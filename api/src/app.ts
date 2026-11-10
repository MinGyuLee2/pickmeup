import {webPushRoutes} from './web-push.js';
import {PlannedRoutes} from './planned-route.js';
import {shareAccess} from './share-access.js';
import {vehicleDetails} from './vehicle-profile.js';
import { locationSample, locationSnapshot } from './recipient-location.js';
import {guests,guestMessageQuota} from './guest.js';
import { onboarding } from './onboarding.js';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import type pg from 'pg';
import { randomInt, randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { destination, fresh, hash, object, observation, phone, point, Problem, same, secrets, text, token, uuid } from './domain.js';
import { realSmsMode, smsLabel, type SmsMode } from './sms.js';

export interface Config { secret: string; publicOrigin: string; smsMode: SmsMode; production: boolean; proxyHops?: 0 | 1; webPushPublicKey?:string; kakaoRouteKey?:string; routeFetch?:typeof fetch }
type Row = Record<string, any>;
const active = (row: Row) => ['ACTIVE', 'ARRIVED'].includes(row.state) && new Date(row.expires_at).getTime() > Date.now();

export async function endPickup(db: pg.PoolClient, id: string, state = 'ENDED', reason = 'DRIVER_ENDED') {
  PlannedRoutes.forget(id);
  await db.query(`UPDATE pickups SET state=$2, ended_at=now(), end_reason=$3,
    latest_observation=NULL, recipient_location=NULL, recipient_location_id=NULL, recipient_location_lease_hash=NULL,
    recipient_location_sequence=0, recipient_location_paused=false, waiting_point=NULL, waiting_point_revision=waiting_point_revision+1, waiting_point_consent_version=NULL, recipient_phone_ciphertext=NULL, recipient_link_ciphertext=NULL, recipient_code_hash=NULL, recipient_code_ciphertext=NULL, vehicle_model_name=NULL, vehicle_plate=NULL, version=version+1 WHERE id=$1 AND state IN ('ACTIVE','ARRIVED')`, [id, state, reason]);
  await db.query('UPDATE pickup_push_subscriptions SET revoked_at=coalesce(revoked_at,now()),protected_subscription=NULL WHERE pickup_id=$1',[id]);
  await db.query('DELETE FROM share_grants WHERE pickup_id=$1', [id]);
  await db.query('DELETE FROM recipient_sessions WHERE pickup_id=$1', [id]);
  await db.query(`UPDATE message_jobs SET status=CASE WHEN status='PENDING' THEN 'CANCELLED' ELSE status END,
    protected_payload=NULL, updated_at=now() WHERE pickup_id=$1`, [id]);
}
export async function expirePickups(pool: pg.Pool) {
  await transaction(pool, async db => {
    const result = await db.query("SELECT id FROM pickups WHERE state IN ('ACTIVE','ARRIVED') AND expires_at<=now() FOR UPDATE");
    for (const row of result.rows) await endPickup(db, row.id, 'EXPIRED', 'TIME_LIMIT');
    await db.query('DELETE FROM web_sessions WHERE expires_at<=now()');
    await db.query('DELETE FROM pairings WHERE expires_at<=now()');
    await db.query(`UPDATE message_jobs SET protected_payload=NULL,
      status=CASE WHEN status='PENDING' THEN 'CANCELLED' ELSE status END,updated_at=now()
      WHERE expires_at<=now() AND (status='PENDING' OR protected_payload IS NOT NULL)`);
  });
}

export function buildApp(pool: pg.Pool, config: Config) {
  const origin = new URL(config.publicOrigin).origin;
  if (config.production && (!realSmsMode(config.smsMode) || !origin.startsWith('https://'))) throw new Error('Production requires HTTPS and a real SMS provider');
  if (config.smsMode==='local' && !['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)) throw new Error('Local SMS is limited to localhost');
  const security = secrets(config.secret);
  const app = Fastify({ logger: false, bodyLimit: 32_768, trustProxy: config.proxyHops === 1 ? (_address, hop) => hop < 1 : false });
  const routes=new PlannedRoutes(config.kakaoRouteKey,config.routeFetch);
  app.addHook('onClose',async()=>routes.close());
  const cookie = (name: string, value: string, seconds: number) =>
    `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${config.production ? '; Secure' : ''}`;
  function getCookie(request: FastifyRequest, name: string) {
    return (request.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
  }
  async function driver(request: FastifyRequest) {
    const result = await pool.query(`SELECT d.* FROM web_sessions s JOIN drivers d ON d.id=s.driver_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND d.auth_mode=$2`, [hash(getCookie(request, 'pmu_driver')),config.smsMode]);
    if (!result.rowCount) throw new Problem(401, 'LOGIN_REQUIRED', '다시 로그인해 주세요.');
    return result.rows[0] as Row;
  }
  async function vehicle(request: FastifyRequest) {
    const auth = request.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ')) throw new Problem(401, 'VEHICLE_REQUIRED', '차량 연결이 필요합니다.');
    const result = await pool.query('SELECT v.* FROM vehicles v JOIN drivers d ON d.id=v.driver_id WHERE v.token_hash=$1 AND d.auth_mode=$2', [hash(auth.slice(7)),config.smsMode]);
    if (!result.rowCount) throw new Problem(401, 'VEHICLE_REQUIRED', '차량 연결이 필요합니다.');
    return result.rows[0] as Row;
  }
  const shareGate=shareAccess(app,pool,config);
  const shared=shareGate.shared;
  function snapshot(row: Row, owner = false) {
    const valid = active(row), sample = valid ? row.latest_observation : null;
    return {
      id: row.id, state: valid ? row.state : (row.state === 'ENDED' ? 'ENDED' : 'EXPIRED'),
      vehicle: valid ? {modelKey:row.vehicle_model_key ?? null,modelName:row.vehicle_model_name??null,licensePlate:row.vehicle_plate??null} : null,
      readiness: row.readiness, destination: valid ? row.destination : null,
      recipientLocation:locationSnapshot(owner?{...row,recipient_location_id:null,recipient_location:null}:row,valid),
      waitingPoint:valid&&row.waiting_point?{source:'MANUAL',location:row.waiting_point.location,selectedAt:row.waiting_point.selectedAt}:null,
      waitingPointRevision:Number(row.waiting_point_revision??0),
      waitingPointConsent:valid&&row.waiting_point_consent_version==='2026-11-09-manual',
      observation: sample, freshness: fresh(sample, Date.now()) ? 'FRESH' : 'STALE',
      plannedRoute:routes.read(row as Parameters<PlannedRoutes['read']>[0]),
      startedAt: row.started_at, expiresAt: row.expires_at, arrivedAt: row.arrived_at,
      ...(owner ? { recipientName: row.recipient_name, sequence:Number(row.sequence), version:Number(row.version) } : {}),
    };
  }
  async function ownerSnapshot(row:Row,db?:pg.PoolClient) {
    const jobs=await (db??pool).query('SELECT kind,status,last_error_code AS "errorCode",provider,includes_near AS "includesNear",available_at AS "availableAt",updated_at AS "updatedAt",created_at AS "createdAt" FROM message_jobs WHERE pickup_id=$1 ORDER BY created_at',[row.id]);
    const locked=(await (db??pool).query('SELECT 1 FROM share_grants WHERE pickup_id=$1 AND failed_attempts>=5',[row.id])).rowCount!>0;
    return {...snapshot(row,true),shareCodeLocked:locked,shareRenewalsRemaining:2-row.share_renew_count,
      shareRenewAfter:row.share_renewed_at?new Date(new Date(row.share_renewed_at).getTime()+60_000).toISOString():null,messages:jobs.rows,smsConfirmed:row.sms_confirmed,messageResendsRemaining:1-row.message_resend_count,messageResendAfter:new Date(new Date(row.started_at).getTime()+60_000).toISOString()};
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-Content-Type-Options','nosniff');
    if (['POST','PUT','PATCH','DELETE'].includes(request.method) &&
        (request.headers.cookie || request.url.startsWith('/auth/') || request.url === '/shares/redeem')) {
      if (request.headers.origin !== origin) throw new Problem(403, 'ORIGIN_DENIED', '이 사이트에서 다시 시도해 주세요.');
    }
    if (request.headers.origin && request.headers.origin !== origin) throw new Problem(403, 'ORIGIN_DENIED', '허용되지 않은 요청입니다.');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Problem) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ code: 'INVALID_REQUEST', message: '요청 내용을 확인해 주세요.' });
    // Do not serialize database errors, credentials, phone numbers or message bodies.
    return reply.code(500).send({ code: 'SERVER_ERROR', message: '잠시 후 다시 시도해 주세요.' });
  });
  onboarding(app,pool,config,vehicle);
  guests(app,pool,config,vehicle);
  webPushRoutes(app,pool,config,shared);
  app.get('/health', async (_request, reply) => {
    try { await pool.query('SELECT 1'); return { service: 'pickmeup-api', status: 'ok', database: 'connected', sms: config.smsMode==='local' ? 'local-simulation' : config.smsMode }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });

  app.post('/auth/otp/request', async request => {
    if (config.smsMode==='disabled') throw new Problem(503, 'SMS_NOT_CONFIGURED', '문자 인증 서비스를 준비 중입니다.');
    const input = object(request.body), number = phone(input.phone), id = randomUUID(), code = String(randomInt(100_000,1_000_000));
    const ipHash = security.digest(request.ip);
    await transaction(pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otp-ip:${ipHash}`]);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otp-phone:${number}`]);
      const limits = await db.query(`SELECT
        count(*) FILTER (WHERE phone=$1)::int AS phone_count,
        count(*) FILTER (WHERE ip_hash=$2)::int AS ip_count,
        count(*) FILTER (WHERE phone=$1 AND created_at>now()-interval '60 seconds')::int AS recent
        FROM login_challenges WHERE created_at>now()-interval '1 hour' AND (phone=$1 OR ip_hash=$2) AND auth_mode=$3`, [number, ipHash,config.smsMode]);
      const limit = limits.rows[0];
      if (limit.phone_count >= 5 || limit.ip_count >= 20 || limit.recent > 0) throw new Problem(429, 'OTP_RATE_LIMIT', '잠시 후 인증번호를 다시 요청해 주세요.');
      await db.query('UPDATE login_challenges SET consumed_at=now() WHERE phone=$1 AND consumed_at IS NULL AND auth_mode=$2', [number,config.smsMode]);
      await db.query(`INSERT INTO login_challenges(id,phone,code_hash,ip_hash,expires_at,auth_mode) VALUES($1,$2,$3,$4,now()+interval '5 minutes',$5)`,
        [id, number, security.digest(`${id}:${code}`), ipHash,config.smsMode]);
      await db.query(`INSERT INTO message_jobs(id,challenge_id,kind,protected_payload,expires_at,provider) VALUES($1,$2,'OTP',$3,now()+interval '5 minutes',$4)`,
        [randomUUID(),id,security.seal({ phone:number, message:`[픽미업] 인증번호 ${code} (5분 이내 입력)` }),config.smsMode]);
    });
    // Explicit local simulation. This never means a real text was sent or a phone was verified.
    return { challengeId:id, expiresIn:300, delivery:config.smsMode==='local'?'LOCAL_SIMULATION':'PENDING',
      ...(config.smsMode==='local'?{developmentCode:code}:{}) };
  });
  app.get<{Params:{id:string}}>('/auth/otp/:id/status',async request=>{
    const result=await pool.query(`SELECT c.expires_at,c.consumed_at,c.attempts,j.status FROM login_challenges c
      JOIN message_jobs j ON j.challenge_id=c.id AND j.kind='OTP' WHERE c.id=$1 AND c.auth_mode=$2`,[uuid(request.params.id),config.smsMode]);
    if(!result.rowCount)throw new Problem(404,'OTP_UNAVAILABLE','인증 요청을 찾을 수 없습니다.');
    const row=result.rows[0],expiresIn=Math.max(0,Math.floor((new Date(row.expires_at).getTime()-Date.now())/1000));
    return {status:row.status,expiresIn,active:expiresIn>0&&!row.consumed_at&&row.attempts<5};
  });
  app.post('/auth/otp/verify', async (request, reply) => {
    const input = object(request.body), id = uuid(input.challengeId), code = text(input.code, '인증번호', 6);
    if (!/^\d{6}$/.test(code)) throw new Problem(400,'INVALID_CODE','인증번호 6자리를 입력해 주세요.');
    const session = token();
    const result = await transaction(pool, async db => {
      const challenges = await db.query('SELECT * FROM login_challenges WHERE id=$1 FOR UPDATE',[id]);
      const challenge = challenges.rows[0];
      if ((await db.query('SELECT 1 FROM onboarding WHERE challenge_id=$1',[id])).rowCount) return null;
      if (!challenge || challenge.auth_mode!==config.smsMode || challenge.consumed_at || challenge.attempts >= 5 || new Date(challenge.expires_at).getTime() <= Date.now()) return null;
      await db.query('UPDATE login_challenges SET attempts=attempts+1 WHERE id=$1',[id]);
      if (!same(challenge.code_hash,security.digest(`${id}:${code}`))) return null;
      await db.query('UPDATE login_challenges SET consumed_at=now() WHERE id=$1',[id]);
      const name = input.name === undefined ? '운전자' : text(input.name,'이름',30);
      const drivers = await db.query(`INSERT INTO drivers(id,phone,name,auth_mode) VALUES($1,$2,$3,$4)
        ON CONFLICT(phone,auth_mode) DO UPDATE SET phone=EXCLUDED.phone RETURNING id,name`,[randomUUID(),challenge.phone,name,config.smsMode]);
      const owner = drivers.rows[0];
      await db.query(`INSERT INTO web_sessions(token_hash,driver_id,expires_at) VALUES($1,$2,now()+interval '7 days')`,[hash(session),owner.id]);
      return owner;
    });
    if (!result) throw new Problem(400,'INVALID_CODE','인증번호가 틀렸거나 만료되었습니다.');
    reply.header('Set-Cookie',cookie('pmu_driver',session,604800));
    return { driver: result, authentication: config.smsMode==='local' ? 'LOCAL_SIMULATION' : 'PHONE_OTP' };
  });
  app.post('/auth/logout', async (request, reply) => {
    await pool.query('DELETE FROM web_sessions WHERE token_hash=$1',[hash(getCookie(request,'pmu_driver'))]);
    reply.header('Set-Cookie',cookie('pmu_driver','',0)); return { ok:true };
  });
  app.get('/me',async request => { const owner = await driver(request); return { id:owner.id,name:owner.name,localSimulation:config.smsMode==='local' }; });
  app.get('/vehicles',async request => {
    const owner = await driver(request);
    return (await pool.query('SELECT id,name,model_key AS "modelKey",model_name AS "modelName",license_plate AS "licensePlate",created_at AS "createdAt" FROM vehicles WHERE driver_id=$1 ORDER BY created_at',[owner.id])).rows;
  });

  app.patch<{Params:{id:string}}>('/vehicles/:id',async request => {
    const owner=await driver(request),id=uuid(request.params.id),input=object(request.body);
    return transaction(pool,async db=>{
      const existing=(await db.query('SELECT * FROM vehicles WHERE id=$1 AND driver_id=$2 FOR UPDATE',[id,owner.id])).rows[0];
      if(!existing)throw new Problem(404,'VEHICLE_NOT_FOUND','연결된 차량을 찾을 수 없습니다.');
      const details=vehicleDetails({modelName:input.modelName===undefined?existing.model_name:input.modelName,licensePlate:input.licensePlate===undefined?existing.license_plate:input.licensePlate});
      const model=input.modelKey===undefined?('modelName' in input?details.modelKey:existing.model_key):input.modelKey;
      if(model!==null&&model!=='ioniq5')throw new Problem(400,'INVALID_VEHICLE_MODEL','지원하는 차종을 선택해 주세요.');
      const result=await db.query('UPDATE vehicles SET model_key=$3,model_name=$4,license_plate=$5 WHERE id=$1 AND driver_id=$2 RETURNING id,name,model_key AS "modelKey",model_name AS "modelName",license_plate AS "licensePlate"',[id,owner.id,model,details.modelName,details.licensePlate]);
      await db.query("UPDATE pickups SET vehicle_model_key=$2,vehicle_model_name=$3,vehicle_plate=$4,version=version+1 WHERE vehicle_id=$1 AND state IN ('ACTIVE','ARRIVED') AND expires_at>now()",[id,model,details.modelName,details.licensePlate]);
      return result.rows[0];
    });
  });

  for(const path of ['/pairings','/pairings/claim'])app.post(path,async()=>{throw new Problem(410,'QR_PAIRING_REMOVED','차량에서 설정 문자를 받아 인증코드로 연결해 주세요.');});
  app.get<{Params:{id:string}}>('/pairings/:id',async request => {
    const id = uuid(request.params.id), secret = (request.headers.authorization ?? '').replace(/^Pairing /,'');
    const rows = await pool.query('SELECT * FROM pairings WHERE id=$1 AND expires_at>now() AND auth_mode=$2',[id,config.smsMode]);
    const row = rows.rows[0];
    if (!row || !same(hash(secret),row.device_secret_hash)) throw new Problem(410,'PAIRING_UNAVAILABLE','차량 연결 코드가 만료되었습니다.');
    return row.vehicle_id ? { state:'PAIRED',vehicleId:row.vehicle_id,deviceToken:security.open<string>(row.encrypted_device_token) } : { state:'WAITING' };
  });

  app.get('/contacts',async request => {
    const owner = await driver(request);
    return (await pool.query(`SELECT c.id,c.name,c.phone,coalesce(array_agg(a.alias) FILTER(WHERE a.alias IS NOT NULL),'{}') aliases
      FROM contacts c LEFT JOIN contact_aliases a ON a.contact_id=c.id WHERE c.driver_id=$1 AND c.deleted_at IS NULL GROUP BY c.id ORDER BY c.created_at`,[owner.id])).rows;
  });
  function contactInput(body: unknown) {
    const input = object(body), name = text(input.name,'이름',30), number = phone(input.phone);
    if (!Array.isArray(input.aliases) || input.aliases.length > 10) throw new Problem(400,'INVALID_ALIASES','별칭은 최대 10개 입력해 주세요.');
    return { name, number, aliases:[...new Set([name,...input.aliases.map(a => text(a,'별칭',30))])] };
  }
  app.post('/contacts',async (request,reply) => {
    const owner = await driver(request), input = contactInput(request.body), id = randomUUID();
    await transaction(pool,async db => {
      await db.query('INSERT INTO contacts(id,driver_id,name,phone) VALUES($1,$2,$3,$4)',[id,owner.id,input.name,input.number]);
      for (const alias of input.aliases) await db.query('INSERT INTO contact_aliases(contact_id,alias) VALUES($1,$2)',[id,alias]);
    });
    return reply.code(201).send({ id,name:input.name,phone:input.number,aliases:input.aliases });
  });
  app.patch<{Params:{id:string}}>('/contacts/:id',async request => {
    const owner = await driver(request), id = uuid(request.params.id), input = contactInput(request.body);
    await transaction(pool,async db => {
      const result = await db.query('UPDATE contacts SET name=$3,phone=$4 WHERE id=$1 AND driver_id=$2 AND deleted_at IS NULL RETURNING id',[id,owner.id,input.name,input.number]);
      if (!result.rowCount) throw new Problem(404,'CONTACT_NOT_FOUND','연락 상대를 찾을 수 없습니다.');
      await db.query('DELETE FROM contact_aliases WHERE contact_id=$1',[id]);
      for (const alias of input.aliases) await db.query('INSERT INTO contact_aliases(contact_id,alias) VALUES($1,$2)',[id,alias]);
    });
    return { id,name:input.name,phone:input.number,aliases:input.aliases };
  });
  app.delete<{Params:{id:string}}>('/contacts/:id',async request => {
    const owner = await driver(request), id = uuid(request.params.id);
    return transaction(pool,async db => {
      const contact = await db.query('SELECT id FROM contacts WHERE id=$1 AND driver_id=$2 AND deleted_at IS NULL FOR UPDATE',[id,owner.id]);
      if (!contact.rowCount) throw new Problem(404,'CONTACT_NOT_FOUND','연락 상대를 찾을 수 없습니다.');
      const running = await db.query("SELECT id FROM pickups WHERE contact_id=$1 AND state IN ('ACTIVE','ARRIVED') FOR UPDATE",[id]);
      for(const row of running.rows)await endPickup(db,row.id,'ENDED','CONTACT_REMOVED');
      await db.query('DELETE FROM contact_aliases WHERE contact_id=$1',[id]);
      await db.query('DELETE FROM contact_places WHERE contact_id=$1',[id]);
      await db.query("UPDATE contacts SET deleted_at=now(),name='삭제한 상대',phone='' WHERE id=$1",[id]);return { ok:true };
    });
  });

  app.get('/vehicle/contacts',async request => {
    const car = await vehicle(request);
    return (await pool.query(`SELECT c.id,c.name,array_agg(a.alias) aliases,cp.destination "meetingPlace" FROM contacts c
      JOIN contact_aliases a ON a.contact_id=c.id LEFT JOIN contact_places cp ON cp.contact_id=c.id
      WHERE c.driver_id=$1 AND c.deleted_at IS NULL GROUP BY c.id,cp.destination
      ORDER BY (SELECT max(p.started_at) FROM pickups p WHERE p.contact_id=c.id) DESC NULLS LAST,c.created_at`,[car.driver_id])).rows;
  });
  app.put<{Params:{id:string}}>('/vehicle/contacts/:id/place',async request=>{
    const car=await vehicle(request),id=uuid(request.params.id),place=destination(object(request.body).destination);
    return transaction(pool,async db=>{
      const person=await db.query('SELECT id FROM contacts WHERE id=$1 AND driver_id=$2 AND deleted_at IS NULL FOR UPDATE',[id,car.driver_id]);
      if(!person.rowCount)throw new Problem(404,'CONTACT_NOT_FOUND','연락 상대를 찾을 수 없습니다.');
      await db.query(`INSERT INTO contact_places(contact_id,destination) VALUES($1,$2) ON CONFLICT(contact_id)
        DO UPDATE SET destination=EXCLUDED.destination,updated_at=now()`,[id,place]);
      return {meetingPlace:place};
    });
  });
  app.delete<{Params:{id:string}}>('/vehicle/contacts/:id/place',async request=>{
    const car=await vehicle(request),id=uuid(request.params.id);
    return transaction(pool,async db=>{
      if(!(await db.query('SELECT id FROM contacts WHERE id=$1 AND driver_id=$2 AND deleted_at IS NULL FOR UPDATE',[id,car.driver_id])).rowCount)
        throw new Problem(404,'CONTACT_NOT_FOUND','연락 상대를 찾을 수 없습니다.');
      await db.query('DELETE FROM contact_places WHERE contact_id=$1',[id]);return {ok:true};
    });
  });
  app.post('/vehicle/contacts/import',async request => {
    const car=await vehicle(request),input=object(request.body);
    const name=text(input.name,'상대 이름',30),number=phone(input.phone);
    return transaction(pool,async db=>{
      // Serialize imports for this owner, including imports from different vehicles.
      await db.query('SELECT id FROM drivers WHERE id=$1 FOR UPDATE',[car.driver_id]);
      if((await db.query('SELECT driver_id FROM vehicles WHERE id=$1',[car.id])).rows[0].driver_id!==car.driver_id)throw new Problem(409,'ACCOUNT_CHANGED','계정 연결을 마쳤어요. 다시 선택해 주세요.');
      let person=(await db.query(`SELECT id,name FROM contacts WHERE driver_id=$1 AND phone=$2 AND deleted_at IS NULL
        ORDER BY (name=$3) DESC,created_at,id LIMIT 1`,[car.driver_id,number,name])).rows[0];
      if(!person){
        person={id:randomUUID(),name};
        await db.query('INSERT INTO contacts(id,driver_id,name,phone) VALUES($1,$2,$3,$4)',[person.id,car.driver_id,name,number]);
        await db.query('INSERT INTO contact_aliases(contact_id,alias) VALUES($1,$2)',[person.id,name]);
      }
      const aliases=(await db.query('SELECT alias FROM contact_aliases WHERE contact_id=$1 ORDER BY alias',[person.id])).rows.map(row=>row.alias);
      const place=(await db.query('SELECT destination FROM contact_places WHERE contact_id=$1',[person.id])).rows[0];
      return {...person,aliases,meetingPlace:place?.destination??null};
    });
  });
  app.post('/pickups',async (request,reply) => {
    const car = await vehicle(request), input = object(request.body);
    const key = uuid(input.idempotencyKey), place = destination(input.destination);
    const recipientId = input.contactId === undefined ? undefined : uuid(input.contactId);
    const alias = recipientId ? undefined : text(input.recipientAlias,'상대 이름',30);
    const requestHash = hash(JSON.stringify({recipientId,alias,place}));
    const now = Date.now(), sample = observation(input.observation,now);
    if (!fresh(sample,now)) throw new Problem(409,'NAVIGATION_STALE','최신 내비 위치와 도착 시간을 기다리고 있습니다.');
    const result = await transaction(pool,async db => {
      const lockedVehicle=await db.query('SELECT id,driver_id,model_key,model_name,license_plate FROM vehicles WHERE id=$1 FOR UPDATE',[car.id]);
      if(lockedVehicle.rows[0].driver_id!==car.driver_id)throw new Problem(409,'ACCOUNT_CHANGED','계정 연결을 마쳤어요. 다시 시작해 주세요.');
      const cancelled=await db.query('SELECT 1 FROM cancelled_pickup_starts WHERE vehicle_id=$1 AND idempotency_key=$2',[car.id,key]);
      if(cancelled.rowCount)throw new Problem(409,'START_CANCELLED','취소한 공유 요청입니다. 새 요청으로 시작해 주세요.');
      const duplicate = await db.query('SELECT * FROM pickups WHERE vehicle_id=$1 AND idempotency_key=$2',[car.id,key]);
      if (duplicate.rowCount) {
        if (duplicate.rows[0].request_hash !== requestHash) throw new Problem(409,'IDEMPOTENCY_CONFLICT','같은 요청 키에 다른 픽업이 있습니다.');
        return { row:duplicate.rows[0],created:false };
      }
      const previous = await db.query("SELECT * FROM pickups WHERE vehicle_id=$1 AND state IN ('ACTIVE','ARRIVED') FOR UPDATE",[car.id]);
      for (const row of previous.rows) {
        if (active(row)) throw new Problem(409,'PICKUP_ALREADY_ACTIVE','진행 중인 픽업을 먼저 종료해 주세요.');
        await endPickup(db,row.id,'EXPIRED','TIME_LIMIT');
      }
      const contacts = recipientId
        ? await db.query('SELECT * FROM contacts WHERE id=$1 AND driver_id=$2 AND deleted_at IS NULL FOR SHARE',[recipientId,car.driver_id])
        : await db.query(`SELECT c.* FROM contacts c JOIN contact_aliases a ON a.contact_id=c.id WHERE c.driver_id=$1 AND c.deleted_at IS NULL AND a.alias=$2 FOR SHARE OF c`,[car.driver_id,alias]);
      if (!contacts.rowCount) throw new Problem(404,'CONTACT_NOT_FOUND','등록한 상대 이름을 확인해 주세요.');
      if (contacts.rowCount !== 1) throw new Problem(409,'AMBIGUOUS_RECIPIENT','같은 별칭이 여러 명입니다. 연락 상대를 선택해 주세요.');
      const contact = contacts.rows[0], id = randomUUID(), shareToken = token(), accessCode=String(randomInt(0,10000)).padStart(4,'0'), near = sample.remainingSeconds<=300;
      const link = `${origin}/s#token=${shareToken}`;
      const created = await db.query(`INSERT INTO pickups(id,driver_id,vehicle_id,contact_id,recipient_name,destination,idempotency_key,
        request_hash,latest_observation,sequence,near_notified_at,expires_at,recipient_phone_ciphertext,recipient_link_ciphertext,vehicle_model_key,vehicle_model_name,vehicle_plate,recipient_code_hash,recipient_code_ciphertext)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,CASE WHEN $10 THEN now() ELSE NULL END,now()+interval '2 hours',$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [id,car.driver_id,car.id,contact.id,contact.name,place,key,requestHash,sample,near,security.seal(contact.phone),security.seal(link),lockedVehicle.rows[0].model_key,lockedVehicle.rows[0].model_name,lockedVehicle.rows[0].license_plate,security.digest(`share:${id}:${accessCode}`),security.seal(accessCode)]);
      await db.query('INSERT INTO share_grants(token_hash,pickup_id,expires_at) VALUES($1,$2,$3)',[hash(shareToken),id,created.rows[0].expires_at]);
      const name = (await db.query('SELECT name FROM drivers WHERE id=$1',[car.driver_id])).rows[0].name;
      const body = `[픽미업] ${name}님이 ${place.name}에 약 ${Math.max(1,Math.ceil(sample.remainingSeconds/60))}분 뒤 도착 예정입니다.${near ? ' 곧 도착해요.' : ''}\n인증코드: ${accessCode}\n위치·준비 상태: ${link}`;
      await db.query(`INSERT INTO message_jobs(id,pickup_id,kind,protected_payload,expires_at,provider,includes_near) VALUES($1,$2,'START',$3,$4,$5,$6)`,
        [randomUUID(),id,security.seal({phone:contact.phone,message:body,shareLink:link,accessCode,senderName:name}),created.rows[0].expires_at,config.smsMode,near]);
      return { row:created.rows[0],created:true };
    });
    const pickup=await ownerSnapshot(result.row);
    return reply.code(result.created ? 201 : 200).send({ pickup, messageStatus:pickup.messages.find(job=>job.kind==='START')?.status,
      delivery:config.smsMode==='local' ? 'LOCAL_SIMULATION' : config.smsMode.toUpperCase() });
  });
  app.post('/pickups/cancel-start',async request => {
    const car=await vehicle(request),key=uuid(object(request.body).idempotencyKey);
    return transaction(pool,async db=>{
      await db.query('SELECT id FROM vehicles WHERE id=$1 FOR UPDATE',[car.id]);
      await db.query('INSERT INTO cancelled_pickup_starts(vehicle_id,idempotency_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[car.id,key]);
      const rows=await db.query('SELECT id FROM pickups WHERE vehicle_id=$1 AND idempotency_key=$2 FOR UPDATE',[car.id,key]);
      for(const row of rows.rows)await endPickup(db,row.id,'ENDED','DRIVER_ENDED');
      return {ok:true};
    });
  });
  app.get('/pickups/current',async request => {
    const car = await vehicle(request);
    const result = await pool.query("SELECT * FROM pickups WHERE vehicle_id=$1 AND state IN ('ACTIVE','ARRIVED') AND expires_at>now()",[car.id]);
    return { pickup:result.rowCount ? await ownerSnapshot(result.rows[0]) : null };
  });
  app.get<{Params:{id:string}}>('/pickups/:id/share-message',async request=>{
    const car=await vehicle(request),id=uuid(request.params.id);
    const row=(await pool.query(`SELECT p.*,d.name AS driver_name FROM pickups p JOIN drivers d ON d.id=p.driver_id
      WHERE p.id=$1 AND p.vehicle_id=$2 AND p.driver_id=$3`,[id,car.id,car.driver_id])).rows[0];
    if(!row)throw new Problem(404,'PICKUP_NOT_FOUND','픽업을 찾을 수 없습니다.');
    if(!active(row)||!row.recipient_link_ciphertext)throw new Problem(410,'SHARE_ENDED','공유가 종료되었습니다.');
    const shareLink=security.open<string>(row.recipient_link_ciphertext);
    const accessCode=row.recipient_code_ciphertext?security.open<string>(row.recipient_code_ciphertext):null;
    const number=security.open<string>(row.recipient_phone_ciphertext);
    const name=smsLabel(row.driver_name,'운전자'),place=smsLabel(row.destination.name,'만날 곳');
    const lead=row.state==='ARRIVED'?`${place} 근처에 도착했습니다.`:fresh(row.latest_observation,Date.now())
      ?`${place}에 약 ${Math.max(1,Math.ceil(row.latest_observation.remainingSeconds/60))}분 뒤 도착 예정입니다.`:`${place}까지 도착 위치를 공유합니다.`;
    return {pickupId:id,recipientName:row.recipient_name,maskedPhone:number.slice(0,3)+'-****-'+number.slice(-4),shareLink,accessCode,
      message:`[픽미업] ${name}님이 ${lead}\n위치·준비 상태: ${shareLink}${accessCode?'\n인증코드: '+accessCode:''}`};
  });
  app.post<{Params:{id:string}}>('/pickups/:id/confirm-message',async request=>{
    const car=await vehicle(request),id=uuid(request.params.id);
    if(object(request.body).confirmed!==true)throw new Problem(400,'CONFIRMATION_REQUIRED','받는 상대를 확인한 뒤 보내기를 눌러 주세요.');
    return transaction(pool,async db=>{
      const row=(await db.query('SELECT * FROM pickups WHERE id=$1 AND vehicle_id=$2 AND driver_id=$3 FOR UPDATE',[id,car.id,car.driver_id])).rows[0];
      if(!row)throw new Problem(404,'PICKUP_NOT_FOUND','픽업을 찾을 수 없습니다.');
      if(!active(row))throw new Problem(410,'SHARE_ENDED','공유가 종료되었습니다.');
      if((await db.query('SELECT 1 FROM share_grants WHERE pickup_id=$1 AND failed_attempts>=5',[id])).rowCount)throw new Problem(409,'SHARE_CODE_LOCKED','먼저 인증 잠금을 풀고 새 링크를 전달해 주세요.');
      if(!row.sms_confirmed){
        await guestMessageQuota(db,car.driver_id);
        await db.query('UPDATE pickups SET sms_confirmed=true,version=version+1 WHERE id=$1',[id]);
        await db.query("UPDATE message_jobs SET available_at=now(),last_error_code=NULL WHERE pickup_id=$1 AND status='PENDING'",[id]);
        row.sms_confirmed=true;row.version=Number(row.version)+1;
      }
      return {pickup:await ownerSnapshot(row,db)};
    });
  });
  app.post<{Params:{id:string}}>('/pickups/:id/resend-message',async request=>{
    const car=await vehicle(request),id=uuid(request.params.id);
    if(object(request.body).confirmed!==true)throw new Problem(400,'CONFIRMATION_REQUIRED','받는 상대를 확인한 뒤 재전송해 주세요.');
    return transaction(pool,async db=>{
      const row=(await db.query('SELECT * FROM pickups WHERE id=$1 AND vehicle_id=$2 AND driver_id=$3 FOR UPDATE',[id,car.id,car.driver_id])).rows[0];
      if(!row)throw new Problem(404,'PICKUP_NOT_FOUND','픽업을 찾을 수 없습니다.');
      if(!active(row))throw new Problem(410,'SHARE_ENDED','공유가 종료되었습니다.');
      if(!row.sms_confirmed)throw new Problem(409,'CONFIRMATION_REQUIRED','먼저 문자 보내기를 눌러 주세요.');
      if((await db.query('SELECT 1 FROM share_grants WHERE pickup_id=$1 AND failed_attempts>=5',[id])).rowCount)throw new Problem(409,'SHARE_CODE_LOCKED','먼저 인증 잠금을 풀고 새 링크를 전달해 주세요.');
      await guestMessageQuota(db,car.driver_id);
      if(row.message_resend_count>=1)throw new Problem(409,'RESEND_LIMIT','문자 재전송은 1회까지 가능해요.');
      if(Date.now()<new Date(row.started_at).getTime()+60_000)throw new Problem(429,'RESEND_WAIT','첫 요청 1분 후에 다시 보낼 수 있어요.');
      const jobs=(await db.query('SELECT * FROM message_jobs WHERE pickup_id=$1 FOR UPDATE',[id])).rows;
      if(jobs.some(j=>j.dispatch_token&&new Date(j.lease_expires_at).getTime()>Date.now()))throw new Problem(409,'MESSAGE_SENDING','문자를 보내고 있어요. 잠시 후 다시 확인해 주세요.');
      if(!row.recipient_link_ciphertext||!row.recipient_phone_ciphertext)throw new Problem(410,'SHARE_ENDED','공유가 종료되었습니다.');
      const link=security.open<string>(row.recipient_link_ciphertext),number=security.open<string>(row.recipient_phone_ciphertext);
      await db.query("UPDATE message_jobs SET status='CANCELLED',protected_payload=NULL,last_error_code='REPLACED_BY_RESEND' WHERE pickup_id=$1 AND kind='START' AND status='PENDING'",[id]);
      await db.query(`INSERT INTO message_jobs(id,pickup_id,kind,protected_payload,expires_at,provider)
        VALUES($1,$2,'RESEND',$3,$4,$5)`,[randomUUID(),id,security.seal({phone:number,shareLink:link,message:'[픽미업] 도착 안내'}),row.expires_at,config.smsMode]);
      await db.query('UPDATE pickups SET message_resend_count=1,version=version+1 WHERE id=$1',[id]);
      row.message_resend_count=1;row.version=Number(row.version)+1;
      return {pickup:await ownerSnapshot(row,db)};
    });
  });
  app.post<{Params:{id:string}}>('/pickups/:id/renew-access',async request=>{
    const car=await vehicle(request),id=uuid(request.params.id),input=object(request.body),key=uuid(input.idempotencyKey);
    if(input.confirmed!==true)throw new Problem(400,'CONFIRMATION_REQUIRED','기존 링크가 종료되는 것을 확인해 주세요.');
    return transaction(pool,async db=>{
      const row=(await db.query('SELECT * FROM pickups WHERE id=$1 AND vehicle_id=$2 AND driver_id=$3 FOR UPDATE',[id,car.id,car.driver_id])).rows[0];
      if(!row)throw new Problem(404,'PICKUP_NOT_FOUND','픽업을 찾을 수 없습니다.');
      if(!active(row))throw new Problem(410,'SHARE_ENDED','공유가 종료되었습니다.');
      if(row.share_renew_key===key)return {pickup:await ownerSnapshot(row,db)};
      if(row.share_renew_count>=2)throw new Problem(409,'RENEW_LIMIT','인증 링크 교체는 픽업당 2회까지 가능해요.');
      if(row.share_renewed_at&&Date.now()<new Date(row.share_renewed_at).getTime()+60_000)throw new Problem(429,'RENEW_WAIT','1분 뒤에 인증 링크를 다시 바꿀 수 있어요.');
      const jobs=(await db.query('SELECT * FROM message_jobs WHERE pickup_id=$1 FOR UPDATE',[id])).rows;
      if(jobs.some(j=>j.dispatch_token&&new Date(j.lease_expires_at).getTime()>Date.now()))throw new Problem(409,'MESSAGE_SENDING','문자를 보내고 있어요. 잠시 후 다시 시도해 주세요.');
      const previous=row.recipient_code_ciphertext?security.open<string>(row.recipient_code_ciphertext):'';
      let code:string;do{code=String(randomInt(0,10000)).padStart(4,'0');}while(code===previous);
      const grant=token(),link=`${origin}/s#token=${grant}`;
      await db.query('DELETE FROM share_grants WHERE pickup_id=$1',[id]);
      await db.query('DELETE FROM recipient_sessions WHERE pickup_id=$1',[id]);
      await db.query('UPDATE pickup_push_subscriptions SET revoked_at=coalesce(revoked_at,now()),protected_subscription=NULL WHERE pickup_id=$1',[id]);
      const updated=(await db.query(`UPDATE pickups SET recipient_link_ciphertext=$2,recipient_code_hash=$3,recipient_code_ciphertext=$4,
        share_renew_count=share_renew_count+1,share_renewed_at=now(),share_renew_key=$5,
        recipient_location=NULL,recipient_location_id=NULL,recipient_location_lease_hash=NULL,recipient_location_sequence=0,recipient_location_paused=false,waiting_point=NULL,waiting_point_revision=waiting_point_revision+1,waiting_point_consent_version=NULL,
        version=version+1 WHERE id=$1 RETURNING *`,[id,security.seal(link),security.digest(`share:${id}:${code}`),security.seal(code),key])).rows[0];
      await db.query('INSERT INTO share_grants(token_hash,pickup_id,expires_at) VALUES($1,$2,$3)',[hash(grant),id,row.expires_at]);
      // Renewal never queues another SMS. Existing jobs materialize the current link at dispatch.
      return {pickup:await ownerSnapshot(updated,db)};
    });
  });
  app.put<{Params:{id:string}}>('/pickups/:id/observation',async request => {
    const car = await vehicle(request), id = uuid(request.params.id), input = object(request.body);
    const sample = observation(input.observation,Date.now()), place = destination(input.destination);
    const sequence = input.sequence;
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 2) throw new Problem(400,'INVALID_SEQUENCE','관측 순서를 확인해 주세요.');
    return transaction(pool,async db => {
      const rows = await db.query('SELECT * FROM pickups WHERE id=$1 AND vehicle_id=$2 AND driver_id=$3 FOR UPDATE',[id,car.id,car.driver_id]);
      const pickup = rows.rows[0];
      if (!pickup) throw new Problem(404,'PICKUP_NOT_FOUND','픽업을 찾을 수 없습니다.');
      if (!active(pickup)) throw new Problem(410,'SHARE_ENDED','공유가 종료되었습니다.');
      if (sequence <= Number(pickup.sequence)) return { accepted:false, reason:'OUT_OF_ORDER' };
      if (JSON.stringify(place)!==JSON.stringify(pickup.destination) &&
          (place.latitude !== pickup.destination.latitude || place.longitude !== pickup.destination.longitude || place.name !== pickup.destination.name)) {
        await endPickup(db,id,'ENDED','DESTINATION_CHANGED'); return { accepted:false,reason:'DESTINATION_CHANGED' };
      }
      const arrived = input.arrived === true;
      const updated = await db.query(`UPDATE pickups SET latest_observation=$2,sequence=$3,version=version+1,
        state=CASE WHEN $4 THEN 'ARRIVED' ELSE state END,
        arrived_at=CASE WHEN $4 THEN coalesce(arrived_at,now()) ELSE arrived_at END,
        expires_at=CASE WHEN $4 THEN least(expires_at,coalesce(arrived_at,now())+interval '10 minutes') ELSE expires_at END
        WHERE id=$1 RETURNING *`,[id,sample,sequence,arrived]);
      if (sample.remainingSeconds<=300 && fresh(sample,Date.now()) && !pickup.near_notified_at && pickup.recipient_phone_ciphertext) {
        const recipientPhone=security.open<string>(pickup.recipient_phone_ciphertext);
        await db.query(`INSERT INTO message_jobs(id,pickup_id,kind,protected_payload,expires_at,provider)
          VALUES($1,$2,'NEAR',$3,$4,$5) ON CONFLICT(pickup_id,kind) DO NOTHING`,
        [randomUUID(),id,security.seal({phone:recipientPhone,message:`[픽미업] ${pickup.destination.name}에 5분 이내 도착 예정입니다. 공유 페이지에서 위치를 확인해 주세요.${pickup.recipient_code_ciphertext?'\n인증코드: '+security.open<string>(pickup.recipient_code_ciphertext):''}`}),updated.rows[0].expires_at,config.smsMode]);
        await db.query('UPDATE pickups SET near_notified_at=now() WHERE id=$1',[id]);
      }
      return { accepted:true,pickup:await ownerSnapshot(updated.rows[0],db) };
    });
  });
  app.post<{Params:{id:string}}>('/pickups/:id/end',async request => {
    const id = uuid(request.params.id);
    const reason=request.body===undefined ? 'DRIVER_ENDED' : object(request.body).reason ?? 'DRIVER_ENDED';
    if(!['DRIVER_ENDED','DESTINATION_CHANGED','ROUTE_CANCELLED','NAVIGATION_UNAVAILABLE'].includes(String(reason))) {
      throw new Problem(400,'INVALID_END_REASON','공유 종료 사유를 확인해 주세요.');
    }
    let vehicleId: string | undefined, driverId: string;
    if (request.headers.authorization) { const car = await vehicle(request); vehicleId=car.id;driverId=car.driver_id; }
    else driverId=(await driver(request)).id;
    return transaction(pool,async db => {
      const rows = await db.query('SELECT * FROM pickups WHERE id=$1 AND driver_id=$2 AND ($3::uuid IS NULL OR vehicle_id=$3) FOR UPDATE',[id,driverId,vehicleId ?? null]);
      if (!rows.rowCount) throw new Problem(404,'PICKUP_NOT_FOUND','픽업을 찾을 수 없습니다.');
      await endPickup(db,id,'ENDED',String(reason)); return { ok:true };
    });
  });

  app.get('/shared-pickup',async request => snapshot(await shared(request)));
  async function locationCommand(request:FastifyRequest,work:(db:pg.PoolClient,row:Row,input:Record<string,unknown>)=>Promise<unknown>) {
    const recipient=await shared(request),input=object(request.body);
    return transaction(pool,async db=>{
      const result=await db.query("SELECT * FROM pickups WHERE id=$1 AND state IN ('ACTIVE','ARRIVED') AND expires_at>now() FOR UPDATE",[recipient.id]);
      if(!result.rowCount||!active(result.rows[0]))throw new Problem(410,'SHARE_ENDED','공유가 종료되었습니다.');
      await shared(request,db);
      return work(db,result.rows[0],input);
    });
  }
  function waitingRevision(row:Row,input:Record<string,unknown>){
    if(typeof input.expectedRevision!=='number'||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)
      throw new Problem(400,'WAITING_REVISION_REQUIRED','기다릴 위치를 다시 확인해 주세요.');
    if(input.expectedRevision!==Number(row.waiting_point_revision))throw new Problem(409,'WAITING_POINT_CHANGED','다른 화면에서 기다릴 위치가 바뀌었어요. 닫고 다시 확인해 주세요.');
  }
  app.post('/shared-pickup/waiting-point/consent',async request=>locationCommand(request,async(db,row,input)=>{
    if(input.consent!==true||input.consentVersion!=='2026-11-09-manual')throw new Problem(400,'WAITING_CONSENT_REQUIRED','위치정보 이용 안내에 동의해 주세요.');
    if(row.waiting_point_consent_version==='2026-11-09-manual')return snapshot(row);
    const updated=await db.query(`UPDATE pickups SET waiting_point_consent_version='2026-11-09-manual',waiting_point_revision=waiting_point_revision+1,
      recipient_location=NULL,recipient_location_id=NULL,recipient_location_lease_hash=NULL,recipient_location_sequence=0,recipient_location_paused=false,version=version+1 WHERE id=$1 RETURNING *`,[row.id]);
    return snapshot(updated.rows[0]);
  }));
  app.put('/shared-pickup/waiting-point',async request=>locationCommand(request,async(db,row,input)=>{
    waitingRevision(row,input);
    if(input.consentVersion!=='2026-11-09-manual'||(row.waiting_point_consent_version!=='2026-11-09-manual'&&input.consent!==true))throw new Problem(400,'WAITING_CONSENT_REQUIRED','지정한 위치를 운전자에게 공유하는 데 동의해 주세요.');
    const value={location:point(input.location),selectedAt:new Date().toISOString(),consentVersion:input.consentVersion};
    const updated=await db.query(`UPDATE pickups SET waiting_point=$2,waiting_point_revision=waiting_point_revision+1,waiting_point_consent_version='2026-11-09-manual',
      recipient_location=NULL,recipient_location_id=NULL,recipient_location_lease_hash=NULL,recipient_location_sequence=0,recipient_location_paused=false,version=version+1 WHERE id=$1 RETURNING *`,[row.id,value]);
    return snapshot(updated.rows[0]);
  }));
  app.delete('/shared-pickup/waiting-point',async request=>locationCommand(request,async(db,row,input)=>{
    waitingRevision(row,input);
    const updated=await db.query('UPDATE pickups SET waiting_point=NULL,waiting_point_revision=waiting_point_revision+1,version=version+1 WHERE id=$1 RETURNING *',[row.id]);
    return snapshot(updated.rows[0]);
  }));
  app.post('/shared-pickup/location',async request=>locationCommand(request,async(db,row,input)=>{
    if(row.waiting_point_consent_version)throw new Problem(410,'LOCATION_COLLECTION_RETIRED','지도에서 기다릴 위치를 직접 지정해 주세요.');
    if(input.consent!==true||input.consentVersion!=='2026-11-08')
      throw new Problem(400,'LOCATION_CONSENT_REQUIRED','위치 공유 안내를 확인하고 동의해 주세요.');
    const lease=token(),sessionId=randomUUID();
    await db.query(`UPDATE pickups SET recipient_location=NULL,recipient_location_id=$2,recipient_location_lease_hash=$3,
      recipient_location_sequence=0,recipient_location_paused=false,version=version+1 WHERE id=$1`,[row.id,sessionId,hash(lease)]);
    return {lease,sessionId};
  }));
  function locationLease(row:Row,input:Record<string,unknown>) {
    if(typeof input.lease!=='string'||hash(input.lease)!==row.recipient_location_lease_hash)
      throw new Problem(409,'LOCATION_REPLACED','위치 공유가 중지되었거나 다른 화면에서 다시 시작됐어요.');
    if(typeof input.sequence!=='number'||!Number.isSafeInteger(input.sequence)||input.sequence<=Number(row.recipient_location_sequence))
      throw new Problem(409,'LOCATION_ORDER','이전 위치 요청은 적용하지 않았어요.');
  }
  app.put('/shared-pickup/location',async request=>locationCommand(request,async(db,row,input)=>{
    if(row.waiting_point_consent_version)throw new Problem(410,'LOCATION_COLLECTION_RETIRED','지도에서 기다릴 위치를 직접 지정해 주세요.');
    locationLease(row,input);
    if('paused' in input) {
      if(typeof input.paused!=='boolean')throw new Problem(400,'INVALID_LOCATION','위치 공유 상태를 확인해 주세요.');
      const updated=await db.query(`UPDATE pickups SET recipient_location_paused=$2,recipient_location_sequence=$3,version=version+1 WHERE id=$1 RETURNING *`,[row.id,input.paused,input.sequence]);
      return snapshot(updated.rows[0]);
    }
    if(row.recipient_location_paused)throw new Problem(409,'LOCATION_PAUSED','위치 공유를 다시 시작한 뒤 갱신해 주세요.');
    const sample=locationSample(input,Date.now());
    if(row.recipient_location && Date.parse(sample.observedAt)<Date.parse(row.recipient_location.observedAt))
      throw new Problem(409,'LOCATION_ORDER','이전 위치는 적용하지 않았어요.');
    if(row.recipient_location && Date.now()-Date.parse(row.recipient_location.receivedAt)<2_000)
      throw new Problem(429,'LOCATION_RATE_LIMIT','위치를 너무 자주 갱신하고 있어요.');
    const updated=await db.query(`UPDATE pickups SET recipient_location=$2,recipient_location_sequence=$3,version=version+1 WHERE id=$1 RETURNING *`,[row.id,sample,input.sequence]);
    return snapshot(updated.rows[0]);
  }));
  app.delete('/shared-pickup/location',async request=>locationCommand(request,async(db,row,input)=>{
    locationLease(row,input);
    const updated=await db.query(`UPDATE pickups SET recipient_location=NULL,recipient_location_id=NULL,recipient_location_lease_hash=NULL,
      recipient_location_sequence=0,recipient_location_paused=false,version=version+1 WHERE id=$1 RETURNING *`,[row.id]);
    return snapshot(updated.rows[0]);
  }));

  app.put('/shared-pickup/readiness',async request => {
    const value = object(request.body).readiness;
    if (!['UNKNOWN','PREPARING','OUTSIDE'].includes(String(value))) throw new Problem(400,'INVALID_READINESS','준비 상태를 선택해 주세요.');
    const pickup = await shared(request);
    return transaction(pool,async db=>{
      await db.query('SELECT id FROM pickups WHERE id=$1 FOR UPDATE',[pickup.id]);
      await shared(request,db);
      const result=await db.query(`UPDATE pickups SET readiness=$2,version=version+1 WHERE id=$1 AND state IN ('ACTIVE','ARRIVED') AND expires_at>now() RETURNING *`,[pickup.id,value]);
      if(!result.rowCount)throw new Problem(410,'SHARE_ENDED','공유가 종료되었습니다.');
      return snapshot(result.rows[0]);
    });
  });

  // Stream complete snapshots, so reconnecting clients never depend on missed deltas.
  // Database polling also works with more than one API process and across worker restarts.
  const streams = new Set<() => void>();
  function stream(reply: FastifyReply, read: () => Promise<unknown>) {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache, no-transform',
      Connection:'keep-alive', 'X-Accel-Buffering':'no', 'Referrer-Policy':'no-referrer',
    });
    reply.raw.flushHeaders();
    reply.raw.write('retry: 3000\n\n');
    let closed=false, busy=false, previous='', ticks=0;
    const close=() => { if(closed)return;closed=true;clearInterval(timer);streams.delete(close);reply.raw.end(); };
    const tick=async () => {
      if(closed || busy)return;busy=true;
      try {
        const value=JSON.stringify(await read());
        if (closed)return;
        if (reply.raw.writableLength>65_536) { close();return; }
        if(value!==previous) { reply.raw.write(`event: pickup\ndata: ${value}\n\n`);previous=value; }
        else if(++ticks%7===0)reply.raw.write(': heartbeat\n\n');
      } catch(error) {
        if (!closed && error instanceof Problem && [401,410].includes(error.statusCode)) {
          reply.raw.write('event: ended\ndata: {"state":"ENDED"}\n\n');close();
        } else if (!closed) {
          reply.raw.write('event: unavailable\ndata: {}\n\n');close();
        }
      } finally { busy=false; }
    };
    const timer=setInterval(()=>{void tick();},2_000);
    streams.add(close);reply.raw.on('close',close);void tick();
  }
  app.get('/shared-pickup/events',async (request,reply) => {
    await shared(request);stream(reply,async()=>snapshot(await shared(request)));
  });
  app.get('/vehicles/me/events',async (request,reply) => {
    await vehicle(request);
    stream(reply,async()=>{
      const car=await vehicle(request);
      const rows=await pool.query("SELECT * FROM pickups WHERE vehicle_id=$1 AND state IN ('ACTIVE','ARRIVED') AND expires_at>now()",[car.id]);
      return { pickup:rows.rowCount ? await ownerSnapshot(rows.rows[0]) : null };
    });
  });
  app.addHook('preClose',async()=>{for(const close of [...streams])close();});

  // A private local preview supports development before a provider is connected.
  // It must never be registered in production or on a public origin.
  if(config.smsMode==='local')app.get('/dev/messages',async request=>{
    const owner=await driver(request);
    const jobs=await pool.query(`SELECT j.id,j.kind,j.status,j.protected_payload,j.created_at
      FROM message_jobs j LEFT JOIN pickups p ON p.id=j.pickup_id
      LEFT JOIN login_challenges c ON c.id=j.challenge_id
      WHERE j.expires_at>now() AND j.protected_payload IS NOT NULL AND j.provider='local'
        AND (p.driver_id=$1 OR (c.phone=$2 AND c.auth_mode='local'))
      ORDER BY j.created_at DESC LIMIT 20`,[owner.id,owner.phone]);
    return { mode:'LOCAL_SIMULATION',messages:jobs.rows.map(j=>({id:j.id,kind:j.kind,status:j.status,
      createdAt:j.created_at,...security.open<Record<string,unknown>>(j.protected_payload)})) };
  });
  return app;
}
