import {useEffect,useRef,useState} from 'react';
import {api,recipientPath,type Pickup} from './api';
import {ArrivalChime,ForegroundArrival} from './ForegroundArrival';
import {Icon} from './Design';
export function SoundArrivalReminder({pickup}:{pickup:Pickup}) {
  const [enabled,setEnabled]=useState(false),[announced,setAnnounced]=useState(false),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[soundReady,setSoundReady]=useState(false);
  const media=useRef<HTMLAudioElement>(null),active=useRef(false),generation=useRef(0),priming=useRef(false),audioEpoch=useRef(0);
  const latest=useRef(pickup);latest.current=pickup;
  const chime=useRef<ArrivalChime|null>(null),session=useRef<ForegroundArrival|null>(null);
  useEffect(()=>{
    let store:Storage|undefined;try{store=sessionStorage;}catch{}
    const s=new ForegroundArrival(pickup.id,store),audio=new ArrivalChime(()=>media.current!);session.current=s;chime.current=audio;
    const epoch=++generation.current;active.current=false;setEnabled(false);setAnnounced(false);setNotice('');setBusy(false);setSoundReady(false);
    const check=()=>{
      if(document.visibilityState!=='visible'){chime.current?.pause();return;}
      if(priming.current)return;
      if(s.check(latest.current,true)){setAnnounced(true);const audioToken=audioEpoch.current;void chime.current?.play().then(ok=>{if(generation.current===epoch&&audioEpoch.current===audioToken&&active.current){setSoundReady(ok);if(!ok)setNotice('소리가 차단됐어요. 소리 확인이나 아래 재생 버튼을 눌러 주세요.');}});}
    };
    const timer=setInterval(check,1000);document.addEventListener('visibilitychange',check);
    // A prior installed iOS web app may have push enabled. This mode uses page sound only.
    let disposed=false;
    if('serviceWorker'in navigator&&'PushManager'in window)void (async()=>{try{const r=await navigator.serviceWorker.getRegistration('/');const sub=await r?.pushManager.getSubscription();if(sub&&!disposed)await api(recipientPath('/shared-pickup/push',pickup.id),'DELETE',{endpoint:sub.endpoint});}catch{/* no new push subscription or permission is created */}})();
    return()=>{disposed=true;generation.current++;audioEpoch.current++;active.current=false;s.disarm();chime.current?.stop();clearInterval(timer);document.removeEventListener('visibilitychange',check);session.current=null;chime.current=null;};
  },[pickup.id]);
  async function preview() {
    const epoch=generation.current,audioToken=++audioEpoch.current;setBusy(true);priming.current=true;setNotice('');
    const started=chime.current?.unlock(); // Called before await, directly from the user gesture.
    const ok=await started;
    if(generation.current!==epoch||audioEpoch.current!==audioToken||!active.current)return;
    priming.current=false;setBusy(false);setSoundReady(!!ok);
    setNotice(ok?'확인 소리 재생이 시작됐어요.':'소리를 재생하지 못했어요. 아래 재생 버튼과 iPhone 음량을 확인해 주세요.');
  }
  function toggle(){
    if(enabled){audioEpoch.current++;active.current=false;session.current?.disarm();chime.current?.stop();chime.current=new ArrivalChime(()=>media.current!);setEnabled(false);setAnnounced(false);setBusy(false);priming.current=false;setNotice('');setSoundReady(false);}
    else{active.current=true;session.current?.arm();setEnabled(true);void preview();}
  }
  if(pickup.state==='ARRIVED')return null;
  return <section className="arrival-reminder pickup-control" aria-label="도착 알림">
    <div className="control-row"><span className="control-symbol"><Icon name="clock" size={21}/></span><div className="control-copy"><h3>도착 알림</h3><p>{enabled?(soundReady?'이 화면에서 소리로 알려드릴게요.':'화면 알림이 켜졌어요. 소리를 확인해 주세요.'):'5분 전, 소리와 화면으로 알려드려요.'}</p></div><button className={`secondary control-button${enabled?' is-on':''}`} aria-pressed={enabled} onClick={toggle}>{enabled?'알림 끄기':'알림 켜기'}</button></div>
    <p className="control-note">웹을 열어둔 동안만 알려드려요.</p>
    {enabled&&<button className="text-button sound-check" disabled={busy} onClick={()=>void preview()}>{busy?'소리 준비 중…':'소리 확인'}</button>}
    <details className="sound-help" hidden={!enabled}><summary>소리 직접 재생</summary><audio ref={media} className="arrival-sound-player" controls preload="auto" src="/audio/arrival-chime.wav" aria-label="도착 알림 소리" onPlaying={()=>{if(active.current){chime.current?.confirmPlayback();setSoundReady(true);}}}/></details>
    {notice&&<p className="control-note" role="status">{notice}</p>}
    {announced&&<aside className="arrival-sound-toast" role="alert"><span className="control-symbol"><Icon name="clock" size={24}/></span><div><strong>곧 도착해요</strong><p>5분 이내 도착 예정이에요. 만날 준비를 해 주세요.</p></div><button className="text-button" aria-label="도착 알림 닫기" onClick={()=>setAnnounced(false)}><Icon name="close" size={22}/></button></aside>}
  </section>;
}
