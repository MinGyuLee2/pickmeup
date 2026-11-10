import pg from 'pg';
import { writeFile, rm } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { migrate } from './db.js';
import { expirePickups } from './app.js';
import { MessageWorker } from './message-worker.js';
import { senderFromEnvironment } from './sms.js';

if(!process.env.DATABASE_URL||!process.env.APP_SECRET)throw new Error('DATABASE_URL and APP_SECRET are required');
const sender=senderFromEnvironment(process.env);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:2000});
await migrate(pool);
const worker=new MessageWorker(pool,process.env.APP_SECRET,sender);
const healthFile=process.env.WORKER_HEALTH_FILE;
if(healthFile)await rm(healthFile,{force:true});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{stopping=true;});
console.log(`PickMeUp message worker: ${sender.mode==='local'?'LOCAL SIMULATION (no text sent)':sender.mode.toUpperCase()}`);
try {
  while(!stopping) {
    try {await expirePickups(pool);await worker.runOnce();if(healthFile)await writeFile(healthFile,String(Date.now()),{mode:0o600});}
    catch {console.error('Message worker cycle failed; pending work remains in the database.');}
    if(!stopping)await setTimeout(1000);
  }
} finally {if(healthFile)await rm(healthFile,{force:true});await pool.end();}
