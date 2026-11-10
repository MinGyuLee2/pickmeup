// Loaded only by the development entry point. Fixtures never reach the production bundle.
import { useState } from 'react';
import { ShareView } from './SharePage';
import type { Pickup } from './api';
export default function DesignPreview(){
  const [mode,setMode]=useState('active'),[readiness,setReadiness]=useState<Pickup['readiness']>('UNKNOWN');
  const timestamp=new Date().toISOString();
  const pickup:Pickup={id:'design-fixture',state:mode==='arrived'?'ARRIVED':'ACTIVE',readiness,vehicle:{modelKey:'ioniq5'},destination:{latitude:37.40048888,longitude:127.10387777,name:'판교역 1번 출구'},observation:{location:{latitude:37.4127212,longitude:127.094681},remainingSeconds:720,remainingMeters:2300,locationReceivedAt:timestamp,etaReceivedAt:timestamp,uploadedAt:timestamp},freshness:'FRESH',expiresAt:new Date(Date.now()+3600000).toISOString(),arrivedAt:mode==='arrived'?timestamp:null};
  return <><nav className="preview-toolbar" aria-label="디자인 검증 상태"><strong>디자인 검증용 예시 · 실제 픽업 아님</strong>{[['active','이동 중'],['stale','갱신 지연'],['arrived','도착'],['ended','종료'],['loading','로딩'],['error','오류']].map(([id,label])=><button className={mode===id?'primary':'secondary'} key={id} onClick={()=>setMode(id)}>{label}</button>)}</nav><ShareView pickup={['loading','error'].includes(mode)?null:pickup} stale={mode==='stale'} ended={mode==='ended'} error={mode==='error'?'링크가 만료되었거나 공유가 종료됐어요.':''} onReadiness={setReadiness}/></>;
}
