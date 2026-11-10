package io.pickmeup.automotive.map

import io.pickmeup.automotive.navigation.GeoPoint
/** The driver and recipient always share one automatic viewport, at any separation. */
internal object PickupMapFrame {
    fun focus(destination: GeoPoint,car: GeoPoint?,recipient: GeoPoint?): List<GeoPoint> =
        listOfNotNull(car,recipient ?: destination).distinct()
}
