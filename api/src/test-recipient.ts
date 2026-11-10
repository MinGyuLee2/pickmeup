/** Existing one-pickup fixtures explicitly scope URLs; multi-link tests use raw URLs. */
export function recipientPath(path:string,headers:{cookie?:string;[key:string]:unknown}) {
  const compact=headers.cookie?.match(/pmu_share_(?:challenge_)?([a-f0-9]{32})=/)?.[1];
  const id=compact?`${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}`:'00000000-0000-4000-8000-000000000000';
  return `${path}?pickupId=${id}`;
}
