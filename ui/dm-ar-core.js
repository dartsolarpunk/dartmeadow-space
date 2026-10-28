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
   • Interstellar: full 3D fly-through around the device (the live scene, chase camera, sticks steer); visited maps (terrain/atmosphere) sit on the anchored table
   • Anchoring (xr-audit): reticle eased from viewer-space plane hits, placement creates an XRAnchor that the
     scene follows every frame (no drift when you walk around); tracking loss hides the scene after 1.2 s,
     re-anchors after 7 s and falls back to RE-PLACE after 20 s; reference-space `reset` events re-base the
     placement. Persistent anchors (Quest) are stored under dm.ar.anchor.v1. Scale 0.2-16x: pinch / twist on
     the screen, thumbstick in a headset, or the tools panel (+ / - / TABLE x1 / ROOM x4 / RE-PLACE).
   • Passthrough + perf: transparent clear, no sky/fog/post passes drawn over the camera; pixel ratio capped per
     graphics preset, EMA frame-time governor steps quality down, framebuffer scale + foveation + target frame
     rate (72 on headsets), optional light-estimation and depth-sensing. Exit restores every patched global.
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
    'html.dm-ar-on #intro-veil{display:none!important}'+   // (v182) a lingering boarding-intro veil (z 8450, opaque gradient) must never sit over the passthrough
    'html.dm-ar-on,body.dm-ar-on,body.dm-ar-on .screen,body.dm-ar-on #game-container{background:transparent!important}'+
    'body.dm-ar-on canvas:not(#dm-ar-canvas):not(#minimap-canvas){visibility:hidden!important}'+
    '#dm-ar-video{position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:-2;pointer-events:none;background:#000}'+
    'body.dm-ar-cam #dm-ar-canvas{z-index:-1!important}'+
    // full space overlay and terrain board: the game's own canvas (alpha:true, premultiplied) drawn over the camera with
    // true alpha. Normal play clears it opaque black; in AR it clears to alpha 0 and the content writes its own alpha
    'html.dm-ar-on body.dm-ar-full canvas.dm-ar-game:not(#dm-ar-canvas):not(#minimap-canvas){visibility:visible!important;background:transparent!important}'+
    'body.dm-ar-full #dm-ar-canvas{visibility:hidden!important}'+
    '#dm-ar-tools{position:fixed;left:calc(10px + env(safe-area-inset-left,0px));top:50%;transform:translateY(-50%);z-index:99997;display:none;flex-direction:column;gap:6px;align-items:stretch;font:600 11px/1 var(--font-mono,monospace);letter-spacing:.08em;pointer-events:auto}'+
    '#dm-ar-tools.show{display:flex}#dm-ar-tools button{padding:9px 10px;min-width:44px;min-height:40px;border-radius:4px;border:1px solid rgba(120,200,255,.45);background:rgba(6,12,24,.72);color:#bfe6ff;font:inherit;letter-spacing:inherit}'+
    '#dm-ar-tools .v{text-align:center;color:#dfeaff;padding:2px 0}'+
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
  // (v178) mesh maps (Bird Temple and other walkable ships/stations): a flat-based board around Ariel's deck
  var _shipH=0; function _shipFlat(){ return _shipH; }
  function shipCtx(){
    var SW=g('SHIP_WALK'); if(!SW||!SW.active||window._dmWarming) return null;
    var st=g('STATE'), sp=st&&st.flight; if(!sp||!sp.pos) return null;
    var gh=null, f=g('_shipGroundHeight'); try{ if(f) gh=f(sp.pos.x,sp.pos.z,sp.pos.y+0.05); }catch(e){}
    _shipH=(gh!=null&&isFinite(gh))?gh:sp.pos.y;
    return {H:_shipFlat,pos:sp.pos,flying:!SW.grounded,pal:null,ship:true};
  }
  function terrainCtx(){
    var sc=shipCtx(); if(sc) return sc;
    var PW=window.PW; if(!PW||!PW.active||window._dmWarming||!(g('surfaceActive')||g('atmoActive'))) return null;
    var H=g('_surfHeight')||g('_atmoHeight')||((g('TERRAIN')||{}).H);
    if(typeof H!=='function') return null;
    var pos=null, flying=false;
    var sp=g('surfPlayer'); if(g('surfaceActive')&&sp&&sp.pos) pos=sp.pos;
    var ab=g('atmoBoard'); if(!pos&&g('atmoActive')&&ab&&ab.position){ pos=ab.position; flying=true; }
    if(!pos&&g('atmoActive')&&PW.board&&PW.board.position){ pos=PW.board.position; flying=true; }
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
    var P=B.geo.attributes.position, C=B.geo.attributes.color, N=B.N, sea=pal.water?(pal.seaLevel!=null?pal.seaLevel:0):-1e9, ks=scratch(window.THREE);
    var c0=ks.c0.set(pal.ground2!=null?pal.ground2:0x4a5a30), c1=ks.c1.set(pal.ground!=null?pal.ground:0x6b7b3a), c2=ks.c2.set(pal.rock!=null?pal.rock:0x9a8a7a),
        seaC=ks.c3.set(pal.liquidColor!=null?pal.liquidColor:0x1a4a7a), c=ks.c, hi=lo+0.16/(k*ex);   // (scratch colours: nothing allocated on a refill)
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
  var _rafO=window.requestAnimationFrame, _cafO=window.cancelAnimationFrame, _raf=_rafO.bind(window), _caf=_cafO.bind(window), q=new Map(), qid=1e9;
  function pumpOn(){ window.requestAnimationFrame=function(cb){ var id=++qid; q.set(id,cb); return id; };
    window.cancelAnimationFrame=function(id){ if(q.has(id)) q.delete(id); else _caf(id); }; }
  function pumpOff(){ window.requestAnimationFrame=_rafO; window.cancelAnimationFrame=_cafO; var cbs=Array.from(q.values()); q.clear(); cbs.forEach(function(cb){ _raf(cb); }); }
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
    // orbits spaced by rank, not distance: one far body (a dwarf, a distant world) must not squeeze every planet
    // into the Sun's glow. Each body's own orbit sets its ring; the ship is placed by interpolating between them.
    list.sort(function(a,b){ return a.orbitR-b.orbitR; });
    var dmax=1; for(i=0;i<list.length;i++) dmax=Math.max(dmax,list[i].orbitR);
    var nL=list.length, rk=function(j){ return ORR_R*(nL>1?0.22+0.78*j/(nL-1):0.6); };
    var comp=function(d){ d=Math.max(0,d); if(!nL) return 0; if(d<=list[0].orbitR) return rk(0)*d/Math.max(1e-9,list[0].orbitR);
      for(var j=1;j<nL;j++) if(d<=list[j].orbitR){ var a0=list[j-1].orbitR,a1=list[j].orbitR; return rk(j-1)+(rk(j)-rk(j-1))*(d-a0)/Math.max(1e-9,a1-a0); }
      return rk(nL-1); };
    if(O.n!==list.length){   // (re)build the planet set
      O.items.forEach(function(it){ O.grp.remove(it.m); O.grp.remove(it.ring); it.m.material.dispose(); }); O.items.length=0;
      for(i=0;i<list.length;i++){ var b2=list[i], mt=b2.renderMesh&&b2.renderMesh.material||b2.mesh.material, c=0xb0c4de;
        try{ if(mt&&mt.color) c=mt.color.getHex(); }catch(e){}
        if(PCOL[b2.name]!=null) c=PCOL[b2.name]; else if(b2.col!=null) c=b2.col;   // textured planets report white
        var m=new T.Mesh(O.geo,new T.MeshBasicNodeMaterial({color:c})), ring=new T.Line(O.ringGeo,O.ringMat);
        var rr=comp(b2.orbitR); ring.scale.set(rr,1,rr); m.scale.setScalar(Math.min(0.018,Math.max(0.008,0.008*Math.cbrt((b2.rRatio||1))))); 
        O.grp.add(m); O.grp.add(ring); O.items.push({b:b2,m:m,ring:ring}); }
      O.n=list.length; }
    var v=O.tmp;
    for(i=0;i<O.items.length;i++){ var it=O.items[i]; it.b.mesh.getWorldPosition(v); v.sub(sp); v.y=0; var d=v.length(), k=d>1e-6?comp(d)/d:0; it.m.position.set(v.x*k,0,v.z*k); }
    var fc=g('flightCamera'); if(fc){ fc.getWorldPosition(v); v.sub(sp); var dy=v.y; v.y=0; var d2=v.length(), k2=d2>1e-6?Math.min(ORR_R*1.15,comp(d2))/d2:0; O.me.position.set(v.x*k2,Math.max(-0.05,Math.min(0.05,dy/dmax*ORR_R)),v.z*k2); }
  }
  function disposeOrrery(O){ try{ O.geo.dispose(); O.ringGeo.dispose(); O.me.geometry.dispose(); O.mats.forEach(function(m){ m.dispose(); }); O.items.forEach(function(it){ it.m.material.dispose(); }); }catch(e){} }

  // ---------- shared scratch: made on the first AR entry (THREE may not exist at load), never per frame ----------
  var K=null;
  function scratch(T){ return K||(K={ m:new T.Matrix4(), m2:new T.Matrix4(), p:new T.Vector3(), s:new T.Vector3(), q:new T.Quaternion(), qa:new T.Quaternion(), v2:new T.Vector2(),
    up:new T.Vector3(0,1,0), z:new T.Vector3(0,0,1), qx:new T.Quaternion(-Math.SQRT1_2,0,0,Math.SQRT1_2), e:new T.Euler(), c:new T.Color(), c0:new T.Color(), c1:new T.Color(), c2:new T.Color(), c3:new T.Color() }); }

  // ---------- performance profile (camera path: the game's own renderer draws, so cap what it draws) ----------
  // Pixel ratio is capped through the one function every setPixelRatio call in the game goes through, for the length of
  // the AR session only: nothing is written to GFX or to a save, and exit puts the original function back.
  var _epr=null, PRCAP={low:1,medium:1.25,high:1.5,ultra:1.75};
  function perfOn(s){ if(_epr||typeof window.effectivePixelRatio!=='function') return; _epr=window.effectivePixelRatio; s.prCap=PRCAP[preset()]||1.25;
    window.effectivePixelRatio=function(){ var v=_epr(); return (S&&S.prCap)?Math.min(v,S.prCap):v; }; perfApply(); }
  function perfOff(){ if(!_epr) return; window.effectivePixelRatio=_epr; _epr=null; perfApply(); }
  function perfApply(){ try{ var FR=g('flightRenderer'); if(FR&&FR.setPixelRatio) FR.setPixelRatio(window.effectivePixelRatio()); }catch(e){} }
  // frame-time book-keeping shared by both paths: exponential average, count of long frames, and the camera path's own
  // step-down (never below 0.75x) when it stays slow
  function track(t){ var s=S; if(!s) return; if(s.tl){ var dt=t-s.tl; if(dt>0&&dt<500){ s.ms=s.ms?s.ms*0.94+dt*0.06:dt; s.nf=(s.nf|0)+1; if(dt>(s.target?1500/s.target:25)) s.slow=(s.slow|0)+1;
      if(s.nf>60&&s.ms>(s.target?1300/s.target:23)){ s.hot=(s.hot|0)+1; } else s.hot=0;
      if(s.hot>90){ s.hot=0; slower(); } } } s.tl=t; }
  function slower(){ var s=S; if(!s) return;
    if(s.kind==='camera'){ if(s.prCap>0.76){ s.prCap=Math.max(0.75,s.prCap-0.25); perfApply(); s.steps=(s.steps|0)+1; } }
    else { if(s.r&&s.r.xr&&!s.fov1){ s.fov1=true; try{ s.r.xr.setFoveation(1); s.steps=(s.steps|0)+1; }catch(e){} } } }

  // ---------- on-screen tools: scale, re-place (handheld DOM; headsets use the controller: squeeze = re-place, stick = scale) ----------
  var UISEL='button,a,input,.hud-c,.hud-l,.hud-r,.mini-kite,.joystick-base,.joystick,#minimap,.dm-ar-btn,.menu-panel,.art-btns,#dm-ar-tools,#dm-ar-view';
  function uiHit(t){ return !!(t&&t.closest&&t.closest(UISEL)); }
  function toolsEl(){ var d=document.getElementById('dm-ar-tools'); if(d) return d;
    d=document.createElement('div'); d.id='dm-ar-tools';
    d.innerHTML='<button type="button" data-a="plus">+</button><span class="v"></span><button type="button" data-a="minus">\u2212</button><button type="button" data-a="table">TABLE</button><button type="button" data-a="room">ROOM</button><button type="button" data-a="replace">RE-PLACE</button>';
    d.addEventListener('click',function(e){ var b=e.target.closest&&e.target.closest('button'); if(!b||!S) return; e.stopPropagation(); toolAct(b.getAttribute('data-a')); });
    d.addEventListener('beforexrselect',function(e){ e.preventDefault(); });
    document.body.appendChild(d); return d; }
  function toolsSync(){ var s=S, want=!!(s&&s.placed&&!(s.kind==='camera'&&s.full)); if(!s||want===!!s.toolsOn&&s.toolsScale===s.scale) return;
    s.toolsOn=want; s.toolsScale=s.scale; var d=toolsEl(); d.classList.toggle('show',want); var v=d.querySelector('.v'); if(v) v.textContent=(Math.round(s.scale*100)/100)+'\u00d7'; }
  function setScale(v){ if(!S) return; S.scale=Math.max(0.2,Math.min(16,v)); persistSave(); }
  function toolAct(a){ if(!S) return;
    if(a==='plus') setScale(S.scale*1.25); else if(a==='minus') setScale(S.scale/1.25); else if(a==='table') setScale(1); else if(a==='room') setScale(4); else if(a==='replace') replace(); }
  function replace(){ var s=S; if(!s) return;
    persistClear(); s.placed=false; s.havePose=false; s.lost=false; s.lostAt=0; s.yaw=0; s.table.visible=false; s.toolsOn=true;
    try{ if(s.anchor){ s.anchor.delete(); } }catch(e){} s.anchor=null; s.reticle.visible=false; s.rInit=false;
    if(s.kind==='camera'){ s.autoPlaced=false; s.q0=null; } toolsSync(); prompt(); }
  // pinch = scale, twist = rotate the placed world (not on any HUD element); the same on both paths
  var _pt=new Map(), _g=null;
  function gDown(e){ if(!S||!S.placed||uiHit(e.target)) return; _pt.set(e.pointerId,{x:e.clientX,y:e.clientY}); if(_pt.size===2){ var a=Array.from(_pt.values()); _g={d:Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)||1,a:Math.atan2(a[1].y-a[0].y,a[1].x-a[0].x),s:S.scale,y:S.yaw}; } }
  function gMove(e){ var p=_pt.get(e.pointerId); if(!p||!S) return; p.x=e.clientX; p.y=e.clientY;
    if(_pt.size===2&&_g){ var a=Array.from(_pt.values()), d=Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)||1, an=Math.atan2(a[1].y-a[0].y,a[1].x-a[0].x);
      setScale(_g.s*d/_g.d); S.yaw=_g.y-(an-_g.a); } }
  function gUp(e){ _pt.delete(e.pointerId); if(_pt.size<2) _g=null; }
  function gOn(){ window.addEventListener('pointerdown',gDown,true); window.addEventListener('pointermove',gMove,true); window.addEventListener('pointerup',gUp,true); window.addEventListener('pointercancel',gUp,true); }
  function gOff(){ window.removeEventListener('pointerdown',gDown,true); window.removeEventListener('pointermove',gMove,true); window.removeEventListener('pointerup',gUp,true); window.removeEventListener('pointercancel',gUp,true); _pt.clear(); _g=null; }
  // a persistent anchor (Quest Browser: session.requestPersistentAnchor) survives leaving AR and reopening the page; Chrome on
  // Android has none, so there the placement is per session. Only the anchor id, scale and twist are stored (own key, no saves touched).
  var PKEY='dm.ar.anchor.v1';
  function persistSave(){ try{ var s=S; if(!s||!s.pid) return; localStorage.setItem(PKEY,JSON.stringify({id:s.pid,scale:s.scale,yaw:s.yaw})); }catch(e){} }
  function persistClear(){ try{ var s=S; localStorage.removeItem(PKEY); if(s&&s.pid&&s.session&&s.session.deletePersistentAnchor) s.session.deletePersistentAnchor(s.pid).catch(function(){}); if(s) s.pid=null; }catch(e){} }

  // ---------- WebXR session ----------
  var FBSCALE={low:0.7,medium:0.85,high:1,ultra:1}, FBSCALE_HEAD={low:0.8,medium:1,high:1,ultra:1};
  async function enter(){
    var T=window.THREE; if(!T||!navigator.xr){ toast('AR is not available on this device'); setTimeout(function(){toast('');},2500); return; }
    var ok=false; try{ ok=await navigator.xr.isSessionSupported('immersive-ar'); }catch(e){}
    if(!ok){ toast('AR is not available on this device'); setTimeout(function(){toast('');},2500); return; }
    var pr=preset(), depthWanted=(pr==='high'||pr==='ultra'||Q.get('ardepth')==='1')&&Q.get('ardepth')!=='0';
    var feats=['anchors','dom-overlay','local-floor','light-estimation']; if(depthWanted) feats.push('depth-sensing');
    var init={requiredFeatures:['hit-test'],optionalFeatures:feats,domOverlay:{root:document.body}};
    if(depthWanted) init.depthSensing={usagePreference:['cpu-optimized'],dataFormatPreference:['luminance-alpha','float32']};
    var session=await navigator.xr.requestSession('immersive-ar',init), cv=null, r=null;
    try{
      var en=session.enabledFeatures||[], has=function(f){ return en.indexOf(f)>=0; };
      var screen=!!(session.domOverlayState||session.interactionMode==='screen-space');
      cv=document.createElement('canvas'); cv.id='dm-ar-canvas'; cv.style.cssText='position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0';
      document.body.appendChild(cv);
      r=new T.WebGPURenderer({canvas:cv,alpha:true,antialias:pr!=='low',forceWebGL:true,powerPreference:'high-performance'});
      await r.init(); r.setClearColor(0x000000,0); r.xr.enabled=true;   // transparent clear, no background, no fog, no post pass, no tone map: the camera shows through
      r.toneMapping=T.NoToneMapping;
      try{ r.xr.setReferenceSpaceType(has('local-floor')?'local-floor':'local'); }catch(e){}
      try{ r.xr.setFramebufferScaleFactor((screen?FBSCALE:FBSCALE_HEAD)[pr]||1); r.xr.setFoveation(screen?0:(pr==='low'?1:0.6)); }catch(e){}
      var target=screen?60:72;
      try{ var sf=session.supportedFrameRates; if(sf&&session.updateTargetFrameRate){ var pick=sf.indexOf(72)>=0?72:sf.indexOf(60)>=0?60:0; if(pick){ await session.updateTargetFrameRate(pick); target=pick; } } }catch(e){}
      var k=scratch(T), scene=new T.Scene();
      var hemi=new T.HemisphereLight(0xdfe8ff,0x40362a,1.4), sun=new T.DirectionalLight(0xffffff,1.6); sun.position.set(0.4,1,0.3); scene.add(hemi); scene.add(sun);
      var cam=new T.PerspectiveCamera(60,1,0.01,1e7);
      var reticle=new T.Mesh(new T.RingGeometry(0.04,0.055,32).rotateX(-Math.PI/2),new T.MeshBasicNodeMaterial({color:0x8fd0ff}));
      reticle.matrixAutoUpdate=false; reticle.visible=false; scene.add(reticle);
      var table=new T.Group(); table.matrixAutoUpdate=false; table.visible=false; scene.add(table);
      var hudScene=new T.Scene(), plate=new T.Group(); plate.matrixAutoUpdate=false; hudScene.add(plate);
      S={kind:'webxr',session:session,r:r,cv:cv,scene:scene,cam:cam,hemi:hemi,sun:sun,reticle:reticle,table:table,hudScene:hudScene,plate:plate,screen:screen,target:target,
         base:new T.Matrix4(),scale:1,yaw:0,placed:false,havePose:false,errs:0,D:null,O:null,mode:null,hitSrc:null,ctl:new Map(),anchor:null,rGood:true,
         vx:0,vy:0,vz:0,hx:0,hy:0,hz:0,rx:0,ry:0,rz:0,hit:false,probe:null,depthOn:has('depth-sensing'),lightOn:has('light-estimation'),anchorsOn:has('anchors'),
         pid:null,persistOn:!!(session.requestPersistentAnchor&&session.restorePersistentAnchor),ses:session};
      session.addEventListener('end',cleanup); syncBtns();
      await r.xr.setSession(session);
      S.ref=r.xr.getReferenceSpace();
      try{ S.ref.addEventListener('reset',onReset); }catch(e){}
      try{ var vs=await session.requestReferenceSpace('viewer');
        try{ S.hitSrc=await session.requestHitTestSource({space:vs,entityTypes:['plane']}); }catch(e){ S.hitSrc=await session.requestHitTestSource({space:vs}); } }catch(e){ console.warn('[AR] hit-test',e); }
      if(S.lightOn&&session.requestLightProbe){ try{ S.probe=await session.requestLightProbe(); }catch(e){ S.probe=null; } }
      session.addEventListener('select',onSelect); session.addEventListener('squeezestart',onSqueeze); session.addEventListener('inputsourceschange',onInputs);
      document.body.addEventListener('beforexrselect',onBeforeSelect); gOn();
      if(S.persistOn) restoreAnchor(session);
      // the hidden flight canvas stops drawing while AR owns the frame (WebXR draws with its own renderer: the game canvas is not touched)
      var FR=g('flightRenderer'); if(FR&&FR.render){ S.flight=FR; S.flightRender=FR.render; FR.render=function(){}; }
      pumpOn();
      try{ window.DMUI3DMesh&&DMUI3DMesh.arHold(true); }catch(e){}
      document.body.classList.add('dm-ar-on'); document.documentElement.classList.add('dm-ar-on');
      if(screen) document.documentElement.classList.add('dm-ar-dom');
      r.setAnimationLoop(frame);
    }catch(e){ console.warn('[AR] session setup failed',e);
      if(S&&S.session===session) cleanup(); else { try{ r&&r.dispose(); }catch(_){} try{ cv&&cv.remove(); }catch(_){} }
      try{ session.end().catch(function(){}); }catch(_){} throw e; }
  }
  // headset stick scale + squeeze to re-place, and one hit-test source per controller ray so the reticle follows the controller
  function onSqueeze(){ if(S&&S.placed) replace(); }
  function onInputs(ev){ var s=S; if(!s) return;
    (ev.removed||[]).forEach(function(i){ var h=s.ctl.get(i); if(h){ try{ h.cancel(); }catch(e){} s.ctl.delete(i); } });
    (ev.added||[]).forEach(function(i){ if(i.targetRayMode!=='tracked-pointer'||!s.session.requestHitTestSource) return;
      s.session.requestHitTestSource({space:i.targetRaySpace,entityTypes:['plane']}).then(function(h){ if(S===s) s.ctl.set(i,h); else try{ h.cancel(); }catch(e){} }).catch(function(){}); }); }
  function onBeforeSelect(ev){ if(uiHit(ev.target)) ev.preventDefault(); }   // a tap on the HUD or the tools is not a placement
  function onReset(ev){ var s=S; if(!s||s.anchor||!ev||!ev.transform||!s.placed) return;   // no anchor: carry the fixed placement across the origin change
    var T=window.THREE, k=scratch(T); k.m.fromArray(ev.transform.matrix); s.base.premultiply(k.m); }
  function restoreAnchor(session){ var st=null; try{ st=JSON.parse(localStorage.getItem(PKEY)||'null'); }catch(e){} if(!st||!st.id) return;
    var ids=session.persistentAnchors||[]; if(ids.indexOf&&ids.indexOf(st.id)<0){ persistClear(); return; }
    session.restorePersistentAnchor(st.id).then(function(a){ if(!S||S.session!==session){ try{ a.delete(); }catch(e){} return; }
      S.anchor=a; S.pid=st.id; S.placed=true; S.restored=true; S.scale=st.scale>0?st.scale:1; S.yaw=+st.yaw||0; S.reticle.visible=false; say('Restored your saved placement',2500); }).catch(function(){ persistClear(); }); }
  function mkAnchor(xf,m){ var s=S; if(!s||!xf||!xf.createAnchor||!window.XRRigidTransform||!s.anchorsOn) return;
    var T=window.THREE, k=scratch(T); m.decompose(k.p,k.q,k.s);
    var tr=new XRRigidTransform({x:k.p.x,y:k.p.y,z:k.p.z},{x:k.q.x,y:k.q.y,z:k.q.z,w:k.q.w}); s.anchorBusy=true;
    xf.createAnchor(tr,s.ref).then(function(a){ s.anchorBusy=false; if(S!==s){ try{ a.delete(); }catch(e){} return; }
        var old=s.anchor; s.anchor=a; s.lostAt=0; try{ old&&old.delete(); }catch(e){}
        if(s.persistOn&&s.session.requestPersistentAnchor) s.session.requestPersistentAnchor(a).then(function(id){ if(S===s){ s.pid=id; persistSave(); } }).catch(function(){}); })
      .catch(function(e){ s.anchorBusy=false; s.anchorFail=(s.anchorFail|0)+1; console.warn('[AR] anchor',e&&e.message||e); }); }
  function onSelect(ev){ var s=S; if(!s||s.placed) return;
    if(!s.hit){ say('Aim at a flat surface (floor or table) until the ring appears',2500); return; }
    if(!s.rGood){ say('Something is in the way \u2014 aim at a clear flat spot',2200); return; }
    var T=window.THREE, k=scratch(T);
    k.p.set(s.hx,s.hy,s.hz); k.q.setFromAxisAngle(k.up,Math.atan2(s.hx-s.vx,s.hz-s.vz)); k.s.set(1,1,1); s.base.compose(k.p,k.q,k.s);   // upright, its front toward you
    s.placed=true; s.havePose=true; s.lost=false; s.lostAt=0; s.yaw=0; s.reticle.visible=false; toast('');
    mkAnchor(ev.frame,s.base); }
  function frame(t,xf){
    if(!S) return;
    try{ frameBody(t,xf); S&&(S.errs=0); }
    catch(e){ console.warn('[AR] frame',e); if(S&&++S.errs>=3) abort(e&&e.message); }
  }
  function frameBody(t,xf){
    var s=S; track(t); pump(t); if(S!==s) return;
    var T=window.THREE, k=scratch(T), ref=s.r.xr.getReferenceSpace(); if(!ref||!xf) return; s.ref=ref; s.fn=(s.fn|0)+1;
    var ctx=terrainCtx(), mode=ctx?'terrain':'space';
    if(mode!==s.mode){ switchMode(mode); }
    var vp=xf.getViewerPose(ref), vpos=null;
    if(vp){ vpos=vp.transform.position; s.vx=vpos.x; s.vy=vpos.y; s.vz=vpos.z; s.emul=!!vp.emulatedPosition; }
    if(!s.placed){
      // the nearest horizontal plane under the view centre (or a controller ray): the ring follows it, eased so it doesn't shimmer
      var hit=null, hs=s.hitSrc?xf.getHitTestResults(s.hitSrc):null, c=null;
      s.ctl.forEach(function(h){ if(!c){ var rs=xf.getHitTestResults(h); if(rs.length) c=rs; } }); if(c) hs=c;
      if(hs) for(var i=0;i<hs.length&&!hit;i++){ var pz=hs[i].getPose(ref); if(pz){ k.m.fromArray(pz.transform.matrix); if(k.m.elements[5]>0.85) hit=k.m; } }
      if(hit){ var e=hit.elements; s.hx=e[12]; s.hy=e[13]; s.hz=e[14];
        if(!s.hit){ s.rx=s.hx; s.ry=s.hy; s.rz=s.hz; } else { s.rx+=(s.hx-s.rx)*0.3; s.ry+=(s.hy-s.ry)*0.3; s.rz+=(s.hz-s.rz)*0.3; }
        s.hit=true; k.m.makeTranslation(s.rx,s.ry,s.rz); s.reticle.matrix.copy(k.m); s.reticle.matrixWorldNeedsUpdate=true; s.reticle.visible=true;
        // depth sensing (where granted): a hand or object nearer than the plane at the ring means it is not a clear spot
        var good=true;
        if(s.depthOn&&vp&&vp.views&&vp.views.length&&xf.getDepthInformation){ try{ var v=vp.views[0], di=xf.getDepthInformation(v);
          if(di){ s.depthSeen=true; k.m.fromArray(v.transform.inverse.matrix); k.p.set(s.hx,s.hy,s.hz).applyMatrix4(k.m); var dv=-k.p.z; k.m2.fromArray(v.projectionMatrix); k.p.applyMatrix4(k.m2);
            var dm=di.getDepthInMeters((k.p.x+1)/2,(1-k.p.y)/2); if(dm>0&&dv>0&&dm<dv-0.25) good=false; } }catch(e2){ s.depthOn=false; } }
        if(good!==s.rGood){ s.rGood=good; s.reticle.material.color.set(good?0x8fd0ff:0xff7a6a); } }
      else { s.hit=false; s.reticle.visible=false; }
    } else {
      // the world follows its anchor. Tracking lost = the anchor leaves the tracked set: hold the last pose, hide the world, and
      // when it comes back it simply resumes; a long loss re-anchors where the world was or asks for a new placement
      if(s.anchor){
        if(xf.trackedAnchors&&xf.trackedAnchors.has(s.anchor)){ var ap=xf.getPose(s.anchor.anchorSpace,ref);
          if(ap){ s.base.fromArray(ap.transform.matrix); s.havePose=true; if(s.lost){ s.lost=false; toast(''); } s.lostAt=0; } }
        else { if(!s.lostAt) s.lostAt=t;
          var gone=t-s.lostAt; if(gone>1200&&!s.lost){ s.lost=true; toast('Tracking lost \u2014 move the phone slowly and look at where you placed it'); }
          if(gone>7000&&!s.anchorBusy&&s.havePose&&!s.restored) mkAnchor(xf,s.base);
          if(gone>20000){ replace(); say('Lost the surface \u2014 tap a flat surface to place it again',3500); return; } } }
      else if(s.anchorsOn&&s.anchorFail>0&&!s.anchorBusy&&s.anchorFail<4&&(s.fn%120)===0) mkAnchor(xf,s.base);   // creating the anchor failed: retry a few times, otherwise a fixed pose in the reference space
      k.q.setFromAxisAngle(k.up,s.yaw); k.p.set(0,0,0); k.s.setScalar(s.scale); k.m.compose(k.p,k.q,k.s);
      s.table.matrix.copy(s.base).multiply(k.m); s.table.matrixWorldNeedsUpdate=true; s.table.visible=s.havePose&&!s.lost;
      if(s.table.visible) content(T,ctx,mode);
    }
    // headset controller thumbstick = scale
    if(s.placed&&s.session.inputSources){ for(var j=0;j<s.session.inputSources.length;j++){ var gp=s.session.inputSources[j].gamepad; if(gp&&gp.axes&&gp.axes.length>3&&Math.abs(gp.axes[3])>0.2){ setScale(s.scale*(1-gp.axes[3]*0.02)); } } }
    // real-world lighting (where granted): the sun direction/colour and the ambient colour follow the room
    if(s.probe&&xf.getLightEstimate){ var le=xf.getLightEstimate(s.probe);
      if(le){ s.lightSeen=true; var pi=le.primaryLightIntensity, d=le.primaryLightDirection, sh=le.sphericalHarmonicsCoefficients, m=Math.max(pi.x,pi.y,pi.z,1e-3), a=0.08;
        s.sun.position.set(d.x,d.y,d.z); s.sun.color.setRGB(pi.x/m,pi.y/m,pi.z/m); s.sun.intensity+=(Math.min(3,Math.max(0.2,m))-s.sun.intensity)*a;
        if(sh&&sh.length>=3){ var amb=Math.max(0.15,Math.min(2,0.886*Math.max(sh[0],sh[1],sh[2]))); s.hemi.color.setRGB(Math.min(1,sh[0]/Math.max(sh[0],sh[1],sh[2],1e-3)),Math.min(1,sh[1]/Math.max(sh[0],sh[1],sh[2],1e-3)),Math.min(1,sh[2]/Math.max(sh[0],sh[1],sh[2],1e-3)));
          s.hemi.groundColor.copy(s.hemi.color).multiplyScalar(0.55); s.hemi.intensity+=(amb*1.6-s.hemi.intensity)*a; } } }
    toolsSync();
    s.r.render(s.scene,s.cam); hud(s.cam);
  }
  // what sits on the placed table: the terrain diorama, or (space) the orrery. The game's own space scene can't be drawn by this
  // renderer, so a table-top orrery is what space shows on WebXR; the full fly-through is the camera path.
  function content(T,ctx,mode){
    if(mode==='terrain'){ if(!S.D){ S.D=buildDiorama(T); S.table.add(S.D.grp); } S.D.grp.visible=true; if(S.O) S.O.grp.visible=false; fillDiorama(S.D,ctx,false); }
    else { if(S.D) S.D.grp.visible=false; if(!S.O){ S.O=buildOrrery(T); S.table.add(S.O.grp); } S.O.grp.visible=true; if(((S.fn|0)%3)===0) fillOrrery(S.O,T); }
  }
  // the 3D HUD (ui/dm-ui3d-mesh.js): the very same merged mesh on a head-locked plate. Handheld: it fills the view (the page's pixel
  // layout, 0.6 m out). Headset: a fixed 0.5 m tall panel 0.9 m out, so the screen-shaped layout never stretches across the whole FOV.
  function hud(camUsed){
    var M=window.DMUI3DMesh, s=S; if(!M||!M.mesh||!M.active) return;   // no 3D HUD (legacy / opt-out / not ready): the real DOM HUD is what shows
    var d=s.screen?0.6:0.9, sc;
    if(s.screen){ var pe=camUsed.projectionMatrix.elements, fovY=2*Math.atan(1/(pe[5]||1)); sc=2*d*Math.tan(fovY/2)/(innerHeight||1); } else sc=0.5/(innerHeight||1);
    if(M.mesh.parent!==s.plate) s.plate.add(M.mesh);
    var k=K; camUsed.updateMatrixWorld(); k.p.set(0,s.screen?0:-0.04,-d); k.q.identity(); k.s.setScalar(sc); k.m2.compose(k.p,k.q,k.s);
    s.plate.matrix.copy(camUsed.matrixWorld).multiply(k.m2); s.plate.matrixWorldNeedsUpdate=true;
    var ac=s.r.autoClear; s.r.autoClear=false; try{ s.r.clearDepth&&s.r.clearDepth(); s.r.render(s.hudScene,camUsed); }catch(e){ s.r.autoClear=ac; return; } s.r.autoClear=ac;
    // the plate drew, so the real panels must ghost: DMUI3DMesh.drawTo does exactly that bookkeeping (it draws its own, now
    // empty, scene because the mesh lives on the plate, then ghostDrawn()). Called every frame so the ghost can never time out.
    try{ M.drawTo&&M.drawTo(s.r); }catch(e){}
  }
  function switchMode(mode){
    S.mode=mode;   // the game's flightScene is never drawn or modified by the WebXR path: nothing to strip, the AR canvas clears to transparent
    if(!S.placed) prompt(); else if(S.kind==='webxr'&&mode==='space') say('Space on WebXR: your orrery. The full fly-through around you is in camera AR.',3200);
    if(mode==='terrain'&&S.D) fillDiorama(S.D,terrainCtx(),true);
  }
  // Restoring the game's rAF and flightRenderer.render is guaranteed: each teardown step is isolated and the
  // two swaps are undone in `finally`, whatever throws. Runs on session 'end', on a frame that keeps throwing,
  // on window error / pagehide, and from enter() failures.
  function cleanup(){
    if(!S) return; var s=S; S=null;
    try{
      try{ s.r&&s.r.setAnimationLoop(null); }catch(e){}
      if(s.kind==='camera'){ try{ _caf(s.raf); }catch(e){} try{ s.stream.getTracks().forEach(function(k){ k.stop(); }); }catch(e){} try{ s.vid.remove(); }catch(e){}
        try{ window.removeEventListener('pointerup',s.onTap,true); window.removeEventListener('resize',s.onResize); window.removeEventListener('deviceorientation',onOri,true); }catch(e){} }
      else { try{ s.ref&&s.ref.removeEventListener('reset',onReset); }catch(e){} try{ document.body.removeEventListener('beforexrselect',onBeforeSelect); }catch(e){}
        try{ s.session.removeEventListener('select',onSelect); s.session.removeEventListener('squeezestart',onSqueeze); s.session.removeEventListener('inputsourceschange',onInputs); }catch(e){}
        try{ s.ctl.forEach(function(h){ try{ h.cancel(); }catch(e){} }); s.ctl.clear(); }catch(e){}
        try{ document.documentElement.classList.remove('dm-ar-dom'); }catch(e){}
        try{ var HM=window.DMUI3DMesh; if(HM&&HM.mesh&&HM.mesh.parent===s.plate) s.plate.remove(HM.mesh); }catch(e){} }
      try{ gOff(); var td=document.getElementById('dm-ar-tools'); if(td) td.remove(); }catch(e){}
      try{ var M=window.DMUI3DMesh; M&&M.arHold(false); }catch(e){}
      try{ viewBtn(false); s.gameCv&&s.gameCv.classList.remove('dm-ar-game'); document.body.classList.remove('dm-ar-full'); }catch(e){}
      try{ var fs=g('flightScene'); if(fs) unstrip(fs,s.sky); }catch(e){}
      try{ s.hitSrc&&s.hitSrc.cancel(); }catch(e){} try{ s.anchor&&s.anchor.delete&&s.anchor.delete(); }catch(e){}   // the anchor object only: a persistent anchor stays saved
      try{ s.D&&s.D.dispose(); }catch(e){} try{ if(s.B){ s.B.pp.dispose(); if(s.B.W){ s.B.W.mesh.parent&&s.B.W.mesh.parent.remove(s.B.W.mesh); s.B.W.geo.dispose(); s.B.W.cap.parent&&s.B.W.cap.parent.remove(s.B.W.cap); s.B.W.cap.geometry.dispose(); } } }catch(e){} try{ var _S=S; S=s; arBlend(false); S=_S; }catch(e){} try{ s.O&&disposeOrrery(s.O); }catch(e){}
      try{ s.reticle&&s.reticle.geometry.dispose(); s.reticle&&s.reticle.material.dispose(); }catch(e){}
      try{ s.session&&s.session.removeEventListener('end',cleanup); }catch(e){}
      try{ s.r&&s.r.dispose(); }catch(e){} try{ s.cv.remove(); }catch(e){}
    } finally {
      if(s.kind!=='camera') try{ pumpOff(); }catch(e){ window.requestAnimationFrame=_rafO; window.cancelAnimationFrame=_cafO; }
      if(s.flight&&s.flightRender) s.flight.render=s.flightRender;
      try{ if(s.kind==='camera') window._dmCanvasAlpha&&_dmCanvasAlpha(false); }catch(e){}   // (v196) back to an opaque canvas (only the camera path ever made it transparent)
      try{ perfOff(); }catch(e){}
      document.body.classList.remove('dm-ar-on','dm-ar-cam'); document.documentElement.classList.remove('dm-ar-on');
      try{ toast(''); syncBtns(); window.dispatchEvent(new Event('resize')); }catch(e){}
    }
  }
  function abort(why){ console.warn('[AR] aborting session:',why); var s=S; cleanup(); try{ s&&s.session&&s.session.end().catch(function(){}); }catch(e){} }
  window.addEventListener('pagehide',function(){ if(S) abort('pagehide'); });
  window.addEventListener('error',function(ev){ if(S&&S.errs>=3) abort(ev&&ev.message); });
  function exit(){ if(S&&S.session) S.session.end().catch(cleanup); else if(S) cleanup(); }
  function prompt(){ if(S.kind==='camera'&&S.mode==='space'&&S.view==='full'){ say('Space all around you: steer with the sticks, turn the phone to look around',3500); viewBtn(true); return; }
    try{ viewBtn(S.kind==='camera'); }catch(e){}
    var what='the world';
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
  function devQuat(T,out){   // three.js DeviceOrientationControls convention (camera looks down -Z); scratch only, nothing allocated per frame
    var k=scratch(T), D=Math.PI/180, so=window.screen&&window.screen.orientation, sa=(so&&so.angle)||(+window.orientation||0);
    var b=ori.ok?ori.b:90;   // no motion data yet: assume the phone held upright, looking ahead
    k.e.set(b*D,(ori.a||0)*D,-ori.g*D,'YXZ'); out.setFromEuler(k.e);
    out.multiply(k.qx);
    k.qa.setFromAxisAngle(k.z,-sa*D); out.multiply(k.qa); return out; }
  var TABLE_Y=-0.45;   // the virtual table: 45 cm below the phone
  async function enterCam(perm){
    var T=window.THREE; if(!T) throw new Error('engine not loaded');
    var _t0=performance.now(), _lg=function(w){ console.log('[AR] cam '+w+' '+Math.round(performance.now()-_t0)+'ms'); };
    var stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
    _lg('stream'); var pr=await perm; if(pr==='granted') window.addEventListener('deviceorientation',onOri,true);
    var vid=document.createElement('video'); vid.id='dm-ar-video'; vid.muted=true; vid.playsInline=true; vid.setAttribute('playsinline',''); vid.autoplay=true; vid.srcObject=stream;
    // the hidden game canvas stops drawing from here on (it's covered by the camera anyway). Everything the camera path
    // shows is drawn by the game's own renderer (fullRender, boardRender, the HUD overlay), so no second WebGL context is
    // created: on iOS that was a long start-up hitch and extra GPU memory for a renderer that never drew a frame.
    var FR0=g('flightRenderer'), FR0render=FR0&&FR0.render; if(FR0render) FR0.render=function(){};
    toast('Starting camera AR\u2026');
    var drop=function(){ if(FR0render) FR0.render=FR0render;  try{ stream.getTracks().forEach(function(k){ k.stop(); }); }catch(e){} vid.remove(); window.removeEventListener('deviceorientation',onOri,true); };
    try{ document.body.appendChild(vid); try{ await Promise.race([vid.play(),new Promise(function(r){ setTimeout(r,1500); })]); }catch(e){} }   // play() can stay pending (autoplay policy, a stalled stream): never block entering on it
    catch(e){ drop(); throw e; }
    var r=null, cv=null, K0=scratch(T);
    var scene=new T.Scene(), cam=new T.PerspectiveCamera(innerHeight>innerWidth?68:50,innerWidth/innerHeight,0.01,100);
    var reticle=new T.Object3D(), table=new T.Group(); table.visible=false; scene.add(table);
    S={kind:'camera',view:'full',rReady:false,stream:stream,vid:vid,r:r,cv:cv,scene:scene,cam:cam,reticle:reticle,table:table,placed:false,errs:0,D:null,sky:null,flight:null,mode:null,
       scale:1,yaw:0,baseYaw:0,target:60,sq:new T.Quaternion(),sqOk:false,tap:new T.Vector2(),
       q0:null,yaw0:null,ray:new T.Raycaster(),plane:new T.Plane(new T.Vector3(0,1,0),-TABLE_Y),hit:new T.Vector3(),hasHit:false,dq:new T.Quaternion()};
    S.onTap=function(e){ if(!S||S.kind!=='camera'||S.full||(S.placed&&!(S.mode==='terrain'))||_pt.size>1||_g) return; var t=e.target;
      if(uiHit(t)) return;
      camTapPlace(e.clientX,e.clientY); };
    gOn(); perfOn(S);   // pinch / twist, and the AR pixel-ratio cap (restored on exit)
    window.addEventListener('pointerup',S.onTap,true);
    S.onResize=function(){ if(!S) return; S.cam.fov=innerHeight>innerWidth?68:50; S.cam.aspect=innerWidth/innerHeight; S.cam.updateProjectionMatrix(); };
    window.addEventListener('resize',S.onResize);
    S.flight=FR0; S.flightRender=FR0render; try{ window._dmCanvasAlpha&&_dmCanvasAlpha(true); }catch(e){}   // (v196) alpha canvas for AR only
    // the game's renderer draws the full space overlay (fullRender) and the terrain board (boardRender, from _pwRender);
    // in the table-top orrery view it stays idle
    if(FR0render) FR0.render=function(sc,cm){ if(!S||S.kind!=='camera') return FR0render.call(FR0,sc,cm); var UM=window.DMUI3DMesh; if(UM&&sc===UM.scene) return FR0render.call(FR0,sc,cm);   /* the 3D HUD pass (overlay) draws normally over every camera view */ if(S.full) return fullRender(sc,cm); if(S.mode==='terrain'&&S._inBoard) return FR0render.call(FR0,sc,cm); if(S.mode==='terrain'&&!S.fp&&S.shipBoard&&S._bfDone!==S._fn){ S._bfDone=S._fn; return boardRender(FR0,sc,cm); } };   // mesh maps draw their board from the flight loop (once per frame)   // terrain: only the board's own pass draws
    try{ var gc=FR0&&FR0.domElement; if(gc){ gc.classList.add('dm-ar-game'); S.gameCv=gc; } }catch(e){}
    viewBtn(true);   // (the 3D HUD is NOT held on this path: the game's own overlay pass draws it over the camera, so its DOM ghosts stay consistent with what is on screen)
    document.body.classList.add('dm-ar-on','dm-ar-cam'); document.documentElement.classList.add('dm-ar-on');
    syncBtns(); if(pr!=='granted') say('Motion access off: the view won\u2019t follow the phone (Settings \u203a Safari \u203a Motion & Orientation)',4500);
    var loop=function(t){ if(!S||S.kind!=='camera') return; S.raf=_raf(loop); try{ camFrame(t); S.errs=0; }catch(e){ console.warn('[AR] cam frame',e); if(++S.errs>=3) abort(e&&e.message); } };
    S.raf=_raf(loop);
  }
  // head pose from the phone's sensors, eased: sub-0.1 degree sensor noise is held still (no shimmer on the placed world) and the
  // easing opens up with the turn rate, so a fast pan is followed almost 1:1
  function camPose(T){ var k=scratch(T), q=devQuat(T,k.q);
    if(S.yaw0==null&&ori.ok){ k.p.set(0,0,-1).applyQuaternion(q); S.yaw0=Math.atan2(-k.p.x,-k.p.z); }
    if(S.yaw0!=null){ k.qa.setFromAxisAngle(k.up,-S.yaw0); q.premultiply(k.qa); }   // start facing -Z
    if(!S.sqOk){ S.sq.copy(q); S.sqOk=true; } else { var ang=S.sq.angleTo(q); if(ang>0.0017) S.sq.slerp(q,Math.min(1,0.18+ang*9)); }
    return S.sq; }
  function camTapPlace(x,y){ var T=window.THREE, k=scratch(T); S.tap.set(x/innerWidth*2-1,-(y/innerHeight)*2+1);
    S.ray.setFromCamera(S.tap,S.cam); var p=k.p;
    if(!S.ray.ray.intersectPlane(S.plane,p)||p.length()>2.2){ p.copy(S.ray.ray.direction).multiplyScalar(0.8); p.y=Math.min(p.y,-0.12); }   // no table hit nearby: where the tap points, 80 cm out, kept just below eye level
    S.table.position.copy(p); S.baseYaw=Math.atan2(-p.x,-p.z)+Math.PI; S.yaw=0; S.table.rotation.set(0,S.baseYaw,0); S.table.visible=true; S.placed=true; S.reticle.visible=false; toast(''); }
  // ---------- full live space overlay (camera fallback) ----------
  // The game keeps drawing its own scene with its own renderer and its already-compiled pipelines; each of its
  // passes that uses the flight camera is drawn with the device turn layered on and, near a star, from a safe
  // standoff outside the photosphere and glow shells. The sky/background is stripped for those calls only.
  var _fq=null,_fp=null,_fv=null,_fs=null,_eye=null,_ev=null,_eyeRoot=null;
  function eyeCam(cm,hid,T){
    var C=window.CHAR, root=C&&C.root; if(!root||!root.visible) return;
    root.updateMatrixWorld(true);
    if(_eyeRoot!==root){ _eye=null; _eyeRoot=root; }   // her model changed: measure the eye again
    if(!_eye){ var bb=new T.Box3().setFromObject(root); if(bb.isEmpty()) return; _eye=root.worldToLocal(new T.Vector3((bb.min.x+bb.max.x)/2,bb.min.y+0.93*(bb.max.y-bb.min.y),(bb.min.z+bb.max.z)/2)); _ev=new T.Vector3(); }
    _ev.copy(_eye); root.localToWorld(_ev); if(cm.parent) cm.parent.worldToLocal(_ev); cm.position.copy(_ev);
    root.visible=false; hid.push(root);   // restored by fullRender's finally (not a wall)
  }
  var SAFE_K=4;   // standoff: 4 solar radii from the Sun's centre
  function fullRender(sc,cm){
    var fc=g('flightCamera'), orig=S.flightRender, T=window.THREE;
    if(!(fc&&cm===fc)&&!(S.fp&&cm&&(cm===g('surfCamera')||cm===g('atmoCamera')))) return orig.call(S.flight,sc,cm);   // (v178) first person on a planet map draws through surfCamera
    _fq=_fq||new T.Quaternion(); _fp=_fp||new T.Vector3(); _fv=_fv||new T.Vector3(); _fs=_fs||new T.Vector3();
    _fq.copy(cm.quaternion); _fp.copy(cm.position);
    var bg=sc.background, hid=[], ca=null, lv=null;
    try{
      if(S.dq) cm.quaternion.multiply(S.dq);
      var sm=g('sunMesh'), R0=g('SOL_SUN_RADIUS')||160;
      if(sm&&!S.fp){ (sm.parent&&sm.parent.isGroup?sm.parent:sm).getWorldPosition(_fs); cm.getWorldPosition(_fv);
        var d=_fv.distanceTo(_fs), safe=R0*SAFE_K;
        if(d<safe){ _fv.sub(_fs); if(_fv.lengthSq()<1e-6) _fv.set(0,0,1); _fv.setLength(safe).add(_fs);
          if(cm.parent) cm.parent.worldToLocal(_fv); cm.position.copy(_fv); S.safeHold=true; } else S.safeHold=false; }
      if(S.eyeOn) eyeCam(cm,hid,T);   // (v178) AR first person in space / atmosphere: through Ariel's eyes
      cm.updateMatrixWorld(true);
      if(((S.blendN=(S.blendN||0)+1)%45)===0) try{ arBlend(true,true); }catch(e){}   // pick up effects added since AR started
      sc.background=null; ca=S.flight.getClearAlpha(); S.flight.setClearAlpha(0);
      sc.traverseVisible&&sc.traverseVisible(function(o){ if(o.userData&&(o.userData.dmSkyShell||o.userData.dmArHide)){ o.visible=false; hid.push(o); } });
      if(S.fp&&S.mode==='terrain'){ lv=_rv; arLit(sc,S.flight); }   // (v196) life-scale ground: same light as the board
      return orig.call(S.flight,sc,cm);
    } finally {
      arUnlit(lv); if(ca!=null) S.flight.setClearAlpha(ca);
      sc.background=bg; for(var i=0;i<hid.length;i++) hid[i].visible=!(hid[i].userData&&hid[i].userData.dmArWall);
      cm.quaternion.copy(_fq); cm.position.copy(_fp); cm.updateMatrixWorld(true);
    }
  }
  // Additive sprites, flares and glows: their colour is added as before, but in AR they must not add to the canvas
  // alpha (a black-cornered sprite quad would turn into an opaque black square over the camera). The premultiplied
  // canvas then composites their light additively over the passthrough with the sprite's own feathered falloff.
  function arBlend(on,rescan){
    var T=window.THREE, sc=g('flightScene'); if(!T||!sc) return;
    if(on){ if(S.blendSaved&&!rescan) return; var sv=S.blendSaved=S.blendSaved||[], n0=sv.length;
      // rescan: effects built after AR started (the star bubble, ghost bubbles, fumes, new bodies' glows) get the same
      // light-only blend; already-converted materials are skipped by their _dmArB mark
      sc.traverse(function(o){ var ms=o.material; if(!ms) return; (Array.isArray(ms)?ms:[ms]).forEach(function(m){
        if(!m||m.blending!==T.AdditiveBlending||m._dmArB) return;
        m._dmArB={b:m.blending,s:m.blendSrc,d:m.blendDst,e:m.blendEquation,sa:m.blendSrcAlpha,da:m.blendDstAlpha,ea:m.blendEquationAlpha};
        m.blending=T.CustomBlending; m.blendEquation=T.AddEquation; m.blendSrc=m.premultipliedAlpha?T.OneFactor:T.SrcAlphaFactor; m.blendDst=T.OneFactor;
        m.blendEquationAlpha=T.AddEquation; m.blendSrcAlpha=T.ZeroFactor; m.blendDstAlpha=T.OneFactor; sv.push(m); }); });
      // compile the changed blend states now, off the frame, so the first AR frames don't hitch
      if(!rescan||sv.length>n0) try{ var fr=S.flight, fc=g('flightCamera'); if(fr&&fr.compileAsync&&fc) fr.compileAsync(sc,fc).catch(function(){}); }catch(e){}
    } else if(S.blendSaved){ S.blendSaved.forEach(function(m){ var b=m._dmArB; if(!b) return; m.blending=b.b; m.blendSrc=b.s; m.blendDst=b.d; m.blendEquation=b.e; m.blendSrcAlpha=b.sa; m.blendDstAlpha=b.da; m.blendEquationAlpha=b.ea; delete m._dmArB; }); S.blendSaved=null; }
  }
  // ---------- terrain board: the real world, drawn by the game's renderer onto the anchored table ----------
  // A board camera stands where the phone is relative to the placed board, scaled up to world size and centred on
  // Ariel, and draws the game's own world scene (terrain mesh, materials, water, props, Ariel) through one pass. The
  // pass keeps only what lies inside the 3x3 square: opaque to halfway across the outer ring, then a premultiplied
  // alpha feather to zero at the perimeter, a hard cut beyond. The world's sky and fog are left out.
  var L_WORLD=300, SHIP_UNITS=10;   // terrain: world units per unit; mesh maps: Ariel heights per unit   // world units per grid unit (Ariel's high-detail square)
  function buildBoard(T,r,scene){
    var TSL=T.TSL, bc=new T.PerspectiveCamera(60,1,1,1e5);
    var U={c:TSL.uniform(new T.Vector2()),half:TSL.uniform(450),tx:TSL.uniform(1),ty:TSL.uniform(1),far:TSL.uniform(1e5),nr:TSL.uniform(1),gy:TSL.uniform(0),fh:TSL.uniform(50),cw:TSL.uniform(new T.Matrix4())};
    var sp=TSL.pass(scene,bc), col=sp.getTextureNode('output'), vz=(r.logarithmicDepthBuffer&&TSL.logarithmicDepthToViewZ)?TSL.logarithmicDepthToViewZ(sp.getTextureNode('depth').r,U.nr,U.far):sp.getViewZNode();   // (v165) the game's renderer uses a log depth buffer
    var u=TSL.screenUV, dist=vz.negate();
    var vp=TSL.vec3(u.x.mul(2).sub(1).mul(U.tx),TSL.float(1).sub(u.y).mul(2).sub(1).mul(U.ty),-1).mul(dist);
    var wp=U.cw.mul(TSL.vec4(vp,1)).xyz;
    var d=TSL.max(TSL.abs(wp.x.sub(U.c.x)),TSL.abs(wp.z.sub(U.c.y))).div(U.half);
    // the block stays solid (ground at the rim, cliff faces); only what rises above the rim, the tall features and the
    // horizon, feathers out toward the perimeter. Beyond the perimeter: a hard cut.
    var tall=TSL.smoothstep(0,U.fh,wp.y.sub(U.gy));
    var a=TSL.float(1).sub(TSL.smoothstep(2/3,1,d).mul(tall)).mul(d.lessThan(1.007).select(1,0)).mul(dist.lessThan(U.far.mul(0.98)).select(1,0));
    var pp=new (T.RenderPipeline||T.PostProcessing)(r);
    pp.outputNode=TSL.vec4(col.rgb.mul(a),col.a.mul(a));   // premultiplied
    return {scene:scene,bc:bc,U:U,pp:pp,m:new T.Matrix4(),p:new T.Vector3(),q:new T.Quaternion(),sc:new T.Vector3()};
  }
  // cliff walls: the board is a solid block. Four skirts follow the terrain's edge profile down to a flat base
  // (about 4x Ariel's height below the ground, with a floor so a low view still reads as a plateau), rock strata.
  var WSEG=48;
  function buildWalls(T){
    var TSL=T.TSL, n=4*(WSEG+1), pos=new Float32Array(n*2*3), idx=[];
    for(var sd=0;sd<4;sd++) for(var i=0;i<WSEG;i++){ var a=(sd*(WSEG+1)+i)*2, b=a+2; idx.push(a,a+1,b, b,a+1,b+1); }
    var geo=new T.BufferGeometry(); geo.setAttribute('position',new T.BufferAttribute(pos,3)); geo.setIndex(idx);
    var M=T.MeshStandardNodeMaterial?new T.MeshStandardNodeMaterial():new T.MeshStandardMaterial();
    M.side=T.DoubleSide; M.roughness=0.95; M.metalness=0;
    if(TSL&&M.isNodeMaterial){ var y=TSL.positionWorld.y, k=TSL.sin(y.mul(0.35)).mul(0.5).add(0.5), k2=TSL.sin(y.mul(1.7).add(TSL.positionWorld.x.add(TSL.positionWorld.z).mul(0.05))).mul(0.5).add(0.5);
      M.colorNode=TSL.mix(TSL.mix(TSL.color(0x5a4636),TSL.color(0x8a6f55),k),TSL.color(0x3e3229),k2.mul(0.35)); M.emissiveNode=M.colorNode.mul(0.45); }   // (v178) never reads black where the scene's light is far or behind
    else M.color.set(0x6b5442);
    var mesh=new T.Mesh(geo,M); mesh.frustumCulled=false; mesh.visible=false; mesh.userData.dmArWall=true;
    var cap=new T.Mesh(new T.PlaneGeometry(1,1).rotateX(-Math.PI/2),M); cap.frustumCulled=false; cap.visible=false; cap.userData.dmArWall=true;   // mesh maps: the plateau's top under the deck
    return {mesh:mesh,pos:pos,geo:geo,cap:cap};
  }
  function fillWalls(W,H,cx,cz,half,depth,pal){
    var p=W.pos, lo=Infinity, tops=[];
    for(var sd=0;sd<4;sd++) for(var i=0;i<=WSEG;i++){ var t=-1+2*i/WSEG, x,z;
      if(sd===0){x=cx+t*half; z=cz-half;} else if(sd===1){x=cx+half; z=cz+t*half;} else if(sd===2){x=cx-t*half; z=cz+half;} else {x=cx-half; z=cz-t*half;}
      var h=0; try{ h=+H(x,z); }catch(e){} if(!isFinite(h)) h=0; var sea=pal; if(sea!=null&&h<sea) h=sea;
      tops.push(x,h,z); if(h<lo) lo=h; }
    var base=lo-depth; W.hi=-Infinity; for(var k=1;k<tops.length;k+=3) if(tops[k]>W.hi) W.hi=tops[k];
    for(var j=0;j<tops.length/3;j++){ var o=j*6; p[o]=tops[j*3]; p[o+1]=tops[j*3+1]; p[o+2]=tops[j*3+2]; p[o+3]=tops[j*3]; p[o+4]=base; p[o+5]=tops[j*3+2]; }
    W.geo.attributes.position.needsUpdate=true; W.geo.computeVertexNormals();
  }
  // (v196) the non-AR terrain gets most of its light from the true-atmosphere pass (sky irradiance + sun through the
  // air), which AR leaves out (it is an opaque full-screen pass). Without it the scene's own lights are a dim fill
  // (sun ~0.16, sky ~0.05) and the ground reads black over the camera. For the AR terrain draw only, the lights are
  // scaled (uniforms: no recompile) and restored after.
  var LIT={d:7,a:12,e:1.2,tint:0.6}, _tc=null;
  // (v196) one reusable restore record (filled BEFORE each change, so a throw partway still restores everything) and a
  // light list cached per scene (re-walked every 120 draws, not every frame).
  var _rv={on:false,l:[],c:[],e:1,r:null}, _ls={sc:null,n:0,a:[]};
  function arLights(scene){ if(_ls.sc!==scene||(++_ls.n%120)===0){ _ls.sc=scene; _ls.a.length=0; scene.traverse(function(o){ if(o.isLight) _ls.a.push(o); }); } return _ls.a; }
  function arLit(scene,r){ var sv=_rv; arUnlit(sv); sv.on=true; sv.r=r; sv.e=r.toneMappingExposure; sv.l.length=0; sv.c.length=0;
    var L=arLights(scene), pw=window.PW, bg=pw&&pw.bg;
    for(var i=0;i<L.length;i++){ var o=L[i]; if(!o.visible) continue; var k=o.isDirectionalLight?LIT.d:(o.isAmbientLight||o.isHemisphereLight)?LIT.a:1; if(k===1) continue;
      sv.l.push(o,o.intensity); o.intensity*=k;
      if(k===LIT.a&&LIT.tint>0&&bg&&bg.isColor){ sv.c.push(o.color,o.color.getHex()); o.color.lerp(bg,LIT.tint); } }   // the air's colour (the true-atmosphere pass tints the ground with it)
    r.toneMappingExposure=sv.e*LIT.e; return sv; }
  function arUnlit(sv){ sv=sv||_rv; if(!sv.on) return; sv.on=false; for(var i=0;i<sv.l.length;i+=2) sv.l[i].intensity=sv.l[i+1]; for(var j=0;j<sv.c.length;j+=2) sv.c[j].setHex(sv.c[j+1]); sv.l.length=0; sv.c.length=0; if(sv.r) sv.r.toneMappingExposure=sv.e; }
  function boardRender(r,scene,cam){
    if(!S||S.kind!=='camera'||S.mode!=='terrain') return false;
    var T=window.THREE, ctx=terrainCtx(), ca=r.getClearAlpha(), bg=scene.background, hid=[], fog=scene.fog, fs=null;
    r.setClearAlpha(0);
    try{
      if(!S.placed||!ctx){ r.setRenderTarget(null); r.clear(); return true; }
      if(!S.B||S.B.scene!==scene){ if(S.B) try{ S.B.pp.dispose(); if(S.B.W){ S.B.W.mesh.parent&&S.B.W.mesh.parent.remove(S.B.W.mesh); S.B.W.geo.dispose(); S.B.W.cap.parent&&S.B.W.cap.parent.remove(S.B.W.cap); S.B.W.cap.geometry.dispose(); } }catch(e){} S.B=buildBoard(T,r,scene); }
      var B=S.B, L=ctx.ship?SHIP_UNITS*(B.ah||1.8):L_WORLD, half=1.5*L, s=3*L/DIO_SIZE;   // (v178) mesh maps: a unit is a fixed number of Ariel heights
      var px=ctx.pos.x, pz=ctx.pos.z, h=NaN; try{ h=+ctx.H(px,pz); }catch(e){} if(!isFinite(h)) h=ctx.pos.y||0;
      S.table.updateMatrixWorld(true); S.cam.updateMatrixWorld(true);
      B.m.copy(S.table.matrixWorld).invert().multiply(S.cam.matrixWorld); B.m.decompose(B.p,B.q,B.sc);
      var bc=B.bc; bc.position.set(px+B.p.x*s,h+B.p.y*s,pz+B.p.z*s); bc.quaternion.copy(B.q);
      bc.fov=S.cam.fov; bc.aspect=innerWidth/innerHeight; bc.near=Math.max(0.5,0.02*s); bc.far=8*s; bc.updateProjectionMatrix(); bc.updateMatrixWorld(true);
      var e=bc.projectionMatrix.elements; B.U.tx.value=1/e[0]; B.U.ty.value=1/e[5]; B.U.far.value=bc.far; B.U.nr.value=bc.near; B.U.cw.value.copy(bc.matrixWorld);
      B.U.c.value.set(px,pz); B.U.half.value=half;
      if(!B.W){ B.W=buildWalls(T); scene.add(B.W.mesh); scene.add(B.W.cap); }
      var ah=B.ah||1.8; if(!B.ah) try{ var cb=window.CHAR&&CHAR.root; if(cb){ var bb=new T.Box3().setFromObject(cb); var hh=bb.max.y-bb.min.y; if(isFinite(hh)&&hh>0.2&&hh<50) ah=B.ah=hh; } }catch(e){}
      var depth=Math.max(4*ah,0.06*2*half);   // ~4x her height, never thinner than a readable slab at board scale
      var sw=g('surfWater'), sea=(sw&&sw.visible&&sw.position&&isFinite(sw.position.y))?sw.position.y:null;
      fillWalls(B.W,ctx.H,px,pz,half,depth,sea);
      B.U.gy.value=B.W.hi; B.U.fh.value=0.12*half; B.W.mesh.visible=true; hid.push(B.W.mesh); B.W._on=true;
      if(ctx.ship){ B.W.cap.position.set(px,B.W.hi-0.02*(B.ah||1.8),pz); B.W.cap.scale.set(2*half,1,2*half); B.W.cap.visible=true; hid.push(B.W.cap); }
      scene.background=null;
      scene.traverseVisible(function(o){ if(o.userData&&(o.userData.dmSkyShell||o.userData.dmArHide)){ o.visible=false; hid.push(o); } });
      if(fog){ fs={n:fog.near,f:fog.far,d:fog.density}; if(fog.density!=null) fog.density=0; else { fog.near=1e12; fog.far=2e12; } }   // uniforms only: no recompile
      S._inBoard=true; try{ arLit(scene,r); B.pp.render(); } finally { S._inBoard=false; arUnlit(_rv); }
      return true;
    } finally {
      r.setClearAlpha(ca); scene.background=bg; for(var i=0;i<hid.length;i++) hid[i].visible=!(hid[i].userData&&hid[i].userData.dmArWall);
      if(fog&&fs){ fog.near=fs.n; fog.far=fs.f; if(fs.d!=null) fog.density=fs.d; }
    }
  }
  function viewBtn(on){ var b=document.getElementById('dm-ar-view');
    if(!on){ if(b) b.remove(); return; }
    if(!b){ b=document.createElement('button'); b.id='dm-ar-view'; b.type='button';
      b.addEventListener('click',function(e){ e.stopPropagation(); if(!S) return; S.arFP=!S.arFP; viewBtn(true); });   // (v178) first person (her eyes) in AR
      document.body.appendChild(b); }
    b.textContent=S&&S.arFP?'\ud83d\udc41 3RD PERSON':'\ud83d\udc41 1ST PERSON'; b.style.display=S&&S.arBtn?'':'none'; }   // space + atmosphere (maps on foot use the game's own 1st-person button)   // (v178) no table/full toggle: the mode follows where Ariel is
  function camFrame(t){
    var T=window.THREE, ctx=terrainCtx(), mode=ctx?'terrain':'space';
    track(t);
    if(mode!==S.mode) switchMode(mode);
    S._fn=(S._fn|0)+1; S.shipBoard=!!(ctx&&ctx.ship);
    S.view='full'; var atmoFly=mode==='terrain'&&!!(ctx&&!ctx.ship&&g('atmoActive')&&!g('surfaceActive'));
    var fp=mode==='terrain'&&!!(ctx&&(ctx.ship?((g('SHIP_WALK')||{}).fp):(g('surfFirstPerson')&&g('surfaceActive')))); if(atmoFly&&S.arFP) fp=true; S.fp=fp;
    var wantBtn=mode==='space'||atmoFly; S.eyeOn=!!(S.arFP&&wantBtn); if(wantBtn!==!!S.arBtn){ S.arBtn=wantBtn; viewBtn(true); }
    var q=camPose(T), full=mode==='space'||fp;   // (v178) first person on a map: the same scene at life scale around the viewer; back to 3rd person returns to the same table anchor   // (v178) space = full fly-through around the device; maps = tabletop
    if(full!==!!S.full){ S.full=full; if(full) S.q0=null; viewBtn(true); arBlend(full); }
    document.body.classList.toggle('dm-ar-full',full||mode==='terrain');
    S.cam.position.set(0,0,0); S.cam.quaternion.copy(q); S.cam.updateMatrixWorld(true);
    if(mode==='terrain'&&!fp){   // the game's own loop draws the world onto the board (boardRender, called from _pwRender)
      if(!S.placed){ S.tap.set(0,0); S.ray.setFromCamera(S.tap,S.cam); var ap=S.hit; if(!(S.ray.ray.intersectPlane(S.plane,ap)&&ap.length()<1.6)){ var fw=S.ray.ray.direction; ap.set(fw.x,0,fw.z); if(ap.lengthSq()<1e-6) ap.set(0,0,-1); ap.normalize().multiplyScalar(0.9); ap.y=-0.25; } S.table.position.copy(ap); S.baseYaw=Math.atan2(-ap.x,-ap.z)+Math.PI; S.yaw=0; S.table.rotation.set(0,S.baseYaw,0); S.table.visible=true; S.placed=true; S.autoPlaced=true; toast(''); }   // (v165) auto-placed where the phone looks: held level it sits ~15° below centre, inside the view
      S.table.rotation.y=S.baseYaw+S.yaw; S.table.scale.setScalar(S.scale); toolsSync();   // pinch / buttons: the world's scale and twist about its anchor
      return; }
    if(full){
      toolsSync();
      if(!S.q0) S.q0=q.clone().invert();
      S.dq.copy(S.q0).multiply(q);   // device turn since entering, layered on the game camera in fullRender
      if(S.safeHold&&!S._safeSaid){ S._safeSaid=true; say('Holding a safe distance from the Sun in AR',2500); }
      return;   // the game's own loop draws (see fullRender)
    }
  }

  window.DMAR={toggle:toggle,exit:exit,get active(){ return !!S; }, get letWarm(){ return !!(S&&S.full); }, get passthrough(){ return !!(S&&S.kind==='camera'&&(S.full||S.mode==='terrain')); }, get noAtmo(){ return !!(S&&S.kind==='camera'&&(S.full||S.mode==='terrain')); }, get boardOn(){ return !!(S&&S.kind==='camera'&&S.mode==='terrain'&&!S.fp); }, board:boardRender, lit:LIT, get mode(){ return S?S.kind+'/'+(S.mode||'-')+(S.placed?' placed':''):(supported?'off (webxr ready)':'off (camera fallback)'); }, _cam:function(){ return S; },get supported(){ return supported; },_buildDiorama:buildDiorama,_fillDiorama:fillDiorama,_stripSky:stripSky,_unstrip:unstrip};
  function init(){
    placeButtons();
    try{ new MutationObserver(function(){ placeButtons(); }).observe(document.body,{childList:true,subtree:false}); }catch(e){}
    if(navigator.xr&&navigator.xr.isSessionSupported){ navigator.xr.isSessionSupported('immersive-ar').then(function(ok){ supported=!!ok; placeButtons(); }).catch(function(){}); }
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})();
