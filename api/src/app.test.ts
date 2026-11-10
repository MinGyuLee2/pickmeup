import {recipientPath} from './test-recipient.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp, expirePickups } from './app.js';
import { migrate } from './db.js';
import { hash, secrets } from './domain.js';

const schema = `test_${randomUUID().replaceAll('-','')}`;
const admin = new pg.Pool({connectionString:process.env.DATABASE_URL});
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
const secret = randomBytes(32).toString('base64'), security = secrets(secret);
const origin = 'http://localhost:5173';
const app = buildApp(pool,{secret,publicOrigin:origin,smsMode:'local',production:false});
before(async () => { await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await app.ready(); });
after(async () => { await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end(); });
let nextPhone = 0;
const cookies = (response: {headers:Record<string,unknown>}) => String(response.headers['set-cookie']).split(';')[0];
async function login(remoteAddress='127.0.0.1') {
  const phone = `0100000${String(++nextPhone).padStart(4,'0')}`;
  const request = await app.inject({method:'POST',url:'/auth/otp/request',remoteAddress,headers:{origin},payload:{phone}});
  assert.equal(request.statusCode,200);
  const challenge = request.json();
  const verified = await app.inject({method:'POST',url:'/auth/otp/verify',headers:{origin},payload:{challengeId:challenge.challengeId,code:challenge.developmentCode,name:'테스트 운전자'}});
  assert.equal(verified.statusCode,200);
  return {cookie:cookies(verified),id:verified.json().driver.id};
}
// Most tests need an already paired vehicle; onboarding itself has dedicated HTTP coverage.
async function pair(cookie: string,_remoteAddress='127.0.0.1') {
  const owner=(await pool.query('SELECT driver_id FROM web_sessions WHERE token_hash=$1',[hash(cookie.split('=')[1])])).rows[0];
  const deviceToken=randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO vehicles(id,driver_id,token_hash) VALUES($1,$2,$3)',[randomUUID(),owner.driver_id,hash(deviceToken)]);
  return {authorization:`Bearer ${deviceToken}`};
}
async function accessCode(id:string){const row=(await pool.query('SELECT recipient_code_ciphertext FROM pickups WHERE id=$1',[id])).rows[0];return security.open<string>(row.recipient_code_ciphertext);}
async function contact(cookie: string, aliases=['지연이','지연']) {
  const response = await app.inject({method:'POST',url:'/contacts',headers:{origin,cookie},payload:{name:'지연이',phone:'01099999999',aliases}});
  assert.equal(response.statusCode,201);return response.json();
}
const destination = {name:'회사 정문',latitude:37.48,longitude:127.03};
const observation = (remainingSeconds=720) => ({location:{latitude:37.41,longitude:127.09},remainingSeconds,remainingMeters:2300,locationAgeMs:0,etaAgeMs:0});
async function createPickup(headers:Record<string,string>,contactId:string,idempotencyKey=randomUUID(),remaining=720) {
  return app.inject({method:'POST',url:'/pickups',headers,payload:{contactId,idempotencyKey,destination,observation:observation(remaining)}});
}

test('OTP wrong-attempt limit persists, single-use success, origin enforcement',async () => {
  const response = await app.inject({method:'POST',url:'/auth/otp/request',headers:{origin},payload:{phone:'01011112222'}});
  const challenge = response.json();
  for(let n=0;n<5;n++) {
    const wrong = await app.inject({method:'POST',url:'/auth/otp/verify',headers:{origin},payload:{challengeId:challenge.challengeId,code:'000000'}});
    assert.equal(wrong.statusCode,400);
  }
  const locked = await app.inject({method:'POST',url:'/auth/otp/verify',headers:{origin},payload:{challengeId:challenge.challengeId,code:challenge.developmentCode}});
  assert.equal(locked.statusCode,400);
  assert.equal((await pool.query('SELECT attempts FROM login_challenges WHERE id=$1',[challenge.challengeId])).rows[0].attempts,5);
  const blocked = await app.inject({method:'POST',url:'/auth/otp/request',headers:{origin:'https://other.example'},payload:{phone:'01022223333'}});
  assert.equal(blocked.statusCode,403);
  const owner = await login();
  assert.equal((await app.inject({method:'GET',url:'/me',headers:{cookie:owner.cookie}})).statusCode,200);
});

test('QR pairing creation and claim are retired without changing existing vehicle credentials',async()=>{
 const owner=await login(),car=await pair(owner.cookie);
 assert.equal((await app.inject({method:'POST',url:'/pairings'})).statusCode,410);
 assert.equal((await app.inject({method:'POST',url:'/pairings/claim',headers:{origin,cookie:owner.cookie},payload:{token:'old-link'}})).statusCode,410);
 assert.equal((await app.inject({method:'GET',url:'/vehicle/contacts',headers:car})).statusCode,200);
});

test('owner isolation, concurrent start idempotency, duplicate aliases never send',async () => {
  const owner = await login(), other = await login(), headers=await pair(owner.cookie), outsider=await pair(other.cookie);
  const recipient=await contact(owner.cookie);
  const key=randomUUID();
  const responses=await Promise.all([createPickup(headers,recipient.id,key),createPickup(headers,recipient.id,key)]);
  assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,201]);
  const id=responses[0].json().pickup.id;
  assert.equal(responses[1].json().pickup.id,id);
  assert.equal((await pool.query("SELECT count(*)::int n FROM message_jobs WHERE pickup_id=$1 AND kind='START'",[id])).rows[0].n,1);
  assert.equal((await createPickup(outsider,recipient.id)).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:`/pickups/${id}/end`,headers:outsider})).statusCode,404);
  assert.equal((await app.inject({method:'PATCH',url:`/contacts/${recipient.id}`,headers:{origin,cookie:other.cookie},payload:{name:'변경',phone:'01033334444',aliases:[]}})).statusCode,404);
  await app.inject({method:'POST',url:`/pickups/${id}/end`,headers});
  await contact(owner.cookie);
  const ambiguous=await app.inject({method:'POST',url:'/pickups',headers,payload:{recipientAlias:'지연이',idempotencyKey:randomUUID(),destination,observation:observation()}});
  assert.equal(ambiguous.statusCode,409);assert.equal(ambiguous.json().code,'AMBIGUOUS_RECIPIENT');
});

test('readiness round trip, single near-arrival job, reverse sample rejected, ending erases coordinates and revokes links',async () => {
  const owner=await login(), headers=await pair(owner.cookie), recipient=await contact(owner.cookie);
  const created=await createPickup(headers,recipient.id),id=created.json().pickup.id;
  const job=(await pool.query("SELECT protected_payload FROM message_jobs WHERE pickup_id=$1 AND kind='START'",[id])).rows[0];
  const content=security.open<{shareLink:string}>(job.protected_payload);
  assert.ok(!job.protected_payload.includes('01099999999'));
  const shareToken=new URLSearchParams(new URL(content.shareLink).hash.slice(1)).get('token');
  const redeem=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token:shareToken,code:await accessCode(id)}});
  assert.equal(redeem.statusCode,200);const cookie=cookies(redeem);
  const before=await app.inject({method:'GET',url:recipientPath('/shared-pickup',{cookie}),headers:{cookie}});
  assert.equal(before.json().readiness,'UNKNOWN');assert.equal(before.json().recipientName,undefined);
  const ready=await app.inject({method:'PUT',url:recipientPath('/shared-pickup/readiness',{origin,cookie}),headers:{origin,cookie},payload:{readiness:'OUTSIDE'}});
  assert.equal(ready.statusCode,200);
  const current=await app.inject({method:'GET',url:'/pickups/current',headers});
  assert.equal(current.json().pickup.readiness,'OUTSIDE');
  await app.inject({method:'PATCH',url:`/contacts/${recipient.id}`,headers:{origin,cookie:owner.cookie},payload:{name:'지연이',phone:'01088888888',aliases:['지연이']}});
  for(const [sequence,eta] of [[2,240],[3,360],[4,240]]) {
    const update=await app.inject({method:'PUT',url:`/pickups/${id}/observation`,headers,payload:{sequence,destination,observation:observation(eta)}});
    assert.equal(update.statusCode,200);
  }
  const late=await app.inject({method:'PUT',url:`/pickups/${id}/observation`,headers,payload:{sequence:3,destination,observation:observation(100)}});
  assert.equal(late.json().reason,'OUT_OF_ORDER');
  assert.equal((await pool.query("SELECT count(*)::int n FROM message_jobs WHERE pickup_id=$1 AND kind='NEAR'",[id])).rows[0].n,1);
  const nearJob=(await pool.query("SELECT protected_payload FROM message_jobs WHERE pickup_id=$1 AND kind='NEAR'",[id])).rows[0];
  assert.equal(security.open<{phone:string}>(nearJob.protected_payload).phone,'01099999999');
  assert.equal((await app.inject({method:'POST',url:`/pickups/${id}/end`,headers})).statusCode,200);
  assert.equal((await app.inject({method:'GET',url:recipientPath('/shared-pickup',{cookie}),headers:{cookie}})).statusCode,410);
  assert.equal((await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token:shareToken}})).statusCode,410);
  const ended=(await pool.query('SELECT latest_observation FROM pickups WHERE id=$1',[id])).rows[0];
  assert.equal(ended.latest_observation,null);
  assert.equal((await pool.query('SELECT count(*)::int n FROM message_jobs WHERE pickup_id=$1 AND protected_payload IS NOT NULL',[id])).rows[0].n,0);
});

test('stale ETA cannot start or notify; expiry and destination changes terminate sharing',async () => {
  const owner=await login(), headers=await pair(owner.cookie),recipient=await contact(owner.cookie);
  const stale=await app.inject({method:'POST',url:'/pickups',headers,payload:{contactId:recipient.id,idempotencyKey:randomUUID(),destination,observation:{...observation(),etaAgeMs:31000}}});
  assert.equal(stale.statusCode,409);
  const id=(await createPickup(headers,recipient.id)).json().pickup.id;
  const upload=await app.inject({method:'PUT',url:`/pickups/${id}/observation`,headers,payload:{sequence:2,destination,observation:{...observation(200),etaAgeMs:31000}}});
  assert.equal(upload.json().pickup.freshness,'STALE');
  assert.equal((await pool.query("SELECT count(*)::int n FROM message_jobs WHERE pickup_id=$1 AND kind='NEAR'",[id])).rows[0].n,0);
  await pool.query("UPDATE pickups SET expires_at=now()-interval '1 second' WHERE id=$1",[id]);
  await expirePickups(pool);
  const row=(await pool.query('SELECT state,latest_observation FROM pickups WHERE id=$1',[id])).rows[0];
  assert.equal(row.state,'EXPIRED');assert.equal(row.latest_observation,null);
  const next=(await createPickup(headers,recipient.id,randomUUID(),200)).json().pickup.id;
  const changed=await app.inject({method:'PUT',url:`/pickups/${next}/observation`,headers,payload:{sequence:2,destination:{...destination,name:'다른 정문'},observation:observation()}});
  assert.equal(changed.json().reason,'DESTINATION_CHANGED');
  assert.equal((await pool.query('SELECT state FROM pickups WHERE id=$1',[next])).rows[0].state,'ENDED');
  assert.notEqual(hash('token'), 'token');
});

test('SSE initial state, readiness, reconnect and revoked-share end use a real HTTP stream',async () => {
  const owner=await login(),headers=await pair(owner.cookie),recipient=await contact(owner.cookie);
  const id=(await createPickup(headers,recipient.id)).json().pickup.id;
  const job=(await pool.query("SELECT protected_payload FROM message_jobs WHERE pickup_id=$1 AND kind='START'",[id])).rows[0];
  const shareToken=new URLSearchParams(new URL(security.open<{shareLink:string}>(job.protected_payload).shareLink).hash.slice(1)).get('token');
  const redeem=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token:shareToken,code:await accessCode(id)}});
  const cookie=cookies(redeem);
  const address=await app.listen({host:'127.0.0.1',port:0});
  async function connection() {
    const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),10_000);
    const response=await fetch(`${address}/shared-pickup/events`,{headers:{cookie},signal:controller.signal});
    assert.equal(response.status,200);
    const reader=response.body!.getReader(),decoder=new TextDecoder();let pending='';
    return {
      async event() {
        while(true) {
          const split=pending.indexOf('\n\n');
          if(split>=0) {
            const frame=pending.slice(0,split);pending=pending.slice(split+2);
            if(frame.startsWith('event:'))return frame;
            continue;
          }
          const next=await reader.read();if(next.done)throw new Error('Stream closed before expected event');pending+=decoder.decode(next.value,{stream:true});
        }
      },
      close(){clearTimeout(deadline);controller.abort();},
    };
  }
  const first=await connection();
  try {
    assert.match(await first.event(),/"readiness":"UNKNOWN"/);
    await app.inject({method:'PUT',url:recipientPath('/shared-pickup/readiness',{origin,cookie}),headers:{origin,cookie},payload:{readiness:'OUTSIDE'}});
    assert.match(await first.event(),/"readiness":"OUTSIDE"/);
  }finally{first.close();}
  const reconnected=await connection();
  try{
    assert.match(await reconnected.event(),/"readiness":"OUTSIDE"/);
    await app.inject({method:'POST',url:`/pickups/${id}/end`,headers});
    const end=await reconnected.event();assert.match(end,/event: ended/);assert.ok(!end.includes('latitude'));
  }finally{reconnected.close();}
});

test('cancel-start wins before, after or concurrently with a start whose response is unknown',async () => {
  const owner=await login(),headers=await pair(owner.cookie),recipient=await contact(owner.cookie);
  const key=randomUUID();
  const cancel=()=>app.inject({method:'POST',url:'/pickups/cancel-start',headers,payload:{idempotencyKey:key}});
  const responses=await Promise.all([createPickup(headers,recipient.id,key),cancel()]);
  assert.ok([201,409].includes(responses[0].statusCode));assert.equal(responses[1].statusCode,200);
  assert.equal((await app.inject({method:'GET',url:'/pickups/current',headers})).json().pickup,null);
  assert.equal((await createPickup(headers,recipient.id,key)).json().code,'START_CANCELLED');
  assert.equal((await cancel()).statusCode,200);
  const before=randomUUID();
  assert.equal((await app.inject({method:'POST',url:'/pickups/cancel-start',headers,payload:{idempotencyKey:before}})).statusCode,200);
  assert.equal((await createPickup(headers,recipient.id,before)).json().code,'START_CANCELLED');
  const rows=await pool.query('SELECT latest_observation FROM pickups WHERE idempotency_key=$1',[key]);
  for(const row of rows.rows)assert.equal(row.latest_observation,null);
});

test('simulation sessions, vehicles, OTPs, pairings and private previews cannot cross into real authentication',async () => {
  const owner=await login(),headers=await pair(owner.cookie),recipient=await contact(owner.cookie);
  const id=(await createPickup(headers,recipient.id)).json().pickup.id;
  const number=(await pool.query('SELECT phone FROM drivers WHERE id=$1',[owner.id])).rows[0].phone;
  for(const mode of ['sens','solapi'] as const) {
  const real=buildApp(pool,{secret,publicOrigin:origin,smsMode:mode,production:false});await real.ready();
  try {
    assert.equal((await real.inject({method:'GET',url:'/me',headers:{cookie:owner.cookie}})).statusCode,401);
    assert.equal((await real.inject({method:'GET',url:'/pickups/current',headers})).statusCode,401);
    const queued=(await real.inject({method:'POST',url:'/auth/otp/request',headers:{origin},payload:{phone:number}})).json();
    assert.equal(queued.developmentCode,undefined);
    const realJob=(await pool.query('SELECT id,protected_payload FROM message_jobs WHERE challenge_id=$1',[queued.challengeId])).rows[0];
    const localPreview=(await app.inject({method:'GET',url:'/dev/messages',headers:{cookie:owner.cookie}})).json();
    assert.ok(!localPreview.messages.some((j:{id:string})=>j.id===realJob.id));
    const code=security.open<{message:string}>(realJob.protected_payload).message.match(/\d{6}/)![0];
    assert.equal((await app.inject({method:'POST',url:'/auth/otp/verify',headers:{origin},payload:{challengeId:queued.challengeId,code}})).statusCode,400);
    const verified=await real.inject({method:'POST',url:'/auth/otp/verify',headers:{origin},payload:{challengeId:queued.challengeId,code}});
    assert.equal(verified.statusCode,200);assert.notEqual(verified.json().driver.id,owner.id);
    const pairing=(await app.inject({method:'POST',url:'/onboarding/start',headers:{origin},payload:{phone:`0100000${String(++nextPhone).padStart(4,'0')}`}})).json();
    assert.equal((await real.inject({method:'GET',url:`/pairings/${pairing.id}`,headers:{authorization:`Pairing ${pairing.deviceSecret}`}})).statusCode,410);
    const startJob=(await pool.query("SELECT protected_payload FROM message_jobs WHERE pickup_id=$1 AND kind='START'",[id])).rows[0];
    const shareToken=new URLSearchParams(new URL(security.open<{shareLink:string}>(startJob.protected_payload).shareLink).hash.slice(1)).get('token');
    assert.equal((await real.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token:shareToken}})).statusCode,410);
    assert.equal((await real.inject({method:'GET',url:'/dev/messages',headers:{cookie:cookies(verified)}})).statusCode,404);
  }finally{await real.close();}
  }
});

test('production supports SOLAPI only with HTTPS and keeps local previews unavailable',async()=>{
  assert.throws(()=>buildApp(pool,{secret,publicOrigin:'http://localhost:5173',smsMode:'solapi',production:true}),/HTTPS/);
  const real=buildApp(pool,{secret,publicOrigin:'https://pickup.example.test',smsMode:'solapi',production:true});
  try {
    await real.ready();
    assert.equal((await real.inject({method:'GET',url:'/health'})).json().sms,'solapi');
    assert.equal((await real.inject({method:'GET',url:'/dev/messages'})).statusCode,404);
  }finally{await real.close();}
});


test('only the configured nearest proxy hop supplies the OTP rate-limit IP', async () => {
  const headers={origin,'x-forwarded-for':'203.0.113.99, 198.51.100.7'};
  const untrusted=await app.inject({method:'POST',url:'/auth/otp/request',headers,payload:{phone:'01055550001'},remoteAddress:'127.0.0.2'});
  assert.equal(untrusted.statusCode,200);
  const proxied=buildApp(pool,{secret,publicOrigin:origin,smsMode:'local',production:false,proxyHops:1});
  try {
    const trusted=await proxied.inject({method:'POST',url:'/auth/otp/request',headers,payload:{phone:'01055550002'},remoteAddress:'127.0.0.2'});
    assert.equal(trusted.statusCode,200);
    const ip=async (id:string)=>(await pool.query('SELECT ip_hash FROM login_challenges WHERE id=$1',[id])).rows[0].ip_hash;
    assert.equal(await ip(untrusted.json().challengeId),security.digest('127.0.0.2'));
    assert.equal(await ip(trusted.json().challengeId),security.digest('198.51.100.7'));
  } finally {await proxied.close();}
});

test('vehicle model is owner controlled and reaches active recipient snapshots',async()=>{
  const owner=await login(),outsider=await login(),headers=await pair(owner.cookie),person=await contact(owner.cookie);
  const cars=await app.inject({method:'GET',url:'/vehicles',headers:{cookie:owner.cookie}});
  const car=cars.json()[0];assert.equal(car.modelKey,null);
  const patch=(cookie:string,modelKey:unknown)=>app.inject({method:'PATCH',url:`/vehicles/${car.id}`,headers:{origin,cookie},payload:{modelKey}});
  assert.equal((await patch(outsider.cookie,'ioniq5')).statusCode,404);
  assert.equal((await patch(owner.cookie,'https://example.invalid/car.png')).statusCode,400);
  assert.equal((await app.inject({method:'PATCH',url:`/vehicles/${car.id}`,headers:{origin:'https://example.invalid',cookie:owner.cookie},payload:{modelKey:'ioniq5'}})).statusCode,403);
  const created=await createPickup(headers,person.id),id=created.json().pickup.id;
  assert.equal(created.json().pickup.vehicle.modelKey,null);
  const payload=(await pool.query("SELECT protected_payload FROM message_jobs WHERE pickup_id=$1 AND kind='START'",[id])).rows[0].protected_payload;
  const link=security.open<{shareLink:string}>(payload).shareLink;
  const redeemed=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token:new URL(link).hash.slice('#token='.length),code:await accessCode(id)}});
  const recipientCookie=cookies(redeemed);
  assert.equal((await patch(owner.cookie,'ioniq5')).json().modelKey,'ioniq5');
  const snapshot=await app.inject({method:'GET',url:recipientPath('/shared-pickup',{cookie:recipientCookie}),headers:{cookie:recipientCookie}});
  assert.deepEqual(snapshot.json().vehicle,{modelKey:'ioniq5',modelName:null,licensePlate:null});
  const ready=await app.inject({method:'PUT',url:recipientPath('/shared-pickup/readiness',{origin,cookie:recipientCookie}),headers:{origin,cookie:recipientCookie},payload:{readiness:'OUTSIDE'}});
  assert.deepEqual(ready.json().vehicle,{modelKey:'ioniq5',modelName:null,licensePlate:null});
  assert.equal((await patch(owner.cookie,null)).statusCode,200);
  const cleared=await app.inject({method:'GET',url:recipientPath('/shared-pickup',{cookie:recipientCookie}),headers:{cookie:recipientCookie}});
  assert.equal(cleared.json().vehicle.modelKey,null);
  assert.equal((await patch(owner.cookie,'ioniq5')).statusCode,200);
  await app.inject({method:'POST',url:`/pickups/${id}/end`,headers});
  const again=(await createPickup(headers,person.id)).json().pickup;
  assert.equal(again.vehicle.modelKey,'ioniq5');
  await app.inject({method:'POST',url:`/pickups/${again.id}/end`,headers});
  await patch(owner.cookie,null);
  const [,raced]=await Promise.all([patch(owner.cookie,'ioniq5'),createPickup(headers,person.id)]);
  const racedId=raced.json().pickup.id;
  assert.equal((await pool.query('SELECT vehicle_model_key FROM pickups WHERE id=$1',[racedId])).rows[0].vehicle_model_key,'ioniq5');
  await app.inject({method:'POST',url:`/pickups/${racedId}/end`,headers});
});

test('SMS onboarding verifies possession, completes atomically and returns credentials only to original device',async()=>{
  const start=await app.inject({method:'POST',url:'/onboarding/start',remoteAddress:'192.0.2.10',payload:{phone:'01070000001'}});
  assert.equal(start.statusCode,200);const setup=start.json(),claim=new URLSearchParams(new URL(setup.claimUrl).hash.slice(1)).get('token');
  assert.equal((await app.inject({method:'POST',url:'/onboarding/complete',headers:{origin},payload:{name:'민규'}})).statusCode,401);
  const legacy=await app.inject({method:'POST',url:'/auth/otp/verify',headers:{origin},payload:{challengeId:(await pool.query('SELECT challenge_id FROM onboarding WHERE pairing_id=$1',[setup.id])).rows[0].challenge_id,code:setup.developmentCode}});
  assert.equal(legacy.statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token:claim,code:'000000'}})).statusCode,400);
  const verified=await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token:claim,code:setup.developmentCode}});
  assert.equal(verified.statusCode,200);const cookie=cookies(verified);
  assert.equal((await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token:claim,code:setup.developmentCode}})).statusCode,400);
  const payload={name:'민규',contact:{name:'지연이',phone:'01070000002'}};
  const saves=await Promise.all([1,2].map(()=>app.inject({method:'POST',url:'/onboarding/complete',headers:{origin,cookie},payload})));
  assert.deepEqual(saves.map(r=>r.statusCode),[200,200]);assert.equal(saves[0].json().vehicleId,saves[1].json().vehicleId);
  assert.equal(saves[0].json().deviceToken,undefined);
  const ownerCookie=cookies(saves[0]);assert.equal((await app.inject({method:'GET',url:'/contacts',headers:{cookie:ownerCookie}})).json().length,1);
  assert.equal((await app.inject({method:'GET',url:'/vehicles',headers:{cookie:ownerCookie}})).json().length,1);
  assert.equal((await app.inject({method:'GET',url:`/pairings/${setup.id}`,headers:{authorization:'Pairing wrong'}})).statusCode,410);
  const paired=await app.inject({method:'GET',url:`/pairings/${setup.id}`,headers:{authorization:`Pairing ${setup.deviceSecret}`}});
  assert.equal(paired.json().state,'PAIRED');
  assert.equal((await app.inject({method:'GET',url:'/vehicle/contacts',headers:{authorization:`Bearer ${paired.json().deviceToken}`}})).json()[0].name,'지연이');
  const job=(await pool.query('SELECT protected_payload FROM message_jobs WHERE challenge_id=(SELECT challenge_id FROM onboarding WHERE pairing_id=$1)',[setup.id])).rows[0];
  assert.ok(security.open<{message:string}>(job.protected_payload).message.includes(setup.claimUrl));
});

test('onboarding rejects expired links and persists five wrong attempts',async()=>{
  const start=(await app.inject({method:'POST',url:'/onboarding/start',remoteAddress:'192.0.2.11',payload:{phone:'01070000003'}})).json();
  const claim=new URLSearchParams(new URL(start.claimUrl).hash.slice(1)).get('token');
  for(let n=0;n<5;n++)assert.equal((await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token:claim,code:'000000'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token:claim,code:start.developmentCode}})).statusCode,400);
  assert.equal((await pool.query('SELECT attempts FROM login_challenges WHERE id=(SELECT challenge_id FROM onboarding WHERE pairing_id=$1)',[start.id])).rows[0].attempts,5);
  assert.equal((await app.inject({method:'POST',url:'/onboarding/start',remoteAddress:'192.0.2.11',payload:{phone:'01070000003'}})).statusCode,429);
});

test('onboarding reuses verified phone account and existing contacts, does not trust unrelated login cookie',async()=>{
  const start=(await app.inject({method:'POST',url:'/onboarding/start',remoteAddress:'192.0.2.12',payload:{phone:'01070000004'}})).json();
  const driverId=randomUUID(),contactId=randomUUID();
  await pool.query("INSERT INTO drivers(id,phone,name,auth_mode) VALUES($1,'01070000004','기존 사용자','local')",[driverId]);
  await pool.query("INSERT INTO contacts(id,driver_id,name,phone) VALUES($1,$2,'가족','01070000005')",[contactId,driverId]);
  await pool.query("INSERT INTO contact_aliases(contact_id,alias) VALUES($1,'가족')",[contactId]);
  const claim=new URLSearchParams(new URL(start.claimUrl).hash.slice(1)).get('token');
  const verified=await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token:claim,code:start.developmentCode}}),cookie=cookies(verified);
  const current=await app.inject({method:'GET',url:'/onboarding/current',headers:{cookie}});assert.equal(current.json().contacts[0].id,contactId);
  const failed=await app.inject({method:'POST',url:'/onboarding/complete',headers:{origin,cookie},payload:{name:'변경',contactId:randomUUID()}});
  assert.equal(failed.statusCode,400);assert.equal((await pool.query('SELECT name FROM drivers WHERE id=$1',[driverId])).rows[0].name,'기존 사용자');
  const done=await app.inject({method:'POST',url:'/onboarding/complete',headers:{origin,cookie},payload:{name:'기존 사용자',contactId}});assert.equal(done.statusCode,200);
  assert.equal((await pool.query('SELECT count(*)::int n FROM contacts WHERE driver_id=$1',[driverId])).rows[0].n,1);
});

test('onboarding expiry blocks verification and completion; cross-origin requests cannot verify',async()=>{
  const setup=(await app.inject({method:'POST',url:'/onboarding/start',remoteAddress:'192.0.2.13',payload:{phone:'01070000006'}})).json();
  const token=new URLSearchParams(new URL(setup.claimUrl).hash.slice(1)).get('token');
  assert.equal((await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin:'https://attacker.example'},payload:{token,code:setup.developmentCode}})).statusCode,403);
  const verified=await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token,code:setup.developmentCode}});
  assert.equal(verified.statusCode,200);
  await pool.query("UPDATE pairings SET expires_at=now()-interval '1 second' WHERE id=$1",[setup.id]);
  assert.equal((await app.inject({method:'POST',url:'/onboarding/complete',headers:{origin,cookie:cookies(verified)},payload:{name:'민규',contact:{name:'가족',phone:'01070000007'}}})).statusCode,401);
  assert.equal((await app.inject({method:'GET',url:`/pairings/${setup.id}`,headers:{authorization:`Pairing ${setup.deviceSecret}`}})).statusCode,410);
  await expirePickups(pool);assert.equal((await pool.query('SELECT 1 FROM onboarding WHERE pairing_id=$1',[setup.id])).rowCount,0);
});

test('recent recipient sorts first and recipient can undo outside status',async()=>{
  const owner=await login(),headers=await pair(owner.cookie),first=await contact(owner.cookie);
  const second=(await app.inject({method:'POST',url:'/contacts',headers:{origin,cookie:owner.cookie},payload:{name:'최근 상대',phone:'01070000008',aliases:[]}})).json();
  const created=await createPickup(headers,second.id),id=created.json().pickup.id;
  assert.equal((await app.inject({method:'GET',url:'/vehicle/contacts',headers})).json()[0].id,second.id);
  const job=(await pool.query("SELECT protected_payload FROM message_jobs WHERE pickup_id=$1 AND kind='START'",[id])).rows[0];
  const payload=security.open<{message:string}>(job.protected_payload),link=payload.message.match(/http[^\s]+/)![0];
  const token=new URLSearchParams(new URL(link).hash.slice(1)).get('token');
  const redeemed=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token,code:await accessCode(id)}});
  const cookie=cookies(redeemed);
  for(const readiness of ['OUTSIDE','UNKNOWN']){
    const result=await app.inject({method:'PUT',url:recipientPath('/shared-pickup/readiness',{origin,cookie}),headers:{origin,cookie},payload:{readiness}});
    assert.equal(result.statusCode,200);assert.equal(result.json().readiness,readiness);
    assert.equal((await app.inject({method:'GET',url:'/pickups/current',headers})).json().pickup.readiness,readiness);
  }
});

test('vehicle imports only a selected phone, reuses concurrent imports and preserves existing contacts and aliases',async()=>{
  const owner=await login(),headers=await pair(owner.cookie),saved=await contact(owner.cookie);
  const beforeJobs=(await pool.query('SELECT count(*)::int n FROM message_jobs')).rows[0].n;
  const beforeVehicle=(await app.inject({method:'GET',url:'/vehicles',headers:{cookie:owner.cookie}})).json();
  const payload={name:'다른 표시 이름',phone:'01099999999'};
  assert.equal((await app.inject({method:'POST',url:'/vehicle/contacts/import',headers:{cookie:owner.cookie,origin},payload})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/vehicle/contacts/import',headers:{...headers,origin:'https://other.example'},payload})).statusCode,403);
  const existing=await app.inject({method:'POST',url:'/vehicle/contacts/import',headers,payload});
  assert.equal(existing.statusCode,200);assert.equal(existing.json().id,saved.id);assert.equal(existing.json().name,'지연이');
  assert.deepEqual([...existing.json().aliases].sort(),['지연','지연이']);
  const imports=await Promise.all([1,2,3].map(()=>app.inject({method:'POST',url:'/vehicle/contacts/import',headers,payload:{name:'선택한 상대',phone:'010-8123-4567'}})));
  assert.ok(imports.every(response=>response.statusCode===200));assert.equal(new Set(imports.map(response=>response.json().id)).size,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM contacts WHERE driver_id=$1',[owner.id])).rows[0].n,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM message_jobs')).rows[0].n,beforeJobs);
  assert.deepEqual((await app.inject({method:'GET',url:'/vehicles',headers:{cookie:owner.cookie}})).json(),beforeVehicle);
  assert.equal((await app.inject({method:'POST',url:'/vehicle/contacts/import',headers,payload:{name:'유선',phone:'0212345678'}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/vehicle/contacts/import',headers,payload:{contacts:[payload]}})).statusCode,400);
});

test('imported recipient belongs to the paired owner and uses the existing single pickup and SMS path',async()=>{
  const owner=await login(),other=await login(),headers=await pair(owner.cookie),otherHeaders=await pair(other.cookie);
  const payload={name:'차량에서 선택',phone:'01081234568'};
  const selected=(await app.inject({method:'POST',url:'/vehicle/contacts/import',headers,payload})).json();
  const otherSelected=(await app.inject({method:'POST',url:'/vehicle/contacts/import',headers:otherHeaders,payload})).json();
  assert.notEqual(selected.id,otherSelected.id);
  assert.equal((await createPickup(otherHeaders,selected.id)).statusCode,404);
  const key=randomUUID(),started=await Promise.all([1,2].map(()=>createPickup(headers,selected.id,key)));
  const id=started[0].json().pickup.id;assert.equal(started[1].json().pickup.id,id);
  const jobs=(await pool.query("SELECT protected_payload FROM message_jobs WHERE pickup_id=$1 AND kind='START'",[id])).rows;
  assert.equal(jobs.length,1);assert.equal(security.open<{phone:string}>(jobs[0].protected_payload).phone,payload.phone);
  assert.equal((await app.inject({method:'GET',url:'/vehicle/contacts',headers})).json()[0].id,selected.id);
  await app.inject({method:'POST',url:`/pickups/${id}/end`,headers});
});

test('onboarding can finish without any recipient; repeat completion creates one vehicle and no contacts',async()=>{
  const setup=(await app.inject({method:'POST',url:'/onboarding/start',remoteAddress:'192.0.2.50',payload:{phone:'01070000801'}})).json();
  const token=new URLSearchParams(new URL(setup.claimUrl).hash.slice(1)).get('token');
  const verified=await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token,code:setup.developmentCode}});
  const responses=await Promise.all([1,2].map(()=>app.inject({method:'POST',url:'/onboarding/complete',headers:{origin,cookie:cookies(verified)},payload:{name:'새 사용자'}})));
  assert.deepEqual(responses.map(r=>r.statusCode),[200,200]);assert.equal(responses[0].json().vehicleId,responses[1].json().vehicleId);
  const ownerCookie=cookies(responses[0]);
  assert.deepEqual((await app.inject({method:'GET',url:'/contacts',headers:{cookie:ownerCookie}})).json(),[]);
  const paired=(await app.inject({method:'GET',url:`/pairings/${setup.id}`,headers:{authorization:`Pairing ${setup.deviceSecret}`}})).json();
  const headers={authorization:`Bearer ${paired.deviceToken}`};
  assert.deepEqual((await app.inject({method:'GET',url:'/vehicle/contacts',headers})).json(),[]);
  assert.equal((await app.inject({method:'POST',url:'/vehicle/contacts/import',headers,payload:{name:'가족',phone:'01070000802'}})).statusCode,200);
});

test('saving a meeting place preserves account, aliases and vehicle; validates ownership, origin and destination without SMS',async()=>{
  const owner=await login(),headers=await pair(owner.cookie),recipient=await contact(owner.cookie),other=await login(),outsider=await pair(other.cookie);
  const before=(await pool.query('SELECT to_jsonb(v) v FROM vehicles v WHERE driver_id=$1',[owner.id])).rows;
  const path=`/vehicle/contacts/${recipient.id}/place`,payload={destination};
  const jobs=(await pool.query('SELECT count(*)::int n FROM message_jobs')).rows[0].n;
  assert.equal((await app.inject({method:'PUT',url:path,headers:{origin,cookie:owner.cookie},payload})).statusCode,401);
  assert.equal((await app.inject({method:'PUT',url:path,headers:outsider,payload})).statusCode,404);
  assert.equal((await app.inject({method:'PUT',url:path,headers:{...headers,origin:'https://other.example'},payload})).statusCode,403);
  for(const bad of [{...destination,latitude:91},{...destination,name:''},{...destination,longitude:'127'}])assert.equal((await app.inject({method:'PUT',url:path,headers,payload:{destination:bad}})).statusCode,400);
  await Promise.all([1,2].map(async()=>assert.equal((await app.inject({method:'PUT',url:path,headers,payload})).statusCode,200)));
  assert.equal((await pool.query('SELECT count(*)::int n FROM contact_places WHERE contact_id=$1',[recipient.id])).rows[0].n,1);
  const list=(await app.inject({method:'GET',url:'/vehicle/contacts',headers})).json();
  assert.deepEqual(list[0].meetingPlace,destination);assert.deepEqual(list[0].aliases.sort(),recipient.aliases.sort());
  assert.equal((await pool.query('SELECT count(*)::int n FROM message_jobs')).rows[0].n,jobs);
  assert.deepEqual((await pool.query('SELECT to_jsonb(v) v FROM vehicles v WHERE driver_id=$1',[owner.id])).rows,before);
  const imported=(await app.inject({method:'POST',url:'/vehicle/contacts/import',headers,payload:{name:recipient.name,phone:recipient.phone}})).json();
  assert.deepEqual(imported.meetingPlace,destination);
  const replacement={...destination,name:'역 1번 출구'};
  assert.equal((await app.inject({method:'PUT',url:path,headers,payload:{destination:replacement}})).statusCode,200);
  assert.deepEqual((await app.inject({method:'GET',url:'/vehicle/contacts',headers})).json()[0].meetingPlace,replacement);
  assert.equal((await app.inject({method:'DELETE',url:path,headers:outsider})).statusCode,404);
  assert.equal((await app.inject({method:'DELETE',url:path,headers})).statusCode,200);
  assert.equal((await app.inject({method:'GET',url:'/vehicle/contacts',headers})).json()[0].meetingPlace,null);
  await app.inject({method:'PUT',url:path,headers,payload});
  await app.inject({method:'DELETE',url:`/contacts/${recipient.id}`,headers:{origin,cookie:owner.cookie}});
  assert.equal((await pool.query('SELECT 1 FROM contact_places WHERE contact_id=$1',[recipient.id])).rowCount,0);
  assert.equal((await app.inject({method:'PUT',url:path,headers,payload})).statusCode,404);
});

async function recipientLocationFixture() {
  const owner=await login(`198.18.${Math.floor(nextPhone/250)}.${nextPhone%250+1}`),car=await pair(owner.cookie),person=await contact(owner.cookie);
  const id=(await createPickup(car,person.id)).json().pickup.id;
  const row=(await pool.query('SELECT recipient_link_ciphertext FROM pickups WHERE id=$1',[id])).rows[0];
  const link=security.open<string>(row.recipient_link_ciphertext);
  const redeemed=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token:new URLSearchParams(new URL(link).hash.slice(1)).get('token'),code:await accessCode(id)}});
  assert.equal(redeemed.statusCode,200);
  return {id,car,headers:{origin,cookie:cookies(redeemed)}};
}
const recipientPoint={location:{latitude:37.4802,longitude:127.0303},accuracyMeters:12,ageMs:0};
test('legacy recipient samples remain scoped but are never exposed to the driver',async()=>{
  const f=await recipientLocationFixture();
  assert.equal((await app.inject({url:recipientPath('/shared-pickup',f.headers),headers:f.headers})).json().recipientLocation.state,'OFF');
  const lease=(await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
  const update=await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:1,...recipientPoint}});
  assert.equal(update.statusCode,200);assert.equal(update.json().recipientLocation.state,'LIVE');
  const owner=(await app.inject({url:'/pickups/current',headers:f.car})).json().pickup;
  assert.equal(owner.recipientLocation.state,'OFF');assert.equal(owner.recipientLocation.position,null);
  assert.ok(!JSON.stringify(owner).includes(lease.lease));assert.ok(!JSON.stringify(owner).includes('lease_hash'));
  const pause=await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:2,paused:true}});
  assert.equal(pause.json().recipientLocation.state,'PAUSED');assert.ok(pause.json().recipientLocation.position);
  assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:3,...recipientPoint}})).statusCode,409);
  assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:3,paused:false}})).statusCode,200);
  assert.equal((await app.inject({method:'DELETE',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:4}})).json().recipientLocation.state,'OFF');
  assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:5,...recipientPoint}})).statusCode,409);
  const row=(await pool.query('SELECT recipient_location,recipient_location_id,recipient_location_lease_hash FROM pickups WHERE id=$1',[f.id])).rows[0];
  assert.deepEqual(row,{recipient_location:null,recipient_location_id:null,recipient_location_lease_hash:null});
});
test('location leases bind to a pickup and reject replacement, cross-recipient, CSRF and old commands',async()=>{
  const a=await recipientLocationFixture(),b=await recipientLocationFixture();
  assert.equal((await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',{}),payload:{}})).statusCode,410);
  assert.equal((await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',{...a.headers,origin:'https://other.example'}),headers:{...a.headers,origin:'https://other.example'},payload:{}})).statusCode,403);
  const old=(await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',a.headers),headers:a.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
  assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',b.headers),headers:b.headers,payload:{...old,sequence:1,...recipientPoint}})).statusCode,409);
  const lease=(await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',a.headers),headers:a.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
  assert.equal((await app.inject({method:'DELETE',url:recipientPath('/shared-pickup/location',a.headers),headers:a.headers,payload:{...old,sequence:10}})).statusCode,409);
  assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',a.headers),headers:a.headers,payload:{...lease,sequence:2,paused:true}})).statusCode,200);
  assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',a.headers),headers:a.headers,payload:{...lease,sequence:1,...recipientPoint}})).statusCode,409);
  assert.equal((await app.inject({url:recipientPath('/shared-pickup',a.headers),headers:a.headers})).json().recipientLocation.state,'PAUSED');
});
test('location validation, measurement freshness and throttling do not refresh old coordinates',async()=>{
  const f=await recipientLocationFixture(),lease=(await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
  for(const bad of [{ageMs:30_001},{accuracyMeters:-1},{location:{latitude:91,longitude:127}},{ageMs:'0'}])
    assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:1,...recipientPoint,...bad}})).statusCode,400);
  assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:1,...recipientPoint}})).statusCode,200);
  assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:2,...recipientPoint}})).statusCode,429);
  await pool.query("UPDATE pickups SET recipient_location=jsonb_set(recipient_location,'{observedAt}',to_jsonb((now()-interval '31 seconds')::text)) WHERE id=$1",[f.id]);
  const loc=(await app.inject({url:recipientPath('/shared-pickup',f.headers),headers:f.headers})).json().recipientLocation;
  assert.equal(loc.state,'STALE');assert.ok(loc.ageMs>=30_000);assert.deepEqual(loc.position.location,recipientPoint.location);
});
test('ending, expiry and a concurrent location upload erase the last position and write lease',async()=>{
  for(const expire of [false,true]) {
    const f=await recipientLocationFixture(),lease=(await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
    await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:1,...recipientPoint}});
    if(expire){await pool.query("UPDATE pickups SET expires_at=now()-interval '1 second' WHERE id=$1",[f.id]);await expirePickups(pool);}
    else await Promise.all([app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.car}),app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:2,paused:true}})]);
    const row=(await pool.query('SELECT recipient_location,recipient_location_id,recipient_location_lease_hash FROM pickups WHERE id=$1',[f.id])).rows[0];
    assert.deepEqual(row,{recipient_location:null,recipient_location_id:null,recipient_location_lease_hash:null});
    assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:3,...recipientPoint}})).statusCode,410);
  }
});
test('location update waiting on a row lock cannot write after pickup expiry',async()=>{
  const f=await recipientLocationFixture(),lease=(await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
  await pool.query("UPDATE pickups SET expires_at=now()+interval '1 second' WHERE id=$1",[f.id]);
  const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM pickups WHERE id=$1 FOR UPDATE',[f.id]);
  try {
    const pending=app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:1,...recipientPoint}}).then(r=>r);
    await new Promise(resolve=>setTimeout(resolve,1100));await lock.query('COMMIT');
    assert.equal((await pending).statusCode,410);
    assert.equal((await pool.query('SELECT recipient_location FROM pickups WHERE id=$1',[f.id])).rows[0].recipient_location,null);
    await expirePickups(pool);
  }finally{await lock.query('ROLLBACK');lock.release();}
});

test('recipient code gates all shared data, persists per browser/pickup, and cannot authorize another pickup',async()=>{
 const a=await recipientLocationFixture();const b=await recipientLocationFixture();
 const row=(await pool.query('SELECT recipient_link_ciphertext FROM pickups WHERE id=$1',[b.id])).rows[0];
 const link=security.open<string>(row.recipient_link_ciphertext),linkToken=new URLSearchParams(new URL(link).hash.slice(1)).get('token');
 const gate=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin,cookie:a.headers.cookie},payload:{token:linkToken}});
 assert.equal(gate.json().verificationRequired,true);assert.equal(gate.json().pickup,undefined);
 assert.equal(String(gate.headers['set-cookie']).includes('Max-Age=0'),false);
 const pending=cookies(gate);
 assert.equal((await app.inject({method:'GET',url:recipientPath('/shared-pickup',{cookie:pending}),headers:{cookie:pending}})).json().code,'SHARE_CODE_REQUIRED');
 assert.equal((await app.inject({method:'GET',url:recipientPath('/shared-pickup/events',{cookie:pending}),headers:{cookie:pending}})).statusCode,401);
 assert.equal((await app.inject({method:'PUT',url:recipientPath('/shared-pickup/readiness',{origin,cookie:pending}),headers:{origin,cookie:pending},payload:{readiness:'OUTSIDE'}})).statusCode,401);
 assert.equal((await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',{origin,cookie:pending}),headers:{origin,cookie:pending},payload:{}})).statusCode,401);
 const code=await accessCode(b.id),verified=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin,cookie:pending},payload:{code,pickupId:b.id}});
 assert.equal(verified.statusCode,200);const known=cookies(verified);
 assert.equal((await app.inject({method:'GET',url:recipientPath('/shared-pickup',{cookie:known}),headers:{cookie:known}})).json().id,b.id);
 const reopen=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin,cookie:known},payload:{token:linkToken}});
 assert.equal(reopen.json().verificationRequired,false);
 const first=(await pool.query('SELECT recipient_link_ciphertext FROM pickups WHERE id=$1',[a.id])).rows[0];
 const another=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin,cookie:known},payload:{token:new URL(security.open<string>(first.recipient_link_ciphertext)).hash.slice(7)}});
 assert.equal(another.json().verificationRequired,true);
});
test('recipient code failures persist, serialize concurrent attempts and never bypass origin or expiry',async()=>{
 const f=await recipientLocationFixture(),row=(await pool.query('SELECT recipient_link_ciphertext FROM pickups WHERE id=$1',[f.id])).rows[0];
 const linkToken=new URL(security.open<string>(row.recipient_link_ciphertext)).hash.slice(7);
 const gate=await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token:linkToken}}),pending=cookies(gate);
 assert.equal((await app.inject({method:'POST',url:'/shares/redeem',headers:{origin:'https://other.example',cookie:pending},payload:{code:await accessCode(f.id)}})).statusCode,403);
 const wrong=(await accessCode(f.id))==='0000'?'0001':'0000';
 const attempts=await Promise.all(Array.from({length:7},()=>app.inject({method:'POST',url:'/shares/redeem',headers:{origin,cookie:pending},payload:{pickupId:f.id,code:wrong}})));
 assert.equal(attempts.filter(r=>r.statusCode===400).length,4);assert.equal(attempts.filter(r=>r.statusCode===429).length,3);
 assert.equal((await pool.query('SELECT failed_attempts FROM share_grants WHERE pickup_id=$1',[f.id])).rows[0].failed_attempts,5);
 assert.equal((await app.inject({method:'POST',url:'/shares/redeem',headers:{origin,cookie:pending},payload:{pickupId:f.id,code:await accessCode(f.id)}})).statusCode,429);
 assert.equal((await app.inject({method:'POST',url:'/shares/redeem',headers:{origin,cookie:pending+'bad'},payload:{code:'0000'}})).statusCode,401);
 await app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.car});
 assert.equal((await app.inject({method:'POST',url:'/shares/redeem',headers:{origin,cookie:pending},payload:{pickupId:f.id,code:'0000'}})).statusCode,410);
 const ended=(await pool.query('SELECT recipient_code_hash,recipient_code_ciphertext FROM pickups WHERE id=$1',[f.id])).rows[0];assert.deepEqual(ended,{recipient_code_hash:null,recipient_code_ciphertext:null});
});
test('optional vehicle details are authorized, shared only after code authentication and cleared at end',async()=>{
 const f=await recipientLocationFixture(),other=await login('198.51.100.200');
 const vehicle=(await pool.query('SELECT vehicle_id,driver_id FROM pickups WHERE id=$1',[f.id])).rows[0];
 const session=randomBytes(32).toString('base64url');await pool.query("INSERT INTO web_sessions(token_hash,driver_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hash(session),vehicle.driver_id]);
 const path=`/vehicles/${vehicle.vehicle_id}`,payload={modelName:'아이오닉 5',licensePlate:'123가 4567'};
 assert.equal((await app.inject({method:'PATCH',url:path,headers:{origin,cookie:other.cookie},payload})).statusCode,404);
 assert.equal((await app.inject({method:'PATCH',url:path,headers:{origin,cookie:`pmu_driver=${session}`},payload})).statusCode,200);
 assert.deepEqual((await app.inject({method:'GET',url:recipientPath('/shared-pickup',f.headers),headers:f.headers})).json().vehicle,{modelKey:'ioniq5',...payload});
 await app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.car});
 assert.equal((await pool.query('SELECT vehicle_plate IS NULL AS removed FROM pickups WHERE id=$1',[f.id])).rows[0].removed,true);
 assert.equal((await pool.query('SELECT license_plate FROM vehicles WHERE id=$1',[vehicle.vehicle_id])).rows[0].license_plate,payload.licensePlate);
});
test('onboarding optionally stores vehicle identity without requiring any recipient or vehicle information',async()=>{
 const phone=`0100000${String(++nextPhone).padStart(4,'0')}`;
 const setup=(await app.inject({method:'POST',url:'/onboarding/start',remoteAddress:'198.51.100.201',headers:{origin},payload:{phone}})).json();
 const verify=await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token:new URL(setup.claimUrl).hash.slice(7),code:setup.developmentCode}});
 const done=await app.inject({method:'POST',url:'/onboarding/complete',headers:{origin,cookie:cookies(verify)},payload:{name:'설정 시험',modelName:'쏘나타',licensePlate:'123가 4567'}});
 assert.equal(done.statusCode,200);const row=(await pool.query('SELECT model_name,license_plate,model_key FROM vehicles WHERE id=$1',[done.json().vehicleId])).rows[0];
 assert.deepEqual(row,{model_name:'쏘나타',license_plate:'123가 4567',model_key:null});
});
test('manual share message is owner-only, includes the existing link/code, and never confirms SMS',async()=>{
 const f=await recipientLocationFixture(),url=`/pickups/${f.id}/share-message`;
 const other=await login('198.51.100.202'),otherCar=await pair(other.cookie);
 assert.equal((await app.inject({method:'GET',url,headers:otherCar})).statusCode,404);
 assert.equal((await app.inject({method:'GET',url,headers:f.headers})).statusCode,401);
 const response=await app.inject({method:'GET',url,headers:f.car}),value=response.json();
 assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');
 assert.equal(value.pickupId,f.id);assert.match(value.maskedPhone,/^010-\*{4}-9999$/);
 assert.equal(value.accessCode,await accessCode(f.id));assert.ok(value.message.includes(value.shareLink));assert.ok(value.message.includes(value.accessCode));
 const row=(await pool.query('SELECT recipient_link_ciphertext,sms_confirmed FROM pickups WHERE id=$1',[f.id])).rows[0];
 assert.equal(value.shareLink,security.open(row.recipient_link_ciphertext));assert.equal(row.sms_confirmed,false);
 assert.equal((await app.inject({method:'GET',url:recipientPath('/shared-pickup',f.headers),headers:f.headers})).json().shareLink,undefined);
 await app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.car});
 assert.equal((await app.inject({method:'GET',url,headers:f.car})).statusCode,410);
});
test('SMS confirmation is explicit, owner-only, idempotent and cannot revive an ended pickup',async()=>{
 const f=await recipientLocationFixture(),url=`/pickups/${f.id}/confirm-message`;
 const other=await login('198.51.100.203'),otherCar=await pair(other.cookie);
 assert.equal((await app.inject({method:'POST',url,headers:f.car,payload:{}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url,headers:otherCar,payload:{confirmed:true}})).statusCode,404);
 assert.equal((await app.inject({method:'POST',url,headers:f.headers,payload:{confirmed:true}})).statusCode,401);
 const first=(await app.inject({method:'POST',url,headers:f.car,payload:{confirmed:true}})).json().pickup;
 assert.equal(first.smsConfirmed,true);
 const repeat=(await app.inject({method:'POST',url,headers:f.car,payload:{confirmed:true}})).json().pickup;
 assert.equal(repeat.version,first.version);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM message_jobs WHERE pickup_id=$1 AND kind='START'",[f.id])).rows[0].n,1);
 await app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.car});
 assert.equal((await app.inject({method:'POST',url,headers:f.car,payload:{confirmed:true}})).statusCode,410);
});

test('setup shares a device-authorized link without leaking OTP and resends once atomically with the same code/link',async()=>{
 const setup=(await app.inject({method:'POST',url:'/onboarding/start',remoteAddress:'192.0.2.151',payload:{phone:'01073000001'}})).json();
 const headers={authorization:`Pairing ${setup.deviceSecret}`},url=`/onboarding/${setup.id}`;
 assert.equal((await app.inject({method:'GET',url:url+'/message'})).statusCode,410);
 const message=(await app.inject({method:'GET',url:url+'/message',headers})).json();
 assert.equal(message.claimUrl,setup.claimUrl);assert.ok(message.shareMessage.includes(setup.claimUrl));assert.ok(!message.shareMessage.includes(setup.developmentCode));assert.equal(message.developmentCode,undefined);
 assert.equal((await app.inject({method:'POST',url:url+'/resend',headers,payload:{confirmed:true}})).statusCode,429);
 await pool.query("UPDATE login_challenges SET created_at=now()-interval '2 minutes' WHERE id=(SELECT challenge_id FROM onboarding WHERE pairing_id=$1)",[setup.id]);
 const responses=await Promise.all([1,2,3].map(()=>app.inject({method:'POST',url:url+'/resend',headers,payload:{confirmed:true}})));
 assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,409,409]);assert.equal(responses.find(r=>r.statusCode===200)!.json().resendsRemaining,0);
 const rows=(await pool.query('SELECT status,protected_payload FROM message_jobs WHERE challenge_id=(SELECT challenge_id FROM onboarding WHERE pairing_id=$1) ORDER BY created_at',[setup.id])).rows;
 assert.equal(rows.length,2);assert.equal(rows[0].status,'CANCELLED');assert.equal(rows[0].protected_payload,null);
 const payload=security.open<{message:string}>(rows[1].protected_payload);assert.ok(payload.message.includes(setup.claimUrl));assert.ok(payload.message.includes(setup.developmentCode));
 const verified=await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token:new URL(setup.claimUrl).hash.slice(7),code:setup.developmentCode}});
 assert.equal(verified.statusCode,200);
 const completedProof=(await app.inject({method:'GET',url:url+'/message',headers})).json();assert.equal(completedProof.verified,true);assert.equal(completedProof.resendsRemaining,0);
});
test('setup resend refuses verified, expired, locked or actively dispatching requests without resetting attempts',async()=>{
 for(const [index,mode] of ['verified','expired','locked','dispatch'].entries()) {
  const setup=(await app.inject({method:'POST',url:'/onboarding/start',remoteAddress:`192.0.2.${160+index}`,payload:{phone:`0107300010${index}`}})).json();
  const challenge=(await pool.query('SELECT challenge_id FROM onboarding WHERE pairing_id=$1',[setup.id])).rows[0].challenge_id;
  await pool.query("UPDATE login_challenges SET created_at=now()-interval '2 minutes' WHERE id=$1",[challenge]);
  if(mode==='verified')await pool.query('UPDATE login_challenges SET consumed_at=now() WHERE id=$1',[challenge]);
  if(mode==='expired')await pool.query("UPDATE login_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",[challenge]);
  if(mode==='locked')await pool.query('UPDATE login_challenges SET attempts=5 WHERE id=$1',[challenge]);
  if(mode==='dispatch')await pool.query("UPDATE message_jobs SET status='UNKNOWN',dispatch_token=$2,lease_expires_at=now()+interval '30 seconds' WHERE challenge_id=$1",[challenge,randomUUID()]);
  const response=await app.inject({method:'POST',url:`/onboarding/${setup.id}/resend`,headers:{authorization:`Pairing ${setup.deviceSecret}`},payload:{confirmed:true}});
  assert.equal(response.statusCode,mode==='dispatch'?409:410);
  assert.equal((await pool.query('SELECT resend_count FROM onboarding WHERE pairing_id=$1',[setup.id])).rows[0].resend_count,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM message_jobs WHERE challenge_id=$1',[challenge])).rows[0].n,1);
 }
});
test('real setup device message never exposes SMS OTP and rejects cross-mode or wrong device secret',async()=>{
 const real=buildApp(pool,{secret,publicOrigin:'https://pickup.example',smsMode:'solapi',production:false});await real.ready();
 try {
  const setup=(await real.inject({method:'POST',url:'/onboarding/start',remoteAddress:'192.0.2.169',payload:{phone:'01073000201'}})).json();
  assert.equal(setup.developmentCode,undefined);assert.ok(setup.claimUrl.startsWith('https://pickup.example/setup#token='));
  const code=security.open<{message:string}>((await pool.query('SELECT message_ciphertext FROM onboarding WHERE pairing_id=$1',[setup.id])).rows[0].message_ciphertext).message.match(/\d{6}/)![0];
  const url=`/onboarding/${setup.id}/message`,headers={authorization:`Pairing ${setup.deviceSecret}`};
  const response=await real.inject({method:'GET',url,headers});assert.equal(response.statusCode,200);assert.ok(!response.body.includes(code));assert.equal(response.headers['cache-control'],'no-store');
  assert.equal((await real.inject({method:'GET',url,headers:{authorization:'Pairing wrong'}})).statusCode,410);
  assert.equal((await app.inject({method:'GET',url,headers})).statusCode,410);
 }finally{await real.close();}
});
test('pickup resend requires approval, cooldown and owner, then preserves its link and code across one concurrent retry',async()=>{
 const owner=await login('192.0.2.175'),headers=await pair(owner.cookie),recipient=await contact(owner.cookie),other=await pair((await login('192.0.2.176')).cookie);
 const id=(await createPickup(headers,recipient.id)).json().pickup.id,url=`/pickups/${id}/resend-message`;
 assert.equal((await app.inject({method:'POST',url,headers:other,payload:{confirmed:true}})).statusCode,404);
 assert.equal((await app.inject({method:'POST',url,headers,payload:{confirmed:true}})).statusCode,409);
 await app.inject({method:'POST',url:`/pickups/${id}/confirm-message`,headers,payload:{confirmed:true}});
 assert.equal((await app.inject({method:'POST',url,headers,payload:{confirmed:true}})).statusCode,429);
 const before=(await app.inject({method:'GET',url:`/pickups/${id}/share-message`,headers})).json();
 await pool.query("UPDATE pickups SET started_at=now()-interval '2 minutes' WHERE id=$1",[id]);
 const responses=await Promise.all([1,2].map(()=>app.inject({method:'POST',url,headers,payload:{confirmed:true}})));
 assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,409]);
 assert.equal(responses.find(r=>r.statusCode===200)!.json().pickup.messageResendsRemaining,0);
 const after=(await app.inject({method:'GET',url:`/pickups/${id}/share-message`,headers})).json();assert.equal(after.shareLink,before.shareLink);assert.equal(after.accessCode,before.accessCode);
 const jobs=(await pool.query('SELECT kind,status,protected_payload FROM message_jobs WHERE pickup_id=$1',[id])).rows;
 assert.equal(jobs.filter(j=>j.kind==='RESEND').length,1);assert.equal(jobs.find(j=>j.kind==='START').status,'CANCELLED');
 await app.inject({method:'POST',url:`/pickups/${id}/end`,headers});
 assert.equal((await app.inject({method:'POST',url,headers,payload:{confirmed:true}})).statusCode,410);
 assert.equal((await pool.query('SELECT count(*)::int n FROM message_jobs WHERE pickup_id=$1 AND protected_payload IS NOT NULL',[id])).rows[0].n,0);
});
test('pickup resend refuses an active dispatch lease without consuming its single retry',async()=>{
 const owner=await login('192.0.2.177'),headers=await pair(owner.cookie),recipient=await contact(owner.cookie);
 const id=(await createPickup(headers,recipient.id)).json().pickup.id;
 await app.inject({method:'POST',url:`/pickups/${id}/confirm-message`,headers,payload:{confirmed:true}});
 await pool.query("UPDATE pickups SET started_at=now()-interval '2 minutes' WHERE id=$1",[id]);
 await pool.query("UPDATE message_jobs SET status='UNKNOWN',dispatch_token=$2,lease_expires_at=now()+interval '30 seconds' WHERE pickup_id=$1",[id,randomUUID()]);
 assert.equal((await app.inject({method:'POST',url:`/pickups/${id}/resend-message`,headers,payload:{confirmed:true}})).statusCode,409);
 assert.equal((await pool.query('SELECT message_resend_count FROM pickups WHERE id=$1',[id])).rows[0].message_resend_count,0);
 await app.inject({method:'POST',url:`/pickups/${id}/end`,headers});
});

test('location consent is explicit and missing or obsolete consent cannot replace an existing share',async()=>{
 const f=await recipientLocationFixture();
 const lease=(await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
 await app.inject({method:'PUT',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload:{...lease,sequence:1,...recipientPoint}});
 for(const payload of [{},{consent:false,consentVersion:'2026-11-08'},{consent:true,consentVersion:'old'}]){
  const r=await app.inject({method:'POST',url:recipientPath('/shared-pickup/location',f.headers),headers:f.headers,payload});assert.equal(r.statusCode,400);assert.equal(r.json().code,'LOCATION_CONSENT_REQUIRED');
 }
 const current=(await app.inject({url:recipientPath('/shared-pickup',f.headers),headers:f.headers})).json();assert.equal(current.recipientLocation.sessionId,lease.sessionId);assert.deepEqual(current.recipientLocation.position.location,recipientPoint.location);
});

// Multi-link regression tests intentionally use raw, explicit URLs (no fixture URL adapter).
test('simultaneous recipient cookies keep A/B data and writes isolated; missing or mismatched scope never guesses',async()=>{
 const a=await recipientLocationFixture(),b=await recipientLocationFixture(),cookie=a.headers.cookie+'; '+b.headers.cookie,headers={origin,cookie};
 for(const id of [a.id,b.id])assert.equal((await app.inject({url:`/shared-pickup?pickupId=${id}`,headers})).json().id,id);
 assert.equal((await app.inject({url:'/shared-pickup',headers})).json().code,'PICKUP_SCOPE_REQUIRED');
 const write=await app.inject({method:'PUT',url:`/shared-pickup/readiness?pickupId=${a.id}`,headers,payload:{readiness:'OUTSIDE'}});
 assert.equal(write.json().id,a.id);assert.equal((await pool.query('SELECT readiness FROM pickups WHERE id=$1',[b.id])).rows[0].readiness,'UNKNOWN');
 for(const path of ['/shared-pickup/readiness','/shared-pickup/location','/shared-pickup/push/status']){
  const r=await app.inject({method:path.endsWith('readiness')?'PUT':'POST',url:path,headers,payload:{readiness:'OUTSIDE',endpoint:'https://fcm.googleapis.com/test'}});
  assert.equal(r.statusCode,400);assert.equal(r.json().code,'PICKUP_SCOPE_REQUIRED');
  const mismatch=await app.inject({method:path.endsWith('readiness')?'PUT':'POST',url:path+'?pickupId='+a.id,headers,payload:{pickupId:b.id,readiness:'OUTSIDE'}});
  assert.equal(mismatch.json().code,'PICKUP_MISMATCH');
 }
 const denied=await app.inject({url:`/shared-pickup?pickupId=${a.id}`,headers:b.headers});assert.equal(denied.statusCode,410);
 const lease=(await app.inject({method:'POST',url:`/shared-pickup/location?pickupId=${a.id}`,headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
 assert.ok(lease.lease);assert.equal((await app.inject({method:'PUT',url:`/shared-pickup/location?pickupId=${b.id}`,headers,payload:{...lease,sequence:1,...recipientPoint}})).statusCode,409);
});

test('legacy recipient sessions bootstrap read-only and cannot write to another pickup',async()=>{
 const a=await recipientLocationFixture(),b=await recipientLocationFixture(),cookie='pmu_share='+a.headers.cookie.split('=')[1];
 assert.equal((await app.inject({url:'/shared-pickup',headers:{cookie}})).json().id,a.id);
 assert.equal((await app.inject({url:`/shared-pickup?pickupId=${b.id}`,headers:{cookie}})).statusCode,410);
 assert.equal((await app.inject({method:'PUT',url:'/shared-pickup/readiness',headers:{origin,cookie},payload:{readiness:'OUTSIDE'}})).statusCode,400);
 assert.equal((await app.inject({method:'PUT',url:`/shared-pickup/readiness?pickupId=${a.id}`,headers:{origin,cookie},payload:{readiness:'OUTSIDE'}})).statusCode,200);
});

async function lockCode(id:string){
 const row=(await pool.query('SELECT recipient_link_ciphertext FROM pickups WHERE id=$1',[id])).rows[0];const token=new URL(security.open<string>(row.recipient_link_ciphertext)).hash.slice(7),code=await accessCode(id),wrong=code==='0000'?'0001':'0000';
 for(let i=0;i<5;i++)await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token,code:wrong}});
 return {token,code};
}
test('locked code renews with new link/code, revokes old sessions/location/push; no extra SMS and credentials remain',async()=>{
 const f=await recipientLocationFixture(),old=await lockCode(f.id);
 const headers=f.car,ownerBefore=(await pool.query('SELECT id,driver_id,vehicle_id FROM pickups WHERE id=$1',[f.id])).rows[0];
 const lease=(await app.inject({method:'POST',url:`/shared-pickup/location?pickupId=${f.id}`,headers:f.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
 await app.inject({method:'PUT',url:`/shared-pickup/location?pickupId=${f.id}`,headers:f.headers,payload:{...lease,sequence:1,...recipientPoint}});
 await pool.query(`INSERT INTO pickup_push_subscriptions(id,pickup_id,endpoint_hash,protected_subscription,expires_at) VALUES($1,$2,'test','test',now()+interval '1 hour')`,[randomUUID(),f.id]);
 const before=await app.inject({url:'/pickups/current',headers});assert.equal(before.json().pickup.shareCodeLocked,true);
 const count=Number((await pool.query('SELECT count(*) n FROM message_jobs WHERE pickup_id=$1',[f.id])).rows[0].n),key=randomUUID(),url=`/pickups/${f.id}/renew-access`;
 assert.equal((await app.inject({method:'POST',url,headers,payload:{idempotencyKey:key}})).statusCode,400);
 const [a,b]=await Promise.all([1,2].map(()=>app.inject({method:'POST',url,headers,payload:{confirmed:true,idempotencyKey:key}})));
 assert.equal(a.statusCode,200);assert.equal(b.statusCode,200);assert.equal(a.json().pickup.shareRenewalsRemaining,1);assert.equal(b.json().pickup.shareRenewalsRemaining,1);assert.equal(a.json().pickup.shareCodeLocked,false);
 const row=(await pool.query('SELECT * FROM pickups WHERE id=$1',[f.id])).rows[0];assert.deepEqual({id:row.id,driver_id:row.driver_id,vehicle_id:row.vehicle_id},ownerBefore);assert.equal(row.state,'ACTIVE');assert.equal(row.recipient_location,null);assert.equal(row.recipient_location_id,null);assert.equal(row.recipient_location_lease_hash,null);
 const push=(await pool.query('SELECT protected_subscription,revoked_at FROM pickup_push_subscriptions WHERE pickup_id=$1',[f.id])).rows[0];assert.equal(push.protected_subscription,null);assert.ok(push.revoked_at);
 assert.equal(Number((await pool.query('SELECT count(*) n FROM message_jobs WHERE pickup_id=$1',[f.id])).rows[0].n),count);
 assert.equal((await app.inject({url:`/shared-pickup?pickupId=${f.id}`,headers:f.headers})).statusCode,410);
 assert.equal((await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:old})).statusCode,410);
 const link=await app.inject({url:`/pickups/${f.id}/share-message`,headers});const content=link.json(),newToken=new URL(content.shareLink).hash.slice(7);
 assert.notEqual(content.accessCode,old.code);assert.notEqual(newToken,old.token);assert.ok(content.message.includes(content.accessCode));
 assert.equal((await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token:newToken,code:old.code}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/shares/redeem',headers:{origin},payload:{token:newToken,code:content.accessCode}})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url,headers,payload:{confirmed:true,idempotencyKey:randomUUID()}})).statusCode,429);
 await pool.query("UPDATE pickups SET share_renewed_at=now()-interval '61 seconds' WHERE id=$1",[f.id]);
 assert.equal((await app.inject({method:'POST',url,headers,payload:{confirmed:true,idempotencyKey:randomUUID()}})).json().pickup.shareRenewalsRemaining,0);
 assert.equal((await app.inject({method:'POST',url,headers,payload:{confirmed:true,idempotencyKey:randomUUID()}})).statusCode,409);
 assert.equal((await app.inject({url:'/vehicle/contacts',headers})).statusCode,200);
});

test('renewal respects owner and expiry, and never resets the one-SMS-resend allowance',async()=>{
 const f=await recipientLocationFixture(),other=await recipientLocationFixture(),url=`/pickups/${f.id}/renew-access`;
 assert.equal((await app.inject({method:'POST',url,headers:other.car,payload:{confirmed:true,idempotencyKey:randomUUID()}})).statusCode,404);
 await pool.query("UPDATE pickups SET started_at=now()-interval '61 seconds' WHERE id=$1",[f.id]);
 await app.inject({method:'POST',url:`/pickups/${f.id}/confirm-message`,headers:f.car,payload:{confirmed:true}});
 assert.equal((await app.inject({method:'POST',url:`/pickups/${f.id}/resend-message`,headers:f.car,payload:{confirmed:true}})).statusCode,200);
 const rotated=await app.inject({method:'POST',url,headers:f.car,payload:{confirmed:true,idempotencyKey:randomUUID()}});assert.equal(rotated.json().pickup.messageResendsRemaining,0);
 assert.equal((await app.inject({method:'POST',url:`/pickups/${f.id}/resend-message`,headers:f.car,payload:{confirmed:true}})).statusCode,409);
 await app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.car});assert.equal((await app.inject({method:'POST',url,headers:f.car,payload:{confirmed:true,idempotencyKey:randomUUID()}})).statusCode,410);
});

test('recipient mutation already waiting for pickup lock is rejected after access renewal',async()=>{
 const f=await recipientLocationFixture(),lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM pickups WHERE id=$1 FOR UPDATE',[f.id]);
 try{
  const renewal=app.inject({method:'POST',url:`/pickups/${f.id}/renew-access`,headers:f.car,payload:{confirmed:true,idempotencyKey:randomUUID()}}).then(r=>r);
  await new Promise(r=>setTimeout(r,60));
  const ready=app.inject({method:'PUT',url:`/shared-pickup/readiness?pickupId=${f.id}`,headers:f.headers,payload:{readiness:'OUTSIDE'}}).then(r=>r);
  await new Promise(r=>setTimeout(r,60));await lock.query('COMMIT');
  assert.equal((await renewal).statusCode,200);assert.equal((await ready).statusCode,410);
  assert.equal((await pool.query('SELECT readiness FROM pickups WHERE id=$1',[f.id])).rows[0].readiness,'UNKNOWN');
 }finally{await lock.query('ROLLBACK');lock.release();}
});

test('delivery snapshots expose queue timestamps without claiming SMS delivery',async()=>{
 const f=await recipientLocationFixture();let current=(await app.inject({url:'/pickups/current',headers:f.car})).json().pickup;
 assert.equal(current.messages[0].status,'PENDING');assert.ok(Date.parse(current.messages[0].availableAt));assert.ok(Date.parse(current.messages[0].updatedAt));assert.equal(current.smsConfirmed,false);
 await pool.query("UPDATE message_jobs SET status='ACCEPTED',protected_payload=NULL WHERE pickup_id=$1",[f.id]);
 current=(await app.inject({url:'/pickups/current',headers:f.car})).json().pickup;assert.equal(current.messages[0].status,'ACCEPTED');assert.equal(current.messages[0].message,undefined);
});

test('two simultaneous cookies scope real SSE snapshots and renewal closes only the old pickup stream',async()=>{
 const a=await recipientLocationFixture(),b=await recipientLocationFixture(),cookie=a.headers.cookie+'; '+b.headers.cookie,address=app.server.address();
 assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
 assert.equal((await fetch(origin+'/shared-pickup/events',{headers:{cookie}})).status,409);
 async function open(id:string){
  const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),10_000),response=await fetch(origin+'/shared-pickup/events?pickupId='+id,{headers:{cookie},signal:controller.signal});assert.equal(response.status,200);
  const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';
  return {async next(){while(true){const i=buffer.indexOf('\n\n');if(i>=0){const frame=buffer.slice(0,i);buffer=buffer.slice(i+2);if(frame.startsWith('event:'))return frame;continue;}const next=await reader.read();if(next.done)throw Error('early stream end');buffer+=decoder.decode(next.value,{stream:true});}},close(){clearTimeout(deadline);controller.abort();}};
 }
 const one=await open(a.id),two=await open(b.id);
 try{
  assert.ok((await one.next()).includes(a.id));assert.ok((await two.next()).includes(b.id));
  assert.equal((await app.inject({method:'POST',url:`/pickups/${a.id}/renew-access`,headers:a.car,payload:{confirmed:true,idempotencyKey:randomUUID()}})).statusCode,200);
  assert.match(await one.next(),/^event: ended/);
  await app.inject({method:'PUT',url:`/shared-pickup/readiness?pickupId=${b.id}`,headers:{origin:'http://localhost:5173',cookie},payload:{readiness:'OUTSIDE'}});
  const current=await two.next();assert.ok(current.includes(b.id));assert.match(current,/"readiness":"OUTSIDE"/);
 }finally{one.close();two.close();}
});

test('recipient chooses a fixed waiting spot without GPS; owner sees it and unrelated pickup/destination/readiness stay intact',async()=>{
 const a=await recipientLocationFixture(),b=await recipientLocationFixture(),path=`/shared-pickup/waiting-point?pickupId=${a.id}`;
 const input={expectedRevision:0,consent:true,consentVersion:'2026-11-09-manual',location:{latitude:37.4804,longitude:127.0305}};
 assert.equal((await app.inject({method:'PUT',url:path,headers:b.headers,payload:input})).statusCode,410);
 assert.equal((await app.inject({method:'PUT',url:path,headers:a.headers,payload:{...input,consent:false}})).json().code,'WAITING_CONSENT_REQUIRED');
 for(const location of [{latitude:91,longitude:0},{latitude:37,longitude:181},{latitude:'37',longitude:127}])assert.equal((await app.inject({method:'PUT',url:path,headers:a.headers,payload:{...input,location}})).statusCode,400);
 const response=await app.inject({method:'PUT',url:path,headers:a.headers,payload:input});assert.equal(response.statusCode,200);assert.equal(response.json().waitingPoint.source,'MANUAL');assert.equal(response.json().waitingPointRevision,1);
 const owner=(await app.inject({url:'/pickups/current',headers:a.car})).json().pickup;assert.deepEqual(owner.waitingPoint.location,input.location);assert.equal(owner.recipientLocation.state,'OFF');assert.deepEqual(owner.destination,destination);assert.equal(owner.readiness,'UNKNOWN');
 assert.equal((await app.inject({url:'/pickups/current',headers:b.car})).json().pickup.waitingPoint,null);
 await pool.query("UPDATE pickups SET waiting_point=jsonb_set(waiting_point,'{selectedAt}',to_jsonb((now()-interval '10 minutes')::text)) WHERE id=$1",[a.id]);
 const restored=(await app.inject({url:`/shared-pickup?pickupId=${a.id}`,headers:a.headers})).json();assert.deepEqual(restored.waitingPoint.location,input.location);assert.equal(restored.waitingPointRevision,1);
});

test('waiting spot revisions prevent simultaneous tabs and late removals from undoing a newer selection',async()=>{
 const f=await recipientLocationFixture(),url=`/shared-pickup/waiting-point?pickupId=${f.id}`,input={expectedRevision:0,consent:true,consentVersion:'2026-11-09-manual',location:{latitude:37.48,longitude:127.03}};
 const responses=await Promise.all([app.inject({method:'PUT',url,headers:f.headers,payload:input}),app.inject({method:'PUT',url,headers:f.headers,payload:{...input,location:{latitude:37.49,longitude:127.04}}})]);assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,409]);
 assert.equal((await app.inject({method:'DELETE',url,headers:f.headers,payload:{expectedRevision:0}})).json().code,'WAITING_POINT_CHANGED');
 assert.equal((await app.inject({method:'PUT',url,headers:f.headers,payload:{...input,expectedRevision:1,location:{latitude:37.50,longitude:127.05}}})).statusCode,200);
 const deleted=await app.inject({method:'DELETE',url,headers:f.headers,payload:{expectedRevision:2}});assert.equal(deleted.json().waitingPoint,null);assert.equal(deleted.json().waitingPointRevision,3);
 assert.equal((await app.inject({method:'PUT',url,headers:f.headers,payload:{...input,expectedRevision:2}})).statusCode,409);
});

test('confirming a waiting pin clears the legacy GPS lease and stops old publishers',async()=>{
 const f=await recipientLocationFixture(),url=`/shared-pickup/waiting-point?pickupId=${f.id}`;
 const lease=(await app.inject({method:'POST',url:`/shared-pickup/location?pickupId=${f.id}`,headers:f.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
 await app.inject({method:'PUT',url:`/shared-pickup/location?pickupId=${f.id}`,headers:f.headers,payload:{...lease,sequence:1,...recipientPoint}});
 await app.inject({method:'PUT',url,headers:f.headers,payload:{expectedRevision:0,consent:true,consentVersion:'2026-11-09-manual',location:{latitude:37.481,longitude:127.031}}});
 const current=(await app.inject({url:'/pickups/current',headers:f.car})).json().pickup;assert.equal(current.recipientLocation.state,'OFF');assert.ok(current.waitingPoint);
 assert.equal((await app.inject({method:'PUT',url:`/shared-pickup/location?pickupId=${f.id}`,headers:f.headers,payload:{...lease,sequence:2,...recipientPoint}})).statusCode,410);
 assert.equal((await app.inject({method:'POST',url:`/shared-pickup/location?pickupId=${f.id}`,headers:f.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).statusCode,410);
 assert.equal((await app.inject({method:'DELETE',url,headers:f.headers,payload:{expectedRevision:1}})).json().waitingPoint,null);
});

test('end, expiry and access renewal delete manual waiting coordinates and reject old recipient writes',async()=>{
 for(const mode of ['end','expire','renew']){
  const f=await recipientLocationFixture(),url=`/shared-pickup/waiting-point?pickupId=${f.id}`,input={expectedRevision:0,consent:true,consentVersion:'2026-11-09-manual',location:{latitude:37.48,longitude:127.03}};
  assert.equal((await app.inject({method:'PUT',url,headers:f.headers,payload:input})).statusCode,200);
  if(mode==='end')await app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.car});
  if(mode==='expire'){await pool.query("UPDATE pickups SET expires_at=now()-interval '1 second' WHERE id=$1",[f.id]);await expirePickups(pool);}
  if(mode==='renew')await app.inject({method:'POST',url:`/pickups/${f.id}/renew-access`,headers:f.car,payload:{confirmed:true,idempotencyKey:randomUUID()}});
  assert.equal((await pool.query('SELECT waiting_point FROM pickups WHERE id=$1',[f.id])).rows[0].waiting_point,null);
  assert.equal((await app.inject({method:'PUT',url,headers:f.headers,payload:{...input,expectedRevision:1}})).statusCode,410);
 }
});

test('driver HTTP stream receives waiting-pin creation and removal as complete snapshots',async()=>{
 const f=await recipientLocationFixture(),address=app.server.address();assert.ok(address&&typeof address==='object');
 const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),10000);
 const response=await fetch(`http://127.0.0.1:${address.port}/vehicles/me/events`,{headers:f.car,signal:controller.signal});assert.equal(response.status,200);
 const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';
 async function next(){while(true){const i=buffer.indexOf('\n\n');if(i>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+2);if(line.startsWith('event: pickup\n'))return JSON.parse(line.split('\ndata: ')[1]).pickup;continue;}const r=await reader.read();if(r.done)throw Error('early close');buffer+=decoder.decode(r.value,{stream:true});}}
 try{
  assert.equal((await next()).waitingPoint,null);
  const url=`/shared-pickup/waiting-point?pickupId=${f.id}`,location={latitude:37.481,longitude:127.031};
  await app.inject({method:'PUT',url,headers:f.headers,payload:{expectedRevision:0,consent:true,consentVersion:'2026-11-09-manual',location}});
  assert.deepEqual((await next()).waitingPoint.location,location);
  await app.inject({method:'DELETE',url,headers:f.headers,payload:{expectedRevision:1}});assert.equal((await next()).waitingPoint,null);
 }finally{clearTimeout(deadline);controller.abort();}
});

test('waiting-location consent is remembered per pickup across edits and removal, and renewal clears it',async()=>{
 const f=await recipientLocationFixture(),url=`/shared-pickup/waiting-point?pickupId=${f.id}`,input={location:{latitude:37.48,longitude:127.03},expectedRevision:0,consentVersion:'2026-11-09-manual'};
 assert.equal((await app.inject({method:'PUT',url,headers:f.headers,payload:input})).json().code,'WAITING_CONSENT_REQUIRED');
 const first=await app.inject({method:'PUT',url,headers:f.headers,payload:{...input,consent:true}});assert.equal(first.json().waitingPointConsent,true);
 const edited=await app.inject({method:'PUT',url,headers:f.headers,payload:{...input,expectedRevision:1,location:{latitude:37.481,longitude:127.031}}});assert.equal(edited.statusCode,200);assert.equal(edited.json().waitingPointConsent,true);
 const cleared=await app.inject({method:'DELETE',url,headers:f.headers,payload:{expectedRevision:2}});assert.equal(cleared.json().waitingPoint,null);assert.equal(cleared.json().waitingPointConsent,true);
 assert.equal((await app.inject({method:'PUT',url,headers:f.headers,payload:{...input,expectedRevision:3}})).statusCode,200);
 const renewed=await app.inject({method:'POST',url:`/pickups/${f.id}/renew-access`,headers:f.car,payload:{confirmed:true,idempotencyKey:randomUUID()}});assert.equal(renewed.json().pickup.waitingPoint,null);assert.equal(renewed.json().pickup.waitingPointConsent,false);
});

test('waiting consent can be saved once before choosing a pin; repeats are idempotent and do not upload coordinates',async()=>{
 const f=await recipientLocationFixture(),url=`/shared-pickup/waiting-point/consent?pickupId=${f.id}`,payload={consent:true,consentVersion:'2026-11-09-manual'};
 const lease=(await app.inject({method:'POST',url:`/shared-pickup/location?pickupId=${f.id}`,headers:f.headers,payload:{consent:true,consentVersion:'2026-11-08'}})).json();
 await app.inject({method:'PUT',url:`/shared-pickup/location?pickupId=${f.id}`,headers:f.headers,payload:{...lease,sequence:1,...recipientPoint}});
 const first=await app.inject({method:'POST',url,headers:f.headers,payload});assert.equal(first.statusCode,200);assert.equal(first.json().waitingPointConsent,true);assert.equal(first.json().waitingPoint,null);assert.equal(first.json().waitingPointRevision,1);assert.equal(first.json().recipientLocation.position,null);
 const second=await app.inject({method:'POST',url,headers:f.headers,payload});assert.equal(second.json().waitingPointRevision,1);
 const restored=(await app.inject({url:`/shared-pickup?pickupId=${f.id}`,headers:f.headers})).json();assert.equal(restored.waitingPointConsent,true);assert.equal(restored.waitingPoint,null);
 const saved=await app.inject({method:'PUT',url:`/shared-pickup/waiting-point?pickupId=${f.id}`,headers:f.headers,payload:{expectedRevision:1,consentVersion:payload.consentVersion,location:{latitude:37.48,longitude:127.03}}});assert.equal(saved.statusCode,200);
 assert.equal((await app.inject({method:'DELETE',url:`/shared-pickup/waiting-point?pickupId=${f.id}`,headers:f.headers,payload:{expectedRevision:2}})).json().waitingPointConsent,true);
});
test('waiting consent requires explicit agreement, valid version, recipient scope and Origin',async()=>{
 const a=await recipientLocationFixture(),b=await recipientLocationFixture(),url=`/shared-pickup/waiting-point/consent?pickupId=${a.id}`,payload={consent:true,consentVersion:'2026-11-09-manual'};
 for(const input of [{...payload,consent:false},{...payload,consentVersion:'unknown'},{}])assert.equal((await app.inject({method:'POST',url,headers:a.headers,payload:input})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url,headers:{...a.headers,origin:'https://other.invalid'},payload})).statusCode,403);
 assert.notEqual((await app.inject({method:'POST',url,headers:b.headers,payload})).statusCode,200);
 assert.equal((await app.inject({url:`/shared-pickup?pickupId=${a.id}`,headers:a.headers})).json().waitingPointConsent,false);
});
test('end, expiry and link renewal clear consent saved without a pin and reject old consent requests',async()=>{
 for(const mode of ['end','expire','renew']){
  const f=await recipientLocationFixture(),url=`/shared-pickup/waiting-point/consent?pickupId=${f.id}`,payload={consent:true,consentVersion:'2026-11-09-manual'};
  assert.equal((await app.inject({method:'POST',url,headers:f.headers,payload})).statusCode,200);
  if(mode==='end')await app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.car});
  if(mode==='expire'){await pool.query("UPDATE pickups SET expires_at=now()-interval '1 second' WHERE id=$1",[f.id]);await expirePickups(pool);}
  if(mode==='renew')await app.inject({method:'POST',url:`/pickups/${f.id}/renew-access`,headers:f.car,payload:{confirmed:true,idempotencyKey:randomUUID()}});
  assert.equal((await pool.query('SELECT waiting_point_consent_version FROM pickups WHERE id=$1',[f.id])).rows[0].waiting_point_consent_version,null);
  assert.equal((await app.inject({method:'POST',url,headers:f.headers,payload})).statusCode,410);
 }
});
