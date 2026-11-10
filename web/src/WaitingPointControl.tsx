import {useEffect,useRef,useState} from 'react';
import {api,recipientPath,type Pickup,type Point} from './api';
import {Icon} from './Design';
import {loadMap} from './PickupMap';
import './waiting-point.css';
const consentVersion='2026-11-09-manual';
export function WaitingPointControl({pickup,onChange}:{pickup:Pickup;onChange?:(pickup:Pickup)=>void}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),opener=useRef<HTMLButtonElement>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
  const close=()=>{setOpen(false);requestAnimationFrame(()=>opener.current?.focus());};
  async function clear(){setBusy(true);setError('');try{const next=await api<Pickup>(recipientPath('/shared-pickup/waiting-point',pickup.id),'DELETE',{expectedRevision:pickup.waitingPointRevision??0});if(alive.current&&next.id===pickup.id)onChange?.(next);}catch(e){if(alive.current)setError((e as Error).message)}finally{if(alive.current)setBusy(false)}}
  return <section className="pickup-control waiting-point-control" aria-label="기다릴 위치">
    <div className="control-row"><span className="control-symbol"><Icon name="pin" size={21}/></span><div className="control-copy"><h3>기다릴 위치</h3><p role="status">{pickup.waitingPoint?'직접 찍은 위치를 운전자에게 보여주고 있어요.':'입구나 길가, 기다리는 곳을 직접 찍어 주세요.'}</p></div><button ref={opener} className="secondary control-button" disabled={busy} onClick={()=>{setError('');setOpen(true)}}>{pickup.waitingPoint?'위치 바꾸기':'지도에 찍기'}</button></div>
    {pickup.waitingPoint&&<div className="waiting-point-note"><span>이 위치는 자동으로 움직이지 않아요.</span><button className="text-button" disabled={busy} onClick={()=>void clear()}>{busy?'지우는 중…':'지우기'}</button></div>}
    {error&&<p className="error" role="alert">{error}</p>}
    {open&&<WaitingPointPicker pickup={pickup} onClose={close} onSaved={value=>{if(alive.current&&value.id===pickup.id){onChange?.(value);close();}}}/>}
  </section>;
}
function WaitingPointPicker({pickup,onClose,onSaved}:{pickup:Pickup;onClose:()=>void;onSaved:(pickup:Pickup)=>void}){
  const dialog=useRef<HTMLDialogElement>(null),host=useRef<HTMLDivElement>(null),runtime=useRef<any>(null),alive=useRef(true);
  const initial=pickup.waitingPoint?.location??pickup.recipientLocation?.position?.location??pickup.destination!;
  const draft=useRef<Point>({latitude:initial.latitude,longitude:initial.longitude}),revision=useRef(pickup.waitingPointRevision??0);
  const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[agreed,setAgreed]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    const element=dialog.current!,overflow=document.body.style.overflow;document.body.style.overflow='hidden';element.showModal();let disposed=false,cleanup=()=>{};alive.current=true;
    void loadMap().then(maps=>{
      if(disposed)return;if(!maps){setError('지도 설정을 확인해 주세요.');return;}
      const map=new maps.Map(host.current,{center:new maps.LatLng(initial.latitude,initial.longitude),level:2});
      runtime.current={maps,map};
      const changed=()=>{const center=map.getCenter();draft.current={latitude:center.getLat(),longitude:center.getLng()};};
      const click=(event:any)=>map.setCenter(event.latLng);
      maps.event.addListener(map,'center_changed',changed);maps.event.addListener(map,'click',click);
      const resize=new ResizeObserver(()=>map.relayout());resize.observe(host.current!);
      cleanup=()=>{resize.disconnect();maps.event.removeListener(map,'center_changed',changed);maps.event.removeListener(map,'click',click);runtime.current=null;};setReady(true);
    }).catch(()=>{if(!disposed)setError('지도를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.');});
    return()=>{disposed=true;alive.current=false;cleanup();element.close();document.body.style.overflow=overflow;};
  },[]);
  function move(lat:number,lng:number){const r=runtime.current;if(!r)return;const c=r.map.getCenter();r.map.setCenter(new r.maps.LatLng(c.getLat()+lat,c.getLng()+lng));}
  async function save(){
    if(!agreed||!ready||busy)return;setBusy(true);setError('');
    try{const next=await api<Pickup>(recipientPath('/shared-pickup/waiting-point',pickup.id),'PUT',{location:draft.current,expectedRevision:revision.current,consent:true,consentVersion});if(alive.current&&next.id===pickup.id)onSaved(next);}
    catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false)}
  }
  return <dialog ref={dialog} className="waiting-point-dialog" aria-labelledby="waiting-point-title" onCancel={e=>{e.preventDefault();if(!busy)onClose()}}>
    <header><div><p className="eyebrow">MEET ME HERE</p><h2 id="waiting-point-title">여기서 기다릴게요</h2><p className="muted">지도를 움직이거나 눌러 핀을 놓아 주세요.</p></div><button className="text-button" aria-label="대기 위치 선택 닫기" disabled={busy} onClick={onClose}><Icon name="close" size={23}/></button></header>
    <div className="waiting-point-map"><div ref={host} className="waiting-point-canvas"/>{ready?<><div className="waiting-point-reticle" aria-hidden="true"><Icon name="pin" size={42}/><span>기다릴 위치</span></div><div className="waiting-point-arrows" role="group" aria-label="핀 위치 미세 조정">{[['북쪽',.0001,0,'↑'],['서쪽',0,-.0001,'←'],['동쪽',0,.0001,'→'],['남쪽',-.0001,0,'↓']].map(([name,lat,lng,label])=><button key={String(name)} className="map-control" aria-label={`대기 위치 ${name}으로 이동`} disabled={busy} onClick={()=>move(Number(lat),Number(lng))}>{label}</button>)}</div></>:<div className="waiting-point-loading" role="status">{error?'지도를 연결하지 못했어요.':'지도 연결 중…'}</div>}</div>
    <footer><details><summary>위치정보 이용 안내</summary><p>직접 지정한 위치(위도·경도)와 지정 시각을 이 픽업의 운전자에게 제공해요. GPS를 수집하지 않아요. 핀을 지우거나 픽업 종료·만료 또는 인증 링크 교체 시 삭제해요. 동의하지 않아도 도착 안내는 볼 수 있어요.</p></details>
      <label className="waiting-point-consent"><input type="checkbox" checked={agreed} disabled={busy} onChange={e=>setAgreed(e.target.checked)}/><span>이 위치를 운전자에게 공유하는 데 동의해요.</span></label>
      {error&&<p className="error" role="alert">{error}</p>}
      <div className="waiting-point-actions"><button className="secondary" disabled={busy} onClick={onClose}>취소</button><button className="primary" disabled={!ready||!agreed||busy} onClick={()=>void save()}><Icon name="pin" size={20}/>{busy?'전달 중…':'이 위치에서 기다릴게요'}</button></div>
    </footer>
  </dialog>;
}
