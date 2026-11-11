package io.pickmeup.automotive.pickup

/** One-way migration between this service's verified deployments, never arbitrary hosts. */
object CredentialServerPolicy {
    const val PRODUCTION = "https://pickmeup.calkok.uk/api"
    const val PREVIOUS_RELEASE = "https://enforced-spookily-unweave.ngrok-free.dev/api"
    const val PREVIOUS_DEBUG = "http://127.0.0.1:4310"

    fun canRead(stored: String, current: String, debug: Boolean): Boolean =
        stored.isNotBlank() && (stored == current || canMigrate(stored, current, debug))

    fun canMigrate(stored: String, current: String, debug: Boolean): Boolean =
        current == PRODUCTION && (stored == PREVIOUS_RELEASE || (debug && stored == PREVIOUS_DEBUG))
}
