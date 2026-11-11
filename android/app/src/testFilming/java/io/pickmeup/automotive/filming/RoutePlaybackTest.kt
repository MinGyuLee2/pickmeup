package io.pickmeup.automotive.filming

import io.pickmeup.automotive.navigation.GeoPoint
import org.junit.Assert.*
import org.junit.Test

class RoutePlaybackTest {
    private var now=0L
    private fun player()=RoutePlayback(listOf(GeoPoint(37.5,127.0),GeoPoint(37.501,127.0),GeoPoint(37.501,127.002)),120){now}
    @Test fun startsPausedAtBeginning(){val p=player();now=10000;assertEquals(120,p.frame().remainingSeconds);assertFalse(p.playing)}
    @Test fun movesByRoadDistanceNotVertexNumber(){val p=player();p.setSpeed(1.0);p.play();now=60000;val f=p.frame();assertEquals(60,f.remainingSeconds);assertEquals(37.501,f.location.latitude,.00001);assertTrue(f.location.longitude>127.0);assertTrue(f.location.longitude<127.002)}
    @Test fun pauseDoesNotConsumeTime(){val p=player();p.play();now=1000;p.pause();val f=p.frame();now=90000;assertEquals(f,p.frame())}
    @Test fun resumeHasNoJump(){val p=player();p.play();now=1000;p.pause();now=50000;p.play();assertEquals(114,p.frame().remainingSeconds);now+=1000;assertEquals(108,p.frame().remainingSeconds)}
    @Test fun speedChangeKeepsProgress(){val p=player();p.play();now=1000;p.setSpeed(2.0);assertEquals(114,p.frame().remainingSeconds);now=2000;assertEquals(112,p.frame().remainingSeconds)}
    @Test fun seekPreservesPausedState(){val p=player();p.seek(80.0);now=100000;assertEquals(40,p.frame().remainingSeconds);assertFalse(p.playing)}
    @Test fun seekWhilePlayingUsesNewAnchor(){val p=player();p.play();now=1000;p.seek(60.0);now=2000;assertEquals(54,p.frame().remainingSeconds)}
    @Test fun arrivalClampsAndStops(){val p=player();p.play();now=999000;val f=p.frame();assertEquals(p.points.last(),f.location);assertEquals(0,f.remainingSeconds);assertEquals(0,f.remainingMeters);assertTrue(f.arrived);assertFalse(p.playing);p.play();assertFalse(p.playing)}
    @Test fun resetReturnsToPausedOrigin(){val p=player();p.seek(120.0);p.reset();assertEquals(120,p.frame().remainingSeconds);assertEquals(p.points.first(),p.frame().location);assertFalse(p.playing)}
    @Test fun repeatedPlayDoesNotLoseElapsedTime(){val p=player();p.play();now=1000;p.play();now=2000;assertEquals(108,p.frame().remainingSeconds)}
    @Test fun duplicateVerticesDoNotBreakInterpolation(){val a=GeoPoint(37.5,127.0);val b=GeoPoint(37.501,127.0);val p=RoutePlayback(listOf(a,a,b),60){now};p.seek(30.0);assertEquals(37.5005,p.frame().location.latitude,.000001)}
    @Test(expected=IllegalArgumentException::class) fun rejectsEmptyRoad(){RoutePlayback(emptyList(),120){now}}
    @Test(expected=IllegalArgumentException::class) fun rejectsZeroLengthRoad(){val a=GeoPoint(37.5,127.0);RoutePlayback(listOf(a,a),120){now}}
    @Test(expected=IllegalArgumentException::class) fun rejectsTeleportRoad(){RoutePlayback(listOf(GeoPoint(0.0,0.0),GeoPoint(30.0,30.0)),120){now}}
    @Test(expected=IllegalArgumentException::class) fun rejectsInvalidSpeed(){player().setSpeed(Double.NaN)}
    @Test(expected=IllegalArgumentException::class) fun rejectsSeekPastEnd(){player().seek(121.0)}
}
