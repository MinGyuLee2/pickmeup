import type {Pickup} from './api';
/** A late GET/readiness response must not undo a newer pin selection or removal. */
export function mergeWaitingPoint(current:Pickup|null,next:Pickup):Pickup {
  if(next.state!=='ACTIVE'&&next.state!=='ARRIVED')return next;
  if(current?.id===next.id&&(current.waitingPointRevision??0)>(next.waitingPointRevision??0))
    return {...next,waitingPoint:current.waitingPoint,waitingPointRevision:current.waitingPointRevision,waitingPointConsent:current.waitingPointConsent};
  return next;
}
