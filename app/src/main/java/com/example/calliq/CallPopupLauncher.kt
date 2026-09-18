package com.example.calliq

import android.content.Context
import android.util.Log

/**
 * Decides HOW the post-call prompt appears, best first.
 *
 *  1. [CallPopupActivity] — a real screen: animated, focusable, and the back button closes it like
 *     any other. Starting an activity from the background is normally forbidden, but holding
 *     "Display over other apps" is one of the exemptions Android allows, so this is available
 *     exactly when the overlay is.
 *  2. [CallPopupOverlay] — the floating card, if launching the screen is refused for any reason.
 *  3. [CallPopupNotifier] — a heads-up notification carrying the same outcomes, for when neither
 *     can run. Without "Display over other apps" Android permits nothing else from the background.
 */
object CallPopupLauncher {

    private const val TAG = "CallPopupLauncher"

    fun show(context: Context, call: CallLogHelper.CallRecord) {
        val app = context.applicationContext

        if (CallPopupOverlay.canShow(app)) {
            try {
                app.startActivity(CallPopupActivity.intentFor(app, call))
                CallIqConfig.notePopup(app, "popup opened for ${call.number.ifEmpty { "the last call" }}")
                Log.d(TAG, "Opened the popup screen")
                return
            } catch (e: Throwable) {
                Log.w(TAG, "Could not open the popup screen (${e.javaClass.simpleName}), using the floating card", e)
            }
            CallPopupOverlay.show(app, call)
            return
        }

        // No overlay permission: a notification is the only thing Android still allows.
        CallIqConfig.notePopup(app, "no “Display over other apps” permission — showed the notification instead")
        CallPopupNotifier.notify(app, call)
    }
}
