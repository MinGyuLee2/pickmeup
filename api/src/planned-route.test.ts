import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {PlannedRoutes,decodeRoute,remainingPath,splitRoute} from './planned-route.js';
import {buildApp} from './app.js';
import {migrate} from './db.js';
import {hash,secrets} from './domain.js';
const origin={longitude:127.097,latitude:37.406},destination={longitude:127.1112,latitude:37.3948};
const body={routes:[{result_code:0,sections:[{roads:[{vertexes:[127.097,37.406,127.103,37.406,127.1112,37.3948]}]}]}]};
const flush=()=>new Promise(resolve=>setTimeout(resolve,5));
function sample(now:number){return {id:randomUUID(),state:'ACTIVE',expires_at:new Date(now+600000).toISOString(),destination,latest_observation:{location:origin,remainingSeconds:500,remainingMeters:2000,locationReceivedAt:new Date(now).toISOString(),etaReceivedAt:new Date(now).toISOString(),uploadedAt:new Date(now).toISOString()}};}
test('provider geometry uses longitude/latitude, retains bends and removes duplicate joins',()=>{
  assert.deepEqual(decodeRoute(body,origin,destination),[[127.097,37.406],[127.103,37.406],[127.1112,37.3948]]);
  const joined={routes:[{result_code:0,sections:[{roads:[{vertexes:[127.097,37.406,127.103,37.406]},{vertexes:[127.103,37.406,127.1112,37.3948]}]}]}]};
  assert.equal(decodeRoute(joined,origin,destination).length,3);
});
test('failed, malformed, disconnected and wrong-endpoint geometry never becomes a straight route',()=>{
  for(const v of [{routes:[{result_code:101}]},{routes:[{result_code:0,sections:[]}]},{routes:[{result_code:0,sections:[{roads:[{vertexes:[127,37,128]}]}]}]},{routes:[{result_code:0,sections:[{roads:[{vertexes:[127.097,37.406,127.103,37.406]},{vertexes:[128,38,127.1112,37.3948]}]}]}]},{routes:[{result_code:0,sections:[{roads:[{vertexes:[NaN,37,127.1112,37.3948]}]}]}]}])assert.throws(()=>decodeRoute(v,origin,destination));
  assert.throws(()=>decodeRoute(body,{longitude:126,latitude:35},destination));
});
test('only future road segments remain; off-route GPS never creates a connector',()=>{
  const path=decodeRoute(body,origin,destination),trimmed=remainingPath(path,{latitude:37.406,longitude:127.1})!;
  assert.equal(trimmed.length,3);assert.ok(Math.abs(trimmed[0][0]-127.1)<.000001);assert.deepEqual(trimmed.at(-1),path.at(-1));
  assert.equal(remainingPath(path,{latitude:38,longitude:128}),null);
});
test('completed and remaining colors meet at one cut; GPS jitter cannot reverse completed progress',()=>{
 const path=decodeRoute(body,origin,destination),a=splitRoute(path,{...origin,longitude:127.1})!;
 assert.deepEqual(a.passed.at(-1),a.remaining[0]);assert.deepEqual(a.passed[0],path[0]);
 const jitter=splitRoute(path,{...origin,longitude:127.0995},a.progress)!;
 assert.equal(jitter.progress,a.progress);assert.deepEqual(jitter.passed.at(-1),a.passed.at(-1));
 assert.equal(splitRoute(path,{longitude:128,latitude:38},a.progress),null);
});
test('recalculation keeps completed road fragments, bounds payload, and ending erases them',async()=>{
 let now=Date.now();const p=sample(now);let calls=0;
 const routes=new PlannedRoutes('test',async url=>{calls++;const [lon,lat]=new URL(String(url)).searchParams.get('origin')!.split(',').map(Number);return new Response(JSON.stringify({routes:[{result_code:0,sections:[{roads:[{vertexes:[lon,lat,127.103,37.406,127.1112,37.3948]}]}]}]}));},()=>now);
 try{
  routes.read(p);await flush();assert.deepEqual(routes.read(p).traveledPaths,[]);
  now+=10000;p.latest_observation.location={...origin,longitude:127.099};p.latest_observation.locationReceivedAt=p.latest_observation.etaReceivedAt=new Date(now).toISOString();
  const moved=routes.read(p);assert.equal(moved.state,'READY');assert.ok(moved.traveledPaths.length);assert.deepEqual(moved.traveledPaths[0][0],[origin.longitude,origin.latitude]);
  now+=51000;p.latest_observation.location={...origin,longitude:127.101};p.latest_observation.locationReceivedAt=p.latest_observation.etaReceivedAt=new Date(now).toISOString();routes.read(p);await flush();
  const rerouted=routes.read(p);assert.equal(calls,2);assert.deepEqual(rerouted.traveledPaths[0][0],[origin.longitude,origin.latitude]);assert.deepEqual(rerouted.path![0],[127.101,37.406]);assert.ok(rerouted.path!.length+rerouted.traveledPaths.reduce((n,s)=>n+s.length,0)<=4000);
  p.state='ENDED';assert.deepEqual(routes.read(p).traveledPaths,[]);assert.equal(routes.read(p).path,null);
 }finally{routes.close();}
});
test('car and recipient share one in-flight request/cache, fixed server URL, no names or secrets in result',async()=>{
  let now=Date.now(),calls=0;const fetcher:typeof fetch=async(url,init)=>{calls++;const u=new URL(String(url));assert.equal(u.origin,'https://apis-navi.kakaomobility.com');assert.equal(u.searchParams.get('origin'),'127.097,37.406');assert.equal(u.searchParams.get('summary'),'false');assert.equal((init?.headers as any).Authorization,'KakaoAK private-test-key');return new Response(JSON.stringify(body));};
  const routes=new PlannedRoutes('private-test-key',fetcher,()=>now),p=sample(now);
  try{for(let n=0;n<20;n++)assert.equal(routes.read(p).state,'LOADING');await flush();const ready=routes.read(p);assert.equal(calls,1);assert.equal(ready.state,'READY');assert.ok(ready.validForMs<=30000);assert.ok(!JSON.stringify(ready).includes('private-test-key'));
    now+=10000;p.latest_observation.location={...origin,longitude:127.1};p.latest_observation.locationReceivedAt=p.latest_observation.etaReceivedAt=new Date(now).toISOString();assert.equal(routes.read(p).state,'READY');assert.equal(calls,1);
    now+=51000;p.latest_observation.locationReceivedAt=p.latest_observation.etaReceivedAt=new Date(now).toISOString();routes.read(p);await flush();assert.equal(calls,2);
  }finally{routes.close();}
});
test('stale/future/arrived/expired observations erase geometry and do not call provider',async()=>{
  const now=Date.now();let calls=0;const routes=new PlannedRoutes('key',async()=>{calls++;return new Response(JSON.stringify(body));},()=>now),p=sample(now);
  try{routes.read(p);await flush();assert.equal(routes.read(p).state,'READY');p.latest_observation.locationReceivedAt=new Date(now-30001).toISOString();assert.equal(routes.read(p).state,'STALE');p.latest_observation.locationReceivedAt=new Date(now+1000).toISOString();assert.equal(routes.read(p).state,'STALE');p.state='ARRIVED';assert.equal(routes.read(p).path,null);p.state='ACTIVE';p.expires_at=new Date(now-1).toISOString();assert.equal(routes.read(p).state,'WAITING');assert.equal(calls,1);}finally{routes.close();}
});
test('provider auth/rate/network/bad-body errors yield no route and retries are throttled',async()=>{
  for(const status of [401,429,500,200]){let now=Date.now(),calls=0;const routes=new PlannedRoutes('key',async()=>{calls++;return new Response(status===200?'not json':'provider-secret-message',{status});},()=>now),p=sample(now);
    try{routes.read(p);await flush();assert.equal(routes.read(p).state,'UNAVAILABLE');for(let n=0;n<20;n++)routes.read(p);assert.equal(calls,1);now+=60000;p.latest_observation.locationReceivedAt=p.latest_observation.etaReceivedAt=new Date(now).toISOString();routes.read(p);await flush();assert.equal(calls,2);}finally{routes.close();}
  }
});
test('ending during a request aborts it and a late response cannot resurrect cached coordinates',async()=>{
  let finish!:(r:Response)=>void,signal:AbortSignal|undefined;const now=Date.now(),p=sample(now),routes=new PlannedRoutes('key',async(_u,o)=>{signal=o?.signal??undefined;return new Promise(resolve=>{finish=resolve;});},()=>now);
  try{routes.read(p);PlannedRoutes.forget(p.id);assert.equal(signal?.aborted,true);finish(new Response(JSON.stringify(body)));await flush();p.state='ENDED';assert.equal(routes.read(p).path,null);}finally{routes.close();}
});
test('route computation waits for 60 seconds/250 meters and refreshes a stationary car at 3 minutes',async()=>{
 let now=Date.now(),calls=0;const p=sample(now),routes=new PlannedRoutes('test',async()=>{calls++;return new Response(JSON.stringify(body));},()=>now);
 const tick=(ms:number,longitude=origin.longitude)=>{now+=ms;p.latest_observation.location={...origin,longitude};p.latest_observation.locationReceivedAt=p.latest_observation.etaReceivedAt=new Date(now).toISOString();return routes.read(p);};
 try{
  routes.read(p);await flush();tick(59999,127.1);assert.equal(calls,1);tick(1,127.099);assert.equal(calls,1);tick(1,127.1);await flush();assert.equal(calls,2);
  tick(179999,127.1);assert.equal(calls,2);tick(1,127.1);await flush();assert.equal(calls,3);
 }finally{routes.close();}
});
test('background refresh and a transient provider failure keep the current valid road without a loading gap',async()=>{
 let now=Date.now(),calls=0,finish!:(r:Response)=>void;const p=sample(now),routes=new PlannedRoutes('test',async()=>{calls++;return calls===1?new Response(JSON.stringify(body)):new Promise(resolve=>{finish=resolve;});},()=>now);
 try{
  routes.read(p);await flush();now+=61000;p.latest_observation.location={...origin,longitude:127.1};p.latest_observation.locationReceivedAt=p.latest_observation.etaReceivedAt=new Date(now).toISOString();
  assert.equal(routes.read(p).state,'READY');assert.equal(calls,2);assert.equal(routes.read(p).state,'READY');finish(new Response('{}',{status:503}));await flush();assert.equal(routes.read(p).state,'READY');
  p.latest_observation.location={latitude:38,longitude:128};assert.equal(routes.read(p).path,null);
 }finally{routes.close();}
});

// Authentication and deletion are exercised against a separate real PostgreSQL schema.
const schema='route_test_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:process.env.DATABASE_URL}),pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
const secret=randomBytes(32).toString('base64'),security=secrets(secret),webOrigin='http://localhost:5173';let requests=0;
const app=buildApp(pool,{secret,publicOrigin:webOrigin,smsMode:'local',production:false,kakaoRouteKey:'test-only',routeFetch:async()=>{requests++;return new Response(JSON.stringify(body));}});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await app.ready();});
after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
test('authenticated vehicle and code-verified recipient see the same road; outsiders/end cannot retrieve it',async()=>{
  assert.equal((await app.inject('/shared-pickup')).statusCode,410);assert.equal((await app.inject('/pickups/current')).statusCode,401);assert.equal(requests,0);
  const car=(await app.inject({method:'POST',url:'/vehicles/guest',payload:{installationKey:randomBytes(32).toString('hex')}})).json(),headers={authorization:'Bearer '+car.deviceToken};
  const person=(await app.inject({method:'POST',url:'/vehicle/contacts/import',headers,payload:{name:'가상 상대',phone:'01099999999'}})).json();
  const started=await app.inject({method:'POST',url:'/pickups',headers,payload:{contactId:person.id,idempotencyKey:randomUUID(),destination:{...destination,name:'가상 만날 곳'},observation:{location:origin,remainingSeconds:500,remainingMeters:2000,locationAgeMs:0,etaAgeMs:0}}});assert.equal(started.statusCode,201,started.body);const id=started.json().pickup.id;
  await flush();const vehicle=(await app.inject({url:'/pickups/current',headers})).json().pickup;assert.equal(vehicle.plannedRoute.state,'READY');assert.equal(requests,1);
  const other=(await app.inject({method:'POST',url:'/vehicles/guest',payload:{installationKey:randomBytes(32).toString('hex')}})).json();assert.equal((await app.inject({url:'/pickups/current',headers:{authorization:'Bearer '+other.deviceToken}})).json().pickup,null);
  const row=(await pool.query('SELECT recipient_link_ciphertext,recipient_code_ciphertext FROM pickups WHERE id=$1',[id])).rows[0],link=security.open<string>(row.recipient_link_ciphertext),code=security.open<string>(row.recipient_code_ciphertext);
  const redeemed=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin:webOrigin},payload:{token:new URL(link).hash.slice(7),code}});assert.equal(redeemed.statusCode,200,redeemed.body);const cookie=String(redeemed.headers['set-cookie']).split(';')[0];
  const recipient=await app.inject({url:'/shared-pickup',headers:{cookie}});assert.equal(recipient.statusCode,200);assert.deepEqual(recipient.json().plannedRoute.path,vehicle.plannedRoute.path);assert.equal(requests,1);
  await app.inject({method:'POST',url:`/pickups/${id}/end`,headers});assert.equal((await app.inject({url:'/shared-pickup',headers:{cookie}})).statusCode,410);assert.equal((await app.inject({url:'/pickups/current',headers})).json().pickup,null);
  assert.equal((await pool.query('SELECT latest_observation FROM pickups WHERE id=$1',[id])).rows[0].latest_observation,null);assert.equal((await pool.query('SELECT sum(attempts)::int n FROM message_jobs')).rows[0].n,0);
});
