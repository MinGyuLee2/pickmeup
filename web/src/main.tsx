import { createRoot } from 'react-dom/client';
import { SharePage } from './SharePage';
import {Brand} from './Design';
import {takeFragmentToken} from './api';
import './style.css';
const root=createRoot(document.getElementById('root')!);
if(window.location.pathname==='/roadview-demo'){
  void import('./RoadviewDemo').then(({default:Demo})=>root.render(<Demo/>));
}else if(import.meta.env.DEV&&window.location.pathname==='/__design'){
  void import('./DesignPreview').then(({default:Preview})=>root.render(<Preview/>));
}else root.render(window.location.pathname==='/s'?<SharePage/>:window.location.pathname==='/pair'?<RetiredPairing/>:<WelcomePage/>);

function RetiredPairing(){takeFragmentToken();return <main className="driver-page"><header className="topline"><Brand/></header><h1>차량에서 바로 시작하세요</h1><p className="muted">차량의 픽미업에서 ‘바로 시작’을 눌러 픽업을 사용할 수 있어요.</p></main>;}

function WelcomePage(){return <main className="driver-page public-welcome"><header className="topline"><Brand/></header><section className="public-welcome-content"><p className="eyebrow">PICK ME UP</p><h1>우리,<br/>곧 만나요.</h1><p className="muted">픽업은 차량의 픽미업에서 바로 시작하세요.<br/>문자로 받은 링크에서 도착 시간과 위치를 확인할 수 있어요.</p></section></main>;}
