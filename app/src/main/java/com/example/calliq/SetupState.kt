package com.example.calliq

import android.Manifest
import android.app.ActivityManager
import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Every switch this app needs, on THIS phone, and whether each one is on.
 *
 * The list changes with the Android version and with the maker: a Redmi on Android 10 needs
 * MIUI's own pop-up and autostart switches, a OnePlus on Android 16 needs full-screen alerts,
 * a Samsung needs neither. So the steps are built for the phone in hand rather than shown as one
 * fixed list with half of it irrelevant.
 *
 * Each step is READ BACK from the system wherever Android allows it — so the app can skip what is
 * already done and move on by itself. Where a maker gives no way to read a switch (autostart on
 * Oppo/OnePlus/Vivo, for instance), the step says so honestly: it is "unknown" until the counselor
 * confirms it, and never shown as done on a guess.
 *
 * The same list is what the phone reports to the admin panel, so the dashboard can say exactly
 * which switch is off on which phone instead of a vague "popup off".
 */
object SetupState {

    const val DONE = "done"            // verified on the phone
    const val TODO = "todo"            // verified off
    const val CONFIRMED = "confirmed"  // cannot be read back; the counselor says it is on
    const val UNKNOWN = "unknown"      // cannot be read back, and nobody has confirmed it

    data class Step(
        val key: String,
        val title: String,
        val why: String,
        /** What to tap once the screen opens — shown in the app while the step is running. */
        val how: String,
        val status: String,
        val required: Boolean,
        /** "dialog": answered over the app · "screen": a settings page we can read back · "manual": one we cannot. */
        val kind: String,
    ) {
        val ok: Boolean get() = status == DONE || status == CONFIRMED
    }

    enum class Oem { XIAOMI, OPPO, VIVO, HUAWEI, SAMSUNG, OTHER }

    fun oem(): Oem {
        val m = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return when {
            m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") -> Oem.XIAOMI
            m.contains("oppo") || m.contains("realme") || m.contains("oneplus") -> Oem.OPPO
            m.contains("vivo") || m.contains("iqoo") -> Oem.VIVO
            m.contains("huawei") || m.contains("honor") -> Oem.HUAWEI
            m.contains("samsung") -> Oem.SAMSUNG
            else -> Oem.OTHER
        }
    }

    /* ── Reading each switch ─────────────────────────────────────────────── */

    private fun granted(ctx: Context, p: String) =
        ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    fun phoneGranted(ctx: Context): Boolean =
        granted(ctx, Manifest.permission.READ_CALL_LOG) && granted(ctx, Manifest.permission.READ_PHONE_STATE)

    /** What the single runtime request asks for — only the ones still missing, and only those this Android has. */
    fun runtimeWanted(ctx: Context): List<String> {
        val all = mutableListOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) all += Manifest.permission.READ_PHONE_NUMBERS
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) all += Manifest.permission.POST_NOTIFICATIONS
        return all.filter { !granted(ctx, it) }
    }

    /** The two the app cannot work without; the rest of [runtimeWanted] is helpful but optional. */
    val CORE = setOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE)

    fun overlayOn(ctx: Context): Boolean = CallPopupOverlay.canShow(ctx)

    fun notificationsOn(ctx: Context): Boolean =
        try { NotificationManagerCompat.from(ctx).areNotificationsEnabled() } catch (e: Throwable) { true }

    fun batteryOn(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        return try {
            (ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isIgnoringBatteryOptimizations(ctx.packageName) ?: true
        } catch (e: Throwable) { true }
    }

    /** Android 9+: "Battery usage → Restricted" — stops the app completely, regardless of the rest. */
    fun backgroundRestricted(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        return try {
            (ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)?.isBackgroundRestricted ?: false
        } catch (e: Throwable) { false }
    }

    /** Android 14+ took full-screen alerts away from apps that are not a phone or alarm by default. */
    fun fullScreenOn(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 34) return true
        return try {
            (ctx.getSystemService(NotificationManager::class.java))?.canUseFullScreenIntent() ?: true
        } catch (e: Throwable) { true }
    }

    /*
     * MIUI keeps its own permissions as AppOps codes above the stock range. They are read through
     * the same call Android uses internally; on any phone that is not MIUI, or a MIUI build that
     * refuses, this answers null — "cannot tell" — and the step falls back to asking the counselor.
     */
    private const val MIUI_OP_AUTOSTART = 10008
    private const val MIUI_OP_SHOW_WHEN_LOCKED = 10020
    private const val MIUI_OP_BACKGROUND_START = 10021

    private fun miuiOp(ctx: Context, op: Int): Boolean? {
        if (oem() != Oem.XIAOMI) return null
        return try {
            val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            val m = AppOpsManager::class.java.getMethod(
                "checkOpNoThrow", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, String::class.java
            )
            (m.invoke(ops, op, Process.myUid(), ctx.packageName) as Int) == AppOpsManager.MODE_ALLOWED
        } catch (e: Throwable) { null }
    }

    fun miuiBackgroundPopup(ctx: Context): Boolean? {
        val bg = miuiOp(ctx, MIUI_OP_BACKGROUND_START) ?: return null
        // "Show on lock screen" lives on the same MIUI page; if it cannot be read, do not let it block.
        val lock = miuiOp(ctx, MIUI_OP_SHOW_WHEN_LOCKED) ?: true
        return bg && lock
    }

    fun miuiAutostart(ctx: Context): Boolean? = miuiOp(ctx, MIUI_OP_AUTOSTART)

    /* ── What the counselor has confirmed ────────────────────────────────── */

    private fun confirmKey(key: String) = "SETUP_CONFIRMED_$key"

    fun confirm(ctx: Context, key: String, on: Boolean) {
        CallIqConfig.prefs(ctx).edit().putBoolean(confirmKey(key), on).apply()
    }

    private fun confirmed(ctx: Context, key: String) = CallIqConfig.prefs(ctx).getBoolean(confirmKey(key), false)

    /** A reading beats a confirmation: if the phone says it is off, it is off. */
    private fun status(ctx: Context, key: String, reading: Boolean?): String = when (reading) {
        true -> DONE
        false -> TODO
        null -> if (confirmed(ctx, key)) CONFIRMED else UNKNOWN
    }

    /* ── The list for this phone ─────────────────────────────────────────── */

    fun steps(ctx: Context): List<Step> {
        val oem = oem()
        val out = mutableListOf<Step>()

        out += Step(
            "phone", "Call logs & phone",
            "So the app can see a call ended, who it was with, and which SIM it used.",
            "Tap Allow on each question. If Android says “Restricted setting”, open App info → ⋮ (top right) → Allow restricted settings, then try again.",
            if (phoneGranted(ctx)) DONE else TODO, true, "dialog",
        )

        // First of the settings screens on purpose: once it is on, Android lets the app bring
        // itself back from every screen after it, so the counselor never has to press Back.
        out += Step(
            "overlay", "Display over other apps",
            "Android draws nothing over the dialer without this — it is what makes the popup appear after a call.",
            "Switch on “Allow display over other apps” for CallIQ. If it is greyed out as a “Restricted setting”, open App info → ⋮ → Allow restricted settings first.",
            if (overlayOn(ctx)) DONE else TODO, true, "screen",
        )

        if (oem == Oem.XIAOMI) {
            val r = miuiBackgroundPopup(ctx)
            out += Step(
                "oem_popup", "Pop-ups while in background",
                "Xiaomi blocks the popup on its own, even with the switch above on.",
                "Allow “Display pop-up windows while running in the background” and “Show on Lock screen”.",
                status(ctx, "oem_popup", r), true, if (r == null) "manual" else "screen",
            )
        }

        if (oem == Oem.XIAOMI || oem == Oem.OPPO || oem == Oem.VIVO || oem == Oem.HUAWEI) {
            val r = if (oem == Oem.XIAOMI) miuiAutostart(ctx) else null
            out += Step(
                "autostart", "Autostart",
                "Without it this phone stops CallIQ once it is swiped away — calls are then never noticed at all.",
                when (oem) {
                    Oem.XIAOMI -> "Switch on Autostart for CallIQ."
                    Oem.OPPO -> "Allow Auto launch (or Auto-start) for CallIQ. If you land on App info, open Battery usage and switch on “Allow auto launch” and “Allow background activity”."
                    Oem.VIVO -> "Switch on Auto-start for CallIQ, and allow High background power consumption."
                    else -> "Set CallIQ to Manage manually, with Auto-launch and Run in background on."
                },
                status(ctx, "autostart", r), true, if (r == null) "manual" else "screen",
            )
        }

        out += Step(
            "battery", "Unrestricted battery",
            "Stops Android pausing the app between calls, so every call is noticed and uploaded.",
            "Tap Allow.",
            if (batteryOn(ctx)) DONE else TODO, true, "dialog",
        )

        // Only listed when it is actually set: "Restricted" overrides everything above.
        if (backgroundRestricted(ctx)) {
            out += Step(
                "background", "Background activity",
                "CallIQ's battery usage is set to Restricted, which stops it completely.",
                "Open Battery (or App battery usage) and choose Unrestricted.",
                TODO, true, "screen",
            )
        }

        out += Step(
            "notifications", "Notifications",
            "The fallback prompt, for the rare call where the popup itself cannot be drawn.",
            "Switch on notifications for CallIQ.",
            if (notificationsOn(ctx)) DONE else TODO, false, "screen",
        )

        if (Build.VERSION.SDK_INT >= 34) {
            out += Step(
                "fullscreen", "Full-screen alerts",
                "Lets the popup open over the lock screen, the way an incoming call does.",
                "Switch on “Allow full-screen notifications” for CallIQ.",
                if (fullScreenOn(ctx)) DONE else TODO, false, "screen",
            )
        }
        return out
    }

    /** For the watcher: is this one verifiably on now? Null when this phone cannot say. */
    fun isVerifiedOn(ctx: Context, key: String): Boolean? = when (key) {
        "phone" -> phoneGranted(ctx)
        "overlay" -> overlayOn(ctx)
        "oem_popup" -> miuiBackgroundPopup(ctx)
        "autostart" -> if (oem() == Oem.XIAOMI) miuiAutostart(ctx) else null
        "battery" -> batteryOn(ctx)
        "background" -> !backgroundRestricted(ctx)
        "notifications" -> notificationsOn(ctx)
        "fullscreen" -> fullScreenOn(ctx)
        else -> null
    }

    /**
     * Can a hung-up call actually produce the popup on this phone? The one answer the panel
     * reports as "popup on / off" — so a Xiaomi with MIUI's own switch still off is not shown
     * as fine just because Android's switch is on.
     */
    fun popupReady(ctx: Context): Boolean {
        if (!CallIqConfig.popupEnabled(ctx) || !phoneGranted(ctx) || !overlayOn(ctx)) return false
        return steps(ctx).firstOrNull { it.key == "oem_popup" }?.ok ?: true
    }

    /* ── Opening each one ────────────────────────────────────────────────── */

    private fun appDetails(ctx: Context) =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))

    /** Opens the exact screen for a step, from [ctx] (an Activity when there is one). */
    fun open(ctx: Context, key: String): Boolean {
        val pkg = ctx.packageName
        val ok = when (key) {
            "overlay" -> OemSettings.start(ctx, listOfNotNull(
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                    Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$pkg")) else null,
                appDetails(ctx),
            ))
            "oem_popup" -> OemSettings.openBackgroundPopupSettings(ctx)
            "autostart" -> OemSettings.openAutostartSettings(ctx)
            "battery" -> OemSettings.start(ctx, listOfNotNull(
                // The direct "Allow" dialog; some makers block it, so the list screen is next.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$pkg")) else null,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
                    Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS) else null,
                appDetails(ctx),
            ))
            "background" -> OemSettings.start(ctx, listOf(appDetails(ctx)))
            "notifications" -> OemSettings.openNotificationSettings(ctx)
            "fullscreen" -> OemSettings.start(ctx, listOfNotNull(
                if (Build.VERSION.SDK_INT >= 34)
                    Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$pkg")) else null,
                appDetails(ctx),
            ))
            // Where "Don't ask again" leaves the counselor: App info → Permissions.
            "app_details" -> OemSettings.start(ctx, listOf(appDetails(ctx)))
            else -> false
        }
        if (ok) SetupWatcher.watch(ctx, key)
        return ok
    }
}
