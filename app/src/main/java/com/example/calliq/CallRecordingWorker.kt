package com.example.calliq

import android.content.Context
import android.provider.CallLog
import android.util.Log
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.DataOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Uploads the phone's own recording of a connected call to the panel (recording.php), where it is
 * kept beside the call for playback and, later, transcription.
 *
 * Queued for every connected call by [CallLogHelper]. The recorder finishes writing its file a few
 * seconds after the call ends and the media index can lag behind that, so a missing file is
 * retried a few times before the call is given up on as "not recorded".
 */
class CallRecordingWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        val key = inputData.getString("key") ?: return@withContext Result.failure()
        val number = inputData.getString("number") ?: ""
        val startMs = inputData.getLong("timestamp", 0L)
        val duration = inputData.getLong("duration", 0L)
        val callType = inputData.getString("call_type") ?: ""

        if (!enabled(ctx) || isDone(ctx, key)) return@withContext Result.success()
        if (!CallRecordingFinder.hasPermission(ctx)) {
            note(ctx, "Waiting for permission to read recordings")
            return@withContext Result.success()
        }

        val found = CallRecordingFinder.find(ctx, number, startMs, duration, usedUris(ctx))
        if (found == null) {
            if (runAttemptCount < 4) return@withContext Result.retry()
            note(ctx, "No recording found for the call to ${number.takeLast(10)} — is call recording on in the dialer?")
            markDone(ctx, key, null)
            return@withContext Result.success()
        }
        if (found.size > MAX_BYTES) {
            note(ctx, "Recording of ${found.name} is over ${MAX_BYTES / 1024 / 1024} MB — skipped")
            markDone(ctx, key, found.uri.toString())
            return@withContext Result.success()
        }

        try {
            val code = upload(ctx, found, key, number, startMs, duration, callType)
            when {
                code in 200..299 -> {
                    markDone(ctx, key, found.uri.toString())
                    countUpload(ctx)
                    note(ctx, null)
                    Result.success()
                }
                code == 413 -> {
                    note(ctx, "The server refused a ${found.size / 1024 / 1024} MB recording (raise upload_max_filesize)")
                    giveUpOrRetry(ctx, key)
                }
                code in 400..499 -> {
                    note(ctx, "The server rejected the recording (HTTP $code)")
                    markDone(ctx, key, found.uri.toString())
                    Result.success()
                }
                else -> {
                    note(ctx, "Server replied HTTP $code while uploading a recording")
                    giveUpOrRetry(ctx, key)
                }
            }
        } catch (e: Exception) {
            Log.w("CallRecordingWorker", "Upload failed for $key: ${e.message}")
            note(ctx, "Upload failed: ${e.javaClass.simpleName}")
            giveUpOrRetry(ctx, key)
        }
    }

    /** Backoff doubles from 30 s, so 10 tries cover about eight hours of a server or network being down. */
    private fun giveUpOrRetry(ctx: Context, key: String): Result =
        if (runAttemptCount < 10) Result.retry() else { markDone(ctx, key, null); Result.success() }

    /** Streams the file as multipart/form-data, without loading it into memory. */
    private fun upload(ctx: Context, f: CallRecordingFinder.Found, key: String, number: String,
                       startMs: Long, duration: Long, callType: String): Int {
        val boundary = "ciq${System.currentTimeMillis()}"
        val fields = linkedMapOf(
            "action" to "upload",
            "app_key" to CallIqConfig.APP_KEY,
            "device_id" to CallIqConfig.deviceId(ctx),
            "call_key" to key,
            "number" to number,
            "call_at" to startMs.toString(),
            "duration" to duration.toString(),
            "call_type" to callType,
            "file_duration_ms" to f.durationMs.toString(),
            "called_by" to CallIqConfig.calledBy(ctx),
        )
        val head = buildString {
            for ((k, v) in fields) {
                append("--$boundary\r\nContent-Disposition: form-data; name=\"$k\"\r\n\r\n$v\r\n")
            }
            val safeName = f.name.replace("\"", "").replace("\r", "").replace("\n", "")
            append("--$boundary\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"$safeName\"\r\n")
            append("Content-Type: ${f.mime}\r\n\r\n")
        }.toByteArray(Charsets.UTF_8)
        val tail = "\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8)

        // The real size on disk; MediaStore's SIZE can be stale for a file written moments ago.
        val size = ctx.contentResolver.openFileDescriptor(f.uri, "r")?.use { it.statSize } ?: f.size

        val conn = (URL(CallIqConfig.siblingEndpoint(ctx, "recording.php")).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 20_000
            readTimeout = 120_000
            setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            setRequestProperty("Accept", "application/json")
            setFixedLengthStreamingMode(head.size + size + tail.size)
        }
        try {
            DataOutputStream(conn.outputStream).use { out ->
                out.write(head)
                ctx.contentResolver.openInputStream(f.uri)?.use { input ->
                    val buf = ByteArray(64 * 1024)
                    var left = size
                    while (left > 0) {
                        val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                        if (n < 0) break
                        out.write(buf, 0, n)
                        left -= n
                    }
                    // The file changed under us (the recorder was still writing): try again later.
                    if (left > 0) throw java.io.IOException("${f.name} shrank while uploading")
                } ?: throw java.io.FileNotFoundException(f.name)
                out.write(tail)
            }
            return conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private const val PREFS = "call_recordings"
        const val KEY_ENABLED = "RECORDING_UPLOAD_ENABLED"
        private const val KEY_NOTE = "note"
        private const val KEY_NOTE_AT = "note_at"
        private const val KEY_DAY = "count_day"
        private const val KEY_DAY_COUNT = "count"
        private const val KEY_LAST_OK = "last_ok_at"
        private const val MAX_BYTES = 60L * 1024 * 1024
        /** Older calls are not looked for: a recorder's files from then are long matched or gone. */
        private const val MAX_AGE_MS = 2L * 24 * 3600 * 1000

        private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        fun enabled(ctx: Context): Boolean = CallIqConfig.prefs(ctx).getBoolean(KEY_ENABLED, false)

        fun setEnabled(ctx: Context, on: Boolean) {
            CallIqConfig.prefs(ctx).edit().putBoolean(KEY_ENABLED, on).apply()
            if (on) backfill(ctx)
        }

        private fun isDone(ctx: Context, key: String) = prefs(ctx).contains("done:$key")

        private fun usedUris(ctx: Context): Set<String> =
            prefs(ctx).all.keys.filter { it.startsWith("uri:") }.map { it.removePrefix("uri:") }.toSet()

        /** Remembers the call (and the file it took), and forgets entries too old to come up again. */
        private fun markDone(ctx: Context, key: String, uri: String?) {
            val p = prefs(ctx)
            val now = System.currentTimeMillis()
            val ed = p.edit().putLong("done:$key", now)
            if (uri != null) ed.putLong("uri:$uri", now)
            for ((k, v) in p.all) {
                if ((k.startsWith("done:") || k.startsWith("uri:")) && v is Long && now - v > 2 * MAX_AGE_MS) ed.remove(k)
            }
            ed.apply()
        }

        private fun countUpload(ctx: Context) {
            val p = prefs(ctx)
            val today = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
            val n = if (p.getString(KEY_DAY, "") == today) p.getInt(KEY_DAY_COUNT, 0) else 0
            p.edit().putString(KEY_DAY, today).putInt(KEY_DAY_COUNT, n + 1).putLong(KEY_LAST_OK, System.currentTimeMillis()).apply()
        }

        /** null = the last upload worked. Shown in Settings so a counselor can see why nothing arrives. */
        private fun note(ctx: Context, text: String?) {
            val ed = prefs(ctx).edit()
            if (text == null) ed.remove(KEY_NOTE).remove(KEY_NOTE_AT)
            else ed.putString(KEY_NOTE, text.take(160)).putLong(KEY_NOTE_AT, System.currentTimeMillis())
            ed.apply()
        }

        data class Status(val enabled: Boolean, val permission: Boolean, val today: Int, val lastOkAt: Long, val note: String, val noteAt: Long)

        fun status(ctx: Context): Status {
            val p = prefs(ctx)
            val today = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
            return Status(
                enabled = enabled(ctx),
                permission = CallRecordingFinder.hasPermission(ctx),
                today = if (p.getString(KEY_DAY, "") == today) p.getInt(KEY_DAY_COUNT, 0) else 0,
                lastOkAt = p.getLong(KEY_LAST_OK, 0L),
                note = p.getString(KEY_NOTE, "") ?: "",
                noteAt = p.getLong(KEY_NOTE_AT, 0L),
            )
        }

        /** Queues the upload of one call's recording. Only connected calls have one. */
        fun schedule(ctx: Context, key: String, number: String, callType: String, duration: Long, timestamp: Long) {
            if (!enabled(ctx) || duration <= 0) return
            if (callType != "INCOMING" && callType != "OUTGOING") return
            if (System.currentTimeMillis() - timestamp > MAX_AGE_MS || isDone(ctx, key)) return

            val request = OneTimeWorkRequestBuilder<CallRecordingWorker>()
                .setInputData(workDataOf(
                    "key" to key, "number" to number, "call_type" to callType,
                    "duration" to duration, "timestamp" to timestamp,
                ))
                // The recorder is still closing its file when the call ends.
                .setInitialDelay(20, TimeUnit.SECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag("CallRecordingWorker")
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork("call_rec_$key", ExistingWorkPolicy.KEEP, request)
        }

        /** On switching on (or being allowed to read recordings): pick up the last two days' calls. */
        fun backfill(ctx: Context) {
            if (!enabled(ctx)) return
            try {
                ctx.contentResolver.query(
                    CallLog.Calls.CONTENT_URI,
                    arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DURATION, CallLog.Calls.DATE),
                    "${CallLog.Calls.DATE} > ? AND ${CallLog.Calls.DURATION} > 0",
                    arrayOf((System.currentTimeMillis() - MAX_AGE_MS).toString()),
                    "${CallLog.Calls.DATE} DESC"
                )?.use { c ->
                    var n = 0
                    while (c.moveToNext() && n++ < 300) {
                        val number = c.getString(0) ?: "UNKNOWN"
                        val type = when (c.getInt(1)) {
                            CallLog.Calls.INCOMING_TYPE -> "INCOMING"
                            CallLog.Calls.OUTGOING_TYPE -> "OUTGOING"
                            else -> continue
                        }
                        val date = c.getLong(3)
                        // Same key as CallLogHelper, so the panel ties the file to the synced call.
                        schedule(ctx, "${number}_${date}", number, type, c.getLong(2), date)
                    }
                }
            } catch (e: Throwable) {
                Log.w("CallRecordingWorker", "backfill failed: ${e.message}")
            }
        }
    }
}
