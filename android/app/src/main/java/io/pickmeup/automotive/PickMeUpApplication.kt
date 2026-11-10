package io.pickmeup.automotive

import android.app.Application
import android.app.ForegroundServiceStartNotAllowedException
import android.os.Build
import android.content.Intent
import android.os.SystemClock
import io.pickmeup.automotive.gleo.awaitVoiceNavigation
import io.pickmeup.automotive.gleo.awaitVoiceNavigationConnection
import io.pickmeup.automotive.pickup.Pickup
import io.pickmeup.automotive.pickup.ApiFailure
import io.pickmeup.automotive.navigation.NaviDataSource
import io.pickmeup.automotive.pickup.HttpPickupGateway
import io.pickmeup.automotive.pickup.KeystoreCredentials
import io.pickmeup.automotive.pickup.PickupCoordinator
import io.pickmeup.automotive.pickup.PickupSyncService
import io.pickmeup.automotive.pickup.SyncLifetime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class PickMeUpApplication : Application() {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val navigation by lazy { NaviDataSource(this, appScope) }
    private var uiVisible=false
    private var syncRequested=false
    private var voiceNavigationUsers=0
    private val messagePreferences by lazy {getSharedPreferences("pickmeup-ui",MODE_PRIVATE)}
    var immediateMessage: Boolean
        get()=messagePreferences.getBoolean("immediateMessage",false)
        set(value){messagePreferences.edit().putBoolean("immediateMessage",value).apply()}
    private val credentials by lazy { KeystoreCredentials(this) }
    val coordinator by lazy {
        PickupCoordinator(appScope,navigation.state,HttpPickupGateway(credentials),credentials,
            object: SyncLifetime {
                override fun start() {
                    try { startForegroundService(Intent(this@PickMeUpApplication,PickupSyncService::class.java)) }
                    catch(error: IllegalStateException) {
                        if(Build.VERSION.SDK_INT>=31 && error is ForegroundServiceStartNotAllowedException)
                            throw ApiFailure(409,"BACKGROUND_START_RESTRICTED","정차 후 픽미업을 열어 공유를 시작해 주세요.")
                        throw error
                    }
                    syncRequested=true
                }
                override fun stop() {
                    syncRequested=false
                    stopService(Intent(this@PickMeUpApplication,PickupSyncService::class.java))
                    closeNavigationIfIdle()
                }
            },SystemClock::elapsedRealtime,routeTo=navigation::prepareRoute)
    }
    suspend fun startSavedPickup(contactId: String) {
        voiceNavigationUsers++
        try {navigation.start();coordinator.startSavedShare(contactId)}
        finally {voiceNavigationUsers--;closeNavigationIfIdle()}
    }
    suspend fun startPlannedPickup(contactId: String, place: io.pickmeup.automotive.pickup.Destination,sendMessage: Boolean=false) {
        voiceNavigationUsers++
        try {navigation.start();coordinator.startPlannedShare(contactId,place,sendMessage)}
        finally {voiceNavigationUsers--;closeNavigationIfIdle()}
    }
    fun onUiVisibility(visible: Boolean) {
        uiVisible=visible
        if(visible)navigation.start() else closeNavigationIfIdle()
    }
    suspend fun openPlaceSelection() {
        voiceNavigationUsers++
        try {navigation.openPlaceSelection()}
        finally {voiceNavigationUsers--;closeNavigationIfIdle()}
    }
    suspend fun startVoicePickup(alias: String): Pickup {
        // Capture the saved choice before navigation suspends; later changes belong to the next start.
        val sendMessage=immediateMessage
        voiceNavigationUsers++
        try {
            return coordinator.startVoiceShare(alias,sendMessage=sendMessage) {hasSavedPlace ->
                navigation.start();navigation.requestSnapshot()
                if(hasSavedPlace) {
                    if(!awaitVoiceNavigationConnection(navigation.state))
                        throw ApiFailure(409,"NAVIGATION_UNAVAILABLE","내비 연결을 확인한 뒤 다시 시작해 주세요.")
                } else if(!awaitVoiceNavigation(navigation.state,SystemClock::elapsedRealtime))
                    throw ApiFailure(409,"NAVIGATION_STALE","저장한 만날 곳이 없어요. 정차 후 장소를 저장하거나 내비에서 목적지를 설정해 주세요.")
            }
        } finally {
            voiceNavigationUsers--
            closeNavigationIfIdle()
        }
    }
    private fun closeNavigationIfIdle() {
        if(!uiVisible && !syncRequested && voiceNavigationUsers==0)navigation.close()
    }
}
