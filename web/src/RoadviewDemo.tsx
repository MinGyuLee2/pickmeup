import {useEffect,useRef,useState} from 'react';
import {Brand,Icon} from './Design';
import {loadMap} from './PickupMap';
import type {Point} from './api';
import {nearestRoadview,pointDistance} from './RoadviewLookup';
import './roadview-demo.css';
const places=[
  {name:'강남역',latitude:37.497942,longitude:127.027621},
  {name:'판교역',latitude:37.3948,longitude:127.1112},
  {name:'월정리 해변',latitude:33.55635,longitude:126.795841},
];
type Target=Point&{name:string};
function badge(){const el=document.createElement('div');el.className='rv-person-marker';const dot=document.createElement('span');dot.textContent='지';const label=document.createElement('strong');label.textContent='지연이 위치 부근';el.append(dot,label);return el;}
export default function RoadviewDemo(){
  const [point,setPoint]=useState<Target>(places[0]),[shared,setShared]=useState(true),[view,setView]=useState<'map'|'roadview'>('map');
  const [mapReady,setMapReady]=useState(false),[mapError,setMapError]=useState(false),[photo,setPhoto]=useState<'idle'|'loading'|'ready'|'empty'>('idle'),[reason,setReason]=useState(''),[retry,setRetry]=useState(0);
  const [photoPoint,setPhotoPoint]=useState('');
  const pointKey=`${point.latitude},${point.longitude}`,photoReady=photo==='ready'&&photoPoint===pointKey;
  const mapHost=useRef<HTMLDivElement>(null),roadHost=useRef<HTMLDivElement>(null),openButton=useRef<HTMLButtonElement>(null);
  const runtime=useRef<any>(null),lookup=useRef(0),target=useRef(point);target.current=point;
  useEffect(()=>{
    let disposed=false,cleanup=()=>{};
    void loadMap().then(maps=>{
      if(disposed)return;if(!maps){setMapError(true);return;}
      const map=new maps.Map(mapHost.current,{center:new maps.LatLng(point.latitude,point.longitude),level:3});
      const marker=new maps.CustomOverlay({content:badge(),yAnchor:1.35,zIndex:6});
      const click=(e:any)=>setPoint({name:'지도에서 고른 위치',latitude:e.latLng.getLat(),longitude:e.latLng.getLng()});
      maps.event.addListener(map,'click',click);
      const resize=new ResizeObserver(()=>{map.relayout();map.setCenter(new maps.LatLng(target.current.latitude,target.current.longitude));});resize.observe(mapHost.current!);
      runtime.current={maps,map,marker,road:null,roadMarker:null};setMapReady(true);
      cleanup=()=>{resize.disconnect();maps.event.removeListener(map,'click',click);marker.setMap(null);runtime.current?.roadMarker?.setMap(null);runtime.current=null;};
    }).catch(()=>{if(!disposed)setMapError(true)});
    return()=>{disposed=true;lookup.current++;cleanup();};
  },[]);
  useEffect(()=>{
    const r=runtime.current;if(!r)return;
    if(!shared){r.marker.setMap(null);return;}
    const p=new r.maps.LatLng(point.latitude,point.longitude);r.marker.setPosition(p);r.marker.setMap(r.map);r.map.setCenter(p);
  },[point,shared,mapReady]);
  useEffect(()=>{
    const r=runtime.current;if(!r||!shared||view!=='roadview')return;
    const epoch=++lookup.current,controller=new AbortController();let disposed=false,wanted=0,settled=false;
    setPhoto('loading');setReason('');r.roadMarker?.setMap(null);
    if(!r.road)r.road=new r.maps.Roadview(roadHost.current,{pan:0,tilt:0,zoom:0});
    const road=r.road,position=new r.maps.LatLng(point.latitude,point.longitude);
    const current=()=>!disposed&&lookup.current===epoch;
    const failed=(message:string)=>{if(!current())return;settled=true;setReason(message);setPhoto('empty');r.roadMarker?.setMap(null)};
    const show=()=>{
      if(!current()||!wanted||String(road.getPanoId())!==String(wanted))return;
      try{
        const p=road.getPosition(),distance=pointDistance(point,{latitude:p.getLat(),longitude:p.getLng()});
        if(!Number.isFinite(distance)||distance>85){failed('이 위치와 가까운 로드뷰가 없어요. 지도에서 위치를 확인해 주세요.');return;}
        r.roadMarker?.setMap(null);r.roadMarker=new r.maps.CustomOverlay({content:badge(),position,yAnchor:.5,zIndex:6});r.roadMarker.setAltitude(0);r.roadMarker.setRange(90);r.roadMarker.setMap(road);
        const viewpoint=road.getProjection().viewpointFromCoords(position,0);if(Number.isFinite(viewpoint.pan))road.setViewpoint({...viewpoint,zoom:0});
        settled=true;setPhotoPoint(`${point.latitude},${point.longitude}`);setPhoto('ready');
      }catch{/* Projection becomes available on init. Keep the loading mask until then. */}
    };
    r.maps.event.addListener(road,'init',show);r.maps.event.addListener(road,'panoid_changed',show);
    const timeout=setTimeout(()=>{if(!settled)failed('주변 사진 연결이 늦어지고 있어요. 지도에서 확인하거나 다시 시도해 주세요.');},15000);
    void nearestRoadview(new r.maps.RoadviewClient(),position,controller.signal).then(id=>{if(current()){wanted=id;road.relayout();road.setPanoId(id,position);}}).catch(error=>{if(error.name!=='AbortError')failed(error.message);});
    const resize=new ResizeObserver(()=>road.relayout());if(roadHost.current)resize.observe(roadHost.current);
    return()=>{disposed=true;controller.abort();clearTimeout(timeout);resize.disconnect();r.maps.event.removeListener(road,'init',show);r.maps.event.removeListener(road,'panoid_changed',show);};
  },[point,shared,view,mapReady,retry]);
  function focusPerson(){const r=runtime.current;if(!r?.road||!shared||!photoReady)return;const p=new r.maps.LatLng(point.latitude,point.longitude);const v=r.road.getProjection().viewpointFromCoords(p,0);if(Number.isFinite(v.pan))r.road.setViewpoint({...v,zoom:0});}
  function back(){lookup.current++;setView('map');setPhoto('idle');requestAnimationFrame(()=>openButton.current?.focus());}
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&view==='roadview')back();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[view]);
  function end(){lookup.current++;setShared(false);setView('map');setPhoto('idle');const r=runtime.current;r?.roadMarker?.setMap(null);if(r)r.road=null;roadHost.current?.replaceChildren();}
  function reset(){setPoint(places[0]);setShared(true);setPhoto('idle');setView('map');}
  return <main className="roadview-demo">
    <header className="rv-header"><Brand/><span className="rv-demo-tag">주변 보기 · 예제</span></header>
    <div className="rv-intro"><div><p className="eyebrow">A LITTLE CLOSER</p><h1>기다리는 곳을,<br className="rv-mobile-break"/> 한눈에.</h1><p>주변 풍경으로 만날 위치를 더 쉽게 찾아보세요.</p></div><span className="rv-example-note">가상 상대·위치로 체험해요</span></div>
    <section className="rv-panel" aria-label="상대 주변 보기 예제">
      <div className="rv-panel-top"><div className="rv-person"><span className="rv-avatar">지</span><div><strong>지연이</strong><p>{shared?point.name:'위치 공유 종료'}</p></div></div><div className="rv-presets" aria-label="예제 장소">{places.map(place=><button key={place.name} disabled={!shared} aria-pressed={point.name===place.name} onClick={()=>setPoint(place)}>{place.name}</button>)}</div></div>
      <div className={`rv-stage ${view==='roadview'?'is-photo':''} ${!shared?'is-ended':''}`}>
        <div className="rv-road" ref={roadHost} aria-label="카카오 로드뷰" style={{visibility:view==='roadview'&&photoReady&&shared?'visible':'hidden'}}/>
        <div className="rv-map" ref={mapHost} aria-label="예제 상대 위치 지도"/>
        {shared&&view==='roadview'&&<button className="rv-back" onClick={back}><Icon name="arrow" size={19} style={{transform:'rotate(180deg)'}}/>지도 돌아가기</button>}
        {shared&&view==='roadview'&&photoReady&&<div className="rv-photo-note">촬영된 거리 사진 · 실시간 영상이 아니에요</div>}
        {!shared?<div className="rv-stage-message"><span className="rv-state-icon"><Icon name="check" size={28}/></span><h2>위치 공유가 끝났어요</h2><p>위치 마커와 주변 사진을 닫았어요.</p><button className="primary" onClick={reset}>예제 다시 시작</button></div>:mapError?<div className="rv-stage-message"><h2>지도를 연결하지 못했어요</h2><p>새로고침한 뒤 다시 확인해 주세요.</p><button className="secondary" onClick={()=>location.reload()}>다시 연결</button></div>:!mapReady?<div className="rv-stage-message"><p role="status">지도를 불러오고 있어요…</p></div>:view==='roadview'&&!photoReady?<div className="rv-stage-message"><span className={`rv-state-icon ${photo==='loading'?'is-loading':''}`}><Icon name={photo==='loading'?'clock':'pin'} size={28}/></span><h2>{photo==='empty'?'가까운 사진을 찾지 못했어요':'주변을 살펴보는 중'}</h2><p role="status">{reason||'상대 위치와 가까운 로드뷰를 찾고 있어요.'}</p>{photo==='empty'&&<div className="rv-empty-actions"><button className="secondary" onClick={back}>지도로 보기</button><button className="primary" onClick={()=>setRetry(v=>v+1)}>다시 시도</button></div>}</div>:null}
      </div>
      <div className="rv-panel-bottom"><div><strong>{!shared?'예제를 다시 시작할 수 있어요':view==='roadview'?(photoReady?'상대가 있는 쪽을 살펴보세요':'지도에서도 위치를 확인할 수 있어요'):'지연이는 이 근처에서 기다려요'}</strong><p>{!shared?'실제 위치나 계정 정보는 사용하지 않은 예제입니다.':view==='roadview'?(photoReady?'사진을 드래그해 둘러볼 수 있어요. 지도에서 위치도 확인하세요.':'가까운 거리 사진이 없는 위치에서는 지도를 이용해 주세요.'):'지도를 눌러 기다리는 위치를 바꿔볼 수도 있어요.'}</p></div>{shared&&<button ref={openButton} className={view==='map'?'primary':'secondary'} disabled={!mapReady} onClick={()=>view==='map'?setView('roadview'):photoReady?focusPerson():back()}><Icon name={view==='map'?'person':'pin'} size={20}/>{view==='map'?'상대 주변 보기':photoReady?'상대 위치 방향으로':'지도로 돌아가기'}<Icon name="arrow" size={19}/></button>}</div>
    </section>
    <footer className="rv-footer"><p><Icon name="shield" size={17}/>로드뷰는 과거에 촬영된 사진이에요. 현재 모습이나 정확한 대기 지점과 다를 수 있어요.</p>{shared&&<button className="text-button" onClick={end}>위치 공유 종료 체험</button>}</footer>
  </main>;
}
