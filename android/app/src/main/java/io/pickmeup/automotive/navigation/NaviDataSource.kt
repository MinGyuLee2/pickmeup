package io.pickmeup.automotive.navigation

import android.content.Context
import android.util.Log
import android.os.SystemClock
import ai.pleos.playground.navi.constants.NaviErrorCode
import ai.pleos.playground.navi.data.CurrentLocationInfo
import ai.pleos.playground.navi.data.DestinationArrivedInfo
import ai.pleos.playground.navi.data.DestinationInfo
import ai.pleos.playground.navi.data.RecentDestinationInfo
import ai.pleos.playground.navi.data.NavigationScreenRequest
import io.pickmeup.automotive.pickup.distinctPlaces
import ai.pleos.playground.navi.data.RouteInfo
import ai.pleos.playground.navi.data.RouteStateInfo
import ai.pleos.playground.navi.constants.NaviMode
import ai.pleos.playground.navi.constants.NavigationStatus
import io.pickmeup.automotive.pickup.upload
import io.pickmeup.automotive.pickup.ApiFailure
import io.pickmeup.automotive.pickup.Destination
import ai.pleos.playground.navi.helper.NaviHelper
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** SDK values only; reception time is not presented as the GPS fix time. */
class NaviDataSource(context: Context, private val scope: CoroutineScope) {
    private val applicationContext=context.applicationContext
    private val helper = NaviHelper(context.applicationContext)
    private val mutable = MutableStateFlow(NavigationState())
    val state = mutable.asStateFlow()
    private var polling: Job? = null
    private var generation = 0L
    private var preparingRoute = false
    private var listener: NaviHelperEventListener? = null

    private fun createListener(session: Long) = object : NaviHelperEventListener {
        override fun onRecentDestinationInfo(recentDestinationInfoList: List<RecentDestinationInfo>) {
            scope.launch {if(session!=generation)return@launch
                val places=recentDestinationInfoList.take(30).mapNotNull {row->runCatching {
                    require(row.name.isNotBlank());Destination(GeoPoint(row.latitude,row.longitude),row.name)
                }.getOrNull()}.distinctPlaces()
                mutable.value=mutable.value.copy(recentDestinations=places)
                Log.i(TAG,"NAVI_RECENT count=${places.size}")
            }
        }
        override fun onCurrentLocationInfo(currentLocationInfo: CurrentLocationInfo) {
            scope.launch { if(session != generation)return@launch;
                runCatching { GeoPoint(currentLocationInfo.latitude, currentLocationInfo.longitude) }
                    .onSuccess { point ->
                        val count=mutable.value.locationUpdates+1
                        mutable.value = mutable.value.copy(location = point, locationReceivedAt = System.currentTimeMillis(), locationElapsedAt = SystemClock.elapsedRealtime(),
                            locationUpdates = count, lastEvent = "현재 위치 수신", error = null)
                        Log.i(TAG, "NAVI_LOCATION count=$count")
                    }.onFailure { recordError("유효하지 않은 위치를 수신했습니다") }
            }
        }
        override fun onDestinationInfo(destinationInfo: DestinationInfo) {
            scope.launch { if(session != generation)return@launch;
                // The emulator returns an empty name and zero values when no route is active.
                // That response is not a valid destination with a zero-minute ETA.
                if (destinationInfo.name.isBlank()) { clearDestination("설정된 목적지가 없습니다", changed = mutable.value.destination != null); return@launch }
                runCatching {
                    PickupDestination(GeoPoint(destinationInfo.latitude, destinationInfo.longitude),
                        destinationInfo.name, destinationInfo.remainTime, destinationInfo.remainDistance)
                }.onSuccess { destination ->
                    val count=mutable.value.destinationUpdates+1
                    mutable.value = mutable.value.copy(destination = destination, destinationReceivedAt = System.currentTimeMillis(), destinationElapsedAt = SystemClock.elapsedRealtime(),
                        routeKnown = true, routeCancelled = false,
                        destinationUpdates = count, lastEvent = "목적지·남은 시간 수신", error = null)
                    Log.i(TAG, "NAVI_DESTINATION count=$count")
                }.onFailure { recordError("유효한 경로의 남은 시간을 기다리고 있습니다") }
            }
        }
        override fun onDestinationChanged() { scope.launch { if(session != generation)return@launch; clearDestination("목적지 변경"); requestSnapshot() } }
        override fun onRoutingCompleted() { scope.launch {
            if(session != generation)return@launch
            val current=mutable.value
            mutable.value=if(preparingRoute)current.copy(routingCompletions=current.routingCompletions+1,
                destination=null,destinationElapsedAt=null,arrived=false)
                else current.copy(routingCompletions=current.routingCompletions+1)
            requestSnapshot()
        } }
        override fun onRouteCancelled() { scope.launch { if(session != generation)return@launch; clearDestination("경로 취소", cancelled = true) } }
        override fun onNavigationStatus(status: NavigationStatus) {scope.launch {
            if(session!=generation)return@launch
            mutable.value=mutable.value.copy(guiding=status==NavigationStatus.ROUTE_DRIVE,guidanceUpdates=mutable.value.guidanceUpdates+1)
        }}
        override fun onRouteStateInfo(routeStateInfo: RouteStateInfo) {scope.launch {
            if(session!=generation)return@launch
            mutable.value=mutable.value.copy(guiding=routeStateInfo.naviMode==NaviMode.ROUTE_GUIDING,guidanceUpdates=mutable.value.guidanceUpdates+1)
        }}
        override fun onDestinationArrived(destinationArrivedInfo: DestinationArrivedInfo) {
            scope.launch { if(session != generation)return@launch; mutable.value = mutable.value.copy(arrived = true, lastEvent = "픽업 지점 근처 도착") }
        }
        override fun onError(errorCode: NaviErrorCode) { scope.launch { if(session != generation)return@launch;
            mutable.value=mutable.value.copy(routingErrors=mutable.value.routingErrors+1);recordError("내비 응답: $errorCode")
        } }
    }

    fun start() {
        if (mutable.value.connection in setOf(NavigationConnection.CONNECTING, NavigationConnection.CONNECTED)) return
        if(listener!=null)close()
        val session=++generation
        mutable.value = mutable.value.copy(connection = NavigationConnection.CONNECTING, error = null)
        listener=createListener(session).also(helper::addListener)
        helper.initialize(
            onConnected = { scope.launch {
                if(session != generation)return@launch
                mutable.value = mutable.value.copy(connection = NavigationConnection.CONNECTED, lastEvent = "NaviHelper 연결 성공")
                Log.i(TAG, "NAVI_CONNECTED")
                polling?.cancel()
                polling = scope.launch { while (isActive) { requestSnapshot(); delay(5_000) } }
            } },
            onFailed = { throwable -> scope.launch {
                if(session != generation)return@launch
                mutable.value = mutable.value.copy(connection = NavigationConnection.FAILED, error = throwable.message ?: "내비 연결 실패")
                Log.w(TAG, "NAVI_CONNECTION_FAILED", throwable)
            } },
        )
    }

    fun requestRecentDestinations() {
        if(mutable.value.connection==NavigationConnection.CONNECTED && !preparingRoute)
            runCatching {helper.getRecentDestinationInfo()}
    }
    suspend fun openPlaceSelection() {
        if(applicationContext.checkSelfPermission("pleos.car.permission.NAVI_CUSTOM_MAP")!=android.content.pm.PackageManager.PERMISSION_GRANTED)
            throw ApiFailure(503,"NAVIGATION_SEARCH_UNAVAILABLE","이 차량에서는 장소 검색 화면을 열 수 없어요. 순정 내비에서 직접 목적지를 설정한 뒤 선택해 주세요.")
        if(mutable.value.connection!=NavigationConnection.CONNECTED)
            throw ApiFailure(409,"NAVIGATION_UNAVAILABLE","내비 연결을 확인한 뒤 다시 검색해 주세요.")
        helper.requestNavigationScreen(NavigationScreenRequest.Foreground)
        delay(500)
    }
    fun requestSnapshot() {
        if (mutable.value.connection != NavigationConnection.CONNECTED) return
        runCatching { helper.getCurrentLocationInfo(); helper.getDestinationInfo();helper.getRouteStateInfo() }
            .onFailure { recordError(it.message ?: "내비 정보 요청 실패") }
    }
    suspend fun prepareRoute(place: Destination) {
        if(mutable.value.connection!=NavigationConnection.CONNECTED)
            throw ApiFailure(409,"NAVIGATION_UNAVAILABLE","내비 연결 후 다시 시작해 주세요.")
        val before=mutable.value
        val existing=before.upload(SystemClock.elapsedRealtime())
        if(before.guiding && existing!=null && existing.observation.fresh && !existing.arrived && place.matches(existing.destination))return
        val session=generation
        preparingRoute=true
        try {
        mutable.value=before.copy(destination=null,destinationElapsedAt=null,arrived=false,guiding=false,routeCancelled=false,error=null)
        helper.requestRoute(RouteInfo(latitude=place.point.latitude,longitude=place.point.longitude,
            displayLatitude=null,displayLongitude=null,poiName=place.name,poiId="",poiSubId="0",address=""))
        val ready=withTimeoutOrNull(45_000) {
            state.first { sample ->
                if(session!=generation || sample.connection!=NavigationConnection.CONNECTED)
                    throw ApiFailure(409,"NAVIGATION_UNAVAILABLE","내비 연결이 끊겼어요. 다시 시작해 주세요.")
                if(sample.routingErrors>before.routingErrors || sample.routeCancelled)
                    throw ApiFailure(409,"ROUTE_FAILED","길안내를 시작하지 못했어요. 내비에서 만날 곳을 확인해 주세요.")
                sample.readyForSavedRoute(place,before,SystemClock.elapsedRealtime())
            }
        }
        if(ready==null)throw ApiFailure(409,"ROUTE_TIMEOUT","길안내 준비 시간이 지났어요. 내비에서 목적지를 확인한 뒤 다시 시작해 주세요.")
        } finally {preparingRoute=false}
    }

    private fun clearDestination(event: String, changed: Boolean = true, cancelled: Boolean = false) {
        val previous = mutable.value
        mutable.value = previous.copy(destination = null, destinationReceivedAt = null, destinationElapsedAt = null,
            routeRevision = previous.routeRevision + if (changed) 1 else 0,
            routeCancelled = cancelled || previous.routeCancelled, routeKnown = true,
            arrived = if (changed) false else previous.arrived, lastEvent = event)
        if (changed) Log.i(TAG, "NAVI_ROUTE_CHANGED")
    }
    private fun recordError(message: String) { mutable.value = mutable.value.copy(error = message) }
    fun close() {
        generation++
        polling?.cancel();polling=null
        listener?.let(helper::removeListener);listener=null
        helper.release()
        mutable.value = NavigationState()
    }
    companion object { private const val TAG = "PickMeUpNavi" }
}
