import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SolapiSmsSender, senderFromEnvironment, smsMode } from './sms.js';

const config={apiKey:'test-key',apiSecret:'test-secret',from:'01000000000'};
const payload={phone:'01000001111',message:'[픽미업] 인증번호 123456'};
const acceptance={messageList:[{messageId:'message-a',statusCode:'2000'}],failedMessageList:[]};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});

test('SOLAPI signs every request with a fresh salt and sends one explicitly typed message',async()=>{
  const calls:{url:string;init:RequestInit}[]=[];
  const sender=new SolapiSmsSender(config,async(url,init)=>{
    calls.push({url,init});
    // The live API omits per-message IDs unless explicitly requested.
    return json(JSON.parse(init.body as string).showMessageList===true?acceptance:{failedMessageList:[],groupInfo:{}});
  },()=>1700000000000);
  assert.deepEqual(await sender.send(payload),{kind:'accepted',requestId:'message-a'});
  await sender.send({...payload,message:'가'.repeat(46)});
  const salts:string[]=[];
  for(const call of calls) {
    const header=(call.init.headers as Record<string,string>).Authorization;
    const match=header.match(/^HMAC-SHA256 apiKey=test-key, date=(.+), salt=([a-f0-9]{32}), signature=([a-f0-9]{64})$/)!;
    assert.ok(match);salts.push(match[2]);
    assert.equal(match[3],createHmac('sha256',config.apiSecret).update(match[1]+match[2]).digest('hex'));
    assert.equal(call.url,'https://api.solapi.com/messages/v4/send-many/detail');
    const body=JSON.parse(call.init.body as string);
    assert.equal(body.messages.length,1);assert.equal(body.messages[0].autoTypeDetect,false);assert.equal(body.allowDuplicates,false);
    assert.equal(body.showMessageList,true);
  }
  assert.notEqual(salts[0],salts[1]);
  assert.equal(JSON.parse(calls[0].init.body as string).messages[0].type,'SMS');
  assert.equal(JSON.parse(calls[1].init.body as string).messages[0].type,'LMS');
});
test('SOLAPI distinguishes explicit rejection, accepted ID and an uncertain send without retrying',async()=>{
  const sender=(data:unknown,status=200)=>new SolapiSmsSender(config,async()=>json(data,status));
  assert.deepEqual(await sender({},429).send(payload),{kind:'rejected',code:'PROVIDER_RATE_LIMIT',retryable:true});
  assert.equal((await sender({},403).send(payload)).kind,'rejected');
  assert.equal((await sender({},503).send(payload)).kind,'unknown');
  assert.equal((await sender({...acceptance,messageList:[]}).send(payload)).kind,'unknown');
  assert.equal((await sender({...acceptance,messageList:[...acceptance.messageList,...acceptance.messageList]}).send(payload)).kind,'unknown');
  assert.deepEqual(await sender({messageList:[],failedMessageList:[{statusCode:'2062'}]}).send(payload),
    {kind:'rejected',code:'SOLAPI_2062',retryable:false});
  const lost=new SolapiSmsSender(config,async()=>{throw new Error('timeout after remote acceptance');});
  assert.equal((await lost.send(payload)).kind,'unknown');
});
test('SOLAPI only marks a matching unique final 4000 receipt as delivered',async()=>{
  const row={messageId:'message-a',status:'COMPLETE',statusCode:'4000'};
  const sender=(messageList:unknown,nextKey?:string)=>new SolapiSmsSender(config,async(url)=>{
    const query=new URL(url).searchParams;
    assert.equal(query.get('criteria'),'messageId');assert.equal(query.get('value'),'message-a');
    return json({messageList,nextKey});
  });
  assert.equal((await sender({'message-a':row}).lookup('message-a')).state,'DELIVERED');
  assert.equal((await sender({'message-a':{...row,status:'SENDING',statusCode:'3000'}}).lookup('message-a')).state,'ACCEPTED');
  assert.equal((await sender({'message-a':{...row,status:'PENDING',statusCode:'2000'}}).lookup('message-a')).state,'ACCEPTED');
  assert.equal((await sender({'message-a':{...row,statusCode:'3043'}}).lookup('message-a')).state,'FAILED');
  assert.equal((await sender({'message-a':{...row,status:'SENDING'}}).lookup('message-a')).state,'UNKNOWN');
  assert.equal((await sender({'message-a':{...row,statusCode:'2000'}}).lookup('message-a')).state,'UNKNOWN');
  assert.equal((await sender({'wrong':row}).lookup('message-a')).state,'UNKNOWN');
  assert.equal((await sender({'message-a':row,other:row}).lookup('message-a')).state,'UNKNOWN');
  assert.equal((await sender({'message-a':row},'next').lookup('message-a')).state,'UNKNOWN');
});
test('SOLAPI configuration and unsupported content fail before making network requests',async()=>{
  assert.equal(smsMode('solapi'),'solapi');
  assert.throws(()=>senderFromEnvironment({SMS_MODE:'solapi'}),/SOLAPI/);
  const sender=new SolapiSmsSender(config,async()=>{assert.fail('must not send');});
  assert.equal((await sender.send({...payload,message:'차량 🚗'})).kind,'rejected');
  assert.equal((await sender.send({...payload,phone:'invalid'})).kind,'rejected');
});
