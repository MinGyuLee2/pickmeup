import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { fresh, secrets } from './domain.js';
import { encodedMessage, smsLabel, type SmsPayload, type SmsSender, type SendResult, type Receipt } from './sms.js';

type Row=Record<string,any>;
type Prepared={payload:SmsPayload;near:boolean};
type Claim={id:string;pickupId:string|null;challengeId:string|null;token:string};
export class MessageWorker {
  private readonly security;
  constructor(private readonly pool:pg.Pool,secret:string,private readonly sender:SmsSender) {this.security=secrets(secret);}
  private async clock(db:pg.PoolClient) {return Number((await db.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS now')).rows[0].now);}
  private async owner(db:pg.PoolClient,job:Row,skip=false):Promise<Row|undefined> {
    if(job.pickup_id)return (await db.query(`SELECT p.*,d.auth_mode,d.name AS driver_name FROM pickups p JOIN drivers d ON d.id=p.driver_id
      WHERE p.id=$1 FOR UPDATE OF p ${skip?'SKIP LOCKED':''}`,[job.pickup_id])).rows[0];
    if(job.challenge_id)return (await db.query(`SELECT * FROM login_challenges WHERE id=$1 FOR UPDATE ${skip?'SKIP LOCKED':''}`,[job.challenge_id])).rows[0];
    return undefined;
  }
  private async cancel(db:pg.PoolClient,id:string,code:string) {
    await db.query(`UPDATE message_jobs SET status='CANCELLED',protected_payload=NULL,dispatch_token=NULL,lease_expires_at=NULL,
      last_error_code=$2,updated_at=clock_timestamp() WHERE id=$1`,[id,code]);
  }
  private async defer(db:pg.PoolClient,id:string,code:string) {
    await db.query(`UPDATE message_jobs SET status='PENDING',dispatch_token=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '5 seconds',
      last_error_code=$2,updated_at=clock_timestamp() WHERE id=$1`,[id,code]);
  }
  private async prepare(db:pg.PoolClient,job:Row,owner:Row,now:number):Promise<Prepared|null> {
    if(job.provider!==this.sender.mode || owner.auth_mode!==this.sender.mode) {
      await this.cancel(db,job.id,'MODE_MISMATCH');return null;
    }
    if(new Date(job.expires_at).getTime()<=now || new Date(owner.expires_at).getTime()<=now) {
      await this.cancel(db,job.id,'EXPIRED');return null;
    }
    if(job.kind==='OTP'&&(owner.consumed_at || owner.attempts>=5)) {
      await this.cancel(db,job.id,'OTP_CONSUMED');return null;
    }
    if(job.pickup_id&&!['ACTIVE','ARRIVED'].includes(owner.state)) {
      await this.cancel(db,job.id,'PICKUP_ENDED');return null;
    }
    if(job.pickup_id&&!owner.sms_confirmed) {
      await this.defer(db,job.id,'CONFIRMATION_REQUIRED');return null;
    }
    if(job.pickup_id&&(await db.query('SELECT 1 FROM share_grants WHERE pickup_id=$1 AND failed_attempts>=5',[job.pickup_id])).rowCount) {
      await this.defer(db,job.id,'SHARE_CODE_LOCKED');return null;
    }
    if(job.pickup_id&&!fresh(owner.latest_observation,now)) {
      await this.defer(db,job.id,'NAVIGATION_STALE');return null;
    }
    if(job.kind==='NEAR') {
      const initial=(await db.query("SELECT status FROM message_jobs WHERE pickup_id=$1 AND kind IN ('START','RESEND') ORDER BY CASE kind WHEN 'RESEND' THEN 0 ELSE 1 END LIMIT 1",[job.pickup_id])).rows[0];
      if(!initial || ['FAILED','CANCELLED'].includes(initial.status)) {
        await this.cancel(db,job.id,'INITIAL_MESSAGE_UNAVAILABLE');return null;
      }
      if(!['ACCEPTED','DELIVERED','SIMULATED'].includes(initial.status)) {
        await this.defer(db,job.id,'INITIAL_MESSAGE_PENDING');return null;
      }
      if(owner.latest_observation.remainingSeconds>300) {await this.defer(db,job.id,'NOT_NEAR_ANYMORE');return null;}
    }
    let payload:SmsPayload;
    try {payload=this.security.open<SmsPayload>(job.protected_payload);}
    catch {
      await db.query("UPDATE message_jobs SET status='FAILED',protected_payload=NULL,last_error_code='PAYLOAD_UNAVAILABLE',updated_at=clock_timestamp() WHERE id=$1",[job.id]);
      return null;
    }
    let near=false;
    if(job.pickup_id) {
      let link:string|undefined,number:string;
      try {
        link=owner.recipient_link_ciphertext?this.security.open<string>(owner.recipient_link_ciphertext):payload.shareLink;
        number=this.security.open<string>(owner.recipient_phone_ciphertext);
        if(typeof number!=='string'||!/^01[016789]\d{7,8}$/.test(number)|| (link!==undefined&&typeof link!=='string'))throw new Error('invalid recipient');
      } catch {
        await db.query("UPDATE message_jobs SET status='FAILED',protected_payload=NULL,last_error_code='RECIPIENT_DATA_UNAVAILABLE',updated_at=clock_timestamp() WHERE id=$1",[job.id]);return null;
      }
      if(!link) {
        await db.query("UPDATE message_jobs SET status='FAILED',protected_payload=NULL,last_error_code='LINK_UNAVAILABLE' WHERE id=$1",[job.id]);return null;
      }
      if(!owner.recipient_link_ciphertext)await db.query('UPDATE pickups SET recipient_link_ciphertext=$2 WHERE id=$1',[owner.id,this.security.seal(link)]);
      if(this.sender.mode!=='local') {
        const url=URL.canParse(link)?new URL(link):null;
        if(!url||url.protocol!=='https:'||['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
          await db.query("UPDATE message_jobs SET status='FAILED',protected_payload=NULL,last_error_code='PUBLIC_HTTPS_REQUIRED' WHERE id=$1",[job.id]);return null;
        }
      }
      const name=smsLabel(owner.driver_name,'운전자'),place=smsLabel(owner.destination.name,'만날 곳');
      const eta=Math.max(1,Math.ceil(owner.latest_observation.remainingSeconds/60));
      near=owner.latest_observation.remainingSeconds<=300;
      payload={phone:number,shareLink:link,
        message:job.kind==='NEAR'
          ?(owner.state==='ARRIVED'
            ?'[픽미업] 차량이 만날 곳 근처에 도착했습니다. 위치를 확인해 주세요.'
            :'[픽미업] 5분 이내 도착 예정입니다. 나올 준비를 해주세요.')
          :owner.state==='ARRIVED'
          ?`[픽미업] ${name}님이 ${place} 근처에 도착했습니다.\n위치·준비 상태: ${link}`
          :(job.kind==='START'||job.kind==='RESEND')
          ?`[픽미업] ${name}님이 ${place}에 약 ${eta}분 뒤 도착 예정입니다.${near?' 곧 도착해요.':''}\n위치·준비 상태: ${link}`
          :`[픽미업] ${name}님이 ${place}에 5분 이내 도착 예정입니다.\n위치·준비 상태: ${link}`};
    }
    if(job.pickup_id && owner.recipient_code_ciphertext)payload.message+=`\n인증코드: ${this.security.open<string>(owner.recipient_code_ciphertext)}`;
    try {encodedMessage(payload.message);}
    catch(error) {
      await db.query("UPDATE message_jobs SET status='FAILED',protected_payload=NULL,last_error_code=$2,updated_at=clock_timestamp() WHERE id=$1",[job.id,(error as Error).message]);return null;
    }
    return {payload,near};
  }
  private async claim():Promise<Claim|null> {
    const candidates=await this.pool.query(`SELECT id,pickup_id,challenge_id FROM message_jobs WHERE provider=$1 AND status='PENDING'
      AND (pickup_id IS NULL OR EXISTS (SELECT 1 FROM pickups p WHERE p.id=message_jobs.pickup_id AND p.sms_confirmed))
      AND available_at<=clock_timestamp() ORDER BY CASE kind WHEN 'OTP' THEN 0 WHEN 'START' THEN 1 ELSE 2 END,created_at LIMIT 20`,[this.sender.mode]);
    for(const candidate of candidates.rows) {
      const claim=await transaction(this.pool,async db=>{
        // All pickup mutations lock the pickup before its jobs. Keep that order here.
        const owner=await this.owner(db,candidate,true);if(!owner)return null;
        const rows=await db.query("SELECT * FROM message_jobs WHERE id=$1 AND status='PENDING' AND available_at<=clock_timestamp() FOR UPDATE SKIP LOCKED",[candidate.id]);
        if(!rows.rowCount)return null;const job=rows.rows[0];
        const prepared=await this.prepare(db,job,owner,await this.clock(db));if(!prepared)return null;
        const lease=randomUUID();
        // Commit uncertainty before the non-transactional provider call. A crash must never
        // turn a potentially accepted message back into an automatically retried PENDING job.
        await db.query(`UPDATE message_jobs SET status='UNKNOWN',dispatch_token=$2,lease_expires_at=clock_timestamp()+interval '30 seconds',
          attempts=attempts+1,protected_payload=$3,includes_near=$4,last_error_code='DISPATCH_IN_PROGRESS',updated_at=clock_timestamp() WHERE id=$1`,
        [job.id,lease,this.security.seal(prepared.payload),(job.kind==='START'||job.kind==='RESEND')&&prepared.near]);
        return {id:job.id,pickupId:job.pickup_id,challengeId:job.challenge_id,token:lease};
      });
      if(claim)return claim;
    }
    return null;
  }
  private async dispatch(claim:Claim) {
    await transaction(this.pool,async db=>{
      const owner=await this.owner(db,{pickup_id:claim.pickupId,challenge_id:claim.challengeId});if(!owner)return;
      const rows=await db.query("SELECT * FROM message_jobs WHERE id=$1 AND status='UNKNOWN' AND dispatch_token=$2 AND lease_expires_at>clock_timestamp() FOR UPDATE",[claim.id,claim.token]);
      if(!rows.rowCount)return;const job=rows.rows[0];
      const prepared=await this.prepare(db,job,owner,await this.clock(db));if(!prepared)return;
      await db.query('UPDATE message_jobs SET includes_near=$2 WHERE id=$1',[job.id,(job.kind==='START'||job.kind==='RESEND')&&prepared.near]);
      let result:SendResult;
      try {result=await this.sender.send(prepared.payload,job.id);}
      catch {result={kind:'unknown',code:'SENDER_UNCERTAIN'};}
      if(result.kind==='simulated') {
        await db.query(`UPDATE message_jobs SET status='SIMULATED',protected_payload=$2,dispatch_token=NULL,lease_expires_at=NULL,
          last_error_code=NULL,updated_at=clock_timestamp() WHERE id=$1`,[job.id,this.security.seal(prepared.payload)]);
      } else if(result.kind==='accepted') {
        await db.query(`UPDATE message_jobs SET status='ACCEPTED',provider_id=$2,protected_payload=NULL,dispatch_token=NULL,lease_expires_at=NULL,
          next_check_at=clock_timestamp()+interval '5 seconds',last_error_code=NULL,updated_at=clock_timestamp() WHERE id=$1`,[job.id,result.requestId]);
      } else if(result.kind==='rejected') {
        const retry=result.retryable && job.attempts<3;
        await db.query(`UPDATE message_jobs SET status=$2,protected_payload=$3,dispatch_token=NULL,lease_expires_at=NULL,
          available_at=clock_timestamp()+$4*interval '1 second',last_error_code=$5,updated_at=clock_timestamp() WHERE id=$1`,
        [job.id,retry?'PENDING':'FAILED',retry?this.security.seal(prepared.payload):null,Math.min(60,5*2**(job.attempts-1)),result.code]);
      } else {
        await db.query(`UPDATE message_jobs SET status='UNKNOWN',protected_payload=NULL,dispatch_token=NULL,lease_expires_at=NULL,
          last_error_code=$2,updated_at=clock_timestamp() WHERE id=$1`,[job.id,result.code]);
      }
      if((job.kind==='START'||job.kind==='RESEND')&&result.kind!=='rejected') {
        if(prepared.near) {
          await db.query('UPDATE pickups SET near_notified_at=coalesce(near_notified_at,clock_timestamp()) WHERE id=$1',[job.pickup_id]);
          await db.query(`UPDATE message_jobs SET status='CANCELLED',protected_payload=NULL,last_error_code='MERGED_IN_START',updated_at=clock_timestamp()
            WHERE pickup_id=$1 AND kind='NEAR' AND status='PENDING'`,[job.pickup_id]);
        } else {
          await db.query(`UPDATE pickups SET near_notified_at=NULL WHERE id=$1 AND NOT EXISTS
            (SELECT 1 FROM message_jobs WHERE pickup_id=$1 AND kind='NEAR')`,[job.pickup_id]);
        }
      }
    });
  }
  private async recoverInterrupted() {
    await this.pool.query(`WITH abandoned AS (SELECT id FROM message_jobs WHERE provider=$1 AND status='UNKNOWN' AND provider_id IS NULL
      AND lease_expires_at<=clock_timestamp() FOR UPDATE SKIP LOCKED)
      UPDATE message_jobs SET protected_payload=NULL,dispatch_token=NULL,lease_expires_at=NULL,last_error_code='PROCESS_INTERRUPTED',
      updated_at=clock_timestamp() WHERE id IN (SELECT id FROM abandoned)`,[this.sender.mode]);
  }
  private async reconcile():Promise<boolean> {
    return transaction(this.pool,async db=>{
      const rows=await db.query(`SELECT * FROM message_jobs WHERE provider=$1 AND status IN ('ACCEPTED','UNKNOWN') AND provider_id IS NOT NULL
        AND next_check_at<=clock_timestamp() ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT 1`,[this.sender.mode]);
      if(!rows.rowCount)return false;const job=rows.rows[0];
      if(new Date(job.reconcile_until).getTime()<=await this.clock(db)) {
        await db.query(`UPDATE message_jobs SET status='UNKNOWN',last_error_code='DELIVERY_UNCONFIRMED',next_check_at='infinity',
          protected_payload=NULL,updated_at=clock_timestamp() WHERE id=$1`,[job.id]);return true;
      }
      const result:Receipt=await this.sender.lookup(job.provider_id).catch(()=>({state:'UNKNOWN',code:'LOOKUP_UNAVAILABLE'}));
      const state=result.state==='UNKNOWN'&&job.status==='ACCEPTED'?'ACCEPTED':result.state;
      await db.query(`UPDATE message_jobs SET status=$2,provider_message_id=coalesce($3,provider_message_id),last_error_code=$4,
        next_check_at=clock_timestamp()+interval '15 seconds',delivered_at=CASE WHEN $2='DELIVERED' THEN clock_timestamp() ELSE delivered_at END,
        protected_payload=NULL,updated_at=clock_timestamp() WHERE id=$1`,[job.id,state,result.messageId??null,result.code??null]);
      return true;
    });
  }
  async runOnce() {
    await this.recoverInterrupted();
    const claim=await this.claim();if(claim)await this.dispatch(claim);
    const reconciled=await this.reconcile();
    return {processed:claim!==null,reconciled};
  }
}
