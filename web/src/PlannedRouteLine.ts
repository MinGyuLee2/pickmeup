export type RouteSnapshot={state:string;path:number[][]|null;traveledPaths?:number[][][];validForMs:number};
/** Separate completed road fragments from the remaining route; overlays never own the camera. */
export class PlannedRouteLine {
  private lines=new Map<string,any[]>();private signature='';private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(private maps:any,private map:any){}
  update(route:RouteSnapshot|undefined,visible=true){
    clearTimeout(this.timer);
    const path=route?.path,passed=route?.traveledPaths??[];
    const valid=(p:unknown):p is number[][]=>Array.isArray(p)&&p.length>=2&&p.every(q=>Array.isArray(q)&&q.length===2&&Number.isFinite(q[0])&&Number.isFinite(q[1])&&Math.abs(q[0])<=180&&Math.abs(q[1])<=90);
    if(!visible||route?.state!=='READY'||!Number.isFinite(route.validForMs)||route.validForMs<=0||!valid(path)||!Array.isArray(passed)||passed.length>32||!passed.every(valid)||path.length+passed.reduce((n,p)=>n+p.length,0)>4000){this.clear();return;}
    const signature=JSON.stringify([path,passed]);
    if(signature!==this.signature){
      this.signature=signature;const updated=new Map<string,any[]>();
      const draw=(road:number[][],key:string,completed=false)=>{const points=road.map(p=>new this.maps.LatLng(p[1],p[0]));
        const existing=this.lines.get(key);
        if(existing){existing.forEach(line=>line.setPath(points));updated.set(key,existing);return;}
        updated.set(key,[new this.maps.Polyline({map:this.map,path:points,strokeWeight:completed?8:9,strokeColor:completed?'#49515C':'#2E343D',strokeOpacity:completed?0.5:0.9,strokeStyle:'solid',zIndex:completed?0:1}),new this.maps.Polyline({map:this.map,path:points,strokeWeight:5,strokeColor:completed?'#8C949F':'#C8FF00',strokeOpacity:completed?0.85:1,strokeStyle:'solid',zIndex:completed?0:2})]);
      };
      passed.forEach((p,i)=>draw(p,'past-'+i,true));draw(path,'future');
      this.lines.forEach((pair,key)=>{if(!updated.has(key))pair.forEach(line=>line.setMap(null));});this.lines=updated;
    }
    this.timer=setTimeout(()=>this.clear(),Math.min(120_000,route.validForMs));
  }
  clear(){clearTimeout(this.timer);this.lines.forEach(pair=>pair.forEach(line=>line.setMap(null)));this.lines.clear();this.signature='';}
}
