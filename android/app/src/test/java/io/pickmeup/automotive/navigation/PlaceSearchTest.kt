package io.pickmeup.automotive.navigation

import io.pickmeup.automotive.pickup.Destination
import org.junit.Assert.*
import org.junit.Test

class PlaceSearchTest {
    private val old=Destination(GeoPoint(37.4,127.1),"기존 장소")
    private val chosen=Destination(GeoPoint(37.5,127.2),"새 장소")
    private fun state()=NavigationState(connection=NavigationConnection.CONNECTED,routeKnown=true,guidanceUpdates=1,guiding=true,
        destination=PickupDestination(chosen.point,chosen.name,600,2000),destinationElapsedAt=11_000)
    @Test fun importsNewGuidanceOnlyAfterSearch() {
        assertEquals(PlaceSearchResult.Selected(chosen),PlaceSearch(10_000,old).result(state(),12_000))
    }
    @Test fun cancellationDoesNotReuseAnExistingRoute() {
        val previous=state().copy(destination=PickupDestination(old.point,old.name,600,2000))
        assertEquals(PlaceSearchResult.Unchanged,PlaceSearch(10_000,old).result(previous,12_000))
        assertEquals(PlaceSearchResult.Unchanged,PlaceSearch(10_000,old).result(previous.copy(destination=null,guiding=false),12_000))
    }
    @Test fun aPreviewAndArrivalAreNotConfirmedNewGuidance() {
        assertEquals(PlaceSearchResult.Unchanged,PlaceSearch(10_000,old).result(state().copy(guiding=false),12_000))
        assertEquals(PlaceSearchResult.Unchanged,PlaceSearch(10_000,old).result(state().copy(arrived=true),12_000))
    }
    @Test fun oldAndStaleSamplesWaitForNewSnapshot() {
        assertEquals(PlaceSearchResult.Waiting,PlaceSearch(10_000,old).result(state().copy(destinationElapsedAt=9_000),12_000))
        assertEquals(PlaceSearchResult.Waiting,PlaceSearch(10_000,old).result(state(),50_000))
    }
    @Test fun initialCallbackOrderDoesNotConsumeSearchPrematurely() {
        val search=PlaceSearch(10_000,null)
        assertEquals(PlaceSearchResult.Waiting,search.result(state().copy(guidanceUpdates=0),12_000))
        assertEquals(PlaceSearchResult.Waiting,search.result(state().copy(routeKnown=false),12_000))
        assertEquals(PlaceSearchResult.Waiting,search.result(state().copy(connection=NavigationConnection.CONNECTING),12_000))
    }
    @Test fun expiredOrRebootedSessionsCannotImportUnrelatedDestinations() {
        assertEquals(PlaceSearchResult.Expired,PlaceSearch(10_000,old).result(state(),700_000))
        assertEquals(PlaceSearchResult.Expired,PlaceSearch(10_000,old).result(state(),9_000))
    }
    @Test fun firstSearchWithoutPreviousRouteCanSelectAPlace() {
        assertEquals(PlaceSearchResult.Selected(chosen),PlaceSearch(10_000,null).result(state(),12_000))
    }
}
