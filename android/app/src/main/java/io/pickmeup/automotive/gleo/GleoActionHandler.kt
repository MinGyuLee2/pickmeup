package io.pickmeup.automotive.gleo

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import io.pickmeup.automotive.PickMeUpApplication
import io.pickmeup.automotive.BuildConfig
import io.pickmeup.automotive.pickup.ApiFailure
import io.pickmeup.automotive.pickup.Pickup
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

object GleoActionHandler {
    private val actions=setOf("START_PICKUP_SHARE","GET_PICKUP_STATUS","STOP_PICKUP_SHARE")
    fun canonicalAction(action: String?): String? {
        val name=action?.removePrefix("${BuildConfig.APPLICATION_ID}.")
        return name?.takeIf { it in actions }
    }
    fun supports(action: String?)=canonicalAction(action)!=null
    fun dispatch(context: Context,intent: Intent,pending: BroadcastReceiver.PendingResult,callbackPackage: String,debug: Boolean=false) {
        dispatch(context,intent,callbackPackage,debug,onComplete=pending::finish)
    }
    fun dispatch(context: Context,intent: Intent,callbackPackage: String,debug: Boolean=false,holdForWork: Boolean=false,onComplete: () -> Unit) {
        val app=context.applicationContext as PickMeUpApplication
        val action=canonicalAction(intent.action) ?: return onComplete()
        // Deadline expiry does not cancel an Application-owned operation that may have committed.
        val work=app.appScope.async {
            when(action) {
                "START_PICKUP_SHARE" -> {
                    val parameters=intent.getStringExtra("ACTION_PARAM")?.let { raw ->
                        when(val parsed=JSONTokener(raw).nextValue()) {
                            is JSONObject->parsed
                            is String->JSONObject(parsed)
                            else->throw ApiFailure(400,"RECIPIENT_REQUIRED","recipient required")
                        }
                    }
                    val alias=parameters?.optString("recipientAlias") ?: intent.getStringExtra("recipientAlias") ?: ""
                    if(alias.isBlank() || alias.length>30 || alias.any { it.isISOControl() })
                        throw ApiFailure(400,"RECIPIENT_REQUIRED","recipient required")
                    val pickup=app.startVoicePickup(alias)
                    if(!pickup.smsConfirmed) {
                        if(context is android.app.Activity)context.startActivity(Intent(context,io.pickmeup.automotive.MainActivity::class.java))
                        return@async callback(action,"asking","Navigation and the pickup link are ready. No text has been sent. Confirm the recipient and choose Send in PickMeUp while parked, or share the link manually.",statusData(pickup).put("messageConfirmationRequired",true))
                    }
                    val message=if(pickup.simulatedDelivery) "The pickup share is active in development simulation. No real text message will be sent."
                    else when(pickup.messageStatus) {
                        "SIMULATED"->"The pickup share is active. Text delivery is simulated and no real text was sent."
                        "DELIVERED"->"The pickup share is active and the provider confirmed text delivery."
                        "FAILED"->"The pickup share is active, but text delivery failed."
                        "UNKNOWN"->"The pickup share is active. The text request result is unconfirmed."
                        else->"The share was started and a text message job was queued. Delivery is not yet confirmed."
                    }
                    callback(action,"success",message,statusData(pickup))
                }
                "GET_PICKUP_STATUS" -> {
                    if(app.coordinator.state.value.preparingRoute)return@async callback(action,"success",
                        "Navigation to the saved meeting place and the arrival notification are still being prepared. Text delivery is not confirmed.",
                        JSONObject().put("active",false).put("preparingRoute",true).put("operation","PREPARING_ROUTE"))
                    val pickup=app.coordinator.currentStatus()
                    val message=when {
                        app.coordinator.state.value.pendingEnd->"The request to end sharing is waiting for confirmation."
                        pickup==null->"There is no active pickup share."
                        !pickup.smsConfirmed->"The pickup link is ready, but no text has been sent. Confirm the recipient and choose Send in PickMeUp while parked, or share the link manually."
                        pickup.readiness=="OUTSIDE"->"${pickup.recipientName} says they are outside."
                        pickup.readiness=="PREPARING"->"${pickup.recipientName} is getting ready."
                        pickup.state=="ARRIVED"->"The vehicle is near the pickup point. Boarding has not been confirmed."
                        else->"The pickup is active and the recipient has not responded yet."
                    }
                    callback(action,"success",message,statusData(pickup).put("pendingEnd",app.coordinator.state.value.pendingEnd))
                }
                "STOP_PICKUP_SHARE" -> {
                    val preparing=app.coordinator.state.value.preparingRoute
                    app.coordinator.endShare()
                    val waiting=app.coordinator.state.value.pendingEnd
                    callback(action,"success",if(preparing)"Arrival notification preparation was cancelled. Navigation may continue; it can be stopped in the navigation app."
                        else if(waiting)"The end request is saved but not confirmed. Open PickMeUp while parked if automatic retry is unavailable." else "Pickup sharing has ended.",JSONObject().put("pendingEnd",waiting))
                }
                else->throw ApiFailure(400,"UNKNOWN_ACTION","unsupported action")
            }
        }
        app.appScope.launch {
            try {
                val response=try {withTimeout(5_500) {work.await()}}
                catch(error: TimeoutCancellationException) {
                    val preparing=app.coordinator.state.value.preparingRoute
                    callback(action,"success",if(preparing)"Navigation to the saved meeting place and the arrival notification are being prepared. Text delivery is not confirmed."
                        else "The request is still being checked. Its result has not been confirmed yet.",JSONObject().put("operation",if(preparing)"PREPARING_ROUTE" else "PENDING").put("preparingRoute",preparing))
                }
                send(context,callbackPackage,response,debug)
            } catch(error: Throwable) {
                app.coordinator.showError(error)
                val problem=error as? ApiFailure
                val asking=problem?.code in setOf("AMBIGUOUS_RECIPIENT","RECIPIENT_REQUIRED","CONTACT_NOT_FOUND","NAVIGATION_STALE","NAVIGATION_UNAVAILABLE","PLACE_REQUIRED","VEHICLE_REQUIRED","BACKGROUND_START_RESTRICTED")
                val message=when(problem?.code) {
                    "AMBIGUOUS_RECIPIENT"->"More than one saved recipient matches. Select a recipient in PickMeUp."
                    "RECIPIENT_REQUIRED","CONTACT_NOT_FOUND"->"Please specify a saved recipient."
                    "NAVIGATION_STALE","PLACE_REQUIRED"->"There is no saved meeting place with current navigation data. Save a meeting place while parked, or set a navigation destination and try again."
                    "NAVIGATION_UNAVAILABLE"->"The navigation connection is unavailable. Please try again after it reconnects."
                    "ROUTE_FAILED","ROUTE_TIMEOUT","ROUTE_MISMATCH"->"Navigation to the saved meeting place was not confirmed. No new arrival notification was requested. Check the destination in the navigation app."
                    "ROUTE_CANCELLED"->"Arrival notification preparation was cancelled. Navigation may continue."
                    "VEHICLE_REQUIRED"->"Please pair the vehicle with PickMeUp while parked."
                    "BACKGROUND_START_RESTRICTED"->"The vehicle system did not allow background sharing to start. Open PickMeUp while parked and start sharing there. No new share was created."
                    "PICKUP_ALREADY_ACTIVE","PICKUP_IN_PROGRESS"->"A pickup is already active or awaiting confirmation. End it before starting another."
                    else->"The request could not be confirmed. Open PickMeUp while parked to check its status."
                }
                send(context,callbackPackage,callback(action,if(asking)"asking" else "fail",message,JSONObject().put("code",problem?.code ?: "UNAVAILABLE")),debug)
            } finally {
                // Only the Activity may outlive the response deadline. Broadcast results stay bounded.
                if(holdForWork)work.join()
                onComplete()
            }
        }
    }
    private fun statusData(pickup: Pickup?)=JSONObject().apply {
        put("active",pickup!=null)
        if(pickup!=null) {
            put("recipientName",pickup.recipientName);put("readiness",pickup.readiness);put("freshness",pickup.freshness)
            put("pickupState",pickup.state)
            put("messageConfirmationRequired",!pickup.smsConfirmed)
            put("messageStatus",pickup.messageStatus);put("nearMessageStatus",pickup.nearMessageStatus)
            put("simulatedDelivery",pickup.simulatedDelivery)
            put("nearMessageIncluded",pickup.nearMessageIncluded)
            put("remainingSeconds",if(pickup.freshness=="FRESH")pickup.remainingSeconds else JSONObject.NULL)
        }
    }
    private fun callback(action: String,status: String,message: String,data: JSONObject)=JSONObject()
        .put("functionName",action).put("status",status).put("message",message).put("data",JSONArray().put(data).toString())
    private fun send(context: Context,target: String,response: JSONObject,debug: Boolean) {
        context.sendBroadcast(Intent("ai.pleos.playground.intent.action.APP_ACTION_RESPONSE").setPackage(target)
            .putExtra("packageName",context.packageName).putExtra("response",response.toString()))
        if(debug) {
            val data=JSONArray(response.getString("data")).getJSONObject(0)
            Log.i("PickMeUpGleo","GLEO_TEST_CALLBACK action=${response.getString("functionName")} status=${response.getString("status")} active=${data.opt("active")} readiness=${data.opt("readiness")} pendingEnd=${data.opt("pendingEnd")} code=${data.opt("code")}")
        }
    }
}
