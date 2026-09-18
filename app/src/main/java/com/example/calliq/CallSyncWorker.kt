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

class CallSyncWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val number = inputData.getString("number") ?: return@withContext Result.failure()
        val callType = inputData.getString("call_type") ?: "UNKNOWN"
        val duration = inputData.getLong("duration", 0L)
        val simId = inputData.getString("sim_id") ?: "SIM_WAITING_FALLBACK"
        val timestamp = inputData.getLong("timestamp", System.currentTimeMillis())
        val idempotencyKey = inputData.getString("idempotency_key") ?: "${number}_${timestamp}"
        val outcome = inputData.getString("outcome") ?: ""
        val taggedVia = inputData.getString("tagged_via") ?: ""

        val targetUrl = CallIqConfig.endpoint(applicationContext)

        /*
         * The SIM is resolved when the call is queued and carried here, because by the time this
         * worker runs the live "which SIM is busy" capture may have expired. Only fall back to
         * resolving now for work queued by an older build, which carries no slot.
         */
        val passedSlot = inputData.getInt("sim_slot", 0)
        val sim = if (passedSlot > 0 || inputData.getString("sim_source") != null) {
            SimResolver.Sim(
                slot = if (passedSlot > 0) passedSlot else null,
                carrier = inputData.getString("sim_carrier") ?: "",
                label = inputData.getString("sim_label") ?: "",
                source = inputData.getString("sim_source") ?: "",
                subId = null,
            )
        } else {
            SimResolver.resolve(applicationContext, simId)
        }

        Log.d("CallSyncWorker", "Executing call log sync for idempotency_key=$idempotencyKey to $targetUrl")

        try {
            val jsonPayload = JSONObject().apply {
                put("number", number)
                put("call_type", callType)
                put("duration", duration)
                put("sim_id", simId)
                put("timestamp", timestamp)
                put("idempotency_key", idempotencyKey)
                if (outcome.isNotEmpty()) {
                    put("outcome", outcome)
                }
                // Lets the admin panel tell phones apart (Caller IQ → Agents).
                put("device_id", CallIqConfig.deviceId(applicationContext))
                put("device_model", CallIqConfig.deviceModel())
                put("app_version", CallIqConfig.appVersion(applicationContext))
                sim.slot?.let { put("sim_slot", it) }
                if (sim.carrier.isNotEmpty()) put("carrier", sim.carrier)
                if (sim.label.isNotEmpty()) put("sim_label", sim.label)
                if (sim.source.isNotEmpty()) put("sim_source", sim.source)
                // The SIM's own number, so the panel's SIM register fills itself in where the
                // network wrote one to the card.
                if (sim.msisdn.isNotEmpty()) put("sim_msisdn", sim.msisdn)
                if (taggedVia.isNotEmpty()) put("tagged_via", taggedVia)
                // So the panel can see which phones cannot show the post-call popup, instead of
                // waiting for someone to notice they are never tagging anything.
                put("popup_ok", CallIqConfig.popupEnabled(applicationContext) && CallPopupOverlay.canShow(applicationContext))
            }

            val url = URL(targetUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                setRequestProperty("Accept", "application/json")
                doOutput = true
                connectTimeout = 15000
                readTimeout = 15000
            }

            OutputStreamWriter(connection.outputStream, "UTF-8").use { writer ->
                writer.write(jsonPayload.toString())
                writer.flush()
            }

            val responseCode = connection.responseCode
            Log.d("CallSyncWorker", "HTTP Response Code: $responseCode for key: $idempotencyKey")

            if (responseCode in 200..299) {
                Result.success()
            } else {
                Log.w("CallSyncWorker", "Non-2xx HTTP status $responseCode, queueing for retry.")
                Result.retry()
            }
        } catch (e: Exception) {
            Log.e("CallSyncWorker", "Network or server failure during call log sync: ${e.message}", e)
            Result.retry()
        }
    }

    companion object {
        fun schedule(
            context: Context,
            number: String,
            callType: String,
            duration: Long,
            simId: String,
            timestamp: Long,
            idempotencyKey: String,
            outcome: String = "",
            simSlot: Int = 0,
            simCarrier: String = "",
            simLabel: String = "",
            simSource: String = "",
            taggedVia: String = ""
        ) {
            // A plain re-sync must never cancel a queued outcome upload for the same call
            // (the log is re-read after every call), so only outcome syncs replace.
            val policy = if (outcome.isNotEmpty()) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP
            val inputData = workDataOf(
                "number" to number,
                "call_type" to callType,
                "duration" to duration,
                "sim_id" to simId,
                "timestamp" to timestamp,
                "idempotency_key" to idempotencyKey,
                "outcome" to outcome,
                "sim_slot" to simSlot,
                "sim_carrier" to simCarrier,
                "sim_label" to simLabel,
                "sim_source" to simSource,
                "tagged_via" to taggedVia
            )

            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val workRequest = OneTimeWorkRequestBuilder<CallSyncWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    WorkRequest.MIN_BACKOFF_MILLIS,
                    TimeUnit.MILLISECONDS
                )
                .setInputData(inputData)
                .addTag("CallSyncWorker")
                .build()

            val uniqueWorkName = "call_sync_${idempotencyKey}"

            WorkManager.getInstance(context).enqueueUniqueWork(
                uniqueWorkName,
                policy,
                workRequest
            )
            Log.d("CallSyncWorker", "Enqueued WorkManager task: $uniqueWorkName")
        }
    }
}