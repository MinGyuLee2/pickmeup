package io.pickmeup.automotive.gleo

import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.PermissionInfo
import io.pickmeup.automotive.BuildConfig

object GleoCallerVerifier {
    fun isTrusted(context: Context, componentPermission: String?, uid: Int = -1): Boolean {
        val expected=BuildConfig.GLEO_CALLER_PACKAGE
        val fingerprint=BuildConfig.GLEO_CALLER_SHA256
        val identified=uid>=0 && expected.isNotBlank() && context.packageManager.getPackagesForUid(uid)?.contains(expected)==true
        val ownerPinned=expected.isNotBlank() && fingerprint.length==64 && runCatching {
            val bytes=fingerprint.chunked(2).map {it.toInt(16).toByte()}.toByteArray()
            context.packageManager.hasSigningCertificate(expected,bytes,PackageManager.CERT_INPUT_SHA256)
        }.getOrDefault(false)
        val permission=runCatching {context.packageManager.getPermissionInfo(GleoCallerPolicy.ACTION_PERMISSION,0)}.getOrNull()
        return GleoCallerPolicy.allows(ownerPinned && permission?.packageName==expected,
            componentPermission==GleoCallerPolicy.ACTION_PERMISSION,
            permission?.protectionLevel==PermissionInfo.PROTECTION_SIGNATURE,uid>=0,identified)
    }
}
