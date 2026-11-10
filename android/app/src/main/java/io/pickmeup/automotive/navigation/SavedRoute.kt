package io.pickmeup.automotive.navigation

import io.pickmeup.automotive.pickup.Destination
import io.pickmeup.automotive.pickup.upload
import kotlin.math.cos
import kotlin.math.hypot

/** Permit small road/entrance snapping, but never accept another named destination. */
fun Destination.matches(other: Destination): Boolean {
    val north=(point.latitude-other.point.latitude)*111_320
    val east=(point.longitude-other.point.longitude)*111_320*cos(Math.toRadians(point.latitude))
    return name==other.name && hypot(north,east)<=50
}

fun NavigationState.readyForSavedRoute(place: Destination, before: NavigationState, elapsedNow: Long): Boolean {
    val sample=upload(elapsedNow) ?: return false
    return guiding && (routingCompletions>before.routingCompletions || guidanceUpdates>before.guidanceUpdates) && destinationUpdates>before.destinationUpdates &&
        locationUpdates>before.locationUpdates && !arrived && !routeCancelled && sample.observation.fresh && place.matches(sample.destination)
}
