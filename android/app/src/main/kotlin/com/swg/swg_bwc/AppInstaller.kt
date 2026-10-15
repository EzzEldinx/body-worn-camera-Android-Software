package com.swg.swg_bwc

import android.app.PendingIntent
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import java.io.File
import java.security.MessageDigest

/**
 * Remote app updates. A downloaded APK is installed with PackageInstaller. When this app is the device owner
 * (set once per camera with `dpm set-device-owner`) the install is silent; otherwise Android asks for a tap.
 */
object AppInstaller {
    const val ACTION_RESULT = "com.swg.swg_bwc.INSTALL_RESULT"

    /** Called with (status, message): success | pending_user | failed. Set by MainActivity. */
    @Volatile
    var onResult: ((String, String) -> Unit)? = null

    /** SHA-256 of the APK this app was installed from: the build id the control room compares against. */
    fun appBuild(ctx: Context): String {
        val md = MessageDigest.getInstance("SHA-256")
        File(ctx.applicationInfo.sourceDir).inputStream().use { input ->
            val buf = ByteArray(1 shl 16)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    fun isDeviceOwner(ctx: Context): Boolean {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        return dpm.isDeviceOwnerApp(ctx.packageName)
    }

    fun install(ctx: Context, path: String) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            val apk = File(path)
            apk.inputStream().use { input ->
                session.openWrite("app.apk", 0, apk.length()).use { out ->
                    input.copyTo(out)
                    session.fsync(out)
                }
            }
            val intent = Intent(ACTION_RESULT).setPackage(ctx.packageName)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val pending = PendingIntent.getBroadcast(ctx, id, intent, flags)
            session.commit(pending.intentSender)
        }
        Log.i("BWC", "install session $id committed (deviceOwner=${isDeviceOwner(ctx)})")
    }
}

/** Receives the installer's verdict; asks the user to confirm when the install is not silent. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
        Log.i("BWC", "install result status=$status $msg")
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(confirm)
                }
                AppInstaller.onResult?.invoke("pending_user", msg)
            }
            PackageInstaller.STATUS_SUCCESS -> AppInstaller.onResult?.invoke("success", msg)
            else -> AppInstaller.onResult?.invoke("failed", msg.ifEmpty { "status $status" })
        }
    }
}

/** After an update the system stops the app: bring it straight back. */
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(launch)
        } catch (e: Exception) {
            Log.w("BWC", "restart after update failed: $e")
        }
    }
}

/** Needed so the app can be made the device owner (silent installs): adb shell dpm set-device-owner. */
class BwcAdminReceiver : DeviceAdminReceiver()
