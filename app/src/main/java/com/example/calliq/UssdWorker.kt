package com.example.calliq

import android.content.Context
import android.util.Log
import androidx.work.*
import java.util.concurrent.TimeUnit

/**
 * Checks every SIM's balance once a day, so the panel's recharge register keeps itself current
 * without anyone remembering to look.
 *
 * Deliberately once a day, in the morning: a USSD request briefly takes over the line, and a
 * balance does not change often enough to justify pestering the network. A check is skipped
 * outright if a call is in progress ([UssdChecker] guards that).
 */
class UssdWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        if (!CallIqConfig.ussdEnabled(applicationContext)) return Result.success()
        Log.d("UssdWorker", "Daily SIM balance check")
        UssdChecker.checkAll(applicationContext)
        return Result.success()
    }

    companion object {
        private const val WORK = "caller_iq_ussd_daily"

        /** Idempotent: safe to call on every app start. */
        fun scheduleDaily(context: Context) {
            if (!UssdChecker.isSupported()) return
            val request = PeriodicWorkRequestBuilder<UssdWorker>(1, TimeUnit.DAYS)
                .setInitialDelay(UssdChecker.millisUntilNextRun(10), TimeUnit.MILLISECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .addTag(WORK)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK)
        }
    }
}
