package io.pickmeup.automotive

import android.app.AlertDialog
import android.app.Activity
import android.content.Intent
import android.net.Uri
import io.pickmeup.automotive.contacts.VehicleContactPicker
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.MotionEvent
import android.text.TextUtils
import io.pickmeup.automotive.driving.DrivingPolicy
import io.pickmeup.automotive.driving.DrivingRestrictions
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import io.pickmeup.automotive.navigation.PlaceSearch
import io.pickmeup.automotive.navigation.PlaceSearchResult
import io.pickmeup.automotive.navigation.NavigationState
import io.pickmeup.automotive.navigation.matches
import io.pickmeup.automotive.pickup.Destination
import io.pickmeup.automotive.pickup.Contact
import io.pickmeup.automotive.pickup.VehicleUiState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : Activity() {
    private var contactRefreshJob: kotlinx.coroutines.Job? = null
    private val uiScope=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private val app get()=application as PickMeUpApplication
    private val driving by lazy { DrivingRestrictions(this) }
    private var policy = DrivingPolicy()
    private lateinit var drivingHint: TextView
    private lateinit var welcome: VehicleWelcomeView
    private lateinit var scroll: ScrollView
    private lateinit var headline: TextView
    private lateinit var status: TextView
    private lateinit var readiness: TextView
    private lateinit var delivery: TextView
    private lateinit var navigationInfo: TextView
    private lateinit var etaText: TextView
    private lateinit var readinessPanel: LinearLayout
    private lateinit var connectionBadge: TextView
    private lateinit var destinationName: TextView
    private lateinit var readinessSymbol: VehicleSymbol
    private lateinit var journeyPanel: LinearLayout
    private var inkColor=Color.BLACK
    private var accentColor=Color.BLACK
    private lateinit var pairingButton: Button
    private lateinit var startButton: Button
    private lateinit var endButton: Button
    private lateinit var shareButton: Button
    private lateinit var copyMessageButton: Button
    private lateinit var resendMessageButton: Button
    private lateinit var sendMessageButton: Button
    private var shareActionBusy=false
    private var actionToast: View?=null
    private var actionToastPickupId: String?=null
    private var startActionBusy=false
    private var immediateMessage: Boolean
        get()=app.immediateMessage
        set(value){app.immediateMessage=value}
    private var messageDialogPickupId: String?=null
    private var endDialog: VehicleDialog?=null
    private var endDialogTarget: String?=null
    private lateinit var contacts: Button
    private lateinit var vehicleContacts: Button
    private val contactPicker by lazy { VehicleContactPicker(this) }
    private var pendingContactUri: Uri?=null
    private var importingContact=false
    private var contactDialog: AlertDialog?=null
    private var selectedContactId: String?=null
    private var selectedPlace: Destination?=null
    private lateinit var home: PickupHomeView
    private lateinit var actionBar: LinearLayout
    private lateinit var actionDivider: View
    private lateinit var recipientMap: io.pickmeup.automotive.map.PickupMapPanel
    private lateinit var journeyCards: LinearLayout
    private var lastRecentRequest=0L
    private var pendingPlaceSearch: PlaceSearch?=null
    private var searchWentAway=false
    private var resumed=false
    private var placeSearchNotice: String?=null
    private var preservePlaceSelection=false
    private var placeSearchLaunchJob: kotlinx.coroutines.Job?=null
    private lateinit var cancelPlaceSearch: Button
    private lateinit var pairingHint: TextView
    private var people=emptyList<Contact>()

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(android.R.style.Theme_Material_NoActionBar)
        super.onCreate(savedInstanceState)
        pendingContactUri=savedInstanceState?.getString("selectedContactUri")?.let(Uri::parse)
        selectedContactId=savedInstanceState?.getString("selectedContactId")
        preservePlaceSelection=savedInstanceState?.getBoolean("preservePlaceSelection") ?: false
        if(savedInstanceState?.containsKey("placeName")==true)selectedPlace=runCatching {Destination(io.pickmeup.automotive.navigation.GeoPoint(savedInstanceState.getDouble("placeLatitude"),savedInstanceState.getDouble("placeLongitude")),savedInstanceState.getString("placeName")!!)}.getOrNull()
        savedInstanceState?.getLong("placeSearchStarted",-1L)?.takeIf {it>=0}?.let {started->
            val previous=savedInstanceState.getString("placeSearchPreviousName")?.let {name->runCatching {
                Destination(io.pickmeup.automotive.navigation.GeoPoint(savedInstanceState.getDouble("placeSearchPreviousLat"),savedInstanceState.getDouble("placeSearchPreviousLon")),name)
            }.getOrNull()}
            pendingPlaceSearch=PlaceSearch(started,previous)
            searchWentAway=savedInstanceState.getBoolean("placeSearchWentAway")
        }
        val wide=resources.configuration.screenWidthDp>=560
        val compact=resources.configuration.screenHeightDp<650
        val colors=VehiclePalette()
        val ink=colors.ink;val muted=colors.muted;val canvas=colors.canvas
        val stroke=colors.border;val accent=colors.accent
        inkColor=ink;accentColor=accent
        val regular=Typeface.create(resources.getFont(R.font.asta_sans),400,false)
        val medium=Typeface.create(regular,500,false)
        fun background(fill: Int,border: Int?=null,radius: Int=4)=GradientDrawable().apply {
            setColor(fill);cornerRadius=dp(radius).toFloat();border?.let { setStroke(dp(1),it) }
        }
        val gutter=if(compact)28 else 48
        val layout=LinearLayout(this).apply {
            orientation=LinearLayout.VERTICAL;setPadding(dp(gutter),dp(16),dp(gutter),dp(20))
        }
        fun line(parent: LinearLayout,size: Float,color: Int=ink,bold: Boolean=false)=TextView(this).apply {
            textSize=size;setTextColor(color);includeFontPadding=false;setPadding(0,dp(6),0,dp(6))
            typeface=if(bold)medium else regular; fontVariationSettings="'wght' ${if(bold)500 else 400}"
            parent.addView(this)
        }
        val brandRow=LinearLayout(this).apply {
            orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL
            setPadding(0,0,0,0)
        }
        line(brandRow,28f,accent,bold=true).apply {text="Pick Me Up";letterSpacing=-.035f;typeface=Typeface.create(regular,800,false);fontVariationSettings="'wght' 800"}
        brandRow.addView(View(this),LinearLayout.LayoutParams(0,1,1f))
        connectionBadge=line(brandRow,18f,muted)
        drivingHint=line(layout,18f,muted)
        headline=line(layout,if(compact)26f else 32f,bold=true).apply {
            isAccessibilityHeading=true;(layoutParams as LinearLayout.LayoutParams).topMargin=0
        }
        status=line(layout,18f,muted).apply {maxLines=3}
        cancelPlaceSearch=Button(this).apply {
            text="검색 취소";isAllCaps=false;textSize=18f;minimumHeight=dp(56);setTextColor(ink)
            background=background(colors.soft,radius=8);visibility=View.GONE
            layout.addView(this,LinearLayout.LayoutParams(-2,-2))
            setOnClickListener {
                if(policy.allowsSetup){placeSearchLaunchJob?.cancel();pendingPlaceSearch=null;searchWentAway=false;placeSearchNotice=null;renderVehicle(app.coordinator.state.value)}
            }
        }
        home=PickupHomeView(this,
            choosePlace={place->selectedPlace=place;placeSearchNotice=null;renderVehicle(app.coordinator.state.value)},
            choosePerson={person->selectedContactId=person.id;if(selectedPlace==null)preservePlaceSelection=false;placeSearchNotice=null;renderVehicle(app.coordinator.state.value)},
            startRecent={recent->
                if(policy.allowsSetup && !app.coordinator.state.value.busy)people.firstOrNull {it.id==recent.contactId}?.let {person->
                    selectedContactId=person.id;selectedPlace=recent.destination;renderVehicle(app.coordinator.state.value);startSelected(person)
                }
            },openNavigation=::openPlaceSearch,
            importPerson={vehicleContacts.performClick()},enterPhone=::showPhoneEntry,
            cancelSearch={cancelPlaceSearch.performClick()},
            startPickup={startButton.performClick()},
            changeImmediateMessage={value->if(policy.allowsSetup && !startActionBusy && !app.coordinator.state.value.busy){immediateMessage=value;renderVehicle(app.coordinator.state.value)}})
        val cards=LinearLayout(this).apply {
            orientation=if(wide)LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
            layoutParams=LinearLayout.LayoutParams(-1,-2).apply { topMargin=dp(12) }
            layout.addView(this)
        }
        journeyCards=cards
        fun card()=LinearLayout(this).apply {
            orientation=LinearLayout.VERTICAL
            setPadding(0,dp(6),dp(24),dp(12))
            minimumHeight=0
            layoutParams=if(wide)LinearLayout.LayoutParams(0,-2,1f) else LinearLayout.LayoutParams(-1,-2)
            cards.addView(this)
        }
        journeyPanel=card()
        etaText=line(journeyPanel,if(compact)48f else 64f).apply {
            maxLines=1;ellipsize=TextUtils.TruncateAt.END;letterSpacing=-.02f
            (layoutParams as LinearLayout.LayoutParams).bottomMargin=dp(4)
        }
        destinationName=line(journeyPanel,if(compact)24f else 30f,bold=true).apply {
            maxLines=1;ellipsize=TextUtils.TruncateAt.END
        }
        navigationInfo=line(journeyPanel,if(compact)18f else 22f,muted)
        readinessPanel=card().apply {gravity=Gravity.END or Gravity.CENTER_VERTICAL}
        val readinessRow=LinearLayout(this).apply {
            orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL
            layoutParams=LinearLayout.LayoutParams(-1,-2).apply {topMargin=0;bottomMargin=0}
            readinessPanel.addView(this)
        }
        readinessSymbol=VehicleSymbol(this,"check",ink).apply {
            layoutParams=LinearLayout.LayoutParams(dp(30),dp(30)).apply {marginEnd=dp(14)}
            readinessRow.addView(this)
        }
        readiness=line(readinessRow,if(compact)26f else 34f)
        delivery=line(readinessPanel,18f,muted)
        recipientMap=io.pickmeup.automotive.map.PickupMapPanel(this)
        layout.addView(recipientMap,LinearLayout.LayoutParams(-1,0,1f).apply {topMargin=dp(12)})
        val actions=LinearLayout(this).apply {
            orientation=LinearLayout.HORIZONTAL;gravity=Gravity.CENTER_VERTICAL
            setPadding(dp(gutter),dp(16),dp(gutter),dp(if(compact)20 else 32));setBackgroundColor(canvas)
        }
        actionBar=actions
        actions.addView(brandRow,LinearLayout.LayoutParams(0,-2,1f))
        fun action(primary: Boolean=false)=Button(this).apply {
            isAllCaps=false;textSize=22f;typeface=medium;fontVariationSettings="'wght' 500";minimumHeight=dp(if(compact)64 else 72);minimumWidth=0
            setPadding(dp(24),dp(14),dp(24),dp(14));stateListAnimator=null
            val fill=if(primary)accent else colors.soft
            this.background=StateListDrawable().apply {
                addState(intArrayOf(-android.R.attr.state_enabled),background(colors.soft,radius=4))
                addState(intArrayOf(android.R.attr.state_pressed),background(if(primary)colors.pressedAccent else colors.soft,radius=12))
                addState(intArrayOf(),background(fill,radius=12))
            }
            val foreground=if(primary)colors.onAccent else ink
            setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled),intArrayOf()),intArrayOf(muted,foreground)))
            layoutParams=(if(wide)LinearLayout.LayoutParams(dp(if(primary)340 else 240),-2) else LinearLayout.LayoutParams(0,-2,1f)).apply {
                if(wide)marginEnd=dp(12) else topMargin=dp(10)
            }
            actions.addView(this)
        }
        contacts=action().apply {
            gravity=Gravity.START or Gravity.CENTER_VERTICAL
            background=android.graphics.drawable.RippleDrawable(ColorStateList.valueOf(colors.soft),background(canvas,radius=0),null)
            if(wide)layoutParams=LinearLayout.LayoutParams(0,-2,1f).apply {marginEnd=dp(24)}
            setOnClickListener {
                if (!policy.allowsSetup || app.coordinator.state.value.busy) return@setOnClickListener
                val choices=people.toList()
                val dialog=VehicleDialog(this@MainActivity,"픽업 상대 선택")
                choices.forEach {person->dialog.choice(person.name) {
                    if(policy.allowsSetup && person in people){selectedContactId=person.id;renderVehicle(app.coordinator.state.value)}
                }}
                dialog.actions("새로고침","닫기") {if(policy.allowsSetup)app.appScope.launch {app.coordinator.resume()};true}
                contactDialog=dialog;dialog.show()
            }
        }
        vehicleContacts=action().apply {
            text="연락처에서 선택"
            setOnClickListener {
                val state=app.coordinator.state.value
                if(!policy.allowsSetup || !state.paired || state.busy || state.pickup!=null || state.pendingEnd || state.pendingStart)return@setOnClickListener
                try {
                    if(!contactPicker.available())throw io.pickmeup.automotive.pickup.ApiFailure(503,"CONTACT_PICKER_UNAVAILABLE","연락처 선택 화면을 열 수 없어요. 차량의 연락처 앱과 휴대전화 연결을 확인해 주세요.")
                    startActivityForResult(contactPicker.intent(),701)
                } catch(error: Exception) {app.coordinator.showError(error)}
            }
        }
        startButton=action(true).apply {
            text="도착 예정 알리기"
            setOnClickListener {
                if (!policy.allowsSetup || app.coordinator.state.value.busy || importingContact) return@setOnClickListener
                val selected=people.firstOrNull { it.id==selectedContactId } ?: return@setOnClickListener
                startSelected(selected)
            }
        }
        shareButton=action().apply {text="공유";setOnClickListener {shareMessage(false)}}
        copyMessageButton=action().apply {text="메시지 복사";setOnClickListener {shareMessage(true)}}
        sendMessageButton=action().apply {text="문자 보내기";setOnClickListener {app.coordinator.state.value.pickup?.let {askMessageConfirmation(it)}}}
        resendMessageButton=action().apply {text="문자 재전송";setOnClickListener {if(app.coordinator.state.value.pickup?.shareCodeLocked==true)askAccessRenewal() else askPickupResend()}}
        endButton=action().apply {
            text="공유 종료"
            background=StateListDrawable().apply {
                addState(intArrayOf(-android.R.attr.state_enabled),background(colors.soft,radius=12))
                addState(intArrayOf(android.R.attr.state_pressed),background(colors.dangerBorder,radius=12))
                addState(intArrayOf(),background(colors.dangerSurface,colors.dangerBorder,12))
            }
            setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled),intArrayOf()),intArrayOf(muted,colors.error)))
            (layoutParams as LinearLayout.LayoutParams).marginStart=dp(24)
            setOnClickListener {showEndConfirmation()}
        }
        pairingButton=action(true).apply {
            text="바로 시작"
            setOnClickListener {
                if(policy.allowsSetup && !app.coordinator.state.value.busy)app.appScope.launch {app.coordinator.startGuest()}
            }
        }
        pairingHint=line(layout,18f,muted)
        scroll=object: ScrollView(this) {
            override fun onInterceptTouchEvent(event: MotionEvent): Boolean = if(policy.restricted) false else super.onInterceptTouchEvent(event)
            override fun onTouchEvent(event: MotionEvent): Boolean = if(policy.restricted) false else super.onTouchEvent(event)
        }.apply { addView(layout);isFillViewport=true;isVerticalScrollBarEnabled=false }
        welcome=VehicleWelcomeView(this)
        val root=LinearLayout(this).apply {
            orientation=LinearLayout.VERTICAL;setBackgroundColor(canvas)
            val content=FrameLayout(this@MainActivity).apply {
                addView(scroll,FrameLayout.LayoutParams(-1,-1))
                addView(home,FrameLayout.LayoutParams(-1,-1))
                addView(welcome,FrameLayout.LayoutParams(-1,-1))
            }
            addView(content,LinearLayout.LayoutParams(-1,0,1f))
            actionDivider=View(this@MainActivity).apply {setBackgroundColor(stroke)}
            addView(actionDivider,LinearLayout.LayoutParams(-1,dp(1)));addView(actions)
        }
        if(BuildConfig.FILMING_MODE) {
            setContentView(FrameLayout(this).apply {
                addView(root,FrameLayout.LayoutParams(-1,-1))
                addView(TextView(this@MainActivity).apply {
                    text="시연 · 가상 주행";textSize=14f;setTextColor(muted)
                    setPadding(dp(12),dp(5),dp(12),dp(5));setBackgroundColor(canvas)
                },FrameLayout.LayoutParams(-2,-2,Gravity.TOP or Gravity.END))
            })
        } else setContentView(root)
        uiScope.launch { driving.state.collect {
            policy=it
            if(it.known && it.restricted && pendingPlaceSearch!=null) {
                placeSearchLaunchJob?.cancel()
                pendingPlaceSearch=null;searchWentAway=false;placeSearchNotice="정차 후 장소를 다시 검색해 주세요."
            }
            if(it.restricted) { contactDialog?.dismiss();contactDialog=null;contacts.visibility=View.GONE;scroll.scrollTo(0,0) }
            renderVehicle(app.coordinator.state.value);renderNavigation(app.navigation.state.value)
            consumePickedContact()
        } }
        uiScope.launch { app.coordinator.state.collect { renderVehicle(it) } }
        uiScope.launch { app.navigation.state.collect { renderNavigation(it) } }
        uiScope.launch { while(true) { delay(1_000);renderNavigation(app.navigation.state.value) } }
    }
    override fun onStart() {
        super.onStart();driving.start();app.onUiVisibility(true)
        app.appScope.launch { app.coordinator.resume() }
        contactRefreshJob?.cancel()
        contactRefreshJob=uiScope.launch { while(true) { delay(15_000);if(policy.allowsSetup)app.coordinator.refreshContacts() } }
    }
    override fun onResume() {
        super.onResume();resumed=true
        renderVehicle(app.coordinator.state.value)
        if(pendingPlaceSearch!=null && searchWentAway)app.navigation.requestSnapshot()
        renderNavigation(app.navigation.state.value)
    }
    override fun onPause() {
        resumed=false
        if(pendingPlaceSearch!=null)searchWentAway=true
        super.onPause()
    }
    override fun onStop() { clearActionToast();endDialog?.dismiss();endDialog=null;endDialogTarget=null;contactRefreshJob?.cancel();contactRefreshJob=null; contactDialog?.dismiss();contactDialog=null;driving.close();app.onUiVisibility(false);super.onStop() }
    override fun onActivityResult(requestCode: Int,resultCode: Int,data: Intent?) {
        super.onActivityResult(requestCode,resultCode,data)
        if(requestCode==701 && resultCode==RESULT_OK){pendingContactUri=data?.data;consumePickedContact()}
    }
    private fun consumePickedContact() {
        val uri=pendingContactUri ?: return
        if(!policy.known || importingContact)return
        pendingContactUri=null
        if(!policy.allowsSetup){app.coordinator.showError(io.pickmeup.automotive.pickup.ApiFailure(409,"PARK_REQUIRED","정차 후 연락처를 다시 선택해 주세요."));return}
        importingContact=true;renderVehicle(app.coordinator.state.value)
        uiScope.launch {
            try {
                val chosen=contactPicker.read(uri)
                if(!policy.allowsSetup)return@launch
                val person=app.coordinator.importContact(chosen.name,chosen.phone)
                selectedContactId=person.id
            } catch(error: Exception) {app.coordinator.showError(error)}
            finally {importingContact=false;renderVehicle(app.coordinator.state.value)}
        }
    }
    override fun onSaveInstanceState(outState: Bundle) {
        pendingContactUri?.let {outState.putString("selectedContactUri",it.toString())}
        selectedContactId?.let {outState.putString("selectedContactId",it)}
        selectedPlace?.let {outState.putString("placeName",it.name);outState.putDouble("placeLatitude",it.point.latitude);outState.putDouble("placeLongitude",it.point.longitude)}
        outState.putBoolean("preservePlaceSelection",preservePlaceSelection)
        pendingPlaceSearch?.let {search->
            outState.putLong("placeSearchStarted",search.startedElapsedAt);outState.putBoolean("placeSearchWentAway",searchWentAway)
            search.previousDestination?.let {place->outState.putString("placeSearchPreviousName",place.name);outState.putDouble("placeSearchPreviousLat",place.point.latitude);outState.putDouble("placeSearchPreviousLon",place.point.longitude)}
        }
        super.onSaveInstanceState(outState)
    }
    private fun canShare(id: String): Boolean {
        val state=app.coordinator.state.value
        return resumed && policy.allowsSetup && state.pickup?.id==id && !state.pendingEnd && !state.busy && state.pickup.expiresAt>System.currentTimeMillis()
    }
    private fun copyShareMessage(value: io.pickmeup.automotive.pickup.ShareMessage) {
        if(!canShare(value.pickupId))return
        val clip=android.content.ClipData.newPlainText("픽미업 공유 메시지",value.message)
        if(android.os.Build.VERSION.SDK_INT>=33)clip.description.extras=android.os.PersistableBundle().apply {putBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE,true)}
        getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(clip)
        showActionToast(value.pickupId,"메시지를 복사했어요")
    }
    private fun clearActionToast() {
        actionToast?.let {(it.parent as? android.view.ViewGroup)?.removeView(it)}
        actionToast=null;actionToastPickupId=null
    }
    private fun showActionToast(pickupId: String?,message: String) {
        val host=window.decorView as? FrameLayout ?: return
        clearActionToast()
        val colors=VehiclePalette()
        val toast=LinearLayout(this).apply {
            gravity=Gravity.CENTER_VERTICAL;setPadding(dp(24),dp(18),dp(28),dp(18))
            background=GradientDrawable().apply {setColor(colors.surface);cornerRadius=dp(36).toFloat();setStroke(dp(1),colors.border)}
            elevation=dp(16).toFloat();isClickable=false;isFocusable=false
            addView(VehicleSymbol(this@MainActivity,"check",colors.accent),LinearLayout.LayoutParams(dp(28),dp(28)).apply {marginEnd=dp(12)})
            addView(TextView(this@MainActivity).apply {
                text=message;textSize=22f;setTextColor(colors.ink);includeFontPadding=false
                typeface=Typeface.create(resources.getFont(R.font.asta_sans),500,false)
                accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE
            })
        }
        actionToast=toast;actionToastPickupId=pickupId
        host.addView(toast,FrameLayout.LayoutParams(-2,-2,Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {bottomMargin=dp(112)})
        toast.postDelayed({if(actionToast===toast)clearActionToast()},2_600)
    }
    private fun showShareFallback(value: io.pickmeup.automotive.pickup.ShareMessage) {
        if(!canShare(value.pickupId))return
        val dialog=VehicleDialog(this,"픽업 링크 공유","이 차량에서는 공유 화면을 열 수 없어요. 메시지를 복사해 전달하세요.")
        dialog.message(value.message)
        dialog.actions("메시지 복사","닫기") {copyShareMessage(value);true}
        dialog.setOnDismissListener {if(contactDialog===dialog){contactDialog=null;messageDialogPickupId=null}}
        contactDialog=dialog;messageDialogPickupId=value.pickupId;dialog.show()
    }
    private fun askAccessRenewal() {
        val value=app.coordinator.state.value.pickup ?: return
        if(!canShare(value.id)||!value.shareCodeLocked||value.shareRenewalsRemaining<1||value.shareRenewAfter>System.currentTimeMillis())return
        val dialog=VehicleDialog(this,"새 인증 링크를 만들까요?","기존 링크·코드는 사용할 수 없게 돼요. 길안내와 차량 연결은 유지해요.")
        dialog.recipient(value.recipientName,null,value.destination.name)
        dialog.note("상대의 기존 위치 공유·알림도 종료돼요. 새 링크를 전달하면 다시 선택할 수 있어요. 추가 문자는 요청하지 않아요.")
        dialog.actions("새 링크 만들기","취소") {
            app.appScope.launch {
                if(!canShare(value.id))return@launch
                shareActionBusy=true;renderVehicle(app.coordinator.state.value)
                runCatching {app.coordinator.renewAccess(value.id);app.coordinator.shareMessage(value.id)}
                    .onSuccess {if(canShare(value.id)){showActionToast(value.id,"새 인증 링크를 만들었어요");showRenewedLink(it)}}
                    .onFailure(app.coordinator::showError)
                shareActionBusy=false;renderVehicle(app.coordinator.state.value)
            };true
        }
        dialog.setOnDismissListener {if(contactDialog===dialog){contactDialog=null;messageDialogPickupId=null}}
        contactDialog=dialog;messageDialogPickupId=value.id;dialog.show()
    }
    private fun showRenewedLink(value: io.pickmeup.automotive.pickup.ShareMessage) {
        if(!canShare(value.pickupId))return
        val dialog=VehicleDialog(this,"새 링크를 전달해 주세요","새 인증코드가 포함돼 있어요. 상대는 새 링크에서 다시 확인할 수 있어요.")
        dialog.message(value.message)
        dialog.actions("메시지 복사","닫기") {copyShareMessage(value);true}
        dialog.setOnDismissListener {if(contactDialog===dialog){contactDialog=null;messageDialogPickupId=null}}
        contactDialog=dialog;messageDialogPickupId=value.pickupId;dialog.show()
    }
    private fun askPickupResend() {
        val value=app.coordinator.state.value.pickup ?: return
        if(!canShare(value.id)||value.messageResendsRemaining<1||value.messageResendAfter>System.currentTimeMillis())return
        val dialog=VehicleDialog(this,"도착 안내를 다시 보낼까요?","기존 링크와 인증코드를 담아 한 번 더 요청해요.")
        dialog.recipient(value.recipientName,null,value.destination.name);dialog.note("재전송은 1회까지 가능해요.")
        dialog.actions("다시 보내기","취소") {
            if(canShare(value.id))app.appScope.launch {
                runCatching {app.coordinator.resendMessage(value.id)}.onSuccess {if(canShare(value.id))showActionToast(value.id,"문자 재전송을 요청했어요")}.onFailure(app.coordinator::showError)
            };true
        }
        contactDialog=dialog;messageDialogPickupId=value.id;dialog.show()
    }
    private fun endTarget(state: VehicleUiState): String? = when {
        state.pickup!=null->"pickup:${state.pickup.id}"
        state.preparingRoute->"preparing"
        state.pendingStart->"starting"
        state.pendingEnd->"ending"
        else->null
    }
    private fun showEndConfirmation() {
        val state=app.coordinator.state.value
        val target=endTarget(state) ?: return
        if(!resumed || endDialog?.isShowing==true || contactDialog?.isShowing==true)return
        if(state.pendingEnd) {
            app.appScope.launch {runCatching {app.coordinator.endShare()}.onFailure(app.coordinator::showError)}
            return
        }
        val preparing=state.preparingRoute
        val dialog=VehicleDialog(this,if(preparing)"알림 준비를 취소할까요?" else "공유를 종료할까요?",
            if(preparing)"아직 시작하지 않은 도착 알림 준비를 취소해요." else "상대에게 보이는 차량 위치와 도착 시간 공유를 끝내요.",destructive=true)
        state.pickup?.let {dialog.recipient(it.recipientName,null,it.destination.name)}
        dialog.note("길안내는 계속돼요.")
        dialog.actions(if(preparing)"준비 취소" else "공유 종료",if(preparing)"계속 준비" else "계속 공유") {
            if(resumed && endTarget(app.coordinator.state.value)==target)
                app.appScope.launch {runCatching {app.coordinator.endShare()}.onFailure(app.coordinator::showError)}
            true
        }
        dialog.setOnDismissListener {if(endDialog===dialog){endDialog=null;endDialogTarget=null}}
        endDialog=dialog;endDialogTarget=target;dialog.show()
    }
    private fun shareMessage(copy: Boolean) {
        val id=app.coordinator.state.value.pickup?.id ?: return
        if(!canShare(id)||shareActionBusy)return
        shareActionBusy=true;renderVehicle(app.coordinator.state.value)
        uiScope.launch {
            try {
                val value=app.coordinator.shareMessage(id)
                if(!canShare(id))return@launch
                if(copy) {
                    copyShareMessage(value)
                } else {
                    val intent=Intent(Intent.ACTION_SEND).apply {type="text/plain";putExtra(Intent.EXTRA_TEXT,value.message);putExtra(Intent.EXTRA_SUBJECT,"픽미업 도착 안내")}
                    try {startActivity(Intent.createChooser(intent,"픽업 링크 공유"))}
                    catch(error: android.content.ActivityNotFoundException){showShareFallback(value)}
                    catch(error: SecurityException){showShareFallback(value)}
                }
            } catch(cancelled: kotlinx.coroutines.CancellationException){throw cancelled}
            catch(error: Exception){app.coordinator.showError(error)}
            finally {shareActionBusy=false;renderVehicle(app.coordinator.state.value)}
        }
    }
    private fun askMessageConfirmation(pickup: io.pickmeup.automotive.pickup.Pickup) {
        if(!canShare(pickup.id)||pickup.smsConfirmed||shareActionBusy||contactDialog?.isShowing==true)return
        shareActionBusy=true;renderVehicle(app.coordinator.state.value)
        uiScope.launch {
            var showing=false
            try {
                val value=app.coordinator.shareMessage(pickup.id)
                if(!canShare(pickup.id)||app.coordinator.state.value.pickup?.smsConfirmed!=false)return@launch
                var sending=false
                val dialog=VehicleDialog(this@MainActivity,"도착 안내를 보낼까요?","링크·인증코드를 담은 안내와 도착 알림을 문자로 보내요.")
                dialog.recipient(value.recipientName,value.maskedPhone,pickup.destination.name)
                dialog.note("나중에를 선택해도 공유는 계속돼요.")
                dialog.actions("보내기","나중에") {
                    if(canShare(pickup.id)) {
                        sending=true
                        uiScope.launch {
                            try {
                                app.coordinator.confirmMessage(pickup.id)
                            }
                            catch(cancelled: kotlinx.coroutines.CancellationException){throw cancelled}
                            catch(error: Exception){app.coordinator.showError(error)}
                            finally {shareActionBusy=false;renderVehicle(app.coordinator.state.value)}
                        }
                    }
                    true
                }
                dialog.setOnDismissListener {if(contactDialog===dialog){contactDialog=null;messageDialogPickupId=null};if(!sending){shareActionBusy=false;renderVehicle(app.coordinator.state.value)}}
                contactDialog=dialog;messageDialogPickupId=pickup.id;showing=true;dialog.show()
            } catch(cancelled: kotlinx.coroutines.CancellationException){throw cancelled}
            catch(error: Exception){app.coordinator.showError(error)}
            finally {if(!showing){shareActionBusy=false;renderVehicle(app.coordinator.state.value)}}
        }
    }
    private fun startSelected(person: Contact) {
        val place=selectedPlace ?: return
        fun available(): Boolean {
            val state=app.coordinator.state.value
            return resumed && policy.allowsSetup && state.paired && !startActionBusy && !state.busy &&
                state.pickup==null && !state.pendingStart && !state.pendingEnd && people.any {it.id==person.id}
        }
        if(!available() || contactDialog?.isShowing==true)return
        fun start(sendMessage: Boolean) {
            if(!available())return
            startActionBusy=true;renderVehicle(app.coordinator.state.value)
            val application=app
            application.appScope.launch {
                try {application.startPlannedPickup(person.id,place,sendMessage)}
                catch(cancelled: kotlinx.coroutines.CancellationException){throw cancelled}
                catch(error: Exception){application.coordinator.showError(error)}
                finally {startActionBusy=false;if(!isDestroyed)renderVehicle(application.coordinator.state.value)}
            }
        }
        if(immediateMessage)start(true) else {
            val dialog=VehicleDialog(this,"도착 안내를 보낼까요?","길안내가 준비되면 링크·인증코드와 도착 알림을 문자로 보내요.")
            dialog.recipient(person.name,null,place.name)
            val current=app.navigation.state.value.destination
            if(current!=null && !place.matches(Destination(current.point,current.name)))dialog.note("현재 길안내 목적지를 선택한 만날 곳으로 바꿔요.")
            dialog.note("문자 없이 시작하면 공유·메시지 복사로 직접 전달할 수 있어요.")
            dialog.actions("보내고 시작","문자 없이 시작",onSecondary={start(false)}) {start(true);true}
            dialog.setOnDismissListener {if(contactDialog===dialog)contactDialog=null}
            contactDialog=dialog;dialog.show()
        }
    }
    private fun openPlaceSearch() {
        val state=app.coordinator.state.value
        if(!policy.allowsSetup || !state.paired || state.busy || importingContact || state.pickup!=null || state.pendingStart || state.pendingEnd || pendingPlaceSearch!=null)return
        val current=app.navigation.state.value.destination?.let {Destination(it.point,it.name)}
        pendingPlaceSearch=PlaceSearch(android.os.SystemClock.elapsedRealtime(),current);searchWentAway=false;preservePlaceSelection=true
        placeSearchNotice="내비에서 장소를 선택하고 안내를 시작한 뒤 픽미업으로 돌아와 주세요."
        renderVehicle(state)
        placeSearchLaunchJob?.cancel()
        val request=pendingPlaceSearch
        placeSearchLaunchJob=app.appScope.launch {
            try {app.openPlaceSelection()}
            catch(cancelled: kotlinx.coroutines.CancellationException){throw cancelled}
            catch(error: Exception){if(pendingPlaceSearch===request){pendingPlaceSearch=null;placeSearchNotice=null;app.coordinator.showError(error)}}
        }
    }
    private fun consumePlaceSearch(state: NavigationState) {
        val request=pendingPlaceSearch ?: return
        if(!resumed || !policy.allowsSetup)return
        val now=android.os.SystemClock.elapsedRealtime()
        if(!searchWentAway) {
            if(now-request.startedElapsedAt>8_000) {
                pendingPlaceSearch=null;placeSearchNotice="내비 앱을 열지 못했어요. 다시 시도해 주세요."
            }
            return
        }
        when(val result=request.result(state,now)) {
            PlaceSearchResult.Waiting->return
            is PlaceSearchResult.Selected->{selectedPlace=result.destination;placeSearchNotice=null}
            PlaceSearchResult.Unchanged->placeSearchNotice="새로 안내를 시작한 장소가 없어 기존 선택을 유지했어요. 내비에서 목적지를 설정하고 안내를 시작해 주세요."
            PlaceSearchResult.Expired->placeSearchNotice="장소 검색 시간이 지났어요. 다시 검색해 주세요."
        }
        pendingPlaceSearch=null;searchWentAway=false
    }
    private fun renderStatus(state: VehicleUiState) {
        status.text=state.error ?: if(state.pendingEnd || state.pendingStart || state.preparingRoute)state.message else if(policy.allowsSetup)placeSearchNotice.orEmpty() else ""
        status.visibility=if(status.text.isNotBlank())View.VISIBLE else View.GONE
        cancelPlaceSearch.visibility=if(policy.allowsSetup && pendingPlaceSearch!=null)View.VISIBLE else View.GONE
    }
    private fun showPhoneEntry() {
        val state=app.coordinator.state.value
        if(!policy.allowsSetup || state.busy || state.pickup!=null || importingContact)return
        val dialog=VehicleDialog(this,"번호로 상대 추가","이름은 선택이에요. 휴대전화 번호를 입력해 주세요.")
        val name=dialog.input("이름 (선택)","예: 지연이",android.text.InputType.TYPE_CLASS_TEXT,30)
        val number=dialog.input("휴대전화 번호","010-0000-0000",android.text.InputType.TYPE_CLASS_PHONE,20)
        dialog.actions("상대 추가","취소") {
            if(!policy.allowsSetup || importingContact)return@actions true
            val phone=number.text.toString().replace(Regex("[-\\s]"),"")
            if(!Regex("01[016789][0-9]{7,8}").matches(phone)){dialog.inputError(number,"국내 휴대전화 번호를 입력해 주세요");return@actions false}
            val display=name.text.toString().trim().ifEmpty {"${phone.takeLast(4)}님"}
            importingContact=true;dialog.dismiss();renderVehicle(app.coordinator.state.value)
            uiScope.launch {
                try {val person=app.coordinator.importContact(display,phone);if(policy.allowsSetup)selectedContactId=person.id}
                catch(error:Exception){app.coordinator.showError(error)}
                finally {importingContact=false;renderVehicle(app.coordinator.state.value)}
            }
            true
        }
        contactDialog=dialog;dialog.show()
    }
    private fun dp(value: Int)=(value*resources.displayMetrics.density).toInt()
    private fun renderVehicle(state: VehicleUiState) {
        val pickup=state.pickup
        if(endDialogTarget!=null && (endTarget(state)!=endDialogTarget || state.pendingEnd))endDialog?.dismiss()
        if(actionToastPickupId!=null && (pickup?.id!=actionToastPickupId || state.pendingEnd))clearActionToast()
        if(messageDialogPickupId!=null && (pickup?.id!=messageDialogPickupId || state.pendingEnd)) {
            messageDialogPickupId=null;val dialog=contactDialog;contactDialog=null;dialog?.dismiss()
        }
        if(pickup!=null || state.pendingStart || state.pendingEnd || state.preparingRoute) {placeSearchLaunchJob?.cancel();pendingPlaceSearch=null;searchWentAway=false;placeSearchNotice=null}
        drivingHint.visibility=if(policy.restricted && pickup==null)View.VISIBLE else View.GONE
        drivingHint.text=if(policy.known) "설정은 정차 후 이용해 주세요" else "차량 상태 확인 중"
        headline.text=when { state.preparingRoute->"길안내·알림 준비 중";state.pendingEnd->"공유 종료 확인 중";state.pendingStart->"공유 시작 확인 중";pickup!=null->"${pickup.recipientName} 픽업";policy.restricted && state.paired->"픽업 없음";policy.restricted->"정차 후 시작하세요";state.paired->"픽업을 시작하세요";else->"픽미업" }
        connectionBadge.text=when {state.error!=null->"연결 확인 중";pickup!=null && state.streamConnected->"공유 중";pickup!=null->"연결 확인 중";state.paired->"차량 연결됨";else->"차량 연결 전"}
        connectionBadge.visibility=if(state.error!=null || (pickup!=null && !state.streamConnected))View.VISIBLE else View.GONE
        readinessPanel.visibility=if(pickup!=null)View.VISIBLE else View.GONE
        journeyPanel.minimumHeight=0
        readinessPanel.minimumHeight=journeyPanel.minimumHeight
        readiness.text=when(pickup?.readiness){"OUTSIDE"->"나왔어요";"PREPARING"->"준비 중이에요";else->if(pickup!=null)"응답 대기" else "공유 전"}
        readinessSymbol.kind=if(pickup?.readiness=="OUTSIDE")"check" else "person"
        readinessSymbol.visibility=if(pickup?.readiness=="OUTSIDE")View.VISIBLE else View.GONE
        readiness.setTextColor(if(pickup?.readiness=="OUTSIDE")accentColor else inkColor)
        delivery.text=pickup?.let {io.pickmeup.automotive.pickup.deliveryStatus(it,System.currentTimeMillis())}.orEmpty()
        delivery.visibility=if(delivery.text.isNotBlank())View.VISIBLE else View.GONE
        renderStatus(state)
        if(people!=state.contacts) {
            people=state.contacts
            if(people.none {it.id==selectedContactId})selectedContactId=people.firstOrNull()?.id
        }
        vehicleContacts.visibility=View.GONE
        vehicleContacts.isEnabled=!state.busy && !importingContact
        contacts.text="다른 상대"
        contacts.visibility=View.GONE
        contacts.isEnabled=!state.busy && !state.pendingEnd && !importingContact
        val person=people.firstOrNull {it.id==selectedContactId}
        startButton.visibility=View.GONE
        updateStartAvailability()
        endButton.visibility=if(pickup!=null || state.pendingEnd || state.pendingStart || state.preparingRoute)View.VISIBLE else View.GONE
        endButton.text=if(state.preparingRoute)"알림 준비 취소" else if(state.pendingEnd)"종료 다시 시도" else "공유 종료"
        endButton.isEnabled=!state.busy || state.preparingRoute
        val manualSharing=pickup!=null && policy.allowsSetup && !state.pendingEnd && !state.pendingStart
        listOf(shareButton,copyMessageButton).forEach {it.visibility=if(manualSharing)View.VISIBLE else View.GONE;it.isEnabled=!shareActionBusy && !state.busy}
        sendMessageButton.visibility=if(manualSharing && pickup?.smsConfirmed==false && !pickup.shareCodeLocked)View.VISIBLE else View.GONE
        sendMessageButton.isEnabled=!shareActionBusy && !state.busy
        pairingButton.visibility=if(policy.allowsSetup && !state.paired)View.VISIBLE else View.GONE
        pairingButton.isEnabled=!state.busy
        pairingButton.text=if(state.busy)"준비 중…" else "바로 시작"
        resendMessageButton.visibility=if(manualSharing && (pickup?.smsConfirmed==true||pickup?.shareCodeLocked==true))View.VISIBLE else View.GONE
        resendMessageButton.isEnabled=!shareActionBusy&&!state.busy&&pickup!=null&&
            (if(pickup.shareCodeLocked)pickup.shareRenewalsRemaining>0&&pickup.shareRenewAfter<=System.currentTimeMillis()
             else pickup.messageResendsRemaining==1&&pickup.messageResendAfter<=System.currentTimeMillis())
        resendMessageButton.text=when {
            pickup?.shareCodeLocked==true&&pickup.shareRenewalsRemaining==0->"링크 교체 2회 사용"
            pickup?.shareCodeLocked==true&&pickup.shareRenewAfter>System.currentTimeMillis()->"잠금 복구 잠시 대기"
            pickup?.shareCodeLocked==true->"인증 잠금 풀기"
            pickup?.messageResendsRemaining==0->"재전송 1회 사용"
            pickup!=null&&pickup.messageResendAfter>System.currentTimeMillis()->"${(pickup.messageResendAfter-System.currentTimeMillis()+999)/1000}초 후 재전송"
            else->"문자 재전송"
        }
        pairingHint.visibility=View.GONE
        listOf(headline,readiness,status,drivingHint).forEach { line ->
            line.maxLines=if(policy.restricted)1 else if(line==status)3 else 2
            line.ellipsize=if(policy.restricted)TextUtils.TruncateAt.END else null
            line.text=policy.text(line.text)
        }
        renderNavigation(app.navigation.state.value)
        if(pickup!=null && state.messageNoticePickupId==pickup.id && canShare(pickup.id) && contactDialog?.isShowing!=true && endDialog?.isShowing!=true) {
            if(app.coordinator.consumeMessageNotice(pickup.id))showActionToast(pickup.id,"문자 발송을 요청했어요")
        }
    }
    private fun renderNavigation(state: NavigationState) {
        val vehicle=app.coordinator.state.value
        consumePlaceSearch(state);renderStatus(vehicle)
        recipientMap.render(vehicle.pickup,state,policy.allowsSetup)
        val idle=policy.allowsSetup && vehicle.pickup==null && !vehicle.pendingEnd && !vehicle.pendingStart && !vehicle.preparingRoute
        if(selectedPlace==null && pendingPlaceSearch==null && !preservePlaceSelection)selectedPlace=state.destination?.let {Destination(it.point,it.name)} ?: people.firstOrNull {it.id==selectedContactId}?.meetingPlace
        val showWelcome=policy.allowsSetup && !vehicle.paired && vehicle.pickup==null && !vehicle.pendingEnd && !vehicle.pendingStart && !vehicle.preparingRoute
        if(showWelcome)connectionBadge.visibility=View.GONE
        val showHome=idle && vehicle.paired
        welcome.visibility=if(showWelcome)View.VISIBLE else View.GONE
        pairingButton.visibility=if(showWelcome)View.VISIBLE else View.GONE
        home.visibility=if(showHome)View.VISIBLE else View.GONE
        scroll.visibility=if(showHome || showWelcome)View.GONE else View.VISIBLE
        headline.visibility=if(showHome)View.GONE else View.VISIBLE
        journeyCards.visibility=if(showHome)View.GONE else View.VISIBLE
        journeyPanel.visibility=if(showHome)View.GONE else View.VISIBLE
        actionBar.visibility=if(showHome)View.GONE else View.VISIBLE
        actionDivider.visibility=if(showWelcome)View.GONE else actionBar.visibility
        if(showHome)pairingHint.visibility=View.GONE
        if(showHome) {
            val person=people.firstOrNull {it.id==selectedContactId}
            val ready=selectedPlace!=null && person!=null && state.connection==io.pickmeup.automotive.navigation.NavigationConnection.CONNECTED && !vehicle.busy && !startActionBusy && !importingContact && pendingPlaceSearch==null
            val disabledReason=when {pendingPlaceSearch!=null->"장소 검색 결과를 기다리고 있어요";importingContact->"연락처를 불러오고 있어요";vehicle.busy->"픽업 상태를 확인하고 있어요";state.connection!=io.pickmeup.automotive.navigation.NavigationConnection.CONNECTED->"내비 연결을 기다리고 있어요";else->null}
            home.render(people,vehicle.recentPickups,selectedContactId,selectedPlace,state.destination?.let {Destination(it.point,it.name)},state.recentDestinations,vehicle.busy || startActionBusy || importingContact || pendingPlaceSearch!=null,ready,disabledReason,status.text.toString().takeIf {it.isNotBlank()},pendingPlaceSearch!=null,immediateMessage)
            val now=android.os.SystemClock.elapsedRealtime()
            if(!vehicle.busy && state.connection==io.pickmeup.automotive.navigation.NavigationConnection.CONNECTED && now-lastRecentRequest>15_000) {
                lastRecentRequest=now;app.navigation.requestRecentDestinations()
            }
        }
        updateStartAvailability()
        val delayed=state.isStale(System.currentTimeMillis()) || state.isEtaStale(System.currentTimeMillis())
        val compact=resources.configuration.screenHeightDp<650
        val primaryEta=state.destination!=null && !state.arrived && !delayed
        etaText.textSize=if(primaryEta)if(compact)40f else 48f else if(compact)28f else 38f
        etaText.text=when {
            state.destination==null && !state.routeKnown->if(state.error!=null)"내비 연결 확인" else "내비 정보 수신 중"
            state.destination==null->if(people.firstOrNull {it.id==selectedContactId}?.meetingPlace!=null)"만날 곳으로 출발하세요" else "목적지를 설정해 주세요"
            delayed->"갱신을 기다려요"
            state.arrived->"도착했어요"
            else->"약 ${maxOf(1,(state.destination.remainingSeconds+59)/60)}분 후 도착"
        }
        etaText.contentDescription="도착 예상: ${etaText.text}"
        destinationName.text=state.destination?.name ?: ""
        destinationName.visibility=if(state.destination!=null)View.VISIBLE else View.GONE
        navigationInfo.text=state.destination?.let {
            if(delayed)"최신 내비 정보를 확인하고 있어요" else if(state.arrived)"탑승 후 공유를 종료해 주세요" else {
                val distance=if(it.remainingMeters>=1000)String.format(java.util.Locale.KOREA,"%.1f km",it.remainingMeters/1000.0) else "${it.remainingMeters} m"
                "남은 거리 $distance"
            }
        } ?: if(people.firstOrNull {it.id==selectedContactId}?.meetingPlace!=null)"저장한 만날 곳으로 길안내와 도착 알림을 시작하세요" else "순정 내비에서 만날 곳을 선택한 뒤 저장하세요"
        navigationInfo.visibility=if(state.destination==null||delayed||state.arrived)View.VISIBLE else View.GONE
        navigationInfo.maxLines=if(policy.restricted)2 else Int.MAX_VALUE
        navigationInfo.ellipsize=if(policy.restricted)TextUtils.TruncateAt.END else null
        navigationInfo.text=policy.text(navigationInfo.text)
        destinationName.text=policy.text(destinationName.text)
    }
    private fun updateStartAvailability() {
        val vehicle=app.coordinator.state.value
        val nav=app.navigation.state.value
        val person=people.firstOrNull {it.id==selectedContactId}
        startButton.isEnabled=selectedPlace!=null && nav.connection==io.pickmeup.automotive.navigation.NavigationConnection.CONNECTED &&
            person!=null && !vehicle.busy && !vehicle.pendingEnd && !vehicle.pendingStart && !importingContact
        startButton.text=if(vehicle.preparingRoute)"길안내 준비 중…" else "길안내·도착 알림 시작"
    }

    override fun onDestroy() { uiScope.cancel();super.onDestroy() }
}
