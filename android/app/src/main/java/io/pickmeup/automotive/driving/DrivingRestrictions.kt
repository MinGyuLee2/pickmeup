package io.pickmeup.automotive.driving

import android.car.Car
import android.car.drivingstate.CarUxRestrictions
import android.car.drivingstate.CarUxRestrictionsManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

class DrivingRestrictions(private val context: Context) {
    private val mutable = MutableStateFlow(DrivingPolicy())
    val state = mutable.asStateFlow()
    private var car: Car? = null
    private var manager: CarUxRestrictionsManager? = null
    private var started = false
    private var generation = 0

    fun start() {
        if (started) return
        started = true
        val connectionGeneration = ++generation
        mutable.value = DrivingPolicy()
        try {
            car = Car.createCar(context, Handler(Looper.getMainLooper()), Car.CAR_WAIT_TIMEOUT_DO_NOT_WAIT) { connected, ready ->
                if (!started || connectionGeneration != generation) return@createCar
                manager?.let { runCatching { it.unregisterListener() } }
                manager = null
                mutable.value = DrivingPolicy()
                if (ready) runCatching {
                    val ux = connected.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE) as CarUxRestrictionsManager
                    manager = ux
                    ux.registerListener(::update)
                    update(ux.currentCarUxRestrictions)
                }.onFailure { Log.w("PickMeUpDriving", "UX restrictions unavailable") }
            }
        } catch (_: Exception) {
            Log.w("PickMeUpDriving", "Car service unavailable")
        }
    }

    private fun update(ux: CarUxRestrictions) {
        mutable.value = DrivingPolicy(true, ux.isRequiresDistractionOptimization,
            ux.activeRestrictions, ux.maxRestrictedStringLength)
        Log.i("PickMeUpDriving", "known=true restricted=${mutable.value.restricted} flags=${ux.activeRestrictions}")
    }

    fun close() {
        started = false
        generation++
        manager?.let { runCatching { it.unregisterListener() } }
        manager = null
        car?.let { runCatching { it.disconnect() } }
        car = null
        mutable.value = DrivingPolicy()
    }
}
