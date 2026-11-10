import type {Point} from './api';
export class RoadviewUnavailable extends Error {}
export function pointDistance(a:Point,b:Point) {
  const rad=Math.PI/180,dLat=(b.latitude-a.latitude)*rad,dLng=(b.longitude-a.longitude)*rad;
  const h=Math.sin(dLat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dLng/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(Math.min(1,h)));
}
/** Abort late callbacks so switching recipients never displays the previous lookup. */
export function nearestRoadview(client:{getNearestPanoId:(point:any,radius:number,callback:(id:number|string|null)=>void)=>void},point:any,signal:AbortSignal,timeoutMs=8000):Promise<number> {
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(error?:Error,id?:number)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(id!);};
    const abort=()=>finish(new DOMException('Cancelled','AbortError'));
    const timer=setTimeout(()=>finish(new RoadviewUnavailable('주변 사진을 불러오지 못했어요.')),timeoutMs);
    if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});
    try{client.getNearestPanoId(point,50,id=>{const value=typeof id==='string'&&/^\d+$/.test(id)?Number(id):id;if(Number.isSafeInteger(value)&&Number(value)>0)finish(undefined,Number(value));else finish(new RoadviewUnavailable('이 위치 근처에는 로드뷰가 없어요.'))});}catch{finish(new RoadviewUnavailable('로드뷰 연결을 확인해 주세요.'));}
  });
}
