#!/usr/bin/env python3
"""Rehearse through real Gleo ASR; never falls back to a debug Intent or enables a host mic."""
from pathlib import Path
import subprocess,sys,time,json,os,re,signal,argparse

def interrupted(_signum,_frame):raise SystemExit(130)
signal.signal(signal.SIGTERM,interrupted)

root=Path(__file__).resolve().parent.parent
adb=[str(root/'scripts/with-env.sh'),'adb','-e']
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('mode',nargs='?',default='status',choices=['start','status','stop','recipient'])
parser.add_argument('--output-dir',type=Path,help='Separate private folder for a new take; existing rehearsal files are left alone')
options=parser.parse_args()
mode=options.mode
files={k:'.local/filming-demo/audio/'+k+'.wav' for k in ['start','status','stop','recipient']}
if mode not in files:raise SystemExit('Expected start, status, stop or recipient')
package=subprocess.check_output(adb+['shell','dumpsys','package','io.pickmeup.automotive'],text=True)
if not re.search(r'versionName=\S+-filming(?:\s|$)',package):
    raise SystemExit('Refusing voice rehearsal: the isolated filming build is not installed')
wav=root/files[mode]
if not wav.exists():raise SystemExit('The existing synthetic command WAV is missing. Do not install new audio dependencies automatically.')
folder=options.output_dir.resolve() if options.output_dir else root/'.local/filming-demo'
folder.mkdir(parents=True,exist_ok=True,mode=0o700)
logpath=folder/('voice-'+mode+'.log')
with os.fdopen(os.open(logpath,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'wb') as log:
    proc=subprocess.Popen(adb+['logcat','-T','1','-v','threadtime'],stdout=log,stderr=subprocess.DEVNULL)
    try:
        subprocess.run(adb+['shell','cmd','voiceinteraction','hide'],check=True,stdout=subprocess.DEVNULL,timeout=8)
        subprocess.run(adb+['shell','cmd','voiceinteraction','show'],check=True,stdout=subprocess.DEVNULL,timeout=8)
        subprocess.run([str(root/'.local/audio-venv/bin/python'),'scripts/emulator-audio.py',str(wav)],check=True,stdout=subprocess.DEVNULL,timeout=40)
        time.sleep(16)
    finally:
        proc.terminate()
        try:proc.wait(timeout=3)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()
text=logpath.read_text(errors='replace');recognized=[];callbacks=[]
def response_events(value):
    if isinstance(value,list):
        for item in value:response_events(item)
    elif isinstance(value,dict):
        response=value.get('response')
        if isinstance(response,dict) and response.get('functionName'):
            data=response.get('data')
            try:data=json.loads(data) if isinstance(data,str)else data
            except ValueError:data=None
            safe=[]
            for row in data if isinstance(data,list)else [data]:
                if isinstance(row,dict):safe.append({k:v for k,v in row.items()if k in ['code','active','state','readiness','remainingSeconds','freshness','simulatedDelivery','smsConfirmed','messageConfirmationRequired','pendingEnd','operation']})
            item={'action':response.get('functionName'),'status':response.get('status'),'data':safe}
            if item not in callbacks:callbacks.append(item)
        for child in value.values():response_events(child)
for line in text.splitlines():
    if 'AMI_STATE_SUMMARY:' not in line:continue
    try:
        value=json.loads(line.split('AMI_STATE_SUMMARY:',1)[1].strip()).get('inputMessage',{}).get('content','')
        if value and value.startswith(('[','{')):
            try:response_events(json.loads(value))
            except ValueError:pass
        elif value and len(value)<200 and value not in recognized:recognized.append(value)
    except (ValueError,TypeError,AttributeError):pass
expected={'start':'START_PICKUP_SHARE','recipient':'START_PICKUP_SHARE','status':'GET_PICKUP_STATUS','stop':'STOP_PICKUP_SHARE'}[mode]
verified=any(c['action']==expected and (c['status']=='success' or(c['status']=='asking' and any(row.get('active') and row.get('messageConfirmationRequired')for row in c['data'])))for c in callbacks)
result={'mode':mode,'recognized':recognized,'nativeStartActivity':'GLEO_VOICE_ACTIVITY_STARTED' in text,'callbackReceived':'APP_ACTION_RESPONSE' in text,'callbacks':callbacks,'verifiedAction':verified,'syntheticAudio':True,'hostMicEnabled':False}
(folder/('voice-'+mode+'.json')).write_text(json.dumps(result,ensure_ascii=False,indent=2))
print(json.dumps(result,ensure_ascii=False))
raise SystemExit(0 if verified else 2)
