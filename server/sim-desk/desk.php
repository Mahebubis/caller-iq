<?php
/**
 * /api/sim-desk/desk.php  —  backend of the SIM & WhatsApp Desk (phones, SIMs, WhatsApp numbers,
 * recharge validity, reminders and spend), inside the admin panel next to Caller IQ.
 * ---------------------------------------------------------------------------
 *   load                                  → { phones, sims, was, payments, recurring, activity, settings }
 *                                           (SIM calls / talkMins filled live from caller_iq_calls, last 30 days)
 *   save   { slice, body }                → { ok }   slice: phones | sims | was | payments | recurring | activity | calling | settings | community;
 *                                           body: { items: [...] } (the whole new list) or the settings object
 *   me                                    → { id, name }
 *   sync                                  → { syncedAt, devices }   "Connect Phone": the Caller IQ phones and their last call
 *   devices                               → { devices: [ { deviceId, agent, team, lastCallAt } ] }
 *   send_reminders { to, subject, text, html, items } → { ok }   emails the reminder list
 *   event  { name, payload }              → { ok }   audit trail of desk actions
 *   events { limit? }                     → { events: [ { id, name, payload, userId, at } ] }
 *
 * Signed-in panel users with the caller_iq permission only. Every reply is plain JSON; errors are
 * { message } with a 4xx/5xx status, which the desk shows to the user as-is.
 * ---------------------------------------------------------------------------
 */
require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../middleware/auth.php';
require_once __DIR__ . '/desk_lib.php';

mysqli_report(MYSQLI_REPORT_OFF);

function desk_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}
set_exception_handler(function (Throwable $e) {
    if ($e instanceof DeskError) desk_out(['message' => $e->getMessage()], 400);
    error_log('[sim-desk] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    desk_out(['message' => 'Desk server error: ' . $e->getMessage()], 500);
});

$in     = get_json_input();
$action = (string)($in['action'] ?? '');

$jwt = require_jwt();
require_permission('caller_iq', $jwt);
$ME = (int)($jwt['user_id'] ?? 0);
$MY_NAME = (string)($jwt['name'] ?? $jwt['username'] ?? $jwt['email'] ?? "User $ME");

require_method('POST');
desk_ensure_schema($conn);

switch ($action) {

case 'load':
    desk_out(desk_load($conn));

case 'save': {
    $slice = (string)($in['slice'] ?? '');
    if (!in_array($slice, DESK_SLICES, true)) desk_out(['message' => "Unknown slice $slice"], 404);
    desk_put_slice($conn, $slice, desk_validate($conn, $slice, $in['body'] ?? null), $ME);
    desk_out(['ok' => true]);
}

case 'me':
    desk_out(['id' => "u_$ME", 'name' => $MY_NAME]);

case 'devices':
    desk_out(['devices' => desk_ciq_devices($conn)]);

case 'sync': {
    $syncedAt = (int)round(microtime(true) * 1000);
    $settings = desk_get_slice($conn, 'settings');
    $settings['lastSync'] = $syncedAt;
    desk_put_slice($conn, 'settings', $settings, $ME);
    desk_out(['syncedAt' => $syncedAt, 'devices' => desk_ciq_devices($conn)]);
}

case 'send_reminders': {
    $to = trim((string)($in['to'] ?? ''));
    $subject = (string)($in['subject'] ?? '');
    $text = (string)($in['text'] ?? '');
    if ($subject === '' || $text === '') desk_out(['message' => 'subject and text are required'], 400);
    desk_send_mail($to, $subject, $text, (string)($in['html'] ?? nl2br(htmlspecialchars($text))));
    desk_log_event($conn, 'sendReminders', ['to' => $to, 'count' => count((array)($in['items'] ?? []))], $ME);
    desk_out(['ok' => true]);
}

case 'send_reminders_wa': {
    $text = trim((string)($in['text'] ?? ''));
    if ($text === '') desk_out(['message' => 'text is required'], 400);
    $to = desk_wa_numbers($in['to'] ?? []);
    $sent = desk_send_whatsapp($to, $text);
    desk_log_event($conn, 'sendReminders', ['whatsapp' => $to, 'sent' => $sent], $ME);
    desk_out(['ok' => true, 'sent' => $sent]);
}

case 'event': {
    $name = (string)($in['name'] ?? '');
    if (!in_array($name, DESK_EVENTS, true)) desk_out(['message' => "Unknown event $name"], 404);
    desk_log_event($conn, $name, $in['payload'] ?? null, $ME);
    desk_out(['ok' => true]);
}

case 'events': {
    $limit = max(1, min(1000, (int)($in['limit'] ?? 100)));
    $rows = desk_all($conn, "SELECT id, name, payload, user_id, at FROM sim_desk_events ORDER BY id DESC LIMIT $limit");
    desk_out(['events' => array_map(fn($r) => ['id' => (int)$r['id'], 'name' => $r['name'], 'payload' => json_decode((string)$r['payload'], true),
                                               'userId' => $r['user_id'] === null ? null : (int)$r['user_id'], 'at' => $r['at']], $rows)]);
}

default:
    desk_out(['message' => 'Unknown action'], 400);
}
