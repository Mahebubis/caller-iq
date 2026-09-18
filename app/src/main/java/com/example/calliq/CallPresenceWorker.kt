package com.example.calliq

import android.content.Context
import android.telephony.TelephonyManager
import android.util.Log
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * The safety net behind [CallPresence]: it re-sends a live event that did not get through, and
 * while a call is still up it heartbeats every 45 seconds.
 *
 * The heartbeat is what stops a dead phone from leaving a call "in progress" on the dashboard for
 * ever: the server ages out any live call it has not heard about recently, and the panel dims a
 * call whose phone has gone quiet instead of pretending it is still connected.
 *
 * It reads the CURRENT call state each time rather than trusting the state it was queued with, so
 * a missed IDLE broadcast (killed process, OEM cleaner) still closes the call.
 */
class CallPresenceWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val app = applicationContext
        if (!CallPresence.hasOpenCall(app)) return@withContext Result.success()

        val tm = try { app.getSystemService(TelephonyManager::class.java) } catch (e: Throwable) { null }
        @Suppress("DEPRECATION")
        val callState = try { tm?.callState ?: TelephonyManager.CALL_STATE_IDLE } catch (e: Throwable) { TelephonyManager.CALL_STATE_IDLE }

        val state = when (callState) {
            TelephonyManager.CALL_STATE_RINGING -> CallPresence.STATE_RINGING
            TelephonyManager.CALL_STATE_OFFHOOK -> CallPresence.STATE_CONNECTED
            else -> CallPresence.STATE_ENDED
        }

        val ok = CallPresence.post(CallPresence.endpoint(app), CallPresence.payload(app, state).toString())
        Log.d("CallPresenceWorker", "Heartbeat '$state' sent=$ok")

        if (state == CallPresence.STATE_ENDED) {
            // The call is over — clear our copy so nothing keeps beating.
            CallPresence.onIdle(app)
            return@withContext Result.success()
        }
        if (!ok) return@withContext Result.retry()

        schedule(app, delaySeconds = 45)
        Result.success()
    }

    companion object {
        private const val WORK = "caller_iq_presence"

        fun schedule(context: Context, delaySeconds: Long) {
            val request = OneTimeWorkRequestBuilder<CallPresenceWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
                .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS)
                .addTag(WORK)
                .build()
            // REPLACE: only the newest state matters, and one heartbeat chain per phone is enough.
            WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
