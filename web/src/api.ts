export class ApiError extends Error {
  constructor(public status:number,public code:string,message:string){super(message);}
}
export function recipientPath(path:string,pickupId:string) {
  if(!/^[a-f0-9-]{36}$/i.test(pickupId))throw new ApiError(400,'PICKUP_SCOPE_REQUIRED','받은 픽업 링크를 다시 열어 주세요.');
  return `${path}${path.includes('?')?'&':'?'}pickupId=${encodeURIComponent(pickupId)}`;
}
export async function api<T>(path:string,method='GET',body?:unknown,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<T> {
  const controller=new AbortController();let timedOut=false;
  const abort=()=>controller.abort();
  if(options.signal?.aborted)controller.abort();else options.signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs??12_000);
  try {
    const response=await fetch(`/api${path}`,{method,credentials:'same-origin',signal:controller.signal,
      ...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    const data=await response.json().catch(()=>null);
    if(!response.ok)throw new ApiError(response.status,data?.code??'HTTP_ERROR',data?.message??'연결을 확인한 뒤 다시 시도해 주세요.');
    if(data===null)throw new ApiError(502,'INVALID_RESPONSE','응답을 확인하지 못했어요. 다시 연결해 주세요.');
    return data as T;
  }catch(error){
    if(error instanceof ApiError)throw error;
    if(options.signal?.aborted)throw error;
    throw new ApiError(0,timedOut?'REQUEST_TIMEOUT':'NETWORK_ERROR',timedOut?'응답이 늦어지고 있어요. 연결을 다시 확인할게요.':'연결이 끊겼어요. 인터넷 연결을 확인해 주세요.');
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
export type Point={latitude:number;longitude:number};
export type RecipientLocation={state:'OFF'|'WAITING'|'LIVE'|'PAUSED'|'STALE';sessionId:string|null;ageMs:number|null;position:{location:Point;accuracyMeters:number;observedAt:string;receivedAt:string}|null};
export type Pickup={
  id:string;state:'ACTIVE'|'ARRIVED'|'ENDED'|'EXPIRED';readiness:'UNKNOWN'|'PREPARING'|'OUTSIDE';
  recipientLocation?:RecipientLocation;
  waitingPoint?:{source:'MANUAL';location:Point;selectedAt:string}|null;waitingPointRevision?:number;waitingPointConsent?:boolean;
  vehicle?:{modelKey:string|null;modelName?:string|null;licensePlate?:string|null}|null;
  destination:(Point&{name:string})|null;
  observation:{location:Point;remainingSeconds:number;remainingMeters:number;locationReceivedAt:string;etaReceivedAt:string;uploadedAt:string}|null;
  freshness:'FRESH'|'STALE';expiresAt:string;arrivedAt:string|null;
  plannedRoute?:{state:'READY'|'LOADING'|'UNAVAILABLE'|'WAITING'|'STALE';provider:'KAKAO';calculatedAt:string|null;validForMs:number;path:number[][]|null;traveledPaths?:number[][][]};
};
export function takeFragmentToken() {
  const value=new URLSearchParams(window.location.hash.slice(1)).get('token');
  // The secret stays in component memory and is never included in subsequent navigation.
  if(window.location.hash)history.replaceState(null,'',window.location.pathname+(value?'':window.location.search));
  return value;
}
