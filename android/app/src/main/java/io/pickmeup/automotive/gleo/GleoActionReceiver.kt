package io.pickmeup.automotive.gleo

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.ComponentName
import android.os.Build
import android.util.Log
import io.pickmeup.automotive.BuildConfig

/** Android enforces Gleo's signature permission; its owner is also certificate-pinned here. */
class GleoActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if(!GleoActionHandler.supports(intent.action))return
        val uid=if(Build.VERSION.SDK_INT>=34)sentFromUid else -1
        val permission=runCatching {context.packageManager.getReceiverInfo(ComponentName(context,javaClass),0).permission}.getOrNull()
        if(!GleoCallerVerifier.isTrusted(context,permission,uid)) {
            Log.w("PickMeUpGleo","GLEO_CALLER_REJECTED identityAvailable=${uid>=0}")
            return
        }
        if(BuildConfig.DEBUG)Log.i("PickMeUpGleo","GLEO_CALLER_ACCEPTED signaturePermission=true identityAvailable=${uid>=0}")
        GleoActionHandler.dispatch(context,intent,goAsync(),BuildConfig.GLEO_CALLER_PACKAGE)
    }
}
