import {test} from 'node:test';import assert from 'node:assert/strict';
import {RecipientLocationSession,LOCATION_CONSENT_VERSION} from '../../.local/web-location-test/RecipientLocationSession.js';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(transport){let visible=true,now=10_000,success,error,cleared=0,watches=0;const states=[],calls=[];
 const geo={watchPosition(a,b){watches++;success=a;error=b;return 1;},clearWatch(){cleared++;},getCurrentPosition(){}};
 const request=transport??(async(method,body)=>{calls.push({method,body});return method==='POST'?{lease:'secret',sessionId:'one'}:{};});
 const c=new RecipientLocationSession(geo,()=>visible,true,s=>states.push(s),request,()=>now,()=>100_000+now);
 return {c,states,calls,geo,emit:()=>success({coords:{latitude:37.4,longitude:127.1,accuracy:12},timestamp:100_000+now}),deny:()=>error({code:1}),hide(){visible=false;c.pause();},show(){visible=true;now+=10_000;c.resume();},advance(){now+=10_000;},get cleared(){return cleared;},get watches(){return watches;}};
}
test('no collection or server start until explicit action; permission denial writes no location',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);f.c.start(true);f.deny();await tick();assert.equal(f.calls.length,0);assert.equal(f.states.at(-1).phase,'ERROR');assert.ok(f.cleared);f.c.dispose();
});
test('visible opt-in sends a sample, hidden callback is ignored and resume needs a fresh sample',async()=>{
 const f=fixture();f.c.start(true);f.emit();await tick();assert.deepEqual(f.calls.map(c=>c.method),['POST','PUT']);f.hide();f.emit();await tick();assert.equal(f.calls.at(-1).body.paused,true);const n=f.calls.length;f.show();await tick();assert.equal(f.calls.length,n);f.emit();await tick();assert.equal(f.calls.at(-2).body.paused,false);assert.ok(f.calls.at(-1).body.location);f.c.dispose();
});
test('stop deletes once and late GPS callbacks cannot upload again',async()=>{
 const f=fixture();f.c.start(true);f.emit();await tick();await f.c.stop();const n=f.calls.length;f.emit();await tick();assert.equal(f.calls.length,n);assert.equal(f.calls.at(-1).method,'DELETE');assert.equal(f.states.at(-1).phase,'OFF');f.c.dispose();
});
test('a start response after cancellation is deleted without sending coordinates',async()=>{
 let resolve;const calls=[];const f=fixture(async(method,body)=>{calls.push({method,body});if(method==='POST')return new Promise(r=>resolve=r);return {};});f.c.start(true);f.emit();await tick();await f.c.stop();resolve({lease:'late',sessionId:'late'});await tick();assert.deepEqual(calls.map(c=>c.method),['POST','DELETE']);f.c.dispose();
});
test('failed stop retains a revocation retry and never claims success',async()=>{
 let fail=true;const f=fixture(async(method)=>{if(method==='POST')return {lease:'x',sessionId:'x'};if(method==='DELETE'&&fail)throw Error('offline');return {};});f.c.start(true);f.emit();await tick();await f.c.stop();assert.equal(f.states.at(-1).phase,'ERROR');assert.equal(f.states.at(-1).hasLease,true);fail=false;await f.c.stop();assert.equal(f.states.at(-1).phase,'OFF');f.c.dispose();
});
test('network failure retries are throttled rather than a hot loop',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('offline');});f.c.start(true);f.emit();await tick();await tick();assert.equal(calls,1);f.c.dispose();
});

test('consent is required before GPS collection and each new sharing request',async()=>{
 const f=fixture();f.c.start();f.c.start(false);f.c.resume();await tick();assert.equal(f.watches,0);assert.equal(f.calls.length,0);
 f.c.start(true);assert.equal(f.watches,1);f.emit();await tick();assert.deepEqual(f.calls[0],{method:'POST',body:{consent:true,consentVersion:LOCATION_CONSENT_VERSION}});
 await f.c.stop();f.c.start(false);assert.equal(f.watches,1);f.c.dispose();
});
