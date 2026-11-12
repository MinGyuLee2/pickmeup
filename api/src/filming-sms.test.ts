import {test,after,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildFilmingSmsRelay,FilmingSmsLedger,FilmingSmsSender,filmingSmsHeaders} from './filming-sms.js';
import type {SmsSender,SmsPayload,SendResult} from './sms.js';

const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});after(()=>admin.end());
const secret='filming-test-secret',origin='https://dev.example.test';
const sample:SmsPayload={phone:'01000000000',shareLink:origin+'/filming/s#token=test',message:'[픽미업] 약 12분 뒤 도착 예정입니다.\n'+origin+'/filming/s#token=test\n인증코드: 7342'};
async function fixture(t:TestContext){
  const schema='filming_sms_test_'+randomUUID().replaceAll('-','');await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
  const ledger=new FilmingSmsLedger(pool,secret);await ledger.initialize();
  const calls:SmsPayload[]=[];let result:SendResult={kind:'accepted',requestId:'provider-1'},during:(()=>Promise<void>)|undefined;
  const sender:SmsSender={mode:'solapi',send:async p=>{calls.push(p);await during?.();return result;},lookup:async requestId=>({state:'DELIVERED',messageId:requestId})};
  const app=buildFilmingSmsRelay(ledger,sender,secret,origin);await app.ready();
  t.after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);});
  const transport:typeof fetch=async(_url,init)=>{
    const r=await app.inject({method:'POST',url:'/',headers:init?.headers as Record<string,string>,payload:init?.body as string});
    return new Response(r.body,{status:r.statusCode,headers:{'content-type':'application/json'}});
  };
  const client=new FilmingSmsSender('https://relay.example.test/internal/filming-sms',secret,transport);
  return {pool,app,ledger,calls,client,setResult:(r:SendResult)=>{result=r;},during:(f:()=>Promise<void>)=>{during=f;}};
}
test('authenticated development dispatch reports real acceptance/receipt and deduplicates across client restarts',async t=>{
  const f=await fixture(t),id=randomUUID();assert(await f.client.health());assert.equal(f.calls.length,0);
  const first=await f.client.send(sample,id);assert.deepEqual(first,{kind:'accepted',requestId:'provider-1'});
  assert.deepEqual(await f.client.send(sample,id),first);assert.equal(f.calls.length,1);
  assert.equal((await f.client.lookup('provider-1')).state,'DELIVERED');
  const persisted=new FilmingSmsLedger(f.pool,secret);assert.deepEqual(await persisted.send(id,sample,{mode:'solapi',send:async()=>{throw Error('must not send');},lookup:async()=>({state:'UNKNOWN'})}),first);
  const row=(await f.pool.query('SELECT * FROM dispatches')).rows[0];assert.equal(row.payload_hash.length,64);assert(!JSON.stringify(row).includes(sample.phone));assert(!JSON.stringify(row).includes('token=test'));
});
test('missing, modified and expired signatures cannot dispatch; lookup is limited to relay messages',async t=>{
  const f=await fixture(t),body=JSON.stringify({operation:'send',dispatchId:randomUUID(),payload:sample});
  for(const headers of [{'content-type':'application/json'},filmingSmsHeaders('wrong',body),filmingSmsHeaders(secret,body,Date.now()-31_000),filmingSmsHeaders(secret,body+' ')]){
    assert.equal((await f.app.inject({method:'POST',url:'/',payload:body,headers})).statusCode,401);
  }
  const lookup=JSON.stringify({operation:'lookup',requestId:'unrelated-production-message'});
  assert.equal((await f.app.inject({method:'POST',url:'/',payload:lookup,headers:filmingSmsHeaders(secret,lookup)})).statusCode,404);assert.equal(f.calls.length,0);
});
test('only reviewed development links and dispatch IDs can be sent',async t=>{
  const f=await fixture(t);
  for(const change of [{shareLink:'https://other.example/filming/s'},{message:'[픽미업] https://other.example/filming/s'},{shareLink:origin+'/s'},{phone:'000'},{message:'arbitrary message'}]){
    assert.equal((await f.client.send({...sample,...change},randomUUID())).kind,'unknown');
  }
  assert.equal((await f.client.send(sample)).kind,'rejected');assert.equal(f.calls.length,0);
});
test('competing requests and changed payloads cannot replay a dispatch ID',async t=>{
  const f=await fixture(t),id=randomUUID();let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);f.during(async()=>{entered();await held;});
  const first=f.client.send(sample,id);await started;
  assert.deepEqual(await f.client.send(sample,id),{kind:'unknown',code:'RELAY_DISPATCH_IN_PROGRESS'});
  assert.deepEqual(await f.client.send({...sample,phone:'01000001111'},id),{kind:'rejected',code:'DISPATCH_ID_CONFLICT',retryable:false});
  release();assert.equal((await first).kind,'accepted');assert.equal(f.calls.length,1);
});
test('uncertain provider outcomes stay uncertain and are never automatically replayed',async t=>{
  const f=await fixture(t),id=randomUUID();f.setResult({kind:'unknown',code:'NETWORK_UNCERTAIN'});
  assert.equal((await f.client.send(sample,id)).kind,'unknown');f.setResult({kind:'accepted',requestId:'should-not-send'});
  assert.equal((await f.client.send(sample,id)).kind,'unknown');assert.equal(f.calls.length,1);
});
test('only definite retryable rejections can be retried, with a hard attempt cap',async t=>{
  const f=await fixture(t),id=randomUUID();f.setResult({kind:'rejected',code:'PROVIDER_RATE_LIMIT',retryable:true});
  for(let i=0;i<5;i++)await f.client.send(sample,id);assert.equal(f.calls.length,3);
});
test('a definite rejection can retry with the refreshed ETA instead of a stale payload',async t=>{
  const f=await fixture(t),id=randomUUID();f.setResult({kind:'rejected',code:'PROVIDER_RATE_LIMIT',retryable:true});
  await f.client.send(sample,id);f.setResult({kind:'accepted',requestId:'provider-refreshed'});
  assert.equal((await f.client.send({...sample,message:sample.message.replace('12분','10분')},id)).kind,'accepted');
  assert.equal(f.calls.length,2);assert(f.calls[1].message.includes('10분'));
});
test('a retryable rejection cannot change the recipient or share link under the same dispatch ID',async t=>{
  const f=await fixture(t),id=randomUUID();f.setResult({kind:'rejected',code:'PROVIDER_RATE_LIMIT',retryable:true});
  await f.client.send(sample,id);
  for(const change of [{phone:'01000001111'},{shareLink:origin+'/filming/s#token=another'},{message:sample.message.replace('token=test','token=another')}]){
    assert.deepEqual(await f.client.send({...sample,...change},id),{kind:'rejected',code:'DISPATCH_ID_CONFLICT',retryable:false});
  }
  assert.equal(f.calls.length,1);
  assert.equal((await f.pool.query('SELECT attempts FROM dispatches WHERE id=$1',[id])).rows[0].attempts,1);
});
test('legacy dispatches preserve their outcome and reject payload changes without reconstructing private data',async t=>{
  const f=await fixture(t),id=randomUUID();f.setResult({kind:'rejected',code:'PROVIDER_RATE_LIMIT',retryable:true});
  await f.client.send(sample,id);
  await f.pool.query('UPDATE dispatches SET identity_hash=NULL WHERE id=$1',[id]);
  assert.deepEqual(await f.client.send({...sample,message:sample.message.replace('12분','10분')},id),{kind:'rejected',code:'DISPATCH_ID_CONFLICT',retryable:false});
  assert.equal(f.calls.length,1);
  assert.equal((await f.client.send(sample,id)).kind,'rejected');assert.equal(f.calls.length,2);
});
test('the relay has a bounded hourly quota without altering production workers',async t=>{
  const f=await fixture(t);await f.pool.query('INSERT INTO dispatches(id,payload_hash,result,attempts) VALUES($1,$2,$3,20)',[randomUUID(),'old',{kind:'unknown',code:'OLD'}]);
  assert.deepEqual(await f.client.send(sample,randomUUID()),{kind:'rejected',code:'FILMING_HOURLY_LIMIT',retryable:false});assert.equal(f.calls.length,0);
});
