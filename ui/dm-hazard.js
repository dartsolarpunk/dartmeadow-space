/* ═══════════════════════════════════════════════════════════════════
   HAZARD — per-body habitability, the DMHazard source registry + sensor, the exposure clock, and the protection state shown on her
   Skyboard set (staff-crown contour glow + lighthouse LED) and on her (a small chest LED; a faint head light in first person).
   (This file replaces ui/dm-hazardbubble.js.  The green "toxic air" orb, the blue underwater mist orb, the HUD SHIELD toggle and the orb's
   look code are GONE: nothing here draws a sphere round her.  The atmosphere / sky are not in this file and are untouched.)

   habitable   DM_HAZ.habitable(body) -> bool, cached on body.habitable.  Earth + Ariel's home planet (Solenne) true; Mars, Titan, Moon, Mercury,
               Venus, Pluto and every other Sol body false; seeded planets are chosen from their OWN derived stream (hash('hab:'+mcSeed),
               type-biased) - the terrain / seed RNG streams are never touched.  An explicit body.habitable boolean wins.
   DMHazard    registry of hazard sources (a world's toxic / airless air is one 'global' source; plumes, vents ... register local ones) and a ~3 Hz
               proximity sensor that exists only while a LOCAL source does.
   exposure    DM_HAZ.exposure: while a hazard is sensed at her, a reserve (1 -> 0) drains at intensity / HAZARD_TABLE[type].safeSec per second and
               refills at 1 / recoverSec when she is clear.  Pure maths in DM_HAZ.core (tools/tests/shield-unit.js).  Nothing happens at zero except the
               warning state ('exposed': red LED / crown, HUD "OVEREXPOSED") and one `dmhazardzero` event (no damage, no game-over).
   protection  DMShield (below): ACTIVE whenever a hazard is sensed at her, whether or not the Skyboard is parked: LED on the lighthouse housing,
               contour glow on the staff crown, and a small LED on her chest.  First person: her body and the board are hidden, so a faint short-range
               light at her head (one of the world's FIXED pooled natural lights, no shadow) is the glow.  Status colour: green protected (reserve above
               the table's warn fraction), amber (below it), red (zero); amber pulsing = a local hazard is NEAR but she is not inside it yet.
   dive        riding the board below JOTS_WATER's surface: water drag (waterDrag), a fog + caustic tint and a bubble trail.  (No orb.)
   Cost: nothing at all on a safe map (one boolean test per frame).  Hostile world: exposure arithmetic + a few uniform writes + 1-2 hull draws of the
   crown's own geometry, 3 tiny LED meshes.  Nothing is created per frame.  Everything is built + compiled while the world loads (DM_HAZ.prewarm).
   ═══════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  const H={wet:0,underwater:false,off:false,built:false,failed:false,ready:true,_mode:null};
  window.DM_HAZ=H; window.DMHaz=H;

  /* ── habitability ──────────────────────────────────────────────── */
  // own copies of the FNV-1a / mulberry32 mix: a separate stream, so no existing RNG state or call order moves
  function fnv(s){ let h=2166136261>>>0; s=String(s); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619)>>>0; } return h>>>0; }
  function u01(seed){ let a=(seed>>>0)+0x6D2B79F5; a=Math.imul(a^(a>>>15),a|1); a^=a+Math.imul(a^(a>>>7),a|61); return ((a^(a>>>14))>>>0)/4294967296; }
  const HOME=new Set(['earth','solenne']);
  const SOL=new Set(['mercury','venus','moon','luna','mars','phobos','deimos','ceres','vesta','pallas','eros','jupiter','io','europa','ganymede','callisto','saturn','titan','enceladus','mimas','rhea','iapetus','dione','tethys','uranus','titania','oberon','miranda','ariel','umbriel','neptune','triton','pluto','charon','haumea','makemake','eris','sedna','sun','sol']);
  const P_TYPE={Habitable:0.9,Ocean:0.7,Desert:0.2,Rocky:0.12,Ice:0.1,Volcanic:0,Methane:0,'Gas Giant':0,'Barren Moon':0};
  function isSol(b){ const n=String(b.name||'').toLowerCase(); return b.semiMajor!==undefined||!!b.catalog||SOL.has(n)||/^sol[:\s]/.test(String(b.id||'')); }
  H.habitable=function(b){
    if(!b) return true;
    if(typeof b.habitable==='boolean') return b.habitable;
    const n=String(b.name||'').toLowerCase(); let v;
    if(HOME.has(n)||b.home===true||b.homeWorld===true||b.isHome===true||b.arielHome===true||(window.DM_HAB_HOME&&window.DM_HAB_HOME===b.name)) v=true;
    else if(isSol(b)) v=false;
    else if(b.mcSeed!==undefined&&b.mcSeed!==null){
      const p=P_TYPE[b.type]; v=u01(fnv('hab:'+b.mcSeed))<(p===undefined?0.15:p);   // seeded system planets: deterministic from the seed, own stream
    } else v=true;   // custom/unknown bodies: never surprise anyone with a toxic orb
    try{ b.habitable=v; }catch(e){}
    return v;
  };
  H.tag=function(b){ return H.habitable(b); };
  // 'breathable' | 'toxic' (a thick, non-breathable air) | 'airless'
  // ?hazard=toxic|airless|safe forces the answer on EVERY world (test / A-B flag; habitability itself, and so every seed, is untouched)
  const FORCE=(()=>{ try{ const v=new URLSearchParams(window.location.search).get('hazard'); return v==='toxic'||v==='airless'?v:v==='safe'?'breathable':null; }catch(e){ return null; } })();
  H.kind=function(b,pal){ if(FORCE) return FORCE; if(H.habitable(b)) return 'breathable'; return (pal?pal.atmos:b&&b.mcHasAtm)?'toxic':'airless'; };

  /* ── helpers ───────────────────────────────────────────────────── */
  const sm=(a,b,x)=>{ x=(x-a)/(b-a); x=x<0?0:x>1?1:x; return x*x*(3-2*x); };
  const ease=(cur,tgt,rate,dt)=>cur+(tgt-cur)*(1-Math.exp(-rate*dt));
  function lowTier(){ try{ return !!(GFX&&(GFX.preset==='low'||(GFX.isMobile&&GFX.preset!=='high'&&GFX.preset!=='ultra'))); }catch(e){ return false; } }

  let evBay=0;
  window.addEventListener('dm:bay',e=>{ const d=e&&e.detail; evBay=d?(d.inside?1:Math.min(1,Math.max(0,+d.membrane||0))):0; });
  function bayLevel(){
    let v=evBay; try{ const f=window.DM_FAC&&window.DM_FAC.bay; if(f){ const q=f.inside?1:Math.min(1,Math.max(0,+f.membrane||0)); if(q>v) v=q; else if(!evBay) v=q; } }catch(e){}
    return v;
  }


  /* ── underwater GPU objects (built on the first dive, reused across worlds) ── */
  const S={ r:null, scene:null, tint:null, bub:null, tu:null, bgeo:null, bmat:null, pos:null, bn:12, bt:0, seed:1, lastP:null, ready:false, fog:null, fogSaved:false, fogCol:0 };
  const N_BUB=28;

  function build(){
    const T=window.THREE&&THREE.TSL; if(!T||!THREE.MeshBasicNodeMaterial){ H.failed=true; return false; }
    const {float,vec2,vec3,vec4,sin,cos,dot,normalize,mix,smoothstep,positionWorld,normalWorld,cameraPosition,positionLocal,uniform}=T;
    const low=lowTier();
    // underwater tint: a clip-space quad (no camera attach) — fog colour, light from above, faint caustic shimmer
    const tu={wet:uniform(0),ph:uniform(0),depth:uniform(0),col:uniform(new THREE.Color(0x0b3a5c)),aspect:uniform(1),low:uniform(low?1:0)};
    S.tu=tu;
    const tm=new THREE.MeshBasicNodeMaterial({transparent:true,depthTest:false,depthWrite:false,side:THREE.DoubleSide}); tm.fog=false; tm.toneMapped=false;
    tm.vertexNode=vec4(positionLocal.x.mul(2.0),positionLocal.y.mul(2.0),0.0,1.0);
    const ndc=positionLocal.xy.mul(2.0);
    const pr=T.cameraProjectionMatrixInverse.mul(vec4(ndc,1.0,1.0)), dv=pr.xyz.div(pr.w);
    const wd=normalize(T.cameraWorldMatrix.mul(vec4(dv,0.0)).xyz);
        const p=ndc.mul(vec2(tu.aspect,1.0)).mul(3.2), t=tu.ph;
    const c1=sin(p.x.mul(2.1).add(t).add(sin(p.y.mul(1.7).sub(t.mul(0.7))))), c2=sin(p.y.mul(2.6).sub(t.mul(0.8)).add(sin(p.x.mul(1.9).add(t.mul(0.5)))));
    const cau=float(1).sub(c1.mul(c2).abs()).pow(7.0).mul(float(1).sub(tu.low)).mul(float(1).sub(tu.depth.mul(0.8)));
    const shaft=sin(ndc.x.mul(7.0).add(sin(t.mul(0.3)).mul(2.0)).add(ndc.y.mul(1.5))).mul(0.5).add(0.5).pow(3.0).mul(ndc.y.mul(0.5).add(0.5)).mul(float(1).sub(tu.depth.mul(0.9)));
    tm.colorNode=mix(tu.col,vec3(0.55,0.9,1.0),cau.mul(0.30).add(shaft.mul(0.10)).min(0.5));
    tm.opacityNode=tu.wet.mul(float(0.34).add(tu.depth.mul(0.22)));
    S.tint=new THREE.Mesh(new THREE.PlaneGeometry(1,1),tm); S.tint.frustumCulled=false; S.tint.visible=false; S.tint.renderOrder=40; S.tint.name='dm-haz-tint';

    // bubble trail: pooled instances, nothing allocated while it runs
    S.bgeo=new THREE.IcosahedronGeometry(1,1);
    const bm=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false,depthTest:true}); bm.fog=false; bm.toneMapped=false;
    const bf=float(1).sub(dot(normalize(normalWorld),normalize(cameraPosition.sub(positionWorld))).abs()).pow(1.8);
    bm.colorNode=mix(vec3(0.55,0.85,1.0),vec3(1,1,1),bf); bm.opacityNode=bf.mul(0.75).add(0.07);
    S.bmat=bm; S.bub=new THREE.InstancedMesh(S.bgeo,bm,N_BUB); S.bub.frustumCulled=false; S.bub.visible=false; S.bub.renderOrder=61; S.bub.name='dm-haz-bubbles';
    S.bub.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    S.pos=new Float32Array(N_BUB*6);      // x y z age life size
    for(let i=0;i<N_BUB;i++){ S.pos[i*6+4]=0; const a=S.bub.instanceMatrix.array, o=i*16; a[o]=a[o+5]=a[o+10]=0; a[o+15]=1; }
    S.lastP=new THREE.Vector3(); S.fog=null;
    H.built=true; return true;
  }
  function attach(scene,renderer){
    if(!H.built&&!build()) return false;
    if(S.scene===scene&&S.r===renderer) return true;
    for(const m of [S.tint,S.bub]){ if(m.parent) m.parent.remove(m); scene.add(m); }
    S.scene=scene; S.r=renderer; S.ready=false; S.fogSaved=false;
    // compile both variants once, off the play path, so the first dive doesn't hitch
    try{
      if(renderer&&renderer.compileAsync&&PW&&PW.camera){
        for(const m of [S.tint,S.bub]) m.visible=true;
        const p=renderer.compileAsync(scene,PW.camera);
        const done=()=>{ for(const m of [S.tint,S.bub]) m.visible=false; S.ready=true; };
        p.then(done,done);
      } else S.ready=true;
    }catch(e){ S.ready=true; }
    return true;
  }
  // detach before the world's scene is disposed: our GPU objects outlive it and are reused by the next world
  H.close=function(scene){
    try{ restoreFog(); for(const m of [S.tint,S.bub]) if(m&&m.parent) m.parent.remove(m); }catch(e){}
    S.scene=null; S.r=null; H.wet=0; H.underwater=false; S.fogSaved=false;
    try{ H.shieldRelease(); DMHazard.clear(); _gid=_zid=0; H.hostile=false; H.awake=false; H.ready=true; exposureReset(); }catch(e){}   // the crown glow / LEDs leave the scene; every hazard source of the world goes; the clock resets
  };
  // out of the air (space) or switched off: hide, keep everything attached and compiled
  H.hide=function(){
    try{ restoreFog(); if(S.tint){ S.tint.visible=false; S.bub.visible=false; } }catch(e){}
    H.wet=0; H.underwater=false;
    try{ H.shieldHide(); }catch(e){}
    if(S.pos) for(let i=0;i<N_BUB;i++) S.pos[i*6+4]=0;
  };
  H.dispose=function(){ try{ H.shieldDispose(); H.close(); for(const o of [S.bgeo,S.tint&&S.tint.geometry]) o&&o.dispose(); for(const m of [S.tint&&S.tint.material,S.bmat]) m&&m.dispose(); }catch(e){} H.built=false; };

  /* ── underwater: drag, fog, bubbles ────────────────────────────── */
  // called right after _boardControls: same controls, water damping on top (per-frame multiplicative, like the air drag)
  H.waterDrag=function(s,dt){
    const W=window.JOTS_WATER; if(H.off||!W||!s||!s.vel||!s.pos) return 0;
    const wet=sm(0,1.6,(W.surfaceY||0)-s.pos.y); if(wet<=0) return 0;
    const f=Math.min(3,Math.max(0.2,(dt||1/60)*60));
    s.vel.multiplyScalar(Math.pow(0.935,f*wet));            // thick medium: top speed ~1/3, glides to a stop sooner
    s.vel.y*=Math.pow(0.965,f*wet);                          // no porpoising
    return wet;
  };
  function restoreFog(){
    const sc=S.scene; if(!sc||!S.fogSaved) return;
    if(S.fogWas&&sc.fog===S.fog){ sc.fog.color.setHex(S.fogCol); }
    else if(!S.fogWas&&sc.fog===S.fog) sc.fog=null;
    S.fogSaved=false;
  }
  function emit(x,y,z,size){
    const p=S.pos; let i=-1; for(let k=0;k<N_BUB;k++){ const j=(S.bn+k)%N_BUB; if(p[j*6+4]<=0){ i=j; break; } } if(i<0) return;
    S.bn=(i+1)%N_BUB; S.seed=(Math.imul(S.seed,1664525)+1013904223)>>>0; const r1=(S.seed>>>8)/16777216; S.seed=(Math.imul(S.seed,1664525)+1013904223)>>>0; const r2=(S.seed>>>8)/16777216; S.seed=(Math.imul(S.seed,1664525)+1013904223)>>>0; const r3=(S.seed>>>8)/16777216;
    const o=i*6; p[o]=x+(r1-0.5)*size*3; p[o+1]=y+(r2-0.5)*size*2; p[o+2]=z+(r3-0.5)*size*3; p[o+3]=0; p[o+4]=1.4+r1*1.2; p[o+5]=size*(0.5+r2);
  }
  function bubbles(dt,wet,cx,cy,cz,speed,len,surfY,dx,dz){
    const p=S.pos, arr=S.bub.instanceMatrix.array; let live=0;
    if(wet>0.4&&speed>len*0.15){ S.bt+=dt*Math.min(34,6+speed/len*5); while(S.bt>=1){ S.bt-=1; emit(cx-dx*len*0.45,cy,cz-dz*len*0.45,len*0.02); } } else S.bt=0;
    for(let i=0;i<N_BUB;i++){
      const o=i*6, m=i*16; let life=p[o+4];
      if(life>0){
        p[o+3]+=dt; if(p[o+3]>=life||p[o+1]>surfY){ p[o+4]=0; arr[m]=arr[m+5]=arr[m+10]=0; continue; }
        const a=p[o+3]/life; p[o+1]+=dt*len*(0.35+a*0.5); p[o]+=Math.sin(p[o+3]*5+i)*dt*len*0.05; p[o+2]+=Math.cos(p[o+3]*4.3+i*2)*dt*len*0.05;
        const s=p[o+5]*(a<0.12?a/0.12:1)*(1-sm(0.8,1,a)*0.6);
        arr[m]=arr[m+5]=arr[m+10]=s; arr[m+12]=p[o]; arr[m+13]=p[o+1]; arr[m+14]=p[o+2]; live++;
      }
    }
    S.bub.visible=live>0; if(live>0) S.bub.instanceMatrix.needsUpdate=true;
  }

  /* ═══════════════════════════════════════════════════════════════════
     DMHAZARD — hazard sources + a low-rate proximity sensor (foundation; real volcano / cave / facility hazards register here later).
       register(src)  src = { type:'atmosphere'|'plume'|'vent'|'cave'|'facility'|'space'|..., gas:'toxic'|'sulfur'|..., sev:0..1 (default 1),
                              shape:'sphere' {x,y,z,r} | 'column' {x,z,r,y0,y1} | 'global', warn: extra metres-ish margin where the warning starts (default 0.8 r),
                              id? }  -> id.   World space of the open world (PW.scene frame). unregister(id) · clear() (world close) · count().
       A world with no source registers nothing: no timer, no state, nothing ticks. The toxic atmosphere is one 'global' source (registered once per world open
       by the gate in DM_HAZ.tick, unregistered at close); a global source needs no sensor (always inside).
       SENSOR: ONE setInterval (~3 Hz), created when the first LOCAL (non-global) source is registered, cleared when the last one goes: reads her world position,
       the nearest signed distance to each source (d <= 0 inside, d <= warn near) -> state 'clear' | 'near' | 'inside'. Event `dmhazard` {state, near, type, gas, sev,
       dist} on change only. HZ.near is the single boolean the per-frame code reads (DM_HAZ.tick sleeps while nothing is near / armed).
       Glasses hook: DMHazard.glasses = {level 0..1, r, g, b} refreshed at the sensor rate (the AR-glasses atmosphere sensor / LED can read it; nothing drives their
       material here). (The old 'initialize protection shield?' prompt is gone: protection is automatic.)
       Flags: `?hazardzone=plume` registers a test plume column ~6 heights ahead of her at world open (radius 4 heights) - the only test source besides ?hazard=toxic.
     ═══════════════════════════════════════════════════════════════════ */
  const HZ={src:[],nextId:1,near:false,state:'clear',type:'',gas:'',sev:0,dist:1e9,gb:null,warnD:1,rad:1,globSev:0,glob:0,timer:0,hz:3,glasses:{level:0,r:1,g:0.72,b:0.1},ticks:0,onClear:null};
  function hazardDist(s,px,py,pz){   // signed distance to the source's edge (negative inside): pure
    if(s.shape==='global') return -1;
    if(s.shape==='column'){ const dx=px-s.x, dz=pz-s.z, h=Math.hypot(dx,dz)-s.r; const dy=py<s.y0?s.y0-py:py>s.y1?py-s.y1:0; return dy>0?Math.hypot(Math.max(h,0),dy):h; }
    return Math.hypot(px-s.x,py-s.y,pz-s.z)-s.r;
  }
  function hazardStep(d,warn){ return d<=0?'inside':d<=warn?'near':'clear'; }
  function hzSense(){
    HZ.ticks++;
    const root=typeof CHAR!=='undefined'&&CHAR?CHAR.root:null; if(!root||typeof PW==='undefined'||!PW.active){ hzSet('clear',null,1e9); return; }   // (CHAR is a script-scope binding, not a window property)
    const e=root.matrixWorld.elements, px=e[12], py=e[13]+0.9, pz=e[14];
    let best=null,bd=1e9,bst='clear',hh=1; try{ hh=(CHAR.rawHeight||1)*(Math.hypot(e[0],e[1],e[2])||1); }catch(x){}
    for(let i=0;i<HZ.src.length;i++){ const s=HZ.src[i]; if(s.shape==='global') continue;
      const d=hazardDist(s,px,py,pz), st=hazardStep(d,s.warn!=null?s.warn:s.r*0.8+hh*1.5);
      if(st!=='clear'&&(!best||d<bd)){ best=s; bd=d; bst=st; } }
    HZ.warnD=best?(best.warn!=null?best.warn:best.r*0.8+hh*1.5):1; HZ.rad=best?Math.max(1e-6,best.r):1;   // for the exposure maths (depth = how far inside)
    hzSet(best?bst:'clear',best,bd);
  }
  function hzSet(st,s,d){
    HZ.dist=d; const g=HZ.glasses; g.level=st==='inside'?1:st==='near'?0.55:0;
    if(st===HZ.state&&(!s||s.type===HZ.type)) return;
    HZ.state=st; HZ.near=st!=='clear'; HZ.type=s?s.type:''; HZ.gas=s?s.gas||'':''; HZ.sev=s?(s.sev==null?1:s.sev):0;
    try{ window.dispatchEvent(new CustomEvent('dmhazard',{detail:{state:st,near:HZ.near,type:HZ.type,gas:HZ.gas,sev:HZ.sev,dist:d}})); }catch(e){}
  }
  // the strongest GLOBAL source (the world's own air): its gas / severity feed the exposure clock without the sensor
  function globRefresh(){ let b=null; for(let i=0;i<HZ.src.length;i++){ const q=HZ.src[i]; if(q.shape==='global'&&(!b||(q.sev==null?1:q.sev)>(b.sev==null?1:b.sev))) b=q; } HZ.gb=b; HZ.globSev=b?(b.sev==null?1:b.sev):0; }
  function hzTimer(){
    let local=0; for(let i=0;i<HZ.src.length;i++) if(HZ.src[i].shape!=='global') local++;
    if(local&&!HZ.timer){ HZ.timer=setInterval(hzSense,Math.round(1000/HZ.hz)); }
    else if(!local&&HZ.timer){ clearInterval(HZ.timer); HZ.timer=0; hzSet('clear',null,1e9); }
  }
  const DMHazard={
    register(src){ if(!src||typeof src!=='object') return 0; const s=Object.assign({shape:'sphere',sev:1,r:1,x:0,y:0,z:0,type:'hazard',gas:''},src); s.id=s.id||('hz'+(HZ.nextId++));
      for(let i=0;i<HZ.src.length;i++) if(HZ.src[i].id===s.id){ if(HZ.src[i].shape==='global') HZ.glob--; HZ.src.splice(i--,1); }
      HZ.src.push(s); if(s.shape==='global') HZ.glob++; globRefresh(); hzTimer(); return s.id; },
    unregister(id){ for(let i=0;i<HZ.src.length;i++) if(HZ.src[i].id===id){ if(HZ.src[i].shape==='global') HZ.glob--; HZ.src.splice(i,1); globRefresh(); hzTimer(); return true; } return false; },
    clear(){ if(!HZ.src.length&&!HZ.timer) return; HZ.src.length=0; HZ.glob=0; globRefresh(); hzTimer(); },
    count(){ return HZ.src.length; }, get near(){ return HZ.near; }, get state(){ return HZ.state; }, get type(){ return HZ.type; }, get gas(){ return HZ.gas; }, get severity(){ return HZ.sev; },
    get distance(){ return HZ.dist; }, get glasses(){ return HZ.glasses; }, get global(){ return HZ.glob>0; }, get sensorOn(){ return !!HZ.timer; }, get ticks(){ return HZ.ticks; }, rateHz:HZ.hz,
    sense:hzSense, core:{hazardDist,hazardStep}
  };
  window.DMHazard=DMHazard; H.hazard=DMHazard;

  /* ═══════════════════════════════════════════════════════════════════
     EXPOSURE — how long she can stay in a hazard before she is too affected.  DATA-DRIVEN: tune HAZARD_TABLE, nothing else.
       key         the source's gas, else its type (HZ.gas / HZ.type), lower-cased; unknown keys use 'default'.
       label       what the HUD calls it.
       safeSec     seconds from a FULL reserve to empty while exposed at intensity 1.0 (the time readout is reserve x safeSec / intensity).
       recoverSec  seconds from EMPTY to full once she is completely clear (a refill is linear; leaving the near band recovers at half rate).
       warn        reserve fraction below which the LED / crown / HUD go amber (red at zero).
       hue         the band's accent for the HUD (css colour of the label dot).
     Intensity (0..1+) = source severity x (0.6 inside the edge .. 1.0 at the core): global sources (a world's whole air) are always the full 1.0 x sev.
       Near (inside the warn margin, not inside): no drain, a half-rate refill, the marker rises on the left half of the band.
       Inside: marker on the right half (0.5 at the edge, 1.0 at the core / in a global source).
     AT ZERO: the reserve stays at 0 while she is exposed; state 'exposed' = red LED + crown glow + HUD "OVEREXPOSED - LEAVE THE ZONE", one `dmhazardzero`
     window event per zero crossing {type, label}.  NO damage, NO game-over, no control change: that is a design decision for the lead (see docs/bubble-lod-notes.md).
     ═══════════════════════════════════════════════════════════════════ */
  const HAZARD_TABLE={
    toxic:    {label:'TOXIC ATMOSPHERE', safeSec:90,  recoverSec:45, warn:0.35, hue:'#35ff7e'},   // a thick non-breathable air (Mars, Venus, Titan ...): the reference rate
    airless:  {label:'NO ATMOSPHERE',    safeSec:240, recoverSec:60, warn:0.30, hue:'#9fc8ee'},   // vacuum: a long clock (the global source is severity 0.5, so ~480 s in practice)
    volcanic: {label:'VOLCANIC PLUME',   safeSec:50,  recoverSec:30, warn:0.40, hue:'#ff8a3a'},   // ash + gas column (?hazardzone=plume): short, burns fast
    sulfur:   {label:'SULFUR GAS',       safeSec:60,  recoverSec:40, warn:0.40, hue:'#e6d93a'},
    vent:     {label:'GAS VENT',         safeSec:75,  recoverSec:40, warn:0.35, hue:'#d0a0ff'},
    cave:     {label:'BAD AIR',          safeSec:120, recoverSec:60, warn:0.30, hue:'#a0c0a0'},
    facility: {label:'CONTAMINATION',    safeSec:100, recoverSec:50, warn:0.35, hue:'#ff6ad0'},
    plume:    {label:'HAZARD PLUME',     safeSec:60,  recoverSec:35, warn:0.40, hue:'#ff8a3a'},
    default:  {label:'HAZARD',           safeSec:90,  recoverSec:45, warn:0.35, hue:'#ffc233'}
  };
  function rowFor(gas,type){ const k=String(gas||'').toLowerCase(), t=String(type||'').toLowerCase(); return HAZARD_TABLE[k]||HAZARD_TABLE[t]||HAZARD_TABLE.default; }
  // pure: intensity at signed distance d from the source's edge (d <= 0 inside), r = its radius, sev 0..1 (undefined = 1), global = the world's own air
  function intensityOf(d,r,sev,isGlobal){
    const s=sev==null?1:sev; if(isGlobal) return s;
    if(!(d<=0)) return 0;
    const depth=Math.min(1,-d/Math.max(1e-6,r)); return s*(0.6+0.4*depth);
  }
  // pure: the HUD band marker 0..1: 0 = clear, 0.5 = at the edge of the zone, 1 = in the core / a global source.  d = signed distance, warn = width of the near band
  function markerOf(d,warn,r,isGlobal){
    if(isGlobal) return 1;
    if(d<=0) return 0.5+0.5*Math.min(1,-d/Math.max(1e-6,r));
    if(d>=warn) return 0;
    return 0.5*(1-d/Math.max(1e-6,warn));
  }
  // pure: one step of the reserve.  I = intensity (> 0 while inside), near = in the near band (no drain), dt seconds.  Returns the new reserve in [0, 1].
  function reserveStep(res,I,near,dt,row){
    if(I>0) return Math.max(0,res-dt*I/row.safeSec);
    const rate=1/row.recoverSec*(near?0.5:1); return Math.min(1,res+dt*rate);
  }
  // pure: seconds left at the current intensity (Infinity when not draining); refill seconds when clear
  function secondsLeft(res,I,row){ return I>0?res*row.safeSec/I:Infinity; }
  function secondsToFull(res,near,row){ return (1-res)*row.recoverSec*(near?2:1); }
  // pure: the colour state of the LED / crown / HUD.  prev for the amber hysteresis (leaves amber 0.08 above the warn fraction)
  function stateOf(prev,sensed,inside,res,warn){
    if(!sensed) return 'off';
    if(!inside) return 'alert';
    if(res<=0) return 'exposed';
    if(res<warn) return 'warn';
    if(prev==='warn'&&res<warn+0.08) return 'warn';
    return 'protected';
  }
  function fmtClock(sec){ if(!isFinite(sec)) return '--:--'; sec=Math.max(0,Math.round(sec)); const m=Math.floor(sec/60), s=sec%60; return (m<10?'0':'')+m+':'+(s<10?'0':'')+s; }
  // the live exposure record (one object, written in place)
  const EX={shelter:false,on:false,sensed:false,inside:false,near:false,I:0,marker:0,reserve:1,sec:Infinity,state:'off',key:'default',label:'',hue:'#ffc233',zero:false,warn:0.35,lastEmit:'',emitT:0,row:HAZARD_TABLE.default};
  // read the sensors into EX (no allocation): the strongest of the world's own air and the nearest local source
  function exposureRead(){
    let I=0,marker=0,inside=false,near=false,gas='',type='',isG=false;
    if(EX.shelter){ EX.I=0; EX.marker=0; EX.inside=EX.near=EX.sensed=false; return; }   // the pressurised bay: breathable, nothing is sensed
    if(HZ.glob>0&&HZ.gb){ I=HZ.globSev; marker=1; inside=true; isG=true; gas=HZ.gb.gas; type=HZ.gb.type; }
    if(HZ.near&&HZ.state!=='clear'){
      const d=HZ.dist, Il=intensityOf(d,HZ.rad,HZ.sev,false), ml=markerOf(d,HZ.warnD,HZ.rad,false);
      if(d<=0){ if(Il>=I){ I=Il; gas=HZ.gas; type=HZ.type; isG=false; } inside=true; marker=Math.max(marker,ml); }
      else if(!inside){ near=true; marker=Math.max(marker,ml); gas=HZ.gas; type=HZ.type; }
    }
    EX.I=I; EX.marker=marker; EX.inside=inside; EX.near=near&&!inside; EX.sensed=inside||near;
    if(EX.sensed){ const row=rowFor(gas,type); if(row!==EX.row){ EX.row=row; } EX.label=row.label; EX.hue=row.hue; EX.warn=row.warn; EX.key=String(gas||type||'default'); }
  }
  function exposureStep(dt){
    exposureRead();
    const row=EX.row, was=EX.reserve;
    EX.reserve=reserveStep(EX.reserve,EX.inside?EX.I:0,EX.near,dt,row);
    EX.sec=EX.inside?secondsLeft(EX.reserve,EX.I,row):Infinity;
    EX.state=stateOf(EX.state,EX.sensed,EX.inside,EX.reserve,EX.warn);
    const nz=EX.inside&&EX.reserve<=0; if(nz&&!EX.zero){ try{ window.dispatchEvent(new CustomEvent('dmhazardzero',{detail:{type:EX.key,label:EX.label}})); }catch(e){} } EX.zero=nz;
    if(!EX.sensed&&EX.reserve>=0.999) EX.reserve=1;   // refilled: snap, so the clock and the HUD end together
    EX.on=EX.sensed||EX.reserve<0.999;
    return was;
  }
  function exposureReset(){ EX.on=EX.sensed=EX.inside=EX.near=false; EX.I=0; EX.marker=0; EX.reserve=1; EX.sec=Infinity; EX.state='off'; EX.zero=false; EX.row=HAZARD_TABLE.default; emitHud(true); }
  // `dmhazardhud` for the HUD (ui/dm-hazardhud.js): on change, at most ~4 Hz, so the HUD needs no loop of its own
  function emitHud(force){
    if(!FLAG_HUD) return;
    const now=(typeof performance!=='undefined')?performance.now():0;
    const sig=(EX.on?1:0)+'|'+EX.state+'|'+EX.key+'|'+Math.round(EX.marker*40)+'|'+Math.round(EX.reserve*100)+'|'+(isFinite(EX.sec)?Math.round(EX.sec):'i');
    if(!force&&(sig===EX.lastEmit||now-EX.emitT<250)) return;
    EX.lastEmit=sig; EX.emitT=now;
    try{ window.dispatchEvent(new CustomEvent('dmhazardhud',{detail:{on:EX.on,sensed:EX.sensed,state:EX.state,type:EX.key,label:EX.label,hue:EX.hue,marker:EX.marker,reserve:EX.reserve,
      intensity:EX.I,sec:EX.sec,refill:EX.sensed?0:secondsToFull(EX.reserve,false,EX.row),zero:EX.zero,warn:EX.warn}})); }catch(e){}
  }
  H.exposure=EX; H.table=HAZARD_TABLE;
  const FLAG_HUD=!/[?&]hazardhud=0\b/.test((window.location&&window.location.search)||'');
  H.core={HAZARD_TABLE,rowFor,intensityOf,markerOf,reserveStep,secondsLeft,secondsToFull,stateOf,fmtClock,sm};

  /* ═══════════════════════════════════════════════════════════════════
     DMSHIELD — the protection state on her Skyboard set and on her (no orb, no toggle, no button: it is automatic).
       ACTIVE whenever a hazard is sensed at her (the world's toxic / airless air, or inside / near a local source), whether the board is parked or not:
         board     contour glow on the staff CROWN (an inverted-hull shell hugging the crown's own silhouette) + a lighthouse-style LED housing on top
         her       a small LED on her chest (parented to the charm's chest rig, so it follows every animation); third person and the orbit camera see it
         first person  her body + the board are hidden: a faint, short-range light at her head (a FIXED pooled natural light, no shadow, no recompile) tints
                   whatever is within a few feet of her eyes (and her arms / hands once the first-person rig shows them).
       Status colour (DM_HAZ.exposure.state): GREEN protected (reserve above the table's warn fraction) / AMBER below it / RED at zero (overexposed) /
       AMBER pulsing = a local hazard is NEAR, she is not inside it.  Safe air (breathable worlds: Earth, Solenne + the mansion, habitable seeds): DMShield.available
       is false, nothing is built, shown or drawn.
     Flags: `?shield=0` no LED / crown / first-person light at all (the HUD band + the exposure clock are unaffected, `?hazardhud=0` hides the HUD) ·
            `?hazard=toxic|airless|safe` force the air kind · `?hazardzone=plume` a test plume ahead of her · `?ledfp=<gain>` first-person light gain (default 1, 0 = off).
     Cost: 1-2 draws of the crown's own (few hundred tri) geometry, 3 tiny LED meshes (+ the chest LED, same materials), one DMVLight point (Med+, shed by
     DMBudget 'light' >= 2), one pooled light in first person.
     ═══════════════════════════════════════════════════════════════════ */
  const SHQ=(()=>{ try{ return new URLSearchParams(window.location.search); }catch(e){ return null; } })();
  const SH_OFF=!!(SHQ&&SHQ.get('shield')==='0');
  const FP_GAIN=(()=>{ const v=SHQ?parseFloat(SHQ.get('ledfp')):NaN; return v>=0&&v<20?v:1; })();
  try{ if(window.localStorage) window.localStorage.removeItem('dm_shield_orb'); }catch(e){}   // the old orb toggle's remembered choice: gone with the orb
  const SH_COL={protected:[0.16,1.0,0.46],warn:[1.0,0.76,0.18],exposed:[1.0,0.18,0.14],alert:[1.0,0.68,0.08]};
  // what the glow may cost: tier ('low' = cheapest) x DMBudget 'light' level -> hull shells (0-2), the fake point light, the LED
  function shieldPlan(low,lvl){
    lvl=lvl|0; const hulls=lvl>=3?0:(low||lvl>=2)?1:2;
    return {hulls,point:!low&&lvl<2,led:true,pulse:lvl<3};
  }
  // which meshes are the staff crown: 'staff head*' pieces first (template C), then the arrowhead / ornament shards (A / B, 'ornament' base part;
  // not the Ariel board, whose arrowhead is the nose), then the staff itself. items: [{name, base}] -> indices
  function pickCrown(items,arielBoard){
    const idx=[],pick=re=>{ for(let i=0;i<items.length;i++){ const n=String(items[i].name||'').toLowerCase(), b=String(items[i].base||'').toLowerCase(); if(re.test(n)||re.test(b)) idx.push(i); } return idx.length>0; };
    if(pick(/staff head|crown/)) return idx;
    if(!arielBoard&&pick(/ornament|arrowhead/)) return idx;
    pick(/^staff$/); return idx;
  }
  // the first-person head light: intensity / range from her height h (world units) and the state's colour; subtle by design (a few feet, faint)
  const FP_I=0.05, FP_R=0.9;
  function fpLightParams(h,level,gain){ const g=gain==null?1:gain; return {range:h*FP_R,intensity:Math.max(0,FP_I*h*h*Math.min(1,level)*g)}; }
  const SH={state:'off',a:0,frames:0,ph:0,u:null,mats:null,hulls:null,led:null,ledGeo:null,scene:null,board:null,ledLoc:null,ledR:0.02,kT:0.05,
            vlOn:false,warm:0,warmAt:0,sig:'',crownN:0,lastEmit:'',busy:false,col:null,body:null,bodyRig:null,bodyH:0,fpLid:null,fpState:'',fpV:null};
  const SHD={shieldPlan,pickCrown,fpLightParams,COL:SH_COL,FP_I,FP_R};
  function shEmit(){
    const sig=SH.state; if(sig===SH.lastEmit) return; SH.lastEmit=sig;
    try{ window.dispatchEvent(new CustomEvent('dmshield',{detail:{available:SH.state!=='off',state:SH.state,status:SH.state}})); }catch(e){}
  }
  const DMShield={
    get available(){ return SH.state!=='off'&&!SH_OFF; }, get active(){ return SH.state==='protected'||SH.state==='warn'||SH.state==='exposed'; },
    get state(){ return SH.state; }, get status(){ return SH.state; }, get protected(){ return SH.state==='protected'||SH.state==='warn'; },
    get exposure(){ return EX; }, core:SHD,
    get stats(){ return {frames:SH.frames,built:!!SH.hulls,gpu:!!SH.mats,awake:H.awake===true,body:!!SH.body,fpLight:SH.fpLid!=null}; }
  };
  window.DMShield=DMShield; H.shield=DMShield;
  function shGpu(){
    if(SH.mats) return true; const T=window.THREE&&THREE.TSL; if(!T||!THREE.MeshBasicNodeMaterial) return false;
    const {uniform,positionLocal,normalLocal,modelScale}=T;
    const u={col:uniform(new THREE.Color(0x29ff75)),a:uniform(0),t:uniform(0.01)};
    const hull=(f,op)=>{ const m=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false,depthTest:true,side:THREE.BackSide}); m.fog=false; m.toneMapped=false; m.blending=THREE.AdditiveBlending;
      m.positionNode=positionLocal.add(normalLocal.mul(u.t.mul(f).div(modelScale.x.max(1e-4)))); m.colorNode=u.col; m.opacityNode=u.a.mul(op); return m; };
    const led=new THREE.MeshBasicNodeMaterial({transparent:false}); led.fog=false; led.toneMapped=false; led.colorNode=u.col.mul(u.a.mul(1.6).add(0.18));
    const dark=new THREE.MeshBasicNodeMaterial({color:0x1d2128}); dark.fog=false;
    SH.u=u; SH.mats={in:hull(1,0.9),out:hull(2.6,0.26),led,dark}; return true;
  }
  function ledGeo(){ return SH.ledGeo||(SH.ledGeo={cas:new THREE.CylinderGeometry(1,1.18,1,10),dome:new THREE.SphereGeometry(1,10,8)}); }
  function bodyTear(){ if(SH.body){ try{ if(SH.body.parent) SH.body.parent.remove(SH.body); }catch(e){} } SH.body=null; SH.bodyRig=null; }
  function shTear(){   // remove our meshes from the scene (the board's own objects are never touched; the crown geometry is the board's, never disposed here)
    if(SH.hulls){ for(const h of SH.hulls){ if(h.parent) h.parent.remove(h); } SH.hulls.length=0; } if(SH.led&&SH.led.parent) SH.led.parent.remove(SH.led);
    SH.board=null; SH.sig=''; SH.crownN=0; SH.warm=0; SH.led=null;
    bodyTear(); fpOff();
    if(SH.vlOn){ try{ window.DMVLight&&DMVLight.clear('shield'); }catch(e){} SH.vlOn=false; }
  }
  function shBuild(board,scene){
    shTear(); if(!shGpu()) return false; SH.hulls=[]; SH.col=SH.col||[1,0.68,0.08];
    const items=[],ms=[]; board.traverse(o=>{ if(o.isMesh&&o.geometry&&!(o.userData&&o.userData.dmShield)){ ms.push(o); items.push({name:o.name,base:o.userData&&o.userData.basePart}); } });
    const ix=pickCrown(items,!!(board.userData&&board.userData.arielBoard));
    board.updateWorldMatrix(true,true);
    const inv=new THREE.Matrix4().copy(board.matrixWorld).invert(), bx=new THREE.Box3(), tmp=new THREE.Box3(), m4=new THREE.Matrix4();
    for(const i of ix){ const o=ms[i]; if(!o.geometry.boundingBox) o.geometry.computeBoundingBox(); tmp.copy(o.geometry.boundingBox).applyMatrix4(m4.multiplyMatrices(inv,o.matrixWorld)); bx.union(tmp);
      for(const mat of [SH.mats.in,SH.mats.out]){ const h=new THREE.Mesh(o.geometry,mat); h.userData.dmShield=true; h.userData.src=o; h.frustumCulled=false; h.matrixAutoUpdate=false; h.visible=false; h.renderOrder=62; h.raycast=()=>{}; h.castShadow=false; h.receiveShadow=false; h.name='dm-shield-crown'; h.userData.out=(mat===SH.mats.out); scene.add(h); SH.hulls.push(h); } }
    let top,cx,cz,span;
    if(!bx.isEmpty()){ top=bx.max.y; cx=(bx.min.x+bx.max.x)/2; cz=(bx.min.z+bx.max.z)/2; span=Math.max(bx.max.x-bx.min.x,bx.max.z-bx.min.z,bx.max.y-bx.min.y); }
    else { const a=board.userData&&board.userData.deckAnchor||{x:0,y:0,z:0.1}; cx=a.x; cz=a.z; top=a.y+0.35; span=0.2; }   // no crown found: a short mast over the deck
    const r=Math.min(0.06,Math.max(0.018,span*0.14)); SH.ledR=r; SH.kT=Math.min(0.05,Math.max(0.012,span*0.05));   // board-local units
    const gg=ledGeo(), g=new THREE.Group(); g.name='dm-shield-led'; g.userData.dmShield=true; g.matrixAutoUpdate=false; g.visible=false;
    const cas=new THREE.Mesh(gg.cas,SH.mats.dark), dome=new THREE.Mesh(gg.dome,SH.mats.led);
    cas.scale.set(r,r*1.3,r); cas.position.y=r*0.65; dome.scale.set(r*0.82,r*0.82,r*0.82); dome.position.y=r*1.3+r*0.5;
    for(const o of [cas,dome]){ o.frustumCulled=false; o.raycast=()=>{}; o.userData.dmShield=true; o.renderOrder=63; g.add(o); }
    SH.led=g; scene.add(g); SH.ledLoc=new THREE.Vector3(cx,top+r*0.15,cz); SH.board=board; SH.scene=scene; SH.crownN=ix.length; SH.sig='b';
    return true;
  }
  // her chest LED: a child of the charm's chest rig (axes right / up / forward, world-unit scale), left of the charm, standing out of the chest.  Same materials as the board LED.
  function bodyBuild(h){
    const cm=window.DMCharm, rig=cm&&cm.built&&cm.rig; if(!rig||!SH.mats||!(h>0)) return false;
    if(SH.body&&SH.bodyRig===rig&&Math.abs(SH.bodyH-h)<h*0.02) return true;
    bodyTear(); const r=h*0.011, gg=ledGeo(), g=new THREE.Group(); g.name='dm-shield-body-led'; g.userData.dmShield=true; g.visible=false;
    const cas=new THREE.Mesh(gg.cas,SH.mats.dark), dome=new THREE.Mesh(gg.dome,SH.mats.led);
    cas.rotation.x=Math.PI/2; cas.scale.set(r,r*0.7,r); cas.position.z=r*0.35; dome.scale.set(r*0.8,r*0.8,r*0.8); dome.position.z=r*0.9;
    for(const o of [cas,dome]){ o.frustumCulled=false; o.raycast=()=>{}; o.castShadow=false; o.receiveShadow=false; o.userData.dmShield=true; o.renderOrder=63; g.add(o); }
    g.position.set(-0.075*h,0.012*h,0.006*h); rig.add(g); SH.body=g; SH.bodyRig=rig; SH.bodyH=h; return true;
  }
  // first person: the pooled natural light (index.html DMNatLights) - released the moment it is not needed; colour follows the state (a request keeps its colour)
  function fpOff(){ if(SH.fpLid!=null){ try{ window.DMNatLights&&DMNatLights.release(SH.fpLid); }catch(e){} SH.fpLid=null; SH.fpState=''; } }
  function fpLight(on,g,st,level){
    const NL=window.DMNatLights; if(!on||!NL||!NL.set||FP_GAIN<=0||!PW.camera){ fpOff(); return; }
    if(!SH.fpV) SH.fpV=new THREE.Vector3();
    const p=fpLightParams(g.h,level,FP_GAIN); SH.fpV.copy(PW.camera.position); SH.fpV.y-=g.h*0.04;
    if(SH.fpLid!=null&&SH.fpState!==st) fpOff();
    if(SH.fpLid==null){ const c=SH_COL[st]||SH_COL.protected; SH.fpLid=NL.request(SH.fpV,new THREE.Color(c[0],c[1],c[2]),p.intensity,p.range); SH.fpState=st; }
    else NL.set(SH.fpLid,SH.fpV,p.intensity);
  }
  // compile the crown / LED pipelines (forced visible a long way under the world, alpha 0): a promise that always resolves (capped)
  function shWarm(scene){
    return new Promise(res=>{
      const r=PW.renderer||(typeof flightRenderer!=='undefined'?flightRenderer:null);
      if(!r||!r.compileAsync||!PW.camera||!SH.led||!SH.hulls){ res(); return; }
      SH.warmAt=performance.now(); const tok=SH.warm=(SH.warm|0)+1||1, far=new THREE.Matrix4().makeTranslation(0,-1e7,0);
      SH.u.a.value=0; for(const h of SH.hulls){ h.matrix.copy(far); h.matrixWorldNeedsUpdate=true; h.visible=true; } SH.led.matrix.copy(far); SH.led.matrixWorldNeedsUpdate=true; SH.led.visible=true;
      let fin=false; const done=()=>{ if(fin) return; fin=true; if(SH.warm===tok) SH.warm=0; if(SH.hulls) for(const h of SH.hulls) h.visible=false; if(SH.led) SH.led.visible=false; res(); };
      try{ r.compileAsync(scene,PW.camera).then(done,done); }catch(e){ done(); }
      setTimeout(done,6000);
    });
  }
  let _M=null,_V=null,_vl=null; const _vo={level:1,gain:1};
  function fpHidden(){ try{ return typeof _surfFpHidden!=='undefined'&&_surfFpHidden===true; }catch(e){ return false; } }
  function shFrame(dt,g,mode){
    SH.frames++;
    const board=PW.board, bay=bayLevel();
    const st=(!SH_OFF&&EX.sensed&&bay<0.5&&(mode==='fly'||mode==='walk'))?EX.state:'off';
    if(st!==SH.state){ SH.state=st; shEmit(); }
    const want=st!=='off';
    SH.a+=((want?1:0)-SH.a)*(1-Math.exp(-(want?4:7)*dt));
    if(SH.a<0.01&&!want){ SH.a=0; shOff(); return; }
    if(!_M){ _M=new THREE.Matrix4(); _V=new THREE.Vector3(); _vl=new Float32Array(7); }
    const low=lowTier(), B=window.DMBudget&&DMBudget.on?DMBudget:null, plan=shieldPlan(low,B?B.lvl('light'):0);
    SH.ph+=dt; const c=SH_COL[st==='off'?'protected':st], k=1-Math.exp(-6*dt);
    if(!SH.col) SH.col=[1,0.68,0.08]; for(let i=0;i<3;i++) SH.col[i]+=(c[i]-SH.col[i])*k;
    const fast=st==='protected'?2.2:st==='warn'?5.5:st==='alert'?4:8;
    const pulse=plan.pulse?(st==='protected'?0.86+0.14*Math.sin(SH.ph*fast):0.7+0.3*Math.sin(SH.ph*fast)):1;
    if(!shGpu()) return; { const u=SH.u; u.col.value.setRGB(SH.col[0],SH.col[1],SH.col[2]); u.a.value=SH.a*pulse; }
    // ── the board's crown glow + LED (built and compiled at world load; this is only the lazy fallback)
    let ledVis=false;
    if(board){
      if(SH.board!==board||SH.scene!==PW.scene){ if(!shBuild(board,PW.scene)) return; shWarm(PW.scene); }
      if(SH.warm&&performance.now()-SH.warmAt>=4000) SH.warm=0;
      if(!SH.warm){
        const be=(board.updateWorldMatrix(true,false),board.matrixWorld.elements), bs=Math.hypot(be[0],be[1],be[2])||1, hullOn=st!=='alert'&&board.visible!==false;
        SH.u.t.value=SH.kT*bs;
        for(const h of SH.hulls){ const src=h.userData.src, vis=hullOn&&!!src&&plan.hulls>(h.userData.out?1:0)&&src.visible!==false;
          h.visible=vis; if(vis){ src.updateWorldMatrix(true,false); h.matrix.copy(src.matrixWorld); h.matrixWorldNeedsUpdate=true; } }
        const L=SH.led; ledVis=plan.led&&board.visible!==false; L.visible=ledVis; if(ledVis){ _M.makeTranslation(SH.ledLoc.x,SH.ledLoc.y,SH.ledLoc.z); L.matrix.multiplyMatrices(board.matrixWorld,_M); L.matrixWorldNeedsUpdate=true; }
        // the fake point light (fog / mist in-scatter, ui/dm-vlight.js): the LED's colour at the LED, shed by tier and DMBudget
        const VL=window.DMVLight;
        if(ledVis&&VL&&VL.on&&plan.point){ _V.copy(SH.ledLoc).applyMatrix4(board.matrixWorld); const rg=g.h*2.6, I=46*SH.a*pulse;
          _vl[0]=_V.x; _vl[1]=_V.y; _vl[2]=_V.z; _vl[3]=SH.col[0]*I; _vl[4]=SH.col[1]*I; _vl[5]=SH.col[2]*I; _vl[6]=rg; VL.setPoints('shield',_vl,_vo); SH.vlOn=true; }
        else if(SH.vlOn){ try{ VL.clear('shield'); }catch(e){} SH.vlOn=false; }
      }
    }
    // ── her chest LED (third person / orbit camera; hidden with her body in first person) and the first-person head light
    const fp=fpHidden(), root=typeof CHAR!=='undefined'&&CHAR?CHAR.root:null;
    if(!fp&&root&&root.visible!==false&&bodyBuild(g.h))SH.body.visible=true;
    else if(SH.body) SH.body.visible=false;
    fpLight(fp&&want,g,st,SH.a*pulse);
  }
  function shOff(){   // nothing of the protection is drawn (hidden = not in any render list); the meshes stay built for the next time
    if(SH.warm||!SH.hulls) { fpOff(); return; }
    if(SH.a!==0) SH.a=0;
    for(const h of SH.hulls) if(h.visible) h.visible=false;
    if(SH.led&&SH.led.visible) SH.led.visible=false;
    if(SH.body&&SH.body.visible) SH.body.visible=false;
    fpOff();
    if(SH.vlOn){ try{ window.DMVLight&&DMVLight.clear('shield'); }catch(e){} SH.vlOn=false; }
  }
  H.shieldHide=function(){ if(SH.state!=='off'){ SH.state='off'; shEmit(); } shOff(); };
  H.shieldRelease=function(){ if(SH.hulls||SH.led||SH.body) shTear(); SH.scene=null; SH.a=0; SH.hulls=null; if(SH.state!=='off'){ SH.state='off'; shEmit(); } };
  H.shieldDispose=function(){ if(SH.hulls||SH.led||SH.body) shTear(); try{ if(SH.mats) for(const k in SH.mats) SH.mats[k].dispose(); if(SH.ledGeo){ SH.ledGeo.cas.dispose(); SH.ledGeo.dome.dispose(); } }catch(e){} SH.mats=null; SH.ledGeo=null; SH.u=null; };

  /* ── per-frame ─────────────────────────────────────────────────── */
  const _c={x:0,y:0,z:0,len:1,ok:false,px:0,py:0,pz:0,h:1};
  // her (+ the board's) centre, her height in world units, and the board length (the dive's bubble trail uses them)
  function groupSphere(mode){
    const root=CHAR&&CHAR.root; _c.ok=false; if(!root) return _c;
    root.updateWorldMatrix(true,false); const e=root.matrixWorld.elements;
    const sc=Math.hypot(e[0],e[1],e[2])||1, h=(CHAR.rawHeight||1)*sc;      // her real height in world units
    let mx=e[12], my=e[13]+h*0.5, mz=e[14], len=h*1.3; _c.px=e[12]; _c.py=e[13]+h*0.5; _c.pz=e[14]; _c.h=h;
    const b=mode==='fly'?atmoBoard:(surfBoard&&surfBoard.visible!==false&&surfBoard.parent&&CHAR.mounted?surfBoard:null);
    if(b){ b.updateWorldMatrix(true,false); const be=b.matrixWorld.elements; len=(typeof _lcBoardLen==='function'?_lcBoardLen(b):0)||len; mx=(mx+be[12])*0.5; my=(my+be[13])*0.5; mz=(mz+be[14])*0.5; }
    _c.x=mx; _c.y=my; _c.z=mz; _c.len=len; _c.ok=true; return _c;
  }
  let hx=0,hz=1,lastX=0,lastY=0,lastZ=0,haveLast=false,spd=0,tPh2=0;
  // ── the world gate: evaluated ONCE per world open / atmosphere change (the body or its palette object changes), never per frame ──
  let _gb=null,_gp=null,_gk='breathable',_gid=0,_zid=0;
  H.hostile=false; H.awake=false;
  function gateWorld(){
    _gb=PW.body; _gp=PW.pal; _gk=H.kind(_gb,_gp); H.hostile=_gk!=='breathable';
    if(_gid){ DMHazard.unregister(_gid); _gid=0; }
    if(_zid){ DMHazard.unregister(_zid); _zid=0; }
    if(H.hostile) _gid=DMHazard.register({id:'atmosphere',type:'atmosphere',gas:_gk,sev:_gk==='toxic'?1:0.5,shape:'global'});   // the toxic atmosphere is simply a global source
    if(ZONE_FLAG&&PW.active) _zid=zoneTest();
  }
  // ?hazardzone=plume: one test plume column ahead of her (radius 4 heights, 6 heights away along +X of the world)
  const ZONE_FLAG=(()=>{ try{ return new URLSearchParams(window.location.search).get('hazardzone')||''; }catch(e){ return ''; } })();
  function zoneTest(){
    const root=typeof CHAR!=='undefined'&&CHAR?CHAR.root:null; if(!root||!CHAR.rawHeight) return 0; root.updateWorldMatrix(true,false); const e=root.matrixWorld.elements, h=CHAR.rawHeight*(Math.hypot(e[0],e[1],e[2])||1);
    return DMHazard.register({id:'test-plume',type:'plume',gas:'volcanic',sev:0.8,shape:'column',x:e[12]+6*h,z:e[14],r:4*h,y0:e[13]-8*h,y1:e[13]+40*h});
  }
  H.gate=gateWorld;
  // WORLD LOAD: build + compile everything hazard-related while the loader is up (index.html _pwOpen calls this after the world's staged compile), so on a hostile world the
  // protection appears in ONE step with the world (nothing half-built shows, no pipeline compiles in play).  Safe worlds: instant, builds nothing.  Never rejects.
  H.prewarm=async function(){
    try{
      if(H.off||typeof PW==='undefined'||!PW.active||!PW.scene) return;
      gateWorld();
      if(!H.hostile||SH_OFF){ H.ready=true; return; }
      H.ready=false;
      if(shGpu()&&PW.board&&PW.scene){ if(shBuild(PW.board,PW.scene)) await shWarm(PW.scene); }
    }catch(e){ try{ console.warn('[hazard] prewarm',e&&e.message); }catch(_){} }
    finally{ H.ready=true; }
  };
  H.tick=function(dt){
    if(H.off||typeof PW==='undefined'||!PW.active||!PW.scene||!PW.camera) { if(H.awake){ H.awake=false; H.shieldHide(); } if(H.wet>0||S.fogSaved) H.hide(); return; }
    if(!H.ready) return;   // a hostile world's protection is still loading: nothing of it runs or shows until it is ready (then it switches on in one step)
    if(PW.body!==_gb||PW.pal!==_gp) gateWorld();
    if(ZONE_FLAG&&!_zid) _zid=zoneTest();   // (test flag only) retried until she exists in the world
    const mode=PW.mode, W=window.JOTS_WATER;
    if(mode!=='fly'&&mode!=='walk'){ if(H.awake){ H.awake=false; H.shieldHide(); } if(H.wet>0||S.fogSaved||(S.tint&&S.tint.visible)) H.hide(); haveLast=false; return; }
    // SAFE MAP, nothing near, nothing left to recover, no dive: this whole feature sleeps here (one boolean test per frame; no exposure, no mesh, no material, no light)
    const wake=H.hostile||HZ.near||EX.on, dive=!!(W&&mode==='fly'&&PW.board&&PW.board.position.y<(W.surfaceY||0)+40)||H.wet>0.01||S.fogSaved;
    if(!wake&&!dive){ if(H.awake){ H.awake=false; H.shieldHide(); if(S.scene&&S.tint&&S.tint.visible) H.hide(); haveLast=false; emitHud(true); } return; }
    H.awake=true; dt=Math.min(0.1,Math.max(0.001,dt||1/60));
    const g=groupSphere(mode);
    // exposure clock + the protection state / glow (hostile air, a local source near / inside, or still recovering)
    if(wake){
      EX.shelter=bayLevel()>=0.5;   // the pressurised bay: breathable inside, nothing is sensed
      exposureStep(dt); emitHud(false);
      if(g.ok&&!SH_OFF){ try{ shFrame(dt,g,mode); }catch(e){ if(!SH.busy){ SH.busy=true; console.warn('[shield]',e&&e.stack||e); } shOff(); } } else shOff();
    }
    // ── the dive: only where a dive can happen (a board below JOTS_WATER's surface); the underwater GPU objects are built on the first one
    if(!dive||!(W&&mode==='fly')){ if(S.scene&&(S.tint.visible||S.bub.visible||S.fogSaved)){ H.wet=ease(H.wet,0,8,dt); H.hide(); } haveLast=false; return; }
    if(!attach(PW.scene,PW.renderer||(typeof flightRenderer!=='undefined'?flightRenderer:null))) return;
    if(!S.ready||!g.ok){ haveLast=false; return; }
    const cam=PW.camera;
    // her speed (world units/s) - for the bubble trail
    if(haveLast){ const dx=g.x-lastX, dy=g.y-lastY, dz=g.z-lastZ, dl=Math.sqrt(dx*dx+dy*dy+dz*dz); spd=ease(spd,dl/dt,6,dt); if(dl>1e-5){ hx=ease(hx,dx/dl,8,dt); hz=ease(hz,dz/dl,8,dt); } }
    lastX=g.x; lastY=g.y; lastZ=g.z; haveLast=true;
    const surfY=W?(W.surfaceY||0):0;
    // wet board: flying (not walking/swimming) with the board centre below the surface
    const dep=surfY-g.y, wet=sm(0.3,2.2,dep);
    H.wet=ease(H.wet,wet,8,dt); H.underwater=H.wet>0.05;
    const camWet=sm(0,1.5,surfY-cam.position.y);
    // underwater look: fog + tint + caustics
    const tw=camWet*Math.min(1,H.wet*3);
    const tintOn=tw>0.01;
    S.tint.visible=tintOn;
    if(tintOn){
      const tu=S.tu; tPh2+=dt; tu.wet.value=tw; tu.ph.value=tPh2*0.8;
      tu.depth.value=sm(0,60,surfY-cam.position.y);
      tu.aspect.value=(window.innerWidth||1)/Math.max(1,window.innerHeight||1);
      const lc=PW.pal&&PW.pal.liquidColor!==undefined?PW.pal.liquidColor:0x1a4a7a; tu.col.value.setHex(lc).multiplyScalar(0.55);
      // fog (set after _pwWorldTick's own near/far): murky water, restored on surfacing
      const sc=PW.scene;
      if(!S.fogSaved){ S.fog=sc.fog||null; S.fogWas=!!sc.fog; if(!sc.fog) sc.fog=(S.fogObj||(S.fogObj=new THREE.Fog(0x0b3a5c,1,1000))); S.fog=sc.fog; S.fogCol=sc.fog.color.getHex(); S.fogSaved=true; }
      if(sc.fog&&sc.fog===S.fog){ sc.fog.color.copy(tu.col.value); sc.fog.near=1; sc.fog.far=sc.fog.far+(Math.max(40,260-tu.depth.value*140)-sc.fog.far)*tw; }
    } else if(S.fogSaved) restoreFog();
    // bubbles
    if(H.wet>0.02||S.bub.visible) bubbles(dt,H.wet,g.x,g.y-g.h*0.1,g.z,spd,g.len,surfY,hx,hz);
  };
  H.setOff=function(v){ H.off=!!v; if(H.off) H.hide(); };
})();
