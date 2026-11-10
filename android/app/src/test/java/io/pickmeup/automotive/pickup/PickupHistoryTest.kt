package io.pickmeup.automotive.pickup

import io.pickmeup.automotive.navigation.GeoPoint
import org.junit.Assert.*
import org.junit.Test

class PickupHistoryTest {
    private val station=Destination(GeoPoint(37.3948,127.1112),"판교역")
    @Test fun sameCombinationMovesToFrontButOtherPeopleAndPlacesRemain() {
        val first=RecentPickup("a","지연이",station)
        val other=RecentPickup("b","민수",station)
        val company=first.copy(destination=station.copy(name="회사"))
        val result=listOf(other,first,company).remember(first.copy(recipientName="새 이름"))
        assertEquals(listOf("새 이름","민수","지연이"),result.map {it.recipientName})
        assertEquals(3,result.size)
        assertEquals(1,result.map {it.destination}.distinctPlaces().count {it.name=="판교역"})
    }
    @Test fun historyIsBoundedAndRoadSnappingDoesNotDuplicateACombination() {
        var rows=emptyList<RecentPickup>()
        repeat(10){rows=rows.remember(RecentPickup("$it","상대$it",station))}
        assertEquals(6,rows.size);assertEquals("9",rows.first().contactId)
        rows=rows.remember(rows.first().copy(destination=station.copy(point=GeoPoint(37.39481,127.1112))))
        assertEquals(6,rows.size)
    }
}
