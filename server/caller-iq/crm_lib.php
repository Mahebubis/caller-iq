<?php
/**
 * crm_lib.php — the sales side of Caller IQ, shared by crm.php, imports.php and callbacks.php.
 * Requires ciq_lib.php (ciq_norm_number, ciq_str) to be loaded first.
 *
 *   caller_iq_contact_meta  one row per number: deal stage, BANT, sentiment, heat score, the
 *                           reason a lead was lost, an offer hold timer, WhatsApp reply / DND
 *   caller_iq_timeline      notes, dictations, stage changes, replies, referrals per number
 *   caller_iq_memos         voice notes (AAC, a few minutes at most) per number
 *   caller_iq_points        the points ledger: one row per award, idempotent by (device, rule, ref)
 *   caller_iq_wa_in         WhatsApp replies the bridge saw, once each (by WhatsApp message id)
 *   caller_iq_settings      team-wide settings: the points rules and the daily goal, the plans the
 *                           offer calculator prices, and the competitor battle matrix
 *
 * Times are written by PHP in India time, like the rest of Caller IQ.
 */

const CRM_STAGES     = ['new', 'contacted', 'interested', 'qualified', 'converted', 'lost'];
const CRM_SENTIMENTS = ['', 'hot', 'price', 'comparing', 'cold'];
const CRM_LOST       = ['', 'price', 'timing', 'competitor', 'unreachable', 'other'];
const CRM_DEFAULT_RULES = [
    'attempt'   => 10,   // a missed-call callback attempted
    'connected' => 25,   // a connected call with its outcome logged
    'ontime'    => 15,   // a scheduled callback made on time
    'hot'       => 50,   // a lead qualified hot (BANT 75% or more)
    'converted' => 200,  // a sale closed
    'referral'  => 100,  // a referral added
    'reply'     => 30,   // a lead replied on WhatsApp
    'offer'     => 20,   // a priced offer sent to a lead on WhatsApp during a call
];
/* Team settings the app may read and an admin may change (crm.php settings_get / settings_set). */
const CRM_SETTING_KEYS = ['plans', 'battle', 'wa_templates'];
const CRM_DEFAULT_GOAL = 100;
const CRM_RANKS = [[0, 'Rookie'], [2000, 'Closer'], [7500, 'Callback Ninja'], [20000, 'Grandmaster']];

function crm_ensure_schema(mysqli $conn): void
{
    static $done = false;
    if ($done) return;
    $done = true;
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_contact_meta (
        number_norm   VARCHAR(20)  NOT NULL,
        stage         VARCHAR(12)  NOT NULL DEFAULT '',
        sentiment     VARCHAR(12)  NOT NULL DEFAULT '',
        bant          TINYINT UNSIGNED NOT NULL DEFAULT 0,   -- bits: 1 budget, 2 authority, 4 need, 8 timeline
        heat          TINYINT UNSIGNED NOT NULL DEFAULT 0,
        lost_reason   VARCHAR(16)  NOT NULL DEFAULT '',
        offer_until   DATETIME     NULL,
        dnd           TINYINT(1)   NOT NULL DEFAULT 0,
        dnd_at        DATETIME     NULL,
        replied_at    DATETIME     NULL,
        reply_text    VARCHAR(500) NOT NULL DEFAULT '',
        reply_ack_at  DATETIME     NULL,
        activity_at   DATETIME     NULL,
        updated_at    DATETIME     NOT NULL,
        updated_by    VARCHAR(64)  NOT NULL DEFAULT '',
        PRIMARY KEY (number_norm),
        KEY k_stage (stage, activity_at),
        KEY k_reply (replied_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_timeline (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        number_norm VARCHAR(20)  NOT NULL,
        kind        VARCHAR(16)  NOT NULL,
        text        TEXT         NOT NULL,
        device_id   VARCHAR(64)  NOT NULL DEFAULT '',
        created_at  DATETIME     NOT NULL,
        PRIMARY KEY (id),
        KEY k_num (number_norm, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_memos (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        number_norm VARCHAR(20)  NOT NULL,
        mime        VARCHAR(40)  NOT NULL DEFAULT 'audio/mp4',
        duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
        data        MEDIUMBLOB   NOT NULL,
        device_id   VARCHAR(64)  NOT NULL DEFAULT '',
        created_at  DATETIME     NOT NULL,
        PRIMARY KEY (id),
        KEY k_num (number_norm, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_points (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        device_id   VARCHAR(64)  NOT NULL,
        rule        VARCHAR(16)  NOT NULL,
        points      INT          NOT NULL,
        ref         VARCHAR(80)  NOT NULL DEFAULT '',
        number_norm VARCHAR(20)  NOT NULL DEFAULT '',
        created_at  DATETIME     NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY u_award (device_id, rule, ref),
        KEY k_when (created_at, device_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_wa_in (
        msg_id      VARCHAR(120) NOT NULL,
        number_norm VARCHAR(20)  NOT NULL,
        text        VARCHAR(1000) NOT NULL DEFAULT '',
        opt_out     TINYINT(1)   NOT NULL DEFAULT 0,
        received_at DATETIME     NOT NULL,
        PRIMARY KEY (msg_id),
        KEY k_num (number_norm, received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_settings (
        k VARCHAR(40) NOT NULL,
        v MEDIUMTEXT  NOT NULL,
        PRIMARY KEY (k)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    /* competitor: the rival the lead mentioned on a call (Battle matrix, Analytics). */
    $r = $conn->query("SHOW COLUMNS FROM caller_iq_contact_meta LIKE 'competitor'");
    if ($r && $r->num_rows === 0) $conn->query("ALTER TABLE caller_iq_contact_meta ADD COLUMN competitor VARCHAR(40) NOT NULL DEFAULT '' AFTER lost_reason");
}

function crm_all(mysqli $conn, string $sql): array
{
    $res = $conn->query($sql);
    if ($res === false) throw new RuntimeException($conn->error);
    return $res === true ? [] : $res->fetch_all(MYSQLI_ASSOC);
}
function crm_e(mysqli $conn, $v): string { return "'" . $conn->real_escape_string((string)$v) . "'"; }
function crm_now(): string { return date('Y-m-d H:i:s'); }

/** The points rules and the daily goal, with defaults for anything never set. */
function crm_rules(mysqli $conn): array
{
    $rows = crm_all($conn, "SELECT k, v FROM caller_iq_settings WHERE k IN ('points_rules', 'daily_goal')");
    $kv = array_column($rows, 'v', 'k');
    $saved = json_decode($kv['points_rules'] ?? '{}', true) ?: [];
    $rules = [];
    foreach (CRM_DEFAULT_RULES as $k => $v) $rules[$k] = isset($saved[$k]) ? max(0, min(10000, (int)$saved[$k])) : $v;
    return ['rules' => $rules, 'goal' => max(1, (int)($kv['daily_goal'] ?? CRM_DEFAULT_GOAL))];
}

function crm_rank(int $total): array
{
    $cur = CRM_RANKS[0]; $next = null;
    foreach (CRM_RANKS as $i => $r) {
        if ($total >= $r[0]) { $cur = $r; $next = CRM_RANKS[$i + 1] ?? null; }
    }
    return ['name' => $cur[1], 'from' => $cur[0], 'next' => $next ? $next[1] : '', 'next_at' => $next ? $next[0] : 0];
}

/**
 * One award, at most once per (device, rule, ref). Returns the points given, 0 when it was
 * already given or the rule is worth nothing.
 */
function crm_award(mysqli $conn, string $device, string $rule, string $ref, string $number = ''): int
{
    if ($device === '' || !array_key_exists($rule, CRM_DEFAULT_RULES)) return 0;
    $pts = crm_rules($conn)['rules'][$rule];
    if ($pts <= 0) return 0;
    $ref = mb_substr($ref !== '' ? $ref : $number, 0, 80);
    $st = $conn->prepare("INSERT IGNORE INTO caller_iq_points (device_id, rule, points, ref, number_norm, created_at) VALUES (?,?,?,?,?,?)");
    $now = crm_now();
    $st->bind_param('ssisss', $device, $rule, $pts, $ref, $number, $now);
    $st->execute();
    $given = $st->affected_rows > 0 ? $pts : 0;
    $st->close();
    return $given;
}

function crm_timeline(mysqli $conn, string $number, string $kind, string $text, string $device): void
{
    $st = $conn->prepare("INSERT INTO caller_iq_timeline (number_norm, kind, text, device_id, created_at) VALUES (?,?,?,?,?)");
    $now = crm_now();
    $text = mb_substr($text, 0, 5000);
    $st->bind_param('sssss', $number, $kind, $text, $device, $now);
    $st->execute();
    $st->close();
}

/** Heat score 0-100: three fifths qualification (BANT), the rest how the buyer sounded. */
function crm_heat(int $bant, string $sentiment): int
{
    $b = 0;
    foreach ([1, 2, 4, 8] as $bit) if ($bant & $bit) $b += 25;
    $s = ['hot' => 40, 'comparing' => 20, 'price' => 15, 'cold' => 0, '' => 10][$sentiment] ?? 10;
    return max(0, min(100, (int)round($b * 0.6 + $s)));
}

/** LEFT JOIN of the meta row for import rows (alias cm), and the columns rows report from it. */
function crm_meta_join(mysqli $conn): string
{
    crm_ensure_schema($conn);
    return " LEFT JOIN caller_iq_contact_meta cm ON cm.number_norm = r.phone_norm";
}
const CRM_META_COLS = "cm.stage, cm.sentiment, cm.bant, cm.heat, cm.lost_reason, cm.competitor, cm.offer_until, cm.dnd, cm.replied_at, cm.reply_text, cm.reply_ack_at, cm.activity_at";

/** Opt-out words in a reply: STOP, DND, unsubscribe, "not interested" (English and Hindi). */
function crm_is_opt_out(string $text): bool
{
    return (bool)preg_match('/\b(stop|dnd|unsubscribe|not\s+interested|no\s+interest)\b|मत\s*भेज|बंद\s*करो|नहीं\s*चाहिए/iu', $text);
}
