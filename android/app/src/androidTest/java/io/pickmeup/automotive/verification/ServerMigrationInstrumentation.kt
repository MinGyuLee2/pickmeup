package io.pickmeup.automotive.verification

import android.app.Instrumentation
import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** Separate, release-signed test APK. Never packaged in the application APK. */
class ServerMigrationInstrumentation : Instrumentation() {
    private var arguments=Bundle()
    override fun onCreate(value: Bundle?) { super.onCreate(value);arguments=value?:Bundle();start() }
    override fun onStart() {
        val result=Bundle()
        try {
            check(arguments.getString("qaPermit")=="new-empty-pickmeup-avd")
            val phase=arguments.getString("phase")?:"storage"
            if(phase=="legacy-seed")legacySeed(result)
            else Class.forName("io.pickmeup.automotive.verification.NewReleaseChecks")
                .getMethod("run",Context::class.java,String::class.java,Bundle::class.java)
                .invoke(null,targetContext,phase,result)
            result.putString("result","PASS");finish(Activity.RESULT_OK,result)
        } catch(error: Throwable) {
            // Fixture credentials and server responses must never appear in test output.
            val cause=if(error is java.lang.reflect.InvocationTargetException)error.targetException else error
            result.putString("result","FAIL");result.putString("failureType",cause.javaClass.simpleName)
            result.putString("failureAt",cause.stackTrace.firstOrNull {it.className.startsWith("io.pickmeup.automotive.verification")}?.toString())
            finish(Activity.RESULT_CANCELED,result)
        }
    }
    private fun legacySeed(result: Bundle) {
        val prefs=targetContext.getSharedPreferences("pickmeup-device",Context.MODE_PRIVATE)
        check(!prefs.contains("record")) { "This test requires a new empty device" }
        val install=(UUID.randomUUID().toString()+UUID.randomUUID()).replace("-","")
        fun request(path: String,body: JSONObject,token: String?=null,method: String="POST"): JSONObject {
            val c=URL("https://pickmeup.calkok.uk/api$path").openConnection() as HttpURLConnection
            try {
                c.connectTimeout=10000;c.readTimeout=10000;c.instanceFollowRedirects=false;c.requestMethod=method
                c.setRequestProperty("Content-Type","application/json");if(token!=null)c.setRequestProperty("Authorization","Bearer $token")
                c.doOutput=true;c.outputStream.use {it.write(body.toString().toByteArray())}
                check(c.responseCode in 200..299)
                return JSONObject(c.inputStream.bufferedReader().use {it.readText()})
            } finally {c.disconnect()}
        }
        val car=request("/vehicles/guest",JSONObject().put("installationKey",install))
        val token=car.getString("deviceToken")
        val contact=request("/vehicle/contacts/import",JSONObject().put("name","배포검증 상대").put("phone","01000000000"),token)
        val place=JSONObject().put("latitude",37.3947).put("longitude",127.1111).put("name","판교역")
        request("/vehicle/contacts/${contact.getString("id")}/place",JSONObject().put("destination",place),token,"PUT")
        val recent=JSONObject(place.toString()).put("contactId",contact.getString("id")).put("recipientName","배포검증 상대")
        val record=JSONObject().put("server","https://enforced-spookily-unweave.ngrok-free.dev/api")
            .put("vehicleId",car.getString("vehicleId")).put("token",token).put("accountLinked",false)
            .put("guestInstallationKey",install).put("recentPickups",JSONArray().put(recent))
        val ks=KeyStore.getInstance("AndroidKeyStore").apply {load(null)}
        val key=(ks.getKey("pickmeup-device-v1",null) as? SecretKey)?:KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("pickmeup-device-v1",KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply {init(Cipher.ENCRYPT_MODE,key)}
        val encrypted=Base64.encodeToString(cipher.iv+cipher.doFinal(record.toString().toByteArray()),Base64.NO_WRAP)
        check(prefs.edit().putString("record",encrypted).commit())
        check(targetContext.getSharedPreferences("pickmeup-deploy-verification",Context.MODE_PRIVATE).edit()
            .putString("vehicleId",car.getString("vehicleId")).putString("contactId",contact.getString("id"))
            .putString("tokenDigest",digest(token)).putString("legacyCiphertext",encrypted).commit())
        result.putString("testVehicleId",car.getString("vehicleId"));result.putBoolean("legacyRecordSeeded",true)
    }
    private fun digest(value: String)=MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") {"%02x".format(it)}
}
