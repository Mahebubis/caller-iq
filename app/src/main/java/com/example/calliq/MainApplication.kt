package com.example.calliq

import android.app.Application
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.shell.MainReactPackage
import com.facebook.soloader.SoLoader

class MainApplication : Application(), ReactApplication {

    override val reactNativeHost: ReactNativeHost =
        object : DefaultReactNativeHost(this) {
            override fun getPackages(): List<ReactPackage> {
                return listOf(
                    MainReactPackage(),
                    CallBridgePackage(),
                )
            }

            override fun getJSMainModuleName(): String = "index"

            override fun getUseDeveloperSupport(): Boolean = false

            override val isNewArchEnabled: Boolean = false
            override val isHermesEnabled: Boolean = true
        }

    override fun onCreate() {
        super.onCreate()
        SoLoader.init(this, false)
        /* If this process was killed mid-call (OEM cleaner, reboot), the dashboard is still showing
           that call as live. Close it now that we can see the phone is idle. */
        CallPresence.clearIfIdle(this)
        /* Keeps the panel's SIM register current by itself, when the counselor has allowed it. */
        if (CallIqConfig.ussdEnabled(this)) UssdWorker.scheduleDaily(this)
        /* The safety net for calls the call-ended broadcast never delivered (MIUI, ColorOS, Vivo
           without Autostart). Costs nothing when there is nothing new; see CatchUpWorker. */
        CatchUpWorker.schedule(this)
    }
}