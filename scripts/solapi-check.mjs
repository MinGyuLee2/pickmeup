// Offline configuration check: this script never sends a message or makes HTTP requests.
import { senderFromEnvironment } from '../api/dist/sms.js';
let ready=true;
for(const name of ['SOLAPI_API_KEY','SOLAPI_API_SECRET','SOLAPI_FROM']) {
  const present=Boolean(process.env[name]);
  console.log(`${name}: ${present?'입력됨':'입력 필요'}`);
  if(!present)ready=false;
}
if(ready) {
  try {senderFromEnvironment({...process.env,SMS_MODE:'solapi'});console.log('인증 설정 형식: 정상 (실제 인증은 미검증)');}
  catch {ready=false;console.log('인증 설정 형식: 확인 필요');}
}
const origin=process.env.PUBLIC_ORIGIN;
const url=origin&&URL.canParse(origin)?new URL(origin):null;
const https=Boolean(url&&url.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname));
console.log(`휴대전화 공유용 HTTPS 주소: ${https?'설정됨 (외부 접속은 미검증)':'준비 필요'}`);
console.log(`현재 SMS_MODE: ${process.env.SMS_MODE==='solapi'?'solapi':process.env.SMS_MODE==='local'?'local · 실제 문자 발송 없음':'solapi 아님'}`);
console.log('오프라인 점검 완료 · 실제 발송/잔액 조회 없음');
if(!ready||!https)process.exitCode=1;
