import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Pickup, takeFragmentToken, recipientPath } from './api';
import {mergeWaitingPoint} from './WaitingPointState';
import {ArrivalReminder} from './ArrivalReminder';
import {isNearArrival,isObservationStale} from './ArrivalNotice';
import { PickupMap } from './PickupMap';
import { vehicleVisual } from './VehicleVisual';
import { Brand, Icon } from './Design';

export function SharePage() {
  const [linkToken,setLinkToken]=useState(takeFragmentToken),[pickup,setPickup]=useState<Pickup|null>(null);
  const [pickupId,setPickupId]=useState(()=>new URLSearchParams(location.search).get('pickupId')??'');
  const scope=useRef(pickupId);
  const [error,setError]=useState(''),[connection,setConnection]=useState('연결 중'),[ended,setEnded]=useState(false);
  const [sending,setSending]=useState(false),[now,setNow]=useState(Date.now());
  const [needsCode,setNeedsCode]=useState(false),[code,setCode]=useState(''),[verifying,setVerifying]=useState(false),[locked,setLocked]=useState(false),[retry,setRetry]=useState(0);
  const endedRef=useRef(false),generation=useRef(0);
  useEffect(()=>{
    const receive=()=>{const value=takeFragmentToken();if(value){generation.current++;scope.current='';setPickupId('');setPickup(null);setError('');setCode('');setLocked(false);setVerifying(false);setSending(false);setLinkToken(value);setRetry(v=>v+1);}};
    window.addEventListener('hashchange',receive);return()=>window.removeEventListener('hashchange',receive);
  },[]);
  useEffect(()=>{
    endedRef.current=false;setEnded(false);setNeedsCode(false);setError('');
    const epoch=++generation.current,abort=new AbortController();
    let disposed=false,stopped=false,streamLive=false,checking=false,waitingCode=false,attempt=0,expiresAt=Infinity,events:EventSource|undefined;
    let reconnect:ReturnType<typeof setTimeout>|undefined;
    const valid=()=>!disposed&&!stopped&&generation.current===epoch;
    const bind=(id:string)=>{if(scope.current&&scope.current!==id)throw new ApiError(409,'PICKUP_MISMATCH','다른 픽업 응답을 표시하지 않았어요. 받은 링크를 다시 열어 주세요.');scope.current=id;setPickupId(id);history.replaceState(null,'',`/s?pickupId=${encodeURIComponent(id)}`);};
    const stop=(message='')=>{if(!valid())return;stopped=true;endedRef.current=true;setEnded(true);setError(message);setNeedsCode(false);setPickup(null);events?.close();};
    const authError=(cause:unknown)=>{
      if(cause instanceof ApiError&&cause.code==='SHARE_CODE_REQUIRED'){waitingCode=true;setNeedsCode(true);setPickup(null);events?.close();return true;}
      if(cause instanceof ApiError&&cause.status===410){stop(cause.message);return true;}
      if(cause instanceof ApiError&&[400,401,403,409].includes(cause.status)){waitingCode=true;setError(cause.message);events?.close();return true;}return false;
    };
    const update=(value:Pickup)=>{if(!valid())return;bind(value.id);expiresAt=Date.parse(value.expiresAt);setPickup(current=>mergeWaitingPoint(current,value));setNeedsCode(false);setError('');attempt=0;};
    const path=(value:string)=>scope.current?recipientPath(value,scope.current):value;
    const schedule=()=>{if(!valid()||waitingCode||reconnect)return;reconnect=setTimeout(()=>{reconnect=undefined;void connect();},Math.min(20_000,2_000*2**Math.min(attempt++,4)));};
    async function connect(){
      if(!valid()||checking||waitingCode)return;checking=true;
      try {
        if(linkToken){
          const gate=await api<{verificationRequired?:boolean;pickupId:string;locked?:boolean}>(path('/shares/redeem'),'POST',{token:linkToken},{signal:abort.signal});
          if(!valid())return;bind(gate.pickupId);
          if(gate.verificationRequired){waitingCode=true;setNeedsCode(true);setLocked(!!gate.locked);setPickup(null);return;}
        }
        let initial:Pickup;
        try{initial=await api<Pickup>(path('/shared-pickup'),'GET',undefined,{signal:abort.signal});}
        catch(cause){
          if(cause instanceof ApiError&&cause.code==='SHARE_CODE_REQUIRED'){
            const gate=await api<{pickupId:string;locked?:boolean}>(path('/shares/redeem'),'POST',{}, {signal:abort.signal});
            if(valid()){bind(gate.pickupId);waitingCode=true;setNeedsCode(true);setLocked(!!gate.locked);setPickup(null);}return;
          }throw cause;
        }
        if(!valid())return;
        update(initial);setConnection('실시간 연결 중');
        if(!events){
          events=new EventSource('/api'+path('/shared-pickup/events'));
          events.addEventListener('pickup',event=>{if(!valid())return;try{update(JSON.parse((event as MessageEvent).data));streamLive=true;setConnection('실시간 연결됨');}catch(cause){authError(cause);}});
          events.addEventListener('ended',()=>stop());
          events.addEventListener('unavailable',()=>{if(valid()){streamLive=false;setConnection('다시 연결하고 있어요');schedule();}});
          events.onerror=()=>{if(valid()){streamLive=false;setConnection('다시 연결하고 있어요');schedule();}};
        }
      }catch(cause){if(valid()&&!authError(cause)){setError((cause as Error).message);setConnection('다시 연결하고 있어요');schedule();}}
      finally{checking=false;}
    }
    const recover=()=>{if(valid()&&!waitingCode){if(reconnect)clearTimeout(reconnect);reconnect=undefined;void connect();}};
    void connect();window.addEventListener('online',recover);window.addEventListener('pageshow',recover);
    const clock=setInterval(()=>{const time=Date.now();setNow(time);if(!stopped&&time>=expiresAt)stop();},1_000);
    const fallback=setInterval(()=>{if(!streamLive)void connect();},10_000);
    return()=>{disposed=true;abort.abort();endedRef.current=true;if(generation.current===epoch)generation.current++;events?.close();clearInterval(clock);clearInterval(fallback);if(reconnect)clearTimeout(reconnect);window.removeEventListener('online',recover);window.removeEventListener('pageshow',recover);};
  },[linkToken,retry]);
  async function verifyCode(event:React.FormEvent){
    event.preventDefault();const epoch=generation.current;setVerifying(true);setError('');
    try{await api(recipientPath('/shares/redeem',scope.current),'POST',{code,...(linkToken?{token:linkToken}:{})});if(epoch===generation.current){setCode('');setNeedsCode(false);setRetry(v=>v+1);}}
    catch(cause){if(epoch===generation.current){setError((cause as Error).message);if(cause instanceof ApiError&&cause.status===429)setLocked(true);if(cause instanceof ApiError&&cause.status===410){setEnded(true);setNeedsCode(false);}}}
    finally{if(epoch===generation.current)setVerifying(false);}
  }
  const stale=isObservationStale(pickup,Math.max(now,Date.now()));
  async function readiness(value:'UNKNOWN'|'PREPARING'|'OUTSIDE'){
    const epoch=generation.current,id=scope.current;setSending(true);setError('');
    try{const next=await api<Pickup>(recipientPath('/shared-pickup/readiness',id),'PUT',{readiness:value});if(!endedRef.current&&epoch===generation.current&&next.id===id)setPickup(current=>mergeWaitingPoint(current,next));}
    catch(cause){if(epoch===generation.current)setError((cause as Error).message);}finally{if(epoch===generation.current)setSending(false);}
  }
  if(needsCode&&!ended)return <main className="share-page"><header className="topline"><Brand/></header><section className="share-code-panel"><span className="state-mark" aria-hidden="true"><Icon name="shield" size={28}/></span><p className="eyebrow">나에게 온 픽업</p><h1>{locked?'인증이 잠겼어요':'픽업 확인하기'}</h1><p className="muted">{locked?<>운전자에게 새 링크와 코드를 요청해 주세요.<br/>운전자가 ‘인증 잠금 풀기’를 누르면 다시 받을 수 있어요.</>:<>문자에 적힌 인증코드 4자리를 입력해 주세요.<br/>한 번 확인하면 이 픽업에서는 다시 묻지 않아요.</>}</p>{!locked&&<form onSubmit={e=>void verifyCode(e)}><label>인증코드<input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{4}" maxLength={4} required value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/></label><button className="primary" disabled={verifying}>확인</button></form>}{error&&<p className="error" role="alert">{error}</p>}</section></main>;
  return <ShareView pickup={pickup} ended={ended} error={error} connection={connection} stale={stale} sending={sending} onRetry={()=>setRetry(v=>v+1)} onPickup={value=>{if(!endedRef.current&&value.id===scope.current)setPickup(current=>mergeWaitingPoint(current,value))}} onReadiness={value=>void readiness(value)}/>;
}

export function ShareView({pickup,ended=false,error='',connection='실시간 연결됨',stale=false,sending=false,onReadiness,onRetry,onPickup}:{pickup:Pickup|null;ended?:boolean;error?:string;connection?:string;stale?:boolean;sending?:boolean;onRetry?:()=>void;onPickup?:(value:Pickup)=>void;onReadiness:(value:'UNKNOWN'|'PREPARING'|'OUTSIDE')=>void}) {
  const [locationRequest,setLocationRequest]=useState(0);
  const sample=pickup?.observation;
  if(ended||!pickup)return <main className="share-page state-page"><header className="topline"><Brand/></header><section className="empty-state" aria-live="polite"><span className={`state-mark${error?' is-error':''}`} aria-hidden="true"><Icon name={ended?'check':error?'link':'clock'} size={32}/></span><h1>{ended?'공유가 끝났어요':error?'연결을 확인해 주세요':'차량 정보 확인 중'}</h1>{ended?<p className="muted">{error||'픽업이 종료되어 위치 공유도 멈췄어요.'}</p>:error&&<p className="muted">{error}</p>}{!ended&&error&&onRetry&&<button className="secondary" onClick={onRetry}>다시 연결</button>}</section></main>;
  const minutes=Math.max(1,Math.ceil((sample?.remainingSeconds??0)/60));
  const arrived=pickup.state==='ARRIVED';
  return <main className="share-page">
    <header className="topline"><Brand/>{(stale||connection!=='실시간 연결됨')&&<span className={`connection ${stale?'delayed':''}`} role="status">{stale?'갱신 지연':connection}</span>}</header>
    {!pickup.waitingPoint&&<section className="waiting-location-invite" aria-label="기다릴 위치 지정 안내"><span className="waiting-invite-symbol"><Icon name="pin" size={28}/></span><div><p className="eyebrow">먼저 해주세요</p><h2>기다릴 위치를 정해 주세요</h2><p>운전자가 찾을 수 있도록, 지도에서 기다릴 곳을 골라 주세요.</p></div><button className="primary" onClick={()=>setLocationRequest(v=>v+1)}>기다릴 위치 정하기<Icon name="arrow" size={19}/></button></section>}
    <div className="share-grid">
      <section className="arrival">
        <p className="eyebrow">{arrived?'곧 만나요':'나에게 오는 중'}</p>
        <h1>{arrived?'만날 곳 근처에 도착했어요':stale?'도착 시간 확인 중':<>약 <span className="eta-number">{minutes}</span>분 후 도착</>}</h1>
        {stale&&sample&&<p className="last-eta">마지막 안내 · 약 {minutes}분</p>}
        <div className="destination"><Icon name="pin" size={20}/><strong>{pickup.destination?.name||'만날 곳 확인 중'}</strong></div>
        {(pickup.vehicle?.modelName||pickup.vehicle?.licensePlate||pickup.vehicle?.modelKey)&&<div className="shared-vehicle"><Icon name="car" size={22}/><span>{pickup.vehicle.modelName||vehicleVisual(pickup.vehicle.modelKey)?.name||'찾을 차량'}</span>{pickup.vehicle.licensePlate&&<strong>{pickup.vehicle.licensePlate}</strong>}</div>}
        {stale&&<p className="notice" role="status">최신 도착 시간을 기다려 주세요.</p>}
        {isNearArrival(pickup)&&<div className="near-arrival-banner" role="alert"><Icon name="clock" size={22}/><div><strong>곧 도착해요</strong><p>5분 이내 도착 예정이에요.</p></div></div>}
      </section>
      <PickupMap pickup={pickup} stale={stale} onPickup={onPickup} locationRequest={locationRequest}/>
      <section className="pickup-actions" aria-label="만날 준비">
      <div className="readiness-card" aria-busy={sending}>
        <div className="pickup-actions-heading"><h2>만날 준비</h2><span>운전자에게 전해요</span></div>
        <p className="muted readiness-message" role="status">{pickup.readiness==='OUTSIDE'?'나왔다고 알렸어요.':'밖으로 나오면 눌러주세요.'}</p>
        <div className="readiness-buttons"><button className={pickup.readiness==='OUTSIDE'?'secondary':'primary'} disabled={sending} onClick={()=>onReadiness(pickup.readiness==='OUTSIDE'?'PREPARING':'OUTSIDE')}><Icon name={pickup.readiness==='OUTSIDE'?'clock':'check'} size={20}/>{pickup.readiness==='OUTSIDE'?'아직 준비 중이에요':'나왔어요'}</button></div>
        <p className="sr-only" role="status">{sending?'운전자에게 알리는 중…':''}</p>
        {error&&<p className="error" role="alert">{error}</p>}
      </div>
      <div className="pickup-settings"><ArrivalReminder key={pickup.id} pickup={pickup}/></div>
      </section>
    </div>
  </main>;
}
