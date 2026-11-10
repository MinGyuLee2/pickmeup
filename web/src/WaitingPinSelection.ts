import type {Point} from './api';
export type PinDraft={point:Point;source:'MAP'|'GPS';baseRevision:number};
export type PinSelectionState={draft:PinDraft|null;locating:boolean;error:string};
/** Local draft only: no watchPosition, storage, API upload, or automatic permission request. */
export class WaitingPinSelection {
  state:PinSelectionState={draft:null,locating:false,error:''};
  private epoch=0;private disposed=false;private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private emit:(state:PinSelectionState)=>void,private wall=()=>Date.now(),private timeoutMs=15000){}
  private cancelRequest(){this.epoch++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
  private publish(value:PinSelectionState){if(this.disposed)return;this.state=value;this.emit(value);}
  select(point:Point,revision:number){
    if(this.disposed)return;this.cancelRequest();
    this.publish({draft:{point,source:'MAP',baseRevision:this.state.draft?.baseRevision??revision},locating:false,error:''});
  }
  locate(geo:Pick<Geolocation,'getCurrentPosition'>|undefined,revision:number){
    if(this.disposed)return;this.cancelRequest();const epoch=this.epoch,base=this.state.draft?.baseRevision??revision;
    const fail=(message:string)=>{if(this.disposed||epoch!==this.epoch)return;this.cancelRequest();this.publish({...this.state,locating:false,error:message});};
    if(!geo){fail('현재 위치를 찾을 수 없어요. 지도를 움직여 기다릴 곳을 골라 주세요.');return;}
    this.publish({...this.state,locating:true,error:''});
    this.timer=setTimeout(()=>fail('위치 찾기가 늦어지고 있어요. 지도를 움직여 직접 고를 수 있어요.'),this.timeoutMs);
    try{geo.getCurrentPosition(position=>{
      if(this.disposed||epoch!==this.epoch)return;
      const {latitude,longitude,accuracy}=position.coords,age=this.wall()-position.timestamp;
      if(![latitude,longitude,accuracy,age].every(Number.isFinite)||Math.abs(latitude)>90||Math.abs(longitude)>180||accuracy<0||age< -5000||age>30000){fail('최신 위치를 확인하지 못했어요. 지도를 움직여 직접 골라 주세요.');return;}
      this.cancelRequest();this.publish({draft:{point:{latitude,longitude},source:'GPS',baseRevision:base},locating:false,error:''});
    },error=>fail(error.code===1?'위치 권한이 없어도 지도를 움직여 기다릴 곳을 고를 수 있어요.':'현재 위치를 찾지 못했어요. 지도를 움직여 직접 골라 주세요.'),{enableHighAccuracy:true,maximumAge:0,timeout:12000});}
    catch{fail('현재 위치를 찾을 수 없어요. 지도를 움직여 직접 골라 주세요.');}
  }
  clear(){if(this.disposed)return;this.cancelRequest();this.publish({draft:null,locating:false,error:''});}
  dispose(){this.cancelRequest();this.disposed=true;this.state={draft:null,locating:false,error:''};}
}
