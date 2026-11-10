import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { encodedMessage, SensSmsSender, sensSignature, senderFromEnvironment, smsLabel } from './sms.js';

const config={serviceId:'ncp:sms:kr:test:pickup',accessKey:'test-access',secretKey:'test-secret',from:'01000000000'};
const payload={phone:'01000001111',message:'[픽미업] 인증번호 123456'};
test('EUC-KR byte limits select SMS/LMS without truncating or substituting unsupported text',()=>{
  assert.deepEqual(encodedMessage('가'.repeat(45)),{type:'SMS',bytes:90});
  assert.deepEqual(encodedMessage('가'.repeat(46)),{type:'LMS',bytes:92});
  assert.throws(()=>encodedMessage('가'.repeat(1001)),/MESSAGE_TOO_LONG/);
  assert.throws(()=>encodedMessage('도착했어요 🚙'),/UNSUPPORTED_CHARACTERS/);
  assert.throws(()=>encodedMessage('갂'),/UNSUPPORTED_CHARACTERS/);
  assert.equal(smsLabel('회사 갂','만날 곳'),'만날 곳');
});
test('SENS signs exactly the wire request including the lookup query string',async()=>{
  const calls:{url:string;init:RequestInit}[]=[];
  const sender=new SensSmsSender(config,async(url,init)=>{
    calls.push({url,init});
    return new Response(JSON.stringify({statusCode:'202',statusName:'success',requestId:'request-a'}),{status:202});
  },()=>1700000000000);
  assert.deepEqual(await sender.send(payload),{kind:'accepted',requestId:'request-a'});
  const path='/sms/v2/services/ncp:sms:kr:test:pickup/messages';
  const expected=createHmac('sha256','test-secret').update(`POST ${path}\n1700000000000\ntest-access`).digest('base64');
  assert.equal((calls[0].init.headers as Record<string,string>)['x-ncp-apigw-signature-v2'],expected);
  assert.equal((JSON.parse(calls[0].init.body as string)).type,'SMS');
  await sender.lookup('request /+a');
  assert.equal(new URL(calls[1].url).search,'?requestId=request%20%2F%2Ba');
  assert.equal((calls[1].init.headers as Record<string,string>)['x-ncp-apigw-signature-v2'],sensSignature('GET',`${path}?requestId=request%20%2F%2Ba`,'1700000000000',config.accessKey,config.secretKey));
});
test('HTTP acceptance is not delivery and ambiguous send failures are not retriable rejections',async()=>{
  for(const status of [500,503]) {
    const sender=new SensSmsSender(config,async()=>new Response('{}',{status}));
    assert.equal((await sender.send(payload)).kind,'unknown');
  }
  const rate=new SensSmsSender(config,async()=>new Response('{}',{status:429}));
  assert.deepEqual(await rate.send(payload),{kind:'rejected',code:'PROVIDER_RATE_LIMIT',retryable:true});
  const broken=new SensSmsSender(config,async()=>{throw new Error('timeout');});
  assert.equal((await broken.send(payload)).kind,'unknown');
  const missingId=new SensSmsSender(config,async()=>new Response('{"statusCode":"202","statusName":"success"}',{status:202}));
  assert.equal((await missingId.send(payload)).kind,'unknown');
});
test('only a unique completed success receipt proves delivery',async()=>{
  const row={requestId:'request-a',messageId:'message-a',status:'COMPLETED',statusCode:'0',statusName:'success'};
  const sender=(messages:unknown[])=>new SensSmsSender(config,async()=>new Response(JSON.stringify({statusCode:'202',statusName:'success',messages}),{status:200}));
  assert.equal((await sender([row]).lookup('request-a')).state,'DELIVERED');
  assert.equal((await sender([{...row,status:'PROCESSING'}]).lookup('request-a')).state,'ACCEPTED');
  assert.equal((await sender([{...row,statusName:'fail',statusCode:'3001'}]).lookup('request-a')).state,'FAILED');
  assert.equal((await sender([{...row,requestId:'wrong'}]).lookup('request-a')).state,'UNKNOWN');
  assert.equal((await sender([row,row]).lookup('request-a')).state,'UNKNOWN');
  assert.equal((await sender([{...row,statusCode:undefined}]).lookup('request-a')).state,'UNKNOWN');
});
test('production cannot enable simulation and incomplete real credentials fail before network use',()=>{
  assert.throws(()=>senderFromEnvironment({SMS_MODE:'local',NODE_ENV:'production'}));
  assert.throws(()=>senderFromEnvironment({SMS_MODE:'sens'}));
});
