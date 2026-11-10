package io.pickmeup.automotive.pickup
import io.pickmeup.automotive.navigation.GeoPoint

data class RecipientLocation(val state: String,val point: GeoPoint?,val accuracyMeters: Double?,val serverAgeMs: Long,val receivedElapsed: Long) {
    fun ageMs(nowElapsed: Long): Long {
        val elapsed=(nowElapsed-receivedElapsed).coerceAtLeast(0)
        return if(serverAgeMs>Long.MAX_VALUE-elapsed)Long.MAX_VALUE else serverAgeMs+elapsed
    }
    fun displayState(nowElapsed: Long): String = when {
        state=="OFF"->"OFF"
        state=="PAUSED"->"PAUSED"
        point==null->"WAITING"
        state!="LIVE"||nowElapsed<receivedElapsed||ageMs(nowElapsed)>30_000->"STALE"
        else->"LIVE"
    }
}
