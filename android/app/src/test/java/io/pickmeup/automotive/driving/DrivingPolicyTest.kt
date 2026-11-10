package io.pickmeup.automotive.driving

import org.junit.Assert.*
import org.junit.Test

class DrivingPolicyTest {
    @Test fun onlyConfirmedUnrestrictedStateAllowsSetup() {
        assertFalse(DrivingPolicy().allowsSetup)
        assertFalse(DrivingPolicy(true, true, 0).allowsSetup)
        assertFalse(DrivingPolicy(true, false, 64).allowsSetup)
        assertTrue(DrivingPolicy(true, false, 0).allowsSetup)
    }
    @Test fun restrictedTextRespectsPlatformLimitWithoutSplittingUnicode() {
        val policy = DrivingPolicy(true, true, 4, 3)
        assertEquals("가😀…", policy.text("가😀나다"))
        assertEquals("…", policy.copy(maxStringLength=0).text("긴 문자열"))
        assertEquals("가😀나다", DrivingPolicy(true, false, 0, 3).text("가😀나다"))
    }
}
