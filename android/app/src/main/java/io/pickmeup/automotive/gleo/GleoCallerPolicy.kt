package io.pickmeup.automotive.gleo

/** A signature permission is enforced by Android before delivery, including legacy broadcasts. */
object GleoCallerPolicy {
    const val ACTION_PERMISSION="ai.umos.gleo.permission.APP_ACTION"
    fun allows(
        pinnedPermissionOwner: Boolean,
        receiverProtected: Boolean,
        pureSignaturePermission: Boolean,
        identityAvailable: Boolean,
        expectedIdentity: Boolean,
    ) = pinnedPermissionOwner && receiverProtected && pureSignaturePermission &&
        (!identityAvailable || expectedIdentity)
}
