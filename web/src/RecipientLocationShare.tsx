import { useEffect, useRef, useState } from 'react';
import type { Pickup } from './api';
import { RecipientLocationSession,locationTransport, type LocationUi } from './RecipientLocationSession';
import {Icon} from './Design';
import {LocationConsentDialog} from './LocationConsentDialog';

export function RecipientLocationShare({pickup}:{pickup:Pickup}) {
  const session=useRef<RecipientLocationSession|null>(null);
  const lastOwnSession=useRef<string|null>(null);
  const [ui,setUi]=useState<LocationUi>({phase:'OFF',error:'',sessionId:null,hasLease:false});
  const [consentOpen,setConsentOpen]=useState(false);
  const shareButton=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    lastOwnSession.current=null;setConsentOpen(false);
    const controller=new RecipientLocationSession(navigator.geolocation,()=>document.visibilityState==='visible',window.isSecureContext,setUi,(method,body,keepalive)=>locationTransport(method,body,keepalive,pickup.id));
    session.current=controller;
    const visibility=()=>{if(document.visibilityState==='visible')controller.resume();else controller.pause();};
    const pagehide=()=>controller.pause();
    document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',pagehide);
    window.addEventListener('pageshow',visibility);
    return()=>{controller.dispose();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',pagehide);window.removeEventListener('pageshow',visibility);session.current=null;};
  },[pickup.id]);
  if(ui.sessionId)lastOwnSession.current=ui.sessionId;
  const remote=pickup.recipientLocation,other=remote?.sessionId&&remote.sessionId!==(ui.sessionId??lastOwnSession.current);
  const stale=remote?.sessionId===ui.sessionId&&remote?.state==='STALE';
  const pending=ui.phase==='ASKING',stopping=ui.phase==='STOPPING';
  const title=ui.phase==='STOPPING'?'위치 공유 중지 확인 중':ui.phase==='ASKING'?'내 위치 확인 중':
    ui.phase==='PAUSED'||(ui.hasLease&&stale)?'위치 갱신 중단':
    ui.phase==='SHARING'?'운전자에게 내 위치를 보여주고 있어요':other&&remote.state!=='OFF'?'다른 화면에서 위치 공유 중':'운전자가 나를 쉽게 찾을 수 있어요.';
  function dismiss(){setConsentOpen(false);requestAnimationFrame(()=>shareButton.current?.focus());}
  return <section className="recipient-location-share pickup-control" aria-label="실시간 위치 공유">
    <div className="control-row"><span className="control-symbol"><Icon name="pin" size={21}/></span><div className="control-copy"><h3>실시간 위치 공유</h3><p aria-live="polite">{title}</p></div>
      {ui.hasLease||pending?<button className="secondary control-button" disabled={stopping} onClick={()=>void session.current?.stop()}>{stopping?'중지 중…':pending?'취소':ui.phase==='ERROR'?'중지 재시도':'공유 중지'}</button>:<button ref={shareButton} className="secondary control-button" onClick={()=>setConsentOpen(true)}>{other?'여기서 공유':'공유하기'}</button>}
    </div>
    {(ui.phase==='PAUSED'||stale)&&<p className="location-note">운전자에게는 마지막 위치와 갱신 중단 상태가 표시돼요.</p>}
    {ui.phase==='PAUSED'&&ui.hasLease&&<button ref={shareButton} className="text-button location-resume" onClick={()=>setConsentOpen(true)}>다시 공유하기</button>}
    {ui.error&&<p className="error" role="alert">{ui.error}</p>}
    {consentOpen&&<LocationConsentDialog onCancel={dismiss} onAgree={()=>{setConsentOpen(false);session.current?.start(true);}}/>}
  </section>;
}
