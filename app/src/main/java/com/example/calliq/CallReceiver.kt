package com.example.calliq

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.telephony.TelephonyManager
import android.util.Log

class CallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

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

                // Tell the dashboard the call is happening, now — the call log will not exist
                // until it ends. RINGING carries the caller's number; OFFHOOK never does.
                val app = context.applicationContext
                if (stateStr == TelephonyManager.EXTRA_STATE_RINGING) {
                    @Suppress("DEPRECATION")
                    val incoming = try { intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) } catch (e: Throwable) { null }
                    // A second RINGING for the same call (some OEMs repeat it) must not restart the timer.
                    if (prevState != TelephonyManager.EXTRA_STATE_RINGING) CallPresence.onRinging(app, incoming)
                } else if (prevState != TelephonyManager.EXTRA_STATE_OFFHOOK) {
                    CallPresence.onOffHook(app)
                }

                prefs.edit().putString("PREV_STATE", stateStr).apply()
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                if (prevState == TelephonyManager.EXTRA_STATE_OFFHOOK || prevState == TelephonyManager.EXTRA_STATE_RINGING) {
                    prefs.edit().putString("PREV_STATE", TelephonyManager.EXTRA_STATE_IDLE).apply()

                    val app = context.applicationContext
                    // Clear the live row straight away; the call itself syncs a few seconds later.
                    CallPresence.onIdle(app)
                    val pendingResult = goAsync()
                    // The call-log row is written a moment after the call ends; 3s catches it on
                    // most phones, and a second pass at 9s covers the slow ones.
                    Handler(Looper.getMainLooper()).postDelayed({
                        try {
                            syncAndPrompt(app, retry = true)
                        } catch (e: Exception) {
                            Log.e("CallReceiver", "Error querying call logs after delay: ${e.message}", e)
                        } finally {
                            pendingResult.finish()
                        }
                    }, 3000)
                }
            }
        }
    }

    private fun syncAndPrompt(app: Context, retry: Boolean) {
        val record = CallLogHelper.processAndEnqueueRecentCalls(app)
        /*
         * The row for the call that just ended can take a few seconds to appear. If the newest row
         * is older than a minute and a half it is the PREVIOUS call, and asking about that one
         * would tag the wrong call — wait and look again instead.
         */
        val stale = record == null || System.currentTimeMillis() - record.timestamp > 90_000
        if (stale && retry) {
            Handler(Looper.getMainLooper()).postDelayed({ syncAndPrompt(app, retry = false) }, 6000)
            return
        }
        if (record != null && !stale) maybePrompt(app, record)
    }

    companion object {
        /** Ask for the outcome, unless this call was already asked about or popups are off. */
        fun maybePrompt(app: Context, record: CallLogHelper.CallRecord) {
            if (!CallIqConfig.popupEnabled(app)) return

            val missed = record.callType.startsWith("MISSED") || record.callType.startsWith("REJECTED")
            if (missed && !CallIqConfig.popupForMissed(app)) return

            // Only for the call that just happened — never for history pulled in by a catch-up.
            if (System.currentTimeMillis() - record.timestamp > 5 * 60 * 1000) return

            val prefs = CallIqConfig.prefs(app)
            if (prefs.getString(CallIqConfig.KEY_LAST_POPUP_KEY, "") == record.idempotencyKey) return
            prefs.edit().putString(CallIqConfig.KEY_LAST_POPUP_KEY, record.idempotencyKey).apply()

            CallPopupOverlay.show(app, record)
        }
    }
}
