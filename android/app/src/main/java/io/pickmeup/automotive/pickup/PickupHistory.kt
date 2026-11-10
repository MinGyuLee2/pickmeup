package io.pickmeup.automotive.pickup

import io.pickmeup.automotive.navigation.matches

/** Only confirmed starts are remembered. No live position, phone number or route trace. */
fun List<RecentPickup>.remember(value: RecentPickup): List<RecentPickup> =
    (listOf(value)+filterNot {it.contactId==value.contactId && it.destination.matches(value.destination)}).take(6)

fun List<Destination>.distinctPlaces(): List<Destination> = fold(emptyList()) { result, place ->
    if(result.any {it.matches(place)})result else result+place
}
