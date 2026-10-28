/* ═══════════════════════════════════════════════════════════════════════════
   ARIEL'S KITE CHARM — a thin necklace around her neck with a tiny kite-shaped charm resting on
   her chest. Everything hangs off ONE bone (Spine02, the chest; the neck sits on it) so it follows
   every animation, the board stance and the root scale. Procedural geometry only, no assets.

   The charm carries a pulsing blue additive glow (a child of the charm mesh, so it can never
   drift off it): a soft orb + inner core + an expanding halo ring + a few crystalline shard
   streaks. Billboard sprites with additive blending, depthWrite false — no custom shader, so it
   works on the WebGPU and the WebGL paths alike. The glow is OFF (hidden, zero cost) normally and
   runs ONLY while the skyboard is on its way back to her:  DMCharm.setReturning(true|false)
   (index.html also drives it from _charmTick: summon, park-off rejoin, fall-catch rescue).
   Fades in ~0.25 s, out ~0.6 s. Kill switch ?charm=0. Nothing is allocated per frame.
   ═══════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  const G={off:/[?&]charm=0\b/.test(location.search),built:false,manual:false,g:0,t:0,last:-1,
    rig:null,kite:null,glow:null,orb:null,core:null,halo:null,shards:null,mats:null,kmat:null,
    FADE_IN:0.25,FADE_OUT:0.6};
  window.DMCharm=G;
  G.setReturning=function(on){ G.manual=!!on; };
  G.stats=function(){ return G.built?{glow:+G.g.toFixed(3),manual:G.manual,visible:!!(G.glow&&G.glow.visible)}:null; };

  function canvasTex(size,draw){
    const c=document.createElement('canvas'); c.width=c.height=size; draw(c.getContext('2d'),size);
    const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; return t;
  }
  function spriteMat(map,r,g,b){
    const m=new THREE.SpriteMaterial({map,color:new THREE.Color(r,g,b),transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,fog:false,toneMapped:false});
    return m;
  }

  G.attach=function(CHAR){
    if(G.off||G.built||!window.THREE||!CHAR||!CHAR.root||!CHAR.bones) return false;
    const bone=CHAR.bones.Spine02||CHAR.bones.Spine01, neck=CHAR.bones.neck||CHAR.bones.Head, head=CHAR.bones.Head, hf=CHAR.bones.headfront;
    if(!bone||!neck||!head) return false;
    const T=THREE;
    CHAR.root.updateMatrixWorld(true);
    const box=new T.Box3().setFromObject(CHAR.root), H=box.max.y-box.min.y; if(!(H>0.01)) return false;
    const nw=neck.getWorldPosition(new T.Vector3()), hw=head.getWorldPosition(new T.Vector3());
    // facing: the way her toes point (feet are level in the bind pose), flattened; falls back to head → headfront
    const up=new T.Vector3(0,1,0), fwd=new T.Vector3(0,0,0), tv=new T.Vector3(), tw=new T.Vector3();
    const B=CHAR.bones, sides=['Left','Right'];
    for(let i=0;i<2;i++){ const f=B[sides[i]+'Foot'], t=B[sides[i]+'ToeBase']; if(f&&t){ t.getWorldPosition(tv); f.getWorldPosition(tw); fwd.add(tv.sub(tw)); } }
    fwd.y=0;
    if(fwd.lengthSq()<1e-10){ if(hf) fwd.copy(hf.getWorldPosition(tv)).sub(hw); fwd.y=0; }
    if(fwd.lengthSq()<1e-10) fwd.set(0,0,1);
    fwd.normalize();
    const right=new T.Vector3().crossVectors(up,fwd).normalize();
    // scan the body's bind-pose vertices (once): chest front depth, neck ring extents (rig axes: x right, y up, z forward)
    const yN=nw.y-0.012*H, yC=nw.y-0.095*H, ax=nw.clone();
    let zF=-1e9, nz0=1e9,nz1=-1e9,nx0=1e9,nx1=-1e9, nn=0;
    const v=new T.Vector3();
    CHAR.root.traverse(sm=>{                                              // every skinned piece (CHAR.skinnedMesh is only the last one)
      if(!sm.isSkinnedMesh||!sm.geometry||!sm.geometry.attributes.position) return;
      const P=sm.geometry.attributes.position, mw=sm.matrixWorld;
      for(let i=0;i<P.count;i++){
        v.fromBufferAttribute(P,i).applyMatrix4(mw).sub(ax);
        const x=v.dot(right), y=v.y, z=v.dot(fwd);
        if(Math.abs(x)<0.045*H&&Math.abs(y-(yC-nw.y))<0.03*H&&z>zF) zF=z;
        if(Math.abs(x)<0.07*H&&Math.abs(z)<0.1*H&&Math.abs(y-(yN-nw.y))<0.012*H){ nn++; if(z<nz0)nz0=z; if(z>nz1)nz1=z; if(x<nx0)nx0=x; if(x>nx1)nx1=x; }
      }
    });
    if(!(zF>-1e8)) zF=0.06*H;
    if(nn<6){ nz0=-0.03*H; nz1=0.035*H; nx0=-0.03*H; nx1=0.03*H; }
    const C=ax.clone().addScaledVector(fwd,zF+0.003*H); C.y=yC;           // charm anchor (top of the kite) on her chest
    // rig: origin at C, axes right/up/fwd, parented to the chest bone (scale compensated by decompose)
    const rig=new T.Object3D(); bone.add(rig);
    const bw=new T.Matrix4().makeBasis(right,up,fwd).setPosition(C);
    rig.matrix.copy(new T.Matrix4().copy(bone.matrixWorld).invert().multiply(bw)); rig.matrix.decompose(rig.position,rig.quaternion,rig.scale);
    rig.name='ArielCharmRig';

    // ── necklace: a thin loop round her neck dipping to the chest at the front
    const yRel=yN-C.y, cx=(nx0+nx1)/2;
    const axisZ=-(zF+0.003*H);                                              // neck axis z, relative to C
    const rz=(nz1-nz0)/2+0.004*H, rx=(nx1-nx0)/2+0.004*H, mz=(nz0+nz1)/2+axisZ;
    const pts=[], N=20;
    for(let i=0;i<N;i++){
      const a=i/N*Math.PI*2, c=Math.cos(a), s=Math.sin(a), w=Math.pow(Math.max(0,c),3);
      const y=yRel*(1-w)+0.006*H*w;
      const zr=mz+rz*c, z=zr*(1-w)+0.003*H*w;
      pts.push(new T.Vector3(cx+rx*s*(1-0.25*w),y,z));
    }
    const chainMat=new T.MeshStandardMaterial({color:0xd8e4f2,metalness:0.9,roughness:0.28,emissive:0x0a1830,emissiveIntensity:0.6});
    const chain=new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts,true,'catmullrom',0.5),64,0.0022*H,5,true),chainMat);
    chain.name='ArielNecklace'; rig.add(chain);

    // ── the kite charm (hangs from the chain's low point), flat diamond with a little bail ring
    const kw=0.016*H, kt=0.050*H, ks=new T.Shape();
    ks.moveTo(0,0.2*kt); ks.lineTo(kw,0); ks.lineTo(0,-0.8*kt); ks.lineTo(-kw,0); ks.closePath();
    const kg=new T.ExtrudeGeometry(ks,{depth:0.0035*H,bevelEnabled:true,bevelThickness:0.0012*H,bevelSize:0.0012*H,bevelSegments:1});
    kg.translate(0,0,-0.00175*H);
    const kmat=new T.MeshStandardMaterial({color:0x9fd2ff,metalness:0.85,roughness:0.22,emissive:0x1b5cff,emissiveIntensity:0.15});
    const kite=new T.Mesh(kg,kmat); kite.name='ArielKiteCharm'; kite.position.set(0,-0.0035*H,0.0025*H); kite.rotation.x=-0.18; rig.add(kite);
    const bail=new T.Mesh(new T.TorusGeometry(0.0036*H,0.0011*H,4,10),chainMat); bail.position.set(0,0.2*kt+0.0026*H,0); kite.add(bail);

    // ── glow: children of the charm mesh, centred on the kite body
    const glow=new T.Group(); glow.name='ArielCharmGlow'; glow.position.set(0,-0.3*kt,0.012*H); glow.visible=false; kite.add(glow);
    const soft=canvasTex(128,(x,s)=>{ const g=x.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2); g.addColorStop(0,'rgba(255,255,255,1)'); g.addColorStop(0.15,'rgba(200,230,255,.7)'); g.addColorStop(0.45,'rgba(90,160,255,.16)'); g.addColorStop(1,'rgba(20,60,255,0)'); x.fillStyle=g; x.fillRect(0,0,s,s); });
    const ring=canvasTex(128,(x,s)=>{ const g=x.createRadialGradient(s/2,s/2,s*0.28,s/2,s/2,s/2); g.addColorStop(0,'rgba(80,150,255,0)'); g.addColorStop(0.72,'rgba(140,200,255,.7)'); g.addColorStop(1,'rgba(40,90,255,0)'); x.fillStyle=g; x.fillRect(0,0,s,s); });
    const streak=canvasTex(64,(x,s)=>{ x.translate(s/2,s/2); const g=x.createLinearGradient(0,-s/2,0,s/2); g.addColorStop(0,'rgba(60,140,255,0)'); g.addColorStop(0.5,'rgba(230,245,255,1)'); g.addColorStop(1,'rgba(60,140,255,0)');
      x.fillStyle=g; x.beginPath(); x.moveTo(0,-s/2); x.lineTo(s*0.09,0); x.lineTo(0,s/2); x.lineTo(-s*0.09,0); x.closePath(); x.fill(); });
    const mk=(tex,r,g,b,order)=>{ const sp=new T.Sprite(spriteMat(tex,r,g,b)); sp.renderOrder=order; sp.frustumCulled=false; glow.add(sp); return sp; };
    G.orb=mk(soft,0.25,0.55,1,12); G.core=mk(soft,0.7,0.88,1,13); G.halo=mk(ring,0.4,0.7,1,11);
    G.shards=[]; const NS=7;
    for(let i=0;i<NS;i++){ const sp=mk(streak,0.55,0.8,1,14); sp.userData={a:i/NS*Math.PI+((i*0.37)%0.4),ph:i*1.9,len:(0.13+0.07*((i*5)%3)/2)*H,sp:0.7+0.25*(i%3)}; G.shards.push(sp); }
    G.H=H; G.rig=rig; G.kite=kite; G.glow=glow; G.kmat=kmat; G.built=true;
    return true;
  };

  /* per frame: ret = skyboard is on its way back to her (OR-ed with setReturning) */
  G.tick=function(dt,ret){
    if(!G.built) return;
    const now=performance.now()*0.001; if(now-G.last<0.002) return; G.last=now;   // both frame loops call this
    dt=dt>0?Math.min(dt,0.1):0.016;
    const want=(ret||G.manual)?1:0;
    G.g+= want?dt/G.FADE_IN:-dt/G.FADE_OUT; if(G.g<0)G.g=0; if(G.g>1)G.g=1;
    if(G.g<=0.002){ if(G.glow.visible){ G.glow.visible=false; G.kmat.emissiveIntensity=0.15; } return; }
    G.glow.visible=true; G.t+=dt;
    const f=G.g*G.g*(3-2*G.g), t=G.t, H=G.H;
    const p=0.5+0.5*Math.sin(t*5.2), p2=0.5+0.5*Math.sin(t*8.3+1.3);       // pulses
    G.kmat.emissiveIntensity=0.15+f*(0.9+0.9*p);
    G.orb.material.opacity=f*(0.5+0.3*p); G.orb.scale.setScalar(H*(0.13+0.04*p));
    G.core.material.opacity=f*(0.7+0.3*p2); G.core.scale.setScalar(H*(0.035+0.012*p2));
    const hp=(t*0.9)%1; G.halo.material.opacity=f*0.55*(1-hp); G.halo.scale.setScalar(H*(0.05+0.11*hp));
    for(let i=0;i<G.shards.length;i++){
      const s=G.shards[i], u=s.userData, fl=Math.max(0,Math.sin(t*(3+u.sp*3)+u.ph)), fl2=fl*fl;
      s.material.rotation=u.a+t*0.35*u.sp*(i&1?1:-1);
      s.material.opacity=f*(0.15+0.85*fl2);
      s.scale.set(H*0.016,u.len*(0.55+0.65*fl)*(0.8+0.3*p),1);
    }
  };
})();
