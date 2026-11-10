package io.pickmeup.automotive.gleo

import io.pickmeup.automotive.navigation.*
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test

class VoiceNavigationTest {
    private fun fresh()=NavigationState(connection=NavigationConnection.CONNECTED,
        location=GeoPoint(37.4,127.0),locationElapsedAt=9_000,
        destination=PickupDestination(GeoPoint(37.5,127.1),"정문",600,2000),
        destinationElapsedAt=9_000,routeKnown=true)

    @Test fun savedPlaceOnlyWaitsForConnectionAndDoesNotRequireAnExistingRoute()=runBlocking {
        val state=MutableStateFlow(NavigationState())
        val result=async {awaitVoiceNavigationConnection(state,1000)}
        yield();assertFalse(result.isCompleted)
        state.value=NavigationState(connection=NavigationConnection.CONNECTED,routeKnown=true)
        assertTrue(result.await())
        assertFalse(awaitVoiceNavigationConnection(MutableStateFlow(NavigationState(connection=NavigationConnection.FAILED))))
    }
    @Test fun coldStartWaitsForBothLocationAndEtaInsteadOfConnectionOnly()=runBlocking {
        val state=MutableStateFlow(NavigationState())
        val result=async { awaitVoiceNavigation(state,{10_000},1_000) }
        yield();assertFalse(result.isCompleted)
        state.value=NavigationState(connection=NavigationConnection.CONNECTED)
        yield();assertFalse(result.isCompleted)
        state.value=fresh().copy(destination=null,destinationElapsedAt=null,routeKnown=false)
        yield();assertFalse(result.isCompleted)
        state.value=fresh();assertTrue(result.await())
    }
    @Test fun failedConnectionMissingRouteAndStaleTimeoutCannotStartSharing()=runBlocking {
        assertFalse(awaitVoiceNavigation(MutableStateFlow(NavigationState(connection=NavigationConnection.FAILED)),{10_000}))
        assertFalse(awaitVoiceNavigation(MutableStateFlow(fresh().copy(destination=null)),{10_000}))
        assertFalse(awaitVoiceNavigation(MutableStateFlow(fresh()),{50_000},20))
    }
}
