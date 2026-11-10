import type {Pickup} from './api';
export function isObservationStale(pickup:Pickup|null,now=Date.now()) {
  const sample=pickup?.observation;
  return !sample||[sample.locationReceivedAt,sample.etaReceivedAt].some(t=>{const age=now-Date.parse(t);return !Number.isFinite(age)||age<0||age>30_000;});
}
/** The page banner reflects fresh ETA; durable once-only push is owned by the server. */
export function isNearArrival(pickup:Pickup,now=Date.now()) {
  const sample=pickup.observation;
  return pickup.state==='ACTIVE'&&Date.parse(pickup.expiresAt)>now&&!!sample&&
    [sample.locationReceivedAt,sample.etaReceivedAt].every(t=>{const age=now-Date.parse(t);return age>=0&&age<=30000;})&&
    Number.isFinite(sample.remainingSeconds)&&sample.remainingSeconds>0&&sample.remainingSeconds<=300;
}
