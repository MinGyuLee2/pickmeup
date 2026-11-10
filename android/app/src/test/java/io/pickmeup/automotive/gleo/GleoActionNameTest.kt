package io.pickmeup.automotive.gleo

import io.pickmeup.automotive.BuildConfig
import org.junit.Assert.*
import org.junit.Test

class GleoActionNameTest {
    @Test fun nativePackageQualifiedActionsAndDocumentedShortActionsHaveTheSameHandler() {
        listOf("START_PICKUP_SHARE","GET_PICKUP_STATUS","STOP_PICKUP_SHARE").forEach {
            assertEquals(it,GleoActionHandler.canonicalAction(it))
            assertEquals(it,GleoActionHandler.canonicalAction("${BuildConfig.APPLICATION_ID}.$it"))
        }
    }
    @Test fun foreignPrefixesAndUnknownActionsAreNotAccepted() {
        assertNull(GleoActionHandler.canonicalAction("other.package.GET_PICKUP_STATUS"))
        assertNull(GleoActionHandler.canonicalAction("${BuildConfig.APPLICATION_ID}.UNKNOWN"))
        assertNull(GleoActionHandler.canonicalAction(null))
    }
}
