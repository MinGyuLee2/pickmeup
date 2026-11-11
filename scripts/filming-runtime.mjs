import http from 'node:http';
import pg from 'pg';
import {readFile,writeFile,open,rm} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {buildApp,endPickup} from '../api/dist/app.js';
import {migrate,transaction} from '../api/dist/db.js';
import {secrets} from '../api/dist/domain.js';
import {splitRoute} from '../api/dist/planned-route.js';

// No SMS transport/worker is imported. Every database write is scoped to this marked schema.
const schema='pickmeup_filming_v1',marker='PickMeUp isolated filming; synthetic recipients; no external SMS';
const local=path.resolve('.local/filming-demo');
const origin=new URL(process.env.PICKMEUP_PREVIEW_ORIGIN||process.env.PUBLIC_ORIGIN).origin;
if(!process.env.APP_SECRET||!process.env.DATABASE_URL||!origin.startsWith('https://'))throw Error('Existing private runtime configuration required');
const route=JSON.parse(await readFile('android/app/src/filming/assets/filming-route.json','utf8'));
const last=route.path.at(-1),destination={longitude:last[0],latitude:last[1],name:route.name};
const security=secrets(process.env.APP_SECRET),controlToken=randomBytes(24).toString('hex');
function filmingLink(value){const link=new URL(value);link.pathname='/filming/s';return link.href;}
const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
const existing=await admin.query('SELECT obj_description(oid,\'pg_namespace\') AS marker FROM pg_namespace WHERE nspname=$1',[schema]);
if(existing.rowCount&&existing.rows[0].marker!==marker)throw Error('Refusing to reuse an unmarked schema');
await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
await admin.query(`COMMENT ON SCHEMA ${schema} IS '${marker}'`);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
if((await pool.query('SELECT current_schema() AS s')).rows[0].s!==schema)throw Error('Filming schema isolation failed');
await migrate(pool);
await pool.query("INSERT INTO contact_aliases(contact_id,alias) SELECT id,'지연' FROM contacts WHERE name='지연이' AND phone='01000000000' AND deleted_at IS NULL ON CONFLICT DO NOTHING");
async function scopeFilmingLinks(){
    const rows=(await pool.query("SELECT id,recipient_link_ciphertext FROM pickups WHERE state IN ('ACTIVE','ARRIVED') AND recipient_link_ciphertext IS NOT NULL")).rows;
    for(const row of rows){const before=security.open(row.recipient_link_ciphertext),after=filmingLink(before);if(after===before)continue;await pool.query('UPDATE pickups SET recipient_link_ciphertext=$2 WHERE id=$1',[row.id,security.seal(after)]);}
}
await scopeFilmingLinks();
const app=buildApp(pool,{secret:process.env.APP_SECRET,publicOrigin:origin+'/filming',smsMode:'solapi',production:false,kakaoRouteKey:'filming-local-road-cache',routeFetch:async input=>{
    const u=new URL(String(input));const p=u.searchParams.get('origin').split(',').map(Number);
    const remaining=splitRoute(route.path,{longitude:p[0],latitude:p[1]})?.remaining;
    return new Response(JSON.stringify({routes:[{result_code:remaining?0:1,sections:remaining?[{roads:[{vertexes:remaining.flat()}]}]:[]}]}),{headers:{'content-type':'application/json'}});
}});
async function simulateMessages(){
    await pool.query("UPDATE message_jobs SET provider='local' WHERE provider IS DISTINCT FROM 'local'");
    await pool.query(`UPDATE message_jobs j SET status='SIMULATED',protected_payload=NULL,attempts=0,updated_at=now() FROM pickups p
        WHERE j.pickup_id=p.id AND p.sms_confirmed AND p.state IN ('ACTIVE','ARRIVED') AND j.status='PENDING' AND j.available_at<=now()`);
}
app.addHook('onSend',async(request,reply,payload)=>{
    if(request.method==='POST'&&request.url.startsWith('/pickups')&&reply.statusCode<300)await scopeFilmingLinks();
    if(request.url==='/vehicles/guest'&&reply.statusCode<300&&typeof payload==='string'){
        const car=JSON.parse(payload);
        await transaction(pool,async db=>{
            const vehicle=(await db.query('SELECT driver_id FROM vehicles WHERE id=$1 FOR UPDATE',[car.vehicleId])).rows[0];
            if(!vehicle)throw Error('Filming vehicle missing');
            await db.query("UPDATE drivers SET name='민규' WHERE id=$1",[vehicle.driver_id]);
            await db.query("UPDATE vehicles SET model_key='ioniq5' WHERE id=$1",[car.vehicleId]);
            let person=(await db.query("SELECT id FROM contacts WHERE driver_id=$1 AND name='지연이' AND deleted_at IS NULL",[vehicle.driver_id])).rows[0];
            if(!person){person={id:randomUUID()};await db.query("INSERT INTO contacts(id,driver_id,name,phone) VALUES($1,$2,'지연이','01000000000')",[person.id,vehicle.driver_id]);}
            await db.query("INSERT INTO contact_aliases(contact_id,alias) VALUES($1,'지연이') ON CONFLICT DO NOTHING",[person.id]);
            await db.query("INSERT INTO contact_aliases(contact_id,alias) VALUES($1,'지연') ON CONFLICT DO NOTHING",[person.id]);
            await db.query('INSERT INTO contact_places(contact_id,destination) VALUES($1,$2) ON CONFLICT(contact_id) DO UPDATE SET destination=$2',[person.id,destination]);
        });
    }
    // Owner callbacks always identify the local simulator, even before its next tick.
    if(typeof payload==='string'&&(payload.includes('"messages"')||request.url.includes('/share-message'))){
        const value=JSON.parse(payload),pickup=value.pickup??value;
        if(Array.isArray(pickup.messages))pickup.messages=pickup.messages.map(m=>({...m,provider:'local'}));
        if(value.shareLink){const before=value.shareLink;value.shareLink=filmingLink(before);if(typeof value.message==='string')value.message=value.message.replaceAll(before,value.shareLink);}
        payload=JSON.stringify(value);
    }
    return payload;
});
await app.listen({host:'127.0.0.1',port:4311});
const timer=setInterval(()=>void simulateMessages().catch(()=>{}),500);timer.unref();
const exec=promisify(execFile);
async function adb(...args){return (await exec('scripts/with-env.sh',['adb','-e',...args],{maxBuffer:4_000_000,timeout:15000})).stdout;}
async function filmingInstalled(){const value=await adb('shell','dumpsys','package','io.pickmeup.automotive');return /versionName=\S+-filming(?:\s|$)/.test(value);}
async function control(command,value){
    if(!await filmingInstalled())throw Error('촬영용 앱을 먼저 설치해 주세요. 일반 앱에는 명령을 보내지 않아요.');
    const requestId=randomUUID();
    const args=['shell','am','broadcast','--user','10','-n','io.pickmeup.automotive/.filming.FilmingControlReceiver','--es','command',command,'--es','requestId',requestId];
    if(value!==undefined)args.push('--es','value',String(value));
    await adb(...args);
    const file='files/filming-status-'+requestId+'.json';
    try{return JSON.parse(await adb('exec-out','run-as','io.pickmeup.automotive','--user','10','cat',file));}
    finally{await adb('shell','run-as','io.pickmeup.automotive','--user','10','rm',file);}
}
let voice={busy:false,result:null},voiceProcess=null,closing=false,ready=false;
async function state(){
    let navigation=null,error='';try{navigation=await control('status');}catch(e){error=e.message;}
    const row=navigation?.pickupId?(await pool.query("SELECT * FROM pickups WHERE id=$1 AND state IN ('ACTIVE','ARRIVED')",[navigation.pickupId])).rows[0]:null;
    const link=row?.recipient_link_ciphertext?filmingLink(security.open(row.recipient_link_ciphertext)):null;
    return {filming:true,externalSms:false,voice,navigation,error,pickup:row?{id:row.id,state:row.state,readiness:row.readiness,observation:row.latest_observation,waitingPoint:row.waiting_point}:null,
        recipientUrl:link,accessCode:row?.recipient_code_ciphertext?security.open(row.recipient_code_ciphertext):null};
}
const controls=await readFile('scripts/filming-controls.html','utf8');
let serial=Promise.resolve();
const controller=http.createServer(async(req,res)=>{
    const json=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(v));};
    const u=new URL(req.url,'http://127.0.0.1:5187');
    try{
        if(req.headers.host!=='127.0.0.1:5187')return json({error:'Local control only'},403);
        if(req.method==='GET'&&u.pathname==='/health')return json({filming:true,schemaIsolated:true,externalSms:false,ready},ready?200:503);
        if(req.method==='GET'&&u.pathname==='/') {res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'});return res.end(controls.replace('__FILMING_CONTROL_TOKEN__',controlToken));}
        if(req.method==='GET'&&u.pathname==='/state')return json(await state());
        if(req.method!=='POST'||u.pathname!=='/command')return json({},404);
        if(req.headers.origin!=='http://127.0.0.1:5187'||req.headers['x-filming-control']!==controlToken)return json({error:'Control authorization required'},403);
        let body='';for await(const chunk of req){body+=chunk;if(body.length>1024)return json({},413);}
        const input=JSON.parse(body),cmd=input.command;
        if(!['play','pause','reset','speed','seek','voice','listen'].includes(cmd))return json({error:'Unknown command'},400);
        if(cmd==='listen'){
            if(voice.busy)return json({error:'녹음 명령 재생이 끝난 뒤 말씀해 주세요.'},409);
            if(!await filmingInstalled())return json({error:'촬영용 앱이 설치되지 않았어요.'},409);
            await adb('shell','cmd','voiceinteraction','show');
            return json({ok:true,listening:true,hostMicrophoneChanged:false});
        }
        if(cmd==='voice'){
            if(!['start','status','stop','recipient'].includes(input.value)||voice.busy)return json({error:'음성 리허설이 이미 진행 중이거나 명령이 잘못됐어요.'},409);
            if(!await filmingInstalled())return json({error:'촬영용 앱이 설치되지 않았어요.'},409);
            await rm(path.join(local,'voice-'+input.value+'.json'),{force:true});
            voice={busy:true,result:null};const log=await open(path.join(local,'voice-run.log'),'a');
            voiceProcess=spawn('.local/audio-venv/bin/python',['scripts/filming-voice.py',input.value],{stdio:['ignore',log.fd,log.fd]});
            voiceProcess.once('error',()=>{voice={busy:false,result:{ok:false,message:'음성 도구를 실행하지 못했어요.'}};});
            voiceProcess.once('exit',async code=>{let result=null;try{result=JSON.parse(await readFile(path.join(local,'voice-'+input.value+'.json'),'utf8'));}catch{}voice={busy:false,result:{...result,ok:code===0}};voiceProcess=null;await log.close();});
            return json({ok:true,voiceStarted:true});
        }
        if(voice.busy)return json({error:'음성 리허설이 끝난 뒤 조작해 주세요.'},409);
        const value=input.value===undefined?undefined:Number(input.value);
        if(cmd==='speed'&&(!Number.isFinite(value)||value<.5||value>20))return json({error:'배속은 0.5–20 사이예요.'},400);
        if(cmd==='seek'&&(!Number.isFinite(value)||value<0||value>route.durationSeconds))return json({error:'시점 범위를 확인해 주세요.'},400);
        const work=serial.then(()=>control(cmd,value));serial=work.catch(()=>{});const result=await work;return json(result,result.ok?200:409);
    }catch(e){return json({error:e.message||'촬영 제어 실패'},503);}
});
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.wav':'audio/wav','.webmanifest':'application/manifest+json'};
const sockets=new Set();
const web=http.createServer(async(req,res)=>{
    const u=new URL(req.url,origin);
    if(u.pathname.startsWith('/filming/api/')||u.pathname.startsWith('/api/')){
        const film=u.pathname.startsWith('/filming/api/'),base=film?'/filming/api':'/api';
        const upstream=http.request('http://127.0.0.1:'+(film?4311:4310)+req.url.slice(base.length),{method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
        req.pipe(upstream);upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end('{"message":"서버 연결을 확인해 주세요."}');});res.on('close',()=>upstream.destroy());return;
    }
    const film=u.pathname.startsWith('/filming/'),base=path.resolve(film?'.local/filming-demo/web':'web/dist');
    const pathname=film?u.pathname.slice('/filming'.length):u.pathname;
    const file=path.resolve(base,'.'+(path.extname(pathname)?pathname:film?'/filming.html':'/index.html'));
    if(!file.startsWith(base+path.sep)){res.writeHead(404);return res.end();}
    try{const data=await readFile(file);res.writeHead(200,{'content-type':types[path.extname(file)]??'application/octet-stream','cache-control':'no-store','referrer-policy':'no-referrer'});res.end(data);}catch{res.writeHead(404);res.end('Not found');}
});
web.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
const pids=JSON.parse(await readFile('.local/public-runtime/pids.json','utf8'));
await new Promise((resolve,reject)=>{controller.once('error',reject);controller.listen(5187,'127.0.0.1',resolve);});
let oldWebStopped=false;
try{
    const command=(await exec('ps',['-p',String(pids.web),'-o','command='])).stdout;
    if(!command.includes('vite'))throw Error('Refusing to replace an unknown process on 5173');
    process.kill(pids.web,'SIGTERM');oldWebStopped=true;
}catch(e){if(e.code!=='ESRCH'&&e.code!==1)throw e;}
await new Promise(r=>setTimeout(r,300));
await new Promise((resolve,reject)=>{web.once('error',reject);web.listen(5173,'127.0.0.1',resolve);});
pids.web=process.pid;await writeFile('.local/public-runtime/pids.json',JSON.stringify(pids));
await writeFile(path.join(local,'runtime.json'),JSON.stringify({pid:process.pid,schema,controlToken,origin,oldWebStopped}),{mode:0o600});
ready=true;
console.log('FILMING_READY localhost control 5187; isolated API 4311; normal routes preserved; external SMS transport absent');
async function close(){
    if(closing)return;closing=true;clearInterval(timer);voiceProcess?.kill('SIGTERM');
    for(const s of sockets)s.destroy();web.close();controller.close();
    await transaction(pool,async db=>{for(const row of(await db.query("SELECT id FROM pickups WHERE state IN ('ACTIVE','ARRIVED') FOR UPDATE")).rows)await endPickup(db,row.id);});
    await app.close();await pool.end();await admin.end();
    const log=await open('.local/public-runtime/web.log','a');const child=spawn('scripts/public-demo.sh',['web'],{detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();
    const current=JSON.parse(await readFile('.local/public-runtime/pids.json','utf8'));current.web=child.pid;await writeFile('.local/public-runtime/pids.json',JSON.stringify(current));
    console.log('FILMING_STOPPED normal web restored; production account/vehicle tables untouched');process.exit(0);
}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
