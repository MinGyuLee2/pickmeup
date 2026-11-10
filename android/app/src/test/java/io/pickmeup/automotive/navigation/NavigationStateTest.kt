package io.pickmeup.automotive.navigation

import org.junit.Assert.*
import org.junit.Test

class NavigationStateTest {
    @Test fun invalidCoordinatesAreRejected() {
        listOf(Double.NaN, Double.POSITIVE_INFINITY, -91.0, 91.0).forEach { value ->
            assertThrows(IllegalArgumentException::class.java) { GeoPoint(value, 127.0) }
        }
        assertThrows(IllegalArgumentException::class.java) { GeoPoint(37.0, 181.0) }
    }
    @Test fun missingOldAndFutureSamplesAreNotPresentedAsFresh() {
        assertTrue(NavigationState().isStale(50_000))
        val sample = NavigationState(location = GeoPoint(37.0, 127.0), locationReceivedAt = 10_000)
        assertFalse(sample.isStale(15_000))
        assertTrue(sample.isStale(41_000))
        assertTrue(sample.isStale(9_999))
    }
    @Test fun negativeEtaCannotEnterValidDestination() {
        assertThrows(IllegalArgumentException::class.java) {
            PickupDestination(GeoPoint(37.0, 127.0), "목적지", -1, 10)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PickupDestination(GeoPoint(0.0, 0.0), "", 0, 0)
        }
    }
    @Test fun etaFreshnessIsIndependentOfLocationFreshness() {
        val sample = NavigationState(locationReceivedAt = 49_000, destinationReceivedAt = 10_000)
        assertFalse(sample.isStale(50_000))
        assertTrue(sample.isEtaStale(50_000))
    }
}
