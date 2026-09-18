package com.example.calliq

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.util.Log

/**
 * The fallback for the post-call popup: a heads-up notification carrying the same one-tap
 * outcomes. Used when "Display over other apps" is off (Android will not let any app draw over
 * the dialer without it) and whenever adding the overlay window fails.
 *
 * Notifications need no special permission below Android 13; on 13+ the app asks for
 * POST_NOTIFICATIONS at startup.
 */
object CallPopupNotifier {

    private const val TAG = "CallPopupNotifier"
    private const val CHANNEL_ID = "calliq_post_call"
    const val NOTIFICATION_ID = 4711

    /** The three outcomes offered as notification buttons — Android shows at most three. */
    private val QUICK = listOf("Interested", "Callback Scheduled", "Not Answering")

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Post-call tagging", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Asks for the outcome right after a call ends"
                enableVibration(false)
                setShowBadge(false)
                lightColor = Color.BLUE
            }
        )
    }

    private fun flags() = PendingIntent.FLAG_UPDATE_CURRENT or
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0

    fun notify(context: Context, call: CallLogHelper.CallRecord) {
        val app = context.applicationContext
        try {
            ensureChannel(app)
            val nm = app.getSystemService(NotificationManager::class.java) ?: return

            val typeLabel = when {
                call.callType.startsWith("OUTGOING") -> "Outgoing"
                call.callType.startsWith("INCOMING") -> "Incoming"
                call.callType.startsWith("MISSED") -> "Missed"
                call.callType.startsWith("REJECTED") -> "Rejected"
                else -> "Call"
            }
            val dur = if (call.duration > 0) "${call.duration / 60}m ${call.duration % 60}s" else "not connected"
            val summary = "$typeLabel · $dur · ${call.sim.display}"

            val open = PendingIntent.getActivity(
                app, 0,
                Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                flags()
            )

            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                Notification.Builder(app, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(app)

            builder.setSmallIcon(android.R.drawable.sym_action_call)
                .setContentTitle(call.number)
                .setContentText("$summary — tag this call")
                .setStyle(Notification.BigTextStyle().bigText("$summary\nTag the outcome so it reaches the dashboard."))
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(open)
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                @Suppress("DEPRECATION") builder.setPriority(Notification.PRIORITY_HIGH)
            }

            QUICK.forEachIndexed { i, outcome ->
                val intent = OutcomeActionReceiver.intentFor(app, call, outcome)
                val pi = PendingIntent.getBroadcast(app, 100 + i, intent, flags())
                builder.addAction(
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                        Notification.Action.Builder(null as android.graphics.drawable.Icon?, outcome, pi).build()
                    else @Suppress("DEPRECATION") Notification.Action.Builder(0, outcome, pi).build()
                )
            }

            nm.notify(NOTIFICATION_ID, builder.build())
            Log.d(TAG, "Posted post-call notification for ${call.number}")
        } catch (e: Throwable) {
            Log.e(TAG, "Could not post the post-call notification: ${e.message}", e)
        }
    }

    fun cancel(context: Context) {
        try {
            context.applicationContext.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
        } catch (e: Throwable) { }
    }
}
