import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {api,ApiError,recipientPath,takeFragmentToken} from '../../.local/web-api-test/api.js';
const saved=globalThis.fetch;after(()=>{globalThis.fetch=saved});
test('requests include pickup scope and preserve timeout/network errors as retryable, never replay mutations',async()=>{
 const id='11111111-1111-4111-8111-111111111111';assert.equal(recipientPath('/shared-pickup/location',id),'/shared-pickup/location?pickupId='+id);
 assert.throws(()=>recipientPath('/shared-pickup',''),ApiError);
 let calls=0;globalThis.fetch=async(_url,{signal})=>{calls++;return new Promise((_ok,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));};
 await assert.rejects(api('/shares/redeem','POST',{code:'1234'},{timeoutMs:10}),e=>e.code==='REQUEST_TIMEOUT');assert.equal(calls,1);
 globalThis.fetch=async()=>{throw new TypeError('network')};await assert.rejects(api('/shared-pickup'),e=>e.code==='NETWORK_ERROR');
});
test('caller abort, structured API errors and invalid proxy responses are handled safely',async()=>{
 globalThis.fetch=async(_u,{signal})=>{if(signal.aborted)throw new DOMException('aborted','AbortError');};const c=new AbortController();c.abort();
 await assert.rejects(api('/shared-pickup','GET',undefined,{signal:c.signal}),e=>e.name==='AbortError');
 globalThis.fetch=async()=>new Response(JSON.stringify({code:'SHARE_CODE_LOCKED',message:'인증이 잠겼어요'}),{status:429});
 await assert.rejects(api('/shares/redeem','POST',{code:'0000'}),e=>e.status===429&&e.code==='SHARE_CODE_LOCKED');
 globalThis.fetch=async()=>new Response('<html>proxy error</html>',{status:502});await assert.rejects(api('/shared-pickup'),e=>e.status===502&&!e.message.includes('html'));
});
test('fragment removal retains a reloadable scoped route but discards stale scope for a newly received link',()=>{
 let replaced;globalThis.history={replaceState(_a,_b,path){replaced=path}};globalThis.window={location:{hash:'#token=secret',pathname:'/s',search:'?pickupId=old'}};
 assert.equal(takeFragmentToken(),'secret');assert.equal(replaced,'/s');window.location.hash='#other';window.location.search='?pickupId=known';assert.equal(takeFragmentToken(),null);assert.equal(replaced,'/s?pickupId=known');delete globalThis.window;delete globalThis.history;
});
