/* A pinned, recipient-selected point only. No GPS, credentials or native bridge. */
(function(root){
 class PickupWaitingRoadview {
  constructor(maps,ui,timeoutMs=15000){this.maps=maps;this.ui=ui;this.timeoutMs=timeoutMs;this.key='';this.target=null;this.parked=false;this.active=false;this.epoch=0;this.road=null;this.home=null;this.cleanup=()=>{};ui.retry.onclick=()=>{if(this.parked)this.open()};ui.home.onclick=()=>this.restore();}
  update(payload){
   const p=payload?.manual?payload.recipient:null;
   const valid=p&&Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180;
   const key=valid?`${p.latitude},${p.longitude}`:'';
   this.parked=payload?.parked===true;
   this.ui.photo.inert=!this.parked;this.ui.photo.style.pointerEvents=this.parked?'auto':'none';this.ui.retry.disabled=!this.parked;this.ui.home.hidden=!this.home||!this.parked;this.ui.home.disabled=!this.parked;
   if(!valid){this.close();this.key='';this.target=null;return;}
   if(key===this.key)return;
   this.close();this.key=key;this.target={...p};this.open();
  }
  close(){this.epoch++;this.active=false;this.cleanup();this.cleanup=()=>{};this.road=null;this.home=null;this.ui.home.hidden=true;this.ui.pane.hidden=true;this.ui.retry.hidden=true;this.ui.photo.style.visibility='hidden';this.ui.photo.replaceChildren();this.ui.split(false);}
  restore(){if(!this.parked||!this.active||!this.home)return;this.open(this.home);}
  resize(){if(this.active)this.road?.relayout();}
  open(startingHome=null){
   if(!this.target)return;this.close();this.active=true;const epoch=this.epoch,point={...this.target},maps=this.maps,ui=this.ui;
   ui.split(true);ui.pane.hidden=false;ui.retry.hidden=true;ui.status.hidden=false;ui.status.textContent='기다릴 곳 주변을 불러오고 있어요…';ui.photo.style.visibility='hidden';
   let road,marker,wanted=0,settled=false;
   const current=()=>this.active&&this.epoch===epoch;
   const fail=message=>{if(!current())return;settled=true;ui.photo.style.visibility='hidden';marker?.setMap(null);ui.status.hidden=false;ui.status.textContent=message;ui.retry.hidden=false;clearTimeout(timer);};
   const timer=setTimeout(()=>{if(!settled)fail('주변 사진을 불러오지 못했어요. 지도로 확인해 주세요.');},this.timeoutMs);
   const position=new maps.LatLng(point.latitude,point.longitude);
   const show=()=>{
    if(!current()||settled||!wanted||String(road.getPanoId())!==String(wanted))return;
    try{
     const p=road.getPosition(),rad=Math.PI/180,dy=(p.getLat()-point.latitude)*rad,dx=(p.getLng()-point.longitude)*rad;
     const h=Math.sin(dy/2)**2+Math.cos(point.latitude*rad)*Math.cos(p.getLat()*rad)*Math.sin(dx/2)**2;
     if(!Number.isFinite(h)||6371000*2*Math.asin(Math.sqrt(Math.min(1,h)))>85){fail('가까운 거리 사진이 없어요. 지도에서 핀을 확인해 주세요.');return;}
     marker?.setMap(null);const label=document.createElement('div');label.className='roadview-waiting-pin';label.textContent='기다릴 위치 부근';
     marker=new maps.CustomOverlay({position,content:label,yAnchor:.5,zIndex:6});marker.setAltitude(0);marker.setRange(90);marker.setMap(road);
     const view=startingHome?.view??road.getProjection().viewpointFromCoords(position,0);if(Number.isFinite(view.pan))road.setViewpoint({...view,zoom:0});
     this.home={epoch,id:wanted,position:new maps.LatLng(p.getLat(),p.getLng()),view:Number.isFinite(view.pan)?{...view,zoom:0}:road.getViewpoint()};ui.home.hidden=!this.parked;
     settled=true;clearTimeout(timer);ui.photo.style.visibility='visible';ui.status.hidden=true;
    }catch{/* Wait for init / panoid_changed until the bounded timeout. */}
   };
   this.cleanup=()=>{clearTimeout(timer);marker?.setMap(null);if(road){maps.event.removeListener(road,'init',show);maps.event.removeListener(road,'panoid_changed',show);}};
   try{
    road=new maps.Roadview(ui.photo,{pan:0,tilt:0,zoom:0});this.road=road;maps.event.addListener(road,'init',show);maps.event.addListener(road,'panoid_changed',show);
    const load=id=>{if(!current()||settled)return;const n=typeof id==='string'&&/^\d+$/.test(id)?Number(id):id;
     if(!Number.isSafeInteger(n)||n<=0){fail('이 위치 근처에는 로드뷰가 없어요. 지도에서 핀을 확인해 주세요.');return;}
     wanted=n;road.relayout();road.setPanoId(n,startingHome?.position??position);
    };
    if(startingHome)load(startingHome.id);else new maps.RoadviewClient().getNearestPanoId(position,50,load);
   }catch{fail('주변 사진을 불러오지 못했어요. 지도로 확인해 주세요.');}
  }
 }
 root.PickupWaitingRoadview=PickupWaitingRoadview;
})(typeof window==='undefined'?globalThis:window);
