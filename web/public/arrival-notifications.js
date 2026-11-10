/* Web Push only. No fetch cache, location collection, or share tokens are stored here. */
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let data;try{data=event.data?.json();}catch{return;}
  if(data?.type!=='arrival-near'||typeof data.pickupId!=='string'||!/^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.test(data.pickupId)||typeof data.validUntil!=='number'||data.validUntil<=Date.now())return;
  event.waitUntil(self.registration.showNotification('곧 도착해요 · 픽미업',{
    body:'차량이 약 5분 이내에 도착할 예정이에요. 만날 준비를 해 주세요.',icon:'/icon.png?v=wordmark-v1',badge:'/icon-192.png',tag:'pmu-near-'+data.pickupId,data:{path:'/s?pickupId='+encodeURIComponent(data.pickupId)}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{
    const path=event.notification.data?.path;
    if(typeof path!=='string'||!/^\/s\?pickupId=[a-f0-9-]{36}$/i.test(path))return;
    const current=clients.find(c=>new URL(c.url).origin===self.location.origin&&new URL(c.url).pathname==='/s'&&new URL(c.url).search===new URL(path,self.location.origin).search);
    return current?current.focus():self.clients.openWindow(path);
  }));
});
