package io.pickmeup.automotive.map
import io.pickmeup.automotive.navigation.GeoPoint
import io.pickmeup.automotive.pickup.RecipientLocation
/** A manually chosen spot stays fixed until removed; Only an explicitly confirmed waiting pin is displayed to the driver. */
internal data class RecipientMapTarget(val point: GeoPoint?,val manual: Boolean,val state: String) {
    companion object {
        @Suppress("UNUSED_PARAMETER")
        fun resolve(waitingPoint: GeoPoint?,gps: RecipientLocation?,now: Long): RecipientMapTarget =
            if(waitingPoint!=null)RecipientMapTarget(waitingPoint,true,"PINNED")
            else RecipientMapTarget(null,false,"OFF")
    }
}
