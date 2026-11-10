import type {Pickup} from './api';
import {isNearArrival} from './ArrivalNotice.js';
export function usesPageSound(agent:{userAgent:string;platform:string;maxTouchPoints:number}) {
  return /iPad|iPhone|iPod/.test(agent.userAgent)||(agent.platform==='MacIntel'&&agent.maxTouchPoints>1);
}
type Store={getItem:(key:string)=>string|null;setItem:(key:string,value:string)=>void};
/** One foreground notice per pickup/tab. No coordinates, phone, or share credentials are stored. */
export class ForegroundArrival {
  private enabled=false;private delivered=false;private key:string;
  constructor(private id:string,private store?:Store,now=Date.now()) {
    this.key='pmu:arrival-sound:'+id;
    try{this.delivered=Number(store?.getItem(this.key))>now;}catch{/* storage may be disabled */}
  }
  arm(){this.enabled=true;}
  disarm(){this.enabled=false;}
  check(pickup:Pickup,visible:boolean,now=Date.now()) {
    if(!this.enabled||this.delivered||!visible||pickup.id!==this.id||!isNearArrival(pickup,now))return false;
    this.delivered=true;
    try{this.store?.setItem(this.key,String(Date.parse(pickup.expiresAt)));}catch{/* in-memory guard remains */}
    return true;
  }
}
type ChimeMedia=Pick<HTMLAudioElement,'play'|'pause'|'currentTime'|'preload'|'volume'|'muted'|'setAttribute'>;
/** Uses Safari's media playback path. A successful constructor is never treated as playback. */
export class ArrivalChime {
  private audio:ChimeMedia|null=null;private generation=0;private primed=false;
  constructor(private create:()=>ChimeMedia=()=>new Audio('/audio/arrival-chime.wav'),private timeoutMs=4000){}
  confirmPlayback(){this.primed=true;}
  unlock(){return this.play(true);}
  async play(gesture=false):Promise<boolean> {
    if(!gesture&&!this.primed)return false;
    const generation=++this.generation;
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{
      this.audio??=this.create();const audio=this.audio;
      audio.preload='auto';audio.volume=1;audio.muted=false;audio.setAttribute('playsinline','');
      audio.pause();try{audio.currentTime=0;}catch{}
      // Keep this call synchronous in the button's click stack, before any await.
      const started=audio.play();
      await Promise.race([started,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('PLAYBACK_TIMEOUT')),this.timeoutMs);})]);
      if(generation!==this.generation)return false;
      this.primed=true;return true;
    }catch{if(generation===this.generation)this.audio?.pause();return false;}
    finally{if(timeout)clearTimeout(timeout);}
  }
  pause(){this.generation++;this.audio?.pause();}
  stop(){this.pause();this.primed=false;this.audio=null;}
}
