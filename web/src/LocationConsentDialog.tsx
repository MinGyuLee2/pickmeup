import {useEffect,useRef,useState} from 'react';
import {Icon} from './Design';

export function LocationConsentDialog({onCancel,onAgree}:{onCancel:()=>void;onAgree:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [agreed,setAgreed]=useState(false);
  useEffect(()=>{
    const element=dialog.current!;const overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';element.showModal();
    return()=>{element.close();document.body.style.overflow=overflow;};
  },[]);
  return <dialog ref={dialog} className="location-consent-dialog" aria-labelledby="location-consent-title" aria-describedby="location-consent-intro" onCancel={event=>{event.preventDefault();onCancel();}} onClick={event=>{if(event.target===event.currentTarget)onCancel();}}>
    <div className="consent-dialog-content">
      <button className="text-button consent-close" aria-label="닫기" onClick={onCancel}><Icon name="close" size={22}/></button>
      <h2 id="location-consent-title">내 위치 공유</h2>
      <p id="location-consent-intro" className="muted">이 픽업의 운전자에게만 위치를 보여줘요.</p>
      <details className="consent-terms"><summary>위치정보 수집·이용 및 제공 약관 <Icon name="chevron" size={18}/></summary>
      <dl className="consent-details">
        <div><dt>공유 항목</dt><dd>현재 위치(위도·경도), 위치 정확도, 갱신 시각</dd></div>
        <div><dt>이용 목적</dt><dd>이 픽업의 운전자가 나를 찾을 수 있도록 차량 지도에 표시</dd></div>
        <div><dt>보관·삭제</dt><dd>공유를 중지하거나 픽업이 종료·만료되면 위치를 삭제해요. 화면을 닫거나 숨기면 갱신이 멈춰요.</dd></div>
      </dl>
      <p className="consent-optional">동의하지 않아도 도착 시간 확인과 ‘나왔어요’는 이용할 수 있어요.</p>
      </details>
      <label className="consent-checkbox"><input type="checkbox" checked={agreed} onChange={event=>setAgreed(event.target.checked)}/><span>위 약관에 동의합니다. <small>(선택)</small></span></label>
      <div className="consent-footer"><button className="secondary" onClick={onCancel}>나중에</button><button className="primary" disabled={!agreed} onClick={onAgree}>동의하고 공유</button></div>
    </div>
  </dialog>;
}
