// Disposable localhost deployment verification. Fixtures do not prove phone authentication or SDK input.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
const project='pickmeup-smoke';
const inspect=name=>JSON.parse(execFileSync('docker',['inspect',`${project}-${name}-1`],{encoding:'utf8'}))[0];
assert.equal(inspect('worker').State.Running,false,'Stop the smoke worker before queuing fixtures');
const apiContainer=inspect('api');
assert.equal(apiContainer.Config.Labels['com.docker.compose.project'],project);
const networks=Object.values(apiContainer.NetworkSettings.Networks);
assert.equal(networks.length,1);
assert.equal(JSON.parse(execFileSync('docker',['network','inspect',networks[0].NetworkID],{encoding:'utf8'}))[0].Internal,true);
const ca=readFileSync(new URL('../.local/deploy-smoke/root.crt',import.meta.url));
const origin='https://localhost:18443';
function request(path,method='GET',body,headers={}) {
  return new Promise((resolve,reject)=>{
    const req=https.request(origin+path,{ca,method,headers:{origin,...headers,...(body===undefined?{}:{'content-type':'application/json'})}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json:()=>JSON.parse(text)}));
    });req.setTimeout(5000,()=>req.destroy(new Error('HTTP timeout')));req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
function sqlFixture(code,args={}) {
  const setup=`import pg from 'pg';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {hash,token,secrets} from './api/dist/domain.js';
const password=(await readFile('/run/secrets/db_password','utf8')).trim();const url=new URL('postgresql://db:5432/pickmeup');url.username='pickmeup';url.password=password;
const pool=new pg.Pool({connectionString:url.href});const security=secrets((await readFile('/run/secrets/app_secret','utf8')).trim());const args=${JSON.stringify(args)};
try {${code}} finally {await pool.end();}`;
  return JSON.parse(execFileSync('docker',['exec','-i',apiContainer.Name.slice(1),'node','--input-type=module'],{input:setup,encoding:'utf8'}));
}
const health=await request('/api/health');assert.equal(health.status,200);assert.equal(health.json().sms,'sens');
assert.equal((await request('/api/unknown-route')).status,404);
assert.match((await request('/s')).text,/<div id="root">/);
assert.equal((await request('/api/dev/messages')).status,404);
const fixture=sqlFixture(`const id=randomUUID(),session=token();await pool.query("INSERT INTO drivers(id,phone,name,auth_mode) VALUES($1,$2,'배포 시험 운전자','sens')",[id,'smoke-'+id]);await pool.query("INSERT INTO web_sessions(token_hash,driver_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')",[hash(session),id]);console.log(JSON.stringify({cookie:'pmu_driver='+session,id}));`);
const driver={cookie:fixture.cookie};
const contact=await request('/api/contacts','POST',{name:'시험 상대',phone:'01000000001',aliases:['시험 상대']},driver);assert.equal(contact.status,201);
const pairing=(await request('/api/pairings','POST')).json();
const claimToken=new URL(pairing.claimUrl).hash.slice('#token='.length);
assert.equal((await request('/api/pairings/claim','POST',{token:claimToken},driver)).status,200);
const paired=(await request(`/api/pairings/${pairing.id}`,'GET',undefined,{authorization:`Pairing ${pairing.deviceSecret}`})).json();
const device={authorization:`Bearer ${paired.deviceToken}`};
const destination={name:'배포 시험 정문',latitude:37.4,longitude:127.1};
const sample={location:{latitude:37.41,longitude:127.09},remainingSeconds:720,remainingMeters:2300,locationAgeMs:0,etaAgeMs:0};
const created=await request('/api/pickups','POST',{contactId:contact.json().id,idempotencyKey:randomUUID(),destination,observation:sample},device);assert.equal(created.status,201);
const id=created.json().pickup.id;
const shared=sqlFixture(`const row=(await pool.query('SELECT recipient_link_ciphertext FROM pickups WHERE id=$1',[args.id])).rows[0];console.log(JSON.stringify({link:security.open(row.recipient_link_ciphertext)}));`,{id});
assert.equal(new URL(shared.link).origin,origin);
const redeemed=await request('/api/shares/redeem','POST',{token:new URL(shared.link).hash.slice('#token='.length)});assert.equal(redeemed.status,200);
const cookie=redeemed.headers['set-cookie'][0];assert.match(cookie,/; Secure/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
const recipient={cookie:cookie.split(';')[0]};
let buffered='',response,stream;
const received=[];
await new Promise((resolve,reject)=>{
  stream=https.get(origin+'/api/shared-pickup/events',{ca,headers:recipient},res=>{
    response=res;assert.equal(res.statusCode,200);res.setEncoding('utf8');res.on('data',chunk=>{
      buffered+=chunk;let end;
      while((end=buffered.indexOf('\n\n'))>=0){const frame=buffered.slice(0,end);buffered=buffered.slice(end+2);received.push(frame);}
      if(received.some(frame=>frame.includes('event: pickup')))resolve();
    });res.on('error',reject);
  });stream.on('error',reject);
  stream.setTimeout(6000,()=>stream.destroy(new Error('Initial SSE flush timeout')));
});
const until=async test=>{const end=Date.now()+6000;while(!test()){assert.ok(Date.now()<end,'SSE update timeout');await new Promise(r=>setTimeout(r,50));}};
assert.equal((await request('/api/shared-pickup/readiness','PUT',{readiness:'OUTSIDE'},recipient)).status,200);
await until(()=>received.some(frame=>frame.includes('"readiness":"OUTSIDE"')));
assert.equal((await request(`/api/pickups/${id}/end`,'POST',{},device)).status,200);
await until(()=>received.some(frame=>frame.includes('event: ended')));
response.destroy();stream.destroy();
assert.equal((await request('/api/shared-pickup','GET',undefined,recipient)).status,410);
const final=sqlFixture(`const row=(await pool.query('SELECT latest_observation,recipient_phone_ciphertext,recipient_link_ciphertext,state FROM pickups WHERE id=$1',[args.id])).rows[0];const jobs=(await pool.query('SELECT status FROM message_jobs WHERE pickup_id=$1',[args.id])).rows;console.log(JSON.stringify({row,jobs}));`,{id});
assert.equal(final.row.state,'ENDED');assert.equal(final.row.latest_observation,null);assert.equal(final.row.recipient_phone_ciphertext,null);assert.equal(final.row.recipient_link_ciphertext,null);assert.ok(final.jobs.every(j=>j.status==='CANCELLED'));
console.log('PASS: trusted local TLS, SPA/API routing, production preview isolation, pairing, synthetic pickup, Secure cookie, proxied SSE readiness/end, revoked access and location erasure. No SMS sent.');
