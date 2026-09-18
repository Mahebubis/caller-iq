package com.example.calliq

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.telephony.SubscriptionManager
import org.json.JSONObject

/**
 * Where calls are sent, and who is sending them.
 *
 * The admin panel (Caller IQ page) groups calls per phone using device_id, so every
 * payload carries the handset's ANDROID_ID, model and app version, plus the SIM slot,
 * carrier and the nickname the counselor gave that slot.
 */
object CallIqConfig {
    const val PREFS = "call_tracker_prefs"
    const val DEFAULT_ENDPOINT = "https://cit3.internshipstudio.com/admin/react-api/api/caller-iq/log_call.php"

    /** The first build's default. Installs still holding it are moved to the live endpoint. */
    private const val LEGACY_ENDPOINT = "https://adp.internshipstudio.com/api/log_call.php"

    fun endpoint(context: Context): String {
        val stored = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("SYNC_ENDPOINT", null)
        return if (stored.isNullOrBlank() || stored == LEGACY_ENDPOINT) DEFAULT_ENDPOINT else stored
    }

    fun deviceId(context: Context): String =
        try { Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "" } catch (e: Throwable) { "" }

    fun deviceModel(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    fun appVersion(context: Context): String =
        try { context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "" } catch (e: Throwable) { "" }

    data class SimInfo(val slot: Int?, val carrier: String, val label: String)

    /**
     * The call log's SIM column is a phone-account id: usually the subscription id, sometimes
     * the ICCID, and "0"/"1" on a few OEMs. Map it back to a physical slot (1 or 2).
     */
    @SuppressLint("MissingPermission")
    fun resolveSim(context: Context, rawSimId: String): SimInfo {
        var slot: Int? = null
        var carrier = ""
        
        try {
            val sm = context.getSystemService(SubscriptionManager::class.java)
            val subs = sm?.activeSubscriptionInfoList ?: emptyList()
            
            // Pass 1: Try strict matching on ICCID (PHONE_ACCOUNT_ID usually holds this on OnePlus/Oppo/Samsung)
            for (info in subs) {
                val iccId = info.iccId ?: ""
                if (iccId.isNotEmpty() && rawSimId.length > 5 && (rawSimId.contains(iccId) || iccId.contains(rawSimId))) {
                    slot = info.simSlotIndex + 1
                    carrier = info.carrierName?.toString() ?: ""
                    break
                }
            }
            
            // Pass 2: Try strict matching on Subscription ID (Standard Android Behavior)
            if (slot == null) {
                for (info in subs) {
                    if (info.subscriptionId.toString() == rawSimId) {
                        slot = info.simSlotIndex + 1
                        carrier = info.carrierName?.toString() ?: ""
                        break
                    }
                }
            }
            
            // Pass 3: Try matching on OEM simSlot values (e.g. 0/1 or 1/2)
            if (slot == null) {
                val parsedRaw = rawSimId.toIntOrNull()
                if (parsedRaw != null) {
                    for (info in subs) {
                        // Some OEMs use 0-indexed (0=SIM1), some use 1-indexed (1=SIM1)
                        if (parsedRaw == info.simSlotIndex || parsedRaw == (info.simSlotIndex + 1)) {
                            slot = info.simSlotIndex + 1
                            carrier = info.carrierName?.toString() ?: ""
                            break
                        }
                    }
                }
            }
        } catch (e: Throwable) {
            // READ_PHONE_STATE or READ_PHONE_NUMBERS missing or OEM restriction.
        }

        // Pass 4: Blind Fallback if SubscriptionManager completely failed or was blocked by OS
        if (slot == null) {
            val parsedRaw = rawSimId.toIntOrNull()
            if (parsedRaw == 0) slot = 1
            else if (parsedRaw == 1) slot = 2 // Most AOSP consider 1 as SIM 2
            else if (parsedRaw == 2) slot = 2 // OnePlus considers 2 as SIM 2
            else slot = 1 // Ultimate fallback
        }

        var label = ""
        try {
            val json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("SIM_NICKNAMES", "{}") ?: "{}"
            label = JSONObject(json).optString("SIM $slot", "")
        } catch (e: Throwable) { }
        
        return SimInfo(slot, carrier, label)
    }
}