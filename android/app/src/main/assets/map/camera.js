// Keep zoom steady as positions change; widen immediately to keep both people visible.
globalThis.PickupMapCamera=class {
  level=null;candidate=null;since=null;
  choose(required,now){
    required=Math.max(3,Math.min(14,required));
    if(this.level===null||required>=this.level){this.level=required;this.candidate=null;this.since=null;}
    else {
      if(this.candidate!==required){this.candidate=required;this.since=now;}
      if(now-this.since>=15000){this.level=required;this.candidate=null;this.since=null;}
    }
    return this.level;
  }
  due(now){return this.since!==null&&now-this.since>=15000;}
};
