package io.pickmeup.automotive

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View

/** PickMeUp uses a single dark palette, independent of the vehicle system theme. */
internal class VehiclePalette {
    val ink=Color.parseColor("#F4F5F7")
    val muted=Color.parseColor("#A4A7AF")
    val canvas=Color.parseColor("#111214")
    val surface=Color.parseColor("#1C1E22")
    val soft=Color.parseColor("#292C31")
    val border=Color.parseColor("#34373D")
    val accent=Color.parseColor("#C8FF00")
    val onAccent=Color.parseColor("#111214")
    val selected=Color.parseColor("#272B30")
    val accentBorder=Color.parseColor("#C8FF00")
    val pressedAccent=Color.parseColor("#B3E500")
    val error=Color.parseColor("#FFB5A9")
    val dangerSurface=Color.parseColor("#332124")
    val dangerBorder=Color.parseColor("#88544F")
    val warning=Color.parseColor("#EFCB8F")
    val warningSurface=Color.parseColor("#302718")
}

/** Static monoline symbols. No animated graphics in the driving surface. */
@android.annotation.SuppressLint("ViewConstructor") // Created in code, never inflated from XML.
internal class VehicleSymbol(context: Context, kind: String, tint: Int): View(context) {
    var kind=kind
        set(value){if(field!=value){field=value;buildPath();invalidate()}}
    var tint=tint
        set(value){if(field!=value){field=value;invalidate()}}
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply { style=Paint.Style.STROKE;strokeWidth=1.7f;strokeCap=Paint.Cap.ROUND;strokeJoin=Paint.Join.ROUND }
    private val path=Path()
    init { buildPath();importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_NO }
    private fun buildPath() {
        val p=path;p.reset()
        when(kind) {
            "close"->{p.moveTo(6f,6f);p.lineTo(18f,18f);p.moveTo(18f,6f);p.lineTo(6f,18f)}
            "stop"->p.addRoundRect(6f,6f,18f,18f,2f,2f,Path.Direction.CW)
            "message"->{p.addRoundRect(3f,4f,21f,17f,3f,3f,Path.Direction.CW);p.moveTo(7f,17f);p.lineTo(7f,21f);p.lineTo(12f,17f);p.moveTo(7f,9f);p.lineTo(17f,9f);p.moveTo(7f,13f);p.lineTo(14f,13f)}
            "arrow"->{p.moveTo(5f,16f);p.lineTo(18f,5f);p.moveTo(8f,5f);p.lineTo(18f,5f);p.lineTo(18f,15f)}
            "voice"->{for((x,a,b) in listOf(Triple(3f,10f,14f),Triple(7f,7f,17f),Triple(12f,3f,21f),Triple(17f,6f,18f),Triple(21f,9f,15f))){p.moveTo(x,a);p.lineTo(x,b)}}
            "person"->{p.addCircle(12f,7f,4f,Path.Direction.CW);p.moveTo(4f,21f);p.lineTo(4f,19f);p.cubicTo(4f,10f,20f,10f,20f,19f);p.lineTo(20f,21f)}
            "check"->{p.moveTo(5f,12f);p.lineTo(10f,17f);p.lineTo(20f,6f)}
            "pin"->{p.moveTo(12f,22f);p.cubicTo(8f,17f,5f,14f,5f,9f);p.cubicTo(5f,0f,19f,0f,19f,9f);p.cubicTo(19f,14f,16f,17f,12f,22f);p.addCircle(12f,9f,2.5f,Path.Direction.CW)}
        }
    }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val availableWidth=width-paddingLeft-paddingRight
        val availableHeight=height-paddingTop-paddingBottom
        val size=minOf(availableWidth,availableHeight).toFloat()
        canvas.save();canvas.translate(paddingLeft+(availableWidth-size)/2,paddingTop+(availableHeight-size)/2);canvas.scale(size/24,size/24)
        paint.color=tint;canvas.drawPath(path,paint);canvas.restore()
    }
}
