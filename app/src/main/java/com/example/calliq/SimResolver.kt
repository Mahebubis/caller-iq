package com.example.calliq

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log
import org.json.JSONObject

/**
 * Which SIM a call used.
 *
 * The call log does not store a slot. It stores PHONE_ACCOUNT_ID, whose meaning is up to the OEM:
 * on stock Android it is the subscription id ("2"), on many Samsung / Xiaomi / OnePlus builds it is
 * the ICCID ("8991000...") and on a few it is the slot itself ("0"). From Android 11 the ICCID is
 * redacted for ordinary apps, so comparing it against SubscriptionInfo.getIccId() — what the
 * previous build did — can never match on Android 12, and every call fell through to "SIM 1".
 *
 * Resolution, best evidence first. Each answer records HOW it was found, so a wrong label can be
 * diagnosed from the dashboard instead of guessed at:
 *
 *   telecom     PHONE_ACCOUNT_COMPONENT_NAME + PHONE_ACCOUNT_ID rebuild the PhoneAccountHandle and
 *               TelephonyManager.getSubscriptionId(handle) names the subscription. Exact, API 30+.
 *   account     the same, but the handle is found by scanning the phone accounts telecom knows.
 *   subid       PHONE_ACCOUNT_ID is the subscription id.
 *   iccid       PHONE_ACCOUNT_ID starts with an ICCID we can still read (pre-Android 11).
 *   live        the slot that was actually busy when the call happened, captured by CallReceiver.
 *   learned     a PHONE_ACCOUNT_ID this phone has resolved before (remembered in prefs).
 *   slot        PHONE_ACCOUNT_ID is "0" / "1" / "2" and there is more than one SIM.
 *   single      the phone has exactly one active SIM, so every call used it.
 *   unknown     nothing matched — reported as unknown rather than silently called SIM 1.
 */
object SimResolver {

    private const val TAG = "SimResolver"
    private const val KEY_LEARNED = "SIM_ACCOUNT_MAP"   // { phoneAccountId: slot }
    private const val KEY_LIVE_SLOT = "SIM_LIVE_SLOT"
    private const val KEY_LIVE_SUB = "SIM_LIVE_SUB"
    private const val KEY_LIVE_AT = "SIM_LIVE_AT"

    /** A call is matched to a live capture only if the capture is this close to it. */
    private const val LIVE_WINDOW_MS = 5 * 60 * 1000L

    data class Sim(
        val slot: Int?,          // 1 or 2 (physical slot + 1), null when unknown
        val carrier: String,
        val label: String,       // the counselor's nickname for that slot
        val source: String,
        val subId: Int?,
        /** The SIM's OWN number, when the network wrote it to the card. Often blank — many Indian
         *  SIMs carry no MSISDN — so the panel lets it be filled in by hand. */
        val msisdn: String = "",
    ) {
        val display: String get() = if (slot == null) "Unknown SIM" else label.ifEmpty { "SIM $slot" }
    }

    /* ── Active subscriptions ─────────────────────────────────────────────── */

    @SuppressLint("MissingPermission")
    fun activeSubscriptions(context: Context): List<SubscriptionInfo> = try {
        context.getSystemService(SubscriptionManager::class.java)?.activeSubscriptionInfoList ?: emptyList()
    } catch (e: Throwable) {
        Log.w(TAG, "activeSubscriptionInfoList unavailable: ${e.message}")
        emptyList()
    }

    private fun slotOf(info: SubscriptionInfo) = info.simSlotIndex + 1
    private fun carrierOf(info: SubscriptionInfo) = try { info.carrierName?.toString() ?: "" } catch (e: Throwable) { "" }
    @SuppressLint("MissingPermission")
    private fun numberOf(info: SubscriptionInfo) = try { info.number ?: "" } catch (e: Throwable) { "" }

    /** The SIM in a given slot, for the details the panel keeps per SIM. */
    fun infoForSlot(context: Context, slot: Int?): SubscriptionInfo? =
        if (slot == null) null else activeSubscriptions(context).firstOrNull { slotOf(it) == slot }

    /* ── Live capture: which SIM is busy right now ────────────────────────── */

    /**
     * Called while a call is ringing or connected. Android 12 can report call state per
     * subscription, so the busy subscription is the SIM in use — the only fully reliable answer,
     * and it also teaches us what this phone's PHONE_ACCOUNT_ID means.
     */
    @SuppressLint("MissingPermission")
    fun captureActiveSim(context: Context) {
        try {
            val subs = activeSubscriptions(context)
            if (subs.size < 2) return   // single SIM: nothing to disambiguate
            for (info in subs) {
                val tm = context.getSystemService(TelephonyManager::class.java)
                    ?.createForSubscriptionId(info.subscriptionId) ?: continue
                val state = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    tm.callStateForSubscription
                } else {
                    @Suppress("DEPRECATION") tm.callState
                }
                if (state != TelephonyManager.CALL_STATE_IDLE) {
                    context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE).edit()
                        .putInt(KEY_LIVE_SLOT, slotOf(info))
                        .putInt(KEY_LIVE_SUB, info.subscriptionId)
                        .putLong(KEY_LIVE_AT, System.currentTimeMillis())
                        .apply()
                    Log.d(TAG, "Live capture: slot ${slotOf(info)} (sub ${info.subscriptionId}) is busy")
                    return
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "captureActiveSim failed: ${e.message}")
        }
    }

    /* ── Learned map ──────────────────────────────────────────────────────── */

    private fun learned(context: Context): JSONObject = try {
        JSONObject(context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE).getString(KEY_LEARNED, "{}") ?: "{}")
    } catch (e: Throwable) { JSONObject() }

    private fun learn(context: Context, accountId: String, slot: Int) {
        if (accountId.isBlank()) return
        try {
            val map = learned(context)
            if (map.optInt(accountId, -1) == slot) return
            map.put(accountId, slot)
            context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_LEARNED, map.toString()).apply()
            Log.d(TAG, "Learned phone account $accountId → SIM $slot")
        } catch (e: Throwable) { }
    }

    /* ── Resolution ───────────────────────────────────────────────────────── */

    /**
     * @param accountId     CallLog.Calls.PHONE_ACCOUNT_ID (or the best OEM column available)
     * @param componentName CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME, when the row has one
     * @param callTimeMs    when the call happened, used to match a live capture
     */
    @SuppressLint("MissingPermission")
    fun resolve(context: Context, accountId: String?, componentName: String? = null, callTimeMs: Long = 0L): Sim {
        val raw = (accountId ?: "").trim()
        val subs = activeSubscriptions(context)

        // Exactly one SIM in the phone: no ambiguity to resolve.
        if (subs.size == 1) return finish(context, subs[0].let { slotOf(it) }, carrierOf(subs[0]), "single", subs[0].subscriptionId, raw, learnIt = false)

        // 1 + 2 — telecom's own mapping of phone account → subscription.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && raw.isNotEmpty()) {
            val tm = try { context.getSystemService(TelephonyManager::class.java) } catch (e: Throwable) { null }
            val handles = mutableListOf<Pair<PhoneAccountHandle, String>>()
            if (!componentName.isNullOrBlank()) {
                ComponentName.unflattenFromString(componentName)?.let { handles += PhoneAccountHandle(it, raw) to "telecom" }
            }
            try {
                val telecom = context.getSystemService(TelecomManager::class.java)
                telecom?.callCapablePhoneAccounts?.forEach { h -> if (h.id == raw) handles += h to "account" }
            } catch (e: Throwable) {
                Log.w(TAG, "callCapablePhoneAccounts unavailable: ${e.message}")
            }
            for ((handle, source) in handles) {
                try {
                    val subId = tm?.getSubscriptionId(handle) ?: SubscriptionManager.INVALID_SUBSCRIPTION_ID
                    val info = subs.firstOrNull { it.subscriptionId == subId }
                    if (info != null) return finish(context, slotOf(info), carrierOf(info), source, subId, raw)
                } catch (e: Throwable) {
                    Log.w(TAG, "getSubscriptionId failed: ${e.message}")
                }
            }
        }

        // 3 — the account id IS the subscription id (stock Android).
        subs.firstOrNull { it.subscriptionId.toString() == raw }?.let {
            return finish(context, slotOf(it), carrierOf(it), "subid", it.subscriptionId, raw)
        }

        // 4 — the account id carries an ICCID we can still read (pre-Android 11).
        for (info in subs) {
            val icc = try { info.iccId ?: "" } catch (e: Throwable) { "" }
            if (icc.length >= 6 && raw.length >= 6 && (raw.startsWith(icc) || icc.startsWith(raw))) {
                return finish(context, slotOf(info), carrierOf(info), "iccid", info.subscriptionId, raw)
            }
        }

        // 5 — the SIM that was actually busy around the time of this call.
        val prefs = context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE)
        val liveAt = prefs.getLong(KEY_LIVE_AT, 0L)
        val liveSlot = prefs.getInt(KEY_LIVE_SLOT, 0)
        if (liveSlot > 0 && liveAt > 0 && (callTimeMs == 0L || Math.abs(callTimeMs - liveAt) <= LIVE_WINDOW_MS)) {
            val subId = prefs.getInt(KEY_LIVE_SUB, -1)
            val carrier = subs.firstOrNull { it.subscriptionId == subId }?.let { carrierOf(it) } ?: ""
            return finish(context, liveSlot, carrier, "live", if (subId > 0) subId else null, raw)
        }

        // 6 — an account id this phone has resolved before.
        val remembered = learned(context).optInt(raw, -1)
        if (remembered > 0) {
            val carrier = subs.firstOrNull { slotOf(it) == remembered }?.let { carrierOf(it) } ?: ""
            return finish(context, remembered, carrier, "learned", null, raw, learnIt = false)
        }

        // 7 — the account id is a slot number. Both 0-based and 1-based OEMs exist, so trust it
        //     only when it lines up with a slot the phone actually has.
        raw.toIntOrNull()?.let { n ->
            subs.firstOrNull { it.simSlotIndex == n }?.let { return finish(context, slotOf(it), carrierOf(it), "slot", it.subscriptionId, raw) }
            subs.firstOrNull { slotOf(it) == n }?.let { return finish(context, slotOf(it), carrierOf(it), "slot", it.subscriptionId, raw) }
        }

        Log.w(TAG, "Could not resolve SIM for phone account '$raw' (${subs.size} active SIMs)")
        return finish(context, null, "", "unknown", null, raw, learnIt = false)
    }

    private fun finish(context: Context, slot: Int?, carrier: String, source: String, subId: Int?, accountId: String, learnIt: Boolean = true): Sim {
        if (learnIt && slot != null && accountId.isNotEmpty()) learn(context, accountId, slot)
        var label = ""
        if (slot != null) {
            try {
                val json = context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE).getString("SIM_NICKNAMES", "{}") ?: "{}"
                label = JSONObject(json).optString("SIM $slot", "")
            } catch (e: Throwable) { }
        }
        val msisdn = infoForSlot(context, slot)?.let { numberOf(it) } ?: ""
        return Sim(slot, carrier, label, source, subId, msisdn)
    }

    /** What the in-app diagnostics screen shows: every SIM the phone reports, as we see it. */
    @SuppressLint("MissingPermission")
    fun diagnostics(context: Context): JSONObject {
        val out = JSONObject()
        val sims = org.json.JSONArray()
        for (info in activeSubscriptions(context)) {
            sims.put(JSONObject().apply {
                put("slot", slotOf(info))
                put("subscriptionId", info.subscriptionId)
                put("carrier", carrierOf(info))
                put("displayName", try { info.displayName?.toString() ?: "" } catch (e: Throwable) { "" })
                put("number", try { info.number ?: "" } catch (e: Throwable) { "" })
            })
        }
        out.put("sims", sims)
        val prefs = context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE)
        out.put("learned", learned(context))
        out.put("liveSlot", prefs.getInt(KEY_LIVE_SLOT, 0))
        out.put("liveAt", prefs.getLong(KEY_LIVE_AT, 0L))
        return out
    }
}
