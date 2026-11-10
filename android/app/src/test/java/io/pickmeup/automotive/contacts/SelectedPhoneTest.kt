package io.pickmeup.automotive.contacts

import io.pickmeup.automotive.pickup.ApiFailure
import org.junit.Assert.*
import org.junit.Test

class SelectedPhoneTest {
    @Test fun normalizesDomesticAndInternationalKoreanMobileFormats() {
        for(number in listOf("010-1234-5678","+82 10 1234 5678","+82 (0)10-1234-5678"))
            assertEquals(SelectedPhone("지연이","01012345678"),SelectedPhone.parse(" 지연이 ",number))
    }
    @Test fun usesFallbackNameWithoutChangingTheChosenNumber() {
        assertEquals(SelectedPhone("연락 상대","01012345678"),SelectedPhone.parse(" ","01012345678"))
    }
    @Test fun rejectsLandlinesForeignNumbersExtensionsAndMissingNumbers() {
        for(number in listOf("02-1234-5678","+1 2125551234","01012345678;123",null)) {
            try {SelectedPhone.parse("상대",number);fail("Invalid number accepted")}
            catch(error: ApiFailure){assertEquals("INVALID_PHONE",error.code)}
        }
    }
    @Test fun rejectsControlCharactersAndOverlongNames() {
        for(name in listOf("상대\n이름","가".repeat(31))) {
            try {SelectedPhone.parse(name,"01012345678");fail("Invalid name accepted")}
            catch(error: ApiFailure){assertEquals("INVALID_CONTACT_NAME",error.code)}
        }
    }
}
