import {fresh, type Observation} from './domain.js';

type Point={latitude:number;longitude:number};
export type Path=number[][]; // [longitude, latitude], road geometry rather than a GPS track.
export type PlannedRoute={state:'READY'|'LOADING'|'UNAVAILABLE'|'WAITING'|'STALE';provider:'KAKAO';calculatedAt:string|null;validForMs:number;path:Path|null;traveledPaths:Path[]};
type Pickup={id:string;state:string;expires_at:Date|string;destination:Point|null;latest_observation:Observation|null};
type Entry={destination:Point;origin:Point;expires:number;attempted:number;calculated:number|null;path:Path|null;completed:Path[];progress:number;pending:boolean;abort:AbortController};
const interval=60_000,stationaryInterval=180_000,lifetime=300_000,maxPoints=4_000;
function valid(p:unknown):p is Point {const q=p as Point;return !!q&&Number.isFinite(q.latitude)&&Number.isFinite(q.longitude)&&Math.abs(q.latitude)<=90&&Math.abs(q.longitude)<=180;}
function xy(p:Point,base:Point){return [(p.longitude-base.longitude)*111_320*Math.cos(base.latitude*Math.PI/180),(p.latitude-base.latitude)*111_320];}
function distance(a:Point,b:Point){return Math.hypot(...xy(a,b));}
const point=(p:number[])=>({longitude:p[0],latitude:p[1]});

/** Keep road shape within 5m while bounding SSE/WebView payloads. No straight-line fallback. */
function simplify(path:Path):Path {
  const keep=new Set([0,path.length-1]),stack=[[0,path.length-1]];
  while(stack.length){const [a,b]=stack.pop()!,base=point(path[a]),[bx,by]=xy(point(path[b]),base);let far=25,index=-1;
    for(let i=a+1;i<b;i++){const [x,y]=xy(point(path[i]),base),t=Math.max(0,Math.min(1,(x*bx+y*by)/(bx*bx+by*by||1))),d=(x-t*bx)**2+(y-t*by)**2;if(d>far){far=d;index=i;}}
    if(index>=0){keep.add(index);stack.push([a,index],[index,b]);}
  }
  return [...keep].sort((a,b)=>a-b).map(i=>path[i]);
}
export function decodeRoute(value:any,origin:Point,destination:Point):Path {
  const route=value?.routes?.[0];if(route?.result_code!==0||!Array.isArray(route.sections)||!route.sections.length)throw Error('NO_ROUTE');
  const path:Path=[];
  for(const section of route.sections){
    if(!Array.isArray(section.roads)||!section.roads.length)throw Error('INVALID_ROUTE');
    for(const road of section.roads){const v=road.vertexes;
      if(!Array.isArray(v)||v.length<4||v.length%2)throw Error('INVALID_ROUTE');
      const first={longitude:v[0],latitude:v[1]};
      if(!valid(first)||(path.length&&distance(point(path.at(-1)!),first)>200))throw Error('DISCONNECTED_ROUTE');
      for(let i=0;i<v.length;i+=2){const p={longitude:v[i],latitude:v[i+1]};if(!valid(p))throw Error('INVALID_ROUTE');
        const pair=[+p.longitude.toFixed(6),+p.latitude.toFixed(6)],last=path.at(-1);
        if(!last||pair[0]!==last[0]||pair[1]!==last[1])path.push(pair);
        if(path.length>100_000)throw Error('ROUTE_TOO_LARGE');
      }
    }
  }
  if(path.length<2||distance(point(path[0]),origin)>500||distance(point(path.at(-1)!),destination)>500)throw Error('WRONG_ROUTE');
  const result=simplify(path);if(result.length>maxPoints)throw Error('ROUTE_TOO_LARGE');return result;
}
/** Split the current road plan at the car, without reversing progress for GPS jitter. */
export function splitRoute(path:Path,origin:Point,minimumProgress=0):{remaining:Path;passed:Path;progress:number}|null {
  let best=Infinity,index=0,fraction=0,cut:number[]=[];
  for(let i=0;i<path.length-1;i++){
    if(i+1<minimumProgress)continue;
    const [ax,ay]=xy(point(path[i]),origin),[bx,by]=xy(point(path[i+1]),origin),dx=bx-ax,dy=by-ay;
    const t=Math.max(0,minimumProgress-i,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1))),d=Math.hypot(ax+t*dx,ay+t*dy);
    if(d<best){best=d;index=i;fraction=t;cut=[+(path[i][0]+t*(path[i+1][0]-path[i][0])).toFixed(6),+(path[i][1]+t*(path[i+1][1]-path[i][1])).toFixed(6)];}
  }
  return best<=150?{remaining:[cut,...path.slice(index+1)],passed:index+fraction>0?[...path.slice(0,index+1),cut]:[],progress:index+fraction}:null;
}
export function remainingPath(path:Path,origin:Point):Path|null {return splitRoute(path,origin)?.remaining??null;}
/** Retain bounded, separate road fragments, never connect a reroute gap or store raw GPS history. */
function completedPaths(paths:Path[],budget:number):Path[] {
  const result:Path[]=[];let remaining=budget;
  for(let i=paths.length-1;i>=0&&remaining>=2&&result.length<32;i--){const p=paths[i];if(p.length<2)continue;const keep=p.slice(-remaining);result.unshift(keep);remaining-=keep.length;}
  return result;
}
export class PlannedRoutes {
  private static instances=new Set<PlannedRoutes>();
  private entries=new Map<string,Entry>();
  private sweep:ReturnType<typeof setInterval>;
  constructor(private key?:string,private fetcher:typeof fetch=fetch,private now=Date.now){
    PlannedRoutes.instances.add(this);this.sweep=setInterval(()=>this.prune(),5_000);this.sweep.unref();
  }
  static forget(id:string){for(const service of this.instances)service.forget(id);}
  private forget(id:string){this.entries.get(id)?.abort.abort();this.entries.delete(id);}
  close(){clearInterval(this.sweep);for(const id of this.entries.keys())this.forget(id);PlannedRoutes.instances.delete(this);}
  private prune(){const now=this.now();for(const [id,e]of this.entries)if(now>=e.expires||now-e.attempted>lifetime)this.forget(id);}
  read(pickup:Pickup):PlannedRoute {
    const empty=(state:PlannedRoute['state']):PlannedRoute=>({state,provider:'KAKAO',calculatedAt:null,validForMs:0,path:null,traveledPaths:[]});
    const now=this.now(),sample=pickup.latest_observation;
    if(pickup.state!=='ACTIVE'||Date.parse(String(pickup.expires_at))<=now||!valid(pickup.destination)||!sample||!valid(sample.location)){this.forget(pickup.id);return empty('WAITING');}
    if(!fresh(sample,now)){this.forget(pickup.id);return empty('STALE');}
    if(!this.key)return empty('UNAVAILABLE');
    this.prune();let e=this.entries.get(pickup.id);
    if(e&&(distance(e.destination,pickup.destination)>1)){this.forget(pickup.id);e=undefined;}
    const section=e?.path?splitRoute(e.path,sample.location,e.progress):null;
    if(e&&section)e.progress=section.progress;
    const path=section?.remaining??null;
    const passed=[...(e?.completed??[]),...(section?.passed.length?[section.passed]:[])];
    const due=!e||(!e.pending&&now-e.attempted>=interval&&(!path||distance(e.origin,sample.location)>=250||now-(e.calculated??0)>=stationaryInterval));
    if(due){
      if(!e&&this.entries.size>=128)return empty('UNAVAILABLE');
      const previous=e;e={origin:sample.location,destination:pickup.destination,expires:Date.parse(String(pickup.expires_at)),attempted:now,calculated:previous?.calculated??null,path:previous?.path??null,completed:previous?.completed??[],progress:previous?.progress??0,pending:true,abort:new AbortController()};
      const carry=section?passed:[...e.completed,...(e.path&&e.progress>0?[e.path.slice(0,Math.floor(e.progress)+1)]:[])];
      this.entries.set(pickup.id,e);void this.load(pickup.id,e,carry);
    }
    if(e?.calculated!==null&&e?.calculated!==undefined&&now-e.calculated<lifetime&&path)return {state:'READY',provider:'KAKAO',calculatedAt:new Date(e.calculated).toISOString(),validForMs:Math.max(0,Math.min(30_000-(now-Date.parse(sample.locationReceivedAt)),30_000-(now-Date.parse(sample.etaReceivedAt)),lifetime-(now-e.calculated),e.expires-now)),path,traveledPaths:completedPaths(passed,maxPoints-path.length)};
    return empty(e?.pending?'LOADING':'UNAVAILABLE');
  }
  private async load(id:string,e:Entry,carry:Path[]){
    const timeout=setTimeout(()=>e.abort.abort(),5_000);timeout.unref();
    try {
      const url=new URL('https://apis-navi.kakaomobility.com/v1/directions');url.search=new URLSearchParams({origin:`${e.origin.longitude},${e.origin.latitude}`,destination:`${e.destination.longitude},${e.destination.latitude}`,summary:'false',alternatives:'false',priority:'RECOMMEND',road_details:'false'}).toString();
      const response=await this.fetcher(url,{headers:{Authorization:`KakaoAK ${this.key}`,Accept:'application/json'},signal:e.abort.signal,redirect:'error'});
      if(!response.ok||!response.body)throw Error('ROUTE_UNAVAILABLE');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4_000_000)throw Error('ROUTE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel();}
      const path=decodeRoute(JSON.parse(Buffer.concat(chunks).toString('utf8')),e.origin,e.destination);
      if(this.entries.get(id)===e&&!e.abort.signal.aborted&&this.now()<e.expires){e.path=path;e.completed=completedPaths(carry,maxPoints-path.length);e.progress=0;e.calculated=this.now();}
    }catch{} // Keep a still-valid road during transient refresh failures. Never log provider bodies or keys.
    finally{clearTimeout(timeout);e.pending=false;}
  }
}
