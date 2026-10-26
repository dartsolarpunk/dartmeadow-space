/* DART Meadow — AR mode (crunch 2).
   • AR button on the kite's lower slope, right of the FPS readout (main kite and the
     walking / flight mini kites). Shown only where WebXR immersive-ar exists (Android
     Chrome tablets, Quest-style headsets); hidden on iOS Safari and desktops.
     `?arpreview=1` shows it anyway (layout screenshots; pressing it reports unsupported).
   • Terrain (on foot or in atmospheric flight): tap a flat surface (hit-test reticle) and
     an anchor is placed there; the local world-map terrain is drawn on it as a tabletop
     diorama (grid-unit LOD by graphics preset), scrolled under the fixed anchor as Ariel
     nears the border, the edges fading through the world's horizon colour into the
     passthrough. Atmospheric flight keeps the same anchor and only widens the LOD span.
   • Interstellar: the live space scene draws over passthrough, its background and sky
     shells removed, the camera following the game camera with the device pose layered on.
   Game logic keeps running: while the session owns the frame, window rAF callbacks are
   pumped from the XR frame and the hidden flight canvas render is skipped (no double cost).
   Modular: nothing in index.html calls in here except the script tag. API: window.DMAR. */
(function(){
  'use strict';
  if(window.DMAR) return;
  var Q=new URLSearchParams(location.search);
  var PREVIEW=Q.get('arpreview')==='1';
  var supported=false, S=null;   // S = live session state
  // dom-overlay shows the page itself over passthrough: while AR is on, the game's own canvases and
  // screen backgrounds go transparent so only the HUD (and the minimap) sits on the camera image
  (function(){ var st=document.createElement('style'); st.textContent=
    'html.dm-ar-on,body.dm-ar-on,body.dm-ar-on .screen,body.dm-ar-on #game-container{background:transparent!important}'+
    'body.dm-ar-on canvas:not(#dm-ar-canvas):not(#minimap-canvas){visibility:hidden!important}';
    document.head.appendChild(st); })();

  // ---------- button ----------
  function mkBtn(){ var b=document.createElement('button'); b.type='button'; b.className='dm-ar-btn'; b.textContent='AR'; b.title='Augmented reality (tap again to exit)';
    b.addEventListener('click',function(e){ e.stopPropagation(); toggle(); }); b.addEventListener('touchstart',function(e){ e.stopPropagation(); },{passive:true}); return b; }
  function placeButtons(){
    if(!(supported||PREVIEW)) return;
    document.querySelectorAll('.hud-c, .mini-kite').forEach(function(k){
      if(k.querySelector(':scope > .dm-ar-btn')) return;
      var b=mkBtn(); var f=k.querySelector(':scope > .dm-fps');
      if(f&&f.nextSibling) k.insertBefore(b,f.nextSibling); else k.appendChild(b);
    });
    syncBtns();
  }
  function syncBtns(){ document.querySelectorAll('.dm-ar-btn').forEach(function(b){ b.classList.toggle('on',!!S); b.textContent=S?'EXIT':'AR'; }); }
  function toast(msg){ var t=document.getElementById('dm-ar-toast'); if(!t){ t=document.createElement('div'); t.id='dm-ar-toast';
      t.style.cssText='position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:99998;padding:8px 14px;border-radius:4px;background:rgba(6,12,24,.82);color:#dfeaff;font:600 12px/1.3 var(--font-mono,monospace);letter-spacing:.05em;pointer-events:none;max-width:90vw;text-align:center';
      document.body.appendChild(t); }
    t.textContent=msg; t.style.display=msg?'block':'none'; }

  // ---------- game-state probes (classic-script globals, read defensively) ----------
  function g(name){ try{ return (0,eval)('typeof '+name+'!=="undefined"?'+name+':undefined'); }catch(e){ return undefined; } }
  function terrainCtx(){
    var PW=window.PW; if(!PW||!PW.active) return null;
    var H=g('_surfHeight')||g('_atmoHeight')||((g('TERRAIN')||{}).H);
    if(typeof H!=='function') return null;
    var pos=null, flying=false;
    var sp=g('surfPlayer'); if(g('surfaceActive')&&sp&&sp.pos) pos=sp.pos;
    var ab=g('atmoBoard'); if(!pos&&g('atmoActive')&&ab&&ab.position){ pos=ab.position; flying=true; }
    if(!pos&&PW.board&&PW.board.position){ pos=PW.board.position; flying=true; }
    if(!pos) return null;
    return {H:H,pos:pos,flying:flying,pal:PW.pal};
  }
  function preset(){ var G=g('GFX'); var p=G&&G.preset; if(p==='auto'&&G.isMobile) p='medium'; return p||'medium'; }

  // ---------- diorama ----------
  var DIO_SIZE=0.56;   // metres across on the table
  function buildDiorama(T){
    var N=preset()==='ultra'?72:preset()==='low'?40:56;   // grid units per side
    var geo=new T.PlaneGeometry(DIO_SIZE,DIO_SIZE,N-1,N-1); geo.rotateX(-Math.PI/2);
    var cnt=N*N, col=new Float32Array(cnt*3), fade=new Float32Array(cnt);
    for(var j=0;j<N;j++) for(var i=0;i<N;i++){ var u=i/(N-1)*2-1, v=j/(N-1)*2-1, r=Math.max(Math.abs(u),Math.abs(v)), rr=Math.hypot(u,v)/1.25;
      var e=Math.max(r,rr); fade[j*N+i]=Math.max(0,Math.min(1,(1-e)/0.22)); }
    geo.setAttribute('color',new T.BufferAttribute(col,3));
    geo.setAttribute('fade',new T.BufferAttribute(fade,1));
    var TSL=T.TSL, horizon=TSL.uniform(new T.Color(0x9fb8d8));
    var m=new T.MeshLambertNodeMaterial({transparent:true,depthWrite:true});
    var f=TSL.attribute('fade','float');
    m.colorNode=TSL.mix(horizon,TSL.vertexColor(),TSL.smoothstep(0.0,0.8,f));
    m.opacityNode=f;
    var mesh=new T.Mesh(geo,m); mesh.frustumCulled=false;
    var marker=new T.Mesh(new T.ConeGeometry(0.008,0.022,10),new T.MeshBasicNodeMaterial({color:0xffd27a}));
    marker.rotation.x=Math.PI;
    var grp=new T.Group(); grp.add(mesh); grp.add(marker);
    return {N:N,geo:geo,mesh:mesh,marker:marker,grp:grp,horizon:horizon,cx:NaN,cz:NaN,span:0,hRef:0};
  }
  function fillDiorama(D,ctx,force){
    var span=ctx.flying?1800:520;                 // world units across: flight = coarser LOD, same anchor
    var cell=span/(D.N-1);
    var px=ctx.pos.x, pz=ctx.pos.z;
    var need=force||D.span!==span||!isFinite(D.cx)||Math.abs(px-D.cx)>span*0.2||Math.abs(pz-D.cz)>span*0.2;
    if(need){
      D.span=span; D.cx=Math.round(px/cell)*cell; D.cz=Math.round(pz/cell)*cell;   // scroll in whole grid units
      var P=D.geo.attributes.position, C=D.geo.attributes.color, N=D.N, k=DIO_SIZE/span, ex=1.6;
      var hs=new Float32Array(N*N), lo=Infinity, hi=-Infinity;
      for(var j=0;j<N;j++) for(var i=0;i<N;i++){ var wx=D.cx+(i/(N-1)-0.5)*span, wz=D.cz+(j/(N-1)-0.5)*span, h=0;
        try{ h=+ctx.H(wx,wz); }catch(e){} if(!isFinite(h)) h=0; hs[j*N+i]=h; if(h<lo) lo=h; if(h>hi) hi=h; }
      if((hi-lo)*k*ex>0.16) ex=0.16/((hi-lo)*k); D.ex=ex;   // keep relief table-sized
      D.hRef=lo; var pal=ctx.pal||{}, C3=window.THREE.Color, sea=pal.water?(pal.seaLevel!=null?pal.seaLevel:0):-1e9;
      var c0=new C3(pal.ground2!=null?pal.ground2:0x4a5a30), c1=new C3(pal.ground!=null?pal.ground:0x6b7b3a), c2=new C3(pal.rock!=null?pal.rock:0x9a8a7a),
          seaC=new C3(pal.liquidColor!=null?pal.liquidColor:0x1a4a7a), c=new C3();
      for(var n=0;n<N*N;n++){ var hh=hs[n]; P.setY(n,(Math.max(hh,sea>-1e8?sea:hh)-lo)*k*ex+0.004);
        var t=hi>lo?(hh-lo)/(hi-lo):0; if(hh<sea) c.copy(seaC); else if(t<0.5) c.copy(c0).lerp(c1,t*2); else c.copy(c1).lerp(c2,(t-0.5)*2); C.setXYZ(n,c.r,c.g,c.b); }
      P.needsUpdate=true; C.needsUpdate=true; D.geo.computeVertexNormals();
      // edge fade through the world's horizon colour (its fog / lower sky); airless worlds just fade out
      try{ var hz=pal.atmos?(pal.fog!=null?pal.fog:(pal.sky&&pal.sky[0])):null; D.horizon.value.set(hz!=null?hz:(pal.ground!=null?pal.ground:0x808080)); }catch(e){}
    }
    var k2=DIO_SIZE/D.span, h0=0; try{ h0=+ctx.H(px,pz); }catch(e){}
    D.marker.position.set((px-D.cx)*k2,((isFinite(h0)?h0:D.hRef)-D.hRef)*k2*(D.ex||1.6)+0.016+(ctx.flying?0.03:0),(pz-D.cz)*k2);
  }

  // ---------- rAF pump + render skip ----------
  var _raf=window.requestAnimationFrame.bind(window), _caf=window.cancelAnimationFrame.bind(window), q=new Map(), qid=1e9;
  function pumpOn(){ window.requestAnimationFrame=function(cb){ var id=++qid; q.set(id,cb); return id; };
    window.cancelAnimationFrame=function(id){ if(q.has(id)) q.delete(id); else _caf(id); }; }
  function pumpOff(){ window.requestAnimationFrame=_raf; window.cancelAnimationFrame=_caf; var cbs=Array.from(q.values()); q.clear(); cbs.forEach(function(cb){ _raf(cb); }); }
  function pump(t){ if(!q.size) return; var cbs=Array.from(q.values()); q.clear(); for(var i=0;i<cbs.length;i++){ try{ cbs[i](t); }catch(e){ console.warn('[AR] frame cb',e); } } }

  // ---------- interstellar: strip background / sky shells ----------
  function stripSky(scene,T){
    var saved={bg:scene.background,env:scene.environment,hid:[]};
    scene.background=null;
    // only shells the game marks itself (userData.dmSkyShell: the sky domes in index.html and ui/dm-sky.js)
    scene.traverse(function(o){ if(o.visible&&o.userData&&o.userData.dmSkyShell){ o.visible=false; saved.hid.push(o); } });
    return saved;
  }
  function unstrip(scene,saved){ if(!saved) return; scene.background=saved.bg; saved.hid.forEach(function(o){ o.visible=true; }); }

  // ---------- session ----------
  async function enter(){
    var T=window.THREE; if(!T||!navigator.xr){ toast('AR is not available on this device'); setTimeout(function(){toast('');},2500); return; }
    var ok=false; try{ ok=await navigator.xr.isSessionSupported('immersive-ar'); }catch(e){}
    if(!ok){ toast('AR is not available on this device'); setTimeout(function(){toast('');},2500); return; }
    var overlay=document.body;
    var session=await navigator.xr.requestSession('immersive-ar',{requiredFeatures:['hit-test'],optionalFeatures:['anchors','dom-overlay','local-floor'],domOverlay:{root:overlay}});
    var cv=document.createElement('canvas'); cv.id='dm-ar-canvas'; cv.style.cssText='position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0';
    document.body.appendChild(cv);
    var r=new T.WebGPURenderer({canvas:cv,alpha:true,antialias:false,forceWebGL:true,powerPreference:'high-performance'});
    await r.init(); r.setClearColor(0x000000,0); r.xr.enabled=true;
    try{ r.xr.setReferenceSpaceType('local'); }catch(e){}
    var scene=new T.Scene();
    scene.add(new T.HemisphereLight(0xdfe8ff,0x40362a,1.4)); var sun=new T.DirectionalLight(0xffffff,1.6); sun.position.set(0.4,1,0.3); scene.add(sun);
    var cam=new T.PerspectiveCamera(60,1,0.01,1e7);
    var reticle=new T.Mesh(new T.RingGeometry(0.04,0.055,32).rotateX(-Math.PI/2),new T.MeshBasicNodeMaterial({color:0x8fd0ff}));
    reticle.matrixAutoUpdate=false; reticle.visible=false; scene.add(reticle);
    var table=new T.Group(); table.matrixAutoUpdate=false; table.visible=false; scene.add(table);
    var rig=new T.Object3D(), rigCam=new T.PerspectiveCamera(60,1,0.05,1e9); rig.add(rigCam);
    var hudScene=new T.Scene(), plate=new T.Group(); plate.matrixAutoUpdate=false; hudScene.add(plate);
    S={hudScene:hudScene,plate:plate,session:session,r:r,cv:cv,scene:scene,cam:cam,reticle:reticle,table:table,rig:rig,rigCam:rigCam,hitSrc:null,anchor:null,placed:false,errs:0,D:null,sky:null,flight:null,mode:null};
    session.addEventListener('end',cleanup);
    syncBtns();
    await r.xr.setSession(session);
    try{ var vs=await session.requestReferenceSpace('viewer'); S.hitSrc=await session.requestHitTestSource({space:vs}); }catch(e){ console.warn('[AR] hit-test',e); }
    session.addEventListener('select',onSelect);
    // the hidden flight canvas stops drawing while AR owns the frame
    var FR=g('flightRenderer'); if(FR&&FR.render){ S.flight=FR; S.flightRender=FR.render; FR.render=function(){}; }
    pumpOn();
    try{ window.DMUI3DMesh&&DMUI3DMesh.arHold(true); }catch(e){}
    document.body.classList.add('dm-ar-on'); document.documentElement.classList.add('dm-ar-on');
    r.setAnimationLoop(frame);
  }
  var _lastHit=null;
  function onSelect(){
    if(!S||S.placed||!_lastHit) return;
    var hit=_lastHit; S.placed=true; S.reticle.visible=false;
    S.table.matrix.fromArray(hit.getPose(S.r.xr.getReferenceSpace()).transform.matrix); S.table.visible=true;
    if(hit.createAnchor) hit.createAnchor().then(function(a){ if(S) S.anchor=a; }).catch(function(){});
    toast('');
  }
  function frame(t,xf){
    if(!S) return;
    try{ frameBody(t,xf); S&&(S.errs=0); }
    catch(e){ console.warn('[AR] frame',e); if(S&&++S.errs>=3) abort(e&&e.message); }
  }
  function frameBody(t,xf){
    pump(t);
    var T=window.THREE, ref=S.r.xr.getReferenceSpace();
    var ctx=terrainCtx(), mode=ctx?'terrain':'space';
    if(mode!==S.mode){ switchMode(mode); }
    if(mode==='terrain'){
      if(!S.placed&&xf&&S.hitSrc){ var hs=xf.getHitTestResults(S.hitSrc); if(hs.length){ _lastHit=hs[0]; var p=hs[0].getPose(ref); S.reticle.matrix.fromArray(p.transform.matrix); S.reticle.visible=true; } else S.reticle.visible=false; }
      if(S.anchor&&xf&&xf.trackedAnchors&&xf.trackedAnchors.has(S.anchor)){ var ap=xf.getPose(S.anchor.anchorSpace,ref); if(ap) S.table.matrix.fromArray(ap.transform.matrix); }
      if(S.placed){ if(!S.D){ S.D=buildDiorama(T); S.table.add(S.D.grp); } fillDiorama(S.D,ctx,false); }
      S.r.render(S.scene,S.cam); hud(S.cam);
    }else{
      var fs=g('flightScene'), fc=g('flightCamera');
      if(fs&&fc){ fc.updateMatrixWorld(); fc.matrixWorld.decompose(S.rig.position,S.rig.quaternion,S.rig.scale); S.rig.scale.setScalar(1); S.rig.updateMatrixWorld(true);
        if(fs.background){ if(S.sky) S.sky.bg=fs.background; fs.background=null; }   // the game may re-set it each frame
        S.rigCam.near=fc.near; S.rigCam.far=fc.far; S.r.render(fs,S.rigCam); hud(S.rigCam); }
      else { S.r.render(S.scene,S.cam); hud(S.cam); }
    }
  }
  // the 3D HUD (ui/dm-ui3d-mesh.js): the very same merged mesh, on a head-locked plate 0.6 m out
  var _m4=null;
  function hud(camUsed){
    var M=window.DMUI3DMesh; if(!M||!M.mesh||!M.mesh.visible) return; var T=window.THREE;
    if(M.mesh.parent!==S.plate) S.plate.add(M.mesh);
    var pe=camUsed.projectionMatrix.elements, fovY=2*Math.atan(1/(pe[5]||1)), d=0.6, sc=2*d*Math.tan(fovY/2)/(innerHeight||1);
    _m4=_m4||new T.Matrix4(); camUsed.updateMatrixWorld();
    S.plate.matrix.copy(camUsed.matrixWorld).multiply(_m4.makeTranslation(0,0,-d)).multiply(new T.Matrix4().makeScale(sc,sc,sc)); S.plate.matrixWorldNeedsUpdate=true;
    var ac=S.r.autoClear; S.r.autoClear=false; try{ S.r.clearDepth&&S.r.clearDepth(); S.r.render(S.hudScene,camUsed); }catch(e){} S.r.autoClear=ac;
  }
  function switchMode(mode){
    var fs=g('flightScene');
    if(S.mode==='space'&&fs) unstrip(fs,S.sky), S.sky=null;
    S.mode=mode;
    if(mode==='space'&&fs){ S.sky=stripSky(fs,window.THREE); toast(''); }
    if(mode==='terrain'&&!S.placed) toast('Point at a flat surface and tap to place the world');
    if(mode==='terrain'&&S.D) fillDiorama(S.D,terrainCtx(),true);
  }
  // Restoring the game's rAF and flightRenderer.render is guaranteed: each teardown step is isolated and the
  // two swaps are undone in `finally`, whatever throws. Runs on session 'end', on a frame that keeps throwing,
  // on window error / pagehide, and from enter() failures.
  function cleanup(){
    if(!S) return; var s=S; S=null;
    try{
      try{ s.r.setAnimationLoop(null); }catch(e){}
      try{ var M=window.DMUI3DMesh; M&&M.arHold(false); }catch(e){}
      try{ var fs=g('flightScene'); if(fs) unstrip(fs,s.sky); }catch(e){}
      try{ s.hitSrc&&s.hitSrc.cancel(); }catch(e){} try{ s.anchor&&s.anchor.delete&&s.anchor.delete(); }catch(e){}
      try{ s.D&&(s.D.geo.dispose(),s.D.mesh.material.dispose()); }catch(e){}
      try{ s.session&&s.session.removeEventListener('end',cleanup); }catch(e){}
      try{ s.r.dispose(); }catch(e){} try{ s.cv.remove(); }catch(e){}
    } finally {
      try{ pumpOff(); }catch(e){ window.requestAnimationFrame=_raf; window.cancelAnimationFrame=_caf; }
      if(s.flight&&s.flightRender) s.flight.render=s.flightRender;
      document.body.classList.remove('dm-ar-on'); document.documentElement.classList.remove('dm-ar-on');
      try{ toast(''); syncBtns(); window.dispatchEvent(new Event('resize')); }catch(e){}
    }
  }
  function abort(why){ console.warn('[AR] aborting session:',why); var s=S; cleanup(); try{ s&&s.session&&s.session.end().catch(function(){}); }catch(e){} }
  window.addEventListener('pagehide',function(){ if(S) abort('pagehide'); });
  window.addEventListener('error',function(ev){ if(S&&S.errs>=3) abort(ev&&ev.message); });
  function exit(){ if(S&&S.session) S.session.end().catch(cleanup); }
  function toggle(){ if(S) exit(); else enter().catch(function(e){ console.warn('[AR] enter failed',e); if(S) abort('enter failed'); toast('Could not start AR'); setTimeout(function(){toast('');},2500); }); }

  window.DMAR={toggle:toggle,exit:exit,get active(){ return !!S; },get supported(){ return supported; },_buildDiorama:buildDiorama,_fillDiorama:fillDiorama,_stripSky:stripSky,_unstrip:unstrip};
  function init(){
    placeButtons();
    try{ new MutationObserver(function(){ placeButtons(); }).observe(document.body,{childList:true,subtree:false}); }catch(e){}
    if(navigator.xr&&navigator.xr.isSessionSupported){ navigator.xr.isSessionSupported('immersive-ar').then(function(ok){ supported=!!ok; placeButtons(); }).catch(function(){}); }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
