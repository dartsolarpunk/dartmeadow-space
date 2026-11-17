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
               character root) inside a non-breathable atmosphere: a thin,
               screen-blended (soft additive, premultiplied) green glow fades in:
               fresnel rim, faint swirl, highlight waves and mellow sparkles
               (Med+). First person (camera inside): clear in the middle of the
               view, the glow only toward the edges of vision (t1590). Airless worlds get a fainter one. Dissolves in the
               pressurised Titan bay (event 'dm:bay' / DM_FAC.bay).
   blue orb    Riding the board below JOTS_WATER's surface: a blue mist orb,
               the same controls with water drag/damping (waterDrag), a
               bubble trail, and fog + a caustic tint outside the orb.
               Off the board, swimming is untouched (this never runs in it).
   Cost: 2 sphere draws (≈ 200 tris), one 2-4 sample chord march per pixel
   (Low / mobile: 2, no sparkles, no tint caustics), one full-screen tint only while
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
  // ?hazard=toxic|airless|safe forces the answer on EVERY world (test / A-B flag; habitability itself, and so every seed, is untouched)
  const FORCE=(()=>{ try{ const v=new URLSearchParams(window.location.search).get('hazard'); return v==='toxic'||v==='airless'?v:v==='safe'?'breathable':null; }catch(e){ return null; } })();
  H.kind=function(b,pal){ if(FORCE) return FORCE; if(H.habitable(b)) return 'breathable'; return (pal?pal.atmos:b&&b.mcHasAtm)?'toxic':'airless'; };

  /* ── helpers ───────────────────────────────────────────────────── */
  const sm=(a,b,x)=>{ x=(x-a)/(b-a); x=x<0?0:x>1?1:x; return x*x*(3-2*x); };
  const ease=(cur,tgt,rate,dt)=>cur+(tgt-cur)*(1-Math.exp(-rate*dt));
  function lowTier(){ try{ return !!(GFX&&(GFX.preset==='low'||(GFX.isMobile&&GFX.preset!=='high'&&GFX.preset!=='ultra'))); }catch(e){ return false; } }
  // (t1590) orb look constants (shader + the pure core below share them; tools/tests/hazard-bubble-look.js)
  //   rim/rimPow  fresnel rim gain / exponent       body / bodyBlue  the faint fill everywhere (green / blue underwater orb)
  //   mist/mistIn swirl gain outside / inside       wave/wavePow    highlight waves sweeping the skin       spk / spkCells / spkKeep  sparkles (Med+)
  //   clear       first-person clear zone: screen radius (1 = top edge) where the glow starts / is full;  clearFloor = what's left in the middle
  //   inside      camera distance / R where the view counts as inside (first person) -> outside;  max  intensity ceiling (screen blend: never a fill)
  const K={rim:0.5,rimPow:3.2,body:0.018,bodyBlue:0.09,mist:0.07,mistIn:0.32,wave:0.16,wavePow:9.0,spk:0.55,spkCells:9.0,spkKeep:0.86,
           clear:[0.38,1.05],clearFloor:0.03,inside:[0.84,1.0],max:0.62};
  // intensity of one pixel (JS twin of the shader, for the tests): fr fresnel 0..1, mist 0..1, wv/spk 0..1 terms, sr screen radius, dc = camera distance / R
  function look(fr,mist,wv,spk,sr,dc,blue){
    const ins=1-sm(K.inside[0],K.inside[1],dc), vig=sm(K.clear[0],K.clear[1],sr)*(1-K.clearFloor)+K.clearFloor, view=1+(vig-1)*ins;
    const body=K.body+(K.bodyBlue-K.body)*(blue||0), mk=K.mist+(K.mistIn-K.mist)*ins;
    const I=Math.min(K.max,Math.pow(fr,1)*K.rim+mist*mk+wv*K.wave*(fr*0.6+0.4)+spk*K.spk+body);
    return I*view;
  }
  // screen blend (what the orb's blending does per channel): dst + src x (1 - dst), never past 1, a dark scene barely tinted
  function screen(dst,src){ return dst+src*(1-dst); }
  H.core={K,look,screen,sm,present:(root,mode,toxic)=>present(root,mode,toxic)};
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
    const low=lowTier(), NS=low?2:4;   // (t1590) the mist is a minor term now (edges / rim): 2 samples on Low, 4 above
    const u={c:uniform(new THREE.Vector3()),R:uniform(1),a:uniform(0),dis:uniform(0),ph:uniform(0),k:uniform(1),blue:uniform(0),asp:uniform(1)};
    S.u=u;
    const gA=new THREE.Color(0x3dff8a), gB=new THREE.Color(0xc8ffb0), bA=new THREE.Color(0x2f8fff), bB=new THREE.Color(0xa6e6ff);
    const colA=mix(vec3(gA.r,gA.g,gA.b),vec3(bA.r,bA.g,bA.b),u.blue), colB=mix(vec3(gB.r,gB.g,gB.b),vec3(bB.r,bB.g,bB.b),u.blue);
    // (t1590) the look: a soft SCREEN-blended glow (premultiplied: out = col x I; dst x (1 - col)), color-dodge-ish on the terrain, never an opaque fill.
    //   outside (third person): a thin shell = fresnel rim + a faint body, slow highlight waves, mellow sparkles (not on Low)
    //   inside (first person):  the same light, but cleared out of the middle of the view (screen-radius vignette): the swirl lives at the edge of vision
    const asp=u.asp, Kc=K;
    function orbMat(side){
      const m=new THREE.MeshBasicNodeMaterial({transparent:true,depthTest:true,depthWrite:false,side});
      m.fog=false; m.toneMapped=false; m.premultipliedAlpha=true;
      m.blending=THREE.CustomBlending; m.blendEquation=THREE.AddEquation; m.blendSrc=THREE.OneFactor; m.blendDst=THREE.OneMinusSrcColorFactor;
      m.blendEquationAlpha=THREE.AddEquation; m.blendSrcAlpha=THREE.OneFactor; m.blendDstAlpha=THREE.OneMinusSrcAlphaFactor;
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
      const V=normalize(cameraPosition.sub(positionWorld)), fr=float(1).sub(dot(normalize(normalWorld),V).abs()).pow(Kc.rimPow);
      // the shell point on the unit sphere (waves + sparkles ride the skin, turning slowly)
      const s=positionWorld.sub(u.c).div(u.R);
      const wv=sin(s.x.mul(5.0).add(s.y.mul(3.0)).sub(u.ph.mul(1.1)).add(sin(s.z.mul(4.0).add(u.ph.mul(0.35))).mul(1.6))).mul(0.5).add(0.5).pow(Kc.wavePow).mul(Kc.wave);
      let spk=float(0);
      if(!low){   // sparkles: one hashed cell per ~1/9 of the radius, a few lit at a time, twinkling (Med+ only)
        const p=s.mul(Kc.spkCells).add(vec3(u.ph.mul(0.05),u.ph.mul(-0.03),0.0)), cell=T.floor(p), lc=T.fract(p).sub(0.5);
        const hs=T.fract(sin(dot(cell,vec3(12.9898,78.233,37.719))).mul(43758.5453));
        const tw=sin(u.ph.mul(2.3).add(hs.mul(40.0))).mul(0.5).add(0.5).pow(10.0);
        spk=smoothstep(0.24,0.0,lc.length()).mul(tw).mul(T.step(Kc.spkKeep,hs)).mul(Kc.spk);
      }
      // first person: clear in the middle of the view (screen radius, 1 = the top edge), the glow only toward the edges
      const sr=T.screenUV.sub(0.5).mul(vec2(asp,1.0)).length().mul(2.0);
      const vig=smoothstep(Kc.clear[0],Kc.clear[1],sr).mul(1-Kc.clearFloor).add(Kc.clearFloor);
      const ins=float(1).sub(smoothstep(Kc.inside[0],Kc.inside[1],cameraPosition.sub(u.c).length().div(u.R)));
      const view=mix(float(1),vig,ins);
      // noise-eroded dissolve (the pressurised bay): holes open where the noise is low, then it's gone
      const th=u.dis.mul(1.2), mask=smoothstep(th.sub(0.15),th,n0.add(fr.mul(0.1)));
      const body=mix(float(Kc.body),float(Kc.bodyBlue),u.blue), mistK=mix(float(Kc.mist),float(Kc.mistIn),ins);
      const I=fr.mul(Kc.rim).add(mist.mul(mistK)).add(wv.mul(fr.mul(0.6).add(0.4))).add(spk).add(body).min(Kc.max).mul(view).mul(u.a).mul(mask).mul(u.k);
      const col=mix(colA,colB,fr.mul(0.7).add(mist.mul(0.3)).add(wv)).add(vec3(spk.mul(0.8)));
      m.colorNode=col; m.opacityNode=I;   // premultipliedAlpha: the output is col x I, then the screen blend
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
        S.u.a.value=0; for(const m of [S.back,S.front]){ m.position.set(0,-1e7,0); m.scale.setScalar(1e-3); }   // if a frame is drawn while the pipelines build, the dummy sphere is a speck a long way under the world (never a disc over the ground)
 const p=renderer.compileAsync(scene,PW.camera);
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
    try{ H.shieldRelease(); DMHazard.clear(); _gb=_gp=null; _gid=_zid=0; H.hostile=false; H.awake=false; }catch(e){}   // the shield's crown glow / LED leave the scene with the orb; every hazard source of the world goes
  };
  // out of the air (space) or switched off: hide, keep everything attached and compiled
  H.hide=function(){
    try{ restoreFog(); if(S.front){ S.front.visible=S.back.visible=S.tint.visible=false; S.bub.visible=false; } }catch(e){}
    H.a=0; H.wet=0; H.dis=0; H.blue=0; H.underwater=false; S.boost=0;
    try{ H.shieldHide(); }catch(e){}
    if(S.pos) for(let i=0;i<N_BUB;i++) S.pos[i*6+4]=0;
  };
  H.dispose=function(){ try{ H.shieldDispose(); H.close(); for(const o of [S.geo,S.bgeo,S.tint&&S.tint.geometry]) o&&o.dispose(); for(const m of [S.back&&S.back.material,S.front&&S.front.material,S.tint&&S.tint.material,S.bmat]) m&&m.dispose(); }catch(e){} H.built=false; };

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
       material here). Prompt cooldown: dismiss(ms) (default 120 s).
       Flags: `?hazardzone=plume` registers a test plume column ~6 heights ahead of her at world open (radius 4 heights) - the only test source besides ?hazard=toxic.
     ═══════════════════════════════════════════════════════════════════ */
  const HZ={src:[],nextId:1,near:false,state:'clear',type:'',gas:'',sev:0,dist:1e9,glob:0,timer:0,hz:3,coolUntil:0,clearSince:0,glasses:{level:0,r:1,g:0.72,b:0.1},ticks:0,onClear:null};
  function hazardDist(s,px,py,pz){   // signed distance to the source's edge (negative inside): pure
    if(s.shape==='global') return -1;
    if(s.shape==='column'){ const dx=px-s.x, dz=pz-s.z, h=Math.hypot(dx,dz)-s.r; const dy=py<s.y0?s.y0-py:py>s.y1?py-s.y1:0; return dy>0?Math.hypot(Math.max(h,0),dy):h; }
    return Math.hypot(px-s.x,py-s.y,pz-s.z)-s.r;
  }
  function hazardStep(d,warn){ return d<=0?'inside':d<=warn?'near':'clear'; }
  function hzSense(){
    HZ.ticks++;
    const root=window.CHAR&&CHAR.root; if(!root||typeof PW==='undefined'||!PW.active){ hzSet('clear',null,1e9); return; }
    const e=root.matrixWorld.elements, px=e[12], py=e[13]+0.9, pz=e[14];
    let best=null,bd=1e9,bst='clear',hh=1; try{ hh=(CHAR.rawHeight||1)*(Math.hypot(e[0],e[1],e[2])||1); }catch(x){}
    for(let i=0;i<HZ.src.length;i++){ const s=HZ.src[i]; if(s.shape==='global') continue;
      const d=hazardDist(s,px,py,pz), st=hazardStep(d,s.warn!=null?s.warn:s.r*0.8+hh*1.5);
      if(st!=='clear'&&(!best||d<bd)){ best=s; bd=d; bst=st; } }
    hzSet(best?bst:'clear',best,bd);
    // a locally armed shield drops again after 8 s clear of every source
    if(!best&&SH.armed&&!HZ.glob){ if(!HZ.clearSince) HZ.clearSince=performance.now(); else if(performance.now()-HZ.clearSince>8000){ HZ.clearSince=0; DMShield.arm(false); } } else HZ.clearSince=0;
  }
  function hzSet(st,s,d){
    HZ.dist=d; const g=HZ.glasses; g.level=st==='inside'?1:st==='near'?0.55:0;
    if(st===HZ.state&&(!s||s.type===HZ.type)) return;
    HZ.state=st; HZ.near=st!=='clear'; HZ.type=s?s.type:''; HZ.gas=s?s.gas||'':''; HZ.sev=s?(s.sev==null?1:s.sev):0;
    try{ window.dispatchEvent(new CustomEvent('dmhazard',{detail:{state:st,near:HZ.near,type:HZ.type,gas:HZ.gas,sev:HZ.sev,dist:d}})); }catch(e){}
  }
  function hzTimer(){
    let local=0; for(let i=0;i<HZ.src.length;i++) if(HZ.src[i].shape!=='global') local++;
    if(local&&!HZ.timer){ HZ.timer=setInterval(hzSense,Math.round(1000/HZ.hz)); }
    else if(!local&&HZ.timer){ clearInterval(HZ.timer); HZ.timer=0; hzSet('clear',null,1e9); }
  }
  const DMHazard={
    register(src){ if(!src||typeof src!=='object') return 0; const s=Object.assign({shape:'sphere',sev:1,r:1,x:0,y:0,z:0,type:'hazard',gas:''},src); s.id=s.id||('hz'+(HZ.nextId++));
      for(let i=0;i<HZ.src.length;i++) if(HZ.src[i].id===s.id) HZ.src.splice(i--,1);
      HZ.src.push(s); if(s.shape==='global') HZ.glob++; hzTimer(); return s.id; },
    unregister(id){ for(let i=0;i<HZ.src.length;i++) if(HZ.src[i].id===id){ if(HZ.src[i].shape==='global') HZ.glob--; HZ.src.splice(i,1); hzTimer(); return true; } return false; },
    clear(){ if(!HZ.src.length&&!HZ.timer) return; HZ.src.length=0; HZ.glob=0; hzTimer(); },
    count(){ return HZ.src.length; }, get near(){ return HZ.near; }, get state(){ return HZ.state; }, get type(){ return HZ.type; }, get gas(){ return HZ.gas; }, get severity(){ return HZ.sev; },
    get distance(){ return HZ.dist; }, get glasses(){ return HZ.glasses; }, get sensorOn(){ return !!HZ.timer; }, get ticks(){ return HZ.ticks; }, rateHz:HZ.hz,
    dismiss(ms){ HZ.coolUntil=performance.now()+(ms>0?ms:120000); }, get cooling(){ return performance.now()<HZ.coolUntil; },
    sense:hzSense, core:{hazardDist,hazardStep}
  };
  window.DMHazard=DMHazard; H.hazard=DMHazard;

  /* ═══════════════════════════════════════════════════════════════════
     DMSHIELD — the shield toggle (HUD button ui/dm-shield.js), the board-group protection field and the staff-crown status glow.
       orb ON   (default; the t1590 breathing orb, unchanged): the orb is drawn round her (+ the board when she rides it) in toxic / airless air.
       orb OFF  no orb is drawn at all (meshes hidden: zero draw, zero blend). Her protection comes from the BOARD GROUP (skyboard + the staff that
                travels beside it): she is protected while she is within PROTECT_R of the board, parked or following. The staff's crown (head
                pieces: GLB 'staff head' / arrowhead shards, else the staff itself) shows it: an inverted-hull contour glow hugging the crown's own
                silhouette + a small lighthouse-style LED housing on top, both in the status colour:
                  GREEN  protected (inside 0.8 R) · AMBER inside the last fifth of the field (walk back) · RED outside R (exposed).
                Hysteresis: back to GREEN only once she is inside 0.74 R (0.92 R from red). A summoned board that is still flying to her leaves her
                red/amber until it is inside the field again; walking back to the board does the same. Nothing is drawn on safe worlds.
       safe air (breathable worlds: Earth, Solenne + the mansion, habitable seeds) never builds, shows or draws any of this: DMShield.available = false.
     Radius: PROTECT_R = RADIUS_MUL x her height (15 x ~1.7 m ~ 25 m on foot); `?shieldr=<mul>`; DMShield.radius() is in world units.
     Cost: 1-2 extra draws of the crown's own (few hundred tri) geometry, 3 tiny LED meshes, one DMVLight point (Med+, shed by DMBudget 'light' >= 2).
     Flags: `?shield=0` (feature off: orb behaves exactly as before, no button) · `?hazard=toxic|airless|safe` (force the air kind) · `?shieldr=`.
     ═══════════════════════════════════════════════════════════════════ */
  const SHQ=(()=>{ try{ return new URLSearchParams(window.location.search); }catch(e){ return null; } })();
  const SH_OFF=!!(SHQ&&SHQ.get('shield')==='0');
  const RADIUS_MUL=(()=>{ const v=SHQ?parseFloat(SHQ.get('shieldr')):NaN; return v>0.5&&v<200?v:15; })();
  const WARN_IN=0.8, WARN_BACK=0.74, REJOIN=0.92;
  // status of the field for her distance d from the board (pure): hysteresis so the colour never flickers at an edge
  function stepStatus(prev,d,R){
    if(!(R>0)||!(d>=0)) return 'protected';
    if(prev==='exposed') return d<R*REJOIN?(d>R*WARN_BACK?'warn':'protected'):'exposed';
    if(d>R) return 'exposed';
    return d>R*(prev==='protected'?WARN_IN:WARN_BACK)?'warn':'protected';
  }
  const SH_COL={protected:[0.16,1.0,0.46],warn:[1.0,0.76,0.18],exposed:[1.0,0.18,0.14],alert:[1.0,0.68,0.08]};   // alert = a hazard source is near and the shield is not armed: the LED only
  // what the crown glow may cost: tier ('low' = cheapest) x DMBudget 'light' level -> hull shells (0-2), the fake point light, the LED
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
  const SH={on:true,armed:false,prot:false,alert:false,frames:0,avail:false,status:'protected',dist:0,R:1,a:0,pulse:0,ph:0,u:null,mats:null,hulls:null,led:null,ledGeo:null,scene:null,board:null,ledLoc:null,ledR:0.02,kT:0.05,
            vl:null,vlOn:false,warm:0,sig:'',fd:null,crownN:0,lastEmit:'',busy:false,col:null,ready:false};
  try{ if(!SH_OFF&&window.localStorage&&window.localStorage.getItem('dm_shield_orb')==='0') SH.on=false; }catch(e){}
  if(SH_OFF) SH.on=true;
  const SHD={RADIUS_MUL,WARN_IN,WARN_BACK,REJOIN,stepStatus,shieldPlan,pickCrown,COL:SH_COL};
  function shEmit(){
    const sig=(SH.avail?1:0)+''+(SH.on?1:0)+(SH.prot?1:0)+(SH.armed?1:0)+SH.status; if(sig===SH.lastEmit) return; SH.lastEmit=sig;
    try{ window.dispatchEvent(new CustomEvent('dmshield',{detail:{on:SH.on,available:SH.avail,armed:SH.armed,status:DMShield.status,state:DMShield.state}})); }catch(e){}
  }
  const DMShield={
    get available(){ return SH.avail&&!SH_OFF; }, get on(){ return SH.on; }, get armed(){ return SH.armed; },
    get state(){ return SH.avail?(SH.prot?(SH.on?'orb':'board'):'alert'):'off'; },
    get status(){ return !SH.avail?'off':!SH.prot?'alert':SH.on?'orb':SH.status; },
    get protected(){ return SH.avail?(SH.prot?(SH.on||SH.status!=='exposed'):false):true; }, get distance(){ return SH.dist; },
    radius(){ return SH.R; }, RADIUS_MUL, core:SHD,
    get stats(){ return {frames:SH.frames,built:!!SH.hulls,gpu:!!SH.mats,awake:H.awake===true}; },
    set(v){ v=!!v; if(SH_OFF) v=true; if(v===SH.on) return SH.on; SH.on=v; try{ window.localStorage&&window.localStorage.setItem('dm_shield_orb',v?'1':'0'); }catch(e){} shEmit(); return SH.on; },
    // arm: switch the protection on although the planet's air is fine (a local hazard source: plume, vent, cave, facility; the prompt's ACCEPT / the HUD button)
    arm(v){ v=!!v&&!SH_OFF; if(v===SH.armed) return SH.armed; SH.armed=v; if(!v&&!H.hostile) SH.prot=false; shEmit(); return SH.armed; },
    // the HUD button: while only an alert is showing it ARMS the shield, otherwise it toggles the orb (orb <-> the board group's field + crown glow)
    toggle(){ if(SH.avail&&!SH.prot) return DMShield.arm(true); return DMShield.set(!SH.on); },
    overrideDistance(d){ SH.fd=(typeof d==='number'&&d>=0)?d:null; }   // tests / screenshots only
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
  function shTear(){   // remove our meshes from the scene (the board's own objects are never touched; the crown geometry is the board's, never disposed here)
    if(SH.hulls){ for(const h of SH.hulls){ if(h.parent) h.parent.remove(h); } SH.hulls.length=0; } if(SH.led&&SH.led.parent) SH.led.parent.remove(SH.led);
    SH.board=null; SH.sig=''; SH.crownN=0; SH.warm=0;
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
    const bsx=Math.hypot(board.matrixWorld.elements[0],board.matrixWorld.elements[1],board.matrixWorld.elements[2])||1;
    let top,cx,cz,span;
    if(!bx.isEmpty()){ top=bx.max.y; cx=(bx.min.x+bx.max.x)/2; cz=(bx.min.z+bx.max.z)/2; span=Math.max(bx.max.x-bx.min.x,bx.max.z-bx.min.z,bx.max.y-bx.min.y); }
    else { const a=board.userData&&board.userData.deckAnchor||{x:0,y:0,z:0.1}; cx=a.x; cz=a.z; top=a.y+0.35; span=0.2; }   // no crown found: a short mast over the deck
    const r=Math.min(0.06,Math.max(0.018,span*0.14)); SH.ledR=r; SH.kT=Math.min(0.05,Math.max(0.012,span*0.05));   // board-local units
    if(SH.led&&SH.led.parent) SH.led.parent.remove(SH.led);
    if(!SH.ledGeo){ SH.ledGeo={cas:new THREE.CylinderGeometry(1,1.18,1,10),dome:new THREE.SphereGeometry(1,10,8)}; }
    const g=new THREE.Group(); g.name='dm-shield-led'; g.userData.dmShield=true; g.matrixAutoUpdate=false; g.visible=false;
    const cas=new THREE.Mesh(SH.ledGeo.cas,SH.mats.dark), dome=new THREE.Mesh(SH.ledGeo.dome,SH.mats.led);
    cas.scale.set(r,r*1.3,r); cas.position.y=r*0.65; dome.scale.set(r*0.82,r*0.82,r*0.82); dome.position.y=r*1.3+r*0.5;
    for(const o of [cas,dome]){ o.frustumCulled=false; o.raycast=()=>{}; o.userData.dmShield=true; o.renderOrder=63; g.add(o); }
    SH.led=g; scene.add(g); SH.ledLoc=new THREE.Vector3(cx,top+r*0.15,cz); SH.board=board; SH.scene=scene; SH.crownN=ix.length; SH.sig='b';
    return true;
  }
  function shWarm(scene){
    const r=PW.renderer||(typeof flightRenderer!=='undefined'?flightRenderer:null);
    if(!r||!r.compileAsync||!PW.camera||!SH.led){ return; }
    SH.warmAt=performance.now(); const tok=SH.warm=(SH.warm|0)+1||1, far=new THREE.Matrix4().makeTranslation(0,-1e7,0);   // a speck-sized dummy a long way under the world, alpha 0
    SH.u.a.value=0; for(const h of SH.hulls){ h.matrix.copy(far); h.matrixWorldNeedsUpdate=true; h.visible=true; } SH.led.matrix.copy(far); SH.led.matrixWorldNeedsUpdate=true; SH.led.visible=true;
    const done=()=>{ if(SH.warm===tok) SH.warm=0; for(const h of SH.hulls) h.visible=false; if(SH.led) SH.led.visible=false; };
    try{ r.compileAsync(scene,PW.camera).then(done,done); }catch(e){ done(); }
  }
  let _M=null,_V=null,_vl=null; const _vo={level:1,gain:1};
  function shFrame(dt,kind,mode,g){
    SH.frames++;
    const board=PW.board, bay=bayLevel();
    // protect = the air is hostile (global source) or she armed it (local source); alert = a local source is near and nothing is armed (LED only)
    const prot=!SH_OFF&&(kind!=='breathable'||SH.armed), alert=!SH_OFF&&!prot&&HZ.near;
    const avail=(prot||alert)&&bay<0.5&&!!board&&(mode==='fly'||mode==='walk');
    if(avail!==SH.avail||prot!==SH.prot){ SH.avail=avail; SH.prot=avail&&prot; shEmit(); }
    SH.alert=avail&&alert;
    if(!avail){ shOff(dt); return; }
    if(!_M){ _M=new THREE.Matrix4(); _V=new THREE.Vector3(); _vl=new Float32Array(7); }
    // her height (world units) -> the field radius; her and the board's world positions
    SH.R=g.h*RADIUS_MUL;
    board.updateWorldMatrix(true,false); const be=board.matrixWorld.elements;
    if(prot){ const d=SH.fd!=null?SH.fd*SH.R:Math.hypot(be[12]-g.px,be[13]-g.py,be[14]-g.pz); SH.dist=d;
      const st=stepStatus(SH.status,d,SH.R); if(st!==SH.status){ SH.status=st; shEmit(); } }
    // built (and its pipelines compiled, off screen) as soon as it is needed: a toggle never hitches
    if(SH.board!==board||SH.scene!==PW.scene){ if(!shBuild(board,PW.scene)) return; shWarm(PW.scene); }
    if(SH.warm){ if(performance.now()-SH.warmAt<4000) return; SH.warm=0; for(const h of SH.hulls) h.visible=false; if(SH.led) SH.led.visible=false; }   // a compile that never answers must not keep the crown off
    const hullOn=prot&&!SH.on&&board.visible!==false, want=hullOn||alert;
    SH.a+=((want?1:0)-SH.a)*(1-Math.exp(-(want?4:7)*dt));
    if(SH.a<0.01&&!want){ SH.a=0; shOff(dt); return; }
    const low=lowTier(), B=window.DMBudget&&DMBudget.on?DMBudget:null, plan=shieldPlan(low,B?B.lvl('light'):0);
    const stN=alert?'alert':SH.status;
    SH.ph+=dt; const c=SH_COL[stN], k=1-Math.exp(-6*dt); for(let i=0;i<3;i++) SH.col[i]+=(c[i]-SH.col[i])*k;
    const fast=stN==='protected'?2.2:stN==='warn'?5.5:stN==='alert'?4:8;
    const pulse=plan.pulse?(stN==='protected'?0.86+0.14*Math.sin(SH.ph*fast):0.7+0.3*Math.sin(SH.ph*fast)):1;
    const u=SH.u; u.col.value.setRGB(SH.col[0],SH.col[1],SH.col[2]); u.a.value=SH.a*pulse;
    const bs=Math.hypot(be[0],be[1],be[2])||1; u.t.value=SH.kT*bs;
    for(const h of SH.hulls){ const src=h.userData.src, vis=hullOn&&!!src&&plan.hulls>(h.userData.out?1:0)&&src.visible!==false;
      h.visible=vis; if(vis){ src.updateWorldMatrix(true,false); h.matrix.copy(src.matrixWorld); h.matrixWorldNeedsUpdate=true; } }
    const L=SH.led; L.visible=plan.led; if(plan.led){ _M.makeTranslation(SH.ledLoc.x,SH.ledLoc.y,SH.ledLoc.z); L.matrix.multiplyMatrices(board.matrixWorld,_M); L.matrixWorldNeedsUpdate=true; }
    // the fake point light (fog / mist in-scatter, ui/dm-vlight.js): the LED's colour at the LED, shed by tier and DMBudget
    const VL=window.DMVLight;
    if(VL&&VL.on&&plan.point){ _V.copy(SH.ledLoc).applyMatrix4(board.matrixWorld); const rg=g.h*2.6, I=46*SH.a*pulse;
      _vl[0]=_V.x; _vl[1]=_V.y; _vl[2]=_V.z; _vl[3]=SH.col[0]*I; _vl[4]=SH.col[1]*I; _vl[5]=SH.col[2]*I; _vl[6]=rg; VL.setPoints('shield',_vl,_vo); SH.vlOn=true; }
    else if(SH.vlOn){ try{ VL.clear('shield'); }catch(e){} SH.vlOn=false; }
  }
  function shOff(dt){   // nothing of the shield is drawn (hidden = not in any render list); the meshes stay built for the next time
    if(SH.warm||!SH.hulls) return;
    if(SH.a!==0) SH.a=0;
    for(const h of SH.hulls) if(h.visible) h.visible=false;
    if(SH.led&&SH.led.visible) SH.led.visible=false;
    if(SH.vlOn){ try{ window.DMVLight&&DMVLight.clear('shield'); }catch(e){} SH.vlOn=false; }
  }
  H.shieldHide=function(){ if(SH.avail){ SH.avail=false; SH.prot=false; shEmit(); } shOff(); };
  H.shieldRelease=function(){ if(SH.hulls||SH.led) shTear(); SH.scene=null; SH.a=0; SH.armed=false; SH.alert=false; SH.hulls=null; if(SH.avail){ SH.avail=false; SH.prot=false; shEmit(); } };
  H.shieldDispose=function(){ if(SH.hulls||SH.led) shTear(); try{ if(SH.mats) for(const k in SH.mats) SH.mats[k].dispose(); if(SH.ledGeo){ SH.ledGeo.cas.dispose(); SH.ledGeo.dome.dispose(); } }catch(e){} SH.mats=null; SH.ledGeo=null; SH.u=null; };

  /* ── per-frame ─────────────────────────────────────────────────── */
  const _c={x:0,y:0,z:0,R:1,len:1,ok:false,px:0,py:0,pz:0,h:1};
  // (t1590) on foot in first person the game hides her body (index.html _surfFpBody: _surfFpHidden); in toxic air the orb stays with her then
  // (her eyes are inside it: the first-person edge glow). Only that hide, only toxic: airless / underwater / any other hidden body unchanged.
  function fpHidden(){ try{ return typeof _surfFpHidden!=='undefined'&&_surfFpHidden===true; }catch(e){ return false; } }
  function present(root,mode,toxic){ return root.visible!==false||(toxic===true&&mode==='walk'&&fpHidden()); }
  function groupSphere(mode,cam,toxic){
    const root=CHAR&&CHAR.root; _c.ok=false; if(!root||!present(root,mode,toxic)) return _c;
    root.updateWorldMatrix(true,false); const e=root.matrixWorld.elements;
    const sc=Math.hypot(e[0],e[1],e[2])||1, h=(CHAR.rawHeight||1)*sc;      // her real height in world units
    let mx=e[12], my=e[13]+h*0.5, mz=e[14], R=h*0.62, len=h*1.3; _c.px=e[12]; _c.py=e[13]+h*0.5; _c.pz=e[14]; _c.h=h;
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
    const root=window.CHAR&&CHAR.root; if(!root||!CHAR.rawHeight) return 0; root.updateWorldMatrix(true,false); const e=root.matrixWorld.elements, h=CHAR.rawHeight*(Math.hypot(e[0],e[1],e[2])||1);
    return DMHazard.register({id:'test-plume',type:'plume',gas:'volcanic',sev:0.8,shape:'column',x:e[12]+6*h,z:e[14],r:4*h,y0:e[13]-8*h,y1:e[13]+40*h});
  }
  H.gate=gateWorld;
  H.tick=function(dt){
    if(H.off||typeof PW==='undefined'||!PW.active||!PW.scene||!PW.camera) { if(H.awake){ H.awake=false; H.shieldHide(); } if(H.a>0||H.wet>0||S.fogSaved) H.hide(); return; }
    if(PW.body!==_gb||PW.pal!==_gp) gateWorld();
    if(ZONE_FLAG&&!_zid) _zid=zoneTest();   // (test flag only) retried until she exists in the world
    const mode=PW.mode, kind=_gk, W=window.JOTS_WATER;
    if(mode!=='fly'&&mode!=='walk'){ if(H.awake){ H.awake=false; H.shieldHide(); } if(H.a>0||H.wet>0||S.fogSaved||S.front&&S.front.visible) H.hide(); haveLast=false; return; }
    // SAFE MAP, nothing near, no dive: this whole feature sleeps here (one boolean test per frame; no groupSphere, no shield, no mesh, no material, no light)
    const wake=H.hostile||SH.armed||HZ.near, dive=!!(W&&mode==='fly'&&PW.board&&PW.board.position.y<(W.surfaceY||0)+40)||H.a>0.01||H.wet>0.01||S.fogSaved;
    if(!wake&&!dive){ if(H.awake){ H.awake=false; H.shieldHide(); if(S.scene&&S.front&&S.front.visible) H.hide(); haveLast=false; } return; }
    H.awake=true; dt=Math.min(0.1,Math.max(0.001,dt||1/60));
    const cam=PW.camera, g=groupSphere(mode,cam,kind==='toxic');
    // the shield (toggle, board-group field, crown glow + LED): independent of the orb's own compile state
    if(wake){ if(g.ok){ try{ shFrame(dt,kind,mode,g); }catch(e){ if(!SH.busy){ SH.busy=true; console.warn('[shield]',e&&e.stack||e); } shOff(); } } else shOff(); }
    // the orb's GPU objects are built / attached only where an orb can ever show: toxic or airless air, an armed shield, or a dive on the board
    if(!S.scene&&kind==='breathable'&&!SH.armed&&!(W&&mode==='fly')){ if(H.a>0||H.wet>0) H.hide(); haveLast=false; return; }
    if(!attach(PW.scene,PW.renderer||(typeof flightRenderer!=='undefined'?flightRenderer:null))) return;
    if(!S.ready){ return; }
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
    let tgt=0;
    if(kind==='toxic') tgt=1; else if(kind==='airless') tgt=0.42; else if(SH.armed) tgt=1;   // (an armed shield on a healthy planet: a local hazard)
    if(!SH.on) tgt=0;                          // (DMShield) orb toggled off: the board group protects her instead (crown glow), no orb is drawn
    const bay=bayLevel(); H.dis=ease(H.dis,bay,4,dt);
    const wantBlue=H.wet>0.5?1:0;
    const tOrb=Math.max(tgt*(1-H.wet), H.wet);              // underwater the blue mist orb takes over from the green one
    H.blue=ease(H.blue,wantBlue,5,dt);
    H.a=ease(H.a,tOrb*(1-H.dis),tOrb>H.a?1.6:2.4,dt);       // slow fade in, quicker out
    if(tOrb*(1-H.dis)<0.001&&H.a<0.02) H.a=0;               // fully off (not an asymptote): below this the orb is hidden, not drawn, not in the transparent pass
    const cg=window.DMCGroup, extern=cg&&typeof cg.intensity==='number'&&cg.intensity>0;
    const loc=0.85+Math.min(0.5,spd/Math.max(0.5,g.len*5))+H.wet*0.5;
    H.inten=ease(H.inten,extern?cg.intensity:loc,5,dt);
    if(extern&&H.wet>0.5){ boostT-=dt; if(boostT<=0&&cg.boost){ try{ cg.boost('swim',1.4,0.5); }catch(e){} boostT=0.25; } }
    // radius settles smoothly; the centre never lags the board
    H.R=H.R>0&&H.a>0.02?ease(H.R,g.R,10,dt):g.R;
    tPh+=dt*(0.55+0.45*H.inten);
    const u=S.u; u.c.value.set(g.x,g.y,g.z); u.R.value=H.R; u.ph.value=tPh;
    u.a.value=Math.min(0.85,H.a)*(0.8+0.2*H.blue); u.dis.value=H.dis; u.asp.value=(window.innerWidth||1)/Math.max(1,window.innerHeight||1); u.blue.value=H.blue; u.k.value=0.88+0.12*H.inten;
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
      if(!S.fogSaved){ S.fog=sc.fog||null; S.fogWas=!!sc.fog; if(!sc.fog) sc.fog=(S.fogObj||(S.fogObj=new THREE.Fog(0x0b3a5c,1,1000))); S.fog=sc.fog; S.fogCol=sc.fog.color.getHex(); S.fogSaved=true; }
      if(sc.fog&&sc.fog===S.fog){ sc.fog.color.copy(tu.col.value); sc.fog.near=1; sc.fog.far=sc.fog.far+(Math.max(40,260-tu.depth.value*140)-sc.fog.far)*tw; }
    } else if(S.fogSaved) restoreFog();
    // bubbles
    if(H.wet>0.02||S.bub.visible) bubbles(dt,H.wet,g.x,g.y-g.R*0.15,g.z,spd,g.len,surfY,hx,hz);
  };
  H.setOff=function(v){ H.off=!!v; if(H.off) H.hide(); };
})();
