import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import {randomUUID,ECDH} from 'node:crypto';
import {object,text,hash,Problem,secrets} from './domain.js';
import {transaction} from './db.js';
import type {Config} from './app.js';
export type BrowserSubscription={endpoint:string;keys:{p256dh:string;auth:string}};
export function subscriptionInput(value:unknown):BrowserSubscription {
  const input=object(value),endpoint=text(input.endpoint,'푸시 주소',2048);let url:URL;
  try{url=new URL(endpoint);}catch{throw new Problem(400,'INVALID_PUSH_ENDPOINT','푸시 주소를 확인해 주세요.');}
  const host=url.hostname;
  // Never allow a browser-supplied endpoint to make the server call arbitrary/private hosts.
  const supported=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(host)||host.endsWith('.push.apple.com');
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!supported)throw new Problem(400,'INVALID_PUSH_ENDPOINT','지원하는 브라우저의 푸시 주소를 확인해 주세요.');
  const keys=object(input.keys),p256dh=text(keys.p256dh,'브라우저 공개 키',100),auth=text(keys.auth,'브라우저 인증 키',30);
  if(!/^[A-Za-z0-9_-]+$/.test(p256dh)||!/^[A-Za-z0-9_-]+$/.test(auth)||Buffer.from(p256dh,'base64url').length!==65||Buffer.from(p256dh,'base64url')[0]!==4||Buffer.from(auth,'base64url').length!==16)
    throw new Problem(400,'INVALID_PUSH_KEYS','브라우저 알림 연결을 다시 확인해 주세요.');
  try{ECDH.convertKey(Buffer.from(p256dh,'base64url'),'prime256v1');}catch{throw new Problem(400,'INVALID_PUSH_KEYS','브라우저 공개 키를 확인해 주세요.');}
  return {endpoint,keys:{p256dh,auth}};
}
export function webPushRoutes(app:FastifyInstance,pool:pg.Pool,config:Config,shared:(request:FastifyRequest,db?:pg.PoolClient)=>Promise<Record<string,any>>) {
  const security=secrets(config.secret);
  app.get('/shared-pickup/push/config',async request=>{await shared(request);return {available:!!config.webPushPublicKey,publicKey:config.webPushPublicKey??null};});
  app.post('/shared-pickup/push/status',async request=>{
    const pickup=await shared(request),endpoint=text(object(request.body).endpoint,'푸시 주소',2048);
    const row=(await pool.query('SELECT state,revoked_at,sent_at,protected_subscription FROM pickup_push_subscriptions WHERE pickup_id=$1 AND endpoint_hash=$2',[pickup.id,hash(endpoint)])).rows[0];
    return {enabled:!!row&&!row.revoked_at&&['WAITING','CLAIMED','SENT','UNKNOWN'].includes(row.state),state:row?.state??'OFF'};
  });
  app.post('/shared-pickup/push',async request=>{
    const pickup=await shared(request),input=object(request.body);
    if(pickup.state==='ARRIVED')throw new Problem(409,'ALREADY_ARRIVED','차량이 이미 도착했어요.');
    if(!config.webPushPublicKey)throw new Problem(503,'PUSH_NOT_CONFIGURED','브라우저 알림을 준비 중입니다.');
    if(input.confirmed!==true)throw new Problem(400,'CONFIRMATION_REQUIRED','알림 받기를 선택해 주세요.');
    const subscription=subscriptionInput(input.subscription),endpointHash=hash(subscription.endpoint);
    return transaction(pool,async db=>{
      const row=(await db.query("SELECT id,expires_at FROM pickups WHERE id=$1 AND state IN ('ACTIVE','ARRIVED') AND expires_at>now() FOR UPDATE",[pickup.id])).rows[0];
      if(!row)throw new Problem(410,'SHARE_ENDED','공유가 종료되었습니다.');
      await shared(request,db);
      const existing=(await db.query('SELECT id FROM pickup_push_subscriptions WHERE pickup_id=$1 AND endpoint_hash=$2',[pickup.id,endpointHash])).rows[0];
      if(!existing&&(await db.query('SELECT count(*)::int n FROM pickup_push_subscriptions WHERE pickup_id=$1',[pickup.id])).rows[0].n>=5)throw new Problem(429,'PUSH_LIMIT','이번 픽업의 알림 등록이 많아요.');
      const saved=(await db.query(`INSERT INTO pickup_push_subscriptions(id,pickup_id,endpoint_hash,protected_subscription,expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(pickup_id,endpoint_hash) DO UPDATE SET
        revoked_at=NULL,protected_subscription=CASE WHEN pickup_push_subscriptions.state IN ('WAITING','CLAIMED') THEN EXCLUDED.protected_subscription ELSE NULL END,
        expires_at=EXCLUDED.expires_at RETURNING state`,[randomUUID(),pickup.id,endpointHash,security.seal(subscription),row.expires_at])).rows[0];
      return {enabled:['WAITING','CLAIMED','SENT','UNKNOWN'].includes(saved.state),state:saved.state};
    });
  });
  app.delete('/shared-pickup/push',async request=>{
    const pickup=await shared(request),endpoint=text(object(request.body).endpoint,'푸시 주소',2048);
    await transaction(pool,async db=>{
      await db.query('SELECT id FROM pickups WHERE id=$1 FOR UPDATE',[pickup.id]);
      await shared(request,db);
      await db.query('UPDATE pickup_push_subscriptions SET revoked_at=now(),protected_subscription=NULL WHERE pickup_id=$1 AND endpoint_hash=$2',[pickup.id,hash(endpoint)]);
    });
    return {enabled:false};
  });
}
