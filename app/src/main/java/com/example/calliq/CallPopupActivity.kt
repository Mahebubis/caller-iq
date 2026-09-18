package com.example.calliq

import android.animation.ValueAnimator
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * The post-call card as a real screen.
 *
 * [CallPopupOverlay] is the better experience — it floats over whatever is on screen with no tap at
 * all — but it needs "Display over other apps". This activity needs no permission whatsoever, and
 * carries exactly the same card and the same full set of outcomes. It is used when:
 *
 *   · the counselor taps the post-call notification, or
 *   · the phone is locked when the call ends, where the notification's full-screen intent brings
 *     this up directly (showWhenLocked + turnScreenOn), which is how a dialer shows an incoming
 *     call and is the one route Android leaves open to an app without the overlay permission.
 */
class CallPopupActivity : Activity() {

    private val main = Handler(Looper.getMainLooper())
    private var call: CallLogHelper.CallRecord? = null
    private var titleView: TextView? = null
    private var metaView: TextView? = null
    private var closed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Show over the lock screen and wake the display, the same way a call screen does.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.parseColor("#66000000")))

        val record = fromIntent(intent)
        call = record

        val container = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
            )
            // Tapping the dimmed area behind the card dismisses it, like any dialog.
            setOnClickListener { finishCard() }
        }

        val card = CallPopupView.build(
            ctx = this,
            call = record,
            onTag = { outcome -> tag(outcome) },
            onClose = { finishCard() },
            onOpenApp = {
                startActivity(Intent(this, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                })
                finishCard()
            },
        )
        titleView = card.title
        metaView = card.meta

        val holder = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP
            ).apply { topMargin = with(CallPopupView) { dp(36) } }
            addView(card.root)
        }
        container.addView(holder)
        setContentView(container)

        // Slide + fade in, then count down to closing itself.
        holder.alpha = 0f
        holder.translationY = -with(CallPopupView) { dp(28) }.toFloat()
        holder.animate().alpha(1f).translationY(0f).setDuration(240).start()

        val timeout = CallIqConfig.popupTimeoutSec(this) * 1000L
        (card.root as? FrameLayout)?.let { addCountdown(it, timeout) }
        main.postDelayed({ finishCard() }, timeout)

        lastShownAt = System.currentTimeMillis()
        CallPopupNotifier.cancel(this)
        CallIqConfig.notePopup(this, "opened the full popup screen")

        // Opened before Android wrote the call-log row: fill in the details when it lands.
        if (!record.fromLog) scheduleLookup(record, 0)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.let {
            call = fromIntent(it)
            titleView?.text = CallPopupView.titleFor(call!!)
            metaView?.text = CallPopupView.metaLine(call!!)
        }
    }

    private fun addCountdown(cardRoot: FrameLayout, timeout: Long) {
        val column = cardRoot.getChildAt(0) as? LinearLayout ?: return
        val bar = CallPopupView.countdownBar(this, column)
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

    private val lookupDelays = longArrayOf(500, 1000, 1500, 2500, 4000, 6000, 9000)

    private fun scheduleLookup(opened: CallLogHelper.CallRecord, index: Int) {
        if (index >= lookupDelays.size) return
        main.postDelayed({
            if (closed) return@postDelayed
            val found = try {
                CallLogHelper.findCallSince(this, opened.timestamp, opened.number.filter { it.isDigit() }.takeLast(10))
            } catch (e: Throwable) { null }
            if (found != null) {
                call = found
                titleView?.text = CallPopupView.titleFor(found)
                metaView?.text = CallPopupView.metaLine(found)
            } else {
                scheduleLookup(opened, index + 1)
            }
        }, if (index == 0) lookupDelays[0] else lookupDelays[index] - lookupDelays[index - 1])
    }

    private fun tag(outcome: String) {
        val c = call
        try {
            TagWorker.schedule(
                context = applicationContext,
                outcome = outcome,
                number = c?.number ?: "",
                startedMs = c?.timestamp ?: System.currentTimeMillis(),
                idempotencyKey = c?.idempotencyKey ?: "",
                via = "popup",
            )
            Toast.makeText(applicationContext, "Tagged \"$outcome\"", Toast.LENGTH_SHORT).show()
            CallIqConfig.notePopup(applicationContext, "tagged \"$outcome\" from the popup screen")
        } catch (e: Throwable) {
            Toast.makeText(applicationContext, "Could not save the tag", Toast.LENGTH_SHORT).show()
        }
        CallPopupNotifier.cancel(applicationContext)
        finishCard()
    }

    /** Back closes the card, exactly as it closes any dialog — never the counselor's own app. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        finishCard()
    }

    private fun finishCard() {
        if (closed) return
        closed = true
        main.removeCallbacksAndMessages(null)
        finish()
        overridePendingTransition(0, android.R.anim.fade_out)
    }

    override fun onDestroy() {
        closed = true
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    companion object {
        /** When this screen last actually appeared, so the launcher can tell a silent block apart. */
        @Volatile private var lastShownAt: Long = 0L

        fun shownSince(ms: Long): Boolean = lastShownAt >= ms

        /** Everything the card needs, carried in the intent — no shared state to go stale. */
        fun intentFor(context: Context, call: CallLogHelper.CallRecord): Intent =
            Intent(context, CallPopupActivity::class.java).apply {
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP or
                        Intent.FLAG_ACTIVITY_NO_HISTORY or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                )
                putExtra("number", call.number)
                putExtra("call_type", call.callType)
                putExtra("duration", call.duration)
                putExtra("timestamp", call.timestamp)
                putExtra("idempotency_key", call.idempotencyKey)
                putExtra("account_id", call.accountId)
                putExtra("sim_slot", call.sim.slot ?: 0)
                putExtra("sim_label", call.sim.label)
                putExtra("sim_carrier", call.sim.carrier)
                putExtra("sim_source", call.sim.source)
                putExtra("from_log", call.fromLog)
                data = android.net.Uri.parse("calliq://popup/${call.timestamp}")
            }

        private fun fromIntent(intent: Intent): CallLogHelper.CallRecord {
            val slot = intent.getIntExtra("sim_slot", 0)
            return CallLogHelper.CallRecord(
                number = intent.getStringExtra("number") ?: "",
                callType = intent.getStringExtra("call_type") ?: "UNKNOWN",
                duration = intent.getLongExtra("duration", 0L),
                timestamp = intent.getLongExtra("timestamp", System.currentTimeMillis()),
                idempotencyKey = intent.getStringExtra("idempotency_key") ?: "",
                accountId = intent.getStringExtra("account_id") ?: "",
                sim = SimResolver.Sim(
                    slot = if (slot > 0) slot else null,
                    carrier = intent.getStringExtra("sim_carrier") ?: "",
                    label = intent.getStringExtra("sim_label") ?: "",
                    source = intent.getStringExtra("sim_source") ?: "",
                    subId = null,
                ),
                fromLog = intent.getBooleanExtra("from_log", false),
            )
        }
    }
}
