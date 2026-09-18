package com.example.calliq

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.CallLog
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.facebook.react.bridge.*

class CallBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "CallBridge"

    @ReactMethod
    fun checkPermissions(promise: Promise) {
        try {
            val readCallLog = ContextCompat.checkSelfPermission(
                reactApplicationContext,
                Manifest.permission.READ_CALL_LOG
            ) == PackageManager.PERMISSION_GRANTED

            val readPhoneState = ContextCompat.checkSelfPermission(
                reactApplicationContext,
                Manifest.permission.READ_PHONE_STATE
            ) == PackageManager.PERMISSION_GRANTED

            promise.resolve(readCallLog && readPhoneState)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun requestPermissions(promise: Promise) {
        try {
            val activity = currentActivity
            if (activity == null) {
                promise.resolve(false)
                return
            }

            val permissions = mutableListOf(
                Manifest.permission.READ_CALL_LOG,
                Manifest.permission.READ_PHONE_STATE
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                permissions.add(Manifest.permission.READ_PHONE_NUMBERS)
            }

            ActivityCompat.requestPermissions(activity, permissions.toTypedArray(), 1001)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getTrackingStatus(promise: Promise) {
        try {
            val readCallLog = ContextCompat.checkSelfPermission(
                reactApplicationContext,
                Manifest.permission.READ_CALL_LOG
            ) == PackageManager.PERMISSION_GRANTED

            val readPhoneState = ContextCompat.checkSelfPermission(
                reactApplicationContext,
                Manifest.permission.READ_PHONE_STATE
            ) == PackageManager.PERMISSION_GRANTED

            val permissionsGranted = readCallLog && readPhoneState

            val prefs = reactApplicationContext.getSharedPreferences("call_tracker_prefs", Context.MODE_PRIVATE)
            val defaultEndpoint = "https://adp.internshipstudio.com/api/log_call.php"
            val currentEndpoint = prefs.getString("SYNC_ENDPOINT", defaultEndpoint) ?: defaultEndpoint

            val result = Arguments.createMap().apply {
                putBoolean("permissionsGranted", permissionsGranted)
                putBoolean("trackingActive", permissionsGranted)
                putString("syncEndpoint", currentEndpoint)
            }
            promise.resolve(result)
        } catch (e: Throwable) {
            val result = Arguments.createMap().apply {
                putBoolean("permissionsGranted", false)
                putBoolean("trackingActive", false)
                putString("syncEndpoint", "https://adp.internshipstudio.com/api/log_call.php")
            }
            promise.resolve(result)
        }
    }

    @ReactMethod
    fun setSyncEndpoint(endpoint: String, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences("call_tracker_prefs", Context.MODE_PRIVATE)
            prefs.edit().putString("SYNC_ENDPOINT", endpoint).apply()
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun triggerManualSync(promise: Promise) {
        try {
            CallLogHelper.processAndEnqueueRecentCalls(reactApplicationContext)
            val result = Arguments.createMap().apply {
                putBoolean("success", true)
                putString("message", "Manual call log sync initiated successfully.")
            }
            promise.resolve(result)
        } catch (e: Throwable) {
            val result = Arguments.createMap().apply {
                putBoolean("success", false)
                putString("message", "Sync trigger error: ${e.message}")
            }
            promise.resolve(result)
        }
    }

    @ReactMethod
    fun getRecentCalls(promise: Promise) {
        getRecentCallLogs(50, promise)
    }

    @ReactMethod
    fun getRecentCallLogs(limit: Int, promise: Promise) {
        try {
            val readCallLog = ContextCompat.checkSelfPermission(
                reactApplicationContext,
                Manifest.permission.READ_CALL_LOG
            ) == PackageManager.PERMISSION_GRANTED

            val array = Arguments.createArray()

            if (!readCallLog) {
                promise.resolve(array)
                return
            }

            val queryLimit = if (limit <= 0) 50 else limit

            val cursor = reactApplicationContext.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                null, // null projection to get all available columns (helps with OEM specific SIM columns)
                null,
                null,
                "${CallLog.Calls.DATE} DESC"
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

                var count = 0
                while (it.moveToNext() && count < queryLimit) {
                    count++
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

                    val simIdRawToPass = rawSimId ?: "0"
                    
                    // Route through the new unified resolver to get a clean "SIM 1" or "SIM 2"
                    val resolvedSim = CallIqConfig.resolveSim(reactApplicationContext, simIdRawToPass)
                    val simIdStr = "SIM ${resolvedSim.slot}"

                    val callTypeStr = when (rawType) {
                        CallLog.Calls.INCOMING_TYPE -> "INCOMING"
                        CallLog.Calls.OUTGOING_TYPE -> "OUTGOING"
                        CallLog.Calls.MISSED_TYPE -> "MISSED"
                        CallLog.Calls.REJECTED_TYPE -> "REJECTED"
                        else -> "UNKNOWN"
                    }

                    val idempotencyKey = "${number}_${date}"

                    val item = Arguments.createMap().apply {
                        putString("number", number)
                        putString("callType", callTypeStr)
                        putDouble("duration", duration.toDouble())
                        putDouble("timestamp", date.toDouble())
                        putString("simId", simIdStr)
                        putString("idempotencyKey", idempotencyKey)
                    }
                    array.pushMap(item)
                }
            }

            promise.resolve(array)
        } catch (e: Throwable) {
            promise.resolve(Arguments.createArray())
        }
    }

    @ReactMethod
    fun isBatteryOptimizationIgnored(promise: Promise) {
        try {
            val pm = reactApplicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
            val isIgnored = pm?.isIgnoringBatteryOptimizations(reactApplicationContext.packageName) ?: false
            promise.resolve(isIgnored)
        } catch (e: Throwable) {
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun requestIgnoreBatteryOptimizations(promise: Promise) {
        try {
            val pm = reactApplicationContext.getSystemService(Context.POWER_SERVICE) as? PowerManager
            val isIgnored = pm?.isIgnoringBatteryOptimizations(reactApplicationContext.packageName) ?: false

            if (!isIgnored) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:${reactApplicationContext.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactApplicationContext.startActivity(intent)
            }
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getPendingQueueCount(promise: Promise) {
        try {
            val workManager = WorkManager.getInstance(reactApplicationContext)
            val future = workManager.getWorkInfosByTag("CallSyncWorker")
            future.addListener({
                try {
                    val workInfos = future.get()
                    var enqueuedCount = 0
                    for (info in workInfos) {
                        if (info.state == WorkInfo.State.ENQUEUED || info.state == WorkInfo.State.RUNNING) {
                            enqueuedCount++
                        }
                    }
                    promise.resolve(enqueuedCount)
                } catch (e: Throwable) {
                    promise.resolve(0)
                }
            }, { command -> Thread(command).start() })
        } catch (e: Throwable) {
            promise.resolve(0)
        }
    }

    @ReactMethod
    fun syncCallOutcome(
        number: String,
        callType: String,
        duration: Double,
        simId: String,
        timestamp: Double,
        idempotencyKey: String,
        outcome: String,
        promise: Promise
    ) {
        try {
            CallSyncWorker.schedule(
                context = reactApplicationContext,
                number = number,
                callType = callType,
                duration = duration.toLong(),
                simId = simId,
                timestamp = timestamp.toLong(),
                idempotencyKey = idempotencyKey,
                outcome = outcome
            )
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun saveSimNicknames(nicknamesJson: String, promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences("call_tracker_prefs", Context.MODE_PRIVATE)
            prefs.edit().putString("SIM_NICKNAMES", nicknamesJson).apply()
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getSimNicknames(promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences("call_tracker_prefs", Context.MODE_PRIVATE)
            val nicknamesJson = prefs.getString("SIM_NICKNAMES", "{}") ?: "{}"
            promise.resolve(nicknamesJson)
        } catch (e: Throwable) {
            promise.resolve("{}")
        }
    }
}
