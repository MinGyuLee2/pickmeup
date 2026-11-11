package io.pickmeup.automotive.filming

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.pickmeup.automotive.BuildConfig
import io.pickmeup.automotive.PickMeUpApplication
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Local shell controls only: Android enforces DUMP; no exported activity or web bridge. */
class FilmingControlReceiver:BroadcastReceiver() {
    override fun onReceive(context:Context,intent:Intent) {
        if(!BuildConfig.DEBUG||!BuildConfig.FILMING_MODE)return
        val requestId=intent.getStringExtra("requestId") ?: return
        if(!Regex("[a-f0-9-]{36}").matches(requestId))return
        val app=context.applicationContext as PickMeUpApplication
        val nav=app.navigation as FilmingNavigation
        val result=goAsync()
        app.appScope.launch {
            try {
                val command=intent.getStringExtra("command")?:"status"
                if(command=="reset") {
                    app.coordinator.endShare()
                    check(app.coordinator.state.value.pickup==null && !app.coordinator.state.value.pendingEnd)
                    nav.resetAfterConfirmedEnd()
                } else if(command!="status")nav.command(command,intent.getStringExtra("value")?.toDoubleOrNull())
                context.filesDir.resolve("filming-status-$requestId.json").writeText(nav.status().put("ok",true).toString())
            }catch(e:Exception){context.filesDir.resolve("filming-status-$requestId.json").writeText(JSONObject().put("ok",false).put("error",e.message?:"촬영 명령 실패").toString())}
            finally{result.finish()}
        }
    }
}
