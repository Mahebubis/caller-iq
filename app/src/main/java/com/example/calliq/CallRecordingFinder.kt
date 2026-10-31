package com.example.calliq

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Finds the file the phone's OWN call recorder saved for a call.
 *
 * Android lets no ordinary app record a SIM call, but most phones sold in India (Xiaomi, Samsung,
 * Oppo, Realme, Vivo, OnePlus) have a recorder in their dialer that saves each call as an audio
 * file in shared storage. Android's media index (MediaStore) lists those files; this picks the one
 * that belongs to a call by when it was written, how long it is and — where the phone puts it in
 * the name — the number. Google's own Phone app keeps its recordings private, so phones that use
 * it have nothing to find.
 *
 * Where the recorders write (all contain "call" or "phonerecord" in the path):
 *   Xiaomi  MIUI/sound_recorder/call_rec/          Samsung  Recordings/Call/
 *   Oppo / Realme  Music/Recordings/Call Recordings/   Vivo  Recordings/Record/Call/
 *   OnePlus (older)  Record/PhoneRecord/
 */
object CallRecordingFinder {

    data class Found(val uri: Uri, val name: String, val size: Long, val mime: String, val durationMs: Long)

    private val PATH_HINTS = listOf("call", "phonerecord", "phone_record", "phone record")

    fun permission(): String =
        if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE

    fun hasPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, permission()) == PackageManager.PERMISSION_GRANTED

    /**
     * The recording of a call that started at [startMs] and was talked for [durationSec], or null.
     * Files already matched to another call ([used]) are never offered twice.
     */
    fun find(context: Context, number: String, startMs: Long, durationSec: Long, used: Set<String>): Found? {
        if (!hasPermission(context)) return null
        val startSec = startMs / 1000
        // The log's start is when the call was placed; the talking starts after up to a minute of
        // ringing, so the recording is finished somewhere after start + talk time.
        val endSec = startSec + durationSec
        val collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI

        @Suppress("DEPRECATION")
        val pathCol = if (Build.VERSION.SDK_INT >= 29) MediaStore.Audio.Media.RELATIVE_PATH else MediaStore.Audio.Media.DATA
        val projection = arrayOf(
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.MIME_TYPE,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.DATE_ADDED,
            MediaStore.Audio.Media.DATE_MODIFIED,
            pathCol,
        )
        val selection = "${MediaStore.Audio.Media.DATE_MODIFIED} >= ? AND ${MediaStore.Audio.Media.DATE_MODIFIED} <= ?"
        val args = arrayOf((startSec - 60).toString(), (endSec + 600).toString())
        val digits = number.filter { it.isDigit() }.takeLast(10)

        var best: Found? = null
        var bestScore = Int.MIN_VALUE
        try {
            context.contentResolver.query(collection, projection, selection, args, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    val name = c.getString(1) ?: ""
                    val path = c.getString(7) ?: ""
                    val where = "$path/$name".lowercase()
                    if (PATH_HINTS.none { where.contains(it) }) continue

                    val uri = ContentUris.withAppendedId(collection, id)
                    if (uri.toString() in used) continue

                    val size = c.getLong(2)
                    if (size <= 0) continue
                    val fileDurMs = c.getLong(4)
                    val added = c.getLong(5)
                    val modified = c.getLong(6)

                    // When the file was last written vs when the call ended (allowing for ringing).
                    val endGap = modified - endSec
                    if (endGap < -15 || endGap > 240) {
                        // Some recorders stamp the file once, when it starts.
                        if (added < startSec - 15 || added > endSec + 240) continue
                    }

                    var score = 100 - minOf(100, kotlin.math.abs(endGap).toInt())
                    val nameDigits = name.filter { it.isDigit() }
                    if (digits.length >= 6 && nameDigits.contains(digits)) score += 200
                    if (fileDurMs > 0 && durationSec > 0) {
                        val diff = kotlin.math.abs(fileDurMs / 1000 - durationSec)
                        if (diff <= maxOf(6L, durationSec / 5)) score += 100 else score -= 150
                    }
                    if (score > bestScore) {
                        bestScore = score
                        best = Found(uri, name, size, c.getString(3) ?: "audio/mpeg", fileDurMs)
                    }
                }
            }
        } catch (e: Throwable) {
            Log.w("CallRecordingFinder", "MediaStore query failed: ${e.message}")
            return null
        }
        return if (bestScore > -50) best else null
    }
}
