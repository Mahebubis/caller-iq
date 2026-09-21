package com.example.calliq

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The post-call card itself — built once and used by all three ways it can reach the counselor:
 *
 *   · [CallPopupOverlay]  floats it over whatever is on screen, the instant a call ends.
 *                         Needs "Display over other apps".
 *   · [CallPopupActivity] the same card as a real screen, opened by tapping the notification or
 *                         thrown up automatically when the phone is locked. Needs no permission.
 *   · [CallPopupNotifier] a notification carrying the same outcomes, for when neither can run.
 *
 * Every one of them offers ALL of the outcomes, so an outcome is never unreachable.
 */
object CallPopupView {

    val INK = Color.parseColor("#0F172A")
    val MUTE = Color.parseColor("#64748B")
    val LINE = Color.parseColor("#E2E8F0")
    val ACCENT = Color.parseColor("#4F46E5")

    fun Context.dp(value: Number): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    fun rounded(color: Int, radius: Float, stroke: Int = 0, strokeColor: Int = Color.TRANSPARENT) =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius
            if (stroke > 0) setStroke(stroke, strokeColor)
        }

    /** label, accent colour, tint for the type badge */
    fun typeStyle(type: String): Triple<String, Int, Int> = when {
        type.startsWith("OUTGOING") -> Triple("Outgoing", Color.parseColor("#4F46E5"), Color.parseColor("#EEF2FF"))
        type.startsWith("INCOMING") -> Triple("Incoming", Color.parseColor("#059669"), Color.parseColor("#ECFDF5"))
        type.startsWith("MISSED") -> Triple("Missed", Color.parseColor("#EF4444"), Color.parseColor("#FEF2F2"))
        type.startsWith("REJECTED") -> Triple("Rejected", Color.parseColor("#F59E0B"), Color.parseColor("#FFFBEB"))
        else -> Triple("Call", Color.parseColor("#64748B"), Color.parseColor("#F1F5F9"))
    }

    fun duration(seconds: Long): String {
        if (seconds <= 0) return "not connected"
        // Same format as the dashboard: "45s" under a minute, "02:04" from a minute, "1:02:04" from an hour.
        if (seconds < 60) return "${seconds}s"
        val h = seconds / 3600
        val m = (seconds % 3600) / 60
        val s = seconds % 60
        return if (h > 0) String.format(java.util.Locale.US, "%d:%02d:%02d", h, m, s)
               else String.format(java.util.Locale.US, "%02d:%02d", m, s)
    }

    /** "Incoming · 4m 12s · SIM 2 · Airtel" */
    fun metaLine(call: CallLogHelper.CallRecord): String {
        val (typeLabel, _, _) = typeStyle(call.callType)
        /*
         * Before the call-log row exists we only know how long the line was open, which for an
         * OUTGOING call includes ringing nobody answered — that is not talk time, so it is not
         * shown as one. The row lands a second later and the real figure replaces this.
         */
        val when_ = if (!call.fromLog && call.callType.startsWith("OUTGOING")) "just now" else duration(call.duration)
        return "$typeLabel · $when_ · ${call.sim.display}" + if (call.sim.carrier.isNotEmpty()) " · ${call.sim.carrier}" else ""
    }

    fun titleFor(call: CallLogHelper.CallRecord): String =
        call.number.ifEmpty { if (call.callType.startsWith("OUTGOING")) "Outgoing call" else "Call just ended" }

    class Card(val root: View, val title: TextView, val meta: TextView)

    /**
     * Builds the card. [onTag] receives the chosen outcome; [onClose] and [onOpenApp] are the
     * footer actions. The caller decides where the card lives.
     */
    fun build(
        ctx: Context,
        call: CallLogHelper.CallRecord,
        onTag: (String) -> Unit,
        onClose: () -> Unit,
        onOpenApp: () -> Unit,
    ): Card {
        val (typeLabel, typeColor, typeBg) = typeStyle(call.callType)

        val outer = FrameLayout(ctx).apply { setPadding(ctx.dp(12), 0, ctx.dp(12), 0) }

        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(Color.WHITE, ctx.dp(20).toFloat())
            elevation = ctx.dp(14).toFloat()
            setPadding(ctx.dp(16), ctx.dp(14), ctx.dp(16), ctx.dp(12))
        }

        /* Header: who, and what just happened */
        val header = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(TextView(ctx).apply {
            text = typeLabel.take(1)
            setTextColor(typeColor)
            textSize = 15f
            gravity = Gravity.CENTER
            typeface = Typeface.DEFAULT_BOLD
            background = rounded(typeBg, ctx.dp(11).toFloat())
            layoutParams = LinearLayout.LayoutParams(ctx.dp(38), ctx.dp(38)).apply { rightMargin = ctx.dp(10) }
        })
        val titles = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val title = TextView(ctx).apply {
            text = titleFor(call)
            setTextColor(INK)
            textSize = 17f
            typeface = Typeface.DEFAULT_BOLD
            maxLines = 1
        }
        val meta = TextView(ctx).apply {
            text = metaLine(call)
            setTextColor(MUTE)
            textSize = 12f
            maxLines = 1
        }
        titles.addView(title)
        titles.addView(meta)
        header.addView(titles)
        header.addView(TextView(ctx).apply {
            text = "✕"
            setTextColor(Color.parseColor("#94A3B8"))
            textSize = 16f
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(ctx.dp(32), ctx.dp(32))
            setOnClickListener { onClose() }
        })
        card.addView(header)

        card.addView(TextView(ctx).apply {
            text = "Tag this call"
            setTextColor(Color.parseColor("#94A3B8"))
            textSize = 11f
            letterSpacing = 0.06f
            typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = ctx.dp(12); bottomMargin = ctx.dp(8) }
        })

        /* Every outcome, one tap each */
        val grid = GridLayout(ctx).apply {
            columnCount = 2
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        CallIqConfig.DISPOSITIONS.forEachIndexed { index, (label, hex) ->
            val color = Color.parseColor(hex)
            val chip = TextView(ctx).apply {
                text = label
                setTextColor(INK)
                textSize = 13f
                gravity = Gravity.CENTER_VERTICAL
                setPadding(ctx.dp(12), ctx.dp(11), ctx.dp(10), ctx.dp(11))
                background = rounded(Color.WHITE, ctx.dp(11).toFloat(), ctx.dp(1), LINE)
                compoundDrawablePadding = ctx.dp(8)
                val dot = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(color)
                    setSize(ctx.dp(9), ctx.dp(9))
                }
                setCompoundDrawablesRelativeWithIntrinsicBounds(dot, null, null, null)
                isClickable = true
                setOnClickListener {
                    // A tap should feel like it landed, even though the card is about to go.
                    background = rounded(Color.parseColor("#EEF2FF"), ctx.dp(11).toFloat(), ctx.dp(1), color)
                    onTag(label)
                }
            }
            grid.addView(chip, GridLayout.LayoutParams().apply {
                width = 0
                height = GridLayout.LayoutParams.WRAP_CONTENT
                columnSpec = GridLayout.spec(index % 2, 1f)
                rowSpec = GridLayout.spec(index / 2)
                setMargins(ctx.dp(3), ctx.dp(3), ctx.dp(3), ctx.dp(3))
            })
        }
        card.addView(grid)

        /* Footer */
        val footer = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = ctx.dp(8) }
        }
        footer.addView(TextView(ctx).apply {
            text = "Open app"
            setTextColor(ACCENT)
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            setPadding(ctx.dp(4), ctx.dp(8), ctx.dp(10), ctx.dp(8))
            setOnClickListener { onOpenApp() }
        })
        footer.addView(View(ctx).apply { layoutParams = LinearLayout.LayoutParams(0, 1, 1f) })
        footer.addView(TextView(ctx).apply {
            text = "Skip"
            setTextColor(MUTE)
            textSize = 13f
            setPadding(ctx.dp(12), ctx.dp(8), ctx.dp(4), ctx.dp(8))
            setOnClickListener { onClose() }
        })
        card.addView(footer)

        outer.addView(card, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT
        ))
        return Card(outer, title, meta)
    }

    /** The thin bar that counts the card down, so it never looks stuck. */
    fun countdownBar(ctx: Context, parent: LinearLayout): View {
        val track = FrameLayout(ctx).apply {
            background = rounded(Color.parseColor("#F1F5F9"), ctx.dp(2).toFloat())
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, ctx.dp(3))
                .apply { topMargin = ctx.dp(6) }
        }
        val bar = View(ctx).apply {
            background = rounded(Color.parseColor("#C7D2FE"), ctx.dp(2).toFloat())
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, ctx.dp(3))
        }
        track.addView(bar)
        parent.addView(track)
        return bar
    }
}
