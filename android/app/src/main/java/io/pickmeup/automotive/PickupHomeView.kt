package io.pickmeup.automotive

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Button
import android.widget.CheckBox
import android.widget.ImageView
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.ScrollView
import android.widget.TextView
import io.pickmeup.automotive.navigation.matches
import io.pickmeup.automotive.pickup.Contact
import io.pickmeup.automotive.pickup.Destination
import io.pickmeup.automotive.pickup.RecentPickup
import io.pickmeup.automotive.pickup.distinctPlaces

/** Parked, bounded home: independent lists fill the space above the fixed start action. */
internal class PickupHomeView(context: Context,
    private val choosePlace: (Destination)->Unit,
    private val choosePerson: (Contact)->Unit,
    private val startRecent: (RecentPickup)->Unit,
    private val openNavigation: ()->Unit,
    private val importPerson: ()->Unit,
    private val enterPhone: ()->Unit,
    private val cancelSearch: ()->Unit,
    private val startPickup: ()->Unit,
    private val changeImmediateMessage: (Boolean)->Unit,
) : LinearLayout(context) {
    private val palette=VehiclePalette()
    private val regular=Typeface.create(context.resources.getFont(R.font.asta_sans),400,false)
    private val medium=Typeface.create(regular,500,false)
    private var last: List<Any?>?=null
    private var placeOrder=emptyList<Destination>()
    private var personOrder=emptyList<String>()
    private var placeScroll: ScrollView?=null
    private var personScroll: ScrollView?=null
    private var recentScroll: HorizontalScrollView?=null
    private var displayedPlace: Destination?=null
    private var displayedPerson: String?=null
    private val compact get()=resources.configuration.screenHeightDp<650
    private fun dp(n: Int)=(n*resources.displayMetrics.density).toInt()
    init {orientation=VERTICAL;setPadding(dp(40),dp(if(compact)16 else 24),dp(40),0)}
    private fun surface(fill: Int,border: Int?=null,radius: Int=16)=GradientDrawable().apply {
        setColor(fill);cornerRadius=dp(radius).toFloat();border?.let {setStroke(dp(1),it)}
    }
    private fun label(parent: LinearLayout,text: String,size: Float=24f,muted: Boolean=false,bold: Boolean=false)=TextView(context).apply {
        this.text=text;textSize=size;setTextColor(if(muted)palette.muted else palette.ink)
        typeface=if(bold)medium else regular;fontVariationSettings="'wght' ${if(bold)500 else 400}"
        includeFontPadding=false;maxLines=2;ellipsize=TextUtils.TruncateAt.END
        parent.addView(this,LayoutParams(-1,-2))
    }
    private fun auxiliary(parent: LinearLayout,text: String,enabled: Boolean,outlined: Boolean=false,action: ()->Unit)=Button(context).apply {
        this.text=text;isAllCaps=false;textSize=20f;typeface=medium;fontVariationSettings="'wght' 500"
        minimumHeight=dp(60);minimumWidth=0;setPadding(dp(18),dp(12),dp(18),dp(12));stateListAnimator=null
        setTextColor(if(outlined)palette.ink else palette.muted)
        background=RippleDrawable(ColorStateList.valueOf(palette.border),surface(if(outlined)palette.soft else android.graphics.Color.TRANSPARENT,if(outlined)palette.border else null,10),null)
        gravity=Gravity.CENTER;isEnabled=enabled;alpha=if(enabled)1f else .45f
        parent.addView(this,LayoutParams(-1,-2));setOnClickListener {action()}
    }
    private fun option(parent: LinearLayout,text: String,selected: Boolean,enabled: Boolean,tagValue: String,action: ()->Unit): View {
        return RadioButton(context).apply {
            this.text=text;isChecked=selected;textSize=26f;typeface=if(selected)medium else regular
            fontVariationSettings="'wght' ${if(selected)500 else 400}";setTextColor(palette.ink)
            buttonDrawable=null;buttonTintList=null
            val marker=GradientDrawable().apply {
                shape=GradientDrawable.OVAL
                setColor(if(selected)palette.accent else android.graphics.Color.TRANSPARENT)
                if(!selected)setStroke(dp(2),palette.muted)
                setBounds(0,0,dp(18),dp(18))
            }
            setCompoundDrawablesRelative(marker,null,null,null)
            background=RippleDrawable(ColorStateList.valueOf(palette.soft),surface(if(selected)palette.selected else android.graphics.Color.TRANSPARENT,if(selected)palette.accentBorder else null,12),null)
            minimumHeight=dp(if(compact)72 else 84);setPaddingRelative(dp(30),dp(14),dp(18),dp(14));compoundDrawablePadding=dp(18)
            maxLines=2;ellipsize=TextUtils.TruncateAt.END;isEnabled=enabled;alpha=if(enabled)1f else .5f
            tag=tagValue;setOnClickListener {action()}
            parent.addView(this,LayoutParams(-1,-2).apply {bottomMargin=dp(6)})
        }
    }
    private fun column(parent: LinearLayout,title: String,kind: String,button: String,enabled: Boolean,action: ()->Unit,extra: (() -> Unit)?=null): Pair<ScrollView,LinearLayout> {
        val panel=LinearLayout(context).apply {orientation=VERTICAL;background=surface(palette.surface,palette.border);setPadding(dp(22),dp(20),dp(22),dp(16))}
        parent.addView(panel,LayoutParams(0,-1,1f))
        val heading=LinearLayout(context).apply {gravity=Gravity.CENTER_VERTICAL}
        panel.addView(heading,LayoutParams(-1,-2).apply {bottomMargin=dp(16)})
        heading.addView(VehicleSymbol(context,kind,palette.accent),LayoutParams(dp(26),dp(26)).apply {marginEnd=dp(12)})
        label(heading,title,26f,bold=true).isAccessibilityHeading=true
        val list=LinearLayout(context).apply {orientation=VERTICAL;setPadding(0,dp(10),dp(6),dp(8))}
        val viewport=ScrollView(context).apply {
            isFillViewport=true;isVerticalScrollBarEnabled=true;isScrollbarFadingEnabled=false
            scrollBarStyle=View.SCROLLBARS_INSIDE_INSET;contentDescription="$title 목록";addView(list)
        }
        panel.addView(viewport,LayoutParams(-1,0,1f))
        // Panel actions stay outside the scroll viewport, directly above the global start action.
        panel.addView(View(context).apply {setBackgroundColor(palette.border)},LayoutParams(-1,dp(1)))
        val actions=LinearLayout(context).apply {setPadding(0,dp(12),0,0)}
        panel.addView(actions,LayoutParams(-1,-2))
        auxiliary(actions,button,enabled,true,action).apply {layoutParams=LayoutParams(0,-2,1f);tag=if(kind=="pin")"openNavigation" else "importPerson"}
        extra?.let {callback->auxiliary(actions,"번호 직접 입력",enabled,true,callback).apply {layoutParams=LayoutParams(0,-2,1f).apply {marginStart=dp(10)};tag="enterPhone"}}
        return viewport to list
    }
    private fun restoreScroll(viewport: ScrollView,y: Int,selected: View?,changed: Boolean) {
        viewport.post {
            if(viewport===placeScroll || viewport===personScroll) {
                val target=if(changed && selected!=null)when {
                    selected.top<y->selected.top
                    selected.bottom>y+viewport.height->selected.bottom-viewport.height
                    else->y
                } else y
                viewport.scrollTo(0,target)
            }
        }
    }
    fun render(people: List<Contact>,history: List<RecentPickup>,personId: String?,place: Destination?,current: Destination?,nativeRecent: List<Destination>,busy: Boolean,canStart: Boolean,disabledReason: String?,notice: String?,searchPending: Boolean,immediateMessage: Boolean) {
        val key=listOf(people,history,personId,place,current,nativeRecent,busy,canStart,disabledReason,notice,searchPending,immediateMessage)
        if(last==key)return;last=key
        val focus=findFocus()?.tag
        val recentX=recentScroll?.scrollX ?: 0
        val placeY=placeScroll?.scrollY ?: 0;val personY=personScroll?.scrollY ?: 0
        val placeChanged=place?.let {displayedPlace?.matches(it)!=true} ?: (displayedPlace!=null)
        val personChanged=displayedPerson!=personId
        displayedPlace=place;displayedPerson=personId
        removeAllViews()
        val brand=LinearLayout(context).apply {gravity=Gravity.CENTER_VERTICAL}
        addView(brand,LayoutParams(-1,-2).apply {bottomMargin=dp(if(compact)12 else 20)})
        label(brand,"Pick Me Up",28f,bold=true).apply {setTextColor(palette.accent);letterSpacing=-.035f;typeface=Typeface.create(regular,800,false);fontVariationSettings="'wght' 800";layoutParams=LayoutParams(0,-2,1f)}
        if(!notice.isNullOrBlank()) {
            val banner=LinearLayout(context).apply {gravity=Gravity.CENTER_VERTICAL;setPadding(dp(18),dp(10),dp(10),dp(10));background=surface(palette.soft,radius=10)}
            addView(banner,LayoutParams(-1,-2).apply {bottomMargin=dp(14)})
            label(banner,notice,18f,true).apply {layoutParams=LayoutParams(0,-2,1f);accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE}
            if(searchPending)auxiliary(banner,"선택 취소",true,action=cancelSearch).apply {layoutParams=LayoutParams(-2,-2);tag="cancelSearch"}
        }
        label(this,"최근 픽업",20f,true).apply {(layoutParams as LayoutParams).bottomMargin=dp(12);isAccessibilityHeading=true}
        val recent=history.filter {row->people.any {it.id==row.contactId}}.take(6)
        val cards=LinearLayout(context)
        val horizontal=HorizontalScrollView(context).apply {isHorizontalScrollBarEnabled=true;isScrollbarFadingEnabled=false;contentDescription="최근 픽업 목록";addView(cards)}
        recentScroll=horizontal;addView(horizontal,LayoutParams(-1,-2))
        horizontal.post {if(horizontal===recentScroll)horizontal.scrollTo(recentX,0)}
        if(recent.isEmpty()) {
            label(cards,"최근 픽업이 없어요. 아래에서 새 픽업을 시작하세요.",20f,true).apply {setPadding(dp(20),dp(20),dp(20),dp(20));background=surface(palette.surface,palette.border)}
        } else {
            recent.forEachIndexed {index,row->
                val person=people.first {it.id==row.contactId}
                val card=LinearLayout(context).apply {
                    orientation=VERTICAL;setPadding(dp(20),dp(18),dp(20),dp(18));minimumHeight=dp(if(compact)128 else 144)
                    background=RippleDrawable(ColorStateList.valueOf(palette.soft),surface(palette.surface,palette.border),null)
                    gravity=Gravity.CENTER_VERTICAL;isClickable=true;isFocusable=true;isEnabled=!busy;alpha=if(busy).5f else 1f
                    tag="recent:${row.contactId}:${row.destination.name}"
                    contentDescription="${row.destination.name}, ${person.name}에게 도착 알림. 바로 출발"
                    accessibilityDelegate=object: View.AccessibilityDelegate() {
                        override fun onInitializeAccessibilityNodeInfo(host: View,info: AccessibilityNodeInfo) {super.onInitializeAccessibilityNodeInfo(host,info);info.className=Button::class.java.name}
                    }
                    setOnClickListener {startRecent(row)}
                }
                cards.addView(card,LayoutParams(dp(if(compact)360 else 460),-2).apply {marginEnd=dp(14)})
                label(card,row.destination.name,26f,bold=true).apply {minHeight=dp(if(compact)52 else 60);importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO}
                val bottom=LinearLayout(context).apply {gravity=Gravity.CENTER_VERTICAL}
                card.addView(bottom,LayoutParams(-1,-2).apply {topMargin=dp(10)})
                label(bottom,person.name,20f,true).apply {layoutParams=LayoutParams(0,-2,1f);maxLines=1;importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO}
                label(bottom,"바로 출발 ↗",18f).apply {layoutParams=LayoutParams(-2,-2);setTextColor(palette.accent);importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO}
            }
        }
        label(this,"새 픽업",24f,bold=true).apply {(layoutParams as LayoutParams).apply {topMargin=dp(if(compact)16 else 24);bottomMargin=dp(14)};isAccessibilityHeading=true}
        val columns=LinearLayout(context)
        addView(columns,LayoutParams(-1,0,1f))
        val (left,places)=column(columns,"만날 곳","pin","내비에서 장소 찾기  ↗",!busy,openNavigation)
        (columns.getChildAt(0).layoutParams as LayoutParams).marginEnd=dp(18)
        val (right,persons)=column(columns,"연락할 상대","person","차량 연락처에서 선택",!busy,importPerson,enterPhone)
        placeScroll=left;personScroll=right
        val person=people.firstOrNull {it.id==personId}
        val candidates=(listOfNotNull(place,current,person?.meetingPlace)+nativeRecent+history.map {it.destination}).distinctPlaces()
        placeOrder=(placeOrder.filter {old->candidates.any {it.matches(old)}}+candidates).distinctPlaces()
        var selectedRow: View?=null
        if(placeOrder.isEmpty())label(places,"내비에서 만날 곳을 찾아 주세요",22f,true).setPadding(dp(16),dp(18),dp(16),0)
        placeOrder.forEach {destination->
            val selected=place?.matches(destination)==true
            val row=option(places,destination.name,selected,!busy,"place:${destination.name}"){choosePlace(destination)}
            if(selected)selectedRow=row
        }
        personOrder=(personOrder.filter {id->people.any {it.id==id}}+people.map {it.id}).distinct()
        var selectedPerson: View?=null
        if(people.isEmpty())label(persons,"차량 연락처에서 상대를 추가하세요",22f,true).setPadding(dp(16),dp(18),dp(16),0)
        personOrder.mapNotNull {id->people.firstOrNull {it.id==id}}.forEach {contact->
            val selected=contact.id==personId
            val row=option(persons,contact.name,selected,!busy,"person:${contact.id}"){choosePerson(contact)}
            if(selected)selectedPerson=row
        }
        val footer=LinearLayout(context).apply {orientation=VERTICAL;setPadding(0,dp(16),0,dp(if(compact)16 else 24))}
        addView(footer,LayoutParams(-1,-2))
        footer.addView(CheckBox(context).apply {
            text="바로 메시지 보내기";textSize=22f;typeface=regular;setTextColor(palette.ink)
            buttonTintList=ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked),intArrayOf()),intArrayOf(palette.accent,palette.muted))
            compoundDrawablePadding=dp(12);minimumHeight=dp(56);setPadding(dp(6),0,dp(12),0)
            isChecked=immediateMessage;isEnabled=!busy;tag="immediateMessage"
            setOnCheckedChangeListener {_,checked->changeImmediateMessage(checked)}
        },LayoutParams(-1,-2).apply {bottomMargin=dp(8)})
        val reason=when {canStart->null;disabledReason!=null->disabledReason;place==null && person==null->"만날 곳과 연락할 상대를 선택하세요";place==null->"만날 곳을 선택하세요";person==null->"연락할 상대를 선택하세요";else->null}
        if(reason!=null)label(footer,reason,18f,true).apply {(layoutParams as LayoutParams).bottomMargin=dp(10);accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE}
        Button(context).apply {
            text="길안내·도착 알림 시작  →";textSize=26f;isAllCaps=false;typeface=medium;fontVariationSettings="'wght' 500"
            minimumWidth=0;minimumHeight=dp(if(compact)72 else 84);maxLines=2;setPadding(dp(24),dp(16),dp(24),dp(16));stateListAnimator=null
            isEnabled=canStart;setTextColor(if(canStart)palette.onAccent else palette.muted)
            background=RippleDrawable(ColorStateList.valueOf(palette.pressedAccent),surface(if(canStart)palette.accent else palette.soft,radius=14),null)
            tag="start";contentDescription=if(canStart)"${place?.name}, ${person?.name}에게 길안내·도착 알림 시작" else text
            footer.addView(this,LayoutParams(-1,-2));setOnClickListener {startPickup()}
        }
        focus?.let {findViewWithTag<View>(it)?.requestFocus()}
        restoreScroll(left,placeY,selectedRow,placeChanged);restoreScroll(right,personY,selectedPerson,personChanged)
    }
}
