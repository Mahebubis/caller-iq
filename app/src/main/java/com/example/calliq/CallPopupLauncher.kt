package com.example.calliq

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Decides HOW the post-call prompt appears, best first, and makes sure something actually did.
 *
 *  1. [CallPopupActivity] — a real screen: animated, focusable, every outcome one tap away, and the
 *     back button closes it like any other. Starting an activity from the background is normally
 *     forbidden; holding "Display over other apps" is one of the exemptions Android allows, so this
 *     route is available exactly when the overlay is.
 *  2. [CallPopupOverlay] — the floating card. Used if the screen refuses to open, INCLUDING the
 *     case where an OEM swallows the launch without raising an error: a second after asking, this
 *     checks whether the screen really appeared and shows the card if it did not. Xiaomi, Oppo and
 *     Vivo builds are known to drop background launches quietly.
 *  3. [CallPopupNotifier] — a heads-up notification carrying the same outcomes. Reached only when
 *     "Display over other apps" is off, because Android then permits nothing else from the
 *     background; its first action button leads straight to that setting.
 */
object CallPopupLauncher {

    private const val TAG = "CallPopupLauncher"
    private val main = Handler(Looper.getMainLooper())

    /** How long to give the system to actually put the popup screen up. */
    private const val APPEAR_GRACE_MS = 1400L

    fun show(context: Context, call: CallLogHelper.CallRecord) {
        val app = context.applicationContext

        if (!CallPopupOverlay.canShow(app)) {
            CallIqConfig.notePopup(app, "no “Display over other apps” permission — showed the notification instead")
            CallPopupNotifier.notify(app, call)
            return
        }

        val askedAt = System.currentTimeMillis()
        try {
            app.startActivity(CallPopupActivity.intentFor(app, call))
        } catch (e: Throwable) {
            Log.w(TAG, "Could not open the popup screen (${e.javaClass.simpleName}); using the floating card", e)
            CallPopupOverlay.show(app, call)
            return
        }

        /* Launching threw nothing — but that is not proof it opened. Check, and fall back to the
           floating card if the screen never came up, so a call always ends with a prompt. */
        main.postDelayed({
            if (CallPopupActivity.shownSince(askedAt) || CallPopupOverlay.isShowing()) {
                CallIqConfig.notePopup(app, "popup opened for ${call.number.ifEmpty { "the last call" }}")
            } else {
                Log.w(TAG, "The popup screen never appeared; showing the floating card instead")
                CallIqConfig.notePopup(app, "the phone blocked the popup screen — showed the floating card")
                CallPopupOverlay.show(app, call)
            }
        }, APPEAR_GRACE_MS)
    }
}
