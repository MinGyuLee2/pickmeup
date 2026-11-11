package io.pickmeup.automotive.filming

import io.pickmeup.automotive.navigation.GeoPoint
import kotlin.math.*

/** Monotonic, distance-based playback. Wall-clock changes never move or restart a take. */
class RoutePlayback(val points: List<GeoPoint>,val durationSeconds: Int,private val clock: ()->Long) {
    private val lengths=points.zipWithNext().map {(a,b)->distance(a,b)}
    val totalMeters=lengths.sum()
    private var offset=0.0
    private var anchor=clock()
    var playing=false;private set
    var speed=6.0;private set
    init {
        require(points.size in 2..4000 && durationSeconds in 30..7200)
        require(totalMeters.isFinite() && totalMeters>1 && lengths.all {it.isFinite() && it<=2000})
    }
    data class Frame(val location: GeoPoint,val remainingSeconds:Int,val remainingMeters:Int,val progress:Double,val arrived:Boolean)
    private fun seconds()=(offset+if(playing)(clock()-anchor).coerceAtLeast(0)/1000.0*speed else 0.0).coerceIn(0.0,durationSeconds.toDouble())
    private fun freeze(){offset=seconds();anchor=clock()}
    fun play(){freeze();if(offset<durationSeconds)playing=true}
    fun pause(){freeze();playing=false}
    fun setSpeed(value:Double){require(value.isFinite() && value in .5..20.0);freeze();speed=value}
    fun seek(value:Double){require(value.isFinite() && value in 0.0..durationSeconds.toDouble());offset=value;anchor=clock();if(value==durationSeconds.toDouble())playing=false}
    fun reset(){pause();seek(0.0)}
    fun frame():Frame {
        val elapsed=seconds();val fraction=elapsed/durationSeconds;var target=totalMeters*fraction
        var p=points.last()
        for(i in lengths.indices){val len=lengths[i];if(target<=len && len>0){val t=target/len;val a=points[i];val b=points[i+1];p=GeoPoint(a.latitude+(b.latitude-a.latitude)*t,a.longitude+(b.longitude-a.longitude)*t);break};target-=len}
        val arrived=elapsed>=durationSeconds
        if(arrived){offset=durationSeconds.toDouble();playing=false;anchor=clock()}
        return Frame(p,ceil(durationSeconds-elapsed).toInt(),ceil(totalMeters*(1-fraction)).toInt(),fraction,arrived)
    }
    companion object {
        private fun distance(a:GeoPoint,b:GeoPoint):Double {
            val x=Math.toRadians(b.longitude-a.longitude)*cos(Math.toRadians((a.latitude+b.latitude)/2))
            val y=Math.toRadians(b.latitude-a.latitude)
            return hypot(x,y)*6_371_000
        }
    }
}
