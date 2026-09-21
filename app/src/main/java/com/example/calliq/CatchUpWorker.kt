package com.example.calliq

import android.content.Context
import android.util.Log
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * The safety net under the call-ended broadcast.
 *
 * Calls normally upload the moment they end, from [CallReceiver]. But that broadcast is exactly
 * what Xiaomi, Oppo and Vivo stop delivering once an app is swiped away without Autostart — and
 * then the calls simply never reach the panel, with nothing on the phone to say so. This runs
 * every 15 minutes (the shortest Android allows) and picks up whatever the broadcast missed.
 *
 * It is built to cost nothing when there is nothing to do: it reads the timestamp of the newest
 * call in the log and compares it with the newest one already uploaded. Only when a call is
 * genuinely missing does anything go over the network. It also records when it ran, which is the
 * one honest proof that this phone really lets CallIQ run in the background.
 */
class CatchUpWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val app = applicationContext
        CallIqConfig.prefs(app).edit().putLong(DeviceCheckin.KEY_BG_RUN_AT, System.currentTimeMillis()).apply()

        if (SetupState.phoneGranted(app)) {
            val newest = CallLogHelper.newestCallAt(app)
            if (newest > CallLogHelper.lastQueuedAt(app)) {
                Log.d(TAG, "calls the broadcast missed — catching up")
                CallLogHelper.processAndEnqueueRecentCalls(app)
            }
        }
        // Local comparison; a request only if the setup changed or the 12-hour heartbeat is due.
        DeviceCheckin.maybeSend(app)
        Result.success()
    }

    companion object {
        private const val TAG = "CatchUpWorker"
        private const val WORK = "caller_iq_catchup"

        /** Idempotent — safe on every app start; KEEP leaves an existing schedule alone. */
        fun schedule(context: Context) {
            try {
                val req = PeriodicWorkRequestBuilder<CatchUpWorker>(15, TimeUnit.MINUTES).addTag(WORK).build()
                WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, req)
            } catch (e: Throwable) {
                Log.w(TAG, "could not schedule: ${e.message}")
            }
        }
    }
}
