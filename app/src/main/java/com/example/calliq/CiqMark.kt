package com.example.calliq

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import android.view.animation.PathInterpolator
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/*
 * The CallIQ mark, "Signal C": three sound-wave arcs radiating from a small core, together
 * reading as a C that opens to the right — a voice going out — with a four-point spark at the
 * opening for the "IQ". The same geometry as res/drawable/ic_launcher_foreground.xml.
 *
 *   tone  "dark"  (default) for dark grounds: ember, flame and glow arcs, a white spark
 *         "light" for light grounds: the same family a step deeper, an ink spark
 *   play  true draws the mark in: each arc sweeps from its lower end, outer first, then the core
 *         lands and the spark pops. Runs on the UI thread, so a busy JS thread cannot stutter it.
 */
class CiqMarkView(ctx: Context) : View(ctx) {
    var tone = "dark"
        set(v) { field = v; invalidate() }

    private var progress = 1f
    private var animator: ValueAnimator? = null
    private var played = false

    // Ember, flame, glow (outer → inner), the core and the spark.
    private val darkColors = intArrayOf(0xFFFF5A4E.toInt(), 0xFFFF8A5B.toInt(), 0xFFFFC27A.toInt(), 0xFFFFC27A.toInt(), 0xFFFFFFFF.toInt())
    private val lightColors = intArrayOf(0xFFE8443A.toInt(), 0xFFF06A3C.toInt(), 0xFFF2994A.toInt(), 0xFFF2994A.toInt(), 0xFF1F1714.toInt())

    private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val oval = RectF()
    private val star = Path()

    // Radius (share of the half-size) and the opening of each arc, in degrees, centred on the right.
    private val radii = floatArrayOf(0.80f, 0.54f, 0.28f)
    private val gaps = floatArrayOf(100f, 76f, 60f)
    private val ease = PathInterpolator(0.2f, 0f, 0f, 1f)

    fun play(on: Boolean) {
        if (!on || played) return
        played = true
        progress = 0f
        animator?.cancel()
        animator = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1250
            startDelay = 120
            addUpdateListener { progress = it.animatedValue as Float; invalidate() }
            start()
        }
    }

    override fun onDetachedFromWindow() {
        animator?.cancel()
        super.onDetachedFromWindow()
    }

    /* A stage of the reveal: 0 before `from`, 1 after `to`, eased in between. */
    private fun stage(from: Float, to: Float): Float {
        val p = ((progress - from) / (to - from)).coerceIn(0f, 1f)
        return ease.getInterpolation(p)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val size = min(width, height).toFloat()
        if (size <= 0f) return
        val c = if (tone == "light") lightColors else darkColors
        val cx = width / 2f - size * 0.04f          // nudged left: the spark sits out to the right
        val cy = height / 2f
        val half = size * 0.40f
        arc.strokeWidth = size * 0.085f

        for (i in 0..2) {
            val p = stage(i * 0.14f, 0.55f + i * 0.14f)
            if (p <= 0f) continue
            val r = half * radii[i]
            oval.set(cx - r, cy - r, cx + r, cy + r)
            val start = gaps[i] / 2f                 // the lower end of the opening (y grows down)
            val sweep = (360f - gaps[i]) * p
            arc.color = c[i]
            arc.alpha = (255 * min(1f, p * 2.5f)).toInt()
            canvas.drawArc(oval, start, sweep, false, arc)
        }

        // The core: a dot at the centre the waves come from.
        val core = stage(0.55f, 0.78f)
        if (core > 0f) {
            fill.color = c[3]
            fill.alpha = 255
            canvas.drawCircle(cx, cy, size * 0.052f * core, fill)
        }

        // The spark: a four-point star at the top of the opening, popping a little past full size.
        val sp = stage(0.70f, 1f)
        if (sp > 0f) {
            val pop = if (sp < 0.7f) sp / 0.7f * 1.18f else 1.18f - (sp - 0.7f) / 0.3f * 0.18f
            val a = Math.toRadians(-48.0)
            val sx = cx + (half * 0.98f * cos(a)).toFloat()
            val sy = cy + (half * 0.98f * sin(a)).toFloat()
            val o = size * 0.105f * pop               // outer point
            val n = o * 0.30f                          // the waist
            star.reset()
            star.moveTo(sx, sy - o)
            star.lineTo(sx + n, sy - n)
            star.lineTo(sx + o, sy)
            star.lineTo(sx + n, sy + n)
            star.lineTo(sx, sy + o)
            star.lineTo(sx - n, sy + n)
            star.lineTo(sx - o, sy)
            star.lineTo(sx - n, sy - n)
            star.close()
            fill.color = c[4]
            fill.alpha = (255 * min(1f, sp * 2f)).toInt()
            canvas.drawPath(star, fill)
        }
    }
}

/*
 * A soft glow: one radial gradient from `color` at the centre to transparent at the edge, so it
 * falls off smoothly (stacked translucent discs band into rings). The intro scales and fades it.
 */
class CiqGlowView(ctx: Context) : View(ctx) {
    var color = 0xFFFF5A4E.toInt()
        set(v) { field = v; shaderFor = 0f; invalidate() }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var shaderFor = 0f

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val r = min(width, height) / 2f
        if (r <= 0f) return
        if (shaderFor != r) {
            val c = color and 0x00FFFFFF
            // Strong in the middle, a long gentle tail: alpha 0.38 → 0.16 → 0.05 → 0.
            paint.shader = android.graphics.RadialGradient(
                width / 2f, height / 2f, r,
                intArrayOf(c or (0x61 shl 24), c or (0x29 shl 24), c or (0x0D shl 24), c),
                floatArrayOf(0f, 0.32f, 0.66f, 1f),
                android.graphics.Shader.TileMode.CLAMP,
            )
            shaderFor = r
        }
        canvas.drawCircle(width / 2f, height / 2f, r, paint)
    }
}

class CiqGlowManager : SimpleViewManager<CiqGlowView>() {
    override fun getName() = "CiqGlow"
    override fun createViewInstance(ctx: ThemedReactContext) = CiqGlowView(ctx)

    @ReactProp(name = "color", customType = "Color")
    fun setColor(v: CiqGlowView, color: Int?) { if (color != null) v.color = color }
}

class CiqMarkManager : SimpleViewManager<CiqMarkView>() {
    override fun getName() = "CiqMark"
    override fun createViewInstance(ctx: ThemedReactContext) = CiqMarkView(ctx)

    @ReactProp(name = "tone")
    fun setTone(v: CiqMarkView, tone: String?) { v.tone = tone ?: "dark" }

    @ReactProp(name = "play", defaultBoolean = false)
    fun setPlay(v: CiqMarkView, play: Boolean) { v.play(play) }
}
