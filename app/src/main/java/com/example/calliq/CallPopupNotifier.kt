package com.example.calliq

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.util.Log
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

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
    private val QUICK = listOf("Interested", "Callback Scheduled", "Resolved")

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
                // Fewer outcomes than slots: the spare chips are hidden, not left blank.
                CHIP_IDS.forEachIndexed { i, id ->
                    if (i >= CallIqConfig.DISPOSITIONS.size) setViewVisibility(id, android.view.View.GONE)
                }
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

/**
 * Callback reminders: "call this lead back at 4:30". One AlarmManager alarm per reminder id, each
 * also kept in prefs so [BootReceiver] can arm it again after a restart (alarms do not survive
 * one). Shared by the bridge, [CallbackReminderReceiver] and [BootReceiver].
 *
 * Exact when Android allows it; when "Alarms & reminders" is off (Android 12+) it falls back to an
 * inexact alarm, which still arrives — just within the system's window.
 */
object CallbackReminders {

    private const val PREFS = "calliq_reminders"
    private const val CHANNEL_ID = "calliq_callback_reminders"
    private const val ACTION = "com.example.calliq.CALLBACK_REMINDER"

    const val EXTRA_ID = "reminder_id"
    const val EXTRA_TITLE = "reminder_title"
    const val EXTRA_BODY = "reminder_body"
    const val EXTRA_NUMBER = "reminder_number"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun alarmIntent(ctx: Context, id: String, title: String = "", body: String = "", number: String = "") =
        PendingIntent.getBroadcast(
            ctx, id.hashCode(),
            Intent(ctx, CallbackReminderReceiver::class.java).setAction(ACTION)
                .putExtra(EXTRA_ID, id).putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_BODY, body).putExtra(EXTRA_NUMBER, number),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    /** Arms (or replaces) one reminder. Returns "exact", "inexact", or "fired" when [atMs] has already passed. */
    fun schedule(context: Context, id: String, atMs: Long, title: String, body: String, number: String): String {
        val ctx = context.applicationContext
        if (atMs <= System.currentTimeMillis()) {
            post(ctx, id, title, body, number)
            return "fired"
        }
        prefs(ctx).edit().putString(id, JSONObject().apply {
            put("id", id); put("atMs", atMs); put("title", title); put("body", body); put("number", number)
        }.toString()).apply()

        val am = ctx.getSystemService(AlarmManager::class.java)
        val pi = alarmIntent(ctx, id, title, body, number)
        val exactAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
        if (exactAllowed) {
            try {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi)
                return "exact"
            } catch (_: SecurityException) {
                // Revoked between the check and the call: fall through to inexact.
            }
        }
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi)
        return "inexact"
    }

    /** Disarms a reminder, forgets it, and clears its notification if it is showing. */
    fun cancel(context: Context, id: String) {
        val ctx = context.applicationContext
        val pi = alarmIntent(ctx, id)
        ctx.getSystemService(AlarmManager::class.java)?.cancel(pi)
        pi.cancel()
        prefs(ctx).edit().remove(id).apply()
        ctx.getSystemService(NotificationManager::class.java)?.cancel(id.hashCode())
    }

    /** After a reboot: future reminders are armed again, overdue ones shown now. */
    fun rearmAll(context: Context) {
        val ctx = context.applicationContext
        prefs(ctx).all.values.forEach { raw ->
            try {
                val o = JSONObject(raw as? String ?: return@forEach)
                schedule(ctx, o.getString("id"), o.getLong("atMs"),
                    o.optString("title"), o.optString("body"), o.optString("number"))
            } catch (_: Throwable) { }
        }
    }

    private fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Callback reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Reminds you to call a lead back at the time you set"
                enableVibration(true)
                setSound(
                    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                    AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build()
                )
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
        )
    }

    /** Shows the reminder, then forgets it — it has done its job. */
    fun post(context: Context, id: String, title: String, body: String, number: String) {
        val ctx = context.applicationContext
        try {
            ensureChannel(ctx)
            val nm = ctx.getSystemService(NotificationManager::class.java) ?: return

            val open = PendingIntent.getActivity(
                ctx, id.hashCode(),
                Intent(ctx, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.sym_action_call)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setDefaults(NotificationCompat.DEFAULT_SOUND or NotificationCompat.DEFAULT_VIBRATE)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(open)

            if (number.isNotBlank()) {
                // Straight onto the line when the Phone permission is there; otherwise the dialer, pre-filled.
                val canCall = ContextCompat.checkSelfPermission(ctx, Manifest.permission.CALL_PHONE) ==
                    PackageManager.PERMISSION_GRANTED
                val call = Intent(if (canCall) Intent.ACTION_CALL else Intent.ACTION_DIAL, Uri.parse("tel:$number"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                builder.addAction(
                    0, "Call now",
                    PendingIntent.getActivity(ctx, id.hashCode() + 1, call, PendingIntent.FLAG_IMMUTABLE)
                )
            }

            nm.notify(id.hashCode(), builder.build())
        } catch (_: Throwable) {
        } finally {
            prefs(ctx).edit().remove(id).apply()
        }
    }
}

/** Fires when a callback reminder's alarm goes off. Not exported: only our own alarms reach it. */
class CallbackReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(CallbackReminders.EXTRA_ID) ?: return
        CallbackReminders.post(
            context, id,
            intent.getStringExtra(CallbackReminders.EXTRA_TITLE) ?: "",
            intent.getStringExtra(CallbackReminders.EXTRA_BODY) ?: "",
            intent.getStringExtra(CallbackReminders.EXTRA_NUMBER) ?: ""
        )
    }
}
