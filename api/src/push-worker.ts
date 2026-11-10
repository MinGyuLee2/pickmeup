import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {fresh,secrets,hash} from './domain.js';
import {transaction} from './db.js';
import type {BrowserSubscription} from './web-push.js';
export type PushPayload={type:'arrival-near';pickupId:string;validUntil:number;title:string;body:string};
export type PushSender=(subscription:BrowserSubscription,payload:PushPayload,topic:string)=>Promise<void>;
/** Web Push is independent of the SMS queue and can never dispatch an SMS job. */
export class PushWorker {
  private security;
  constructor(private pool:pg.Pool,secret:string,private mode:string,private send:PushSender){this.security=secrets(secret);}
  async runOnce() {
    await this.pool.query(`UPDATE pickup_push_subscriptions SET state='UNKNOWN',protected_subscription=NULL,last_error_code='DISPATCH_UNCERTAIN'
      WHERE state='CLAIMED' AND lease_expires_at<=now()`);
    await this.pool.query(`UPDATE pickup_push_subscriptions s SET revoked_at=coalesce(s.revoked_at,now()),protected_subscription=NULL
      FROM pickups p WHERE p.id=s.pickup_id AND (s.expires_at<=now() OR p.expires_at<=now() OR p.state NOT IN ('ACTIVE','ARRIVED'))`);
    await this.pool.query("DELETE FROM pickup_push_subscriptions WHERE expires_at<now()-interval '1 day'");
    for(let n=0;n<10;n++) {
      const claim=randomUUID();
      const candidate=await transaction(this.pool,async db=>{
        const row=(await db.query(`SELECT s.*,p.latest_observation,p.state AS pickup_state,p.expires_at AS pickup_expires
          FROM pickup_push_subscriptions s JOIN pickups p ON p.id=s.pickup_id JOIN drivers d ON d.id=p.driver_id
          WHERE s.state='WAITING' AND s.revoked_at IS NULL AND s.protected_subscription IS NOT NULL AND s.available_at<=now()
          AND s.expires_at>now() AND p.state='ACTIVE' AND p.expires_at>now() AND d.auth_mode=$1
          AND (p.latest_observation->>'remainingSeconds')::integer BETWEEN 1 AND 300
          AND (p.latest_observation->>'locationReceivedAt')::timestamptz BETWEEN now()-interval '30 seconds' AND now()
          AND (p.latest_observation->>'etaReceivedAt')::timestamptz BETWEEN now()-interval '30 seconds' AND now()
          ORDER BY s.created_at FOR UPDATE OF s SKIP LOCKED LIMIT 1`,[this.mode])).rows[0];
        if(!row)return null;
        if(!fresh(row.latest_observation,Date.now())){await db.query("UPDATE pickup_push_subscriptions SET available_at=now()+interval '5 seconds' WHERE id=$1",[row.id]);return null;}
        await db.query("UPDATE pickup_push_subscriptions SET state='CLAIMED',claim_token=$2,lease_expires_at=now()+interval '15 seconds',attempts=attempts+1 WHERE id=$1",[row.id,claim]);return row;
      });
      if(!candidate)break;
      // Re-check right before the external request; stop/expiry can revoke a claimed subscription.
      const valid=(await this.pool.query(`SELECT s.*,p.latest_observation,p.state AS pickup_state,p.expires_at AS pickup_expires
        FROM pickup_push_subscriptions s JOIN pickups p ON p.id=s.pickup_id
        WHERE s.id=$1 AND s.claim_token=$2 AND s.state='CLAIMED' AND s.revoked_at IS NULL AND s.protected_subscription IS NOT NULL`,[candidate.id,claim])).rows[0];
      if(!valid||valid.pickup_state!=='ACTIVE'||new Date(valid.pickup_expires).getTime()<=Date.now()||!fresh(valid.latest_observation,Date.now())||valid.latest_observation.remainingSeconds>300||valid.latest_observation.remainingSeconds<=0) {
        await this.pool.query("UPDATE pickup_push_subscriptions SET state='WAITING',claim_token=NULL,lease_expires_at=NULL WHERE id=$1 AND claim_token=$2",[candidate.id,claim]);continue;
      }
      try {
        const payload:PushPayload={type:'arrival-near',pickupId:valid.pickup_id,validUntil:Math.min(Date.now()+60000,new Date(valid.pickup_expires).getTime()),title:'곧 도착해요 · 픽미업',body:'차량이 약 5분 이내에 도착할 예정이에요. 만날 준비를 해 주세요.'};
        await this.send(this.security.open<BrowserSubscription>(valid.protected_subscription),payload,hash(valid.pickup_id).slice(0,32));
        await this.pool.query("UPDATE pickup_push_subscriptions SET state='SENT',sent_at=now(),protected_subscription=NULL,claim_token=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE id=$1 AND claim_token=$2",[valid.id,claim]);
      }catch(error) {
        const status=Number((error as {statusCode?:number})?.statusCode??0),retry=(status===429||status>=500)&&Number(valid.attempts)<3;
        const state=retry?'WAITING':status?'FAILED':'UNKNOWN',code=[404,410].includes(status)?'ENDPOINT_GONE':retry?'PROVIDER_RETRY':status?'PROVIDER_FAILED':'DISPATCH_UNCERTAIN';
        await this.pool.query(`UPDATE pickup_push_subscriptions SET state=$3,last_error_code=$4,available_at=now()+interval '30 seconds',
          protected_subscription=CASE WHEN $3='WAITING' THEN protected_subscription ELSE NULL END,claim_token=NULL,lease_expires_at=NULL,
          revoked_at=CASE WHEN $4='ENDPOINT_GONE' THEN now() ELSE revoked_at END WHERE id=$1 AND claim_token=$2`,[valid.id,claim,state,code]);
      }
    }
  }
}
