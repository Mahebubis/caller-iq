package com.example.calliq

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.telecom.PhoneAccount
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
    const val KEY_LAST_SOURCE = "SIM_LAST_SOURCE"
    const val KEY_LAST_UNRESOLVED = "SIM_LAST_UNRESOLVED"

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
                val state = callStateOf(context, info.subscriptionId) ?: return   // cannot tell: never guess
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

    /**
     * The call state of ONE subscription — or null when this Android cannot say.
     *
     * Before Android 12 there is no public per-SIM call state: `callState` on a per-SIM
     * TelephonyManager quietly reports the whole PHONE's state, so every SIM looks busy and the
     * capture always picked whichever SIM was listed first — confidently wrong. Those versions do
     * have a per-subscription getCallState(int) inside TelephonyManager (present since Android 7);
     * it is used when it answers, and otherwise the capture is skipped rather than guessed.
     */
    @SuppressLint("MissingPermission")
    private fun callStateOf(context: Context, subId: Int): Int? {
        val tm = context.getSystemService(TelephonyManager::class.java) ?: return null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return try { tm.createForSubscriptionId(subId).callStateForSubscription } catch (e: Throwable) { null }
        }
        return try {
            TelephonyManager::class.java.getMethod("getCallState", Int::class.javaPrimitiveType).invoke(tm, subId) as? Int
        } catch (e: Throwable) {
            null
        }
    }

    /* ── Learned map ──────────────────────────────────────────────────────── */

    private fun learned(context: Context): JSONObject = try {
        JSONObject(context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE).getString(KEY_LEARNED, "{}") ?: "{}")
    } catch (e: Throwable) { JSONObject() }

    /**
     * Forget every learned mapping and live capture. Before Android 12 the old capture read the whole
     * phone's call state as each SIM's, so what earlier builds learned from it may name the wrong
     * SIM; wiped once, it is relearned from the exact methods above.
     */
    fun forgetLearned(context: Context) {
        try {
            context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_LEARNED).remove(KEY_LIVE_SLOT).remove(KEY_LIVE_SUB).remove(KEY_LIVE_AT).apply()
        } catch (e: Throwable) { }
    }

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
    fun resolve(
        context: Context,
        accountId: String?,
        componentName: String? = null,
        callTimeMs: Long = 0L,
        /** The maker's own SIM columns from the same call-log row, if it has any. */
        oemIds: List<String?> = emptyList(),
    ): Sim {
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

        /*
         * 2b — Android 10 and older (and any phone where the above found nothing).
         *
         * On these versions PHONE_ACCOUNT_ID is the SIM card's ICCID, and ordinary apps may no
         * longer read ICCIDs to compare it with — which is why a Redmi on Android 10 showed every
         * call as "Unknown SIM". But the phone's own Telephony service can still do the match:
         *   exact    its getSubIdForPhoneAccount() — hidden, but present and callable since
         *            Android 6 — matches the account against the SIM card itself;
         *   label    failing that, the phone account carries the SIM's display name, colour and
         *            (sometimes) number, which are compared with each SIM's own. Used only when
         *            exactly ONE SIM matches — two SIMs both called "Jio" prove nothing.
         */
        if (raw.isNotEmpty()) {
            for (handle in handlesFor(context, raw, componentName)) {
                val subId = subIdViaTelephony(context, handle)
                subs.firstOrNull { it.subscriptionId == subId }?.let {
                    return finish(context, slotOf(it), carrierOf(it), "exact", it.subscriptionId, raw)
                }
            }
            for (handle in handlesFor(context, raw, componentName)) {
                subViaAccountDetails(context, handle, subs)?.let {
                    return finish(context, slotOf(it), carrierOf(it), "label", it.subscriptionId, raw)
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

        /*
         * 6b — the maker's own SIM column. Xiaomi, MediaTek and others add one to the call log
         * ("simid", "sub_id", "subscription_id") holding the subscription id. It was ignored
         * whenever PHONE_ACCOUNT_ID was filled in. Some makers store the SLOT there instead, so a
         * value that could be read either way — and would mean different SIMs — is not trusted.
         */
        for (v in oemIds.mapNotNull { it?.trim()?.takeIf { s -> s.isNotEmpty() && s != raw } }.distinct()) {
            val n = v.toIntOrNull() ?: continue
            val bySub = subs.firstOrNull { it.subscriptionId == n } ?: continue
            val bySlot = subs.firstOrNull { it.simSlotIndex == n } ?: subs.firstOrNull { slotOf(it) == n }
            if (bySlot != null && bySlot.subscriptionId != bySub.subscriptionId) continue   // ambiguous
            return finish(context, slotOf(bySub), carrierOf(bySub), "oem", bySub.subscriptionId, raw)
        }

        // 7 — the account id is a slot number. Both 0-based and 1-based OEMs exist, so trust it
        //     only when it lines up with a slot the phone actually has.
        raw.toIntOrNull()?.let { n ->
            subs.firstOrNull { it.simSlotIndex == n }?.let { return finish(context, slotOf(it), carrierOf(it), "slot", it.subscriptionId, raw) }
            subs.firstOrNull { slotOf(it) == n }?.let { return finish(context, slotOf(it), carrierOf(it), "slot", it.subscriptionId, raw) }
        }

        Log.w(TAG, "Could not resolve SIM for phone account '$raw' (${subs.size} active SIMs)")
        // Kept for the panel: what this phone's call log holds when no method can place it.
        if (raw.isNotEmpty()) {
            try {
                context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_LAST_UNRESOLVED, JSONObject()
                        .put("account", raw.take(40)).put("component", (componentName ?: "").take(120))
                        .put("oem", oemIds.joinToString(",") { it ?: "" }).put("sims", subs.size).toString())
                    .apply()
            } catch (e: Throwable) { }
        }
        return finish(context, null, "", "unknown", null, raw, learnIt = false)
    }

    /* ── Phone accounts (used by 2b) ──────────────────────────────────────── */

    /** Every phone account this call-log id can refer to: rebuilt from the row, and as telecom lists it. */
    @SuppressLint("MissingPermission")
    private fun handlesFor(context: Context, raw: String, componentName: String?): List<PhoneAccountHandle> {
        val out = mutableListOf<PhoneAccountHandle>()
        try {
            val telecom = context.getSystemService(TelecomManager::class.java)
            telecom?.callCapablePhoneAccounts?.forEach { if (it.id == raw) out += it }
        } catch (e: Throwable) { }
        if (out.isEmpty() && !componentName.isNullOrBlank()) {
            try { ComponentName.unflattenFromString(componentName)?.let { out += PhoneAccountHandle(it, raw) } } catch (e: Throwable) { }
        }
        return out
    }

    /** Telephony's own account → subscription match; null where the phone will not say. */
    private fun subIdViaTelephony(context: Context, handle: PhoneAccountHandle): Int? {
        return try {
            val tm = context.getSystemService(TelephonyManager::class.java) ?: return null
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                return tm.getSubscriptionId(handle).takeIf { it != SubscriptionManager.INVALID_SUBSCRIPTION_ID }
            }
            val account = context.getSystemService(TelecomManager::class.java)?.getPhoneAccount(handle) ?: return null
            val m = TelephonyManager::class.java.getMethod("getSubIdForPhoneAccount", PhoneAccount::class.java)
            (m.invoke(tm, account) as? Int)?.takeIf { it != SubscriptionManager.INVALID_SUBSCRIPTION_ID }
        } catch (e: Throwable) {
            Log.w(TAG, "getSubIdForPhoneAccount unavailable: ${e.javaClass.simpleName}")
            null
        }
    }

    /** The SIM whose name, colour or number matches this account's — only when exactly one does. */
    @SuppressLint("MissingPermission")
    private fun subViaAccountDetails(context: Context, handle: PhoneAccountHandle, subs: List<SubscriptionInfo>): SubscriptionInfo? {
        val account = (try { context.getSystemService(TelecomManager::class.java)?.getPhoneAccount(handle) } catch (e: Throwable) { null })
            ?: return null
        fun norm(s: CharSequence?) = s?.toString()?.trim()?.lowercase() ?: ""

        val label = norm(account.label)
        if (label.isNotEmpty()) {
            val m = subs.filter { norm(it.displayName) == label }
            if (m.size == 1) return m[0]
        }
        val tint = try { account.highlightColor } catch (e: Throwable) { 0 }
        if (tint != 0 && tint != PhoneAccount.NO_HIGHLIGHT_COLOR) {
            val m = subs.filter { try { it.iconTint == tint } catch (e: Throwable) { false } }
            if (m.size == 1) return m[0]
        }
        val digits = { s: String -> s.filter { it.isDigit() }.takeLast(10) }
        val addr = try { digits(account.address?.schemeSpecificPart ?: "") } catch (e: Throwable) { "" }
        if (addr.length >= 8) {
            val m = subs.filter { digits(numberOf(it)) == addr }
            if (m.size == 1) return m[0]
        }
        return null
    }

    private fun finish(context: Context, slot: Int?, carrier: String, source: String, subId: Int?, accountId: String, learnIt: Boolean = true): Sim {
        // How the last call-log row was placed — only for real rows, never the empty lookups live events make.
        if (accountId.isNotEmpty()) {
            try { context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE).edit().putString(KEY_LAST_SOURCE, source).apply() } catch (e: Throwable) { }
        }
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
