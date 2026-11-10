package io.pickmeup.automotive.contacts

import io.pickmeup.automotive.pickup.ApiFailure

data class SelectedPhone(val name: String, val phone: String) {
    companion object {
        fun parse(displayName: String?, number: String?): SelectedPhone {
            var phone=number.orEmpty().replace(Regex("[\\s().-]"),"")
            if(phone.startsWith("+82"))phone="0"+phone.removePrefix("+82").removePrefix("0")
            if(!Regex("01[016789]\\d{7,8}").matches(phone))
                throw ApiFailure(400,"INVALID_PHONE","국내 휴대전화 번호가 있는 연락처를 선택해 주세요.")
            val name=displayName?.trim()?.ifBlank { null } ?: "연락 상대"
            if(name.length>30 || name.any { it.code<32 || it.code==127 })
                throw ApiFailure(400,"INVALID_CONTACT_NAME","상대 이름은 30자 이내로 등록해 주세요.")
            return SelectedPhone(name,phone)
        }
    }
}
