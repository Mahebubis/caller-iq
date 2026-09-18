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
            // Android 13+ needs consent before the post-call notification can appear.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                permissions.add(Manifest.permission.POST_NOTIFICATIONS)
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

            val result = Arguments.createMap().apply {
                putBoolean("permissionsGranted", permissionsGranted)
                putBoolean("trackingActive", permissionsGranted)
                putString("syncEndpoint", CallIqConfig.endpoint(reactApplicationContext))
                // Post-call popup state, so the app can nudge for what is missing.
                putBoolean("overlayGranted", CallPopupOverlay.canShow(reactApplicationContext))
                putBoolean("popupEnabled", CallIqConfig.popupEnabled(reactApplicationContext))
                putBoolean("popupForMissed", CallIqConfig.popupForMissed(reactApplicationContext))
                putInt("popupTimeoutSec", CallIqConfig.popupTimeoutSec(reactApplicationContext))
                putInt("simCount", SimResolver.activeSubscriptions(reactApplicationContext).size)
            }
            promise.resolve(result)
        } catch (e: Throwable) {
            val result = Arguments.createMap().apply {
                putBoolean("permissionsGranted", false)
                putBoolean("trackingActive", false)
                putString("syncEndpoint", CallIqConfig.DEFAULT_ENDPOINT)
                putBoolean("overlayGranted", false)
                putBoolean("popupEnabled", true)
                putBoolean("popupForMissed", true)
                putInt("popupTimeoutSec", 45)
                putInt("simCount", 0)
            }
            promise.resolve(result)
        }
    }

    /* ── Post-call popup ──────────────────────────────────────────────────── */

    @ReactMethod
    fun canDrawOverlays(promise: Promise) {
        promise.resolve(CallPopupOverlay.canShow(reactApplicationContext))
    }

    /** Opens the system screen; Android gives no way to grant this silently. */
    @ReactMethod
    fun requestOverlayPermission(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(reactApplicationContext)) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:${reactApplicationContext.packageName}")
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactApplicationContext.startActivity(intent)
            }
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun setPopupSettings(enabled: Boolean, forMissed: Boolean, timeoutSec: Int, promise: Promise) {
        try {
            CallIqConfig.prefs(reactApplicationContext).edit()
                .putBoolean(CallIqConfig.KEY_POPUP_ENABLED, enabled)
                .putBoolean(CallIqConfig.KEY_POPUP_MISSED, forMissed)
                .putInt(CallIqConfig.KEY_POPUP_TIMEOUT, timeoutSec)
                .apply()
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    /** Shows the popup for the most recent call, so the counselor can see what it looks like. */
    @ReactMethod
    fun showPopupForLastCall(promise: Promise) {
        try {
            val record = CallLogHelper.latestCall(reactApplicationContext)
            if (record == null) {
                promise.resolve(false)
                return
            }
            CallIqConfig.prefs(reactApplicationContext).edit().remove(CallIqConfig.KEY_LAST_POPUP_KEY).apply()
            CallPopupLauncher.show(reactApplicationContext, record)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    /**
     * Everything that decides whether the post-call popup can appear, so the app can show a
     * checklist instead of the counselor wondering why nothing happened.
     */
    @ReactMethod
    fun getPopupReadiness(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val notifications = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            } else {
                androidx.core.app.NotificationManagerCompat.from(ctx).areNotificationsEnabled()
            }
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
            val result = Arguments.createMap().apply {
                putBoolean("enabled", CallIqConfig.popupEnabled(ctx))
                putBoolean("overlay", CallPopupOverlay.canShow(ctx))
                putBoolean("notifications", notifications)
                putBoolean("battery", pm?.isIgnoringBatteryOptimizations(ctx.packageName) ?: true)
                putBoolean("callLog", ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED)
                putBoolean("needsOemSteps", OemSettings.needsExtraSteps())
                putString("manufacturer", OemSettings.manufacturer())
                putString("oemSteps", OemSettings.extraStepsText())
                putString("lastNote", CallIqConfig.popupNote(ctx))
                putDouble("lastNoteAt", CallIqConfig.popupNoteAt(ctx).toDouble())
            }
            promise.resolve(result)
        } catch (e: Throwable) {
            promise.reject("readiness_failed", e)
        }
    }

    /** Opens the OEM screen that owns one of the switches the popup depends on. */
    @ReactMethod
    fun openOemSetting(kind: String, promise: Promise) {
        try {
            val ok = when (kind) {
                "popup" -> OemSettings.openBackgroundPopupSettings(reactApplicationContext)
                "autostart" -> OemSettings.openAutostartSettings(reactApplicationContext)
                "notifications" -> OemSettings.openNotificationSettings(reactApplicationContext)
                else -> false
            }
            promise.resolve(ok)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    /**
     * Rehearse a real call ending, using the same code path the phone-state receiver takes — the
     * honest way to prove the popup works without having to call someone.
     */
    @ReactMethod
    fun simulateCallEnd(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            CallIqConfig.prefs(ctx).edit().remove(CallIqConfig.KEY_LAST_POPUP_KEY).apply()
            val record = CallLogHelper.latestCall(ctx) ?: CallLogHelper.CallRecord(
                number = "", callType = "OUTGOING", duration = 0L,
                timestamp = System.currentTimeMillis(), idempotencyKey = "", accountId = "",
                sim = SimResolver.resolve(ctx, "", null, System.currentTimeMillis()), fromLog = false,
            )
            CallReceiver.maybePrompt(ctx, record.copy(timestamp = System.currentTimeMillis()))
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    /* ── SIM balance over USSD ────────────────────────────────────────────── */

    /** The codes, the switch, and what the operator last said — the SIM balance screen. */
    @ReactMethod
    fun getUssdSettings(promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val out = Arguments.createArray()
            for (info in SimResolver.activeSubscriptions(ctx)) {
                val slot = info.simSlotIndex + 1
                val carrier = try { info.carrierName?.toString() ?: "" } catch (e: Throwable) { "" }
                out.pushMap(Arguments.createMap().apply {
                    putInt("slot", slot)
                    putString("carrier", carrier)
                    putString("code", UssdChecker.codeFor(ctx, slot, carrier))
                    putString("lastReply", UssdChecker.lastReply(ctx, slot))
                    putDouble("lastCheckedAt", UssdChecker.lastCheckedAt(ctx, slot).toDouble())
                })
            }
            promise.resolve(Arguments.createMap().apply {
                putBoolean("supported", UssdChecker.isSupported())
                putBoolean("enabled", CallIqConfig.ussdEnabled(ctx))
                putBoolean("callPermission",
                    ContextCompat.checkSelfPermission(ctx, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED)
                putArray("sims", out)
            })
        } catch (e: Throwable) {
            promise.reject("ussd_settings_failed", e)
        }
    }

    @ReactMethod
    fun setUssdSettings(enabled: Boolean, promise: Promise) {
        try {
            CallIqConfig.prefs(reactApplicationContext).edit()
                .putBoolean(CallIqConfig.KEY_USSD_ENABLED, enabled).apply()
            if (enabled) UssdWorker.scheduleDaily(reactApplicationContext) else UssdWorker.cancel(reactApplicationContext)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun setUssdCode(slot: Int, code: String, promise: Promise) {
        try {
            UssdChecker.setCode(reactApplicationContext, slot, code)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    /** Runs the code now and resolves with whatever the operator replied. */
    @ReactMethod
    fun checkSimBalance(slot: Int, promise: Promise) {
        try {
            val ctx = reactApplicationContext
            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
                currentActivity?.let {
                    ActivityCompat.requestPermissions(it, arrayOf(Manifest.permission.CALL_PHONE), 1002)
                }
                promise.resolve(Arguments.createMap().apply {
                    putBoolean("ok", false)
                    putString("text", "Allow the Phone-calls permission, then try again — the carrier code runs on the line.")
                })
                return
            }
            var answered = false
            UssdChecker.check(ctx, slot, object : UssdChecker.Result {
                override fun onDone(s: Int, ok: Boolean, text: String) {
                    if (answered) return
                    answered = true
                    promise.resolve(Arguments.createMap().apply {
                        putBoolean("ok", ok)
                        putString("text", text)
                    })
                }
            })
            // USSD can hang silently; answer the UI either way.
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                if (!answered) {
                    answered = true
                    promise.resolve(Arguments.createMap().apply {
                        putBoolean("ok", false)
                        putString("text", "No reply within 45 seconds. This operator may not answer this code automatically.")
                    })
                }
            }, 45_000)
        } catch (e: Throwable) {
            promise.reject("ussd_failed", e)
        }
    }

    /** Every SIM the phone reports, plus what this app has learned — the SIM diagnostics screen. */
    @ReactMethod
    fun getSimDiagnostics(promise: Promise) {
        try {
            promise.resolve(SimResolver.diagnostics(reactApplicationContext).toString())
        } catch (e: Throwable) {
            promise.resolve("{}")
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
                
                // Standard and OEM-specific SIM columns. The component name is what turns
                // PHONE_ACCOUNT_ID into a real PhoneAccountHandle — see SimResolver.
                val simIdIdx = it.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_ID)
                val componentIdx = it.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_COMPONENT_NAME)
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

                    val phoneAccountId = if (simIdIdx != -1) it.getString(simIdIdx) else null
                    val component = if (componentIdx != -1) it.getString(componentIdx) else null
                    val subId = if (subIdIdx != -1) it.getString(subIdIdx) else null
                    val subIdAlt = if (subIdAltIdx != -1) it.getString(subIdAltIdx) else null
                    val simIdOem = if (simIdOemIdx != -1) it.getString(simIdOemIdx) else null
                    val simIdOemAlt = if (simIdOemAltIdx != -1) it.getString(simIdOemAltIdx) else null

                    val rawSimId = listOf(phoneAccountId, subId, subIdAlt, simIdOem, simIdOemAlt)
                        .firstOrNull { v -> !v.isNullOrBlank() } ?: ""

                    val sim = SimResolver.resolve(reactApplicationContext, rawSimId, component, date)

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
                        // "SIM 1" / "SIM 2", or "Unknown SIM" when nothing could identify it —
                        // never a guess dressed up as a fact.
                        putString("simId", if (sim.slot != null) "SIM ${sim.slot}" else "Unknown SIM")
                        putInt("simSlot", sim.slot ?: 0)
                        putString("simCarrier", sim.carrier)
                        putString("simSource", sim.source)
                        putString("rawSimId", rawSimId)
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
            // simId here is the display label the JS list holds ("SIM 2"), not a phone-account id,
            // so re-read the slot from it and let the worker keep whatever it already knows.
            val slot = Regex("(\\d+)").find(simId)?.value?.toIntOrNull() ?: 0
            CallSyncWorker.schedule(
                context = reactApplicationContext,
                number = number,
                callType = callType,
                duration = duration.toLong(),
                simId = simId,
                timestamp = timestamp.toLong(),
                idempotencyKey = idempotencyKey,
                outcome = outcome,
                simSlot = slot,
                // No sim_source: this path re-sends a call the server already knows, and the
                // original detection source must not be overwritten with a weaker one.
                taggedVia = "app"
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
//changed