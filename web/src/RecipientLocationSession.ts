export type LocationPhase='OFF'|'ASKING'|'SHARING'|'PAUSED'|'STOPPING'|'ERROR';
export const LOCATION_CONSENT_VERSION='2026-11-08';
export type LocationUi={phase:LocationPhase;error:string;sessionId:string|null;hasLease:boolean};
type Lease={lease:string;sessionId:string;sequence:number;paused:boolean};
type Sample={location:{latitude:number;longitude:number};accuracyMeters:number;observedElapsed:number};
export type LocationTransport=(method:string,body:unknown,keepalive?:boolean)=>Promise<any>;

export async function locationTransport(method:string,body:unknown,keepalive=false,pickupId?:string) {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15_000);
  try {
    const response=await fetch('/api/shared-pickup/location?pickupId='+encodeURIComponent(pickupId??''),{method,credentials:'same-origin',keepalive,signal:controller.signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok)throw Object.assign(new Error(data.message??'위치 공유 연결을 확인해 주세요.'),{status:response.status,code:data.code});
    return data;
  }finally{clearTimeout(timeout);}
}
/** Owns one explicit opt-in. No permission request, coordinates, or lease are persisted. */
export class RecipientLocationSession {
  private epoch=0;private intent=false;private disposed=false;private lease:Lease|null=null;
  private watch:number|null=null;private poll:ReturnType<typeof setInterval>|null=null;
  private delayed:ReturnType<typeof setTimeout>|null=null;private pending:Sample|null=null;
  private uploading=false;private lastSent=-Infinity;
  constructor(private geo:Geolocation|undefined,private visible:()=>boolean,private secure:boolean,
    private emit:(state:LocationUi)=>void,private request:LocationTransport=locationTransport,
    private elapsed=()=>performance.now(),private wall=()=>Date.now()) {}
  private state(phase:LocationPhase,error='') {if(!this.disposed)this.emit({phase,error,sessionId:this.lease?.sessionId??null,hasLease:!!this.lease});}
  private clearCollection() {
    if(this.watch!==null)this.geo?.clearWatch(this.watch);this.watch=null;
    if(this.poll!==null)clearInterval(this.poll);this.poll=null;
    if(this.delayed!==null)clearTimeout(this.delayed);this.delayed=null;
  }
  start(consented=false) {
    if(this.disposed||!consented)return;
    const old=this.lease;this.lease=null;
    if(old)void this.request('DELETE',{lease:old.lease,sequence:++old.sequence},true).catch(()=>{});
    this.epoch++;this.clearCollection();this.pending=null;this.intent=true;this.lastSent=-Infinity;
    if(!this.geo||!this.secure){this.intent=false;this.state('ERROR','이 브라우저에서는 위치를 공유할 수 없어요. 보안 연결된 문자 링크를 열어 주세요.');return;}
    this.state('ASKING');this.collect(this.epoch);
  }
  private collect(epoch:number) {
    if(!this.geo||!this.intent||!this.visible()||this.disposed)return;
    const success=(position:GeolocationPosition)=>{
      if(epoch!==this.epoch||!this.intent||!this.visible()||this.disposed)return;
      const c=position.coords,age=this.wall()-position.timestamp;
      if(!Number.isFinite(age)||age< -5_000||age>30_000||![c.latitude,c.longitude,c.accuracy].every(Number.isFinite)||
        Math.abs(c.latitude)>90||Math.abs(c.longitude)>180||c.accuracy<0||c.accuracy>100_000){this.state('PAUSED','최신 위치를 기다리고 있어요.');return;}
      this.pending={location:{latitude:c.latitude,longitude:c.longitude},accuracyMeters:c.accuracy,observedElapsed:this.elapsed()-Math.max(0,age)};
      this.schedule(epoch);
    };
    const failure=(error:GeolocationPositionError)=>{
      if(epoch!==this.epoch||!this.intent||this.disposed)return;
      if(error.code===1){this.intent=false;this.epoch++;this.clearCollection();}
      this.pauseLease();this.state(this.lease?'PAUSED':'ERROR',error.code===1?'위치 권한을 허용해야 공유할 수 있어요.':'위치를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.');
    };
    const options={enableHighAccuracy:true,maximumAge:5_000,timeout:15_000};
    this.watch=this.geo.watchPosition(success,failure,options);
    this.poll=setInterval(()=>{if(epoch===this.epoch&&this.intent&&this.visible())this.geo?.getCurrentPosition(success,failure,options);},10_000);
  }
  private schedule(epoch:number) {
    if(this.uploading||!this.pending||epoch!==this.epoch)return;
    const wait=5_000-(this.elapsed()-this.lastSent);
    if(wait>0){if(this.delayed===null)this.delayed=setTimeout(()=>{this.delayed=null;void this.flush(epoch);},wait);}
    else void this.flush(epoch);
  }
  private async flush(epoch:number) {
    if(this.uploading||!this.pending||!this.intent||!this.visible()||epoch!==this.epoch||this.disposed)return;
    this.uploading=true;this.lastSent=this.elapsed();
    try {
      if(!this.lease) {
        const result=await this.request('POST',{consent:true,consentVersion:LOCATION_CONSENT_VERSION});
        const lease:Lease={lease:result.lease,sessionId:result.sessionId,sequence:0,paused:false};
        if(epoch!==this.epoch||!this.intent||!this.visible()||this.disposed){void this.request('DELETE',{lease:lease.lease,sequence:1},true).catch(()=>{});return;}
        this.lease=lease;
      }
      const lease=this.lease;
      if(lease.paused) {
        await this.request('PUT',{lease:lease.lease,sequence:++lease.sequence,paused:false});
        if(epoch!==this.epoch||!this.intent||!this.visible()||this.disposed)return;
        lease.paused=false;
      }
      const sample=this.pending;this.pending=null;if(!sample)return;
      const ageMs=Math.round(this.elapsed()-sample.observedElapsed);
      if(ageMs<0||ageMs>30_000){this.state('PAUSED','최신 위치를 기다리고 있어요.');return;}
      await this.request('PUT',{lease:lease.lease,sequence:++lease.sequence,location:sample.location,accuracyMeters:sample.accuracyMeters,ageMs});
      if(epoch===this.epoch&&this.intent&&this.visible()&&!this.disposed){this.lastSent=this.elapsed();this.state('SHARING');}
    } catch(cause) {
      if(epoch!==this.epoch||this.disposed)return;
      const error=cause as Error&{status?:number;code?:string};
      if(error.status===410||error.code==='LOCATION_REPLACED') {
        this.intent=false;this.lease=null;this.epoch++;this.clearCollection();this.state('OFF','위치 공유가 끝났거나 다른 화면에서 다시 시작됐어요.');
      }else if(error.status!==429)this.state('PAUSED','위치 갱신 연결이 끊겼어요. 다시 연결하면 갱신합니다.');
    } finally {
      this.uploading=false;
      if(this.pending&&this.intent&&this.visible()&&!this.disposed)this.schedule(this.epoch);
    }
  }
  private pauseLease() {
    const lease=this.lease;if(!lease)return;lease.paused=true;
    void this.request('PUT',{lease:lease.lease,sequence:++lease.sequence,paused:true},true).catch(()=>{});
  }
  pause() {
    if(!this.intent&&!this.lease)return;
    this.epoch++;this.clearCollection();this.pending=null;this.pauseLease();this.state('PAUSED');
  }
  resume() {
    if(!this.intent||!this.visible()||this.disposed)return;
    this.epoch++;this.clearCollection();this.state('ASKING');this.collect(this.epoch);
  }
  async stop() {
    const epoch=++this.epoch;this.intent=false;this.clearCollection();this.pending=null;
    const lease=this.lease;if(!lease){this.state('OFF');return;}
    this.state('STOPPING');
    try {
      await this.request('DELETE',{lease:lease.lease,sequence:++lease.sequence},true);
      if(epoch===this.epoch){this.lease=null;this.state('OFF');}
    }catch(cause) {
      if(epoch!==this.epoch||this.disposed)return;
      const error=cause as {status?:number};
      if(error.status===409||error.status===410){this.lease=null;this.state('OFF');}
      else this.state('ERROR','중지를 확인하지 못했어요. 위치 수집은 멈췄으니 연결 후 중지를 다시 눌러 주세요.');
    }
  }
  dispose() {this.pause();this.intent=false;this.disposed=true;this.epoch++;this.clearCollection();this.pending=null;}
}
