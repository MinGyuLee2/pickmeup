package io.pickmeup.automotive

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.InputFilter
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import io.pickmeup.automotive.pickup.VehicleUiState

/** Full-screen, phone-first setup using the existing pairing request and delivery controls. */
@android.annotation.SuppressLint("ViewConstructor") // Created in code with callbacks, never inflated from XML.
internal class VehicleConnectionView(context: Context,
    private val request: (String)->Unit, private val share: ()->Unit,
    private val copy: ()->Unit, private val resend: ()->Unit
): ScrollView(context) {
    private val colors=VehiclePalette()
    private val font=resources.getFont(R.font.asta_sans)
    private val phone: EditText
    private val entry: LinearLayout
    private val waiting: LinearLayout
    private val requestButton: Button
    private val cancelEdit: Button
    private val shareButton: Button
    private val copyButton: Button
    private val resendButton: Button
    private val editButton: Button
    private val notice: TextView
    private val waitingTitle: TextView
    private var lastPairingId: String?=null
    private var editing=false
    var draftPhone: String
        get()=phone.text.toString()
        set(value){phone.setText(value)}
    private fun dp(value: Int)=(value*resources.displayMetrics.density).toInt()
    private fun fill(color: Int,radius: Int)=GradientDrawable().apply {setColor(color);cornerRadius=dp(radius).toFloat()}
    private fun text(value: String,size: Float,color: Int=colors.ink,weight: Int=400)=TextView(context).apply {
        text=value;textSize=size;setTextColor(color);includeFontPadding=false
        typeface=Typeface.create(font,weight,false);fontVariationSettings="'wght' $weight"
        setLineSpacing(dp(6).toFloat(),1f)
    }
    private fun button(label: String,primary: Boolean=false,action: ()->Unit)=Button(context).apply {
        text=label;textSize=22f;isAllCaps=false;typeface=Typeface.create(font,500,false)
        minimumHeight=dp(68);minimumWidth=0;stateListAnimator=null
        setPadding(dp(18),dp(12),dp(18),dp(12))
        setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled),intArrayOf()),intArrayOf(colors.muted,if(primary)colors.onAccent else colors.ink)))
        background=android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(-android.R.attr.state_enabled),fill(colors.soft,14))
            addState(intArrayOf(),RippleDrawable(ColorStateList.valueOf(colors.border),fill(if(primary)colors.accent else colors.soft,14),null))
        }
        setOnClickListener {action()}
    }
    init {
        val wide=resources.configuration.screenWidthDp>=1000
        val compact=resources.configuration.screenHeightDp<650
        isFillViewport=true;isVerticalScrollBarEnabled=false;isFocusableInTouchMode=true
        val content=LinearLayout(context).apply {
            orientation=if(wide)LinearLayout.HORIZONTAL else LinearLayout.VERTICAL;gravity=Gravity.CENTER_VERTICAL
            setPadding(dp(if(wide)72 else 32),dp(32),dp(if(wide)72 else 32),dp(32))
        }
        addView(content,LayoutParams(-1,-2))
        val intro=LinearLayout(context).apply {orientation=LinearLayout.VERTICAL}
        content.addView(intro,if(wide)LinearLayout.LayoutParams(0,-2,1f) else LinearLayout.LayoutParams(-1,-2))
        intro.addView(text("LET’S GET STARTED",18f,colors.accent,500).apply {letterSpacing=.12f},LinearLayout.LayoutParams(-1,-2).apply {bottomMargin=dp(30)})
        intro.addView(text("픽업을\n시작해 볼까요?",if(compact)48f else 60f,weight=600).apply {letterSpacing=-.03f;isAccessibilityHeading=true})
        intro.addView(text("계정 연결은 선택이에요.\n이 차량에서 쓰던 픽업을 그대로 이어가요.",if(compact)22f else 26f,colors.muted),LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(26)})
        val card=LinearLayout(context).apply {orientation=LinearLayout.VERTICAL;background=fill(colors.surface,28);setPadding(dp(36),dp(36),dp(36),dp(32))}
        content.addView(card,(if(wide)LinearLayout.LayoutParams(0,-2,1.05f) else LinearLayout.LayoutParams(-1,-2)).apply {if(wide)marginStart=dp(64) else topMargin=dp(32)})
        entry=LinearLayout(context).apply {orientation=LinearLayout.VERTICAL};card.addView(entry)
        entry.addView(text("계정 연결 (선택)",30f,weight=500).apply {isAccessibilityHeading=true})
        entry.addView(text("설정 링크와 인증번호를 문자로 보내드려요.",20f,colors.muted),LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(14);bottomMargin=dp(28)})
        val label=text("내 휴대전화 번호",18f,colors.muted)
        entry.addView(label)
        phone=EditText(context).apply {
            id=View.generateViewId();hint="010-0000-0000";textSize=26f;isSingleLine=true;setSelectAllOnFocus(true)
            inputType=InputType.TYPE_CLASS_PHONE;filters=arrayOf(InputFilter.LengthFilter(20));typeface=Typeface.create(font,400,false)
            setTextColor(colors.ink);setHintTextColor(colors.muted);setPadding(dp(20),dp(18),dp(20),dp(18))
            background=fill(colors.canvas,14);minimumHeight=dp(76)
        }
        label.labelFor=phone.id
        entry.addView(phone,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(10)})
        requestButton=button("인증문자 받기",true) {
            (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(phone.windowToken,0)
            phone.clearFocus();request(phone.text.toString())
        }
        entry.addView(requestButton,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(22)})
        cancelEdit=button("기존 요청으로 돌아가기") {editing=false;renderedState?.let(::render)}
        entry.addView(cancelEdit,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(12)})
        waiting=LinearLayout(context).apply {orientation=LinearLayout.VERTICAL};card.addView(waiting)
        waitingTitle=text("문자를 확인해 주세요",30f,weight=500).apply {isAccessibilityHeading=true}
        waiting.addView(waitingTitle)
        waiting.addView(text("문자 링크에서 인증하고 이름을 입력하면\n이 차량에 계정이 연결돼요.",20f,colors.muted),LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(16);bottomMargin=dp(28)})
        resendButton=button("인증문자 다시 보내기",true,resend)
        waiting.addView(resendButton,LinearLayout.LayoutParams(-1,-2))
        val row=LinearLayout(context)
        waiting.addView(row,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(12)})
        copyButton=button("링크 복사하기",action=copy);shareButton=button("링크 공유",action=share)
        row.addView(copyButton,LinearLayout.LayoutParams(0,-2,1f).apply {marginEnd=dp(10)})
        row.addView(shareButton,LinearLayout.LayoutParams(0,-2,1f))
        editButton=button("다른 번호로 요청") {editing=true;renderedState?.let(::render)}
        editButton.background=null;editButton.setTextColor(colors.muted);editButton.textSize=19f
        waiting.addView(editButton,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(14)})
        notice=text("",19f,colors.error).apply {accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE}
        card.addView(notice,LinearLayout.LayoutParams(-1,-2).apply {topMargin=dp(20)})
    }
    private var renderedState: VehicleUiState?=null
    fun render(state: VehicleUiState) {
        renderedState=state
        val pending=state.pairing;val now=System.currentTimeMillis()
        if(pending?.id!=lastPairingId){lastPairingId=pending?.id;editing=false}
        val showEntry=pending==null||editing
        entry.visibility=if(showEntry)View.VISIBLE else View.GONE
        waiting.visibility=if(showEntry)View.GONE else View.VISIBLE
        cancelEdit.visibility=if(pending!=null)View.VISIBLE else View.GONE
        phone.isEnabled=!state.busy;requestButton.isEnabled=!state.busy;cancelEdit.isEnabled=!state.busy;editButton.isEnabled=!state.busy
        requestButton.text=if(state.busy)"요청 중…" else "인증문자 받기"
        val seconds=if(pending==null)0 else maxOf(0,(pending.resendAfter-now+999)/1000)
        val expired=pending!=null&&pending.resendExpiresAt<=now
        waitingTitle.text=if(pending?.verified==true)"연결을 마무리해 주세요" else "문자를 확인해 주세요"
        resendButton.text=when {pending?.verified==true->"본인 인증을 마쳤어요";pending?.resendsRemaining==0->"재전송 1회를 사용했어요";expired->"인증번호가 만료되었어요";seconds>0->"${seconds}초 후 다시 보내기";else->"인증문자 다시 보내기 · 1회"}
        resendButton.isEnabled=!state.busy&&pending!=null&&!pending.verified&&pending.resendsRemaining>0&&!expired&&seconds==0L
        shareButton.isEnabled=!state.busy&&pending?.shareMessage?.isNotBlank()==true&&pending.expiresAt>now
        copyButton.isEnabled=shareButton.isEnabled
        notice.text=state.error ?: if(state.busy)"잠시만 기다려 주세요." else ""
        notice.visibility=if(notice.text.isBlank())View.GONE else View.VISIBLE
    }
}
