<?php
/**
 * /api/caller-iq/callbacks.php  —  every number still owed a callback, across EVERY counselor's
 * phone, so any one phone (or the panel) can work through the whole team's list.
 * ---------------------------------------------------------------------------
 *   list { since: 'today' | '7' | '15' | '30' | 'all' (default '30'), q? }
 *        → { callbacks: [ { number, name, reason, since_at, last_at, missed, tries, calls,
 *                           agent, device_id, last_outcome, segment, import_id, import_status,
 *                           due_at, note, sched_device, sms_count, sms_at, wa_count, wa_at } ],
 *            total, since }
 *   schedule   { number, due_ms, note?, name? }  → sets the number's callback time (replaces any open one)
 *   unschedule { number }                       → clears it
 *   sms_log    { number, template?, body, channel? }  → records an SMS (or, with channel 'whatsapp',
 *              a WhatsApp message) a counselor sent that number; { items: [{ number, body }] } logs
 *              many at once (a WhatsApp campaign), at most 500
 *
 * A number is owed when its newest "owed" event — a missed / rejected / blocked call, or a call
 * tagged "Callback Scheduled" or "Not Answering" — is newer than the last call where someone
 * actually spoke to them (duration > 0, not itself tagged for a callback). Calling back and
 * getting through, from ANY phone, clears it for everyone. Computed live from caller_iq_calls,
 * matched on number_norm like the rest of Caller IQ; hidden test phones are left out.
 *
 * Calling lists add their own tasks (reason 'imported'): people imported as "Needs callback",
 * "Missed call" or "Pending follow-up" whom nobody has spoken to since the list was uploaded.
 * Every callback carries its segment — the newest calling list the number is on.
 *
 * Scheduled callbacks (reason 'scheduled', with due_at): a time someone set for calling a number
 * back, shared by the whole team. It stays open until someone speaks to the person after it was
 * set (then it is closed here), or it is cleared.
 * ---------------------------------------------------------------------------
 */
require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../middleware/auth.php';
require_once __DIR__ . '/ciq_lib.php';
require_once __DIR__ . '/crm_lib.php';

mysqli_report(MYSQLI_REPORT_OFF);
set_exception_handler(function (Throwable $e) {
    error_log('[caller-iq callbacks] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    api_error('Callbacks: ' . $e->getMessage(), 500);
});

$in     = get_json_input();
$action = (string)($in['action'] ?? 'list');

/* Same rule as imports.php: the phone app proves itself with CALLER_IQ_APP_KEY; it may read, set or
   clear a callback time, and log an SMS it sent — nothing else. */
$appKey = (string)($in['app_key'] ?? ($_SERVER['HTTP_X_CALLIQ_APP_KEY'] ?? ''));
$isApp  = !empty($in['device_id']) && $appKey !== '';
if ($isApp) {
    if (!defined('CALLER_IQ_APP_KEY') || !hash_equals((string)CALLER_IQ_APP_KEY, $appKey)) {
        api_error('This phone is not allowed to read callbacks.', 403);
    }
    if (!in_array($action, ['list', 'schedule', 'unschedule', 'sms_log'], true)) api_error('This action is only available in the admin panel.', 403);
    $ME = 0;
} else {
    $jwt = require_jwt();
    require_permission('caller_iq', $jwt);
    $ME = (int)($jwt['user_id'] ?? 0);
}

require_method('POST');
ciq_ensure_schema($conn);
/* Times are written by PHP in India time, like the rest of Caller IQ. */
$conn->query("CREATE TABLE IF NOT EXISTS caller_iq_schedules (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    number_norm VARCHAR(20)  NOT NULL,
    due_at      DATETIME     NOT NULL,
    note        VARCHAR(255) NOT NULL DEFAULT '',
    name        VARCHAR(190) NOT NULL DEFAULT '',
    device_id   VARCHAR(64)  NOT NULL DEFAULT '',
    created_by  INT          NULL,
    created_at  DATETIME     NOT NULL,
    done_at     DATETIME     NULL,
    PRIMARY KEY (id),
    KEY k_open (done_at, number_norm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
/* SMS counselors sent from the app, when a callback went unanswered. The app hands the text to
   the phone's messaging app, so sent_at is when it was handed over. */
$conn->query("CREATE TABLE IF NOT EXISTS caller_iq_sms (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    number_norm VARCHAR(20)  NOT NULL,
    template    VARCHAR(80)  NOT NULL DEFAULT '',
    body        TEXT         NOT NULL,
    device_id   VARCHAR(64)  NOT NULL DEFAULT '',
    created_by  INT          NULL,
    sent_at     DATETIME     NOT NULL,
    PRIMARY KEY (id),
    KEY k_num (number_norm, sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
/* 'sms' or 'whatsapp'; tables from before WhatsApp get the column, every old row an SMS. */
$hasChannel = $conn->query("SHOW COLUMNS FROM caller_iq_sms LIKE 'channel'");
if ($hasChannel && $hasChannel->num_rows === 0) {
    $conn->query("ALTER TABLE caller_iq_sms ADD COLUMN channel VARCHAR(12) NOT NULL DEFAULT 'sms' AFTER number_norm");
}

function cb_all(mysqli $conn, string $sql): array
{
    $res = $conn->query($sql);
    if ($res === false) throw new RuntimeException($conn->error);
    return $res->fetch_all(MYSQLI_ASSOC);
}
function cb_e(mysqli $conn, $v): string { return "'" . $conn->real_escape_string((string)$v) . "'"; }

const CB_HIDDEN   = "c.device_id NOT IN (SELECT device_id FROM caller_iq_devices WHERE is_hidden = 1)";
const CB_TAGS     = "('Callback Scheduled','Not Answering')";
const CB_OWED     = "(c.call_type IN ('MISSED','REJECTED','BLOCKED') OR c.outcome IN " . CB_TAGS . ")";
const CB_SPOKE    = "(c.duration_sec > 0 AND COALESCE(c.outcome, '') NOT IN " . CB_TAGS . ")";

/** Every call to these numbers, oldest first, grouped by number. */
function cb_calls_for(mysqli $conn, array $nums): array
{
    $out = [];
    foreach (array_chunk(array_values($nums), 1000) as $part) {
        $list = implode(',', array_map(fn($n) => cb_e($conn, (string)$n), $part));
        foreach (cb_all($conn, "SELECT c.number_norm, c.call_type, c.duration_sec, c.call_at, c.outcome FROM caller_iq_calls c
                                WHERE c.number_norm IN ($list) AND " . CB_HIDDEN . " ORDER BY c.call_at ASC") as $c) {
            $out[$c['number_norm']][] = $c;
        }
    }
    return $out;
}

/**
 * Since `$from`: whether someone spoke to the person, the unanswered rings, and the newest call.
 * With $settleAny, a conversation at any time counts (an imported task the list already shows as
 * connected); otherwise only one after $from (a callback time set at $from).
 */
function cb_since(array $calls, string $from, bool $settleAny): array
{
    $r = ['spoke' => false, 'tries' => 0, 'last' => $from];
    foreach ($calls as $c) {
        $spoke = (int)$c['duration_sec'] > 0 && !in_array((string)($c['outcome'] ?? ''), ['Callback Scheduled', 'Not Answering'], true);
        if ($c['call_at'] < $from) { if ($spoke && $settleAny) $r['spoke'] = true; continue; }
        if ($spoke) { $r['spoke'] = true; break; }
        if ($c['call_type'] === 'OUTGOING') $r['tries']++;
        $r['last'] = $c['call_at'];
    }
    return $r;
}

if ($action === 'schedule' || $action === 'unschedule') {
    $num = ciq_norm_number((string)($in['number'] ?? ''));
    if (strlen($num) < 6) api_error('That phone number is not valid.');
    $now = date('Y-m-d H:i:s');
    $st = $conn->prepare("UPDATE caller_iq_schedules SET done_at = ? WHERE number_norm = ? AND done_at IS NULL");
    $st->bind_param('ss', $now, $num); $st->execute(); $st->close();
    if ($action === 'unschedule') api_success(['number' => $num], 'Callback cleared');

    $ms = (float)($in['due_ms'] ?? 0);
    if ($ms < (time() - 86400) * 1000 || $ms > (time() + 366 * 86400) * 1000) api_error('Pick a callback time within the next year.');
    $due  = date('Y-m-d H:i:s', (int)floor($ms / 1000));
    $note = ciq_str($in['note'] ?? '', 255);
    $name = ciq_str($in['name'] ?? '', 190);
    $dev  = ciq_str($in['device_id'] ?? '', 64);
    $st = $conn->prepare("INSERT INTO caller_iq_schedules (number_norm, due_at, note, name, device_id, created_by, created_at) VALUES (?,?,?,?,?,?,?)");
    $st->bind_param('sssssis', $num, $due, $note, $name, $dev, $ME, $now);
    if (!$st->execute()) api_error('Could not save the callback time: ' . $st->error, 500);
    api_success(['schedule' => ['number' => $num, 'due_at' => $due, 'note' => $note]], 'Callback scheduled');
}

if ($action === 'sms_log') {
    $channel = (string)($in['channel'] ?? 'sms') === 'whatsapp' ? 'whatsapp' : 'sms';
    $tpl = ciq_str($in['template'] ?? '', 80);
    $dev = ciq_str($in['device_id'] ?? '', 64);
    $now = date('Y-m-d H:i:s');
    $items = isset($in['items']) && is_array($in['items']) ? $in['items'] : [['number' => $in['number'] ?? '', 'body' => $in['body'] ?? '']];
    if (count($items) > 500) api_error('Log at most 500 messages at a time.');
    $st = $conn->prepare("INSERT INTO caller_iq_sms (number_norm, channel, template, body, device_id, created_by, sent_at) VALUES (?,?,?,?,?,?,?)");
    $logged = [];
    foreach ($items as $it) {
        $num = ciq_norm_number((string)($it['number'] ?? ''));
        $body = mb_substr(trim((string)($it['body'] ?? '')), 0, 1000);
        if (strlen($num) < 6 || $body === '') {
            if (count($items) === 1) api_error(strlen($num) < 6 ? 'That phone number is not valid.' : 'The message is empty.');
            continue;
        }
        $st->bind_param('sssssis', $num, $channel, $tpl, $body, $dev, $ME, $now);
        if (!$st->execute()) api_error('Could not log the message: ' . $st->error, 500);
        $logged[$num] = true;
    }
    $st->close();
    if (count($items) === 1) {
        $num = (string)array_key_first($logged);
        $n = (int)cb_all($conn, "SELECT COUNT(*) n FROM caller_iq_sms WHERE number_norm = " . cb_e($conn, $num) . " AND channel = " . cb_e($conn, $channel))[0]['n'];
        api_success(['number' => $num, 'channel' => $channel, 'sms_at' => $now, 'sms_count' => $n], $channel === 'whatsapp' ? 'WhatsApp logged' : 'SMS logged');
    }
    api_success(['logged' => count($logged), 'channel' => $channel, 'at' => $now], 'Messages logged');
}

if ($action !== 'list') api_error('Unknown action', 400);

/* All times are written by PHP in India time, so the window is too. */
$sinceKey = (string)($in['since'] ?? '30');
switch ($sinceKey) {
    case 'today': $since = date('Y-m-d 00:00:00'); break;
    case '7':     $since = date('Y-m-d 00:00:00', strtotime('-6 days')); break;
    case '15':    $since = date('Y-m-d 00:00:00', strtotime('-14 days')); break;
    case 'all':   $since = ''; break;
    default:      $sinceKey = '30'; $since = date('Y-m-d 00:00:00', strtotime('-29 days'));
}
$sinceSql = $since !== '' ? ' AND c.call_at >= ' . cb_e($conn, $since) : '';

/* 1 — which numbers are owed: one grouped pass over the window. */
$owed = cb_all($conn, "SELECT c.number_norm AS n,
                              MAX(CASE WHEN " . CB_OWED . " THEN c.call_at END) AS owed_at,
                              MAX(CASE WHEN " . CB_SPOKE . " THEN c.call_at END) AS spoke_at
                       FROM caller_iq_calls c
                       WHERE " . CB_HIDDEN . " AND c.number_norm <> ''$sinceSql
                       GROUP BY c.number_norm
                       HAVING owed_at IS NOT NULL AND (spoke_at IS NULL OR spoke_at < owed_at)
                       ORDER BY owed_at DESC
                       LIMIT 1000");
$out = [];
$numList = implode(',', array_map(fn($n) => cb_e($conn, $n), array_column($owed, 'n')));
$spokeAt = array_column($owed, 'spoke_at', 'n');

/* 2 — what happened since each number was last spoken to: why it is owed, how many times they
   rang, how many times we rang back without getting through, and on whose phone. */
foreach ($owed ? cb_all($conn, "SELECT c.number_norm, c.call_type, c.duration_sec, c.call_at, c.device_id, c.outcome
                                FROM caller_iq_calls c
                                WHERE c.number_norm IN ($numList) AND " . CB_HIDDEN . "$sinceSql
                                ORDER BY c.call_at ASC") : [] as $c) {
    $n = $c['number_norm'];
    if ($spokeAt[$n] !== null && $c['call_at'] <= $spokeAt[$n]) continue;    // settled before
    $tag = (string)($c['outcome'] ?? '');
    $o = &$out[$n];
    if ($o === null) $o = ['number' => $n, 'reason' => '', 'since_at' => null, 'last_at' => null, 'missed' => 0, 'tries' => 0,
                           'calls' => 0, 'device_id' => '', 'last_outcome' => '', 'segment' => '', 'import_id' => 0, 'import_status' => '',
                           'due_at' => '', 'note' => ''];
    $o['calls']++;
    $o['last_at'] = $c['call_at'];
    if ($tag !== '') $o['last_outcome'] = $tag;
    $isMissed = in_array($c['call_type'], ['MISSED', 'REJECTED', 'BLOCKED'], true);
    if ($tag === 'Callback Scheduled' || $tag === 'Not Answering' || $isMissed) {
        if ($o['since_at'] === null) $o['since_at'] = $c['call_at'];
        $o['device_id'] = $c['device_id'];                                  // whose phone it is owed on
        if ($isMissed) $o['missed']++;
        // A scheduled callback outranks "not answering", which outranks a plain missed call.
        $rank = ['missed' => 1, 'no_answer' => 2, 'callback' => 3];
        $why = $tag === 'Callback Scheduled' ? 'callback' : ($tag === 'Not Answering' ? 'no_answer' : 'missed');
        if ($o['reason'] === '' || $rank[$why] >= $rank[$o['reason']]) $o['reason'] = $why;
    } elseif ($o['since_at'] !== null) {
        $o['tries']++;                                                      // rang back, nobody answered
    }
    unset($o);
}
$out = array_filter($out, fn($o) => $o['since_at'] !== null);

/* 3 — callback tasks from calling lists, for numbers the call log does not already owe. */
$t = $conn->query("SHOW TABLES LIKE 'caller_iq_import_rows'");
$hasImports = $t && $t->num_rows > 0;
$t = $hasImports ? $conn->query("SHOW COLUMNS FROM caller_iq_import_rows LIKE 'import_status'") : false;
if ($t && $t->num_rows > 0) {
    $impSince = $since !== '' ? ' AND i.created_at >= ' . cb_e($conn, $since) : '';
    $tasks = [];
    foreach (cb_all($conn, "SELECT r.phone_norm, r.import_status, i.id AS import_id, i.name AS segment, i.created_at
                            FROM caller_iq_import_rows r JOIN caller_iq_imports i ON i.id = r.import_id
                            WHERE r.import_status IN ('needs_callback', 'missed_call', 'pending_followup')
                              AND r.phone_norm <> '' AND r.called_by = '' AND i.status = 'ready'$impSince
                            ORDER BY r.id DESC LIMIT 3000") as $r) {
        if (!isset($tasks[$r['phone_norm']]) && !isset($out[$r['phone_norm']])) $tasks[$r['phone_norm']] = $r;   // newest list wins
    }
    /* Settled by any real conversation, as the list's own status counts it; tries are the
       unanswered rings since the upload. */
    $calls = $tasks ? cb_calls_for($conn, array_keys($tasks)) : [];
    foreach ($tasks as $n => $tk) {
        $r = cb_since($calls[$n] ?? [], $tk['created_at'], true);
        if ($r['spoke']) continue;
        $out[$n] = ['number' => $n, 'reason' => 'imported', 'since_at' => $tk['created_at'], 'last_at' => $r['last'], 'missed' => 0,
                    'tries' => $r['tries'], 'calls' => $r['tries'], 'device_id' => '', 'last_outcome' => '',
                    'segment' => $tk['segment'], 'import_id' => (int)$tk['import_id'], 'import_status' => $tk['import_status'],
                    'due_at' => '', 'note' => ''];
    }
}

/* 4 — callback times set by hand, whatever the window: closed here once someone has spoken to
   the person since; otherwise they lead the number's entry. */
$sched = [];
foreach (cb_all($conn, "SELECT id, number_norm, due_at, note, name, device_id, created_at FROM caller_iq_schedules
                        WHERE done_at IS NULL ORDER BY id DESC LIMIT 2000") as $x) {
    if (!isset($sched[$x['number_norm']])) $sched[$x['number_norm']] = $x;
}
$schedNames = [];
if ($sched) {
    $calls = cb_calls_for($conn, array_keys($sched));
    $closed = [];
    foreach ($sched as $n => $x) {
        $n = (string)$n;
        $r = cb_since($calls[$n] ?? [], $x['created_at'], false);
        if ($r['spoke']) { $closed[] = (int)$x['id']; continue; }
        if (!isset($out[$n])) {
            $out[$n] = ['number' => $n, 'reason' => 'scheduled', 'since_at' => $x['created_at'], 'last_at' => $r['last'], 'missed' => 0,
                        'tries' => $r['tries'], 'calls' => $r['tries'], 'device_id' => $x['device_id'], 'last_outcome' => '',
                        'segment' => '', 'import_id' => 0, 'import_status' => '', 'due_at' => '', 'note' => ''];
        }
        $out[$n]['reason'] = 'scheduled';
        $out[$n]['due_at'] = $x['due_at'];
        $out[$n]['note']   = $x['note'];
        $out[$n]['sched_device'] = $x['device_id'];   // the phone that set it rings for it
        if ($x['name'] !== '') $schedNames[$n] = $x['name'];
    }
    if ($closed) $conn->query("UPDATE caller_iq_schedules SET done_at = " . cb_e($conn, date('Y-m-d H:i:s')) . " WHERE id IN (" . implode(',', $closed) . ")");
}
if (!$out) api_success(['callbacks' => [], 'total' => 0, 'since' => $sinceKey]);

/* 5 — who: the counselor's phone, and the person's name and segment from the calling lists. */
$agents = [];
foreach (cb_all($conn, "SELECT device_id, agent_name FROM caller_iq_devices") as $d) $agents[$d['device_id']] = (string)$d['agent_name'];
$names = []; $segs = [];
if ($hasImports) {
    $allList = implode(',', array_map(fn($n) => cb_e($conn, (string)$n), array_keys($out)));
    foreach (cb_all($conn, "SELECT r.phone_norm, r.name, i.id AS import_id, i.name AS segment
                            FROM caller_iq_import_rows r JOIN caller_iq_imports i ON i.id = r.import_id
                            WHERE r.phone_norm IN ($allList) ORDER BY r.id DESC") as $r) {
        $p = $r['phone_norm'];
        if (!isset($names[$p]) && $r['name'] !== '') $names[$p] = $r['name'];
        if (!isset($segs[$p])) $segs[$p] = $r;
    }
}

/* SMS and WhatsApp messages already sent to each number. */
$sms = [];
foreach (cb_all($conn, "SELECT number_norm, SUM(channel <> 'whatsapp') n, MAX(IF(channel <> 'whatsapp', sent_at, NULL)) at,
                               SUM(channel = 'whatsapp') wn, MAX(IF(channel = 'whatsapp', sent_at, NULL)) wat
                        FROM caller_iq_sms WHERE number_norm IN (" .
                        implode(',', array_map(fn($n) => cb_e($conn, (string)$n), array_keys($out))) . ") GROUP BY number_norm") as $x) {
    $sms[$x['number_norm']] = $x;
}

/* Deal fields: heat score, stage, DND (a DND number is never sent bulk WhatsApp). */
crm_ensure_schema($conn);
$meta = [];
foreach (array_chunk(array_map('strval', array_keys($out)), 1000) as $part) {
    foreach (cb_all($conn, "SELECT number_norm, heat, stage, dnd, replied_at FROM caller_iq_contact_meta WHERE number_norm IN (" .
                            implode(',', array_map(fn($n) => cb_e($conn, $n), $part)) . ")") as $x) $meta[$x['number_norm']] = $x;
}

$q = strtolower(trim((string)($in['q'] ?? '')));
$qDigits = preg_replace('/\D+/', '', $q);
$list = [];
foreach ($out as $n => $o) {
    $n = (string)$n;
    $o['number'] = (string)$o['number'];
    $o['name']  = $names[$n] ?? ($schedNames[$n] ?? '');
    $o['sms_count'] = (int)($sms[$n]['n'] ?? 0);
    $o['sms_at'] = $sms[$n]['at'] ?? '';
    $o['wa_count'] = (int)($sms[$n]['wn'] ?? 0);
    $o['wa_at'] = $sms[$n]['wat'] ?? '';
    $o['heat'] = (int)($meta[$n]['heat'] ?? 0);
    $o['stage'] = (string)($meta[$n]['stage'] ?? '');
    $o['dnd'] = (int)($meta[$n]['dnd'] ?? 0);
    $o['replied_at'] = $meta[$n]['replied_at'] ?? '';
    $o['agent'] = $agents[$o['device_id']] ?? '';
    if ($o['segment'] === '' && isset($segs[$n])) { $o['segment'] = $segs[$n]['segment']; $o['import_id'] = (int)$segs[$n]['import_id']; }
    if ($q !== '') {
        $hit = ($qDigits !== '' && strpos($n, $qDigits) !== false)
            || strpos(strtolower($o['name']), $q) !== false
            || strpos(strtolower($o['agent']), $q) !== false
            || strpos(strtolower($o['segment']), $q) !== false;
        if (!$hit) continue;
    }
    $list[] = $o;
}
usort($list, fn($a, $b) => strcmp((string)$b['last_at'], (string)$a['last_at']));

api_success(['callbacks' => $list, 'total' => count($list), 'since' => $sinceKey]);
