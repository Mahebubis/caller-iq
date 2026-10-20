<?php
/**
 * /api/caller-iq/crm.php  —  the sales workspace: deal stage, qualification, timeline, voice notes,
 * points and leaderboard, analytics, and WhatsApp replies. The phone app (app key + device id)
 * and the admin panel (login) may use every action.
 * ---------------------------------------------------------------------------
 *   meta        { numbers[] }                         → { meta: { number: {…} } }
 *   meta_set    { number, stage?, sentiment?, bant?, lost_reason?, competitor?, offer_hours?, offer_clear?,
 *                 dnd?, reply_ack? }                  → { meta, awarded: [ { rule, points } ] }
 *   timeline    { number }                            → { items: [ { kind, text, at, by, id? } ] }
 *   note_add    { number, text, kind? }               → adds a note (or a dictation)
 *   memo_upload { number, b64, mime?, duration_ms }   → stores a voice note (≤ 3 MB)
 *   memo_get    { id }                                → { b64, mime }
 *   points_add  { rule: attempt | connected | ontime | offer, ref, number? }  → { points }
 *   settings_get { keys[] }  settings_set { key, value }  → team plans / battle matrix (JSON)
 *   stats       { }                                   → this phone: today, week, total, rank, goal, rules
 *   leaderboard { range: today | week | month }       → { rows: [ { device_id, agent, points, … } ] }
 *   analytics   { range, scope: me | team }           → points by rule, funnel, lost reasons, hours
 *   rules_set   { rules: { rule: points }, goal }     → saves the team's scoring
 *   wa_inbound  { items: [ { id, phone, text, at } ] } → replies seen by the bridge, stored once
 *   feed        { }                                   → replies of the last day not acknowledged yet
 *   referral    { from, import_id, name, phone }      → adds the friend at the top of the list
 * ---------------------------------------------------------------------------
 */
require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../middleware/auth.php';
require_once __DIR__ . '/ciq_lib.php';
require_once __DIR__ . '/crm_lib.php';

mysqli_report(MYSQLI_REPORT_OFF);
set_exception_handler(function (Throwable $e) {
    error_log('[caller-iq crm] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    api_error('CRM: ' . $e->getMessage(), 500);
});

$in     = get_json_input();
$action = (string)($in['action'] ?? '');

$appKey = (string)($in['app_key'] ?? ($_SERVER['HTTP_X_CALLIQ_APP_KEY'] ?? ''));
$isApp  = !empty($in['device_id']) && $appKey !== '';
if ($isApp) {
    if (!defined('CALLER_IQ_APP_KEY') || !hash_equals((string)CALLER_IQ_APP_KEY, $appKey)) api_error('This phone is not allowed here.', 403);
    $DEV = ciq_str($in['device_id'] ?? '', 64);
} else {
    $jwt = require_jwt();
    require_permission('caller_iq', $jwt);
    $DEV = 'panel:' . (int)($jwt['user_id'] ?? 0);
}
require_method('POST');
crm_ensure_schema($conn);

$num = fn($v) => ciq_norm_number((string)$v);
$needNum = function ($v) use ($num): string {
    $n = $num($v);
    if (strlen($n) < 6) api_error('That phone number is not valid.');
    return $n;
};

function crm_meta_rows(mysqli $conn, array $nums): array
{
    $out = [];
    $nums = array_values(array_unique(array_filter($nums)));
    foreach (array_chunk($nums, 1000) as $part) {
        $list = implode(',', array_map(fn($n) => crm_e($conn, $n), $part));
        foreach (crm_all($conn, "SELECT * FROM caller_iq_contact_meta WHERE number_norm IN ($list)") as $m) {
            foreach (['bant', 'heat', 'dnd'] as $k) $m[$k] = (int)$m[$k];
            $out[$m['number_norm']] = $m;
        }
    }
    return $out;
}

/** Since when a range starts: today, this week (Monday), this month. */
function crm_range_start(string $range): string
{
    switch ($range) {
        case 'week':  return date('Y-m-d 00:00:00', strtotime('monday this week'));
        case 'month': return date('Y-m-01 00:00:00');
        case 'all':   return '2000-01-01 00:00:00';
        default:      return date('Y-m-d 00:00:00');
    }
}

function crm_agents(mysqli $conn): array
{
    $r = $conn->query("SHOW TABLES LIKE 'caller_iq_devices'");
    if (!$r || !$r->num_rows) return [];
    return array_column(crm_all($conn, "SELECT device_id, COALESCE(NULLIF(agent_name,''), device_id) n FROM caller_iq_devices"), 'n', 'device_id');
}

switch ($action) {

case 'meta': {
    $nums = array_map($num, array_slice((array)($in['numbers'] ?? []), 0, 5000));
    api_success(['meta' => (object)crm_meta_rows($conn, $nums)]);
}

case 'meta_set': {
    $n = $needNum($in['number'] ?? '');
    $cur = crm_meta_rows($conn, [$n])[$n] ?? ['stage' => '', 'sentiment' => '', 'bant' => 0, 'heat' => 0, 'lost_reason' => '', 'offer_until' => null, 'dnd' => 0];
    $set = []; $notes = []; $awarded = [];
    $stage = $cur['stage']; $sent = $cur['sentiment']; $bant = (int)$cur['bant'];

    if (isset($in['stage']) && in_array((string)$in['stage'], CRM_STAGES, true) && $in['stage'] !== $cur['stage']) {
        $stage = (string)$in['stage'];
        $set['stage'] = $stage;
        $notes[] = ['status', 'Stage: ' . ucfirst($stage)];
        if ($stage !== 'lost') $set['lost_reason'] = '';
    }
    if (isset($in['lost_reason']) && in_array((string)$in['lost_reason'], CRM_LOST, true)) {
        $set['lost_reason'] = (string)$in['lost_reason'];
        if ($in['lost_reason'] !== '') { $stage = 'lost'; $set['stage'] = 'lost'; $notes[] = ['status', 'Not interested: ' . $in['lost_reason']]; }
    }
    if (isset($in['sentiment']) && in_array((string)$in['sentiment'], CRM_SENTIMENTS, true)) { $sent = (string)$in['sentiment']; $set['sentiment'] = $sent; }
    if (isset($in['bant'])) { $bant = max(0, min(15, (int)$in['bant'])); $set['bant'] = $bant; }
    if (isset($set['sentiment']) || isset($set['bant'])) $set['heat'] = crm_heat($bant, $sent);
    if (!empty($in['offer_hours'])) {
        $h = max(1, min(72, (int)$in['offer_hours']));
        $set['offer_until'] = date('Y-m-d H:i:s', time() + $h * 3600);
        $notes[] = ['offer', "Offer held for $h hours"];
    }
    if (!empty($in['offer_clear'])) $set['offer_until'] = null;
    if (isset($in['dnd'])) {
        $set['dnd'] = $in['dnd'] ? 1 : 0;
        $set['dnd_at'] = $in['dnd'] ? crm_now() : null;
        $notes[] = ['status', $in['dnd'] ? 'Marked DND — no more bulk messages' : 'DND removed'];
    }
    if (!empty($in['reply_ack'])) $set['reply_ack_at'] = crm_now();
    if (isset($in['competitor'])) {
        $comp = ciq_str($in['competitor'], 40);
        $set['competitor'] = $comp;
        if ($comp !== '' && $comp !== ($cur['competitor'] ?? '')) $notes[] = ['status', "Mentioned competitor: $comp"];
    }
    $set['activity_at'] = crm_now();
    $set['updated_at'] = crm_now();
    $set['updated_by'] = $DEV;

    $cols = array_keys($set);
    $vals = array_map(fn($v) => $v === null ? 'NULL' : crm_e($conn, $v), array_values($set));
    $upd = implode(',', array_map(fn($c) => "$c = VALUES($c)", $cols));
    $conn->query("INSERT INTO caller_iq_contact_meta (number_norm, " . implode(',', $cols) . ") VALUES (" . crm_e($conn, $n) . ',' . implode(',', $vals) . ") ON DUPLICATE KEY UPDATE $upd");
    if ($conn->errno) api_error('Could not save: ' . $conn->error, 500);
    foreach ($notes as [$k, $t]) crm_timeline($conn, $n, $k, $t, $DEV);

    /* Hot lead: BANT at 75% or more, once per number. Converted: once per number. */
    $bantPct = 0; foreach ([1, 2, 4, 8] as $bit) if ($bant & $bit) $bantPct += 25;
    if ($bantPct >= 75 && ($p = crm_award($conn, $DEV, 'hot', $n, $n))) $awarded[] = ['rule' => 'hot', 'points' => $p];
    if (($set['stage'] ?? '') === 'converted' && ($p = crm_award($conn, $DEV, 'converted', $n, $n))) $awarded[] = ['rule' => 'converted', 'points' => $p];
    api_success(['meta' => crm_meta_rows($conn, [$n])[$n] ?? null, 'awarded' => $awarded]);
}

case 'timeline': {
    $n = $needNum($in['number'] ?? '');
    $agents = crm_agents($conn);
    $by = fn($d) => $agents[$d] ?? (strpos((string)$d, 'panel:') === 0 ? 'Admin panel' : '');
    $items = [];
    foreach (crm_all($conn, "SELECT kind, text, device_id, created_at FROM caller_iq_timeline WHERE number_norm = " . crm_e($conn, $n) . " ORDER BY id DESC LIMIT 200") as $x) {
        $items[] = ['kind' => $x['kind'], 'text' => $x['text'], 'at' => $x['created_at'], 'by' => $by($x['device_id'])];
    }
    foreach (crm_all($conn, "SELECT id, duration_ms, device_id, created_at FROM caller_iq_memos WHERE number_norm = " . crm_e($conn, $n) . " ORDER BY id DESC LIMIT 50") as $x) {
        $items[] = ['kind' => 'memo', 'text' => 'Voice note', 'at' => $x['created_at'], 'by' => $by($x['device_id']), 'id' => (int)$x['id'], 'duration_ms' => (int)$x['duration_ms']];
    }
    $r = $conn->query("SHOW TABLES LIKE 'caller_iq_sms'");
    if ($r && $r->num_rows) {
        $hasChan = ($c = $conn->query("SHOW COLUMNS FROM caller_iq_sms LIKE 'channel'")) && $c->num_rows;
        foreach (crm_all($conn, "SELECT " . ($hasChan ? 'channel' : "'sms' AS channel") . ", body, device_id, sent_at FROM caller_iq_sms WHERE number_norm = " . crm_e($conn, $n) . " ORDER BY id DESC LIMIT 100") as $x) {
            $items[] = ['kind' => $x['channel'] === 'whatsapp' ? 'wa_out' : 'sms', 'text' => $x['body'], 'at' => $x['sent_at'], 'by' => $by($x['device_id'])];
        }
    }
    foreach (crm_all($conn, "SELECT text, opt_out, received_at FROM caller_iq_wa_in WHERE number_norm = " . crm_e($conn, $n) . " ORDER BY received_at DESC LIMIT 100") as $x) {
        $items[] = ['kind' => 'wa_in', 'text' => $x['text'], 'at' => $x['received_at'], 'by' => '', 'opt_out' => (int)$x['opt_out']];
    }
    foreach (crm_all($conn, "SELECT call_type, duration_sec, outcome, device_id, call_at FROM caller_iq_calls WHERE number_norm = " . crm_e($conn, $n) . " ORDER BY call_at DESC LIMIT 100") as $x) {
        $d = (int)$x['duration_sec'];
        $items[] = ['kind' => 'call', 'text' => ucfirst(strtolower($x['call_type'])) . ($d > 0 ? ' · ' . gmdate($d >= 3600 ? 'G:i:s' : 'i:s', $d) : ' · not connected') . ($x['outcome'] ? ' · ' . $x['outcome'] : ''),
                    'at' => $x['call_at'], 'by' => $by($x['device_id'])];
    }
    usort($items, fn($a, $b) => strcmp((string)$b['at'], (string)$a['at']));
    api_success(['items' => array_slice($items, 0, 300), 'meta' => crm_meta_rows($conn, [$n])[$n] ?? null]);
}

case 'note_add': {
    $n = $needNum($in['number'] ?? '');
    $text = trim((string)($in['text'] ?? ''));
    if ($text === '') api_error('The note is empty.');
    $kind = (string)($in['kind'] ?? 'note') === 'dictation' ? 'dictation' : 'note';
    crm_timeline($conn, $n, $kind, $text, $DEV);
    $conn->query("INSERT INTO caller_iq_contact_meta (number_norm, activity_at, updated_at, updated_by) VALUES (" . crm_e($conn, $n) . ", '" . crm_now() . "', '" . crm_now() . "', " . crm_e($conn, $DEV) . ")
                  ON DUPLICATE KEY UPDATE activity_at = VALUES(activity_at)");
    api_success([], 'Note saved');
}

case 'memo_upload': {
    $n = $needNum($in['number'] ?? '');
    $b64 = (string)($in['b64'] ?? '');
    if ($b64 === '' || strlen($b64) > 4 * 1024 * 1024) api_error('The voice note is empty or longer than a few minutes.');
    $data = base64_decode($b64, true);
    if ($data === false) api_error('The voice note could not be read.');
    $mime = preg_match('#^audio/[a-z0-9.+-]{1,30}$#i', (string)($in['mime'] ?? '')) ? (string)$in['mime'] : 'audio/mp4';
    $dur = max(0, (int)($in['duration_ms'] ?? 0));
    $now = crm_now();
    $st = $conn->prepare("INSERT INTO caller_iq_memos (number_norm, mime, duration_ms, data, device_id, created_at) VALUES (?,?,?,?,?,?)");
    $null = null;
    $st->bind_param('ssibss', $n, $mime, $dur, $null, $DEV, $now);
    $st->send_long_data(3, $data);
    if (!$st->execute()) api_error('Could not save the voice note: ' . $st->error, 500);
    api_success(['id' => (int)$st->insert_id], 'Voice note saved');
}

case 'memo_get': {
    $id = (int)($in['id'] ?? 0);
    $m = crm_all($conn, "SELECT mime, data FROM caller_iq_memos WHERE id = $id");
    if (!$m) api_error('That voice note is gone.', 404);
    api_success(['mime' => $m[0]['mime'], 'b64' => base64_encode($m[0]['data'])]);
}

case 'points_add': {
    $rule = (string)($in['rule'] ?? '');
    if (!in_array($rule, ['attempt', 'connected', 'ontime', 'offer'], true)) api_error('Those points are given by the panel itself.');
    $n = $num($in['number'] ?? '');
    $ref = ciq_str($in['ref'] ?? '', 80);
    if ($ref === '') api_error('Missing reference.');
    api_success(['points' => crm_award($conn, $DEV, $rule, $ref, $n)]);
}

case 'stats': {
    $cfg = crm_rules($conn);
    $d = crm_e($conn, $DEV);
    $sum = fn($from) => (int)(crm_all($conn, "SELECT COALESCE(SUM(points),0) p FROM caller_iq_points WHERE device_id = $d AND created_at >= '$from'")[0]['p']);
    $today = crm_range_start('today');
    $byRule = [];
    foreach (crm_all($conn, "SELECT rule, COUNT(*) n, SUM(points) p FROM caller_iq_points WHERE device_id = $d AND created_at >= '$today' GROUP BY rule") as $x) {
        $byRule[$x['rule']] = ['n' => (int)$x['n'], 'points' => (int)$x['p']];
    }
    $total = $sum('2000-01-01 00:00:00');
    api_success([
        'today' => $sum($today), 'week' => $sum(crm_range_start('week')), 'total' => $total,
        'by_rule' => (object)$byRule, 'rank' => crm_rank($total), 'goal' => $cfg['goal'], 'rules' => $cfg['rules'],
        'cleared_today' => ($byRule['attempt']['n'] ?? 0),
    ]);
}

case 'leaderboard': {
    $from = crm_range_start((string)($in['range'] ?? 'today'));
    $agents = crm_agents($conn);
    $rows = [];
    foreach (crm_all($conn, "SELECT device_id, SUM(points) p, SUM(rule = 'connected') connected, SUM(rule = 'converted') converted, SUM(rule = 'attempt') attempts
                             FROM caller_iq_points WHERE created_at >= '$from' GROUP BY device_id ORDER BY p DESC LIMIT 50") as $x) {
        $tot = (int)crm_all($conn, "SELECT COALESCE(SUM(points),0) p FROM caller_iq_points WHERE device_id = " . crm_e($conn, $x['device_id']))[0]['p'];
        $rows[] = ['device_id' => $x['device_id'], 'agent' => $agents[$x['device_id']] ?? $x['device_id'], 'points' => (int)$x['p'],
                   'connected' => (int)$x['connected'], 'converted' => (int)$x['converted'], 'attempts' => (int)$x['attempts'],
                   'rank' => crm_rank($tot)['name'], 'me' => $x['device_id'] === $DEV];
    }
    api_success(['rows' => $rows, 'range' => (string)($in['range'] ?? 'today')]);
}

case 'analytics': {
    $from = crm_range_start((string)($in['range'] ?? 'week'));
    $mine = (string)($in['scope'] ?? 'me') === 'me';
    $dev = $mine ? ' AND device_id = ' . crm_e($conn, $DEV) : '';
    $byRule = [];
    foreach (crm_all($conn, "SELECT rule, COUNT(*) n, SUM(points) p FROM caller_iq_points WHERE created_at >= '$from'$dev GROUP BY rule") as $x) {
        $byRule[$x['rule']] = ['n' => (int)$x['n'], 'points' => (int)$x['p']];
    }
    $days = [];
    foreach (crm_all($conn, "SELECT DATE(created_at) d, SUM(points) p FROM caller_iq_points WHERE created_at >= '$from'$dev GROUP BY DATE(created_at) ORDER BY d") as $x) {
        $days[] = ['day' => $x['d'], 'points' => (int)$x['p']];
    }
    /* Funnel and lost reasons over the leads touched in the range. */
    $funnel = array_fill_keys(CRM_STAGES, 0);
    $metaDev = $mine ? ' AND updated_by = ' . crm_e($conn, $DEV) : '';
    foreach (crm_all($conn, "SELECT stage, COUNT(*) n FROM caller_iq_contact_meta WHERE stage <> '' AND activity_at >= '$from'$metaDev GROUP BY stage") as $x) $funnel[$x['stage']] = (int)$x['n'];
    $lost = [];
    foreach (crm_all($conn, "SELECT lost_reason, COUNT(*) n FROM caller_iq_contact_meta WHERE stage = 'lost' AND activity_at >= '$from'$metaDev GROUP BY lost_reason ORDER BY n DESC") as $x) {
        $lost[] = ['reason' => $x['lost_reason'] ?: 'other', 'n' => (int)$x['n']];
    }
    /* Calls by weekday (1 = Sunday) and hour, and how many connected: the peak hours heatmap. */
    $hours = [];
    foreach (crm_all($conn, "SELECT DAYOFWEEK(call_at) wd, HOUR(call_at) h, COUNT(*) n, SUM(duration_sec > 0) c FROM caller_iq_calls
                             WHERE call_at >= '$from'" . ($mine ? ' AND device_id = ' . crm_e($conn, $DEV) : '') . " GROUP BY wd, h") as $x) {
        $hours[] = ['wd' => (int)$x['wd'], 'h' => (int)$x['h'], 'n' => (int)$x['n'], 'connected' => (int)$x['c']];
    }
    $calls = crm_all($conn, "SELECT COUNT(*) n, COALESCE(SUM(duration_sec > 0),0) c, COALESCE(SUM(duration_sec),0) t FROM caller_iq_calls
                             WHERE call_at >= '$from' AND call_type = 'OUTGOING'" . ($mine ? ' AND device_id = ' . crm_e($conn, $DEV) : ''))[0];
    $competitors = [];
    foreach (crm_all($conn, "SELECT competitor, COUNT(*) n, SUM(stage = 'converted') won, SUM(stage = 'lost') lost FROM caller_iq_contact_meta
                             WHERE competitor <> '' AND activity_at >= '$from'$metaDev GROUP BY competitor ORDER BY n DESC LIMIT 12") as $x) {
        $competitors[] = ['name' => $x['competitor'], 'n' => (int)$x['n'], 'won' => (int)$x['won'], 'lost' => (int)$x['lost']];
    }
    /* The Reports donut (connected / missed / callbacks) and the bar chart: calls per day for the
       last 180 days, whatever the range, so the app can show days, weeks or months. */
    $callDev = $mine ? ' AND device_id = ' . crm_e($conn, $DEV) : '';
    $mix = crm_all($conn, "SELECT COUNT(*) total, COALESCE(SUM(duration_sec > 0), 0) connected,
                                  COALESCE(SUM(call_type IN ('MISSED','REJECTED','BLOCKED')), 0) missed,
                                  COALESCE(SUM(outcome = 'Callback Scheduled' OR outcome = 'Not Answering'), 0) callbacks
                           FROM caller_iq_calls WHERE call_at >= '$from'$callDev")[0];
    $callDays = [];
    foreach (crm_all($conn, "SELECT DATE(call_at) d, COUNT(*) n, SUM(duration_sec > 0) c FROM caller_iq_calls
                             WHERE call_at >= '" . date('Y-m-d 00:00:00', strtotime('-180 days')) . "'$callDev GROUP BY DATE(call_at) ORDER BY d") as $x) {
        $callDays[] = ['day' => $x['d'], 'n' => (int)$x['n'], 'connected' => (int)$x['c']];
    }
    api_success([
        'call_mix' => array_map('intval', $mix),
        'call_days' => $callDays,
        'competitors' => $competitors,
        'by_rule' => (object)$byRule, 'days' => $days, 'funnel' => $funnel, 'lost' => $lost, 'hours' => $hours,
        'calls' => ['outgoing' => (int)$calls['n'], 'connected' => (int)$calls['c'], 'talk_sec' => (int)$calls['t']],
    ]);
}

case 'rules_set': {
    $rules = [];
    foreach (CRM_DEFAULT_RULES as $k => $v) $rules[$k] = max(0, min(10000, (int)(($in['rules'] ?? [])[$k] ?? $v)));
    $goal = max(1, min(10000, (int)($in['goal'] ?? CRM_DEFAULT_GOAL)));
    $conn->query("REPLACE INTO caller_iq_settings (k, v) VALUES ('points_rules', " . crm_e($conn, json_encode($rules)) . "), ('daily_goal', '$goal')");
    api_success(crm_rules($conn), 'Points rules saved');
}

case 'settings_get': {
    $keys = array_values(array_intersect((array)($in['keys'] ?? CRM_SETTING_KEYS), CRM_SETTING_KEYS));
    $out = [];
    if ($keys) {
        foreach (crm_all($conn, "SELECT k, v FROM caller_iq_settings WHERE k IN (" . implode(',', array_map(fn($k) => crm_e($conn, $k), $keys)) . ")") as $x) {
            $out[$x['k']] = json_decode($x['v'], true);
        }
    }
    api_success(['settings' => (object)$out]);
}

case 'settings_set': {
    $key = (string)($in['key'] ?? '');
    if (!in_array($key, CRM_SETTING_KEYS, true)) api_error('Unknown setting.');
    $json = json_encode($in['value'] ?? null, JSON_UNESCAPED_UNICODE);
    if (strlen($json) > 200000) api_error('That is too much to save.');
    $conn->query("REPLACE INTO caller_iq_settings (k, v) VALUES (" . crm_e($conn, $key) . ", " . crm_e($conn, $json) . ")");
    api_success(['key' => $key], 'Saved for the team');
}

case 'wa_inbound': {
    $items = array_slice((array)($in['items'] ?? []), 0, 500);
    $stored = 0; $optOuts = 0;
    $hasSms = ($r = $conn->query("SHOW TABLES LIKE 'caller_iq_sms'")) && $r->num_rows;
    foreach ($items as $it) {
        $id = ciq_str($it['id'] ?? '', 120);
        $n = $num($it['phone'] ?? '');
        $text = mb_substr(trim((string)($it['text'] ?? '')), 0, 1000);
        if ($id === '' || strlen($n) < 6) continue;
        $at = !empty($it['at']) ? date('Y-m-d H:i:s', (int)floor((float)$it['at'] / 1000)) : crm_now();
        $opt = crm_is_opt_out($text) ? 1 : 0;
        $st = $conn->prepare("INSERT IGNORE INTO caller_iq_wa_in (msg_id, number_norm, text, opt_out, received_at) VALUES (?,?,?,?,?)");
        $st->bind_param('sssis', $id, $n, $text, $opt, $at);
        $st->execute();
        $fresh = $st->affected_rows > 0;
        $st->close();
        if (!$fresh) continue;
        $stored++;
        /* Only people on a calling list count as leads replying. */
        $onList = (bool)crm_all($conn, "SELECT 1 FROM caller_iq_import_rows WHERE phone_norm = " . crm_e($conn, $n) . " LIMIT 1");
        if (!$onList) continue;
        $snippet = mb_substr($text, 0, 500);
        $conn->query("INSERT INTO caller_iq_contact_meta (number_norm, replied_at, reply_text, reply_ack_at, activity_at, updated_at, dnd, dnd_at)
                      VALUES (" . crm_e($conn, $n) . ", '$at', " . crm_e($conn, $snippet) . ", NULL, '$at', '" . crm_now() . "', $opt, " . ($opt ? "'$at'" : 'NULL') . ")
                      ON DUPLICATE KEY UPDATE replied_at = VALUES(replied_at), reply_text = VALUES(reply_text), reply_ack_at = NULL,
                                              activity_at = VALUES(activity_at), dnd = GREATEST(dnd, VALUES(dnd)), dnd_at = COALESCE(dnd_at, VALUES(dnd_at))");
        crm_timeline($conn, $n, 'wa_in', $text, '');
        if ($opt) { $optOuts++; crm_timeline($conn, $n, 'status', 'Opted out on WhatsApp — marked DND', ''); continue; }
        /* +30 to whoever messaged them last on WhatsApp. */
        if ($hasSms) {
            $last = crm_all($conn, "SELECT device_id FROM caller_iq_sms WHERE number_norm = " . crm_e($conn, $n) . " AND device_id <> '' ORDER BY id DESC LIMIT 1");
            if ($last) crm_award($conn, $last[0]['device_id'], 'reply', $id, $n);
        }
    }
    api_success(['stored' => $stored, 'opt_outs' => $optOuts]);
}

case 'feed': {
    $since = date('Y-m-d H:i:s', time() - 86400);
    $rows = crm_all($conn, "SELECT m.number_norm, m.replied_at, m.reply_text, m.dnd, m.heat,
                                   (SELECT r.name FROM caller_iq_import_rows r WHERE r.phone_norm = m.number_norm ORDER BY r.id DESC LIMIT 1) name,
                                   (SELECT i.name FROM caller_iq_import_rows r JOIN caller_iq_imports i ON i.id = r.import_id WHERE r.phone_norm = m.number_norm ORDER BY r.id DESC LIMIT 1) segment
                            FROM caller_iq_contact_meta m
                            WHERE m.replied_at >= '$since' AND (m.reply_ack_at IS NULL OR m.reply_ack_at < m.replied_at)
                            ORDER BY m.replied_at DESC LIMIT 30");
    $out = array_map(fn($x) => ['number' => $x['number_norm'], 'at' => $x['replied_at'], 'text' => $x['reply_text'], 'dnd' => (int)$x['dnd'],
                                'heat' => (int)$x['heat'], 'name' => (string)$x['name'], 'segment' => (string)$x['segment']], $rows);
    api_success(['replies' => $out]);
}

case 'referral': {
    $from = $needNum($in['from'] ?? '');
    $phoneRaw = ciq_str($in['phone'] ?? '', 40);
    $n = $needNum($phoneRaw);
    $name = ciq_str($in['name'] ?? '', 190);
    $impId = (int)($in['import_id'] ?? 0);
    $imp = crm_all($conn, "SELECT id, name FROM caller_iq_imports WHERE id = $impId AND status = 'ready'");
    if (!$imp) api_error('Pick the calling list to add them to.');
    $rowNo = (int)crm_all($conn, "SELECT COALESCE(MAX(row_no), 0) + 1 m FROM caller_iq_import_rows WHERE import_id = $impId")[0]['m'];
    $cols = array_column(crm_all($conn, "SHOW COLUMNS FROM caller_iq_import_rows"), 'Field');
    $extra = in_array('pinned', $cols, true) ? ', pinned' : '';
    $comment = 'Referred by ' . $from;
    $st = $conn->prepare("INSERT INTO caller_iq_import_rows (import_id, row_no, phone_norm, phone_raw, phone_src, email, name, import_status, called_by, comment, tags$extra)
                          VALUES (?,?,?,?,'f','',?,'needs_callback','',?,',referral,'" . ($extra ? ',1' : '') . ")");
    $st->bind_param('iissss', $impId, $rowNo, $n, $phoneRaw, $name, $comment);
    if (!$st->execute()) api_error('Could not add the referral: ' . $st->error, 500);
    $rowId = (int)$st->insert_id;
    $conn->query("UPDATE caller_iq_imports SET stored_rows = stored_rows + 1, with_phone = with_phone + 1, changed_at = '" . crm_now() . "' WHERE id = $impId");
    crm_timeline($conn, $from, 'referral', "Referred $name ($phoneRaw)", $DEV);
    crm_timeline($conn, $n, 'referral', "Referred by $from", $DEV);
    $pts = crm_award($conn, $DEV, 'referral', $n, $n);
    api_success(['row_id' => $rowId, 'awarded' => $pts ? [['rule' => 'referral', 'points' => $pts]] : []], 'Referral added');
}

default:
    api_error('Unknown action', 400);
}
