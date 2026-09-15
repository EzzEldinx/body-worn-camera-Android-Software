package com.swg.swg_bwc

import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * Native kiosk host for SWG-BWC-04 (Android 10).
 *
 * Dart cannot intercept HOME. While [kioskArmed] is true we:
 *  - apply immersive sticky / hide system bars
 *  - start lock-task (screen pinning)
 *  - consume KEYCODE_BACK
 *  - forward raw keyCode + scanCode to Flutter (KEY_CAMERA, 0x12d, 0x12e, MUTE)
 */
class MainActivity : FlutterActivity() {
    private val kioskChannelName = "com.swg.bwc/kiosk"
    private val hardwareChannelName = "com.swg.bwc/hardware_keys"

    @Volatile
    private var kioskArmed = false

    private var hardwareSink: EventChannel.EventSink? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, kioskChannelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "enableKiosk" -> {
                        runOnUiThread { enableKiosk() }
                        result.success(null)
                    }
                    "disableKiosk" -> {
                        runOnUiThread { disableKiosk() }
                        result.success(null)
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
                },
            )
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
    }

    override fun onResume() {
        super.onResume()
        if (kioskArmed) {
            applyImmersive()
            startLockTaskQuietly()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && kioskArmed) {
            applyImmersive()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (kioskArmed) {
            return
        }
        super.onBackPressed()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        forwardHardwareKey(event)
        if (kioskArmed && event.keyCode == KeyEvent.KEYCODE_BACK) {
            return true
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
        try {
            stopLockTask()
        } catch (_: Exception) {
        }
        restoreSystemBars()
    }

    private fun startLockTaskQuietly() {
        try {
            startLockTask()
        } catch (_: Exception) {
            // First pin on a non-DO device may show a system confirmation.
        }
    }

    private fun applyImmersive() {
        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.hide(
                    WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars(),
                )
                controller.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                )
        }
    }

    private fun restoreSystemBars() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.show(
                WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars(),
            )
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    private fun forwardHardwareKey(event: KeyEvent) {
        val payload = hashMapOf(
            "keyCode" to event.keyCode,
            "scanCode" to event.scanCode,
            "action" to event.action,
            "repeatCount" to event.repeatCount,
        )
        hardwareSink?.success(payload)
    }
}
