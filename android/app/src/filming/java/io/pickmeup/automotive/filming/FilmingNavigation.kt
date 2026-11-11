package io.pickmeup.automotive.filming

import android.content.Context
import android.os.SystemClock
import io.pickmeup.automotive.PickMeUpApplication
import io.pickmeup.automotive.navigation.*
import io.pickmeup.automotive.pickup.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import org.json.JSONObject

/** Compiled only in the filming variant. Never initializes or controls the vehicle NaviHelper. */
class FilmingNavigation(context:Context,private val scope:CoroutineScope):NavigationSource {
    private val route=JSONObject(context.assets.open("filming-route.json").bufferedReader().use {it.readText()})
    private val coordinates=route.getJSONArray("path")
    private val playback=RoutePlayback((0 until coordinates.length()).map {i->val p=coordinates.getJSONArray(i);GeoPoint(p.getDouble(1),p.getDouble(0))},route.getInt("durationSeconds"),SystemClock::elapsedRealtime)
    val destination=Destination(playback.points.last(),route.getString("name"))
    private val mutable=MutableStateFlow(NavigationState())
    override val state=mutable.asStateFlow()
    private var job:Job?=null
    private var watching=false
    private var revision=0L
    private var activePickup:String?=null
    private var stopOnNextPickup=false
    private var preparedForNewShare=false
    override fun start(){publish();if(job?.isActive!=true)job=scope.launch {while(isActive){publish();delay(250)}}}
    override fun close(){job?.cancel();job=null;playback.pause();publish()}
    override fun requestSnapshot()=publish()
    override fun requestRecentDestinations()=publish()
    override suspend fun openPlaceSelection(){throw ApiFailure(409,"FILMING_FIXED_ROUTE","촬영 중에는 준비된 만날 곳을 선택해 주세요.")}
    override suspend fun prepareRoute(place:Destination){
        if(!place.matches(destination))throw ApiFailure(409,"FILMING_FIXED_ROUTE","촬영 경로의 만날 곳을 선택해 주세요.")
        check(activePickup==null)
        playback.reset();preparedForNewShare=true
        start()
    }
    fun watchPickup(app:PickMeUpApplication) {
        if(watching)return;watching=true
        scope.launch {app.coordinator.state.collect {s->
            val id=s.pickup?.id
            if(id!=activePickup){
                activePickup=id
                if(id==null)playback.pause()
                else if(s.pickup?.state=="ACTIVE") {
                    if(preparedForNewShare){playback.reset();if(!stopOnNextPickup)playback.play()}
                    else {playback.seek((playback.durationSeconds-(s.pickup.remainingSeconds?:playback.durationSeconds).coerceIn(0,playback.durationSeconds)).toDouble());playback.pause()}
                    preparedForNewShare=false;stopOnNextPickup=false
                } else {playback.seek(playback.durationSeconds.toDouble());playback.pause();preparedForNewShare=false}
                publish()
            }
        }}
    }
    fun resetAfterConfirmedEnd(){activePickup=null;playback.reset();revision++;stopOnNextPickup=false;preparedForNewShare=false;publish()}
    fun command(command:String,value:Double?=null){
        when(command){
            "play"->{check(activePickup!=null){"음성 또는 앱에서 픽업을 먼저 시작해 주세요."};check(!playback.frame().arrived){"다시 찍기를 눌러 새 픽업을 시작해 주세요."};playback.play()}
            "pause"->{playback.pause();if(activePickup==null)stopOnNextPickup=true}
            "speed"->playback.setSpeed(requireNotNull(value))
            "seek"->{check(activePickup!=null);val elapsed=requireNotNull(value);require(elapsed>=playback.durationSeconds-playback.frame().remainingSeconds){"이전 시점은 다시 찍기로 시작해 주세요."};playback.seek(elapsed)}
            "reset"->{check(activePickup==null);playback.reset();revision++;stopOnNextPickup=false}
            else->error("지원하지 않는 촬영 명령입니다.")
        };publish()
    }
    fun status():JSONObject {
        val f=playback.frame()
        return JSONObject().put("playing",playback.playing).put("speed",playback.speed).put("progress",f.progress)
            .put("remainingSeconds",f.remainingSeconds).put("remainingMeters",f.remainingMeters).put("arrived",f.arrived)
            .put("latitude",f.location.latitude).put("longitude",f.location.longitude).put("pickupActive",activePickup!=null).put("pickupId",activePickup?:JSONObject.NULL)
    }
    private fun publish(){
        val f=playback.frame();val wall=System.currentTimeMillis();val elapsed=SystemClock.elapsedRealtime();val before=mutable.value
        mutable.value=before.copy(connection=NavigationConnection.CONNECTED,location=f.location,locationReceivedAt=wall,locationElapsedAt=elapsed,
            destination=PickupDestination(destination.point,destination.name,f.remainingSeconds,f.remainingMeters),destinationReceivedAt=wall,destinationElapsedAt=elapsed,
            routeKnown=true,guiding=true,arrived=f.arrived,routeCancelled=false,routeRevision=revision,recentDestinations=listOf(destination),
            locationUpdates=before.locationUpdates+1,destinationUpdates=before.destinationUpdates+1,lastEvent="촬영용 가상 주행",error=null)
    }
}
