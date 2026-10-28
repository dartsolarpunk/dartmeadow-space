/* dm-places.js — settlements, stations and venues in the world (JOTS Towns asset pack).
   The deterministic half is ui/dm-places-core.js (a derived RNG stream: it never touches terrain output).
   This is the streaming half: it sites them on the live ground, streams GLBs by distance
   (box → impostor → LOD1 → LOD0 + instanced props), culls them, holds a memory budget, announces a first
   approach as a discovery and lists the place in Quick Travel.   Kill switch: ?places=0

   Hooks (index.html, three one-liners): DMPlaces.tick(dt,env) in _pwWorldTick, DMPlaces.onWorldClose() at the top of
   _pwClose, DMPlaces.spaceTick(dt,env) beside updateDiscoveries; DMPlaces.qtNode(gal) in the Travel tree.
   THREE is a late module global — nothing here touches it until the first tick. No per-frame allocations. */
(function(root){
'use strict';
const C=root.DMPlacesCore; if(!C) return;
const Q=new URLSearchParams(root.location&&root.location.search||'');
const OFF=Q.get('places')==='0';
const LS_KEY='dm_places_v1';
const BASE=(Q.get('placesbase')||'assets/places/');
const S={ ready:false, T:null, defs:null, byId:null, man:0, found:null, listeners:0,
  world:null, space:null, eWait:0, cache:new Map(), mem:0, loadQ:[], loading:0, t4:0, tSp:0, tPlan:0, stats:{sites:0,l0:0,l1:0,imp:0,box:0,beacon:0,planMs:0,tickMs:0,mem:0,assets:0,props:0,orb:0} };
const mob=()=>!!(S.env&&S.env.GFX&&S.env.GFX.isMobile);
const KCOL={town:0xffd27a,village:0x9cf0b4,venue:0xff8fc8,station:0x8fe6ff,ship:0xb8a6ff,hub:0xffffff,prop:0xffffff};
let TMP=null;   // preallocated THREE temporaries (built at the first tick, when THREE exists)

// ── persistence ───────────────────────────────────────────────────────
function loadFound(){ if(S.found) return S.found; let o=null; try{ o=JSON.parse(localStorage.getItem(LS_KEY)||'null'); }catch(e){} S.found=(o&&o.items)||{}; return S.found; }
function saveFound(){ try{ localStorage.setItem(LS_KEY,JSON.stringify({v:1,items:S.found})); }catch(e){} }

// ── init ──────────────────────────────────────────────────────────────
function init(env){
  S.env=env; if(S.ready) return true; const T=env.THREE; if(!T||!T.Vector3) return false;
  S.T=T; TMP={v:new T.Vector3(),v2:new T.Vector3(),m:new T.Matrix4(),m2:new T.Matrix4(),q:new T.Quaternion(),e:new T.Euler(),s:new T.Vector3(),fr:new T.Frustum(),sp:new T.Sphere(),p:[0,0,0]};
  S.ready=true; loadFound();
  if(!S.man){ S.man=1;
    fetch(BASE+'manifest.json',{cache:'default'}).then(r=>r.ok?r.json():null).then(j=>{ if(!j){ S.man=-1; return; }
      S.defs=C.normalizeManifest(j,BASE); S.byId=Object.create(null); S.defs.forEach(d=>{ S.byId[d.id]=d; }); S.man=2;
      S.world=null; S.space=null; if(root.DMCreatures&&root.DMCreatures.onPlaces) root.DMCreatures.onPlaces(S.defs);
    }).catch(()=>{ S.man=-1; });
  }
  return true;
}
const hasDefs=()=>S.man===2&&S.defs&&S.defs.length;

// ── asset cache (GLB templates: LOD0 / LOD1 nodes, shared geometry+materials, ref-counted, LRU budget) ──
const budget=()=>mob()?96e6:300e6;
function estMem(root3){ let b=0; const seen=new Set(); root3.traverse(o=>{
  if(o.geometry&&!seen.has(o.geometry)){ seen.add(o.geometry); const g=o.geometry; for(const k in g.attributes){ const a=g.attributes[k]; b+=a.array?a.array.byteLength:0; } if(g.index) b+=g.index.array.byteLength; }
  const ms=o.material?(Array.isArray(o.material)?o.material:[o.material]):[];
  for(const m of ms) for(const k in m){ const t=m[k]; if(t&&t.isTexture&&!seen.has(t)){ seen.add(t); const im=t.image; if(im&&im.width) b+=im.width*im.height*4*1.33; } }
}); return b; }
function shrinkTextures(root3,max){
  const seen=new Set(); root3.traverse(o=>{ const ms=o.material?(Array.isArray(o.material)?o.material:[o.material]):[];
    for(const m of ms) for(const k in m){ const t=m[k]; if(t&&t.isTexture&&!seen.has(t)){ seen.add(t); const im=t.image;
      if(im&&im.width>max&&typeof document!=='undefined'){ try{ const c=document.createElement('canvas'); c.width=max; c.height=Math.max(1,Math.round(im.height*max/im.width)); c.getContext('2d').drawImage(im,0,0,c.width,c.height); if(im.close) try{ im.close(); }catch(e){} t.image=c; t.needsUpdate=true; }catch(e){} } } } });
}
function disposeTpl(a){ if(!a||!a.root) return; const seen=new Set(); a.root.traverse(o=>{
  if(o.geometry) o.geometry.dispose();
  const ms=o.material?(Array.isArray(o.material)?o.material:[o.material]):[];
  for(const m of ms){ for(const k in m){ const t=m[k]; if(t&&t.isTexture&&!seen.has(t)){ seen.add(t); t.dispose(); } } m.dispose(); } }); S.mem-=a.mem||0; a.root=null; a.lod0=a.lod1=null; }
function asset(id){ let a=S.cache.get(id); if(!a){ a={id,state:0,root:null,lod0:null,lod1:null,refs:0,last:0,mem:0}; S.cache.set(id,a); } return a; }
function reqAsset(id,now){ const a=asset(id); a.last=now||performance.now(); if(a.state===0){ a.state=1; S.loadQ.push(a); } return a; }
function pumpLoads(){
  if(S.loading||!S.loadQ.length||!S.T||!S.T.GLTFLoader) return;
  const a=S.loadQ.shift(), d=S.byId&&S.byId[a.id]; if(!d){ a.state=-1; return; }
  S.loading=1; if(!S.loader) S.loader=new S.T.GLTFLoader();
  const T=S.T, env=S.env;
  S.loader.load(d.url,gltf=>{
    try{
      const r=gltf.scene||gltf.scenes[0]; r.userData.noBendRoot=0;
      const n0=r.getObjectByName(d.id+'_LOD0')||r.getObjectByName('LOD0'), n1=r.getObjectByName(d.id+'_LOD1')||r.getObjectByName('LOD1');
      if(n0&&n0.parent) n0.parent.remove(n0); if(n1&&n1.parent) n1.parent.remove(n1);
      a.lod0=n0||r; a.lod1=n1||null;
      a.root=new T.Group(); a.root.add(a.lod0); if(a.lod1) a.root.add(a.lod1);   // (only for disposal / memory accounting)
      if(mob()) shrinkTextures(a.root,512);
      a.root.traverse(o=>{ if(o.isMesh){ o.castShadow=false; o.receiveShadow=false; o.frustumCulled=false; } });
      a.mem=estMem(a.root); S.mem+=a.mem;
      if(a.lod0.parent===a.root) a.root.remove(a.lod0); if(a.lod1&&a.lod1.parent===a.root) a.root.remove(a.lod1);
      a.state=2;
      try{ if(env.pwMapTag){ env.pwMapTag(a.lod0); if(a.lod1) env.pwMapTag(a.lod1); } }catch(e){}
    }catch(e){ console.warn('[places] bad glb',d.id,e); a.state=-1; }
    S.loading=0;
  },undefined,err=>{ console.warn('[places] load failed',d.url); a.state=-1; S.loading=0; });
}
function trim(now){
  const B=budget(); if(S.mem<=B) return;
  const idle=[]; S.cache.forEach(a=>{ if(a.state===2&&a.refs<=0) idle.push(a); });
  idle.sort((x,y)=>x.last-y.last);
  for(const a of idle){ if(S.mem<=B*0.85) break; disposeTpl(a); a.state=0; }
}

// ── small shared GPU bits ─────────────────────────────────────────────
function glowTex(){ if(S.glow) return S.glow; const c=document.createElement('canvas'); c.width=c.height=64; const x=c.getContext('2d'), g=x.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,'rgba(255,255,255,1)'); g.addColorStop(0.25,'rgba(255,255,255,0.55)'); g.addColorStop(1,'rgba(255,255,255,0)'); x.fillStyle=g; x.fillRect(0,0,64,64);
  const t=new S.T.CanvasTexture(c); t.colorSpace=S.T.SRGBColorSpace; return (S.glow=t); }
function impTex(d){   // a baked silhouette of the settlement for the far LOD (one tiny canvas per asset)
  S.imp=S.imp||new Map(); let t=S.imp.get(d.id); if(t) return t;
  const c=document.createElement('canvas'); c.width=128; c.height=64; const x=c.getContext('2d'), r=C.rng(C.h32('imp:'+d.id));
  const col='#'+(KCOL[d.kind]||0xffffff).toString(16).padStart(6,'0');
  x.fillStyle='rgba(8,18,28,0.0)'; x.fillRect(0,0,128,64);
  const grd=x.createLinearGradient(0,0,0,64); grd.addColorStop(0,'#e9fff6'); grd.addColorStop(1,'#5e8f8a'); x.fillStyle=grd;
  if(/dome|ring|spindle|ark|ship/.test(d.id)){ x.beginPath(); x.ellipse(64,56,52,34,0,Math.PI,2*Math.PI); x.fill(); }
  let cx=14; while(cx<114){ const w=7+r()*12, h=8+r()*(d.kind==='town'?42:22); x.fillRect(cx,60-h,w,h); cx+=w+1+r()*3; }
  x.fillStyle=col; x.globalAlpha=0.55; for(let i=0;i<26;i++) x.fillRect(12+r()*100,24+r()*34,2,2); x.globalAlpha=1;
  x.fillStyle='#2f5a54'; x.fillRect(4,59,120,4);
  t=new S.T.CanvasTexture(c); t.colorSpace=S.T.SRGBColorSpace; S.imp.set(d.id,t); return t; }
function boxGeo(){ return S.box||(S.box=new S.T.BoxGeometry(1,1,1).translate(0,0.5,0)); }
function boxMat(kind){ S.bm=S.bm||{}; return S.bm[kind]||(S.bm[kind]=new S.T.MeshStandardMaterial({color:KCOL[kind]||0xcccccc,roughness:0.7,metalness:0.1,emissive:0x112a26})); }

// ── a settlement record ───────────────────────────────────────────────
// st: 0 nothing · 1 beacon pip · 2 impostor · 3 LOD1 (or box) · 4 LOD0 (+ props)
function mkRec(s,def){
  const d=def||(S.byId&&S.byId[s.asset]); const h=Math.max(8,(d&&d.height)||s.radius*0.6);
  return {s,d,st:0,h,lx:0,lz:0,y:0,yLive:0,seen:0,beacon:null,imp:null,g:null,lod0:null,lod1:null,box:null,disc:0,dist:1e9,vis:true,a:null,props:0,rx:-1e9,rz:-1e9};
}
function dropObj(w,rec){
  if(rec.beacon){ w.G.remove(rec.beacon); rec.beacon.material.dispose(); rec.beacon=null; }
  if(rec.imp){ w.G.remove(rec.imp); rec.imp.material.dispose(); rec.imp=null; }
  if(rec.g){ w.G.remove(rec.g); rec.g=null; rec.lod0=rec.lod1=rec.box=null; }
  if(rec.a){ rec.a.refs--; rec.a=null; }
  rec.st=0;
}
function ensureSprites(w,rec,st){
  const T=S.T;
  if(st===1||st===2){ if(!rec.beacon){ const m=new T.SpriteMaterial({map:glowTex(),color:KCOL[rec.s.kind]||0xffffff,transparent:true,depthWrite:false,blending:T.AdditiveBlending,fog:false}); rec.beacon=new T.Sprite(m); rec.beacon.userData.noBend=true; rec.beacon.renderOrder=5; w.G.add(rec.beacon); } }
  else if(rec.beacon){ w.G.remove(rec.beacon); rec.beacon.material.dispose(); rec.beacon=null; }
  if(st===2){ if(!rec.imp&&rec.d){ const m=new T.SpriteMaterial({map:impTex(rec.d),transparent:true,depthWrite:false,fog:true}); rec.imp=new T.Sprite(m); rec.imp.userData.noBend=true; rec.imp.center.set(0.5,0); w.G.add(rec.imp); } }
  else if(rec.imp){ w.G.remove(rec.imp); rec.imp.material.dispose(); rec.imp=null; }
}
function ensureModel(w,rec,st){   // st 3 or 4
  const T=S.T; if(!rec.g){ rec.g=new T.Group(); rec.g.rotation.y=rec.s.yaw||0; w.G.add(rec.g); rec.g.position.set(rec.lx,rec.y,rec.lz); }
  fillModel(rec,st);
}
function fillModel(rec,st){
  const T=S.T, a=rec.d?reqAsset(rec.d.id):null;
  if(a&&a.state===2){
    if(!rec.a){ rec.a=a; a.refs++; }
    const hi=(st===4||!a.lod1), wantN=hi?a.lod0:a.lod1, cur=hi?rec.lod0:rec.lod1;
    if(wantN&&!cur&&S.cloneBudget>0){ const o=wantN.clone(true); if(hi) rec.lod0=o; else rec.lod1=o; rec.g.add(o); S.cloneBudget--; if(rec.box){ rec.g.remove(rec.box); rec.box=null; } }
    if(hi){ if(rec.lod1){ rec.g.remove(rec.lod1); rec.lod1=null; } } else if(rec.lod0){ rec.g.remove(rec.lod0); rec.lod0=null; }
  } else if(!rec.box&&!rec.lod0&&!rec.lod1){   // placeholder until the GLB lands (or if it never does)
    const b=new T.Mesh(boxGeo(),boxMat(rec.s.kind)); const R=rec.s.radius; b.scale.set(R*1.3,rec.h||R*0.6,R*1.3); b.frustumCulled=false; rec.box=b; rec.g.add(b);
  }
}
// where the ground really is at a site (live field; the foundation skirt in the GLB buries any difference)
function groundAt(env,x,z,rec){
  const H=env.TERRAIN.H; let y=H?H(x,z):0;
  if(rec&&rec.seen>=1&&env.surfH){ const y2=env.surfH(x,z); if(typeof y2==='number'&&isFinite(y2)) y=y2; }
  return y;
}
function siteY(env,rec,lx,lz,fine){
  if(rec.s.afloat) return Math.max(rec.s.baseY,0.05);
  const R=Math.min(rec.s.radius*0.6,30); let m=-1e9; const H=fine&&env.surfH?env.surfH:env.TERRAIN.H;
  const f=(x,z)=>{ const v=H(x,z); return v>m?v:m; };
  m=H(lx,lz); const k=6; for(let i=0;i<k;i++){ const a=i*6.2831853/k, v=H(lx+Math.cos(a)*R,lz+Math.sin(a)*R); if(v>m) m=v; }
  return m-0.4;
}

// ── world (surface) ───────────────────────────────────────────────────
function buildWorld(env){
  const PW=env.PW, F=PW.ground.F, body=PW.body, D=env.D, T=S.T;
  const w={gen:PW.gen,key:String(body.name),body,G:new T.Group(),F,recs:[],plan:null,done:false,ds:null,sw:env.siteXZ(PW.site),n:0,env:null,props:null,propKey:'',l0:[],l1:[]};
  w.G.name='JOTS_Places'; w.G.userData.noBend=false; PW.scene.add(w.G);
  const core=env.terrainCore, W=360/D, x0=-180/D, zN=-89.9/D, zS=89.9/D;
  const geo=body.name==='Earth'&&env.geoH;   // Earth's live ground is the real relief blended over the core noise: site on THAT (absolute lat/lon, so it is the same from any landing site)
  w.env={key:w.key.toLowerCase(),seed:F.seed,W,x0,zN,zS,D,H:geo?((x,z)=>{ x=C.wrapX(x,W,x0); z=z<zN?zN:(z>zS?zS:z); return env.geoH(core(x,z,F.seed,F.ws),x,z,F.seed); }):((x,z)=>core(C.wrapX(x,W,x0),z<zN?zN:(z>zS?zS:z),F.seed,F.ws))};
  w.ds=S.defs.filter(d=>(d.kind!=='station'&&d.kind!=='ship'&&d.kind!=='hub')&&C.defForBody(d,body));
  w.plan=C.planSurface(w.env,w.ds,{});
  return w;
}
function stepPlan(w,ms){
  if(w.done) return; const t0=performance.now();
  try{ for(;;){ const r=w.plan.next(); if(r.done){ finishPlan(w,r.value); break; } if(performance.now()-t0>ms) break; } }catch(e){ console.warn('[places] plan',e); w.done=true; }
  S.stats.planMs+=performance.now()-t0;
}
function finishPlan(w,sites){
  w.done=true; w.plan=null; const f=loadFound();
  for(const s of sites){ if(s.kind==='prop') continue; const r=mkRec(s,S.byId[s.asset]); r.disc=f[s.id]?1:0; r.bid=s.id; w.recs.push(r); }
  w.byId=new Map(); w.recs.forEach(r=>w.byId.set(r.s.id,r)); S.stats.sites=w.recs.length;
  try{ root.dispatchEvent(new CustomEvent('dm:places-ready',{detail:{body:w.key,count:w.recs.length}})); }catch(e){}
}
function distTo(w,rec,fx,fy,fz,env){
  const D=env.D, ax=rec.s.x-w.sw.x, dx=C.wrapDx(ax-fx,360/D), dz=(rec.s.z-w.sw.z)-fz;
  rec.lx=fx+dx; rec.lz=fz+dz;
  if(rec.st<3&&(Math.abs(rec.lx-rec.rx)>25||Math.abs(rec.lz-rec.rz)>25)){   // far: ride the LIVE ground (core height minus this world's site bias), refreshed as she moves
    rec.rx=rec.lx; rec.rz=rec.lz; rec.yLive=rec.s.afloat?Math.max(rec.s.baseY,0.05):env.TERRAIN.H(rec.lx,rec.lz);
  }
  const dy=fy-rec.yLive; return Math.sqrt(dx*dx+dz*dz+dy*dy);
}
function tick(dt,env){
  if(S.pause){ if(S.world&&S.world.G.visible) S.world.G.visible=false; return; }
  if(OFF||!env||!init(env)) return; const PW=env.PW; if(!PW.scene||!PW.ground||!PW.ground.F||!PW.body||!hasDefs()||!PW.camera) return;
  const t0=performance.now();
  let w=S.world; if(w&&(w.gen!==PW.gen)) { teardown(w,false); S.world=w=null; }
  if(!w){ if(PW.body.name==='Earth'&&env.earthReady&&!env.earthReady()&&(S.eWait+=dt)<20) return;   // the real relief map arrives async: plan once it is in (≤20 s wait)
    S.eWait=0; w=S.world=buildWorld(env); }
  if(!w.G.parent) PW.scene.add(w.G); w.G.visible=true;
  stepPlan(w,mob()?1.2:2.5);
  pumpLoads(); S.cloneBudget=1;
  if(!w.done){ S.stats.tickMs=performance.now()-t0; return; }
  const mode=PW.mode, f=mode==='space'?(PW.sp&&PW.sp.flat):(mode==='fly'?env.atmoState():env.surfPlayer()); if(!f) return;
  const fp=f.pos||f, fx=fp.x, fy=fp.y, fz=fp.z;
  S.t4+=dt;
  if(S.t4>=0.25){ S.t4=0; decide(w,env,fx,fy,fz,mode); }
  render(w,env,fx,fy,fz);
  S.stats.tickMs=performance.now()-t0;
}
function lodDist(rec,k){ const d=rec.d, R=rec.s.radius, m=mob()?0.7:1; const sw=(d&&d.lodD&&d.lodD[0])||R*3;
  const d0=(sw*1.7+60)*m; return k===0?d0:(k===1?d0*7+500*m:Math.min(mob()?3800:6500,d0*20)); }
function decide(w,env,fx,fy,fz,mode){
  const st=S.stats; st.l0=st.l1=st.imp=st.box=st.beacon=0; st.props=0;
  const alt=fy-(w.recs.length?0:0), farBeacon=mob()?7000:14000;
  // 1 distances + desired state
  for(const rec of w.recs){
    const d=distTo(w,rec,fx,fy,fz,env); rec.dist=d;
    if(!rec.disc&&d<450+rec.s.radius){ discover(w,rec,env); }
    const d0=lodDist(rec,0), d1=lodDist(rec,1), d2=lodDist(rec,2), hy=rec.st>=4?1.12:1, hy1=rec.st>=3?1.12:1, hy2=rec.st>=2?1.12:1;
    let want=0;
    if(d<d0*hy) want=4; else if(d<d1*hy1) want=3; else if(d<d2*hy2) want=2; else if(rec.disc?d<farBeacon:d<2600) want=1;
    if(rec.s.kind==='venue'&&want===2) want=1;       // a pub is a speck from afar
    rec.want=want;
  }
  // 2 budget: only so many fully-modelled sites at once, nearest first
  const maxL0=mob()?1:3, maxL1=mob()?3:7; let n0=0,n1=0;
  const order=w.recs.slice().sort((a,b)=>a.dist-b.dist);   // (≤ ~60 records, 4 Hz)
  for(const rec of order){ if(rec.want===4){ if(n0<maxL0) n0++; else rec.want=3; } if(rec.want===3){ if(n1<maxL1+n0) n1++; else rec.want=2; } }
  // 3 apply (cheap state flips; the heavy part — a clone — is rate limited in ensureModel)
  for(const rec of w.recs){
    const sw=rec.want; if(sw!==rec.st||(sw>=3&&!rec.g)){
      if(sw<3&&rec.g){ if(rec.a){ rec.a.refs--; rec.a=null; } w.G.remove(rec.g); rec.g=null; rec.lod0=rec.lod1=rec.box=null; }
      if(sw===0){ dropObj(w,rec); } else { ensureSprites(w,rec,sw); }
      if(sw>=3&&sw!==rec.st){ rec.y=rec.yLive=siteY(env,rec,rec.lx,rec.lz,false); rec.seen=0; }
      rec.st=sw;
    }
    if(rec.st>=3){ // ground refinement once the marching-cubes/tess patch exists (and on a wrap)
      if(rec.g&&(Math.abs(rec.g.position.x-rec.lx)>1||Math.abs(rec.g.position.z-rec.lz)>1)){ rec.g.position.x=rec.lx; rec.g.position.z=rec.lz; }
      if(rec.st===4&&rec.seen<2&&rec.dist<rec.s.radius*2.5+80){ rec.seen++; if(rec.seen===2){ rec.y=siteY(env,rec,rec.lx,rec.lz,true); rec.yLive=rec.y; if(rec.g) rec.g.position.y=rec.y; } }
      ensureModel(w,rec,rec.st);
      if(rec.g) rec.g.position.y=rec.y;
    }
    if(rec.st===4) st.l0++; else if(rec.st===3){ if(rec.box) st.box++; else st.l1++; } else if(rec.st===2) st.imp++; else if(rec.st===1) st.beacon++;
  }
  updateProps(w,env);
  S.stats.mem=S.mem; S.stats.assets=S.cache.size; trim();
}
// frustum + per-frame placement of sprites (they ride the planet frame on the CPU) and model culling
function render(w,env,fx,fy,fz){
  const cam=env.PW.camera, T=TMP; T.m.multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse); T.fr.setFromProjectionMatrix(T.m,cam.coordinateSystem);
  const map=env.pwfMap, cp=cam.position;
  for(const rec of w.recs){
    if(!rec.st) continue; const R=rec.s.radius, h=rec.h, y=rec.st>=3?rec.y:rec.yLive;
    map(rec.lx,y+h*0.5,rec.lz,T.v);
    T.sp.center.copy(T.v); T.sp.radius=Math.max(R,h)*1.2+8; const inV=T.fr.intersectsSphere(T.sp);
    if(rec.g) rec.g.visible=inV;
    const dc=T.v.distanceTo(cp);
    if(rec.imp){ rec.imp.visible=inV&&rec.st===2; if(inV){ map(rec.lx,y,rec.lz,T.v2); rec.imp.position.copy(T.v2); rec.imp.scale.set(R*2.4,Math.max(h*1.6,R*0.9),1); } }
    if(rec.beacon){ rec.beacon.visible=inV; if(inV){ rec.beacon.position.copy(T.v); const s=Math.max(10,dc*(rec.st===1?(rec.disc?0.012:0.02):0.006)); rec.beacon.scale.set(s,s,1); rec.beacon.material.opacity=rec.disc?0.55:0.9; } }
  }
}
// ── props: one InstancedMesh per prop mesh, rebuilt only when the set of fully-modelled sites changes ──
function updateProps(w,env){
  const T=S.T, act=[]; for(const rec of w.recs) if(rec.st===4&&rec.s.props&&rec.s.props.length) act.push(rec);
  let key=''; for(const r of act) key+=r.s.id+'@'+Math.round(r.y)+';'; if(w.propKey===key&&w.propsDone) return; 
  // need every prop asset loaded
  const need=new Set(); for(const r of act) for(const p of r.s.props) need.add(p.a);
  let ready=true; need.forEach(id=>{ const a=reqAsset(id); if(a.state===0||a.state===1) ready=false; }); if(!ready){ w.propsDone=false; return; }
  clearProps(w); w.propKey=key; w.propsDone=true; if(!act.length) return;
  const by=new Map();   // asset → [{rec,prop}]
  for(const r of act) for(const p of r.s.props){ let l=by.get(p.a); if(!l){ l=[]; by.set(p.a,l); } l.push([r,p]); }
  w.props=new T.Group(); w.props.name='JOTS_PlaceProps'; w.G.add(w.props); let total=0;
  by.forEach((list,id)=>{ const a=S.cache.get(id); if(!a||a.state!==2) return; a.refs++; (w.propAssets=w.propAssets||[]).push(a);
    const src=a.lod1||a.lod0; src.updateWorldMatrix(true,true); const inv=TMP.m2.copy(src.matrixWorld).invert();
    src.traverse(o=>{ if(!o.isMesh) return; const rel=new T.Matrix4().multiplyMatrices(inv,o.matrixWorld);   // (once per rebuild)
      const im=new T.InstancedMesh(o.geometry,o.material,list.length); im.frustumCulled=false; im.castShadow=false; im.receiveShadow=false;
      let i=0; for(const [r,p] of list){
        const lx=r.lx+Math.cos(r.s.yaw||0)*p.x+Math.sin(r.s.yaw||0)*p.z, lz=r.lz-Math.sin(r.s.yaw||0)*p.x+Math.cos(r.s.yaw||0)*p.z;
        const gy=env.surfH?env.surfH(lx,lz):env.TERRAIN.H(lx,lz); TMP.e.set(0,p.yaw,0); TMP.q.setFromEuler(TMP.e); TMP.v.set(lx,gy,lz); TMP.s.set(p.s,p.s,p.s);
        TMP.m.compose(TMP.v,TMP.q,TMP.s).multiply(rel); im.setMatrixAt(i++,TMP.m); }
      im.instanceMatrix.needsUpdate=true; w.props.add(im); total+=list.length; });
  });
  S.stats.props=total;
}
function clearProps(w){ if(w.props){ w.G.remove(w.props); w.props.children.forEach(c=>{ if(c.dispose) c.dispose(); }); w.props=null; } if(w.propAssets){ w.propAssets.forEach(a=>{ a.refs--; }); w.propAssets=null; } w.propKey=''; w.propsDone=false; }
function teardown(w,full){
  if(!w) return; try{ clearProps(w); for(const rec of w.recs) dropObj(w,rec); if(w.G.parent) w.G.parent.remove(w.G); }catch(e){}
  if(full){ S.cache.forEach(a=>{ disposeTpl(a); a.state=0; a.refs=0; }); S.loadQ.length=0; S.loading=0; }
}
function onWorldClose(){ // before _pwClose disposes the whole scene: our templates must survive, our group must not be disposed with it
  const w=S.world; if(w){ teardown(w,false); S.world=null; }
  S.cache.forEach(a=>{ a.refs=0; });
  if(root.DMCreatures&&root.DMCreatures.onWorldClose) root.DMCreatures.onWorldClose();
  trim();
}

// ── discovery ─────────────────────────────────────────────────────────
function discover(w,rec,env){
  rec.disc=1; const f=loadFound(); if(f[rec.s.id]) return;
  const ref=env.sysRef?env.sysRef():{gal:'milkyway',sys:null}, D=env.D;
  const it={id:rec.s.id,name:rec.s.name,kind:rec.s.kind,asset:rec.s.asset,body:w.body.name,gal:ref.gal||'milkyway',sys:ref.sys||null,
    lat:-rec.s.z*D,lon:rec.s.x*D,r:rec.s.radius,t:Date.now(),space:0};
  f[it.id]=it; saveFound();
  announce(it,env);
}
function announce(it,env){
  try{ root.dispatchEvent(new CustomEvent('dm:place-discovered',{detail:it})); }catch(e){}
  try{ const kind=({town:'Town',village:'Village',venue:'Venue',station:'Station',ship:'Ship village',hub:'Hub'})[it.kind]||'Place';
    if(env&&env.toast) env.toast('✦ PLACE DISCOVERED — '+it.name+' · '+kind+' on '+it.body+' · added to Quick Travel',3600); }catch(e){}
}

// ── Quick Travel ──────────────────────────────────────────────────────
const ICON={town:'🏙️',village:'🏘️',venue:'🍻',station:'🛰️',ship:'🚀',hub:'🌀'};
function metaOf(it){ const K=({town:'Town',village:'Village',venue:'Pub',station:'Station',ship:'Ship village',hub:'Hub'})[it.kind]||'Place'; return K+' · '+(it.space?('orbiting '+it.body):it.body); }
function travel(it){
  const env=S.env||{}; const jt=root.journalTravel; if(typeof jt!=='function') return;
  const place={gal:it.gal||'milkyway',sys:it.sys||null};
  if(!it.space){ Object.assign(place,{body:it.body,site:{lat:it.lat,lon:it.lon},x:0,z:+(it.r+35).toFixed(1),yaw:0}); jt({kind:'surface',label:it.name,place}); }
  else {   // beside it, a little out (a station orbits: where it is now)
    const k=Math.max(0.5,(it.size||0.3)*8);
    if(it.orb){ const v=[0,0,0]; C.orbitPos(it.orb,Date.now()/1000,v); const l=Math.hypot(v[0],v[1],v[2])||1; place.near={name:it.body,off:[v[0]*(1+k/l),v[1]*(1+k/l)+k*0.15,v[2]*(1+k/l)]}; }
    else if(it.pos) place.pos=[it.pos[0]+k,it.pos[1]+k*0.15,it.pos[2]+k];
    jt({kind:'space',label:it.name,place}); }
}
function qtNode(gal,ctx){
  const f=loadFound(), all=Object.keys(f).map(k=>f[k]).filter(it=>(it.gal||'milkyway')===gal).sort((a,b)=>b.t-a.t);
  if(!all.length) return null; const close=ctx&&ctx.close, ask=ctx&&ctx.ask;
  return {id:'places:'+gal,icon:'📍',label:'Places',meta:all.length+' discovered',count:all.length,kids:()=>all.map(it=>({id:'place:'+it.id,icon:ICON[it.kind]||'📍',label:it.name,meta:metaOf(it),
    go:()=>{ const doit=()=>travel(it); if(ask) ask('TRAVEL — '+it.name.toUpperCase(),'Go to '+it.name+' ('+metaOf(it)+')?',doit); else doit(); if(close) close(); },kids:null}))};
}

// ── space: stations, ship villages and deep-space hubs (flightScene) ──
function spaceTick(dt,env){
  if(OFF||S.pause||!env||!init(env)||!hasDefs()) return; const st=env.STATE; if(!st||st.screen!=='flight'||!st.flight||!st.flight.pos||env.PW.active) return;
  const fs=env.flightScene; if(!fs) return; const T=S.T;
  S.tSp+=dt; if(S.tSp<0.25){ if(S.space&&S.space.key) spaceFrame(S.space,env); return; } S.tSp=0; const t0=performance.now();
  const ref=env.sysRef(), sysKey=(ref.gal||'milkyway')+':'+((ref.sys&&ref.sys.name)||'Sol');
  let sp=S.space; if(sp&&(sp.key!==sysKey||sp.scene!==fs)){ teardownSpace(sp); S.space=sp=null; }
  if(!sp){
    sp={key:sysKey,scene:fs,G:new T.Group(),recs:[],hubs:new Map(),ref,planned:0}; sp.G.name='JOTS_PlacesSpace'; fs.add(sp.G); S.space=sp;
  }
  if(!sp.planned){ const bs=env.celestial(); if(!bs||!bs.length) return;
    const list=[]; for(const b of bs){ if(!b||!b.mesh||b.name==='Sun'||b.isDiscovery) continue; const r=env.bodyVisR?env.bodyVisR(b):b.collisionRadius; if(r>=0.9) list.push({name:b.name,r,home:b.name==='Earth'}); }
    if(!list.length) return; if(!list.some(x=>x.home)) list[0].home=true;
    const orbs=C.planOrbits(sysKey,list,S.defs); const f=loadFound();
    for(const o of orbs){ const d=S.byId[o.asset]; if(!d) continue; const rec=mkSpaceRec(o,d); rec.disc=f[o.id]?1:0; sp.recs.push(rec); }
    sp.planned=1; S.stats.orb=sp.recs.length;
  }
  const p=st.flight.pos, now=Date.now()/1000, cel=env.celestial();
  // deep-space hubs are seeded per 9000-unit cell round you (found as you fly)
  const hs=C.hubsNear(sysKey,S.defs,p.x,p.z,12000,9000);
  for(const h of hs){ if(!sp.hubs.has(h.id)){ const d=S.byId[h.asset]; if(d){ const rec=mkSpaceRec(h,d); rec.disc=loadFound()[h.id]?1:0; rec.hubPos=true; sp.hubs.set(h.id,rec); sp.recs.push(rec); } } }
  for(const rec of sp.recs){
    const o=rec.o; let bx,by,bz;
    if(o.hub){ bx=o.x; by=o.y; bz=o.z; }
    else { let b=rec.bodyRef; if(!b||!b.mesh||cel.indexOf(b)<0){ b=rec.bodyRef=null; for(const c of cel) if(c&&c.name===o.body&&c.mesh){ b=rec.bodyRef=c; break; } } if(!b) { setSpaceState(sp,rec,0); continue; }
      C.orbitPos(o,now,TMP.p); bx=b.mesh.position.x+TMP.p[0]; by=b.mesh.position.y+TMP.p[1]; bz=b.mesh.position.z+TMP.p[2]; }
    rec.wx=bx; rec.wy=by; rec.wz=bz;
    const dx=bx-p.x, dy=by-p.y, dz=bz-p.z, d=Math.sqrt(dx*dx+dy*dy+dz*dz); rec.dist=d;
    if(!rec.disc&&d<Math.max(6,o.size*40)){ rec.disc=1; const f=loadFound(); if(!f[o.id]){ const b=rec.bodyRef;
      const it={id:o.id,name:o.name,kind:o.kind,asset:o.asset,body:o.hub?'deep space':o.body,gal:ref.gal||'milkyway',sys:ref.sys||null,r:o.size,t:Date.now(),space:1,hub:o.hub?1:0,size:o.size,orb:o.hub?null:{a:o.a,inc:o.inc,node:o.node,phase:o.phase,period:o.period},pos:o.hub?[o.x,o.y,o.z]:null};
      f[o.id]=it; saveFound(); announce(it,env); } }
    const sz=o.size, m0=sz*14, m1=sz*70; let want=0;
    if(d<m0*(rec.st>=4?1.15:1)) want=4; else if(d<m1*(rec.st>=3?1.15:1)) want=3; else if(d<(o.hub?9000:Math.max(220,sz*900))) want=1;
    if(want===1&&!rec.disc&&d>(o.hub?5000:600)) want=0;
    setSpaceState(sp,rec,want,env);
  }
  spaceFrame(sp,env);
  S.stats.tickMs=performance.now()-t0; trim();
}
function spacePosOf(rec,now,cel,out){
  const o=rec.o; if(o.hub){ out[0]=o.x; out[1]=o.y; out[2]=o.z; return true; }
  const b=rec.bodyRef; if(!b||!b.mesh) return false; C.orbitPos(o,now,out); out[0]+=b.mesh.position.x; out[1]+=b.mesh.position.y; out[2]+=b.mesh.position.z; return true;
}
function spaceFrame(sp,env){   // every frame: stations ride their world (cheap — a handful of records)
  const now=Date.now()/1000, P=TMP.p;
  for(const rec of sp.recs){ if(!rec.st) continue; if(!spacePosOf(rec,now,null,P)) continue; rec.wx=P[0]; rec.wy=P[1]; rec.wz=P[2];
    if(rec.g) rec.g.position.set(P[0],P[1],P[2]); if(rec.beacon) rec.beacon.position.set(P[0],P[1],P[2]); }
}
function mkSpaceRec(o,d){ return {o,s:{id:o.id,kind:o.kind,asset:o.asset,radius:d.radius,name:o.name},d,st:0,g:null,lod0:null,lod1:null,box:null,beacon:null,a:null,disc:0,dist:1e9,wx:0,wy:0,wz:0,bodyRef:null}; }
function setSpaceState(sp,rec,want,env){
  const T=S.T; if(want===rec.st&&(want<3||rec.g)) { if(want>=3) spaceModel(sp,rec,want); return; }
  if(want<3&&rec.g){ if(rec.a){ rec.a.refs--; rec.a=null; } sp.G.remove(rec.g); rec.g=null; rec.lod0=rec.lod1=rec.box=null; }
  if(want===1||want===3||want===4){ if(!rec.beacon){ const m=new T.SpriteMaterial({map:glowTex(),color:KCOL[rec.o.kind]||0xffffff,transparent:true,depthWrite:false,blending:T.AdditiveBlending,sizeAttenuation:false}); rec.beacon=new T.Sprite(m); rec.beacon.scale.set(0.022,0.022,1); sp.G.add(rec.beacon); } }
  if((want===0||want>=3)&&rec.beacon&&want!==1){ if(want===0||want>=3){ sp.G.remove(rec.beacon); rec.beacon.material.dispose(); rec.beacon=null; } }
  rec.st=want; if(want>=3) spaceModel(sp,rec,want);
}
function spaceModel(sp,rec,st){
  const T=S.T, o=rec.o;
  if(!rec.g){ rec.g=new T.Group(); rec.g.scale.setScalar(o.size/Math.max(1,rec.d.radius)); rec.g.rotation.y=o.yaw||0; sp.G.add(rec.g); rec.g.position.set(rec.wx,rec.wy,rec.wz); }
  S.cloneBudget=1; rec.h=rec.d.height||rec.d.radius*0.5; fillModel(rec,st);
}
function teardownSpace(sp){ for(const rec of sp.recs){ if(rec.beacon){ rec.beacon.material.dispose(); } if(rec.a) rec.a.refs--; } if(sp.G.parent) sp.G.parent.remove(sp.G); }

function stats(){ return Object.assign({},S.stats,{manifest:S.man,defs:S.defs?S.defs.length:0,found:Object.keys(loadFound()).length}); }
root.DMPlaces={tick,spaceTick,onWorldClose,qtNode,travel,stats,loadFound,
  pause(on){ S.pause=!!on; },   // A/B perf switch (tools/perf only)
  reset(){ if(S.world) teardown(S.world,false); S.world=null; if(S.space) teardownSpace(S.space); S.space=null; },
  _S:S,get off(){ return OFF; }};
})(window);
