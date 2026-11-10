package io.pickmeup.automotive.navigation

import io.pickmeup.automotive.pickup.Destination

/** Native search has no POI-picker callback. Only import fresh, confirmed guidance on return. */
data class PlaceSearch(val startedElapsedAt: Long, val previousDestination: Destination?) {
    fun result(state: NavigationState, elapsedNow: Long): PlaceSearchResult {
        val age=elapsedNow-startedElapsedAt
        if(age !in 0..600_000)return PlaceSearchResult.Expired
        if(state.connection!=NavigationConnection.CONNECTED || !state.routeKnown || state.guidanceUpdates==0L)
            return PlaceSearchResult.Waiting
        val destination=state.destination ?: return PlaceSearchResult.Unchanged
        val observedAt=state.destinationElapsedAt ?: return PlaceSearchResult.Waiting
        if(observedAt<startedElapsedAt || elapsedNow-observedAt !in 0..30_000)return PlaceSearchResult.Waiting
        if(!state.guiding || state.arrived)return PlaceSearchResult.Unchanged
        val place=Destination(destination.point,destination.name)
        return if(previousDestination?.matches(place)==true)PlaceSearchResult.Unchanged else PlaceSearchResult.Selected(place)
    }
}
sealed class PlaceSearchResult {
    object Waiting: PlaceSearchResult()
    object Unchanged: PlaceSearchResult()
    object Expired: PlaceSearchResult()
    data class Selected(val destination: Destination): PlaceSearchResult()
}
