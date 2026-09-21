package com.example.calliq

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * Shortcuts into the settings screens that decide whether the post-call popup can appear.
 *
 * Stock Android needs one thing: "Display over other apps". Xiaomi (MIUI/HyperOS), Oppo, Realme
 * (ColorOS), Vivo (FuntouchOS) and OnePlus each add their OWN switches on top — most importantly a
 * separate "show pop-up windows while running in the background" permission and an "autostart"
 * one. On those phones `Settings.canDrawOverlays()` happily returns true while the system still
 * silently refuses to draw the card, and the app's receiver stops being called once the app is
 * swiped away. That is why this exists: each entry is tried in turn and the first one that opens
 * wins, falling back to the app's own settings page, which always exists.
 */
object OemSettings {

    private const val TAG = "OemSettings"

    /*
     * Each intent is simply tried, and the first that opens wins.
     *
     * This used to ask resolveActivity() first — but from Android 11 package-visibility rules
     * make that return null for another maker's app (MIUI's Security app, ColorOS's safe centre)
     * unless it is declared, so on every newer phone the right screen was silently skipped for
     * the generic one. Starting it and catching the failure is the reliable test.
     *
     * From an Activity the screen opens in the app's own task, so Back returns straight here;
     * only a bare Context needs a new task.
     */
    fun start(context: Context, intents: List<Intent>): Boolean {
        for (intent in intents) {
            try {
                if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                return true
            } catch (e: Throwable) {
                Log.w(TAG, "intent failed: ${e.message}")
            }
        }
        return false
    }

    private fun tryStart(context: Context, intents: List<Intent>): Boolean = start(context, intents)

    private fun component(pkg: String, cls: String) = Intent().setComponent(ComponentName(pkg, cls))

    /** Is this phone one of the makes that adds its own pop-up / autostart switches? */
    fun needsExtraSteps(): Boolean {
        val m = Build.MANUFACTURER.lowercase()
        return m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") ||
            m.contains("oppo") || m.contains("realme") || m.contains("oneplus") ||
            m.contains("vivo") || m.contains("iqoo") || m.contains("honor") || m.contains("huawei")
    }

    fun manufacturer(): String = Build.MANUFACTURER

    /** The OEM's own permission screen, where the background pop-up switch lives. */
    fun openBackgroundPopupSettings(context: Context): Boolean {
        val pkg = context.packageName
        val m = Build.MANUFACTURER.lowercase()
        val intents = mutableListOf<Intent>()

        if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")) {
            // MIUI keeps "Display pop-up windows while running in the background" here.
            intents += Intent("miui.intent.action.APP_PERM_EDITOR")
                .setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity")
                .putExtra("extra_pkgname", pkg)
            intents += Intent("miui.intent.action.APP_PERM_EDITOR")
                .setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.AppPermissionsEditorActivity")
                .putExtra("extra_pkgname", pkg)
        }
        if (m.contains("oppo") || m.contains("realme") || m.contains("oneplus")) {
            intents += component("com.coloros.safecenter", "com.coloros.safecenter.permission.floatwindow.FloatWindowListActivity")
            intents += component("com.coloros.safecenter", "com.coloros.safecenter.sysfloatwindow.FloatWindowListActivity")
            intents += component("com.oppo.safe", "com.oppo.safe.permission.floatwindow.FloatWindowListActivity")
        }
        if (m.contains("vivo") || m.contains("iqoo")) {
            intents += component("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.SoftPermissionDetailActivity")
                .putExtra("packagename", pkg)
        }
        if (m.contains("honor") || m.contains("huawei")) {
            intents += component("com.huawei.systemmanager", "com.huawei.permissionmanager.ui.MainActivity")
        }

        // Always available: Android's own overlay screen, then the app's settings page.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            intents += Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$pkg"))
        }
        intents += Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
        return tryStart(context, intents)
    }

    /** Autostart / "allow the app to run in the background", without which the receiver stops firing. */
    fun openAutostartSettings(context: Context): Boolean {
        val m = Build.MANUFACTURER.lowercase()
        val intents = mutableListOf<Intent>()

        if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")) {
            intents += component("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
        }
        if (m.contains("oneplus")) {
            // Older OxygenOS. Newer OnePlus builds are ColorOS underneath and fall through to the
            // ColorOS screens, then to App info → Battery usage → "Allow auto launch".
            intents += component("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity")
        }
        if (m.contains("oppo") || m.contains("realme") || m.contains("oneplus")) {
            intents += component("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")
            intents += component("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity")
            intents += component("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity")
        }
        if (m.contains("vivo") || m.contains("iqoo")) {
            intents += component("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")
            intents += component("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager")
        }
        if (m.contains("honor") || m.contains("huawei")) {
            intents += component("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")
            intents += component("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity")
        }
        if (m.contains("samsung")) {
            intents += component("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity")
        }

        intents += Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
        return tryStart(context, intents)
    }

    /** Android 13+ notification settings, for the popup's fallback. */
    fun openNotificationSettings(context: Context): Boolean {
        val intents = mutableListOf<Intent>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intents += Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        }
        intents += Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
        return tryStart(context, intents)
    }

    /** Plain-English list of what still has to be done on THIS make of phone. */
    fun extraStepsText(): String {
        val m = Build.MANUFACTURER.lowercase()
        return when {
            m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") ->
                "On Xiaomi/Redmi: open Permissions and switch on “Display pop-up windows while running in the background”, then switch on Autostart."
            m.contains("oppo") || m.contains("realme") || m.contains("oneplus") ->
                "On Realme/Oppo/OnePlus: switch on “Display over other apps” AND “Allow floating windows in the background”, then allow Auto-start, and set Battery usage to “Allow background activity”."
            m.contains("vivo") || m.contains("iqoo") ->
                "On Vivo/iQOO: allow “Floating window” and “Display over other apps”, then turn on “Auto-start” and “High background power consumption”."
            m.contains("honor") || m.contains("huawei") ->
                "On Honor/Huawei: allow “Display over other apps”, then set App launch to Manage manually with Auto-launch and Run in background on."
            m.contains("samsung") ->
                "On Samsung: allow “Appear on top”, then in Battery set this app to Unrestricted."
            else -> "Allow “Display over other apps”, then set the battery setting for this app to Unrestricted."
        }
    }
}
