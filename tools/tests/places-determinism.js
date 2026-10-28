// node tools/tests/places-determinism.js — the places plan is a pure function of (body key, world seed, manifest):
//  1. same sites on every run,  2. independent of how the generator is sliced (frame budget),
//  3. different seeds differ,    4. the plan never consumes Math.random / touches any shared RNG state.
const fs=require('fs'), path=require('path'); const C=require('../../ui/dm-places-core.js');
const man=JSON.parse(fs.readFileSync(path.join(__dirname,'../../assets/places/manifest.json'),'utf8'));
const defs=C.normalizeManifest(man,'assets/places/');
const D=0.008, W=360/D, x0=-180/D, zN=-89.9/D, zS=89.9/D;
const mkEnv=(key,seed)=>({key,seed,W,x0,zN,zS,D,H:(x,z)=>{ const a=Math.sin(x*0.0007+seed)*40+Math.cos(z*0.0011-seed*0.3)*35+Math.sin((x+z)*0.004)*6; return a-5; }});
const bodies=[{name:'Earth',type:'terran'},{name:'Mars'},{name:'Moon'},{name:'Ceres'}];
let fails=0; const ok=(c,m)=>{ if(!c){ console.error('FAIL',m); fails++; } else console.log('ok  ',m); };
const rnd=Math.random; let calls=0; Math.random=function(){ calls++; return rnd(); };
for(const b of bodies){
  const ds=defs.filter(d=>d.kind!=='station'&&d.kind!=='ship'&&d.kind!=='hub'&&C.defForBody(d,b));
  const key=b.name.toLowerCase(), env=mkEnv(key,12345);
  const a=C.runSync(C.planSurface(env,ds,{})), b2=C.runSync(C.planSurface(mkEnv(key,12345),ds,{}));
  ok(JSON.stringify(a)===JSON.stringify(b2),key+': repeat run identical ('+a.length+' sites)');
  const g=C.planSurface(mkEnv(key,12345),ds,{}); let r,steps=0; while(!(r=g.next()).done) steps++;
  ok(JSON.stringify(r.value)===JSON.stringify(a),key+': sliced == sync ('+steps+' slices)');
  const c=C.runSync(C.planSurface(mkEnv(key,999),ds,{})); ok(a.length===0||JSON.stringify(c)!==JSON.stringify(a),key+': a different seed gives a different map');
  ok(a.every(s=>isFinite(s.x)&&isFinite(s.z)&&isFinite(s.baseY)&&s.name),key+': every site is finite and named');
}
const sp=[{name:'Earth',r:6,home:true},{name:'Moon',r:1.6},{name:'Mars',r:3.4}];
const o1=JSON.stringify(C.planOrbits('milkyway:Sol',sp,defs)), o2=JSON.stringify(C.planOrbits('milkyway:Sol',sp,defs));
ok(o1===o2&&o1.length>10,'orbit plan identical per system'); ok(JSON.stringify(C.hubsNear('milkyway:Sol',defs,100,100,12000,9000))===JSON.stringify(C.hubsNear('milkyway:Sol',defs,100,100,12000,9000)),'hub cells identical');
ok(calls===0,'the plan never calls Math.random (calls='+calls+')');
if(fails){ console.error(fails+' failed'); process.exit(1); } console.log('all places determinism checks passed');
