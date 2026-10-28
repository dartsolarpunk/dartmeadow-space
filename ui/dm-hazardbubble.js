/* ═══════════════════════════════════════════════════════════════════
   HAZARD BUBBLE — per-body habitability, the green "toxic air" orb, and
   underwater skyboard flight with its blue mist orb.

   habitable   DM_HAZ.habitable(body) → bool, cached on body.habitable.
               Earth + Ariel's home planet (Solenne) true; Mars, Titan, Moon,
               Mercury, Venus, Pluto and every other Sol body false; seeded
               planets are chosen from their OWN derived stream
               (hash('hab:'+mcSeed), type-biased) — the terrain/seed RNG
               streams are never touched, so every existing seed builds the
               identical world. An explicit body.habitable boolean wins.
   green orb   Ariel's group (character + board; hair and cloth ride the
               character root) inside a non-breathable atmosphere: a soft
               translucent green sphere fades in, mist swirling inside, a
               fresnel rim. Airless worlds get a fainter one. Dissolves in the
               pressurised Titan bay (event 'dm:bay' / DM_FAC.bay).
   blue orb    Riding the board below JOTS_WATER's surface: a blue mist orb,
               the same controls with water drag/damping (waterDrag), a
               bubble trail, and fog + a caustic tint outside the orb.
               Off the board, swimming is untouched (this never runs in it).
   Cost: 2 sphere draws (≈ 200 tris), one 3-5 sample chord march per pixel
   (mobile: 3, and no tint caustics), one full-screen tint only while
   diving, 28 instanced bubbles. Nothing is created per frame.
   ═══════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  const H={a:0,blue:0,wet:0,dis:0,inten:1,R:1,underwater:false,off:false,built:false,failed:false,_mode:null};
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
  H.kind=function(b,pal){ if(H.habitable(b)) return 'breathable'; return (pal?pal.atmos:b&&b.mcHasAtm)?'toxic':'airless'; };

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

  /* ── GPU objects (built once, reused across worlds) ────────────── */
  const S={ r:null, scene:null, front:null, back:null, tint:null, bub:null, u:null, tu:null, geo:null, bgeo:null, bmat:null,
            pos:null, bn:12, bt:0, seed:1, lastP:null, ready:false, fog:null, fogSaved:false, fogCol:0, boost:0 };
  const N_BUB=28;

  function build(){
    const T=window.THREE&&THREE.TSL; if(!T||!THREE.MeshBasicNodeMaterial){ H.failed=true; return false; }
    const {float,vec2,vec3,vec4,sin,cos,dot,normalize,mix,smoothstep,positionWorld,normalWorld,cameraPosition,positionLocal,uniform}=T;
    const low=lowTier(), NS=low?3:5;
    const u={c:uniform(new THREE.Vector3()),R:uniform(1),a:uniform(0),dis:uniform(0),ph:uniform(0),k:uniform(1),blue:uniform(0)};
    S.u=u;
    const gA=new THREE.Color(0x3dff8a), gB=new THREE.Color(0xc8ffb0), bA=new THREE.Color(0x2f8fff), bB=new THREE.Color(0xa6e6ff);
    const colA=mix(vec3(gA.r,gA.g,gA.b),vec3(bA.r,bA.g,bA.b),u.blue), colB=mix(vec3(gB.r,gB.g,gB.b),vec3(bB.r,bB.g,bB.b),u.blue);
    function orbMat(side){
      const m=new THREE.MeshBasicNodeMaterial({transparent:true,depthTest:true,depthWrite:false,side});
      m.fog=false; m.toneMapped=false;
      // analytic chord of this pixel's ray through the sphere (the camera may be inside it)
      const D=normalize(positionWorld.sub(cameraPosition)), L=u.c.sub(cameraPosition), tca=dot(L,D);
      const d2=dot(L,L).sub(tca.mul(tca)), h=u.R.mul(u.R).sub(d2).max(0.0).sqrt();
      const ta=tca.sub(h).max(0.0), tb=tca.add(h).max(ta), chord=tb.sub(ta);
      let acc=float(0), n0=float(0);
      for(let i=0;i<NS;i++){
        const f=(i+0.5)/NS, P=cameraPosition.add(D.mul(ta.add(chord.mul(f)))), q=P.sub(u.c).div(u.R), rr=q.length();
        // differential swirl: the core turns faster than the skin
        const ang=u.ph.mul(0.55).mul(float(1.5).sub(rr)).add(float(i*0.9)), ca=cos(ang), sa=sin(ang);
        const x=q.x.mul(ca).sub(q.z.mul(sa)), z=q.x.mul(sa).add(q.z.mul(ca)), y=q.y.add(u.ph.mul(0.07));
        const n=sin(x.mul(3.1).add(y.mul(1.7)).add(u.ph.mul(0.5))).mul(sin(y.mul(2.9).sub(z.mul(2.3)).sub(u.ph.mul(0.4)))).add(sin(z.mul(3.7).add(x.mul(2.1)).add(y.mul(1.3)).add(u.ph.mul(0.3))).mul(0.6));
        const dens=smoothstep(-0.25,1.05,n).mul(float(1).sub(smoothstep(0.7,1.0,rr)));
        acc=acc.add(dens); if(i===0) n0=n.mul(0.5).add(0.5);
      }
      const mist=acc.div(NS).mul(chord.div(u.R.mul(2.0)).min(1.0).mul(0.75).add(0.25));
      // fresnel rim: |N·V| of the sphere (abs: back faces flip)
      const V=normalize(cameraPosition.sub(positionWorld)), fr=float(1).sub(dot(normalize(normalWorld),V).abs()).pow(2.6);
      // noise-eroded dissolve (the pressurised bay): holes open where the noise is low, then it's gone
      const th=u.dis.mul(1.2), mask=smoothstep(th.sub(0.15),th,n0.add(fr.mul(0.1)));
      const a=mist.mul(0.30).add(fr.mul(0.36)).add(0.02).min(0.55).mul(u.a).mul(mask).mul(u.k);
      const col=mix(colA,colB,fr.mul(0.75).add(mist.mul(0.3))).mul(float(1).add(mist.mul(0.35)));
      m.colorNode=col; m.opacityNode=a;
      return m;
    }
    S.geo=new THREE.SphereGeometry(1,low?20:28,low?14:20);
    S.back=new THREE.Mesh(S.geo,orbMat(THREE.BackSide)); S.front=new THREE.Mesh(S.geo,orbMat(THREE.FrontSide));
    for(const m of [S.back,S.front]){ m.frustumCulled=false; m.visible=false; m.renderOrder=60; m.name='dm-haz-orb'; }
    S.back.renderOrder=59;

    // underwater tint: a clip-space quad (no camera attach) — fog colour, light from above, faint caustic shimmer; clear inside the orb
    const tu={wet:uniform(0),ph:uniform(0),depth:uniform(0),col:uniform(new THREE.Color(0x0b3a5c)),aspect:uniform(1),c:uniform(new THREE.Vector3()),R:uniform(0),low:uniform(low?1:0)};
    S.tu=tu;
    const tm=new THREE.MeshBasicNodeMaterial({transparent:true,depthTest:false,depthWrite:false,side:THREE.DoubleSide}); tm.fog=false; tm.toneMapped=false;
    tm.vertexNode=vec4(positionLocal.x.mul(2.0),positionLocal.y.mul(2.0),0.0,1.0);
    const ndc=positionLocal.xy.mul(2.0);
    const pr=T.cameraProjectionMatrixInverse.mul(vec4(ndc,1.0,1.0)), dv=pr.xyz.div(pr.w);
    const wd=normalize(T.cameraWorldMatrix.mul(vec4(dv,0.0)).xyz);
    const Lc=tu.c.sub(cameraPosition), tc=dot(Lc,wd), dd=dot(Lc,Lc).sub(tc.mul(tc)).max(0.0).sqrt().div(tu.R.max(1e-3));
    const inOrb=float(1).sub(smoothstep(0.78,1.02,dd)).mul(smoothstep(0.0,0.05,tu.R));   // 1 inside the orb's disc: no tint there
    const p=ndc.mul(vec2(tu.aspect,1.0)).mul(3.2), t=tu.ph;
    const c1=sin(p.x.mul(2.1).add(t).add(sin(p.y.mul(1.7).sub(t.mul(0.7))))), c2=sin(p.y.mul(2.6).sub(t.mul(0.8)).add(sin(p.x.mul(1.9).add(t.mul(0.5)))));
    const cau=float(1).sub(c1.mul(c2).abs()).pow(7.0).mul(float(1).sub(tu.low)).mul(float(1).sub(tu.depth.mul(0.8)));
    const shaft=sin(ndc.x.mul(7.0).add(sin(t.mul(0.3)).mul(2.0)).add(ndc.y.mul(1.5))).mul(0.5).add(0.5).pow(3.0).mul(ndc.y.mul(0.5).add(0.5)).mul(float(1).sub(tu.depth.mul(0.9)));
    tm.colorNode=mix(tu.col,vec3(0.55,0.9,1.0),cau.mul(0.30).add(shaft.mul(0.10)).min(0.5));
    tm.opacityNode=tu.wet.mul(float(0.34).add(tu.depth.mul(0.22))).mul(float(1).sub(inOrb.mul(0.97)));
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
    for(const m of [S.back,S.front,S.tint,S.bub]){ if(m.parent) m.parent.remove(m); scene.add(m); }
    S.scene=scene; S.r=renderer; S.ready=false; S.fogSaved=false;
    // compile every variant once, off the play path, so the first orb / dive doesn't hitch
    try{
      if(renderer&&renderer.compileAsync&&PW&&PW.camera){
        for(const m of [S.back,S.front,S.tint,S.bub]) m.visible=true;
        S.u.a.value=0; const p=renderer.compileAsync(scene,PW.camera);
        const done=()=>{ for(const m of [S.back,S.front,S.tint,S.bub]) m.visible=false; S.ready=true; };
        p.then(done,done);
      } else S.ready=true;
    }catch(e){ S.ready=true; }
    return true;
  }
  // detach before the world's scene is disposed: our GPU objects outlive it and are reused by the next world
  H.close=function(scene){
    try{ restoreFog(); for(const m of [S.back,S.front,S.tint,S.bub]) if(m&&m.parent) m.parent.remove(m); }catch(e){}
    S.scene=null; S.r=null; H.a=0; H.wet=0; H.dis=0; H.blue=0; H.underwater=false; S.fogSaved=false; S.boost=0;
  };
  // out of the air (space) or switched off: hide, keep everything attached and compiled
  H.hide=function(){
    try{ restoreFog(); if(S.front){ S.front.visible=S.back.visible=S.tint.visible=false; S.bub.visible=false; } }catch(e){}
    H.a=0; H.wet=0; H.dis=0; H.blue=0; H.underwater=false; S.boost=0;
    if(S.pos) for(let i=0;i<N_BUB;i++) S.pos[i*6+4]=0;
  };
  H.dispose=function(){ try{ H.close(); for(const o of [S.geo,S.bgeo,S.tint&&S.tint.geometry]) o&&o.dispose(); for(const m of [S.back&&S.back.material,S.front&&S.front.material,S.tint&&S.tint.material,S.bmat]) m&&m.dispose(); }catch(e){} H.built=false; };

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

  /* ── per-frame ─────────────────────────────────────────────────── */
  const _c={x:0,y:0,z:0,R:1,len:1,ok:false};
  function groupSphere(mode,cam,a){
    const root=CHAR&&CHAR.root; _c.ok=false; if(!root||root.visible===false) return _c;
    root.updateWorldMatrix(true,false); const e=root.matrixWorld.elements;
    const sc=Math.hypot(e[0],e[1],e[2])||1, h=(CHAR.rawHeight||1)*sc;      // her real height in world units
    let mx=e[12], my=e[13]+h*0.5, mz=e[14], R=h*0.62, len=h*1.3;
    const b=mode==='fly'?atmoBoard:(surfBoard&&surfBoard.visible!==false&&surfBoard.parent&&CHAR.mounted?surfBoard:null);
    if(b){
      b.updateWorldMatrix(true,false); const be=b.matrixWorld.elements; len=(typeof _lcBoardLen==='function'?_lcBoardLen(b):0)||len;
      const bx=be[12], by=be[13], bz=be[14];
      mx=(mx+bx)*0.5; my=(my+by)*0.5; mz=(mz+bz)*0.5;
      const dx=e[12]-mx, dy=e[13]+h*0.5-my, dz=e[14]-mz, dc=Math.sqrt(dx*dx+dy*dy+dz*dz);
      R=Math.max(h*0.55+dc, len*0.55+dc)*1.12;
    } else R=h*0.66;
    // keep the camera outside when it can be (a first-person view just sits inside the orb)
    const ce=cam.matrixWorld.elements, ex=ce[12]-mx, ey=ce[13]-my, ez=ce[14]-mz, cd=Math.sqrt(ex*ex+ey*ey+ez*ez);
    if(cd>h*2.2) R=Math.min(R,cd*0.8);
    _c.x=mx; _c.y=my; _c.z=mz; _c.R=R; _c.len=len; _c.ok=true; return _c;
  }
  let hx=0,hz=1,lastX=0,lastY=0,lastZ=0,haveLast=false,spd=0,tPh=0,tPh2=0,boostT=0;
  H.tick=function(dt){
    if(H.off||typeof PW==='undefined'||!PW.active||!PW.scene||!PW.camera) { if(H.a>0||H.wet>0||S.fogSaved) H.hide(); return; }
    const mode=PW.mode; dt=Math.min(0.1,Math.max(0.001,dt||1/60));
    if(mode!=='fly'&&mode!=='walk'){ if(H.a>0||H.wet>0||S.fogSaved||S.front&&S.front.visible) H.hide(); haveLast=false; return; }
    if(!attach(PW.scene,PW.renderer||(typeof flightRenderer!=='undefined'?flightRenderer:null))) return;
    if(!S.ready){ return; }
    const cam=PW.camera, W=window.JOTS_WATER, g=groupSphere(mode,cam);
    if(!g.ok){ haveLast=false; H.a=ease(H.a,0,3,dt); S.front.visible=S.back.visible=H.a>0.01; S.tint.visible=false; return; }
    // her speed (world units/s) — local stand-in for the physics-intensity scalar
    if(haveLast){ const dx=g.x-lastX, dy=g.y-lastY, dz=g.z-lastZ, dl=Math.sqrt(dx*dx+dy*dy+dz*dz); spd=ease(spd,dl/dt,6,dt); if(dl>1e-5){ hx=ease(hx,dx/dl,8,dt); hz=ease(hz,dz/dl,8,dt); } }
    lastX=g.x; lastY=g.y; lastZ=g.z; haveLast=true;
    const surfY=W?(W.surfaceY||0):0;
    // wet board: flying (not walking/swimming) with the board centre below the surface
    const dep=W&&mode==='fly'?surfY-g.y:-1, wet=sm(0.3,2.2,dep);
    H.wet=ease(H.wet,wet,8,dt); H.underwater=H.wet>0.05;
    const camWet=W&&mode==='fly'?sm(0,1.5,surfY-cam.position.y):0;
    // hazard target
    let tgt=0; const kind=H.kind(PW.body,PW.pal);
    if(kind==='toxic') tgt=1; else if(kind==='airless') tgt=0.42;
    const bay=bayLevel(); H.dis=ease(H.dis,bay,4,dt);
    const wantBlue=H.wet>0.5?1:0;
    const tOrb=Math.max(tgt*(1-H.wet), H.wet);              // underwater the blue mist orb takes over from the green one
    H.blue=ease(H.blue,wantBlue,5,dt);
    H.a=ease(H.a,tOrb*(1-H.dis),tOrb>H.a?1.6:2.4,dt);       // slow fade in, quicker out
    const cg=window.DMCGroup, extern=cg&&typeof cg.intensity==='number'&&cg.intensity>0;
    const loc=0.85+Math.min(0.5,spd/Math.max(0.5,g.len*5))+H.wet*0.5;
    H.inten=ease(H.inten,extern?cg.intensity:loc,5,dt);
    if(extern&&H.wet>0.5){ boostT-=dt; if(boostT<=0&&cg.boost){ try{ cg.boost('swim',1.4,0.5); }catch(e){} boostT=0.25; } }
    // radius settles smoothly; the centre never lags the board
    H.R=H.R>0&&H.a>0.02?ease(H.R,g.R,10,dt):g.R;
    tPh+=dt*(0.55+0.45*H.inten);
    const u=S.u; u.c.value.set(g.x,g.y,g.z); u.R.value=H.R; u.ph.value=tPh;
    u.a.value=Math.min(0.85,H.a)*(0.8+0.2*H.blue); u.dis.value=H.dis; u.blue.value=H.blue; u.k.value=0.88+0.12*H.inten;
    const vis=H.a>0.01; S.front.visible=S.back.visible=vis;
    if(vis){ S.front.position.set(g.x,g.y,g.z); S.back.position.copy(S.front.position); S.front.scale.setScalar(H.R); S.back.scale.setScalar(H.R); }
    // underwater look outside the orb: fog + tint + caustics
    const tw=camWet*Math.min(1,H.wet*3);
    const tintOn=tw>0.01&&mode==='fly';
    S.tint.visible=tintOn;
    if(tintOn){
      const tu=S.tu; tPh2+=dt; tu.wet.value=tw; tu.ph.value=tPh2*0.8;
      tu.depth.value=sm(0,60,surfY-cam.position.y);
      tu.aspect.value=(window.innerWidth||1)/Math.max(1,window.innerHeight||1);
      tu.c.value.set(g.x,g.y,g.z); tu.R.value=H.R*(H.a>0.05?1:0);
      const lc=PW.pal&&PW.pal.liquidColor!==undefined?PW.pal.liquidColor:0x1a4a7a; tu.col.value.setHex(lc).multiplyScalar(0.55);
      // fog (set after _pwWorldTick's own near/far): murky water, restored on surfacing
      const sc=PW.scene;
      if(!S.fogSaved){ S.fog=sc.fog||null; S.fogWas=!!sc.fog; if(!sc.fog) sc.fog=new THREE.Fog(0x0b3a5c,1,1000); S.fog=sc.fog; S.fogCol=sc.fog.color.getHex(); S.fogSaved=true; }
      if(sc.fog&&sc.fog===S.fog){ sc.fog.color.copy(tu.col.value); sc.fog.near=1; sc.fog.far=sc.fog.far+(Math.max(40,260-tu.depth.value*140)-sc.fog.far)*tw; }
    } else if(S.fogSaved) restoreFog();
    // bubbles
    if(H.wet>0.02||S.bub.visible) bubbles(dt,H.wet,g.x,g.y-g.R*0.15,g.z,spd,g.len,surfY,hx,hz);
  };
  H.setOff=function(v){ H.off=!!v; if(H.off) H.hide(); };
})();
