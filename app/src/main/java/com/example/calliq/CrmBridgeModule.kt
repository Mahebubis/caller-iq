package com.example.calliq

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.speech.RecognizerIntent
import android.util.Base64
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File

/*
 * The sales workspace's phone features, all free and on the device:
 *   - pickTextFile: a CSV / TSV picked with the system file picker, read as text (for imports)
 *   - pickMediaFile: a PDF, image or audio file, as base64, to attach to a WhatsApp message
 *   - recognizeSpeech: Android's own speech recogniser (the Google voice-typing dialog), for
 *     dictating call notes in English, Hindi or Marathi
 *   - startMemo / stopMemo / cancelMemo: a voice note recorded to AAC, handed back as base64
 *   - playAudio / stopAudio: plays a voice note back from base64
 *   - saveDownload: writes an export (CSV) to the phone's Downloads folder
 *   - emitKey: hardware-keyboard shortcuts, sent from MainActivity as "CallIQKey" events
 *   - "CallIQCallState" events (RINGING / OFFHOOK / IDLE) from the phone itself, so the in-app call
 *     screen and the power dialer know the moment a call goes live and the moment it ends
 *   - call controls for the in-app call screen: speaker, mute, the system keypad, end call. The
 *     phone's own dialer owns the call; these are the switches Android lets another app use.
 */
class CrmBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        private const val REQ_PICK = 4101
        private const val REQ_SPEECH = 4102
        private const val REQ_MEDIA = 4103
        private const val MAX_MEDIA_BYTES = 16 * 1024 * 1024     // WhatsApp's own limit for media
        private const val MAX_FILE_BYTES = 25 * 1024 * 1024

        @Volatile private var instance: CrmBridgeModule? = null

        /**
         * True when the running app placed this call and will ask for its outcome itself. If the app
         * is not running (swiped away mid-call), the popup still comes up — an outcome is never lost.
         */
        fun appHandles(context: android.content.Context, number: String): Boolean {
            val ctx = instance?.reactApplicationContext ?: return false
            if (!ctx.hasActiveReactInstance()) return false
            val v = context.getSharedPreferences("calliq_ui_cache", android.content.Context.MODE_PRIVATE).getString("inapp_call", "") ?: ""
            val parts = v.split("|")
            if (parts.size != 2) return false
            val k = number.filter { it.isDigit() }.takeLast(10)
            val at = parts[1].toLongOrNull() ?: return false
            return k.isNotEmpty() && k == parts[0] && System.currentTimeMillis() - at < 3 * 3600 * 1000L
        }

        /** A key a hardware keyboard sent; JS ignores it while a text box has focus. */
        fun emitKey(key: String, ctrl: Boolean, shift: Boolean) {
            val ctx = instance?.reactApplicationContext ?: return
            if (!ctx.hasActiveReactInstance()) return
            val map = Arguments.createMap().apply {
                putString("key", key)
                putBoolean("ctrl", ctrl)
                putBoolean("shift", shift)
            }
            try {
                ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("CallIQKey", map)
            } catch (_: Throwable) {}
        }
    }

    private var pickPromise: Promise? = null
    private var speechPromise: Promise? = null
    private var mediaPromise: Promise? = null
    private var recorder: MediaRecorder? = null
    private var memoFile: File? = null
    private var memoStartedAt = 0L
    private var player: MediaPlayer? = null

    /* The phone's call state, as it changes (READ_PHONE_STATE is already granted for call logging). */
    private val callState = object : android.content.BroadcastReceiver() {
        override fun onReceive(c: android.content.Context?, i: Intent?) {
            if (i?.action != android.telephony.TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
            val st = i.getStringExtra(android.telephony.TelephonyManager.EXTRA_STATE) ?: return
            val name = when (st) {
                android.telephony.TelephonyManager.EXTRA_STATE_OFFHOOK -> "OFFHOOK"
                android.telephony.TelephonyManager.EXTRA_STATE_RINGING -> "RINGING"
                else -> "IDLE"
            }
            if (name == "OFFHOOK") liveSinceMark = true
            // A call the app placed has ended: come back to the app's call screen for the outcome,
            // rather than leaving the counselor in the phone's dialer.
            if (name == "IDLE" && liveSinceMark) {
                liveSinceMark = false
                if (markedRecently()) android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ bringAppToFront() }, 700)
            }
            try {
                if (!reactApplicationContext.hasActiveReactInstance()) return
                reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("CallIQCallState", Arguments.createMap().apply {
                        putString("state", name)
                        putDouble("at", System.currentTimeMillis().toDouble())
                    })
            } catch (_: Throwable) {}
        }
    }

    init {
        reactContext.addActivityEventListener(this)
        instance = this
        try {
            androidx.core.content.ContextCompat.registerReceiver(
                reactContext, callState,
                android.content.IntentFilter(android.telephony.TelephonyManager.ACTION_PHONE_STATE_CHANGED),
                androidx.core.content.ContextCompat.RECEIVER_EXPORTED,
            )
        } catch (_: Throwable) {}
    }

    override fun getName(): String = "CrmBridge"

    /* ── files ── */

    @ReactMethod
    fun pickTextFile(promise: Promise) {
        val activity = currentActivity ?: return promise.reject("no_activity", "Open the app first")
        if (pickPromise != null) return promise.reject("busy", "A file picker is already open")
        pickPromise = promise
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("text/csv", "text/comma-separated-values", "text/tab-separated-values", "text/plain", "application/csv", "application/vnd.ms-excel", "application/json", "application/octet-stream"))
            }
            activity.startActivityForResult(intent, REQ_PICK)
        } catch (e: Throwable) {
            pickPromise = null
            promise.reject("pick_failed", e.message ?: "Could not open the file picker")
        }
    }

    @ReactMethod
    fun pickMediaFile(promise: Promise) {
        val activity = currentActivity ?: return promise.reject("no_activity", "Open the app first")
        if (mediaPromise != null) return promise.reject("busy", "A file picker is already open")
        mediaPromise = promise
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/pdf", "image/*", "audio/*", "video/mp4"))
            }
            activity.startActivityForResult(intent, REQ_MEDIA)
        } catch (e: Throwable) {
            mediaPromise = null
            promise.reject("pick_failed", e.message ?: "Could not open the file picker")
        }
    }

    @ReactMethod
    fun saveDownload(name: String, mime: String, content: String, promise: Promise) {
        try {
            val ctx = reactApplicationContext
            val safe = name.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(100)
            val bytes = content.toByteArray(Charsets.UTF_8)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safe)
                    put(MediaStore.Downloads.MIME_TYPE, mime)
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return promise.reject("save_failed", "Could not create the file")
                ctx.contentResolver.openOutputStream(uri)?.use { out ->
                    out.write(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()))   // BOM, so Excel reads Hindi names right
                    out.write(bytes)
                }
                promise.resolve("Downloads/$safe")
            } else {
                val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: ctx.filesDir
                val file = File(dir, safe)
                file.writeBytes(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + bytes)
                promise.resolve(file.absolutePath)
            }
        } catch (e: Throwable) {
            promise.reject("save_failed", e.message ?: "Could not save the file")
        }
    }

    /* ── speech to text ── */

    @ReactMethod
    fun recognizeSpeech(lang: String, prompt: String, promise: Promise) {
        val activity = currentActivity ?: return promise.reject("no_activity", "Open the app first")
        if (speechPromise != null) return promise.reject("busy", "Already listening")
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang.ifBlank { "en-IN" })
            putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        if (intent.resolveActivity(activity.packageManager) == null) {
            return promise.reject("no_recognizer", "This phone has no speech recogniser — install or enable Google voice typing")
        }
        speechPromise = promise
        try {
            activity.startActivityForResult(intent, REQ_SPEECH)
        } catch (e: Throwable) {
            speechPromise = null
            promise.reject("speech_failed", e.message ?: "Could not start listening")
        }
    }

    override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: Intent?) {
        when (requestCode) {
            REQ_PICK -> {
                val p = pickPromise ?: return
                pickPromise = null
                val uri = data?.data
                if (resultCode != Activity.RESULT_OK || uri == null) return p.resolve(null)
                try {
                    val cr = reactApplicationContext.contentResolver
                    var name = uri.lastPathSegment ?: "file.csv"
                    cr.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                        if (c.moveToFirst()) name = c.getString(0) ?: name
                    }
                    val bytes = cr.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0)
                    if (bytes.size > MAX_FILE_BYTES) return p.reject("too_big", "That file is over 25 MB — split it first")
                    var text = String(bytes, Charsets.UTF_8)
                    if (text.startsWith("﻿")) text = text.substring(1)
                    p.resolve(Arguments.createMap().apply {
                        putString("name", name)
                        putString("text", text)
                        putInt("bytes", bytes.size)
                    })
                } catch (e: Throwable) {
                    p.reject("read_failed", e.message ?: "Could not read that file")
                }
            }
            REQ_MEDIA -> {
                val p = mediaPromise ?: return
                mediaPromise = null
                val uri = data?.data
                if (resultCode != Activity.RESULT_OK || uri == null) return p.resolve(null)
                try {
                    val cr = reactApplicationContext.contentResolver
                    var name = uri.lastPathSegment ?: "file"
                    cr.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                        if (c.moveToFirst()) name = c.getString(0) ?: name
                    }
                    val bytes = cr.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0)
                    if (bytes.size > MAX_MEDIA_BYTES) return p.reject("too_big", "That file is over 16 MB — WhatsApp will not send it")
                    val mime = cr.getType(uri) ?: when (name.substringAfterLast('.', "").lowercase()) {
                        "pdf" -> "application/pdf"; "jpg", "jpeg" -> "image/jpeg"; "png" -> "image/png"
                        "ogg", "opus" -> "audio/ogg"; "mp3" -> "audio/mpeg"; "m4a" -> "audio/mp4"; else -> "application/octet-stream"
                    }
                    p.resolve(Arguments.createMap().apply {
                        putString("name", name)
                        putString("mime", mime)
                        putInt("bytes", bytes.size)
                        putString("b64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    })
                } catch (e: Throwable) {
                    p.reject("read_failed", e.message ?: "Could not read that file")
                }
            }
            REQ_SPEECH -> {
                val p = speechPromise ?: return
                speechPromise = null
                if (resultCode != Activity.RESULT_OK) return p.resolve("")
                val heard = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull() ?: ""
                p.resolve(heard)
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {}

    /* ── calls placed from the app: its own call screen asks for the outcome ── */

    @Volatile private var liveSinceMark = false

    private fun markedRecently(): Boolean {
        val v = reactApplicationContext.getSharedPreferences("calliq_ui_cache", android.content.Context.MODE_PRIVATE).getString("inapp_call", "") ?: ""
        val at = v.substringAfter('|', "").toLongOrNull() ?: return false
        return System.currentTimeMillis() - at < 3 * 3600 * 1000L
    }

    /** Back to the app (allowed from the background because it may "Display over other apps"). */
    private fun bringAppToFront() {
        try {
            val ctx = reactApplicationContext
            val i = Intent(ctx, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            ctx.startActivity(i)
        } catch (_: Throwable) {}
    }

    /** The app placed a call to [number]: the native popup stays away for it while the app runs. */
    @ReactMethod
    fun markInAppCall(number: String) {
        liveSinceMark = false
        val k = number.filter { it.isDigit() }.takeLast(10)
        reactApplicationContext.getSharedPreferences("calliq_ui_cache", android.content.Context.MODE_PRIVATE)
            .edit().putString("inapp_call", "$k|${System.currentTimeMillis()}").apply()
    }

    /** The outcome picked on the app's call screen, sent like a popup tag (matched by the call's start). */
    @ReactMethod
    fun tagInAppCall(number: String, startedMs: Double, outcome: String, promise: Promise) {
        try {
            TagWorker.schedule(
                context = reactApplicationContext, outcome = outcome, number = number,
                startedMs = startedMs.toLong(), idempotencyKey = "", via = "app",
            )
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("tag_failed", e.message ?: "Could not save the tag")
        }
    }

    /* ── call controls ── */

    private fun audio() = reactApplicationContext.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager

    @ReactMethod
    fun setSpeaker(on: Boolean, promise: Promise) {
        try {
            val am = audio()
            if (Build.VERSION.SDK_INT >= 31) {
                if (on) {
                    val dev = am.availableCommunicationDevices.firstOrNull { it.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    if (dev != null) am.setCommunicationDevice(dev)
                } else am.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = on
            }
            promise.resolve(on)
        } catch (e: Throwable) {
            promise.reject("speaker_failed", e.message ?: "Could not switch the speaker")
        }
    }

    @ReactMethod
    fun setMute(on: Boolean, promise: Promise) {
        try {
            audio().isMicrophoneMute = on
            promise.resolve(on)
        } catch (e: Throwable) {
            promise.reject("mute_failed", e.message ?: "Could not mute")
        }
    }

    /** The phone's own call screen, with its dial pad open when `keypad`. */
    @ReactMethod
    fun showInCallScreen(keypad: Boolean, promise: Promise) {
        try {
            val tm = reactApplicationContext.getSystemService(android.content.Context.TELECOM_SERVICE) as android.telecom.TelecomManager
            tm.showInCallScreen(keypad)
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.reject("incall_failed", e.message ?: "Could not open the call screen")
        }
    }

    /** Hangs up (Android 9+, with "answer phone calls" allowed); false when the phone will not let us. */
    @ReactMethod
    fun endCall(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < 28) return promise.resolve(false)
            if (androidx.core.content.ContextCompat.checkSelfPermission(reactApplicationContext, android.Manifest.permission.ANSWER_PHONE_CALLS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) return promise.resolve(false)
            val tm = reactApplicationContext.getSystemService(android.content.Context.TELECOM_SERVICE) as android.telecom.TelecomManager
            @Suppress("DEPRECATION")
            promise.resolve(tm.endCall())
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    /* ── voice notes ── */

    @ReactMethod
    fun startMemo(promise: Promise) {
        try {
            stopRecorderQuietly()
            val file = File(reactApplicationContext.cacheDir, "memo_${System.currentTimeMillis()}.m4a")
            val rec = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(reactApplicationContext)
                      else @Suppress("DEPRECATION") MediaRecorder()
            rec.setAudioSource(MediaRecorder.AudioSource.MIC)
            rec.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            rec.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            rec.setAudioEncodingBitRate(32000)       // speech: ~240 KB a minute
            rec.setAudioSamplingRate(22050)
            rec.setMaxDuration(5 * 60 * 1000)
            rec.setOutputFile(file.absolutePath)
            rec.prepare()
            rec.start()
            recorder = rec
            memoFile = file
            memoStartedAt = System.currentTimeMillis()
            promise.resolve(true)
        } catch (e: Throwable) {
            stopRecorderQuietly()
            promise.reject("record_failed", e.message ?: "Could not start recording — allow the microphone")
        }
    }

    @ReactMethod
    fun stopMemo(promise: Promise) {
        val rec = recorder ?: return promise.reject("not_recording", "Not recording")
        val file = memoFile
        val duration = System.currentTimeMillis() - memoStartedAt
        try {
            rec.stop()
        } catch (_: Throwable) {
            // Stopped straight after starting: nothing was recorded.
        }
        rec.release()
        recorder = null
        memoFile = null
        try {
            if (file == null || !file.exists() || file.length() == 0L) return promise.reject("empty", "Nothing was recorded")
            val b64 = Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)
            file.delete()
            promise.resolve(Arguments.createMap().apply {
                putString("b64", b64)
                putString("mime", "audio/mp4")
                putDouble("durationMs", duration.toDouble())
            })
        } catch (e: Throwable) {
            promise.reject("read_failed", e.message ?: "Could not read the recording")
        }
    }

    @ReactMethod
    fun cancelMemo(promise: Promise) {
        stopRecorderQuietly()
        promise.resolve(true)
    }

    private fun stopRecorderQuietly() {
        try { recorder?.stop() } catch (_: Throwable) {}
        try { recorder?.release() } catch (_: Throwable) {}
        recorder = null
        memoFile?.delete()
        memoFile = null
    }

    @ReactMethod
    fun playAudio(b64: String, promise: Promise) {
        try {
            stopPlayer()
            val file = File(reactApplicationContext.cacheDir, "play.m4a")
            file.writeBytes(Base64.decode(b64, Base64.DEFAULT))
            val mp = MediaPlayer()
            mp.setDataSource(file.absolutePath)
            mp.setOnCompletionListener {
                stopPlayer()
                sendEvent("CallIQAudioDone")
            }
            mp.prepare()
            mp.start()
            player = mp
            promise.resolve(mp.duration.toDouble())
        } catch (e: Throwable) {
            stopPlayer()
            promise.reject("play_failed", e.message ?: "Could not play the voice note")
        }
    }

    @ReactMethod
    fun stopAudio(promise: Promise) {
        stopPlayer()
        promise.resolve(true)
    }

    private fun stopPlayer() {
        try { player?.stop() } catch (_: Throwable) {}
        try { player?.release() } catch (_: Throwable) {}
        player = null
    }

    private fun sendEvent(name: String) {
        try {
            reactApplicationContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, null)
        } catch (_: Throwable) {}
    }

    // Required by NativeEventEmitter on the JS side.
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    override fun invalidate() {
        try { reactApplicationContext.unregisterReceiver(callState) } catch (_: Throwable) {}
        stopRecorderQuietly()
        stopPlayer()
        if (instance === this) instance = null
        super.invalidate()
    }
}
