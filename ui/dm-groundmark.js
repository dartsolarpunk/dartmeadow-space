/* ═══════════════════════════════════════════════════════════════════════════
   GROUND MARK — the laser-projected reticle on the ground in terrain mode.
   Controller for two DMProjector instances (ui/dm-projector.js), each parented to
   its owner:

     (A) RED   centred on the base of Ariel's feet, radius = her height, always with her.
     (B) BLUE  the skyboard's projector. Board beside her (walking / running): centred on
               her feet, a frame band from the red radius out to the board's farthest
               corner (+ a small margin; recomputed every frame from the board's
               bounding-box corners relative to her feet). She PARKS the board
               (BOARD_CALL.parked): (B) detaches, re-centres on the board and stays with
               it (radius = the board's ends + margin) while she walks off with only red.
               Park OFF (the board rejoins on its next move) or SUMMON: (B) animates
               (~0.65 s, smoothstep) back to wrap her red zone as the frame.

   Shows only in terrain mode while she is on foot (walking/running, not boarding). It fades
   in on landing; on liftoff / boarding both stay anchored to the ground and dissolve out over
   ~0.8 s, then switch off completely (fade 0 → the receivers' uniform branch is skipped).

   Receivers: _terrainDetailMat (all terrain) calls DMGroundMark.receive(mat); static meshes
   (rocks, trees, props…) opt in with obj.userData.groundMark=true, which _pwMapTag turns
   into DMGroundMark.tagMaterial(mat). Kill switch: ?groundmark=0. Nothing is allocated
   per frame (all scratch is module-level numbers / vectors made once).
   ═══════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  const G={off:/[?&]groundmark=0\b/.test(location.search),A:null,B:null,built:false,gen:-1,
    fa:0,fb:0,has:false,mode:0,mt:1,frame:0,lastR:0,
    // B's current state + the state it left from when the mode flipped (plain numbers)
    bx:0,bz:0,bRi:0,bR:0,fx:0,fz:0,fRi:0,fR:0,
    ax:0,az:0,ay:0,nax:0,nay:1,naz:0,nbx:0,nby:1,nbz:0,
    FADE_IN:0.9,FADE_OUT:0.8,MERGE:0.65};
  window.DMGroundMark=G;
  const sm=(x)=>{ x=x<0?0:x>1?1:x; return x*x*(3-2*x); };

  function build(){
    if(G.built||G.off||!window.DMProjector||typeof window.uniform!=='function'||!window.THREE) return G.built;
    const D=window.DMProjector;
    G.A=D.create({radius:1.7,innerRadius:1.7,inner:'laserRed',outer:null,colorInner:[1,.12,.08]});
    G.B=D.create({radius:5,innerRadius:1.7,inner:null,outer:'laserBlue',colorOuter:[.1,.45,1]});
    G.built=true; return true;
  }

  /* ── receivers ─────────────────────────────────────────────────────── */
  G.receive=function(mat){ if(G.off||!build()) return false; return window.DMProjector.receive(mat,{projectors:[G.A,G.B]}); };
  // static meshes opt in through userData.groundMark (see _pwMapTag); lit node materials only
  G.tagMaterial=function(mat){
    if(G.off||!mat||mat.transparent||!mat.isMeshStandardNodeMaterial) return false;
    if(mat.userData&&mat.userData._dmproj&&mat.userData._dmproj.key) return true;
    return G.receive(mat);
  };

  /* ── board geometry relative to a point (no allocation) ───────────── */
  // farthest horizontal distance from (ox,oz) to the board's 8 bounding-box corners; also leaves the box centre in G._cx/_cz
  function boardReach(board,ox,oz){
    const bd=window._surfBoardDims; if(!board||typeof bd!=='function') return 0;
    const d=bd(board), e=board.matrixWorld.elements, p=board.position;
    const s=Math.hypot(e[0],e[1],e[2])||1;
    const xx=e[0]/s, xz=e[2]/s, yx=e[4]/s, yz=e[6]/s, zx=e[8]/s, zz=e[10]/s;
    const y0=d.minY, y1=d.minY+d.halfT*2;
    let m=0;
    for(let i=0;i<8;i++){
      const lx=(i&1)?d.maxX:d.minX, lz=(i&2)?d.maxZ:d.minZ, ly=(i&4)?y1:y0;
      const wx=p.x+lx*xx+ly*yx+lz*zx-ox, wz=p.z+lx*xz+ly*yz+lz*zz-oz;
      const h=Math.hypot(wx,wz); if(h>m) m=h;
    }
    G._cx=p.x+d.cx*xx+d.cz*zx; G._cz=p.z+d.cx*xz+d.cz*zz;
    return m;
  }
  G._cx=0; G._cz=0;

  // smoothed plane normal of the ground around (x,z), from 4 height samples (e = sample spacing)
  function planeNormal(gnd,x,z,e,P,k){
    const hx=gnd(x+e,z)-gnd(x-e,z), hz=gnd(x,z+e)-gnd(x,z-e);
    let nx=-hx/(2*e), ny=1, nz=-hz/(2*e); const l=Math.hypot(nx,ny,nz); nx/=l; ny/=l; nz/=l;
    if(!(nx===nx&&ny===ny&&nz===nz)) return;
    P.nx+=(nx-P.nx)*k; P.ny+=(ny-P.ny)*k; P.nz+=(nz-P.nz)*k;
  }
  const NA={nx:0,ny:1,nz:0}, NB={nx:0,ny:1,nz:0};

  function reset(){
    G.fa=G.fb=0; G.has=false; if(G.A){ G.A.fade=0; G.B.fade=0; }
  }

  /* ── per frame ─────────────────────────────────────────────────────────
     player/board are non-null only while she is on foot and not boarding.
     gen: PW.gen (a new world resets); gnd(x,z): ground height; map(x,y,z,out): flat → drawn frame;
     charH: her height; bc: BOARD_CALL (parked / summon). */
  G.tick=function(dt,player,board,gen,gnd,map,charH,bc){
    if(G.off||!G.built) return;
    if(gen!==G.gen){ G.gen=gen; reset(); }
    const A=G.A, B=G.B;
    const vis=!!(player&&board&&charH>0&&typeof gnd==='function');
    if(!vis&&G.fa<=0&&G.fb<=0){ if(A.active||B.active){ A.fade=0; B.fade=0; A.tick(dt); B.tick(dt); } return; }   // fully off: nothing else runs
    dt=dt>0?Math.min(dt,0.1):0.016;
    const parked=!!(bc&&bc.parked);
    if(vis){
      const px=player.pos.x, pz=player.pos.z, Rin=charH;
      // (A) her feet: the point on the ground under her
      const fresh=G.fa<=0.001&&G.fb<=0.001||!G.has;
      const gy=gnd(px,pz); const yk=fresh?1:Math.min(1,dt*18);
      G.ax=px; G.az=pz; if(gy===gy) G.ay+=(gy-G.ay)*yk;
      if(fresh){ G.ay=gy===gy?gy:G.ay; NA.nx=0; NA.ny=1; NA.nz=0; NB.nx=0; NB.ny=1; NB.nz=0; }
      const k=fresh?1:Math.min(1,dt*8), ph=(G.frame++)%3;
      if(ph===0||fresh) planeNormal(gnd,px,pz,Rin*0.6,NA,k);
      A.radius=A.innerRadius=Rin;
      // (B) the board's projector: merged around her, or parked on the board
      let tx,tz,tRi,tR;
      const reachHer=boardReach(board,px,pz);
      const near=reachHer<Rin*4.5;                      // beside her; a far board (parked, being summoned) keeps the last frame size
      if(near&&!parked){ G.lastR=Math.max(Rin*1.35,reachHer*1.04+Rin*0.08); }
      if(!(G.lastR>0)) G.lastR=Rin*2.4;
      const want=parked?1:0;
      if(parked){
        const reachB=boardReach(board,board.position.x,board.position.z);   // (also sets the box centre)
        tx=G._cx; tz=G._cz; tR=reachB*1.12+Rin*0.08; tRi=tR*0.5;
      } else { tx=px; tz=pz; tRi=Rin; tR=G.lastR; }
      if(fresh){ G.mode=want; G.mt=1; G.bx=tx; G.bz=tz; G.bRi=tRi; G.bR=tR; }
      else if(want!==G.mode){ G.mode=want; G.mt=0; G.fx=G.bx; G.fz=G.bz; G.fRi=G.bRi; G.fR=G.bR; }
      if(G.mt<1){
        G.mt=Math.min(1,G.mt+dt/G.MERGE); const s=sm(G.mt);
        G.bx=G.fx+(tx-G.fx)*s; G.bz=G.fz+(tz-G.fz)*s; G.bRi=G.fRi+(tRi-G.fRi)*s; G.bR=G.fR+(tR-G.fR)*s;
      } else { G.bx=tx; G.bz=tz; G.bRi=tRi; G.bR=tR; }
      B.radius=G.bR; B.innerRadius=G.bRi;
      const gby=(G.bx===px&&G.bz===pz)?G.ay:gnd(G.bx,G.bz);
      // (B)'s own plane (it sits on different ground when parked); only sampled when it is away from her
      if(G.bx!==px||G.bz!==pz){ if(ph===1||fresh) planeNormal(gnd,G.bx,G.bz,Math.max(0.3,G.bR*0.35),NB,k); }
      else { NB.nx=NA.nx; NB.ny=NA.ny; NB.nz=NA.nz; }
      // drawn-frame centres (the frame bends the world to the sphere; near her it is the identity)
      map(G.ax,G.ay,G.az,A.center); A.normal.set(NA.nx,NA.ny,NA.nz);
      map(G.bx,gby===gby?gby:G.ay,G.bz,B.center); B.normal.set(NB.nx,NB.ny,NB.nz);
      G.has=true;
    }
    // fades: in on landing, out (anchored) on liftoff / boarding
    // a parked board far from her is not drawn (no detail terrain there; keep the cost bounded)
    const far=parked&&vis&&Math.hypot(G.bx-G.ax,G.bz-G.az)>140;
    G.fa+=vis?dt/G.FADE_IN:-dt/G.FADE_OUT; if(G.fa<0)G.fa=0; if(G.fa>1)G.fa=1;
    G.fb+=(vis&&!far)?dt/G.FADE_IN:-dt/G.FADE_OUT; if(G.fb<0)G.fb=0; if(G.fb>1)G.fb=1;
    A.fade=sm(G.fa); B.fade=sm(G.fb);
    A.tick(dt); B.tick(dt,A.time);
  };
  G.stats=function(){ return G.built?{fa:+G.fa.toFixed(3),fb:+G.fb.toFixed(3),mode:G.mode?'split':'merged',R_A:G.A.radius,R_B:G.B.radius,Ri_B:G.B.innerRadius,active:[G.A.active,G.B.active]}:null; };
})();
