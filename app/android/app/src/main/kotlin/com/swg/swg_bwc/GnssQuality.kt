package com.swg.swg_bwc

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.GnssStatus
import android.location.LocationManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlin.math.sqrt

/**
 * What the GPS chip does NOT tell in a Location: how many satellites made this fix and how strong their signals are (Android's
 * Location extras carry it, the geolocator plugin does not pass it on), and whether the camera is being moved at all (accelerometer).
 *
 * Measured on the real cameras on a desk: indoors the chip reports "accuracy 1-10 m" with 3-4 satellites at 13-18 dB-Hz (outdoors 8+ at 25-40),
 * altitudes of -120000 m, and a position that wanders 300 m while the camera lies still. The Dart side uses these numbers to refuse such
 * fixes and to hold the position of a camera that is not moving.
 */
object GnssQuality {
    private const val TAG = "BWC"
    private var started = false
    @Volatile private var used = 0
    @Volatile private var visible = 0
    @Volatile private var meanCn0 = 0.0
    @Volatile private var maxCn0 = 0.0
    @Volatile private var statusAt = 0L

    // accelerometer: variance of the acceleration magnitude over the last ~3 s; a camera on a desk or a dock is below 0.02 (m/s^2)^2
    private val win = DoubleArray(60)
    private var n = 0
    private var fill = 0
    @Volatile private var variance = 99.0
    @Volatile private var stillSince = 0L
    @Volatile private var movedAt = 0L

    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(ctx: Context) {
        if (started) return
        started = true
        val app = ctx.applicationContext
        try {
            val lm = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            lm.registerGnssStatusCallback(object : GnssStatus.Callback() {
                override fun onSatelliteStatusChanged(s: GnssStatus) {
                    var u = 0; var sum = 0.0; var mx = 0.0
                    for (i in 0 until s.satelliteCount) {
                        if (s.usedInFix(i)) {
                            u++
                            val c = s.getCn0DbHz(i).toDouble()
                            sum += c
                            if (c > mx) mx = c
                        }
                    }
                    used = u; visible = s.satelliteCount; meanCn0 = if (u > 0) sum / u else 0.0; maxCn0 = mx
                    statusAt = System.currentTimeMillis()
                }
            }, Handler(Looper.getMainLooper()))
        } catch (e: Exception) { Log.w(TAG, "gnss status callback failed: $e") }
        try {
            val sm = app.getSystemService(Context.SENSOR_SERVICE) as SensorManager
            val acc = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            if (acc != null) sm.registerListener(object : SensorEventListener {
                override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
                override fun onSensorChanged(e: SensorEvent) {
                    val m = sqrt((e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]).toDouble())
                    win[n] = m; n = (n + 1) % win.size; if (fill < win.size) fill++
                    if (fill < 20) return
                    var mean = 0.0; for (i in 0 until fill) mean += win[i]; mean /= fill
                    var v = 0.0; for (i in 0 until fill) { val d = win[i] - mean; v += d * d }; v /= fill
                    variance = v
                    val now = System.currentTimeMillis()
                    if (v < 0.03) { if (stillSince == 0L) stillSince = now } else { stillSince = 0L; movedAt = now }
                }
            }, acc, SensorManager.SENSOR_DELAY_GAME)
            else Log.w(TAG, "no accelerometer")
        } catch (e: Exception) { Log.w(TAG, "accelerometer failed: $e") }
    }

    /** Satellites used by the chip, their mean and best signal (dB-Hz), and how long the camera has lain still (ms; 0 = it is moving). */
    fun snapshot(): Map<String, Any> {
        val now = System.currentTimeMillis()
        return mapOf(
            "used" to used, "visible" to visible, "meanCn0" to meanCn0, "maxCn0" to maxCn0,
            "statusAgeMs" to if (statusAt == 0L) -1L else now - statusAt,
            "variance" to variance, "stillMs" to if (stillSince == 0L) 0L else now - stillSince,
            "sinceMoveMs" to if (movedAt == 0L) -1L else now - movedAt,
        )
    }
}
