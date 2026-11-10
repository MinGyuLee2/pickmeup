import { useEffect, useState, type FormEvent } from 'react';
import { api, takeFragmentToken } from './api';
import { Brand, Icon } from './Design';

export function SetupPage(){
  const [token,setToken]=useState(takeFragmentToken),[step,setStep]=useState('loading'),[code,setCode]=useState('');
  const [accountLink,setAccountLink]=useState(false);
  const [modelName,setModelName]=useState(''),[licensePlate,setLicensePlate]=useState('');
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function load(){const data=await api<{name:string;completed:boolean;accountLink?:boolean;modelName?:string;licensePlate?:string}>('/onboarding/current');setName(data.name);setAccountLink(!!data.accountLink);setModelName(data.modelName??'');setLicensePlate(data.licensePlate??'');setStep(data.completed?'done':'details');}
  useEffect(()=>{if(token)setStep('verify');else void load().catch(()=>setStep('verify'));},[]);
  useEffect(()=>{
    // A later SMS link can reuse this page without remounting React.
    const receiveLink=()=>{const next=takeFragmentToken();if(next){setToken(next);setCode('');setModelName('');setLicensePlate('');setError('');setStep('verify');}};
    window.addEventListener('hashchange',receiveLink);
    return ()=>window.removeEventListener('hashchange',receiveLink);
  },[]);
  async function submit(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{
    if(step==='verify'){await api('/onboarding/verify','POST',{token,code});setStep('recover');await load();}
    else{await api('/onboarding/complete','POST',{name,modelName,licensePlate});setStep('done');}
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const done=step==='done';
  return <main className="driver-page setup-page"><header className="topline"><Brand/></header><section className={`setup-content ${done?'setup-complete':''}`}>
    {done&&<span className="setup-success" aria-hidden="true"><Icon name="check" size={28}/></span>}
    <p className="eyebrow">{done?'연결 완료':step==='verify'?'계정 연결 · 문자 인증':'계정 연결 · 내 정보'}</p>
    <h1>{done?(accountLink?'계정이 연결됐어요':'준비가 끝났어요'):'내 계정 연결하기'}</h1>
    {step==='loading'?<p>확인 중…</p>:step==='recover'?<><p>인증됐어요. 설정을 불러오고 있어요.</p><button className="primary" disabled={busy} onClick={()=>{setBusy(true);setError('');void load().catch(e=>setError((e as Error).message)).finally(()=>setBusy(false));}}>다시 불러오기</button></>:done?<>
      <p className="setup-lead">{accountLink?'이 차량의 상대·만날 곳·최근 픽업은 그대로예요. 차량으로 돌아가 계속 이용하세요.':'이제 차량의 픽미업에서 첫 픽업을 시작해 보세요.'}</p>
      {!accountLink&&<ol className="setup-steps">
        <li><div><h2>만날 곳을 선택하세요</h2><p>차량 홈의 최근 장소를 고르세요. 새 장소는 ‘내비에서 장소 찾기’를 눌러 검색하고, 내비 안내를 시작한 뒤 픽미업으로 돌아오세요.</p></div></li>
        <li><div><h2>연락할 상대를 고르세요</h2><p>‘연락할 상대’ 목록에서 선택하세요. 처음 연락하는 상대는 연락처에서 고르거나 번호를 직접 입력해 추가하세요.</p></div></li>
        <li><div><h2>길안내·도착 알림을 시작하세요</h2><p>하단의 ‘길안내·도착 알림 시작’을 누르고 ‘보내고 시작’을 선택하세요. ‘바로 메시지 보내기’를 켜면 다음부터 확인 없이 보내요. 직접 전달하려면 ‘문자 없이 시작’ 후 ‘공유’나 ‘메시지 복사’를 이용하세요.</p></div></li>
      </ol>}
      <div className="setup-next"><p>다음부터는 차량 홈의 최근 픽업 카드로 바로 출발할 수 있어요.</p></div>
    </>:<form onSubmit={e=>void submit(e)}>
      {step==='verify'?<><label>문자로 받은 인증번호<input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e=>setCode(e.target.value)}/></label><button className="primary" disabled={busy||!token}>확인</button>{!token&&<p>차량에서 받은 문자 링크를 다시 열어 주세요.</p>}</>:<>
      <label>상대에게 표시할 내 이름<input autoComplete="name" required maxLength={30} value={name} onChange={e=>setName(e.target.value)}/></label>
      <p className="muted">픽업 상대는 차량에서 선택하세요. 차량 정보는 입력하면 상대에게 함께 보여드려요.</p>
      <details className="optional-car"><summary>차량 정보 입력 (선택)</summary><label>차종<input list="car-models" value={modelName} maxLength={40} placeholder="예: 아이오닉 5" onChange={e=>setModelName(e.target.value)}/></label><datalist id="car-models"><option value="아이오닉 5"/><option value="아이오닉 6"/><option value="아반떼"/><option value="쏘나타"/><option value="그랜저"/><option value="투싼"/><option value="싼타페"/></datalist><label>차량번호<input value={licensePlate} maxLength={20} placeholder="예: 123가 4567" onChange={e=>setLicensePlate(e.target.value)}/></label></details>
      <button className="primary" disabled={busy}>{accountLink?'계정 연결하기':'설정 마치기'}</button></>}
    </form>}{error&&<p className="error" role="alert">{error}</p>}
  </section></main>;
}
