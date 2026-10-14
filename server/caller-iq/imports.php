<?php
/**
 * /api/caller-iq/imports.php  —  Caller IQ "Imports": upload a list of people (CSV / Excel)
 * and see, for every row, whether our counselors have called them and how it went.
 * ---------------------------------------------------------------------------
 * The browser parses the file (any size, in a worker) and sends it in chunks:
 *
 *   start    { name, file_name, headers[], mapping{phone,email,name[],status?}, total,
 *              default_status?, dupe_mode? }  → { id }
 *   chunk    { id, rows: [ { r: rowNo, p: phone, e: email, n: name, s: status?, d: [cells…] } ] }
 *            → { stored, skipped, dupes }
 *   finish   { id }  → finds a phone for rows that only had an email (users.email → users.phone)
 *   preview  { phones[], emails[] }   → call stats for the first rows, BEFORE importing
 *   dupes    { phones[] }            → which numbers are already on other lists, BEFORE importing
 *   list                                 → every import with its reach
 *   detail   { id, page, per_page, sort, dir, q, show, agent, since }  → summary + agents + rows
 *   export   { id, … same filters }      → CSV of the original columns + call stats (streamed)
 *   delete   { id }   rename { id, name }
 *   bulk     { id, row_ids[], op: 'status' | 'move' | 'delete', status?, to_id? }  → { changed }
 *   annotate { id, row_id, called_by?, comment?, tags[]? }  → saves a counselor's note on one row
 *
 * Each row also reports `attempts` (our outgoing calls since the list was uploaded) and
 * `callback_at` (its open callback time, set through callbacks.php "schedule").
 *
 * Every row is matched to a student account (email, else phone) so the list can show whether that
 * student PURCHASED an internship (payment_status = success) — also live, never snapshotted.
 *
 * Call stats are computed LIVE from caller_iq_calls on every read (matched on the last 10 digits,
 * exactly how the rest of Caller IQ matches), so a call made after the import shows up straight
 * away — nothing is snapshotted. Hidden test phones are left out, as everywhere else.
 *
 * Status on import: every row keeps the status it came in with (import_status) — from the file's
 * mapped status column, else the list's "Default status on import". The live status (IMP_STATUS)
 * starts from it and moves on with the call log. "Called" means WE reached out — an outgoing call,
 * a connected call, or a counselor's "Called by" — never just an incoming missed call, which is
 * what used to mark a whole "Missed call callbacks" list as Called.
 *
 * Duplicates: dupe_mode decides what happens to a number already on another list —
 *   skip       not imported again (nor twice from the same file)
 *   overwrite  imported, and the other lists' rows take the new status
 *   merge      imported, carrying over the counselor notes already written for that number
 *              (call history is shared by number already, so it merges by itself)
 *   keep / ''  imported as it is
 * ---------------------------------------------------------------------------
 */
require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../middleware/auth.php';
require_once __DIR__ . '/ciq_lib.php';

mysqli_report(MYSQLI_REPORT_OFF);
set_exception_handler(function (Throwable $e) {
    error_log('[caller-iq imports] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    api_error('Imports: ' . $e->getMessage(), 500);
});

$in     = get_json_input();
$action = (string)($in['action'] ?? '');

/*
 * The Caller IQ phone app cannot log in, so it identifies itself with the shared app key
 * (CALLER_IQ_APP_KEY in ciq_lib.php) plus its device id. A key match lets it read lists, save
 * counselor notes and run bulk actions on people — nothing else: uploading, renaming, deleting a
 * whole list and exporting stay behind the admin login. A device_id WITHOUT the right key never
 * skips the login.
 */
$appKey = (string)($in['app_key'] ?? ($_SERVER['HTTP_X_CALLIQ_APP_KEY'] ?? ''));
$isApp  = !empty($in['device_id']) && $appKey !== '';
if ($isApp) {
    if (!defined('CALLER_IQ_APP_KEY') || !hash_equals((string)CALLER_IQ_APP_KEY, $appKey)) {
        api_error('This phone is not allowed to read calling lists.', 403);
    }
    if (!in_array($action, ['list', 'detail', 'annotate', 'bulk'], true)) {
        api_error('This action is only available in the admin panel.', 403);
    }
    $ME = 0; // Device acting as an agent
} else {
    $jwt = require_jwt();
    require_permission('caller_iq', $jwt);
    $ME = (int)($jwt['user_id'] ?? 0);
}

require_method('POST');

ciq_ensure_schema($conn);
imp_ensure_schema($conn);

const IMP_HIDDEN = "c.device_id NOT IN (SELECT device_id FROM caller_iq_devices WHERE is_hidden = 1)";

/* The statuses a row can be imported with — the import dialog's "Default status on import". */
const IMP_IMPORT_STATUSES = ['needs_callback', 'missed_call', 'not_called', 'pending_followup', 'called'];
const IMP_DUPE_MODES = ['skip', 'overwrite', 'merge', 'keep'];

/* Over a row r, its call stats s (connected, outgoing, missed, last_tag) and its open callback
   time sc (imp_sched_join). */
const IMP_CALLED = "(COALESCE(s.outgoing, 0) > 0 OR COALESCE(s.connected, 0) > 0 OR r.called_by <> '' OR r.import_status = 'called')";
/* One live status per row, first match wins. The call log moves a row on only by reaching the
   person (or a "Callback Scheduled" tag); until then the status it was imported with stands. A
   callback is owed (needs_callback / missed_call) until someone actually speaks to the person —
   ringing back unanswered does not settle it. */
const IMP_STATUS = "(CASE
    WHEN r.phone_norm = '' THEN 'no_phone'
    WHEN sc.due_at IS NOT NULL THEN 'scheduled'
    WHEN s.last_tag = 'Callback Scheduled' THEN 'scheduled'
    WHEN COALESCE(s.connected, 0) > 0 THEN 'connected'
    WHEN r.called_by <> '' THEN 'called'
    WHEN r.import_status = 'needs_callback' THEN 'needs_callback'
    WHEN r.import_status = 'missed_call' THEN 'missed_call'
    WHEN r.import_status = 'pending_followup' THEN 'scheduled'
    WHEN r.import_status = 'called' THEN 'called'
    WHEN COALESCE(s.missed, 0) > 0 THEN 'missed_call'
    WHEN COALESCE(s.outgoing, 0) > 0 THEN 'not_connected'
    ELSE 'not_called' END)";
const IMP_TO_CALL = "('needs_callback', 'missed_call', 'not_called')";
const IMP_DONE    = "('connected', 'called', 'not_connected')";
const IMP_STATUS_LABEL = [
    'needs_callback' => 'Needs callback', 'missed_call' => 'Missed call', 'scheduled' => 'Scheduled',
    'connected' => 'Connected', 'called' => 'Called', 'not_connected' => 'Called, not connected',
    'not_called' => 'Not called', 'no_phone' => 'No phone',
];
const IMP_IMPORT_LABEL = [
    'needs_callback' => 'Needs callback', 'missed_call' => 'Missed call', 'not_called' => 'Not called',
    'pending_followup' => 'Pending follow-up', 'called' => 'Called',
];

/** A status as a file writes it ("Call back", "Follow up", "Done"…) → one of IMP_IMPORT_STATUSES. */
function imp_norm_status(string $raw, string $default): string
{
    $k = preg_replace('/[^a-z]+/', ' ', strtolower(trim($raw)));
    $k = trim($k);
    if ($k === '') return $default;
    $k = str_replace(' ', '', $k);
    if (in_array($k, ['needscallback', 'needcallback', 'callback', 'callbackneeded', 'tocallback', 'callmeback', 'cb'], true)) return 'needs_callback';
    if (in_array($k, ['missedcall', 'missed', 'missedcalls', 'nocall', 'unanswered'], true)) return 'missed_call';
    if (in_array($k, ['pendingfollowup', 'followup', 'followuppending', 'pending', 'scheduled', 'callbackscheduled', 'later'], true)) return 'pending_followup';
    if (in_array($k, ['called', 'calledmarked', 'done', 'completed', 'complete', 'contacted', 'connected', 'spoken', 'reached', 'yes'], true)) return 'called';
    if (in_array($k, ['notcalled', 'uncalled', 'new', 'fresh', 'todo', 'open', 'no'], true)) return 'not_called';
    $snake = preg_replace('/\s+/', '_', preg_replace('/[^a-z]+/', ' ', strtolower(trim($raw))));
    return in_array($snake, IMP_IMPORT_STATUSES, true) ? $snake : $default;
}

/*
 * Open callback times (callbacks.php "schedule"), one per number, as sc. A time stops counting once
 * someone speaks to the person after it was set — the same rule callbacks.php settles it by.
 */
function imp_sched_join(mysqli $conn): string
{
    static $has = null;
    if ($has === null) { $r = $conn->query("SHOW TABLES LIKE 'caller_iq_schedules'"); $has = $r && $r->num_rows > 0; }
    if (!$has) return " LEFT JOIN (SELECT '' AS n, NULL AS due_at FROM DUAL WHERE 1 = 0) sc ON sc.n = r.phone_norm";
    return " LEFT JOIN (SELECT sc.number_norm AS n, MIN(sc.due_at) AS due_at FROM caller_iq_schedules sc
                        WHERE sc.done_at IS NULL AND NOT EXISTS (
                            SELECT 1 FROM caller_iq_calls c WHERE c.number_norm = sc.number_norm AND c.call_at > sc.created_at
                              AND c.duration_sec > 0 AND COALESCE(c.outcome, '') NOT IN ('Callback Scheduled', 'Not Answering'))
                        GROUP BY sc.number_norm) sc ON sc.n = r.phone_norm";
}

/** SMS sent to each number from the app (callbacks.php "sms_log"), as sm: count and last time. */
function imp_sms_join(mysqli $conn): string
{
    static $has = null;
    if ($has === null) { $r = $conn->query("SHOW TABLES LIKE 'caller_iq_sms'"); $has = $r && $r->num_rows > 0; }
    if (!$has) return " LEFT JOIN (SELECT '' AS n, 0 AS sms_count, NULL AS sms_at FROM DUAL WHERE 1 = 0) sm ON sm.n = r.phone_norm";
    return " LEFT JOIN (SELECT number_norm AS n, COUNT(*) AS sms_count, MAX(sent_at) AS sms_at FROM caller_iq_sms GROUP BY number_norm) sm ON sm.n = r.phone_norm";
}

/** "Max attempts reached": the limit the app works to (its MAX_ATTEMPTS), 3 unless it says otherwise. */
function imp_max_attempts(array $in): int { return max(1, min(20, (int)($in['max'] ?? 3))); }

/** stored_rows / with_phone again from the rows themselves, after people were moved or deleted. */
function imp_recount(mysqli $conn, int $id, string $now): void
{
    $conn->query("UPDATE caller_iq_imports SET
                    stored_rows = (SELECT COUNT(*) FROM caller_iq_import_rows WHERE import_id = $id),
                    with_phone  = (SELECT COALESCE(SUM(phone_norm <> ''), 0) FROM caller_iq_import_rows WHERE import_id = $id),
                    changed_at  = '$now'
                  WHERE id = $id");
}

/** Per number over a set of imports' phones: what IMP_CALLED / IMP_STATUS read as s. */
function imp_reach_sql(string $phones): string
{
    return "SELECT c.number_norm AS n, SUM(c.duration_sec > 0) AS connected, SUM(c.call_type = 'OUTGOING') AS outgoing,
                   SUM(c.call_type IN ('MISSED','REJECTED','BLOCKED')) AS missed,
                   SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(c.outcome, '') ORDER BY c.call_at DESC SEPARATOR '||'), '||', 1) AS last_tag
            FROM caller_iq_calls c
            WHERE " . IMP_HIDDEN . " AND c.number_norm IN ($phones)
            GROUP BY c.number_norm";
}

function imp_ensure_schema(mysqli $conn): void
{
    /* All times written by PHP (Asia/Kolkata) — MySQL runs a different clock on this host. */
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_imports (
        id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
        name          VARCHAR(160) NOT NULL,
        file_name     VARCHAR(255) NOT NULL DEFAULT '',
        headers_json  MEDIUMTEXT   NULL,
        mapping_json  TEXT         NULL,
        total_rows    INT UNSIGNED NOT NULL DEFAULT 0,
        stored_rows   INT UNSIGNED NOT NULL DEFAULT 0,
        with_phone    INT UNSIGNED NOT NULL DEFAULT 0,
        from_email    INT UNSIGNED NOT NULL DEFAULT 0,
        status        VARCHAR(16)  NOT NULL DEFAULT 'uploading',
        created_by    INT          NULL,
        created_at    DATETIME     NOT NULL,
        finished_at   DATETIME     NULL,
        PRIMARY KEY (id),
        KEY k_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    /* phone_src: 'f' = phone from the file, 'e' = found from the email via users, '' = none. */
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_import_rows (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        import_id   INT UNSIGNED NOT NULL,
        row_no      INT UNSIGNED NOT NULL,
        phone_norm  VARCHAR(20)  NOT NULL DEFAULT '',
        phone_raw   VARCHAR(40)  NOT NULL DEFAULT '',
        phone_src   CHAR(1)      NOT NULL DEFAULT '',
        email       VARCHAR(190) NOT NULL DEFAULT '',
        name        VARCHAR(190) NOT NULL DEFAULT '',
        data_json   TEXT         NULL,
        PRIMARY KEY (id),
        KEY k_imp_row (import_id, row_no),
        KEY k_imp_phone (import_id, phone_norm),
        KEY k_imp_email (import_id, email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    /* Counselor notes per row + the student account it belongs to (for purchases).
       user_id: NULL = not looked up yet, 0 = no matching account. tags are stored ",a,b," so one
       tag is an exact LIKE '%,a,%'. */
    imp_add_columns($conn, 'caller_iq_import_rows', [
        'user_id'   => "ADD COLUMN user_id INT UNSIGNED NULL",
        'called_by' => "ADD COLUMN called_by VARCHAR(80) NOT NULL DEFAULT ''",
        'comment'   => "ADD COLUMN comment TEXT NULL",
        'tags'      => "ADD COLUMN tags VARCHAR(500) NOT NULL DEFAULT ''",
        'noted_at'  => "ADD COLUMN noted_at DATETIME NULL",
        'noted_by'  => "ADD COLUMN noted_by INT NULL",
        'import_status' => "ADD COLUMN import_status VARCHAR(20) NOT NULL DEFAULT ''",
    ], [
        'k_imp_user' => 'ADD KEY k_imp_user (import_id, user_id)',
        'k_imp_caller' => 'ADD KEY k_imp_caller (import_id, called_by)',
        'k_phone' => 'ADD KEY k_phone (phone_norm)',
    ]);
    /* changed_at moves on every note, so open pages know to refresh; users_resolved = accounts matched.
       default_status / dupe_mode: what the import dialog chose; dupes = rows already on another list. */
    imp_add_columns($conn, 'caller_iq_imports', [
        'changed_at'     => "ADD COLUMN changed_at DATETIME NULL",
        'users_resolved' => "ADD COLUMN users_resolved TINYINT(1) NOT NULL DEFAULT 0",
        'default_status' => "ADD COLUMN default_status VARCHAR(20) NOT NULL DEFAULT ''",
        'dupe_mode'      => "ADD COLUMN dupe_mode VARCHAR(10) NOT NULL DEFAULT ''",
        'dupes'          => "ADD COLUMN dupes INT UNSIGNED NOT NULL DEFAULT 0",
        'skipped'        => "ADD COLUMN skipped INT UNSIGNED NOT NULL DEFAULT 0",
    ]);

    /* The unique "Called by" names and tags people have typed — the dropdown suggestions. */
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_callers (
        name      VARCHAR(80) NOT NULL,
        uses      INT UNSIGNED NOT NULL DEFAULT 0,
        last_used DATETIME NOT NULL,
        PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_note_tags (
        name      VARCHAR(40) NOT NULL,
        uses      INT UNSIGNED NOT NULL DEFAULT 0,
        last_used DATETIME NOT NULL,
        PRIMARY KEY (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

/** Adds the columns / keys a table is missing (one ALTER), so old installs upgrade in place. */
function imp_add_columns(mysqli $conn, string $table, array $cols, array $keys = []): void
{
    $have = [];
    $r = $conn->query("SHOW COLUMNS FROM `$table`");
    while ($r && $c = $r->fetch_assoc()) $have[$c['Field']] = true;
    $haveKeys = [];
    $r = $conn->query("SHOW INDEX FROM `$table`");
    while ($r && $k = $r->fetch_assoc()) $haveKeys[$k['Key_name']] = true;
    $alter = [];
    foreach ($cols as $name => $sql) if (!isset($have[$name])) $alter[] = $sql;
    foreach ($keys as $name => $sql) if (!isset($haveKeys[$name])) $alter[] = $sql;
    if ($alter && !$conn->query("ALTER TABLE `$table` " . implode(', ', $alter))) error_log("[caller-iq imports] ALTER $table: " . $conn->error);
}

/*
 * Match every row to a student account: by email first, then by phone (users.phone is stored as
 * 9876543210, +919876543210, 09876543210, "+91 98765 43210"… so each number is looked up in those
 * shapes). Rows with no account get user_id = 0 so they are not looked up again.
 */
function imp_resolve_users(mysqli $conn, int $id): void
{
    $rows = imp_all($conn, "SELECT id, email, phone_norm FROM caller_iq_import_rows WHERE import_id = $id AND user_id IS NULL");
    if (!$rows) { $conn->query("UPDATE caller_iq_imports SET users_resolved = 1 WHERE id = $id"); return; }
    $byEmail = []; $byPhone = [];
    foreach (array_chunk(array_values(array_unique(array_filter(array_column($rows, 'email')))), 1000) as $part) {
        foreach (imp_all($conn, "SELECT user_id, email FROM users WHERE email IN (" . implode(',', array_map(fn($e) => imp_e($conn, $e), $part)) . ")") as $u) {
            $byEmail[strtolower($u['email'])] = (int)$u['user_id'];
        }
    }
    $need = [];
    foreach ($rows as $r) if (!isset($byEmail[strtolower($r['email'])]) && strlen($r['phone_norm']) === 10) $need[$r['phone_norm']] = true;
    foreach (array_chunk(array_keys($need), 300) as $part) {
        $shapes = [];
        foreach ($part as $n) {
            $n = (string)$n;
            array_push($shapes, $n, "+91$n", "91$n", "0$n", "+91 $n", "+91-$n", substr($n, 0, 5) . ' ' . substr($n, 5), '+91 ' . substr($n, 0, 5) . ' ' . substr($n, 5));
        }
        foreach (imp_all($conn, "SELECT user_id, phone FROM users WHERE phone IN (" . implode(',', array_map(fn($s) => imp_e($conn, $s), $shapes)) . ") ORDER BY user_id") as $u) {
            $n = ciq_norm_number((string)$u['phone']);
            if (strlen($n) === 10) $byPhone[$n] = (int)$u['user_id'];  // latest account wins (ORDER BY user_id)
        }
    }
    $set = [];
    foreach ($rows as $r) $set[(int)$r['id']] = $byEmail[strtolower($r['email'])] ?? ($byPhone[$r['phone_norm']] ?? 0);
    foreach (array_chunk($set, 2000, true) as $part) {
        $case = implode(' ', array_map(fn($rid, $uid) => "WHEN $rid THEN $uid", array_keys($part), $part));
        $conn->query("UPDATE caller_iq_import_rows SET user_id = CASE id $case END WHERE id IN (" . implode(',', array_keys($part)) . ")");
    }
    $conn->query("UPDATE caller_iq_imports SET users_resolved = 1 WHERE id = $id");
}

/*
 * Purchases of the students in this import (payment_status, status = 'success'), one row per
 * account, in an indexed temporary table like the call stats: n = distinct internships bought.
 */
function imp_build_purchases(mysqli $conn, int $id): string
{
    $sql = "SELECT p.user_id AS u, COUNT(DISTINCT p.internship_name) AS n, MIN(p.`timestamp`) AS first_at, MAX(p.`timestamp`) AS last_at,
                   SUBSTRING_INDEX(GROUP_CONCAT(p.internship_name ORDER BY p.`timestamp` DESC SEPARATOR '||'), '||', 1) AS item,
                   SUM(p.amount) AS amount
            FROM payment_status p
            JOIN (SELECT DISTINCT user_id FROM caller_iq_import_rows WHERE import_id = $id AND user_id > 0) iu ON iu.user_id = p.user_id
            WHERE p.status = 'success'
            GROUP BY p.user_id";
    $conn->query("DROP TEMPORARY TABLE IF EXISTS imp_p");
    if (!$conn->query("CREATE TEMPORARY TABLE imp_p (PRIMARY KEY (u)) ENGINE=InnoDB AS $sql")) {
        error_log('[caller-iq imports] purchases temp table: ' . $conn->error);
        /* no payment_status / no temp-table privilege: an empty set keeps every query working */
        if (!$conn->query("CREATE TEMPORARY TABLE IF NOT EXISTS imp_p (u INT UNSIGNED PRIMARY KEY, n INT, first_at DATETIME, last_at DATETIME, item VARCHAR(255), amount DECIMAL(12,2)) ENGINE=InnoDB")) {
            return "(SELECT 0 AS u, 0 AS n, NULL AS first_at, NULL AS last_at, '' AS item, 0 AS amount FROM DUAL WHERE 1 = 0)";
        }
    }
    return 'imp_p';
}

/** One name / tag as people typed it, but matched case-insensitively to the stored spelling. */
function imp_clean_label(string $v, int $max): string
{
    $v = preg_replace('/\s+/u', ' ', trim(str_replace(',', ' ', $v)));
    return mb_substr($v, 0, $max);
}
function imp_remember(mysqli $conn, string $table, string $name): string
{
    $st = $conn->prepare("SELECT name FROM $table WHERE name = ?");
    $st->bind_param('s', $name); $st->execute();
    $row = $st->get_result()->fetch_row(); $st->close();
    $stored = $row ? (string)$row[0] : $name;
    $now = date('Y-m-d H:i:s');
    $st = $conn->prepare("INSERT INTO $table (name, uses, last_used) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE uses = uses + 1, last_used = VALUES(last_used)");
    $st->bind_param('ss', $stored, $now); $st->execute(); $st->close();
    return $stored;
}
function imp_tags_out(string $s): array { return array_values(array_filter(explode(',', $s), fn($t) => $t !== '')); }

function imp_has_payments(mysqli $conn): bool
{
    static $has = null;
    if ($has === null) { $r = $conn->query("SHOW TABLES LIKE 'payment_status'"); $has = $r && $r->num_rows > 0; }
    return $has;
}

/** Names of the people who wrote notes (admin accounts live in users). */
function imp_user_names(mysqli $conn, array $ids): array
{
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
    if (!$ids) return [];
    $out = [];
    foreach (imp_all($conn, "SELECT user_id, COALESCE(NULLIF(TRIM(CONCAT(COALESCE(fname,''),' ',COALESCE(lname,''))),''), name, email) n FROM users WHERE user_id IN (" . implode(',', $ids) . ")") as $u) $out[(int)$u['user_id']] = $u['n'];
    return $out;
}

function imp_get(mysqli $conn, int $id): array
{
    $st = $conn->prepare("SELECT * FROM caller_iq_imports WHERE id = ?");
    $st->bind_param('i', $id);
    $st->execute();
    $r = $st->get_result()->fetch_assoc();
    if (!$r) api_error('Import not found', 404);
    return $r;
}

function imp_all(mysqli $conn, string $sql): array
{
    $res = $conn->query($sql);
    if ($res === false) throw new RuntimeException($conn->error);
    return $res->fetch_all(MYSQLI_ASSOC);
}

function imp_e(mysqli $conn, $v): string { return "'" . $conn->real_escape_string((string)$v) . "'"; }

/** "Calls since…" window for the stats. */
function imp_since_sql(array $in, array $imp): string
{
    switch ((string)($in['since'] ?? 'all')) {
        case 'import': return " AND c.call_at >= '" . addslashes($imp['created_at']) . "'";
        case '7':      return " AND c.call_at >= '" . date('Y-m-d 00:00:00', strtotime('-6 days')) . "'";
        case '30':     return " AND c.call_at >= '" . date('Y-m-d 00:00:00', strtotime('-29 days')) . "'";
        case 'today':  return " AND c.call_at >= '" . date('Y-m-d 00:00:00') . "'";
        default:       return '';
    }
}

/** One stats row per number in this import (a derived table, joined to the rows). */
function imp_stats_sql(mysqli $conn, int $id, string $since, string $agent, string $created): string
{
    $agentSql = $agent !== '' ? ' AND c.device_id = ' . imp_e($conn, $agent === '__none__' ? '' : $agent) : '';
    return "SELECT c.number_norm AS n,
                   COUNT(*) AS total,
                   SUM(c.call_type = 'OUTGOING') AS outgoing,
                   SUM(c.call_type = 'INCOMING') AS incoming,
                   SUM(c.call_type IN ('MISSED','REJECTED','BLOCKED')) AS missed,
                   SUM(c.duration_sec > 0) AS connected,
                   SUM(c.duration_sec) AS talk_sec,
                   MAX(c.duration_sec) AS longest_sec,
                   MIN(c.call_at) AS first_at,
                   MAX(c.call_at) AS last_at,
                   COUNT(DISTINCT c.device_id) AS agents,
                   SUM(c.call_type = 'OUTGOING' AND c.call_at >= " . imp_e($conn, $created) . ") AS attempts,
                   SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(c.outcome, '') ORDER BY c.call_at DESC SEPARATOR '||'), '||', 1) AS last_tag
            FROM caller_iq_calls c
            JOIN (SELECT DISTINCT phone_norm FROM caller_iq_import_rows WHERE import_id = $id AND phone_norm <> '') ip
              ON ip.phone_norm = c.number_norm
            WHERE " . IMP_HIDDEN . "$since$agentSql
            GROUP BY c.number_norm";
}

/** WHERE for the rows list: search + "show" bucket. */
function imp_rows_where(mysqli $conn, int $id, array $in): string
{
    $w = ["r.import_id = $id"];
    $q = trim((string)($in['q'] ?? ''));
    if ($q !== '') {
        $like = imp_e($conn, '%' . $q . '%');
        $digits = preg_replace('/\D+/', '', $q);
        $or = ["r.name LIKE $like", "r.email LIKE $like", "r.phone_raw LIKE $like"];
        if (strlen($digits) >= 4) $or[] = 'r.phone_norm LIKE ' . imp_e($conn, '%' . $digits . '%');
        $w[] = '(' . implode(' OR ', $or) . ')';
    }
    /* "Called by <agent>" on its own lists just the people that agent called; the status chips still slice by it. */
    if ((string)($in['agent'] ?? '') !== '' && in_array((string)($in['show'] ?? 'all'), ['all', ''], true)) $w[] = 's.n IS NOT NULL';
    /* "Called" = we rang them (or got through), or a counselor wrote their name in "Called by". */
    switch ((string)($in['show'] ?? 'all')) {
        case 'called':         $w[] = IMP_CALLED; break;
        case 'connected':      $w[] = 's.connected > 0'; break;
        case 'not_connected':  $w[] = 's.outgoing > 0 AND s.connected = 0'; break;
        case 'never':          $w[] = 'NOT ' . IMP_CALLED; break;
        case 'no_phone':       $w[] = "r.phone_norm = ''"; break;
        case 'to_call':        $w[] = IMP_STATUS . ' IN ' . IMP_TO_CALL; break;
        case 'needs_callback': $w[] = IMP_STATUS . " IN ('needs_callback', 'missed_call')"; break;
        case 'scheduled':      $w[] = IMP_STATUS . " = 'scheduled'"; break;
        case 'maxed':          $w[] = 'COALESCE(s.attempts, 0) >= ' . imp_max_attempts($in); break;
        case 'done':           $w[] = IMP_STATUS . ' IN ' . IMP_DONE; break;
    }
    switch ((string)($in['buy'] ?? '')) {
        case 'yes': $w[] = 'p.u IS NOT NULL'; break;
        case 'no':  $w[] = 'p.u IS NULL'; break;
    }
    $caller = (string)($in['caller'] ?? '');
    if ($caller === '__none__') $w[] = "r.called_by = ''";
    elseif ($caller !== '') $w[] = 'r.called_by = ' . imp_e($conn, $caller);
    $tag = (string)($in['tag'] ?? '');
    if ($tag !== '') $w[] = 'r.tags LIKE ' . imp_e($conn, '%,' . addcslashes($tag, '%_\\') . ',%');
    return implode(' AND ', $w);
}

const IMP_SORTS = [
    'row' => 'r.row_no', 'name' => 'r.name', 'calls' => 's.total', 'talk' => 's.talk_sec',
    'last' => 's.last_at', 'first' => 's.first_at', 'connected' => 's.connected', 'agents' => 's.agents',
    'caller' => 'NULLIF(r.called_by, \'\')', 'noted' => 'r.noted_at', 'bought' => 'p.last_at', 'email' => 'r.email',
    'status' => IMP_STATUS,
];

/** The last call, latest outcome + notes, and every agent, for the numbers on one page. */
function imp_page_details(mysqli $conn, array $nums, string $since, string $agent): array
{
    $nums = array_values(array_unique(array_filter($nums)));
    if (!$nums) return [];
    $list = implode(',', array_map(fn($n) => imp_e($conn, $n), $nums));
    $agentSql = $agent !== '' ? ' AND c.device_id = ' . imp_e($conn, $agent === '__none__' ? '' : $agent) : '';
    $base = "FROM caller_iq_calls c WHERE c.number_norm IN ($list) AND " . IMP_HIDDEN . $since . $agentSql;
    $out = [];
    foreach (imp_all($conn, "SELECT c.number_norm, c.call_type, c.duration_sec, c.call_at, c.device_id, c.outcome, c.notes
                             $base ORDER BY c.call_at DESC") as $c) {
        $n = $c['number_norm'];
        if (!isset($out[$n])) {
            $out[$n] = ['last_type' => $c['call_type'], 'last_dur' => (int)$c['duration_sec'], 'last_device' => $c['device_id'],
                        'last_outcome' => null, 'last_notes' => null, 'agents_list' => []];
        }
        if ($out[$n]['last_outcome'] === null && $c['outcome'] !== null && $c['outcome'] !== '') $out[$n]['last_outcome'] = $c['outcome'];
        if ($out[$n]['last_notes'] === null && $c['notes'] !== null && trim($c['notes']) !== '') $out[$n]['last_notes'] = $c['notes'];
        $d = $c['device_id'];
        /* Rows arrive newest first, so the first call seen per agent is that agent's last call. */
        if (!isset($out[$n]['agents_list'][$d])) $out[$n]['agents_list'][$d] = ['device_id' => $d, 'calls' => 0, 'connected' => 0, 'talk_sec' => 0, 'last_at' => $c['call_at'], 'last_type' => $c['call_type']];
        $out[$n]['agents_list'][$d]['calls']++;
        if ((int)$c['duration_sec'] > 0) $out[$n]['agents_list'][$d]['connected']++;
        $out[$n]['agents_list'][$d]['talk_sec'] += (int)$c['duration_sec'];
    }
    foreach ($out as &$o) $o['agents_list'] = array_values($o['agents_list']);
    return $out;
}

/** fputcsv with every argument spelled out (PHP 8.4+ warns about the implicit escape character, and the warning lands inside the CSV). */
function imp_csv($fp, array $row): void { fputcsv($fp, $row, ',', '"', '\\'); }

/*
 * The call stats for this import, computed ONCE per request into an indexed temporary table, then
 * joined by every query of the request (summary, count, page). As a derived table the database
 * re-ran the aggregation for each of them and could not use an index for the join — 5.6 s on a
 * 100,000-row import; this way it is a single pass plus primary-key lookups.
 */
function imp_build_stats(mysqli $conn, int $id, string $since, string $agent, string $created): string
{
    $conn->query("DROP TEMPORARY TABLE IF EXISTS imp_s");
    $sql = "CREATE TEMPORARY TABLE imp_s (PRIMARY KEY (n)) ENGINE=InnoDB AS " . imp_stats_sql($conn, $id, $since, $agent, $created);
    if (!$conn->query($sql)) {
        // No CREATE TEMPORARY TABLES privilege: fall back to the (slower) derived table.
        error_log('[caller-iq imports] temp table: ' . $conn->error);
        return '(' . imp_stats_sql($conn, $id, $since, $agent, $created) . ')';
    }
    return 'imp_s';
}

function imp_num(array $r): array
{
    foreach (['total', 'outgoing', 'incoming', 'missed', 'connected', 'talk_sec', 'longest_sec', 'agents', 'attempts', 'sms_count', 'row_no', 'id', 'calls', 'people'] as $k) {
        if (array_key_exists($k, $r) && $r[$k] !== null) $r[$k] = (int)$r[$k];
    }
    return $r;
}

switch ($action) {

/* ── upload ─────────────────────────────────────────────────────────────── */
case 'start': {
    $name = ciq_str($in['name'] ?? '', 160);
    if ($name === '') $name = ciq_str($in['file_name'] ?? 'Import', 160) ?: 'Import';
    $file = ciq_str($in['file_name'] ?? '', 255);
    $headers = json_encode(array_slice(array_map(fn($h) => ciq_str($h, 120), (array)($in['headers'] ?? [])), 0, 200), JSON_UNESCAPED_UNICODE);
    $mapping = json_encode($in['mapping'] ?? new stdClass(), JSON_UNESCAPED_UNICODE);
    $total = max(0, (int)($in['total'] ?? 0));
    $def = (string)($in['default_status'] ?? '');
    if (!in_array($def, IMP_IMPORT_STATUSES, true)) $def = 'not_called';
    $mode = (string)($in['dupe_mode'] ?? 'keep');
    if (!in_array($mode, IMP_DUPE_MODES, true)) $mode = 'keep';
    $now = date('Y-m-d H:i:s');
    $st = $conn->prepare("INSERT INTO caller_iq_imports (name, file_name, headers_json, mapping_json, total_rows, created_by, created_at, default_status, dupe_mode) VALUES (?,?,?,?,?,?,?,?,?)");
    $st->bind_param('ssssiisss', $name, $file, $headers, $mapping, $total, $ME, $now, $def, $mode);
    if (!$st->execute()) api_error('Could not start the import: ' . $st->error, 500);
    api_success(['id' => (int)$conn->insert_id, 'default_status' => $def, 'dupe_mode' => $mode]);
}

case 'chunk': {
    $id = (int)($in['id'] ?? 0);
    $imp = imp_get($conn, $id);
    if ($imp['status'] !== 'uploading') api_error('This import is already finished.');
    $rows = is_array($in['rows'] ?? null) ? $in['rows'] : [];
    if (count($rows) > 10000) api_error('Send at most 10,000 rows per chunk.');
    $def  = in_array($imp['default_status'], IMP_IMPORT_STATUSES, true) ? $imp['default_status'] : '';
    $mode = in_array($imp['dupe_mode'], IMP_DUPE_MODES, true) ? $imp['dupe_mode'] : 'keep';

    $clean = [];
    foreach ($rows as $r) {
        if (!is_array($r)) continue;
        $raw   = ciq_str($r['p'] ?? '', 40);
        $email = strtolower(ciq_str($r['e'] ?? '', 190));
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) $email = '';
        $data  = is_array($r['d'] ?? null) ? json_encode(array_map(fn($v) => is_scalar($v) ? mb_substr((string)$v, 0, 500) : '', array_slice($r['d'], 0, 200)), JSON_UNESCAPED_UNICODE) : null;
        if ($data !== null && strlen($data) > 60000) $data = substr($data, 0, 60000);
        $clean[] = [
            'row' => max(0, (int)($r['r'] ?? 0)), 'raw' => $raw, 'norm' => ciq_norm_number($raw), 'email' => $email,
            'name' => ciq_str($r['n'] ?? '', 190), 'data' => $data,
            'status' => imp_norm_status(ciq_str($r['s'] ?? '', 60), $def),
        ];
    }

    /* Numbers already on a list: other imports (newest row first, for its notes), and this one. */
    $phones = array_values(array_unique(array_filter(array_column($clean, 'norm'))));
    $elsewhere = []; $here = [];
    if ($phones && $mode !== 'keep') {
        foreach (array_chunk($phones, 1000) as $part) {
            $list = implode(',', array_map(fn($p) => imp_e($conn, $p), $part));
            foreach (imp_all($conn, "SELECT import_id, phone_norm, called_by, comment, tags FROM caller_iq_import_rows
                                     WHERE phone_norm IN ($list) ORDER BY id DESC") as $x) {
                if ((int)$x['import_id'] === $id) $here[$x['phone_norm']] = true;
                elseif (!isset($elsewhere[$x['phone_norm']]) || ($elsewhere[$x['phone_norm']]['called_by'] === '' && (string)$elsewhere[$x['phone_norm']]['comment'] === '' && $elsewhere[$x['phone_norm']]['tags'] === '')) {
                    $elsewhere[$x['phone_norm']] = $x;     // keep the newest row that has notes, if any
                }
            }
        }
    } elseif ($phones) {
        foreach (array_chunk($phones, 1000) as $part) {
            $list = implode(',', array_map(fn($p) => imp_e($conn, $p), $part));
            foreach (imp_all($conn, "SELECT DISTINCT phone_norm FROM caller_iq_import_rows WHERE phone_norm IN ($list) AND import_id <> $id") as $x) $elsewhere[$x['phone_norm']] = [];
        }
    }

    $vals = []; $withPhone = 0; $skipped = 0; $dupes = 0; $overwrite = [];
    foreach ($clean as $c) {
        $norm = $c['norm'];
        $dupe = $norm !== '' && (isset($elsewhere[$norm]) || isset($here[$norm]));
        if ($dupe) $dupes++;
        if ($dupe && $mode === 'skip') { $skipped++; continue; }
        if ($norm !== '') $here[$norm] = true;               // a number twice in the same file is a duplicate too
        $notes = $mode === 'merge' && $norm !== '' && !empty($elsewhere[$norm]) ? $elsewhere[$norm] : ['called_by' => '', 'comment' => null, 'tags' => ''];
        if ($mode === 'overwrite' && isset($elsewhere[$norm]) && $c['status'] !== '') $overwrite[$c['status']][] = $norm;
        if ($norm !== '') $withPhone++;
        $vals[] = '(' . $id . ',' . $c['row'] . ',' . imp_e($conn, $norm) . ',' . imp_e($conn, $c['raw']) . ','
            . imp_e($conn, $norm !== '' ? 'f' : '') . ',' . imp_e($conn, $c['email']) . ',' . imp_e($conn, $c['name']) . ','
            . ($c['data'] === null ? 'NULL' : imp_e($conn, $c['data'])) . ',' . imp_e($conn, $c['status']) . ','
            . imp_e($conn, $notes['called_by']) . ',' . ($notes['comment'] === null ? 'NULL' : imp_e($conn, $notes['comment'])) . ',' . imp_e($conn, $notes['tags']) . ')';
    }
    /* Multi-row INSERTs of 2,000 in one transaction: a 100k-row file is ~50 statements. */
    $conn->begin_transaction();
    foreach (array_chunk($vals, 2000) as $part) {
        if (!$conn->query('INSERT INTO caller_iq_import_rows (import_id, row_no, phone_norm, phone_raw, phone_src, email, name, data_json, import_status, called_by, comment, tags) VALUES ' . implode(',', $part))) {
            $err = $conn->error;
            $conn->rollback();
            api_error('Could not save rows: ' . $err, 500);
        }
    }
    /* "Overwrite status": the same number on older lists takes the status it was just imported with. */
    $now = date('Y-m-d H:i:s');
    foreach ($overwrite as $status => $nums) {
        foreach (array_chunk(array_values(array_unique($nums)), 1000) as $part) {
            $list = implode(',', array_map(fn($p) => imp_e($conn, $p), $part));
            $conn->query("UPDATE caller_iq_imports SET changed_at = '$now' WHERE id IN (SELECT DISTINCT import_id FROM caller_iq_import_rows WHERE phone_norm IN ($list) AND import_id <> $id)");
            $conn->query("UPDATE caller_iq_import_rows SET import_status = " . imp_e($conn, $status) . " WHERE phone_norm IN ($list) AND import_id <> $id");
        }
    }
    $n = count($vals);
    $conn->query("UPDATE caller_iq_imports SET stored_rows = stored_rows + $n, with_phone = with_phone + $withPhone, dupes = dupes + $dupes, skipped = skipped + $skipped WHERE id = $id");
    $conn->commit();
    api_success(['stored' => $n, 'skipped' => $skipped, 'dupes' => $dupes]);
}

case 'finish': {
    $id = (int)($in['id'] ?? 0);
    $imp = imp_get($conn, $id);
    /* Rows with an email but no usable phone: take the phone from that student's account.
       Done in PHP, 1,000 emails at a time, rather than one UPDATE … JOIN users: the two tables can
       have different collations (which makes that JOIN fail outright), and users.phone is stored
       in many formats (+91 …, 0…, spaces) that ciq_norm_number() already understands. */
    $fromEmail = 0;
    $emails = array_column(imp_all($conn, "SELECT DISTINCT email FROM caller_iq_import_rows WHERE import_id = $id AND phone_norm = '' AND email <> ''"), 'email');
    foreach (array_chunk($emails, 1000) as $part) {
        $list = implode(',', array_map(fn($e) => imp_e($conn, $e), $part));
        $map = [];
        foreach (imp_all($conn, "SELECT email, phone FROM users WHERE email IN ($list)") as $u) {
            $n = ciq_norm_number((string)$u['phone']);
            if (strlen($n) === 10) $map[strtolower($u['email'])] = $n;
        }
        if (!$map) continue;
        $case = implode(' ', array_map(fn($e, $n) => 'WHEN ' . imp_e($conn, $e) . ' THEN ' . imp_e($conn, $n), array_keys($map), $map));
        $in   = implode(',', array_map(fn($e) => imp_e($conn, $e), array_keys($map)));
        if ($conn->query("UPDATE caller_iq_import_rows SET phone_norm = CASE email $case ELSE phone_norm END, phone_src = 'e'
                          WHERE import_id = $id AND phone_norm = '' AND email IN ($in)")) {
            $fromEmail += $conn->affected_rows;
        }
    }
    imp_resolve_users($conn, $id);
    $c = imp_all($conn, "SELECT COUNT(*) n, SUM(phone_norm <> '') wp FROM caller_iq_import_rows WHERE import_id = $id")[0];
    $now = date('Y-m-d H:i:s');
    $st = $conn->prepare("UPDATE caller_iq_imports SET status = 'ready', stored_rows = ?, with_phone = ?, from_email = ?, finished_at = ? WHERE id = ?");
    $stored = (int)$c['n']; $wp = (int)$c['wp'];
    $st->bind_param('iiisi', $stored, $wp, $fromEmail, $now, $id);
    $st->execute();
    api_success(['id' => $id, 'stored' => $stored, 'with_phone' => $wp, 'from_email' => $fromEmail]);
}

/* ── before importing: how the first rows look against the call log ────── */
case 'preview': {
    $phones = array_slice(array_values(array_filter(array_map(fn($p) => ciq_norm_number((string)$p), (array)($in['phones'] ?? [])))), 0, 500);
    $emails = array_slice(array_values(array_filter(array_map(fn($e) => strtolower(trim((string)$e)), (array)($in['emails'] ?? [])), fn($e) => filter_var($e, FILTER_VALIDATE_EMAIL))), 0, 500);
    $emailPhone = [];
    if ($emails) {
        $list = implode(',', array_map(fn($e) => imp_e($conn, $e), $emails));
        foreach (imp_all($conn, "SELECT email, phone FROM users WHERE email IN ($list)") as $u) {
            $n = ciq_norm_number((string)$u['phone']);
            if (strlen($n) >= 10) $emailPhone[strtolower($u['email'])] = $n;
        }
    }
    $all = array_values(array_unique(array_merge($phones, array_values($emailPhone))));
    $stats = [];
    if ($all) {
        $list = implode(',', array_map(fn($n) => imp_e($conn, $n), $all));
        foreach (imp_all($conn, "SELECT c.number_norm AS n, COUNT(*) total, SUM(c.duration_sec > 0) connected, SUM(c.duration_sec) talk_sec, MAX(c.call_at) last_at
                                 FROM caller_iq_calls c WHERE c.number_norm IN ($list) AND " . IMP_HIDDEN . " GROUP BY c.number_norm") as $s) {
            $stats[$s['n']] = imp_num($s);
        }
        foreach (imp_page_details($conn, array_keys($stats), '', '') as $n => $d) $stats[$n] += $d;
    }
    api_success(['stats' => (object)$stats, 'email_phone' => (object)$emailPhone]);
}

/* ── before importing: which numbers are already on a calling list ─────── */
case 'dupes': {
    $given = array_values(array_filter(array_map(fn($p) => ciq_norm_number((string)$p), array_slice((array)($in['phones'] ?? []), 0, 200000))));
    $counts = array_count_values($given);
    $inFile = count(array_filter($counts, fn($n) => $n > 1));
    $phones = array_keys($counts);
    $found = []; $byImport = [];
    foreach (array_chunk($phones, 1000) as $part) {
        $list = implode(',', array_map(fn($p) => imp_e($conn, $p), $part));
        foreach (imp_all($conn, "SELECT r.phone_norm, r.name, r.import_status, r.called_by, i.id, i.name AS import_name
                                 FROM caller_iq_import_rows r JOIN caller_iq_imports i ON i.id = r.import_id
                                 WHERE r.phone_norm IN ($list) ORDER BY r.id DESC") as $x) {
            if (!isset($found[$x['phone_norm']])) $found[$x['phone_norm']] = $x;
            $byImport[(int)$x['id']]['name'] = $x['import_name'];
            $byImport[(int)$x['id']]['numbers'][$x['phone_norm']] = true;
        }
    }
    /* How many of those numbers already have calls — what "Merge call history" keeps together. */
    $withHistory = 0;
    foreach (array_chunk(array_keys($found), 1000) as $part) {
        $list = implode(',', array_map(fn($p) => imp_e($conn, $p), $part));
        $withHistory += (int)imp_all($conn, "SELECT COUNT(DISTINCT c.number_norm) n FROM caller_iq_calls c WHERE c.number_norm IN ($list) AND " . IMP_HIDDEN)[0]['n'];
    }
    $lists = [];
    foreach ($byImport as $iid => $b) $lists[] = ['id' => $iid, 'name' => $b['name'], 'numbers' => count($b['numbers'])];
    usort($lists, fn($a, $b) => $b['numbers'] - $a['numbers']);
    api_success([
        'checked' => count($phones), 'duplicates' => count($found), 'in_file' => $inFile, 'with_history' => $withHistory,
        'lists' => array_slice($lists, 0, 20),
        'samples' => array_map(fn($x) => [
            'phone' => $x['phone_norm'], 'name' => $x['name'], 'list' => $x['import_name'],
            'status' => $x['import_status'], 'called_by' => $x['called_by'],
        ], array_slice(array_values($found), 0, 50)),
    ]);
}

/* ── reading ────────────────────────────────────────────────────────────── */
case 'list': {
    foreach (imp_all($conn, "SELECT id FROM caller_iq_imports WHERE users_resolved = 0 AND status = 'ready' LIMIT 20") as $u) imp_resolve_users($conn, (int)$u['id']);
    $imps = imp_all($conn, "SELECT id, name, file_name, total_rows, stored_rows, with_phone, from_email, status, created_by, created_at, finished_at, changed_at,
                                   default_status, dupe_mode, dupes, skipped
                            FROM caller_iq_imports ORDER BY id DESC LIMIT 200");
    $ids = array_map(fn($i) => (int)$i['id'], $imps);
    $reach = [];
    if ($ids) {
        $idl = implode(',', $ids);
        /* Per import: called (we rang them, or a "Called by" name), connected, never called, purchased,
           plus the live status buckets every list's summary shows. */
        foreach (imp_all($conn, "SELECT r.import_id, SUM(s.n IS NOT NULL) reached, SUM(COALESCE(s.connected, 0) > 0) connected,
                                        SUM(" . IMP_CALLED . ") called,
                                        SUM(NOT " . IMP_CALLED . ") never,
                                        SUM(r.called_by <> '') marked,
                                        SUM(" . IMP_STATUS . " IN " . IMP_TO_CALL . ") to_call,
                                        SUM(" . IMP_STATUS . " IN ('needs_callback', 'missed_call')) needs_callback,
                                        SUM(" . IMP_STATUS . " = 'scheduled') scheduled,
                                        SUM(" . IMP_STATUS . " IN " . IMP_DONE . ") done,
                                        SUM(pu.u IS NOT NULL) purchased
                                 FROM caller_iq_import_rows r
                                 LEFT JOIN (" . imp_reach_sql("SELECT phone_norm FROM caller_iq_import_rows WHERE import_id IN ($idl) AND phone_norm <> ''") . ") s ON s.n = r.phone_norm" . imp_sched_join($conn) . "
                                 LEFT JOIN " . (imp_has_payments($conn)
                                     ? "(SELECT DISTINCT p.user_id u FROM payment_status p
                                         WHERE p.status = 'success' AND p.user_id IN (SELECT user_id FROM caller_iq_import_rows WHERE import_id IN ($idl) AND user_id > 0))"
                                     : "(SELECT 0 AS u FROM DUAL WHERE 1 = 0)") . " pu ON pu.u = r.user_id
                                 WHERE r.import_id IN ($idl) GROUP BY r.import_id") as $r) {
            $reach[(int)$r['import_id']] = array_map('intval', array_diff_key($r, ['import_id' => 1]));
        }
    }
    $by = [];
    if ($imps) {
        $uids = array_values(array_unique(array_filter(array_map(fn($i) => (int)$i['created_by'], $imps))));
        if ($uids) foreach (imp_all($conn, "SELECT user_id, COALESCE(NULLIF(TRIM(CONCAT(COALESCE(fname,''),' ',COALESCE(lname,''))),''), name, email) n FROM users WHERE user_id IN (" . implode(',', $uids) . ")") as $u) $by[(int)$u['user_id']] = $u['n'];
    }
    foreach ($imps as &$i) {
        $i = imp_num($i) + ($reach[(int)$i['id']] ?? ['reached' => 0, 'connected' => 0, 'called' => 0, 'never' => 0, 'marked' => 0,
                                                       'to_call' => 0, 'needs_callback' => 0, 'scheduled' => 0, 'done' => 0, 'purchased' => 0]);
        foreach (['total_rows', 'stored_rows', 'with_phone', 'from_email', 'dupes', 'skipped'] as $k) $i[$k] = (int)$i[$k];
        $i['created_by_name'] = $by[(int)$i['created_by']] ?? '';
    }
    api_success(['imports' => $imps]);
}

case 'detail': {
    $t0 = microtime(true);
    $id = (int)($in['id'] ?? 0);
    $imp = imp_get($conn, $id);
    $since = imp_since_sql($in, $imp);
    $agent = (string)($in['agent'] ?? '');
    if (!(int)$imp['users_resolved']) imp_resolve_users($conn, $id);
    $S = imp_build_stats($conn, $id, $since, $agent, $imp['created_at']);
    $SC = imp_sched_join($conn);
    $P = imp_build_purchases($conn, $id);

    /* Headline numbers, counted over ROWS (one row = one person in the file). */
    $sum = imp_all($conn, "SELECT COUNT(*) rows_total,
                                  SUM(r.phone_norm <> '') with_phone,
                                  SUM(r.phone_src = 'e') from_email,
                                  SUM(s.n IS NOT NULL) reached,
                                  SUM(" . IMP_CALLED . ") called,
                                  SUM(r.called_by <> '' AND COALESCE(s.outgoing, 0) = 0 AND COALESCE(s.connected, 0) = 0) marked_only,
                                  SUM(COALESCE(s.connected, 0) > 0) connected,
                                  SUM(COALESCE(s.outgoing, 0) > 0 AND COALESCE(s.connected, 0) = 0) not_connected,
                                  SUM(NOT " . IMP_CALLED . ") never,
                                  SUM(" . IMP_STATUS . " IN " . IMP_TO_CALL . ") to_call,
                                  SUM(" . IMP_STATUS . " IN ('needs_callback', 'missed_call')) needs_callback,
                                  SUM(" . IMP_STATUS . " = 'scheduled') scheduled,
                                  SUM(" . IMP_STATUS . " IN " . IMP_DONE . ") done,
                                  SUM(r.phone_norm = '') no_phone,
                                  SUM(p.u IS NOT NULL) purchased,
                                  SUM(p.u IS NOT NULL AND " . IMP_CALLED . ") purchased_called,
                                  SUM(r.user_id > 0) with_account,
                                  SUM(r.called_by <> '' OR r.comment <> '' OR r.tags <> '') noted,
                                  SUM(COALESCE(s.attempts, 0) >= " . imp_max_attempts($in) . ") maxed
                           FROM caller_iq_import_rows r LEFT JOIN $S s ON s.n = r.phone_norm LEFT JOIN $P p ON p.u = r.user_id$SC WHERE r.import_id = $id")[0];
    /* Call totals over DISTINCT numbers, so a person listed twice is not double counted. */
    $calls = imp_all($conn, "SELECT COUNT(*) numbers, COALESCE(SUM(total),0) calls, COALESCE(SUM(outgoing),0) outgoing, COALESCE(SUM(incoming),0) incoming,
                                    COALESCE(SUM(missed),0) missed, COALESCE(SUM(connected),0) connected_calls, COALESCE(SUM(talk_sec),0) talk_sec,
                                    MAX(longest_sec) longest_sec, MIN(first_at) first_at, MAX(last_at) last_at
                             FROM $S s")[0];
    $agentSql = $agent !== '' ? ' AND c.device_id = ' . imp_e($conn, $agent === '__none__' ? '' : $agent) : '';
    $agents = imp_all($conn, "SELECT c.device_id, COALESCE(NULLIF(d.agent_name,''), '') agent_name, d.team,
                                     COUNT(*) calls, COUNT(DISTINCT c.number_norm) people, SUM(c.duration_sec > 0) connected,
                                     SUM(c.duration_sec) talk_sec, MAX(c.call_at) last_at
                              FROM caller_iq_calls c
                              JOIN (SELECT DISTINCT phone_norm FROM caller_iq_import_rows WHERE import_id = $id AND phone_norm <> '') ip ON ip.phone_norm = c.number_norm
                              LEFT JOIN caller_iq_devices d ON d.device_id = c.device_id
                              WHERE " . IMP_HIDDEN . "$since$agentSql
                              GROUP BY c.device_id, d.agent_name, d.team ORDER BY calls DESC");

    $where = imp_rows_where($conn, $id, $in);
    $sortKey = IMP_SORTS[(string)($in['sort'] ?? 'row')] ?? 'r.row_no';
    $dir = strtolower((string)($in['dir'] ?? 'asc')) === 'desc' ? 'DESC' : 'ASC';
    /* Rows with no calls sort last whichever way a call column is sorted. */
    $order = in_array($sortKey, ['r.row_no', 'r.name', 'r.email'], true) ? "$sortKey $dir, r.row_no" : "($sortKey IS NULL), $sortKey $dir, r.row_no";
    $per = max(10, min(500, (int)($in['per_page'] ?? 50)));
    $page = max(1, (int)($in['page'] ?? 1));
    $off = ($page - 1) * $per;
    $total = (int)imp_all($conn, "SELECT COUNT(*) n FROM caller_iq_import_rows r LEFT JOIN $S s ON s.n = r.phone_norm LEFT JOIN $P p ON p.u = r.user_id$SC WHERE $where")[0]['n'];
    $rows = imp_all($conn, "SELECT r.id, r.row_no, r.phone_norm, r.phone_raw, r.phone_src, r.email, r.name, r.data_json, r.user_id,
                                   r.called_by, r.comment, r.tags, r.noted_at, r.noted_by, r.import_status, " . IMP_STATUS . " AS status,
                                   s.attempts, sc.due_at AS callback_at, sm.sms_count, sm.sms_at,
                                   s.total, s.outgoing, s.incoming, s.missed, s.connected, s.talk_sec, s.longest_sec, s.first_at, s.last_at, s.agents,
                                   p.n AS bought, p.item AS bought_item, p.amount AS bought_amount, p.first_at AS bought_first, p.last_at AS bought_at
                            FROM caller_iq_import_rows r LEFT JOIN $S s ON s.n = r.phone_norm LEFT JOIN $P p ON p.u = r.user_id$SC" . imp_sms_join($conn) . "
                            WHERE $where ORDER BY $order LIMIT $per OFFSET $off");
    $details = imp_page_details($conn, array_column($rows, 'phone_norm'), $since, $agent);
    $noters = imp_user_names($conn, array_column($rows, 'noted_by'));
    foreach ($rows as &$r) {
        $r = imp_num($r);
        $r['data'] = $r['data_json'] ? json_decode($r['data_json'], true) : [];
        unset($r['data_json']);
        $r['tags'] = imp_tags_out((string)$r['tags']);
        $r['user_id'] = $r['user_id'] === null ? null : (int)$r['user_id'];
        $r['bought'] = (int)($r['bought'] ?? 0);
        $r['noted_by_name'] = $noters[(int)$r['noted_by']] ?? '';
        $r += $details[$r['phone_norm']] ?? [];
    }
    unset($r);

    /* Filter options for this import, and the suggestion lists every row's dropdowns offer. */
    $facetCallers = array_map(fn($x) => ['name' => $x['called_by'], 'n' => (int)$x['n']],
        imp_all($conn, "SELECT called_by, COUNT(*) n FROM caller_iq_import_rows WHERE import_id = $id AND called_by <> '' GROUP BY called_by ORDER BY n DESC, called_by"));
    $tagCount = [];
    foreach (imp_all($conn, "SELECT tags FROM caller_iq_import_rows WHERE import_id = $id AND tags <> ''") as $t) {
        foreach (imp_tags_out($t['tags']) as $tg) $tagCount[$tg] = ($tagCount[$tg] ?? 0) + 1;
    }
    arsort($tagCount);
    $facetTags = array_map(fn($k, $v) => ['name' => (string)$k, 'n' => $v], array_keys($tagCount), $tagCount);
    $sumInt = array_map(fn($v) => (int)$v, $sum);
    $callsOut = $calls;
    foreach (['numbers', 'calls', 'outgoing', 'incoming', 'missed', 'connected_calls', 'talk_sec', 'longest_sec'] as $k) $callsOut[$k] = (int)$calls[$k];
    api_success([
        'import'  => imp_num($imp) + ['headers' => json_decode($imp['headers_json'] ?: '[]', true), 'mapping' => json_decode($imp['mapping_json'] ?: '{}', true)],
        'summary' => $sumInt, 'calls' => $callsOut,
        'agents'  => array_map(fn($a) => imp_num($a) + ['people' => (int)$a['people'], 'calls' => (int)$a['calls']], $agents),
        'rows' => $rows, 'total' => $total, 'page' => $page, 'per_page' => $per,
        'facets' => ['callers' => $facetCallers, 'tags' => $facetTags],
        'suggest' => [
            'callers' => array_column(imp_all($conn, "SELECT name FROM caller_iq_callers ORDER BY last_used DESC LIMIT 300"), 'name'),
            'tags'    => array_column(imp_all($conn, "SELECT name FROM caller_iq_note_tags ORDER BY uses DESC, last_used DESC LIMIT 300"), 'name'),
        ],
        'took_ms' => (int)round((microtime(true) - $t0) * 1000),
    ]);
}

case 'export': {
    $id = (int)($in['id'] ?? 0);
    $imp = imp_get($conn, $id);
    $since = imp_since_sql($in, $imp);
    $agent = (string)($in['agent'] ?? '');
    if (!(int)$imp['users_resolved']) imp_resolve_users($conn, $id);
    $S = imp_build_stats($conn, $id, $since, $agent, $imp['created_at']);
    $SC = imp_sched_join($conn);
    $P = imp_build_purchases($conn, $id);
    $where = imp_rows_where($conn, $id, $in);
    $headers = json_decode($imp['headers_json'] ?: '[]', true) ?: [];
    $devs = [];
    foreach (imp_all($conn, "SELECT device_id, agent_name FROM caller_iq_devices") as $d) $devs[$d['device_id']] = $d['agent_name'] ?: ($d['device_id'] === '' ? 'Unidentified phone' : $d['device_id']);

    while (ob_get_level()) ob_end_clean();
    header('Content-Type: text/csv; charset=UTF-8');
    header('Content-Disposition: attachment; filename="caller-iq-import-' . $id . '-' . date('Y-m-d') . '.csv"');
    header('Cache-Control: no-store');
    echo "\xEF\xBB\xBF";
    $fp = fopen('php://output', 'w');
    imp_csv($fp, array_merge($headers, ['Matched phone', 'Phone found via', 'Calls', 'Outgoing', 'Incoming', 'Missed', 'Connected calls',
        'Talk time (sec)', 'Longest call (sec)', 'First call', 'Last call', 'Agents', 'Agent names', 'Latest outcome', 'Latest notes', 'Status',
        'Imported status', 'Callback attempts', 'Callback at', 'Called by', 'Comment', 'Tags', 'Purchased', 'Purchased internship', 'Purchase amount', 'Purchased on']));
    /* Streams in pages of 2,000 so a 100k-row export never holds the file in memory. */
    $last = 0;
    while (true) {
        $rows = imp_all($conn, "SELECT r.row_no, r.phone_norm, r.phone_src, r.data_json, s.total, s.outgoing, s.incoming, s.missed, s.connected,
                                       s.talk_sec, s.longest_sec, s.first_at, s.last_at, s.agents, r.called_by, r.comment, r.tags,
                                       r.import_status, " . IMP_STATUS . " AS status, s.attempts, sc.due_at AS callback_at,
                                       p.u AS bought, p.item AS bought_item, p.amount AS bought_amount, p.last_at AS bought_at
                                FROM caller_iq_import_rows r LEFT JOIN $S s ON s.n = r.phone_norm LEFT JOIN $P p ON p.u = r.user_id$SC
                                WHERE $where AND r.row_no > $last ORDER BY r.row_no LIMIT 2000");
        if (!$rows) break;
        $det = imp_page_details($conn, array_column($rows, 'phone_norm'), $since, $agent);
        foreach ($rows as $r) {
            $d = $det[$r['phone_norm']] ?? null;
            $cells = $r['data_json'] ? (json_decode($r['data_json'], true) ?: []) : [];
            $cells = array_pad($cells, count($headers), '');
            $status = IMP_STATUS_LABEL[$r['status']] ?? $r['status'];
            $imported = IMP_IMPORT_LABEL[$r['import_status']] ?? '';
            imp_csv($fp, array_merge($cells, [
                $r['phone_norm'], $r['phone_src'] === 'e' ? 'Email (student account)' : ($r['phone_src'] === 'f' ? 'File' : ''),
                (int)$r['total'], (int)$r['outgoing'], (int)$r['incoming'], (int)$r['missed'], (int)$r['connected'],
                (int)$r['talk_sec'], (int)$r['longest_sec'], $r['first_at'] ?? '', $r['last_at'] ?? '', (int)$r['agents'],
                $d ? implode(', ', array_map(fn($a) => ($devs[$a['device_id']] ?? $a['device_id']) . ' (' . $a['calls'] . ')', $d['agents_list'])) : '',
                $d['last_outcome'] ?? '', $d['last_notes'] ?? '', $status, $imported, (int)$r['attempts'], $r['callback_at'] ?? '',
                $r['called_by'], (string)$r['comment'], implode(', ', imp_tags_out((string)$r['tags'])),
                $r['bought'] !== null ? 'Yes' : 'No', $r['bought_item'] ?? '', $r['bought_amount'] ?? '', $r['bought_at'] ?? '',
            ]));
            $last = (int)$r['row_no'];
        }
        if (count($rows) < 2000) break;
    }
    fclose($fp);
    exit;
}

/* ── counselor notes ────────────────────────────────────────────────────── */
case 'annotate': {
    $id = (int)($in['id'] ?? 0);
    $rowId = (int)($in['row_id'] ?? 0);
    imp_get($conn, $id);
    if (!imp_all($conn, "SELECT id FROM caller_iq_import_rows WHERE id = $rowId AND import_id = $id")) api_error('Row not found', 404);
    $sets = []; $types = ''; $vals = [];
    if (array_key_exists('called_by', $in)) {
        $name = imp_clean_label((string)$in['called_by'], 80);
        if ($name !== '') $name = imp_remember($conn, 'caller_iq_callers', $name);
        $sets[] = 'called_by = ?'; $types .= 's'; $vals[] = $name;
    }
    if (array_key_exists('comment', $in)) {
        $sets[] = 'comment = ?'; $types .= 's'; $vals[] = mb_substr(trim((string)$in['comment']), 0, 2000);
    }
    if (array_key_exists('tags', $in)) {
        $tags = [];
        foreach ((array)$in['tags'] as $t) {
            $t = imp_clean_label((string)$t, 40);
            if ($t === '') continue;
            $t = imp_remember($conn, 'caller_iq_note_tags', $t);
            $tags[mb_strtolower($t)] = $t;   // one of each, whatever the case
        }
        $sets[] = 'tags = ?'; $types .= 's'; $vals[] = $tags ? ',' . implode(',', array_slice(array_values($tags), 0, 10)) . ',' : '';
    }
    if (!$sets) api_error('Nothing to save.');
    $now = date('Y-m-d H:i:s');
    $sets[] = 'noted_at = ?'; $types .= 's'; $vals[] = $now;
    $sets[] = 'noted_by = ?'; $types .= 'i'; $vals[] = $ME;
    $types .= 'ii'; $vals[] = $rowId; $vals[] = $id;
    $st = $conn->prepare("UPDATE caller_iq_import_rows SET " . implode(', ', $sets) . " WHERE id = ? AND import_id = ?");
    $st->bind_param($types, ...$vals);
    if (!$st->execute()) api_error('Could not save: ' . $st->error, 500);
    $st->close();
    $conn->query("UPDATE caller_iq_imports SET changed_at = '$now' WHERE id = $id");
    $row = imp_all($conn, "SELECT id, called_by, comment, tags, noted_at, noted_by FROM caller_iq_import_rows WHERE id = $rowId")[0];
    $row['id'] = (int)$row['id'];
    $row['tags'] = imp_tags_out((string)$row['tags']);
    $row['noted_by'] = (int)$row['noted_by'];
    $row['noted_by_name'] = imp_user_names($conn, [$ME])[$ME] ?? '';
    api_success(['row' => $row], 'Saved');
}

/* ── bulk actions on people, from the panel or a counselor's phone ──────── */
case 'bulk': {
    $id = (int)($in['id'] ?? 0);
    imp_get($conn, $id);
    $ids = array_values(array_unique(array_filter(array_map('intval', (array)($in['row_ids'] ?? [])))));
    if (!$ids) api_error('Pick at least one person.');
    if (count($ids) > 5000) api_error('Pick at most 5,000 people at a time.');
    $where = "import_id = $id AND id IN (" . implode(',', $ids) . ")";
    $now = date('Y-m-d H:i:s');
    switch ((string)($in['op'] ?? '')) {
        case 'status':
            $status = (string)($in['status'] ?? '');
            if (!in_array($status, IMP_IMPORT_STATUSES, true)) api_error('Pick a status.');
            $conn->query("UPDATE caller_iq_import_rows SET import_status = " . imp_e($conn, $status) . " WHERE $where");
            $changed = $conn->affected_rows;
            $conn->query("UPDATE caller_iq_imports SET changed_at = '$now' WHERE id = $id");
            break;
        case 'move':
            /* Into another list, numbered on after its last row; its columns may differ, so the
               original cells travel along as they were. */
            $to = (int)($in['to_id'] ?? 0);
            if ($to === $id) api_error('They are already on this list.');
            $dest = imp_get($conn, $to);
            if ($dest['status'] !== 'ready') api_error('That list is still uploading.');
            $base = (int)imp_all($conn, "SELECT COALESCE(MAX(row_no), 0) m FROM caller_iq_import_rows WHERE import_id = $to")[0]['m'];
            $conn->begin_transaction();
            $conn->query("SET @n := $base");
            $conn->query("UPDATE caller_iq_import_rows SET import_id = $to, row_no = (@n := @n + 1) WHERE $where ORDER BY row_no");
            $changed = $conn->affected_rows;
            imp_recount($conn, $id, $now);
            imp_recount($conn, $to, $now);
            $conn->commit();
            break;
        case 'delete':
            $conn->query("DELETE FROM caller_iq_import_rows WHERE $where");
            $changed = $conn->affected_rows;
            imp_recount($conn, $id, $now);
            break;
        default:
            api_error('Unknown bulk action.');
    }
    api_success(['changed' => $changed], 'Done');
}

case 'rename': {
    $id = (int)($in['id'] ?? 0);
    imp_get($conn, $id);
    $name = ciq_str($in['name'] ?? '', 160);
    if ($name === '') api_error('Give the import a name.');
    $st = $conn->prepare("UPDATE caller_iq_imports SET name = ? WHERE id = ?");
    $st->bind_param('si', $name, $id);
    $st->execute();
    api_success(['id' => $id, 'name' => $name], 'Renamed');
}

case 'delete': {
    $id = (int)($in['id'] ?? 0);
    imp_get($conn, $id);
    /* Large imports are deleted in slices so one request never holds a huge lock. */
    do { $conn->query("DELETE FROM caller_iq_import_rows WHERE import_id = $id LIMIT 20000"); } while ($conn->affected_rows > 0);
    $conn->query("DELETE FROM caller_iq_imports WHERE id = $id");
    api_success(['id' => $id], 'Import deleted');
}

default:
    api_error('Unknown action', 400);
}
