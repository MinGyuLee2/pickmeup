package io.pickmeup.automotive.pickup
import io.pickmeup.automotive.navigation.GeoPoint
import org.junit.Assert.*
import org.junit.Test

class DeliveryStatusTest {
    private val pickup=Pickup("p","ACTIVE","UNKNOWN","가상 상대",Destination(GeoPoint(37.4,127.1),"만날 곳"),600,"FRESH",1,1,9999999,messageStatus="PENDING",messageProvider="solapi",messageQueuedAt=1000)
    @Test fun pendingAndAcceptedNeverClaimDeliveryAndLongWaitOffersDirectLink() {
        assertEquals("문자 발송 대기 중",deliveryStatus(pickup,10000))
        assertTrue(deliveryStatus(pickup,31000).contains("링크로 직접"))
        assertEquals("문자 발송 접수 · 전달 확인 중",deliveryStatus(pickup.copy(messageStatus="ACCEPTED"),31000))
        assertEquals("문자 전달 확인",deliveryStatus(pickup.copy(messageStatus="DELIVERED"),31000))
    }
    @Test fun unapprovedSimulatedAndFailedJobsAreDistinct() {
        assertTrue(deliveryStatus(pickup.copy(smsConfirmed=false),10000).contains("문자 없이"))
        assertEquals("테스트 모드 · 실제 문자 발송 없음",deliveryStatus(pickup.copy(messageProvider="local"),10000))
        assertTrue(deliveryStatus(pickup.copy(messageStatus="FAILED"),10000).contains("발송 실패"))
        assertTrue(deliveryStatus(pickup.copy(messageStatus="UNKNOWN"),10000).contains("전달 미확인"))
    }
    @Test fun codeLockTakesPriorityAndExhaustionDoesNotSuggestAnUnavailableRecovery() {
        assertTrue(deliveryStatus(pickup.copy(shareCodeLocked=true,shareRenewalsRemaining=1),10000).contains("인증 잠금 풀기"))
        assertTrue(deliveryStatus(pickup.copy(shareCodeLocked=true),10000).contains("모두 사용"))
    }
}
