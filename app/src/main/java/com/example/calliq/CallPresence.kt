package com.example.calliq

import android.content.Context
import android.telephony.TelephonyManager
import android.util.Log
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

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
 *  - outgoing: the number arrives with the repeat OFFHOOK broadcast (READ_CALL_LOG holders get
 *    one carrying the number of the call on the line) — see onOffHook.
 *  - when an outgoing call is ANSWERED is invisible to any app but the default dialer: OFFHOOK
 *    covers dialling and talking alike, so an outgoing call is shown from the moment it is dialled
 *    and its real talk time arrives from the call log when it ends.
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

    /** A call is already up on this phone — talking, or one the counselor placed. */
    private fun inCall(context: Context): Boolean {
        val prefs = CallIqConfig.prefs(context)
        if (prefs.getLong(KEY_STARTED_AT, 0L) <= 0L) return false
        return prefs.getLong(KEY_ANSWERED_AT, 0L) > 0L || prefs.getString(KEY_DIRECTION, "") == DIR_OUTGOING
    }

    fun onRinging(context: Context, number: String?) {
        /*
         * Call waiting: a second call ringing while one is already up. Android reports it as
         * RINGING, and treating that as a new call would throw away the call actually in progress
         * (and then mark the original as a freshly "answered" incoming one). The call on the line
         * stays the live one; the waiting call reaches the panel from the call log if it is missed.
         */
        if (inCall(context)) {
            Log.d(TAG, "Call waiting — keeping the call already in progress")
            return
        }
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

    /**
     * The caller's number, learned after the call was already reported as ringing (Android sends
     * the number in a second broadcast). Updates the dashboard in place — same call, same timer.
     */
    fun fillNumber(context: Context, number: String) {
        val prefs = CallIqConfig.prefs(context)
        if (prefs.getLong(KEY_STARTED_AT, 0L) <= 0L) return           // no call open
        if (!(prefs.getString(KEY_NUMBER, "") ?: "").isEmpty()) return // already known
        prefs.edit().putString(KEY_NUMBER, number).apply()
        Log.d(TAG, "Learned the number from the repeat broadcast")
        // Re-send the state the call is actually in: re-sending "ringing" for a call already off
        // hook is refused by the server as going backwards, and the number would be lost.
        send(context, if (inCall(context)) STATE_CONNECTED else STATE_RINGING)
    }

    /**
     * The line went off hook. Called for EVERY off-hook broadcast — Android sends two, and the
     * second (to apps holding READ_CALL_LOG) carries the number of the call on the line, outgoing
     * calls included. So this must be idempotent, and must never drop that number.
     *
     *  - an incoming call that was ringing  → it was answered: the talk timer starts now
     *  - a call already up (repeat broadcast, or back from call waiting) → only fill the number
     *  - no ring before it                   → the counselor placed this call: OUTGOING
     *
     * An outgoing call gets no "answered" time, on purpose: Android reports dialling and talking
     * as the same off-hook state, so any answer time here would be invented. The panel counts an
     * outgoing call from when it was dialled, says so, and swaps in the real talk time from the
     * call log the moment the call ends.
     */
    fun onOffHook(context: Context, number: String? = null) {
        val prefs = CallIqConfig.prefs(context)
        val now = System.currentTimeMillis()
        val started = prefs.getLong(KEY_STARTED_AT, 0L)
        val direction = prefs.getString(KEY_DIRECTION, "") ?: ""
        val answered = prefs.getLong(KEY_ANSWERED_AT, 0L)

        when {
            started > 0 && direction == DIR_INCOMING && answered <= 0L -> {
                val ed = prefs.edit().putLong(KEY_ANSWERED_AT, now)
                if (!number.isNullOrBlank() && (prefs.getString(KEY_NUMBER, "") ?: "").isEmpty()) ed.putString(KEY_NUMBER, number)
                ed.apply()
                send(context, STATE_CONNECTED)
            }
            started > 0 -> {
                if (!number.isNullOrBlank()) fillNumber(context, number)
            }
            else -> {
                prefs.edit()
                    .putLong(KEY_STARTED_AT, now)
                    .putString(KEY_DIRECTION, DIR_OUTGOING)
                    .putString(KEY_NUMBER, number ?: "")
                    .remove(KEY_ANSWERED_AT)
                    .apply()
                send(context, STATE_CONNECTED)
            }
        }
    }

    fun onIdle(context: Context) {
        send(context, STATE_ENDED)
        CallIqConfig.prefs(context).edit()
            .remove(KEY_STARTED_AT).remove(KEY_DIRECTION).remove(KEY_NUMBER).remove(KEY_ANSWERED_AT)
            .apply()
    }

    /**
     * The finished call, once Android has written its row: the real talk time (which for an
     * outgoing call is the only way to know it was answered at all) and, for an outgoing call, the
     * number — neither of which exists while the call is running. Sent as a last "ended" update so
     * the dashboard's card stops guessing and shows the truth.
     */
    fun finalise(context: Context, record: CallLogHelper.CallRecord) {
        val app = context.applicationContext
        val direction = when {
            record.callType.startsWith("OUTGOING") -> DIR_OUTGOING
            record.callType.startsWith("INCOMING") || record.callType.startsWith("MISSED") ||
                record.callType.startsWith("REJECTED") -> DIR_INCOMING
            else -> "unknown"
        }
        val body = JSONObject().apply {
            put("device_id", CallIqConfig.deviceId(app))
            put("state", STATE_ENDED)
            put("direction", direction)
            if (record.number.isNotEmpty()) put("number", record.number)
            put("started_at", record.timestamp)
            put("event_at", System.currentTimeMillis())
            // A missed or declined call was never talked on — Xiaomi writes its RING time here.
            val talked = !(record.callType.startsWith("MISSED") || record.callType.startsWith("REJECTED") || record.callType.startsWith("BLOCKED"))
            put("duration_sec", if (talked) record.duration else 0L)
            record.sim.slot?.let { put("sim_slot", it) }
            if (record.sim.carrier.isNotEmpty()) put("carrier", record.sim.carrier)
            if (record.sim.label.isNotEmpty()) put("sim_label", record.sim.label)
        }.toString()
        sender.execute { post(endpoint(app), body) }   // after "ended", never before it
    }

    /**
     * What we know about the call the instant it ends, WITHOUT waiting for Android to write its
     * call-log row: direction, the caller's number for an incoming call, when it started and
     * whether it was ever answered. This is what the post-call popup opens on.
     *
     * Call it before [onIdle], which clears the bookkeeping.
     */
    fun endedSnapshot(context: Context): CallLogHelper.CallRecord? {
        val prefs = CallIqConfig.prefs(context)
        val started = prefs.getLong(KEY_STARTED_AT, 0L)
        if (started <= 0L) return null

        val direction = prefs.getString(KEY_DIRECTION, "") ?: ""
        val number = prefs.getString(KEY_NUMBER, "") ?: ""
        val answered = prefs.getLong(KEY_ANSWERED_AT, 0L)
        val now = System.currentTimeMillis()

        /* Type as far as it can honestly be known yet:
           - incoming that was never answered  → MISSED (the log may later say REJECTED)
           - incoming that was answered        → INCOMING
           - anything we placed               → OUTGOING, answered or not; Android does not say. */
        val type = when {
            direction == DIR_INCOMING && answered <= 0L -> "MISSED"
            direction == DIR_INCOMING -> "INCOMING"
            direction == DIR_OUTGOING -> "OUTGOING"
            else -> "UNKNOWN"
        }
        // Provisional until the call-log row arrives a moment later with the real talk time.
        val duration = when {
            answered > 0L -> ((now - answered) / 1000).coerceAtLeast(0L)
            direction == DIR_OUTGOING -> ((now - started) / 1000).coerceAtLeast(0L)
            else -> 0L
        }

        return CallLogHelper.CallRecord(
            number = number,
            callType = type,
            duration = duration,
            timestamp = started,
            idempotencyKey = "",                       // unknown until the log row exists
            accountId = "",
            sim = SimResolver.resolve(context, "", null, started),
            fromLog = false,
        )
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
            put("popup_ok", SetupState.popupReady(context))
            sim.slot?.let { put("sim_slot", it) }
            if (sim.carrier.isNotEmpty()) put("carrier", sim.carrier)
            if (sim.label.isNotEmpty()) put("sim_label", sim.label)
        }
    }

    /**
     * Fire the event now on a background thread, and queue a worker as the safety net: it retries a
     * failed send and keeps the call alive on the dashboard until it really ends.
     */
    /*
     * One sender thread for every live event, in order.
     *
     * Events used to go out on a fresh Thread each, fired from the broadcast receiver and then
     * left running after it returned. Two problems, both invisible while the phone was attached to
     * Android Studio: separate threads could deliver "connected" before "ringing"; and once the
     * receiver returns, Android treats the process as cached — Android 14+ FREEZES cached
     * processes within seconds (Xiaomi and Oppo simply kill them), so the request stalled mid-send
     * and the dashboard never heard about the call. A debugger attached from Android Studio keeps
     * the process from ever being frozen, which is exactly why it only worked plugged in.
     *
     * Now events queue on one thread, and the receiver waits for the queue ([flush]) through
     * goAsync() before letting Android put the process away.
     */
    private val sender: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "ciq-live").apply { isDaemon = true } }

    private fun send(context: Context, state: String) {
        val app = context.applicationContext
        val body = payload(app, state).toString()
        sender.execute {
            val ok = post(endpoint(app), body)
            if (!ok) Log.w(TAG, "Live '$state' did not reach the server; the next heartbeat re-sends it.")
        }
        // With the monitor service running, the process stays alive and the service heartbeats
        // (see CallMonitorService). Without it, WorkManager is the only thing left to retry.
        if (!CallMonitorService.isRunning) {
            CallPresenceWorker.schedule(app, delaySeconds = if (state == STATE_ENDED) 0L else 5L)
        }
    }

    /** Blocks until every event queued so far has been sent (or [timeoutMs] passes). Never on the main thread. */
    fun flush(timeoutMs: Long) {
        try {
            sender.submit {}.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: Throwable) {
            Log.w(TAG, "flush: ${e.javaClass.simpleName}")
        }
    }

    /**
     * Re-sends the current call's state, read fresh from Android — so a lost event is recovered
     * and a missed hang-up still closes the call. Called by the monitor service while a call is up.
     */
    fun heartbeat(context: Context) {
        val app = context.applicationContext
        if (!hasOpenCall(app)) return
        val tm = try { app.getSystemService(TelephonyManager::class.java) } catch (e: Throwable) { null }
        @Suppress("DEPRECATION")
        val callState = try { tm?.callState ?: TelephonyManager.CALL_STATE_IDLE } catch (e: Throwable) { TelephonyManager.CALL_STATE_IDLE }
        if (callState == TelephonyManager.CALL_STATE_IDLE) {
            onIdle(app)
            return
        }
        val state = if (callState == TelephonyManager.CALL_STATE_RINGING && !inCall(app)) STATE_RINGING else STATE_CONNECTED
        val body = payload(app, state).toString()
        sender.execute { post(endpoint(app), body) }
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
