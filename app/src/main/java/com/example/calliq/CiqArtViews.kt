package com.example.calliq

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.view.View
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp
import kotlin.math.cos
import kotlin.math.sin

/*
 * The two pieces of the Sunset Coral look React Native cannot draw by itself, as plain views:
 *
 *   CiqArt    a linear gradient (CSS angle: 90 = left→right, 180 = top→bottom) with rounded
 *             corners, optionally with translucent botanical leaf silhouettes in its corners.
 *             Used behind buttons, chips, tabs, the home hero and the call screen (src/art.tsx).
 *   CiqDonut  a ring chart: one arc per value, a small gap between them, over a track.
 */

private fun dp(ctx: Context, v: Float) = v * ctx.resources.displayMetrics.density
private fun ints(a: ReadableArray?): IntArray =
    if (a == null) IntArray(0) else IntArray(a.size()) { i -> a.getDouble(i).toLong().toInt() }

class CiqArtView(ctx: Context) : View(ctx) {
    var colors: IntArray = intArrayOf(0, 0)
    var positions: FloatArray? = null
    var angle = 90f
    var corner = 0f
    var leaves = "none"
    var leafColor = 0x22FFFFFF

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)

    /* A backdrop: no size of its own. React Native always gives it an exact size; in a native
       FrameLayout it then takes the size of whatever it sits behind (e.g. the popup's header). */
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        fun size(spec: Int) = if (MeasureSpec.getMode(spec) == MeasureSpec.EXACTLY) MeasureSpec.getSize(spec) else 0
        setMeasuredDimension(size(widthMeasureSpec), size(heightMeasureSpec))
    }

    private val leaf = Paint(Paint.ANTI_ALIAS_FLAG)
    private val vein = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val rect = RectF()
    private val clip = Path()

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return
        rect.set(0f, 0f, w, h)
        clip.reset()
        clip.addRoundRect(rect, corner, corner, Path.Direction.CW)
        canvas.save()
        canvas.clipPath(clip)
        if (colors.isNotEmpty()) {
            // CSS angles: 0deg points up, 90deg right; the line runs through the centre.
            val rad = Math.toRadians(angle.toDouble())
            val dx = sin(rad).toFloat()
            val dy = -cos(rad).toFloat()
            val half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2f
            val cx = w / 2f
            val cy = h / 2f
            val cs = if (colors.size == 1) intArrayOf(colors[0], colors[0]) else colors
            val pos = positions?.takeIf { it.size == cs.size }
            fill.shader = LinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half, cs, pos, Shader.TileMode.CLAMP)
            canvas.drawRect(rect, fill)
        }
        if (leaves != "none") drawLeaves(canvas, w, h)
        canvas.restore()
    }

    /* A small spray of leaves: each a pointed oval made of two curves, with a centre vein. */
    private fun drawLeaves(canvas: Canvas, w: Float, h: Float) {
        leaf.color = leafColor
        vein.color = leafColor
        vein.strokeWidth = dp(context, 1.2f)
        val s = dp(context, 1f)
        val sprays = when (leaves) {
            "corners" -> listOf(Triple(0f, h, -35f), Triple(w, 0f, 145f), Triple(w, h, -145f))
            "bottom" -> listOf(Triple(0f, h, -35f), Triple(w, h, -145f))
            "top" -> listOf(Triple(0f, 0f, 35f), Triple(w, 0f, 145f))
            else -> listOf(Triple(w, h, -145f))
        }
        for ((x, y, rot) in sprays) {
            canvas.save()
            canvas.translate(x, y)
            canvas.rotate(rot)
            // Five leaves fanned along a stem.
            val lens = floatArrayOf(70f, 56f, 62f, 46f, 40f)
            val offs = floatArrayOf(0f, 26f, 44f, 64f, 80f)
            val tilts = floatArrayOf(0f, -38f, 34f, -30f, 28f)
            canvas.drawLine(0f, 0f, 104f * s, 0f, vein)
            for (i in lens.indices) {
                canvas.save()
                canvas.translate(offs[i] * s, 0f)
                canvas.rotate(tilts[i])
                val len = lens[i] * s
                val wid = len * 0.34f
                val p = Path()
                p.moveTo(0f, 0f)
                p.quadTo(len * 0.45f, -wid, len, 0f)
                p.quadTo(len * 0.45f, wid, 0f, 0f)
                p.close()
                canvas.drawPath(p, leaf)
                canvas.drawLine(0f, 0f, len * 0.9f, 0f, vein)
                canvas.restore()
            }
            canvas.restore()
        }
    }
}

class CiqArtManager : SimpleViewManager<CiqArtView>() {
    override fun getName() = "CiqArt"
    override fun createViewInstance(ctx: ThemedReactContext) = CiqArtView(ctx)

    @ReactProp(name = "colors")
    fun setColors(v: CiqArtView, a: ReadableArray?) { v.colors = ints(a); v.invalidate() }

    @ReactProp(name = "locations")
    fun setLocations(v: CiqArtView, a: ReadableArray?) {
        v.positions = a?.let { arr -> FloatArray(arr.size()) { arr.getDouble(it).toFloat() } }
        v.invalidate()
    }

    @ReactProp(name = "angle", defaultFloat = 90f)
    fun setAngle(v: CiqArtView, a: Float) { v.angle = a; v.invalidate() }

    @ReactProp(name = "corner", defaultFloat = 0f)
    fun setCorner(v: CiqArtView, r: Float) { v.corner = dp(v.context, r); v.invalidate() }

    @ReactProp(name = "leaves")
    fun setLeaves(v: CiqArtView, l: String?) { v.leaves = l ?: "none"; v.invalidate() }

    // Already processColor()'d in JS (src/art.tsx), like `colors`: an ARGB number.
    @ReactProp(name = "leafColor", defaultDouble = 0.0)
    fun setLeafColor(v: CiqArtView, c: Double) { v.leafColor = if (c == 0.0) 0x22FFFFFF else c.toLong().toInt(); v.invalidate() }
}

class CiqDonutView(ctx: Context) : View(ctx) {
    var values = FloatArray(0)
    var colors = IntArray(0)
    var thickness = 18f
    var track = 0x11000000
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.BUTT }
    private val oval = RectF()

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val t = dp(context, thickness)
        val size = minOf(width, height).toFloat()
        oval.set((width - size) / 2f + t / 2f, (height - size) / 2f + t / 2f, (width + size) / 2f - t / 2f, (height + size) / 2f - t / 2f)
        paint.strokeWidth = t
        paint.color = track
        canvas.drawArc(oval, 0f, 360f, false, paint)
        val total = values.sum()
        if (total <= 0f) return
        val shown = values.count { it > 0f }
        val gap = if (shown > 1) 3f else 0f
        var start = -90f
        for (i in values.indices) {
            val sweep = values[i] / total * 360f
            if (sweep <= 0f) continue
            paint.color = colors.getOrElse(i) { 0xFF888888.toInt() }
            canvas.drawArc(oval, start + gap / 2f, (sweep - gap).coerceAtLeast(0.5f), false, paint)
            start += sweep
        }
    }
}

class CiqDonutManager : SimpleViewManager<CiqDonutView>() {
    override fun getName() = "CiqDonut"
    override fun createViewInstance(ctx: ThemedReactContext) = CiqDonutView(ctx)

    @ReactProp(name = "values")
    fun setValues(v: CiqDonutView, a: ReadableArray?) {
        v.values = a?.let { arr -> FloatArray(arr.size()) { arr.getDouble(it).toFloat() } } ?: FloatArray(0)
        v.invalidate()
    }

    @ReactProp(name = "colors")
    fun setColors(v: CiqDonutView, a: ReadableArray?) { v.colors = ints(a); v.invalidate() }

    @ReactProp(name = "thickness", defaultFloat = 18f)
    fun setThickness(v: CiqDonutView, t: Float) { v.thickness = t; v.invalidate() }

    @ReactProp(name = "trackColor", defaultDouble = 0.0)
    fun setTrack(v: CiqDonutView, c: Double) { v.track = if (c == 0.0) 0x11000000 else c.toLong().toInt(); v.invalidate() }
}
