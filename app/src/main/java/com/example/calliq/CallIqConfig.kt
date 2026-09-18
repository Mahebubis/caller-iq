package com.example.calliq

import android.content.Context
import android.os.Build
import android.provider.Settings

/**
 * Where calls are sent, who is sending them, and how the post-call popup behaves.
 *
 * The admin panel (Caller IQ page) groups calls per phone using device_id, so every payload
 * carries the handset's ANDROID_ID, model and app version, plus the SIM slot, carrier and the
 * nickname the counselor gave that slot. SIM detection itself lives in [SimResolver].
 */
object CallIqConfig {
    const val PREFS = "call_tracker_prefs"
    const val DEFAULT_ENDPOINT = "https://cit3.internshipstudio.com/admin/react-api/api/caller-iq/log_call.php"

    /** The first build's default. Installs still holding it are moved to the live endpoint. */
    private const val LEGACY_ENDPOINT = "https://adp.internshipstudio.com/api/log_call.php"

    /* Post-call popup */
    const val KEY_POPUP_ENABLED = "POPUP_ENABLED"
    const val KEY_POPUP_MISSED = "POPUP_FOR_MISSED"
    const val KEY_POPUP_TIMEOUT = "POPUP_TIMEOUT_SEC"
    const val KEY_LAST_POPUP_KEY = "LAST_POPUP_KEY"

    /** The one-tap outcomes offered on the popup — the same seven the app's own dialog shows. */
    val DISPOSITIONS: List<Pair<String, String>> = listOf(
        "Interested" to "#059669",
        "Enrolled" to "#7C3AED",
        "Callback Scheduled" to "#D97706",
        "Resolved" to "#0891B2",
        "Not Answering" to "#DC2626",
        "Course Query" to "#4F46E5",
        "Escalated to Tech" to "#DB2777",
    )

    fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun endpoint(context: Context): String {
        val stored = prefs(context).getString("SYNC_ENDPOINT", null)
        return if (stored.isNullOrBlank() || stored == LEGACY_ENDPOINT) DEFAULT_ENDPOINT else stored
    }

    fun deviceId(context: Context): String =
        try { Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "" } catch (e: Throwable) { "" }

    fun deviceModel(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    fun appVersion(context: Context): String =
        try { context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "" } catch (e: Throwable) { "" }

    /* What happened the last time a call ended — the app's own answer to "why did no popup show?" */
    private const val KEY_POPUP_NOTE = "POPUP_LAST_NOTE"
    private const val KEY_POPUP_NOTE_AT = "POPUP_LAST_NOTE_AT"

    fun notePopup(context: Context, note: String) {
        try {
            prefs(context).edit()
                .putString(KEY_POPUP_NOTE, note)
                .putLong(KEY_POPUP_NOTE_AT, System.currentTimeMillis())
                .apply()
        } catch (e: Throwable) { }
    }

    fun popupNote(context: Context): String = prefs(context).getString(KEY_POPUP_NOTE, "") ?: ""
    fun popupNoteAt(context: Context): Long = prefs(context).getLong(KEY_POPUP_NOTE_AT, 0L)

    /* Automatic SIM balance checks (USSD). Off until switched on: it runs a carrier code on the
       line, which is the counselor's phone, so it is asked for rather than assumed. */
    const val KEY_USSD_ENABLED = "USSD_ENABLED"
    fun ussdEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_USSD_ENABLED, false)

    fun popupEnabled(context: Context): Boolean = prefs(context).getBoolean(KEY_POPUP_ENABLED, true)
    fun popupForMissed(context: Context): Boolean = prefs(context).getBoolean(KEY_POPUP_MISSED, true)
    fun popupTimeoutSec(context: Context): Int = prefs(context).getInt(KEY_POPUP_TIMEOUT, 45).coerceIn(10, 300)

    /** Kept so older callers still compile; SIM logic lives in [SimResolver]. */
    fun resolveSim(context: Context, rawSimId: String): SimResolver.Sim = SimResolver.resolve(context, rawSimId)
}
