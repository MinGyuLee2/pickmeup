type Scene='pickup-ready'|'recipient-waiting'|'pickup-complete';

// Decorative imagery: labels and state remain readable independently of these assets.
export function PickupIllustration({scene}:{scene:Scene}) {
  return <img className="pickup-illustration" src={`/illustrations/${scene}.png`} width={768} height={512} alt="" aria-hidden="true" decoding="async" loading="lazy" onError={event=>{event.currentTarget.style.visibility='hidden';}}/>;
}
