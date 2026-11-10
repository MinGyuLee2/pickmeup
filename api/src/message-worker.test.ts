import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp, expirePickups } from './app.js';
import { migrate } from './db.js';
import { hash, secrets } from './domain.js';
import { MessageWorker } from './message-worker.js';
import { encodedMessage, type SendingMode, type SmsPayload, type SmsSender, type SendResult, type Receipt } from './sms.js';

const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
after(()=>admin.end());
class FakeSender implements SmsSender {
  sent:SmsPayload[]=[];
  lookedUp:string[]=[];
  result:SendResult|undefined;
  receipt:Receipt={state:'DELIVERED',code:'0',messageId:'message-1'};
  onSend:(()=>Promise<void>)|undefined;
  constructor(readonly mode:SendingMode='sens'){}
  async send(payload:SmsPayload):Promise<SendResult> {
    this.sent.push(payload);await this.onSend?.();
    return this.result??(this.mode==='local'?{kind:'simulated'}:{kind:'accepted',requestId:`request-${this.sent.length}`});
  }
  async lookup(id:string):Promise<Receipt>{this.lookedUp.push(id);return this.receipt;}
}
async function fixture(t:TestContext,mode:SendingMode='sens',eta=600,confirm=true) {
  const schema=`worker_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
  await migrate(pool);
  const secret=randomBytes(32).toString('base64'),security=secrets(secret);
  const origin=mode!=='local'?'https://pickup.example.test':'http://localhost:5173';
  const app=buildApp(pool,{secret,publicOrigin:origin,smsMode:mode,production:false});await app.ready();
  t.after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);});
  const requested=await app.inject({method:'POST',url:'/auth/otp/request',headers:{origin},payload:{phone:'01000001111'}});
  assert.equal(requested.statusCode,200);
  const challenge=requested.json();
  if(mode!=='local')assert.equal(challenge.developmentCode,undefined);
  const otp=(await pool.query("SELECT protected_payload FROM message_jobs WHERE challenge_id=$1",[challenge.challengeId])).rows[0];
  const code=security.open<SmsPayload>(otp.protected_payload).message.match(/\d{6}/)![0];
  const verified=await app.inject({method:'POST',url:'/auth/otp/verify',headers:{origin},payload:{challengeId:challenge.challengeId,code,name:'운전자'}});
  assert.equal(verified.statusCode,200);const cookie=String(verified.headers['set-cookie']).split(';')[0];
  const deviceToken=randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO vehicles(id,driver_id,token_hash) VALUES($1,$2,$3)',[randomUUID(),verified.json().driver.id,hash(deviceToken)]);
  const headers={authorization:`Bearer ${deviceToken}`};
  const contact=(await app.inject({method:'POST',url:'/contacts',headers:{origin,cookie},payload:{name:'지연이',phone:'01000002222',aliases:['지연']}})).json();
  const destination={name:'회사 정문',latitude:37.4,longitude:127.0};
  const observation=(remainingSeconds:number)=>({location:{latitude:37.41,longitude:127.01},remainingSeconds,remainingMeters:2000,locationAgeMs:0,etaAgeMs:0});
  const response=await app.inject({method:'POST',url:'/pickups',headers,payload:{idempotencyKey:randomUUID(),contactId:contact.id,destination,observation:observation(eta)}});
  assert.equal(response.statusCode,201);const id=response.json().pickup.id;
  if(confirm)assert.equal((await app.inject({method:'POST',url:`/pickups/${id}/confirm-message`,headers,payload:{confirmed:true}})).statusCode,200);
  const sender=new FakeSender(mode),worker=new MessageWorker(pool,secret,sender);
  let sequence=1;
  async function update(remaining:number,arrived=false) {
    const response=await app.inject({method:'PUT',url:`/pickups/${id}/observation`,headers,payload:{sequence:++sequence,destination,observation:observation(remaining),arrived}});
    assert.equal(response.statusCode,200);
  }
  async function job(kind='START') {return (await pool.query('SELECT * FROM message_jobs WHERE pickup_id=$1 AND kind=$2',[id,kind])).rows[0];}
  async function ready(kind='START') {await pool.query("UPDATE message_jobs SET available_at=now()-interval '1 second',next_check_at=now()-interval '1 second' WHERE pickup_id=$1 AND kind=$2",[id,kind]);}
  return {pool,app,headers,origin,cookie,id,sender,worker,secret,security,update,job,ready,initial:response.json().pickup};
}

test('competing workers send once; accepted is separate from delivered and survives restart',async t=>{
  const f=await fixture(t);
  await Promise.all([f.worker.runOnce(),new MessageWorker(f.pool,f.secret,f.sender).runOnce()]);
  assert.match(f.sender.sent[0].message,/인증코드: [0-9]{4}/);
  assert.equal(f.sender.sent.length,1);assert.equal((await f.job()).status,'ACCEPTED');assert.equal((await f.job()).protected_payload,null);
  await f.ready();await new MessageWorker(f.pool,f.secret,f.sender).runOnce();
  assert.equal((await f.job()).status,'DELIVERED');assert.equal(f.sender.sent.length,1);assert.ok((await f.job()).delivered_at);
  const current=(await f.app.inject({method:'GET',url:'/pickups/current',headers:f.headers})).json();
  assert.equal(current.pickup.messages.find((j:{kind:string})=>j.kind==='START').status,'DELIVERED');
});
test('unknown send and interrupted process never become an automatic resend',async t=>{
  const f=await fixture(t);f.sender.result={kind:'unknown',code:'TIMEOUT'};
  await f.worker.runOnce();assert.equal((await f.job()).status,'UNKNOWN');assert.equal(f.sender.sent.length,1);
  await new MessageWorker(f.pool,f.secret,f.sender).runOnce();assert.equal(f.sender.sent.length,1);
  await f.pool.query(`UPDATE message_jobs SET lease_expires_at=now()-interval '1 second',dispatch_token=$2,protected_payload=$3 WHERE id=$1`,
    [(await f.job()).id,randomUUID(),f.security.seal({phone:'01000002222',message:'보존된 불명 요청'})]);
  await f.worker.runOnce();assert.equal(f.sender.sent.length,1);assert.equal((await f.job()).last_error_code,'PROCESS_INTERRUPTED');assert.equal((await f.job()).protected_payload,null);
});
test('confirmed rate rejection can retry, with no delivery claim before a receipt',async t=>{
  const f=await fixture(t);f.sender.result={kind:'rejected',code:'RATE_LIMIT',retryable:true};
  await f.worker.runOnce();assert.equal((await f.job()).status,'PENDING');assert.equal((await f.job()).attempts,1);
  await f.ready();f.sender.result=undefined;await f.worker.runOnce();
  assert.equal((await f.job()).status,'ACCEPTED');assert.equal((await f.job()).attempts,2);assert.equal(f.sender.sent.length,2);
  f.sender.receipt={state:'UNKNOWN',code:'LOOKUP_UNAVAILABLE'};await f.ready();await f.worker.runOnce();
  assert.equal((await f.job()).status,'ACCEPTED');assert.equal(f.sender.sent.length,2);
  f.sender.receipt={state:'FAILED',code:'3001',messageId:'message-2'};await f.ready();await f.worker.runOnce();
  assert.equal((await f.job()).status,'FAILED');assert.equal(f.sender.sent.length,2);
});
test('stale data defers dispatch and the sent ETA uses the latest observation',async t=>{
  const f=await fixture(t);
  const sample=(await f.pool.query('SELECT latest_observation FROM pickups WHERE id=$1',[f.id])).rows[0].latest_observation;
  sample.etaReceivedAt=new Date(Date.now()-31_000).toISOString();
  await f.pool.query('UPDATE pickups SET latest_observation=$2 WHERE id=$1',[f.id,sample]);
  await f.worker.runOnce();assert.equal(f.sender.sent.length,0);assert.equal((await f.job()).last_error_code,'NAVIGATION_STALE');
  await f.update(540);await f.ready();await f.worker.runOnce();
  assert.equal(f.sender.sent.length,1);assert.match(f.sender.sent[0].message,/약 9분/);assert.doesNotMatch(f.sender.sent[0].message,/약 10분/);
});
test('near notice is folded into a pending first message and otherwise waits for fresh ETA <= 5 min',async t=>{
  const f=await fixture(t);await f.update(240);await f.worker.runOnce();
  assert.equal(f.sender.sent.length,1);assert.match(f.sender.sent[0].message,/곧 도착/);assert.equal((await f.job('NEAR')).last_error_code,'MERGED_IN_START');
  assert.equal((await f.job()).includes_near,true);
  await f.update(360);await f.update(240);await f.worker.runOnce();assert.equal(f.sender.sent.length,1);
});
test('initially near pickup reports merged guidance without creating a separate NEAR job',async t=>{
  const f=await fixture(t,'local',60);
  assert.equal(f.initial.messages.find((job:{kind:string})=>job.kind==='START').includesNear,true);
  assert.equal(await f.job('NEAR'),undefined);
  await f.worker.runOnce();
  assert.equal(f.sender.sent.length,1);assert.match(f.sender.sent[0].message,/곧 도착/);
  const current=(await f.app.inject({method:'GET',url:'/pickups/current',headers:f.headers})).json();
  assert.deepEqual(current.pickup.messages.map((job:{kind:string;status:string;includesNear:boolean})=>({kind:job.kind,status:job.status,includesNear:job.includesNear})),
    [{kind:'START',status:'SIMULATED',includesNear:true}]);
});
test('first-message near metadata follows the ETA actually prepared for dispatch',async t=>{
  const f=await fixture(t,'local',60);
  assert.equal((await f.job()).includes_near,true);
  await f.update(540);await f.worker.runOnce();
  assert.equal(f.sender.sent.length,1);assert.match(f.sender.sent[0].message,/약 9분/);assert.doesNotMatch(f.sender.sent[0].message,/곧 도착/);
  const current=(await f.app.inject({method:'GET',url:'/pickups/current',headers:f.headers})).json();
  assert.equal(current.pickup.messages.find((job:{kind:string})=>job.kind==='START').includesNear,false);
  await f.update(240);await f.worker.runOnce();
  assert.equal(f.sender.sent.length,2);assert.match(f.sender.sent[1].message,/5분 이내/);
});
test('a queued near notice is not sent if ETA rose again, and still sends only once later',async t=>{
  const f=await fixture(t);await f.worker.runOnce();await f.update(240);await f.update(360);
  await f.worker.runOnce();assert.equal(f.sender.sent.length,1);assert.equal((await f.job('NEAR')).status,'PENDING');
  await f.update(240);await f.ready('NEAR');await f.worker.runOnce();assert.equal(f.sender.sent.length,2);
  assert.match(f.sender.sent[1].message,/5분 이내/);assert.ok(f.sender.sent[1].shareLink?.startsWith('https://'));
  assert.equal(encodedMessage(f.sender.sent[1].message).type,'SMS');
  assert.doesNotMatch(f.sender.sent[1].message,/https?:/);
  await f.update(360);await f.update(240);await f.worker.runOnce();assert.equal(f.sender.sent.length,2);
});
test('dispatch skips locked pickups; a provider call already in flight is not recallable',async t=>{
  const f=await fixture(t);
  const lock=await f.pool.connect();await lock.query('BEGIN');await lock.query('SELECT id FROM pickups WHERE id=$1 FOR UPDATE',[f.id]);
  await f.worker.runOnce();assert.equal(f.sender.sent.length,0);
  await lock.query('ROLLBACK');lock.release();
  let started!:()=>void,release!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  f.sender.onSend=async()=>{started();await gate;};
  const work=f.worker.runOnce();await began;
  const ending=f.app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.headers});
  release();await work;assert.equal((await ending).statusCode,200);
  await f.worker.runOnce();assert.equal(f.sender.sent.length,1);
  assert.equal((await f.pool.query('SELECT latest_observation,recipient_link_ciphertext FROM pickups WHERE id=$1',[f.id])).rows[0].latest_observation,null);
});
test('committed end or expiry suppresses pending dispatch entirely',async t=>{
  const f=await fixture(t);
  await f.app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.headers});
  await f.worker.runOnce();assert.equal(f.sender.sent.length,0);assert.equal((await f.job()).status,'CANCELLED');
  const expired=await fixture(t);
  await expired.pool.query("UPDATE pickups SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
  await expired.worker.runOnce();assert.equal(expired.sender.sent.length,0);assert.equal((await expired.job()).status,'CANCELLED');
});
test('local jobs stay simulated, never cross to SENS, and expired previews are scrubbed',async t=>{
  const f=await fixture(t,'local');
  const real=new FakeSender('sens');await new MessageWorker(f.pool,f.secret,real).runOnce();assert.equal(real.sent.length,0);
  await f.worker.runOnce();assert.equal((await f.job()).status,'SIMULATED');assert.ok((await f.job()).protected_payload);
  await f.pool.query("UPDATE message_jobs SET expires_at=now()-interval '1 second' WHERE pickup_id=$1",[f.id]);
  await expirePickups(f.pool);assert.equal((await f.job()).protected_payload,null);
});
test('a broken recipient ciphertext fails without calling a provider or blocking the cycle',async t=>{
  const f=await fixture(t);
  await f.pool.query("UPDATE pickups SET recipient_phone_ciphertext='invalid' WHERE id=$1",[f.id]);
  await f.worker.runOnce();assert.equal(f.sender.sent.length,0);assert.equal((await f.job()).status,'FAILED');
});
test('arrival shortens expiry without asserting boarding and uses a truthful arrival message',async t=>{
  const f=await fixture(t);await f.update(0,true);await f.worker.runOnce();
  const row=(await f.pool.query('SELECT state,expires_at,latest_observation FROM pickups WHERE id=$1',[f.id])).rows[0];
  assert.equal(row.state,'ARRIVED');assert.ok(row.latest_observation);assert.ok(new Date(row.expires_at).getTime()-Date.now()<=601_000);
  assert.equal(f.sender.sent.length,1);assert.match(f.sender.sent[0].message,/근처에 도착/);assert.doesNotMatch(f.sender.sent[0].message,/1분 뒤/);
});
test('SOLAPI worker sends LMS then a short notice once; local and SENS workers cannot claim its jobs',async t=>{
  const f=await fixture(t,'solapi');
  for(const mode of ['local','sens'] as const) {
    const other=new FakeSender(mode);await new MessageWorker(f.pool,f.secret,other).runOnce();assert.equal(other.sent.length,0);
  }
  await f.worker.runOnce();assert.equal(f.sender.sent.length,1);
  assert.equal(encodedMessage(f.sender.sent[0].message).type,'LMS');
  const current=(await f.app.inject({method:'GET',url:'/pickups/current',headers:f.headers})).json();
  assert.equal(current.pickup.messages[0].provider,'solapi');assert.equal(current.pickup.messages[0].status,'ACCEPTED');
  await f.update(240);await f.worker.runOnce();assert.equal(f.sender.sent.length,2);
  assert.equal(encodedMessage(f.sender.sent[1].message).type,'SMS');
  await f.update(0,true);await f.worker.runOnce();assert.equal(f.sender.sent.length,2);
});
test('an arrival before a queued near notice still fits a single SMS',async t=>{
  const f=await fixture(t,'solapi');await f.worker.runOnce();await f.update(0,true);await f.worker.runOnce();
  assert.equal(f.sender.sent.length,2);assert.match(f.sender.sent[1].message,/근처에 도착/);
  assert.equal(encodedMessage(f.sender.sent[1].message).type,'SMS');
});
test('new pickup dispatch waits for explicit confirmation even with a worker running',async t=>{
 const f=await fixture(t,'solapi',600,false);
 await f.worker.runOnce();await f.update(240);await f.worker.runOnce();
 assert.equal(f.sender.sent.length,0);assert.equal((await f.job()).attempts,0);assert.equal((await f.job('NEAR')).attempts,0);
 const copy=(await f.app.inject({method:'GET',url:`/pickups/${f.id}/share-message`,headers:f.headers})).json();
 await f.worker.runOnce();assert.equal(f.sender.sent.length,0);
 for(let i=0;i<2;i++)assert.equal((await f.app.inject({method:'POST',url:`/pickups/${f.id}/confirm-message`,headers:f.headers,payload:{confirmed:true}})).statusCode,200);
 await f.worker.runOnce();await f.worker.runOnce();
 assert.equal(f.sender.sent.length,1);assert.ok(f.sender.sent[0].message.includes(copy.shareLink));assert.ok(f.sender.sent[0].message.includes(copy.accessCode));
 assert.equal((await f.job('NEAR')).status,'CANCELLED');
});

test('manual resend dispatches the original link/code with fresh ETA and keeps provider receipts separate',async t=>{
 const f=await fixture(t);await f.worker.runOnce();const initial=f.sender.sent[0];
 await f.pool.query("UPDATE pickups SET started_at=now()-interval '2 minutes' WHERE id=$1",[f.id]);await f.update(480);
 const response=await f.app.inject({method:'POST',url:`/pickups/${f.id}/resend-message`,headers:f.headers,payload:{confirmed:true}});assert.equal(response.statusCode,200);
 await f.worker.runOnce();assert.equal(f.sender.sent.length,2);
 assert.equal(f.sender.sent[1].shareLink,initial.shareLink);assert.equal(f.sender.sent[1].message.match(/인증코드: (\d{4})/)![1],initial.message.match(/인증코드: (\d{4})/)![1]);assert.match(f.sender.sent[1].message,/약 8분/);
 assert.equal((await f.job()).provider_id,'request-1');assert.equal((await f.job('RESEND')).provider_id,'request-2');
 assert.equal((await f.app.inject({method:'POST',url:`/pickups/${f.id}/resend-message`,headers:f.headers,payload:{confirmed:true}})).statusCode,409);
});
test('manual resend replaces an unsent initial job, merges the near notice and is erased on end',async t=>{
 const f=await fixture(t);await f.update(240);
 await f.pool.query("UPDATE pickups SET started_at=now()-interval '2 minutes' WHERE id=$1",[f.id]);
 assert.equal((await f.app.inject({method:'POST',url:`/pickups/${f.id}/resend-message`,headers:f.headers,payload:{confirmed:true}})).statusCode,200);
 assert.equal((await f.job()).status,'CANCELLED');await f.worker.runOnce();assert.equal(f.sender.sent.length,1);assert.match(f.sender.sent[0].message,/곧 도착/);
 assert.equal((await f.job('RESEND')).includes_near,true);assert.equal((await f.job('NEAR')).status,'CANCELLED');
 await f.app.inject({method:'POST',url:`/pickups/${f.id}/end`,headers:f.headers});
 assert.equal((await f.pool.query('SELECT count(*)::int n FROM message_jobs WHERE pickup_id=$1 AND protected_payload IS NOT NULL',[f.id])).rows[0].n,0);
});

test('a locked code defers pending SMS until explicit renewal, then uses only the new link/code',async t=>{
 const f=await fixture(t);await f.pool.query('UPDATE share_grants SET failed_attempts=5 WHERE pickup_id=$1',[f.id]);
 assert.equal((await f.app.inject({method:'POST',url:`/pickups/${f.id}/resend-message`,headers:f.headers,payload:{confirmed:true}})).json().code,'SHARE_CODE_LOCKED');
 await f.worker.runOnce();assert.equal(f.sender.sent.length,0);assert.equal((await f.job()).last_error_code,'SHARE_CODE_LOCKED');
 const key=randomUUID(),renewed=await f.app.inject({method:'POST',url:`/pickups/${f.id}/renew-access`,headers:f.headers,payload:{confirmed:true,idempotencyKey:key}});assert.equal(renewed.statusCode,200);
 const link=(await f.app.inject({url:`/pickups/${f.id}/share-message`,headers:f.headers})).json();
 await f.pool.query("UPDATE message_jobs SET available_at=now() WHERE pickup_id=$1",[f.id]);await f.worker.runOnce();assert.equal(f.sender.sent.length,1);assert.ok(f.sender.sent[0].message.includes(link.accessCode));assert.ok(f.sender.sent[0].message.includes(link.shareLink));
});
