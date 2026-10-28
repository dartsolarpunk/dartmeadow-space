/* ═══════════════════════════════════════════════════════════════════════════
   ARIEL'S KITE CHARM — a thin necklace around her neck with a tiny kite-shaped charm resting on
   her chest. Everything hangs off ONE bone (Spine02, the chest; the neck sits on it) so it follows
   every animation, the board stance and the root scale. Procedural geometry only, no assets.

   The charm carries a pulsing blue additive glow (a child of the charm mesh, so it can never
   drift off it) that hugs the kite's own 3D contour: 3 inflated shells of the charm geometry
   (offset along smoothed normals) with a fresnel rim (TSL node material; plain additive basic
   material if TSL is missing) + a few small shards lying along the kite edges. depthWrite false. The glow is OFF (hidden, zero cost) normally and
   runs ONLY while the skyboard is on its way back to her:  DMCharm.setReturning(true|false)
   (index.html also drives it from _charmTick: summon, park-off rejoin, fall-catch rescue).
   Fades in ~0.25 s, out ~0.6 s. Kill switch ?charm=0. Nothing is allocated per frame.
   ═══════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  const G={off:/[?&]charm=0\b/.test(location.search),built:false,manual:false,g:0,t:0,last:-1,
    rig:null,kite:null,glow:null,shells:null,shards:null,kmat:null,
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

    // ── glow: a few inflated shells of the kite's OWN geometry (smoothed normals, pushed outward by a hair), additive
    //    with a fresnel rim, plus small shards hugging the kite edges. All children of the charm mesh.
    const glow=new T.Group(); glow.name='ArielCharmGlow'; glow.visible=false; kite.add(glow);
    const TS=T.TSL, nodeOK=!!(TS&&T.MeshBasicNodeMaterial&&TS.uniform&&TS.vec3&&TS.normalView&&TS.positionViewDirection);
    function inflated(src,d){                                              // weld by position → smooth normals → offset along them
      const g=src.clone(), P=g.attributes.position, N=g.attributes.normal, key=new Map(), q=1/(H*1e-5), sm=[];
      for(let k=0;k<P.count;k++){ const kk=Math.round(P.getX(k)*q)+'|'+Math.round(P.getY(k)*q)+'|'+Math.round(P.getZ(k)*q); let e=key.get(kk); if(!e){ e=[0,0,0]; key.set(kk,e); } e[0]+=N.getX(k); e[1]+=N.getY(k); e[2]+=N.getZ(k); sm.push(e); }
      for(let k=0;k<P.count;k++){ const e=sm[k], l=Math.hypot(e[0],e[1],e[2])||1, nx=e[0]/l, ny=e[1]/l, nz=e[2]/l;
        P.setXYZ(k,P.getX(k)+nx*d,P.getY(k)+ny*d,P.getZ(k)+nz*d); N.setXYZ(k,nx,ny,nz); }
      P.needsUpdate=true; N.needsUpdate=true; return g;
    }
    function glowMat(r,gc,b,pw){
      if(!nodeOK){ const m=new T.MeshBasicMaterial({color:new T.Color(r,gc,b),transparent:true,opacity:0,blending:T.AdditiveBlending,depthWrite:false,side:T.DoubleSide,fog:false,toneMapped:false}); return {m,set:v=>{ m.opacity=Math.min(1,v*0.3); }}; }
      const u=TS.uniform(0), m=new T.MeshBasicNodeMaterial({transparent:true,blending:T.AdditiveBlending,depthWrite:false,side:T.DoubleSide});
      const rim=TS.float(1).sub(TS.normalize(TS.normalView).dot(TS.positionViewDirection).abs().clamp(0,1)).pow(pw);   // 0 face-on → 1 at the silhouette
      m.colorNode=TS.vec3(r,gc,b).mul(TS.float(0.05).add(rim.mul(2.0)).mul(u)); m.fog=false; m.toneMapped=false;
      return {m,set:v=>{ u.value=v; }};
    }
    G.shells=[]; const SH=[[0.0016,0.55,0.85,1,2.2,1.0],[0.0034,0.3,0.62,1,1.8,0.7],[0.0058,0.18,0.42,1,1.4,0.45]];   // offset/H, rgb, rim power, gain
    for(let k=0;k<SH.length;k++){ const c=SH[k], gm=glowMat(c[1],c[2],c[3],c[4]), me=new T.Mesh(inflated(kg,c[0]*H),gm.m); me.renderOrder=11+k; me.frustumCulled=false; me.name='ArielCharmShell'+k; glow.add(me); G.shells.push({mesh:me,set:gm.set,gain:c[5],ph:k*0.9}); }
    const streak=canvasTex(64,(x,s)=>{ x.translate(s/2,s/2); const g=x.createLinearGradient(0,-s/2,0,s/2); g.addColorStop(0,'rgba(60,140,255,0)'); g.addColorStop(0.5,'rgba(230,245,255,1)'); g.addColorStop(1,'rgba(60,140,255,0)');
      x.fillStyle=g; x.beginPath(); x.moveTo(0,-s/2); x.lineTo(s*0.12,0); x.lineTo(0,s/2); x.lineTo(-s*0.12,0); x.closePath(); x.fill(); });
    const sg=new T.PlaneGeometry(1,1), V=[[0,0.2*kt],[kw,0],[0,-0.8*kt],[-kw,0]];           // the kite's four corners
    G.shards=[]; const NS=6;
    for(let i=0;i<NS;i++){                                                  // a shard lying along an edge, a little off the face
      const a=V[i%4], b=V[(i+1)%4], u=0.3+0.4*((i*0.37)%1), ex=b[0]-a[0], ey=b[1]-a[1], el=Math.hypot(ex,ey);
      const m=new T.MeshBasicMaterial({map:streak,color:new T.Color(0.6,0.85,1),transparent:true,opacity:0,blending:T.AdditiveBlending,depthWrite:false,side:T.DoubleSide,fog:false,toneMapped:false});
      const me=new T.Mesh(sg,m); me.position.set(a[0]+ex*u,a[1]+ey*u,(i&1?-1:1)*0.0042*H); me.rotation.z=Math.atan2(ey,ex)-Math.PI/2;
      me.scale.set(0.022*H,el*0.6,1); me.renderOrder=14; me.frustumCulled=false; me.userData={ph:i*1.9,sp:0.7+0.25*(i%3),l0:el*0.6}; glow.add(me); G.shards.push(me); }
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
    for(let i=0;i<G.shells.length;i++){ const sh=G.shells[i]; sh.set(f*sh.gain*(0.7+0.9*(0.5+0.5*Math.sin(t*5.2-sh.ph)))); }   // pulse ripples outward shell by shell
    for(let i=0;i<G.shards.length;i++){
      const s=G.shards[i], u=s.userData, fl=Math.max(0,Math.sin(t*(3+u.sp*3)+u.ph));
      s.material.opacity=f*(0.1+0.9*fl*fl); s.scale.y=s.userData.l0*(0.6+0.5*fl)*(0.85+0.25*p2);
    }
  };
})();
