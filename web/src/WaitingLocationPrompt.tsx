import {useEffect,useRef,useState} from 'react';
import {Icon} from './Design';
export type LocationPromptAction='intro'|'edit'|'locate';
/** No location request or upload occurs until the user explicitly agrees. */
export function WaitingLocationPrompt({action,ready,busy,error,onCancel,onAgree}:{action:LocationPromptAction;ready:boolean;busy:boolean;error:string;onCancel:()=>void;onAgree:()=>void}){
  const heading=useRef<HTMLHeadingElement>(null),dialog=useRef<HTMLDialogElement>(null),[agreed,setAgreed]=useState(false);
  useEffect(()=>{const el=dialog.current!,previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';el.showModal();heading.current?.focus({preventScroll:true});
    return()=>{el.close();document.body.style.overflow=overflow;previous?.focus();};
  },[]);
  return <dialog ref={dialog} className="waiting-location-prompt" aria-labelledby="waiting-prompt-title" onCancel={e=>{e.preventDefault();onCancel()}}>
    <div className="waiting-prompt-content"><span className="waiting-prompt-symbol"><Icon name={action==='locate'?'locate':'pin'} size={28}/></span>
      <h2 ref={heading} tabIndex={-1} id="waiting-prompt-title">{action==='intro'?'먼저, 기다릴 곳을 정해 주세요':action==='locate'?'현재 위치를 찾을까요?':'만날 위치를 선택할까요?'}</h2>
      <p>{action==='intro'?'운전자가 정확한 곳으로 찾아올 수 있어요.':action==='locate'?'내 위치를 한 번 찾은 뒤, 지도에서 조정할 수 있어요.':'지도를 움직여 기다릴 곳을 골라 주세요.'}<br/>확정한 핀 하나만 운전자에게 보여요.</p>
      <details><summary>위치정보 이용 약관</summary><p>현재 위치 찾기를 선택하면 기기의 위치를 한 번 조회해 지도에 표시해요. 확정 전 위치는 서버에 보내지 않아요. 확정한 위도·경도와 지정 시각은 이 픽업의 운전자에게 제공하며, 지도와 카카오 로드뷰에서 확인할 수 있어요. 핀 삭제·픽업 종료·만료·인증 링크 교체 시 좌표를 삭제해요. 동의하지 않아도 도착 안내는 볼 수 있어요.</p></details>
      <label><input type="checkbox" checked={agreed} disabled={busy} onChange={e=>setAgreed(e.target.checked)}/><span>위치정보 이용과 운전자 제공에 동의해요.</span></label>
      {error&&<p className="error" role="alert">{error}</p>}
      <div className="waiting-prompt-actions"><button className="secondary" disabled={busy} onClick={onCancel}>{action==='intro'?'나중에':'취소'}</button><button className="primary" disabled={!agreed||!ready||busy} onClick={onAgree}>{busy?'동의 저장 중…':!ready?'지도 연결 중…':action==='locate'?'동의하고 위치 찾기':'동의하고 위치 정하기'}</button></div>
    </div>
  </dialog>;
}
