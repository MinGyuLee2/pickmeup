import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';

// Runs only against the filming runtime. No DB credentials or production vehicle tokens are used.
const runtime=JSON.parse(await readFile('.local/filming-demo/runtime.json','utf8'));
assert.equal(runtime.schema,'pickmeup_filming_v1');
const health=await(await fetch('http://127.0.0.1:5187/health')).json();
assert(health.filming&&health.schemaIsolated&&health.externalSms===false);
const route=JSON.parse(await readFile('android/app/src/filming/assets/filming-route.json','utf8'));
let key;try{key=await readFile('.local/filming-demo/smoke-installation','utf8');}catch{key=randomBytes(32).toString('hex');await writeFile('.local/filming-demo/smoke-installation',key,{mode:0o600});}
let headers={};
async function api(path,method='GET',body){
    const r=await fetch('http://127.0.0.1:4311'+path,{method,headers:{...headers,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const value=await r.json();assert(r.ok,JSON.stringify(value));return value;
}
const denied=await fetch('http://127.0.0.1:5187/command',{method:'POST',headers:{origin:'https://example.com','content-type':'application/json'},body:'{"command":"reset"}'});
assert.equal(denied.status,403);
const car=await api('/vehicles/guest','POST',{installationKey:key});headers={authorization:'Bearer '+car.deviceToken};
const people=await api('/vehicle/contacts'),person=people.find(p=>p.name==='지연이');assert(person&&person.aliases.includes('지연'));
const current=await api('/pickups/current');assert(!current.pickup,'An earlier smoke pickup is still active; refusing to interfere');
const first=route.path[0],last=route.path.at(-1);
const created=await api('/pickups','POST',{contactId:person.id,idempotencyKey:randomUUID(),destination:{name:route.name,latitude:last[1],longitude:last[0]},observation:{location:{latitude:first[1],longitude:first[0]},remainingSeconds:720,remainingMeters:1775,locationAgeMs:0,etaAgeMs:0}});
const id=created.pickup.id;
try{
    const message=await api('/pickups/'+id+'/share-message');assert.equal(new URL(message.shareLink).pathname,'/filming/s');assert(message.message.includes('/filming/s#token='));
    const page=await fetch(message.shareLink.split('#')[0]);assert.equal(page.status,200);assert((await page.text()).includes('/filming/assets/'));
    const redeem=await fetch('http://127.0.0.1:4311/shares/redeem',{method:'POST',headers:{origin:runtime.origin,'content-type':'application/json'},body:JSON.stringify({token:new URL(message.shareLink).hash.slice(7),code:message.accessCode})});assert.equal(redeem.status,200);
    assert.equal((await fetch('http://127.0.0.1:4310/health')).status,200);
    console.log('PASS: filming scope, existing recipient aliases, scoped link/message/bundle, recipient code gate, control authorization, and normal API availability. No SMS transport.');
}finally{await api('/pickups/'+id+'/end','POST',{reason:'DRIVER_ENDED'});}
