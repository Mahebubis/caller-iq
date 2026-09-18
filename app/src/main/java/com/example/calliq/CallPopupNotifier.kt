package com.example.calliq

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import android.util.Log
import android.widget.RemoteViews

/**
 * The post-call prompt as a notification — the route that needs no permission beyond notifications
 * themselves, used whenever [CallPopupOverlay] cannot draw (no "Display over other apps", or the
 * system refused the window).
 *
 * Two things make it a real fallback rather than a consolation prize:
 *
 *  · it carries EVERY outcome, not the three that Android allows as action buttons, by drawing its
 *    own expanded layout (ciq_notif_expanded.xml). One tap tags the call from the shade.
 *  · it sets a full-screen intent, so when the phone is locked as the call ends, Android opens
 *    [CallPopupActivity] outright — the animated card, with no tap at all. Unlocked, the same
 *    notification arrives as a heads-up banner, and tapping it opens that card.
 */
object CallPopupNotifier {

    private const val TAG = "CallPopupNotifier"
    private const val CHANNEL_ID = "calliq_post_call"
    const val NOTIFICATION_ID = 4711

    /** The three shown as ordinary action buttons on the collapsed notification. */
    private val QUICK = listOf("Interested", "Callback Scheduled", "Not Answering")

    private val CHIP_IDS = intArrayOf(
        R.id.ciq_tag_0, R.id.ciq_tag_1, R.id.ciq_tag_2, R.id.ciq_tag_3,
        R.id.ciq_tag_4, R.id.ciq_tag_5, R.id.ciq_tag_6,
    )

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Post-call tagging", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Asks for the outcome right after a call ends"
                enableVibration(true)
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
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

            val title = CallPopupView.titleFor(call)
            val meta = CallPopupView.metaLine(call)

            // Tapping the notification — or the lock screen firing the full-screen intent — opens
            // the same card as a screen.
            val popup = PendingIntent.getActivity(
                app, 1, CallPopupActivity.intentFor(app, call), flags()
            )

            val big = RemoteViews(app.packageName, R.layout.ciq_notif_expanded).apply {
                setTextViewText(R.id.ciq_title, title)
                setTextViewText(R.id.ciq_meta, meta)
                CallIqConfig.DISPOSITIONS.forEachIndexed { i, (label, _) ->
                    if (i < CHIP_IDS.size) {
                        setTextViewText(CHIP_IDS[i], label)
                        setOnClickPendingIntent(
                            CHIP_IDS[i],
                            PendingIntent.getBroadcast(app, 200 + i, OutcomeActionReceiver.intentFor(app, call, label), flags())
                        )
                    }
                }
                setOnClickPendingIntent(R.id.ciq_open, popup)
                // The footer doubles as the way out of notifications: one tap to the setting that
                // turns this into a real popup.
                setTextViewText(R.id.ciq_open, "Open the full popup  ·  turn on instant popups")
            }

            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                Notification.Builder(app, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(app)

            builder.setSmallIcon(android.R.drawable.sym_action_call)
                .setContentTitle(title)
                // Says why this is a notification and not the popup, because the fix is one tap away.
                .setContentText("$meta — tap to tag · allow “Display over other apps” for the instant popup")
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_CALL)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setContentIntent(popup)
                // Locked phone: Android opens the card itself. Unlocked: a heads-up banner.
                .setFullScreenIntent(popup, true)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                builder.setCustomBigContentView(big)
                builder.style = Notification.DecoratedCustomViewStyle()
            } else {
                @Suppress("DEPRECATION") builder.setPriority(Notification.PRIORITY_HIGH)
            }

            // Three of them also as ordinary buttons, for the collapsed shade and for watches.
            QUICK.forEachIndexed { i, outcome ->
                val pi = PendingIntent.getBroadcast(app, 100 + i, OutcomeActionReceiver.intentFor(app, call, outcome), flags())
                builder.addAction(
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                        Notification.Action.Builder(null as android.graphics.drawable.Icon?, outcome, pi).build()
                    else @Suppress("DEPRECATION") Notification.Action.Builder(0, outcome, pi).build()
                )
            }

            nm.notify(NOTIFICATION_ID, builder.build())
            CallIqConfig.notePopup(app, "notification shown for ${call.number.ifEmpty { "the last call" }} (allow “Display over other apps” for the instant popup)")
            Log.d(TAG, "Posted post-call notification for ${call.number}")
        } catch (e: Throwable) {
            Log.e(TAG, "Could not post the post-call notification: ${e.message}", e)
            CallIqConfig.notePopup(app, "could not show anything: ${e.javaClass.simpleName}")
        }
    }

    fun cancel(context: Context) {
        try {
            context.applicationContext.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
        } catch (e: Throwable) { }
    }
}
