/* dm-places-core.js — the pure, deterministic half of the placement system.
 *
 * No THREE, no DOM, no game globals: everything here takes an `env` object, so the
 * same code runs in the game and in `node tools/tests/places-determinism.js`.
 *
 *   • manifest → defs (tolerant of schema differences, rules read from the
 *     "place" text when a manifest does not spell them out)
 *   • a DERIVED random stream per body ('places:v1:<body>:<world seed>:…'): it is
 *     never the terrain's stream and never advances it, so every existing seed
 *     keeps its exact world — settlements are laid ON TOP of it
 *   • settlement siting (slope / altitude band / spacing / coast / crater floor /
 *     clear-of-water), venues beside towns, prop scatter, orbital stations,
 *     ship villages and deep-space hubs
 *   • generated names
 *
 * Siting is a generator that yields every few hundred height samples; it can be
 * time-sliced across frames and the result is identical however it is sliced.
 */
(function(root){
'use strict';
const VER='places:v1';

// ── deterministic helpers ─────────────────────────────────────────────
function h32(s){ s=String(s); let h=2166136261>>>0; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } h^=h>>>13; h=Math.imul(h,0x5bd1e995); h^=h>>>15; return h>>>0; }
function rng(seed){ let a=seed>>>0; return function(){ a=(a+0x6D2B79F5)>>>0; let t=a; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }
const clamp=(v,a,b)=>v<a?a:(v>b?b:v);
const num=(v,d)=>{ v=parseFloat(v); return isFinite(v)?v:d; };
const PI2=Math.PI*2;

// ── manifest ──────────────────────────────────────────────────────────
const KIND_ALIAS={city:'town',metropolis:'town',outpost:'village',hamlet:'village',pub:'venue',bar:'venue',tavern:'venue',cantina:'venue',lounge:'venue',
  orbital:'station',habitat:'station',ring:'station',vessel:'ship',gate:'hub',crossroads:'hub',prop:'prop',props:'prop',decor:'prop'};
const SURFACE_KINDS={town:1,village:1,venue:1};
const SPACE_KINDS={station:1,ship:1,hub:1};
// What a def's free-text "place" says, as machine rules. A manifest may also give `rules` explicitly (wins).
function rulesFromText(t){
  t=String(t||'').toLowerCase(); const r={};
  if(/half over (water|liquid)|over the water|on piles|boardwalk/.test(t)) r.coast='half';
  else if(/shoreline|shore\b|coast(al|line)?\b|beach|lake shore|waterfront/.test(t)&&!/clear of (the )?(water|shore)/.test(t)) r.coast='shore';
  const cl=t.match(/(\d+)\s*m\s*clear of (the )?(water|shore)/); if(cl) r.clearWater=num(cl[1],40);
  { const c1=t.split(/[;.]/)[0]; if(/crater floor|crater bowl|inside a crater/.test(c1)&&!/\bor\b|\//.test(c1)) r.bowl=true; }
  if(/ocean|archipelago|sea[- ]city|open sea/.test(t)) r.ocean=true;
  if(/no (terrain|slope) (constraint|limit)|any asteroid|anywhere/.test(t)) r.anywhere=true;
  if(/orbit|deep[- ]space|dock/.test(t)) r.space=true;
  const fr=t.match(/needs? >?\s*(\d+)\s*m clear|diameter\s*>\s*(\d+)\s*m/); if(fr) r.free=num(fr[1]||fr[2],0);
  return r;
}
function _band(e){
  const pl=e.placement||{};
  let a=e.alt!==undefined?e.alt:(e.altitude!==undefined?e.altitude:(e.altBand!==undefined?e.altBand:pl.altitude_band_m));
  if(a&&!Array.isArray(a)&&typeof a==='object') a=[a.min,a.max];
  if(!Array.isArray(a)||a.length<2) a=[-1e4,1e4];
  return [num(a[0],-1e4),num(a[1],1e4)];
}
// → [{id,asset,name,kind,body[],slope,alt[2],radius,rules,url,bytes,tris0,tris1,weight,props[],theme,desc,place,lodD[]}]
// Reads the asset-pack manifest as shipped (name/file/kind/body/footprint_radius_m/placement{slope_max_deg,
// altitude_band_m,rules}/tris{lod0,lod1}/lod_switch_m/file_kb) and, tolerantly, the flatter registry shape.
function normalizeManifest(raw,base){
  let arr=raw; if(raw&&!Array.isArray(raw)) arr=raw.assets||raw.places||raw.items||raw.entries||raw.settlements||raw.list||raw;
  if(arr&&!Array.isArray(arr)&&typeof arr==='object') arr=Object.keys(arr).map(k=>Object.assign({name:k},arr[k]));
  if(!Array.isArray(arr)) return [];
  base=base===undefined?'':String(base);
  const out=[]; const seen=Object.create(null);
  for(const e of arr){
    if(!e||typeof e!=='object') continue;
    const id=String(e.id||e.asset||e.name||'').trim(); if(!id||seen[id]) continue; seen[id]=1;
    let kind=String(e.kind||e.type||'village').toLowerCase(); kind=KIND_ALIAS[kind]||kind;
    let body=e.body!==undefined?e.body:(e.bodies!==undefined?e.bodies:'any'); if(!Array.isArray(body)) body=[body];
    body=body.map(b=>String(b||'any').toLowerCase());
    const st=e.stats||{}, pl=e.placement||{}; const place=String(e.place||pl.rules||''), desc=String(e.desc||e.description||'');
    const rules=Object.assign(rulesFromText(place+' '+desc),e.rules&&typeof e.rules==='object'?e.rules:{});
    const slope=num(e.slope!==undefined?e.slope:(e.maxSlope!==undefined?e.maxSlope:(e.max_slope!==undefined?e.max_slope:pl.slope_max_deg)),8);
    const alt=_band(e); if(slope>=60) rules.anywhere=true;
    let file=e.glb||e.file||e.url||e.path||(id+'.glb'); file=String(file);
    const url=/^(https?:)?\/\/|^\//.test(file)?file:(base+file.replace(/^glb\//,''));
    const tr=(e.tris&&typeof e.tris==='object')?e.tris:{};
    const lsw=Array.isArray(e.lod_switch_m)?e.lod_switch_m:null;
    out.push({id,asset:id,name:String(e.title||e.label||id.replace(/_/g,' ')),kind,body,slope,alt,
      radius:Math.max(0.2,num(e.radius!==undefined?e.radius:(e.footprint_radius_m!==undefined?e.footprint_radius_m:st.radius),30)),
      height:num(e.height_m!==undefined?e.height_m:e.height,0),
      rules,url,bytes:num(e.bytes!==undefined?e.bytes:(e.file_kb!==undefined?e.file_kb*1024:st.bytes),0),
      tris0:num(tr.lod0!==undefined?tr.lod0:(e.lod0||st.lod0||{}).tris,0),tris1:num(tr.lod1!==undefined?tr.lod1:(e.lod1||st.lod1||{}).tris,0),
      weight:Math.max(0.01,num(e.weight,kind==='town'?1:(kind==='village'?2:1))),
      props:Array.isArray(e.props)?e.props.map(String):[],theme:String(e.theme||''),desc,place,interior:!!e.interior,
      lodD:Array.isArray(e.lodD)?e.lodD.map(Number):(lsw&&lsw.length>1?[num(lsw[1],0)]:null),color:e.color!==undefined?e.color:null});
  }
  return out;
}
// ── creature manifest (tolerant) ──
const BIOME={earth:['earth'],mars:['mars'],asteroid:['asteroid'],icy_moon:['europa','titan','pluto','enceladus','triton','ganymede','callisto'],alien:['alien'],village:'any',pub:'any'};
function normalizeCreatures(raw,base){
  let arr=raw; if(raw&&!Array.isArray(raw)) arr=raw.creatures||raw.species||raw.items||raw.entries||raw.list||raw;
  if(arr&&!Array.isArray(arr)&&typeof arr==='object') arr=Object.keys(arr).map(k=>Object.assign({name:k},arr[k]));
  if(!Array.isArray(arr)) return [];
  base=base===undefined?'':String(base); const out=[], seen=Object.create(null);
  for(const e of arr){
    if(!e||typeof e!=='object') continue;
    const id=String(e.id||e.asset||e.name||'').trim(); if(!id||seen[id]) continue; seen[id]=1;
    const ai=String(e.ai||'').toLowerCase(), bio=String(e.biome||'').toLowerCase();
    let body=e.body!==undefined?e.body:(e.bodies!==undefined?e.bodies:(e.world!==undefined?e.world:(BIOME[bio]||'any'))); if(!Array.isArray(body)) body=[body];
    let hab=e.habitat!==undefined?e.habitat:(e.medium!==undefined?e.medium:(e.locomotion!==undefined?e.locomotion:(/flyer/.test(ai)?'air':'land'))); if(Array.isArray(hab)) hab=hab[0];
    hab=String(hab||'land').toLowerCase();
    const medium=/air|fly|flight|bird|wing|sky/.test(hab)?'air':(/water|swim|aquat|sea|fish|marine/.test(hab)?'water':'land');
    let alt=_band(e);
    let file=e.glb||e.file||e.url||e.path||(id+'.glb'); file=String(file);
    out.push({id,name:String(e.title||e.label||id.replace(/_/g,' ')),body:body.map(b=>String(b||'any').toLowerCase()),theme:String(e.theme||''),medium,
      slope:num(e.slope!==undefined?e.slope:e.maxSlope,35),alt,
      url:/^(https?:)?\/\/|^\//.test(file)?file:(base+file),bytes:num(e.bytes,0),
      scale:num(e.scale,1),radius:num(e.radius,1),speed:num(e.speed,medium==='air'?7:2.2),
      fly:[num(e.flyMin!==undefined?e.flyMin:(e.fly&&e.fly[0]),6),num(e.flyMax!==undefined?e.flyMax:(e.fly&&e.fly[1]),40)],
      weight:Math.max(0.01,num(e.weight,1)),group:Math.max(1,Math.round(num(e.group,1))),
      clips:e.clips&&typeof e.clips==='object'?e.clips:{},temper:String(e.temper||e.behavior||e.behaviour||'wary').toLowerCase(),
      tris:num(e.tris,0),noise:e.sound||null,color:e.color!==undefined?e.color:null,ai,biome:bio,role:String(e.role||''),npc:/^npc/.test(String(e.cat||e.category||''))||/^npc_/.test(id)||!!e.role,flock:!!e.flock,size:String(e.size||''),glow:!!e.glow});
  }
  return out;
}

// ── which game body a def is for ──
const ASTEROIDS={ceres:1,vesta:1,pallas:1,eros:1,hygiea:1,phobos:1,deimos:1,mathilde:1,itokawa:1,ryugu:1,bennu:1};
function bodyClass(b){
  const n=String(b&&b.name||'').toLowerCase(), ty=String(b&&b.type||'').toLowerCase();
  if(ASTEROIDS[n]||(b&&b.lumpy)||(b&&b.kind==='asteroid')||/asteroid/.test(ty)) return 'asteroid';
  if(n==='moon') return 'moon';
  return n;
}
function bodyKeys(b){
  const n=String(b&&b.name||'').toLowerCase(), ty=String(b&&b.type||'').toLowerCase(), c=bodyClass(b); const k=[n,c];
  if(/ocean|terra|earth|lush|habitable|garden/.test(ty)) k.push('earth');
  if(/desert|arid|mars|dune/.test(ty)) k.push('mars');
  if(/barren|moon|crater|rock/.test(ty)&&c!=='asteroid') k.push('moon');
  if(/ice|frozen|cryo/.test(ty)) k.push('europa');
  return k;
}
function defForBody(def,b){
  const ks=bodyKeys(b); for(const x of def.body){ if(x==='any'||x==='*'||x==='all') return true; if(ks.indexOf(x)>=0) return true; } return false;
}
function creatureForBody(c,b){ return defForBody({body:c.body},b); }

// ── names ─────────────────────────────────────────────────────────────
const NM={
  a:['Aur','Bel','Cal','Dun','Elm','Fen','Gal','Hal','Isl','Jun','Kel','Lum','Mar','Nor','Ost','Pel','Quill','Ros','Sol','Tam','Ul','Vel','Wyn','Yar','Zen','Ash','Bri','Cor','Del','Eri','Fir','Gry','Hel','Ilo','Kes'],
  b:['ara','ell','ion','ova','ume','ys','ia','ora','eth','an','is','ar','ent','ow','ia','ine','ora','el'],
  c:['wick','mere','haven','vale','reach','gate','holm','spire','ford','ness','stead','bright','fall','moor','cairn','light'],
  town:['Commons','Arcology','Spire','Terraces','Concord','Landing','Plaza','Rise'],
  village:['Hollow','Green','Pods','Rest','Steading','Meadow','Camp','Haven'],
  station:['Ring','Spindle','Gardens','Anchorage','Orbital','Crown','Halo'],
  ship:['Ark','Drifter','Wayfarer','Barge','Meridian','Argosy'],
  hub:['Crossroads','Gate','Nexus','Junction','Concourse','Waypoint'],
  adj:['Golden','Quiet','Last','Orbit','Lantern','Copper','Velvet','Rusty','Starlit','Green','Slow','Salt'],
  noun:['Perch','Lamp','Heron','Kettle','Anchor','Orbit','Dune','Comet','Fern','Bell','Drum','Moth']
};
function makeName(r,kind,asset){
  const pick=a=>a[Math.floor(r()*a.length)];
  if(kind==='venue'){
    const t=String(asset||'');
    if(/pub|tavern|cantina|bar|lounge/.test(t)) return 'The '+pick(NM.adj)+' '+pick(NM.noun);
    return 'The '+pick(NM.adj)+' '+pick(NM.noun);
  }
  const stem=pick(NM.a)+pick(NM.b)+(r()<0.45?pick(NM.c):'');
  const tail=NM[kind]?pick(NM[kind]):'';
  return (r()<0.6&&tail?stem+' '+tail:stem);
}

// ── geometry helpers on the flat world (x east, z south, wraps east-west) ──
function wrapDx(dx,W){ return dx-Math.round(dx/W)*W; }
function wrapX(x,W,x0){ return x-Math.floor((x-x0)/W)*W; }
function slopeDeg(relief,span){ return Math.atan2(relief,Math.max(1e-6,span))*57.29578; }

// Terrain "environment" the generator needs (all site-independent):
//   env.H(x,z)   base height (absolute flat coords), sea level = 0
//   env.W        world width in units, env.x0 west edge, env.zN/zS pole limits, env.D degrees per unit
// body quantiles (so a manifest's altitude band in metres lands on a world's own relief)
function heightStats(env,seedKey){
  const r=rng(h32(VER+':hs:'+seedKey)), hs=[]; const n=96;
  for(let i=0;i<n;i++){ hs.push(env.H(env.x0+r()*env.W,env.zN+r()*(env.zS-env.zN))); }
  hs.sort((a,b)=>a-b); const q=p=>hs[clamp(Math.round(p*(n-1)),0,n-1)];
  return {min:hs[0],max:hs[n-1],q05:q(0.05),q25:q(0.25),q50:q(0.5),q75:q(0.75),q95:q(0.95),wet:hs.filter(h=>h<0).length/n};
}
function effBand(alt,hs){
  let lo=alt[0],hi=alt[1];
  if(hi<hs.q05||lo>hs.q95){ lo=hs.q05; hi=hs.q75; }      // a band the world cannot reach → its lower-middle relief
  return [lo,hi];
}

// One candidate. Returns {ok,y,yaw,...} — all from the base height field.
function fits(env,def,x,z,hs,rr){
  const R=Math.max(def.radius,def.rules.free||0)*1.0, rules=def.rules, H=env.H;
  const c=H(x,z); let mn=c, mx=c, wet=0, dry=0, sum=c, n=1, lowAng=0, lowH=1e9;
  const ring=(rad,k,fn)=>{ for(let i=0;i<k;i++){ const a=i*PI2/k; fn(H(x+Math.cos(a)*rad,z+Math.sin(a)*rad),a); } };
  if(!rules.anywhere){
    ring(R,8,(h,a)=>{ mn=Math.min(mn,h); mx=Math.max(mx,h); sum+=h; n++; if(h<0.2) wet++; else dry++; if(h<lowH){ lowH=h; lowAng=a; } });
    ring(R*0.5,4,(h)=>{ mn=Math.min(mn,h); mx=Math.max(mx,h); sum+=h; n++; if(h<0.2) wet++; else dry++; });
  } else { ring(R,4,(h)=>{ mn=Math.min(mn,h); mx=Math.max(mx,h); sum+=h; n++; }); }
  const mean=sum/n;
  if(!rules.anywhere){
    if(slopeDeg(mx-mn,2*R)>def.slope) return null;
    const b=effBand(def.alt,hs); if(c<b[0]||c>b[1]) return null;
  }
  if(rules.ocean){                                     // an ocean city: afloat in the shallows, land within sight
    if(mx>-0.8||mn<-90) return null; let land=false; ring(520,8,(h)=>{ if(h>0.5) land=true; }); if(!land) return null;
    return {ok:1,y:0,yaw:rr()*PI2,afloat:1};
  }
  if(rules.coast){                                     // a shoreline: some of the footprint wet, some dry
    if(rules.coast==='half'){ if(wet<3||dry<3) return null; }
    else { if(dry<4||(wet<1&&c<0.5)) return null; let w2=false; ring(R*2.2,8,(h)=>{ if(h<0) w2=true; }); if(!w2&&wet<1) return null; }
    return {ok:1,y:Math.max(0.5,mx-0.2),yaw:lowAng+Math.PI/2,afloat:0};
  }
  if(mn<0.25) return null;                              // land towns keep their feet dry
  if(rules.clearWater){ let w=false; ring(R+rules.clearWater,8,(h)=>{ if(h<0.1) w=true; }); if(w) return null; }
  if(rules.bowl){ let rim=0; ring(R*3,8,(h)=>{ rim+=h; }); rim/=8; if(c>rim-Math.max(3,R*0.12)) return null; }
  return {ok:1,y:mx-0.4,yaw:rr()*PI2,afloat:0};
}

// ── surface planner: a generator; `yield` after every cell so a caller can slice it ──
function* planSurface(env,defs,opt){
  opt=opt||{}; const key=env.key, seed=env.seed;
  const towns=defs.filter(d=>d.kind==='town'||d.kind==='village'), venues=defs.filter(d=>d.kind==='venue'), props=defs.filter(d=>d.kind==='prop');
  const out=[]; if(!towns.length) return out;
  const hs=heightStats(env,key+':'+seed);
  const CS=opt.cell||1500, nx=Math.max(1,Math.round(env.W/CS)), nz=Math.max(1,Math.round((env.zS-env.zN)/CS));
  const cw=env.W/nx, ch=(env.zS-env.zN)/nz;
  const rb=rng(h32(VER+':count:'+key+':'+seed));
  const only=towns.every(d=>d.rules.anywhere);
  const want=opt.count||Math.round((only?9:26)+rb()*(only?6:30));
  const minSp=opt.spacing||Math.min(cw,ch)*0.8;
  const cells=[]; for(let j=0;j<nz;j++) for(let i=0;i<nx;i++) cells.push({i,j,p:h32(VER+':cell:'+key+':'+seed+':'+i+','+j)});
  cells.sort((a,b)=>(a.p-b.p)||(a.j-b.j)||(a.i-b.i));
  const wsum=towns.reduce((s,d)=>s+d.weight,0);
  for(const cell of cells){
    if(out.length>=want) break;
    const r=rng(h32(VER+':site:'+key+':'+seed+':'+cell.i+','+cell.j));
    // up to 6 jittered tries per cell, a different def each (weighted)
    for(let t=0;t<6;t++){
      let pick=r()*wsum, def=towns[0]; for(const d of towns){ pick-=d.weight; if(pick<=0){ def=d; break; } }
      const x=env.x0+(cell.i+0.12+r()*0.76)*cw, z=env.zN+(cell.j+0.12+r()*0.76)*ch;
      const poleOk=Math.abs(z)<(env.zS*0.94);
      if(!poleOk) continue;
      let near=false; for(const s of out){ const dx=wrapDx(x-s.x,env.W), dz=z-s.z; if(dx*dx+dz*dz<minSp*minSp){ near=true; break; } } if(near) break;
      const f=fits(env,def,x,z,hs,r); if(!f) continue;
      const site={id:key+'|'+def.id+'|'+cell.i+','+cell.j,kind:def.kind,asset:def.id,defIdx:-1,x:wrapX(x,env.W,env.x0),z,yaw:f.yaw,baseY:f.y,afloat:f.afloat||0,
        name:makeName(rng(h32(VER+':name:'+key+':'+cell.i+','+cell.j)),def.kind,def.id),radius:def.radius,venue:null,props:[],parent:null};
      out.push(site); break;
    }
    yield out.length;
  }
  // venues beside the settlements (a deterministic share of towns get one)
  if(venues.length){
    const bodyVenues=venues; const nTown=out.length;
    for(let k=0;k<nTown;k++){
      const s=out[k]; if(s.kind!=='town'&&s.kind!=='village') continue;
      const r=rng(h32(VER+':venue:'+s.id)); if(r()>(s.kind==='town'?0.8:0.4)) continue;
      const v=bodyVenues[Math.floor(r()*bodyVenues.length)];
      for(let t=0;t<4;t++){
        const a=r()*PI2, d=s.radius+v.radius+8+r()*10, vx=s.x+Math.cos(a)*d, vz=s.z+Math.sin(a)*d;
        const f=fits(env,v,vx,vz,hs,r); if(!f) continue;
        out.push({id:s.id+'|'+v.id,kind:'venue',asset:v.id,x:wrapX(vx,env.W,env.x0),z:vz,yaw:a+Math.PI,baseY:f.y,afloat:0,
          name:makeName(rng(h32(VER+':name:'+s.id+':'+v.id)),'venue',v.id),radius:v.radius,props:[],parent:s.id}); s.venue=v.id; break;
      }
      yield out.length;
    }
  }
  // props (instanced at runtime) — deterministic offsets only; the ground is read when a town streams in
  if(props.length){
    const wp=props.reduce((s,d)=>s+d.weight,0);
    for(const s of out){
      if(s.kind==='venue') continue; const r=rng(h32(VER+':props:'+s.id));
      const cnt=s.kind==='town'?22:12;
      for(let q=0;q<cnt;q++){
        let pick=r()*wp, d=props[0]; for(const p of props){ pick-=p.weight; if(pick<=0){ d=p; break; } }
        const a=r()*PI2, rad=s.radius*(1.06+r()*0.35);
        s.props.push({a:d.id,x:Math.cos(a)*rad,z:Math.sin(a)*rad,yaw:r()*PI2,s:0.9+r()*0.25});
      }
    }
  }
  return out;
}
function runSync(gen){ let r; do{ r=gen.next(); }while(!r.done); return r.value; }

// ── orbital + deep-space (flightScene) ──────────────────────────────
// bodiesIn: [{name,r (visual radius), size:0..}] from the live system; sysKey: system name + galaxy.
function planOrbits(sysKey,bodiesIn,defs){
  const sta=defs.filter(d=>d.kind==='station'), shp=defs.filter(d=>d.kind==='ship'), ven=defs.filter(d=>d.kind==='venue'&&(d.body.indexOf('space')>=0));
  const out=[]; if(!sta.length&&!shp.length) return out;
  for(const b of bodiesIn){
    if(!(b.r>=0.9)||b.name==='Sun'||b.star) continue;                 // planets and large moons only
    const r=rng(h32(VER+':orbit:'+sysKey+':'+b.name));
    const n=r()<(b.home?1:0.55)?(b.home&&r()<0.5?2:1):0; if(b.home) { /* the home world always has at least one */ }
    const count=b.home?Math.max(1,n):n;
    for(let k=0;k<count;k++){
      const isShip=!sta.length||(shp.length&&r()<0.3), list=isShip?shp:sta, def=list[Math.floor(r()*list.length)];
      const id=sysKey+'|'+b.name+'|orb'+k+'|'+def.id;
      const nm=makeName(rng(h32(VER+':name:'+id)),def.kind,def.id)+(def.kind==='station'?'':'');
      const a=b.r*(1.7+r()*1.1);                              // orbit radius (× the world's drawn radius)
      out.push({id,space:1,kind:def.kind,asset:def.id,name:nm,body:b.name,a:a,inc:(r()-0.5)*1.1,node:r()*PI2,phase:r()*PI2,
        period:9000+r()*5000,size:Math.max(0.05,b.r*(def.kind==='ship'?0.02:0.04)),yaw:r()*PI2,radius:def.radius});
      if(ven.length&&!isShip&&r()<0.5){ const v=ven[Math.floor(r()*ven.length)]; const vid=id+'|'+v.id;
        out.push({id:vid,space:1,kind:'venue',asset:v.id,name:makeName(rng(h32(VER+':name:'+vid)),'venue',v.id),body:b.name,a:a,inc:out[out.length-1].inc,node:out[out.length-1].node,phase:out[out.length-1].phase+0.02/Math.max(0.2,a/b.r),
          period:out[out.length-1].period,size:Math.max(0.035,b.r*0.02),yaw:r()*PI2,radius:v.radius,parent:id}); }
    }
  }
  return out;
}
// deep-space hubs: seeded cells of the system (units match the flight scene)
function hubsNear(sysKey,defs,cx,cz,span,cell){
  const hubs=defs.filter(d=>d.kind==='hub'); const out=[]; if(!hubs.length) return out; cell=cell||9000;
  const i0=Math.floor((cx-span)/cell), i1=Math.floor((cx+span)/cell), j0=Math.floor((cz-span)/cell), j1=Math.floor((cz+span)/cell);
  for(let i=i0;i<=i1;i++) for(let j=j0;j<=j1;j++){
    const r=rng(h32(VER+':hub:'+sysKey+':'+i+','+j)); if(r()>0.34) continue;
    const def=hubs[Math.floor(r()*hubs.length)], x=(i+0.15+r()*0.7)*cell, z=(j+0.15+r()*0.7)*cell, y=(r()-0.5)*cell*0.08;
    if(Math.hypot(x,z)<1800) continue;                         // clear of the inner system
    const id=sysKey+'|hub|'+i+','+j;
    out.push({id,space:1,hub:1,kind:'hub',asset:def.id,name:makeName(rng(h32(VER+':name:'+id)),'hub',def.id),x,y,z,yaw:r()*PI2,size:0.9+r()*0.5,radius:def.radius});
  }
  return out;
}
function orbitPos(o,t,out){                    // → relative to the body centre
  const ang=o.phase+(t/o.period)*PI2, cx=Math.cos(ang)*o.a, cz=Math.sin(ang)*o.a;
  const ci=Math.cos(o.inc), si=Math.sin(o.inc), cn=Math.cos(o.node), sn=Math.sin(o.node);
  const x1=cx, y1=cz*si, z1=cz*ci;               // tilt about x
  out[0]=x1*cn-z1*sn; out[1]=y1; out[2]=x1*sn+z1*cn; return out;
}

root.DMPlacesCore={VER,h32,rng,clamp,normalizeManifest,normalizeCreatures,rulesFromText,bodyClass,bodyKeys,defForBody,creatureForBody,makeName,
  heightStats,effBand,fits,planSurface,runSync,planOrbits,hubsNear,orbitPos,wrapDx,wrapX,slopeDeg,SURFACE_KINDS,SPACE_KINDS};
if(typeof module!=='undefined'&&module.exports) module.exports=root.DMPlacesCore;
})(typeof window!=='undefined'?window:globalThis);
