package com.example.calliq

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Brings call tracking back after the phone restarts, or after CallIQ is updated — two moments
 * when Android stops every app and, for these two broadcasts, explicitly allows a foreground
 * service to be started from the background. Without it, a counselor who rebooted their phone
 * would be untracked until they happened to open the app.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON" -> CallMonitorService.start(context.applicationContext)
        }
    }
}
