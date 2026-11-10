import {test} from 'node:test';import assert from 'node:assert/strict';
import {nearestRoadview,pointDistance,RoadviewUnavailable} from '../../.local/web-roadview-test/RoadviewLookup.js';
test('nearest panorama accepts SDK number and numeric string IDs with bounded lookup radius',async()=>{
 for(const id of [1207237367,'1207237367']){let radius;const result=await nearestRoadview({getNearestPanoId(_p,r,callback){radius=r;callback(id)}},{},new AbortController().signal);assert.equal(result,1207237367);assert.equal(radius,50);}
});
test('missing or malformed panoramas produce map fallback errors',async()=>{
 for(const id of [null,0,-1,'invalid'])await assert.rejects(nearestRoadview({getNearestPanoId(_p,_r,callback){callback(id)}},{},new AbortController().signal),RoadviewUnavailable);
});
test('switching position aborts an older pending lookup and ignores its late callback',async()=>{
 let callback;const controller=new AbortController(),old=nearestRoadview({getNearestPanoId(_p,_r,c){callback=c}},{},controller.signal);controller.abort();await assert.rejects(old,e=>e.name==='AbortError');callback(123);
 assert.equal(await nearestRoadview({getNearestPanoId(_p,_r,c){c(456)}},{},new AbortController().signal),456);
});
test('a never-returning SDK call times out; already aborted calls never query',async()=>{
 await assert.rejects(nearestRoadview({getNearestPanoId(){}},{},new AbortController().signal,10),RoadviewUnavailable);
 const c=new AbortController();c.abort();let called=false;await assert.rejects(nearestRoadview({getNearestPanoId(){called=true}},{},c.signal),e=>e.name==='AbortError');assert.equal(called,false);
});
test('distance rejects far panorama positions without interpreting them as the recipient spot',()=>{
 assert.equal(pointDistance({latitude:37.4,longitude:127.1},{latitude:37.4,longitude:127.1}),0);
 const nearby=pointDistance({latitude:37.4,longitude:127.1},{latitude:37.4001,longitude:127.1});assert.ok(nearby>10&&nearby<12);
 assert.ok(pointDistance({latitude:37.4,longitude:127.1},{latitude:37.5,longitude:127.1})>10000);
});
