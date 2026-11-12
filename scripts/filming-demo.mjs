import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');process.chdir(root);
const local=path.join(root,'.local/filming-demo');await mkdir(local,{recursive:true});
const command=process.argv[2]??'status';
const run=(file,args,options={})=>new Promise((resolve,reject)=>{
    const child=spawn(file,args,{cwd:root,stdio:'inherit',...options});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Command failed: '+file+' ('+code+')')));
});
function adb(...args){return execFileSync('scripts/with-env.sh',['adb','-e',...args],{encoding:'utf8',maxBuffer:4_000_000});}
async function config(){return JSON.parse(await readFile('.local/web-map-alert/build-config.json','utf8'));}
async function buildArgs(){const p=await config();return ['-PpickmeupGleoCallerPackage='+p.GLEO_CALLER_PACKAGE,'-PpickmeupGleoCallerSha256='+p.GLEO_CALLER_SHA256,'-PpickmeupMapOrigin='+p.KAKAO_MAP_ORIGIN];}
if(command==='prepare'){
    await run('.local/audio-venv/bin/python',['scripts/filming-audio.py']);
    await run('scripts/with-env.sh',['node','node_modules/vite/bin/vite.js','build','--config','scripts/filming-vite.config.mjs']);
    await run('scripts/with-env.sh',['bash','-c','cd android && exec ./gradlew "$@"','filming-gradle','assembleFilming','testFilmingUnitTest','lintFilming','assembleDebug','testDebugUnitTest','lintDebug',...await buildArgs()]);
    console.log('Filming and normal APKs ready. No installation or account changes.');
}else if(command==='install'){
    const version=adb('shell','dumpsys','package','io.pickmeup.automotive');
    if(!version.includes('-filming')){
        adb('shell','am','force-stop','--user','10','io.pickmeup.automotive');
        const files=['pickmeup-device.xml','pickmeup-ui.xml','WebViewChromiumPrefs.xml'];
        for(const file of files){const bytes=execFileSync('scripts/with-env.sh',['adb','-e','exec-out','run-as','io.pickmeup.automotive','--user','10','cat','shared_prefs/'+file]);if(!bytes.includes(Buffer.from('<?xml')))throw Error('Cannot verify original preferences');await writeFile(path.join(local,'original-'+file),bytes,{mode:0o600});}
        const original=adb('shell','pm','path','io.pickmeup.automotive').trim().split('\n')[0].replace(/^package:/,'');
        await run('scripts/with-env.sh',['adb','-e','pull',original,path.join(local,'original-app.apk')]);
    }
    await run('scripts/with-env.sh',['adb','-e','install','-r','android/app/build/outputs/apk/filming/app-filming.apk']);
    adb('reverse','tcp:4311','tcp:4311');adb('shell','am','start','--user','10','-n','io.pickmeup.automotive/.MainActivity');
    console.log('Filming build opened. Production preferences and Keystore retained.');
}else if(command==='start'){
    try{const state=JSON.parse(await readFile(path.join(local,'runtime.json'),'utf8'));const response=await fetch('http://127.0.0.1:5187/health',{signal:AbortSignal.timeout(1000)});if(response.ok){console.log('Filming runtime already running: http://127.0.0.1:5187');process.exit(0);}}catch{}
    const log=await open(path.join(local,'runtime.log'),'a');
    const child=spawn('scripts/with-env.sh',['node','--env-file=.env','--env-file-if-exists=.local/public-demo.env','--env-file-if-exists=.local/filming-demo/sms.env','scripts/filming-runtime.mjs'],{cwd:root,detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();
    for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,250));try{const res=await fetch('http://127.0.0.1:5187/health');if(res.ok){console.log('Filming controls: http://127.0.0.1:5187');process.exit(0);}}catch{}}
    throw Error('Runtime did not start. Inspect .local/filming-demo/runtime.log privately.');
}else if(command==='stop'){
    const state=JSON.parse(await readFile(path.join(local,'runtime.json'),'utf8'));
    let live='';try{live=execFileSync('ps',['-p',String(state.pid),'-o','command='],{encoding:'utf8'});}catch{}
    if(!live.includes('scripts/filming-runtime.mjs'))throw Error('The filming PID is stale; refusing to signal another process.');
    process.kill(state.pid,'SIGTERM');
    for(let i=0;i<40;i++){
        await new Promise(r=>setTimeout(r,250));
        const current=JSON.parse(await readFile('.local/public-runtime/pids.json','utf8'));
        if(current.web!==state.pid){console.log('Filming API stopped; normal web server restored.');process.exit(0);}
    }
    throw Error('Filming shutdown is still pending; inspect the private runtime log.');
}else if(command==='restore'){
    await run('scripts/with-env.sh',['adb','-e','install','-r','android/app/build/outputs/apk/debug/app-debug.apk']);
    adb('reverse','tcp:4310','tcp:4310');adb('shell','am','start','--user','10','-n','io.pickmeup.automotive/.MainActivity');
    console.log('Normal app opened using its original account and vehicle data.');
}else if(['status','play','pause','reset','speed','seek','voice','listen'].includes(command)){
    const state=JSON.parse(await readFile(path.join(local,'runtime.json'),'utf8'));
    const response=await fetch('http://127.0.0.1:5187/'+(command==='status'?'state':'command'),command==='status'?{}:{method:'POST',headers:{'content-type':'application/json','x-filming-control':state.controlToken,origin:'http://127.0.0.1:5187'},body:JSON.stringify({command,value:process.argv[3]})});
    if(!response.ok)throw Error('Filming control failed: '+response.status);console.log(JSON.stringify(await response.json(),null,2));
}else throw Error('Use prepare, start, install, status, play, pause, speed N, seek SECONDS, reset, voice start|status|stop, listen, restore, stop');
