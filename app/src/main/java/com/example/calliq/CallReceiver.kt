package com.example.calliq

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.telephony.TelephonyManager
import android.util.Log

/**
 * Every call-state change: RINGING → OFFHOOK → IDLE.
 *
 * Two instances can exist: the one declared in the manifest (Android starts the app for it even
 * when it is not running), and one registered at runtime by [CallMonitorService] while that is
 * up. Both receive every broadcast, so when the service's copy is live the manifest one stands
 * aside — otherwise each event would be handled twice.
 */
class CallReceiver(private val viaService: Boolean = false) : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
        if (!viaService && CallMonitorService.isRunning) return

        val stateStr = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        val prefs = context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE)
        val prevState = prefs.getString("PREV_STATE", TelephonyManager.EXTRA_STATE_IDLE)

        Log.d("CallReceiver", "Phone state transition detected: prev=$prevState, new=$stateStr")

        when (stateStr) {
            TelephonyManager.EXTRA_STATE_RINGING,
            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                /*
                 * While the call is up, Android can say which SUBSCRIPTION is busy — the one piece
                 * of evidence that is never ambiguous. Recorded now and used by SimResolver when
                 * the call-log row (which only carries an OEM-specific phone-account id) arrives
                 * seconds later.
                 */
                SimResolver.captureActiveSim(context.applicationContext)

                /*
                 * Tell the dashboard the call is happening, now — the call log will not exist
                 * until it ends.
                 *
                 * Android delivers every state change TWICE: once to every app with no number, and
                 * again to apps holding READ_CALL_LOG WITH the number of the call on the line —
                 * the caller for RINGING, and for OFFHOOK the call being made, outgoing included.
                 * In either order. So a repeat is never simply dropped: it fills in the number.
                 */
                val app = context.applicationContext
                @Suppress("DEPRECATION")
                val number = try { intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) } catch (e: Throwable) { null }
                if (stateStr == TelephonyManager.EXTRA_STATE_RINGING) {
                    if (prevState != TelephonyManager.EXTRA_STATE_RINGING) CallPresence.onRinging(app, number)
                    else if (!number.isNullOrBlank()) CallPresence.fillNumber(app, number)
                } else {
                    // Idempotent: works out for itself whether this is an answer, a placed call
                    // or a repeat, so both broadcasts can go straight to it.
                    CallPresence.onOffHook(app, number)
                }

                prefs.edit().putString("PREV_STATE", stateStr).apply()

                // A call is starting: make sure the monitor is up for the rest of it (a no-op if
                // it already is, and quietly refused by Android where it is not allowed).
                if (CallMonitorService.isRunning) CallMonitorService.poke() else CallMonitorService.start(app)

                // Keep this process awake until the event has actually left the phone.
                val pending = goAsync()
                Thread {
                    try { CallPresence.flush(8_000) } finally { pending.finish() }
                }.start()
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                /*
                 * A call ended if we saw it start — OR if presence still holds an open call, which
                 * covers the case where this process was killed mid-call and PREV_STATE never got
                 * written. Relying on PREV_STATE alone silently skipped the popup in exactly the
                 * situation where it matters most.
                 */
                val wasInCall = prevState == TelephonyManager.EXTRA_STATE_OFFHOOK ||
                    prevState == TelephonyManager.EXTRA_STATE_RINGING ||
                    CallPresence.hasOpenCall(context.applicationContext)
                if (wasInCall) {
                    prefs.edit().putString("PREV_STATE", TelephonyManager.EXTRA_STATE_IDLE).apply()

                    val app = context.applicationContext

                    /*
                     * Ask for the outcome RIGHT NOW, from what we already know, before touching the
                     * call log at all — Android writes that row a second or three later (longer on
                     * some OEMs, and sometimes never for a rejected call). Waiting for it is what
                     * made the popup feel absent. The popup fills in the number, duration and type
                     * itself as soon as the row appears.
                     */
                    val snapshot = CallPresence.endedSnapshot(app)

                    // Clear the live row straight away; the call itself syncs a few seconds later.
                    CallPresence.onIdle(app)

                    if (snapshot != null) maybePrompt(app, snapshot)

                    val pendingResult = goAsync()
                    Handler(Looper.getMainLooper()).postDelayed({
                        try {
                            // Sync the call itself, and prompt here too when there was no snapshot
                            // to open on (e.g. the app was installed while the call was running).
                            syncAndPrompt(app, promptIfNotShowing = snapshot == null)
                        } catch (e: Exception) {
                            Log.e("CallReceiver", "Error querying call logs after delay: ${e.message}", e)
                        }
                        // The "ended" event and the real talk time must leave the phone before
                        // Android is allowed to freeze this process — off the main thread.
                        // 2.5 s already spent above; stay well inside the 10 s receiver limit.
                        Thread {
                            try { CallPresence.flush(6_000) } finally { pendingResult.finish() }
                        }.start()
                    }, 2500)
                }
            }
        }
    }

    private fun syncAndPrompt(app: Context, promptIfNotShowing: Boolean) {
        val record = CallLogHelper.processAndEnqueueRecentCalls(app)
        /* Now that Android has written the row, tell the dashboard what the call actually was:
           the real talk time, and — for an outgoing call — the number, neither of which can be
           known while it is still running. */
        if (record != null && System.currentTimeMillis() - record.timestamp <= 120_000) {
            CallPresence.finalise(app, record)
        }
        if (!promptIfNotShowing || CallPopupOverlay.isShowing()) return
        // Only ever ask about a call that just happened, never about history a catch-up pulled in.
        if (record != null && System.currentTimeMillis() - record.timestamp <= 90_000) maybePrompt(app, record)
    }

    companion object {
        /** Ask for the outcome, unless this call was already asked about or popups are off. */
        fun maybePrompt(app: Context, record: CallLogHelper.CallRecord) {
            if (!CallIqConfig.popupEnabled(app)) {
                CallIqConfig.notePopup(app, "skipped: the popup is switched off in the app")
                return
            }

            val missed = record.callType.startsWith("MISSED") || record.callType.startsWith("REJECTED")
            if (missed && !CallIqConfig.popupForMissed(app)) {
                CallIqConfig.notePopup(app, "skipped: missed-call popups are switched off")
                return
            }

            // Only for the call that just happened — never for history pulled in by a catch-up.
            if (System.currentTimeMillis() - record.timestamp > 5 * 60 * 1000) return

            /* One popup per call. The key is the call's start time, which both the snapshot and
               the call-log row agree on, so the later sync cannot open a second popup. */
            val stamp = "${record.timestamp / 1000}"
            val prefs = CallIqConfig.prefs(app)
            if (prefs.getString(CallIqConfig.KEY_LAST_POPUP_KEY, "") == stamp) return
            prefs.edit().putString(CallIqConfig.KEY_LAST_POPUP_KEY, stamp).apply()

            CallPopupLauncher.show(app, record)
        }
    }
}
