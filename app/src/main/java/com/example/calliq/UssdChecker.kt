package com.example.calliq

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telephony.TelephonyManager
import android.util.Log
import org.json.JSONObject
import java.util.Calendar
import java.util.Locale
import java.util.regex.Pattern

/**
 * Asks the network what a SIM has left, by running the carrier's own USSD code.
 *
 * Android exposes no prepaid balance or plan validity to apps — but since Android 8 it will run a
 * USSD code for us and hand back the operator's reply, per SIM, with no dialer screen and nothing
 * for the counselor to do. That reply is the same text they would see after dialling *121#, so this
 * is the one honest route to "is this SIM recharged, and until when".
 *
 * What it cannot do, and the dashboard says so rather than pretending:
 *  · Menu codes that answer "reply 1 for balance" cannot be automated — Android has no way to send
 *    the follow-up. Only codes that reply in one shot work.
 *  · Some carriers and some ROMs refuse programmatic USSD outright; the failure is reported.
 *  · Jio answers almost nothing over USSD; it uses its own app and SMS.
 *  · A check cannot run during a call, and briefly occupies the line otherwise.
 *
 * The raw reply is always kept and shown in the panel. Even when the parser cannot pick a date out
 * of it, a person reads "Validity 25-Sep-26" at a glance — so a failed parse still answers the
 * question, which is the point.
 */
object UssdChecker {

    private const val TAG = "UssdChecker"

    /** Single-shot balance codes that answer without a menu. Editable per SIM in the app. */
    private val DEFAULT_CODES = mapOf(
        "airtel" to "*121#",
        "vi" to "*199#",
        "vodafone" to "*199#",
        "idea" to "*199#",
        "bsnl" to "*123#",
        "jio" to "*333#",
    )

    fun defaultCodeFor(carrier: String): String {
        val c = carrier.lowercase(Locale.ROOT)
        for ((name, code) in DEFAULT_CODES) if (c.contains(name)) return code
        return "*121#"
    }

    fun codeFor(context: Context, slot: Int, carrier: String): String {
        val saved = CallIqConfig.prefs(context).getString("USSD_CODE_$slot", null)
        return if (!saved.isNullOrBlank()) saved else defaultCodeFor(carrier)
    }

    fun setCode(context: Context, slot: Int, code: String) {
        CallIqConfig.prefs(context).edit().putString("USSD_CODE_$slot", code.trim()).apply()
    }

    /* ── Running the check ────────────────────────────────────────────────── */

    interface Result {
        fun onDone(slot: Int, ok: Boolean, text: String)
    }

    /**
     * Runs the code on one SIM. The reply arrives on a callback, so this returns immediately.
     * Requires CALL_PHONE; without it Android throws and the failure is reported as-is.
     */
    @SuppressLint("MissingPermission")
    fun check(context: Context, slot: Int, result: Result?) {
        val app = context.applicationContext
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            report(app, slot, false, "This phone is too old for automatic balance checks (needs Android 8).", result)
            return
        }
        val info = SimResolver.infoForSlot(app, slot)
        if (info == null) {
            report(app, slot, false, "SIM $slot is not in this phone any more.", result)
            return
        }
        val carrier = try { info.carrierName?.toString() ?: "" } catch (e: Throwable) { "" }
        val code = codeFor(app, slot, carrier)

        // A USSD request during a call would drop it; wait for a quieter moment instead.
        val tmAll = app.getSystemService(TelephonyManager::class.java)
        @Suppress("DEPRECATION")
        val busy = try { (tmAll?.callState ?: TelephonyManager.CALL_STATE_IDLE) != TelephonyManager.CALL_STATE_IDLE } catch (e: Throwable) { false }
        if (busy) {
            report(app, slot, false, "Skipped: a call was in progress.", result)
            return
        }

        val tm = try { tmAll?.createForSubscriptionId(info.subscriptionId) } catch (e: Throwable) { null }
        if (tm == null) {
            report(app, slot, false, "Could not reach SIM $slot.", result)
            return
        }

        try {
            tm.sendUssdRequest(code, object : TelephonyManager.UssdResponseCallback() {
                override fun onReceiveUssdResponse(t: TelephonyManager?, request: String?, response: CharSequence?) {
                    val text = response?.toString()?.trim().orEmpty()
                    Log.d(TAG, "USSD $code on SIM $slot → $text")
                    report(app, slot, true, text, result)
                }

                override fun onReceiveUssdResponseFailed(t: TelephonyManager?, request: String?, failureCode: Int) {
                    val why = when (failureCode) {
                        TelephonyManager.USSD_RETURN_FAILURE -> "the network rejected $code"
                        TelephonyManager.USSD_ERROR_SERVICE_UNAVAIL -> "the service was unavailable"
                        else -> "failure code $failureCode"
                    }
                    Log.w(TAG, "USSD $code on SIM $slot failed: $why")
                    report(app, slot, false, "No reply — $why. Try a different code for this operator.", result)
                }
            }, Handler(Looper.getMainLooper()))
        } catch (e: SecurityException) {
            report(app, slot, false, "The Phone-calls permission is needed to run $code.", result)
        } catch (e: Throwable) {
            report(app, slot, false, "Could not run $code: ${e.javaClass.simpleName}", result)
        }
    }

    private fun report(app: Context, slot: Int, ok: Boolean, text: String, result: Result?) {
        send(app, slot, ok, text)
        result?.onDone(slot, ok, text)
    }

    /* ── Reading the reply ────────────────────────────────────────────────── */

    private val MON = mapOf(
        "jan" to 1, "feb" to 2, "mar" to 3, "apr" to 4, "may" to 5, "jun" to 6,
        "jul" to 7, "aug" to 8, "sep" to 9, "oct" to 10, "nov" to 11, "dec" to 12,
    )

    /** "25-Sep-2026", "25/09/26", "25.09.2026" → 2026-09-25, or null. */
    fun parseValidTill(text: String): String? {
        if (text.isBlank()) return null
        val lower = text.lowercase(Locale.ROOT)
        // Only trust a date that is actually described as a validity/expiry.
        val near = Regex("(valid(ity)?( till| upto| up to| until)?|expir(y|es|ing)( on)?|exp\\.?)[^0-9]{0,20}([0-9]{1,2})[-/. ]([0-9]{1,2}|[a-z]{3,9})[-/. ]([0-9]{2,4})")
            .find(lower) ?: return null
        val d = near.groupValues[6].toIntOrNull() ?: return null
        val mRaw = near.groupValues[7]
        val m = mRaw.toIntOrNull() ?: MON[mRaw.take(3)] ?: return null
        var y = near.groupValues[8].toIntOrNull() ?: return null
        if (y < 100) y += 2000
        if (d !in 1..31 || m !in 1..12 || y !in 2020..2100) return null
        return String.format(Locale.ROOT, "%04d-%02d-%02d", y, m, d)
    }

    /** "Rs 47.50", "₹120", "MRP 299" → "47.50". */
    fun parseBalance(text: String): String? {
        if (text.isBlank()) return null
        val m = Pattern.compile("(?:rs\\.?|inr|₹)\\s*([0-9]+(?:\\.[0-9]{1,2})?)", Pattern.CASE_INSENSITIVE).matcher(text)
        return if (m.find()) m.group(1) else null
    }

    /* ── Sending it to the panel ──────────────────────────────────────────── */

    private fun send(app: Context, slot: Int, ok: Boolean, text: String) {
        val sim = SimResolver.resolve(app, "", null, System.currentTimeMillis())
        val info = SimResolver.infoForSlot(app, slot)
        val carrier = try { info?.carrierName?.toString() ?: sim.carrier } catch (e: Throwable) { "" }
        val body = JSONObject().apply {
            put("device_id", CallIqConfig.deviceId(app))
            put("slot", slot)
            put("carrier", carrier)
            put("ok", ok)
            put("text", text.take(500))
            put("code", codeFor(app, slot, carrier))
            put("checked_at", System.currentTimeMillis())
            parseValidTill(text)?.let { put("valid_till", it) }
            parseBalance(text)?.let { put("balance", it) }
        }.toString()

        val url = CallIqConfig.endpoint(app).replace("log_call.php", "sim_status.php")
        Thread { CallPresence.post(url, body) }.start()
        CallIqConfig.prefs(app).edit()
            .putString("USSD_LAST_$slot", text)
            .putLong("USSD_LAST_AT_$slot", System.currentTimeMillis())
            .apply()
    }

    fun lastReply(context: Context, slot: Int): String =
        CallIqConfig.prefs(context).getString("USSD_LAST_$slot", "") ?: ""

    fun lastCheckedAt(context: Context, slot: Int): Long =
        CallIqConfig.prefs(context).getLong("USSD_LAST_AT_$slot", 0L)

    /** Every SIM in the phone, one after another — what the daily check runs. */
    fun checkAll(context: Context) {
        val app = context.applicationContext
        val subs = SimResolver.activeSubscriptions(app)
        subs.forEachIndexed { i, info ->
            val slot = info.simSlotIndex + 1
            // Staggered: two USSD requests at once confuse the radio.
            Handler(Looper.getMainLooper()).postDelayed({ check(app, slot, null) }, i * 20_000L)
        }
    }

    /** Is a check even worth offering on this phone? */
    fun isSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O

    /** Calendar helper for the worker's daily slot. */
    fun millisUntilNextRun(hourOfDay: Int = 10): Long {
        val now = Calendar.getInstance()
        val next = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, hourOfDay); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0)
            if (before(now)) add(Calendar.DAY_OF_YEAR, 1)
        }
        return next.timeInMillis - now.timeInMillis
    }
}
