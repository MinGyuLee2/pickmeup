import Fastify from 'fastify';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type pg from 'pg';
import {transaction} from './db.js';
import {encodedMessage,type SmsPayload,type SmsSender,type SendResult,type Receipt} from './sms.js';

// Only the development backend knows this existing server secret. Never ship it to an APK/web bundle.
function signature(secret:string,stamp:string,body:string) {
  const key=createHmac('sha256',secret).update('pickmeup/filming-sms/v1').digest();
  return createHmac('sha256',key).update(stamp+'\n'+body).digest('hex');
}
export function filmingSmsHeaders(secret:string,body:string,now=Date.now()) {
  const stamp=String(now);
  return {'content-type':'application/json','x-filming-time':stamp,'x-filming-signature':signature(secret,stamp,body)};
}
function authenticated(secret:string,body:string,stamp:unknown,proof:unknown,now:number) {
  if(typeof stamp!=='string'||!/^\d{13}$/.test(stamp)||Math.abs(now-Number(stamp))>30_000||typeof proof!=='string'||!/^[a-f0-9]{64}$/.test(proof))return false;
  return timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(signature(secret,stamp,body),'hex'));
}
function validSendResult(value:any):value is SendResult {
  return value?.kind==='accepted'&&/^[A-Za-z0-9_-]{1,100}$/.test(value.requestId??'') ||
    value?.kind==='unknown'&&typeof value.code==='string' ||
    value?.kind==='rejected'&&typeof value.code==='string'&&typeof value.retryable==='boolean';
}
export class FilmingSmsSender implements SmsSender {
  readonly mode='solapi' as const;
  constructor(private readonly endpoint:string,private readonly secret:string,private readonly transport:typeof fetch=fetch) {
    const url=new URL(endpoint);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Filming SMS relay requires a private authenticated HTTPS endpoint');
  }
  private async call(value:unknown) {
    const body=JSON.stringify(value);
    const r=await this.transport(this.endpoint,{method:'POST',headers:filmingSmsHeaders(this.secret,body),body,redirect:'error',signal:AbortSignal.timeout(8_000)});
    if(!r.ok)throw Error('FILMING_RELAY_HTTP_'+r.status);
    return r.json() as Promise<any>;
  }
  async health(){const value=await this.call({operation:'health'});return value.ready===true&&value.provider==='solapi';}
  async send(payload:SmsPayload,dispatchId?:string):Promise<SendResult> {
    if(!dispatchId||!/^[a-f0-9-]{36}$/i.test(dispatchId))return {kind:'rejected',code:'DISPATCH_ID_REQUIRED',retryable:false};
    try {const r=await this.call({operation:'send',dispatchId,payload});return validSendResult(r)?r:{kind:'unknown',code:'RELAY_RESPONSE_INVALID'};}
    catch{return {kind:'unknown',code:'RELAY_DELIVERY_UNCERTAIN'};}
  }
  async lookup(requestId:string):Promise<Receipt> {
    try {
      const r=await this.call({operation:'lookup',requestId});
      return ['ACCEPTED','DELIVERED','FAILED','UNKNOWN'].includes(r.state)?r:{state:'UNKNOWN',code:'RELAY_RECEIPT_INVALID'};
    }catch{return {state:'UNKNOWN',code:'RELAY_LOOKUP_UNAVAILABLE'};}
  }
}

// The pool is restricted to a dedicated relay schema. No production account/pickup table is read or written.
export class FilmingSmsLedger {
  private readonly identityKey:Buffer;
  constructor(private readonly pool:pg.Pool,secret:string){
    if(!secret)throw Error('Existing backend secret required for private dispatch identity');
    this.identityKey=createHmac('sha256',secret).update('pickmeup/filming-sms/identity/v1').digest();
  }
  async initialize(){await this.pool.query(`CREATE TABLE IF NOT EXISTS dispatches (
    id uuid PRIMARY KEY,payload_hash text NOT NULL,identity_hash text,result jsonb NOT NULL,attempts integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    // Existing rows have no recoverable phone/link. They may replay the same payload,
    // but cannot refresh it until a new dispatch establishes an immutable identity.
    await this.pool.query('ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS identity_hash text');
  }
  async send(id:string,payload:SmsPayload,sender:SmsSender):Promise<SendResult> {
    const digest=createHash('sha256').update(JSON.stringify([payload.phone,payload.message,payload.shareLink??null])).digest('hex');
    const links=[...(payload.message.match(/https?:\/\/[^\s]+/g)??[]),...(payload.shareLink?[payload.shareLink]:[])];
    const identity=createHmac('sha256',this.identityKey).update(JSON.stringify([payload.phone,[...new Set(links)].sort()])).digest('hex');
    const initial:SendResult={kind:'unknown',code:'RELAY_DISPATCH_IN_PROGRESS'};
    const claim=await transaction(this.pool,async db=>{
      // All relay dispatches share this quota lock, including concurrent processes.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('pickmeup-filming-sms-quota-v1'))");
      const old=(await db.query('SELECT * FROM dispatches WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const retry=old?.result.kind==='rejected'&&old.result.retryable&&old.attempts<3;
      if(old&&(old.identity_hash?old.identity_hash!==identity:old.payload_hash!==digest))return {result:{kind:'rejected',code:'DISPATCH_ID_CONFLICT',retryable:false} as SendResult};
      if(old&&old.payload_hash!==digest&&!retry)return {result:{kind:'rejected',code:'DISPATCH_ID_CONFLICT',retryable:false} as SendResult};
      if(old&&!retry)return {result:old.result as SendResult};
      const quota=(await db.query("SELECT coalesce(sum(attempts),0)::int AS count FROM dispatches WHERE created_at>clock_timestamp()-interval '1 hour'")).rows[0].count;
      if(quota>=20)return {result:{kind:'rejected',code:'FILMING_HOURLY_LIMIT',retryable:false} as SendResult};
      if(old)await db.query('UPDATE dispatches SET result=$2,payload_hash=$3,attempts=attempts+1,updated_at=clock_timestamp() WHERE id=$1',[id,initial,digest]);
      else await db.query('INSERT INTO dispatches(id,payload_hash,identity_hash,result) VALUES($1,$2,$3,$4)',[id,digest,identity,initial]);
      return {claimed:true};
    });
    if(claim.result)return claim.result;
    // Persist uncertainty before calling the provider. A restart cannot replay an accepted SMS.
    let result:SendResult;
    try{result=await sender.send(payload,id);}catch{result={kind:'unknown',code:'RELAY_PROVIDER_UNCERTAIN'};}
    if(result.kind==='simulated')result={kind:'rejected',code:'REAL_PROVIDER_REQUIRED',retryable:false};
    await this.pool.query('UPDATE dispatches SET result=$2,updated_at=clock_timestamp() WHERE id=$1',[id,result]);
    return result;
  }
  async knows(requestId:string){return (await this.pool.query("SELECT 1 FROM dispatches WHERE result->>'kind'='accepted' AND result->>'requestId'=$1",[requestId])).rowCount!>0;}
}
function reviewedPayload(input:any,origin:string):SmsPayload|null {
  if(!input||typeof input.phone!=='string'||!/^01[016789]\d{7,8}$/.test(input.phone)||typeof input.message!=='string'||!input.message.startsWith('[픽미업]'))return null;
  try{encodedMessage(input.message);}catch{return null;}
  // No arbitrary bulk/proxy messages. Each URL must belong to the current isolated web flow.
  const links=input.message.match(/https?:\/\/[^\s]+/g)??[];
  if(input.shareLink!==undefined)links.push(input.shareLink);
  if(!links.length&&!/^\[픽미업\] 인증번호 \d{6} \(5분 이내 입력\)$/.test(input.message))return null;
  for(const link of links){
    if(typeof link!=='string'||!URL.canParse(link))return null;
    const u=new URL(link);
    if(u.origin!==origin||u.protocol!=='https:'||!['/filming/s','/filming/setup'].includes(u.pathname)||u.username||u.password)return null;
  }
  return {phone:input.phone,message:input.message,...(input.shareLink?{shareLink:input.shareLink}:{})};
}
export function buildFilmingSmsRelay(ledger:FilmingSmsLedger,sender:SmsSender,secret:string,publicOrigin:string,now=Date.now) {
  if(sender.mode!=='solapi'||!secret||new URL(publicOrigin).protocol!=='https:')throw Error('Existing real provider and private backend secret are required');
  const origin=new URL(publicOrigin).origin,app=Fastify({logger:false,bodyLimit:8_192});
  // Verify the exact signed bytes, not a re-serialized object supplied by an unauthenticated caller.
  app.removeContentTypeParser('application/json');app.addContentTypeParser('application/json',{parseAs:'string'},(_req,body,done)=>done(null,body));
  app.post('/',async(request,reply)=>{
    const raw=typeof request.body==='string'?request.body:'';
    if(!authenticated(secret,raw,request.headers['x-filming-time'],request.headers['x-filming-signature'],now()))return reply.code(401).send({code:'AUTH_REQUIRED'});
    let input:any;try{input=JSON.parse(raw);}catch{return reply.code(400).send({code:'INVALID_REQUEST'});}
    if(input.operation==='health')return {ready:true,provider:'solapi'};
    if(input.operation==='lookup') {
      if(typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId)||!await ledger.knows(input.requestId))return reply.code(404).send({code:'RECEIPT_NOT_FOUND'});
      return sender.lookup(input.requestId);
    }
    const payload=reviewedPayload(input.payload,origin);
    if(input.operation!=='send'||typeof input.dispatchId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.dispatchId)||!payload)return reply.code(400).send({code:'INVALID_DISPATCH'});
    return ledger.send(input.dispatchId,payload,sender);
  });
  app.setErrorHandler((_error,_request,reply)=>reply.code(503).send({code:'RELAY_UNAVAILABLE'}));
  return app;
}
