<?php
/**
 * Shared by desk.php (the SIM & WhatsApp Desk API) and desk_cron.php (daily reminder email).
 * Requires config/database.php ($conn) to be loaded first.
 *
 * The desk stores its data as seven slices (phones, sims, was, payments, recurring, activity,
 * settings), each a JSON document saved whole by the desk frontend — see the frontend's
 * README → "Backend API contract". Call stats come live from caller_iq_calls.
 */

date_default_timezone_set('Asia/Kolkata');   // same clock as the rest of Caller IQ

const DESK_LIST_SLICES = ['phones', 'sims', 'was', 'payments', 'recurring', 'activity', 'calling'];
const DESK_SLICES = ['phones', 'sims', 'was', 'payments', 'recurring', 'activity', 'calling', 'settings', 'community'];
const DESK_DEFAULT_SETTINGS = ['reminders' => ['d3' => true, 'd1' => true, 'onExpiry' => true, 'deact90' => true], 'lastSync' => 0, 'reminderEmail' => ''];
const DESK_EVENTS = ['assignSim', 'moveSimToPouch', 'updateSim', 'deleteSim', 'deleteSims', 'assignWhatsApp', 'updateWhatsApp', 'deleteWhatsApp', 'recordRecharge', 'bulkRecharge',
    'addPhone', 'updatePhone', 'deletePhone', 'importSims', 'importWhatsApps', 'addPayment', 'saveRecurring', 'saveReminders', 'sendReminders'];

class DeskError extends RuntimeException {}

function desk_ensure_schema(mysqli $conn): void
{
    $conn->query("CREATE TABLE IF NOT EXISTS sim_desk_slices (
        slice      VARCHAR(20)  NOT NULL,
        json       LONGTEXT     NOT NULL,
        updated_at DATETIME     NOT NULL,
        updated_by INT          NULL,
        PRIMARY KEY (slice)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $conn->query("CREATE TABLE IF NOT EXISTS sim_desk_events (
        id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
        name    VARCHAR(40)  NOT NULL,
        payload LONGTEXT     NULL,
        user_id INT          NULL,
        at      DATETIME     NOT NULL,
        PRIMARY KEY (id),
        KEY k_at (at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $conn->query("CREATE TABLE IF NOT EXISTS sim_desk_meta (
        k VARCHAR(60)  NOT NULL,
        v VARCHAR(255) NULL,
        PRIMARY KEY (k)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

function desk_all(mysqli $conn, string $sql): array
{
    $res = $conn->query($sql);
    if ($res === false) throw new RuntimeException($conn->error);
    return $res === true ? [] : $res->fetch_all(MYSQLI_ASSOC);
}
function desk_e(mysqli $conn, $v): string { return "'" . $conn->real_escape_string((string)$v) . "'"; }
function desk_now(): string { return date('Y-m-d H:i:s'); }

/* ── Slices ─────────────────────────────────────────────────────────────── */

function desk_get_slice(mysqli $conn, string $slice)
{
    $rows = desk_all($conn, "SELECT json FROM sim_desk_slices WHERE slice = " . desk_e($conn, $slice));
    if (!$rows) return $slice === 'settings' ? DESK_DEFAULT_SETTINGS : ($slice === 'community' ? null : []);
    return json_decode($rows[0]['json'], true);
}

function desk_put_slice(mysqli $conn, string $slice, $value, ?int $userId): void
{
    $json = json_encode($value, JSON_UNESCAPED_UNICODE);
    $st = $conn->prepare("INSERT INTO sim_desk_slices (slice, json, updated_at, updated_by) VALUES (?, ?, ?, ?)
                          ON DUPLICATE KEY UPDATE json = VALUES(json), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)");
    $now = desk_now();
    $st->bind_param('sssi', $slice, $json, $now, $userId);
    if (!$st->execute()) throw new RuntimeException($st->error);
}

/** The whole desk as the frontend expects it, with Caller IQ call stats filled into each SIM. */
function desk_load(mysqli $conn): array
{
    $desk = [];
    foreach (DESK_SLICES as $k) $desk[$k] = desk_get_slice($conn, $k);
    $stats = desk_call_stats($conn, $desk['sims'], $desk['phones']);
    foreach ($desk['sims'] as &$s) {
        if (isset($stats[$s['id']])) { $s['calls'] = $stats[$s['id']]['calls']; $s['talkMins'] = $stats[$s['id']]['talkMins']; }
    }
    unset($s);
    $ussd = desk_ussd_status($conn, $desk['sims'], $desk['phones']);
    foreach ($desk['sims'] as &$s) {
        if (isset($ussd[$s['id']])) $s['ussd'] = $ussd[$s['id']]; else unset($s['ussd']);
    }
    unset($s);
    return $desk;
}

function desk_log_event(mysqli $conn, string $name, $payload, ?int $userId): void
{
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE);
    $now = desk_now();
    $st = $conn->prepare("INSERT INTO sim_desk_events (name, payload, user_id, at) VALUES (?, ?, ?, ?)");
    $st->bind_param('ssis', $name, $json, $userId, $now);
    $st->execute();
}

function desk_meta(mysqli $conn, string $k): ?string
{
    $r = desk_all($conn, "SELECT v FROM sim_desk_meta WHERE k = " . desk_e($conn, $k));
    return $r ? $r[0]['v'] : null;
}
function desk_set_meta(mysqli $conn, string $k, string $v): void
{
    $conn->query("INSERT INTO sim_desk_meta (k, v) VALUES (" . desk_e($conn, $k) . ", " . desk_e($conn, $v) . ") ON DUPLICATE KEY UPDATE v = VALUES(v)");
}

/* ── Caller IQ ──────────────────────────────────────────────────────────── */

/** Which of these columns caller_iq_calls actually has (log_call.php owns that table). */
function desk_calls_column(mysqli $conn, array $candidates): ?string
{
    static $cols = null;
    if ($cols === null) {
        $exists = desk_all($conn, "SHOW TABLES LIKE 'caller_iq_calls'");
        $cols = $exists ? array_column(desk_all($conn, "SHOW COLUMNS FROM caller_iq_calls"), 'Field') : [];
    }
    foreach ($candidates as $c) if (in_array($c, $cols, true)) return $c;
    return null;
}

/**
 * Calls and talk minutes per desk SIM over the last 30 days, from every phone running Caller IQ.
 * caller_iq_calls.number_norm is the OTHER party, so a SIM is matched by what the phone reported
 * about its own line:
 *   1. the SIM's own number (sim_msisdn), when the network wrote it to the card;
 *   2. otherwise the Caller IQ phone the desk phone is linked to (phone.ciqDeviceId) + the SIM's slot.
 * Returns [simId => ['calls' => n, 'talkMins' => n]]; SIMs with no match are left out.
 */
function desk_call_stats(mysqli $conn, array $sims, array $phones): array
{
    if (!$sims) return [];
    $msisdnCol = desk_calls_column($conn, ['sim_msisdn', 'msisdn']);
    $slotCol = desk_calls_column($conn, ['sim_slot', 'slot']);
    if (!$msisdnCol && !$slotCol) return [];

    $since = desk_e($conn, date('Y-m-d H:i:s', strtotime('-30 days')));
    $hidden = "device_id NOT IN (SELECT device_id FROM caller_iq_devices WHERE is_hidden = 1)";
    $out = [];

    if ($msisdnCol) {
        $nums = array_map(fn($s) => desk_e($conn, $s['number']), $sims);
        $rows = desk_all($conn, "SELECT RIGHT($msisdnCol, 10) n, COUNT(*) calls, COALESCE(SUM(duration_sec), 0) talk
                                 FROM caller_iq_calls WHERE call_at >= $since AND RIGHT($msisdnCol, 10) IN (" . implode(',', $nums) . ") AND $hidden
                                 GROUP BY RIGHT($msisdnCol, 10)");
        $byNum = array_column($rows, null, 'n');
        foreach ($sims as $s) {
            if (isset($byNum[$s['number']])) $out[$s['id']] = ['calls' => (int)$byNum[$s['number']]['calls'], 'talkMins' => (int)round($byNum[$s['number']]['talk'] / 60)];
        }
    }

    if ($slotCol) {
        $pairs = array_diff_key(desk_sim_links($sims, $phones), $out);
        if ($pairs) {
            $ids = implode(',', array_unique(array_map(fn($p) => desk_e($conn, $p[0]), $pairs)));
            $rows = desk_all($conn, "SELECT device_id, $slotCol slot, COUNT(*) calls, COALESCE(SUM(duration_sec), 0) talk
                                     FROM caller_iq_calls WHERE call_at >= $since AND device_id IN ($ids)
                                     GROUP BY device_id, $slotCol");
            $by = [];
            foreach ($rows as $r) $by[$r['device_id'] . '#' . (int)$r['slot']] = $r;
            foreach ($pairs as $simId => [$dev, $slot]) {
                if ($r = $by["$dev#$slot"] ?? null) $out[$simId] = ['calls' => (int)$r['calls'], 'talkMins' => (int)round($r['talk'] / 60)];
            }
        }
    }
    return $out;
}

/**
 * [simId => [Caller IQ device id, slot 1|2]] for SIMs in desk phones linked to a Caller IQ phone.
 * The slot is sim.ciqSlot if set, else the slot the desk shows (same rule as the frontend's slotLayout:
 * a SIM's saved slot first, the others fill the free slots in order).
 */
function desk_sim_links(array $sims, array $phones): array
{
    $out = [];
    $byId = array_column($sims, null, 'id');
    foreach ($phones as $p) {
        if (empty($p['ciqDeviceId'])) continue;
        $on = array_values(array_filter($sims, fn($s) => ($s['phoneId'] ?? null) === $p['id']));
        $n = max((int)($p['simSlots'] ?? 2), count($on));
        $slots = array_fill(1, $n, null);
        foreach ($on as $s) { $k = (int)($s['slot'] ?? 0); if ($k >= 1 && $k <= $n && !$slots[$k]) $slots[$k] = $s['id']; }
        foreach ($on as $s) {
            if (in_array($s['id'], $slots, true)) continue;
            $k = array_search(null, $slots, true);
            if ($k === false) $slots[] = $s['id']; else $slots[$k] = $s['id'];
        }
        foreach ($slots as $k => $id) if ($id) $out[$id] = [(string)$p['ciqDeviceId'], (int)($byId[$id]['ciqSlot'] ?? 0) ?: $k];
    }
    return $out;
}

/**
 * The latest "valid till" / balance Caller IQ's daily USSD check reported for each linked SIM
 * (the app posts device_id, slot, valid_till, balance, checked_at to sim_status.php).
 * sim_status.php isn't in this repo, so its table and columns are found at runtime; if they can't be
 * found the desk simply works without it. Returns [simId => ['validTill', 'balance', 'checkedAt' (ms)]].
 */
function desk_ussd_status(mysqli $conn, array $sims, array $phones): array
{
    $table = null;
    foreach (['caller_iq_sim_status', 'caller_iq_ussd', 'caller_iq_sims', 'sim_status'] as $t) {
        if (desk_all($conn, 'SHOW TABLES LIKE ' . desk_e($conn, $t))) { $table = $t; break; }
    }
    if (!$table) return [];
    $cols = array_column(desk_all($conn, "SHOW COLUMNS FROM `$table`"), 'Field');
    $pick = function (array $names) use ($cols) { foreach ($names as $n) if (in_array($n, $cols, true)) return $n; return null; };
    $slotCol = $pick(['slot', 'sim_slot']);
    $validCol = $pick(['valid_till', 'validity', 'valid_until']);
    $balCol = $pick(['balance']);
    $atCol = $pick(['checked_at', 'created_at', 'updated_at']);
    if (!in_array('device_id', $cols, true) || !$slotCol || !$validCol) return [];
    $links = desk_sim_links($sims, $phones);
    if (!$links) return [];
    $ids = implode(',', array_unique(array_map(fn($l) => desk_e($conn, $l[0]), $links)));
    $order = $atCol ? "`$atCol` DESC" : ($pick(['id']) ? 'id DESC' : '1');
    $rows = desk_all($conn, "SELECT device_id, `$slotCol` slot, `$validCol` valid_till, " . ($balCol ? "`$balCol`" : 'NULL') . ' balance, '
        . ($atCol ? "`$atCol`" : 'NULL') . " checked_at FROM `$table`
        WHERE device_id IN ($ids) AND `$validCol` IS NOT NULL AND `$validCol` <> '' ORDER BY $order LIMIT 5000");
    $latest = [];
    foreach ($rows as $r) { $k = $r['device_id'] . '#' . (int)$r['slot']; if (!isset($latest[$k])) $latest[$k] = $r; }
    $out = [];
    foreach ($links as $simId => [$dev, $slot]) {
        $r = $latest["$dev#$slot"] ?? null;
        $till = $r ? substr((string)$r['valid_till'], 0, 10) : '';
        if (!desk_is_date($till)) continue;
        $at = $r['checked_at'];
        $ms = is_numeric($at) ? ((float)$at > 1e11 ? (int)$at : (int)$at * 1000) : ($at ? (strtotime((string)$at) ?: 0) * 1000 : null);
        $out[$simId] = ['validTill' => $till, 'balance' => $r['balance'] === null || $r['balance'] === '' ? null : (string)$r['balance'], 'checkedAt' => $ms ?: null];
    }
    return $out;
}

/** Caller IQ phones the desk can link a handset to (Phone.ciqDeviceId). */
function desk_ciq_devices(mysqli $conn): array
{
    if (!desk_all($conn, "SHOW TABLES LIKE 'caller_iq_devices'")) return [];
    $last = desk_calls_column($conn, ['call_at']) ? "(SELECT MAX(c.call_at) FROM caller_iq_calls c WHERE c.device_id = d.device_id)" : 'NULL';
    return array_map(fn($r) => ['deviceId' => $r['device_id'], 'agent' => $r['agent_name'] ?? '', 'team' => $r['team'] ?? '', 'lastCallAt' => $r['last_call_at']],
        desk_all($conn, "SELECT d.device_id, d.agent_name, d.team, $last last_call_at FROM caller_iq_devices d WHERE d.is_hidden = 0 ORDER BY d.agent_name"));
}

/* ── Validation (mirrors the frontend's data model and business rules) ─── */

const DESK_CARRIERS = ['Airtel', 'Jio', 'Vi', 'BSNL', 'Unknown', ''];   // '' = the sheet doesn't say
const DESK_CATS = ['SIM recharge', 'Blue tick', 'WhatsApp API', 'Other'];
const DESK_WA_TYPES = ['WA Business', 'WhatsApp', 'WA API'];
const DESK_HEALTH = ['Online', 'QR Required', 'Restricted', 'Unknown'];
const DESK_POWER = ['on', 'off', 'offline'];

function desk_fail(string $msg): void { throw new DeskError($msg); }
function desk_is_date($v): bool { return is_string($v) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) && checkdate((int)substr($v, 5, 2), (int)substr($v, 8, 2), (int)substr($v, 0, 4)); }
function desk_is_num($v): bool { return is_int($v) || is_float($v); }
function desk_ref($v): bool { return $v === null || is_string($v); }
/** First key of $x that is set but not a string / not a bool (null = not set). */
function desk_bad_str(array $x, array $keys): ?string { foreach ($keys as $k) if (isset($x[$k]) && !is_string($x[$k])) return $k; return null; }
function desk_bad_bool(array $x, array $keys): ?string { foreach ($keys as $k) if (isset($x[$k]) && !is_bool($x[$k])) return $k; return null; }

function desk_each($items, string $what, callable $check): void
{
    if (!is_array($items) || ($items && array_keys($items) !== range(0, count($items) - 1))) desk_fail("$what: expected { items: [...] }");
    $ids = [];
    foreach ($items as $i => $x) {
        if (!is_array($x)) desk_fail("{$what}[$i]: not an object");
        if (!isset($x['id']) || !is_string($x['id']) || $x['id'] === '') desk_fail("{$what}[$i]: missing id");
        if (isset($ids[$x['id']])) desk_fail("$what: duplicate id {$x['id']}");
        $ids[$x['id']] = true;
        if ($err = $check($x)) desk_fail("$what " . (isset($x['number']) ? '+91 ' . $x['number'] : $x['id']) . ": $err");
    }
}

/** Each phone holds at most simSlots SIMs / waSlots WhatsApp accounts. */
function desk_capacity(array $items, string $slotKey, string $label, array $phones): void
{
    $byId = array_column($phones, null, 'id');
    $used = [];
    foreach ($items as $x) {
        if (empty($x['phoneId'])) continue;
        $ph = $byId[$x['phoneId']] ?? null;
        if (!$ph) desk_fail("$label +91 {$x['number']} is assigned to a phone that doesn't exist ({$x['phoneId']})");
        $used[$x['phoneId']] = ($used[$x['phoneId']] ?? 0) + 1;
        if ($used[$x['phoneId']] > $ph[$slotKey]) desk_fail("{$ph['name']} can hold only {$ph[$slotKey]} $label" . ($ph[$slotKey] === 1 ? '' : 's'));
    }
}

/** Returns what to store for this slice; throws DeskError with a message the desk shows. */
function desk_validate(mysqli $conn, string $slice, $body)
{
    if (!is_array($body)) desk_fail('Body must be JSON');
    if ($slice === 'settings') {
        $r = $body['reminders'] ?? [];
        foreach (['d3', 'd1', 'onExpiry', 'deact90'] as $k) if (!is_bool($r[$k] ?? null)) desk_fail('settings.reminders needs d3, d1, onExpiry, deact90 as true/false');
        $email = is_string($body['reminderEmail'] ?? null) ? trim($body['reminderEmail']) : '';
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) desk_fail('settings.reminderEmail is not a valid email');
        return ['reminders' => ['d3' => $r['d3'], 'd1' => $r['d1'], 'onExpiry' => $r['onExpiry'], 'deact90' => $r['deact90']],
                'lastSync' => desk_is_num($body['lastSync'] ?? null) ? $body['lastSync'] : 0, 'reminderEmail' => $email,
                'reminderWhatsApp' => implode(', ', desk_wa_numbers($body['reminderWhatsApp'] ?? ''))];
    }
    if ($slice === 'community') {
        $data = $body['data'] ?? null;
        if ($data !== null && !is_array($data)) desk_fail('community: expected { data: {...} }');
        return $data ?: null;
    }
    $items = $body['items'] ?? null;
    switch ($slice) {
        case 'phones':
            desk_each($items, 'phones', function ($p) {
                if (!is_string($p['name'] ?? null) || trim($p['name']) === '') return 'name is required';
                if (!in_array($p['simSlots'] ?? null, [1, 2], true)) return 'simSlots must be 1 or 2';
                if (!in_array($p['waSlots'] ?? null, [1, 2, 3], true)) return 'waSlots must be 1, 2 or 3';
                if (isset($p['power']) && !in_array($p['power'], DESK_POWER, true)) return 'unknown power state ' . $p['power'];
                $bad = desk_bad_str($p, ['model', 'owner', 'agent', 'ciqDeviceId']) ?? desk_bad_bool($p, ['archived']);
                return $bad ? "bad $bad" : null;
            });
            break;
        case 'sims':
            desk_each($items, 'sims', function ($s) {
                if (!preg_match('/^\d{10}$/', (string)($s['number'] ?? ''))) return 'number must be 10 digits';
                if (!in_array($s['carrier'] ?? '', DESK_CARRIERS, true)) return 'unknown carrier ' . $s['carrier'];
                if (!desk_ref($s['phoneId'] ?? null)) return 'bad phoneId';
                // no recharge date / validity = 'No validity' on the desk
                if (isset($s['rechargeDate']) && !desk_is_date($s['rechargeDate'])) return 'rechargeDate must be YYYY-MM-DD';
                if (isset($s['validityDays']) && (!is_int($s['validityDays']) || $s['validityDays'] < 1 || $s['validityDays'] > 365)) return 'validityDays must be 1–365';
                if (isset($s['lastAmount']) && (!desk_is_num($s['lastAmount']) || $s['lastAmount'] < 0)) return 'lastAmount must be a number ≥ 0';
                if (isset($s['slot']) && !in_array($s['slot'], [1, 2], true)) return 'slot must be 1 or 2';
                if (isset($s['graceDays']) && (!desk_is_num($s['graceDays']) || $s['graceDays'] < 0)) return 'graceDays must be a number ≥ 0';
                $bad = desk_bad_str($s, ['name', 'owner', 'vendor', 'use', 'note', 'holder']) ?? desk_bad_bool($s, ['inPouch', 'archived', 'proof']);
                return $bad ? "bad $bad" : null;
            });
            desk_capacity($items, 'simSlots', 'SIM', desk_get_slice($conn, 'phones'));
            break;
        case 'was':
            desk_each($items, 'was', function ($w) {
                if (!preg_match('/^\d{10}$/', (string)($w['number'] ?? ''))) return 'number must be 10 digits';
                if (!in_array($w['type'] ?? null, DESK_WA_TYPES, true)) return 'unknown type ' . ($w['type'] ?? '');
                if (!in_array($w['health'] ?? null, DESK_HEALTH, true)) return 'unknown health ' . ($w['health'] ?? '');
                // null = the sheet doesn't say
                if (desk_bad_bool($w, ['verified', 'metaAI'])) return 'verified and metaAI must be true, false or null';
                if (desk_bad_str($w, ['note', 'banReason'])) return 'bad note / banReason';
                if (isset($w['bans'])) {
                    if (!is_array($w['bans'])) return 'bans must be a list';
                    foreach ($w['bans'] as $b) if (!is_array($b) || !desk_is_date($b['date'] ?? null) || !in_array($b['kind'] ?? null, ['banned', 'appealed', 'restored'], true)) return 'bans: each needs a date and kind banned / appealed / restored';
                }
                if (!desk_ref($w['simId'] ?? null) || !desk_ref($w['phoneId'] ?? null)) return 'bad simId/phoneId';
                return null;
            });
            desk_capacity($items, 'waSlots', 'WhatsApp account', desk_get_slice($conn, 'phones'));
            break;
        case 'payments':
            desk_each($items, 'payments', function ($p) {
                if (!desk_is_date($p['date'] ?? null)) return 'date must be YYYY-MM-DD';
                if (!in_array($p['category'] ?? null, DESK_CATS, true)) return 'unknown category ' . ($p['category'] ?? '');
                return desk_is_num($p['amount'] ?? null) && $p['amount'] >= 0 ? null : 'amount must be a number ≥ 0';
            });
            break;
        case 'recurring':
            desk_each($items, 'recurring', function ($r) {
                if (!is_string($r['label'] ?? null) || trim($r['label']) === '') return 'label is required';
                if (!in_array($r['category'] ?? null, DESK_CATS, true)) return 'unknown category ' . ($r['category'] ?? '');
                return desk_is_num($r['amount'] ?? null) && $r['amount'] >= 0 ? null : 'amount must be a number ≥ 0';
            });
            break;
        case 'activity':
            desk_each($items, 'activity', fn($a) => desk_is_num($a['at'] ?? null) && is_string($a['text'] ?? null) ? null : 'needs at (ms) and text');
            return array_slice($items, 0, 300);
        case 'calling':
            // calling numbers table from the sheet: cell text kept exactly as written
            desk_each($items, 'calling', fn($c) => desk_bad_str($c, array_keys($c)) ? 'cells must be text' : null);
            break;
    }
    return $items;
}

/* ── Reminders (same rules and message as the frontend's Send reminders dialog) ── */

const DESK_DEACTIVATE_AFTER = 90;
const DESK_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function desk_days(DateTimeImmutable $a, DateTimeImmutable $b): int { return (int)$b->diff($a)->format('%r%a'); }   // a − b in days
function desk_fmt_num(string $n): string { return '+91 ' . substr($n, 0, 5) . ' ' . substr($n, 5); }
function desk_fmt_date(DateTimeImmutable $d): string { return $d->format('j') . ' ' . DESK_MONTHS[(int)$d->format('n') - 1] . ' ' . $d->format('Y'); }

function desk_sim_state(array $sim, DateTimeImmutable $today): array
{
    // Caller IQ's USSD check (sim.ussd.validTill) wins when it is newer than the logged recharge — same rule as the frontend.
    $ussd = desk_is_date($sim['ussd']['validTill'] ?? null) ? new DateTimeImmutable($sim['ussd']['validTill']) : null;
    $planTill = !empty($sim['rechargeDate']) && !empty($sim['validityDays']) ? (new DateTimeImmutable($sim['rechargeDate']))->modify('+' . ((int)$sim['validityDays'] - 1) . ' days') : null;
    if ($ussd && (!$planTill || $ussd > $planTill)) {
        $expiry = $ussd->modify('+1 day');
        $start = $expiry->modify('-' . ((int)($sim['validityDays'] ?? 0) ?: 28) . ' days');
        $daysLeft = desk_days($expiry, $today);
    } else {
        if (empty($sim['rechargeDate']) || empty($sim['validityDays'])) return ['daysLeft' => 0, 'daysToDead' => DESK_DEACTIVATE_AFTER, 'status' => 'unknown'];
        $start = new DateTimeImmutable($sim['rechargeDate']);
        $daysLeft = desk_days($start->modify('+' . (int)$sim['validityDays'] . ' days'), $today);
    }
    $daysToDead = desk_days($start->modify('+' . DESK_DEACTIVATE_AFTER . ' days'), $today);
    $status = $daysToDead <= 0 ? 'dead' : ($daysLeft <= 0 ? 'expired' : ($daysLeft <= 3 ? 'expiring' : 'active'));
    return ['daysLeft' => $daysLeft, 'daysToDead' => $daysToDead, 'status' => $status];
}

function desk_due_reminders(array $sims, array $r, DateTimeImmutable $today): array
{
    $out = [];
    foreach ($sims as $sim) {
        if (!empty($sim['archived'])) continue;
        $st = desk_sim_state($sim, $today);
        $cd = $st['status'] === 'dead' ? 'Deactivated' : ($st['daysLeft'] === 0 ? 'Expired today' : 'Expired ' . -$st['daysLeft'] . 'd ago');
        if (!empty($r['d3']) && $st['daysLeft'] >= 2 && $st['daysLeft'] <= 3) $out[] = [$sim, 'amber', "Validity ends in {$st['daysLeft']} days"];
        if (!empty($r['d1']) && $st['daysLeft'] === 1) $out[] = [$sim, 'amber', 'Last valid day today'];
        if (!empty($r['onExpiry']) && $st['status'] === 'expired') $out[] = [$sim, 'red', "$cd · outgoing barred, recharge to restore"];
        if (!empty($r['deact90']) && $st['status'] === 'expired' && $st['daysToDead'] <= 15) $out[] = [$sim, 'red', "Deactivates in {$st['daysToDead']} days (90 days without recharge)"];
        if (!empty($r['deact90']) && $st['status'] === 'dead') $out[] = [$sim, 'red', 'Deactivated after 90 days without recharge'];
    }
    return $out;
}

function desk_reminder_email(array $desk): array
{
    $today = new DateTimeImmutable('today');
    $phones = array_column($desk['phones'], null, 'id');
    $items = array_map(function ($d) use ($phones) {
        [$sim, $tone, $text] = $d;
        $p = $phones[$sim['phoneId'] ?? ''] ?? null;
        return ['simId' => $sim['id'], 'number' => desk_fmt_num($sim['number']), 'where' => $sim['carrier'] . ', ' . ($p ? $p['name'] : 'SIM pool'),
                'text' => $text, 'severity' => $tone === 'red' ? 'critical' : 'warning'];
    }, desk_due_reminders($desk['sims'], (array)$desk['settings']['reminders'], $today));
    $n = count($items);
    $date = desk_fmt_date($today);
    $h = fn($s) => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
    $text = "SIM validity reminders · $date\n\n"
        . ($n ? implode("\n", array_map(fn($l) => "• {$l['number']} ({$l['where']}): {$l['text']}", $items)) : 'Nothing due today.')
        . "\n\nOpen the SIM & WhatsApp Desk to recharge.";
    $html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#0F172A"><h2 style="font-size:18px;margin:0 0 4px">SIM validity reminders</h2>'
        . '<p style="color:#64748B;margin:0 0 14px">' . $h($date) . " · $n due</p>"
        . '<table cellpadding="8" style="border-collapse:collapse;border:1px solid #E2E8F0"><tr style="background:#2563EB;color:#fff"><th align="left">Number</th><th align="left">Where</th><th align="left">Reminder</th></tr>'
        . implode('', array_map(fn($l) => '<tr><td style="border-top:1px solid #E2E8F0"><b>' . $h($l['number']) . '</b></td><td style="border-top:1px solid #E2E8F0">' . $h($l['where']) . '</td>'
            . '<td style="border-top:1px solid #E2E8F0;color:' . ($l['severity'] === 'critical' ? '#DC2626' : '#B45309') . '">' . $h($l['text']) . '</td></tr>', $items))
        . '</table><p style="color:#64748B">Open the SIM &amp; WhatsApp Desk to recharge.</p></div>';
    return ['subject' => "SIM validity: $n reminder" . ($n === 1 ? '' : 's') . " due · $date", 'text' => $text, 'html' => $html, 'items' => $items];
}

/** 10-digit numbers from "98765 43210, +91 9123456789" or an array; duplicates and junk dropped. */
function desk_wa_numbers($v): array
{
    $parts = is_array($v) ? $v : preg_split('/[,;\n]+/', (string)$v);
    $nums = [];
    foreach ($parts as $p) { $d = substr(preg_replace('/\D/', '', (string)$p), -10); if (strlen($d) === 10 && !in_array($d, $nums, true)) $nums[] = $d; }
    return $nums;
}

/**
 * Sends a text through the Caller IQ WhatsApp bridge (calliq2/whatsapp-bridge). Set in config/database.php:
 *   define('DESK_WA_BRIDGE_URL', 'https://bridge.example.com');  define('DESK_WA_BRIDGE_KEY', '<its BRIDGE_KEY>');
 * The panel's server must be able to reach the bridge. Returns how many numbers it went to.
 */
function desk_send_whatsapp(array $numbers, string $text): int
{
    if (!defined('DESK_WA_BRIDGE_URL') || !DESK_WA_BRIDGE_URL) desk_fail('WhatsApp sending isn’t set up on the server yet (DESK_WA_BRIDGE_URL). Use “Copy message” for now.');
    if (!$numbers) desk_fail('Enter 10-digit WhatsApp numbers.');
    $sent = 0; $errors = [];
    foreach ($numbers as $n) {
        $ctx = stream_context_create(['http' => ['method' => 'POST', 'timeout' => 25, 'ignore_errors' => true,
            'header' => "Content-Type: application/json\r\nX-Bridge-Key: " . (defined('DESK_WA_BRIDGE_KEY') ? DESK_WA_BRIDGE_KEY : ''),
            'content' => json_encode(['phone' => $n, 'name' => '', 'segment' => '', 'message' => $text], JSON_UNESCAPED_UNICODE)]]);
        $res = @file_get_contents(rtrim(DESK_WA_BRIDGE_URL, '/') . '/api/whatsapp/send-single', false, $ctx);
        $code = isset($http_response_header[0]) && preg_match('/\s(\d{3})/', $http_response_header[0], $m) ? (int)$m[1] : 0;
        if ($res !== false && $code >= 200 && $code < 300) { $sent++; continue; }
        $why = $res !== false ? (json_decode($res, true)['error'] ?? "HTTP $code") : 'bridge not reachable';
        $errors[] = "$n: $why";
    }
    if (!$sent) desk_fail('WhatsApp not sent — ' . implode('; ', $errors));
    return $sent;
}

/** Sends with PHP mail(), which the panel's host delivers. Set DESK_MAIL_FROM in config if needed. */
function desk_send_mail(string $to, string $subject, string $text, string $html): void
{
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) desk_fail('Enter a valid email address.');
    $from = defined('DESK_MAIL_FROM') ? DESK_MAIL_FROM : 'no-reply@' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
    $b = 'desk' . bin2hex(random_bytes(8));
    $headers = "From: SIM Desk <$from>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"$b\"";
    $body = "--$b\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n$text\r\n--$b\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n$html\r\n--$b--";
    $subj = '=?UTF-8?B?' . base64_encode($subject) . '?=';
    if (!@mail($to, $subj, $body, $headers)) desk_fail('The server could not send the email. Use “Copy message” for now.');
}
