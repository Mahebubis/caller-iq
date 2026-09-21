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
        // A switch may have just been turned on: the panel hears about it now, not tomorrow.
        // Local comparison first; this only sends when something actually changed.
        DeviceCheckin.maybeSend(this)
    }
}
