package io.pickmeup.automotive.gleo

import org.junit.Assert.*
import org.junit.Test

class GleoCallerPolicyTest {
    @Test fun identitylessLegacyDeliveryRequiresAllSignaturePermissionGuards() {
        assertTrue(GleoCallerPolicy.allows(true,true,true,false,false))
        assertFalse(GleoCallerPolicy.allows(false,true,true,false,false))
        assertFalse(GleoCallerPolicy.allows(true,false,true,false,false))
        assertFalse(GleoCallerPolicy.allows(true,true,false,false,false))
    }
    @Test fun anAvailableIdentityMustAlsoMatchTheConfiguredCaller() {
        assertTrue(GleoCallerPolicy.allows(true,true,true,true,true))
        assertFalse(GleoCallerPolicy.allows(true,true,true,true,false))
        assertFalse(GleoCallerPolicy.allows(false,true,true,true,true))
    }
}
