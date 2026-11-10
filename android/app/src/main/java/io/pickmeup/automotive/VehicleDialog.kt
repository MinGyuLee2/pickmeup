package io.pickmeup.automotive

import android.app.Activity
import android.app.AlertDialog
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.Editable
import android.text.InputFilter
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** App-owned dialogs use the same palette, typography and touch targets as the parked home. */
internal class VehicleDialog(private val activity: Activity, title: String, subtitle: String?=null,private val destructive: Boolean=false) : AlertDialog(activity) {
    private val colors=VehiclePalette()
    private val regular=Typeface.create(activity.resources.getFont(R.font.asta_sans),400,false)
    private val medium=Typeface.create(regular,500,false)
    private fun dp(n: Int)=(n*activity.resources.displayMetrics.density).toInt()
    private fun fill(color: Int,border: Int?=null,radius: Int=16)=GradientDrawable().apply {
        setColor(color);cornerRadius=dp(radius).toFloat();border?.let {setStroke(dp(1),it)}
    }
    private val root=LinearLayout(activity).apply {
        orientation=LinearLayout.VERTICAL;setPadding(dp(36),dp(28),dp(36),dp(32))
        background=fill(colors.surface,colors.border,24);elevation=dp(24).toFloat()
        isFocusableInTouchMode=true
    }
    private val content=LinearLayout(activity).apply {orientation=LinearLayout.VERTICAL}
    private val errorLabel=label("",20f,colors.error).apply {visibility=View.GONE}
    private var invalidInput: EditText?=null
    private var backdrop: ColorDrawable?=null
    private val backdropBounds=View.OnLayoutChangeListener {view,_,_,_,_,_,_,_,_->backdrop?.setBounds(0,0,view.width,view.height)}
    init {
        val header=LinearLayout(activity).apply {gravity=Gravity.CENTER_VERTICAL}
        header.addView(label(title,34f,colors.ink,true).apply {isAccessibilityHeading=true},LinearLayout.LayoutParams(0,-2,1f).apply {marginEnd=dp(16)})
        val close=android.widget.FrameLayout(activity).apply {
            contentDescription="닫기";isFocusable=true;isClickable=true
            background=RippleDrawable(ColorStateList.valueOf(colors.soft),fill(Color.TRANSPARENT,radius=14),null)
            addView(VehicleSymbol(activity,"close",colors.muted),android.widget.FrameLayout.LayoutParams(dp(24),dp(24),Gravity.CENTER))
            setOnClickListener {cancel()}
        }
        header.addView(close,LinearLayout.LayoutParams(dp(56),dp(56)))
        root.addView(header,LinearLayout.LayoutParams(-1,-2))
        if(subtitle!=null)root.addView(label(subtitle,22f,colors.muted),LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(10)})
        val scroll=object: ScrollView(activity) {
            override fun onMeasure(widthMeasureSpec: Int,heightMeasureSpec: Int) {
                val available=(activity.window.decorView.height-dp(if(subtitle==null)300 else 350)).coerceAtLeast(dp(140))
                val limit=minOf(dp(420),available)
                val requested=if(MeasureSpec.getMode(heightMeasureSpec)==MeasureSpec.UNSPECIFIED)limit else minOf(limit,MeasureSpec.getSize(heightMeasureSpec))
                super.onMeasure(widthMeasureSpec,MeasureSpec.makeMeasureSpec(requested,MeasureSpec.AT_MOST))
            }
        }.apply {isFillViewport=false;isVerticalScrollBarEnabled=true;addView(content)}
        root.addView(scroll,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(26)})
        root.addView(errorLabel,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(14)})
        setView(root,0,0,0,0)
        setCanceledOnTouchOutside(true)
    }
    private fun label(value: String,size: Float=24f,color: Int=colors.ink,bold: Boolean=false)=TextView(activity).apply {
        text=value;textSize=size;setTextColor(color);includeFontPadding=false
        typeface=if(bold)medium else regular;fontVariationSettings="'wght' ${if(bold)500 else 400}"
        setLineSpacing(dp(5).toFloat(),1f)
    }
    fun note(value: String) {content.addView(label(value,20f,colors.muted),LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(18)})}
    private fun card()=LinearLayout(activity).apply {
        orientation=LinearLayout.VERTICAL;setPadding(dp(24),dp(24),dp(24),dp(24));background=fill(colors.canvas,radius=16)
        content.addView(this,LinearLayout.LayoutParams(-1,-2))
    }
    fun recipient(name: String,phone: String?,place: String) {
        val card=card()
        val person=LinearLayout(activity).apply {gravity=Gravity.CENTER_VERTICAL}
        person.addView(VehicleSymbol(activity,"person",colors.accent),LinearLayout.LayoutParams(dp(32),dp(32)).apply {marginEnd=dp(18)})
        val identity=LinearLayout(activity).apply {orientation=LinearLayout.VERTICAL}
        identity.addView(label(name,30f,colors.ink,true),LinearLayout.LayoutParams(-1,-2))
        if(phone!=null)identity.addView(label(phone,22f,colors.muted),LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(6)})
        person.addView(identity,LinearLayout.LayoutParams(0,-2,1f));card.addView(person)
        val destination=LinearLayout(activity).apply {gravity=Gravity.TOP}
        destination.addView(VehicleSymbol(activity,"pin",colors.accent),LinearLayout.LayoutParams(dp(28),dp(28)).apply {marginEnd=dp(22);topMargin=dp(2)})
        val location=LinearLayout(activity).apply {orientation=LinearLayout.VERTICAL}
        location.addView(label("만날 곳",20f,colors.muted))
        location.addView(label(place,26f,colors.ink,true),LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(6)})
        destination.addView(location,LinearLayout.LayoutParams(0,-2,1f))
        card.addView(destination,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(24)})
    }
    fun message(value: String) {
        val card=card();card.addView(label("공유할 메시지",18f,colors.muted))
        card.addView(label(value,23f).apply {setTextIsSelectable(true)},LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(14)})
    }
    fun destination(current: String,selected: String) {
        val card=card()
        card.addView(label("현재 목적지",20f,colors.muted));card.addView(label(current,24f,colors.muted),LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(6)})
        card.addView(label("새 만날 곳",20f,colors.accent),LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(22)})
        card.addView(label(selected,28f,colors.ink,true),LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(6)})
    }
    fun input(title: String,hint: String,inputType: Int,maxLength: Int): EditText {
        content.addView(label(title,20f,colors.muted),LinearLayout.LayoutParams(-1,-2).apply {topMargin=if(content.childCount==0)0 else dp(20)})
        val field=EditText(activity).apply {
            this.hint=hint;this.inputType=inputType;setSingleLine(true);textSize=26f
            typeface=regular;fontVariationSettings="'wght' 400";setTextColor(colors.ink);setHintTextColor(colors.muted)
            filters=arrayOf(InputFilter.LengthFilter(maxLength));setPadding(dp(20),dp(16),dp(20),dp(16));minimumHeight=dp(72)
            background=fill(colors.canvas,colors.border,12)
            setOnFocusChangeListener {_,focused->background=fill(colors.canvas,if(focused)colors.accentBorder else colors.border,12)}
            addTextChangedListener(object: TextWatcher {
                override fun beforeTextChanged(s: CharSequence?,start: Int,count: Int,after: Int){}
                override fun onTextChanged(s: CharSequence?,start: Int,before: Int,count: Int){if(invalidInput===this@apply){errorLabel.visibility=View.GONE;invalidInput=null;background=fill(colors.canvas,colors.accentBorder,12)}}
                override fun afterTextChanged(s: Editable?){}
            })
        }
        content.addView(field,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(8)});return field
    }
    fun inputError(field: EditText,message: String) {
        invalidInput=field;errorLabel.text=message;errorLabel.visibility=View.VISIBLE
        field.requestFocus();field.background=fill(colors.canvas,colors.error,12)
        field.announceForAccessibility(message)
    }
    fun choice(value: String,selected: () -> Unit) {
        content.addView(button(value,false).apply {gravity=Gravity.START or Gravity.CENTER_VERTICAL;setOnClickListener {dismiss();selected()}},LinearLayout.LayoutParams(-1,-2).apply {bottomMargin=dp(10)})
    }
    private fun button(value: String,primary: Boolean)=Button(activity).apply {
        text=value;isAllCaps=false;textSize=24f;typeface=medium;fontVariationSettings="'wght' 500";stateListAnimator=null
        minimumHeight=dp(72);minimumWidth=0;setPadding(dp(20),dp(14),dp(20),dp(14));gravity=Gravity.CENTER
        val danger=primary && destructive
        setTextColor(if(danger)colors.error else if(primary)colors.onAccent else colors.ink)
        background=RippleDrawable(ColorStateList.valueOf(if(danger)colors.dangerBorder else if(primary)colors.pressedAccent else colors.border),fill(if(danger)colors.dangerSurface else if(primary)colors.accent else colors.soft,if(primary)null else colors.border,12),null)
    }
    fun actions(primary: String,secondary: String,onSecondary: (() -> Unit)?=null,onPrimary: () -> Boolean) {
        val row=LinearLayout(activity).apply {gravity=Gravity.CENTER_VERTICAL}
        row.addView(button(secondary,false).apply {setOnClickListener {if(onSecondary==null)cancel() else {onSecondary();dismiss()}}},LinearLayout.LayoutParams(0,dp(72),1f).apply {marginEnd=dp(12)})
        row.addView(button(primary,true).apply {setOnClickListener {if(onPrimary())dismiss()}},LinearLayout.LayoutParams(0,dp(72),1f))
        root.addView(row,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(28)})
    }
    override fun show() {
        super.show()
        val width=activity.window.decorView.width.takeIf {it>0} ?: activity.resources.displayMetrics.widthPixels
        window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT));decorView.setPadding(0,0,0,0)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);setDimAmount(.30f)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            setLayout(minOf(dp(800),(width-dp(64)).coerceAtLeast(dp(280))),ViewGroup.LayoutParams.WRAP_CONTENT)
            setGravity(Gravity.CENTER)
        }
        // Pleos may limit system window dimming. Draw a scrim over this app's own window too.
        val host=activity.window.decorView
        if(backdrop==null) {
            backdrop=ColorDrawable(Color.argb(165,0,0,0)).also {it.setBounds(0,0,host.width,host.height);host.overlay.add(it)}
            host.addOnLayoutChangeListener(backdropBounds)
        }
        root.requestFocus()
    }
    override fun onStop() {
        val host=activity.window.decorView
        backdrop?.let {host.overlay.remove(it)};backdrop=null
        host.removeOnLayoutChangeListener(backdropBounds)
        super.onStop()
    }
}
