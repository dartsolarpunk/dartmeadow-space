/* DART Meadow — AR mode (crunch 2).
   • AR button on the kite's lower slope, right of the FPS readout (main kite and the
     walking / flight mini kites). Always shown in game (v148). WebXR immersive-ar with
     hit-test where it exists (Android Chrome, headsets); otherwise (iOS Safari, desktops)
     a camera-passthrough fallback: getUserMedia back camera behind a transparent canvas,
     DeviceOrientation head tracking and tap-to-place on a virtual table 45 cm below the
     phone (approximate placement, no real surface detection). With neither, the button
     says plainly that AR isn't supported here.
   • Terrain (on foot or in atmospheric flight): tap a flat surface (hit-test reticle) and
     an anchor is placed there; the local world-map terrain is drawn on it as a tabletop
     diorama (grid-unit LOD by graphics preset), scrolled under the fixed anchor as Ariel
     nears the border, the edges fading through the world's horizon colour into the
     passthrough. Atmospheric flight keeps the same anchor and only widens the LOD span.
   • Interstellar: a table-top orrery (Sun, planets, orbits, your ship) placed like the terrain map; the game scene is not redrawn
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
    'body.dm-ar-on canvas:not(#dm-ar-canvas):not(#minimap-canvas){visibility:hidden!important}'+
    '#dm-ar-video{position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:-2;pointer-events:none;background:#000}'+
    'body.dm-ar-cam #dm-ar-canvas{z-index:-1!important}'+
    // full-overlay view: the game's own canvas, screen-blended over the camera. Screen is the alpha-correct composite for
    // this content without touching any shader: black (the stripped sky, the black discs of the lens bubble, keyed sprite
    // quads) contributes nothing, additive glows/sprites/smoke add their light with their own feathered edges, and the
    // game's AA, bloom, tonemap and post passes all stay as they are
    'html.dm-ar-on body.dm-ar-full canvas.dm-ar-game:not(#dm-ar-canvas):not(#minimap-canvas){visibility:visible!important;mix-blend-mode:screen}'+
    'body.dm-ar-full #dm-ar-canvas{visibility:hidden!important}'+
    '#dm-ar-view{position:fixed;right:calc(12px + env(safe-area-inset-right,0px));top:calc(50% - 18px);z-index:99997;padding:8px 12px;border-radius:4px;border:1px solid rgba(120,200,255,.45);background:rgba(6,12,24,.7);color:#bfe6ff;font:600 11px/1 var(--font-mono,monospace);letter-spacing:.08em;text-transform:uppercase}';
    document.head.appendChild(st); })();

  // ---------- button ----------
  function mkBtn(){ var b=document.createElement('button'); b.type='button'; b.className='dm-ar-btn'; b.textContent='AR'; b.title='Augmented reality (tap again to exit)';
    b.addEventListener('click',function(e){ e.stopPropagation(); toggle(); }); b.addEventListener('touchstart',function(e){ e.stopPropagation(); },{passive:true}); return b; }
  function placeButtons(){
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
  var DIO_SIZE=0.48;   // metres across on the table (3x3 units; the inner square ~16 cm)
  // Board layout (Justin's spec): a 3x3 grid of equal units. The centre unit is Ariel's high-detail square at full grid
  // resolution; the ring of 8 units around it is the same scenery at a lower LOD, fully opaque out to halfway across
  // the ring, then feathering in true alpha to fully transparent at the outer perimeter; beyond it, only passthrough.
  // The inner square stays centred on her (the board scrolls under its fixed anchor in whole cells); flight uses the
  // same board and area, she just lifts above it.
  var L_UNIT=320;   // world units per grid unit (the high-detail square)
  function boardMesh(T,N,size,ring){
    var geo=new T.PlaneGeometry(size,size,N-1,N-1); geo.rotateX(-Math.PI/2);
    var cnt=N*N, col=new Float32Array(cnt*3), fade=new Float32Array(cnt);
    for(var j=0;j<N;j++) for(var i=0;i<N;i++){ var e=Math.max(Math.abs(i/(N-1)*2-1),Math.abs(j/(N-1)*2-1));   // 0 centre .. 1 perimeter
      fade[j*N+i]=ring?Math.max(0,Math.min(1,(1-e)/(1-2/3))):1; }   // ring: opaque to 2/3 (halfway across it), 0 at the edge
    geo.setAttribute('color',new T.BufferAttribute(col,3)); geo.setAttribute('fade',new T.BufferAttribute(fade,1));
    var TSL=T.TSL, f=TSL.attribute('fade','float'), horizon=TSL.uniform(new T.Color(0x9fb8d8));
    var m=new T.MeshLambertNodeMaterial({transparent:ring,depthWrite:true,polygonOffset:ring,polygonOffsetFactor:ring?2:0,polygonOffsetUnits:ring?2:0});
    m.colorNode=ring?TSL.mix(horizon,TSL.vertexColor(),TSL.smoothstep(0.0,1.0,f)):TSL.vertexColor();
    if(ring) m.opacityNode=f.mul(f).mul(TSL.float(3).sub(f.mul(2)));   // smoothstep feather in alpha (premultiplied by the renderer), never keyed to black
    var mesh=new T.Mesh(geo,m); mesh.frustumCulled=false; mesh.renderOrder=ring?1:0;
    return {N:N,size:size,geo:geo,mesh:mesh,horizon:horizon};
  }
  function buildDiorama(T){
    var pr=preset(), Ni=pr==='ultra'?72:pr==='low'?40:56, No=pr==='ultra'?60:pr==='low'?36:48;   // inner: full detail; ring: lower LOD over 3x the span
    var unit=DIO_SIZE/3;
    var inner=boardMesh(T,Ni,unit,false), outer=boardMesh(T,No,DIO_SIZE,true);
    var marker=new T.Mesh(new T.ConeGeometry(0.006,0.018,10),new T.MeshBasicNodeMaterial({color:0xffd27a})); marker.rotation.x=Math.PI;
    var grp=new T.Group(), board=new T.Group(); board.add(outer.mesh); board.add(inner.mesh); grp.add(board); grp.add(marker);
    return {inner:inner,outer:outer,geo:inner.geo,mesh:inner.mesh,marker:marker,grp:grp,board:board,horizon:inner.horizon,cx:NaN,cz:NaN,span:0,hRef:0,
      dispose:function(){ [inner,outer].forEach(function(b){ b.geo.dispose(); b.mesh.material.dispose(); }); marker.geometry.dispose(); marker.material.dispose(); }};
  }
  function fillBoard(B,ctx,cx,cz,span,lo,k,ex,pal){
    var P=B.geo.attributes.position, C=B.geo.attributes.color, N=B.N, C3=window.THREE.Color, sea=pal.water?(pal.seaLevel!=null?pal.seaLevel:0):-1e9;
    var c0=new C3(pal.ground2!=null?pal.ground2:0x4a5a30), c1=new C3(pal.ground!=null?pal.ground:0x6b7b3a), c2=new C3(pal.rock!=null?pal.rock:0x9a8a7a),
        seaC=new C3(pal.liquidColor!=null?pal.liquidColor:0x1a4a7a), c=new C3(), hi=lo+0.16/(k*ex);
    for(var j=0;j<N;j++) for(var i=0;i<N;i++){ var n=j*N+i, h=0; try{ h=+ctx.H(cx+(i/(N-1)-0.5)*span,cz+(j/(N-1)-0.5)*span); }catch(e){} if(!isFinite(h)) h=lo;
      P.setY(n,(Math.max(h,sea>-1e8?sea:h)-lo)*k*ex+0.004); var t=Math.max(0,Math.min(1,(h-lo)/(hi-lo)));
      if(h<sea) c.copy(seaC); else if(t<0.5) c.copy(c0).lerp(c1,t*2); else c.copy(c1).lerp(c2,(t-0.5)*2); C.setXYZ(n,c.r,c.g,c.b); }
    P.needsUpdate=true; C.needsUpdate=true; B.geo.computeVertexNormals();
  }
  function fillDiorama(D,ctx,force){
    var unit=L_UNIT, span=unit*3, cell=unit/(D.inner.N-1), k=DIO_SIZE/span;
    var px=ctx.pos.x, pz=ctx.pos.z;
    var need=force||D.span!==span||!isFinite(D.cx)||Math.abs(px-D.cx)>cell*2||Math.abs(pz-D.cz)>cell*2;
    if(need){
      D.span=span; D.cx=Math.round(px/cell)*cell; D.cz=Math.round(pz/cell)*cell;   // re-centre in whole cells: the inner square follows her
      var lo=Infinity, hi=-Infinity, n=24;
      for(var j=0;j<n;j++) for(var i=0;i<n;i++){ var h=0; try{ h=+ctx.H(D.cx+(i/(n-1)-0.5)*span,D.cz+(j/(n-1)-0.5)*span); }catch(e){} if(isFinite(h)){ if(h<lo) lo=h; if(h>hi) hi=h; } }
      if(!isFinite(lo)){ lo=0; hi=1; }
      if(D.hRef===0||force||Math.abs(lo-D.hRef)>(hi-lo)*0.25) D.hRef=lo;   // keep the base steady while scrolling
      var ex=1.6; if((hi-D.hRef)*k*ex>0.12) ex=0.12/Math.max(1e-6,(hi-D.hRef)*k); D.ex=ex;   // relief kept table-sized
      var pal=ctx.pal||{};
      fillBoard(D.inner,ctx,D.cx,D.cz,unit,D.hRef,k,ex,pal);
      fillBoard(D.outer,ctx,D.cx,D.cz,span,D.hRef,k,ex,pal);
      try{ var hz=pal.atmos?(pal.fog!=null?pal.fog:(pal.sky&&pal.sky[0])):null; D.outer.horizon.value.set(hz!=null?hz:(pal.ground!=null?pal.ground:0x808080)); }catch(e){}
    }
    // sub-cell scroll: the board slides so she stays at the centre; the marker sits on her
    D.board.position.set((D.cx-px)*k,0,(D.cz-pz)*k);
    var h0=0; try{ h0=+ctx.H(px,pz); }catch(e){}
    var lift=0; if(ctx.flying){ var y=ctx.pos.y; lift=isFinite(y)&&isFinite(h0)?Math.max(0.02,Math.min(0.12,(y-h0)*k*(D.ex||1.6))):0.04; }   // flight: lifted above the board, within its volume
    D.marker.position.set(0,((isFinite(h0)?h0:D.hRef)-D.hRef)*k*(D.ex||1.6)+0.014+lift,0);
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

  // ---------- interstellar: a table-top orrery ----------
  // Drawing the live flightScene through a second (WebGL) renderer meant recompiling every game material on the AR
  // renderer (a long freeze on iOS) and put the AR eye wherever the game camera was, often inside the Sun's glow
  // shells (the full-screen yellow-tan view). Space AR instead shows a small orrery, built from celestialBodies,
  // on the placed table: one shared sphere geometry and a few flat materials, so it compiles in milliseconds.
  var ORR_R=0.22, PCOL={Mercury:0x9c8a7a,Venus:0xddaa44,Earth:0x3a6fe0,Mars:0xcc4411,Jupiter:0xcc9944,Saturn:0xe0c27a,Uranus:0x7fd6e0,Neptune:0x3f5fe0,Pluto:0xc9b29a};   // metres: outermost orbit on the table
  function buildOrrery(T){
    var grp=new T.Group(), geo=new T.SphereGeometry(1,24,16), items=[], ringMat=new T.LineBasicNodeMaterial({color:0x8fd0ff,transparent:true,opacity:0.28});
    var sunM=new T.Mesh(geo,new T.MeshBasicNodeMaterial({color:0xffd27a})); sunM.scale.setScalar(0.03); grp.add(sunM);
    var halo=new T.Mesh(geo,new T.MeshBasicNodeMaterial({color:0xffb347,transparent:true,opacity:0.18,depthWrite:false})); halo.scale.setScalar(0.045); grp.add(halo);
    var me=new T.Mesh(new T.OctahedronGeometry(1),new T.MeshBasicNodeMaterial({color:0x6effd8})); me.scale.setScalar(0.009); grp.add(me);
    var ringGeo=(function(){ var pts=[]; for(var i=0;i<=64;i++){ var a=i/64*Math.PI*2; pts.push(new T.Vector3(Math.cos(a),0,Math.sin(a))); } return new T.BufferGeometry().setFromPoints(pts); })();
    grp.position.y=0.06;   // hovering a little above the table
    return {grp:grp,geo:geo,ringGeo:ringGeo,ringMat:ringMat,sun:sunM,me:me,items:items,mats:[sunM.material,halo.material,me.material,ringMat],tmp:new T.Vector3(),tmp2:new T.Vector3(),n:-1};
  }
  function fillOrrery(O,T){
    var CB=g('celestialBodies')||[], sunB=null, list=[];
    for(var i=0;i<CB.length;i++){ var b=CB[i]; if(!b||!b.mesh) continue; if(b.name==='Sun'){ sunB=b; continue; }
      if(/moon|station|ship|comet|asteroid/i.test((b.type||'')+' '+(b.name||''))) continue; if(b.orbitR>0) list.push(b); }
    var sp=O.tmp2.set(0,0,0); if(sunB) sunB.mesh.getWorldPosition(sp);
    var dmax=1; for(i=0;i<list.length;i++) dmax=Math.max(dmax,list[i].orbitR);
    var comp=function(d){ return ORR_R*Math.sqrt(Math.max(0,d)/dmax); };   // sqrt: the inner planets don't collapse into the Sun
    if(O.n!==list.length){   // (re)build the planet set
      O.items.forEach(function(it){ O.grp.remove(it.m); O.grp.remove(it.ring); it.m.material.dispose(); }); O.items.length=0;
      for(i=0;i<list.length;i++){ var b2=list[i], mt=b2.renderMesh&&b2.renderMesh.material||b2.mesh.material, c=0xb0c4de;
        try{ if(mt&&mt.color) c=mt.color.getHex(); }catch(e){}
        if(PCOL[b2.name]!=null) c=PCOL[b2.name]; else if(b2.col!=null) c=b2.col;   // textured planets report white
        var m=new T.Mesh(O.geo,new T.MeshBasicNodeMaterial({color:c})), ring=new T.Line(O.ringGeo,O.ringMat);
        var rr=comp(b2.orbitR); ring.scale.set(rr,1,rr); m.scale.setScalar(Math.min(0.016,Math.max(0.005,0.006*Math.cbrt((b2.rRatio||1))))); 
        O.grp.add(m); O.grp.add(ring); O.items.push({b:b2,m:m,ring:ring}); }
      O.n=list.length; }
    var v=O.tmp;
    for(i=0;i<O.items.length;i++){ var it=O.items[i]; it.b.mesh.getWorldPosition(v); v.sub(sp); v.y=0; var d=v.length(), k=d>1e-6?comp(d)/d:0; it.m.position.set(v.x*k,0,v.z*k); }
    var fc=g('flightCamera'); if(fc){ fc.getWorldPosition(v); v.sub(sp); var dy=v.y; v.y=0; var d2=v.length(), k2=d2>1e-6?Math.min(ORR_R*1.15,comp(d2))/d2:0; O.me.position.set(v.x*k2,Math.max(-0.05,Math.min(0.05,dy/dmax*ORR_R)),v.z*k2); }
  }
  function disposeOrrery(O){ try{ O.geo.dispose(); O.ringGeo.dispose(); O.me.geometry.dispose(); O.mats.forEach(function(m){ m.dispose(); }); O.items.forEach(function(it){ it.m.material.dispose(); }); }catch(e){} }

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
    S={kind:'webxr',hudScene:hudScene,plate:plate,session:session,r:r,cv:cv,scene:scene,cam:cam,reticle:reticle,table:table,rig:rig,rigCam:rigCam,hitSrc:null,anchor:null,placed:false,errs:0,D:null,sky:null,flight:null,mode:null};
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
    {
      if(!S.placed&&xf&&S.hitSrc){ var hs=xf.getHitTestResults(S.hitSrc); if(hs.length){ _lastHit=hs[0]; var p=hs[0].getPose(ref); S.reticle.matrix.fromArray(p.transform.matrix); S.reticle.visible=true; } else S.reticle.visible=false; }
      if(S.anchor&&xf&&xf.trackedAnchors&&xf.trackedAnchors.has(S.anchor)){ var ap=xf.getPose(S.anchor.anchorSpace,ref); if(ap) S.table.matrix.fromArray(ap.transform.matrix); }
      if(S.placed) content(T,ctx,mode);
      S.r.render(S.scene,S.cam); hud(S.cam);
    }
  }
  // what sits on the placed table: the terrain diorama, or the orrery in space (only the one in use is visible)
  function content(T,ctx,mode){
    if(mode==='terrain'){ if(!S.D){ S.D=buildDiorama(T); S.table.add(S.D.grp); } S.D.grp.visible=true; if(S.O) S.O.grp.visible=false; fillDiorama(S.D,ctx,false); }
    else { if(!S.O){ S.O=buildOrrery(T); S.table.add(S.O.grp); } S.O.grp.visible=true; if(S.D) S.D.grp.visible=false; fillOrrery(S.O,T); }
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
    S.mode=mode;   // the game's flightScene is never drawn or modified in AR: nothing to strip, the AR canvas clears to transparent
    if(!S.placed) prompt();
    if(mode==='terrain'&&S.D) fillDiorama(S.D,terrainCtx(),true);
  }
  // Restoring the game's rAF and flightRenderer.render is guaranteed: each teardown step is isolated and the
  // two swaps are undone in `finally`, whatever throws. Runs on session 'end', on a frame that keeps throwing,
  // on window error / pagehide, and from enter() failures.
  function cleanup(){
    if(!S) return; var s=S; S=null;
    try{
      try{ s.r.setAnimationLoop(null); }catch(e){}
      if(s.kind==='camera'){ try{ _caf(s.raf); }catch(e){} try{ s.stream.getTracks().forEach(function(k){ k.stop(); }); }catch(e){} try{ s.vid.remove(); }catch(e){}
        try{ window.removeEventListener('pointerup',s.onTap,true); window.removeEventListener('resize',s.onResize); window.removeEventListener('deviceorientation',onOri,true); }catch(e){} }
      try{ var M=window.DMUI3DMesh; M&&M.arHold(false); }catch(e){}
      try{ viewBtn(false); s.gameCv&&s.gameCv.classList.remove('dm-ar-game'); document.body.classList.remove('dm-ar-full'); }catch(e){}
      try{ var fs=g('flightScene'); if(fs) unstrip(fs,s.sky); }catch(e){}
      try{ s.hitSrc&&s.hitSrc.cancel(); }catch(e){} try{ s.anchor&&s.anchor.delete&&s.anchor.delete(); }catch(e){}
      try{ s.D&&s.D.dispose(); }catch(e){} try{ s.O&&disposeOrrery(s.O); }catch(e){}
      try{ s.session&&s.session.removeEventListener('end',cleanup); }catch(e){}
      try{ s.r.dispose(); }catch(e){} try{ s.cv.remove(); }catch(e){}
    } finally {
      if(s.kind!=='camera') try{ pumpOff(); }catch(e){ window.requestAnimationFrame=_raf; window.cancelAnimationFrame=_caf; }
      if(s.flight&&s.flightRender) s.flight.render=s.flightRender;
      document.body.classList.remove('dm-ar-on','dm-ar-cam'); document.documentElement.classList.remove('dm-ar-on');
      try{ toast(''); syncBtns(); window.dispatchEvent(new Event('resize')); }catch(e){}
    }
  }
  function abort(why){ console.warn('[AR] aborting session:',why); var s=S; cleanup(); try{ s&&s.session&&s.session.end().catch(function(){}); }catch(e){} }
  window.addEventListener('pagehide',function(){ if(S) abort('pagehide'); });
  window.addEventListener('error',function(ev){ if(S&&S.errs>=3) abort(ev&&ev.message); });
  function exit(){ if(S&&S.session) S.session.end().catch(cleanup); else if(S) cleanup(); }
  function prompt(){ if(S.kind==='camera'&&S.mode==='space'&&S.view==='full'){ say('Full space view: turn the phone to look around. \u25a6 Table view shows the system on a table',3500); viewBtn(true); return; }
    try{ viewBtn(S.kind==='camera'); }catch(e){}
    var what=S.mode==='space'?'the solar system':'the world';
    toast(S.kind==='camera'?'Aim at a table and tap to place '+what+' (approximate placement)':'Point at a flat surface and tap to place '+what); }
  function say(m,ms){ toast(m); setTimeout(function(){ toast(''); },ms||3000); }
  function toggle(){
    if(S){ exit(); return; }
    if(supported){ enter().catch(function(e){ console.warn('[AR] enter failed',e); if(S) abort('enter failed'); say('Could not start AR: '+(e&&e.message||e)); }); return; }
    if(!(navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)||!window.isSecureContext){ say('AR isn\u2019t supported on this device (no WebXR AR and no camera access in this browser)',4000); return; }
    // iOS 13+: motion permission has to be requested synchronously inside the tap
    var perm=(window.DeviceOrientationEvent&&typeof DeviceOrientationEvent.requestPermission==='function')?DeviceOrientationEvent.requestPermission().catch(function(){ return 'denied'; }):Promise.resolve('granted');
    enterCam(perm).catch(function(e){ console.warn('[AR] camera AR failed',e); if(S) abort('enter failed'); say(e&&e.name==='NotAllowedError'?'Camera permission denied \u2014 AR needs the camera':'Could not start camera AR: '+(e&&e.message||e),4000); });
  }

  // ---------- camera-passthrough fallback (no WebXR AR: iOS Safari, desktops) ----------
  var ori={a:null,b:0,g:0,ok:false};
  function onOri(e){ if(e.alpha==null&&e.beta==null) return; ori.a=e.webkitCompassHeading!=null?-e.webkitCompassHeading:(e.alpha||0); ori.b=e.beta||0; ori.g=e.gamma||0; ori.ok=true; }
  function devQuat(T,out){   // three.js DeviceOrientationControls convention (camera looks down -Z)
    var D=Math.PI/180, so=window.screen&&window.screen.orientation, sa=(so&&so.angle)||(+window.orientation||0);
    var b=ori.ok?ori.b:90;   // no motion data yet: assume the phone held upright, looking ahead
    var e=new T.Euler(b*D,(ori.a||0)*D,-ori.g*D,'YXZ'); out.setFromEuler(e);
    out.multiply(new T.Quaternion(-Math.sqrt(0.5),0,0,Math.sqrt(0.5)));
    out.multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),-sa*D)); return out; }
  var TABLE_Y=-0.45;   // the virtual table: 45 cm below the phone
  async function enterCam(perm){
    var T=window.THREE; if(!T) throw new Error('engine not loaded');
    var _t0=performance.now(), _lg=function(w){ console.log('[AR] cam '+w+' '+Math.round(performance.now()-_t0)+'ms'); };
    var stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
    _lg('stream'); var pr=await perm; if(pr==='granted') window.addEventListener('deviceorientation',onOri,true);
    var vid=document.createElement('video'); vid.id='dm-ar-video'; vid.muted=true; vid.playsInline=true; vid.setAttribute('playsinline',''); vid.autoplay=true; vid.srcObject=stream;
    var cv=document.createElement('canvas'); cv.id='dm-ar-canvas'; cv.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none';
    // the hidden game canvas stops drawing from here on (it's covered by the camera anyway), so the AR renderer's
    // context comes up without queuing behind full game frames on the GPU
    var FR0=g('flightRenderer'), FR0render=FR0&&FR0.render; if(FR0render) FR0.render=function(){};
    toast('Starting camera AR\u2026');
    var drop=function(){ if(FR0render) FR0.render=FR0render;  try{ stream.getTracks().forEach(function(k){ k.stop(); }); }catch(e){} vid.remove(); cv.remove(); window.removeEventListener('deviceorientation',onOri,true); };
    // WebGL2 backend (as the WebXR path): alpha compositing over the <video> is dependable on iOS and it
    // doesn't stand up a second WebGPU device next to the game's
    var r=new T.WebGPURenderer({canvas:cv,alpha:true,antialias:true,forceWebGL:true,powerPreference:'high-performance'});
    try{ document.body.appendChild(vid); document.body.appendChild(cv); try{ await Promise.race([vid.play(),new Promise(function(r){ setTimeout(r,1500); })]); }catch(e){} }   // play() can stay pending (autoplay policy, a stalled stream): never block entering on it
    catch(e){ drop(); throw e; }
    // the small AR renderer (table-top views, terrain board) comes up in the background: the full space overlay
    // draws with the game's own renderer, so entering never waits on a second context
    var rInit=Promise.race([r.init(),new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('renderer init timed out')); },15000); })]);
    rInit.then(function(){ _lg('renderer'); r.setClearColor(0x000000,0); r.setPixelRatio(Math.min(2,window.devicePixelRatio||1)); r.setSize(innerWidth,innerHeight,false); if(S&&S.r===r) S.rReady=true; })
      .catch(function(e){ console.warn('[AR] table renderer',e); if(S&&S.r===r) S.rFail=true; });
    var scene=new T.Scene();
    scene.add(new T.HemisphereLight(0xdfe8ff,0x40362a,1.4)); var sun=new T.DirectionalLight(0xffffff,1.6); sun.position.set(0.4,1,0.3); scene.add(sun);
    var cam=new T.PerspectiveCamera(innerHeight>innerWidth?68:50,innerWidth/innerHeight,0.01,100);
    var reticle=new T.Mesh(new T.RingGeometry(0.04,0.055,32).rotateX(-Math.PI/2),new T.MeshBasicNodeMaterial({color:0x8fd0ff,transparent:true,opacity:0.9}));
    reticle.visible=false; scene.add(reticle);
    var table=new T.Group(); table.visible=false; scene.add(table);
    var rig=new T.Object3D(), rigCam=new T.PerspectiveCamera(60,1,0.05,1e9); rig.add(rigCam);
    S={kind:'camera',view:'full',rReady:false,stream:stream,vid:vid,r:r,cv:cv,scene:scene,cam:cam,reticle:reticle,table:table,rig:rig,rigCam:rigCam,placed:false,errs:0,D:null,sky:null,flight:null,mode:null,
       q0:null,yaw0:null,ray:new T.Raycaster(),plane:new T.Plane(new T.Vector3(0,1,0),-TABLE_Y),hit:new T.Vector3(),hasHit:false,dq:new T.Quaternion()};
    S.onTap=function(e){ if(!S||S.kind!=='camera'||S.placed||S.full) return; var t=e.target;
      if(t&&t.closest&&t.closest('button,a,input,.hud-c,.hud-l,.hud-r,.mini-kite,.joystick-base,.joystick,#minimap,.dm-ar-btn,.menu-panel,.art-btns')) return;
      camTapPlace(e.clientX,e.clientY); };
    window.addEventListener('pointerup',S.onTap,true);
    S.onResize=function(){ if(!S) return; if(S.rReady) S.r.setSize(innerWidth,innerHeight,false); S.cam.fov=innerHeight>innerWidth?68:50; S.cam.aspect=innerWidth/innerHeight; S.cam.updateProjectionMatrix(); };
    window.addEventListener('resize',S.onResize);
    S.flight=FR0; S.flightRender=FR0render;
    if(FR0render) FR0.render=function(sc,cm){ return S&&S.kind==='camera'&&S.full?fullRender(sc,cm):undefined; };   // the game draws only in the full overlay
    try{ var gc=FR0&&FR0.domElement; if(gc){ gc.classList.add('dm-ar-game'); S.gameCv=gc; } }catch(e){}
    viewBtn(true);
    try{ window.DMUI3DMesh&&DMUI3DMesh.arHold(true); }catch(e){}
    document.body.classList.add('dm-ar-on','dm-ar-cam'); document.documentElement.classList.add('dm-ar-on');
    syncBtns(); if(pr!=='granted') say('Motion access off: the view won\u2019t follow the phone (Settings \u203a Safari \u203a Motion & Orientation)',4500);
    var loop=function(t){ if(!S||S.kind!=='camera') return; S.raf=_raf(loop); try{ camFrame(t); S.errs=0; }catch(e){ console.warn('[AR] cam frame',e); if(++S.errs>=3) abort(e&&e.message); } };
    S.raf=_raf(loop);
  }
  function camPose(T){ var q=devQuat(T,new T.Quaternion());
    if(S.yaw0==null&&ori.ok){ var f=new T.Vector3(0,0,-1).applyQuaternion(q); S.yaw0=Math.atan2(-f.x,-f.z); }
    if(S.yaw0!=null) q.premultiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),-S.yaw0));   // start facing -Z
    return q; }
  function camTapPlace(x,y){ var T=window.THREE, nd=new T.Vector2(x/innerWidth*2-1,-(y/innerHeight)*2+1);
    S.ray.setFromCamera(nd,S.cam); var p=new T.Vector3();
    if(!S.ray.ray.intersectPlane(S.plane,p)||p.length()>2.2){ p.copy(S.ray.ray.direction).multiplyScalar(0.8); p.y=Math.min(p.y,-0.12); }   // no table hit nearby: where the tap points, 80 cm out, kept just below eye level
    S.table.position.copy(p); S.table.rotation.set(0,Math.atan2(-p.x,-p.z)+Math.PI,0); S.table.visible=true; S.placed=true; S.reticle.visible=false; toast(''); }
  // ---------- full live space overlay (camera fallback) ----------
  // The game keeps drawing its own scene with its own renderer and its already-compiled pipelines; each of its
  // passes that uses the flight camera is drawn with the device turn layered on and, near a star, from a safe
  // standoff outside the photosphere and glow shells. The sky/background is stripped for those calls only.
  var _fq=null,_fp=null,_fv=null,_fs=null;
  var SAFE_K=4;   // standoff: 4 solar radii from the Sun's centre
  function fullRender(sc,cm){
    var fc=g('flightCamera'), orig=S.flightRender, T=window.THREE;
    if(!fc||cm!==fc) return orig.call(S.flight,sc,cm);
    _fq=_fq||new T.Quaternion(); _fp=_fp||new T.Vector3(); _fv=_fv||new T.Vector3(); _fs=_fs||new T.Vector3();
    _fq.copy(cm.quaternion); _fp.copy(cm.position);
    var bg=sc.background, hid=[];
    try{
      if(S.dq) cm.quaternion.multiply(S.dq);
      var sm=g('sunMesh'), R0=g('SOL_SUN_RADIUS')||160;
      if(sm){ (sm.parent&&sm.parent.isGroup?sm.parent:sm).getWorldPosition(_fs); cm.getWorldPosition(_fv);
        var d=_fv.distanceTo(_fs), safe=R0*SAFE_K;
        if(d<safe){ _fv.sub(_fs); if(_fv.lengthSq()<1e-6) _fv.set(0,0,1); _fv.setLength(safe).add(_fs);
          if(cm.parent) cm.parent.worldToLocal(_fv); cm.position.copy(_fv); S.safeHold=true; } else S.safeHold=false; }
      cm.updateMatrixWorld(true);
      sc.background=null;
      sc.traverseVisible&&sc.traverseVisible(function(o){ if(o.userData&&o.userData.dmSkyShell){ o.visible=false; hid.push(o); } });
      return orig.call(S.flight,sc,cm);
    } finally {
      sc.background=bg; for(var i=0;i<hid.length;i++) hid[i].visible=true;
      cm.quaternion.copy(_fq); cm.position.copy(_fp); cm.updateMatrixWorld(true);
    }
  }
  function viewBtn(on){ var b=document.getElementById('dm-ar-view');
    if(!on){ if(b) b.remove(); return; }
    if(!b){ b=document.createElement('button'); b.id='dm-ar-view'; b.type='button';
      b.addEventListener('click',function(e){ e.stopPropagation(); if(!S) return; S.view=S.view==='full'?'table':'full'; S.placed=false; S.table.visible=false; if(S.mode) switchMode(S.mode); });
      document.body.appendChild(b); }
    b.textContent=S&&S.view==='full'?'\u25a6 Table view':'\u2726 Full space'; b.style.display=S&&S.mode==='space'?'':'none'; }
  function camFrame(t){
    var T=window.THREE, ctx=terrainCtx(), mode=ctx?'terrain':'space';
    if(mode!==S.mode) switchMode(mode);
    var q=camPose(T), full=mode==='space'&&S.view==='full';
    if(full!==!!S.full){ S.full=full; document.body.classList.toggle('dm-ar-full',full); if(full) S.q0=null; viewBtn(true); }
    if(full){
      if(!S.q0) S.q0=q.clone().invert();
      S.dq.copy(S.q0).multiply(q);   // device turn since entering, layered on the game camera in fullRender
      if(S.safeHold&&!S._safeSaid){ S._safeSaid=true; say('Holding a safe distance from the Sun in AR',2500); }
      return;   // the game's own loop draws (see fullRender)
    }
    if(!S.rReady){ if(S.rFail&&!S._failSaid){ S._failSaid=true; say('Table view isn\u2019t available on this device',3000); } return; }
    {
      S.cam.position.set(0,0,0); S.cam.quaternion.copy(q); S.cam.updateMatrixWorld(true);
      if(!S.placed){ S.ray.setFromCamera(new T.Vector2(0,0),S.cam); var p=S.hit;
        if(S.ray.ray.intersectPlane(S.plane,p)&&p.length()<2.2){ S.reticle.position.copy(p); S.reticle.visible=true; } else S.reticle.visible=false; }
      if(S.placed) content(T,ctx,mode);
      S.r.render(S.scene,S.cam);
    }
    try{ window.DMUI3DMesh&&DMUI3DMesh.drawTo(S.r); }catch(e){}   // 3D HUD over the passthrough (DOM HUD if the mesh is off)
  }

  window.DMAR={toggle:toggle,exit:exit,get active(){ return !!S; }, get mode(){ return S?S.kind+'/'+(S.mode||'-')+(S.placed?' placed':''):(supported?'off (webxr ready)':'off (camera fallback)'); }, _cam:function(){ return S; },get supported(){ return supported; },_buildDiorama:buildDiorama,_fillDiorama:fillDiorama,_stripSky:stripSky,_unstrip:unstrip};
  function init(){
    placeButtons();
    try{ new MutationObserver(function(){ placeButtons(); }).observe(document.body,{childList:true,subtree:false}); }catch(e){}
    if(navigator.xr&&navigator.xr.isSessionSupported){ navigator.xr.isSessionSupported('immersive-ar').then(function(ok){ supported=!!ok; placeButtons(); }).catch(function(){}); }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
