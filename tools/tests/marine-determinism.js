// node tools/tests/marine-determinism.js — marine life is a pure function of (body, world seed, cell, manifest) from its OWN rng stream:
//  1. same kit / same cell plan on every run,  2. different seeds / cells / bodies differ,  3. Earth gets the Earth set, every other ocean an alien kit,
//  4. nothing consumes Math.random or touches the world's seed state,  5. the plan respects the seabed (depth ranges, no flora out of water),
//  6. the kit does not depend on manifest key order,  7. the kill switch ?marine=0 yields a stub.
const fs=require('fs'), path=require('path'); globalThis.DMPlacesCore=require('../../ui/dm-places-core.js');
const rnd=Math.random; let calls=0; Math.random=function(){ calls++; return rnd(); };
const M=require('../../ui/dm-marine.js'); const man=JSON.parse(fs.readFileSync(path.join(__dirname,'../../assets/marine/marine.json'),'utf8'));
let fails=0; const ok=(c,m)=>{ if(!c){ console.error('FAIL',m); fails++; } else console.log('ok  ',m); };
const hf=seed=>(x,z)=>-(2+14*(0.5+0.5*Math.sin(x*0.011+seed))+60*(0.5+0.5*Math.sin(z*0.004-seed*0.7))+30*Math.max(0,Math.sin((x+z)*0.002)));
const sy=0, fl=-36, J=o=>JSON.stringify(o);
const planAll=(kit,seed)=>{ const out=[]; for(let cx=-6;cx<6;cx++) for(let cz=-6;cz<6;cz++) out.push(M.planCell(kit,man,cx,cz,hf(seed),sy,fl)); return out; };
const eK=M.kitFor(man,'Earth',12345), eK2=M.kitFor(man,'Earth',12345);
ok(J(eK)===J(eK2),'earth: kit repeat identical');
ok(eK.earth&&eK.fauna.length===13&&eK.flora.length===4,'earth: full earth set (13 fauna, 4 flora)');
ok(eK.fauna.every(e=>man.species[e.id].m.set==='earth')&&eK.flora.every(e=>man.species[e.id].m.set==='earth'),'earth: no alien species on Earth');
const aK=M.kitFor(man,'Kepler-22b',777), aK2=M.kitFor(man,'Kepler-22b',777), aK3=M.kitFor(man,'Kepler-22b',778), aK4=M.kitFor(man,'Gliese 581 c',777);
ok(J(aK)===J(aK2),'alien: kit repeat identical');
ok(!aK.earth&&aK.fauna.every(e=>man.species[e.id].m.set==='alien')&&aK.flora.every(e=>man.species[e.id].m.set==='alien'),'alien: only alien species');
ok(aK.fauna.length>=5&&aK.fauna.length<=7&&aK.flora.length>=2&&aK.flora.length<=3,'alien: 5-7 fauna, 2-3 flora ('+aK.fauna.length+'/'+aK.flora.length+')');
ok(aK.fauna.some(e=>man.species[e.id].m.role==='jelly'),'alien: always at least one jelly');
ok(J(aK)!==J(aK3)&&J(aK)!==J(aK4),'alien: seed and body name change the kit');
let diff=0; for(let s=1;s<40;s++) if(J(M.kitFor(man,'Orb'+s,s).fauna.map(e=>e.id))!==J(aK.fauna.map(e=>e.id))) diff++; ok(diff>25,'alien: kits vary across worlds ('+diff+'/39 differ)');
ok(aK.fauna.every(e=>e.mul>=0.8&&e.mul<=1.35&&e.hue>=0&&e.hue<1),'alien: size and hue within range');
const shuf={profiles:man.profiles,species:{}}; for(const k of Object.keys(man.species).reverse()) shuf.species[k]=man.species[k];
ok(J(M.kitFor(shuf,'Kepler-22b',777))===J(aK),'kit is independent of manifest key order');
const mk=M.kitFor(man,'Earth',12345,6,2); ok(mk.fauna.length===6&&mk.flora.length===2&&mk.fauna.every(e=>eK.fauna.some(q=>q.id===e.id)),'mobile kit is a subset of the same shuffle');
const p1=planAll(eK,5), p2=planAll(eK2,5), p3=planAll(eK,6);
ok(J(p1)===J(p2),'plan: repeat identical over 144 cells'); ok(J(p1)!==J(p3),'plan: a different terrain/seed gives a different map');
const n=p1.filter(c=>c.fauna).length, f=p1.reduce((a,c)=>a+c.flora.length,0); ok(n>20&&n<120,'plan: fauna in a sensible share of cells ('+n+'/144)'); ok(f>20,'plan: flora present ('+f+')');
const sp=new Set(p1.filter(c=>c.fauna).map(c=>c.fauna.id)); ok(sp.size>=5,'plan: several species show up ('+sp.size+')');
let bad=0; for(const c of p1){ if(c.fauna){ const m=man.species[c.fauna.id].m, h=hf(5)(c.fauna.x,c.fauna.z), D=sy-h; if(D<m.D[0]||D>m.D[1]||c.fauna.y>sy-0.3||c.fauna.y<h+0.2||c.fauna.y<fl) bad++; if(!(c.fauna.n>=1&&c.fauna.n<=m.n[1])) bad++; }
  for(const q of c.flora){ const m=man.species[q.id].m, d=sy-q.y; if(!(d>0.3)||q.y!==hf(5)(q.x,q.z)||!(q.s>=0.3)||q.s*m.bb[1][1]>d) bad++; } }
ok(bad===0,'plan: every group sits in its depth band above the seabed; every plant stands on it, underwater ('+bad+' violations)');
const dry=M.planCell(eK,man,0,0,()=>5,0,fl); ok(!dry.fauna&&dry.flora.length===0,'plan: dry land yields nothing');
const shal=[]; for(let cx=0;cx<30;cx++){ const c=M.planCell(eK,man,cx,0,()=>-0.9,0,fl); if(c.fauna) shal.push(c.fauna.id); } ok(shal.every(id=>man.species[id].m.D[0]<=0.9),'plan: shallows only hold shallow-water species');
const deep=[]; for(let cx=0;cx<80;cx++){ const c=M.planCell(eK,man,cx,3,()=>-200,0,fl); if(c.fauna) deep.push(c.fauna.id); } ok(deep.length>5&&deep.every(id=>man.species[id].m.D[1]>=200),'plan: open ocean only holds deep-water species ('+new Set(deep).size+' kinds)');
ok(calls===0,'nothing consumed Math.random (calls='+calls+')');
ok(typeof M.kitFor==='function'&&M.CELL===36,'module API present');
const vm=require('vm'), src=fs.readFileSync(path.join(__dirname,'../../ui/dm-marine.js'),'utf8');
const sb={URLSearchParams,performance,DMPlacesCore:globalThis.DMPlacesCore,location:{search:'?marine=0'},document:{currentScript:null}}; sb.window=sb; vm.createContext(sb); vm.runInContext(src,sb);
ok(sb.DMMarine&&sb.DMMarine.off===true,'?marine=0 turns the whole system off');
let thrown=0; try{ sb.DMMarine.tick(0.016,{PW:{active:true}},false); sb.DMMarine.onWorldClose(); sb.DMMarine.stats(); }catch(e){ thrown++; } sb.JOTS_WATER={surfaceY:0}; try{ sb.DMMarine.tick(0.016,{PW:{active:true}},false); }catch(e){ thrown++; }
ok(thrown===0&&sb.DMMarine._S.bt.size===0&&!sb.DMMarine._S.ready,'?marine=0: tick is a no-op even with water present');
if(fails){ console.error(fails+' failed'); process.exit(1); } console.log('all marine determinism checks passed');
