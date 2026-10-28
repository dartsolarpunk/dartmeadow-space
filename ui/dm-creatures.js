/* dm-creatures.js — wildlife and villagers around the player (JOTS creature pack).
   Spawns by habitat band (body · altitude · slope · land/air), inside a radius around the player, from fixed pools
   (rigs are reused, never re-created), in a deterministic order per (body, seed, cell). Skinned GLBs clone with
   SkeletonUtils and share geometry/textures; only creatures near the camera animate. Creatures are drawn unbent and
   placed through the planet frame on the CPU, so they ride the curved ground. Kill switch: ?creatures=0 (or ?places=0).
   AI: a small built-in brain (wander / flee / circle); DMCreatures.setBrain(fn) swaps in jots-ai.js when it lands. */
(function(root){
'use strict';
const C=root.DMPlacesCore; if(!C) return;
const Q=new URLSearchParams(root.location&&root.location.search||'');
const OFF=Q.get('creatures')==='0'||Q.get('places')==='0';
const BASE=(Q.get('creaturesbase')||'assets/creatures/');
const KNOWN={earth:1,moon:1,mars:1,mercury:1,asteroid:1,pluto:1,europa:1,titan:1,venus:1};
const S={ready:false,T:null,env:null,defs:null,man:0,rigs:[],act:[],pool:new Map(),tpl:new Map(),loadQ:[],loading:0,world:null,tS:0,tA:0,gen:-1,brain:null,skel:null,skelTry:0,
  stats:{active:0,anim:0,tickMs:0,species:0,loaded:0,npc:0,spawned:0}};
let TMP=null;
const mob=()=>!!(S.env&&S.env.GFX&&S.env.GFX.isMobile);
const SIZEN={air:()=>mob()?6:12,land:()=>mob()?5:10};

function init(env){
  S.env=env; if(S.ready) return true; const T=env.THREE; if(!T||!T.Vector3||!T.GLTFLoader) return false; S.T=T;
  TMP={v:new T.Vector3(),v2:new T.Vector3(),m:new T.Matrix4(),fr:new T.Frustum(),sp:new T.Sphere(),q:new T.Quaternion(),e:new T.Euler()}; S.ready=true;
  fetch(BASE+'manifest-creatures.json').then(r=>r.ok?r.json():null).then(j=>{ if(!j){ S.man=-1; return; } S.defs=C.normalizeCreatures(j,BASE); S.man=2; }).catch(()=>{ S.man=-1; });
  S.man=1;
  if(!S.skel&&!S.skelTry){ S.skelTry=1; try{ import('three/addons/utils/SkeletonUtils.js').then(m=>{ S.skel=m; }).catch(()=>{}); }catch(e){} }
  return true;
}
function onPlaces(){}
function speciesFor(body){
  const keys=C.bodyKeys(body), alienOk=!keys.some(k=>KNOWN[k]); const out=[];
  for(const c of S.defs){ if(c.npc) continue; let ok=false; for(const b of c.body){ if(b==='any'||keys.indexOf(b)>=0||(b==='alien'&&alienOk)) { ok=true; break; } } if(ok) out.push(c); }
  return out;
}
// ── templates (one GLB per species) ──
function tplOf(c){ let t=S.tpl.get(c.id); if(!t){ t={c,state:0,scene:null,clips:null,last:0}; S.tpl.set(c.id,t); } t.last=performance.now(); if(t.state===0){ t.state=1; S.loadQ.push(t); } return t; }
function pump(){
  if(S.loading||!S.loadQ.length) return; const t=S.loadQ.shift(); S.loading=1; if(!S.loader) S.loader=new S.T.GLTFLoader();
  S.loader.load(t.c.url,g=>{ try{ t.scene=g.scene||g.scenes[0]; t.clips=g.animations||[]; t.scene.traverse(o=>{ if(o.isMesh||o.isSkinnedMesh){ o.frustumCulled=false; o.castShadow=false; o.receiveShadow=false; } }); t.scene.userData.noBend=true; t.state=2; S.stats.loaded++; }catch(e){ t.state=-1; } S.loading=0; },
    undefined,()=>{ t.state=-1; S.loading=0; });
}
function pickClip(t,names){ for(const n of names) for(const a of t.clips) if(a.name===n) return a; return t.clips[0]||null; }
// ── rig pool ──
function takeRig(t){
  let list=S.pool.get(t.c.id); if(!list){ list=[]; S.pool.set(t.c.id,list); }
  let r=list.pop(); if(r) return r;
  const T=S.T; let obj;
  if(S.skel&&S.skel.clone) obj=S.skel.clone(t.scene); else { if(t.scene.getObjectByProperty('isSkinnedMesh',true)) return null; obj=t.scene.clone(true); }   // (skinned needs SkeletonUtils)
  obj.userData.noBend=true; const grp=new T.Group(); grp.userData.noBend=true; grp.add(obj);
  const mixer=t.clips.length?new T.AnimationMixer(obj):null; const acts={};
  if(mixer){ for(const a of t.clips){ acts[a.name]=mixer.clipAction(a); } }
  r={t,grp,obj,mixer,acts,cur:null,sphereR:Math.max(0.6,(t.c.radius||1)*(t.c.size==='large'?1.6:0.8))};
  return r;
}
function play(cr,name,fade){ const r=cr.rig; if(!r.mixer||cr.clip===name) return; const a=r.acts[name]||r.acts.idle||r.acts.walk; if(!a) return; const o=r.cur; r.cur=a; cr.clip=name;
  a.reset(); a.enabled=true; a.setEffectiveWeight(1); a.play(); if(o&&o!==a) o.crossFadeTo(a,fade||0.25,false); }
function release(cr){ const r=cr.rig; r.grp.visible=false; if(r.grp.parent) r.grp.parent.remove(r.grp); if(r.mixer) r.mixer.stopAllAction(); r.cur=null; cr.clip=''; let l=S.pool.get(r.t.c.id); if(!l){ l=[]; S.pool.set(r.t.c.id,l); } if(l.length<6) l.push(r); cr.rig=null; cr.live=false; }

// ── world binding ──
function bind(env){
  const PW=env.PW; if(S.world&&S.world.gen===PW.gen) return S.world;
  if(S.world) unbind();
  const T=S.T, w={gen:PW.gen,G:new T.Group(),body:PW.body,pick:S.defs?speciesFor(PW.body):[],cells:new Map(),n:0};
  w.G.name='JOTS_Creatures'; w.G.userData.noBend=true; PW.scene.add(w.G);
  w.tot=0; for(const c of w.pick) w.tot+=c.weight*(c.medium==='air'?0.7:1);
  S.world=w; S.act.length=0; return w;
}
function unbind(){ const w=S.world; if(!w) return; for(const cr of S.act) if(cr.rig) release(cr); S.act.length=0; if(w.G.parent) w.G.parent.remove(w.G); S.world=null; }
function onWorldClose(){ unbind(); const M=root.DMMarine; if(M&&M.onWorldClose) M.onWorldClose(); }

const bandOK=(c,y)=>y>=c.alt[0]&&y<=c.alt[1];
function newCrit(){ return {c:null,rig:null,live:false,x:0,y:0,z:0,yaw:0,tx:0,tz:0,ty:0,home:0,hx:0,hz:0,t:0,state:0,spd:0,clip:'',vis:true,seed:0,anim:false,dist:0,phase:0,flockLead:null,npcSite:null}; }
const POOLN=40; const CR=[]; for(let i=0;i<POOLN;i++) CR.push(newCrit());

// deterministic pick: one hash per (body, seed, spawn-cell, attempt)
function cellRand(w,env,cx,cz,k){ return C.rng(C.h32('cr:v1:'+w.body.name+':'+env.PW.ground.F.seed+':'+cx+':'+cz+':'+k)); }
function trySpawn(w,env,fx,fz,fy,R,cap){
  const H=env.TERRAIN.H; if(!w.pick.length) return false; const CELL=26; const ang=Math.random()*6.2831853, rad=R*(0.35+0.65*Math.sqrt(Math.random()));   // placement jitter only; the species/variant come from the seeded cell hash
  const x=fx+Math.cos(ang)*rad, z=fz+Math.sin(ang)*rad, cx=Math.floor(x/CELL), cz=Math.floor(z/CELL), r=cellRand(w,env,cx,cz,0);
  if(r()>(mob()?0.55:0.8)) return false;   // not every cell holds life
  let pick=r()*w.tot, c=null; for(const s of w.pick){ pick-=s.weight*(s.medium==='air'?0.7:1); if(pick<=0){ c=s; break; } } if(!c) c=w.pick[0];
  const y=H(x,z); if(!bandOK(c,y)) return false;
  if(c.medium==='land'){ if(y<0.4) return false; const sl=Math.abs(H(x+2,z)-y)+Math.abs(H(x,z+2)-y); if(Math.atan(sl/4)*57.3>c.slope) return false; }
  else if(c.medium==='water'){ if(y>-0.5) return false; }
  const t=tplOf(c); if(t.state!==2) return false;
  const rig=takeRig(t); if(!rig) return false;
  let cr=null; for(const q of CR) if(!q.live){ cr=q; break; } if(!cr){ rig.grp.visible=false; const l=S.pool.get(c.id); if(l) l.push(rig); return false; }
  cr.c=c; cr.rig=rig; cr.live=true; cr.x=x; cr.z=z; cr.hx=x; cr.hz=z; cr.home=c.medium==='air'?R*0.9:(mob()?40:70); cr.seed=r(); cr.yaw=r()*6.283; cr.t=r()*2; cr.state=0; cr.spd=0; cr.phase=r()*6.283; cr.npcSite=null;
  cr.y=c.medium==='air'?(y+c.fly[0]+r()*(c.fly[1]-c.fly[0])):y; cr.ty=cr.y; cr.tx=x; cr.tz=z;
  const sc=(c.scale||1)*(0.9+0.2*r()); rig.grp.scale.setScalar(sc); rig.grp.visible=true; w.G.add(rig.grp);
  play(cr,c.medium==='air'?'fly':'idle'); S.act.push(cr); S.stats.spawned++; return true;
}
function trySpawnNpc(w,env){   // villagers / patrons round the fully modelled places
  const P=root.DMPlaces&&root.DMPlaces._S&&root.DMPlaces._S.world; if(!P||!P.recs||!S.defs) return false;
  for(const rec of P.recs){ if(rec.st!==4||!rec.g) continue; if(rec.s.kind!=='village'&&rec.s.kind!=='town'&&rec.s.kind!=='venue') continue;
    let have=0; for(const cr of S.act) if(cr.npcSite===rec) have++; const want=rec.s.kind==='venue'?3:(mob()?3:5); if(have>=want) continue;
    const roles=S.defs.filter(c=>c.npc&&(rec.s.kind==='venue'?/pub|any/.test(c.biome):/village|any/.test(c.biome))); if(!roles.length) return false;
    const r=cellRand(w,env,Math.round(rec.s.x*1000),Math.round(rec.s.z*1000),100+have); const c=roles[Math.floor(r()*roles.length)]; const t=tplOf(c); if(t.state!==2) return false;
    const rig=takeRig(t); if(!rig) return false; let cr=null; for(const q of CR) if(!q.live){ cr=q; break; } if(!cr) return false;
    const a=r()*6.283, d=rec.s.radius*(0.15+0.5*r()), x=rec.lx+Math.cos(a)*d, z=rec.lz+Math.sin(a)*d;
    cr.c=c; cr.rig=rig; cr.live=true; cr.x=x; cr.z=z; cr.hx=rec.lx; cr.hz=rec.lz; cr.home=rec.s.radius*0.55; cr.seed=r(); cr.yaw=r()*6.283; cr.t=r()*3; cr.state=0; cr.spd=0; cr.npcSite=rec; cr.y=rec.y; cr.ty=rec.y;
    rig.grp.scale.setScalar(c.scale||1); rig.grp.visible=true; w.G.add(rig.grp); play(cr,'idle'); S.act.push(cr); S.stats.npc++; return true; }
  return false;
}
function brain(cr,dt,env,px,pz){
  const c=cr.c; if(S.brain&&S.brain(cr,dt,env,px,pz)) return;
  const air=c.medium==='air', dx=cr.x-px, dz=cr.z-pz, d2=dx*dx+dz*dz; cr.t-=dt;
  if(!air&&c.temper!=='bold'&&d2<(cr.npcSite?25:225)&&c.ai!=='bartender'&&c.ai!=='patron'){   // wary: bolt from the player
    if(cr.state!==3&&!cr.npcSite){ cr.state=3; cr.t=2+cr.seed*2; const l=Math.sqrt(d2)||1; cr.tx=cr.x+dx/l*40; cr.tz=cr.z+dz/l*40; play(cr,'flee',0.15); }
  }
  if(cr.t<=0){
    if(air){ const a=Math.random()*6.283, r=cr.home*(0.2+0.8*Math.random()); cr.tx=cr.hx+Math.cos(a)*r; cr.tz=cr.hz+Math.sin(a)*r; cr.t=3+Math.random()*5; cr.state=1; }
    else if(cr.state===1||cr.state===3){ cr.state=0; cr.t=1.5+Math.random()*4; play(cr,'idle'); }
    else if(c.speed>0.3&&c.ai!=='bartender'&&c.ai!=='patron'){ const a=Math.random()*6.283, r=cr.home*Math.random(); cr.tx=cr.hx+Math.cos(a)*r; cr.tz=cr.hz+Math.sin(a)*r; cr.state=1; cr.t=3+Math.random()*5; play(cr,'walk'); }
    else { cr.t=4+Math.random()*4; if(c.ai==='patron') play(cr,'sit'); else if(c.ai==='bartender') play(cr,'idle'); }
  }
  if(cr.state===1||cr.state===3||air){
    const ex=cr.tx-cr.x, ez=cr.tz-cr.z, l=Math.sqrt(ex*ex+ez*ez);
    if(l>0.5){ const want=Math.atan2(-ex,-ez); let dy=want-cr.yaw; dy=Math.atan2(Math.sin(dy),Math.cos(dy)); cr.yaw+=dy*Math.min(1,dt*(air?1.6:4));
      const sp=c.speed*(cr.state===3?2.2:1)*(air&&c.ai==='flyer_insect'?(0.6+0.4*Math.sin(cr.phase*1.7+S.tA)):1); cr.x+=-Math.sin(cr.yaw)*sp*dt; cr.z+=-Math.cos(cr.yaw)*sp*dt; }
    else if(!air){ cr.state=0; cr.t=1+Math.random()*3; play(cr,'idle'); }
  }
}
function tick(dt,env){
  const M=root.DMMarine; if(M){ try{ M.tick(dt,env,S.pause); }catch(e){ if(!S.mW){ S.mW=1; console.warn('[marine]',e); } } }   // marine life (ui/dm-marine.js): zero-cost unless the rider is in or near water
  if(S.pause){ if(S.world&&S.world.G.visible) S.world.G.visible=false; return; }
  if(OFF||!env||!init(env)||!S.defs) return; const PW=env.PW; if(!PW.scene||!PW.ground||!PW.body||!PW.camera||!env.TERRAIN.H) return;
  const mode=PW.mode; if(mode==='space'){ if(S.world&&S.world.G.visible) S.world.G.visible=false; return; }
  const t0=performance.now(); const w=bind(env); w.G.visible=true; if(w.G.parent!==PW.scene) PW.scene.add(w.G);
  if(S.skelTry===1&&!S.skel&&S.stats.tickMs>=0&&performance.now()>0){}   // (SkeletonUtils arrives async)
  S.tA+=dt; pump(); S.stats.species=w.pick.length;
  const f=mode==='fly'?env.atmoState():env.surfPlayer(); if(!f) return; const fp=f.pos||f, fx=fp.x, fy=fp.y, fz=fp.z;
  const H=env.TERRAIN.H, agl=fy-H(fx,fz), R=(mode==='fly'?Math.min(220,60+agl*1.2):1)*(mob()?85:140)*(mode==='fly'?1:1);
  // keep the pool filled: one try per ~0.15 s, far fewer on mobile; none from a high flight
  const cap=mob()?10:22; S.tS+=dt;
  if(S.tS>0.12&&agl<400){ S.tS=0; if(S.act.length<cap){ if(!trySpawnNpc(w,env)) trySpawn(w,env,fx,fz,fy,R,cap); } for(const c of w.pick){ if(S.act.length<cap) tplOf(c); } }
  const m=TMP; m.m.multiplyMatrices(PW.camera.projectionMatrix,PW.camera.matrixWorldInverse); m.fr.setFromProjectionMatrix(m.m,PW.camera.coordinateSystem);
  const map=env.pwfMap, camP=PW.camera.position, animD=mob()?45:80; let anim=0;
  for(let i=S.act.length-1;i>=0;i--){ const cr=S.act[i], rig=cr.rig;
    const dx=cr.x-fx, dz=cr.z-fz, d=Math.sqrt(dx*dx+dz*dz);
    if(d>R*1.45||(!cr.npcSite&&agl>500)||(cr.npcSite&&(!cr.npcSite.g||cr.npcSite.st!==4))){ release(cr); S.act.splice(i,1); continue; }
    cr.dist=d; brain(cr,dt,env,fx,fz);
    const gy=H(cr.x,cr.z); const air=cr.c.medium==='air';
    if(air){ const want=gy+cr.c.fly[0]+(cr.c.fly[1]-cr.c.fly[0])*(0.5+0.5*Math.sin(cr.phase+S.tA*0.15)); cr.y+=(want-cr.y)*Math.min(1,dt*0.8); if(cr.y<gy+2) cr.y=gy+2; }
    else cr.y=cr.npcSite?cr.npcSite.y:gy;
    map(cr.x,cr.y,cr.z,m.v); rig.grp.position.copy(m.v); rig.grp.rotation.y=cr.yaw;
    m.sp.center.copy(m.v); m.sp.radius=rig.sphereR*3; const vis=m.fr.intersectsSphere(m.sp); rig.grp.visible=vis;
    if(rig.mixer&&vis&&d<animD){ rig.mixer.update(dt*(cr.state===3?1.3:1)); anim++; } else if(rig.mixer&&vis&&!cr.anim&&rig.mixer){ /* frozen pose far off */ }
  }
  S.stats.active=S.act.length; S.stats.anim=anim; S.stats.tickMs=performance.now()-t0;
}
root.DMCreatures={tick,onWorldClose,onPlaces,pause(on){ S.pause=!!on; },setBrain(fn){ S.brain=fn; },stats(){ return Object.assign({},S.stats,{manifest:S.man,defs:S.defs?S.defs.length:0}); },_S:S,get off(){ return OFF; }};
})(window);
