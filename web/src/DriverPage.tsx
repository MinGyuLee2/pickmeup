import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { Brand, Icon } from './Design';
import { PickupIllustration } from './PickupIllustration';
type Driver={id:string;name:string;localSimulation:boolean};
type Vehicle={id:string;name:string;modelKey:string|null;modelName?:string|null;licensePlate?:string|null};
type Preview={id:string;kind:string;status:string;message:string;shareLink?:string};

export function DriverPage() {
  const [driver,setDriver]=useState<Driver|null>(null),[loading,setLoading]=useState(true);
  const [phone,setPhone]=useState(''),[name,setName]=useState(''),[code,setCode]=useState(''),[challenge,setChallenge]=useState(''),[developmentCode,setDevelopmentCode]=useState('');
  const [vehicles,setVehicles]=useState<Vehicle[]>([]),[messages,setMessages]=useState<Preview[]>([]);
  const [vehiclesLoaded,setVehiclesLoaded]=useState(false);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [otpStatus,setOtpStatus]=useState(''),[otpInactive,setOtpInactive]=useState(false);
  async function refresh(owner=driver) {
    if(!owner)return;
    setVehiclesLoaded(false);setVehicles(await api<Vehicle[]>('/vehicles'));setVehiclesLoaded(true);
    if(owner.localSimulation)setMessages((await api<{messages:Preview[]}>('/dev/messages')).messages);
  }
  useEffect(()=>{void api<Driver>('/me').then(owner=>{setDriver(owner);return refresh(owner);}).catch(cause=>{if(!(cause instanceof ApiError&&cause.status===401))setError((cause as Error).message);}).finally(()=>setLoading(false));},[]);
  useEffect(()=>{
    if(!challenge||driver)return;
    let disposed=false,pending=false;
    async function poll(){
      if(pending)return;pending=true;
      try{const result=await api<{status:string;active:boolean}>(`/auth/otp/${challenge}/status`);
        if(!disposed){setOtpStatus(result.status);setOtpInactive(!result.active);}}
      catch{}finally{pending=false;}
    }
    void poll();const timer=setInterval(()=>void poll(),3000);
    return()=>{disposed=true;clearInterval(timer);};
  },[challenge,driver?.id]);
  async function perform(action:()=>Promise<void>) {
    setBusy(true);setError('');
    try{await action();}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  function requestCode(event:FormEvent) {event.preventDefault();void perform(async()=>{
    const response=await api<{challengeId:string;developmentCode?:string}>('/auth/otp/request','POST',{phone});
    setChallenge(response.challengeId);setDevelopmentCode(response.developmentCode??'');setOtpStatus('PENDING');setOtpInactive(false);
  });}
  function verify(event:FormEvent) {event.preventDefault();void perform(async()=>{
    await api('/auth/otp/verify','POST',{challengeId:challenge,code,...(name.trim()?{name}:{} )});
    const owner=await api<Driver>('/me');setDriver(owner);setCode('');setDevelopmentCode('');setChallenge('');await refresh(owner);
  });}
  return <main className="driver-page">
    <div className="topline"><Brand/>{driver&&<button className="text-button" onClick={()=>void perform(async()=>{await api('/auth/logout','POST',{});setDriver(null);setVehicles([]);setVehiclesLoaded(false);setMessages([]);})}>로그아웃</button>}</div>
    <header className={driver?'driver-hero signed-in':'driver-hero'}><h1>{driver?'연결된 차량':'내 계정 연결하기'}</h1>{driver?<p>{driver.name}님, 픽업은 차량의 픽미업에서 시작하세요.</p>:<p>픽업은 차량에서 인증 없이 바로 시작할 수 있어요. 계정 연결은 선택이에요.</p>}
      {!driver&&!loading&&!challenge&&<div className="login-art"><PickupIllustration scene="pickup-ready"/></div>}
    </header>
    {error&&<p className="error" role="alert">{error}</p>}
    {loading?<p>확인 중…</p>:!driver?<section className="panel login"><h2>로그인</h2>
      {!challenge?<form onSubmit={requestCode}><label>이름<input value={name} onChange={e=>setName(e.target.value)} maxLength={30} autoComplete="name" placeholder="상대에게 표시할 이름"/></label>
        <label>휴대전화 번호<input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} autoComplete="tel" required placeholder="010-0000-0000"/></label><button className="primary" disabled={busy}>인증번호 받기</button></form>
      :<form onSubmit={verify}>{developmentCode&&<p className="dev-code">테스트 인증번호 <strong>{developmentCode}</strong><small>실제 문자 발송 없음</small></p>}
        {(!developmentCode||otpInactive)&&<p className="muted" role="status">{otpInactive?'인증 시간이 지났어요. 다시 요청해 주세요.':({PENDING:'인증번호를 보내고 있어요.',ACCEPTED:'문자 전달을 확인하고 있어요.',DELIVERED:'받은 인증번호를 입력하세요.',UNKNOWN:'문자 전달 미확인 · 받은 번호가 있다면 입력하세요.',FAILED:'문자 발송 실패 · 잠시 후 다시 요청하세요.',SIMULATED:'실제 문자 발송 없음',CANCELLED:'인증 요청이 취소됐어요.'} as Record<string,string>)[otpStatus]}</p>}
        <label>인증번호<input value={code} onChange={e=>setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required/></label><button className="primary" disabled={busy||otpInactive}>로그인</button>
        <button type="button" className="text-button" onClick={()=>setChallenge('')}>번호 다시 입력</button></form>}
      </section>:<>
      {driver.localSimulation&&<p className="environment-note">테스트 모드 · 실제 문자 발송 없음</p>}
      <section className="connection-panel" aria-labelledby="connected-vehicles"><h2 id="connected-vehicles" className="sr-only">연결된 차량</h2>
        {!vehiclesLoaded?<div className="no-vehicle"><p>{busy?'연결 상태를 확인하고 있어요.':'차량 연결 상태를 확인하지 못했어요.'}</p><button className="secondary" disabled={busy} onClick={()=>void perform(()=>refresh())}>다시 확인</button></div>:vehicles.length?<ul className="connected-vehicles">{vehicles.map(car=><li key={car.id}><span className="connected-car-icon"><Icon name="car" size={26}/></span><strong>{car.name}</strong><span className="connection-pill"><Icon name="check" size={15}/>연결됨</span><VehicleDetails car={car} busy={busy} save={(modelName,licensePlate)=>perform(async()=>{await api(`/vehicles/${car.id}`,'PATCH',{modelName,licensePlate});await refresh();})}/></li>)}</ul>:<div className="no-vehicle"><p>아직 연결된 차량이 없어요.</p><p className="muted">차량에서 ‘바로 시작’한 뒤 홈의 ‘계정 연결 (선택)’을 눌러 주세요. 휴대전화로 받은 문자 링크에서 연결을 마칠 수 있어요.</p></div>}
        {vehiclesLoaded&&vehicles.length>0&&<p className="connection-caption">차량에서 연락처를 고르거나 번호를 직접 입력해 픽업 상대를 추가할 수 있어요.</p>}
      </section>
      {driver.localSimulation&&<details className="panel dev-panel"><summary>개발용 문자함</summary><button className="text-button" disabled={busy} onClick={()=>void perform(()=>refresh())}>새로고침</button>
        {!messages.length&&<p className="muted">안내 메시지가 없어요.</p>}{messages.map(message=><article className="message-preview" key={message.id}><small>{message.kind} · {message.status}</small><p>{message.message}</p>{message.shareLink&&<a className="inline-link" href={message.shareLink} target="_blank" rel="noreferrer">수신자 화면 열기 ↗</a>}</article>)}
      </details>}
    </>}

  </main>;
}

function VehicleDetails({car,busy,save}:{car:Vehicle;busy:boolean;save:(model:string,plate:string)=>Promise<void>}) {
 const [model,setModel]=useState(car.modelName??(car.modelKey==='ioniq5'?'아이오닉 5':'')),[plate,setPlate]=useState(car.licensePlate??'');
 return <details className="optional-car"><summary>차량 정보 (선택)</summary><form onSubmit={e=>{e.preventDefault();void save(model,plate);}}><label>차종<input maxLength={40} value={model} onChange={e=>setModel(e.target.value)} placeholder="예: 아이오닉 5"/></label><label>차량번호<input maxLength={20} value={plate} onChange={e=>setPlate(e.target.value)} placeholder="예: 123가 4567"/></label><button className="secondary" disabled={busy}>저장</button></form></details>;
}
