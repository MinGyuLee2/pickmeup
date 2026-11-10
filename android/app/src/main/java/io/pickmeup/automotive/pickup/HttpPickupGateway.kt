package io.pickmeup.automotive.pickup

import io.pickmeup.automotive.BuildConfig
import io.pickmeup.automotive.navigation.GeoPoint
import io.pickmeup.automotive.map.PlannedRoute
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

class HttpPickupGateway(private val credentials: CredentialStore) : PickupGateway {
    private val base = BuildConfig.API_BASE_URL.trimEnd('/')
    @Volatile private var eventConnection: HttpURLConnection? = null
    private fun connection(path: String, authenticated: Boolean = true): HttpURLConnection {
        require(base.startsWith("https://") || (BuildConfig.DEBUG && base == "http://127.0.0.1:4310")) {
            "서버 연결 주소가 준비되지 않았습니다."
        }
        return (URL(base + path).openConnection() as HttpURLConnection).apply {
            connectTimeout=2_000;readTimeout=3_000;instanceFollowRedirects=false
            setRequestProperty("Accept","application/json")
            if(authenticated) {
                val saved=credentials.read() ?: throw ApiFailure(401,"VEHICLE_REQUIRED","바로 시작을 눌러 주세요.")
                setRequestProperty("Authorization","Bearer ${saved.token}")
            }
        }
    }
    private suspend fun request(path: String, method: String = "GET", body: JSONObject? = null,
        authenticated: Boolean = true, pairingSecret: String? = null): String = withContext(Dispatchers.IO) {
        val connection=connection(path,authenticated)
        try {
            connection.requestMethod=method
            if(pairingSecret!=null)connection.setRequestProperty("Authorization","Pairing $pairingSecret")
            val payload=body ?: if(method=="POST")JSONObject() else null
            if(payload!=null) {
                connection.doOutput=true;connection.setRequestProperty("Content-Type","application/json")
                connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status=connection.responseCode
            val stream=if(status in 200..299)connection.inputStream else connection.errorStream
            val raw=stream?.bufferedReader(Charsets.UTF_8)?.use { reader ->
                val value=StringBuilder();val buffer=CharArray(4096)
                while(true) { val count=reader.read(buffer);if(count<0)break;value.append(buffer,0,count);check(value.length<=131_072) }
                value.toString()
            } ?: "{}"
            currentCoroutineContext().ensureActive()
            if(status !in 200..299) {
                val error=runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
                if(BuildConfig.DEBUG)android.util.Log.w("PickMeUpApi","HTTP_FAILURE status=$status code=${error.optString("code")}")
                throw ApiFailure(status,error.optString("code","HTTP_ERROR"),error.optString("message","서버 연결을 확인해 주세요."))
            }
            raw
        } finally { connection.disconnect() }
    }
    override suspend fun startGuest(installationKey: String): DeviceCredentials {
        val json=JSONObject(request("/vehicles/guest","POST",JSONObject().put("installationKey",installationKey),authenticated=false))
        return DeviceCredentials(json.getString("vehicleId"),json.getString("deviceToken"),json.getBoolean("accountLinked"))
    }
    override suspend fun accountLinked()=JSONObject(request("/vehicle/profile")).getBoolean("accountLinked")
    override suspend fun cancelOnboarding(pairing: Pairing) {request("/onboarding/${pairing.id}","DELETE",authenticated=false,pairingSecret=pairing.deviceSecret)}
    override suspend fun startOnboarding(phone: String): Pairing {
        val json=JSONObject(request("/onboarding/start","POST",JSONObject().put("phone",phone),authenticated=credentials.read()!=null))
        return pairingMessage(json,Pairing(json.getString("id"),json.getString("deviceSecret"),json.optString("claimUrl"),System.currentTimeMillis()+json.getLong("expiresIn")*1000))
    }
    private fun pairingMessage(json: JSONObject,base: Pairing)=base.copy(claimUrl=json.optString("claimUrl",base.claimUrl),
        shareMessage=json.optString("shareMessage",base.shareMessage),resendsRemaining=json.optInt("resendsRemaining",0),
        resendAfter=json.optString("resendAfter").takeIf {it.isNotBlank()}?.let {Instant.parse(it).toEpochMilli()} ?: 0,
        resendExpiresAt=json.optString("resendExpiresAt").takeIf {it.isNotBlank()}?.let {Instant.parse(it).toEpochMilli()} ?: 0,verified=json.optBoolean("verified",false))
    override suspend fun onboardingMessage(pairing: Pairing)=pairingMessage(JSONObject(request("/onboarding/${pairing.id}/message",authenticated=false,pairingSecret=pairing.deviceSecret)),pairing)
    override suspend fun resendOnboarding(pairing: Pairing)=pairingMessage(JSONObject(request("/onboarding/${pairing.id}/resend","POST",JSONObject().put("confirmed",true),authenticated=false,pairingSecret=pairing.deviceSecret)),pairing)
    override suspend fun resendMessage(id: String)=requireNotNull(pickup(JSONObject(request("/pickups/$id/resend-message","POST",JSONObject().put("confirmed",true))).getJSONObject("pickup")))
    override suspend fun renewAccess(id: String,key: String)=requireNotNull(pickup(JSONObject(request("/pickups/$id/renew-access","POST",JSONObject().put("confirmed",true).put("idempotencyKey",key))).getJSONObject("pickup")))
    override suspend fun pairingStatus(pairing: Pairing): DeviceCredentials? {
        val json=JSONObject(request("/pairings/${pairing.id}",authenticated=false,pairingSecret=pairing.deviceSecret))
        return if(json.getString("state")=="PAIRED") DeviceCredentials(json.getString("vehicleId"),json.getString("deviceToken")) else null
    }
    override suspend fun contacts(): List<Contact> {
        val array=JSONArray(request("/vehicle/contacts"))
        return (0 until array.length()).map { index ->
            val row=array.getJSONObject(index);val aliases=row.getJSONArray("aliases")
            Contact(row.getString("id"),row.getString("name"),(0 until aliases.length()).map { aliases.getString(it) },meetingPlace(row))
        }
    }
    override suspend fun importContact(name: String, phone: String): Contact {
        val row=JSONObject(request("/vehicle/contacts/import","POST",JSONObject().put("name",name).put("phone",phone)))
        val aliases=row.getJSONArray("aliases")
        return Contact(row.getString("id"),row.getString("name"),(0 until aliases.length()).map { aliases.getString(it) },meetingPlace(row))
    }
    private fun meetingPlace(row: JSONObject): Destination? = row.optJSONObject("meetingPlace")?.let {
        Destination(GeoPoint(it.getDouble("latitude"),it.getDouble("longitude")),it.getString("name"))
    }
    override suspend fun saveMeetingPlace(contactId: String, place: Destination?) {
        if(place==null)request("/vehicle/contacts/$contactId/place","DELETE")
        else request("/vehicle/contacts/$contactId/place","PUT",JSONObject().put("destination",point(place.point).put("name",place.name)))
    }
    private fun pickup(json: JSONObject?): Pickup? {
        if(json==null || json.optString("state") !in setOf("ACTIVE","ARRIVED"))return null
        val place=json.getJSONObject("destination")
        val messages=json.optJSONArray("messages")
        fun messageAttribute(kind: String,key: String="status"): String? {
            if(messages==null)return null
            for(index in 0 until messages.length()) {
                val value=messages.getJSONObject(index);if(value.optString("kind")==kind)return value.optString(key)
            }
            return null
        }
        return Pickup(json.getString("id"),json.getString("state"),json.getString("readiness"),json.getString("recipientName"),
            Destination(GeoPoint(place.getDouble("latitude"),place.getDouble("longitude")),place.getString("name")),
            json.optJSONObject("observation")?.getInt("remainingSeconds"),json.getString("freshness"),
            json.getLong("sequence"),json.getLong("version"),Instant.parse(json.getString("expiresAt")).toEpochMilli(),
            messageAttribute("RESEND") ?: messageAttribute("START"),messageAttribute("NEAR"),messageAttribute("RESEND","includesNear")=="true" || messageAttribute("START","includesNear")=="true" || messageAttribute("NEAR","errorCode")=="MERGED_IN_START",
            (messageAttribute("RESEND","provider") ?: messageAttribute("START","provider")),recipientLocation(json.optJSONObject("recipientLocation")),json.optJSONObject("observation")?.optJSONObject("location")?.let(::safePoint),json.optBoolean("smsConfirmed",true),json.optInt("messageResendsRemaining",0),json.optString("messageResendAfter").takeIf {it.isNotBlank()}?.let {Instant.parse(it).toEpochMilli()} ?: 0,json.optJSONObject("vehicle")?.optString("modelKey")?.takeIf {it=="ioniq5"},plannedRoute(json.optJSONObject("plannedRoute")),json.optBoolean("shareCodeLocked",false),json.optInt("shareRenewalsRemaining",0),
            json.optString("shareRenewAfter").takeIf {it.isNotBlank()&&it!="null"}?.let {Instant.parse(it).toEpochMilli()} ?: 0,
            (messageAttribute("RESEND","createdAt") ?: messageAttribute("START","createdAt"))?.let {Instant.parse(it).toEpochMilli()} ?: 0,
            json.optJSONObject("waitingPoint")?.optJSONObject("location")?.let(::safePoint))
    }
    private fun plannedRoute(json: JSONObject?): PlannedRoute? {
        if(json?.optString("state")!="READY")return null
        val ttl=json.optLong("validForMs",0);val path=json.optJSONArray("path") ?: return null
        if(ttl !in 1..120_000)return null
        fun road(array: JSONArray): List<GeoPoint>? {
            if(array.length() !in 2..4000)return null
            val points=ArrayList<GeoPoint>(array.length())
            for(i in 0 until array.length()) {
                val p=array.optJSONArray(i) ?: return null;if(p.length()!=2)return null
                val lon=p.optDouble(0,Double.NaN);val lat=p.optDouble(1,Double.NaN)
                if(!lat.isFinite()||!lon.isFinite()||lat !in -90.0..90.0||lon !in -180.0..180.0)return null
                points.add(GeoPoint(lat,lon))
            }
            return points
        }
        val points=road(path) ?: return null
        val completed=ArrayList<List<GeoPoint>>();val paths=json.optJSONArray("traveledPaths")
        if(paths!=null) {
            if(paths.length()>32)return null
            var count=points.size
            for(i in 0 until paths.length()) {
                val p=road(paths.optJSONArray(i) ?: return null) ?: return null
                count+=p.size;if(count>4000)return null;completed.add(p)
            }
        }
        return PlannedRoute(points,ttl,android.os.SystemClock.elapsedRealtime(),completed)
    }
    private fun safePoint(json: JSONObject): GeoPoint? {
        val lat=json.optDouble("latitude",Double.NaN);val lon=json.optDouble("longitude",Double.NaN)
        return if(lat.isFinite()&&lon.isFinite()&&lat in -90.0..90.0&&lon in -180.0..180.0)GeoPoint(lat,lon) else null
    }
    private fun recipientLocation(json: JSONObject?): RecipientLocation? {
        if(json==null || json.optString("state")=="OFF")return null
        val state=json.optString("state").takeIf {it in setOf("WAITING","LIVE","PAUSED","STALE")} ?: return null
        val sample=json.optJSONObject("position");val point=sample?.optJSONObject("location")?.let(::safePoint)
        val accuracy=sample?.optDouble("accuracyMeters",Double.NaN)?.takeIf {it.isFinite()&&it in 0.0..100_000.0}
        return RecipientLocation(state,point,accuracy,json.optLong("ageMs",Long.MAX_VALUE).coerceAtLeast(0),android.os.SystemClock.elapsedRealtime())
    }
    override suspend fun current() = pickup(JSONObject(request("/pickups/current")).optJSONObject("pickup"))
    override suspend fun shareMessage(id: String): ShareMessage {
        val value=JSONObject(request("/pickups/$id/share-message"))
        return ShareMessage(value.getString("pickupId"),value.getString("recipientName"),value.getString("maskedPhone"),value.getString("message"))
    }
    override suspend fun confirmMessage(id: String): Pickup = pickup(JSONObject(request("/pickups/$id/confirm-message","POST",JSONObject().put("confirmed",true))).getJSONObject("pickup"))
        ?: throw ApiFailure(410,"SHARE_ENDED","공유가 종료되었습니다.")
    private fun point(value: GeoPoint) = JSONObject().put("latitude",value.latitude).put("longitude",value.longitude)
    private fun navigationBody(value: NavigationUpload) = JSONObject().apply {
        put("destination",point(value.destination.point).put("name",value.destination.name))
        put("observation",JSONObject().put("location",point(value.observation.location))
            .put("remainingSeconds",value.observation.remainingSeconds).put("remainingMeters",value.observation.remainingMeters)
            .put("locationAgeMs",value.observation.locationAgeMs).put("etaAgeMs",value.observation.etaAgeMs))
        put("arrived",value.arrived)
    }
    override suspend fun start(alias: String, key: String, navigation: NavigationUpload, contactId: String?): Pickup {
        val body=navigationBody(navigation).put("idempotencyKey",key)
        if(contactId==null)body.put("recipientAlias",alias) else body.put("contactId",contactId)
        val response=JSONObject(request("/pickups","POST",body))
        return pickup(response.optJSONObject("pickup")) ?: throw ApiFailure(410,"SHARE_ENDED","픽업이 이미 종료되었습니다.")
    }
    override suspend fun upload(id: String, sequence: Long, navigation: NavigationUpload): UploadResult {
        val response=JSONObject(request("/pickups/$id/observation","PUT",navigationBody(navigation).put("sequence",sequence)))
        return UploadResult(response.getBoolean("accepted"),pickup(response.optJSONObject("pickup")),response.optString("reason").takeIf { it.isNotEmpty() })
    }
    override suspend fun end(id: String, reason: String) { request("/pickups/$id/end","POST",JSONObject().put("reason",reason)) }
    override suspend fun cancelStart(key: String) {request("/pickups/cancel-start","POST",JSONObject().put("idempotencyKey",key))}
    override suspend fun events(onSnapshot: suspend (Pickup?) -> Unit, onConnected: suspend () -> Unit) = withContext(Dispatchers.IO) {
        val connection=connection("/vehicles/me/events");eventConnection=connection
        try {
            connection.readTimeout=20_000;connection.setRequestProperty("Accept","text/event-stream")
            if(connection.responseCode!=200)throw ApiFailure(connection.responseCode,"STREAM_FAILED","실시간 연결을 확인하고 있습니다.")
            onConnected()
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                var event="";val data=StringBuilder()
                while(true) {
                    val line=reader.readLine() ?: break;currentCoroutineContext().ensureActive()
                    check(line.length<=131_072)
                    when {
                        line.startsWith("event:") -> event=line.substringAfter(':').trim()
                        line.startsWith("data:") -> {data.append(line.substringAfter(':').trim());check(data.length<=131_072)}
                        line.isEmpty() -> {
                            if(event=="pickup" && data.isNotEmpty())onSnapshot(pickup(JSONObject(data.toString()).optJSONObject("pickup")))
                            else if(event=="ended")throw ApiFailure(401,"VEHICLE_REQUIRED","차량 연결을 다시 확인해 주세요.")
                            event="";data.clear()
                        }
                    }
                }
            }
        } finally { if(eventConnection===connection)eventConnection=null;connection.disconnect() }
    }
    override fun closeEvents() { eventConnection?.disconnect();eventConnection=null }
}
