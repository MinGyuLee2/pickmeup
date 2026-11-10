import { object, point, Problem } from './domain.js';

export function locationSample(value:unknown,now:number) {
  const input=object(value),accuracy=input.accuracyMeters,age=input.ageMs;
  if(typeof accuracy!=='number'||!Number.isFinite(accuracy)||accuracy<0||accuracy>100_000 ||
     typeof age!=='number'||!Number.isSafeInteger(age)||age<0||age>30_000)
    throw new Problem(400,'INVALID_LOCATION','위치 정확도와 갱신 시간을 확인해 주세요.');
  return {location:point(input.location),accuracyMeters:accuracy,observedAt:new Date(now-age).toISOString(),receivedAt:new Date(now).toISOString()};
}
export function locationSnapshot(row:Record<string,any>,valid:boolean,now=Date.now()) {
  if(!valid||!row.recipient_location_id)return {state:'OFF',sessionId:null,position:null,ageMs:null};
  const sample=row.recipient_location;
  const age=sample?now-Date.parse(sample.observedAt):Infinity;
  return {state:row.recipient_location_paused?'PAUSED':!sample?'WAITING':age>=0&&age<=30_000?'LIVE':'STALE',
    sessionId:row.recipient_location_id,position:sample??null,ageMs:sample?Math.max(0,age):null};
}
