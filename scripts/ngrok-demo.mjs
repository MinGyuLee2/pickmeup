import {spawn} from 'node:child_process';
if(!process.env.NGROK_AUTHTOKEN?.trim())throw new Error('NGROK_AUTHTOKEN is required in .local/ngrok.env');
// No inspection/replay capture of phone numbers, OTPs or location-sharing requests.
const child=spawn('ngrok',['http','http://127.0.0.1:5173','--inspect=false','--log=stdout','--log-format=json'],{
  stdio:'inherit',env:{PATH:process.env.PATH,HOME:process.env.HOME,NGROK_AUTHTOKEN:process.env.NGROK_AUTHTOKEN},
});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
child.once('error',()=>{console.error('ngrok could not start; check installation and account configuration.');process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
