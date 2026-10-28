/* ═══════════════════════════════════════════════════════════════════════════
   DMProjector — a reusable "laser projector".

   A projector paints an animated light pattern onto whatever surfaces opt in as
   RECEIVERS. There is no decal mesh: the pattern is evaluated per pixel in the
   receiver's own fragment shader (emissive), from the pixel's world position in
   the projector's frame — so it follows every polygon the receiver draws (the
   marching-cubes terrain's rocks, pebbles and cracks included), there is nothing
   to z-fight, and it costs nothing when the projector is off (one uniform branch).

   const P = DMProjector.create({ radius:5, innerRadius:1.7 });
   DMProjector.receive(material, { projector:P });      // any lit node material
   P.center / P.normal / P.radius / P.innerRadius / P.fade   // owned state (plain fields)
   P.tick(dt)                                            // once a frame; no allocation

   Frame: origin C (the ground point under the subject), unit normal N, basis T1/T2
   from N. A fragment at world point W has plane coords x=(W-C)·T1, z=(W-C)·T2,
   r=|(x,z)| and height h=(W-C)·N, faded by |h| (bands off cliffs the plane cannot
   paint) and by the surface normal facing N.

   ZONES: r < innerRadius is the INNER zone, innerRadius..radius the OUTER annulus; a thin
   glowing seam marks innerRadius. A projector may draw either or both (zones.inner/outer = null
   skips one): the ground marker is TWO projectors — red disc (inner only, innerRadius = radius)
   and blue annulus (outer only). Up to 4 projectors can be live on one receiver at once. Each zone has its OWN pattern
   source (swappable independently, e.g. a baked animated texture for the outer one):

     DMProjector.registerPattern(name, fn)   fn(ctx) → vec3 node (zone emissive, before
        the fade/height masks). ctx = { q (0..1 across THIS zone), a01 (0..1 around),
        ang, t (pattern clock), px (anti-alias width in q units), U (uniforms),
        zone:'inner'|'outer', colorU (the zone's colour uniform), P }.
        A texture/flipbook pattern samples with uv = vec2(a01, q) (polar strip) or
        (x,z)-based planar uv and returns rgb.
     P.setZones(innerName, outerName)        re-targets and recompiles the receivers.
   Built in: 'laserRed' (inner) and 'laserBlue' (outer).

   HOOKS (alloc-free uniforms; no gameplay uses them yet)
     P.speed  P.pulse  P.gain   clock scale / pulse amount / brightness
     P.highlight(angleRad, amount)   boosts one arc of both zones (0 = off)
     P.ping(strength)                one expanding ring from the origin
     P.colorInner / P.colorOuter     [r,g,b]
   ═══════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  if(window.DMProjector) return;
  const D={version:1,patterns:Object.create(null),list:[]};
  window.DMProjector=D;
  const TAU=Math.PI*2;
  let _pid=0;

  /* ── pattern registry ─────────────────────────────────────────────── */
  D.registerPattern=function(name,fn){ if(name&&typeof fn==='function') D.patterns[name]=fn; return D; };

  // ---- small helpers shared by the zone patterns (TSL nodes; built once per compile) ----
  function K(c){
    const W=window, F=W.float, sm=W.smoothstep, ab=W.abs, mx=W.max, q=c.q, px=c.px;
    return {W:W,F:F,sm:sm,ab:ab,mx:mx,fr:W.fract,ex:W.exp,
      L:(cen,hw)=>{ const w=mx(F(hw),px.mul(0.8)); return F(1).sub(sm(w,w.add(px.mul(1.6)),ab(q.sub(cen)))); },   // a ring line
      B:(lo,hi)=>sm(F(lo).sub(px),F(lo),q).mul(F(1).sub(sm(F(hi),F(hi).add(px),q))),                              // a radial band
      dashes:(a01,n,rot,on)=>{ const d=W.fract(a01.mul(n).add(rot)); return sm(0.0,0.04,d).mul(F(1).sub(sm(on-0.05,on,d))); } };
  }
  // INNER zone (red): measurement rings, ticks, comet, dots and a centre crosshair — all inside the character-height circle
  D.registerPattern('laserRed',function(c){
    const k=K(c), W=k.W, F=k.F, sm=k.sm, ab=k.ab, U=c.U, a=c.a01, t=c.t, px=c.px, q=c.q;
    const pu=U.pulse.mul(W.sin(t.mul(2.4)));
    const br=F(0.86).add(pu.mul(0.14));
    const r1=t.mul(0.13), r2=t.mul(-0.09), r3=t.mul(0.06);
    const core=k.L(0.84,0.03);                                          // solid ring just inside the seam
    const halo=k.ex(q.sub(0.84).div(0.12).pow2().negate()).mul(0.28);
    const mid=k.L(0.60,0.012).mul(k.dashes(a,22,r2.mul(3),0.6)).mul(0.8);   // dashed ring, counter-rotating
    const inner=k.L(0.34,0.01).mul(0.55).mul(F(0.8).add(pu.mul(0.2)));     // faint inner ring (breathes)
    const s=W.fract(a.sub(t.mul(0.2)));
    const comet=k.L(0.84,0.06).mul(k.ex(s.mul(-7))).mul(1.6);               // scanning comet on the main ring
    const tk=a.mul(60).add(r1.mul(6)), idx=W.floor(tk);
    const tick=F(1).sub(sm(0.05,0.1,ab(W.fract(tk).sub(0.5))));
    const major=F(1).sub(W.step(F(0.1667),W.fract(idx.add(0.5).div(6))));
    const hiR=F(0.745).add(major.mul(0.06));
    const ticks=tick.mul(sm(F(0.685).sub(px),F(0.685),q).mul(F(1).sub(sm(hiR,hiR.add(px),q)))).mul(F(0.55).add(major.mul(0.45)));   // measurement ticks
    const dc=W.fract(a.mul(8).add(r3)).sub(0.5);
    const dd=W.length(W.vec2(dc.mul(TAU*0.47/8),q.sub(0.47)));
    const dots=F(1).sub(sm(F(0.02),F(0.02).add(px.mul(1.6)),dd));
    const arm=F(1).sub(sm(0.012,px.mul(1.6).add(0.012),W.min(ab(c.x),ab(c.z)).div(c.zs))).mul(sm(F(0.07),F(0.08),q)).mul(F(1).sub(sm(0.17,0.18,q)));
    const dot=F(1).sub(sm(0.03,px.mul(1.6).add(0.03),q));
    const hot=core.add(comet.mul(0.8)).add(dots).add(dot);
    const soft=halo.add(mid).add(inner).add(ticks).add(arm.mul(0.9)).add(comet.mul(0.2)).add(B_(k,q,px));
    return c.colorU.mul(soft.add(core.mul(0.5)).add(dots.mul(0.6))).add(W.vec3(1.0,0.55,0.45).mul(U.gain).mul(hot).mul(0.5)).mul(br);
  });
  function B_(k,q,px){ return k.F(0); }   // no fill: the red zone is laser lines only (the old 5% disc read as a see-through red sheet)

  // OUTER zone (blue): the annulus is a circular frame band for the skyboard's extended bounds
  D.registerPattern('laserBlue',function(c){
    const k=K(c), W=k.W, F=k.F, sm=k.sm, ab=k.ab, U=c.U, a=c.a01, t=c.t, px=c.px, q=c.q;
    const pu=U.pulse.mul(W.sin(t.mul(2.0).add(1.3)));
    const br=F(0.86).add(pu.mul(0.14));
    const r1=t.mul(-0.1), r2=t.mul(0.07), r3=t.mul(0.045);
    const edge=k.L(0.965,0.022);                                       // crisp outer frame line
    const hair=k.L(0.12,0.006).mul(0.5);                               // hairline just outside the seam
    const halo=k.ex(q.sub(0.965).div(0.07).pow2().negate()).mul(0.22);
    // frame band: chunky dash bars counter-rotating, with a thin dashed hairline inside it
    const bars=k.B(0.62,0.80).mul(k.dashes(a,30,r1.mul(4),0.55)).mul(0.65);
    const thin=k.L(0.52,0.006).mul(k.dashes(a,64,r2.mul(8),0.4)).mul(0.55);
    // measurement ticks hugging the outer frame (every 8th long)
    const tk=a.mul(96).add(r2.mul(10)), idx=W.floor(tk);
    const tick=F(1).sub(sm(0.05,0.1,ab(W.fract(tk).sub(0.5))));
    const major=F(1).sub(W.step(F(0.125),W.fract(idx.add(0.5).div(8))));
    const loR=F(0.88).sub(major.mul(0.06));
    const ticks=tick.mul(sm(loR.sub(px),loR,q).mul(F(1).sub(sm(F(0.935),F(0.935).add(px),q)))).mul(F(0.5).add(major.mul(0.5)));
    const s=W.fract(a.sub(t.mul(0.13)));
    const comet=k.L(0.965,0.05).mul(k.ex(s.mul(-6))).mul(1.4);          // scanning arc on the frame
    const dc=W.fract(a.mul(10).add(r3)).sub(0.5);
    const dd=W.length(W.vec2(dc.mul(TAU*0.34/10).div(1.0),q.sub(0.34)));  // dots, arclength in q units (annulus ≈ same scale)
    const dots=F(1).sub(sm(F(0.025),F(0.025).add(px.mul(1.6)),dd));
    const haze=F(0);                                                  // no fill: the blue zone is laser lines only
    const soft=halo.add(bars).add(thin).add(ticks).add(hair).add(haze).add(comet.mul(0.25));
    const hot=edge.add(comet.mul(0.8)).add(dots);
    return c.colorU.mul(soft.add(edge.mul(0.55)).add(dots.mul(0.5))).add(W.vec3(0.55,0.8,1.0).mul(U.gain).mul(hot).mul(0.5)).mul(br);
  });

  /* ── projector instances ──────────────────────────────────────────── */
  function nodeKit(P){
    const u=window.uniform;
    P.U={
      c:u(new THREE.Vector3()), n:u(new THREE.Vector3(0,1,0)), t1:u(new THREE.Vector3(1,0,0)), t2:u(new THREE.Vector3(0,0,1)),
      R:u(1), Ri:u(0.5), band:u(1), t:u(0), fade:u(0), pulse:u(1), gain:u(2.3),
      colIn:u(new THREE.Vector3(1,.12,.08)), colOut:u(new THREE.Vector3(.1,.45,1)),
      hiAng:u(0), hiAmt:u(0), pingT:u(9), pingK:u(0)
    };
  }

  D.create=function(o){
    o=o||{};
    const P={id:++_pid,center:new THREE.Vector3(),normal:new THREE.Vector3(0,1,0),radius:+o.radius||5,innerRadius:+o.innerRadius||1.7,
      fade:0,time:0,speed:o.speed!==undefined?+o.speed:1,pulse:o.pulse!==undefined?+o.pulse:1,gain:o.gain||2.3,
      zones:{inner:o.inner===undefined?'laserRed':o.inner,outer:o.outer===undefined?'laserBlue':o.outer},
      colorInner:o.colorInner||[1,.12,.08],colorOuter:o.colorOuter||[.1,.45,1],
      active:false,enabled:true,bandK:o.bandK||0.5,_recv:[],_pingAge:9,_pingK:0,_hiA:0,_hiK:0,_ready:false};
    nodeKit(P); P._ready=true;
    P.highlight=function(angle,amount){ P._hiA=+angle||0; P._hiK=+amount||0; return P; };   // hook: a brighter arc of the rims
    P.ping=function(strength){ P._pingAge=0; P._pingK=strength===undefined?1:+strength; return P; };  // hook: one expanding ring
    P.setZones=function(inner,outer){
      if((inner&&!D.patterns[inner])||(outer&&!D.patterns[outer])) return P;
      P.zones.inner=inner||null; P.zones.outer=outer||null; D._rebuild(P); return P;   // null = that zone is not drawn
    };
    // once per frame: pushes plain fields into uniforms; nothing is allocated
    P.tick=function(dt,clock){
      const U=P.U, f=P.enabled?P.fade:0;
      P.active=f>0.001;
      U.fade.value=P.active?f:0;                  // 0 → every receiver's branch is skipped entirely
      if(!P.active) return P;
      dt=dt>0?Math.min(dt,0.1):0.016;
      if(clock!==undefined) P.time=clock;                 // several projectors can share one pattern clock
      else { P.time+=dt*P.speed; if(P.time>6283) P.time-=6283; }   // (keeps float precision on long sessions)
      U.t.value=P.time; U.pulse.value=P.pulse; U.gain.value=P.gain;
      let c=P.colorInner; U.colIn.value.set(c[0]*P.gain,c[1]*P.gain,c[2]*P.gain);
      c=P.colorOuter; U.colOut.value.set(c[0]*P.gain,c[1]*P.gain,c[2]*P.gain);
      U.R.value=P.radius; U.Ri.value=Math.max(0.0001,Math.min(P.innerRadius,P.radius)); U.band.value=Math.max(0.6,P.radius*P.bandK);
      U.c.value.copy(P.center);
      // orthonormal basis of the tangent plane from the normal (no allocation)
      const n=P.normal; let nx=n.x,ny=n.y,nz=n.z; const l=Math.hypot(nx,ny,nz)||1; nx/=l; ny/=l; nz/=l;
      U.n.value.set(nx,ny,nz);
      let ax=1-nx*nx, ay=-nx*ny, az=-nx*nz; const al0=Math.hypot(ax,ay,az); let al=al0;
      if(al<1e-4){ ax=0; ay=0; az=1; al=1; }
      ax/=al; ay/=al; az/=al;
      U.t1.value.set(ax,ay,az);
      U.t2.value.set(ny*az-nz*ay, nz*ax-nx*az, nx*ay-ny*ax);   // n × t1
      U.hiAng.value=P._hiA; U.hiAmt.value=P._hiK;
      if(P._pingK>0){ P._pingAge+=dt*0.7; if(P._pingAge>=1){ P._pingK=0; P._pingAge=9; } }
      U.pingT.value=P._pingAge; U.pingK.value=P._pingK;
      return P;
    };
    D.list.push(P);
    return P;
  };

  /* ── the shared shader chunk ──────────────────────────────────────── */
  // → a vec3 emissive node for world position `pos` (in the frame the projector's
  //   origin is written in) and surface normal `nrm`. One uniform branch on fade,
  //   one on the outer radius, one inner/outer zone split.
  // The body must run inside a Fn, with the shared per-pixel inputs (pos, unit normal, pixel size) declared as vars
  // BEFORE any projector's If: a cached node first built inside one projector's branch would otherwise be left
  // uninitialised when the next projector's chunk reuses it outside that branch (NaN → black).
  D.chunkBody=function(P,pos,nrm,pxw){
    const W=window, U=P.U, F=W.float, sm=W.smoothstep;
    const patIn=D.patterns[P.zones.inner]||null, patOut=D.patterns[P.zones.outer]||null, lim=patOut?1.03:1.06;
    {
      const out=W.vec3(0).toVar();
      W.If(U.fade.greaterThan(0.001),function(){
        const d=pos.sub(U.c);
        const x=W.dot(d,U.t1), z=W.dot(d,U.t2), h=W.dot(d,U.n);
        const r=W.sqrt(x.mul(x).add(z.mul(z)));
        W.If(r.lessThan(U.R.mul(lim)),function(){
          const ang=W.atan(z,x), a01=ang.div(TAU).add(0.5);
          const col=W.vec3(0).toVar();
          const ctxBase={x:x,z:z,a01:a01,ang:ang,t:U.t,U:U,P:P};
          const inFn=function(){ const zs=U.Ri; col.assign(patIn(Object.assign({q:r.div(zs),px:pxw.div(zs),zs:zs,zone:'inner',colorU:U.colIn},ctxBase))); };
          const outFn=function(){ const zs=U.R.sub(U.Ri); col.assign(patOut(Object.assign({q:r.sub(U.Ri).div(zs),px:pxw.div(zs),zs:zs,zone:'outer',colorU:U.colOut},ctxBase))); };
          if(patIn&&patOut) W.If(r.lessThan(U.Ri),inFn).Else(outFn);
          else if(patIn) W.If(r.lessThan(U.Ri.mul(1.0)),inFn);
          else if(patOut) W.If(r.greaterThanEqual(U.Ri),outFn);
          // crisp seam between the zones: a thin hot line with a short glow either side
          const pxs=pxw.mul(1.2), ds=W.abs(r.sub(U.Ri));
          const seam=F(1).sub(sm(pxs,pxs.mul(2.2).add(0.012),ds)).add(W.exp(ds.div(0.07).pow2().negate()).mul(0.22));
          col.addAssign(W.vec3(1.0,0.78,0.85).mul(U.gain).mul(seam).mul(0.55));
          // dissolve: per-cell noise against the fade (a fully faded marker leaves nothing)
          const cell=W.floor(a01.mul(96)).mul(12.9898).add(W.floor(r.div(U.R).mul(26)).mul(78.233));
          const nz=W.fract(W.sin(cell).mul(43758.5453));
          const vis=W.clamp(U.fade.mul(1.6).sub(nz.mul(0.6)),0,1);
          // the optional highlighted arc (hook) and ping ring (hook)
          const hl=F(1).add(U.hiAmt.mul(sm(0.55,1.0,W.cos(ang.sub(U.hiAng)))));
          const pr=W.min(U.pingT.mul(0.9),F(1.05)).mul(U.R);
          const ping=F(1).sub(sm(0.02,0.07,W.abs(r.sub(pr)))).mul(U.pingK).mul(F(1).sub(W.min(U.pingT,F(1)))).mul(U.gain);
          // off the projector's plane / facing away from it: the cliff and overhang mask
          const hm=F(1).sub(sm(U.band.mul(0.55),U.band,W.abs(h)));
          const face=sm(0.12,0.5,W.dot(nrm,U.n));
          const edge=F(1).sub(sm(U.R.mul(lim-0.045),U.R.mul(lim),r));
          out.assign(col.mul(hl).add(W.vec3(1.0,0.8,0.5).mul(ping)).mul(vis).mul(hm).mul(face).mul(edge));
        });
      });
      return out;
    }
  };
  D.chunk=function(P,pos,nrm){ return D.chunkAll([P],pos,nrm); };
  D.chunkAll=function(list,pos,nrm){
    const W=window;
    return W.Fn(function(){
      const pw=pos.toVar(), nn=W.normalize(nrm).toVar(), pxw=W.length(W.positionView).mul(0.0022).toVar();   // ≈ one pixel in world units
      const tot=W.vec3(0).toVar();
      for(const P of list) tot.addAssign(D.chunkBody(P,pw,nn,pxw));
      return tot;
    })();
  };

  // opt a lit node material in (idempotent). o: {projectors:[P…] (default: every projector, max 4), pos?, normal?}
  // Every projector adds its own emissive term, each inside its own uniform branch.
  D.MAX=4;
  D.receive=function(mat,o){
    if(!mat||!(mat.isNodeMaterial||mat.isMeshStandardNodeMaterial)) return false;
    const W=window, list=((o&&o.projectors)||(o&&o.projector&&[o.projector])||D.list).filter(function(p){ return p&&p._ready; }).slice(0,D.MAX);
    if(!list.length) return false;
    const info=mat.userData._dmproj||(mat.userData._dmproj={});
    const base=info.base!==undefined?info.base:(info.base=mat.emissiveNode||null);   // the emissive it had before we touched it
    const pos=(o&&o.pos)||W.positionWorld, nrm=(o&&o.normal)||W.normalWorld;
    let key=''; for(const P of list) key+=P.id+':'+P.zones.inner+'|'+P.zones.outer+';';
    mat.emissiveNode=(base||W.materialEmissive).add(D.chunkAll(list,pos,nrm));
    if(info.key!==key){ info.key=key; info.id=list[0].id; mat.needsUpdate=true; }
    if(!info.reg){ info.reg=true; for(const P of list){ P._recv.push({m:typeof WeakRef==='function'?new WeakRef(mat):{deref:()=>mat},o:{pos:o&&o.pos,normal:o&&o.normal,list:list}}); if(P._recv.length>96) P._recv.shift(); } }
    return true;
  };
  D._rebuild=function(P){
    for(const r of P._recv){ const m=r.m.deref(); if(m) D.receive(m,{projectors:r.o.list,pos:r.o.pos,normal:r.o.normal}); }
  };
  D.isReceiver=function(mat){ return !!(mat&&mat.userData&&mat.userData._dmproj&&mat.userData._dmproj.id); };
})();
