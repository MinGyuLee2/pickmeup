import { useEffect, useRef, useState } from 'react';
import {api,recipientPath,type Pickup} from './api';
import {WaitingPinSelection,type PinSelectionState} from './WaitingPinSelection';
import './unified-pin.css';
import {WaitingLocationPrompt,type LocationPromptAction} from './WaitingLocationPrompt';
import { Icon } from './Design';
import {MapViewport} from './MapViewport';
import { vehicleBadge } from './VehicleVisual';
import {PlannedRouteLine} from './PlannedRouteLine';

declare global { interface Window { kakao?:any } }
let loader:Promise<any>|undefined;
export function loadMap() {
  const key=import.meta.env.VITE_KAKAO_MAP_KEY as string|undefined;
  if(!key)return Promise.resolve(null);
  if(!loader)loader=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src=`https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&appkey=${encodeURIComponent(key)}`;
    const timeout=setTimeout(()=>reject(new Error('지도 연결 시간 초과')),12_000);
    script.onload=()=>{if(!window.kakao?.maps){clearTimeout(timeout);reject(new Error('지도 연결 실패'));return;}
      window.kakao.maps.load(()=>{clearTimeout(timeout);resolve(window.kakao.maps);});};
    script.onerror=()=>{clearTimeout(timeout);reject(new Error('지도 연결 실패'));};document.head.appendChild(script);
  });
  return loader;
}
export function PickupMap({pickup,stale,onPickup,locationRequest=0}:{pickup:Pickup;stale:boolean;onPickup?:(value:Pickup)=>void;locationRequest?:number}) {
  const [selection,setSelection]=useState<PinSelectionState>({draft:null,locating:false,error:''});
  const [saving,setSaving]=useState(false),[agreed,setAgreed]=useState(false),[saveError,setSaveError]=useState('');
  const [prompt,setPrompt]=useState<LocationPromptAction|null>(null),[editing,setEditing]=useState(false);
  const editingRef=useRef(false),consentPending=useRef(false);
  const [consentBusy,setConsentBusy]=useState(false),[consentError,setConsentError]=useState('');
  const editor=useRef<WaitingPinSelection|null>(null),latest=useRef(pickup),busy=useRef(false),editEpoch=useRef(0),waitingBar=useRef<HTMLDivElement>(null);
  latest.current=pickup;
  useEffect(()=>{const control=new WaitingPinSelection(setSelection);editor.current=control;setSelection(control.state);editingRef.current=false;setEditing(false);setPrompt(pickup.waitingPoint||pickup.waitingPointConsent?null:'intro');consentPending.current=false;setConsentBusy(false);setConsentError('');setAgreed(false);setSaveError('');busy.current=false;setSaving(false);editEpoch.current++;
    return()=>{control.dispose();editor.current=null;editEpoch.current++;};},[pickup.id]);
  async function commit(remove=false){
    const control=editor.current,draft=control?.state.draft,id=pickup.id,epoch=editEpoch.current;
    if(!control||busy.current||(!remove&&!draft)||(!remove&&!pickup.waitingPointConsent&&!agreed))return;
    busy.current=true;setSaving(true);setSaveError('');
    try{
      const value=await api<Pickup>(recipientPath('/shared-pickup/waiting-point',id),remove?'DELETE':'PUT',remove?{expectedRevision:pickup.waitingPointRevision??0}:{location:draft!.point,expectedRevision:draft!.baseRevision,consent:agreed,consentVersion:'2026-11-09-manual'});
      if(editEpoch.current===epoch&&value.id===latest.current.id){onPickup?.(value);editingRef.current=false;setEditing(false);control.clear();setAgreed(false);}
    }catch(cause){if(editEpoch.current===epoch)setSaveError((cause as Error).message);}
    finally{if(editEpoch.current===epoch){busy.current=false;setSaving(false);}}
  }

  const container=useRef<HTMLDivElement>(null),instance=useRef<any>(null),pins=useRef<any[]>([]);
  const routeLine=useRef<PlannedRouteLine|null>(null);
  const viewport=useRef<MapViewport|null>(null),boundsRef=useRef<any>(null),openButton=useRef<HTMLButtonElement>(null),backButton=useRef<HTMLButtonElement>(null),shell=useRef<HTMLElement>(null);
  const [expanded,setExpanded]=useState(false);
  const [available,setAvailable]=useState(false),[mapState,setMapState]=useState('loading');
  useEffect(()=>{
    let disposed=false,cleanup=()=>{};
    const host=container.current;setExpanded(false);host?.replaceChildren();setAvailable(false);setMapState('loading');
    void loadMap().then(maps=>{
      if(disposed)return;
      if(!maps || !container.current || !pickup.destination){setMapState('unavailable');return;}
      instance.current=new maps.Map(container.current,{center:new maps.LatLng(pickup.destination.latitude,pickup.destination.longitude),level:5});
      const map=instance.current;
      routeLine.current=new PlannedRouteLine(maps,map);
      viewport.current=new MapViewport(map,()=>container.current?.clientHeight??320);
      const changed=()=>{if(!editingRef.current||busy.current)return;const p=map.getCenter();editor.current?.select({latitude:p.getLat(),longitude:p.getLng()},latest.current.waitingPointRevision??0);};
      const drag=()=>{viewport.current?.interact();changed();};
      maps.event.addListener(map,'center_changed',changed);maps.event.addListener(map,'dragstart',drag);
      const interact=()=>viewport.current?.interact();
      host?.addEventListener('pointerdown',interact,{passive:true});host?.addEventListener('wheel',interact,{passive:true});
      const observer=new ResizeObserver(()=>viewport.current?.resize());if(host)observer.observe(host);
      cleanup=()=>{maps.event.removeListener(map,'center_changed',changed);maps.event.removeListener(map,'dragstart',drag);observer.disconnect();host?.removeEventListener('pointerdown',interact);host?.removeEventListener('wheel',interact);};
      setAvailable(true);setMapState('ready');
    }).catch(()=>{if(!disposed){setAvailable(false);setMapState('unavailable');}});
    return ()=>{disposed=true;cleanup();routeLine.current?.clear();routeLine.current=null;viewport.current=null;boundsRef.current=null;pins.current.forEach(p=>p.setMap(null));pins.current=[];instance.current=null;host?.replaceChildren();};
  },[pickup.id]);
  useEffect(()=>{
    const maps=window.kakao?.maps,map=instance.current;
    if(!available || !map || !pickup.destination)return;
    const previous=new Map(pins.current.map(p=>[p.pmuKind,p])),updated:any[]=[];
    const bounds=new maps.LatLngBounds();
    function pin(point:{latitude:number;longitude:number},label:string,className:string) {
      const position=new maps.LatLng(point.latitude,point.longitude);
      const visual=className==='car-pin'?vehicleBadge(pickup.vehicle?.modelKey):null;
      const signature=JSON.stringify([className,label,visual?.name,stale]);
      const old=previous.get(className);previous.delete(className);
      if(old?.pmuSignature===signature){old.setPosition(position);bounds.extend(position);updated.push(old);return;}
      old?.setMap(null);const element=document.createElement('div');
      if(className==='car-pin'){
        element.className=`vehicle-marker${stale?' is-stale':''}`;
        element.setAttribute('aria-label',`${stale?'마지막 차량 위치':'차량 위치'} · ${visual?.name??'우리 차'}`);
        const badge=document.createElement('div');badge.className='vehicle-marker-badge';
        const fallback=()=>{const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.classList.add('generic-car');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','m5 7 2-4h10l2 4M4 8h16a1 1 0 0 1 1 1v8H3V9a1 1 0 0 1 1-1ZM5 17v3m14-3v3M6 12h2m8 0h2');svg.append(path);badge.replaceChildren(svg);};
        if(visual){const img=document.createElement('img');img.src=visual.image;img.alt=visual.name;img.width=68;img.height=40;badge.append(img);img.onerror=fallback;}else fallback();
        const caption=document.createElement('span');caption.className='vehicle-marker-label';caption.textContent=stale?'마지막 차량 위치':visual?.name??'우리 차';
        element.append(badge,caption);
      }else{
        element.className=`map-pin ${className}`;
        if(className==='destination-pin'){
          const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
          svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','18');svg.setAttribute('height','18');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.8');
          const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM12 7v6m-3-3h6');svg.appendChild(path);element.append(svg);
        }
        element.append(document.createTextNode(label));
      }
      const overlay=new maps.CustomOverlay({position,content:element,yAnchor:className==='car-pin'?1:1.1,zIndex:5});overlay.setMap(map);
      overlay.pmuKind=className;overlay.pmuSignature=signature;bounds.extend(position);updated.push(overlay);
    }
    const waiting=pickup.waitingPoint?.location;
    if(!waiting&&!editing)pin(pickup.destination,'만날 곳','destination-pin');
    if(pickup.observation)pin(pickup.observation.location,stale?'마지막 차량 위치':'차량','car-pin');
    if(waiting&&!editing)pin(waiting,'기다릴 위치','waiting-pin');
    previous.forEach(p=>p.setMap(null));pins.current=updated;
    const road=pickup.plannedRoute;
    const hasRoute=road?.state==='READY'&&!stale&&!!road.path?.length;
    if(hasRoute){road.path?.forEach(p=>bounds.extend(new maps.LatLng(p[1],p[0])));road.traveledPaths?.forEach(fragment=>fragment.forEach(p=>bounds.extend(new maps.LatLng(p[1],p[0]))));}
    boundsRef.current=bounds;
    viewport.current?.update(bounds,!!pickup.observation,hasRoute);
  },[pickup,available,stale,editing]);
  useEffect(()=>{if(available)routeLine.current?.update(pickup.plannedRoute,!stale&&pickup.state==='ACTIVE');},[pickup,available,stale]);
  useEffect(()=>{
    const point=selection.draft?.point,map=instance.current,maps=window.kakao?.maps;
    if(!available||!map||!point||selection.draft?.source!=='GPS')return;viewport.current?.interact();map.setCenter(new maps.LatLng(point.latitude,point.longitude));
  },[selection.draft,available]);
  function cancelEdit(){editingRef.current=false;setEditing(false);editor.current?.clear();setSaveError('');setAgreed(false);}
  function beginEdit(action:LocationPromptAction,p=latest.current){
    const initial=p.waitingPoint?.location??p.destination,map=instance.current,maps=window.kakao?.maps;
    setPrompt(null);setAgreed(true);setSaveError('');if(!initial||!map||!maps)return;
    editingRef.current=true;setEditing(true);viewport.current?.interact();editor.current?.select(initial,p.waitingPointRevision??0);
    map.setLevel(2);map.setCenter(new maps.LatLng(initial.latitude,initial.longitude));container.current?.scrollIntoView({block:'center',behavior:'smooth'});
    if(action==='locate')editor.current?.locate(navigator.geolocation,p.waitingPointRevision??0);
  }
  function requestEdit(action:LocationPromptAction){
    setConsentError('');if(latest.current.waitingPointConsent)beginEdit(action);else setPrompt(action);
  }
  async function agreeOnce(action:LocationPromptAction){
    if(consentPending.current)return;consentPending.current=true;setConsentBusy(true);setConsentError('');const epoch=editEpoch.current,id=latest.current.id;
    try{
      const value=await api<Pickup>(recipientPath('/shared-pickup/waiting-point/consent',id),'POST',{consent:true,consentVersion:'2026-11-09-manual'});
      if(editEpoch.current!==epoch||value.id!==latest.current.id)return;
      latest.current=value;onPickup?.(value);beginEdit(action,value);
    }catch(error){if(editEpoch.current===epoch)setConsentError((error as Error).message);}
    finally{if(editEpoch.current===epoch){consentPending.current=false;setConsentBusy(false);}}
  }
  const consumedLocationRequest=useRef(locationRequest);
  useEffect(()=>{
    if(!available||locationRequest===consumedLocationRequest.current)return;consumedLocationRequest.current=locationRequest;
    if(editingRef.current)container.current?.scrollIntoView({block:'center',behavior:'smooth'});else requestEdit('edit');
  },[locationRequest,available]);
  useEffect(()=>{instance.current?.setDraggable(!saving);},[saving,available]);
  useEffect(()=>{
    const bar=waitingBar.current,host=shell.current;if(!bar||!host)return;
    const observer=new ResizeObserver(()=>host.style.setProperty('--waiting-bar',`${bar.getBoundingClientRect().height}px`));observer.observe(bar);return()=>observer.disconnect();
  },[]);
  function open() {
    history.pushState({...history.state,pmuMap:pickup.id},'',location.href);setExpanded(true);
  }
  function close() {
    setExpanded(false);if(history.state?.pmuMap===pickup.id)history.back();
    requestAnimationFrame(()=>openButton.current?.focus());
  }
  useEffect(()=>{
    const pop=()=>{if(history.state?.pmuMap!==pickup.id)setExpanded(false);};
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  },[pickup.id]);
  useEffect(()=>{
    if(!expanded)return;
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';backButton.current?.focus();
    const background=[...document.querySelectorAll<HTMLElement>('.arrival,.pickup-actions,.share-page>.topline,.waiting-location-invite')].map(el=>({el,inert:el.inert}));
    background.forEach(({el})=>{el.inert=true;});
    const key=(event:KeyboardEvent)=>{
      if(document.querySelector('.waiting-location-prompt[open]'))return;
      if(event.key==='Escape'){event.preventDefault();close();}
      if(event.key==='Tab'){
        const items=[...(shell.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),summary,a[href],[tabindex="0"]')??[])];
        const first=items[0],last=items.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',key);
    return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',key);background.forEach(({el,inert})=>{el.inert=inert;});};
  },[expanded,pickup.id]);
  useEffect(()=>()=>{if(history.state?.pmuMap===pickup.id){const state={...history.state};delete state.pmuMap;history.replaceState(state,'');}},[pickup.id]);
  return <div className="map-slot unified-slot"><section ref={shell} className={`map-shell unified-map${expanded?' is-expanded':''}`} role={expanded?'dialog':undefined} aria-modal={expanded||undefined} aria-label="차량과 기다릴 위치 지도">
    <div ref={container} className="map-canvas" />
    {editing&&<div className="waiting-center-pin" aria-label="중앙에 고정된 선택 핀"><Icon name="pin" size={42}/><span>여기서 기다릴게요</span></div>}
    {available&&pickup.plannedRoute?.state==='READY'&&<span className="map-route-label" title="카카오가 계산한 예상 경로로, 차량 내비게이션 안내와 다를 수 있어요.">예상경로</span>}
    <div className="map-zoom" role="group" aria-label="지도 확대·축소"><button className="map-control" aria-label="확대" disabled={!available} onClick={()=>{viewport.current?.interact();const map=instance.current;if(map)map.setLevel(Math.max(1,map.getLevel()-1));}}><Icon name="plus" size={21}/></button><button className="map-control" aria-label="축소" disabled={!available} onClick={()=>{viewport.current?.interact();const map=instance.current;if(map)map.setLevel(Math.min(14,map.getLevel()+1));}}><Icon name="minus" size={21}/></button></div>
    <button className={`map-control map-locate${selection.locating?' is-locating':''}`} aria-label="현재 위치 찾기" title="현재 위치 찾기" aria-busy={selection.locating} disabled={!available||saving} onClick={()=>requestEdit('locate')}><Icon name="locate" size={23}/></button>
    <div className="unified-waiting-bar" ref={waitingBar} aria-busy={saving}>
      <div className="waiting-summary"><div><strong>{editing?'만날 위치를 골라 주세요':pickup.waitingPoint?'지정한 기다릴 위치':'기다릴 위치를 정해 주세요'}</strong><p role="status">{selection.locating?'현재 위치를 찾고 있어요…':editing?'핀은 그대로, 지도를 움직여 맞춰 주세요.':pickup.waitingPoint?'이 핀만 운전자에게 보여요.':'기다릴 곳을 지정하면 운전자가 쉽게 찾을 수 있어요.'}</p></div>{!editing&&<div className="waiting-summary-actions"><button className={pickup.waitingPoint?"secondary":"primary"} disabled={saving||!available} onClick={()=>requestEdit('edit')}>{pickup.waitingPoint?'위치 변경':'위치 정하기'}</button>{pickup.waitingPoint&&<button className="text-button" disabled={saving} onClick={()=>void commit(true)}>지우기</button>}</div>}</div>
      {(saveError||selection.error)&&<p className="waiting-error" role="alert">{saveError||selection.error}</p>}
      {editing&&<div className="unified-pin-actions"><button className="secondary" disabled={saving} onClick={cancelEdit}>취소</button><button className="primary" disabled={saving||(!pickup.waitingPointConsent&&!agreed)} onClick={()=>void commit()}>{saving?'전달 중…':'여기서 기다릴게요'}<Icon name="arrow" size={18}/></button></div>}
    </div>
    {!available&&<div className="map-placeholder"><p role="status">{mapState==='loading'?'지도 연결 중…':'지도를 불러오지 못했어요.'}</p></div>}
    {expanded?<div className="map-toolbar"><button ref={backButton} className="secondary map-back" onClick={close}><Icon name="arrow" size={20} style={{transform:'rotate(180deg)'}}/>뒤로가기</button><strong>{pickup.destination?.name||'만날 곳'}</strong><button className="secondary map-fit" disabled={!available} onClick={()=>boundsRef.current&&viewport.current?.fit(boundsRef.current,true)}><Icon name="pin" size={18}/>위치 다시 맞추기</button></div>:<button ref={openButton} className="map-control map-external" aria-label="지도 확대해서 보기" title="지도 확대해서 보기" onClick={open}><Icon name="expand" size={21}/></button>}
  </section>{prompt&&<WaitingLocationPrompt action={prompt} ready={available} busy={consentBusy} error={consentError} onCancel={()=>{if(!consentBusy)setPrompt(null)}} onAgree={()=>void agreeOnce(prompt)}/>}</div>;
}
