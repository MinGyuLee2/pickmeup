package io.pickmeup.automotive

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** The first screen is an introduction; connection controls live on their own screen. */
internal class VehicleWelcomeView(context: Context) : ScrollView(context) {
    init {
        val colors=VehiclePalette()
        val wide=resources.configuration.screenWidthDp>=1000
        val compact=resources.configuration.screenHeightDp<650
        fun dp(value: Int)=(value*resources.displayMetrics.density).toInt()
        val font=resources.getFont(R.font.asta_sans)
        fun text(value: String,size: Float,color: Int,weight: Int)=TextView(context).apply {
            text=value;textSize=size;setTextColor(color);includeFontPadding=false
            typeface=Typeface.create(font,weight,false);fontVariationSettings="'wght' $weight"
        }
        isFillViewport=true;isVerticalScrollBarEnabled=false
        val content=LinearLayout(context).apply {
            orientation=if(wide)LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
            gravity=Gravity.CENTER_VERTICAL
            setPadding(dp(if(wide)72 else 32),dp(36),dp(if(wide)56 else 32),dp(36))
        }
        addView(content,LayoutParams(-1,-2))
        val words=LinearLayout(context).apply {orientation=LinearLayout.VERTICAL}
        content.addView(words,if(wide)LinearLayout.LayoutParams(0,-2,1f) else LinearLayout.LayoutParams(-1,-2))
        words.addView(text("A LITTLE CLOSER",18f,colors.accent,500).apply {letterSpacing=.15f},LinearLayout.LayoutParams(-1,-2).apply {bottomMargin=dp(36)})
        words.addView(text("우리,",if(compact)52f else 76f,colors.ink,600))
        words.addView(text("곧 만나요.",if(compact)64f else 88f,colors.ink,600).apply {letterSpacing=-.04f;isAccessibilityHeading=true},LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(6)})
        words.addView(text("도착 시간을 나누고,\n기다림은 가볍게.",if(compact)24f else 28f,colors.muted,400).apply {setLineSpacing(dp(8).toFloat(),1f)},LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(32)})
        content.addView(MeetingArt(context), (if(wide)LinearLayout.LayoutParams(0,dp(if(compact)360 else 500),1.12f) else LinearLayout.LayoutParams(-1,dp(340))).apply {if(wide)marginStart=dp(40) else topMargin=dp(30)})
    }
}

/** Decorative, static messages: a preview of the feeling, never live pickup data. */
private class MeetingArt(context: Context): View(context) {
    private val colors=VehiclePalette()
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG)
    private val font=resources.getFont(R.font.asta_sans)
    private val medium=Typeface.create(font,500,false)
    private val semibold=Typeface.create(font,600,false)
    private val route=Path().apply {moveTo(118f,376f);cubicTo(54f,230f,476f,360f,473f,113f)}
    private val tail=Path().apply {moveTo(120f,260f);lineTo(120f,291f);lineTo(154f,260f);close()}
    private val check=Path().apply {moveTo(461f,346f);lineTo(470f,355f);lineTo(489f,335f)}
    init {importantForAccessibility=IMPORTANT_FOR_ACCESSIBILITY_NO}
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        // Keep the composition proportional on both the full vehicle panel and a narrow screen.
        val scale=minOf(width/600f,height/500f)
        canvas.save();canvas.translate((width-600*scale)/2,(height-500*scale)/2);canvas.scale(scale,scale)
        paint.style=Paint.Style.FILL;paint.color=colors.surface
        canvas.drawCircle(302f,246f,190f,paint)
        paint.style=Paint.Style.STROKE;paint.strokeWidth=1.5f;paint.color=colors.border
        canvas.drawCircle(302f,246f,220f,paint)
        paint.strokeWidth=3f;paint.color=colors.accent;paint.strokeCap=Paint.Cap.ROUND;canvas.drawPath(route,paint)
        paint.style=Paint.Style.FILL;paint.color=colors.canvas
        canvas.drawCircle(118f,376f,19f,paint);canvas.drawCircle(473f,113f,19f,paint)
        paint.color=colors.accent;canvas.drawCircle(118f,376f,8f,paint);canvas.drawCircle(473f,113f,8f,paint)
        // A large arrival bubble and a smaller reply keep the focal point off the app icon.
        paint.color=colors.accent;canvas.drawRoundRect(80f,136f,432f,270f,32f,32f,paint)
        canvas.drawPath(tail,paint)
        paint.typeface=medium;paint.textSize=18f;paint.color=colors.onAccent
        canvas.drawText("ON MY WAY",110f,174f,paint)
        paint.textSize=38f;paint.typeface=semibold;canvas.drawText("곧 도착해요",110f,232f,paint)
        paint.color=colors.soft;canvas.drawRoundRect(254f,300f,535f,396f,28f,28f,paint)
        paint.color=colors.ink;paint.textSize=31f;paint.typeface=medium
        canvas.drawText("나왔어요",287f,360f,paint)
        paint.color=colors.accent;paint.style=Paint.Style.STROKE;paint.strokeWidth=3f
        canvas.drawPath(check,paint)
        canvas.restore()
    }
}
