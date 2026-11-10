import type {FastifyInstance,FastifyRequest} from 'fastify';
import type pg from 'pg';
import {transaction} from './db.js';
import {hash,object,Problem,same,secrets,token,uuid} from './domain.js';
import type {Config} from './app.js';

export const shareCookie=(id:string)=>'pmu_share_'+id.replaceAll('-','').toLowerCase();
const challengeCookie=(id:string)=>'pmu_share_challenge_'+id.replaceAll('-','').toLowerCase();
export function requestPickupId(r:FastifyRequest):string|undefined {
  const query=(r.query as Record<string,unknown>|undefined)?.pickupId;
  const body=r.body&&typeof r.body==='object'?(r.body as Record<string,unknown>).pickupId:undefined;
  if(query!==undefined&&body!==undefined&&uuid(query).toLowerCase()!==uuid(body).toLowerCase())
    throw new Problem(409,'PICKUP_MISMATCH','다른 픽업 요청은 처리하지 않았어요. 받은 링크를 다시 열어 주세요.');
  return query===undefined&&body===undefined?undefined:uuid(query??body).toLowerCase();
}
export function shareAccess(app:FastifyInstance,pool:pg.Pool,config:Config) {
  const security=secrets(config.secret);
  const getCookie=(r:FastifyRequest,name:string)=>(r.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)??'';
  const cookie=(name:string,value:string,seconds:number)=>`${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${config.production?'; Secure':''}`;
  function challenge(r:FastifyRequest,id?:string) {
    try {
      const value=security.open<{purpose:string;grant:string;expiresAt:number;pickupId?:string}>(getCookie(r,id?challengeCookie(id):'pmu_share_challenge'));
      return value.purpose==='share-code'&&/^[a-f0-9]{64}$/.test(value.grant)&&value.expiresAt>Date.now()&&(!id||value.pickupId===id)?value:null;
    }catch{return null;}
  }
  async function shared(r:FastifyRequest,db?:pg.PoolClient) {
    let id=requestPickupId(r);
    if(!id){
      if(r.method!=='GET')throw new Problem(400,'PICKUP_SCOPE_REQUIRED','받은 픽업 링크를 다시 열어 주세요.');
      const names=[...new Set((r.headers.cookie??'').split(';').map(v=>v.trim().split('=')[0]).filter(v=>/^pmu_share_[a-f0-9]{32}$/.test(v)))];
      if(names.length>1)throw new Problem(409,'PICKUP_SCOPE_REQUIRED','확인할 픽업의 문자 링크를 열어 주세요.');
      if(names.length===1){const v=names[0].slice(10);id=`${v.slice(0,8)}-${v.slice(8,12)}-${v.slice(12,16)}-${v.slice(16,20)}-${v.slice(20)}`;}
    }
    // Legacy sessions remain readable, but never authorize a different requested pickup.
    const session=(id?getCookie(r,shareCookie(id)):'')||getCookie(r,'pmu_share');
    const result=await (db??pool).query(`SELECT p.* FROM recipient_sessions s JOIN pickups p ON p.id=s.pickup_id JOIN drivers d ON d.id=p.driver_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND p.expires_at>now() AND p.state IN ('ACTIVE','ARRIVED') AND d.auth_mode=$2 AND ($3::uuid IS NULL OR p.id=$3)`,[hash(session),config.smsMode,id??null]);
    if(!result.rowCount&&challenge(r,id))throw new Problem(401,'SHARE_CODE_REQUIRED','문자에 적힌 인증코드를 입력해 주세요.');
    if(!result.rowCount)throw new Problem(410,'SHARE_ENDED','공유가 종료되었거나 인증 링크가 바뀌었어요. 가장 최근에 받은 링크를 열어 주세요.');
    return result.rows[0];
  }
  app.post('/shares/redeem',async(request,reply)=>{
    if(request.headers.origin!==new URL(config.publicOrigin).origin)throw new Problem(403,'ORIGIN_DENIED','이 사이트에서 다시 시도해 주세요.');
    const input=object(request.body),expected=requestPickupId(request);
    const grant=typeof input.token==='string'&&input.token.length<=100?hash(input.token):challenge(request,expected)?.grant;
    if(!grant)throw new Problem(401,'SHARE_LINK_REQUIRED','문자로 받은 픽업 링크를 다시 열어 주세요.');
    const result=await transaction(pool,async db=>{
      const found=(await db.query('SELECT pickup_id FROM share_grants WHERE token_hash=$1',[grant])).rows[0];
      if(!found)return {error:'ended' as const};
      if(expected&&found.pickup_id!==expected)throw new Problem(409,'PICKUP_MISMATCH','다른 픽업의 인증은 처리하지 않았어요. 받은 링크를 다시 열어 주세요.');
      // Match every writer's lock order: pickup first, then grants/sessions/jobs.
      const row=(await db.query(`SELECT p.* FROM pickups p JOIN drivers d ON d.id=p.driver_id
        WHERE p.id=$1 AND p.expires_at>now() AND p.state IN ('ACTIVE','ARRIVED') AND d.auth_mode=$2 FOR UPDATE OF p`,[found.pickup_id,config.smsMode])).rows[0];
      const access=(await db.query('SELECT failed_attempts FROM share_grants WHERE token_hash=$1 AND expires_at>now() FOR UPDATE',[grant])).rows[0];
      if(!row||!access||Date.parse(row.expires_at)<=Date.now())return {error:'ended' as const};
      row.failed_attempts=access.failed_attempts;
      const sessionCookie=getCookie(request,shareCookie(row.id))||getCookie(request,'pmu_share');
      const known=(await db.query('SELECT 1 FROM recipient_sessions WHERE token_hash=$1 AND pickup_id=$2 AND expires_at>now()',[hash(sessionCookie),row.id])).rowCount;
      if(known)return {known:true,pickupId:row.id as string};
      if(row.recipient_code_hash){
        if(input.code===undefined)return {pickupId:row.id as string,locked:row.failed_attempts>=5,challenge:security.seal({purpose:'share-code',grant,pickupId:row.id,expiresAt:Date.parse(row.expires_at)})};
        if(row.failed_attempts>=5)return {error:'locked' as const};
        if(typeof input.code!=='string'||!/^\d{4}$/.test(input.code)||!same(row.recipient_code_hash,security.digest(`share:${row.id}:${input.code}`))){
          const failed=await db.query('UPDATE share_grants SET failed_attempts=failed_attempts+1 WHERE token_hash=$1 RETURNING failed_attempts',[grant]);
          return {error:failed.rows[0].failed_attempts>=5?'locked' as const:'code' as const};
        }
      }
      const session=token();await db.query('INSERT INTO recipient_sessions(token_hash,pickup_id,expires_at) VALUES($1,$2,$3)',[hash(session),row.id,row.expires_at]);
      return {session,pickupId:row.id as string,seconds:Math.max(1,Math.floor((Date.parse(row.expires_at)-Date.now())/1000))};
    });
    if(result.error==='ended')throw new Problem(410,'SHARE_ENDED','공유가 종료되었거나 인증 링크가 바뀌었어요. 가장 최근에 받은 링크를 열어 주세요.');
    if(result.error==='locked')throw new Problem(429,'SHARE_CODE_LOCKED','인증이 잠겼어요. 운전자에게 새 링크와 코드를 요청해 주세요.');
    if(result.error==='code')throw new Problem(400,'INVALID_SHARE_CODE','문자에 적힌 인증코드 4자리를 확인해 주세요.');
    if(result.challenge){reply.header('Set-Cookie',cookie(challengeCookie(result.pickupId!),result.challenge,7200));return {verificationRequired:true,pickupId:result.pickupId,locked:result.locked};}
    if(result.session)reply.header('Set-Cookie',[cookie(shareCookie(result.pickupId!),result.session,result.seconds!),cookie(challengeCookie(result.pickupId!),'',0)]);
    return {ok:true,verificationRequired:false,pickupId:result.pickupId};
  });
  return {shared};
}
