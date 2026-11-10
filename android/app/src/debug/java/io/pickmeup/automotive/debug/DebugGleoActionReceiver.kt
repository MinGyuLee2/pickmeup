package io.pickmeup.automotive.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.pickmeup.automotive.gleo.GleoActionHandler

/** Shell/instrumentation only, enforced by Android DUMP permission. Absent from release. */
class DebugGleoActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context,intent: Intent) {
        if(GleoActionHandler.supports(intent.action))GleoActionHandler.dispatch(context,intent,goAsync(),context.packageName,debug=true)
    }
}
