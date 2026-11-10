package io.pickmeup.automotive.navigation

import io.pickmeup.automotive.pickup.Destination
import org.junit.Assert.*
import org.junit.Test

class SavedRouteTest {
    private val place=Destination(GeoPoint(37.5,127.1),"역 1번 출구")
    private val before=NavigationState(connection=NavigationConnection.CONNECTED,location=GeoPoint(37.4,127.0),
        locationElapsedAt=1000,destination=PickupDestination(place.point,place.name,600,2000),destinationElapsedAt=1000,
        routingCompletions=1,locationUpdates=1,destinationUpdates=1)
    @Test fun requestAcceptanceOrOldMatchingSnapshotIsNotRouteSuccess() {
        assertFalse(before.readyForSavedRoute(place,before,2000))
        assertFalse(before.copy(routingCompletions=2).readyForSavedRoute(place,before,2000))
        assertFalse(before.copy(locationUpdates=2,destinationUpdates=2).readyForSavedRoute(place,before,2000))
    }
    @Test fun onlyNewCompletedMatchingFreshRouteCanStart() {
        val ready=before.copy(guiding=true,routingCompletions=2,locationUpdates=2,destinationUpdates=2)
        assertTrue(ready.readyForSavedRoute(place,before,2000))
        assertFalse(ready.copy(guiding=false).readyForSavedRoute(place,before,2000))
        assertFalse(ready.copy(routeCancelled=true).readyForSavedRoute(place,before,2000))
        assertFalse(ready.copy(arrived=true).readyForSavedRoute(place,before,2000))
        assertFalse(ready.readyForSavedRoute(place,before,40000))
        assertFalse(ready.copy(destination=ready.destination!!.copy(name="다른 출구")).readyForSavedRoute(place,before,2000))
        assertFalse(ready.copy(destination=ready.destination!!.copy(point=GeoPoint(37.6,127.1))).readyForSavedRoute(place,before,2000))
        assertTrue(place.matches(place.copy(point=GeoPoint(37.50001,127.1))))
    }
}
