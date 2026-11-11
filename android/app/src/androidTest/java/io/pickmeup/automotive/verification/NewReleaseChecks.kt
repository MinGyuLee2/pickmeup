package io.pickmeup.automotive.verification

import android.content.Context
import android.os.Bundle
import io.pickmeup.automotive.BuildConfig
import io.pickmeup.automotive.navigation.GeoPoint
import io.pickmeup.automotive.pickup.*
import kotlinx.coroutines.*
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import android.util.Base64
import org.json.JSONObject
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class NewReleaseChecks {
    companion object {
        @JvmStatic fun run(context: Context,phase: String,result: Bundle) {
            check(BuildConfig.API_BASE_URL==CredentialServerPolicy.PRODUCTION && !BuildConfig.FILMING_MODE)
            if(phase=="storage") { storage(context,result);return }
            val credentials=KeystoreCredentials(context)
            if(phase=="existing-profile") {
                val before=requireNotNull(credentials.read())
                val history=credentials.recentPickups();val pairing=credentials.pendingPairing()
                val start=credentials.pendingStart();val end=credentials.pendingEnd();val guest=credentials.guestInstallationKey()
                val prefs=context.getSharedPreferences("pickmeup-device",Context.MODE_PRIVATE)
                val encrypted=prefs.getString("record",null)
                val previous=prefs.getString("previous-server-record",null)
                runBlocking {HttpPickupGateway(credentials).accountLinked()}
                check(credentials.read()==before && credentials.recentPickups()==history && credentials.pendingPairing()==pairing)
                check(credentials.pendingStart()==start && credentials.pendingEnd()==end && credentials.guestInstallationKey()==guest)
                if(previous==null)check(prefs.getString("previous-server-record",null)==encrypted)
                else check(prefs.getString("previous-server-record",null)==previous && prefs.getString("record",null)==encrypted)
                result.putBoolean("existingVehicleAuthenticatedOnCloud",true)
                result.putBoolean("existingRecordAndHistoryPreserved",true)
                return
            }
            val fixture=context.getSharedPreferences("pickmeup-deploy-verification",Context.MODE_PRIVATE)
            val saved=requireNotNull(credentials.read())
            check(saved.vehicleId==fixture.getString("vehicleId",null))
            val digest=MessageDigest.getInstance("SHA-256").digest(saved.token.toByteArray()).joinToString("") {"%02x".format(it)}
            check(digest==fixture.getString("tokenDigest",null))
            val gateway=HttpPickupGateway(credentials)
            runBlocking {
                check(!gateway.accountLinked())
                check(credentials.read()==saved)
                // The old app may normally re-encrypt an unchanged record while resuming.
                // Verify the retained record's identity/data rather than a particular GCM IV.
                val previous=requireNotNull(context.getSharedPreferences("pickmeup-device",Context.MODE_PRIVATE).getString("previous-server-record",null))
                val data=Base64.decode(previous,Base64.NO_WRAP)
                val key=KeyStore.getInstance("AndroidKeyStore").apply {load(null)}.getKey("pickmeup-device-v1",null) as SecretKey
                val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply {init(Cipher.DECRYPT_MODE,key,GCMParameterSpec(128,data.copyOfRange(0,12)))}
                val original=JSONObject(String(cipher.doFinal(data.copyOfRange(12,data.size)),Charsets.UTF_8))
                check(original.getString("server")==CredentialServerPolicy.PREVIOUS_RELEASE)
                check(original.getString("vehicleId")==saved.vehicleId && original.getString("token")==saved.token)
                check(original.getJSONArray("recentPickups").getJSONObject(0).getString("contactId")==fixture.getString("contactId",null))
                val person=gateway.contacts().single {it.id==fixture.getString("contactId",null)}
                check(person.name=="배포검증 상대" && person.meetingPlace?.name=="판교역")
                check(credentials.recentPickups().single().contactId==person.id)
                when(phase) {
                    "profile" -> result.putBoolean("sameVehicleTokenHistory",true)
                    "start" -> {
                        val existing=gateway.current()
                        val place=requireNotNull(person.meetingPlace)
                        val start=existing?:gateway.start("",UUID.randomUUID().toString(),NavigationUpload(place,Observation(GeoPoint(37.399,127.106),720,1700,0,0),false,0),person.id)
                        result.putString("startSource",if(existing==null)"synthetic-navigation-upload" else "existing-ui-pickup")
                        check(!start.smsConfirmed && start.state=="ACTIVE")
                        val message=gateway.shareMessage(start.id).message
                        check(message.contains("https://pickmeup.calkok.uk/s#token="))
                        result.putString("fixtureMessageBase64",Base64.encodeToString(message.toByteArray(Charsets.UTF_8),Base64.NO_WRAP))
                        check(fixture.edit().putString("pickupId",start.id).commit())
                        val connected=CompletableDeferred<Unit>();val snapshot=CompletableDeferred<Unit>()
                        val stream=launch(Dispatchers.IO) {try{gateway.events({if(it?.id==start.id)snapshot.complete(Unit)},{connected.complete(Unit)})}catch(error:Exception){if(isActive)throw error}}
                        try {withTimeout(12000){connected.await();snapshot.await()};result.putBoolean("sseSnapshot",true)}
                        finally {stream.cancel();gateway.closeEvents();stream.join()}
                        result.putBoolean("pickupStartedWithoutSms",true)
                    }
                    "readiness" -> {
                        val current=requireNotNull(gateway.current());check(current.id==fixture.getString("pickupId",null))
                        check(current.readiness=="OUTSIDE" && current.waitingPoint!=null)
                        result.putBoolean("recipientReplyAndWaitingPin",true)
                    }
                    "end" -> {
                        val id=requireNotNull(fixture.getString("pickupId",null));gateway.end(id,"DRIVER_ENDED")
                        check(gateway.current()==null);result.putBoolean("pickupEnded",true)
                    }
                    else -> error("Unsupported verification phase")
                }
            }
        }
        private fun storage(context: Context,result: Bundle) {
            val name="pickmeup-migration-storage-test";val alias=name+"-key"
            val prefs=context.getSharedPreferences(name,Context.MODE_PRIVATE)
            check(!prefs.contains("record"))
            try {
                val old=KeystoreCredentials(context,name,alias,CredentialServerPolicy.PREVIOUS_RELEASE,false)
                val device=DeviceCredentials("storage-test-vehicle","not-a-real-token",true)
                val place=Destination(GeoPoint(37.3947,127.1111),"판교역")
                val history=listOf(RecentPickup("storage-test-contact","가상 상대",place))
                val pairing=Pairing("storage-test-pairing","not-a-real-secret","https://example.invalid",System.currentTimeMillis()+60000)
                val ending=PendingEnd("storage-test-pickup","DRIVER_ENDED","storage-test-start")
                old.saveGuestInstallationKey("a".repeat(64));old.save(device);old.saveRecentPickups(history)
                old.savePendingPairing(pairing);old.savePendingStart("storage-test-start");old.savePendingEnd(ending)
                val encrypted=prefs.getString("record",null)
                val next=KeystoreCredentials(context,name,alias,CredentialServerPolicy.PRODUCTION,false)
                check(next.read()==device && next.recentPickups()==history && next.pendingPairing()==pairing)
                check(prefs.getString("record",null)==encrypted)
                check(runCatching {next.confirmServerIdentity("wrong-vehicle")}.isFailure)
                check(prefs.getString("record",null)==encrypted)
                next.savePendingStart("storage-test-retry");check(old.pendingStart()=="storage-test-retry")
                val before=prefs.getString("record",null);next.confirmServerIdentity(device.vehicleId)
                check(prefs.getString("previous-server-record",null)==before)
                val reopened=KeystoreCredentials(context,name,alias,CredentialServerPolicy.PRODUCTION,false)
                check(reopened.read()==device && reopened.recentPickups()==history && reopened.pendingEnd()==ending)
                check(reopened.pendingPairing()==pairing && reopened.pendingStart()=="storage-test-retry" && reopened.guestInstallationKey()=="a".repeat(64))
                check(old.read()==null)
                check(KeystoreCredentials(context,name,alias,"https://unrelated.example/api",true).read()==null)
                result.putBoolean("encryptedMigrationPreservesAllFields",true)
                result.putBoolean("identityMismatchLeavesOriginalUntouched",true)
                result.putBoolean("unapprovedEndpointRejected",true)
            } finally {
                prefs.edit().clear().commit()
                KeyStore.getInstance("AndroidKeyStore").apply {load(null);deleteEntry(alias)}
            }
        }
    }
}
