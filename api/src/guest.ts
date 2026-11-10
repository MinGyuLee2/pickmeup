import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {transaction} from './db.js';
import {hash,object,Problem,secrets,token} from './domain.js';
import type {Config} from './app.js';
export type VehicleAuth=(request:FastifyRequest)=>Promise<Record<string,any>>;

export function guests(app:FastifyInstance,pool:pg.Pool,config:Config,vehicle:VehicleAuth) {
  const security=secrets(config.secret);
  app.post('/vehicles/guest',async request=>{
    const key=object(request.body).installationKey;
    if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw new Problem(400,'INSTALLATION_REQUIRED','다시 시작해 주세요.');
    if(config.smsMode==='disabled')throw new Problem(503,'SERVER_NOT_READY','서버를 준비 중입니다.');
    const keyHash=hash(key),ipHash=security.digest(request.ip);
    return transaction(pool,async db=>{
      // A locally persisted secret recovers a lost response without creating another vehicle.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`guest:${config.smsMode}:${keyHash}`]);
      const saved=(await db.query(`SELECT g.*,d.is_guest FROM guest_installations g JOIN vehicles v ON v.id=g.vehicle_id
        JOIN drivers d ON d.id=v.driver_id WHERE g.secret_hash=$1 AND g.auth_mode=$2`,[keyHash,config.smsMode])).rows[0];
      if(saved)return {vehicleId:saved.vehicle_id,deviceToken:security.open<string>(saved.encrypted_device_token),accountLinked:!saved.is_guest};
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`guest-ip:${ipHash}`]);
      const count=(await db.query("SELECT count(*)::int AS n FROM guest_installations WHERE ip_hash=$1 AND created_at>now()-interval '1 hour'",[ipHash])).rows[0].n;
      if(count>=10)throw new Problem(429,'GUEST_RATE_LIMIT','잠시 후 다시 시작해 주세요.');
      const owner=randomUUID(),vehicleId=randomUUID(),deviceToken=token();
      await db.query("INSERT INTO drivers(id,phone,name,auth_mode,is_guest) VALUES($1,NULL,'운전자',$2,true)",[owner,config.smsMode]);
      await db.query('INSERT INTO vehicles(id,driver_id,token_hash) VALUES($1,$2,$3)',[vehicleId,owner,hash(deviceToken)]);
      await db.query('INSERT INTO guest_installations(secret_hash,auth_mode,vehicle_id,encrypted_device_token,ip_hash) VALUES($1,$2,$3,$4,$5)',[keyHash,config.smsMode,vehicleId,security.seal(deviceToken),ipHash]);
      return {vehicleId,deviceToken,accountLinked:false};
    });
  });
  app.get('/vehicle/profile',async request=>{
    const car=await vehicle(request);
    const owner=(await pool.query('SELECT name,is_guest FROM drivers WHERE id=$1',[car.driver_id])).rows[0];
    return {vehicleId:car.id,accountLinked:!owner.is_guest,name:owner.name};
  });
}

/** Anonymous use keeps explicit message approval and bounds public-provider costs per origin. */
export async function guestMessageQuota(db:pg.PoolClient,driverId:string) {
  const row=(await db.query(`SELECT g.ip_hash FROM guest_installations g JOIN vehicles v ON v.id=g.vehicle_id
    JOIN drivers d ON d.id=v.driver_id WHERE d.id=$1 AND d.is_guest`,[driverId])).rows[0];
  if(!row)return;
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`guest-message:${row.ip_hash}`]);
  const count=(await db.query(`SELECT count(*)::int AS n FROM message_jobs j JOIN pickups p ON p.id=j.pickup_id
    JOIN guest_installations g ON g.vehicle_id=p.vehicle_id
    WHERE g.ip_hash=$1 AND p.sms_confirmed AND j.kind IN ('START','RESEND') AND j.created_at>now()-interval '1 hour'`,[row.ip_hash])).rows[0].n;
  if(count>=20)throw new Problem(429,'MESSAGE_RATE_LIMIT','문자 요청이 많아요. 잠시 후 다시 보내 주세요.');
}
