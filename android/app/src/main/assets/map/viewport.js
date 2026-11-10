/* Auto framing yields to parked interaction, and resets once when the panel size changes. */
(function(root){
 root.PickupVehicleViewport=class {
  constructor(maps,map,host,clock=()=>performance.now()){this.maps=maps;this.map=map;this.host=host;this.clock=clock;this.camera=new root.PickupMapCamera();this.manual=false;this.parked=false;this.key='';this.size='';this.payload=null;}
  update(payload){const wasParked=this.parked;this.payload=payload;this.parked=payload?.parked===true;
   this.map.setDraggable(this.parked);this.map.setZoomable(this.parked);this.map.setKeyboardShortcuts(this.parked);
   if(!payload){this.manual=false;this.key='';this.camera=new root.PickupMapCamera();return;}
   if(wasParked&&!this.parked){this.manual=false;this.camera=new root.PickupMapCamera();this.fit(true);}else this.fit();
  }
  interact(){if(this.parked)this.manual=true;}
  points(){const p=this.payload;if(!p)return[];const valid=q=>q&&Number.isFinite(q.latitude)&&Math.abs(q.latitude)<=90&&Number.isFinite(q.longitude)&&Math.abs(q.longitude)<=180;
   const result=(p.focus??[]).filter(valid),route=p.route;
   const path=a=>Array.isArray(a)&&a.length>=2&&a.every(q=>Array.isArray(q)&&q.length===2&&Number.isFinite(q[0])&&Math.abs(q[0])<=180&&Number.isFinite(q[1])&&Math.abs(q[1])<=90);
   const past=route?.traveledPaths??[];
   if(route?.validForMs>0&&path(route.path)&&Array.isArray(past)&&past.length<=32&&past.every(path)&&route.path.length+past.reduce((n,p)=>n+p.length,0)<=4000){for(const q of route.path.concat(...past))result.push({latitude:q[1],longitude:q[0]});}
   return result;
  }
  fit(force=false){if(!this.payload||this.manual&&!force)return;const points=this.points();if(!points.length||this.host.clientWidth<1||this.host.clientHeight<1)return;
   const now=this.clock(),key=JSON.stringify(points.map(q=>[q.latitude.toFixed(5),q.longitude.toFixed(5)]));if(!force&&key===this.key&&!this.camera.due(now))return;
   const previous=this.map.getCenter(),previousLevel=this.map.getLevel(),bounds=new this.maps.LatLngBounds();points.forEach(q=>bounds.extend(new this.maps.LatLng(q.latitude,q.longitude)));
   const padding=Math.max(32,Math.min(72,Math.round(this.host.clientHeight*.12)));
   this.map.setBounds(bounds,padding,Math.min(60,this.host.clientWidth*.13),padding,Math.min(60,this.host.clientWidth*.13));
   const center=this.map.getCenter(),level=this.camera.choose(this.map.getLevel(),now);if(this.key&&!force){this.map.jump(previous,previousLevel);this.map.jump(center,level,{animate:{duration:450}});}else this.map.jump(center,level);this.key=key;
  }
  resize(){const size=this.host.clientWidth+':'+this.host.clientHeight;if(size===this.size)return;this.size=size;
   this.map.relayout();this.manual=false;this.camera=new root.PickupMapCamera();this.fit(true);
  }
  zoom(delta){if(!this.parked)return;this.interact();this.map.setLevel(Math.max(1,Math.min(14,this.map.getLevel()+delta)));}
  reset(){this.manual=false;this.camera=new root.PickupMapCamera();this.map.relayout();this.fit(true);}
 };
})(typeof window==='undefined'?globalThis:window);
