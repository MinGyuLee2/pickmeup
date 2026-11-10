package io.pickmeup.automotive.pickup

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import io.pickmeup.automotive.BuildConfig
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Device credentials and unfinished operations stay encrypted and bound to this server. */
class KeystoreCredentials(context: Context) : CredentialStore {
    private val preferences = context.getSharedPreferences("pickmeup-device", Context.MODE_PRIVATE)
    private val alias = "pickmeup-device-v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun readRecord(): JSONObject = runCatching {
        val encoded = preferences.getString("record", null) ?: return JSONObject()
        val data = Base64.decode(encoded, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data.copyOfRange(0,12)))
        val value = JSONObject(String(cipher.doFinal(data.copyOfRange(12,data.size)), Charsets.UTF_8))
        if (value.optString("server") == BuildConfig.API_BASE_URL) value else JSONObject()
    }.getOrElse { JSONObject() }
    private fun writeRecord(record: JSONObject) {
        record.put("server", BuildConfig.API_BASE_URL)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE,key()) }
        val encrypted = cipher.iv + cipher.doFinal(record.toString().toByteArray(Charsets.UTF_8))
        check(preferences.edit().putString("record",Base64.encodeToString(encrypted,Base64.NO_WRAP)).commit()) {
            "차량 연결 정보를 저장할 수 없습니다."
        }
    }
    override fun guestInstallationKey(): String?=readRecord().optString("guestInstallationKey").takeIf {it.isNotBlank()}
    override fun saveGuestInstallationKey(value: String){writeRecord(readRecord().put("guestInstallationKey",value))}
    override fun pendingPairing(): Pairing?=runCatching {readRecord().optJSONObject("pairing")?.let {
        Pairing(it.getString("id"),it.getString("secret"),it.optString("url"),it.getLong("expires"),it.optString("message"),it.optInt("remaining"),it.optLong("after"),it.optLong("codeExpires"),it.optBoolean("verified"))
    }}.getOrNull()
    override fun savePendingPairing(value: Pairing?) {
        val record=readRecord()
        if(value==null) {if(!record.has("pairing"))return;record.remove("pairing")}
        else record.put("pairing",JSONObject().put("id",value.id).put("secret",value.deviceSecret).put("url",value.claimUrl).put("expires",value.expiresAt)
            .put("message",value.shareMessage).put("remaining",value.resendsRemaining).put("after",value.resendAfter).put("codeExpires",value.resendExpiresAt).put("verified",value.verified))
        writeRecord(record)
    }
    override fun read(): DeviceCredentials? = readRecord().let {
        val token = it.optString("token"); val id = it.optString("vehicleId")
        if (token.isBlank() || id.isBlank()) null else DeviceCredentials(id,token,it.optBoolean("accountLinked",true))
    }
    override fun save(credentials: DeviceCredentials) {
        val record=readRecord()
        if(record.optString("vehicleId")!=credentials.vehicleId)record.remove("recentPickups")
        record.remove("pairing")
        writeRecord(record.put("vehicleId",credentials.vehicleId).put("token",credentials.token).put("accountLinked",credentials.accountLinked))
    }
    override fun recentPickups(): List<RecentPickup> = runCatching {
        val values=readRecord().optJSONArray("recentPickups") ?: return emptyList()
        (0 until minOf(values.length(),6)).map {index ->
            val row=values.getJSONObject(index)
            RecentPickup(row.getString("contactId"),row.getString("recipientName"),Destination(
                io.pickmeup.automotive.navigation.GeoPoint(row.getDouble("latitude"),row.getDouble("longitude")),row.getString("name")))
        }
    }.getOrDefault(emptyList())
    override fun saveRecentPickups(value: List<RecentPickup>) {
        val rows=org.json.JSONArray()
        value.take(6).forEach { rows.put(JSONObject().put("contactId",it.contactId).put("recipientName",it.recipientName)
            .put("latitude",it.destination.point.latitude).put("longitude",it.destination.point.longitude).put("name",it.destination.name)) }
        writeRecord(readRecord().put("recentPickups",rows))
    }
    override fun pendingEnd(): PendingEnd? = readRecord().optJSONObject("pendingEnd")?.let {
        PendingEnd(it.optString("id").takeIf {value->value.isNotEmpty()},it.getString("reason"),it.optString("startKey").takeIf {value->value.isNotEmpty()})
    }
    override fun savePendingEnd(value: PendingEnd?) {
        val record=readRecord()
        if(value==null)record.remove("pendingEnd") else record.put("pendingEnd",JSONObject().put("id",value.pickupId).put("reason",value.reason).put("startKey",value.startKey))
        writeRecord(record)
    }
    override fun pendingStart(): String? = readRecord().optString("pendingStart").takeIf { it.isNotEmpty() }
    override fun savePendingStart(key: String?) {
        val record=readRecord();if(key==null)record.remove("pendingStart") else record.put("pendingStart",key);writeRecord(record)
    }
}
