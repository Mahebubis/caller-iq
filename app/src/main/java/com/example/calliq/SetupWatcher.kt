package com.example.calliq

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Brings CallIQ back by itself the moment a switch is turned on in Settings.
 *
 * Without this, every step is: open Settings → flip the switch → find the Back button → come back
 * → tap the next step. With it, the counselor only flips the switch; the app notices within half
 * a second, returns to the front, and opens the next step.
 *
 * Android allows an app in the background to open its own screen only once "Display over other
 * apps" is granted — which is why that step comes first. Before then, or on a phone that refuses
 * anyway, nothing breaks: the counselor presses Back as usual and the app carries on from there.
 *
 * Only steps that can be read back are watched. A switch the phone will not report (Oppo/Vivo
 * autostart) cannot be noticed, so for those the counselor presses Back and confirms.
 */
object SetupWatcher {

    private const val TAG = "SetupWatcher"
    private const val POLL_MS = 500L
    private const val GIVE_UP_MS = 120_000L

    private val handler = Handler(Looper.getMainLooper())
    private var running: Runnable? = null

    fun watch(ctx: Context, key: String) {
        stop()
        // Answered in a dialog over the app itself — there is nothing to come back from.
        if (key == "phone" || key == "battery") return
        val app = ctx.applicationContext
        if (SetupState.isVerifiedOn(app, key) == null) return

        val until = System.currentTimeMillis() + GIVE_UP_MS
        val r = object : Runnable {
            override fun run() {
                val on = SetupState.isVerifiedOn(app, key)
                when {
                    on == true -> { running = null; bringBack(app, key) }
                    on == null || System.currentTimeMillis() > until -> running = null
                    else -> handler.postDelayed(this, POLL_MS)
                }
            }
        }
        running = r
        handler.postDelayed(r, POLL_MS)
    }

    /** Called when the app is back in front, by whatever route. */
    fun stop() {
        running?.let { handler.removeCallbacks(it) }
        running = null
    }

    private fun bringBack(app: Context, key: String) {
        try {
            app.startActivity(
                Intent(app, MainActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP
                )
            )
            Log.d(TAG, "$key is on — brought CallIQ back")
        } catch (e: Throwable) {
            // Refused by this phone: the counselor presses Back, and the app resumes normally.
            Log.w(TAG, "could not return after $key: ${e.message}")
        }
    }
}
