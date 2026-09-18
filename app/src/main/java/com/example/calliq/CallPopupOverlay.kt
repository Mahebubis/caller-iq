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
 * The post-call popup.
 *
 * A floating window (TYPE_APPLICATION_OVERLAY) shown the moment a call ends, so the counselor tags
 * the outcome there and then instead of remembering to open the app later. It needs "Display over
 * other apps"; without that permission Android forbids drawing over the launcher or the dialer, and
 * [CallPopupNotifier] posts a heads-up notification with the same one-tap actions instead.
 *
 * No service is involved on purpose: an attached overlay window already keeps this process
 * perceptible to Android, which sidesteps the background-service and background-activity limits
 * that Android 12+ applies to everything a BroadcastReceiver tries to start.
 */
object CallPopupOverlay {

    private const val TAG = "CallPopupOverlay"
    private val main = Handler(Looper.getMainLooper())
    private var root: View? = null
    private var dismissRunnable: Runnable? = null

    fun canShow(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

    /** dp → px */
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
                    // Not focusable and not touch-modal: the popup takes its own taps and lets
                    // everything else through, so it never traps the phone.
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                        WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                    android.graphics.PixelFormat.TRANSLUCENT
                ).apply {
                    gravity = Gravity.TOP
                    y = app.dp(28)
                    windowAnimations = android.R.style.Animation_Translucent
                }

                wm.addView(view, params)
                root = view
                view.alpha = 0f
                view.translationY = -app.dp(24).toFloat()
                view.animate().alpha(1f).translationY(0f).setDuration(220).start()

                val timeout = CallIqConfig.popupTimeoutSec(app) * 1000L
                startCountdown(view, timeout)
                dismissRunnable = Runnable { dismiss(app) }
                main.postDelayed(dismissRunnable!!, timeout)
                Log.d(TAG, "Popup shown for ${call.number} (${call.sim.display})")
            } catch (e: Throwable) {
                Log.e(TAG, "Could not show popup, falling back to a notification: ${e.message}", e)
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
        try {
            (app.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(view)
        } catch (e: Throwable) {
            Log.w(TAG, "removeView: ${e.message}")
        }
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

    private var progressBar: View? = null

    private fun buildView(app: Context, call: CallLogHelper.CallRecord): View {
        val (typeLabel, typeColor, typeBg) = typeStyle(call.callType)

        val outer = FrameLayout(app).apply {
            setPadding(app.dp(12), 0, app.dp(12), 0)
        }

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
        titles.addView(TextView(app).apply {
            text = call.number
            setTextColor(Color.parseColor("#0F172A"))
            textSize = 17f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            maxLines = 1
        })
        titles.addView(TextView(app).apply {
            // The SIM is named here too, so a wrong SIM is caught the moment it happens.
            val sim = call.sim.display
            text = "$typeLabel · ${duration(call.duration)} · $sim" + if (call.sim.carrier.isNotEmpty()) " · ${call.sim.carrier}" else ""
            setTextColor(Color.parseColor("#64748B"))
            textSize = 12f
            maxLines = 1
        })
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
                setOnClickListener {
                    tag(app, call, label)
                }
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

        /* The countdown to auto-dismiss, so the popup never feels like it is stuck */
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

    private fun tag(app: Context, call: CallLogHelper.CallRecord, outcome: String) {
        try {
            CallSyncWorker.schedule(
                context = app,
                number = call.number,
                callType = call.callType,
                duration = call.duration,
                simId = call.accountId,
                timestamp = call.timestamp,
                idempotencyKey = call.idempotencyKey,
                outcome = outcome,
                simSlot = call.sim.slot ?: 0,
                simCarrier = call.sim.carrier,
                simLabel = call.sim.label,
                simSource = call.sim.source,
                taggedVia = "popup"
            )
            Toast.makeText(app, "Tagged \"$outcome\"", Toast.LENGTH_SHORT).show()
        } catch (e: Throwable) {
            Log.e(TAG, "tag failed: ${e.message}", e)
            Toast.makeText(app, "Could not save the tag", Toast.LENGTH_SHORT).show()
        }
        CallPopupNotifier.cancel(app)
        dismiss(app)
    }
}
