type CameraMap={relayout:()=>void;getCenter:()=>unknown;getLevel:()=>number;setCenter:(center:any)=>void;setLevel:(level:number)=>void;setBounds:(bounds:any,top:number,right:number,bottom:number,left:number)=>void};
/** Marker updates never own the user's camera. Only first framing and an explicit fit do. */
export class MapViewport {
  private framed=false;private hadVehicle=false;private hadRoute=false;private userMoved=false;
  constructor(private map:CameraMap,private height:()=>number){}
  interact(){this.userMoved=true;}
  update(bounds:unknown,hasVehicle:boolean,hasRoute=false) {
    if(!this.framed||(!this.userMoved&&((!this.hadVehicle&&hasVehicle)||(!this.hadRoute&&hasRoute))))this.fit(bounds);
    this.hadVehicle=hasVehicle;
    this.hadRoute=this.hadRoute||hasRoute;
  }
  fit(bounds:unknown,expanded=false) {
    const height=this.height(),compact=height<400;
    this.map.setBounds(bounds,expanded?112:Math.min(140,Math.round(height*.42)),compact?32:64,Math.min(64,Math.round(height*.18)),compact?32:64);
    this.framed=true;
  }
  resize() {
    const center=this.map.getCenter(),level=this.map.getLevel();
    this.map.relayout();this.map.setLevel(level);this.map.setCenter(center);
  }
}
