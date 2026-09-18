package com.example.calliq

import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import android.util.Log

object CallLogHelper {

    /**
     * One call as the app understands it, SIM already resolved.
     *
     * `fromLog` false means this is what we knew the moment the call ended, before Android had
     * written its call-log row: the popup opens on that immediately and fills the rest in a second
     * or two later. `idempotencyKey` is empty until the row exists, which is why a tag made from
     * the popup is matched on the server by time window rather than by key alone.
     */
    data class CallRecord(
        val number: String,
        val callType: String,
        val duration: Long,
        val timestamp: Long,
        val idempotencyKey: String,
        val accountId: String,
        val sim: SimResolver.Sim,
        val fromLog: Boolean = true,
    )

    /**
     * Sync every call since the last one queued, and return the newest one (what the post-call
     * popup asks about).
     *
     * The SIM is resolved HERE rather than inside the worker: the worker can run minutes later,
     * on a different network, by which time the live "which SIM is busy" capture has expired.
     */
    fun processAndEnqueueRecentCalls(context: Context): CallRecord? {
        val contentResolver = context.contentResolver
        val prefs = context.getSharedPreferences(CallIqConfig.PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()

        /*
         * Catch up from the last call already queued rather than only the last 5 minutes, so
         * calls made while the app was killed (OEM battery savers) still reach the panel.
         * 10 minutes of overlap covers call-log rows written late; the server upserts on
         * idempotency_key, so a re-sent call is harmless. First run looks back 3 days.
         */
        val lastQueued = prefs.getLong("LAST_QUEUED_CALL_TS", 0L)
        val since = if (lastQueued > 0) maxOf(lastQueued - 10 * 60 * 1000, now - 7L * 24 * 3600 * 1000)
                    else now - 3L * 24 * 3600 * 1000
        var newest = lastQueued
        var newestRecord: CallRecord? = null
        var queued = 0

        val selection = "${CallLog.Calls.DATE} > ?"
        val selectionArgs = arrayOf(since.toString())
        val sortOrder = "${CallLog.Calls.DATE} DESC"

        try {
            val cursor = contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                null, // null projection to get all available columns (helps with OEM specific SIM columns)
                selection,
                selectionArgs,
                sortOrder
            )

            cursor?.use {
                val numberIdx = it.getColumnIndex(CallLog.Calls.NUMBER)
                val typeIdx = it.getColumnIndex(CallLog.Calls.TYPE)
                val durationIdx = it.getColumnIndex(CallLog.Calls.DURATION)
                val dateIdx = it.getColumnIndex(CallLog.Calls.DATE)

                // Standard and OEM-specific SIM columns. The component name turns PHONE_ACCOUNT_ID
                // into a real PhoneAccountHandle, which is the only exact way back to a slot.
                val simIdIdx = it.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_ID)
                val componentIdx = it.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME)
                val subIdIdx = it.getColumnIndex("subscription_id")
                val subIdAltIdx = it.getColumnIndex("sub_id")
                val simIdOemIdx = it.getColumnIndex("simid")
                val simIdOemAltIdx = it.getColumnIndex("sim_id")

                while (it.moveToNext() && queued < 500) {
                    queued++
                    val number = if (numberIdx != -1) it.getString(numberIdx) ?: "UNKNOWN" else "UNKNOWN"
                    val rawType = if (typeIdx != -1) it.getInt(typeIdx) else -1
                    val duration = if (durationIdx != -1) it.getLong(durationIdx) else 0L
                    val date = if (dateIdx != -1) it.getLong(dateIdx) else System.currentTimeMillis()

                    val phoneAccountId = if (simIdIdx != -1) it.getString(simIdIdx) else null
                    val component = if (componentIdx != -1) it.getString(componentIdx) else null
                    val subId = if (subIdIdx != -1) it.getString(subIdIdx) else null
                    val subIdAlt = if (subIdAltIdx != -1) it.getString(subIdAltIdx) else null
                    val simIdOem = if (simIdOemIdx != -1) it.getString(simIdOemIdx) else null
                    val simIdOemAlt = if (simIdOemAltIdx != -1) it.getString(simIdOemAltIdx) else null

                    val rawSimId = listOf(phoneAccountId, subId, subIdAlt, simIdOem, simIdOemAlt)
                        .firstOrNull { v -> !v.isNullOrBlank() } ?: ""

                    val sim = SimResolver.resolve(context, rawSimId, component, date)

                    val callTypeStr = when (rawType) {
                        CallLog.Calls.INCOMING_TYPE -> "INCOMING"
                        CallLog.Calls.OUTGOING_TYPE -> "OUTGOING"
                        CallLog.Calls.MISSED_TYPE -> "MISSED"
                        CallLog.Calls.REJECTED_TYPE -> "REJECTED"
                        else -> "UNKNOWN_TYPE_$rawType"
                    }

                    val idempotencyKey = "${number}_${date}"

                    Log.d("CallLogHelper", "Call: number=$number type=$callTypeStr dur=$duration " +
                        "account=$rawSimId → ${sim.display} (via ${sim.source}) date=$date")

                    CallSyncWorker.schedule(
                        context = context,
                        number = number,
                        callType = callTypeStr,
                        duration = duration,
                        simId = rawSimId,
                        timestamp = date,
                        idempotencyKey = idempotencyKey,
                        simSlot = sim.slot ?: 0,
                        simCarrier = sim.carrier,
                        simLabel = sim.label,
                        simSource = sim.source
                    )

                    // Rows come back newest first, so the first one is the call that just ended.
                    if (newestRecord == null) newestRecord = CallRecord(number, callTypeStr, duration, date, idempotencyKey, rawSimId, sim)
                    if (date > newest) newest = date
                }
            }
            if (newest > lastQueued) prefs.edit().putLong("LAST_QUEUED_CALL_TS", newest).apply()
        } catch (e: PackageManager.NameNotFoundException) {
            Log.e("CallLogHelper", "OPlus/ColorOS OEM package lookup failed during call log query: ${e.message}", e)
        } catch (e: Exception) {
            Log.e("CallLogHelper", "Error querying call log content provider: ${e.message}", e)
        } catch (e: Throwable) {
            Log.e("CallLogHelper", "Unexpected throwable during call log query: ${e.message}", e)
        }
        return newestRecord
    }

    /**
     * The call the popup is waiting for: the newest row at or after `sinceMs`, optionally for a
     * known number. Used to fill in a popup that opened before Android wrote the row.
     */
    fun findCallSince(context: Context, sinceMs: Long, numberNorm: String): CallRecord? {
        val latest = latestCall(context) ?: return null
        // Allow a little slack: the log's timestamp is when the call STARTED, and our clock for
        // "when it started" can differ by a second or two.
        if (latest.timestamp < sinceMs - 15_000) return null
        if (numberNorm.isNotEmpty()) {
            val got = latest.number.filter { it.isDigit() }.takeLast(10)
            if (got.isNotEmpty() && got != numberNorm.takeLast(10)) return null
        }
        return latest
    }

    /** The most recent call in the log, regardless of what has already been synced. */
    fun latestCall(context: Context): CallRecord? {
        try {
            val cursor = context.contentResolver.query(
                CallLog.Calls.CONTENT_URI, null, null, null, "${CallLog.Calls.DATE} DESC"
            ) ?: return null
            cursor.use {
                if (!it.moveToFirst()) return null
                val number = it.getColumnIndex(CallLog.Calls.NUMBER).let { i -> if (i != -1) it.getString(i) ?: "UNKNOWN" else "UNKNOWN" }
                val rawType = it.getColumnIndex(CallLog.Calls.TYPE).let { i -> if (i != -1) it.getInt(i) else -1 }
                val duration = it.getColumnIndex(CallLog.Calls.DURATION).let { i -> if (i != -1) it.getLong(i) else 0L }
                val date = it.getColumnIndex(CallLog.Calls.DATE).let { i -> if (i != -1) it.getLong(i) else System.currentTimeMillis() }
                val account = it.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_ID).let { i -> if (i != -1) it.getString(i) ?: "" else "" }
                val component = it.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME).let { i -> if (i != -1) it.getString(i) else null }
                val callTypeStr = when (rawType) {
                    CallLog.Calls.INCOMING_TYPE -> "INCOMING"
                    CallLog.Calls.OUTGOING_TYPE -> "OUTGOING"
                    CallLog.Calls.MISSED_TYPE -> "MISSED"
                    CallLog.Calls.REJECTED_TYPE -> "REJECTED"
                    else -> "UNKNOWN_TYPE_$rawType"
                }
                return CallRecord(number, callTypeStr, duration, date, "${number}_${date}", account,
                    SimResolver.resolve(context, account, component, date))
            }
        } catch (e: Throwable) {
            Log.e("CallLogHelper", "latestCall failed: ${e.message}", e)
            return null
        }
    }
}
