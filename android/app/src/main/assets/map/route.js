globalThis.PickupRouteLine=class {
 constructor(maps,map,label){this.maps=maps;this.map=map;this.label=label;this.lines=new Map();this.signature='';this.timer=null;}
 clear(){clearTimeout(this.timer);this.lines.forEach(pair=>pair.forEach(line=>line.setMap(null)));this.lines.clear();this.signature='';this.label.hidden=true;}
 update(route){
  clearTimeout(this.timer);const path=route?.path,passed=route?.traveledPaths??[];
  const valid=p=>Array.isArray(p)&&p.length>=2&&p.every(q=>Array.isArray(q)&&q.length===2&&Number.isFinite(q[0])&&Number.isFinite(q[1])&&Math.abs(q[0])<=180&&Math.abs(q[1])<=90);
  if(!Number.isFinite(route?.validForMs)||route.validForMs<=0||!valid(path)||!Array.isArray(passed)||passed.length>32||!passed.every(valid)||path.length+passed.reduce((n,p)=>n+p.length,0)>4000){this.clear();return;}
  const signature=JSON.stringify([path,passed]);
  if(signature!==this.signature){this.signature=signature;const updated=new Map();
   const draw=(road,key,completed=false)=>{const points=road.map(p=>new this.maps.LatLng(p[1],p[0])),existing=this.lines.get(key);
    if(existing){existing.forEach(line=>line.setPath(points));updated.set(key,existing);return;}
    updated.set(key,[new this.maps.Polyline({map:this.map,path:points,strokeWeight:completed?8:9,strokeColor:completed?'#49515C':'#2E343D',strokeOpacity:completed?0.5:0.9,strokeStyle:'solid',zIndex:completed?0:1}),new this.maps.Polyline({map:this.map,path:points,strokeWeight:5,strokeColor:completed?'#8C949F':'#C8FF00',strokeOpacity:completed?0.85:1,strokeStyle:'solid',zIndex:completed?0:2})]);};
   passed.forEach((p,i)=>draw(p,'past-'+i,true));draw(path,'future');
   this.lines.forEach((pair,key)=>{if(!updated.has(key))pair.forEach(line=>line.setMap(null));});this.lines=updated;
  }
  this.label.hidden=false;this.timer=setTimeout(()=>this.clear(),Math.min(120000,route.validForMs));
 }
};
