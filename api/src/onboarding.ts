import type {VehicleAuth} from './guest.js';
import {vehicleDetails} from './vehicle-profile.js';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { randomInt, randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { hash, object, phone, Problem, same, secrets, text, token, uuid } from './domain.js';
import type { Config } from './app.js';

export function onboarding(app:FastifyInstance,pool:pg.Pool,config:Config,vehicle:VehicleAuth) {
  const security=secrets(config.secret),origin=new URL(config.publicOrigin).origin;
  const cookie=(name:string,value:string,age:number)=>`${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${config.production?'; Secure':''}`;
  const requireOrigin=(value:unknown)=>{if(value!==origin)throw new Problem(403,'ORIGIN_DENIED','이 사이트에서 다시 시도해 주세요.');};
  app.post('/onboarding/start',async request=>{
    if(config.smsMode==='disabled')throw new Problem(503,'SMS_NOT_CONFIGURED','문자 인증을 준비 중입니다.');
    const car=request.headers.authorization?await vehicle(request):null;
    const number=phone(object(request.body).phone),id=randomUUID(),challengeId=randomUUID(),deviceSecret=token(),claim=token();
    const code=String(randomInt(100000,1000000)),ipHash=security.digest(request.ip);
    const claimUrl=`${origin}/setup#token=${claim}`;
    const payload={phone:number,message:`[픽미업] 인증번호 ${code}\n차량 설정: ${claimUrl}\n5분 이내 인증해 주세요.`};
    await transaction(pool,async db=>{
      if(car) {
        const locked=(await db.query('SELECT v.id,d.is_guest FROM vehicles v JOIN drivers d ON d.id=v.driver_id WHERE v.id=$1 FOR UPDATE OF v',[car.id])).rows[0];
        if(!locked?.is_guest)throw new Problem(409,'ACCOUNT_ALREADY_LINKED','이미 계정에 연결된 차량이에요.');
        if((await db.query("SELECT 1 FROM pickups WHERE vehicle_id=$1 AND state IN ('ACTIVE','ARRIVED')",[car.id])).rowCount)throw new Problem(409,'PICKUP_ACTIVE','진행 중인 픽업을 마친 뒤 계정을 연결해 주세요.');
      }
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`otp-ip:${ipHash}`]);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`otp-phone:${number}`]);
      const limits=(await db.query(`SELECT count(*) FILTER(WHERE phone=$1)::int n,count(*) FILTER(WHERE ip_hash=$2)::int ip,
        count(*) FILTER(WHERE phone=$1 AND created_at>now()-interval '60 seconds')::int recent
        FROM login_challenges WHERE created_at>now()-interval '1 hour' AND auth_mode=$3`,[number,ipHash,config.smsMode])).rows[0];
      if(limits.n>=5||limits.ip>=20||limits.recent>0)throw new Problem(429,'OTP_RATE_LIMIT','잠시 후 다시 요청해 주세요.');
      await db.query(`INSERT INTO login_challenges(id,phone,code_hash,ip_hash,expires_at,auth_mode) VALUES($1,$2,$3,$4,now()+interval '5 minutes',$5)`,[challengeId,number,security.digest(`${challengeId}:${code}`),ipHash,config.smsMode]);
      await db.query(`INSERT INTO pairings(id,device_secret_hash,claim_token_hash,ip_hash,expires_at,auth_mode) VALUES($1,$2,$3,$4,now()+interval '10 minutes',$5)`,[id,hash(deviceSecret),hash(claim),ipHash,config.smsMode]);
      await db.query('INSERT INTO onboarding(pairing_id,challenge_id,claim_ciphertext,message_ciphertext,target_vehicle_id) VALUES($1,$2,$3,$4,$5)',[id,challengeId,security.seal(claim),security.seal(payload),car?.id??null]);
      await db.query(`INSERT INTO message_jobs(id,challenge_id,kind,protected_payload,expires_at,provider) VALUES($1,$2,'OTP',$3,now()+interval '5 minutes',$4)`,[randomUUID(),challengeId,security.seal(payload),config.smsMode]);
    });
    return {id,deviceSecret,expiresIn:600,claimUrl,shareMessage:setupShare(claimUrl),resendsRemaining:1,resendAfter: new Date(Date.now()+60_000).toISOString(),resendExpiresAt:new Date(Date.now()+300_000).toISOString(),...(config.smsMode==='local'?{developmentCode:code}:{})};
  });
  function setupShare(link:string) {return `[픽미업] 차량 연결을 완료해 주세요.\n설정 링크: ${link}\n본인 확인을 위해 휴대전화 문자로 받은 인증번호를 입력해 주세요.`;}
  async function deviceSetup(db:pg.Pool|pg.PoolClient,request:any,lock=false) {
    const id=uuid(request.params.id),auth=request.headers.authorization??'';
    const row=(await db.query(`SELECT o.*,p.device_secret_hash,p.expires_at AS pairing_expires,c.expires_at AS code_expires,
      c.consumed_at,c.attempts,c.created_at,p.auth_mode FROM onboarding o JOIN pairings p ON p.id=o.pairing_id
      JOIN login_challenges c ON c.id=o.challenge_id WHERE o.pairing_id=$1 ${lock?'FOR UPDATE OF o,p,c':''}`,[id])).rows[0];
    if(!row||!auth.startsWith('Pairing ')||!same(row.device_secret_hash,hash(auth.slice(8)))||row.auth_mode!==config.smsMode||
      new Date(row.pairing_expires).getTime()<=Date.now()||row.completed_at||!row.claim_ciphertext)
      throw new Problem(410,'SETUP_EXPIRED','설정 요청이 만료되었어요. 다시 시작해 주세요.');
    return row;
  }
  function setupMessage(row:any) {
    const claimUrl=`${origin}/setup#token=${security.open<string>(row.claim_ciphertext)}`;
    return {id:row.pairing_id,claimUrl,shareMessage:setupShare(claimUrl),verified:!!row.consumed_at,resendsRemaining:row.consumed_at?0:1-row.resend_count,
      resendAfter:new Date(new Date(row.created_at).getTime()+60_000).toISOString(),resendExpiresAt:row.code_expires};
  }
  app.get<{Params:{id:string}}>('/onboarding/:id/message',async request=>setupMessage(await deviceSetup(pool,request)));
  app.post<{Params:{id:string}}>('/onboarding/:id/resend',async request=>{
    if(object(request.body).confirmed!==true)throw new Problem(400,'CONFIRMATION_REQUIRED','문자 재전송을 확인해 주세요.');
    return transaction(pool,async db=>{
      const row=await deviceSetup(db,request,true);
      if(row.resend_count>=1)throw new Problem(409,'RESEND_LIMIT','문자 재전송은 1회까지 가능해요.');
      if(row.consumed_at||row.attempts>=5||new Date(row.code_expires).getTime()<=Date.now()||!row.message_ciphertext)
        throw new Problem(410,'CODE_EXPIRED','인증이 끝났거나 인증번호가 만료되었어요.');
      if(Date.now()<new Date(row.created_at).getTime()+60_000)throw new Problem(429,'RESEND_WAIT','첫 요청 1분 후에 다시 보낼 수 있어요.');
      const jobs=(await db.query('SELECT * FROM message_jobs WHERE challenge_id=$1 FOR UPDATE',[row.challenge_id])).rows;
      if(jobs.some(j=>j.dispatch_token&&new Date(j.lease_expires_at).getTime()>Date.now()))throw new Problem(409,'MESSAGE_SENDING','문자를 보내고 있어요. 잠시 후 다시 확인해 주세요.');
      await db.query("UPDATE message_jobs SET status='CANCELLED',protected_payload=NULL,last_error_code='REPLACED_BY_RESEND' WHERE challenge_id=$1 AND status='PENDING'",[row.challenge_id]);
      await db.query(`INSERT INTO message_jobs(id,challenge_id,kind,protected_payload,expires_at,provider)
        VALUES($1,$2,'OTP',$3,$4,$5)`,[randomUUID(),row.challenge_id,row.message_ciphertext,row.code_expires,config.smsMode]);
      await db.query('UPDATE onboarding SET resend_count=1 WHERE pairing_id=$1',[row.pairing_id]);
      row.resend_count=1;return setupMessage(row);
    });
  });
  app.delete<{Params:{id:string}}>('/onboarding/:id',async request=>transaction(pool,async db=>{
    const row=await deviceSetup(db,request,true);
    await db.query("UPDATE message_jobs SET status='CANCELLED',protected_payload=NULL,last_error_code='SETUP_CANCELLED' WHERE challenge_id=$1 AND status='PENDING'",[row.challenge_id]);
    await db.query('UPDATE login_challenges SET consumed_at=coalesce(consumed_at,now()) WHERE id=$1',[row.challenge_id]);
    await db.query('DELETE FROM pairings WHERE id=$1',[row.pairing_id]);return {ok:true};
  }));
  app.post('/onboarding/verify',async(request,reply)=>{
    requireOrigin(request.headers.origin);
    const input=object(request.body),claim=text(input.token,'설정 링크',100),code=text(input.code,'인증번호',6),session=token();
    const result=await transaction(pool,async db=>{
      const row=(await db.query(`SELECT c.* FROM onboarding o JOIN pairings p ON p.id=o.pairing_id JOIN login_challenges c ON c.id=o.challenge_id
        WHERE p.claim_token_hash=$1 AND p.expires_at>now() AND p.auth_mode=$2 FOR UPDATE OF o,c`,[hash(claim),config.smsMode])).rows[0];
      if(!row||row.consumed_at||row.attempts>=5||new Date(row.expires_at).getTime()<=Date.now())return null;
      await db.query('UPDATE login_challenges SET attempts=attempts+1 WHERE id=$1',[row.id]);
      if(!same(row.code_hash,security.digest(`${row.id}:${code}`)))return null;
      await db.query('UPDATE login_challenges SET consumed_at=now() WHERE id=$1',[row.id]);
      await db.query('UPDATE onboarding SET session_hash=$2 WHERE challenge_id=$1',[row.id,hash(session)]);
      return {ok:true};
    });
    if(!result)throw new Problem(400,'INVALID_CODE','인증번호가 틀렸거나 만료되었습니다.');
    reply.header('Set-Cookie',cookie('pmu_setup',session,600));return result;
  });
  app.get('/onboarding/current',async request=>{
    const value=(request.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('pmu_setup='))?.slice(10)??'';
    const row=(await pool.query(`SELECT d.id,d.name,o.completed_at,o.target_vehicle_id,v.model_name,v.license_plate FROM onboarding o JOIN pairings p ON p.id=o.pairing_id JOIN login_challenges c ON c.id=o.challenge_id
      LEFT JOIN vehicles v ON v.id=o.target_vehicle_id LEFT JOIN drivers d ON d.phone=c.phone AND d.auth_mode=p.auth_mode WHERE o.session_hash=$1 AND p.expires_at>now() AND p.auth_mode=$2`,[hash(value),config.smsMode])).rows[0];
    if(!row)throw new Problem(401,'SETUP_REQUIRED','문자 링크에서 다시 인증해 주세요.');
    const contacts=row.id?(await pool.query('SELECT id,name,phone FROM contacts WHERE driver_id=$1 AND deleted_at IS NULL ORDER BY created_at',[row.id])).rows:[];
    return {name:row.name??'',contacts,completed:!!row.completed_at,accountLink:!!row.target_vehicle_id,modelName:row.model_name??'',licensePlate:row.license_plate??''};
  });
  app.post('/onboarding/complete',async(request,reply)=>{
    requireOrigin(request.headers.origin);
    const input=object(request.body),value=(request.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('pmu_setup='))?.slice(10)??'',webToken=token();
    const result=await transaction(pool,async db=>{
      const row=(await db.query(`SELECT o.*,c.phone,p.auth_mode,p.vehicle_id FROM onboarding o JOIN pairings p ON p.id=o.pairing_id
        JOIN login_challenges c ON c.id=o.challenge_id WHERE o.session_hash=$1 AND p.expires_at>now() AND p.auth_mode=$2 FOR UPDATE OF o,p`,[hash(value),config.smsMode])).rows[0];
      if(!row)throw new Problem(401,'SETUP_REQUIRED','문자 링크에서 다시 인증해 주세요.');
      if(row.completed_at)return {vehicleId:row.vehicle_id,driverId:row.driver_id};
      let target:any=null;
      if(row.target_vehicle_id) {
        target=(await db.query('SELECT v.*,d.is_guest FROM vehicles v JOIN drivers d ON d.id=v.driver_id WHERE v.id=$1 FOR UPDATE OF v',[row.target_vehicle_id])).rows[0];
        if(!target?.is_guest)throw new Problem(409,'ACCOUNT_ALREADY_LINKED','이미 계정에 연결된 차량이에요.');
        if((await db.query("SELECT 1 FROM pickups WHERE vehicle_id=$1 AND state IN ('ACTIVE','ARRIVED')",[target.id])).rowCount)throw new Problem(409,'PICKUP_ACTIVE','진행 중인 픽업을 마친 뒤 계정을 연결해 주세요.');
      }
      const name=text(input.name,'표시 이름',30);
      if(target)await db.query('SELECT id FROM drivers WHERE id=$1 FOR UPDATE',[target.driver_id]);
      const owner=(await db.query(`INSERT INTO drivers(id,phone,name,auth_mode) VALUES($1,$2,$3,$4) ON CONFLICT(phone,auth_mode) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[randomUUID(),row.phone,name,config.smsMode])).rows[0];
      if(input.contactId){
        if(!(await db.query('SELECT id FROM contacts WHERE id=$1 AND driver_id=$2 AND deleted_at IS NULL',[input.contactId,owner.id])).rowCount)throw new Problem(400,'CONTACT_REQUIRED','픽업 상대를 선택해 주세요.');
      }else if(input.contact!==undefined){
        const person=object(input.contact),personName=text(person.name,'상대 이름',30),number=phone(person.phone);
        const existing=(await db.query('SELECT id FROM contacts WHERE driver_id=$1 AND phone=$2 AND name=$3 AND deleted_at IS NULL',[owner.id,number,personName])).rows[0];
        if(!existing){const id=randomUUID();await db.query('INSERT INTO contacts(id,driver_id,name,phone) VALUES($1,$2,$3,$4)',[id,owner.id,personName,number]);await db.query('INSERT INTO contact_aliases(contact_id,alias) VALUES($1,$2)',[id,personName]);}
      }
      const vehicleId=target?.id??randomUUID(),details=vehicleDetails(input);
      let deviceToken:string;
      if(target) {
        const install=(await db.query('SELECT encrypted_device_token FROM guest_installations WHERE vehicle_id=$1',[target.id])).rows[0];
        if(!install)throw new Problem(409,'VEHICLE_REQUIRED','차량 연결을 다시 확인해 주세요.');
        deviceToken=security.open<string>(install.encrypted_device_token);
        await db.query('UPDATE contacts SET driver_id=$2 WHERE driver_id=$1',[target.driver_id,owner.id]);
        await db.query('UPDATE pickups SET driver_id=$2 WHERE driver_id=$1',[target.driver_id,owner.id]);
        await db.query('UPDATE vehicles SET driver_id=$2 WHERE id=$1',[target.id,owner.id]);
        if(input.modelName!==undefined||input.licensePlate!==undefined)
          await db.query('UPDATE vehicles SET model_name=$2,license_plate=$3,model_key=$4 WHERE id=$1',[target.id,input.modelName===undefined?target.model_name:details.modelName,input.licensePlate===undefined?target.license_plate:details.licensePlate,input.modelName===undefined?target.model_key:details.modelKey]);
      } else {
        deviceToken=token();
        await db.query('INSERT INTO vehicles(id,driver_id,token_hash,model_name,license_plate,model_key) VALUES($1,$2,$3,$4,$5,$6)',[vehicleId,owner.id,hash(deviceToken),details.modelName,details.licensePlate,details.modelKey]);
      }
      await db.query('UPDATE pairings SET vehicle_id=$2,encrypted_device_token=$3 WHERE id=$1',[row.pairing_id,vehicleId,security.seal(deviceToken)]);
      await db.query('UPDATE onboarding SET driver_id=$2,completed_at=now(),claim_ciphertext=NULL,message_ciphertext=NULL WHERE pairing_id=$1',[row.pairing_id,owner.id]);
      return {vehicleId,driverId:owner.id};
    });
    await pool.query(`INSERT INTO web_sessions(token_hash,driver_id,expires_at) VALUES($1,$2,now()+interval '7 days')`,[hash(webToken),result.driverId]);
    reply.header('Set-Cookie',cookie('pmu_driver',webToken,604800));return {vehicleId:result.vehicleId};
  });
}
