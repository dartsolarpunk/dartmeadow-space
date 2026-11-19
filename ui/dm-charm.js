/* ═══════════════════════════════════════════════════════════════════════════
   ARIEL'S KITE CHARM + NECKLACE - a thin chain round the BASE OF HER NECK (resting on the shoulder yoke, above the shirt's neckline) with a tiny kite-shaped charm
   hanging from its front, lying on her upper chest.  Both are a small VERLET simulation (ui/dm-necklace-sim.js, ~16 links + the charm, a few capsule colliders for the
   neck / shoulders / chest / back, all in the local space of 'ArielNeckRig' = a child of the upper-spine bone 'Spine'), so they follow every animation, the board stance
   and the root scale, swing a little when she moves and can never pass through her neck, chest or shirt.  Chain, charm and body collide with each other.
   Nodes: ArielNeckRig > ArielNecklace > { ArielNecklaceChain (tube, rewritten each frame), ArielKiteCharm > { bail ring, ArielCharmGlow } }.
   ArielCharmRig (a child of Spine02, the old chest anchor) is kept exactly where it was: ui/dm-hazard.js parents her chest LED to DMCharm.rig.
   Kill switches: ?charm=0 (everything), ?neckphys=0 (static rest pose, no solver).  Without ui/dm-necklace-sim.js it falls back to the same shape, static.

   The charm carries a pulsing blue additive glow (a child of the charm mesh, so it can never
   drift off it) that hugs the kite's own 3D contour: 3 inflated shells of the charm geometry
   (offset along smoothed normals) with a fresnel rim (TSL node material; plain additive basic
   material if TSL is missing) + a few small shards lying along the kite edges. depthWrite false. The glow is OFF (hidden, zero cost) normally and
   runs ONLY while the skyboard is on its way back to her:  DMCharm.setReturning(true|false)
   (index.html also drives it from _charmTick: summon, park-off rejoin, fall-catch rescue).
   Fades in ~0.25 s, out ~0.6 s. Nothing is allocated per frame.
   ═══ */
(function(){
  'use strict';
  const G={off:/[?&]charm=0\b/.test(location.search),nophys:/[?&]neckphys=0\b/.test(location.search),built:false,manual:false,g:0,t:0,last:-1,
    rig:null,kite:null,glow:null,shells:null,shards:null,kmat:null,
    FADE_IN:0.25,FADE_OUT:0.6,lid:null,wp:null,lastI:0,LIGHT_I:0.02,LIGHT_MAX:0.03,LIGHT_R:1.2};
  window.DMCharm=G;
  G.setReturning=function(on){ G.manual=!!on; };
  G.stats=function(){ const S=G.sim; return G.built?{glow:+G.g.toFixed(3),manual:G.manual,visible:!!(G.glow&&G.glow.visible),light:G.lid!=null,lightI:+G.lastI.toFixed(4),
    neck:S?{steps:G.phys.steps,ms:+G.phys.ms.toFixed(3),resets:S.resets,linkErr:+S.maxLinkError().toFixed(3),pen:+(S.penetration(G.caps,G.nCaps)/G.u*1000).toFixed(2),asleep:G.sleep}:null}:null; };

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
    // the GLB still carries its ORIGINAL baked necklace (a thin chain 'Tube.021' round the neck base + the kite 'Charm.001' on the upper chest, (three strips the dots from node names: 'Charm001' / 'Tube021') both bone-skinned, so they never moved and the
    // charm tip pokes through the shirt).  This simulated necklace replaces them: hide the baked pieces (same body part, no GLB edit).
    CHAR.root.traverse(o=>{ if(o.isMesh&&/^(Charm|Tube0*21$|Tube0*4$)/.test(o.name||'')) o.visible=false; });
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

    // ── necklace + charm: a verlet chain round the BASE OF HER NECK (ui/dm-necklace-sim.js) with the kite hanging from its front, in a rig on the UPPER SPINE bone.
    //    (G.rig above = the old chest anchor on Spine02, kept untouched: ui/dm-hazard.js parents her chest LED to it.)
    const u=H/1.7;                                                         // the colliders below are measured on the Ariel GLB (1.7 m tall): u scales them to any size
    const spineB=CHAR.bones.Spine||CHAR.bones.Spine01||bone;
    const nrig=new T.Object3D(); nrig.name='ArielNeckRig'; spineB.add(nrig);
    const nbw=new T.Matrix4().makeBasis(right,up,fwd).setPosition(nw);     // origin = the neck bone's head (the base of the neck), axes right / up / forward
    spineB.updateWorldMatrix(true,false);
    nrig.matrix.copy(new T.Matrix4().copy(spineB.matrixWorld).invert().multiply(nbw)); nrig.matrix.decompose(nrig.position,nrig.quaternion,nrig.scale);
    nrig.updateWorldMatrix(false,false);
    const kt=0.050*H, kw=0.016*H;                                          // kite height / half width (as before)
    const chainR=0.0020*u, charmLen=kt+0.0026*H;                          // chain radius, bail centre -> tip
    G.u=u; G.nrig=nrig; G.nbw=nbw; G.spine=spineB;
    // body colliders: the table lives in ui/dm-necklace-sim.js (DMNecklaceSim.ARIEL.colliders: round cones in the rig frame, metres on a 1.7 m body, each END with a bone -> weight table taken from
    // the GLB's own skin weights - the neck / collar of this rig follows 'Head' by 25-55 %, not only 'Spine' - so every end is skinned like the mesh around it and the colliders move where her
    // skin and shirt move).  +x = her left (LeftShoulder).
    G.v3=new T.Vector3(); G.v4=new T.Vector3();
    const SIM=window.DMNecklaceSim, COL=SIM?SIM.ARIEL.colliders:[];
    const NC=COL.length, caps=new Float64Array(Math.max(1,NC)*9), cb=[], bl=[];         // caps: per frame, in rig-local space; bl = the distinct bones used
    const tv3=new T.Vector3();
    for(let c=0;c<NC;c++){
      const d=COL[c], ends=[];
      for(let e=0;e<2;e++){
        const W=e?d.wb:d.wa, P0=e?d.b:d.a, list=[]; let ws=0; for(const k in W) if(CHAR.bones[k]) ws+=W[k];
        tv3.set(P0[0],P0[1],P0[2]).multiplyScalar(u).applyMatrix4(nbw);                 // bind pose, world
        for(const k in W){ const bn=CHAR.bones[k]; if(!bn) continue; bn.updateWorldMatrix(true,false); let bi=bl.indexOf(bn); if(bi<0){ bi=bl.length; bl.push(bn); }
          const loc=bn.worldToLocal(tv3.clone()); list.push([bi,loc.x,loc.y,loc.z,W[k]/(ws||1)]); }
        if(!list.length){ const bn=spineB; let bi=bl.indexOf(bn); if(bi<0){ bi=bl.length; bl.push(bn); } const loc=bn.worldToLocal(tv3.clone()); list.push([bi,loc.x,loc.y,loc.z,1]); }
        ends.push(list);
      }
      cb.push(ends); const o=c*9; caps[o+6]=d.ra*u; caps[o+7]=d.rb*u; caps[o+8]=d.kx;
    }
    G.caps=caps; G.capBones=cb; G.bl=bl; G.nCaps=NC; G.mCs=bl.map(()=>new T.Matrix4());
    const sim=SIM?SIM.createAriel(u):null;
    const NN=sim?sim.N:16, rest=new Float64Array((NN+1)*3);
    // rest pose: bind-pose body colliders in rig space -> pre-roll the loop until it hangs still, then mirror it (a necklace hangs symmetrically) and let it settle once more
    function bindCaps(){ const inv=new T.Matrix4().copy(nrig.matrixWorld).invert(); for(let i=0;i<bl.length;i++){ bl[i].updateWorldMatrix(true,false); G.mCs[i].multiplyMatrices(inv,bl[i].matrixWorld); } G.skinCaps(); }
    G.skinCaps=function(){ const v=G.v3, w=G.v4; for(let c=0;c<NC;c++) for(let e=0;e<2;e++){ const L=cb[c][e]; let x=0,y=0,z=0;
        for(let k=0;k<L.length;k++){ const q=L[k]; v.set(q[1],q[2],q[3]).applyMatrix4(G.mCs[q[0]]); x+=v.x*q[4]; y+=v.y*q[4]; z+=v.z*q[4]; }
        const o=c*9+e*3; caps[o]=x; caps[o+1]=y; caps[o+2]=z; } };
    bindCaps();
    const gdir=new T.Vector3(), gl=[0,0,0];
    function gravityLocal(){ gdir.set(0,-1,0).transformDirection(new T.Matrix4().copy(nrig.matrixWorld).invert()); /* transformDirection normalises */ const g=9.81*u; gl[0]=gdir.x*g; gl[1]=gdir.y*g; gl[2]=gdir.z*g; }
    gravityLocal();
    if(sim){ SIM.settle(sim,caps,NC,gl,u); for(let i=0;i<rest.length;i++) rest[i]=sim.rest[i]; }   // pre-roll on the bind-pose colliders, mirror, settle: that is the rest pose (soft tether on)
    else {                                                                  // no solver file: a static loop (rest = analytic ring + the kite hanging), nothing moves
      for(let i=0;i<NN;i++){ const a=i/NN*Math.PI*2; rest[i*3]=0.06*u*Math.sin(a); rest[i*3+1]=(0.045-0.012*Math.max(0,Math.cos(a)))*u; rest[i*3+2]=0.058*u*Math.cos(a); }
      rest[NN*3]=0; rest[NN*3+1]=rest[1]-charmLen; rest[NN*3+2]=rest[2]+0.004*u;
    }
    const necklace=new T.Group(); necklace.name='ArielNecklace'; nrig.add(necklace);   // the chain AND the charm live under this one node
    // chain tube: closed loop, 2 rings per link (4-point subdivision), 5 sides; positions rewritten every frame
    const RR=5, NR=NN*2, rc=0.0020*u, tubeP=new Float32Array(NR*RR*3), tubeN=new Float32Array(NR*RR*3), idx=[];
    for(let i=0;i<NR;i++){ const j=(i+1)%NR; for(let k=0;k<RR;k++){ const k2=(k+1)%RR; idx.push(i*RR+k,j*RR+k,j*RR+k2, i*RR+k,j*RR+k2,i*RR+k2); } }
    const tg=new T.BufferGeometry(); tg.setAttribute('position',new T.BufferAttribute(tubeP,3).setUsage(T.DynamicDrawUsage)); tg.setAttribute('normal',new T.BufferAttribute(tubeN,3).setUsage(T.DynamicDrawUsage)); tg.setIndex(idx);
    const chainMat=new T.MeshStandardMaterial({color:0xd8e4f2,metalness:0.9,roughness:0.28,emissive:0x0a1830,emissiveIntensity:0.6});
    const chain=new T.Mesh(tg,chainMat); chain.name='ArielNecklaceChain'; chain.frustumCulled=false; chain.castShadow=false; necklace.add(chain);
    const pt=new Float64Array(NR*3);
    function buildTube(X){                                                       // X = sim positions (chain nodes first)
      for(let i=0;i<NN;i++){ const i3=i*3, j3=((i+1)%NN)*3, h3=((i+NN-1)%NN)*3, k3=((i+2)%NN)*3;
        for(let c=0;c<3;c++){ pt[(i*2)*3+c]=X[i3+c]; pt[(i*2+1)*3+c]=(9*(X[i3+c]+X[j3+c])-(X[h3+c]+X[k3+c]))/16; } }
      for(let i=0;i<NR;i++){
        const p3=i*3, a3=((i+NR-1)%NR)*3, b3=((i+1)%NR)*3; let tx=pt[b3]-pt[a3], ty=pt[b3+1]-pt[a3+1], tz=pt[b3+2]-pt[a3+2]; const tl=Math.hypot(tx,ty,tz)||1; tx/=tl; ty/=tl; tz/=tl;
        let nx=-tz, ny=0, nz=tx, nl=Math.hypot(nx,ny,nz);                          // n = t x up(0,1,0) if(nl<1e-6){ nx=1; ny=0; nz=0; nl=1; } nx/=nl; ny/=nl; nz/=nl;
        const mx=ty*nz-tz*ny, my=tz*nx-tx*nz, mz=tx*ny-ty*nx;                      // t x n
        for(let k=0;k<RR;k++){ const an=k/RR*Math.PI*2, cs=Math.cos(an), sn=Math.sin(an), vx=nx*cs+mx*sn, vy=ny*cs+my*sn, vz=nz*cs+mz*sn, o=(i*RR+k)*3;
          tubeP[o]=pt[p3]+vx*rc; tubeP[o+1]=pt[p3+1]+vy*rc; tubeP[o+2]=pt[p3+2]+vz*rc; tubeN[o]=vx; tubeN[o+1]=vy; tubeN[o+2]=vz; } }
      tg.attributes.position.needsUpdate=true; tg.attributes.normal.needsUpdate=true;
    }
    buildTube(rest);

    // ── the kite charm: flat diamond with a little bail ring; its bail hangs on chain node 0, its tip is the sim's charm particle
    const ks=new T.Shape(); ks.moveTo(0,0.2*kt); ks.lineTo(kw,0); ks.lineTo(0,-0.8*kt); ks.lineTo(-kw,0); ks.closePath();
    const kg=new T.ExtrudeGeometry(ks,{depth:0.0035*H,bevelEnabled:true,bevelThickness:0.0012*H,bevelSize:0.0012*H,bevelSegments:1});
    kg.translate(0,0,-0.00175*H);
    const kmat=new T.MeshStandardMaterial({color:0x0d0f14,metalness:0.85,roughness:0.3,emissive:0x1b5cff,emissiveIntensity:0});   // a small BLACK kite; its blue only comes with the glow
    const kite=new T.Mesh(kg,kmat); kite.name='ArielKiteCharm'; kite.matrixAutoUpdate=true; necklace.add(kite);
    const bail=new T.Mesh(new T.TorusGeometry(0.0036*H,0.0011*H,4,10),chainMat); bail.position.set(0,0.2*kt+0.0026*H,0); kite.add(bail);
    const kq=new T.Quaternion(), kq2=new T.Quaternion(), kb=new T.Matrix4(), kx=new T.Vector3(), ky=new T.Vector3(), kz=new T.Vector3(), kn=new T.Vector3(0,0.15,1).normalize();
    function placeKite(X,nrm,dt){                                               // X: chain node 0 = bail centre, X[N] = tip; nrm = the way the chest faces there (rig space)
      const N=NN, t0=0, tb=N*3;
      ky.set(X[t0]-X[tb],X[t0+1]-X[tb+1],X[t0+2]-X[tb+2]); const yl=ky.length(); if(yl<1e-9) return; ky.multiplyScalar(1/yl);
      if(nrm){ const l=Math.hypot(nrm[0],nrm[1],nrm[2]); if(l>1e-6) { const a=Math.min(1,dt*14); kn.x+=(nrm[0]/l-kn.x)*a; kn.y+=(nrm[1]/l-kn.y)*a; kn.z+=(nrm[2]/l-kn.z)*a; kn.normalize(); } }
      kz.copy(kn).addScaledVector(ky,-kn.dot(ky)); if(kz.lengthSq()<1e-8) kz.set(0,0,1); kz.normalize(); kx.crossVectors(ky,kz);
      kb.makeBasis(kx,ky,kz); kq2.setFromRotationMatrix(kb);
      kite.quaternion.copy(kq2);
      kite.position.set(X[tb]+ky.x*0.8*kt,X[tb+1]+ky.y*0.8*kt,X[tb+2]+ky.z*0.8*kt);            // kite origin sits 0.8 kt above the tip (its shape runs +0.2 kt .. -0.8 kt)
    }
    placeKite(rest,[0,0.35,1],1);
    // (perf-mars) where her chest LED (ui/dm-hazard.js bodyBuild) sits: BESIDE the charm.  The LED is parented to the OLD chest anchor (G.rig, Spine02), whose origin is yC (9.5 % H below the
    // neck base) and zF+3 mm in front of it; the verlet charm now rests on her upper chest, ~20 cm higher, so the old fixed offset left the LED below it.  chestLed = the charm's rest
    // position, 5.5 % H to her left (the old 7.5 % sat on the arm edge at this height), expressed in G.rig's frame (both frames share the bind-pose right / up / forward axes: only the origins differ).
    G.chestLed={x:kite.position.x-0.055*H, y:kite.position.y+0.095*H, z:kite.position.z-zF-0.003*H};
    G.sim=sim; G.simRest=rest; G.chainMesh=chain; G.necklace=necklace; G.buildTube=buildTube; G.placeKite=placeKite; G.gl=gl; G.gravityLocal=gravityLocal; G.bindCaps=bindCaps;
    G.mRoot=new T.Matrix4(); G.mRel=new T.Matrix4(); G.mPrev=new T.Matrix4().copy(G.mRoot.copy(CHAR.root.matrixWorld).invert().multiply(nrig.matrixWorld)); G.mInv=new T.Matrix4(); G.mD=new T.Matrix4(); G.mC=new T.Matrix4(); G.sleep=false; G.root=CHAR.root; G.phys={ms:0,steps:0};

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
    // ONE shared node program for every glow piece (3 shells + the shards): colour / rim power / gain are material properties read through
    // materialReference, so a pulse is a property write (no uniform nodes, no per-material graph, one tiny compile). Facet term: the flat
    // screen-space face normal gives the crystal a faceted shimmer on top of the smooth rim (still the kite's own shape).
    function glowMat(r,gc,b,pw){
      if(!nodeOK||!TS.materialReference||!TS.dFdx){ const m=new T.MeshBasicMaterial({color:new T.Color(r,gc,b),transparent:true,opacity:0,blending:T.AdditiveBlending,depthWrite:false,side:T.DoubleSide,fog:false,toneMapped:false}); return {m,set:v=>{ m.opacity=Math.min(1,v*0.3); }}; }
      const m=new T.MeshBasicNodeMaterial({transparent:true,blending:T.AdditiveBlending,depthWrite:false,side:T.DoubleSide});
      m.cgR=r; m.cgG=gc; m.cgB=b; m.cgPow=pw; m.cgGain=0;
      const ref=(n)=>TS.materialReference(n,'float'), V=TS.positionViewDirection;
      const rim=TS.float(1).sub(TS.normalize(TS.normalView).dot(V).abs().clamp(0,1)).pow(ref('cgPow'));          // 0 face-on -> 1 at the silhouette
      const fn=TS.normalize(TS.cross(TS.dFdx(TS.positionView),TS.dFdy(TS.positionView)));
      const facet=TS.float(1).sub(fn.dot(V).abs().clamp(0,1)).pow(1.5);                                         // flat facets catch light differently
      const k=TS.float(0.05).add(rim.mul(1.6)).add(facet.mul(0.5).mul(rim.add(0.25)));
      m.colorNode=TS.vec3(ref('cgR'),ref('cgG'),ref('cgB')).mul(k).mul(ref('cgGain')); m.fog=false; m.toneMapped=false;
      return {m,set:v=>{ m.cgGain=v; }};
    }
    G.shells=[]; const SH=[[0.0022,0.55,0.85,1,2.2,1.0],[0.0048,0.3,0.62,1,1.8,0.7],[0.0085,0.18,0.42,1,1.4,0.45]];   // offset/H, rgb, rim power, gain
    for(let k=0;k<SH.length;k++){ const c=SH[k], gm=glowMat(c[1],c[2],c[3],c[4]), me=new T.Mesh(inflated(kg,c[0]*H),gm.m); me.renderOrder=11+k; me.frustumCulled=false; me.name='ArielCharmShell'+k; glow.add(me); G.shells.push({mesh:me,set:gm.set,gain:c[5],ph:k*0.9}); }
    // crystal shards: little elongated bipyramids (faceted 3-D geometry, not sprites) lying along the kite's edges, same shared program
    const sg=new T.OctahedronGeometry(1,0), V=[[0,0.2*kt],[kw,0],[0,-0.8*kt],[-kw,0]], cx0=0, cy0=-0.3*kt;      // the kite's four corners, its centre
    const sgm=glowMat(0.6,0.85,1,1.6);
    G.shards=[]; const NS=6;
    for(let i=0;i<NS;i++){
      const a=V[i%4], b=V[(i+1)%4], u=0.3+0.4*((i*0.37)%1), ex=b[0]-a[0], ey=b[1]-a[1], el=Math.hypot(ex,ey);
      let px=a[0]+ex*u, py=a[1]+ey*u; const ox=px-cx0, oy=py-cy0, ol=Math.hypot(ox,oy)||1; px+=ox/ol*0.0022*H; py+=oy/ol*0.0022*H;   // a hair outside the rim
      const me=new T.Mesh(sg,sgm.m); me.position.set(px,py,(i&1?-1:1)*0.0028*H); me.rotation.z=Math.atan2(ey,ex)-Math.PI/2; me.rotation.y=0.5*(i&1?-1:1);
      me.scale.set(0.0042*H,el*0.42,0.0030*H); me.renderOrder=14; me.frustumCulled=false; me.userData={ph:i*1.9,sp:0.7+0.25*(i%3),l0:el*0.42}; glow.add(me); G.shards.push(me); }
    G.shardSet=sgm.set;
    G.H=H; G.rig=rig; G.kite=kite; G.glow=glow; G.kmat=kmat; G.built=true;
    if(sim){ sim.setRest(rest); }
    return true;
  };

  /* per frame: ret = skyboard is on its way back to her (OR-ed with setReturning) */
  // ── necklace physics (one verlet step per frame, in the neck rig's local space; see ui/dm-necklace-sim.js).  Hidden body (first person) = asleep, snaps home on return.
  function vis(o){ while(o){ if(o.visible===false) return false; o=o.parent; } return true; }
  function physics(dt){
    const sim=G.sim; if(!sim||G.nophys) return; const T=THREE, t0=performance.now();
    if(!vis(G.nrig)){ G.sleep=true; return; }
    G.spine.updateWorldMatrix(true,false); G.nrig.updateWorldMatrix(false,false);
    const mw=G.nrig.matrixWorld;
    // the frame's motion RELATIVE TO HER ROOT: walking / turning / the riding mirror / the root scale are not inertia for a chain on her neck, only her own bone motion is
    G.mInv.copy(mw).invert(); G.mRoot.copy(G.root.matrixWorld).invert(); G.mRel.multiplyMatrices(G.mRoot,mw);
    if(G.sleep){ G.sleep=false; sim.snapToRest(); G.mPrev.copy(G.mRel); }
    G.mD.copy(G.mRel).invert().multiply(G.mPrev); G.mPrev.copy(G.mRel);                       // D = inv(rel now) * rel before
    let D=G.mD.elements; if(G.mD.determinant()<0.5){ sim.snapToRest(); D=null; }
    const v=G.v3, bl=G.bl; for(let i=0;i<bl.length;i++){ bl[i].updateWorldMatrix(true,false); G.mCs[i].multiplyMatrices(G.mInv,bl[i].matrixWorld); }
    G.skinCaps();
    v.set(0,-1,0).transformDirection(G.mInv); const g=9.81*G.u, gl=G.gl; gl[0]=v.x*g; gl[1]=v.y*g; gl[2]=v.z*g;
    sim.step(dt,gl,D,G.caps,G.nCaps);
    G.buildTube(sim.x); G.placeKite(sim.x,sim.cnN?sim.cn:null,dt);
    G.phys.steps++; G.phys.ms+=(performance.now()-t0-G.phys.ms)*0.05;                       // smoothed cost
  }
  G.tick=function(dt,ret){
    if(!G.built) return;
    const now=performance.now()*0.001; if(now-G.last<0.002) return; G.last=now;   // both frame loops call this
    dt=dt>0?Math.min(dt,0.1):0.016;
    physics(dt);
    const want=(ret||G.manual)?1:0;
    G.g+= want?dt/G.FADE_IN:-dt/G.FADE_OUT; if(G.g<0)G.g=0; if(G.g>1)G.g=1;
    if(G.g<=0.002){ if(G.glow.visible){ G.glow.visible=false; G.kmat.emissiveIntensity=0; light(0,0); } return; }
    G.glow.visible=true; G.t+=dt;
    const f=G.g*G.g*(3-2*G.g), t=G.t, H=G.H;
    const p=0.5+0.5*Math.sin(t*5.2), p2=0.5+0.5*Math.sin(t*8.3+1.3);       // pulses
    G.kmat.emissiveIntensity=f*(0.2+0.45*p);
    for(let i=0;i<G.shells.length;i++){ const sh=G.shells[i]; sh.set(f*sh.gain*(0.7+0.9*(0.5+0.5*Math.sin(t*5.2-sh.ph)))); }   // pulse ripples outward shell by shell
    let sf=0;
    for(let i=0;i<G.shards.length;i++){
      const s=G.shards[i], u=s.userData, fl=Math.max(0,Math.sin(t*(3+u.sp*3)+u.ph)); sf=Math.max(sf,0.1+0.9*fl*fl);
      s.scale.y=u.l0*(0.6+0.5*fl)*(0.85+0.25*p2);
    }
    G.shardSet(f*(0.5+1.6*sf));
    light(f,p);
  };
  // (bugfix-1119) the pilot changed after a preload (the previous pilot's GLB is being dropped): take the necklace + charm off her, free what they
  // built, and let attach() build again for the next pilot. Safe to call when nothing is built.
  G.detach=function(){
    if(!G.built) return false;
    try{ const NL=window.DMNatLights; if(G.lid!=null&&NL&&NL.release) NL.release(G.lid); }catch(e){} G.lid=null;
    const roots=[G.nrig,G.rig];
    for(const r of roots){ if(!r) continue; try{ r.traverse(o=>{ if(o.geometry&&o.geometry.dispose) o.geometry.dispose(); const ms=o.material?(Array.isArray(o.material)?o.material:[o.material]):[]; for(const m of ms){ try{ if(m&&m.map&&m.map.dispose) m.map.dispose(); m&&m.dispose&&m.dispose(); }catch(e){} } }); if(r.parent) r.parent.remove(r); }catch(e){} }
    G.built=false; G.manual=false; G.g=0; G.t=0; G.last=-1; G.sleep=false;
    G.rig=G.kite=G.glow=G.shells=G.shards=G.kmat=G.nrig=G.necklace=G.chainMesh=G.sim=G.spine=G.caps=G.capBones=G.bl=G.mCs=G.chestLed=G.skinCaps=null;
    return true;
  };
  // a little blue light from the charm: borrows one of the world's FIXED pooled natural lights (DMNatLights, index.html) so the scene's light set never
  // changes (adding a light would recompile every lit material). Ground only (where the pool exists); bounded; no shadow; no per-frame allocation.
  function light(f,p){
    const NL=window.DMNatLights, H=G.H; if(!NL||!NL.set) return;
    if(f<0.02){ if(G.lid!=null){ NL.release(G.lid); G.lid=null; } return; }
    if(!G.wp) G.wp=new THREE.Vector3();
    G.kite.getWorldPosition(G.wp);
    const I=Math.min(G.LIGHT_MAX*H*H,G.LIGHT_I*H*H*f*(0.75+0.5*p));
    if(G.lid==null) G.lid=NL.request(G.wp,0x5aa8ff,I,G.LIGHT_R*H); else NL.set(G.lid,G.wp,I);
    G.lastI=I;
  }
})();