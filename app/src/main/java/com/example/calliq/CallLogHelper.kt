package com.example.calliq

import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import android.util.Log

object CallLogHelper {

    fun processAndEnqueueRecentCalls(context: Context) {
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
                
                // Probe for standard and OEM-specific SIM columns
                val simIdIdx = it.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_ID)
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

                    var rawSimId: String? = null
                    
                    val phoneAccountId = if (simIdIdx != -1) it.getString(simIdIdx) else null
                    val subId = if (subIdIdx != -1) it.getString(subIdIdx) else null
                    val subIdAlt = if (subIdAltIdx != -1) it.getString(subIdAltIdx) else null
                    val simIdOem = if (simIdOemIdx != -1) it.getString(simIdOemIdx) else null
                    val simIdOemAlt = if (simIdOemAltIdx != -1) it.getString(simIdOemAltIdx) else null

                    if (!phoneAccountId.isNullOrBlank()) rawSimId = phoneAccountId
                    else if (!subId.isNullOrBlank()) rawSimId = subId
                    else if (!subIdAlt.isNullOrBlank()) rawSimId = subIdAlt
                    else if (!simIdOem.isNullOrBlank()) rawSimId = simIdOem
                    else if (!simIdOemAlt.isNullOrBlank()) rawSimId = simIdOemAlt

                    val simId = rawSimId ?: "0"

                    val callTypeStr = when (rawType) {
                        CallLog.Calls.INCOMING_TYPE -> "INCOMING"
                        CallLog.Calls.OUTGOING_TYPE -> "OUTGOING"
                        CallLog.Calls.MISSED_TYPE -> "MISSED"
                        CallLog.Calls.REJECTED_TYPE -> "REJECTED"
                        else -> "UNKNOWN_TYPE_$rawType"
                    }

                    val idempotencyKey = "${number}_${date}"

                    Log.d("CallLogHelper", "Extracted Call: number=$number, type=$callTypeStr, duration=$duration, simId=$simId, date=$date, key=$idempotencyKey")

                    CallSyncWorker.schedule(
                        context = context,
                        number = number,
                        callType = callTypeStr,
                        duration = duration,
                        simId = simId,
                        timestamp = date,
                        idempotencyKey = idempotencyKey
                    )
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
    }
}