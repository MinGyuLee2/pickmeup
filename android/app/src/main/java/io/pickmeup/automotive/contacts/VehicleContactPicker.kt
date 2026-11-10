package io.pickmeup.automotive.contacts

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract.CommonDataKinds.Phone
import io.pickmeup.automotive.pickup.ApiFailure
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The system picker grants access to one chosen phone row; no address-book permission or sync. */
class VehicleContactPicker(private val context: Context) {
    fun intent()=Intent(Intent.ACTION_PICK).apply { type=Phone.CONTENT_TYPE }
    fun available()=intent().resolveActivity(context.packageManager)!=null
    suspend fun read(uri: Uri): SelectedPhone = withContext(Dispatchers.IO) {
        if(uri.scheme!="content" || uri.authority !in setOf("com.android.contacts","contacts") || uri.lastPathSegment?.toLongOrNull()==null)
            throw ApiFailure(400,"INVALID_CONTACT_URI","차량 연락처에서 상대를 다시 선택해 주세요.")
        try {
            context.contentResolver.query(uri,arrayOf(Phone.DISPLAY_NAME,Phone.NUMBER),null,null,null)?.use { cursor ->
                if(cursor.count==1 && cursor.moveToFirst())return@withContext SelectedPhone.parse(
                    cursor.getString(cursor.getColumnIndexOrThrow(Phone.DISPLAY_NAME)),
                    cursor.getString(cursor.getColumnIndexOrThrow(Phone.NUMBER)))
            }
            throw ApiFailure(400,"CONTACT_UNAVAILABLE","연락처 번호를 읽지 못했어요. 다시 선택해 주세요.")
        } catch(error: ApiFailure) {throw error}
        catch(_: SecurityException) {throw ApiFailure(403,"CONTACT_ACCESS_DENIED","선택한 연락처를 읽을 수 없어요. 차량의 연락처 공유 상태를 확인해 주세요.")}
        catch(_: Exception) {throw ApiFailure(400,"CONTACT_UNAVAILABLE","차량 연락처를 불러오지 못했어요. 휴대전화 연결 상태를 확인해 주세요.")}
    }
}
