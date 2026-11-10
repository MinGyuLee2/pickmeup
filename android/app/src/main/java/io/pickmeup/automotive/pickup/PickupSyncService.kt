package io.pickmeup.automotive.pickup

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import io.pickmeup.automotive.MainActivity
import io.pickmeup.automotive.PickMeUpApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Keeps the user's active, expiring pickup sync alive alongside native navigation. */
class PickupSyncService : Service() {
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private val app get()=application as PickMeUpApplication
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL,"픽업 공유",NotificationManager.IMPORTANCE_LOW))
        val notification=notification("픽업 공유 상태를 확인하고 있어요.")
        if(Build.VERSION.SDK_INT>=29)startForeground(ID,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(ID,notification)
        app.navigation.start();app.coordinator.onServiceStarted()
        scope.launch {
            app.coordinator.state.collect { state ->
                val detail=if(state.pendingEnd)"공유 종료 요청을 확인하고 있어요." else state.pickup?.let {
                    val readiness=when(it.readiness){"OUTSIDE"->"나왔어요";"PREPARING"->"준비 중";else->"응답 대기"}
                    "${it.recipientName} · $readiness"
                } ?: state.message
                getSystemService(NotificationManager::class.java).notify(ID,notification(detail))
            }
        }
        Log.i("PickMeUpSync","SYNC_SERVICE_STARTED")
    }
    private fun notification(detail: String): Notification {
        val open=PendingIntent.getActivity(this,0,Intent(this,MainActivity::class.java),PendingIntent.FLAG_IMMUTABLE)
        val end=PendingIntent.getService(this,1,Intent(this,javaClass).setAction(END),PendingIntent.FLAG_IMMUTABLE)
        val publicVersion=Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("픽미업 · 픽업 공유 중").build()
        return Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("픽미업 · 픽업 공유").setContentText(detail).setOngoing(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion).setContentIntent(open)
            .addAction(Notification.Action.Builder(null,"공유 종료",end).build()).build()
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if(intent?.action==END)app.appScope.launch { runCatching {app.coordinator.endShare()}.onFailure(app.coordinator::showError) }
        return START_STICKY
    }
    override fun onBind(intent: Intent?): IBinder?=null
    override fun onDestroy() {
        scope.cancel();app.coordinator.onServiceStopped();stopForeground(STOP_FOREGROUND_REMOVE)
        Log.i("PickMeUpSync","SYNC_SERVICE_STOPPED");super.onDestroy()
    }
    companion object {
        private const val CHANNEL="pickmeup-sharing"
        private const val ID=1702
        const val END="io.pickmeup.END_SHARE"
    }
}
