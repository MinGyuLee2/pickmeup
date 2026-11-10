import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from './app.js';
import {migrate} from './db.js';
import {hash} from './domain.js';
const schema='guest_test_'+randomUUID().replaceAll('-','');
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
const secret=randomBytes(32).toString('base64'),origin='http://localhost:5173';
const app=buildApp(pool,{secret,publicOrigin:origin,smsMode:'local',production:false});
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await app.ready()});
after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()});
let n=0;
async function guest(remoteAddress='127.0.1.'+(++n)) {
 const key=randomBytes(32).toString('hex');
 const r=await app.inject({method:'POST',url:'/vehicles/guest',remoteAddress,payload:{installationKey:key}});
 assert.equal(r.statusCode,200,r.body);const car=r.json();return {...car,key,headers:{authorization:'Bearer '+car.deviceToken}};
}
const place={name:'판교역',latitude:37.3948,longitude:127.1112};
async function person(car:any) {
 const r=await app.inject({method:'POST',url:'/vehicle/contacts/import',headers:car.headers,payload:{name:'지연이',phone:'01099999999'}});assert.equal(r.statusCode,200,r.body);return r.json();
}
async function start(car:any,contactId:string) {
 const r=await app.inject({method:'POST',url:'/pickups',headers:car.headers,payload:{idempotencyKey:randomUUID(),contactId,destination:place,observation:{location:{latitude:37.4,longitude:127.1},remainingSeconds:500,remainingMeters:1000,locationAgeMs:0,etaAgeMs:0}}});assert.equal(r.statusCode,201,r.body);return r.json().pickup;
}
async function setup(car:any,phone='0108000'+String(++n).padStart(4,'0')) {
 const r=await app.inject({method:'POST',url:'/onboarding/start',headers:car?.headers??{},remoteAddress:'127.0.2.'+n,payload:{phone}});assert.equal(r.statusCode,200,r.body);return {phone,...r.json()};
}
async function verify(s:any) {
 const r=await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token:new URL(s.claimUrl).hash.slice(7),code:s.developmentCode}});assert.equal(r.statusCode,200,r.body);return String(r.headers['set-cookie']).split(';')[0];
}
async function finish(cookie:string,name='운전자') {return app.inject({method:'POST',url:'/onboarding/complete',headers:{origin,cookie},payload:{name}})}

test('guest start requires no phone or OTP, concurrent retry recovers same token and stays isolated',async()=>{
 const key=randomBytes(32).toString('hex');const before=(await pool.query('SELECT count(*)::int n FROM message_jobs')).rows[0].n;
 const rs=await Promise.all([1,2,3].map(()=>app.inject({method:'POST',url:'/vehicles/guest',payload:{installationKey:key}})));
 rs.forEach(r=>assert.equal(r.statusCode,200,r.body));assert.deepEqual(rs[0].json(),rs[1].json());assert.deepEqual(rs[0].json(),rs[2].json());
 const car={...rs[0].json(),headers:{authorization:'Bearer '+rs[0].json().deviceToken}};
 assert.equal(car.accountLinked,false);assert.equal((await pool.query('SELECT count(*)::int n FROM message_jobs')).rows[0].n,before);
 const owner=(await pool.query('SELECT d.* FROM drivers d JOIN vehicles v ON v.driver_id=d.id WHERE v.id=$1',[car.vehicleId])).rows[0];assert.equal(owner.phone,null);assert.equal(owner.is_guest,true);
 const c=await person(car);const other=await guest();assert.deepEqual((await app.inject({url:'/vehicle/contacts',headers:other.headers})).json(),[]);
 const p=await start(car,c.id);assert.equal(p.smsConfirmed,false);
 assert.equal((await app.inject({url:`/pickups/${p.id}/share-message`,headers:other.headers})).statusCode,404);
 assert.equal((await app.inject({url:'/vehicle/profile',headers:car.headers})).json().accountLinked,false);
 assert.equal((await app.inject({url:'/vehicle/profile'})).statusCode,401);
});

test('existing account link keeps vehicle/token/contact IDs/places/history and all other account vehicles',async()=>{
 const regular=await setup(null),cookie=await verify(regular),complete=await finish(cookie,'기존 이름');assert.equal(complete.statusCode,200,complete.body);
 const existingId=complete.json().vehicleId;const existing=(await pool.query('SELECT * FROM vehicles WHERE id=$1',[existingId])).rows[0];
 const car=await guest(),c=await person(car);
 await app.inject({method:'PUT',url:`/vehicle/contacts/${c.id}/place`,headers:car.headers,payload:{destination:place}});
 const p=await start(car,c.id);await app.inject({method:'POST',url:`/pickups/${p.id}/end`,headers:car.headers});
 await pool.query("UPDATE login_challenges SET created_at=now()-interval '2 minutes' WHERE phone=$1",[regular.phone]);
 await pool.query("UPDATE vehicles SET model_name='아이오닉 5',license_plate='123가 4567',model_key='ioniq5' WHERE id=$1",[car.vehicleId]);
 const s=await setup(car,regular.phone);const sc=await verify(s);
 const fields=(await app.inject({url:'/onboarding/current',headers:{cookie:sc}})).json();assert.equal(fields.accountLink,true);assert.equal(fields.modelName,'아이오닉 5');assert.equal(fields.licensePlate,'123가 4567');const r=await finish(sc,'기존 이름');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().vehicleId,car.vehicleId);
 assert.equal((await app.inject({url:'/vehicle/profile',headers:car.headers})).json().accountLinked,true);
 const still=(await pool.query('SELECT * FROM vehicles WHERE id=$1',[existingId])).rows[0];assert.deepEqual(still,existing);
 const now=(await pool.query('SELECT driver_id,token_hash FROM vehicles WHERE id=$1',[car.vehicleId])).rows[0];assert.equal(now.driver_id,existing.driver_id);assert.equal(now.token_hash,hash(car.deviceToken));
 assert.equal((await pool.query('SELECT license_plate FROM vehicles WHERE id=$1',[car.vehicleId])).rows[0].license_plate,'123가 4567');
 const contacts=(await app.inject({url:'/vehicle/contacts',headers:car.headers})).json();assert.equal(contacts[0].id,c.id);assert.deepEqual(contacts[0].meetingPlace,place);
 assert.equal((await pool.query('SELECT driver_id,contact_id FROM pickups WHERE id=$1',[p.id])).rows[0].driver_id,existing.driver_id);
 const status=(await app.inject({url:`/pairings/${s.id}`,headers:{authorization:'Pairing '+s.deviceSecret}})).json();assert.equal(status.vehicleId,car.vehicleId);assert.equal(status.deviceToken,car.deviceToken);
 const again=await app.inject({method:'POST',url:'/vehicles/guest',payload:{installationKey:car.key}});assert.equal(again.json().deviceToken,car.deviceToken);assert.equal(again.json().accountLinked,true);
 const repeat=await finish(sc,'기존 이름');assert.equal(repeat.json().vehicleId,car.vehicleId);
 assert.equal((await app.inject({method:'POST',url:'/onboarding/start',headers:car.headers,payload:{phone:'01066665555'}})).statusCode,409);
});

test('account link never takes a caller-supplied vehicle, and active pickup blocks start and completion',async()=>{
 const car=await guest(),other=await guest();const s=await setup(car);const c=await person(car),p=await start(car,c.id);
 const blocked=await app.inject({method:'POST',url:'/onboarding/start',headers:car.headers,payload:{phone:'01066664444',vehicleId:other.vehicleId}});assert.equal(blocked.statusCode,409);
 const cookie=await verify(s),done=await finish(cookie);assert.equal(done.statusCode,409);
 assert.equal((await app.inject({url:'/vehicle/profile',headers:other.headers})).json().accountLinked,false);
 await app.inject({method:'POST',url:`/pickups/${p.id}/end`,headers:car.headers});assert.equal((await finish(cookie)).statusCode,200);
 assert.equal((await app.inject({url:'/vehicle/profile',headers:other.headers})).json().accountLinked,false);
});

test('guest registration limits new identities per IP but not recovery, and rejects invalid keys/origins',async()=>{
 assert.equal((await app.inject({method:'POST',url:'/vehicles/guest',payload:{installationKey:'short'}})).statusCode,400);
 const car=await guest('127.1.1.1');for(let i=0;i<9;i++)await guest('127.1.1.1');
 assert.equal((await app.inject({method:'POST',url:'/vehicles/guest',remoteAddress:'127.1.1.1',payload:{installationKey:randomBytes(32).toString('hex')}})).statusCode,429);
 assert.equal((await app.inject({method:'POST',url:'/vehicles/guest',remoteAddress:'127.1.1.1',payload:{installationKey:car.key}})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:'/vehicles/guest',headers:{origin:'https://evil.example'},payload:{installationKey:randomBytes(32).toString('hex')}})).statusCode,403);
 const sens=buildApp(pool,{secret,publicOrigin:origin,smsMode:'sens',production:false});await sens.ready();
 assert.equal((await sens.inject({url:'/vehicle/profile',headers:car.headers})).statusCode,401);await sens.close();
});

test('abandoning legacy setup revokes its OTP/link, completed account cannot be cancelled',async()=>{
 const s=await setup(null),bad=await app.inject({method:'DELETE',url:`/onboarding/${s.id}`,headers:{authorization:'Pairing wrong'}});assert.equal(bad.statusCode,410);
 assert.equal((await app.inject({method:'DELETE',url:`/onboarding/${s.id}`,headers:{authorization:'Pairing '+s.deviceSecret}})).statusCode,200);
 assert.equal((await app.inject({method:'POST',url:'/onboarding/verify',headers:{origin},payload:{token:new URL(s.claimUrl).hash.slice(7),code:s.developmentCode}})).statusCode,400);
 const c=await setup(null),cookie=await verify(c);assert.equal((await finish(cookie)).statusCode,200);
 assert.equal((await app.inject({method:'DELETE',url:`/onboarding/${c.id}`,headers:{authorization:'Pairing '+c.deviceSecret}})).statusCode,410);
});

test('guest SMS retains confirmation and caps new approvals without blocking direct link sharing',async()=>{
 const car=await guest(),c=await person(car);
 for(let i=0;i<20;i++){
  const p=await start(car,c.id);const r=await app.inject({method:'POST',url:`/pickups/${p.id}/confirm-message`,headers:car.headers,payload:{confirmed:true}});assert.equal(r.statusCode,200,r.body);
  await app.inject({method:'POST',url:`/pickups/${p.id}/end`,headers:car.headers});
 }
 const p=await start(car,c.id);
 assert.equal((await app.inject({method:'POST',url:`/pickups/${p.id}/confirm-message`,headers:car.headers,payload:{confirmed:false}})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:`/pickups/${p.id}/confirm-message`,headers:car.headers,payload:{confirmed:true}})).statusCode,429);
 assert.equal((await app.inject({url:`/pickups/${p.id}/share-message`,headers:car.headers})).statusCode,200);
 assert.equal((await pool.query('SELECT sms_confirmed FROM pickups WHERE id=$1',[p.id])).rows[0].sms_confirmed,false);
});
