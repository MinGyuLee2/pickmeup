import { createHmac, randomBytes } from 'node:crypto';
import iconv from 'iconv-lite';

export type SmsMode='local'|'sens'|'solapi'|'disabled';
export type SendingMode=Exclude<SmsMode,'disabled'>;
export function realSmsMode(mode:SmsMode):mode is 'sens'|'solapi' {return mode==='sens'||mode==='solapi';}
export function smsMode(value:string|undefined):SmsMode {
  if(!value || value==='disabled')return 'disabled';
  if(value==='local'||value==='sens'||value==='solapi')return value;
  throw new Error('SMS_MODE must be local, sens, solapi or disabled');
}
export type SmsPayload={phone:string;message:string;shareLink?:string};
export type SendResult=
  |{kind:'simulated'}
  |{kind:'accepted';requestId:string}
  |{kind:'rejected';code:string;retryable:boolean}
  |{kind:'unknown';code:string};
export type Receipt={state:'ACCEPTED'|'DELIVERED'|'FAILED'|'UNKNOWN';code?:string;messageId?:string};
export interface SmsSender {
  readonly mode:SendingMode;
  send(payload:SmsPayload,dispatchId?:string):Promise<SendResult>;
  lookup(requestId:string):Promise<Receipt>;
}
export class LocalSmsSender implements SmsSender {
  readonly mode='local' as const;
  async send(_payload:SmsPayload):Promise<SendResult>{return {kind:'simulated'};}
  async lookup(_requestId:string):Promise<Receipt>{return {state:'UNKNOWN',code:'LOCAL_HAS_NO_RECEIPT'};}
}
function eucKrBytes(message:string) {
  if(typeof message!=='string')throw new Error('INVALID_MESSAGE');
  const encoded=iconv.encode(message,'euc-kr');
  if(iconv.decode(encoded,'euc-kr')!==message)throw new Error('UNSUPPORTED_CHARACTERS');
  // iconv-lite aliases EUC-KR to CP949. Reject the CP949 extension ranges so the
  // transport matches SENS's documented EUC-KR repertoire rather than replacing text.
  for(let index=0;index<encoded.length;index++) {
    if(encoded[index]<=0x7f)continue;
    const lead=encoded[index],trail=encoded[++index];
    if(lead<0xa1||lead>0xfe||trail===undefined||trail<0xa1||trail>0xfe)throw new Error('UNSUPPORTED_CHARACTERS');
  }
  return encoded;
}
export function encodedMessage(message:string):{type:'SMS'|'LMS';bytes:number} {
  const encoded=eucKrBytes(message);
  if(encoded.length===0 || encoded.length>2000)throw new Error('MESSAGE_TOO_LONG');
  return {type:encoded.length<=90?'SMS':'LMS',bytes:encoded.length};
}
export function smsLabel(value:string,fallback:string) {
  try {eucKrBytes(value);return value;}catch{return fallback;}
}
export function sensSignature(method:string,path:string,timestamp:string,accessKey:string,secretKey:string) {
  return createHmac('sha256',secretKey).update(`${method} ${path}\n${timestamp}\n${accessKey}`).digest('base64');
}
type SensConfig={serviceId:string;accessKey:string;secretKey:string;from:string};
type Transport=(url:string,init:RequestInit)=>Promise<Response>;
export class SensSmsSender implements SmsSender {
  readonly mode='sens' as const;
  private readonly path:string;
  constructor(private readonly config:SensConfig,private readonly transport:Transport=fetch,private readonly now=Date.now) {
    if(!/^[A-Za-z0-9:_-]+$/.test(config.serviceId)||!config.accessKey||!config.secretKey||!/^\d{8,15}$/.test(config.from))
      throw new Error('SENS service ID, access key, secret key and registered sender are required');
    this.path=`/sms/v2/services/${config.serviceId}/messages`;
  }
  private request(method:string,path:string,body?:unknown) {
    const timestamp=String(this.now());
    return this.transport(`https://sens.apigw.ntruss.com${path}`,{
      method,redirect:'error',signal:AbortSignal.timeout(4_000),
      headers:{'Content-Type':'application/json','x-ncp-apigw-timestamp':timestamp,'x-ncp-iam-access-key':this.config.accessKey,
        'x-ncp-apigw-signature-v2':sensSignature(method,path,timestamp,this.config.accessKey,this.config.secretKey)},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
  }
  async send(payload:SmsPayload):Promise<SendResult> {
    let type:'SMS'|'LMS';
    try {type=encodedMessage(payload.message).type;}
    catch(error){return {kind:'rejected',code:(error as Error).message,retryable:false};}
    if(!/^01[016789]\d{7,8}$/.test(payload.phone))return {kind:'rejected',code:'INVALID_RECIPIENT',retryable:false};
    try {
      const response=await this.request('POST',this.path,{type,contentType:'COMM',countryCode:'82',from:this.config.from,
        content:payload.message,...(type==='LMS'?{subject:'픽미업 안내'}:{}),messages:[{to:payload.phone}]});
      if(response.status===429)return {kind:'rejected',code:'PROVIDER_RATE_LIMIT',retryable:true};
      if([400,401,403,404,413].includes(response.status))return {kind:'rejected',code:`PROVIDER_HTTP_${response.status}`,retryable:false};
      if(response.status!==202)return {kind:'unknown',code:`PROVIDER_HTTP_${response.status}`};
      const result=await response.json() as Record<string,unknown>;
      if(result.statusCode!=='202'||result.statusName!=='success'||typeof result.requestId!=='string'||!result.requestId)
        return {kind:'unknown',code:'INVALID_ACCEPTANCE'};
      return {kind:'accepted',requestId:result.requestId};
    }catch{return {kind:'unknown',code:'PROVIDER_TRANSPORT_UNCERTAIN'};}
  }
  async lookup(requestId:string):Promise<Receipt> {
    try {
      const response=await this.request('GET',`${this.path}?requestId=${encodeURIComponent(requestId)}`);
      if(!response.ok)return {state:'UNKNOWN',code:`LOOKUP_HTTP_${response.status}`};
      const result=await response.json() as {statusCode?:string;statusName?:string;messages?:Record<string,unknown>[];hasMore?:boolean};
      if(!['200','202'].includes(String(result.statusCode))||result.statusName!=='success')
        return {state:'UNKNOWN',code:'INVALID_RECEIPT_HEADER'};
      if(!Array.isArray(result.messages)||result.messages.length!==1||result.hasMore===true)
        return {state:'UNKNOWN',code:'RECEIPT_NOT_UNIQUE'};
      const row=result.messages[0];
      if(row.requestId!==requestId||typeof row.messageId!=='string'||!row.messageId)
        return {state:'UNKNOWN',code:'RECEIPT_MISMATCH'};
      if(row.status==='READY'||row.status==='PROCESSING')return {state:'ACCEPTED',messageId:row.messageId};
      if(row.status==='COMPLETED'&&row.statusName==='success'&&String(row.statusCode)==='0')
        return {state:'DELIVERED',messageId:row.messageId,code:'0'};
      if(row.status==='COMPLETED'&&row.statusName==='fail')
        return {state:'FAILED',messageId:row.messageId,code:/^[A-Za-z0-9_-]{1,30}$/.test(String(row.statusCode))?String(row.statusCode):'PROVIDER_FAILURE'};
      return {state:'UNKNOWN',messageId:row.messageId,code:'UNRECOGNIZED_RECEIPT'};
    }catch{return {state:'UNKNOWN',code:'LOOKUP_UNAVAILABLE'};}
  }
}
type SolapiConfig={apiKey:string;apiSecret:string;from:string};
export class SolapiSmsSender implements SmsSender {
  readonly mode='solapi' as const;
  constructor(private readonly config:SolapiConfig,private readonly transport:Transport=fetch,private readonly now=Date.now) {
    if(!/^[A-Za-z0-9_-]+$/.test(config.apiKey)||!config.apiSecret||!/^\d{8,15}$/.test(config.from))
      throw new Error('SOLAPI API key, API secret and registered sender are required');
  }
  private request(method:string,path:string,body?:unknown) {
    const date=new Date(this.now()).toISOString(),salt=randomBytes(16).toString('hex');
    const signature=createHmac('sha256',this.config.apiSecret).update(date+salt).digest('hex');
    return this.transport(`https://api.solapi.com${path}`,{
      method,redirect:'error',signal:AbortSignal.timeout(4_000),
      headers:{'Content-Type':'application/json',
        Authorization:`HMAC-SHA256 apiKey=${this.config.apiKey}, date=${date}, salt=${salt}, signature=${signature}`},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    });
  }
  async send(payload:SmsPayload):Promise<SendResult> {
    let type:'SMS'|'LMS';
    try {type=encodedMessage(payload.message).type;}
    catch(error){return {kind:'rejected',code:(error as Error).message,retryable:false};}
    if(!/^01[016789]\d{7,8}$/.test(payload.phone))return {kind:'rejected',code:'INVALID_RECIPIENT',retryable:false};
    try {
      const response=await this.request('POST','/messages/v4/send-many/detail',{
        messages:[{to:payload.phone,from:this.config.from,text:payload.message,type,country:'82',autoTypeDetect:false,
          ...(type==='LMS'?{subject:'픽미업 안내'}:{})}],allowDuplicates:false,showMessageList:true,
      });
      if(response.status===429)return {kind:'rejected',code:'PROVIDER_RATE_LIMIT',retryable:true};
      if([400,401,403,404,413,422].includes(response.status))return {kind:'rejected',code:`PROVIDER_HTTP_${response.status}`,retryable:false};
      if(!response.ok)return {kind:'unknown',code:`PROVIDER_HTTP_${response.status}`};
      const result=await response.json() as {messageList?:Record<string,unknown>[];failedMessageList?:Record<string,unknown>[]};
      if(!Array.isArray(result.messageList)||!Array.isArray(result.failedMessageList))return {kind:'unknown',code:'INVALID_ACCEPTANCE'};
      const accepted=result.messageList,failed=result.failedMessageList;
      if(accepted.length===1&&failed.length===0&&accepted[0].statusCode==='2000'&&
        typeof accepted[0].messageId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(accepted[0].messageId))
        return {kind:'accepted',requestId:accepted[0].messageId};
      if(accepted.length===0&&failed.length===1&&/^[123]\d{3}$/.test(String(failed[0].statusCode)))
        return {kind:'rejected',code:`SOLAPI_${failed[0].statusCode}`,retryable:false};
      return {kind:'unknown',code:'INVALID_ACCEPTANCE'};
    }catch{return {kind:'unknown',code:'PROVIDER_TRANSPORT_UNCERTAIN'};}
  }
  async lookup(requestId:string):Promise<Receipt> {
    try {
      const query=new URLSearchParams({criteria:'messageId',cond:'eq',value:requestId,limit:'2'});
      const response=await this.request('GET',`/messages/v4/list?${query}`);
      if(!response.ok)return {state:'UNKNOWN',code:`LOOKUP_HTTP_${response.status}`};
      const result=await response.json() as {messageList?:Record<string,Record<string,unknown>>;nextKey?:string};
      if(!result.messageList||typeof result.messageList!=='object'||Array.isArray(result.messageList)||result.nextKey||
        Object.keys(result.messageList).length!==1)return {state:'UNKNOWN',code:'RECEIPT_NOT_UNIQUE'};
      const row=result.messageList[requestId];
      if(!row||row.messageId!==requestId)return {state:'UNKNOWN',code:'RECEIPT_MISMATCH'};
      const code=String(row.statusCode);
      if(row.status==='COMPLETE'&&code==='4000')return {state:'DELIVERED',messageId:requestId,code};
      if(row.status!=='COMPLETE'&&['2000','3000'].includes(code))return {state:'ACCEPTED',messageId:requestId,code};
      if(row.status==='COMPLETE'&&/^[123]\d{3}$/.test(code)&&!['2000','3000'].includes(code))
        return {state:'FAILED',messageId:requestId,code};
      return {state:'UNKNOWN',messageId:requestId,code:'UNRECOGNIZED_RECEIPT'};
    }catch{return {state:'UNKNOWN',code:'LOOKUP_UNAVAILABLE'};}
  }
}
export function senderFromEnvironment(environment:NodeJS.ProcessEnv):SmsSender {
  const mode=smsMode(environment.SMS_MODE);
  if(mode==='local') {
    if(environment.NODE_ENV==='production')throw new Error('Local SMS is forbidden in production');
    return new LocalSmsSender();
  }
  if(mode==='sens')return new SensSmsSender({serviceId:environment.SENS_SERVICE_ID??'',accessKey:environment.SENS_ACCESS_KEY??'',
    secretKey:environment.SENS_SECRET_KEY??'',from:environment.SENS_FROM??''});
  if(mode==='solapi')return new SolapiSmsSender({apiKey:environment.SOLAPI_API_KEY??'',apiSecret:environment.SOLAPI_API_SECRET??'',from:environment.SOLAPI_FROM??''});
  throw new Error('SMS is disabled. Configure SMS_MODE before running the worker.');
}
