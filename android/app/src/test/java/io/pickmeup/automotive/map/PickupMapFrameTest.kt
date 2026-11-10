package io.pickmeup.automotive.map
import io.pickmeup.automotive.navigation.GeoPoint
import io.pickmeup.automotive.pickup.RecipientLocation
import org.junit.Assert.*
import org.junit.Test
class PickupMapFrameTest {
    @Test fun carAndRecipientStayTogetherEvenWhenFarApart() {
        val meeting=GeoPoint(37.3948,127.1112);val person=GeoPoint(37.39505,127.1115);val car=GeoPoint(37.52,127.09)
        assertEquals(setOf(car,person),PickupMapFrame.focus(meeting,car,person).toSet())
    }
    @Test fun distantMeetingDoesNotMakeTheTwoPersonViewSmaller() {
        val meeting=GeoPoint(36.0,128.0);val person=GeoPoint(37.39505,127.1115);val car=GeoPoint(37.4,127.11)
        assertFalse(meeting in PickupMapFrame.focus(meeting,car,person))
    }
    @Test fun stoppingLocationSharingReturnsToCarAndMeetingWithoutKeepingTheRecipient() {
        val meeting=GeoPoint(37.3948,127.1112);val car=GeoPoint(37.42,127.09)
        assertEquals(listOf(car,meeting),PickupMapFrame.focus(meeting,car,null))
        assertEquals(listOf(meeting),PickupMapFrame.focus(meeting,null,null))
    }
    @Test fun missingCarAndCoincidentPointsStillProduceAValidFrame() {
        val meeting=GeoPoint(37.3948,127.1112);val person=GeoPoint(37.4,127.1)
        assertEquals(listOf(person),PickupMapFrame.focus(meeting,null,person))
        assertEquals(listOf(person),PickupMapFrame.focus(meeting,person,person))
    }
    @Test fun staleAgeUsesElapsedTimeAndCannotBecomeLiveAfterClockChanges() {
        val point=GeoPoint(37.4,127.1);val s=RecipientLocation("LIVE",point,12.0,29_000,1000)
        assertEquals("LIVE",s.displayState(2000));assertEquals("STALE",s.displayState(2001));assertEquals("STALE",s.displayState(500))
        assertEquals("PAUSED",s.copy(state="PAUSED").displayState(1000));assertEquals("STALE",s.copy(state="STALE").displayState(1000))
    }
    @Test fun noSampleNeverDisplaysALiveRecipientAndAgeDoesNotOverflow() {
        assertEquals("WAITING",RecipientLocation("LIVE",null,null,0,0).displayState(0))
        assertEquals(Long.MAX_VALUE,RecipientLocation("LIVE",null,null,Long.MAX_VALUE,0).ageMs(1000))
    }
}
