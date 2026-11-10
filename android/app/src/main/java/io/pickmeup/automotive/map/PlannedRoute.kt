package io.pickmeup.automotive.map

import io.pickmeup.automotive.navigation.GeoPoint

/** Ephemeral road geometry: never persisted in credentials or pickup history. */
data class PlannedRoute(val path: List<GeoPoint>,val validForMs: Long,val receivedElapsedAt: Long,val traveledPaths: List<List<GeoPoint>> = emptyList()) {
    fun visibleAt(elapsedNow: Long)=path.size>=2 && traveledPaths.size<=32 && traveledPaths.all {it.size>=2} && path.size+traveledPaths.sumOf {it.size}<=4000 && validForMs in 1..120_000 && elapsedNow-receivedElapsedAt in 0 until validForMs
}
