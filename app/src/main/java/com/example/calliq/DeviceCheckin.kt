package com.example.calliq

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.core.content.pm.PackageInfoCompat
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Tells the admin panel this phone exists, and exactly how it is set up.
 *
 * Before this, a phone only appeared on the dashboard once a call had uploaded from it — so a
 * phone that was installed but had MIUI blocking it, or simply had not made a call yet, was
 * invisible, and there was no way to tell "not set up" from "not installed".
 *
 * It sends only when something the panel shows has CHANGED (a switch turned on or off, the app
 * updated, a SIM added) — plus one heartbeat every 12 hours so an idle phone still reads as alive.
 * Opening the app, or the background catch-up, merely asks "has anything changed?", which is a
 * local comparison and costs no request at all.
 */
object DeviceCheckin {

    private const val TAG = "DeviceCheckin"
    private const val WORK = "caller_iq_checkin"
    private const val HEARTBEAT_MS = 12L * 3600 * 1000

    private const val KEY_HASH = "CHECKIN_HASH"
    private const val KEY_AT = "CHECKIN_AT"
    private const val KEY_ERR = "CHECKIN_ERR"
    private const val KEY_ERR_AT = "CHECKIN_ERR_AT"

    /* Upload health, written by CallSyncWorker — the app's own answer to "are my calls getting through?" */
    const val KEY_SYNC_OK_AT = "SYNC_OK_AT"
    const val KEY_SYNC_ERR = "SYNC_ERR"
    const val KEY_SYNC_ERR_AT = "SYNC_ERR_AT"
    /* Proof the phone lets CallIQ run by itself, written by the background catch-up. */
    const val KEY_BG_RUN_AT = "BG_RUN_AT"

    fun url(ctx: Context) = CallIqConfig.endpoint(ctx).replace("log_call.php", "checkin.php")

    fun appBuild(ctx: Context): Long = try {
        PackageInfoCompat.getLongVersionCode(ctx.packageManager.getPackageInfo(ctx.packageName, 0))
    } catch (e: Throwable) { 0L }

    fun snapshot(ctx: Context, pending: Int? = null): JSONObject {
        val p = CallIqConfig.prefs(ctx)
        val steps = SetupState.steps(ctx)
        return JSONObject().apply {
            put("device_id", CallIqConfig.deviceId(ctx))
            put("device_model", CallIqConfig.deviceModel())
            put("manufacturer", Build.MANUFACTURER ?: "")
            put("brand", Build.BRAND ?: "")
            put("os_release", Build.VERSION.RELEASE ?: "")
            put("sdk", Build.VERSION.SDK_INT)
            put("app_version", CallIqConfig.appVersion(ctx))
            put("app_build", appBuild(ctx))
            put("popup_ok", SetupState.popupReady(ctx))
            put("health", JSONObject().apply {
                put("steps", JSONArray().apply {
                    steps.forEach { s ->
                        put(JSONObject()
                            .put("key", s.key).put("title", s.title).put("status", s.status)
                            .put("required", s.required).put("how", s.how))
                    }
                })
                put("popup_enabled", CallIqConfig.popupEnabled(ctx))
                put("sims", SimResolver.activeSubscriptions(ctx).size)
                put("sync_ok_at", p.getLong(KEY_SYNC_OK_AT, 0L))
                put("sync_error", p.getString(KEY_SYNC_ERR, "") ?: "")
                put("sync_error_at", p.getLong(KEY_SYNC_ERR_AT, 0L))
                put("bg_run_at", p.getLong(KEY_BG_RUN_AT, 0L))
                // The phone's own clock at sending, so the panel compares phone time with phone
                // time ("background last ran 9 h before this report") and never mixes two clocks.
                put("sent_at", System.currentTimeMillis())
                // Is CallIQ being kept alive between calls? Without it live calls go missing.
                put("monitor_enabled", CallIqConfig.monitorEnabled(ctx))
                put("monitor", CallMonitorService.isRunning)
                // How this phone tells its SIMs apart (see SimResolver), and what it holds when it cannot.
                put("sim_method", p.getString(SimResolver.KEY_LAST_SOURCE, "") ?: "")
                put("sim_unresolved", p.getString(SimResolver.KEY_LAST_UNRESOLVED, "") ?: "")
                if (pending != null) put("pending_uploads", pending)
            })
        }
    }

    /**
     * Only what the panel would show differently. Timestamps and error text are left out on
     * purpose — they change on every call and would turn this into a request per call.
     */
    private fun fingerprint(ctx: Context): String = buildString {
        append(CallIqConfig.appVersion(ctx)).append('|').append(Build.VERSION.SDK_INT)
        append('|').append(CallIqConfig.popupEnabled(ctx)).append('|').append(SetupState.popupReady(ctx))
        append('|').append(SimResolver.activeSubscriptions(ctx).size)
        SetupState.steps(ctx).forEach { append('|').append(it.key).append('=').append(it.status) }
        append('|').append(CallIqConfig.endpoint(ctx))
        append('|').append(CallIqConfig.monitorEnabled(ctx)).append(CallMonitorService.isRunning)
        append('|').append(CallIqConfig.prefs(ctx).getString(SimResolver.KEY_LAST_SOURCE, ""))
    }

    /** Cheap and local: queues a check-in only when something changed, or the heartbeat is due. */
    fun maybeSend(ctx: Context, force: Boolean = false) {
        try {
            val app = ctx.applicationContext
            val p = CallIqConfig.prefs(app)
            val changed = fingerprint(app) != p.getString(KEY_HASH, "")
            val due = System.currentTimeMillis() - p.getLong(KEY_AT, 0L) > HEARTBEAT_MS
            if (!force && !changed && !due) return
            val req = OneTimeWorkRequestBuilder<CheckinWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            // REPLACE: a newer change supersedes one still waiting for a network.
            WorkManager.getInstance(app).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE, req)
        } catch (e: Throwable) {
            Log.w(TAG, "could not queue check-in: ${e.message}")
        }
    }

    /**
     * Sends now and says what happened in plain words — also what the app's "Test connection"
     * button shows, so a counselor can see "No internet" or "Server error 503" instead of silence.
     */
    fun sendNow(ctx: Context, pending: Int? = null): Pair<Boolean, String> {
        val app = ctx.applicationContext
        val p = CallIqConfig.prefs(app)
        val result = try {
            val conn = (URL(url(app)).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json; charset=UTF-8")
                setRequestProperty("Accept", "application/json")
                doOutput = true
                connectTimeout = 10_000
                readTimeout = 10_000
            }
            OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(snapshot(app, pending).toString()); it.flush() }
            val code = conn.responseCode
            conn.disconnect()
            when {
                code in 200..299 -> true to "Connected — the panel has this phone's setup."
                code == 404 -> false to "Server is missing checkin.php (HTTP 404) — the panel's files need updating."
                code == 503 -> false to "Server not ready (HTTP 503) — the panel's caller-iq files need updating."
                else -> false to "Server replied HTTP $code."
            }
        } catch (e: java.net.UnknownHostException) {
            false to "No internet, or the server name cannot be found."
        } catch (e: java.net.SocketTimeoutException) {
            false to "The server did not answer in time."
        } catch (e: javax.net.ssl.SSLException) {
            false to "Secure connection failed (${e.message?.take(60)}). Check the phone's date and time."
        } catch (e: Throwable) {
            false to "Could not connect: ${e.javaClass.simpleName} ${e.message?.take(80) ?: ""}".trim()
        }

        val ed = p.edit()
        if (result.first) {
            ed.putString(KEY_HASH, fingerprint(app)).putLong(KEY_AT, System.currentTimeMillis()).remove(KEY_ERR)
        } else {
            ed.putString(KEY_ERR, result.second).putLong(KEY_ERR_AT, System.currentTimeMillis())
        }
        ed.apply()
        return result
    }

    fun lastAt(ctx: Context) = CallIqConfig.prefs(ctx).getLong(KEY_AT, 0L)
    fun lastError(ctx: Context) = CallIqConfig.prefs(ctx).getString(KEY_ERR, "") ?: ""

    /** Uploads still queued on the phone. Blocking — call off the main thread. */
    fun pendingUploads(ctx: Context): Int? = try {
        WorkManager.getInstance(ctx).getWorkInfosByTag("CallSyncWorker").get(3, TimeUnit.SECONDS)
            .count { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.BLOCKED }
    } catch (e: Throwable) { null }
}

class CheckinWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val (ok, msg) = DeviceCheckin.sendNow(applicationContext, DeviceCheckin.pendingUploads(applicationContext))
        Log.d("CheckinWorker", msg)
        when {
            ok -> Result.success()
            // A server that is missing the file will not fix itself in a minute; stop until the
            // next change or heartbeat rather than retrying all day.
            runAttemptCount >= 4 -> Result.success()
            else -> Result.retry()
        }
    }
}
