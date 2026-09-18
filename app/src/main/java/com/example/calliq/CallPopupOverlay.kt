package com.example.calliq

import android.animation.ValueAnimator
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * The post-call popup, floating over whatever is on screen the instant a call ends.
 *
 * It opens on what the app already knows (who called, which SIM, when it started) WITHOUT waiting
 * for Android to write its call-log row — that row arrives a second or three later, much later on
 * some OEMs, and never at all for some rejected calls, and waiting for it was the difference
 * between "instant, like Truecaller" and "nothing happened". While the card is up it looks for the
 * row in the background and fills in the number, real duration and call type in place.
 *
 * This is the best of the three routes because it needs no tap, but it does need "Display over
 * other apps". Without that Android forbids drawing over the dialer, and [CallPopupNotifier] takes
 * over with a notification carrying the same outcomes plus a way into [CallPopupActivity].
 *
 * No service is involved on purpose: an attached overlay window already makes this process
 * perceptible to Android, which sidesteps the background-start limits of Android 12+.
 */
object CallPopupOverlay {

    private const val TAG = "CallPopupOverlay"
    private val main = Handler(Looper.getMainLooper())

    private var root: View? = null
    private var dismissRunnable: Runnable? = null
    private var titleView: TextView? = null
    private var metaView: TextView? = null
    private var current: CallLogHelper.CallRecord? = null

    private val LOOKUP_DELAYS = longArrayOf(400, 800, 1500, 2500, 4000, 6000, 9000, 13000, 18000, 25000)

    fun isShowing(): Boolean = root != null

    fun canShow(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

    fun show(context: Context, call: CallLogHelper.CallRecord) {
        val app = context.applicationContext
        if (!canShow(app)) {
            CallIqConfig.notePopup(app, "no “Display over other apps” permission — showed the notification instead")
            CallPopupNotifier.notify(app, call)
            return
        }
        main.post {
            try {
                dismissInternal(app)
                val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager

                val card = CallPopupView.build(
                    ctx = app,
                    call = call,
                    onTag = { outcome -> tag(app, outcome) },
                    onClose = { dismiss(app) },
                    onOpenApp = {
                        try {
                            app.startActivity(Intent(app, MainActivity::class.java).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                            })
                        } catch (e: Throwable) { Log.w(TAG, "open app: ${e.message}") }
                        dismiss(app)
                    },
                )
                titleView = card.title
                metaView = card.meta

                val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

                val params = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    type,
                    // Not focusable and not touch-modal: the card takes its own taps and lets
                    // everything else through, so it never traps the phone.
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                        WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                    android.graphics.PixelFormat.TRANSLUCENT
                ).apply {
                    gravity = Gravity.TOP
                    y = with(CallPopupView) { app.dp(28) }
                }

                wm.addView(card.root, params)
                root = card.root
                current = call

                card.root.alpha = 0f
                card.root.translationY = -with(CallPopupView) { app.dp(24) }.toFloat()
                card.root.animate().alpha(1f).translationY(0f).setDuration(220).start()

                val timeout = CallIqConfig.popupTimeoutSec(app) * 1000L
                ((card.root as? FrameLayout)?.getChildAt(0) as? LinearLayout)?.let { column ->
                    val bar = CallPopupView.countdownBar(app, column)
                    startCountdown(bar, timeout)
                }
                dismissRunnable = Runnable { dismiss(app) }
                main.postDelayed(dismissRunnable!!, timeout)

                if (!call.fromLog) scheduleLookup(app, call, 0)

                CallIqConfig.notePopup(app, "popup shown for ${call.number.ifEmpty { "the last call" }}")
                Log.d(TAG, "Popup shown for ${call.number} (${call.sim.display}), fromLog=${call.fromLog}")
            } catch (e: Throwable) {
                Log.e(TAG, "Could not show popup, falling back to a notification: ${e.message}", e)
                CallIqConfig.notePopup(app, "the system refused the overlay (${e.javaClass.simpleName}) — showed the notification")
                CallPopupNotifier.notify(app, call)
            }
        }
    }

    fun dismiss(context: Context) {
        main.post { dismissInternal(context.applicationContext) }
    }

    private fun dismissInternal(app: Context) {
        dismissRunnable?.let { main.removeCallbacks(it) }
        dismissRunnable = null
        val view = root ?: return
        root = null
        current = null
        titleView = null
        metaView = null
        try {
            (app.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(view)
        } catch (e: Throwable) {
            Log.w(TAG, "removeView: ${e.message}")
        }
    }

    private fun startCountdown(bar: View, timeout: Long) {
        bar.post {
            val full = bar.width.takeIf { it > 0 } ?: return@post
            ValueAnimator.ofInt(full, 0).apply {
                duration = timeout
                addUpdateListener { a ->
                    val lp = bar.layoutParams
                    lp.width = a.animatedValue as Int
                    bar.layoutParams = lp
                }
                start()
            }
        }
    }

    /** Fill the card in once Android finally writes the call. */
    private fun scheduleLookup(app: Context, opened: CallLogHelper.CallRecord, index: Int) {
        if (index >= LOOKUP_DELAYS.size) return
        main.postDelayed({
            if (root == null) return@postDelayed          // already answered or closed
            val found = try {
                CallLogHelper.findCallSince(app, opened.timestamp, opened.number.filter { it.isDigit() }.takeLast(10))
            } catch (e: Throwable) {
                Log.w(TAG, "call-log lookup failed: ${e.message}"); null
            }
            if (found != null) {
                current = found
                titleView?.text = CallPopupView.titleFor(found)
                metaView?.text = CallPopupView.metaLine(found)
                Log.d(TAG, "Popup filled in from the call log: ${found.number} ${found.duration}s")
            } else {
                scheduleLookup(app, opened, index + 1)
            }
        }, if (index == 0) LOOKUP_DELAYS[0] else LOOKUP_DELAYS[index] - LOOKUP_DELAYS[index - 1])
    }

    /**
     * Save the outcome. The call may not exist on the server yet (the sync is seconds behind, and
     * the counselor can tap within one), so the tag is sent with the call's start time and the
     * server attaches it to that call — creating nothing, losing nothing.
     */
    private fun tag(app: Context, outcome: String) {
        val call = current
        try {
            TagWorker.schedule(
                context = app,
                outcome = outcome,
                number = call?.number ?: "",
                startedMs = call?.timestamp ?: System.currentTimeMillis(),
                idempotencyKey = call?.idempotencyKey ?: "",
                via = "popup",
            )
            Toast.makeText(app, "Tagged \"$outcome\"", Toast.LENGTH_SHORT).show()
            CallIqConfig.notePopup(app, "tagged \"$outcome\"")
        } catch (e: Throwable) {
            Log.e(TAG, "tag failed: ${e.message}", e)
            Toast.makeText(app, "Could not save the tag", Toast.LENGTH_SHORT).show()
        }
        CallPopupNotifier.cancel(app)
        dismiss(app)
    }
}
