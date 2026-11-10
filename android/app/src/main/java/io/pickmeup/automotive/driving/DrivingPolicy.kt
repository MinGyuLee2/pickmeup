package io.pickmeup.automotive.driving

/** Unknown/disconnected is restricted; only an explicit unrestricted platform value permits setup. */
data class DrivingPolicy(
    val known: Boolean = false,
    val requiresOptimization: Boolean = true,
    val activeRestrictions: Int = 0,
    val maxStringLength: Int = 120,
) {
    val restricted get() = !known || requiresOptimization || activeRestrictions != 0
    val allowsSetup get() = !restricted
    fun text(value: CharSequence): String {
        if (!restricted) return value.toString()
        val limit = maxStringLength.coerceIn(1, 120)
        val points = value.toString().codePoints().toArray()
        return if (points.size <= limit) value.toString()
        else String(points, 0, (limit - 1).coerceAtLeast(0)) + "…"
    }
}
