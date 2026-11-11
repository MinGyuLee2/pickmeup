#!/usr/bin/env python3
"""Create local synthetic rehearsal WAVs with the existing macOS Korean voice. No microphone."""
from pathlib import Path
import subprocess,json

root=Path(__file__).resolve().parent.parent
folder=root/'.local/filming-demo/audio';folder.mkdir(parents=True,exist_ok=True)
phrases={'start':'픽미업에서 지연이에게 현재 위치와 도착 시간을 공유해 줘.',
         'status':'픽미업에서 픽업 상태 알려줘.',
         'stop':'픽미업 공유를 종료해 줘.',
         'recipient':'저장된 이름은 지연입니다.'}
cache=folder/'phrases.json'
try:previous=json.loads(cache.read_text())
except (FileNotFoundError,ValueError):previous={}
for name,text in phrases.items():
    aiff=folder/(name+'.aiff');wav=folder/(name+'.wav')
    if wav.exists() and previous.get(name)==text:continue
    wav.unlink(missing_ok=True)
    subprocess.run(['/usr/bin/say','-v','Yuna','-r','155' if name=='recipient' else '170','-o',str(aiff),text],check=True)
    subprocess.run(['/usr/bin/afconvert','-f','WAVE','-d','LEI16@16000','-c','1',str(aiff),str(wav)],check=True)
    aiff.unlink()
cache.write_text(json.dumps(phrases,ensure_ascii=False,indent=2))
print('Local Korean rehearsal audio ready. No host microphone input or new dependencies.')
