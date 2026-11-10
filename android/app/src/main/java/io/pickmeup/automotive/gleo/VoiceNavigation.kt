package io.pickmeup.automotive.gleo

import io.pickmeup.automotive.navigation.NavigationConnection
import io.pickmeup.automotive.navigation.NavigationState
import io.pickmeup.automotive.pickup.upload
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/** A saved place can create a route; it only needs the SDK connection at this stage. */
suspend fun awaitVoiceNavigationConnection(state: StateFlow<NavigationState>,timeoutMillis: Long = 3_500): Boolean {
    val result=withTimeoutOrNull(timeoutMillis) {
        state.first {it.connection in setOf(NavigationConnection.CONNECTED,NavigationConnection.FAILED)}
    }
    return result?.connection==NavigationConnection.CONNECTED
}

/** Connection alone is insufficient: voice start needs both fresh SDK location and route ETA. */
suspend fun awaitVoiceNavigation(
    state: StateFlow<NavigationState>,
    elapsedNow: () -> Long,
    timeoutMillis: Long = 3_500,
): Boolean {
    val result = withTimeoutOrNull(timeoutMillis) {
        state.first { sample ->
            sample.upload(elapsedNow())?.observation?.fresh == true ||
                sample.connection == NavigationConnection.FAILED ||
                (sample.routeKnown && sample.destination == null)
        }
    }
    return result?.upload(elapsedNow())?.observation?.fresh == true
}
