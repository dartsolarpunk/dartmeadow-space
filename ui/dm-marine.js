/* dm-marine.js — marine life for oceans and underwater areas (extends the JOTS creature system; hooked from ui/dm-creatures.js).
   Fish schools (boids), rays, jellyfish, turtles, seals, dolphins, whales, crabs, plus swaying kelp / coral / anemones,
   and an alien kit (re-rolled per seeded world) on non-Earth oceans. They react to Ariel riding past: schools scatter,
   dolphins / rays / turtles / seals come to look and follow, the flora bends away from her wake.
   Drawing: one InstancedMesh per species (≤ a handful of draw calls); every animation (tail wave, wing flap, bell pulse,
   kelp sway) runs on the GPU in TSL from per-instance attributes — no skeletons, no mixers, no per-frame THREE objects.
   Models: assets/marine/*.glb (rest-pose baked, ~25-130 KB each), fetched lazily the first time a species is needed and
   never precached; an LRU memory budget (mobile / desktop) evicts idle species. AI: ui/marine/jots-ai.js (vendored).
   Seeding: its own derived stream 'marine:v1:<body>:<seed>:...' — never touches terrain or world seeds, no Math.random.
   Zero cost when the rider is not in / near water (one global read per frame). Kill switch: ?marine=0 (or ?creatures=0 / ?places=0). */
(function(root){
'use strict';
const C=root.DMPlacesCore; if(!C) return;
const Q=new URLSearchParams(root.location&&root.location.search||'');
const OFF=Q.get('marine')==='0'||Q.get('creatures')==='0'||Q.get('places')==='0';
const CS=root.document&&root.document.currentScript, SRC=(CS&&CS.src)||'', VQ=(SRC.match(/[?&]v=(\d+)/)||[])[1]||'';
const BASE=Q.get('marinebase')||'assets/marine/';
const CELL=36, TAU=6.283185307179586;
const PROBE=[[0,0],[22,0],[-22,0],[0,22],[0,-22],[16,16],[-16,16],[16,-16],[-16,-16]];   // near-water probe offsets (numbers, no THREE)
const S={ready:false,T:null,env:null,man:0,ai:null,aiM:null,aiState:0,bt:new Map(),loadQ:[],loading:0,w:null,on:false,mem:0,cells:new Map(),cellId:0,
  tA:0,rt:0,idleT:0,pt:0,eWait:0,psp:0,wet:false,pause:false,sleepTimer:0,U:null,TMP:null,own:null,phase:null,nBt:0,spB:[],px:0,py:0,pz:0,havePrev:false,
  stats:{active:false,agents:0,flora:0,draws:0,cells:0,species:0,loaded:0,memMB:0,ms:0,ai:0,follow:0,scares:0}};
const mob=()=>!!(S.env&&S.env.GFX&&S.env.GFX.isMobile);
const BUDGET=()=>(mob()?24:56)*1048576;
const AICAP=()=>mob()?110:260, FLORA_CAP=()=>mob()?70:170;

// ───────────────────────── pure planning (no THREE, no globals, no Math.random) ─────────────────────────
const wpick=(arr,tot,r)=>{ let p=r*tot; for(let i=0;i<arr.length;i++){ p-=arr[i].w; if(p<=0) return arr[i]; } return arr[arr.length-1]; };
/** The species kit of one world: Earth gets the Earth set; every other ocean gets a seeded alien subset with its own palette/sizes. */
function kitFor(man,name,seed,maxFauna,maxFlora){
  const earth=/^earth$/i.test(String(name||'')), set=earth?'earth':'alien';
  const r=C.rng(C.h32('marine:v1:'+name+':'+seed+':kit'));
  const fa=[],fl=[]; for(const id of Object.keys(man.species).sort()){ const m=man.species[id].m; if(m.set!==set) continue; (m.role==='flora'?fl:fa).push(id); }
  const shuf=a=>{ for(let i=a.length-1;i>0;i--){ const j=Math.floor(r()*(i+1)); const t=a[i]; a[i]=a[j]; a[j]=t; } return a; };
  const hue=r(); let F=shuf(fa.slice()), L=shuf(fl.slice());
  if(!earth){ F=F.slice(0,5+Math.floor(r()*3)); if(!F.some(id=>man.species[id].m.role==='jelly')){ const j=fa.find(id=>man.species[id].m.role==='jelly'); if(j) F[F.length-1]=j; } L=L.slice(0,2+Math.floor(r()*2)); }
  if(maxFauna&&F.length>maxFauna) F=F.slice(0,maxFauna); if(maxFlora&&L.length>maxFlora) L=L.slice(0,maxFlora);
  const mk=(ids,off)=>ids.map((id,i)=>{ const m=man.species[id].m; return {id,w:m.w,mul:earth?1:0.8+0.55*r(),hue:earth?-1:(hue+off+i*0.13+r()*0.05)%1}; });
  return {earth,set,name:String(name),seed,hue:earth?-1:hue,fauna:mk(F,0),flora:mk(L,0.5)};
}
/** One habitat cell → what lives there. hf(x,z) = seabed height, sy = sea level, fl = lowest swimmable y. Pure and deterministic. */
function planCell(kit,man,cx,cz,hf,sy,fl){
  const base='marine:v1:'+kit.name+':'+kit.seed+':'+cx+':'+cz, r=C.rng(C.h32(base)), out={fauna:null,flora:[],h:C.h32(base+':ai')};
  const x0=cx*CELL, z0=cz*CELL;
  if(r()<0.62&&kit.fauna.length){   // a group lives here
    let x=0,z=0,D=-1,k=0; for(;k<3;k++){ x=x0+(0.15+0.7*r())*CELL; z=z0+(0.15+0.7*r())*CELL; D=sy-hf(x,z); if(D>=0.45) break; }
    const rr=r(), rn=r(), ry=r();
    if(D>=0.45){
      const ok=kit.fauna.filter(e=>{ const m=man.species[e.id].m; return D>=m.D[0]&&D<=m.D[1]; });
      if(ok.length){ let tot=0; for(const e of ok) tot+=e.w; const e=wpick(ok,tot,rr), d=man.species[e.id], m=d.m;
        const n=m.n[0]+Math.floor(rn*(m.n[1]-m.n[0]+1)); const lim=Math.min(D,sy-fl);
        let d1=Math.min(m.depth[1],lim-0.8), d0=Math.min(m.depth[0],d1-0.4); if(d0<0.4) d0=0.4; if(d1<d0) d1=d0;
        out.fauna={id:e.id,n,x,z,y:sy-(d0+(d1-d0)*ry),mul:e.mul,D};
        if(m.role==='crawler'){ out.fauna.pts=[]; for(let i=0;i<n;i++){ const px=x+(r()-0.5)*8, pz=z+(r()-0.5)*8, dd=sy-hf(px,pz); if(dd>=0.45&&dd>=m.D[0]&&dd<=m.D[1]) out.fauna.pts.push(px,pz); } if(!out.fauna.pts.length) out.fauna=null; }
      }
    }
  }
  const np=r()<0.55?(r()<0.3?2:1):0;   // flora patches
  for(let p=0;p<np&&kit.flora.length;p++){
    let x=0,z=0,D=-1; for(let k=0;k<3;k++){ x=x0+(0.1+0.8*r())*CELL; z=z0+(0.1+0.8*r())*CELL; D=sy-hf(x,z); if(D>=0.8) break; }
    const rr=r(); if(D<0.8) continue;
    const ok=kit.flora.filter(e=>{ const m=man.species[e.id].m; return D>=m.D[0]&&D<=m.D[1]; }); if(!ok.length) continue;
    let tot=0; for(const e of ok) tot+=e.w; const e=wpick(ok,tot,rr), m=man.species[e.id].m, n=m.n[0]+Math.floor(r()*(m.n[1]-m.n[0]+1)), hgt=m.bb[1][1];
    for(let i=0;i<n;i++){ const a=r()*TAU, d=Math.sqrt(r())*7, fx=x+Math.cos(a)*d, fz=z+Math.sin(a)*d, y=hf(fx,fz), dep=sy-y, yaw=r()*TAU, s0=r(), ph=r()*100;
      if(dep<Math.max(0.6,m.D[0]*0.6)||dep>m.D[1]*1.15) continue;
      let s=m.scale[0]+(m.scale[1]-m.scale[0])*s0; s*=e.mul; const cap=(dep-0.35)/hgt; if(s>cap) s=cap; if(s<0.3) continue;
      out.flora.push({id:e.id,x:fx,y,z:fz,yaw,s,ph}); }
  }
  return out;
}

// ───────────────────────── seabed height cache (bilinear on a 2 m grid, direct-mapped, allocation free) ─────────────────────────
const GN=8192, GKX=new Int32Array(GN), GKZ=new Int32Array(GN), GV=new Float32Array(GN); let GH=null;
function gNode(ix,iz){ const h=((Math.imul(ix,73856093)^Math.imul(iz,19349663))>>>0)&(GN-1); if(GKX[h]===ix&&GKZ[h]===iz) return GV[h]; const v=GH(ix*2,iz*2); GKX[h]=ix; GKZ[h]=iz; GV[h]=v; return v; }
function gH(x,z){ const fx=x*0.5, fz=z*0.5, ix=Math.floor(fx), iz=Math.floor(fz), tx=fx-ix, tz=fz-iz;
  const a=gNode(ix,iz), b=gNode(ix+1,iz), c=gNode(ix,iz+1), d=gNode(ix+1,iz+1); return (a+(b-a)*tx)*(1-tz)+(c+(d-c)*tx)*tz; }
function gReset(H){ GH=H; GKX.fill(0x7fffffff); }

// ───────────────────────── GPU materials (TSL) ─────────────────────────
function weights(geo,m){   // per-vertex animation weights: x = amplitude weight, y = phase / depth along the body
  const p=geo.attributes.position, n=p.count, arr=new Float32Array(n*2), mn=m.bb[0], mx=m.bb[1], a=m.anim;
  const zl=Math.max(1e-4,mx[2]-mn[2]), hy=Math.max(1e-4,mx[1]-mn[1]), hx=Math.max(1e-4,Math.max(mx[0],-mn[0]));
  const bellY=mx[1]-0.45*hy, ss=t=>t<=0?0:t>=1?1:t*t*(3-2*t);
  for(let i=0;i<n;i++){ const x=p.getX(i), y=p.getY(i), z=p.getZ(i); let w=0, ph=0;
    if(a.mode==='wave'){ let u=(mx[2]-z)/zl; u=u<0?0:u>1?1:u; w=Math.pow(u,1.4); ph=u; }
    else if(a.mode==='flap'){ const ax=Math.min(1,Math.abs(x)/hx); w=Math.pow(ax,1.3); ph=a.alt?((z-mn[2])/zl+(x>0?0.5:0)):-ax; }
    else if(a.mode==='sway'){ const h=Math.max(0,(y-mn[1])/hy); w=Math.pow(h,1.6); ph=h; }
    else { const bm=ss((y-(bellY-0.1*hy))/(0.2*hy)); w=bm; ph=(1-bm)*Math.min(1,Math.max(0,(bellY-y)/Math.max(1e-4,bellY-mn[1]))); }
    arr[i*2]=w; arr[i*2+1]=ph; }
  const ext=a.mode==='wave'?zl:a.mode==='flap'?hx:hy; return {arr,ext};
}
function makeMaterial(b,src,ext,tint){
  const T=S.T, t=T.TSL, a=b.m.anim, U=S.U;
  const {attribute,positionGeometry,normalGeometry,vec3,float,sin,cos,cross,clamp,max,length}=t;
  const aP=attribute('aP','vec4'), aQ=attribute('aQ','vec4'), aT=attribute('aT','float'), aW=attribute('aW','vec2');
  const L=positionGeometry, flora=a.mode==='sway', tt=flora?aT.add(U.time):aT, A=a.amp*ext;
  let off;
  if(a.mode==='pulse'){
    const p=sin(tt.mul(a.freq)), sw=sin(tt.mul(a.freq*0.55).sub(aW.y.mul(3.0))), cw=cos(tt.mul(a.freq*0.43).sub(aW.y.mul(2.3)));
    off=vec3(L.x,0,L.z).mul(p.mul(a.radial).mul(aW.x)).add(vec3(0,1,0).mul(p.mul(a.lift*ext).mul(aW.x).negate())).add(vec3(sw.mul(A),0,cw.mul(A*0.7)).mul(aW.y));
  } else if(flora){
    const s1=sin(tt.mul(a.freq).add(aW.y.mul(a.k))), s2=sin(tt.mul(a.freq*0.83).add(aW.y.mul(a.k*1.3)).add(1.7));
    off=vec3(s1,0,s2).mul(aW.x.mul(A));
  } else {
    const s1=sin(tt.mul(a.freq).add(aW.y.mul(a.k))), ax=a.axis==='y'?vec3(0,1,0):vec3(1,0,0);
    off=ax.mul(s1.mul(aW.x).mul(A));
  }
  const v=L.add(off).mul(aP.w), q=aQ.xyz, qw=aQ.w;
  const rot=x=>{ const k=cross(q,x).mul(2.0); return x.add(k.mul(qw)).add(cross(q,k)); };
  let wp=rot(v).add(aP.xyz);
  if(flora){   // bend away from the rider's wake
    const d=wp.xz.sub(U.pl.xz), dist=length(d), k=clamp(float(1).sub(dist.div(U.pr)),0,1);
    wp=wp.add(vec3(d.x,0,d.y).div(max(dist,0.05)).mul(k.mul(k).mul(aW.x).mul(aP.w).mul(a.push||0.5)));
  }
  const M=new T.MeshStandardNodeMaterial();
  M.color.copy(src.color); if(tint) M.color.multiply(tint); M.map=src.map||null; M.emissive.copy(src.emissive); M.emissiveMap=src.emissiveMap||null; M.emissiveIntensity=src.emissiveIntensity;
  M.roughness=src.roughness; M.metalness=src.metalness; M.side=src.side; M.transparent=!!src.transparent; M.opacity=src.opacity; M.alphaTest=src.alphaTest; M.alphaMap=src.alphaMap||null;
  M.depthWrite=!src.transparent; M.fog=true;
  M.positionNode=wp; M.normalNode=t.transformNormalToView?t.transformNormalToView(rot(normalGeometry)):rot(normalGeometry);
  return M;
}

// ───────────────────────── species batches (one GLB → one InstancedMesh per primitive) ─────────────────────────
function batchOf(id){
  let b=S.bt.get(id); if(b) return b; const d=S.man.species[id]; if(!d) return null;
  const m=d.m, fl=m.role==='flora', cap=fl?FLORA_CAP():(m.role==='school'?(mob()?70:130):m.role==='jelly'?(mob()?24:44):(mob()?14:28));
  b={id,d,m,flora:fl,state:0,cap:Math.min(cap,fl?FLORA_CAP():AICAP()),meshes:[],n:0,nPrev:0,hw:0,live:0,last:0,retry:0,mem:m.mem,idx:-1,hue:-1,mul:1,
     bx0:0,bx1:0,by0:0,by1:0,bz0:0,bz1:0};
  S.bt.set(id,b); return b;
}
function request(id){   // returns the batch if its model is ready, else queues it (or null when over budget / failed)
  const b=batchOf(id); if(!b) return null; const now=performance.now(); b.last=now;
  if(b.state===2) return b;
  if(b.state===0||(b.state===-2&&now>b.retry)){ if(S.mem+b.mem>BUDGET()&&!evict(b.mem,b)){ b.state=-2; b.retry=now+8000; return null; } b.state=1; S.mem+=b.mem; S.loadQ.push(b); }
  return null;
}
function pump(){
  if(S.loading||!S.loadQ.length||!S.T) return; const b=S.loadQ.shift(); S.loading=1; if(!S.loader) S.loader=new S.T.GLTFLoader();
  S.loader.load(BASE+b.m.file+(VQ?'?v='+VQ:''),g=>{ try{ build(b,g); b.state=2; S.stats.loaded++; }catch(e){ console.warn('[marine]',b.id,e); b.state=-1; S.mem-=b.mem; } S.loading=0; },
    undefined,()=>{ b.state=-1; S.mem-=b.mem; S.loading=0; });
}
function build(b,g){
  const T=S.T, W=S.w, cap=b.cap, ms=[]; g.scene.traverse(o=>{ if(o.isMesh) ms.push(o); }); if(!ms.length) throw new Error('no mesh');
  b.aP=new T.InstancedBufferAttribute(new Float32Array(cap*4),4); b.aQ=new T.InstancedBufferAttribute(new Float32Array(cap*4),4);
  b.aT=new T.InstancedBufferAttribute(new Float32Array(cap),1); for(const a of [b.aP,b.aQ,b.aT]) a.setUsage(T.DynamicDrawUsage);
  const k=b.aQ.array; for(let i=0;i<cap;i++) k[i*4+3]=1;
  if(b.flora){ b.fx=new Float32Array(cap); b.fy=new Float32Array(cap); b.fz=new Float32Array(cap); b.used=new Uint8Array(cap); b.fs=new Float32Array(cap); b.free=[]; }
  let tint=null; if(b.hue>=0){ tint=new T.Color(); tint.setHSL(b.hue,0.5,0.74); }
  for(const o of ms){
    const geo=o.geometry, wt=weights(geo,b.m); geo.setAttribute('aW',new T.BufferAttribute(wt.arr,2)); geo.setAttribute('aP',b.aP); geo.setAttribute('aQ',b.aQ); geo.setAttribute('aT',b.aT);
    const mat=makeMaterial(b,o.material,wt.ext,tint), im=new T.InstancedMesh(geo,mat,cap); im.count=0; im.frustumCulled=false; im.visible=false; im.castShadow=false; im.receiveShadow=false;
    im.userData.noBend=true; im.renderOrder=mat.transparent?3:2; im.name='JOTS_Marine_'+b.id; W.G.add(im); b.meshes.push(im);
  }
  b.gltf=g.scene;
}
function disposeBatch(b){
  for(const im of b.meshes){ if(im.parent) im.parent.remove(im); im.geometry.dispose(); const m=im.material; if(m){ for(const k of ['map','emissiveMap','alphaMap']) if(m[k]) m[k].dispose(); m.dispose(); } if(im.dispose) im.dispose(); }
  b.meshes=[]; b.gltf=null; b.aP=b.aQ=b.aT=null; if(b.state===2||b.state===1) S.mem-=b.mem; b.state=0; b.n=b.nPrev=b.hw=b.live=0; S.stats.loaded=Math.max(0,S.stats.loaded-1);
}
function evict(need,keep){   // free idle (nothing alive) species, oldest first
  const c=[]; for(const b of S.bt.values()) if(b!==keep&&b.state===2&&b.live===0&&b.nPrev===0) c.push(b); c.sort((p,q)=>p.last-q.last);
  for(const b of c){ if(S.mem+need<=BUDGET()) break; disposeBatch(b); } return S.mem+need<=BUDGET();
}

// ───────────────────────── AI, cells, spawning ─────────────────────────
function mkAI(){
  const man=S.man, w=S.w, sp={profiles:man.profiles,species:{}}, kit=w.kit;
  const ids=S.showAll?Object.keys(man.species).filter(k=>man.species[k].m.role!=='flora').map(k=>({id:k})):kit.fauna;   // (showAll: test harness only)
  for(const e of ids){ const d=man.species[e.id]; if(!d.profile) continue; const o={profile:d.profile,name:d.name,depth:d.depth,journal:d.journal}; if(d.lateral) o.lateral=true; Object.assign(o,JSON.parse(JSON.stringify(d.over||{}))); sp.species[e.id]=o; }
  const ai=new S.aiM.CreatureAI({capacity:AICAP(),species:sp,quality:mob()?'low':'med',world:{groundHeight:gH,waterY:0},seed:C.h32('marine:v1:'+kit.name+':'+kit.seed+':ai')});
  S.spB=new Array(ai.spec.length); S.own=new Int32Array(ai.cap); S.phase=new Float32Array(ai.cap); S.ai=ai; return ai;
}
const cellKey=(cx,cz)=>(cx+32768)*65536+(cz+32768);
function spawnCell(w,env,cx,cz,hf,sy,fl){
  const man=S.man, plan=planCell(w.kit,man,cx,cz,hf,sy,fl), ai=S.ai;
  let ready=true, fb=null;
  if(plan.fauna){ fb=request(plan.fauna.id); if(!fb){ const b=S.bt.get(plan.fauna.id); if(b&&b.state===1) ready=false; else plan.fauna=null; } }
  const fset=new Set(); for(const f of plan.flora) fset.add(f.id);
  for(const id of fset){ const b=request(id); if(!b){ const q=S.bt.get(id); if(q&&q.state===1) ready=false; } }
  if(!ready) return false;
  const cell={id:++S.cellId,cx,cz,gids:[],fl:[]}; S.cells.set(cellKey(cx,cz),cell);
  const F=plan.fauna; 
  if(F&&fb){
    const sd=man.species[F.id], m=sd.m, idx=ai.specIndex[F.id];
    if(idx!==undefined&&fb.nPrev+fb.live+F.n<=fb.cap&&ai.n-ai.freeN+F.n<=ai.cap){
      ai.seed=plan.h; S.spB[idx]=fb; fb.idx=idx; fb.mul=F.mul;
      const AIsp=ai.spec[idx], grp=AIsp.flock.on&&F.n>1&&m.role!=='crawler';
      let ids=[];
      if(m.role==='crawler'){ for(let i=0;i<F.pts.length;i+=2){ const x=F.pts[i], z=F.pts[i+1], y=hf(x,z); const a=ai.spawn(F.id,x,y,z,{}); if(a>=0) ids.push(a); } }
      else if(grp){ const g=ai.spawnGroup(F.id,F.n,F.x,F.y,F.z,Math.max(1.5,Math.sqrt(F.n)*(m.role==='school'?1.1:2.2)),{wander:m.role==='jelly'?14:undefined}); cell.gids.push(g);
        if(ai._gax){ ai._gax[g]=F.x; ai._gay[g]=F.y; ai._gaz[g]=F.z; } }   // (the AI caches group anchors once; keep new groups' anchors current)
      else for(let i=0;i<F.n;i++){ const a=ai.spawn(F.id,F.x+(i%2?1:-1)*(i>0?6+i*3:0),F.y+(i>0?(i%3-1)*2:0),F.z+(i>1?5*i:0),{}); if(a>=0) ids.push(a); }
      for(let i=0;i<ai.n;i++) if(ai.alive[i]&&S.own[i]===0&&ai.sp[i]===idx&&(ids.length?ids.indexOf(i)>=0:ai.grp[i]>=0&&cell.gids.indexOf(ai.grp[i])>=0)) S.own[i]=cell.id;
    }
  }
  for(const f of plan.flora){ const b=S.bt.get(f.id); if(!b||b.state!==2) continue; if(S.stats.flora>=FLORA_CAP()*4) break;
    let s=b.free.length?b.free.pop():(b.hw<b.cap?b.hw++:-1); if(s<0) continue;
    b.used[s]=1; b.fx[s]=f.x; b.fy[s]=f.y; b.fz[s]=f.z; b.fs[s]=f.s; b.live++;
    const h=f.yaw*0.5, q=b.aQ.array; q[s*4]=0; q[s*4+1]=Math.sin(h); q[s*4+2]=0; q[s*4+3]=Math.cos(h); b.aT.array[s]=f.ph; cell.fl.push(b,s); }
  return true;
}
function dropCell(cell){
  const ai=S.ai; if(ai){ for(let i=0;i<ai.n;i++) if(ai.alive[i]&&S.own[i]===cell.id){ ai.despawn(i); S.own[i]=0; } for(const g of cell.gids) ai.gUsed[g]=0; }
  for(let i=0;i<cell.fl.length;i+=2){ const b=cell.fl[i], s=cell.fl[i+1]; if(b.used&&b.used[s]){ b.used[s]=0; b.aP.array[s*4+3]=0; b.free.push(s); b.live--; } }
}
function clearCells(){
  for(const c of S.cells.values()) dropCell(c); S.cells.clear();
  if(S.ai){ S.ai.gUsed.fill(0); S.own.fill(0); }
  for(const b of S.bt.values()){ b.n=b.nPrev=0; b.live=0; for(const im of b.meshes){ im.count=0; im.visible=false; } if(b.flora&&b.used){ b.used.fill(0); b.free.length=0; b.hw=0; } }
}

// ───────────────────────── world binding / lifecycle ─────────────────────────
function init(env){
  if(S.ready) return true; const T=env.THREE; if(!T||!T.GLTFLoader||!T.TSL||!T.MeshStandardNodeMaterial||!T.InstancedMesh) return false;
  S.env=env; S.T=T; S.ready=true;
  S.U={time:T.TSL.uniform(0),pl:T.TSL.uniform(new T.Vector3()),pr:T.TSL.uniform(7)};
  S.TMP={v:new T.Vector3(),m:new T.Matrix4(),fr:new T.Frustum(),sp:new T.Sphere()};
  S.man=0;   // 0 = loading, -1 = failed, object = ready (fetched once, the first time water is near)
  fetch(BASE+'marine.json'+(VQ?'?v='+VQ:'')).then(r=>r.ok?r.json():null).then(j=>{ S.man=(j&&j.species)?j:-1; }).catch(()=>{ S.man=-1; });
  S.aiState=1; try{ import(new URL('marine/jots-ai.js'+(VQ?'?v='+VQ:''),SRC||root.location.href).href).then(m=>{ S.aiM=m; S.aiState=2; }).catch(()=>{ S.aiState=-1; }); }catch(e){ S.aiState=-1; }
  return true;
}
function bind(env){
  const PW=env.PW; if(S.w&&S.w.gen===PW.gen) return S.w; if(S.w) unbind();
  const T=S.T, G=new T.Group(); G.name='JOTS_Marine'; G.userData.noBend=true; G.visible=false; PW.scene.add(G);
  const F=PW.ground&&PW.ground.F, seed=F&&F.seed!==undefined?F.seed:0, name=PW.body&&PW.body.name||'';
  const w={gen:PW.gen,G,name,seed,kit:kitFor(S.man,name,seed,mob()?6:0,mob()?2:0)}; S.w=w; gReset(env.TERRAIN.H);
  S.stats.species=w.kit.fauna.length+w.kit.flora.length; S.ai=null; return w;
}
function unbind(){
  const w=S.w; if(!w) return; clearTimeout(S.sleepTimer); clearCells();
  for(const b of S.bt.values()){ if(b.meshes.length) disposeBatch(b); } S.bt.clear(); S.loadQ.length=0; S.mem=0; S.loading=0; S.stats.loaded=0;
  if(w.G.parent) w.G.parent.remove(w.G); S.w=null; S.ai=null; S.on=false; S.havePrev=false; S.spB=[];
}
function sleep(){
  if(!S.on) return; S.on=false; clearCells(); if(S.w) S.w.G.visible=false; S.stats.active=false; S.stats.agents=0; S.stats.flora=0; S.stats.draws=0;
  clearTimeout(S.sleepTimer); S.sleepTimer=setTimeout(()=>{ if(!S.on){ for(const b of S.bt.values()) if(b.meshes.length&&b.live===0) disposeBatch(b); S.mem=0; for(const b of S.bt.values()) if(b.state===2||b.state===1) S.mem+=b.mem; } },60000);
}
function onWorldClose(){ unbind(); }

// ───────────────────────── per frame ─────────────────────────
function tick(dt,env,paused){
  if(OFF) return;
  const W=root.JOTS_WATER;
  if(!W||paused||!env||!env.PW||!env.PW.active){ if(S.on) sleep(); return; }
  const PW=env.PW, mode=PW.mode;
  if((mode!=='fly'&&mode!=='walk'&&mode!=='surf')||!PW.scene||!PW.camera||!PW.ground||!env.TERRAIN||!env.TERRAIN.H){ if(S.on) sleep(); return; }
  const f=mode==='fly'?env.atmoState():env.surfPlayer(); if(!f){ if(S.on) sleep(); return; }
  const fp=f.pos||f, fx=fp.x, fy=fp.y, fz=fp.z, sy=W.surfaceY, H=env.TERRAIN.H, under=fy<sy-0.15;
  let near=under;
  if(!under){ if(fy>sy+36){ S.wet=false; } else { S.pt-=dt; if(S.pt<=0){ S.pt=0.7; let wet=false; for(let i=0;i<PROBE.length&&!wet;i++) if(H(fx+PROBE[i][0],fz+PROBE[i][1])<sy-0.9) wet=true; S.wet=wet; } } near=S.wet; }
  if(!near){ if(S.on){ S.idleT+=dt; if(S.idleT>2.5) sleep(); } return; }
  S.idleT=0;
  if(!S.ready&&!init(env)) return; if(!S.man||S.man===-1||S.aiState!==2) return;
  if(PW.body&&PW.body.name==='Earth'&&env.earthReady&&!env.earthReady()&&(S.eWait+=dt)<20) return;   // the real relief map arrives async: plan once it is in (≤20 s wait)
  const t0=performance.now(), w=bind(env), T=S.T, m=S.TMP, map=env.pwfMap;
  if(!S.ai) mkAI(); const ai=S.ai; ai.world.waterY=sy;
  if(!S.on){ S.on=true; w.G.visible=true; if(w.G.parent!==PW.scene) PW.scene.add(w.G); S.havePrev=false; ai.plx=fx; ai.ply=fy; ai.plz=fz; }
  if(dt>0.1) dt=0.1; S.tA+=dt; S.U.time.value+=dt; S.U.pl.value.set(0,0,0);
  pump();
  const R=under?(mob()?58:84):(mob()?34:46), Rc=Math.max(R*1.7,95), lim=W.floorY!==undefined?W.floorY:sy-36, cull2=Rc*Rc;
  // player + wake
  ai.setPlayer(fx,fy,fz,dt);
  S.rt+=dt; if(S.rt>=0.25){ const tt=S.rt; S.rt=0; if(S.havePrev){ const vx=(fx-S.px)/tt, vy=(fy-S.py)/tt, vz=(fz-S.pz)/tt, sp=Math.sqrt(vx*vx+vy*vy+vz*vz); reactions(ai,fx,fy,fz,vx,vy,vz,sp); } S.px=fx; S.py=fy; S.pz=fz; S.havePrev=true; }
  // fill the habitat band: one cell per frame, nearest first
  const c0x=Math.floor((fx-R)/CELL), c1x=Math.floor((fx+R)/CELL), c0z=Math.floor((fz-R)/CELL), c1z=Math.floor((fz+R)/CELL); let bestK=null,bx=0,bz=0,bd=1e18;
  for(let cz=c0z;cz<=c1z;cz++) for(let cx=c0x;cx<=c1x;cx++){ const dx=(cx+0.5)*CELL-fx, dz=(cz+0.5)*CELL-fz, d=dx*dx+dz*dz; if(d>(R+CELL*0.5)*(R+CELL*0.5)||S.cells.has(cellKey(cx,cz))) continue; if(d<bd){ bd=d; bx=cx; bz=cz; bestK=1; } }
  if(bestK&&!S.noCells) spawnCell(w,env,bx,bz,gH,sy,lim);
  for(const [k,c] of S.cells){ const dx=(c.cx+0.5)*CELL-fx, dz=(c.cz+0.5)*CELL-fz; if(dx*dx+dz*dz>(R*1.45+CELL)*(R*1.45+CELL)){ dropCell(c); S.cells.delete(k); } }
  // simulate
  ai.update(dt);
  // draw: pack agents into the per-species instance buffers
  m.m.multiplyMatrices(PW.camera.projectionMatrix,PW.camera.matrixWorldInverse); m.fr.setFromProjectionMatrix(m.m,PW.camera.coordinateSystem);
  for(const b of S.bt.values()){ b.n=0; b.bx0=b.by0=b.bz0=1e18; b.bx1=b.by1=b.bz1=-1e18; }
  const v=m.v, ph=S.phase; let nAg=0;
  for(let i=0;i<ai.n;i++){
    if(!ai.alive[i]) continue; const dx=ai.px[i]-fx, dz=ai.pz[i]-fz, dy=ai.py[i]-fy;
    if(dx*dx+dz*dz+dy*dy>cull2){ ai.despawn(i); S.own[i]=0; continue; }
    const b=S.spB[ai.sp[i]]; if(!b||b.state!==2||!b.aP) continue; const k=b.n; if(k>=b.cap) continue; b.n=k+1; nAg++;
    map(ai.px[i],ai.py[i],ai.pz[i],v);
    const a=b.aP.array, q=b.aQ.array, cs=ai.clipSpeed[i]; ph[i]+=dt*(cs<0.5?0.5:cs>2.5?2.5:cs);
    const sc=b.m.scale*b.mul*(0.88+0.24*ai.tint[i]); a[k*4]=v.x; a[k*4+1]=v.y; a[k*4+2]=v.z; a[k*4+3]=sc;
    const h1=ai.pitch[i]*0.5, h2=ai.yaw[i]*0.5, h3=ai.roll[i]*0.5, c1=Math.cos(h1), c2=Math.cos(h2), c3=Math.cos(h3), s1=Math.sin(h1), s2=Math.sin(h2), s3=Math.sin(h3);
    q[k*4]=s1*c2*c3+c1*s2*s3; q[k*4+1]=c1*s2*c3-s1*c2*s3; q[k*4+2]=c1*c2*s3-s1*s2*c3; q[k*4+3]=c1*c2*c3+s1*s2*s3; b.aT.array[k]=ph[i];
    if(v.x<b.bx0) b.bx0=v.x; if(v.x>b.bx1) b.bx1=v.x; if(v.y<b.by0) b.by0=v.y; if(v.y>b.by1) b.by1=v.y; if(v.z<b.bz0) b.bz0=v.z; if(v.z>b.bz1) b.bz1=v.z;
  }
  let nFl=0, draws=0; const pl=S.U.pl.value;
  map(fx,fy,fz,v); pl.set(v.x,v.y,v.z); S.U.pr.value=6+Math.min(10,S.psp||0);
  for(const b of S.bt.values()){
    if(b.state!==2||!b.aP) continue;
    if(b.flora){ const a=b.aP.array;
      for(let s=0;s<b.hw;s++){ if(!b.used[s]){ a[s*4+3]=0; continue; } map(b.fx[s],b.fy[s],b.fz[s],v); a[s*4]=v.x; a[s*4+1]=v.y; a[s*4+2]=v.z; a[s*4+3]=b.fs[s]; nFl++;
        if(v.x<b.bx0) b.bx0=v.x; if(v.x>b.bx1) b.bx1=v.x; if(v.y<b.by0) b.by0=v.y; if(v.y>b.by1) b.by1=v.y; if(v.z<b.bz0) b.bz0=v.z; if(v.z>b.bz1) b.bz1=v.z; }
      b.n=b.hw; }
    b.nPrev=b.flora?0:b.n; let vis=b.n>0&&b.bx1>=b.bx0;
    if(vis){ const sp=m.sp; sp.center.set((b.bx0+b.bx1)*0.5,(b.by0+b.by1)*0.5,(b.bz0+b.bz1)*0.5); const ex=b.bx1-b.bx0, ey=b.by1-b.by0, ez=b.bz1-b.bz0; sp.radius=0.5*Math.sqrt(ex*ex+ey*ey+ez*ez)+(b.m.bb[1][2]-b.m.bb[0][2]+6)*b.m.scale*(b.flora?1:b.mul); vis=m.fr.intersectsSphere(sp); }
    for(const im of b.meshes){ im.visible=vis; im.count=b.n; }
    if(vis){ draws+=b.meshes.length; b.aP.needsUpdate=true; b.aQ.needsUpdate=true; b.aT.needsUpdate=true; }
  }
  const st=S.stats; st.active=true; st.agents=nAg; st.flora=nFl; st.draws=draws; st.cells=S.cells.size; st.memMB=S.mem/1048576; st.ai=ai.stats.ms; st.ms=performance.now()-t0;
}
// Ariel riding past: schools scatter ahead of the board (radius grows with speed); dolphins / rays / turtles / seals keep coming to look.
function reactions(ai,fx,fy,fz,vx,vy,vz,sp){
  S.psp=sp*0.5;
  if(sp>5){ const k=Math.min(2.8,1+sp/9), bx=fx+vx*0.35, by=fy+vy*0.35, bz=fz+vz*0.35; let n=0;
    for(let i=0;i<ai.n;i++){ if(!ai.alive[i]) continue; const D=ai.spec[ai.sp[i]]; if(!(D.flee.r>0)||ai.state[i]===3) continue; const r=D.flee.r*k;
      const dx=ai.px[i]-bx, dy=ai.py[i]-by, dz=ai.pz[i]-bz; if(dx*dx+dy*dy+dz*dz<r*r){ ai._enterFlee(i,D,bx,by,bz,D.flee.hold); n++; } }
    S.stats.scares+=n; }
  let nf=0; const M=S.man.species;
  for(let i=0;i<ai.n;i++){ if(!ai.alive[i]) continue; const b=S.spB[ai.sp[i]]; if(!b||!b.m.follow) continue; const st=ai.state[i]; if(st===3||st===5) continue;
    const D=ai.spec[ai.sp[i]], dx=ai.px[i]-fx, dy=ai.py[i]-fy, dz=ai.pz[i]-fz, d2=dx*dx+dy*dy+dz*dz, c=D.curious;
    if(d2<c.r*c.r*1.2&&d2>c.keep*c.keep&&ai.bold[i]>1-c.chance){ if(st!==4){ ai.prev[i]=st; ai.state[i]=4; } ai.timer[i]=5; nf++; } }
  S.stats.follow=nf;
}

// test-harness helper (contact sheets): place n of one species at a point, bypassing the habitat plan. Needs S.noCells/S.showAll set before the first tick.
function show(id,n,x,y,z,yaw,sc){
  const d=S.man&&S.man.species&&S.man.species[id], ai=S.ai; if(!d||!ai) return -1; const b=request(id); if(!b) return 0; const m=d.m, mark=-7;
  if(m.role==='flora'){ const f=b.free.length?b.free.pop():b.hw++; b.used[f]=1; b.fx[f]=x; b.fy[f]=y; b.fz[f]=z; b.fs[f]=sc||1; b.live++; const h=(yaw||0)*0.5,q=b.aQ.array; q[f*4]=0;q[f*4+1]=Math.sin(h);q[f*4+2]=0;q[f*4+3]=Math.cos(h); b.aT.array[f]=1.3; return 1; }
  const idx=ai.specIndex[id]; S.spB[idx]=b; b.mul=sc||1; let c=0;
  for(let i=0;i<n;i++){ const a=ai.spawn(id,x+(i%3)*1.2-1.2,y+((i/3)|0)*0.8,z-(i%2)*0.9,{yaw:yaw||0}); if(a>=0){ S.own[a]=mark; c++; } } return c;
}
function showClear(){ clearCells(); const ai=S.ai; if(ai) for(let i=0;i<ai.n;i++) if(ai.alive[i]){ ai.despawn(i); S.own[i]=0; } }
const api={show,showClear,tick,onWorldClose,pause(on){ S.pause=!!on; if(on) sleep(); },stats(){ return Object.assign({},S.stats,{manifest:S.man&&S.man.species?2:S.man,ai:S.aiState,on:S.on,off:OFF,batches:S.bt.size}); },
  kitFor,planCell,CELL,_S:S,get off(){ return OFF; }};
root.DMMarine=api;
if(typeof module!=='undefined'&&module.exports) module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
