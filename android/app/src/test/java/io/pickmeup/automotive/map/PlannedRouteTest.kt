package io.pickmeup.automotive.map
import io.pickmeup.automotive.navigation.GeoPoint
import org.junit.Assert.*
import org.junit.Test
class PlannedRouteTest {
    private val path=listOf(GeoPoint(37.4,127.1),GeoPoint(37.41,127.11))
    @Test fun geometryExpiresWithMonotonicTimeIncludingWhileOffline() {
        val route=PlannedRoute(path,30_000,1000)
        assertTrue(route.visibleAt(1000));assertTrue(route.visibleAt(30_999));assertFalse(route.visibleAt(31_000));assertFalse(route.visibleAt(999))
    }
    @Test fun missingOversizedAndInvalidLeasesCannotRemainVisible() {
        for(route in listOf(PlannedRoute(emptyList(),1000,0),PlannedRoute(path,0,0),PlannedRoute(path,120_001,0),PlannedRoute(List(4001){path[0]},1000,0)))assertFalse(route.visibleAt(0))
    }
    @Test fun completedRoadFragmentsShareThePayloadBudgetAndExpireWithTheRoute() {
        assertTrue(PlannedRoute(path,1000,0,listOf(path)).visibleAt(0))
        assertFalse(PlannedRoute(path,1000,0,List(33){path}).visibleAt(0))
        assertFalse(PlannedRoute(path,1000,0,listOf(List(3999){path[0]})).visibleAt(0))
        assertFalse(PlannedRoute(path,1000,0,listOf(listOf(path[0]))).visibleAt(0))
        assertFalse(PlannedRoute(path,1000,0,listOf(path)).visibleAt(1000))
    }
}
