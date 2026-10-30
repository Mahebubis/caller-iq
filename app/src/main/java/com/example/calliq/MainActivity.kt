package com.example.calliq

import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

    override fun getMainComponentName(): String = "CallIQ"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        fitBetweenSystemBars()
    }

    /*
     * Android 15+ draws every app targeting SDK 35 edge to edge: behind the status bar and behind
     * the navigation buttons. Unpadded, the header slid under the clock and the bottom tab bar
     * (Calls / Lists / Setup) sat under the back/home buttons where it could not be tapped. Same
     * layout on every Android version: draw edge to edge, then pad the screen by the system bars
     * — and by the keyboard while it is open, so a search box is never hidden behind it.
     */
    private fun fitBetweenSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // The app opens on the brand intro's night colour, so the bars start with light icons; the
        // intro hands them to the app's own theme when it ends (CallBridge.setSystemBarsTheme).
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
    }

    /*
     * Hardware keyboard (a tablet or a phone with a Bluetooth keyboard): every key-up also goes to
     * JS as a "CallIQKey" event for the shortcuts — Space dial, W WhatsApp, N next, 1-5 outcome,
     * Ctrl+K search, Ctrl+Z undo. Nothing is consumed, so typing into a text box is untouched; JS
     * ignores keys while one has focus.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_UP && event.keyCode != KeyEvent.KEYCODE_BACK) {
            val ch = event.unicodeChar.takeIf { it > 0 }?.toChar()?.toString()?.lowercase()
            val key = when (event.keyCode) {
                KeyEvent.KEYCODE_SPACE -> "space"
                KeyEvent.KEYCODE_ESCAPE -> "escape"
                KeyEvent.KEYCODE_ENTER -> "enter"
                else -> if (event.isCtrlPressed) KeyEvent.keyCodeToString(event.keyCode).removePrefix("KEYCODE_").lowercase() else ch
            }
            if (!key.isNullOrBlank()) CrmBridgeModule.emitKey(key, event.isCtrlPressed, event.isShiftPressed)
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onResume() {
        super.onResume()
        // Back from Settings by whatever route — nothing left to watch for.
        SetupWatcher.stop()
        // The app is in front, which is always allowed to start the monitor: from here on it
        // keeps CallIQ alive between calls, and restarts itself after a reboot (BootReceiver).
        if (!CallMonitorService.isRunning) CallMonitorService.start(this)
        // A switch may have just been turned on: the panel hears about it now, not tomorrow.
        // Local comparison first; this only sends when something actually changed.
        DeviceCheckin.maybeSend(this)
    }
}
