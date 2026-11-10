import type { CSSProperties } from 'react';
export type IconName='arrow'|'pin'|'car'|'check'|'clock'|'person'|'voice'|'shield'|'plus'|'chevron'|'link'|'close'|'minus'|'expand'|'locate';
const paths:Record<IconName, string>={
  arrow:'M5 12h14M13 6l6 6-6 6', pin:'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  car:'m5 7 2-4h10l2 4M4 8h16a1 1 0 0 1 1 1v8H3V9a1 1 0 0 1 1-1ZM5 17v3m14-3v3M6 12h2m8 0h2',
  check:'m5 12 4 4L19 6', clock:'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  person:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  voice:'M12 3v18M7 7v10M17 6v12M3 10v4m18-5v6', shield:'m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5l8-3Zm-4 9 3 3 5-6',
  locate:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  expand:'M8 3H3v5M16 3h5v5M3 16v5h5m13-5v5h-5',
  minus:'M5 12h14', plus:'M12 5v14M5 12h14', chevron:'m9 5 7 7-7 7', link:'m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0', close:'m6 6 12 12M6 18 18 6',
};
export function Icon({name,size=24,style}:{name:IconName;size?:number;style?:CSSProperties}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]}/></svg>;
}
export function Brand(){return <a className="wordmark" href="https://mingyulee2.github.io/pickmeup-landing/" referrerPolicy="no-referrer" aria-label="Pick Me Up 랜딩 페이지">Pick Me Up</a>;}
