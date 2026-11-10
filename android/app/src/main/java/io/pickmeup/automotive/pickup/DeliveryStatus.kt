package io.pickmeup.automotive.pickup

/** Queue acceptance is not recipient delivery. Restored snapshots never trigger send toasts. */
fun deliveryStatus(pickup: Pickup,now: Long): String {
    if(pickup.shareCodeLocked)return if(pickup.shareRenewalsRemaining>0)"상대 인증이 잠겼어요 · 정차 후 ‘인증 잠금 풀기’로 새 링크를 전달하세요" else "상대 인증이 잠겼어요 · 링크 교체 횟수를 모두 사용했어요"
    if(!pickup.smsConfirmed)return "문자 없이 공유 중 · 링크를 직접 전달하세요"
    if(pickup.simulatedDelivery)return "테스트 모드 · 실제 문자 발송 없음"
    return when {
        pickup.messageStatus=="PENDING"->if(pickup.messageQueuedAt>0&&now-pickup.messageQueuedAt>=30_000)"문자 발송 대기 중 · 링크로 직접 알려주세요" else "문자 발송 대기 중"
        pickup.messageStatus=="ACCEPTED"->"문자 발송 접수 · 전달 확인 중"
        pickup.messageStatus=="FAILED"->"문자 발송 실패 · 링크로 직접 알려주세요"
        pickup.messageStatus=="UNKNOWN"->"문자 전달 미확인 · 상대에게 확인해 주세요"
        pickup.messageStatus=="CANCELLED"->"문자 발송 취소됨 · 링크로 직접 알려주세요"
        pickup.nearMessageStatus=="FAILED"->"5분 전 문자 발송 실패 · 도착 시간은 계속 공유돼요"
        pickup.nearMessageStatus=="UNKNOWN"->"5분 전 문자 전달 미확인"
        pickup.messageStatus=="DELIVERED"->"문자 전달 확인"
        else->"문자 전달 상태 확인 중"
    }
}
