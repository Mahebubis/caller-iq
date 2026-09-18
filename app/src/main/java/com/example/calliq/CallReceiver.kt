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
        val prefs = context.getSharedPreferences("call_tracker_prefs", Context.MODE_PRIVATE)
        val prevState = prefs.getString("PREV_STATE", TelephonyManager.EXTRA_STATE_IDLE)

        Log.d("CallReceiver", "Phone state transition detected: prev=$prevState, new=$stateStr")

        when (stateStr) {
            TelephonyManager.EXTRA_STATE_RINGING,
            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                prefs.edit().putString("PREV_STATE", stateStr).apply()
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                if (prevState == TelephonyManager.EXTRA_STATE_OFFHOOK || prevState == TelephonyManager.EXTRA_STATE_RINGING) {
                    prefs.edit().putString("PREV_STATE", TelephonyManager.EXTRA_STATE_IDLE).apply()

                    val pendingResult = goAsync()
                    Handler(Looper.getMainLooper()).postDelayed({
                        try {
                            CallLogHelper.processAndEnqueueRecentCalls(context)
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
}