const L=require('../../ui/dm-level.js'); let fails=0;
const ok=(c,m)=>{ if(!c){ fails++; console.log('FAIL',m); } };
const near=(a,b,e=1e-6)=>Math.abs(a-b)<e;
const qAxis=(ax,an)=>{ const n=Math.hypot(...ax),s=Math.sin(an/2)/n; return [ax[0]*s,ax[1]*s,ax[2]*s,Math.cos(an/2)]; };
const qmul=(a,b)=>[a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const horiz=(f,u)=>{ const d=dot(f,u),h=[f[0]-u[0]*d,f[1]-u[1]*d,f[2]-u[2]*d],l=Math.hypot(...h); return h.map(x=>x/l); };
// radial up from the planet centre
let up=L.radialUp([0,1000,0],[0,0,0]); ok(near(up[1],1),'up over +Y');
up=L.radialUp([700,700,0],[0,0,0]); ok(near(up[0],Math.SQRT1_2)&&near(up[1],Math.SQRT1_2),'up on a slanted site');
up=L.radialUp([5,-3,2],[5,-1003,2]); ok(near(up[1],1),'flat frame: centre far below -> world Y');
// random attitudes on random sites: level result has pitch 0, no roll, heading kept
let seed=7; const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
for(let i=0;i<500;i++){
  const pos=[rnd()*2000-1000,rnd()*2000-1000,rnd()*2000-1000], u=L.radialUp(pos,[10,-20,5]);
  const q0=qAxis([rnd()-.5,rnd()-.5,rnd()-.5],rnd()*6.2), q1=L.level(q0,u);
  const f0=L.rot(q0,[0,0,-1]), f1=L.rot(q1,[0,0,-1]), r1=L.rot(q1,[1,0,0]), u1=L.rot(q1,[0,1,0]);
  if(Math.abs(dot(f0,u))>0.99) continue;
  ok(near(dot(f1,u),0,1e-9),'nose on horizon '+i);
  ok(near(dot(r1,u),0,1e-9),'wings level (right vector on horizon) '+i);
  ok(near(dot(u1,u),1,1e-9),'board up == local up '+i);
  const h0=horiz(f0,u), h1=f1; ok(near(dot(h0,h1),1,1e-9),'heading kept '+i);
  ok(near(Math.hypot(...q1),1,1e-9),'unit quat');
}
// shortest arc: slerp midpoint is half the angle, never the long way; q and -q equivalent
const a=qAxis([0,1,0],0.2), b0=L.level(a,[0,1,0]), b=b0.map(x=>-x);
const tot=L.angle(a,b0); ok(near(L.angle(a,L.slerp(a,b,0.5)),tot/2,1e-9),'half way = half angle (negated target)');
ok(near(L.angle(L.slerp(a,b0,1),b0),0,1e-9)&&near(L.angle(L.slerp(a,b0,0),a),0,1e-9),'slerp ends');
let prev=0; for(let t=0;t<=1.0001;t+=0.05){ const g=L.angle(a,L.slerp(a,b0,L.ease(t))); ok(g>=prev-1e-9,'monotonic'); prev=g; }
// pitched-up and rolled craft over a tilted site, heading east: becomes level and still points east
{ const u2=L.radialUp([300,900,0],[0,0,0]); const q=L.level(qAxis([1,0,0],0.4),u2); // some attitude
  const qr=qmul(qmul(q,qAxis([1,0,0],0.5)),qAxis([0,0,1],0.9)); const q1=L.level(qr,u2);
  ok(near(dot(L.rot(q1,[0,0,-1]),u2),0,1e-9),'tilted site level'); ok(near(dot(L.rot(q1,[0,1,0]),u2),1,1e-9),'tilted site up'); }
// already level -> no change; straight up nose -> finite and level
const lv=L.level(qAxis([0.3,1,0.2],1.1),[0,1,0]); ok(near(L.angle(lv,L.level(lv,[0,1,0])),0,1e-6),'idempotent');
const vert=qAxis([1,0,0],Math.PI/2); const lq=L.level(vert,[0,1,0]); ok(lq.every(Number.isFinite)&&near(L.rot(lq,[0,1,0])[1],1,1e-9),'vertical nose finite');
ok(L.duration(0.01)>=0.6&&L.duration(Math.PI)<=1.2+1e-9,'duration 0.6-1.2');
console.log(fails?fails+' FAILED':'level: all passed'); process.exit(fails?1:0);
