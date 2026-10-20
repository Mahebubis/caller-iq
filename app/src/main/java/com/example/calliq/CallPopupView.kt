package com.example.calliq

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.res.ResourcesCompat

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
 *
 * Styled like the app ("Sunset Coral", src/theme.ts): a deep-plum header strip with faint leaves,
 * a white card, Plus Jakarta Sans, blush chips, and the sunset-coral gradient for what is picked.
 */
object CallPopupView {

    val INK = Color.parseColor("#1F1924")
    val MUTE = Color.parseColor("#7D6E75")
    val BLUSH = Color.parseColor("#F7E6DF")
    val LINE = Color.parseColor("#F2D8CE")
    val ACCENT = Color.parseColor("#F44350")    // sunset coral (src/theme.ts `primary`)
    val ACCENT_INK = Color.parseColor("#DE2F3C")
    val CORAL = intArrayOf(Color.parseColor("#FF7556"), Color.parseColor("#F44350"), Color.parseColor("#E62E5C"))
    private val HEADER = intArrayOf(Color.parseColor("#3A0CA3"), Color.parseColor("#4A154B"), Color.parseColor("#6B1143"))

    fun Context.dp(value: Number): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    fun rounded(color: Int, radius: Float, stroke: Int = 0, strokeColor: Int = Color.TRANSPARENT) =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius
            if (stroke > 0) setStroke(stroke, strokeColor)
        }

    /** The sunset-coral gradient as a rounded background. */
    fun coral(radius: Float) = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, CORAL).apply { cornerRadius = radius }

    /* The app's typeface, falling back to the system font if it cannot load. */
    private val fonts = HashMap<Int, Typeface>()
    fun font(ctx: Context, weight: Int): Typeface = fonts.getOrPut(weight) {
        val res = when {
            weight >= 800 -> R.font.pjs_extrabold
            weight >= 700 -> R.font.pjs_bold
            weight >= 600 -> R.font.pjs_semibold
            weight >= 500 -> R.font.pjs_medium
            else -> R.font.pjs_regular
        }
        try { ResourcesCompat.getFont(ctx, res) } catch (_: Throwable) { null }
            ?: if (weight >= 600) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    }

    /** label, accent colour, tint for the type badge — the app's status colours. */
    fun typeStyle(type: String): Triple<String, Int, Int> = when {
        type.startsWith("OUTGOING") -> Triple("Outgoing", Color.parseColor("#2563EB"), Color.parseColor("#EBF3FE"))
        type.startsWith("INCOMING") -> Triple("Incoming", Color.parseColor("#059669"), Color.parseColor("#E0F8EF"))
        type.startsWith("MISSED") -> Triple("Missed", Color.parseColor("#E11D48"), Color.parseColor("#FFE4E8"))
        type.startsWith("REJECTED") -> Triple("Rejected", Color.parseColor("#D97706"), Color.parseColor("#FEF3C7"))
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

    /** "+91 98765 43210" for a 10-digit Indian number, as the app writes it. */
    private fun pretty(n: String): String {
        val d = n.filter { it.isDigit() }
        val ten = when {
            d.length == 10 -> d
            d.length == 12 && d.startsWith("91") -> d.substring(2)
            else -> ""
        }
        return if (ten.isNotEmpty()) "+91 ${ten.substring(0, 5)} ${ten.substring(5)}" else n
    }

    fun titleFor(call: CallLogHelper.CallRecord): String =
        if (call.number.isNotEmpty()) pretty(call.number)
        else if (call.callType.startsWith("OUTGOING")) "Outgoing call" else "Call just ended"

    class Card(val root: View, val title: TextView, val meta: TextView)

    private fun sectionLabel(ctx: Context, label: String) = TextView(ctx).apply {
        text = label.uppercase()
        setTextColor(MUTE)
        textSize = 11f
        letterSpacing = 0.07f
        typeface = font(ctx, 700)
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { topMargin = ctx.dp(14); bottomMargin = ctx.dp(8) }
    }

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
        val radius = ctx.dp(24).toFloat()

        val outer = FrameLayout(ctx).apply { setPadding(ctx.dp(12), 0, ctx.dp(12), 0) }

        val card = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(Color.WHITE, radius)
            elevation = ctx.dp(16).toFloat()
            // The plum header follows the card's rounded top corners.
            clipToOutline = true
            if (Build.VERSION.SDK_INT >= 28) {
                outlineSpotShadowColor = Color.parseColor("#EB5757")
                outlineAmbientShadowColor = Color.parseColor("#EB5757")
            }
        }

        /* Header: a plum strip with faint leaves — who, and what just happened */
        val headerBox = FrameLayout(ctx)
        headerBox.addView(CiqArtView(ctx).apply {
            colors = HEADER
            angle = 145f
            leaves = "top"
            leafColor = Color.argb(20, 255, 255, 255)
        }, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        val header = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(ctx.dp(16), ctx.dp(16), ctx.dp(10), ctx.dp(16))
        }
        header.addView(TextView(ctx).apply {
            text = typeLabel.take(1)
            setTextColor(typeColor)
            textSize = 16f
            gravity = Gravity.CENTER
            typeface = font(ctx, 800)
            background = rounded(typeBg, ctx.dp(14).toFloat())
            layoutParams = LinearLayout.LayoutParams(ctx.dp(44), ctx.dp(44)).apply { rightMargin = ctx.dp(12) }
        })
        val titles = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        val title = TextView(ctx).apply {
            text = titleFor(call)
            setTextColor(Color.WHITE)
            textSize = 18f
            typeface = font(ctx, 800)
            maxLines = 1
        }
        val meta = TextView(ctx).apply {
            text = metaLine(call)
            setTextColor(Color.argb(210, 255, 255, 255))
            textSize = 12.5f
            typeface = font(ctx, 500)
            maxLines = 1
        }
        titles.addView(title)
        titles.addView(meta)
        header.addView(titles)
        header.addView(TextView(ctx).apply {
            text = "✕"
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
            background = rounded(Color.argb(36, 255, 255, 255), ctx.dp(18).toFloat())
            layoutParams = LinearLayout.LayoutParams(ctx.dp(36), ctx.dp(36))
            contentDescription = "Close"
            setOnClickListener { onClose() }
        })
        headerBox.addView(header)
        card.addView(headerBox)

        val body = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(ctx.dp(16), ctx.dp(2), ctx.dp(16), ctx.dp(14))
        }

        /* Called by — a shared phone, so the tag says who made the call. Remembered between calls. */
        body.addView(sectionLabel(ctx, "Called by"))
        val callerRow = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
        val callerChips = mutableListOf<TextView>()
        fun paintCallers() {
            val picked = CallIqConfig.calledBy(ctx)
            callerChips.forEach { chip ->
                val on = chip.text.toString() == picked
                chip.setTextColor(if (on) Color.WHITE else INK)
                chip.background = if (on) coral(ctx.dp(20).toFloat()) else rounded(BLUSH, ctx.dp(20).toFloat())
                chip.elevation = if (on) ctx.dp(4).toFloat() else 0f
            }
        }
        CallIqConfig.CALLERS.forEach { name ->
            val chip = TextView(ctx).apply {
                text = name
                textSize = 13f
                typeface = font(ctx, 700)
                gravity = Gravity.CENTER
                maxLines = 1
                setPadding(ctx.dp(6), ctx.dp(9), ctx.dp(6), ctx.dp(9))
                isClickable = true
                setOnClickListener {
                    // Tapping the picked name again clears it.
                    CallIqConfig.setCalledBy(ctx, if (CallIqConfig.calledBy(ctx) == name) "" else name)
                    paintCallers()
                }
            }
            callerChips += chip
            callerRow.addView(chip, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                setMargins(ctx.dp(3), ctx.dp(2), ctx.dp(3), ctx.dp(4))
            })
        }
        paintCallers()
        body.addView(callerRow)

        body.addView(sectionLabel(ctx, "Tag this call"))

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
                textSize = 13.5f
                typeface = font(ctx, 600)
                gravity = Gravity.CENTER_VERTICAL
                setPadding(ctx.dp(14), ctx.dp(13), ctx.dp(10), ctx.dp(13))
                background = rounded(BLUSH, ctx.dp(16).toFloat())
                compoundDrawablePadding = ctx.dp(9)
                val dot = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(color)
                    setSize(ctx.dp(10), ctx.dp(10))
                }
                setCompoundDrawablesRelativeWithIntrinsicBounds(dot, null, null, null)
                isClickable = true
                setOnClickListener {
                    // A tap should feel like it landed, even though the card is about to go.
                    background = rounded(Color.parseColor("#FFE6E3"), ctx.dp(16).toFloat(), ctx.dp(2), ACCENT)
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
        body.addView(grid)

        /* Footer: the coral "Open app" pill, and Skip */
        val footer = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = ctx.dp(12) }
        }
        footer.addView(TextView(ctx).apply {
            text = "Skip"
            setTextColor(MUTE)
            textSize = 13.5f
            typeface = font(ctx, 700)
            gravity = Gravity.CENTER
            background = rounded(BLUSH, ctx.dp(22).toFloat())
            setPadding(ctx.dp(20), ctx.dp(11), ctx.dp(20), ctx.dp(11))
            setOnClickListener { onClose() }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            rightMargin = ctx.dp(8)
        })
        footer.addView(TextView(ctx).apply {
            text = "Open app"
            setTextColor(Color.WHITE)
            textSize = 14f
            typeface = font(ctx, 800)
            gravity = Gravity.CENTER
            background = coral(ctx.dp(22).toFloat())
            setPadding(ctx.dp(16), ctx.dp(11), ctx.dp(16), ctx.dp(11))
            setOnClickListener { onOpenApp() }
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        body.addView(footer)
        card.addView(body)

        outer.addView(card, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT
        ))
        return Card(outer, title, meta)
    }

    /** The thin bar that counts the card down, so it never looks stuck. */
    fun countdownBar(ctx: Context, parent: LinearLayout): View {
        // Under the buttons, inside the card's padded body, clear of the rounded corners.
        val host = (parent.getChildAt(parent.childCount - 1) as? LinearLayout) ?: parent
        val track = FrameLayout(ctx).apply {
            background = rounded(Color.argb(140, 247, 230, 223), ctx.dp(3).toFloat())
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, ctx.dp(5))
                .apply { topMargin = ctx.dp(14); leftMargin = ctx.dp(4); rightMargin = ctx.dp(4) }
        }
        val bar = View(ctx).apply {
            background = coral(ctx.dp(3).toFloat())
            layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, ctx.dp(5))
        }
        track.addView(bar)
        host.addView(track)
        return bar
    }
}
