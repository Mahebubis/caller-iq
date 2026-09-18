package com.example.calliq

import android.content.Context
import android.util.Log
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Delivers an outcome tagged from the post-call popup.
 *
 * The popup opens the instant a call ends — before Android has written its call-log row, and well
 * before that call has been synced. A counselor who taps within that second must not lose the tag,
 * and must not create a second, phantom call on the dashboard, so the tag is sent with the call's
 * START TIME and the server attaches it to the matching call (or holds it until that call arrives).
 *
 * Retried by WorkManager until it lands, so a tag made in a lift with no signal still arrives.
 */
class TagWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val app = applicationContext
        val outcome = inputData.getString("outcome") ?: return@withContext Result.failure()
        val startedMs = inputData.getLong("started_ms", 0L)
        if (startedMs <= 0L) return@withContext Result.failure()

        val url = CallIqConfig.endpoint(app).replace("log_call.php", "tag_call.php")
        val body = JSONObject().apply {
            put("device_id", CallIqConfig.deviceId(app))
            put("outcome", outcome)
            put("started_at", startedMs)
            put("tagged_via", inputData.getString("via") ?: "popup")
            inputData.getString("number")?.takeIf { it.isNotEmpty() }?.let { put("number", it) }
            inputData.getString("idempotency_key")?.takeIf { it.isNotEmpty() }?.let { put("idempotency_key", it) }
        }.toString()

        try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                setRequestProperty("Accept", "application/json")
                doOutput = true
                connectTimeout = 15000
                readTimeout = 15000
            }
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(body); it.flush() }
            val code = conn.responseCode
            conn.disconnect()
            Log.d("TagWorker", "Tag '$outcome' → HTTP $code")
            if (code in 200..299) Result.success() else Result.retry()
        } catch (e: Exception) {
            Log.e("TagWorker", "Tag send failed: ${e.message}", e)
            Result.retry()
        }
    }

    companion object {
        fun schedule(
            context: Context,
            outcome: String,
            number: String,
            startedMs: Long,
            idempotencyKey: String,
            via: String,
        ) {
            val request = OneTimeWorkRequestBuilder<TagWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, WorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
                .setInputData(workDataOf(
                    "outcome" to outcome,
                    "number" to number,
                    "started_ms" to startedMs,
                    "idempotency_key" to idempotencyKey,
                    "via" to via,
                ))
                .addTag("CallSyncWorker")   // counts towards the app's "pending queue" figure
                .build()

            // One tag per call: re-tagging the same call replaces a send that has not gone yet.
            WorkManager.getInstance(context)
                .enqueueUniqueWork("call_tag_${startedMs / 1000}", ExistingWorkPolicy.REPLACE, request)
            Log.d("TagWorker", "Queued tag '$outcome' for call at $startedMs")
        }
    }
}
