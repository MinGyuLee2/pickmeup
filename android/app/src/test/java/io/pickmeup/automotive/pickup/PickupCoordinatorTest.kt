package io.pickmeup.automotive.pickup

import io.pickmeup.automotive.navigation.GeoPoint
import io.pickmeup.automotive.navigation.NavigationConnection
import io.pickmeup.automotive.navigation.NavigationState
import io.pickmeup.automotive.navigation.PickupDestination
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.coroutines.launch
import org.junit.Assert.*
import org.junit.Test

class PickupCoordinatorTest {
    private class MemoryCredentials : CredentialStore {
        var installKey: String?=null
        override fun guestInstallationKey()=installKey
        override fun saveGuestInstallationKey(value: String){installKey=value}
        var setup: Pairing?=null
        override fun pendingPairing()=setup
        override fun savePendingPairing(value: Pairing?){setup=value}
        var history=emptyList<RecentPickup>()
        override fun recentPickups()=history
        override fun saveRecentPickups(value: List<RecentPickup>){history=value}
        var saved: DeviceCredentials?=DeviceCredentials("vehicle","token")
        var ending: PendingEnd?=null
        var starting: String?=null
        override fun read()=saved
        override fun save(credentials: DeviceCredentials) { saved=credentials }
        override fun pendingEnd()=ending
        override fun savePendingEnd(value: PendingEnd?) { ending=value }
        override fun pendingStart()=starting
        override fun savePendingStart(key: String?) { starting=key }
    }
    private class Lifetime : SyncLifetime {
        var starts=0;var stops=0
        var denied=false
        override fun start(){starts++;if(denied)throw ApiFailure(409,"BACKGROUND_START_RESTRICTED","blocked")}
        override fun stop(){stops++}
    }
    private class Gateway : PickupGateway {
        val guestKeys=mutableListOf<String>()
        var guestResponseLost=false
        var linkedProfile: Boolean?=null
        var cancelledSetups=0
        var contactsOffline=false
        override suspend fun startGuest(installationKey: String): DeviceCredentials {
            guestKeys.add(installationKey)
            if(guestResponseLost)throw java.io.IOException("lost guest response")
            return DeviceCredentials("guest-vehicle","guest-token",false)
        }
        override suspend fun accountLinked()=linkedProfile
        override suspend fun cancelOnboarding(pairing: Pairing){cancelledSetups++}
        var server: Pickup?=null
        var uploads=0
        var ends=0
        var endOffline=false
        var startResponseLost=false
        var currentOffline=false
        var lastSequence=0L
        var cancelledKey: String?=null
        var sink: (suspend (Pickup?) -> Unit)?=null
        var onboardingPhone: String?=null
        var pairingResult: DeviceCredentials?=null
        var setup=Pairing("setup","secret","https://example.test/setup",System.currentTimeMillis()+600000,"설정 링크 안내",1,0,System.currentTimeMillis()+300000)
        var setupResends=0
        var pickupResends=0
        var wrongResendId=false
        override suspend fun onboardingMessage(pairing: Pairing)=setup
        override suspend fun resendOnboarding(pairing: Pairing): Pairing {setupResends++;setup=setup.copy(resendsRemaining=0);return setup}
        override suspend fun resendMessage(id: String): Pickup {pickupResends++;return server!!.copy(id=if(wrongResendId)"other" else id,messageResendsRemaining=0,version=server!!.version+1).also {if(!wrongResendId)server=it}}
        val renewalKeys=mutableListOf<String>()
        var renewalOffline=false
        var wrongRenewalId=false
        override suspend fun renewAccess(id: String,key: String): Pickup {
            renewalKeys.add(key)
            if(renewalOffline)throw java.io.IOException("lost renewal response")
            return server!!.copy(id=if(wrongRenewalId)"other" else id,shareCodeLocked=false,shareRenewalsRemaining=1,version=server!!.version+1).also {if(!wrongRenewalId)server=it}
        }
        var imports=0
        var contactReads=0
        var startCalls=0
        var lastContactId: String?=null
        var confirmationCalls=0
        var confirmationOffline=false
        val confirmedIds=mutableListOf<String>()
        var newPickupSmsConfirmed=true
        var messageReads=0
        var beforeMessageReturn: (() -> Unit)?=null
        override suspend fun shareMessage(id: String): ShareMessage {
            messageReads++;beforeMessageReturn?.invoke();return ShareMessage(id,"지연이","010-****-9999","가상 링크와 인증코드")
        }
        override suspend fun confirmMessage(id: String): Pickup {
            confirmationCalls++;confirmedIds.add(id)
            if(confirmationOffline)throw java.io.IOException("confirmation offline")
            return server!!.copy(smsConfirmed=true,version=server!!.version+1).also {server=it}
        }
        override suspend fun importContact(name: String, phone: String): Contact {
            imports++;return Contact("selected",name,listOf(name))
        }
        override suspend fun startOnboarding(phone: String): Pairing { onboardingPhone=phone;return setup }
        override suspend fun pairingStatus(pairing: Pairing): DeviceCredentials?=pairingResult
        var people=listOf(Contact("contact","지연이",listOf("지연이","지연")))
        override suspend fun contacts(): List<Contact> {contactReads++;if(contactsOffline)throw java.io.IOException("contacts offline");return people}
        override suspend fun saveMeetingPlace(contactId: String, place: Destination?) {people=people.map {if(it.id==contactId)it.copy(meetingPlace=place) else it}}
        override suspend fun current(): Pickup? {
            if(currentOffline)throw java.io.IOException("status read offline")
            return server
        }
        override suspend fun start(alias: String,key: String,navigation: NavigationUpload,contactId: String?): Pickup {
            check(alias=="지연이");check(key.isNotEmpty());startCalls++;lastContactId=contactId
            val value=Pickup("pickup","ACTIVE","UNKNOWN",alias,navigation.destination,600,"FRESH",1,1,9_999_999,smsConfirmed=newPickupSmsConfirmed)
            server=value
            if(startResponseLost)throw java.io.IOException("response lost after commit")
            return value
        }
        override suspend fun upload(id: String,sequence: Long,navigation: NavigationUpload): UploadResult {
            check(sequence>lastSequence);lastSequence=sequence;uploads++
            val updated=server!!.copy(sequence=sequence,version=server!!.version+1);server=updated
            return UploadResult(true,updated,null)
        }
        override suspend fun end(id: String,reason: String) {
            ends++
            if(endOffline)throw java.io.IOException("offline")
            server=null
        }
        override suspend fun cancelStart(key: String) {
            if(endOffline)throw java.io.IOException("offline")
            cancelledKey=key;server=null
        }
        override suspend fun events(onSnapshot: suspend (Pickup?) -> Unit,onConnected: suspend () -> Unit) {
            sink=onSnapshot;onConnected();awaitCancellation()
        }
        override fun closeEvents(){}
    }
    private fun navigation()=NavigationState(connection=NavigationConnection.CONNECTED,
        location=GeoPoint(37.4,127.0),locationElapsedAt=9_000,
        destination=PickupDestination(GeoPoint(37.5,127.1),"회사 정문",600,2000),
        destinationElapsedAt=9_000,routeKnown=true)

    @Test fun plannedDestinationIsIndependentOfDefaultAndHistorySurvivesRecreation()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val source=MutableStateFlow(navigation());val saved=MemoryCredentials();val gateway=Gateway()
            val default=Destination(GeoPoint(37.5,127.1),"기본 장소")
            gateway.people=gateway.people.map {it.copy(meetingPlace=default)}
            val chosen=Destination(GeoPoint(37.6,127.2),"새 만날 곳")
            var routed: Destination?=null
            val coordinator=PickupCoordinator(scope,source,gateway,saved,Lifetime(),{10000},routeTo={place->
                routed=place;source.value=source.value.copy(destination=PickupDestination(place.point,place.name,600,2000))
            })
            coordinator.resume()
            coordinator.startPlannedShare("contact",chosen)
            assertEquals(chosen,routed);assertEquals(chosen,gateway.server!!.destination)
            assertEquals(default,gateway.people.single().meetingPlace)
            assertEquals("contact",gateway.lastContactId)
            assertEquals(listOf(RecentPickup("contact","지연이",chosen)),saved.history)
            coordinator.endShare()
            val restored=PickupCoordinator(scope,source,gateway,saved,Lifetime(),{10000})
            assertEquals(saved.history,restored.state.value.recentPickups)
            assertEquals(DeviceCredentials("vehicle","token"),saved.read())
        } finally {scope.cancel()}
    }
    @Test fun failedPlannedRouteDoesNotCreateHistoryOrSendToCurrentDestination()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials();val gateway=Gateway()
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000},routeTo={throw ApiFailure(409,"ROUTE_FAILED","failed")})
            coordinator.resume()
            assertTrue(runCatching {coordinator.startPlannedShare("contact",Destination(GeoPoint(37.6,127.2),"선택한 곳"))}.isFailure)
            assertEquals(0,gateway.startCalls);assertTrue(saved.history.isEmpty());assertNull(saved.starting)
        } finally {scope.cancel()}
    }
    @Test fun existingServerPickupBlocksPlannedNavigation()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway();var routes=0
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},routeTo={routes++})
            coordinator.resume();gateway.server=Pickup("existing","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,999999)
            assertTrue(runCatching {coordinator.startPlannedShare("contact",gateway.server!!.destination)}.isFailure)
            assertEquals(0,routes);assertEquals(0,gateway.startCalls)
        } finally {scope.cancel()}
    }
    @Test fun removedRecipientsArePrunedWithoutChangingCredentialsOrOtherHistory()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {history=listOf(RecentPickup("removed","예전 상대",navigation().upload(10000)!!.destination),RecentPickup("contact","지연이",navigation().upload(10000)!!.destination))}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),Gateway(),saved,Lifetime(),{10000})
            coordinator.resume()
            assertEquals(listOf("contact"),saved.history.map {it.contactId})
            assertEquals(saved.history,coordinator.state.value.recentPickups)
            assertEquals(DeviceCredentials("vehicle","token"),saved.read())
        } finally {scope.cancel()}
    }
    @Test fun importsSelectedRecipientWithoutChangingPairingOrStartingShare()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials();val gateway=Gateway();val lifetime=Lifetime()
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,lifetime,{10000})
            coordinator.resume()
            repeat(2){assertEquals("selected",coordinator.importContact("새 상대","01012345678").id)}
            assertEquals(DeviceCredentials("vehicle","token"),saved.read())
            assertEquals(1,coordinator.state.value.contacts.count {it.id=="selected"})
            assertTrue(coordinator.state.value.contacts.any {it.id=="contact"})
            assertNull(gateway.server);assertNull(saved.pendingStart());assertEquals(0,lifetime.starts)
        } finally {scope.cancel()}
    }
    @Test fun pendingSharePreventsImportingAnotherRecipient()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {starting="unresolved"};val gateway=Gateway()
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000})
            try {coordinator.importContact("새 상대","01012345678");fail("Pending share allowed import")}
            catch(error: ApiFailure){assertEquals("PICKUP_IN_PROGRESS",error.code)}
            assertEquals(0,gateway.imports)
        } finally {scope.cancel()}
    }
    @Test fun smsSetupSavesDeviceCredentialsAndLoadsContactsWithoutQrOrRefresh()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply { this.saved=null }
            val gateway=Gateway().apply { pairingResult=DeviceCredentials("new-vehicle","new-token") }
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000})
            coordinator.createPairing("01012345678");yield()
            assertEquals("01012345678",gateway.onboardingPhone)
            assertEquals("new-vehicle",saved.read()?.vehicleId)
            assertTrue(coordinator.state.value.paired)
            assertNull(coordinator.state.value.pairing)
            assertEquals("지연이",coordinator.state.value.contacts.single().name)
            val restored=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000})
            restored.resume()
            assertTrue(restored.state.value.paired)
            assertEquals(1,restored.state.value.contacts.size)
        } finally {scope.cancel()}
    }
    @Test fun backgroundServiceDenialCannotCreateAShareOrPersistAnUnconfirmedStart()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway();val saved=MemoryCredentials();val lifetime=Lifetime().apply { denied=true }
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,lifetime,{10_000})
            val error=runCatching { coordinator.startShare("지연이") }.exceptionOrNull() as ApiFailure
            assertEquals("BACKGROUND_START_RESTRICTED",error.code)
            assertNull(gateway.server);assertNull(saved.starting)
            assertFalse(coordinator.state.value.pendingStart);assertFalse(coordinator.state.value.busy)
            assertEquals(1,lifetime.stops)
        } finally {scope.cancel()}
    }
    @Test fun coldEndLooksUpTheServerShareAndCanFinishWithoutANewForegroundService()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials();val lifetime=Lifetime().apply {denied=true}
            val gateway=Gateway().apply {server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10_000)!!.destination,600,"FRESH",20,20,9_999_999)}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,lifetime,{10_000})
            assertNull(coordinator.state.value.pickup)
            coordinator.endShare()
            assertNull(gateway.server);assertNull(saved.ending);assertEquals(1,gateway.ends);assertEquals(0,lifetime.starts)
        } finally {scope.cancel()}
    }
    @Test fun unknownColdEndAndDeniedOfflineRetryCannotBeReportedAsCompleted()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials();val lifetime=Lifetime().apply {denied=true}
            val gateway=Gateway().apply {currentOffline=true}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,lifetime,{10_000})
            assertTrue(runCatching {coordinator.endShare()}.isFailure)
            gateway.currentOffline=false;gateway.endOffline=true
            gateway.server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10_000)!!.destination,600,"FRESH",20,20,9_999_999)
            coordinator.endShare()
            assertNotNull(saved.ending);assertTrue(coordinator.state.value.pendingEnd);assertNotNull(gateway.server)
        } finally {scope.cancel()}
    }

    @Test fun monotonicAgesAndIndependentEtaGateSharing() = runBlocking {
        val sample=navigation()
        assertTrue(sample.upload(10_000)!!.observation.fresh)
        assertNull(sample.upload(8_999))
        assertFalse(sample.copy(destinationElapsedAt=0).upload(40_000)!!.observation.fresh)
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val lifetime=Lifetime()
            val coordinator=PickupCoordinator(scope,MutableStateFlow(sample.copy(destinationElapsedAt=0)),Gateway(),MemoryCredentials(),lifetime,{40_000})
            val error=runCatching { coordinator.startShare("지연이") }.exceptionOrNull()
            assertEquals("NAVIGATION_STALE",(error as ApiFailure).code);assertEquals(0,lifetime.starts)
        } finally {scope.cancel()}
    }
    @Test fun routeChangeOfflinePersistsEndAndStopsFurtherUploadsUntilAcknowledged() = runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val source=MutableStateFlow(navigation());val gateway=Gateway();val saved=MemoryCredentials();val lifetime=Lifetime()
            val coordinator=PickupCoordinator(scope,source,gateway,saved,lifetime,{10_000})
            coordinator.startShare("지연이");yield();val uploads=gateway.uploads
            gateway.endOffline=true
            source.value=source.value.copy(routeRevision=1,destination=null,routeCancelled=true)
            yield();assertEquals("ROUTE_CANCELLED",saved.ending!!.reason)
            coordinator.syncOnce();assertEquals(uploads,gateway.uploads);assertTrue(coordinator.state.value.pendingEnd)
            gateway.endOffline=false;coordinator.syncOnce()
            assertNull(saved.ending);assertNull(coordinator.state.value.pickup);assertTrue(lifetime.stops>0)
        } finally {scope.cancel()}
    }
    @Test fun recoveryUsesServerSequenceAndIgnoresOldOrClosedStreamSnapshots() = runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway();val sample=navigation().upload(10_000)!!
            gateway.server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",sample.destination,600,"FRESH",50,20,9_999_999)
            gateway.lastSequence=50
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10_000})
            coordinator.resume();yield();assertTrue(gateway.lastSequence>=51)
            val old=gateway.server!!
            val outside=old.copy(readiness="OUTSIDE",version=old.version+1)
            gateway.server=outside;val sink=gateway.sink!!;sink(outside)
            assertEquals("OUTSIDE",coordinator.state.value.pickup!!.readiness)
            sink(old);assertEquals("OUTSIDE",coordinator.state.value.pickup!!.readiness)
            coordinator.endShare();sink(outside)
            assertNull(coordinator.state.value.pickup)
        } finally {scope.cancel()}
    }
    @Test fun committedStartWithLostResponseIsRecoveredAndNotCreatedAgain() = runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {startResponseLost=true};val saved=MemoryCredentials()
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10_000})
            assertTrue(runCatching {coordinator.startShare("지연이")}.isFailure)
            coordinator.syncOnce()
            assertEquals("pickup",coordinator.state.value.pickup!!.id)
            assertNull(saved.starting)
        } finally {scope.cancel()}
    }
    @Test fun persistedEndSurvivesCoordinatorRecreation() = runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {ending=PendingEnd("pickup","DRIVER_ENDED")}
            val gateway=Gateway().apply {server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10_000)!!.destination,600,"FRESH",20,20,9_999_999)}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10_000})
            coordinator.resume();yield();coordinator.syncOnce()
            assertNull(gateway.server);assertNull(saved.ending);assertEquals(0,gateway.uploads)
        } finally {scope.cancel()}
    }
    @Test fun persistedEndRetriesEvenWhenFirstStatusReadIsOffline() = runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {ending=PendingEnd("pickup","DRIVER_ENDED")}
            val lifetime=Lifetime();val gateway=Gateway().apply {currentOffline=true;endOffline=true}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,lifetime,{10_000})
            coordinator.resume();yield()
            assertTrue(lifetime.starts>0);assertTrue(gateway.ends>0);assertNotNull(saved.ending)
            gateway.endOffline=false;coordinator.syncOnce();assertNull(saved.ending)
        } finally {scope.cancel()}
    }
    @Test fun uncertainStartCanBeCancelledWithoutKnowingItsPickupId() = runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {startResponseLost=true;currentOffline=true;endOffline=true}
            val saved=MemoryCredentials()
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10_000})
            runCatching {coordinator.startShare("지연이")};val key=saved.starting!!
            coordinator.endShare();assertEquals(key,saved.ending!!.startKey);assertEquals(0,gateway.uploads)
            gateway.endOffline=false;coordinator.syncOnce()
            assertEquals(key,gateway.cancelledKey);assertNull(saved.ending);assertNull(saved.starting);assertNull(coordinator.state.value.pickup)
        } finally {scope.cancel()}
    }
    @Test fun cancellationOfUnknownStartSurvivesRestartEvenIfCurrentPickupIsAbsent() = runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {starting="start-key";ending=PendingEnd(null,"DRIVER_ENDED","start-key")}
            val gateway=Gateway();val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10_000})
            coordinator.resume();yield();coordinator.syncOnce()
            assertEquals("start-key",gateway.cancelledKey);assertNull(saved.ending)
        } finally {scope.cancel()}
    }

    @Test fun savingPlaceDoesNotStartNavigationOrShareAndSurvivesReload()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val nav=MutableStateFlow(navigation());val gateway=Gateway();val saved=MemoryCredentials();val lifetime=Lifetime()
            val coordinator=PickupCoordinator(scope,nav,gateway,saved,lifetime,{10000})
            coordinator.resume();val place=nav.value.upload(10000)!!.destination
            coordinator.saveMeetingPlace("contact",place);coordinator.resume()
            assertEquals(place,coordinator.state.value.contacts.single().meetingPlace)
            assertNull(gateway.server);assertEquals(0,lifetime.starts);assertEquals("token",saved.read()!!.token)
            coordinator.saveMeetingPlace("contact",null);assertNull(coordinator.state.value.contacts.single().meetingPlace)
        } finally {scope.cancel()}
    }
    @Test fun savedPickupWaitsForRouteBeforeStartingAndRejectsDuplicate()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val nav=MutableStateFlow(navigation());val gateway=Gateway();val saved=MemoryCredentials();val lifetime=Lifetime()
            val place=nav.value.upload(10000)!!.destination;gateway.people=gateway.people.map {it.copy(meetingPlace=place)}
            var routes=0
            val coordinator=PickupCoordinator(scope,nav,gateway,saved,lifetime,{10000},routeTo={
                assertNull(gateway.server);assertNull(saved.pendingStart());assertEquals(1,lifetime.starts);routes++
                nav.value=navigation().copy(routeRevision=1)
            })
            coordinator.resume();coordinator.startSavedShare("contact")
            assertEquals(1,routes);assertNotNull(gateway.server);assertFalse(coordinator.state.value.preparingRoute)
            try {coordinator.startSavedShare("contact");fail("duplicate route allowed")}catch(error: ApiFailure){assertEquals("PICKUP_IN_PROGRESS",error.code)}
            assertEquals(1,routes)
        } finally {scope.cancel()}
    }
    @Test fun routeFailureOrWrongDestinationNeverCreatesSmsOrPendingStart()=runBlocking {
        for(mode in listOf("failure","mismatch","stale")) {
            val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
            try {
                val nav=MutableStateFlow(navigation());val gateway=Gateway();val saved=MemoryCredentials();val lifetime=Lifetime()
                val place=nav.value.upload(10000)!!.destination;gateway.people=gateway.people.map {it.copy(meetingPlace=place)}
                val coordinator=PickupCoordinator(scope,nav,gateway,saved,lifetime,{10000},routeTo={
                    when(mode) {
                        "failure"->throw ApiFailure(409,"ROUTE_FAILED","cancelled")
                        "mismatch"->nav.value=navigation().copy(destination=navigation().destination!!.copy(name="다른 장소"))
                        "stale"->nav.value=navigation().copy(destinationElapsedAt=-50000)
                    }
                })
                coordinator.resume()
                try {coordinator.startSavedShare("contact");fail("invalid route allowed")}catch(_: ApiFailure){}
                assertNull(gateway.server);assertNull(saved.pendingStart());assertEquals(1,lifetime.starts);assertTrue(lifetime.stops>0)
                assertFalse(coordinator.state.value.busy);assertFalse(coordinator.state.value.preparingRoute)
            } finally {scope.cancel()}
        }
    }

    @Test fun cancellingRoutePreparationStopsBeforeCreatingShare()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val nav=MutableStateFlow(navigation());val gateway=Gateway();val saved=MemoryCredentials();val lifetime=Lifetime()
            gateway.people=gateway.people.map {it.copy(meetingPlace=nav.value.upload(10000)!!.destination)}
            val coordinator=PickupCoordinator(scope,nav,gateway,saved,lifetime,{10000},routeTo={awaitCancellation()})
            coordinator.resume()
            val work=scope.launch {
                try {coordinator.startSavedShare("contact");fail("cancelled preparation started sharing")}
                catch(error: ApiFailure){assertEquals("ROUTE_CANCELLED",error.code)}
            }
            yield();assertTrue(coordinator.state.value.preparingRoute)
            coordinator.endShare();work.join()
            assertFalse(coordinator.state.value.busy);assertFalse(coordinator.state.value.preparingRoute)
            assertNull(gateway.server);assertNull(saved.pendingStart());assertEquals(0,gateway.ends);assertTrue(lifetime.stops>0)
        } finally {scope.cancel()}
    }

    @Test fun coldVoiceResolvesAliasAndCreatesSavedRouteWithoutAnExistingDestination()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val nav=MutableStateFlow(NavigationState());val gateway=Gateway();val saved=MemoryCredentials();val lifetime=Lifetime()
            val place=navigation().upload(10000)!!.destination;gateway.people=gateway.people.map {it.copy(meetingPlace=place)}
            var routes=0;var prepares=0
            val coordinator=PickupCoordinator(scope,nav,gateway,saved,lifetime,{10000},routeTo={target ->
                assertEquals(place,target);assertNull(gateway.server);routes++;nav.value=navigation()
            })
            coordinator.startVoiceShare(" 지연 ") {hasSavedPlace ->
                assertTrue(hasSavedPlace);assertNull(nav.value.destination);prepares++
            }
            assertEquals(1,prepares);assertEquals(1,routes);assertEquals(1,gateway.contactReads)
            assertEquals("contact",gateway.lastContactId);assertEquals(1,gateway.startCalls)
            assertEquals(DeviceCredentials("vehicle","token"),saved.read())
            val duplicate=runCatching {coordinator.startVoiceShare("지연이"){fail("duplicate prepared route")}}.exceptionOrNull() as ApiFailure
            assertEquals("PICKUP_IN_PROGRESS",duplicate.code);assertEquals(1,gateway.startCalls);assertEquals(1,routes)
        } finally {scope.cancel()}
    }
    @Test fun voiceUsesCurrentNavigationOnlyWhenRecipientHasNoSavedPlace()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway();var routes=0;val nav=MutableStateFlow(navigation())
            val coordinator=PickupCoordinator(scope,nav,gateway,MemoryCredentials(),Lifetime(),{10000},routeTo={routes++})
            coordinator.startVoiceShare("지연이"){assertFalse(it)}
            assertEquals(0,routes);assertEquals("contact",gateway.lastContactId)
            assertEquals(nav.value.upload(10000)!!.destination,gateway.server!!.destination)
        } finally {scope.cancel()}
    }
    @Test fun ambiguousMissingAndUnpairedVoiceNeverPrepareNavigationOrCreateShare()=runBlocking {
        for(mode in listOf("ambiguous","missing","unpaired")) {
            val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
            try {
                val gateway=Gateway();val saved=MemoryCredentials();val lifetime=Lifetime()
                if(mode=="ambiguous")gateway.people=gateway.people+gateway.people.single().copy(id="other")
                if(mode=="missing")gateway.people=emptyList()
                if(mode=="unpaired")saved.saved=null
                val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,lifetime,{10000})
                val error=runCatching {coordinator.startVoiceShare("지연이"){fail("unresolved recipient prepared navigation")}}.exceptionOrNull() as ApiFailure
                assertEquals(when(mode){"ambiguous"->"AMBIGUOUS_RECIPIENT";"missing"->"CONTACT_NOT_FOUND";else->"VEHICLE_REQUIRED"},error.code)
                assertEquals(0,gateway.startCalls);assertEquals(0,lifetime.starts);assertNull(saved.pendingStart())
            } finally {scope.cancel()}
        }
    }
    @Test fun voiceRouteFailureDoesNotFallBackToAnUnrelatedCurrentDestination()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway();val saved=MemoryCredentials();val lifetime=Lifetime()
            gateway.people=gateway.people.map {it.copy(meetingPlace=Destination(GeoPoint(37.7,127.3),"저장한 장소"))}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,lifetime,{10000},routeTo={throw ApiFailure(409,"ROUTE_FAILED","failed")})
            val error=runCatching {coordinator.startVoiceShare("지연이"){assertTrue(it)}}.exceptionOrNull() as ApiFailure
            assertEquals("ROUTE_FAILED",error.code);assertEquals(0,gateway.startCalls);assertNull(saved.pendingStart())
        } finally {scope.cancel()}
    }

    @Test fun messageCopyDoesNotAuthorizeSmsAndConfirmationIsIdempotent()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway();val saved=MemoryCredentials()
            gateway.server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999,smsConfirmed=false)
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000},wallNow={10000})
            coordinator.resume();assertFalse(coordinator.state.value.pickup!!.smsConfirmed)
            assertEquals("pickup",coordinator.shareMessage("pickup").pickupId);assertEquals(0,gateway.confirmationCalls)
            coordinator.confirmMessage("pickup");coordinator.confirmMessage("pickup")
            assertTrue(coordinator.state.value.pickup!!.smsConfirmed);assertEquals(1,gateway.confirmationCalls)
        } finally {scope.cancel()}
    }
    @Test fun lateMessageResponseCannotBeCopiedAfterAnEndWasRequested()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway();val saved=MemoryCredentials()
            gateway.server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999,smsConfirmed=false)
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000},wallNow={10000})
            coordinator.resume();gateway.beforeMessageReturn={saved.savePendingEnd(PendingEnd("pickup","DRIVER_ENDED"))}
            val error=runCatching {coordinator.shareMessage("pickup")}.exceptionOrNull() as ApiFailure
            assertEquals("SHARE_ENDED",error.code)
            assertTrue(runCatching {coordinator.confirmMessage("pickup")}.isFailure);assertEquals(0,gateway.confirmationCalls)
        } finally {scope.cancel()}
    }
    @Test fun voiceStartDefaultsToLeavingSmsUnconfirmed()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {newPickupSmsConfirmed=false}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000})
            coordinator.startVoiceShare("지연이") {assertFalse(it)}
            assertFalse(coordinator.state.value.pickup!!.smsConfirmed);assertEquals(0,gateway.confirmationCalls)
        } finally {scope.cancel()}
    }
    @Test fun plannedStartUsesOnlyItsExplicitMessageChoiceAfterRoutePreparation()=runBlocking {
        for(send in listOf(false,true)) {
            val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
            try {
                val gateway=Gateway().apply {newPickupSmsConfirmed=false}
                val source=MutableStateFlow(navigation());val place=Destination(GeoPoint(37.6,127.2),"선택한 장소")
                val coordinator=PickupCoordinator(scope,source,gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000},routeTo={
                    assertEquals(0,gateway.startCalls);assertEquals(0,gateway.confirmationCalls)
                    source.value=source.value.copy(destination=PickupDestination(it.point,it.name,600,2000))
                })
                coordinator.resume();val started=coordinator.startPlannedShare("contact",place,send)
                assertEquals(place,started.destination);assertEquals(send,started.smsConfirmed)
                assertEquals(1,gateway.startCalls);assertEquals(if(send)1 else 0,gateway.confirmationCalls)
                assertEquals(if(send)listOf(started.id) else emptyList<String>(),gateway.confirmedIds)
            } finally {scope.cancel()}
        }
    }
    @Test fun approvedStartWithRouteFailureNeverCreatesOrConfirmsAPickup()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {newPickupSmsConfirmed=false}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000},routeTo={throw ApiFailure(409,"ROUTE_FAILED","failed")})
            coordinator.resume()
            assertTrue(runCatching {coordinator.startPlannedShare("contact",Destination(GeoPoint(37.6,127.2),"선택한 곳"),true)}.isFailure)
            assertEquals(0,gateway.startCalls);assertEquals(0,gateway.confirmationCalls)
        } finally {scope.cancel()}
    }
    @Test fun cancellingApprovedRoutePreparationNeverConfirmsAMessage()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {newPickupSmsConfirmed=false};val entered=kotlinx.coroutines.CompletableDeferred<Unit>()
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000},routeTo={entered.complete(Unit);awaitCancellation()})
            coordinator.resume()
            var failure: Throwable?=null
            val start=scope.launch {failure=runCatching {coordinator.startPlannedShare("contact",Destination(GeoPoint(37.6,127.2),"선택한 곳"),true)}.exceptionOrNull()}
            entered.await();coordinator.endShare();start.join()
            assertEquals("ROUTE_CANCELLED",(failure as ApiFailure).code)
            assertEquals(0,gateway.startCalls);assertEquals(0,gateway.confirmationCalls)
        } finally {scope.cancel()}
    }
    @Test fun approvedNewStartCannotApproveAnExistingServerPickup()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {server=Pickup("other","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999,smsConfirmed=false)}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000})
            assertTrue(runCatching {coordinator.startPlannedShare("contact",navigation().upload(10000)!!.destination,true)}.isFailure)
            assertEquals(0,gateway.startCalls);assertEquals(0,gateway.confirmationCalls);assertFalse(gateway.server!!.smsConfirmed)
        } finally {scope.cancel()}
    }
    @Test fun lostStartResponseDoesNotSilentlyApproveARecoveredPickup()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {newPickupSmsConfirmed=false;startResponseLost=true}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000},routeTo={})
            coordinator.resume()
            assertTrue(runCatching {coordinator.startPlannedShare("contact",navigation().upload(10000)!!.destination,true)}.isFailure)
            coordinator.currentStatus();assertFalse(coordinator.state.value.pickup!!.smsConfirmed)
            assertEquals(1,gateway.startCalls);assertEquals(0,gateway.confirmationCalls)
            coordinator.confirmMessage("pickup");assertTrue(coordinator.state.value.pickup!!.smsConfirmed)
        } finally {scope.cancel()}
    }
    @Test fun failedInitialConfirmationCanRetryWithoutStartingAnotherPickup()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {newPickupSmsConfirmed=false;confirmationOffline=true}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000},routeTo={})
            coordinator.resume()
            assertTrue(runCatching {coordinator.startPlannedShare("contact",navigation().upload(10000)!!.destination,true)}.isFailure)
            assertFalse(coordinator.state.value.pickup!!.smsConfirmed);assertEquals(1,gateway.startCalls)
            assertNull(coordinator.state.value.messageNoticePickupId)
            gateway.confirmationOffline=false;coordinator.confirmMessage("pickup")
            assertEquals(1,gateway.startCalls);assertEquals(listOf("pickup","pickup"),gateway.confirmedIds)
            assertTrue(coordinator.state.value.pickup!!.smsConfirmed)
        } finally {scope.cancel()}
    }
    @Test fun confirmationNoticeIsOneShotAndDoesNotReplayFromExistingServerState()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999,smsConfirmed=false)}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000})
            coordinator.resume();assertNull(coordinator.state.value.messageNoticePickupId)
            coordinator.confirmMessage("pickup");assertEquals("pickup",coordinator.state.value.messageNoticePickupId)
            assertFalse(coordinator.consumeMessageNotice("other"));assertTrue(coordinator.consumeMessageNotice("pickup"))
            assertFalse(coordinator.consumeMessageNotice("pickup"))
            coordinator.confirmMessage("pickup");coordinator.resume()
            assertNull(coordinator.state.value.messageNoticePickupId);assertEquals(1,gateway.confirmationCalls)
            val restored=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000})
            restored.resume();assertNull(restored.state.value.messageNoticePickupId)
        } finally {scope.cancel()}
    }
    @Test fun endingShareDiscardsAnUnseenConfirmationNotice()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999,smsConfirmed=false)}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000})
            coordinator.resume();coordinator.confirmMessage("pickup");coordinator.endShare()
            assertNull(coordinator.state.value.messageNoticePickupId);assertFalse(coordinator.consumeMessageNotice("pickup"))
        } finally {scope.cancel()}
    }
    @Test fun coldVoiceChecksExistingServerShareBeforeChangingNavigation()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway();gateway.server=Pickup("existing","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999)
            val coordinator=PickupCoordinator(scope,MutableStateFlow(NavigationState()),gateway,MemoryCredentials(),Lifetime(),{10000})
            val error=runCatching {coordinator.startVoiceShare("지연이"){fail("existing server share changed navigation")}}.exceptionOrNull() as ApiFailure
            assertEquals("PICKUP_IN_PROGRESS",error.code);assertEquals("existing",coordinator.state.value.pickup!!.id)
            assertEquals(0,gateway.contactReads);assertEquals(0,gateway.startCalls)
        } finally {scope.cancel()}
    }
    @Test fun voiceImmediateChoiceAppliesOnlyAfterNewShareForSavedAndCurrentDestinations()=runBlocking {
        for(hasPlace in listOf(false,true))for(send in listOf(false,true)) {
            val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
            try {
                val gateway=Gateway().apply {newPickupSmsConfirmed=false};val saved=MemoryCredentials()
                val source=MutableStateFlow(navigation());val place=Destination(GeoPoint(37.6,127.2),"저장한 곳")
                if(hasPlace)gateway.people=gateway.people.map {it.copy(meetingPlace=place)}
                var routes=0
                val coordinator=PickupCoordinator(scope,source,gateway,saved,Lifetime(),{10000},wallNow={10000},routeTo={
                    assertEquals(0,gateway.startCalls);assertEquals(0,gateway.confirmationCalls);routes++
                    source.value=source.value.copy(destination=PickupDestination(it.point,it.name,600,2000))
                })
                val started=coordinator.startVoiceShare(" 지연 ",send) {
                    assertEquals(hasPlace,it);assertEquals(0,gateway.confirmationCalls)
                }
                assertEquals(send,started.smsConfirmed);assertEquals(1,gateway.startCalls)
                assertEquals(if(hasPlace)1 else 0,routes);assertEquals(if(send)listOf(started.id) else emptyList<String>(),gateway.confirmedIds)
                assertEquals(if(send)started.id else null,coordinator.state.value.messageNoticePickupId)
                assertEquals(DeviceCredentials("vehicle","token"),saved.read())
                assertTrue(runCatching {coordinator.startVoiceShare("지연이",true){fail("duplicate prepared route")}}.isFailure)
                assertEquals(if(send)1 else 0,gateway.confirmationCalls)
            } finally {scope.cancel()}
        }
    }
    @Test fun immediateVoiceNeverApprovesAnExistingOrUnresolvedPickup()=runBlocking {
        for(mode in listOf("server","local","pendingStart","pendingEnd")) {
            val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
            try {
                val gateway=Gateway().apply {newPickupSmsConfirmed=false};val saved=MemoryCredentials()
                if(mode in listOf("server","local"))gateway.server=Pickup("existing","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999,smsConfirmed=false)
                if(mode=="pendingStart")saved.starting="unresolved"
                if(mode=="pendingEnd")saved.ending=PendingEnd("existing","DRIVER_ENDED")
                val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000},wallNow={10000})
                if(mode=="local")coordinator.resume()
                assertTrue(runCatching {coordinator.startVoiceShare("지연이",true){fail("existing operation changed route")}}.isFailure)
                assertEquals(0,gateway.startCalls);assertEquals(0,gateway.confirmationCalls)
                gateway.server?.let {assertEquals("existing",it.id);assertFalse(it.smsConfirmed)}
            } finally {scope.cancel()}
        }
    }
    @Test fun immediateVoiceLostStartResponseCannotApproveRecoveredShare()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {newPickupSmsConfirmed=false;startResponseLost=true}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000})
            assertTrue(runCatching {coordinator.startVoiceShare("지연이",true){}}.isFailure)
            coordinator.currentStatus();assertFalse(coordinator.state.value.pickup!!.smsConfirmed)
            assertTrue(runCatching {coordinator.startVoiceShare("지연이",true){fail("recovery started another route")}}.isFailure)
            assertEquals(1,gateway.startCalls);assertEquals(0,gateway.confirmationCalls)
            assertNull(coordinator.state.value.messageNoticePickupId)
        } finally {scope.cancel()}
    }
    @Test fun failedImmediateVoiceApprovalKeepsShareForExplicitRetry()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {newPickupSmsConfirmed=false;confirmationOffline=true}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000})
            assertTrue(runCatching {coordinator.startVoiceShare("지연이",true){}}.isFailure)
            assertFalse(coordinator.state.value.pickup!!.smsConfirmed);assertNull(coordinator.state.value.messageNoticePickupId)
            gateway.confirmationOffline=false;coordinator.confirmMessage("pickup")
            assertTrue(coordinator.state.value.pickup!!.smsConfirmed)
            assertEquals(1,gateway.startCalls);assertEquals(listOf("pickup","pickup"),gateway.confirmedIds)
        } finally {scope.cancel()}
    }
    @Test fun cancellingImmediateVoiceRouteNeverCreatesOrApprovesPickup()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {newPickupSmsConfirmed=false}
            gateway.people=gateway.people.map {it.copy(meetingPlace=Destination(GeoPoint(37.6,127.2),"저장한 곳"))}
            val entered=kotlinx.coroutines.CompletableDeferred<Unit>()
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000},routeTo={entered.complete(Unit);awaitCancellation()})
            var failure: Throwable?=null
            val start=scope.launch {failure=runCatching {coordinator.startVoiceShare("지연이",true){}}.exceptionOrNull()}
            entered.await();coordinator.endShare();start.join()
            assertEquals("ROUTE_CANCELLED",(failure as ApiFailure).code)
            assertEquals(0,gateway.startCalls);assertEquals(0,gateway.confirmationCalls)
            assertNull(coordinator.state.value.pickup)
        } finally {scope.cancel()}
    }
    @Test fun immediateVoiceNavigationFailuresNeverApproveMessages()=runBlocking {
        for(mode in listOf("connection","routeFailure","routeMismatch","stale")) {
            val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
            try {
                val gateway=Gateway().apply {newPickupSmsConfirmed=false}
                if(mode!="stale")gateway.people=gateway.people.map {it.copy(meetingPlace=Destination(GeoPoint(37.6,127.2),"저장한 곳"))}
                val source=MutableStateFlow(if(mode=="stale")NavigationState() else navigation())
                val coordinator=PickupCoordinator(scope,source,gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000},routeTo={
                    if(mode=="routeFailure")throw ApiFailure(409,"ROUTE_FAILED","failed")
                })
                assertTrue(runCatching {coordinator.startVoiceShare("지연이",true){
                    if(mode=="connection")throw ApiFailure(409,"NAVIGATION_UNAVAILABLE","unavailable")
                }}.isFailure)
                assertEquals(0,gateway.startCalls);assertEquals(0,gateway.confirmationCalls)
            } finally {scope.cancel()}
        }
    }

    @Test fun pendingSetupSurvivesCoordinatorRecreationAndResendStaysUsed()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {saved=null};val gateway=Gateway()
            val first=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000},wallNow={10000})
            first.createPairing("01000005678");assertEquals(gateway.setup,saved.pendingPairing())
            first.resendPairing();assertEquals(0,saved.pendingPairing()!!.resendsRemaining)
            val restored=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000},wallNow={10000})
            restored.resume();assertEquals(0,restored.state.value.pairing!!.resendsRemaining)
            restored.resendPairing();assertEquals(1,gateway.setupResends)
            assertEquals(gateway.setup.shareMessage,restored.pairingMessage().shareMessage)
            assertNull(saved.read())
        } finally {scope.cancel()}
    }
    @Test fun expiredSetupIsDiscardedWithoutReplacingAnExistingVehicle()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {this.saved=null;setup=Pairing("old","secret","",5000)}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),Gateway(),saved,Lifetime(),{10000},wallNow={10000})
            coordinator.resume();assertNull(saved.pendingPairing());assertNull(coordinator.state.value.pairing)
        } finally {scope.cancel()}
    }
    @Test fun pickupResendIsOnceAndMessageCopyDoesNotUseIt()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999,smsConfirmed=true,messageResendsRemaining=1)}
            val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000})
            coordinator.resume();coordinator.shareMessage("pickup");assertEquals(0,gateway.pickupResends)
            assertEquals(0,coordinator.resendMessage("pickup").messageResendsRemaining)
            assertTrue(runCatching {coordinator.resendMessage("pickup")}.isFailure);assertEquals(1,gateway.pickupResends)
            coordinator.endShare();assertTrue(runCatching {coordinator.resendMessage("pickup")}.isFailure)
        } finally {scope.cancel()}
    }
    @Test fun pickupResendRejectsUnapprovedCooldownAndMismatchedResponse()=runBlocking {
        for(mode in listOf("unapproved","cooldown","wrong")) {
            val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
            try {
                val gateway=Gateway().apply {wrongResendId=mode=="wrong";server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999,smsConfirmed=mode!="unapproved",messageResendsRemaining=1,messageResendAfter=if(mode=="cooldown")20000 else 0)}
                val coordinator=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,MemoryCredentials(),Lifetime(),{10000},wallNow={10000})
                coordinator.resume();assertTrue(runCatching {coordinator.resendMessage("pickup")}.isFailure)
                assertEquals(if(mode=="wrong")1 else 0,gateway.pickupResends);assertEquals("pickup",coordinator.state.value.pickup!!.id)
            } finally {scope.cancel()}
        }
    }

    @Test fun guestStartsWithoutOtpAndRestoresSameVehicleWithoutProvisioningAgain()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {saved=null};val gateway=Gateway().apply {people=emptyList();linkedProfile=false}
            val c=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000})
            c.startGuest();assertTrue(c.state.value.paired);assertFalse(c.state.value.accountLinked)
            assertNull(gateway.onboardingPhone);assertEquals(1,gateway.guestKeys.size);assertEquals(64,saved.installKey!!.length)
            val old=saved.read();val restored=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000})
            restored.resume();restored.startGuest();assertEquals(old,saved.read());assertEquals(1,gateway.guestKeys.size)
        } finally {scope.cancel()}
    }
    @Test fun lostGuestResponseUsesDurableInstallationKeyAfterRecreation()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {saved=null};val gateway=Gateway().apply {guestResponseLost=true}
            PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000}).startGuest()
            assertNull(saved.read());assertNotNull(saved.installKey)
            gateway.guestResponseLost=false
            val restored=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000});restored.startGuest()
            assertEquals(gateway.guestKeys[0],gateway.guestKeys[1]);assertTrue(restored.state.value.paired)
        } finally {scope.cancel()}
    }
    @Test fun guestStartCannotReplaceAnExistingAccountOrOpenAnotherPairing()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials();val old=saved.read();val gateway=Gateway()
            val c=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000})
            c.startGuest();c.createPairing("01000005678")
            assertEquals(old,saved.read());assertTrue(gateway.guestKeys.isEmpty());assertNull(gateway.onboardingPhone)
        } finally {scope.cancel()}
    }
    @Test fun optionalLinkKeepsGuestVehicleTokenAndHistoryWhenPairingCompletes()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {saved=DeviceCredentials("vehicle","token",false);history=listOf(RecentPickup("contact","지연이",navigation().upload(10000)!!.destination))}
            val gateway=Gateway().apply {pairingResult=DeviceCredentials("vehicle","token",true)}
            val c=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000})
            c.createPairing("01000005678");yield()
            assertTrue(c.state.value.accountLinked);assertEquals("token",saved.read()!!.token);assertEquals("vehicle",saved.read()!!.vehicleId)
            assertEquals(1,c.state.value.recentPickups.size);assertNull(c.state.value.pairing);assertTrue(gateway.guestKeys.isEmpty())
        } finally {scope.cancel()}
    }
    @Test fun optionalPendingLinkRestoresAndProfileRecoversCompletionWithoutNewVehicle()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val gateway=Gateway().apply {linkedProfile=false}
            val saved=MemoryCredentials().apply {saved=DeviceCredentials("vehicle","token",false);setup=gateway.setup;history=listOf(RecentPickup("contact","지연이",navigation().upload(10000)!!.destination))}
            val c=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000})
            c.resume();assertFalse(c.state.value.accountLinked);assertNotNull(c.state.value.pairing)
            gateway.linkedProfile=true;c.resume();assertTrue(c.state.value.accountLinked);assertNull(c.state.value.pairing);assertNull(saved.pendingPairing())
            assertEquals("token",saved.read()!!.token);assertEquals(1,saved.history.size);assertTrue(gateway.guestKeys.isEmpty())
        } finally {scope.cancel()}
    }
    @Test fun directStartAbandonsUnfinishedLegacySetupButHonorsACompletedBinding()=runBlocking {
        for(completed in listOf(false,true)) {
            val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
            try {
                val gateway=Gateway().apply {if(completed)pairingResult=DeviceCredentials("old-vehicle","old-token")}
                val saved=MemoryCredentials().apply {saved=null;setup=gateway.setup}
                val c=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000})
                c.startGuest();assertNull(saved.pendingPairing())
                assertEquals(if(completed)"old-vehicle" else "guest-vehicle",saved.read()!!.vehicleId)
                assertEquals(if(completed)0 else 1,gateway.cancelledSetups);assertEquals(if(completed)0 else 1,gateway.guestKeys.size)
            } finally {scope.cancel()}
        }
    }
    @Test fun contactsFailureAfterProvisioningKeepsReadyStateAndNeverCreatesAnotherGuest()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials().apply {saved=null};val gateway=Gateway().apply {contactsOffline=true;linkedProfile=false}
            val c=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000})
            c.startGuest();assertTrue(c.state.value.paired);assertNotNull(saved.read());assertNotNull(c.state.value.error)
            gateway.contactsOffline=false;c.resume();assertNull(c.state.value.error);assertEquals(1,gateway.guestKeys.size)
        } finally {scope.cancel()}
    }

    @Test fun lockedAccessRecoveryReusesRequestKeyAfterNetworkFailureAndPreservesVehicleAndSmsAllowance()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
        try {
            val saved=MemoryCredentials();val before=saved.read()
            val gateway=Gateway().apply {renewalOffline=true;server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999,messageResendsRemaining=0,shareCodeLocked=true,shareRenewalsRemaining=2)}
            val c=PickupCoordinator(scope,MutableStateFlow(navigation()),gateway,saved,Lifetime(),{10000},wallNow={10000})
            c.resume();assertTrue(runCatching {c.renewAccess("pickup")}.isFailure)
            gateway.renewalOffline=false;val recovered=c.renewAccess("pickup")
            assertFalse(recovered.shareCodeLocked);assertEquals(0,recovered.messageResendsRemaining)
            assertEquals(2,gateway.renewalKeys.size);assertEquals(gateway.renewalKeys[0],gateway.renewalKeys[1]);assertEquals(before,saved.read())
            assertEquals(0,gateway.pickupResends);assertEquals(0,gateway.confirmationCalls)
            assertTrue(runCatching {c.renewAccess("pickup")}.isFailure);assertEquals(2,gateway.renewalKeys.size)
        } finally {scope.cancel()}
    }
    @Test fun recoveryRejectsCooldownExhaustionWrongPickupAndClosedShare()=runBlocking {
        for(mode in listOf("cooldown","exhausted","wrong")) {
            val scope=CoroutineScope(SupervisorJob()+Dispatchers.Unconfined)
            try {
                val g=Gateway().apply {wrongRenewalId=mode=="wrong";server=Pickup("pickup","ACTIVE","UNKNOWN","지연이",navigation().upload(10000)!!.destination,600,"FRESH",1,1,9999999,shareCodeLocked=true,shareRenewalsRemaining=if(mode=="exhausted")0 else 2,shareRenewAfter=if(mode=="cooldown")20000 else 0)}
                val c=PickupCoordinator(scope,MutableStateFlow(navigation()),g,MemoryCredentials(),Lifetime(),{10000},wallNow={10000})
                c.resume();assertTrue(runCatching {c.renewAccess("pickup")}.isFailure);assertEquals(if(mode=="wrong")1 else 0,g.renewalKeys.size);assertEquals("pickup",c.state.value.pickup!!.id)
                c.endShare();assertTrue(runCatching {c.renewAccess("pickup")}.isFailure)
            } finally {scope.cancel()}
        }
    }

}
