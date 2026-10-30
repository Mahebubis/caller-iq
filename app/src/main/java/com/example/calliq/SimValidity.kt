package com.example.calliq

import android.content.Context
import java.util.Calendar
import java.util.Locale

/**
 * When each SIM's prepaid plan runs out, and the recharge reminder two days before.
 *
 * The date comes from either side:
 *   auto    read out of the operator's USSD reply by [UssdChecker] (when the operator says it —
 *           Airtel's *121# and Vi's *199# often answer with an app advert or not at all);
 *   manual  set by the counselor in the SIM sheet ("Recharged today: +28 days", or a date).
 *
 * The reminder rides on [CallbackReminders]: an AlarmManager alarm that is kept in prefs, armed
 * again after a reboot ([BootReceiver]) and shown even with the app closed. It fires at 10:00, two
 * days before the plan's last day, once per date: a new date (a recharge) starts a new reminder.
 */
object SimValidity {

    private const val REMIND_DAYS = 2
    private const val REMIND_HOUR = 10

    private fun keyDate(slot: Int) = "SIM_VALID_TILL_$slot"
    private fun keySource(slot: Int) = "SIM_VALID_SRC_$slot"
    private fun keyArmed(slot: Int) = "SIM_VALID_ARMED_$slot"
    private fun reminderId(slot: Int) = "recharge_sim_$slot"

    /** The plan's last day as yyyy-MM-dd, or "" when it is not known. */
    fun date(context: Context, slot: Int): String =
        CallIqConfig.prefs(context).getString(keyDate(slot), "") ?: ""

    /** "auto" (from the operator's reply) or "manual" (typed in), "" when unknown. */
    fun source(context: Context, slot: Int): String =
        CallIqConfig.prefs(context).getString(keySource(slot), "") ?: ""

    /** Saves the date (yyyy-MM-dd; blank clears it) and arms its reminder. */
    fun set(context: Context, slot: Int, date: String, source: String) {
        val ctx = context.applicationContext
        val d = date.trim()
        if (d.isNotEmpty() && parse(d) == null) throw IllegalArgumentException("Not a date: $d")
        CallIqConfig.prefs(ctx).edit().apply {
            if (d.isEmpty()) { remove(keyDate(slot)); remove(keySource(slot)) }
            else { putString(keyDate(slot), d); putString(keySource(slot), source) }
        }.apply()
        arm(ctx, slot)
    }

    /** Both slots — at app start, after a reboot and after each daily check. Idempotent. */
    fun armAll(context: Context) {
        for (slot in 1..2) arm(context.applicationContext, slot)
    }

    fun arm(context: Context, slot: Int) {
        val ctx = context.applicationContext
        val prefs = CallIqConfig.prefs(ctx)
        val date = date(ctx, slot)
        val last = date.takeIf { it.isNotEmpty() }?.let { parse(it) }
        if (last == null) {
            CallbackReminders.cancel(ctx, reminderId(slot))
            prefs.edit().remove(keyArmed(slot)).apply()
            return
        }
        // Already reminded (or armed) for this very date: nothing to do. A new date re-arms.
        if (prefs.getString(keyArmed(slot), "") == date) return

        val endOfLastDay = (last.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, 1) }.timeInMillis
        if (System.currentTimeMillis() >= endOfLastDay) {
            // The plan has already run out: no "in 2 days" reminder for a date in the past.
            CallbackReminders.cancel(ctx, reminderId(slot))
            prefs.edit().putString(keyArmed(slot), date).apply()
            return
        }
        val at = (last.clone() as Calendar).apply {
            add(Calendar.DAY_OF_YEAR, -REMIND_DAYS)
            set(Calendar.HOUR_OF_DAY, REMIND_HOUR)
        }.timeInMillis
        val (title, body) = words(ctx, slot, last)
        // In the past (set late, inside the last two days) → shown straight away, once.
        CallbackReminders.schedule(ctx, reminderId(slot), at, title, body, "")
        prefs.edit().putString(keyArmed(slot), date).apply()
    }

    private fun words(ctx: Context, slot: Int, last: Calendar): Pair<String, String> {
        // The counselor's label for the slot ({"SIM 1": "SIM 1: Inbound leads", …}), as on the panel.
        val label = try {
            org.json.JSONObject(CallIqConfig.prefs(ctx).getString("SIM_NICKNAMES", "{}") ?: "{}")
                .optString("SIM $slot").takeIf { it.isNotBlank() }
        } catch (_: Throwable) { null }
        val day = String.format(Locale.ENGLISH, "%ta %<te %<tb", last)
        val title = "Recharge SIM $slot by $day"
        val body = "${label ?: "SIM $slot"}: the plan ends on $day. Recharge before then so calls on " +
            "this SIM keep reaching the panel."
        return title to body
    }

    private fun parse(date: String): Calendar? {
        val m = Regex("^(\\d{4})-(\\d{2})-(\\d{2})$").find(date) ?: return null
        val (y, mo, d) = m.destructured
        return Calendar.getInstance().apply {
            clear()
            set(y.toInt(), mo.toInt() - 1, d.toInt(), 0, 0, 0)
            isLenient = false
            try { timeInMillis } catch (_: Throwable) { return null }
        }
    }
}
