package com.example.calliq

import android.os.Bundle
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
