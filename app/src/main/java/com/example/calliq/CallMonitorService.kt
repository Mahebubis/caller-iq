package com.example.calliq

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps CallIQ running, so every call is seen — the standard way call-tracking apps stay alive.
 *
 * Without it, CallIQ only runs for the few seconds Android gives a broadcast receiver. Between
 * calls the process is "cached": Android 14+ freezes it, and Xiaomi, Oppo, Vivo and Samsung's own
 * battery managers kill it — after which the phone may not even wake the app for the next call.
 * That is why everything worked while the phone was plugged into Android Studio (a debugged app is
 * never frozen or killed) and fell apart from an installed APK.
 *
 * A foreground service is Android's own answer: the process stays alive, live events always get
 * out, and — because a receiver is registered from here at runtime — calls are noticed even where
 * the phone maker blocks the manifest receiver ("Autostart" off). Android requires a visible
 * notification for it; it is posted at the lowest importance, so it sits quietly in the shade.
 *
 * While a call is up it heartbeats every 30 s (the live card stays current, and a missed hang-up
 * still closes the call). While the phone is idle it does nothing at all — no network, no timers.
 */
class CallMonitorService : Service() {

    companion object {
        private const val TAG = "CallMonitorService"
        private const val CHANNEL_ID = "caller_iq_monitor"
        private const val NOTIFICATION_ID = 4712
        private const val BEAT_MS = 30_000L

        /** True only once the runtime receiver is registered — the manifest receiver defers to it. */
        @Volatile var isRunning = false
            private set

        /**
         * Starts it if it is switched on. Safe from anywhere: where Android does not allow a
         * start (from the background on Android 12+, without an exemption) it is simply refused,
         * and the manifest receiver carries on as before.
         */
        fun start(context: Context): Boolean {
            if (!CallIqConfig.monitorEnabled(context)) return false
            return try {
                ContextCompat.startForegroundService(context, Intent(context, CallMonitorService::class.java))
                true
            } catch (e: Throwable) {
                Log.w(TAG, "not started: ${e.javaClass.simpleName} ${e.message}")
                false
            }
        }

        /** A call just started: restart the heartbeat on the running service (same process). */
        fun poke() {
            instance?.kick()
        }

        @Volatile private var instance: CallMonitorService? = null

        fun stop(context: Context) {
            try { context.stopService(Intent(context, CallMonitorService::class.java)) } catch (e: Throwable) { }
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var receiver: CallReceiver? = null
    private var foreground = false

    private fun kick() {
        handler.post {
            handler.removeCallbacks(beat)
            handler.postDelayed(beat, BEAT_MS)
        }
    }

    /** Heartbeats only while a call is open; reschedules itself only then. */
    private val beat = object : Runnable {
        override fun run() {
            if (CallPresence.hasOpenCall(this@CallMonitorService)) {
                CallPresence.heartbeat(this@CallMonitorService)
                handler.postDelayed(this, BEAT_MS)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        // First, before anything that could fail: Android gives a started foreground service only
        // a few seconds to show its notification.
        foreground = goForeground()
        if (!foreground) {
            stopSelf()
            return
        }
        instance = this
        try {
            val r = CallReceiver(viaService = true)
            ContextCompat.registerReceiver(
                this, r, IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED), ContextCompat.RECEIVER_EXPORTED
            )
            receiver = r
            isRunning = true
            Log.d(TAG, "monitoring calls")
        } catch (e: Throwable) {
            Log.w(TAG, "could not listen for calls: ${e.message}")
        }
        // Picked up mid-call (just started, or restarted by Android): resume the heartbeat.
        handler.post(beat)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!foreground || !CallIqConfig.monitorEnabled(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        kick()
        // If Android ever has to kill it for memory, it brings it back as soon as it can.
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        instance = null
        handler.removeCallbacks(beat)
        receiver?.let { try { unregisterReceiver(it) } catch (e: Throwable) { } }
        receiver = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun goForeground(): Boolean = try {
        ensureChannel()
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle("CallIQ is tracking calls")
            .setContentText("Calls and live status reach the panel as they happen.")
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
        // Android 14+ requires the type declared in the manifest to be passed here too.
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
        true
    } catch (e: Throwable) {
        Log.w(TAG, "startForeground failed: ${e.javaClass.simpleName} ${e.message}")
        false
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Call tracking", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Shown while CallIQ is running so no call is missed."
                setShowBadge(false)
            }
        )
    }
}
