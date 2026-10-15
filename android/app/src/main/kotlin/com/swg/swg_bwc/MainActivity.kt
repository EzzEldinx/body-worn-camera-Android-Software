package com.swg.swg_bwc

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val kioskChannelName = "com.swg.bwc/kiosk"
    private val hardwareChannelName = "com.swg.bwc/hardware_keys"

    @Volatile
    private var kioskArmed = false
    private var hardwareSink: EventChannel.EventSink? = null

    // 🔥 الرادار الشامل المفصول بأرقام فريدة 🔥
    private val lolaageReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val action = intent?.action ?: return
            when (action) {
                "lolaage.video.down" -> forwardCustomKey(1001, 0)
                "lolaage.video.up" -> forwardCustomKey(1001, 1)
                
                "lolaage.sos.down" -> forwardCustomKey(1002, 0)
                "lolaage.sos.up" -> forwardCustomKey(1002, 1)

                "lolaage.ptt.down" -> forwardCustomKey(1003, 0)
                "lolaage.ptt.up" -> forwardCustomKey(1003, 1)
                
                // زرار التصوير
                "lolaage.photo.down" -> forwardCustomKey(1004, 0)
                "lolaage.photo.up" -> forwardCustomKey(1004, 1)

                // The CAMERA button really sends "take.picture" and the MIC button sends "audio".
                "lolaage.take.picture.down" -> forwardCustomKey(1004, 0)
                "lolaage.take.picture.up" -> forwardCustomKey(1004, 1)
                "lolaage.audio.down" -> forwardCustomKey(1008, 0)
                "lolaage.audio.up" -> forwardCustomKey(1008, 1)

                // زرار الكشاف
                "lolaage.light.down" -> forwardCustomKey(1005, 0)
                "lolaage.light.up" -> forwardCustomKey(1005, 1)

                // زراير الصوت
                "lolaage.volume.up" -> forwardCustomKey(1006, 1)
                "lolaage.volume.down" -> forwardCustomKey(1007, 1)
            }
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        // Remote app updates: build id, device-owner check, install a downloaded APK.
        val updateChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.swg.bwc/update")
        AppInstaller.onResult = { status, msg ->
            runOnUiThread { updateChannel.invokeMethod("installResult", mapOf("status" to status, "message" to msg)) }
        }
        updateChannel.setMethodCallHandler { call, result ->
            when (call.method) {
                "getAppBuild" -> Thread {
                    try {
                        val b = AppInstaller.appBuild(this)
                        runOnUiThread { result.success(b) }
                    } catch (e: Exception) {
                        runOnUiThread { result.error("build", e.message, null) }
                    }
                }.start()
                "isDeviceOwner" -> result.success(AppInstaller.isDeviceOwner(this))
                "installApk" -> {
                    val path = call.argument<String>("path")
                    if (path == null) {
                        result.error("path", "missing path", null)
                    } else {
                        Thread {
                            try {
                                AppInstaller.install(this, path)
                                runOnUiThread { result.success(null) }
                            } catch (e: Exception) {
                                runOnUiThread { result.error("install", e.message, null) }
                            }
                        }.start()
                    }
                }
                else -> result.notImplemented()
            }
        }

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, kioskChannelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "enableKiosk" -> { runOnUiThread { enableKiosk() }; result.success(null) }
                    "disableKiosk" -> { runOnUiThread { disableKiosk() }; result.success(null) }
                    
                    // دوال النداء من أزرار الشاشة في فلاتر
                    "toggleIR" -> { toggleIR(); result.success(null) }
                    "toggleLaser" -> { toggleLaser(); result.success(null) }
                    "prize" -> {
                        // Laser, torch, IR and black-and-white mode are driven by the device's own
                        // system app (com.pri.factorytest). Only these actions are allowed.
                        val allowed = setOf(
                            "lolaage.rayled.set",
                            "lolaage.ircut.switch",
                            "lolaage.ir.led",
                            "com.android.led.torch",
                            "com.lxy.bw.sensormode"
                        )
                        val action = call.argument<String>("action")
                        if (action == null || action !in allowed) {
                            result.error("prize", "action not allowed", null)
                        } else {
                            // A plain sendBroadcast() from the app never reaches the system receiver on this device,
                            // while "am broadcast" run as the app's own user does. Run it off the UI thread.
                            Thread {
                                try {
                                    val cmd = mutableListOf(
                                        "am", "broadcast", "--user", "0",
                                        "-a", action,
                                        "-n", "com.pri.factorytest/com.pri.factorytest.PrizeReceiver"
                                    )
                                    call.argument<Int>("open")?.let { cmd += listOf("--ei", "open", it.toString()) }
                                    call.argument<Int>("value")?.let { cmd += listOf("--ei", "value", it.toString()) }
                                    call.argument<String>("sensormode")?.let { cmd += listOf("--es", "sensormode", it) }
                                    val proc = ProcessBuilder(cmd).redirectErrorStream(true).start()
                                    val out = proc.inputStream.bufferedReader().readText()
                                    val code = proc.waitFor()
                                    Log.i("BWC", "prize $action exit=$code ${out.trim().take(120)}")
                                    runOnUiThread {
                                        if (code == 0) result.success(null) else result.error("prize", "am exit $code", null)
                                    }
                                } catch (e: Exception) {
                                    runOnUiThread { result.error("prize", e.message, null) }
                                }
                            }.start()
                        }
                    }
                    "getBwMode" -> {
                        try {
                            val proc = Runtime.getRuntime().exec(arrayOf("getprop", "sys.debug.bw.sensormode"))
                            result.success(proc.inputStream.bufferedReader().readText().trim())
                        } catch (e: Exception) {
                            result.error("bw", e.message, null)
                        }
                    }
                    "showVolume" -> {
                        // Opens the system volume slider so the user can drag it up or down.
                        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                        am.adjustStreamVolume(
                            AudioManager.STREAM_MUSIC,
                            AudioManager.ADJUST_SAME,
                            AudioManager.FLAG_SHOW_UI
                        )
                        result.success(mapOf(
                            "level" to am.getStreamVolume(AudioManager.STREAM_MUSIC),
                            "max" to am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                        ))
                    }
                    "cycleVolume" -> {
                        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                        val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)
                        val next = if (cur <= 0) max else cur - 1
                        am.setStreamVolume(AudioManager.STREAM_MUSIC, next, 0)
                        result.success(mapOf("level" to next, "max" to max))
                    }
                    "setTorch" -> {
                        try {
                            setTorchNative(call.argument<Boolean>("on") ?: false)
                            result.success(null)
                        } catch (e: Exception) {
                            result.error("torch", e.message, null)
                        }
                    }
                    
                    else -> result.notImplemented()
                }
            }

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, hardwareChannelName)
            .setStreamHandler(
                object : EventChannel.StreamHandler {
                    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                        hardwareSink = events
                    }
                    override fun onCancel(arguments: Any?) {
                        hardwareSink = null
                    }
                }
            )
    }

    // 🔥 إرسال إشارات للنظام لفتح الليزر والـ IR 🔥
    private fun setTorchNative(on: Boolean) {
        val cm = getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = cm.cameraIdList.firstOrNull {
            val ch = cm.getCameraCharacteristics(it)
            ch.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true &&
                ch.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        } ?: throw IllegalStateException("No flash available on this device")
        cm.setTorchMode(id, on)
    }

    private fun toggleIR() {
        sendBroadcast(Intent("lolaage.ir.down"))
        sendBroadcast(Intent("lolaage.ir.up"))
    }

    private fun toggleLaser() {
        sendBroadcast(Intent("lolaage.laser.down"))
        sendBroadcast(Intent("lolaage.laser.up"))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        @Suppress("DEPRECATION")
        window.addFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD)
        @Suppress("DEPRECATION")
        window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        @Suppress("DEPRECATION")
        window.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)

        registerLolaageReceiver()
    }

    private fun registerLolaageReceiver() {
        val filter = IntentFilter().apply {
            addAction("lolaage.video.down")
            addAction("lolaage.video.up")
            addAction("lolaage.sos.down")
            addAction("lolaage.sos.up")
            addAction("lolaage.ptt.down")
            addAction("lolaage.ptt.up")
            addAction("lolaage.photo.down")
            addAction("lolaage.photo.up")
            addAction("lolaage.take.picture.down")
            addAction("lolaage.take.picture.up")
            addAction("lolaage.audio.down")
            addAction("lolaage.audio.up")
            addAction("lolaage.light.down")
            addAction("lolaage.light.up")
            addAction("lolaage.volume.up")
            addAction("lolaage.volume.down")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(lolaageReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            registerReceiver(lolaageReceiver, filter)
        }
    }

    override fun onDestroy() {
        unregisterReceiver(lolaageReceiver)
        super.onDestroy()
    }

    override fun onResume() {
        super.onResume()
        if (kioskArmed) { applyImmersive(); startLockTaskQuietly() }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && kioskArmed) { applyImmersive() }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (kioskArmed) return
        super.onBackPressed()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        forwardCustomKey(event.keyCode, event.action)
        if (kioskArmed && event.keyCode == KeyEvent.KEYCODE_BACK) return true
        // Volume and camera keys are app controls (zoom / photo), not system volume.
        when (event.keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP,
            KeyEvent.KEYCODE_VOLUME_DOWN,
            KeyEvent.KEYCODE_CAMERA -> return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun enableKiosk() {
        kioskArmed = true
        applyImmersive()
        startLockTaskQuietly()
    }

    private fun disableKiosk() {
        kioskArmed = false
        try { stopLockTask() } catch (_: Exception) {}
        restoreSystemBars()
    }

    private fun startLockTaskQuietly() {
        try { startLockTask() } catch (_: Exception) {}
    }

    private fun applyImmersive() {
        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
        }
    }

    private fun restoreSystemBars() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.show(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    private fun forwardCustomKey(keyCode: Int, action: Int) {
        val payload = hashMapOf(
            "keyCode" to keyCode,
            "scanCode" to 300,
            "action" to action,
            "repeatCount" to 0,
        )
        hardwareSink?.success(payload)
    }
}