<?php
/**
 * Daily SIM reminders for the SIM & WhatsApp Desk. Run from the host's cron once a day, e.g.
 *     0 9 * * *  php /path/to/react-api/api/sim-desk/desk_cron.php
 * Sends today's due reminders to the email and the WhatsApp numbers saved in the desk's Send reminders
 * dialog (WhatsApp needs DESK_WA_BRIDGE_URL). Skips days with nothing due, and never sends twice on one
 * day. `--force` sends even when nothing is due.
 */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit('CLI only'); }

require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/desk_lib.php';

mysqli_report(MYSQLI_REPORT_OFF);
$force = in_array('--force', $argv, true);

try {
    desk_ensure_schema($conn);
    $today = date('Y-m-d');
    if (!$force && desk_meta($conn, 'reminders.lastDay') === $today) exit("Already sent today.\n");
    $desk = desk_load($conn);
    $to = (string)($desk['settings']['reminderEmail'] ?? '');
    $wa = defined('DESK_WA_BRIDGE_URL') && DESK_WA_BRIDGE_URL ? desk_wa_numbers($desk['settings']['reminderWhatsApp'] ?? '') : [];
    if ($to === '' && !$wa) exit("No reminder email or WhatsApp numbers saved yet (set them in the desk's Send reminders dialog).\n");
    $mail = desk_reminder_email($desk);
    if (!$mail['items'] && !$force) exit("Nothing due today.\n");
    $done = [];
    if ($to !== '') {
        try { desk_send_mail($to, $mail['subject'], $mail['text'], $mail['html']); $done[] = "email to $to"; }
        catch (Throwable $e) { fwrite(STDERR, 'Email: ' . $e->getMessage() . "\n"); }
    }
    if ($wa) {
        try { $n = desk_send_whatsapp($wa, $mail['text']); $done[] = "WhatsApp to $n number" . ($n === 1 ? '' : 's'); }
        catch (Throwable $e) { fwrite(STDERR, 'WhatsApp: ' . $e->getMessage() . "\n"); }
    }
    if (!$done) exit(1);
    desk_set_meta($conn, 'reminders.lastDay', $today);
    desk_log_event($conn, 'sendReminders', ['to' => $to, 'whatsapp' => $wa, 'count' => count($mail['items']), 'via' => 'cron'], null);
    echo 'Sent ' . count($mail['items']) . ' reminders: ' . implode(', ', $done) . "\n";
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}
