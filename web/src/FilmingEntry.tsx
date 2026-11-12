import {createRoot} from 'react-dom/client';
import {SharePage} from './SharePage';
import './style.css';

// Separate filming bundle only. The production index never imports this module.
const prefix='/filming';
const originalFetch=window.fetch.bind(window),OriginalEvents=window.EventSource;
window.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
  return originalFetch(url.origin===location.origin&&url.pathname.startsWith('/api/')?prefix+url.pathname+url.search:input,options);
};
window.EventSource=class extends OriginalEvents {
  constructor(input:string|URL,options?:EventSourceInit){const url=new URL(input,location.href);super(url.origin===location.origin&&url.pathname.startsWith('/api/')?prefix+url.pathname+url.search:input,options);}
};
const replace=history.replaceState.bind(history);
history.replaceState=(state,title,input)=>{
  if(input!=null){const url=new URL(input,location.href);if(url.origin===location.origin&&!url.pathname.startsWith(prefix+'/'))input=prefix+url.pathname+url.search+url.hash;}
  replace(state,title,input);
};
createRoot(document.getElementById('root')!).render(<SharePage/>);
