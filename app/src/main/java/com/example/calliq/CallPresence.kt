package com.example.calliq

import android.content.Context
import android.telephony.TelephonyManager
import android.util.Log
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Live call presence — what the dashboard's "Live now" strip is made of.
 *
 * The call log only exists AFTER a call ends, so anything live has to be pushed as it happens:
 * ringing → connected → ended. These go out immediately over a short-timeout HTTP call rather than
 * through WorkManager, because a live event that arrives two minutes late is worthless; if the send
 * fails, [CallPresenceWorker] retries and also heartbeats while the call is still up, so a phone
 * that dies mid-call cannot leave a call "in progress" on the dashboard forever.
 *
 * What Android will and will not tell an ordinary app:
 *  - incoming: the number arrives with the RINGING broadcast (needs READ_CALL_LOG, which we hold).
 *  - outgoing: there is NO number until the call ends. Since Android 10 only the default dialer
 *    receives NEW_OUTGOING_CALL, and the call-log row is written after hang-up. The dashboard says
 *    so rather than inventing one, and fills it in when the call syncs.
 *  - "ringing" for an outgoing call is equally invisible — OFFHOOK covers dialling and talking
 *    alike, so an outgoing call is reported as in progress from the moment it is dialled.
 */
object CallPresence {

    private const val TAG = "CallPresence"

    const val STATE_RINGING = "ringing"
    const val STATE_CONNECTED = "connected"
    const val STATE_ENDED = "ended"

    const val DIR_INCOMING = "incoming"
    const val DIR_OUTGOING = "outgoing"

    private const val KEY_STARTED_AT = "LIVE_STARTED_AT"
    private const val KEY_DIRECTION = "LIVE_DIRECTION"
    private const val KEY_NUMBER = "LIVE_NUMBER"
    private const val KEY_ANSWERED_AT = "LIVE_ANSWERED_AT"

    /** The presence endpoint sits next to the call-log one. */
    fun endpoint(context: Context): String =
        CallIqConfig.endpoint(context).replace("log_call.php", "live_call.php")

    /* ── Call bookkeeping ─────────────────────────────────────────────────── */

    fun onRinging(context: Context, number: String?) {
        val prefs = CallIqConfig.prefs(context)
        val now = System.currentTimeMillis()
        prefs.edit()
            .putLong(KEY_STARTED_AT, now)
            .putString(KEY_DIRECTION, DIR_INCOMING)
            .putString(KEY_NUMBER, number ?: "")
            .remove(KEY_ANSWERED_AT)
            .apply()
        send(context, STATE_RINGING)
    }

    fun onOffHook(context: Context) {
        val prefs = CallIqConfig.prefs(context)
        val now = System.currentTimeMillis()
        val hadRing = prefs.getString(KEY_DIRECTION, "") == DIR_INCOMING && prefs.getLong(KEY_STARTED_AT, 0L) > 0
        if (!hadRing) {
            // No ring before going off hook: the counselor placed this call.
            prefs.edit()
                .putLong(KEY_STARTED_AT, now)
                .putString(KEY_DIRECTION, DIR_OUTGOING)
                .putString(KEY_NUMBER, "")
                .apply()
        }
        prefs.edit().putLong(KEY_ANSWERED_AT, now).apply()
        send(context, STATE_CONNECTED)
    }

    fun onIdle(context: Context) {
        send(context, STATE_ENDED)
        CallIqConfig.prefs(context).edit()
            .remove(KEY_STARTED_AT).remove(KEY_DIRECTION).remove(KEY_NUMBER).remove(KEY_ANSWERED_AT)
            .apply()
    }

    /**
     * Called when the app starts: if the phone is idle but we never reported the end of a call
     * (killed mid-call, rebooted), close it now so the dashboard stops showing it.
     */
    fun clearIfIdle(context: Context) {
        try {
            val prefs = CallIqConfig.prefs(context)
            if (prefs.getLong(KEY_STARTED_AT, 0L) <= 0L) return
            val tm = context.getSystemService(TelephonyManager::class.java)
            @Suppress("DEPRECATION")
            val state = try { tm?.callState ?: TelephonyManager.CALL_STATE_IDLE } catch (e: Throwable) { TelephonyManager.CALL_STATE_IDLE }
            if (state == TelephonyManager.CALL_STATE_IDLE) {
                Log.d(TAG, "Found a live call left open; closing it.")
                onIdle(context)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "clearIfIdle failed: ${e.message}")
        }
    }

    /* ── Sending ──────────────────────────────────────────────────────────── */

    fun payload(context: Context, state: String): JSONObject {
        val prefs = CallIqConfig.prefs(context)
        val started = prefs.getLong(KEY_STARTED_AT, 0L).let { if (it > 0) it else System.currentTimeMillis() }
        val direction = prefs.getString(KEY_DIRECTION, "") ?: ""
        val number = prefs.getString(KEY_NUMBER, "") ?: ""
        val answered = prefs.getLong(KEY_ANSWERED_AT, 0L)
        val sim = SimResolver.resolve(context, "", null, System.currentTimeMillis())

        return JSONObject().apply {
            put("device_id", CallIqConfig.deviceId(context))
            put("device_model", CallIqConfig.deviceModel())
            put("app_version", CallIqConfig.appVersion(context))
            put("state", state)
            put("direction", if (direction.isEmpty()) "unknown" else direction)
            if (number.isNotEmpty()) put("number", number)
            put("started_at", started)
            if (answered > 0) put("answered_at", answered)
            put("event_at", System.currentTimeMillis())
            sim.slot?.let { put("sim_slot", it) }
            if (sim.carrier.isNotEmpty()) put("carrier", sim.carrier)
            if (sim.label.isNotEmpty()) put("sim_label", sim.label)
        }
    }

    /**
     * Fire the event now on a background thread, and queue a worker as the safety net: it retries a
     * failed send and keeps the call alive on the dashboard until it really ends.
     */
    private fun send(context: Context, state: String) {
        val app = context.applicationContext
        val body = payload(app, state).toString()
        Thread {
            val ok = post(endpoint(app), body)
            if (!ok) Log.w(TAG, "Live '$state' did not reach the server; the worker will retry.")
        }.start()
        // The direct send is best effort (no network, dozing radio, server blip), so the worker
        // always backs it up — and while the call is still up it keeps heartbeating.
        CallPresenceWorker.schedule(app, delaySeconds = if (state == STATE_ENDED) 0L else 5L)
    }

    fun post(url: String, body: String): Boolean = try {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            setRequestProperty("Accept", "application/json")
            doOutput = true
            connectTimeout = 6000
            readTimeout = 6000
        }
        OutputStreamWriter(conn.outputStream, "UTF-8").use { it.write(body); it.flush() }
        val code = conn.responseCode
        conn.disconnect()
        code in 200..299
    } catch (e: Throwable) {
        Log.w(TAG, "Live post failed: ${e.message}")
        false
    }

    /** True while this phone still believes a call is up. */
    fun hasOpenCall(context: Context): Boolean =
        CallIqConfig.prefs(context).getLong(KEY_STARTED_AT, 0L) > 0L
}
