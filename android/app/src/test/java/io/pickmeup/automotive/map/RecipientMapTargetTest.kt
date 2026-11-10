package io.pickmeup.automotive.map
import io.pickmeup.automotive.navigation.GeoPoint
import io.pickmeup.automotive.pickup.RecipientLocation
import org.junit.Assert.*
import org.junit.Test
class RecipientMapTargetTest {
    private val pin=GeoPoint(37.3948,127.1112)
    private val gps=RecipientLocation("LIVE",GeoPoint(37.3950,127.1120),5.0,0,0)
    @Test fun manuallyChosenSpotTakesPriorityAndNeverAgesIntoAGpsWarning() {
        val target=RecipientMapTarget.resolve(pin,gps,120000)
        assertEquals(pin,target.point);assertTrue(target.manual);assertEquals("PINNED",target.state)
    }
    @Test fun removingThePinNeverFallsBackToAnUnconfirmedGpsPosition() {
        assertEquals("OFF",RecipientMapTarget.resolve(null,gps,1000).state)
        assertNull(RecipientMapTarget.resolve(null,gps,31000).point)
        assertFalse(RecipientMapTarget.resolve(null,gps,1000).manual)
    }
    @Test fun noLocationReturnsToTheMeetingPlaceFrame() {
        val target=RecipientMapTarget.resolve(null,null,1000)
        assertNull(target.point);assertEquals("OFF",target.state)
        assertEquals(listOf(pin),PickupMapFrame.focus(pin,null,target.point))
    }
}
