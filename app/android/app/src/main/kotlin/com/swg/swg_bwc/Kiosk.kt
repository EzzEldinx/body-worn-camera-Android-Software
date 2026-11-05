package com.swg.swg_bwc

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.util.Log

/**
 * On a camera provisioned as device owner (tools/update-cameras.ps1 -Provision) this app becomes the Home app.
 * Android then starts it by itself after a remote update, a crash or a reboot; without that, an update would
 * leave the camera sitting on the launcher.
 * Cameras that are not provisioned are untouched (the Home entry stays disabled).
 */
object Kiosk {
    private fun alias(ctx: Context) = ComponentName(ctx, "com.swg.swg_bwc.HomeAlias")

    fun applyHome(ctx: Context) {
        if (!AppInstaller.isDeviceOwner(ctx)) return
        try {
            ctx.packageManager.setComponentEnabledSetting(alias(ctx), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
            val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val admin = ComponentName(ctx, BwcAdminReceiver::class.java)
            val filter = IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addCategory(Intent.CATEGORY_DEFAULT)
            }
            dpm.addPersistentPreferredActivity(admin, filter, alias(ctx))
            Log.i("BWC", "kiosk: this app is the Home app")
        } catch (e: Exception) {
            Log.w("BWC", "kiosk home setup failed: $e")
        }
    }

    /** Undo everything provisioning did. */
    fun release(ctx: Context) {
        val dpm = ctx.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (dpm.isDeviceOwnerApp(ctx.packageName)) {
            val admin = ComponentName(ctx, BwcAdminReceiver::class.java)
            dpm.clearPackagePersistentPreferredActivities(admin, ctx.packageName)
            ctx.packageManager.setComponentEnabledSetting(alias(ctx), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
            dpm.clearDeviceOwnerApp(ctx.packageName)
        }
    }
}

/**
 * adb-only control: `adb shell content call --uri content://com.swg.swg_bwc.control --method unprovision`.
 * Anything that is not the adb shell (or root) is refused.
 */
class ControlProvider : ContentProvider() {
    override fun onCreate() = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        val uid = Binder.getCallingUid()
        if (uid != 2000 && uid != 0) throw SecurityException("adb only")
        val ctx = context ?: return null
        val out = Bundle()
        when (method) {
            "unprovision" -> {
                Kiosk.release(ctx)
                out.putString("result", "released; deviceOwner=${AppInstaller.isDeviceOwner(ctx)}")
            }
            "status" -> out.putString("result", "deviceOwner=${AppInstaller.isDeviceOwner(ctx)}")
            else -> out.putString("result", "unknown method")
        }
        return out
    }

    override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
}
