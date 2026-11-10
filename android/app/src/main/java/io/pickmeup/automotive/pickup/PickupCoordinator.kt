package io.pickmeup.automotive.pickup

import io.pickmeup.automotive.navigation.NavigationState
import io.pickmeup.automotive.navigation.matches
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID
import java.text.Normalizer

/** UI, service and voice entry points share the same serialized operations. */
class PickupCoordinator(
    private val scope: CoroutineScope,
    private val navigation: StateFlow<NavigationState>,
    private val gateway: PickupGateway,
    private val credentials: CredentialStore,
    private val lifetime: SyncLifetime,
    private val elapsedNow: () -> Long,
    private val wallNow: () -> Long = System::currentTimeMillis,
    private val routeTo: suspend (Destination) -> Unit = { throw ApiFailure(503,"ROUTING_UNAVAILABLE","길안내 연결을 확인해 주세요.") },
) {
    private val initialPaired=credentials.read()!=null
    private val initialEnding=credentials.pendingEnd()!=null
    private val initialStarting=credentials.pendingStart()!=null
    private val mutable = MutableStateFlow(VehicleUiState(paired=initialPaired,accountLinked=credentials.read()?.accountLinked ?: true, pendingEnd=initialEnding,pendingStart=initialStarting,recentPickups=credentials.recentPickups(),
        message=if(initialEnding)"공유 종료 요청을 다시 확인하고 있어요." else if(initialStarting)"공유 시작 여부를 다시 확인하고 있어요." else if(initialPaired)"픽업 상태를 불러오고 있어요." else "차량을 연결해 주세요."))
    val state = mutable.asStateFlow()
    private val mutex = Mutex()
    private var pairingJob: Job? = null
    private var routePreparation: Deferred<Unit>? = null
    private var syncJob: Job? = null
    private var streamJob: Job? = null
    private var routeRevision = navigation.value.routeRevision
    private var sequence = 1L
    private var unresolvedStartAt: Long? = null
    private var workGeneration = 0L
    private val closedPickups = mutableSetOf<String>()

    init {
        scope.launch {
            navigation.collect { sample ->
                val pickup=mutable.value.pickup ?: return@collect
                if (sample.routeRevision != routeRevision) {
                    // Persist intent before waiting for any current HTTP upload to finish.
                    credentials.savePendingEnd(PendingEnd(pickup.id,if(sample.routeCancelled) "ROUTE_CANCELLED" else "DESTINATION_CHANGED"))
                    mutable.value=mutable.value.copy(pendingEnd=true,message="공유를 종료하고 있어요.")
                    launch { syncOnce() }
                }
            }
        }
    }

    private fun fail(error: Throwable) {
        if(error is CancellationException)throw error
        mutable.value=mutable.value.copy(busy=false,
            paired=if(error is ApiFailure && error.status==401) false else mutable.value.paired,
            error=if(error is ApiFailure)error.message else "서버 연결이 원활하지 않아요. 다시 연결하고 있습니다.")
    }
    suspend fun resume() = mutex.withLock {
        val pending=credentials.pendingPairing()
        if(pending!=null && pending.expiresAt>wallNow()) {
            mutable.value=mutable.value.copy(pairing=pending)
            if(pairingJob?.isActive!=true)watchPairing(pending)
            runCatching {gateway.onboardingMessage(pending)}.onSuccess {credentials.savePendingPairing(it);mutable.value=mutable.value.copy(pairing=it)}
        } else if(pending!=null){credentials.savePendingPairing(null);mutable.value=mutable.value.copy(pairing=null)}
        if(credentials.read()==null)return@withLock
        try {
            val linked=gateway.accountLinked() ?: credentials.read()!!.accountLinked
            if(linked!=credentials.read()!!.accountLinked)credentials.save(credentials.read()!!.copy(accountLinked=linked))
            mutable.value=mutable.value.copy(paired=true,accountLinked=linked,error=null)
            if(linked && pending!=null){pairingJob?.cancel();credentials.savePendingPairing(null);mutable.value=mutable.value.copy(pairing=null)}
            // A persisted end must retry even if the first status read is offline.
            if(credentials.pendingStart()!=null && unresolvedStartAt==null)unresolvedStartAt=elapsedNow()
            if(credentials.pendingEnd()!=null || credentials.pendingStart()!=null) { lifetime.start();startProcessing() }
            applySnapshot(gateway.current())
            val people=gateway.contacts()
            val history=mutable.value.recentPickups.filter {row->people.any {it.id==row.contactId}}
            if(history!=mutable.value.recentPickups)runCatching {credentials.saveRecentPickups(history)}
            mutable.value=mutable.value.copy(contacts=people,recentPickups=history)
            if(mutable.value.pickup!=null || credentials.pendingEnd()!=null) {
                lifetime.start();startProcessing()
            }
        } catch(error: Throwable) { fail(error) }
    }
    suspend fun startGuest() = mutex.withLock {
        if(credentials.read()!=null || mutable.value.busy || mutable.value.pickup!=null || credentials.pendingStart()!=null || credentials.pendingEnd()!=null)return@withLock
        mutable.value=mutable.value.copy(busy=true,error=null)
        try {
            val pending=mutable.value.pairing ?: credentials.pendingPairing()
            if(pending!=null) {
                pairingJob?.cancel();pairingJob=null
                suspend fun completed()=try {gateway.pairingStatus(pending)} catch(e:ApiFailure){if(e.status==410)null else throw e}
                var linked=completed()
                if(linked==null)try {gateway.cancelOnboarding(pending)} catch(e:ApiFailure){if(e.status!=410)throw e;linked=completed()}
                if(linked!=null) {
                    credentials.save(linked);credentials.savePendingPairing(null)
                    mutable.value=mutable.value.copy(paired=true,accountLinked=linked.accountLinked,pairing=null,busy=false,contacts=gateway.contacts(),error=null)
                    return@withLock
                }
                credentials.savePendingPairing(null);mutable.value=mutable.value.copy(pairing=null)
            }
            val key=credentials.guestInstallationKey() ?: (UUID.randomUUID().toString()+UUID.randomUUID().toString()).replace("-","").also {credentials.saveGuestInstallationKey(it)}
            val saved=gateway.startGuest(key)
            credentials.save(saved)
            mutable.value=mutable.value.copy(paired=true,accountLinked=saved.accountLinked,pairing=null,busy=false,error=null,message="픽업을 시작해 보세요.")
            mutable.value=mutable.value.copy(contacts=gateway.contacts())
        } catch(error:Throwable){fail(error)}
    }
    suspend fun createPairing(phone: String) = mutex.withLock {
        if(mutable.value.paired && mutable.value.accountLinked){mutable.value=mutable.value.copy(error="이미 계정에 연결된 차량이에요.");return@withLock}
        if(mutable.value.pendingStart || mutable.value.preparingRoute){mutable.value=mutable.value.copy(error="픽업 준비를 마친 뒤 계정을 연결해 주세요.");return@withLock}
        if(mutable.value.pickup!=null || credentials.pendingEnd()!=null) {
            mutable.value=mutable.value.copy(error="진행 중인 공유가 끝난 뒤 차량을 다시 연결해 주세요.");return@withLock
        }
        mutable.value=mutable.value.copy(busy=true,error=null)
        try {
            val pairing=gateway.startOnboarding(phone)
            mutable.value=mutable.value.copy(pairing=pairing,busy=false,message="문자로 받은 링크에서 설정을 완료해 주세요.")
            credentials.savePendingPairing(pairing)
            watchPairing(pairing)
        } catch(error: Throwable) { fail(error) }
    }
    private fun watchPairing(pairing: Pairing) {
        pairingJob?.cancel()
        pairingJob=scope.launch {
                while(isActive && wallNow()<pairing.expiresAt) {
                    try {
                        val saved=gateway.pairingStatus(pairing)
                        if(saved!=null) {
                            mutex.withLock {
                                credentials.save(saved)
                                credentials.savePendingPairing(null)
                                mutable.value=mutable.value.copy(paired=true,accountLinked=saved.accountLinked,pairing=null,contacts=gateway.contacts(),error=null,message="차량이 연결됐어요. 상대 이름을 선택해 주세요.")
                            }
                            return@launch
                        }
                    } catch(error: Throwable) {
                        if(error is CancellationException)throw error
                        if(error is ApiFailure && error.status==410)break
                        mutable.value=mutable.value.copy(error="차량 연결을 확인하고 있어요. 네트워크를 확인해 주세요.")
                    }
                    delay(3_000)
                }
                if(mutable.value.pairing?.id==pairing.id) {
                    credentials.savePendingPairing(null)
                    mutable.value=mutable.value.copy(pairing=null,error="연결 코드가 만료됐어요. 다시 열어 주세요.")
                }
            }
    }
    suspend fun pairingMessage(): Pairing = mutex.withLock {
        val current=mutable.value.pairing ?: throw ApiFailure(410,"SETUP_EXPIRED","다시 시작해 주세요.")
        val value=gateway.onboardingMessage(current)
        if(mutable.value.pairing?.id!=current.id)throw ApiFailure(409,"PAIRING_CHANGED","연결 요청이 바뀌었어요.")
        credentials.savePendingPairing(value);mutable.value=mutable.value.copy(pairing=value);value
    }
    suspend fun resendPairing() = mutex.withLock {
        val current=mutable.value.pairing ?: return@withLock
        if(mutable.value.busy)return@withLock
        if(current.verified||current.resendsRemaining<1||current.resendAfter>wallNow()||current.resendExpiresAt<=wallNow()) {
            mutable.value=mutable.value.copy(error="재전송 가능 횟수와 인증 시간을 확인해 주세요.");return@withLock
        }
        mutable.value=mutable.value.copy(busy=true,error=null)
        try {
            val value=gateway.resendOnboarding(current)
            credentials.savePendingPairing(value);mutable.value=mutable.value.copy(pairing=value,busy=false,message="설정 문자 재전송을 요청했어요.")
        } catch(error: Throwable) {
            runCatching {gateway.onboardingMessage(current)}.onSuccess {credentials.savePendingPairing(it);mutable.value=mutable.value.copy(pairing=it)}
            fail(error)
        }
    }
    suspend fun refreshContacts() = mutex.withLock {
        if(credentials.read()!=null && mutable.value.pickup==null && !mutable.value.busy) {
            runCatching { gateway.contacts() }.onSuccess { mutable.value=mutable.value.copy(contacts=it) }
        }
    }
    suspend fun importContact(name: String, phone: String): Contact = mutex.withLock {
        if(credentials.read()==null)throw ApiFailure(401,"VEHICLE_REQUIRED","차량을 먼저 연결해 주세요.")
        if(mutable.value.pickup!=null || credentials.pendingEnd()!=null || credentials.pendingStart()!=null)
            throw ApiFailure(409,"PICKUP_IN_PROGRESS","진행 중인 공유가 끝난 뒤 상대를 추가해 주세요.")
        mutable.value=mutable.value.copy(busy=true,error=null)
        try {
            val person=gateway.importContact(name,phone)
            mutable.value=mutable.value.copy(busy=false,contacts=listOf(person)+mutable.value.contacts.filter { it.id!=person.id },error=null)
            person
        } catch(error: Throwable) {fail(error);throw error}
    }
    suspend fun saveMeetingPlace(contactId: String, place: Destination?) = mutex.withLock {
        if(credentials.read()==null)throw ApiFailure(401,"VEHICLE_REQUIRED","차량을 먼저 연결해 주세요.")
        if(mutable.value.pickup!=null || credentials.pendingEnd()!=null || credentials.pendingStart()!=null)
            throw ApiFailure(409,"PICKUP_IN_PROGRESS","공유 종료 후 만날 곳을 변경해 주세요.")
        if(mutable.value.contacts.none {it.id==contactId})throw ApiFailure(404,"CONTACT_NOT_FOUND","상대를 다시 선택해 주세요.")
        mutable.value=mutable.value.copy(busy=true,error=null)
        try {
            gateway.saveMeetingPlace(contactId,place)
            mutable.value=mutable.value.copy(busy=false,contacts=mutable.value.contacts.map {if(it.id==contactId)it.copy(meetingPlace=place) else it},
                message=if(place==null)"저장한 만날 곳을 지웠어요." else "만날 곳을 저장했어요.")
        } catch(error: Throwable){fail(error);throw error}
    }
    suspend fun startVoiceShare(alias: String, sendMessage: Boolean=false, prepareNavigation: suspend (hasSavedPlace: Boolean) -> Unit): Pickup = mutex.withLock {
        if(credentials.read()==null)throw ApiFailure(401,"VEHICLE_REQUIRED","차량을 먼저 연결해 주세요.")
        if(mutable.value.pickup!=null || credentials.pendingEnd()!=null || credentials.pendingStart()!=null)
            throw ApiFailure(409,"PICKUP_IN_PROGRESS","이전 공유가 끝난 뒤 시작해 주세요.")
        val name=Normalizer.normalize(alias.trim(),Normalizer.Form.NFC)
        if(name.isBlank() || name.length>30 || name.any {it.isISOControl()})
            throw ApiFailure(400,"RECIPIENT_REQUIRED","상대 이름을 알려 주세요.")
        val existing=gateway.current()
        if(existing!=null) {
            applySnapshot(existing)
            throw ApiFailure(409,"PICKUP_IN_PROGRESS","진행 중인 픽업을 먼저 종료해 주세요.")
        }
        // Always resolve against this paired owner's latest list, including a cold voice launch.
        val people=gateway.contacts()
        val matches=people.filter {person -> (person.aliases+person.name).any {Normalizer.normalize(it,Normalizer.Form.NFC)==name}}
        if(matches.isEmpty())throw ApiFailure(404,"CONTACT_NOT_FOUND","등록한 상대 이름을 확인해 주세요.")
        if(matches.size!=1)throw ApiFailure(409,"AMBIGUOUS_RECIPIENT","같은 이름이 여러 명이에요. 차량에서 상대를 선택해 주세요.")
        val person=matches.single()
        mutable.value=mutable.value.copy(contacts=people,busy=true,error=null)
        try {
            prepareNavigation(person.meetingPlace!=null)
            val started=if(person.meetingPlace!=null)startSavedShareLocked(person.id) else startShareLocked(person.name,person.id)
            // Approve only the share returned by this successful start, never a recovered/existing share.
            if(sendMessage)confirmMessageLocked(started.id) else started
        } catch(error: Throwable){fail(error);throw error}
        finally {mutable.value=mutable.value.copy(busy=false)}
    }
    suspend fun startSavedShare(contactId: String): Pickup = mutex.withLock {startSavedShareLocked(contactId)}
    private suspend fun startSavedShareLocked(contactId: String): Pickup {
        val person=mutable.value.contacts.firstOrNull {it.id==contactId} ?: throw ApiFailure(404,"CONTACT_NOT_FOUND","상대를 다시 선택해 주세요.")
        val place=person.meetingPlace ?: throw ApiFailure(400,"PLACE_REQUIRED","만날 곳을 먼저 저장해 주세요.")
        return startPlannedShareLocked(contactId,place)
    }
    suspend fun startPlannedShare(contactId: String, place: Destination,sendMessage: Boolean=false): Pickup = mutex.withLock {
        if(credentials.read()==null)throw ApiFailure(401,"VEHICLE_REQUIRED","차량을 먼저 연결해 주세요.")
        if(mutable.value.pickup!=null || credentials.pendingEnd()!=null || credentials.pendingStart()!=null)
            throw ApiFailure(409,"PICKUP_IN_PROGRESS","이전 공유가 끝난 뒤 시작해 주세요.")
        val existing=gateway.current()
        if(existing!=null){applySnapshot(existing);throw ApiFailure(409,"PICKUP_IN_PROGRESS","진행 중인 픽업을 먼저 종료해 주세요.")}
        val started=startPlannedShareLocked(contactId,place)
        // Approval belongs to this explicit start only. Never apply a remembered choice to an existing/recovered pickup.
        if(sendMessage)try {confirmMessageLocked(started.id)}catch(error: Throwable){fail(error);throw error} else started
    }
    private suspend fun startPlannedShareLocked(contactId: String, place: Destination): Pickup {
        if(credentials.read()==null)throw ApiFailure(401,"VEHICLE_REQUIRED","차량을 먼저 연결해 주세요.")
        if(mutable.value.pickup!=null || credentials.pendingEnd()!=null || credentials.pendingStart()!=null)
            throw ApiFailure(409,"PICKUP_IN_PROGRESS","이전 공유가 끝난 뒤 시작해 주세요.")
        val person=mutable.value.contacts.firstOrNull {it.id==contactId} ?: throw ApiFailure(404,"CONTACT_NOT_FOUND","상대를 다시 선택해 주세요.")
        if(place.name.isBlank() || place.name.length>200 || !place.point.latitude.isFinite() || !place.point.longitude.isFinite() ||
            place.point.latitude !in -90.0..90.0 || place.point.longitude !in -180.0..180.0)
            throw ApiFailure(400,"PLACE_REQUIRED","올바른 만날 곳을 선택해 주세요.")
        mutable.value=mutable.value.copy(busy=true,preparingRoute=true,error=null,message="내비에서 ‘안내 시작’을 확인해 주세요. ${person.name}님과 만날 곳의 길안내와 도착 알림을 준비합니다.")
        return try {
            lifetime.start()
            val preparation=scope.async(start=CoroutineStart.LAZY){routeTo(place)}
            routePreparation=preparation
            try {preparation.await()}
            catch(error: CancellationException){throw ApiFailure(409,"ROUTE_CANCELLED","도착 알림 준비를 취소했어요. 길안내는 내비에서 종료할 수 있어요.")}
            finally {preparation.cancel();routePreparation=null}
            val sample=navigation.value.upload(elapsedNow())
            if(sample==null || !sample.observation.fresh || !place.matches(sample.destination) || sample.arrived)
                throw ApiFailure(409,"ROUTE_MISMATCH","저장한 만날 곳의 최신 길안내를 확인하지 못했어요.")
            startShareLocked(person.name,person.id)
        } catch(error: Throwable){
            if(mutable.value.pickup==null && credentials.pendingStart()==null)stopProcessing()
            fail(error);throw error
        }
        finally {mutable.value=mutable.value.copy(preparingRoute=false,busy=false)}
    }
    suspend fun startShare(alias: String, contactId: String? = null): Pickup = mutex.withLock { startShareLocked(alias,contactId) }
    private suspend fun startShareLocked(alias: String, contactId: String?): Pickup {
        if(alias.isBlank())throw ApiFailure(400,"RECIPIENT_REQUIRED","상대 이름을 선택해 주세요.")
        if(credentials.read()==null)throw ApiFailure(401,"VEHICLE_REQUIRED","휴대전화로 차량을 먼저 연결해 주세요.")
        if(credentials.pendingEnd()!=null)throw ApiFailure(409,"ENDING","이전 공유의 종료를 확인하고 있어요.")
        if(mutable.value.pendingStart)throw ApiFailure(409,"START_UNCONFIRMED","이전 공유의 시작 여부를 먼저 확인하거나 취소해 주세요.")
        val sample=navigation.value.upload(elapsedNow())
        if(sample==null || !sample.observation.fresh)throw ApiFailure(409,"NAVIGATION_STALE","최신 내비 위치와 목적지를 기다리고 있어요.")
        if(mutable.value.pickup!=null)throw ApiFailure(409,"PICKUP_ALREADY_ACTIVE","진행 중인 픽업을 먼저 종료해 주세요.")
        mutable.value=mutable.value.copy(busy=true,error=null)
        return try {
            lifetime.start() // May fail under OS background-start policy. Never bypass that policy.
            val key=credentials.pendingStart() ?: UUID.randomUUID().toString().also(credentials::savePendingStart)
            mutable.value=mutable.value.copy(pendingStart=true)
            unresolvedStartAt=elapsedNow()
            val started=gateway.start(alias,key,sample,contactId)
            val person=mutable.value.contacts.firstOrNull {it.id==contactId}
                ?: mutable.value.contacts.singleOrNull {alias==it.name || alias in it.aliases}
            if(person!=null) {
                val history=mutable.value.recentPickups.remember(RecentPickup(person.id,person.name,sample.destination))
                // History is optional; a storage failure must never turn an accepted SMS request into a retry.
                runCatching {credentials.saveRecentPickups(history)}
                mutable.value=mutable.value.copy(recentPickups=history)
            }
            credentials.savePendingStart(null);unresolvedStartAt=null
            routeRevision=sample.routeRevision;sequence=started.sequence
            mutable.value=mutable.value.copy(pickup=started,busy=false,pendingEnd=false,pendingStart=false,message=if(started.smsConfirmed)"공유를 시작했어요." else "공유를 시작했어요. 문자는 보내기 전에 확인해 주세요.",error=null,messageNoticePickupId=null)
            if(navigation.value.routeRevision!=routeRevision) {
                credentials.savePendingEnd(PendingEnd(started.id,"DESTINATION_CHANGED"))
                mutable.value=mutable.value.copy(pendingEnd=true,message="목적지가 바뀌어 공유를 종료하고 있어요.")
            }
            startProcessing()
            started
        } catch(error: Throwable) {
            fail(error)
            if(error is ApiFailure && error.status in 400..499) {
                credentials.savePendingStart(null);unresolvedStartAt=null
                mutable.value=mutable.value.copy(pendingStart=false)
                if(error.code=="PICKUP_ALREADY_ACTIVE")startProcessing() else stopProcessing()
            } else {
                if(unresolvedStartAt!=null) {
                    mutable.value=mutable.value.copy(message="공유 시작 결과를 확인하고 있어요.")
                    startProcessing()
                } else stopProcessing()
            }
            throw error
        }
    }
    suspend fun endShare(reason: String = "DRIVER_ENDED") {
        routePreparation?.let {it.cancel();return}
        endShareLocked(reason)
    }
    private suspend fun endShareLocked(reason: String) = mutex.withLock {
        if(credentials.read()==null)throw ApiFailure(401,"VEHICLE_REQUIRED","차량 연결 상태를 먼저 확인해 주세요.")
        val pending=credentials.pendingEnd() ?: mutable.value.pickup?.let { PendingEnd(it.id,reason) }
            ?: credentials.pendingStart()?.let {PendingEnd(null,reason,it)}
            ?: gateway.current()?.let {PendingEnd(it.id,reason)}
        if(pending==null)return@withLock
        credentials.savePendingEnd(pending)
        mutable.value=mutable.value.copy(pendingEnd=true,busy=true,error=null,message="공유를 종료하고 있어요.")
        // A finite end request may finish during a voice broadcast without starting a new FGS.
        try { finishEnd(pending) }
        catch(error: Throwable) {
            fail(error);mutable.value=mutable.value.copy(message="연결되면 공유 종료를 다시 요청합니다.")
            try {lifetime.start();startProcessing()}
            catch(blocked: Throwable) {
                fail(blocked)
                mutable.value=mutable.value.copy(message="종료 요청을 저장했어요. 정차 후 앱을 열어 종료 상태를 확인해 주세요.")
            }
        }
    }
    suspend fun currentStatus(): Pickup? = mutex.withLock {
        if(credentials.read()==null)throw ApiFailure(401,"VEHICLE_REQUIRED","차량 연결 상태를 먼저 확인해 주세요.")
        val value=gateway.current()
        if(value==null && credentials.pendingStart()!=null && credentials.pendingEnd()==null)
            throw ApiFailure(409,"START_UNCONFIRMED","공유 시작 여부를 아직 확인하고 있어요.")
        if(value!=null && credentials.pendingStart()!=null && credentials.pendingEnd()==null) {
            credentials.savePendingStart(null);unresolvedStartAt=null
        }
        applySnapshot(value);value
    }
    private fun requireShare(id: String): Pickup = mutable.value.pickup?.takeIf {
        it.id==id && it.expiresAt>wallNow() && !mutable.value.pendingEnd && credentials.pendingEnd()==null
    } ?: throw ApiFailure(410,"SHARE_ENDED","공유가 종료되었어요. 새 픽업에서 다시 시도해 주세요.")
    suspend fun shareMessage(id: String): ShareMessage = mutex.withLock {
        requireShare(id)
        val value=gateway.shareMessage(id)
        requireShare(id)
        if(value.pickupId!=id)throw ApiFailure(409,"PICKUP_CHANGED","픽업이 바뀌었어요. 다시 시도해 주세요.")
        value
    }
    private val renewalKeys=mutableMapOf<String,String>()
    suspend fun renewAccess(id: String): Pickup = mutex.withLock {
        val current=requireShare(id)
        if(!current.shareCodeLocked || current.shareRenewalsRemaining<1 || current.shareRenewAfter>wallNow())
            throw ApiFailure(409,"RENEW_UNAVAILABLE","인증 링크를 바꿀 수 있는 횟수와 시간을 확인해 주세요.")
        val key=renewalKeys.getOrPut(id){java.util.UUID.randomUUID().toString()}
        val value=gateway.renewAccess(id,key)
        requireShare(id)
        if(value.id!=id)throw ApiFailure(409,"PICKUP_CHANGED","픽업이 바뀌었어요.")
        renewalKeys.remove(id);applySnapshot(value);value
    }
    suspend fun resendMessage(id: String): Pickup = mutex.withLock {
        val current=requireShare(id)
        if(!current.smsConfirmed)throw ApiFailure(409,"CONFIRMATION_REQUIRED","먼저 문자 보내기를 눌러 주세요.")
        if(current.messageResendsRemaining<1||current.messageResendAfter>wallNow())throw ApiFailure(409,"RESEND_UNAVAILABLE","재전송 가능 횟수와 시간을 확인해 주세요.")
        val value=gateway.resendMessage(id)
        requireShare(id)
        if(value.id!=id)throw ApiFailure(409,"PICKUP_CHANGED","픽업이 바뀌었어요.")
        applySnapshot(value);value
    }
    suspend fun confirmMessage(id: String): Pickup = mutex.withLock {confirmMessageLocked(id)}
    private suspend fun confirmMessageLocked(id: String): Pickup {
        val current=requireShare(id)
        if(current.smsConfirmed)return current
        val confirmed=gateway.confirmMessage(id)
        if(confirmed.id!=id)throw ApiFailure(409,"PICKUP_CHANGED","픽업이 바뀌었어요. 다시 시도해 주세요.")
        applySnapshot(confirmed)
        if(confirmed.smsConfirmed && mutable.value.pickup?.id==id && !mutable.value.pendingEnd)
            mutable.value=mutable.value.copy(messageNoticePickupId=id)
        return confirmed
    }
    /** An explicit successful approval produces one UI notice; restoring a server snapshot never does. */
    fun consumeMessageNotice(id: String): Boolean {
        val current=mutable.value
        if(current.messageNoticePickupId!=id)return false
        mutable.value=current.copy(messageNoticePickupId=null)
        return current.pickup?.id==id && current.pickup.smsConfirmed && !current.pendingEnd
    }
    private suspend fun finishEnd(pending: PendingEnd) {
        try {
            if(pending.startKey!=null)gateway.cancelStart(pending.startKey)
            else gateway.end(requireNotNull(pending.pickupId),pending.reason)
        }
        catch(error: ApiFailure) {
            if(pending.startKey!=null || error.code !in setOf("PICKUP_NOT_FOUND","SHARE_ENDED"))throw error
        }
        credentials.savePendingEnd(null);credentials.savePendingStart(null);unresolvedStartAt=null
        pending.pickupId?.let {closedPickups.add(it)}
        mutable.value=mutable.value.copy(pickup=null,pendingEnd=false,pendingStart=false,busy=false,message="공유가 종료됐어요.",error=null,messageNoticePickupId=null)
        stopProcessing()
        if(mutable.value.contacts.isEmpty())scope.launch {
            runCatching {gateway.contacts()}.onSuccess {mutable.value=mutable.value.copy(contacts=it)}
        }
    }
    private fun applySnapshot(value: Pickup?) {
        val pending=credentials.pendingEnd()
        if(value==null) {
            if(pending?.startKey!=null)return // Absence is not an acknowledgement of a delayed start cancellation.
            if(unresolvedStartAt!=null)return
            credentials.savePendingEnd(null)
            val wasActive=mutable.value.pickup!=null || pending!=null
            mutable.value.pickup?.let { closedPickups.add(it.id) }
            mutable.value=mutable.value.copy(pickup=null,pendingEnd=false,busy=false,messageNoticePickupId=null,
                message=if(wasActive) "공유가 종료됐어요." else "연락 상대를 선택해 공유를 시작해 주세요.")
            if(wasActive)stopProcessing()
            return
        }
        if(value.id in closedPickups)return
        if(pending!=null) return // An SSE snapshot cannot undo the driver's persisted end request.
        if(credentials.pendingStart()!=null) {credentials.savePendingStart(null);unresolvedStartAt=null}
        val previous=mutable.value.pickup
        if(previous!=null && previous.id==value.id && previous.version>value.version)return
        if(previous?.id!=value.id)routeRevision=navigation.value.routeRevision
        sequence=maxOf(sequence,value.sequence)
        mutable.value=mutable.value.copy(pickup=value,paired=true,busy=false,pendingStart=false,error=null)
    }
    /** Called by the foreground work loop; public for deterministic lifecycle/failure tests. */
    suspend fun syncOnce() = mutex.withLock {
        val pending=credentials.pendingEnd()
        if(pending!=null) {
            try { finishEnd(pending) } catch(error: Throwable) { fail(error) }
            return@withLock
        }
        try {
            val current=gateway.current()
            if(current!=null && unresolvedStartAt!=null) {
                credentials.savePendingStart(null);unresolvedStartAt=null
            }
            applySnapshot(current)
            val pickup=mutable.value.pickup
            if(pickup==null) {
                val pendingSince=unresolvedStartAt
                if(pendingSince!=null && elapsedNow()-pendingSince>60_000) {
                    unresolvedStartAt=null;mutable.value=mutable.value.copy(message="공유 시작 여부를 다시 확인해 주세요.")
                    stopProcessing() // The idempotency key remains for a safe manual retry.
                } else if(pendingSince==null)stopProcessing()
                return@withLock
            }
            val source=navigation.value
            val sample=source.upload(elapsedNow())
            val changed=source.routeRevision!=routeRevision || (sample!=null && sample.destination!=pickup.destination)
            val missing=source.routeKnown && source.destination==null && pickup.state!="ARRIVED"
            if(changed || missing) {
                val reason=if(source.routeCancelled)"ROUTE_CANCELLED" else if(changed)"DESTINATION_CHANGED" else "NAVIGATION_UNAVAILABLE"
                val end=PendingEnd(pickup.id,reason);credentials.savePendingEnd(end)
                mutable.value=mutable.value.copy(pendingEnd=true,message="내비 경로가 바뀌어 공유를 종료하고 있어요.")
                finishEnd(end);return@withLock
            }
            if(sample==null || !sample.observation.fresh) {
                mutable.value=mutable.value.copy(message="내비 정보 갱신을 기다리고 있어요.")
                return@withLock
            }
            sequence=maxOf(sequence,pickup.sequence)+1
            val result=gateway.upload(pickup.id,sequence,sample)
            if(result.accepted) {
                applySnapshot(result.pickup)
                mutable.value=mutable.value.copy(message="차량 위치와 도착 시간을 공유하고 있어요.")
            } else if(result.reason=="DESTINATION_CHANGED")applySnapshot(null)
            else if(result.reason=="OUT_OF_ORDER")applySnapshot(gateway.current())
        } catch(error: Throwable) { fail(error) }
    }
    private fun startProcessing() {
        if(syncJob?.isActive!=true)syncJob=scope.launch {
            while(isActive) { syncOnce();delay(5_000) }
        }
        if(streamJob?.isActive!=true) {
            val generation=workGeneration
            streamJob=scope.launch {
            while(isActive) {
                try {
                    gateway.events(onSnapshot={ snapshot ->
                        scope.launch { mutex.withLock { if(generation==workGeneration)applySnapshot(snapshot) } }.join()
                    },onConnected={ scope.launch { if(generation==workGeneration)mutable.value=mutable.value.copy(streamConnected=true) }.join() })
                } catch(error: Throwable) { if(error is CancellationException)throw error }
                mutable.value=mutable.value.copy(streamConnected=false)
                delay(3_000)
            }
            }
        }
    }
    private fun stopProcessing() {
        workGeneration++
        syncJob?.cancel();syncJob=null
        streamJob?.cancel();streamJob=null;gateway.closeEvents()
        mutable.value=mutable.value.copy(streamConnected=false)
        lifetime.stop()
    }
    fun onServiceStarted() { if(!mutable.value.busy)startProcessing() }
    fun onServiceStopped() {
        workGeneration++
        syncJob?.cancel();syncJob=null
        streamJob?.cancel();streamJob=null;gateway.closeEvents()
        mutable.value=mutable.value.copy(streamConnected=false)
    }
    fun showError(error: Throwable) { fail(error) }
}
