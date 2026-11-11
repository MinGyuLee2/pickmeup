package io.pickmeup.automotive.pickup

import org.junit.Assert.*
import org.junit.Test

class CredentialServerPolicyTest {
    @Test fun currentBindingRemainsReadable() {
        assertTrue(CredentialServerPolicy.canRead(CredentialServerPolicy.PRODUCTION,CredentialServerPolicy.PRODUCTION,false))
        assertFalse(CredentialServerPolicy.canMigrate(CredentialServerPolicy.PRODUCTION,CredentialServerPolicy.PRODUCTION,false))
        assertFalse(CredentialServerPolicy.canRead("","",false))
    }
    @Test fun releaseMovesOnlyToVerifiedProduction() {
        assertTrue(CredentialServerPolicy.canMigrate(CredentialServerPolicy.PREVIOUS_RELEASE,CredentialServerPolicy.PRODUCTION,false))
        assertFalse(CredentialServerPolicy.canRead(CredentialServerPolicy.PRODUCTION,CredentialServerPolicy.PREVIOUS_RELEASE,false))
    }
    @Test fun loopbackMigrationIsLimitedToNormalDebug() {
        assertTrue(CredentialServerPolicy.canMigrate(CredentialServerPolicy.PREVIOUS_DEBUG,CredentialServerPolicy.PRODUCTION,true))
        assertFalse(CredentialServerPolicy.canRead(CredentialServerPolicy.PREVIOUS_DEBUG,CredentialServerPolicy.PRODUCTION,false))
        assertFalse(CredentialServerPolicy.canRead("http://127.0.0.1:4311",CredentialServerPolicy.PRODUCTION,true))
    }
    @Test fun unapprovedOriginsAndUrlVariantsNeverReceiveStoredCredentials() {
        val previous=CredentialServerPolicy.PREVIOUS_RELEASE
        for(target in listOf("https://evil.example/api",CredentialServerPolicy.PRODUCTION+"/","http://pickmeup.calkok.uk/api","https://pickmeup.calkok.uk.evil.example/api","https://pickmeup.calkok.uk@evil.example/api","https://pickmeup.calkok.uk/api?override=1"))
            assertFalse(target,CredentialServerPolicy.canRead(previous,target,true))
        for(stored in listOf("https://unrelated.ngrok-free.dev/api",previous+"/","https://localhost:4310","https://pickmeup.calkok.uk/api?override=1"))
            assertFalse(stored,CredentialServerPolicy.canRead(stored,CredentialServerPolicy.PRODUCTION,true))
    }
}
