package io.pickmeup.automotive.map

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.SystemClock
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import io.pickmeup.automotive.BuildConfig
import io.pickmeup.automotive.VehiclePalette
import io.pickmeup.automotive.navigation.GeoPoint
import io.pickmeup.automotive.navigation.NavigationState
import io.pickmeup.automotive.pickup.Pickup
import org.json.JSONArray
import org.json.JSONObject

/** An automatic, read-only Kakao map; no account token or JS-to-native bridge. */
internal class PickupMapPanel(context: Context): FrameLayout(context) {
    private val colors=VehiclePalette()
    private val map=KakaoMapSurface(context)
    private val warning=TextView(context).apply {
        textSize=18f;setTextColor(colors.warning);setPadding(dp(16),dp(10),dp(16),dp(10))
        background=GradientDrawable().apply {setColor(this@PickupMapPanel.colors.warningSurface);cornerRadius=dp(12).toFloat()}
        visibility=GONE
    }
    private fun dp(n: Int)=(n*resources.displayMetrics.density).toInt()
    init {
        minimumHeight=dp(if(resources.configuration.screenHeightDp<650)180 else 280)
        background=GradientDrawable().apply {setColor(Color.rgb(6,17,13));cornerRadius=dp(16).toFloat()};clipToOutline=true
        addView(map,LayoutParams(-1,-1));addView(warning,LayoutParams(-2,-2,Gravity.TOP or Gravity.START).apply {setMargins(dp(16),dp(16),dp(16),0)})
    }
    fun render(pickup: Pickup?,nav: NavigationState,parked: Boolean) {
        visibility=if(pickup==null)GONE else VISIBLE;map.parked=parked
        if(pickup==null){warning.visibility=GONE;warning.text="";map.show(null);return}
        val sample=pickup.recipientLocation;val now=SystemClock.elapsedRealtime();val target=RecipientMapTarget.resolve(pickup.waitingPoint,sample,now);val state=target.state
        warning.visibility=if(target.point!=null && state in listOf("PAUSED","STALE"))VISIBLE else GONE
        warning.text=if(warning.visibility==VISIBLE)"위치 갱신 중단" else ""
        val car=nav.location ?: pickup.vehiclePoint
        val carFresh=nav.locationElapsedAt?.let {now-it in 0..30_000}==true
        val focus=PickupMapFrame.focus(pickup.destination.point,car,target.point)
        val payload=JSONObject().put("destination",point(pickup.destination.point)).put("car",car?.let(::point) ?: JSONObject.NULL)
            .put("route",pickup.plannedRoute?.takeIf {pickup.state=="ACTIVE"&&it.visibleAt(now)}?.let {route->JSONObject().put("path",JSONArray(route.path.map {JSONArray(listOf(it.longitude,it.latitude))})).put("traveledPaths",JSONArray(route.traveledPaths.map {p->JSONArray(p.map {JSONArray(listOf(it.longitude,it.latitude))})})).put("validForMs",route.validForMs-(now-route.receivedElapsedAt))} ?: JSONObject.NULL)
            .put("vehicleModelKey",pickup.vehicleModelKey ?: JSONObject.NULL)
            .put("recipient",target.point?.let(::point) ?: JSONObject.NULL).put("manual",target.manual)
            .put("parked",parked).put("live",state=="LIVE").put("carFresh",carFresh).put("focus",JSONArray(focus.map(::point)))
        map.show(payload.toString())
        map.contentDescription="차량과 ${pickup.recipientName} 위치 지도. "+when(state){"PINNED"->"상대가 직접 지정한 대기 위치";"LIVE"->"위치 공유 중";"PAUSED","STALE"->"마지막 위치, 갱신 중단";else->"상대 위치 공유 대기"}
    }
    private fun point(p: GeoPoint)=JSONObject().put("latitude",p.latitude).put("longitude",p.longitude)
}

@SuppressLint("SetJavaScriptEnabled")
private class KakaoMapSurface(context: Context): FrameLayout(context) {
    var parked=false
    private var web: WebView?=null
    private var ready=false
    private var payload: String?=null
    private var sent: String?=null
    fun show(value: String?) {
        payload=value
        if(value==null){release();return}
        if(web==null&&isAttachedToWindow)create()
        push()
    }
    private fun create() {
        if(BuildConfig.KAKAO_MAP_JS_KEY.isBlank()) {
            removeAllViews();addView(TextView(context).apply {text="카카오 지도 설정을 확인해 주세요";gravity=Gravity.CENTER;setTextColor(VehiclePalette().muted)},LayoutParams(-1,-1));return
        }
        val view=object:WebView(context){
            override fun onTouchEvent(event: MotionEvent): Boolean=if(parked)super.onTouchEvent(event) else true
            override fun performClick(): Boolean=if(parked)super.performClick() else false
        }
        view.setBackgroundColor(Color.rgb(6,17,13))
        view.settings.apply {
            javaScriptEnabled=true;domStorageEnabled=false;databaseEnabled=false;setGeolocationEnabled(false)
            allowFileAccess=false;allowContentAccess=false;mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically=false;setSupportMultipleWindows(false);setSupportZoom(false)
        }
        view.webChromeClient=object:WebChromeClient(){override fun onConsoleMessage(message:android.webkit.ConsoleMessage)=true}
        view.webViewClient=object:WebViewClient() {
            override fun onPageFinished(view: WebView,url: String) {if(view===web&&url.startsWith(BuildConfig.KAKAO_MAP_ORIGIN)){ready=true;push()}}
            override fun shouldOverrideUrlLoading(view: WebView,request: WebResourceRequest):Boolean {
                val u=request.url
                if(parked&&request.isForMainFrame&&request.hasGesture()&&u.scheme=="https"&&u.host in setOf("map.kakao.com","maps.kakao.com","www.kakao.com"))runCatching {context.startActivity(Intent(Intent.ACTION_VIEW,u))}
                return true
            }
        }
        removeAllViews();addView(view,LayoutParams(-1,-1));web=view;ready=false;sent=null
        val html=context.assets.open("map/pickup.html").bufferedReader().use {it.readText()}.replace("__PMU_KAKAO_KEY__",Uri.encode(BuildConfig.KAKAO_MAP_JS_KEY))
            .replace("__PMU_MAP_CAMERA__",context.assets.open("map/camera.js").bufferedReader().use {it.readText()})
            .replace("__PMU_WAITING_ROADVIEW__",context.assets.open("map/waiting-roadview.js").bufferedReader().use {it.readText()})
            .replace("__PMU_MAP_VIEWPORT__",context.assets.open("map/viewport.js").bufferedReader().use {it.readText()})
            .replace("__PMU_MAP_ROUTE__",context.assets.open("map/route.js").bufferedReader().use {it.readText()})
            .replace("__PMU_CAR_IMAGE__",android.util.Base64.encodeToString(context.assets.open("map/ioniq5.png").use {it.readBytes()},android.util.Base64.NO_WRAP))
        view.loadDataWithBaseURL(BuildConfig.KAKAO_MAP_ORIGIN,html,"text/html",null,BuildConfig.KAKAO_MAP_ORIGIN)
    }
    private fun push(){val data=payload ?: return;if(ready&&sent!=data){web?.evaluateJavascript("window.pickmeupMap?.render($data);",null);sent=data}}
    private fun release(){ready=false;sent=null;web?.let {it.stopLoading();it.evaluateJavascript("window.pickmeupMap?.render(null);",null);it.loadUrl("about:blank");removeView(it);it.destroy()};web=null}
    override fun onAttachedToWindow(){super.onAttachedToWindow();if(payload!=null&&web==null)create()}
    override fun onDetachedFromWindow(){release();super.onDetachedFromWindow()}
}
