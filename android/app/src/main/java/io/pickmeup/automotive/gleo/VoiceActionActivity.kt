package io.pickmeup.automotive.gleo

import android.app.Activity
import android.content.ComponentName
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.widget.TextView
import io.pickmeup.automotive.BuildConfig

/** A visible, voice-initiated entry permits FGS startup under Android's normal lifecycle policy. */
class VoiceActionActivity : Activity() {
    private var requestStarted=false
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val permission=runCatching {packageManager.getActivityInfo(ComponentName(this,javaClass),0).permission}.getOrNull()
        if(savedInstanceState?.getBoolean("started")==true ||
            GleoActionHandler.canonicalAction(intent.action)!="START_PICKUP_SHARE" ||
            !GleoCallerVerifier.isTrusted(this,permission)) {
            finish();return
        }
        setContentView(TextView(this).apply {
            text="픽미업 · 길안내와 도착 알림을 준비하고 있어요."
            textSize=28f;gravity=Gravity.CENTER
            val palette=io.pickmeup.automotive.VehiclePalette()
            setTextColor(palette.accent);setBackgroundColor(palette.canvas)
        })
    }
    override fun onResume() {
        super.onResume()
        if(isFinishing || requestStarted)return
        requestStarted=true
        if(BuildConfig.DEBUG)Log.i("PickMeUpGleo","GLEO_VOICE_ACTIVITY_STARTED signaturePermission=true")
        GleoActionHandler.dispatch(this,intent,BuildConfig.GLEO_CALLER_PACKAGE,holdForWork=true) { finish() }
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("started",requestStarted);super.onSaveInstanceState(outState)
    }
}
