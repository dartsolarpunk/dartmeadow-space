/* ═══════════════════════════════════════════════════════════════════
   STARS — every star you can fly to, built by the world engine from its
   data (radius, surface temperature):
     surface      boiling plasma: two layers of flow-warped waves (a
                  curl-like fluid drift, like the planets' cloud decks)
                  over moving granulation, coloured from the star's
                  blackbody ramp, limb-darkened. Far away it drops to a
                  plain glowing sphere (one cheap material).
     corona       a shell round the star, ray-marched in a few steps
                  through a falling-off, streamer-modulated glow.
     prominences  loops of glowing particles riding magnetic arcs off the
                  surface; now and then one erupts as a flare. Only near.
   No fluid sim, no marching cubes: all of it is a handful of sines per
   pixel and a few hundred points, so it holds up on a phone.
   The zero-gravity bubble (ui/dm-starbubble.js) compresses this same
   surface/corona/prominence light round its rim, and inside the star it
   shows interiorMaterial() — the same plasma, seen from within.
   TSL node materials: one source for WebGPU and the WebGL2 fallback.
   ═══════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  const live=new Set();
  const lowTier=()=>{ try{ return !!(GFX&&(GFX.preset==='low'||(GFX.isMobile&&GFX.preset!=='high'&&GFX.preset!=='ultra'))); /* a phone set to High/Ultra gets the full shaders */ }catch(e){ return false; } };

  // blackbody colour (sRGB 0..255) for a temperature in kelvin
  function kelvin(K){
    const t=Math.max(10,Math.min(400,K/100)); let r,g,b;
    if(t<=66){ r=255; g=99.4708025861*Math.log(t)-161.1195681661; b=t<=19?0:138.5177312231*Math.log(t-10)-305.0447927307; }
    else { r=329.698727446*Math.pow(t-60,-0.1332047592); g=288.1221695283*Math.pow(t-60,-0.0755148492); b=255; }
    const c=v=>Math.max(0,Math.min(255,v))/255;
    return new THREE.Color().setRGB(c(r),c(g),c(b),THREE.SRGBColorSpace);
  }
  // spectral class / catalogue label → surface temperature
  function tempFor(type){
    const s=String(type||'G');
    if(/O\/B|O\b|blue giant/i.test(s)) return 22000;
    if(/^B|blue/i.test(s)) return 15000;
    if(/^A|white$/i.test(s)&&!/yellow/i.test(s)) return 9000;
    if(/^F\/G|yellow-white/i.test(s)) return 6200;
    if(/^F/i.test(s)) return 6800;
    if(/red giant/i.test(s)) return 3600;
    if(/^K|orange/i.test(s)) return 4500;
    if(/^M|red/i.test(s)) return 3200;
    return 5600;
  }
  // deep → mid → hot → core. The reference photosphere's golden ramp, tinted by
  // how far the star's blackbody sits from the Sun's: a red dwarf glows deep
  // orange-red, a hot star white-blue, with the same cell/vein texture.
  function palette(K){
    const ref=kelvin(5778), me=kelvin(K), tint=new THREE.Color(1,1,1);
    for(const ch of ['r','g','b']) tint[ch]=Math.max(0.12,Math.min(1.9,(me[ch]+1e-3)/(ref[ch]+1e-3)));
    const gold=(r,g,b)=>new THREE.Color().setRGB(r/255,g/255,b/255,THREE.SRGBColorSpace);
    const mk=(c,w)=>{ const o=c.clone(); o.r*=1+(tint.r-1)*w; o.g*=1+(tint.g-1)*w; o.b*=1+(tint.b-1)*w; return o; };
    const lum=Math.max(0.35,Math.min(1.6,Math.pow(K/5778,0.35)));
    const P={deep:mk(gold(128,66,10),1).multiplyScalar(lum),mid:mk(gold(226,148,34),1).multiplyScalar(lum),hot:mk(gold(252,196,84),1).multiplyScalar(lum),core:mk(gold(255,246,206),0.6).multiplyScalar(lum)};
    // hotter than the Sun: the same texture in the star's own blackbody blue-white
    const w=Math.max(0,Math.min(1,(K-6200)/5500));
    if(w>0){ const f={deep:0.12,mid:0.42,hot:0.7,core:1.0}; for(const k in P) P[k].lerp(me.clone().multiplyScalar(f[k]*lum),w); }
    return P;
  }

  /* the plasma: one function for the surface and the inside view.
     Reference look (SDO-style photosphere): golden cells laced with thin bright
     veins, dark orange pores between them, small white-hot plage patches.
     Veins are ridged gradient noise (1-|n|)^k over a flow-warped domain; finer
     octaves fade in as the star grows on screen. */
  function plasma(T,U,d,detail){
    const {sin,mix,smoothstep,time,vec3,float}=T;
    const t=time.mul(U.speed);
    const nz=x=>T.mx_noise_float?T.mx_noise_float(x)
      :sin(x.x.mul(3.1).add(x.y.mul(1.7))).mul(sin(x.y.mul(2.7).sub(x.z.mul(1.3)))).mul(sin(x.z.mul(3.3).add(x.x.mul(0.9))));
    const ridge=(x,k)=>float(1).sub(nz(x).abs()).pow(k);
    const p0=d.mul(U.scale).add(U.seed);
    // big slow warps so the network stretches and bunches from place to place
    const wp=p0.add(sin(p0.yzx.mul(0.17).add(1.3)).mul(1.3)).add(sin(p0.zxy.mul(0.29).add(0.7)).mul(0.8));
    // convective drift + slow boil
    const fl=wp.add(sin(wp.yzx.mul(0.9).add(t.mul(0.12))).mul(0.6));
    const boil=vec3(t.mul(0.05),0,t.mul(0.07));
    const mott=nz(fl.mul(0.55).add(3.1).add(boil)).mul(0.5).add(0.5);
    const mott2=nz(fl.mul(1.3).add(9.7).sub(boil)).mul(0.5).add(0.5);
    const v1=ridge(fl.add(boil),4.0);
    let g=float(0.08).add(mott.mul(0.2)).add(mott2.mul(0.12)).add(v1.mul(0.36));
    if(detail){
      const v2=ridge(fl.mul(2.1).add(7.3).add(boil.mul(1.6)),5.0);
      g=g.add(v2.mul(float(0.14).add(U.fine.mul(0.16))));
      if(detail!=='low'){
        const v3=ridge(fl.mul(4.4).add(13.1).sub(boil.mul(2.0)),6.0);
        g=g.add(v3.mul(U.fine.mul(0.2)));
        // close up: the finest threads and the molten micro-eddies
        const v4=ridge(fl.mul(9.5).add(2.9).add(boil.mul(2.6)),6.0);
        const v5=ridge(fl.mul(20.0).add(5.3).sub(boil.mul(3.0)),7.0);
        g=g.add(v4.mul(U.micro.mul(0.25))).add(v5.mul(U.micro2.mul(0.3)));
      }
    }
    // plage: a few white-hot active patches, veins flaring inside them
    const pn=nz(d.mul(3.6).add(U.seed.mul(0.7)).add(vec3(0,t.mul(0.004),0))).mul(0.5).add(0.5);
    const pl=smoothstep(0.62,0.82,pn);
    const pn2=nz(d.mul(11.0).add(U.seed).add(4.4)).mul(0.5).add(0.5);
    const pl2=smoothstep(0.72,0.9,pn2).mul(0.6);
    g=g.add(pl.add(pl2).mul(float(0.1).add(v1.mul(0.5))));
    g=g.clamp(0.0,1.0);
    let col=mix(U.deep,U.mid,smoothstep(0.18,0.5,g));
    col=mix(col,U.hot,smoothstep(0.5,0.76,g));
    col=mix(col,U.core,smoothstep(0.8,1.0,g));
    return col;
  }
  function uniforms(T,K,seed){
    const P=palette(K);
    return {deep:T.uniform(P.deep),mid:T.uniform(P.mid),hot:T.uniform(P.hot),core:T.uniform(P.core),
      seed:T.uniform(new THREE.Vector3(seed*1.7%9,seed*2.3%9,seed*3.1%9)),speed:T.uniform(1),fine:T.uniform(0),micro:T.uniform(0),micro2:T.uniform(0),scale:T.uniform(60.0),
      flareD:T.uniform(new THREE.Vector3(0,1,0)),flareK:T.uniform(0),fume:T.uniform(0.3)};
  }
  // the zero-g bubble (ui/dm-starbubble.js) parts the plasma round it
  let BU=null;
  function bubbleU(T){ return BU||(BU={c:T.uniform(new THREE.Vector3(0,0,0)),r:T.uniform(0)}); }
  function surfaceMat(T,U,near,low){
    const m=new THREE.MeshBasicNodeMaterial();
    const B=bubbleU(T);
    // cut along the line of sight: any surface between the camera and the
    // bubble, within its outline, is pushed aside (a rider just under the
    // photosphere is still seen in her window)
    const toP=T.positionWorld.sub(T.cameraPosition), D=T.normalize(toP), L=B.c.sub(T.cameraPosition);
    const tca=T.dot(L,D), d2=T.dot(L,L).sub(tca.mul(tca));
    const hole=d2.lessThan(B.r.mul(B.r)).and(toP.length().lessThan(tca.add(B.r)));
    m.opacityNode=hole.select(0.0,1.0);
    m.alphaTest=0.5;
    const d=T.normalize(T.positionLocal);
    const V=T.normalize(T.cameraPosition.sub(T.positionWorld));
    const ndv=T.normalWorld.dot(V).clamp(0.0,1.0);
    // limb darkening, redder toward the edge
    const limb=ndv.pow(0.3).mul(0.25).add(0.75);
    const base=near?plasma(T,U,d,low?'low':true):T.mix(U.mid,U.hot,ndv.pow(1.5).mul(0.5));
    const rim=T.float(1).sub(ndv).pow(3.0);   // the limb glows pale gold, as in the reference
    m.colorNode=base.mul(limb).add(U.core.mul(rim.mul(0.3)));
    m.toneMapped=false;
    return m;
  }
  function coronaMat(T,U,R,steps){
    const m=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.BackSide});
    const {float,vec3,sin,exp,dot,normalize,max,time}=T;
    const C=T.uniform(new THREE.Vector3());
    const Rc=R*2.4, H=R*0.22;
    const ro=T.cameraPosition.sub(C), rd=normalize(T.positionWorld.sub(T.cameraPosition));
    const b=dot(ro,rd), c=dot(ro,ro).sub(Rc*Rc);
    const disc=b.mul(b).sub(c).max(0.0).sqrt();
    const t0=b.negate().sub(disc).max(0.0), t1=b.negate().add(disc);
    const dt=t1.sub(t0).div(steps);
    let acc=float(0);
    for(let i=0;i<steps;i++){
      const p=ro.add(rd.mul(t0.add(dt.mul(i+0.5))));
      const r=p.length();
      const n=p.div(r);
      // streamers: brighter fans along slowly turning great circles
      const s=sin(n.x.mul(5.0).add(time.mul(0.05))).mul(sin(n.y.mul(4.0).sub(time.mul(0.04)))).mul(sin(n.z.mul(6.0))).mul(0.5).add(0.5);
      // gas swirling through the streamers, whipped up near a flare
      const flc=exp(float(1).sub(dot(n,U.flareD)).mul(-10.0)).mul(U.flareK);
      const sw=sin(n.x.mul(11.0).add(sin(n.y.mul(8.0).add(time.mul(0.35))).mul(float(1.6).add(flc.mul(2.0)))).add(time.mul(0.08))).mul(0.5).add(0.5);
      // fine radial hairs (spicules): high-frequency in direction only, so they stream straight out
      const hair=T.mx_noise_float?T.pow(T.mx_noise_float(n.mul(240.0).add(U.seed)).abs().oneMinus(),6.0).mul(exp(r.sub(R).div(R*0.09).negate())):float(0);
      acc=acc.add(exp(r.sub(R).div(H).negate()).mul(s.mul(0.5).add(sw.mul(0.3)).add(0.3).mul(flc.mul(2.5).add(1.0))).mul(r.greaterThan(R*0.99).select(1.0,0.0)).add(hair.mul(0.5)));
    }
    // soft-saturating so a long path through it glows, never whites out
    const k=float(1).sub(exp(acc.mul(dt).div(R*1.4).negate()));
    m.colorNode=T.mix(U.hot,U.core,k.mul(k)).mul(k.mul(0.38));
    m.toneMapped=false;
    m.userData.C=C;
    return m;
  }

  /* fumes: breezy gas lying just over the surface (the chromosphere), swirled by the loops and flares */
  function fumeMat(T,U,low){
    const m=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending});
    const {sin,mix,smoothstep,time,vec3,float,dot,normalize}=T;
    const d=normalize(T.positionLocal), V=normalize(T.cameraPosition.sub(T.positionWorld));
    const ndv=T.normalWorld.dot(V).clamp(0.0,1.0);
    const fl=T.exp(float(1).sub(dot(d,U.flareD)).mul(-14.0)).mul(U.flareK);          // a flare stirs the gas round its foot
    const t=time.mul(0.07);
    const p=d.mul(7.0).add(U.seed);
    const amp=float(0.55).add(fl.mul(1.6));
    const q=p.add(vec3(sin(p.y.mul(2.1).add(t.mul(3.0))),sin(p.z.mul(1.9).sub(t.mul(2.4))),sin(p.x.mul(2.3).add(t.mul(2.7)))).mul(amp));
    const nz=T.mx_fractal_noise_float?T.mx_fractal_noise_float(q.mul(1.6).add(vec3(0,t,0)),low?2:4,2.0,0.5).mul(0.5).add(0.5)
      :sin(q.x.mul(3.1)).mul(sin(q.y.mul(2.7).add(t))).mul(sin(q.z.mul(3.3))).mul(0.5).add(0.5);
    const wisps=smoothstep(0.38,0.82,nz);
    const edge=float(1).sub(ndv).pow(1.5).mul(0.8).add(0.2);
    m.colorNode=mix(U.mid,U.hot,wisps.add(fl.mul(0.5)).clamp(0,1)).mul(1.25);
    m.opacityNode=wisps.mul(edge).mul(U.fume).mul(0.3).add(fl.mul(0.35)).clamp(0.0,0.85);
    m.toneMapped=false;
    return m;
  }

  /* prominences: particles on magnetic arcs, now and then a flare */
  function prominences(R,col,low,seed){
    const A=low?5:10, N=low?22:44, tot=A*N;
    // camera-facing quads (WebGPU draws GL points one pixel wide, so no Points)
    let tex=null; try{ tex=makeCircleTex(32,'rgb(255,230,190)',1); }catch(e){}
    const m=new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false});
    const pts=new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1),m,tot);
    pts.frustumCulled=false; pts.renderOrder=2; pts.name='JOTS_StarProminences';
    const pos=new Float32Array(tot*3), cols=new Float32Array(tot*3);
    const S=R*(low?0.034:0.026), M4=new THREE.Matrix4(), PV=new THREE.Vector3(), SC=new THREE.Vector3(), CL=new THREE.Color(), Q=new THREE.Quaternion();
    for(let i=0;i<tot;i++) pts.setColorAt(i,CL.setRGB(0,0,0));
    let rs=seed*9301+49297; const rnd=()=>{ rs=(rs*9301+49297)%233280; return rs/233280; };
    const V=THREE.Vector3;
    const arcs=[];
    function arc(a){
      const d0=new V(rnd()*2-1,rnd()*2-1,rnd()*2-1).normalize();
      const ax=new V().crossVectors(d0,new V(rnd()-0.5,rnd()-0.5,rnd()-0.5)).normalize();
      const d1=d0.clone().applyAxisAngle(ax,0.12+rnd()*0.18);
      a.d0=d0; a.d1=d1; a.h=R*(0.08+rnd()*0.2); a.life=6+rnd()*10; a.age=0; a.flare=rnd()<0.18; a.sp=0.12+rnd()*0.2;
      return a;
    }
    for(let i=0;i<A;i++){ const a=arc({}); a.age=rnd()*a.life; arcs.push(a); }
    const off=new Float32Array(tot); for(let i=0;i<tot;i++) off[i]=rnd();
    const jit=new Float32Array(tot*3); for(let i=0;i<tot*3;i++) jit[i]=(rnd()-0.5);
    const tmp=new V(), c=col.mid.clone(), cHot=col.hot.clone();   // reddish loops, hotter at the feet
    pts.userData.tick=function(dt,cam){
      let bestK=0; const fo=pts.userData.flare||(pts.userData.flare={d:new V(0,1,0),k:0});
      for(let ai=0;ai<A;ai++){
        const a=arcs[ai]; a.age+=dt; if(a.age>a.life) arc(a);
        const env=Math.sin(Math.PI*Math.min(1,a.age/a.life));        // rises, holds, sinks back
        const er=a.flare?Math.max(0,(a.age/a.life-0.55)/0.45):0;      // flares tear loose late in life
        if(er>bestK){ bestK=er; fo.d.copy(a.d0).lerp(a.d1,0.5).normalize(); }
        for(let j=0;j<N;j++){
          const i=ai*N+j;
          let s=(off[i]+a.age*a.sp)%1;
          tmp.copy(a.d0).lerp(a.d1,s).normalize();
          let h=a.h*env*Math.sin(Math.PI*s)*(1+er*3);
          if(er>0) h+=R*er*er*0.9*(0.5+off[i]);                       // ejected material flying out
          const r=R*1.005+h, jj=R*0.012*(1+er*2);
          pos[i*3]=tmp.x*r+jit[i*3]*jj; pos[i*3+1]=tmp.y*r+jit[i*3+1]*jj; pos[i*3+2]=tmp.z*r+jit[i*3+2]*jj;
          const k=env*(0.55+0.45*Math.sin(Math.PI*s))*(1-er*0.7);
          const cc=s<0.15||s>0.85?cHot:c;
          cols[i*3]=cc.r*k*1.5; cols[i*3+1]=cc.g*k*1.5; cols[i*3+2]=cc.b*k*1.5;
        }
      }
      fo.k=bestK;
      // face the camera (in the star's frame)
      if(cam){ pts.parent.getWorldQuaternion(Q).invert().multiply(cam.quaternion); }
      for(let i=0;i<tot;i++){
        const k=Math.max(cols[i*3],cols[i*3+1],cols[i*3+2]);
        M4.compose(PV.set(pos[i*3],pos[i*3+1],pos[i*3+2]),Q,SC.setScalar(k>0.01?S*(0.6+k*0.6):1e-4));
        pts.setMatrixAt(i,M4); pts.setColorAt(i,CL.setRGB(cols[i*3],cols[i*3+1],cols[i*3+2]));
      }
      pts.instanceMatrix.needsUpdate=true; if(pts.instanceColor) pts.instanceColor.needsUpdate=true;
    };
    return pts;
  }


  /* ── baked look ─────────────────────────────────────────────────────
     The procedural plasma is ~9 noise taps per pixel: fine for a one-off
     bake, far too heavy for a sun filling a phone screen every frame. So the
     GPU renders it ONCE into a cube map (and the corona into a 2D map), and
     every frame is then a texture fetch + a cheap drift. Only the last few
     metres above the surface go back to the live shader. */
  let _R=null; const rend=()=>{ if(_R) return _R; try{ return (typeof flightRenderer!=='undefined'&&flightRenderer)||null; }catch(e){ return null; } };
  function bakeSurface(h,renderer){
    const T=h.T, size=h.low?768:1024;
    const rt=new THREE.CubeRenderTarget(size,{type:THREE.HalfFloatType,generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter});
    const sc=new THREE.Scene();
    const m=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide});
    const bU={fine:T.uniform(1),micro:T.uniform(0),micro2:T.uniform(0)};
    const U2=Object.assign({},h.U,bU);
    m.colorNode=plasma(T,U2,T.normalize(T.positionLocal),h.low?'low':true);
    m.toneMapped=false;
    sc.add(new THREE.Mesh(new THREE.SphereGeometry(1,48,32),m));
    const cc=new THREE.CubeCamera(0.1,10,rt);
    const prev=renderer.getRenderTarget();
    cc.update(renderer,sc);
    renderer.setRenderTarget(prev);
    h.cube=rt;
  }
  function bakedMat(h){
    const T=h.T, U=h.U, {sin,cos,float,vec3,mix}=T;
    const m=new THREE.MeshBasicNodeMaterial();
    const B=bubbleU(T);
    const toP=T.positionWorld.sub(T.cameraPosition), D=T.normalize(toP), L=B.c.sub(T.cameraPosition);
    const tca=T.dot(L,D), d2=T.dot(L,L).sub(tca.mul(tca));
    m.opacityNode=d2.lessThan(B.r.mul(B.r)).and(toP.length().lessThan(tca.add(B.r))).select(0.0,1.0);
    m.alphaTest=0.5;
    const d=T.normalize(T.positionLocal);
    const V=T.normalize(T.cameraPosition.sub(T.positionWorld));
    const ndv=T.normalWorld.dot(V).clamp(0.0,1.0);
    // differential rotation (equator turns faster than the poles) = slow convective drift
    const lat2=d.y.mul(d.y), t=T.time;
    const rot=a=>{ const c=cos(a), s=sin(a); return vec3(d.x.mul(c).add(d.z.mul(s)),d.y,d.z.mul(c).sub(d.x.mul(s))); };
    const a1=t.mul(0.006).mul(float(1).sub(lat2.mul(0.3))), a2=t.mul(-0.0045).mul(float(1).sub(lat2.mul(0.2))).add(0.7);
    const tex=h.cube.texture;
    const s1=T.cubeTexture(tex,rot(a1)).rgb, s2=T.cubeTexture(tex,rot(a2)).rgb;
    const w=sin(t.mul(0.35)).mul(0.5).add(0.5);
    const base=mix(s1,s2,w.mul(0.45));
    const limb=ndv.pow(0.3).mul(0.25).add(0.75);
    const rim=float(1).sub(ndv).pow(3.0);
    m.colorNode=base.mul(limb).add(U.core.mul(rim.mul(0.3)));
    m.toneMapped=false;
    return m;
  }
  function bakeCorona(h,renderer){
    const T=h.T, U=h.U, {vec3,vec4,float,exp,smoothstep,mix,pow}=T, RM=5.0, size=1024;
    const rt=new THREE.RenderTarget(size,size,{type:THREE.HalfFloatType,generateMipmaps:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
    const p=T.uv().sub(0.5).mul(2.0), len=p.length().max(1e-4), dir=p.div(len), r=len.mul(RM), fall=r.sub(1.0).max(0.0);
    const sd=U.seed.x;
    const nz=x=>T.mx_noise_float(x);
    const hair=float(1).sub(nz(vec3(dir.mul(70.0),r.mul(0.9).add(sd))).abs()).pow(7.0);
    const hair2=float(1).sub(nz(vec3(dir.mul(22.0),r.mul(0.5).add(sd.add(3.1)))).abs()).pow(5.0);
    const st=nz(vec3(dir.mul(3.2),sd.add(r.mul(0.12)))).mul(0.5).add(0.5);
    const I=exp(fall.div(0.03).negate()).mul(1.1)
      .add(exp(fall.div(0.22).negate()).mul(float(0.55).add(st.mul(0.4))))
      .add(exp(fall.div(1.0).negate()).mul(float(0.2).add(st.mul(0.25))))
      .add(float(0.05).div(float(1).add(fall.mul(fall))))
      .add(hair.mul(exp(fall.div(0.5).negate())).mul(0.75))
      .add(hair2.mul(exp(fall.div(1.3).negate())).mul(0.3));
    const edge=smoothstep(float(RM),float(RM*0.72),r);
    const k=I.clamp(0.0,4.0);
    const col=mix(U.hot,U.core,smoothstep(0.35,1.4,k)).mul(k).mul(edge);
    const m=new THREE.MeshBasicNodeMaterial(); m.colorNode=vec4(col,1.0); m.toneMapped=false;
    const sc=new THREE.Scene(), cam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    sc.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),m));
    const prev=renderer.getRenderTarget();
    renderer.setRenderTarget(rt); renderer.render(sc,cam); renderer.setRenderTarget(prev);
    h.coronaTex=rt;
    const cm=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});
    const uv=T.uv().sub(0.5), time=T.time;
    const rotUV=a=>{ const c=T.cos(a), s=T.sin(a); return T.vec2(uv.x.mul(c).sub(uv.y.mul(s)),uv.x.mul(s).add(uv.y.mul(c))).add(0.5); };
    const t1=T.texture(rt.texture,rotUV(time.mul(0.004))).rgb, t2=T.texture(rt.texture,rotUV(time.mul(-0.0035).add(0.9))).rgb;
    cm.colorNode=T.max(t1,t2.mul(0.85)).mul(h.low?1.0:1.0);
    cm.toneMapped=false;
    h.corona.material=cm; h.corona.geometry.dispose(); h.corona.geometry=new THREE.PlaneGeometry(2*RM*h.R,2*RM*h.R);
    h.coronaBaked=true;
  }

  function build(o){
    const T=THREE.TSL, R=o.radius, K=o.temp||5600, seed=o.seed||1, low=lowTier();
    const group=new THREE.Group(); group.name='JOTS_Star';
    const h={group,R,K,low,seed};
    if(!T||!THREE.MeshBasicNodeMaterial){
      // no node materials at all: a flat glowing sphere
      h.mesh=new THREE.Mesh(new THREE.SphereGeometry(R,32,24),new THREE.MeshBasicMaterial({color:kelvin(K*0.75)}));
      group.add(h.mesh); return h;
    }
    const U=uniforms(T,K,seed); h.U=U; h.T=T;
    h.matNear=surfaceMat(T,U,true,low); h.matFar=surfaceMat(T,U,false,low);
    h.mesh=new THREE.Mesh(new THREE.SphereGeometry(R,96,64),h.matFar);   // a smooth limb up close
    h.mesh.name='JOTS_StarSurface';
    group.add(h.mesh);
    try{
      h.corona=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshBasicMaterial({visible:false}));
      h.corona.renderOrder=1; h.corona.frustumCulled=false; h.corona.name='JOTS_StarCorona'; h.corona.visible=false;
      group.add(h.corona);
    }catch(e){ console.warn('[star] corona:',e); }
    try{
      h.fume=new THREE.Mesh(new THREE.SphereGeometry(R*1.015,low?48:96,low?32:64),fumeMat(T,U,low));
      h.fume.renderOrder=1; h.fume.frustumCulled=false; h.fume.name='JOTS_StarFume'; group.add(h.fume);
    }catch(e){ console.warn('[star] fume:',e); }
    try{
      h.prom=prominences(R,palette(K),low,seed); h.prom.visible=false; group.add(h.prom);
    }catch(e){ console.warn('[star] prominences:',e); }
    group.userData.dmStar=h;
    for(const o of live) if(!o.group.parent) live.delete(o);   // stars of systems we've left
    live.add(h);
    return h;
  }
  // the same plasma, seen from inside the star (the zero-g bubble's dive)
  function interiorMaterial(h){
    if(!h||!h.U) return null;
    if(h.matIn) return h.matIn;
    const T=h.T, m=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide});
    m.colorNode=plasma(T,h.U,T.normalize(T.positionLocal),h.low?'low':true).mul(0.85);
    m.toneMapped=false;
    return (h.matIn=m);
  }

  const _v=()=>new THREE.Vector3(); const _Q=new THREE.Quaternion(), _Q2=new THREE.Quaternion();
  let V1=null;
  // per frame: level of detail by how big the star is on screen; corona centre;
  // prominences only up close
  function frame(cam,dt){
    if(!cam) return;
    if(!V1) V1=_v();
    for(const h of live){
      if(!h.group.parent||!h.group.visible) continue;
      h.group.getWorldPosition(V1);
      const d=Math.max(1e-3,cam.position.distanceTo(V1));
      const ang=h.R/d;                                     // ~angular radius
      const near=ang>0.04;
      if(h.U) h.U.fine.value=Math.max(0,Math.min(1,(ang-0.3)/0.5));
      if(h.U){ h.U.micro.value=Math.max(0,Math.min(1,(ang-1.0)/6.0)); h.U.micro2.value=Math.max(0,Math.min(1,(ang-40)/400)); h.U.fume.value=0.35+0.65*Math.max(0,Math.min(1,(ang-0.1)/0.6));
        const fl=h.prom&&h.prom.visible&&h.prom.userData.flare; if(fl&&fl.k>0.01){ h.U.flareD.value.copy(fl.d); h.U.flareK.value=Math.min(1,fl.k); } else h.U.flareK.value*=0.92; }
      // baked look (GPU, once) for everything but the last few metres above the surface
      const R_=rend();
      if(R_&&h.T&&!h.bakeTried&&ang>0.03){ h.bakeTried=true;
        try{ bakeSurface(h,R_); h.matBaked=bakedMat(h); bakeCorona(h,R_); }catch(e){ console.warn('[star] bake failed, live shader:',e&&e.message||e); h.matBaked=null; } }
      if(h.matBaked){ if(ang>1.6) h.close=true; else if(ang<1.3) h.close=false; }
      const m=near?((h.matBaked&&!h.close)?h.matBaked:h.matNear):h.matFar; if(h.mesh.material!==m) h.mesh.material=m;
      if(h.corona&&h.coronaBaked){ h.corona.visible=true; _Q.copy(cam.quaternion); h.group.getWorldQuaternion(_Q2).invert(); h.corona.quaternion.copy(_Q2.multiply(_Q)); }
      if(h.fume) h.fume.visible=ang>0.6;
      if(h.prom){ h.prom.visible=ang>0.12; if(h.prom.visible) h.prom.userData.tick(Math.min(0.1,dt||1/60),cam); }
    }
  }
  function setBubble(c,r){ if(!BU) return; if(c) BU.c.value.copy(c); BU.r.value=r>0?r:0; }
  window.DMStar={setRenderer(r){ _R=r; },build,frame,interiorMaterial,setBubble,tempFor,kelvin,palette};
})();
