package com.example.calliq

import android.animation.ValueAnimator
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * The post-call popup — the Truecaller-style card that asks for the outcome the moment a call ends.
 *
 * It opens on what the app already knows (who called, which SIM, when it started), WITHOUT waiting
 * for Android to write its call-log row. That row arrives a second or three later — much later on
 * some OEMs, and never at all for some rejected calls — and waiting for it was the difference
 * between "instant, like Truecaller" and "nothing happened". While the card is up it looks for the
 * row in the background and fills in the number, the real duration and the call type in place.
 *
 * It needs "Display over other apps": Android lets nothing draw over the dialer without it. When
 * that is missing (or adding the window fails for any reason) [CallPopupNotifier] posts a heads-up
 * notification carrying the same one-tap outcomes, so the counselor is always asked something.
 *
 * No service is involved on purpose: an attached overlay window already makes this process
 * perceptible to Android, which sidesteps the background-start limits that Android 12+ applies to
 * anything a BroadcastReceiver tries to launch.
 */
object CallPopupOverlay {

    private const val TAG = "CallPopupOverlay"
    private val main = Handler(Looper.getMainLooper())

    private var root: View? = null
    private var dismissRunnable: Runnable? = null
    private var progressBar: View? = null
    private var titleView: TextView? = null
    private var metaView: TextView? = null
    private var current: CallLogHelper.CallRecord? = null

    /** How long after opening we keep looking for the call-log row, in milliseconds. */
    private val LOOKUP_DELAYS = longArrayOf(400, 800, 1500, 2500, 4000, 6000, 9000, 13000, 18000, 25000)

    fun isShowing(): Boolean = root != null

    fun canShow(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

    private fun Context.dp(value: Number): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun rounded(color: Int, radius: Float, stroke: Int = 0, strokeColor: Int = Color.TRANSPARENT) =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius
            if (stroke > 0) setStroke(stroke, strokeColor)
        }

    fun show(context: Context, call: CallLogHelper.CallRecord) {
        val app = context.applicationContext
        if (!canShow(app)) {
            CallIqConfig.notePopup(app, "no overlay permission — showed a notification instead")
            CallPopupNotifier.notify(app, call)
            return
        }
        main.post {
            try {
                dismissInternal(app)
                val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                val view = buildView(app, call)
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
                    y = app.dp(28)
                }

                wm.addView(view, params)
                root = view
                current = call
                view.alpha = 0f
                view.translationY = -app.dp(24).toFloat()
                view.animate().alpha(1f).translationY(0f).setDuration(200).start()

                val timeout = CallIqConfig.popupTimeoutSec(app) * 1000L
                startCountdown(view, timeout)
                dismissRunnable = Runnable { dismiss(app) }
                main.postDelayed(dismissRunnable!!, timeout)

                // Opened on what we knew; now go and find the real row to fill in the rest.
                if (!call.fromLog) scheduleLookup(app, call, 0)

                CallIqConfig.notePopup(app, "shown for ${if (call.number.isEmpty()) "the last call" else call.number}")
                Log.d(TAG, "Popup shown for ${call.number} (${call.sim.display}), fromLog=${call.fromLog}")
            } catch (e: Throwable) {
                Log.e(TAG, "Could not show popup, falling back to a notification: ${e.message}", e)
                CallIqConfig.notePopup(app, "overlay refused by the system (${e.javaClass.simpleName}) — showed a notification")
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
        progressBar = null
        try {
            (app.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(view)
        } catch (e: Throwable) {
            Log.w(TAG, "removeView: ${e.message}")
        }
    }

    /* ── Filling in the call once Android writes it ───────────────────────── */

    private fun scheduleLookup(app: Context, opened: CallLogHelper.CallRecord, index: Int) {
        if (index >= LOOKUP_DELAYS.size) return
        main.postDelayed({
            if (root == null) return@postDelayed          // the counselor already answered or closed it
            val found = try {
                CallLogHelper.findCallSince(app, opened.timestamp, opened.number.filter { it.isDigit() }.takeLast(10))
            } catch (e: Throwable) {
                Log.w(TAG, "call-log lookup failed: ${e.message}"); null
            }
            if (found != null) {
                current = found
                titleView?.text = found.number.ifEmpty { titleView?.text.toString() }
                metaView?.text = metaLine(found)
                Log.d(TAG, "Popup filled in from the call log: ${found.number} ${found.duration}s")
            } else {
                scheduleLookup(app, opened, index + 1)
            }
        }, LOOKUP_DELAYS[index] - (if (index == 0) 0 else LOOKUP_DELAYS[index - 1]))
    }

    /* ── UI ───────────────────────────────────────────────────────────────── */

    private fun typeStyle(type: String): Triple<String, Int, Int> = when {
        type.startsWith("OUTGOING") -> Triple("Outgoing", Color.parseColor("#4F46E5"), Color.parseColor("#EEF2FF"))
        type.startsWith("INCOMING") -> Triple("Incoming", Color.parseColor("#059669"), Color.parseColor("#ECFDF5"))
        type.startsWith("MISSED") -> Triple("Missed", Color.parseColor("#EF4444"), Color.parseColor("#FEF2F2"))
        type.startsWith("REJECTED") -> Triple("Rejected", Color.parseColor("#F59E0B"), Color.parseColor("#FFFBEB"))
        else -> Triple("Call", Color.parseColor("#64748B"), Color.parseColor("#F1F5F9"))
    }

    private fun duration(seconds: Long): String {
        if (seconds <= 0) return "not connected"
        val m = seconds / 60
        val s = seconds % 60
        return if (m > 0) "${m}m ${s}s" else "${s}s"
    }

    private fun metaLine(call: CallLogHelper.CallRecord): String {
        val (typeLabel, _, _) = typeStyle(call.callType)
        val sim = call.sim.display
        /*
         * Before the call-log row exists we know how long the line was open, which for an OUTGOING
         * call includes the ringing nobody answered — that is not talk time, so it is not shown as
         * one. A second later the row lands and the real figure replaces this.
         */
        val when_ = if (!call.fromLog && call.callType.startsWith("OUTGOING")) "just now" else duration(call.duration)
        return "$typeLabel · $when_ · $sim" + if (call.sim.carrier.isNotEmpty()) " · ${call.sim.carrier}" else ""
    }

    private fun buildView(app: Context, call: CallLogHelper.CallRecord): View {
        val (typeLabel, typeColor, typeBg) = typeStyle(call.callType)

        val outer = FrameLayout(app).apply { setPadding(app.dp(12), 0, app.dp(12), 0) }

        val card = LinearLayout(app).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(Color.WHITE, app.dp(18).toFloat())
            elevation = app.dp(12).toFloat()
            setPadding(app.dp(16), app.dp(14), app.dp(16), app.dp(12))
        }

        /* Header: who, and what just happened */
        val header = LinearLayout(app).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(TextView(app).apply {
            text = typeLabel.take(1)
            setTextColor(typeColor)
            textSize = 15f
            gravity = Gravity.CENTER
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            background = rounded(typeBg, app.dp(11).toFloat())
            layoutParams = LinearLayout.LayoutParams(app.dp(38), app.dp(38)).apply { rightMargin = app.dp(10) }
        })
        val titles = LinearLayout(app).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val title = TextView(app).apply {
            // An outgoing call has no number until Android writes the row — say so instead of
            // showing a blank, and the lookup above replaces it moments later.
            text = call.number.ifEmpty { "Call just ended" }
            setTextColor(Color.parseColor("#0F172A"))
            textSize = 17f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            maxLines = 1
        }
        val meta = TextView(app).apply {
            text = metaLine(call)
            setTextColor(Color.parseColor("#64748B"))
            textSize = 12f
            maxLines = 1
        }
        titles.addView(title)
        titles.addView(meta)
        titleView = title
        metaView = meta
        header.addView(titles)
        header.addView(TextView(app).apply {
            text = "✕"
            setTextColor(Color.parseColor("#94A3B8"))
            textSize = 16f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(app.dp(32), app.dp(32))
            setOnClickListener { dismiss(app) }
        })
        card.addView(header)

        card.addView(TextView(app).apply {
            text = "Tag this call"
            setTextColor(Color.parseColor("#94A3B8"))
            textSize = 11f
            letterSpacing = 0.06f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = app.dp(12); bottomMargin = app.dp(8) }
        })

        /* One tap per outcome */
        val grid = GridLayout(app).apply {
            columnCount = 2
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        CallIqConfig.DISPOSITIONS.forEachIndexed { index, (label, hex) ->
            val color = Color.parseColor(hex)
            val chip = TextView(app).apply {
                text = label
                setTextColor(Color.parseColor("#0F172A"))
                textSize = 13f
                gravity = Gravity.CENTER_VERTICAL
                setPadding(app.dp(12), app.dp(11), app.dp(10), app.dp(11))
                background = rounded(Color.WHITE, app.dp(11).toFloat(), app.dp(1), Color.parseColor("#E2E8F0"))
                compoundDrawablePadding = app.dp(8)
                val dot = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(color)
                    setSize(app.dp(9), app.dp(9))
                }
                setCompoundDrawablesRelativeWithIntrinsicBounds(dot, null, null, null)
                isClickable = true
                setOnClickListener { tag(app, label) }
            }
            grid.addView(chip, GridLayout.LayoutParams().apply {
                width = 0
                height = GridLayout.LayoutParams.WRAP_CONTENT
                columnSpec = GridLayout.spec(index % 2, 1f)
                rowSpec = GridLayout.spec(index / 2)
                setMargins(app.dp(3), app.dp(3), app.dp(3), app.dp(3))
            })
        }
        card.addView(grid)

        /* Footer */
        val footer = LinearLayout(app).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = app.dp(8) }
        }
        footer.addView(TextView(app).apply {
            text = "Open app"
            setTextColor(Color.parseColor("#4F46E5"))
            textSize = 13f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setPadding(app.dp(4), app.dp(8), app.dp(10), app.dp(8))
            setOnClickListener {
                try {
                    app.startActivity(Intent(app, MainActivity::class.java).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    })
                } catch (e: Throwable) { Log.w(TAG, "open app: ${e.message}") }
                dismiss(app)
            }
        })
        footer.addView(View(app).apply { layoutParams = LinearLayout.LayoutParams(0, 1, 1f) })
        footer.addView(TextView(app).apply {
            text = "Skip"
            setTextColor(Color.parseColor("#64748B"))
            textSize = 13f
            setPadding(app.dp(12), app.dp(8), app.dp(4), app.dp(8))
            setOnClickListener { dismiss(app) }
        })
        card.addView(footer)

        /* The countdown to auto-dismiss, so the card never feels stuck */
        val track = FrameLayout(app).apply {
            background = rounded(Color.parseColor("#F1F5F9"), app.dp(2).toFloat())
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, app.dp(3)).apply { topMargin = app.dp(6) }
        }
        val bar = View(app).apply {
            background = rounded(Color.parseColor("#C7D2FE"), app.dp(2).toFloat())
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, app.dp(3))
        }
        track.addView(bar)
        card.addView(track)
        progressBar = bar

        outer.addView(card, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT
        ))
        return outer
    }

    private fun startCountdown(view: View, timeout: Long) {
        val bar = progressBar ?: return
        view.post {
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
