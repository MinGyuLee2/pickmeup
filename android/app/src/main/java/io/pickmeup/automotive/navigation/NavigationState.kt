package io.pickmeup.automotive.navigation

data class GeoPoint(val latitude: Double, val longitude: Double) {
    init {
        require(latitude.isFinite() && latitude in -90.0..90.0)
        require(longitude.isFinite() && longitude in -180.0..180.0)
    }
}

data class PickupDestination(val point: GeoPoint, val name: String, val remainingSeconds: Int, val remainingMeters: Int) {
    init { require(name.isNotBlank() && remainingSeconds >= 0 && remainingMeters >= 0) }
}

enum class NavigationConnection { DISCONNECTED, CONNECTING, CONNECTED, FAILED }

data class NavigationState(
    val recentDestinations: List<io.pickmeup.automotive.pickup.Destination> = emptyList(),
    val connection: NavigationConnection = NavigationConnection.DISCONNECTED,
    val location: GeoPoint? = null,
    val locationReceivedAt: Long? = null,
    val locationElapsedAt: Long? = null,
    val destination: PickupDestination? = null,
    val destinationReceivedAt: Long? = null,
    val destinationElapsedAt: Long? = null,
    val routeRevision: Long = 0,
    val routeCancelled: Boolean = false,
    val routeKnown: Boolean = false,
    val locationUpdates: Long = 0,
    val destinationUpdates: Long = 0,
    val routingCompletions: Long = 0,
    val routingErrors: Long = 0,
    val guiding: Boolean = false,
    val guidanceUpdates: Long = 0,
    val arrived: Boolean = false,
    val lastEvent: String = "내비 연결 대기",
    val error: String? = null,
) {
    fun isStale(now: Long, thresholdMillis: Long = 30_000): Boolean =
        locationReceivedAt == null || now < locationReceivedAt || now - locationReceivedAt > thresholdMillis

    fun isEtaStale(now: Long, thresholdMillis: Long = 30_000): Boolean =
        destinationReceivedAt == null || now < destinationReceivedAt || now - destinationReceivedAt > thresholdMillis
}
