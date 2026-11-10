import {useEffect,useRef,useState} from 'react';
import {api,recipientPath,type Pickup} from './api';
import {Icon} from './Design';
import {usesPageSound} from './ForegroundArrival';
import {SoundArrivalReminder} from './SoundArrivalReminder';
type PushState={enabled:boolean;state:string};
function publicKeyBytes(value:string){const s=atob(value.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(s,c=>c.charCodeAt(0));}
export function ArrivalReminder({pickup}:{pickup:Pickup}) {
  return usesPageSound(navigator)?<SoundArrivalReminder key={pickup.id} pickup={pickup}/>:<PushArrivalReminder key={pickup.id} pickup={pickup}/>;
}
function PushArrivalReminder({pickup}:{pickup:Pickup}) {
  const registration=useRef<ServiceWorkerRegistration|null>(null),subscription=useRef<PushSubscription|null>(null),epoch=useRef(0);
  const [enabled,setEnabled]=useState(false),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[key,setKey]=useState(''),[supported,setSupported]=useState(false),[state,setState]=useState('OFF');
  useEffect(()=>{
    const generation=++epoch.current;registration.current=null;subscription.current=null;
    const capable=window.isSecureContext&&'Notification'in window&&'serviceWorker'in navigator&&'PushManager'in window;
    setSupported(capable);setKey('');setEnabled(false);setState('OFF');setNotice('');setBusy(false);
    if(capable)void (async()=>{
      try{
        const config=await api<{available:boolean;publicKey:string|null}>(recipientPath('/shared-pickup/push/config',pickup.id));
        if(epoch.current!==generation)return;
        if(!config.available||!config.publicKey){setNotice('푸시 알림을 준비 중이에요.');return;}
        await navigator.serviceWorker.register('/arrival-notifications.js',{scope:'/'});
        const r=await navigator.serviceWorker.ready;if(epoch.current!==generation)return;
        registration.current=r;setKey(config.publicKey);
        const existing=await r.pushManager.getSubscription();if(epoch.current!==generation)return;subscription.current=existing;
        if(existing){const status=await api<PushState>(recipientPath('/shared-pickup/push/status',pickup.id),'POST',{endpoint:existing.endpoint});if(epoch.current===generation){setEnabled(status.enabled);setState(status.state);}}
      }catch{if(epoch.current===generation)setNotice('푸시 연결을 확인하지 못했어요. 이 화면에서는 도착 알림을 볼 수 있어요.');}
    })();
    // Closing this page MUST NOT revoke server push. Only the explicit off action or pickup end does.
    return()=>{epoch.current++;};
  },[pickup.id]);
  async function enable() {
    const r=registration.current,generation=epoch.current;if(!r||!key||busy)return;
    setBusy(true);setNotice('');
    try{
      // subscribe is invoked by this click, so the browser can present its own permission prompt.
      const current=subscription.current;
      const next=current??await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:publicKeyBytes(key)});
      if(epoch.current!==generation)return;subscription.current=next;
      const saved=await api<PushState>(recipientPath('/shared-pickup/push',pickup.id),'POST',{confirmed:true,subscription:next.toJSON()});
      if(epoch.current!==generation)return;setEnabled(saved.enabled);setState(saved.state);
      setNotice(saved.state==='SENT'?'이번 픽업의 알림은 이미 보냈어요.':saved.enabled?'':'브라우저의 알림 연결을 다시 확인해 주세요.');
    }catch(error){if(epoch.current===generation)setNotice(Notification.permission==='denied'?'알림 권한이 꺼져 있어요. 브라우저 설정에서 허용해 주세요.':(error instanceof Error?error.message:'푸시 알림을 켜지 못했어요.'));}
    finally{if(epoch.current===generation)setBusy(false);}
  }
  async function disable(){const current=subscription.current,generation=epoch.current;if(!current||busy)return;setBusy(true);try{await api(recipientPath('/shared-pickup/push',pickup.id),'DELETE',{endpoint:current.endpoint});if(epoch.current===generation){setEnabled(false);setState('OFF');setNotice('이번 픽업의 푸시 알림을 껐어요.');}}catch(error){if(epoch.current===generation)setNotice((error as Error).message);}finally{if(epoch.current===generation)setBusy(false);}}
  if(pickup.state==='ARRIVED')return null;
  return <section className="arrival-reminder pickup-control" aria-label="도착 알림">
    <div className="control-row"><span className="control-symbol"><Icon name="clock" size={21}/></span><div className="control-copy"><h3>도착 알림</h3><p>{enabled?(state==='SENT'?'이번 픽업의 알림을 요청했어요.':state==='UNKNOWN'?'알림 전달 여부를 확인하지 못했어요.':'5분 전에 알려드릴게요.'):'5분 전, 웹을 닫아도 알려드려요.'}</p></div><button className={`secondary control-button${enabled?' is-on':''}`} aria-pressed={enabled} aria-busy={busy} disabled={busy||(!enabled&&(!supported||!key))} onClick={()=>void (enabled?disable():enable())}>{busy?'처리 중…':enabled?'알림 끄기':'알림 켜기'}</button></div>
    {!supported&&<p className="control-note">이 브라우저에서는 푸시 알림을 지원하지 않아요.</p>}
    {notice&&<p className="control-note" role="status">{notice}</p>}
  </section>;
}
