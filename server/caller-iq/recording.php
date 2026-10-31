<?php
/**
 * /api/caller-iq/recording.php  —  call recordings. The phone uploads the file its own dialer
 * recorded after each connected call; the panel (login) and the app (app key + device id) can list
 * and play them. Files live on disk, one row per call in caller_iq_recordings.
 * ---------------------------------------------------------------------------
 *   upload  multipart: app_key, device_id, call_key, number, call_at (ms), duration (s), call_type,
 *           file_duration_ms?, called_by?, audio (file)          → { id, duplicate }
 *   list    { number? , from?, to?, limit? }                     → { items: [ {…} ] }
 *   get     { id }  (JSON POST, or GET ?action=get&id=…&app_key=…&device_id=…)  → the audio itself
 * ---------------------------------------------------------------------------
 * PHP must accept the upload: upload_max_filesize and post_max_size of at least 64M (a 10-minute
 * call is 5–10 MB). Files go to CALLER_IQ_RECORDINGS_DIR when defined, else ../../storage/call-recordings,
 * which is locked against direct web access.
 *
 * transcript / summary / ai_status are for the transcription step that comes next; ai_status
 * starts at 'pending'.
 */
require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../middleware/auth.php';
require_once __DIR__ . '/ciq_lib.php';
require_once __DIR__ . '/crm_lib.php';

mysqli_report(MYSQLI_REPORT_OFF);
set_exception_handler(function (Throwable $e) {
    error_log('[caller-iq recording] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    api_error('Recordings: ' . $e->getMessage(), 500);
});

const REC_MAX_BYTES = 60 * 1024 * 1024;
const REC_TYPES = [
    'audio/mpeg' => 'mp3', 'audio/mp3' => 'mp3', 'audio/mp4' => 'm4a', 'audio/x-m4a' => 'm4a', 'audio/m4a' => 'm4a',
    'audio/aac' => 'aac', 'audio/amr' => 'amr', 'audio/3gpp' => '3gp', 'audio/ogg' => 'ogg', 'audio/opus' => 'opus',
    'audio/wav' => 'wav', 'audio/x-wav' => 'wav', 'audio/webm' => 'webm',
];

$isMultipart = stripos((string)($_SERVER['CONTENT_TYPE'] ?? ''), 'multipart/form-data') === 0;
if ($isMultipart && empty($_POST) && (int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
    // PHP drops the whole body when it is over post_max_size.
    api_error('The recording is larger than this server accepts (post_max_size).', 413);
}
$in = $isMultipart ? $_POST : ($_SERVER['REQUEST_METHOD'] === 'GET' ? $_GET : get_json_input());
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
if ($action !== 'get') require_method('POST');
crm_ensure_schema($conn);
rec_ensure_schema($conn);

function rec_ensure_schema(mysqli $conn): void
{
    $conn->query("CREATE TABLE IF NOT EXISTS caller_iq_recordings (
        id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        call_key    VARCHAR(120) NOT NULL,
        number_norm VARCHAR(20)  NOT NULL,
        device_id   VARCHAR(64)  NOT NULL DEFAULT '',
        called_by   VARCHAR(60)  NOT NULL DEFAULT '',
        call_type   VARCHAR(20)  NOT NULL DEFAULT '',
        call_at     DATETIME     NOT NULL,
        duration_s  INT UNSIGNED NOT NULL DEFAULT 0,
        file_ms     INT UNSIGNED NOT NULL DEFAULT 0,
        mime        VARCHAR(40)  NOT NULL DEFAULT 'audio/mpeg',
        size_bytes  INT UNSIGNED NOT NULL DEFAULT 0,
        sha1        CHAR(40)     NOT NULL DEFAULT '',
        path        VARCHAR(255) NOT NULL,
        orig_name   VARCHAR(255) NOT NULL DEFAULT '',
        ai_status   VARCHAR(12)  NOT NULL DEFAULT 'pending',
        transcript  MEDIUMTEXT   NULL,
        summary     TEXT         NULL,
        created_at  DATETIME     NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY u_call (call_key),
        KEY k_num (number_norm, call_at),
        KEY k_ai (ai_status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

function rec_dir(): string
{
    $dir = defined('CALLER_IQ_RECORDINGS_DIR') ? CALLER_IQ_RECORDINGS_DIR : __DIR__ . '/../../storage/call-recordings';
    if (!is_dir($dir) && !@mkdir($dir, 0750, true)) api_error('Cannot create the recordings folder.', 500);
    if (!file_exists("$dir/.htaccess")) @file_put_contents("$dir/.htaccess", "Require all denied\nDeny from all\n");
    if (!file_exists("$dir/index.html")) @file_put_contents("$dir/index.html", '');
    return rtrim($dir, '/');
}

function rec_row(array $r): array
{
    return [
        'id' => (int)$r['id'], 'number' => $r['number_norm'], 'call_key' => $r['call_key'],
        'device_id' => $r['device_id'], 'called_by' => $r['called_by'], 'call_type' => $r['call_type'],
        'call_at' => $r['call_at'], 'duration' => (int)$r['duration_s'], 'mime' => $r['mime'],
        'size' => (int)$r['size_bytes'], 'ai_status' => $r['ai_status'], 'summary' => $r['summary'],
    ];
}

switch ($action) {

case 'upload': {
    if (!$isApp) api_error('Recordings are uploaded by the phone app.', 403);
    $key = ciq_str($in['call_key'] ?? '', 120);
    if ($key === '') api_error('Missing call_key.');
    $n = ciq_norm_number((string)($in['number'] ?? ''));

    $f = $_FILES['audio'] ?? null;
    if (!$f || !isset($f['error'])) api_error('No recording attached.');
    if ($f['error'] === UPLOAD_ERR_INI_SIZE || $f['error'] === UPLOAD_ERR_FORM_SIZE) api_error('The recording is larger than this server accepts (upload_max_filesize).', 413);
    if ($f['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($f['tmp_name'])) api_error('The recording did not arrive whole (error ' . (int)$f['error'] . ').');
    if ($f['size'] <= 0 || $f['size'] > REC_MAX_BYTES) api_error('The recording is empty or too large.', 413);

    // The same call sent twice (a retry after a lost reply) is kept once.
    $dup = crm_all($conn, "SELECT id FROM caller_iq_recordings WHERE call_key = " . crm_e($conn, $key));
    if ($dup) api_success(['id' => (int)$dup[0]['id'], 'duplicate' => true], 'Already saved');

    $mime = strtolower((string)($f['type'] ?? ''));
    $ext = REC_TYPES[$mime] ?? strtolower(pathinfo((string)$f['name'], PATHINFO_EXTENSION));
    if (!preg_match('/^[a-z0-9]{2,5}$/', $ext)) $ext = 'bin';
    if (!isset(REC_TYPES[$mime])) $mime = array_search($ext, REC_TYPES, true) ?: 'application/octet-stream';

    $sha = sha1_file($f['tmp_name']);
    $rel = date('Y/m') . '/' . preg_replace('/\D/', '', $n ?: '0') . '_' . substr($sha, 0, 16) . '.' . $ext;
    $abs = rec_dir() . '/' . $rel;
    if (!is_dir(dirname($abs)) && !@mkdir(dirname($abs), 0750, true)) api_error('Cannot create the recordings folder.', 500);
    if (!move_uploaded_file($f['tmp_name'], $abs)) api_error('Could not save the recording.', 500);

    $callAt = date('Y-m-d H:i:s', (int)(((int)($in['call_at'] ?? 0)) / 1000) ?: time());
    $dur = max(0, (int)($in['duration'] ?? 0));
    $fileMs = max(0, (int)($in['file_duration_ms'] ?? 0));
    $type = ciq_str($in['call_type'] ?? '', 20);
    $by = ciq_str($in['called_by'] ?? '', 60);
    $orig = ciq_str($f['name'] ?? '', 255);
    $size = (int)$f['size'];
    $now = crm_now();

    $st = $conn->prepare("INSERT INTO caller_iq_recordings
        (call_key, number_norm, device_id, called_by, call_type, call_at, duration_s, file_ms, mime, size_bytes, sha1, path, orig_name, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    $st->bind_param('ssssssiisissss', $key, $n, $DEV, $by, $type, $callAt, $dur, $fileMs, $mime, $size, $sha, $rel, $orig, $now);
    if (!$st->execute()) {
        $err = $st->error;
        @unlink($abs);
        // Lost a race with a parallel retry of the same call.
        if ($conn->errno === 1062) api_success(['id' => 0, 'duplicate' => true], 'Already saved');
        api_error('Could not save the recording: ' . $err, 500);
    }
    $id = (int)$st->insert_id;
    $st->close();

    if ($n !== '') crm_timeline($conn, $n, 'recording', sprintf('Call recorded · %dm %02ds', intdiv($dur, 60), $dur % 60), $DEV);
    api_success(['id' => $id, 'duplicate' => false], 'Recording saved');
}

case 'list': {
    $where = [];
    if (!empty($in['number'])) $where[] = 'number_norm = ' . crm_e($conn, ciq_norm_number((string)$in['number']));
    if (!empty($in['from'])) $where[] = 'call_at >= ' . crm_e($conn, (string)$in['from']);
    if (!empty($in['to']))   $where[] = 'call_at <= ' . crm_e($conn, (string)$in['to']);
    $limit = min(500, max(1, (int)($in['limit'] ?? 100)));
    $sql = 'SELECT * FROM caller_iq_recordings' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . " ORDER BY call_at DESC LIMIT $limit";
    api_success(['items' => array_map('rec_row', crm_all($conn, $sql))]);
}

case 'get': {
    $id = (int)($in['id'] ?? 0);
    $r = crm_all($conn, "SELECT mime, path, orig_name FROM caller_iq_recordings WHERE id = $id");
    if (!$r) api_error('That recording is gone.', 404);
    $abs = rec_dir() . '/' . $r[0]['path'];
    if (!is_file($abs)) api_error('The recording file is missing on the server.', 404);
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: ' . $r[0]['mime']);
    header('Content-Length: ' . filesize($abs));
    header('Content-Disposition: inline; filename="' . str_replace('"', '', basename($r[0]['path'])) . '"');
    header('Cache-Control: private, max-age=3600');
    readfile($abs);
    exit;
}

default:
    api_error('Unknown action.');
}
