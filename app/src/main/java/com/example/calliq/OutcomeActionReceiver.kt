package com.example.calliq

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast

/**
 * Handles a tap on one of the notification's outcome buttons: queues the tag for the dashboard and
 * clears the notification. The overlay popup calls [CallSyncWorker] directly and never comes here.
 */
class OutcomeActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_TAG) return
        val app = context.applicationContext
        val outcome = intent.getStringExtra(EXTRA_OUTCOME) ?: return
        val number = intent.getStringExtra("number") ?: return
        val timestamp = intent.getLongExtra("timestamp", 0L)
        if (timestamp <= 0L) return

        try {
            // Same delivery as the popup: matched on the server by the call's start time, so a tag
            // made before the call has synced still lands on that call rather than making a new one.
            TagWorker.schedule(
                context = app,
                outcome = outcome,
                number = number,
                startedMs = timestamp,
                idempotencyKey = intent.getStringExtra("idempotency_key") ?: "",
                via = "notification",
            )
            Toast.makeText(app, "Tagged \"$outcome\"", Toast.LENGTH_SHORT).show()
        } catch (e: Throwable) {
            Log.e("OutcomeActionReceiver", "Could not queue the tag: ${e.message}", e)
        }
        CallPopupNotifier.cancel(app)
        CallPopupOverlay.dismiss(app)
    }

    companion object {
        const val ACTION_TAG = "com.example.calliq.TAG_OUTCOME"
        const val EXTRA_OUTCOME = "outcome"

        fun intentFor(context: Context, call: CallLogHelper.CallRecord, outcome: String) =
            Intent(context, OutcomeActionReceiver::class.java).apply {
                action = ACTION_TAG
                putExtra(EXTRA_OUTCOME, outcome)
                putExtra("number", call.number)
                putExtra("call_type", call.callType)
                putExtra("duration", call.duration)
                putExtra("timestamp", call.timestamp)
                putExtra("idempotency_key", call.idempotencyKey)
                putExtra("sim_id", call.accountId)
                putExtra("sim_slot", call.sim.slot ?: 0)
                putExtra("sim_carrier", call.sim.carrier)
                putExtra("sim_label", call.sim.label)
                putExtra("sim_source", call.sim.source)
                // One notification is reused per call, so the extras must differ per call.
                data = android.net.Uri.parse("calliq://tag/${call.idempotencyKey}/$outcome")
            }
    }
}
