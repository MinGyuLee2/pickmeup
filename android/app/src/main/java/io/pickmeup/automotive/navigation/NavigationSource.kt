package io.pickmeup.automotive.navigation

import io.pickmeup.automotive.pickup.Destination
import kotlinx.coroutines.flow.StateFlow

/** Navigation input contract. Production uses NaviHelper; filming has its own source set. */
interface NavigationSource {
    val state: StateFlow<NavigationState>
    fun start()
    fun close()
    fun requestSnapshot()
    fun requestRecentDestinations()
    suspend fun openPlaceSelection()
    suspend fun prepareRoute(place: Destination)
}
