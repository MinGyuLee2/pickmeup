import pg from 'pg';import * as webpush from 'web-push';
import {writeFile,rm} from 'node:fs/promises';import {setTimeout} from 'node:timers/promises';
import {migrate} from './db.js';import {PushWorker} from './push-worker.js';
if(!process.env.DATABASE_URL||!process.env.APP_SECRET||!process.env.WEB_PUSH_PUBLIC_KEY||!process.env.WEB_PUSH_PRIVATE_KEY||!process.env.WEB_PUSH_SUBJECT)throw new Error('Web Push configuration is required');
webpush.setVapidDetails(process.env.WEB_PUSH_SUBJECT,process.env.WEB_PUSH_PUBLIC_KEY,process.env.WEB_PUSH_PRIVATE_KEY);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:2000});await migrate(pool);
const worker=new PushWorker(pool,process.env.APP_SECRET,process.env.SMS_MODE??'solapi',async(s,p,topic)=>{await webpush.sendNotification(s,JSON.stringify(p),{TTL:60,urgency:'high',topic,timeout:5000});});
let stopping=false;for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{stopping=true;});
console.log('PickMeUp Web Push worker ready; SMS dispatch disabled in this process');
const healthFile=process.env.WORKER_HEALTH_FILE??'.local/web-push-worker.health';
try {while(!stopping){try{await worker.runOnce();await writeFile(healthFile,String(Date.now()),{mode:0o600});}catch{console.error('Web Push cycle failed; no endpoint or payload logged');}if(!stopping)await setTimeout(1000);}}
finally{await rm(healthFile,{force:true});await pool.end();}
