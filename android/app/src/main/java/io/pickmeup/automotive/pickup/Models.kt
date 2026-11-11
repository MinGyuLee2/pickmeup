package io.pickmeup.automotive.pickup

import io.pickmeup.automotive.navigation.GeoPoint
import io.pickmeup.automotive.navigation.NavigationConnection
import io.pickmeup.automotive.navigation.NavigationState
import io.pickmeup.automotive.map.PlannedRoute

data class Pairing(val id: String, val deviceSecret: String, val claimUrl: String, val expiresAt: Long, val shareMessage: String="", val resendsRemaining: Int=0, val resendAfter: Long=0, val resendExpiresAt: Long=0, val verified: Boolean=false)
data class DeviceCredentials(val vehicleId: String, val token: String, val accountLinked: Boolean=true)
data class Contact(val id: String, val name: String, val aliases: List<String>, val meetingPlace: Destination? = null)
data class Destination(val point: GeoPoint, val name: String)
data class RecentPickup(val contactId: String, val recipientName: String, val destination: Destination)
data class Observation(val location: GeoPoint, val remainingSeconds: Int, val remainingMeters: Int,
    val locationAgeMs: Long, val etaAgeMs: Long) {
    val fresh get() = locationAgeMs in 0..30_000 && etaAgeMs in 0..30_000
}
data class NavigationUpload(val destination: Destination, val observation: Observation, val arrived: Boolean, val routeRevision: Long)
fun NavigationState.upload(elapsedNow: Long): NavigationUpload? {
    if (connection != NavigationConnection.CONNECTED) return null
    val point = location ?: return null
    val place = destination ?: return null
    val locationTime = locationElapsedAt ?: return null
    val etaTime = destinationElapsedAt ?: return null
    val locationAge = elapsedNow - locationTime
    val etaAge = elapsedNow - etaTime
    if (locationAge !in 0..86_400_000 || etaAge !in 0..86_400_000) return null
    return NavigationUpload(Destination(place.point, place.name),
        Observation(point, place.remainingSeconds, place.remainingMeters, locationAge, etaAge), arrived, routeRevision)
}
data class Pickup(val id: String, val state: String, val readiness: String, val recipientName: String,
    val destination: Destination, val remainingSeconds: Int?, val freshness: String,
    val sequence: Long, val version: Long, val expiresAt: Long,
    val messageStatus: String? = null, val nearMessageStatus: String? = null, val nearMessageIncluded: Boolean = false,
    val messageProvider: String? = null, val recipientLocation: RecipientLocation? = null, val vehiclePoint: GeoPoint? = null,
    val smsConfirmed: Boolean = true, val messageResendsRemaining: Int=0, val messageResendAfter: Long=0, val vehicleModelKey: String?=null,
    val plannedRoute: PlannedRoute?=null,
    val shareCodeLocked: Boolean=false, val shareRenewalsRemaining: Int=0, val shareRenewAfter: Long=0,
    val messageQueuedAt: Long=0, val waitingPoint: GeoPoint?=null) {
    val simulatedDelivery get() = messageProvider=="local" || messageStatus=="SIMULATED"
}
data class UploadResult(val accepted: Boolean, val pickup: Pickup?, val reason: String?)
data class PendingEnd(val pickupId: String?, val reason: String, val startKey: String? = null)
data class ShareMessage(val pickupId: String, val recipientName: String, val maskedPhone: String, val message: String)
data class VehicleUiState(val paired: Boolean = false, val pairing: Pairing? = null,
    val contacts: List<Contact> = emptyList(), val pickup: Pickup? = null,
    val recentPickups: List<RecentPickup> = emptyList(),
    val busy: Boolean = false, val preparingRoute: Boolean = false, val streamConnected: Boolean = false, val pendingEnd: Boolean = false, val pendingStart: Boolean = false,
    val message: String = "차량을 연결해 주세요.", val error: String? = null,
    val messageNoticePickupId: String? = null, val accountLinked: Boolean=true)

interface CredentialStore {
    fun confirmServerIdentity(vehicleId: String) {}
    fun guestInstallationKey(): String? = null
    fun saveGuestInstallationKey(value: String) {}
    fun pendingPairing(): Pairing? = null
    fun savePendingPairing(value: Pairing?) {}
    fun recentPickups(): List<RecentPickup> = emptyList()
    fun saveRecentPickups(value: List<RecentPickup>) {}
    fun read(): DeviceCredentials?
    fun save(credentials: DeviceCredentials)
    fun pendingEnd(): PendingEnd?
    fun savePendingEnd(value: PendingEnd?)
    fun pendingStart(): String?
    fun savePendingStart(key: String?)
}
interface PickupGateway {
    suspend fun startGuest(installationKey: String): DeviceCredentials = throw UnsupportedOperationException("바로 시작을 지원하지 않는 연결입니다.")
    suspend fun accountLinked(): Boolean? = null
    suspend fun cancelOnboarding(pairing: Pairing) {}
    suspend fun startOnboarding(phone: String): Pairing = throw UnsupportedOperationException("문자 설정을 지원하지 않는 연결입니다.")
    suspend fun onboardingMessage(pairing: Pairing): Pairing = pairing
    suspend fun resendOnboarding(pairing: Pairing): Pairing = throw UnsupportedOperationException()
    suspend fun pairingStatus(pairing: Pairing): DeviceCredentials?
    suspend fun contacts(): List<Contact>
    suspend fun importContact(name: String, phone: String): Contact = throw UnsupportedOperationException("차량 연락처 추가를 지원하지 않는 연결입니다.")
    suspend fun saveMeetingPlace(contactId: String, place: Destination?): Unit = throw UnsupportedOperationException("만날 곳 저장을 지원하지 않는 연결입니다.")
    suspend fun current(): Pickup?
    suspend fun shareMessage(id: String): ShareMessage = throw UnsupportedOperationException()
    suspend fun confirmMessage(id: String): Pickup = throw UnsupportedOperationException()
    suspend fun resendMessage(id: String): Pickup = throw UnsupportedOperationException()
    suspend fun renewAccess(id: String,key: String): Pickup = throw UnsupportedOperationException()
    suspend fun start(alias: String, key: String, navigation: NavigationUpload, contactId: String? = null): Pickup
    suspend fun upload(id: String, sequence: Long, navigation: NavigationUpload): UploadResult
    suspend fun end(id: String, reason: String)
    suspend fun cancelStart(key: String)
    suspend fun events(onSnapshot: suspend (Pickup?) -> Unit, onConnected: suspend () -> Unit)
    fun closeEvents()
}
class ApiFailure(val status: Int, val code: String, override val message: String) : Exception(message)
interface SyncLifetime { fun start(); fun stop() }
