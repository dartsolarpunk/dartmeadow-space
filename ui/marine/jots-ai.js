// jots-ai.js — Journey of the Skyboard creature / NPC / marine AI.   ES module, zero dependencies, engine-agnostic.
// Design: struct-of-arrays (typed arrays), data-driven species + profiles (jots-species.json), spatial-hash boids,
// distance-LOD ticking with a round-robin budget, NPC schedules/routes, depth bands, discovery events.
// HOT PATH RULES: update() allocates nothing (no objects/arrays/closures created per frame). Events are written to a
// ring buffer and delivered through ONE reused event object (do not keep a reference to it).
// Axes: y up, creatures face +z. yaw = rotation about y: forward = (sin yaw, 0, cos yaw). pitch>0 = nose down (Rx).
export const ST={IDLE:0,WANDER:1,FLOCK:2,FLEE:3,CURIOUS:4,GREET:5,GOTO:6,DWELL:7,SIT:8,ROUTE:9,PAUSE:10};
export const CLIP={IDLE:0,MOVE:1,FLEE:2,GREET:3,TALK:4,SIT:5};
export const EV={GREET:1,DISCOVER:2,SPECIES_FIRST:3,ARRIVE:4,FLEE:5,SIT:6};
export const KIND={GROUND:0,FLYER:1,SWIMMER:2,FLOATER:3,SESSILE:4,BOTTOM:5};
const KIND_NAMES={ground:0,flyer:1,swimmer:2,floater:3,sessile:4,bottom:5};
const TAU=Math.PI*2, PI=Math.PI;
const LODI=new Float32Array([0,1/15,1/4,1]);               // tick interval per LOD band (s): near=every frame
const QUALITY={low:{lod:0.6,maxN:4,budget:48,hashHz:6,flockMid:0.2},med:{lod:0.85,maxN:6,budget:96,hashHz:10,flockMid:0.1},high:{lod:1.15,maxN:8,budget:200,hashHz:15,flockMid:1/15}};
function angDiff(a,b){let d=(b-a)%TAU; if(d>PI)d-=TAU; else if(d<-PI)d+=TAU; return d;}
function clamp(x,a,b){return x<a?a:x>b?b:x;}
function mergeInto(dst,src){ for(const k in src){const v=src[k]; if(v&&typeof v==='object'&&!Array.isArray(v)){ if(!dst[k]||typeof dst[k]!=='object')dst[k]={}; mergeInto(dst[k],v);} else dst[k]=v;} return dst; }

export class CreatureAI{
  /**
   * @param {object} o {capacity, species(json: {profiles,species,schedules}), world, onEvent, quality, seed}
   * world: {groundHeight(x,z)->y, waterY:number|(x,z)->y, isWater?(x,z)->bool}  (all optional; sensible flat defaults)
   */
  constructor(o={}){
    const N=this.cap=o.capacity||512;
    this.n=0; this.free=[]; this.freeN=0;
    this.world=Object.assign({groundHeight:null,waterY:0,isWater:null},o.world||{});
    this.onEvent=o.onEvent||null;
    this.seed=(o.seed||1337)>>>0;
    const F=()=>new Float32Array(N), U8=()=>new Uint8Array(N), I16=()=>new Int16Array(N);
    this.px=F();this.py=F();this.pz=F();this.vx=F();this.vy=F();this.vz=F();this.yaw=F();this.pitch=F();this.roll=F();
    this.tx=F();this.ty=F();this.tz=F();this.hx=F();this.hz=F();          // target, home
    this.timer=F();this.cd=F();this.acc=F();this.spd=F();this.phase=F();this.bold=F();this.clipSpeed=F();this.tint=F();
    this.state=U8();this.sp=U8();this.lod=U8();this.clip=U8();this.alive=U8();this.prev=U8();this.clipChanged=U8();this.kind=U8();
    this.grp=I16();this.slot=I16();this.sched=I16();this.route=I16();this.wp=I16();this.seat=I16();this.placeAt=I16();this.flags=U8(); // flags bit0 greeter bit1 npc
    this.visibleHint=U8();                                                  // renderer may set 0 to skip anim work (frustum)
    this.dist2=F();
    // species tables
    this.spec=[]; this.specIndex={}; this.profiles={}; this.schedules=[]; this.scheduleIndex={};
    this.seen=null;
    // groups
    this.G=64; this.gx=new Float32Array(64);this.gy=new Float32Array(64);this.gz=new Float32Array(64);this.gt=new Float32Array(64);this.gR=new Float32Array(64);this.gUsed=new Uint8Array(64);
    // places / routes / seats
    this.places=[]; this.placeIndex={}; this.px_=new Float32Array(64);this.py_=new Float32Array(64);this.pz_=new Float32Array(64);this.pr_=new Float32Array(64);
    this.routes=[]; this.routeIndex={};
    this.seats=[]; // per place: array of {x,y,z,yaw,taken}
    this.visited=new Set(); this.visitedFlag=new Uint8Array(64);
    this.agentPlaces=new Array(N).fill(null);
    // spatial hash for flockers
    this.HS=1<<12; this.hHead=new Int32Array(this.HS).fill(-1); this.hNext=new Int32Array(N).fill(-1); this.hCell=8; this.hTimer=0; this.hDirty=true;
    // player
    this.plx=0;this.ply=0;this.plz=0;this.plvx=0;this.plvz=0;this.plSpeed=0; this.hour=12; this.t=0; this.frame=0;
    // events (ring)
    this.EVN=64; this.evT=new Uint8Array(64);this.evA=new Int32Array(64);this.evP=new Int32Array(64);this.evS=new Int32Array(64);this.evH=0;this.evTl=0;
    this.ev={type:0,agent:-1,place:-1,species:-1,x:0,y:0,z:0,name:'',text:'',journal:'',speciesId:'',placeId:'',first:false};
    this.cursor=0; this.q=QUALITY[o.quality||'med']; this.qname=o.quality||'med';
    this.stats={ticked:0,near:0,mid:0,far:0,dormant:0,ms:0,active:0};
    this.maxNear=Infinity;
    if(o.species) this.loadSpecies(o.species);
  }
  // ------------------------------------------------------------------ data
  loadSpecies(j){
    this.profiles=j.profiles||{};
    for(const id in (j.species||{})) this.defineSpecies(id,j.species[id]);
    for(const id in (j.schedules||{})) this.defineSchedule(id,j.schedules[id]);
    this.seen=new Uint8Array(Math.max(1,this.spec.length));
  }
  defineSpecies(id,def){
    const base={kind:'ground',walk:1,run:3,turn:4,accel:4,radius:0.3,sight:25,clipRef:{move:1,flee:3},
      flee:{r:0,mul:1,hold:2.5,min:0},curious:{r:0,chance:0,keep:2.5,maxSpeed:2.0},greet:{r:0,cooldown:30,dur:3},
      flock:{on:false,nbr:6,sep:1,ali:1,coh:1,rad:6,sepR:1.2,maxN:8,leash:1},wander:{r:10,pause:[1,4],turnJit:0.4},
      depth:[0,20],alt:[0.5,3],bob:{a:0,f:1},lateral:false,floorOff:0.0,nightRise:0,clips:{}};
    if(def.profile && this.profiles[def.profile]) mergeInto(base,this.profiles[def.profile]);
    mergeInto(base,def); base.id=id; base.kindI=KIND_NAMES[base.kind]??0;
    base.walkClipSpeed=base.clipRef.move; base.fleeClipSpeed=base.clipRef.flee;
    base.depth0=base.depth[0]; base.depth1=base.depth[1];
    base.flee2=base.flee.r*base.flee.r; base.cur2=base.curious.r*base.curious.r; base.gr2=base.greet.r*base.greet.r; base.sight2=base.sight*base.sight;
    base.idx=this.spec.length; this.spec.push(base); this.specIndex[id]=base.idx; return base.idx;
  }
  defineSchedule(id,slots){ this.scheduleIndex[id]=this.schedules.length; this.schedules.push(slots); }
  addPlace(id,x,y,z,r,o={}){
    const i=this.places.length; if(i>=this.px_.length) throw new Error('too many places');
    this.px_[i]=x;this.py_[i]=y;this.pz_[i]=z;this.pr_[i]=r;
    this.places.push({id,name:o.name||id,greeting:o.greeting||'',journal:o.journal||'',discover:o.discover!==false,seats:[]});
    this.placeIndex[id]=i; return i;
  }
  addSeat(placeId,x,y,z,yaw){ const p=this.places[this.placeIndex[placeId]]; p.seats.push({x,y,z,yaw,taken:-1}); return p.seats.length-1; }
  addRoute(id,pts,o={}){ const a=new Float32Array(pts.length*2); for(let i=0;i<pts.length;i++){a[i*2]=pts[i][0];a[i*2+1]=pts[i][1];}
    this.routes.push({id,pts:a,n:pts.length,loop:o.loop!==false,pause:o.pause||[1.5,5]}); this.routeIndex[id]=this.routes.length-1; return this.routes.length-1; }
  setQuality(name){ this.q=QUALITY[name]||this.q; this.qname=name; }
  setTime(h){ this.hour=h; }
  setPlayer(x,y,z,dt){ if(dt>0){ this.plvx=(x-this.plx)/dt; this.plvz=(z-this.plz)/dt; this.plSpeed=Math.sqrt(this.plvx*this.plvx+this.plvz*this.plvz);} this.plx=x;this.ply=y;this.plz=z; }
  // ------------------------------------------------------------------ rng
  rnd(){ let t=(this.seed+=0x6D2B79F5)|0; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }
  rr(a,b){ return a+(b-a)*this.rnd(); }
  // ------------------------------------------------------------------ spawn
  spawn(speciesId,x,y,z,o={}){
    const si=typeof speciesId==='number'?speciesId:this.specIndex[speciesId]; const S=this.spec[si]; if(!S) throw new Error('unknown species '+speciesId);
    let i; if(this.freeN>0) i=this.free[--this.freeN]; else { if(this.n>=this.cap) return -1; i=this.n++; }
    this.alive[i]=1; this.sp[i]=si; this.kind[i]=S.kindI;
    this.px[i]=x;this.py[i]=y;this.pz[i]=z;this.vx[i]=this.vy[i]=this.vz[i]=0; this.yaw[i]=o.yaw!==undefined?o.yaw:this.rnd()*TAU; this.pitch[i]=this.roll[i]=0;
    this.hx[i]=o.homeX!==undefined?o.homeX:x; this.hz[i]=o.homeZ!==undefined?o.homeZ:z;
    this.state[i]=ST.IDLE; this.prev[i]=ST.IDLE; this.clip[i]=0; this.clipChanged[i]=1; this.timer[i]=this.rr(0,2); this.cd[i]=0; this.acc[i]=this.rnd()*0.2; this.spd[i]=0;
    this.phase[i]=this.rnd()*TAU; this.bold[i]=o.bold!==undefined?o.bold:this.rnd(); this.clipSpeed[i]=1; this.tint[i]=this.rnd();
    this.grp[i]=o.group!==undefined?o.group:-1; this.slot[i]=-1; this.route[i]=-1; this.wp[i]=0; this.seat[i]=-1; this.placeAt[i]=-1; this.visibleHint[i]=1;
    this.flags[i]=(o.greeter?1:0)|(o.npc||S.npc?2:0);
    this.sched[i]=o.schedule!==undefined?(typeof o.schedule==='number'?o.schedule:(this.scheduleIndex[o.schedule]??-1)):(S.schedule!==undefined?(this.scheduleIndex[S.schedule]??-1):-1);
    this.agentPlaces[i]=o.places||null;
    if(o.route!==undefined){ this.route[i]=typeof o.route==='number'?o.route:this.routeIndex[o.route]; }
    this._pickTarget(i,S,true);
    if(S.flock.on) this.hDirty=true;
    return i;
  }
  /** spawn n members of a flock/school sharing a group target; returns group id */
  spawnGroup(speciesId,n,cx,cy,cz,spread,o={}){
    let g=-1; for(let k=0;k<this.G;k++) if(!this.gUsed[k]){g=k;break;} if(g<0) g=0; this.gUsed[g]=1;
    this.gx[g]=cx;this.gy[g]=cy;this.gz[g]=cz;this.gt[g]=0;this.gR[g]=o.wander||spread*3;
    for(let k=0;k<n;k++){ const a=this.rnd()*TAU, r=Math.sqrt(this.rnd())*spread;
      this.spawn(speciesId,cx+Math.sin(a)*r,cy+(this.rnd()-0.5)*spread*0.5,cz+Math.cos(a)*r,Object.assign({group:g,homeX:cx,homeZ:cz},o)); }
    return g;
  }
  despawn(i){ if(!this.alive[i]) return; this.alive[i]=0; this.free[this.freeN++]=i; this.agentPlaces[i]=null; this.hDirty=true; }
  // ------------------------------------------------------------------ world helpers
  _ground(x,z){ const g=this.world.groundHeight; return g?g(x,z):0; }
  _water(x,z){ const w=this.world.waterY; return typeof w==='function'?w(x,z):w; }
  // ------------------------------------------------------------------ events
  _emit(type,agent,place,sp){ const h=this.evH; this.evT[h]=type;this.evA[h]=agent;this.evP[h]=place;this.evS[h]=sp; this.evH=(h+1)%this.EVN; if(this.evH===this.evTl) this.evTl=(this.evTl+1)%this.EVN; }
  _drain(){
    const e=this.ev;
    while(this.evTl!==this.evH){
      const t=this.evTl; this.evTl=(t+1)%this.EVN;
      e.type=this.evT[t]; e.agent=this.evA[t]; e.place=this.evP[t]; e.species=this.evS[t]; e.first=false;
      const a=e.agent;
      if(a>=0){ e.x=this.px[a];e.y=this.py[a];e.z=this.pz[a]; } else { e.x=this.plx;e.y=this.ply;e.z=this.plz; }
      const S=e.species>=0?this.spec[e.species]:null; e.speciesId=S?S.id:''; e.name=S?(S.name||S.id):'';
      const P=e.place>=0?this.places[e.place]:null; e.placeId=P?P.id:'';
      e.text=''; e.journal='';
      if(e.type===EV.DISCOVER){ e.text=P.greeting; e.journal=P.journal||('Discovered '+P.name); e.name=P.name; e.first=true; }
      else if(e.type===EV.GREET){ e.text=this._pick(S&&S.greeting,a)||(P&&P.greeting)||''; e.journal=(P&&P.journal)||''; }
      else if(e.type===EV.SPECIES_FIRST){ e.text=this._pick(S&&S.greeting,a)||''; e.journal=(S&&S.journal)||('Spotted a '+e.name); e.first=true; }
      else if(e.type===EV.ARRIVE||e.type===EV.SIT){ e.text=P?P.name:''; }
      if(this.onEvent) this.onEvent(e);
    }
  }
  _pick(v,a){ if(!v) return ''; if(typeof v==='string') return v; const n=v.length; return v[((a>=0?this.tint[a]:this.rnd())*n)|0]; }
  // ------------------------------------------------------------------ main update
  update(dt){
    const t0=(typeof performance!=='undefined')?performance.now():0;
    if(dt>0.25) dt=0.25; this.t+=dt; this.frame++;
    const q=this.q, n=this.n, st=this.stats; st.ticked=st.near=st.mid=st.far=st.dormant=0; let active=0;
    const l0=22*q.lod,l1=60*q.lod,l2=150*q.lod; const n2=l0*l0,m2=l1*l1,f2=l2*l2;
    // spatial hash rebuild (flockers only) at hashHz
    this.hTimer+=dt; if(this.hTimer>=1/q.hashHz||this.hDirty){ this.hTimer=0; this.hDirty=false; this._rebuildHash(); }
    // groups: retarget
    for(let g=0;g<this.G;g++){ if(!this.gUsed[g]) continue; this.gt[g]-=dt; if(this.gt[g]<=0) this._groupRetarget(g); }
    // discovery places @ ~4Hz
    this._placeTimer=(this._placeTimer||0)+dt; if(this._placeTimer>0.25){ this._placeTimer=0; this._checkPlaces(); }
    let budget=q.budget, start=this.cursor, cnt=0, last=start;
    for(let k=0;k<n;k++){
      let i=start+k; if(i>=n) i-=n; if(!this.alive[i]) continue; active++;
      const dx=this.px[i]-this.plx,dy=this.py[i]-this.ply,dz=this.pz[i]-this.plz; const d2=dx*dx+dz*dz+dy*dy*0.25; this.dist2[i]=d2;
      const lod=d2<n2?0:d2<m2?1:d2<f2?2:3; this.lod[i]=lod; this.acc[i]+=dt;
      if(this.acc[i]<LODI[lod]) { if(lod===0) {} else continue; }
      if(lod>0){ if(budget<=0) { continue; } budget--; }
      last=i+1; const a=this.acc[i]; this.acc[i]=0; st.ticked++; if(lod===0)st.near++; else if(lod===1)st.mid++; else if(lod===2)st.far++; else st.dormant++;
      this._step(i,a>0.25?0.25:a,lod,d2);
    }
    if(budget<=0) this.cursor=last>=n?0:last; // resume where the budget ran out (round-robin fairness)
    st.active=active;
    this._drain();
    if(t0) st.ms=performance.now()-t0;
  }
  // apply pose to a three.js Object3D-like (position + rotation) — allocation-free
  applyTo(obj,i){ obj.position.set(this.px[i],this.py[i],this.pz[i]); obj.rotation.order='YXZ'; obj.rotation.set(this.pitch[i],this.yaw[i],this.roll[i]); }
  // external triggers
  scare(x,y,z,r,hold=3){ const r2=r*r; for(let i=0;i<this.n;i++){ if(!this.alive[i]) continue; const S=this.spec[this.sp[i]]; if(S.kindI===KIND.SESSILE&&!S.reacts) continue;
      const dx=this.px[i]-x,dz=this.pz[i]-z,dy=this.py[i]-y; if(dx*dx+dz*dz+dy*dy<r2){ this._enterFlee(i,S,x,y,z,hold); } } }
  // ------------------------------------------------------------------ internals
  _setClip(i,c,speedScale){ if(this.clip[i]!==c){ this.clip[i]=c; this.clipChanged[i]=1; } this.clipSpeed[i]=speedScale; }
  _rebuildHash(){
    this.hHead.fill(-1); const inv=1/this.hCell, M=this.HS-1;
    for(let i=0;i<this.n;i++){ if(!this.alive[i]) continue; const S=this.spec[this.sp[i]]; if(!S.flock.on) continue;
      const cx=Math.floor(this.px[i]*inv),cz=Math.floor(this.pz[i]*inv); const h=((cx*73856093)^(cz*19349663))&M; this.hNext[i]=this.hHead[h]; this.hHead[h]=i; }
  }
  _groupRetarget(g){
    const S0=this.gR[g]; // wander radius about group's home (first member's home): keep drifting around anchor
    const a=this.rnd()*TAU, r=this.rr(0.3,1)*S0; const ax=this._gax?this._gax[g]:this.gx[g], az=this._gaz?this._gaz[g]:this.gz[g];
    if(!this._gax){ this._gax=new Float32Array(this.G); this._gaz=new Float32Array(this.G); this._gay=new Float32Array(this.G); for(let k=0;k<this.G;k++){this._gax[k]=this.gx[k];this._gaz[k]=this.gz[k];this._gay[k]=this.gy[k];} }
    this.gx[g]=this._gax[g]+Math.sin(a)*r; this.gz[g]=this._gaz[g]+Math.cos(a)*r; this.gy[g]=this._gay[g]+(this.rnd()-0.5)*S0*0.3; this.gt[g]=this.rr(4,10);
  }
  _pickTarget(i,S,init){
    const r=S.wander.r, a=this.rnd()*TAU, d=Math.sqrt(this.rnd())*r;
    const x=this.hx[i]+Math.sin(a)*d, z=this.hz[i]+Math.cos(a)*d; this.tx[i]=x; this.tz[i]=z;
    const k=S.kindI;
    if(k===KIND.SWIMMER||k===KIND.FLOATER){ this.ty[i]=this._pickDepthY(i,S,x,z); }
    else if(k===KIND.FLYER){ this.ty[i]=this._ground(x,z)+this.rr(S.alt[0],S.alt[1]); }
    else this.ty[i]=this._ground(x,z);
  }
  _pickDepthY(i,S,x,z){
    const wy=this._water(x,z); let d0=S.depth0,d1=S.depth1;
    if(S.nightRise && (this.hour<6||this.hour>=19.5)){ d0=Math.max(0,d0-S.nightRise); d1=Math.max(d0+1,d1-S.nightRise); }
    let y=wy-this.rr(d0,d1)-0.15; const fl=this._ground(x,z)+0.4+S.floorOff; if(y<fl) y=fl; if(y>wy-0.15) y=wy-0.15; return y;
  }
  _enterFlee(i,S,x,y,z,hold){
    if(S.flee.r<=0 && !S.reacts) return;
    if(this.state[i]!==ST.FLEE){ this._emit(EV.FLEE,i,-1,this.sp[i]); }
    this.prev[i]=this.state[i]===ST.FLEE?this.prev[i]:this.state[i]; this.state[i]=ST.FLEE; this.timer[i]=hold||S.flee.hold;
    this._fx=x;this._fy=y;this._fz=z; this.tx[i]=x; this.tz[i]=z; this.ty[i]=y; this.seat[i]>=0&&this._freeSeat(i);
  }
  _freeSeat(i){ const pa=this.placeAt[i]; if(pa>=0&&this.seat[i]>=0){ const s=this.places[pa].seats[this.seat[i]]; if(s&&s.taken===i) s.taken=-1; } this.seat[i]=-1; }
  _checkPlaces(){
    const np=this.places.length;
    for(let p=0;p<np;p++){
      const P=this.places[p]; if(!P.discover||this.visitedFlag[p]) continue;
      const dx=this.plx-this.px_[p],dz=this.plz-this.pz_[p],r=this.pr_[p]; if(dx*dx+dz*dz>r*r) continue;
      this.visitedFlag[p]=1; this.visited.add(P.id);
      this._emit(EV.DISCOVER,-1,p,-1);
      // nearest greeter NPC within place (or 20m) says hello
      let best=-1,bd=(r+20)*(r+20);
      for(let i=0;i<this.n;i++){ if(!this.alive[i]||!(this.flags[i]&1)) continue; const ex=this.px[i]-this.px_[p],ez=this.pz[i]-this.pz_[p],d=ex*ex+ez*ez; if(d<bd){bd=d;best=i;} }
      if(best>=0){ this._startGreet(best,this.spec[this.sp[best]],p,true); }
    }
  }
  _startGreet(i,S,place,force){
    if(this.state[i]===ST.SIT||this.state[i]===ST.FLEE) { if(force){ this._emit(EV.GREET,i,place,this.sp[i]); } return; }
    if(this.state[i]!==ST.GREET) this.prev[i]=this.state[i];
    this.state[i]=ST.GREET; this.timer[i]=S.greet.dur||3; this.cd[i]=this.t+(S.greet.cooldown||30); this.spd[i]=0;
    this._emit(EV.GREET,i,place,this.sp[i]);
  }
  _faceToward(i,x,z,dt,rate){ const want=Math.atan2(x-this.px[i],z-this.pz[i]); const d=angDiff(this.yaw[i],want); const m=rate*dt; this.yaw[i]+= d>m?m:d<-m?-m:d; }
  // Core integrate: head toward (tx,tz) at speed v. Handles lateral movers and 3D for swimmers/flyers.
  _move(i,S,v,dt,tx,ty,tz,flee){
    const dx=tx-this.px[i],dz=tz-this.pz[i]; const dh=Math.sqrt(dx*dx+dz*dz);
    let want=Math.atan2(dx,dz); if(flee) want=Math.atan2(-dx,-dz);
    if(S.lateral) want-=PI*0.5;
    let d=angDiff(this.yaw[i],want); const turn=S.turn*(flee?1.6:1)*dt; this.yaw[i]+=d>turn?turn:d<-turn?-turn:d;
    // speed smoothing; slow while turning sharply (ground)
    const k=S.kindI; let tv=v; if(k===KIND.GROUND||k===KIND.BOTTOM){ const c=Math.cos(d); if(c<0.3) tv*=0.25+0.75*clamp(c+0.7,0,1)*0.5; }
    const a=S.accel*dt; this.spd[i]+=clamp(tv-this.spd[i],-a*1.5,a);
    const mv=this.yaw[i]+(S.lateral?PI*0.5:0); const sx=Math.sin(mv),cz=Math.cos(mv);
    this.vx[i]=sx*this.spd[i]; this.vz[i]=cz*this.spd[i];
    let ny=this.py[i]; 
    if(k===KIND.GROUND||k===KIND.BOTTOM){ const nx=this.px[i]+this.vx[i]*dt, nz=this.pz[i]+this.vz[i]*dt; this.px[i]=nx; this.pz[i]=nz; const gy=this._ground(nx,nz)+S.floorOff; ny=this.py[i]+(gy-this.py[i])*Math.min(1,12*dt); this.vy[i]=0; this.pitch[i]=0; }
    else {
      // 3D: vertical steering toward ty
      let vyT=(ty-this.py[i])*0.8; const lim=this.spd[i]*0.6+0.2; vyT=clamp(vyT,-lim,lim); this.vy[i]+= (vyT-this.vy[i])*Math.min(1,3*dt);
      this.px[i]+=this.vx[i]*dt; this.pz[i]+=this.vz[i]*dt; ny=this.py[i]+this.vy[i]*dt;
      const h=Math.sqrt(this.vx[i]*this.vx[i]+this.vz[i]*this.vz[i]); const tp=-Math.atan2(this.vy[i],h+0.05); this.pitch[i]+= (tp-this.pitch[i])*Math.min(1,4*dt);
      if(k===KIND.SWIMMER||k===KIND.FLOATER){ const wy=this._water(this.px[i],this.pz[i]); const fl=this._ground(this.px[i],this.pz[i])+0.25; if(ny>wy-0.1) ny=wy-0.1; if(ny<fl) ny=fl; }
      else if(k===KIND.FLYER){ const fl=this._ground(this.px[i],this.pz[i])+0.3; if(ny<fl) ny=fl; }
      // bank into turns
      const rt=clamp(d*1.2,-0.7,0.7)*(S.bank===undefined?0.6:S.bank); this.roll[i]+=(rt-this.roll[i])*Math.min(1,4*dt);
    }
    this.py[i]=ny;
    return dh;
  }
  _applyBob(i,S,dt){ if(S.bob.a>0){ const b=Math.sin(this.t*S.bob.f*TAU+this.phase[i])*S.bob.a; this.py[i]+=b*dt*S.bob.f*TAU*0.5; } }
  _step(i,dt,lod,d2){
    const S=this.spec[this.sp[i]]; const k=S.kindI; let state=this.state[i];
    // ---------- first-sight journal hook
    if(lod===0 && this.seen && !this.seen[S.idx] && d2<S.sight2 && S.journal!==undefined){ this.seen[S.idx]=1; this._emit(EV.SPECIES_FIRST,i,-1,S.idx); }
    if(k===KIND.SESSILE){ this._stepSessile(i,S,dt,d2,lod); return; }
    // ---------- sensing (near/mid only)
    const pd=Math.sqrt(d2);
    if(lod<=1){
      if(S.flee.r>0 && d2<S.flee2 && state!==ST.SIT && state!==ST.FLEE){
        // stealth: slow-moving players scare less (bold creatures tolerate approach)
        const scale=this.plSpeed>3?1.0:(this.plSpeed>0.6?0.85:0.6+0.25*(1-this.bold[i]));
        if(d2<S.flee2*scale*scale) this._enterFlee(i,S,this.plx,this.ply,this.plz,S.flee.hold), state=ST.FLEE;
      }
      if(state!==ST.FLEE && state!==ST.GREET && S.greet.r>0 && d2<S.gr2 && this.t>this.cd[i] && state!==ST.SIT){ this._startGreet(i,S,-1,false); state=ST.GREET; }
      else if(state!==ST.FLEE && state!==ST.GREET && S.curious.r>0 && d2<S.cur2 && d2>S.curious.keep*S.curious.keep && this.plSpeed<S.curious.maxSpeed && this.bold[i]>1-S.curious.chance && state!==ST.SIT && state!==ST.CURIOUS){
        this.prev[i]=state; state=this.state[i]=ST.CURIOUS; this.timer[i]=this.rr(4,9); }
    }
    this.timer[i]-=dt;
    // ---------- state machine
    switch(state){
      case ST.FLEE:{
        const fx=this.plx,fz=this.plz; let tx=this.tx[i],tz=this.tz[i],ty=this.ty[i];
        if(lod<=1){ tx=fx; tz=fz; ty=this.ply; }
        let v=S.run*S.flee.mul; 
        if(k===KIND.FLYER){ ty=this._ground(this.px[i],this.pz[i])+S.alt[1]*1.6; }
        else if(k===KIND.SWIMMER||k===KIND.FLOATER){ ty=this.py[i]-3; const wy=this._water(this.px[i],this.pz[i]); if(ty>wy-S.depth0-0.2) ty=wy-S.depth0-0.2; if(S.depth1>S.depth0) ty=Math.max(ty,wy-S.depth1); }
        this._move(i,S,v,dt,tx,ty,tz,true); this._setClip(i,CLIP.FLEE,v/S.fleeClipSpeed);
        if(this.timer[i]<=0 && (lod>1 || d2>S.flee2*1.8)){ this.state[i]=this.prev[i]===ST.FLEE?ST.WANDER:this.prev[i]; if(this.state[i]===ST.CURIOUS||this.state[i]===ST.GREET)this.state[i]=ST.WANDER; this.timer[i]=this.rr(0.5,2); this._pickTarget(i,S,false); this.slot[i]=-1; this.spd[i]*=0.5; }
        break; }
      case ST.GREET:{
        this._faceToward(i,this.plx,this.plz,dt,6); this.spd[i]*=0.8; this._setClip(i,CLIP.GREET,1);
        if(this.timer[i]<=0){ this.state[i]=this.prev[i]===ST.GREET?ST.IDLE:this.prev[i]; if(this.state[i]===ST.CURIOUS)this.state[i]=ST.IDLE; this.timer[i]=this.rr(1,3); }
        break; }
      case ST.CURIOUS:{
        const keep=S.curious.keep; const tx=this.plx,tz=this.plz;
        if(d2>keep*keep*1.1 && d2<S.cur2*1.3){ const v=S.walk*1.1; this._move(i,S,v,dt,tx,this.ply,tz,false); this._setClip(i,CLIP.MOVE,v/S.walkClipSpeed); }
        else { this._faceToward(i,tx,tz,dt,3); this.spd[i]*=0.85; this._setClip(i,CLIP.IDLE,1); }
        if(this.timer[i]<=0||d2>S.cur2*1.5||this.plSpeed>S.curious.maxSpeed*1.8){ this.state[i]=ST.IDLE; this.timer[i]=this.rr(1,3); this.cd[i]=Math.max(this.cd[i],this.t+8); }
        break; }
      case ST.SIT:{
        const sp=this.spd[i]; this.spd[i]=0; this.vx[i]=this.vz[i]=0; this._setClip(i,CLIP.SIT,1);
        if(this.sched[i]>=0) this._scheduleCheck(i,S,dt);
        break; }
      default: this._stepIdleWander(i,S,dt,lod,state);
    }
    if(this.state[i]!==ST.FLEE && S.bob.a>0 && (k===KIND.FLYER||k===KIND.SWIMMER||k===KIND.FLOATER)) this._applyBob(i,S,dt);
  }
  _stepSessile(i,S,dt,d2,lod){
    // flora/anemones: react (flee clip = quick recoil) when player/creature gets close, else sway
    if(lod>1) return;
    if(S.flee.r>0 && d2<S.flee2){ if(this.state[i]!==ST.FLEE){ this.state[i]=ST.FLEE; this.timer[i]=S.flee.hold; this._setClip(i,CLIP.FLEE,1); } }
    else if(this.state[i]===ST.FLEE){ this.timer[i]-=dt; if(this.timer[i]<=0){ this.state[i]=ST.IDLE; this._setClip(i,CLIP.MOVE,1); } }
    else { if(this.clip[i]!==CLIP.MOVE) this._setClip(i,CLIP.MOVE,0.8+0.4*this.tint[i]); }
  }
  _stepIdleWander(i,S,dt,lod,state){
    const k=S.kindI;
    // schedule-driven NPCs
    if(this.sched[i]>=0){ this._scheduleStep(i,S,dt,lod); return; }
    // flock members follow boids (when flocking enabled and have neighbors/group)
    if(S.flock.on && this.grp[i]>=0){ this._stepFlock(i,S,dt,lod); return; }
    // plain wander: walk to target, pause, repeat
    if(state===ST.IDLE||state===ST.PAUSE){
      this.spd[i]*=0.8; this._setClip(i,CLIP.IDLE,1);
      if(this.timer[i]<=0){ this._pickTarget(i,S,false); this.state[i]=ST.WANDER; this.timer[i]=this.rr(6,18); }
      else if(k===KIND.FLYER||k===KIND.SWIMMER||k===KIND.FLOATER){ this.state[i]=ST.WANDER; }
      return;
    }
    const dx=this.tx[i]-this.px[i],dz=this.tz[i]-this.pz[i]; const dh2=dx*dx+dz*dz;
    const v=S.walk*(0.8+0.4*this.tint[i]);
    if(dh2<0.25*(1+S.radius) || this.timer[i]<=0){
      if(k===KIND.GROUND||k===KIND.BOTTOM||k===KIND.SESSILE){ this.state[i]=ST.IDLE; this.timer[i]=this.rr(S.wander.pause[0],S.wander.pause[1]); }
      else { this._pickTarget(i,S,false); this.timer[i]=this.rr(6,18); }
    }
    // swimmers/flyers: occasional jittery redirect for organic motion
    if(lod<=1 && S.wander.turnJit>0 && (k===KIND.FLYER)){ this.tx[i]+=(this.rnd()-0.5)*S.wander.turnJit*dt*20; this.tz[i]+=(this.rnd()-0.5)*S.wander.turnJit*dt*20; }
    this._move(i,S,v,dt,this.tx[i],this.ty[i],this.tz[i],false); this._setClip(i,CLIP.MOVE,v/S.walkClipSpeed);
    this._confine(i,S);
  }
  _confine(i,S){ const r=S.wander.r*1.6+4; const dx=this.px[i]-this.hx[i],dz=this.pz[i]-this.hz[i]; if(dx*dx+dz*dz>r*r){ this.tx[i]=this.hx[i]; this.tz[i]=this.hz[i]; } }
  // ---------------- boids / schooling (spatial hash, bounded neighbours, no allocations)
  _stepFlock(i,S,dt,lod){
    const F=S.flock, g=this.grp[i]; const maxN=Math.min(F.maxN,this.q.maxN*(lod===0?1.5:1)|0);
    let cx=0,cy=0,cz=0,ax=0,ay=0,az=0,sx=0,sy=0,sz=0,cnt=0;
    const inv=1/this.hCell, M=this.HS-1, ci=Math.floor(this.px[i]*inv), cj=Math.floor(this.pz[i]*inv); const r2=F.rad*F.rad, s2=F.sepR*F.sepR;
    if(lod<=2){
      for(let oz=-1;oz<=1&&cnt<maxN;oz++) for(let ox=-1;ox<=1&&cnt<maxN;ox++){
        let j=this.hHead[(((ci+ox)*73856093)^((cj+oz)*19349663))&M], guard=0;
        while(j>=0 && cnt<maxN && guard++<64){
          if(j!==i && this.sp[j]===this.sp[i]){
            const dx=this.px[j]-this.px[i],dy=this.py[j]-this.py[i],dz=this.pz[j]-this.pz[i],d=dx*dx+dy*dy+dz*dz;
            if(d<r2){ cnt++; cx+=dx;cy+=dy;cz+=dz; ax+=this.vx[j];ay+=this.vy[j];az+=this.vz[j];
              if(d<s2&&d>1e-6){ const w=1/d; sx-=dx*w;sy-=dy*w;sz-=dz*w; } }
          }
          j=this.hNext[j];
        }
      }
    }
    const k=S.kindI; let gx=this.gx[g]-this.px[i], gy=this.gy[g]-this.py[i], gz=this.gz[g]-this.pz[i];
    let gl=Math.sqrt(gx*gx+gz*gz)+1e-4; const leash=F.leash;
    let dvx=gx/gl*leash*0.6, dvz=gz/gl*leash*0.6, dvy=(this.ty[i]-this.py[i])*0.2;
    if(cnt>0){ const ic=1/cnt; dvx+=cx*ic*F.coh*0.5+(ax*ic-this.vx[i])*F.ali*0.4+sx*F.sep*1.2; dvz+=cz*ic*F.coh*0.5+(az*ic-this.vz[i])*F.ali*0.4+sz*F.sep*1.2;
      if(k!==KIND.GROUND){ dvy+=cy*ic*F.coh*0.4+(ay*ic-this.vy[i])*F.ali*0.3+sy*F.sep*1.2; } }
    // swimmer depth band
    if(k===KIND.SWIMMER||k===KIND.FLOATER){ const wy=this._water(this.px[i],this.pz[i]); let d0=S.depth0,d1=S.depth1; if(S.nightRise&&(this.hour<6||this.hour>=19.5)){d0=Math.max(0,d0-S.nightRise);d1=Math.max(d0+1,d1-S.nightRise);}
      const dep=wy-this.py[i]; if(dep<d0) dvy-=(d0-dep)*0.6+0.3; else if(dep>d1) dvy+=(dep-d1)*0.6+0.3; dvy+=gy*0.15; }
    else if(k===KIND.FLYER){ dvy+=gy*0.3; }
    // integrate as steering via a virtual target ahead of the agent
    const sp=S.walk*(0.85+0.3*this.tint[i]); const tl=Math.sqrt(dvx*dvx+dvz*dvz)+1e-4;
    const tx=this.px[i]+dvx/tl*4, tz=this.pz[i]+dvz/tl*4;
    let ty=this.py[i]+dvy*2; if(k===KIND.GROUND) ty=0;
    this._move(i,S,sp,dt,tx,ty,tz,false); this._setClip(i,CLIP.MOVE,sp/S.walkClipSpeed);
    if(k===KIND.GROUND && cnt===0 && gl<2){ this.spd[i]*=0.5; this._setClip(i,CLIP.IDLE,1); }
  }
  // ---------------- NPC schedules, routes, seats
  _slotFor(sched,h){ const sl=this.schedules[sched]; for(let s=0;s<sl.length;s++){ const a=sl[s].h[0],b=sl[s].h[1]; if(a<=b?(h>=a&&h<b):(h>=a||h<b)) return s; } return 0; }
  _placeFor(i,name){ const ap=this.agentPlaces[i]; const id=(ap&&ap[name])||name; const pi=this.placeIndex[id]; return pi===undefined?-1:pi; }
  _scheduleCheck(i,S,dt){ const s=this._slotFor(this.sched[i],this.hour); if(s!==this.slot[i]){ this._beginSlot(i,S,s); } }
  _beginSlot(i,S,s){
    this.slot[i]=s; const sl=this.schedules[this.sched[i]][s]; const pi=this._placeFor(i,sl.place);
    if(this.state[i]===ST.SIT) this._freeSeat(i);
    if(pi<0){ this.state[i]=ST.IDLE; return; }
    this.placeAt[i]=pi; const P=this.places[pi]; this.seat[i]=-1;
    if(sl.act==='sit'){ for(let q=0;q<P.seats.length;q++){ if(P.seats[q].taken<0||P.seats[q].taken===i){ P.seats[q].taken=i; this.seat[i]=q; this.tx[i]=P.seats[q].x; this.tz[i]=P.seats[q].z; this.ty[i]=P.seats[q].y; break; } } }
    if(this.seat[i]<0){ const a=this.rnd()*TAU,d=Math.sqrt(this.rnd())*this.pr_[pi]*0.8; this.tx[i]=this.px_[pi]+Math.sin(a)*d; this.tz[i]=this.pz_[pi]+Math.cos(a)*d; this.ty[i]=this.py_[pi]; }
    if(sl.act==='route'&&sl.route!==undefined){ const ri=this.routeIndex[sl.route]; if(ri!==undefined){ this.route[i]=ri; this.wp[i]=0; } }
    this.state[i]=ST.GOTO; this.timer[i]=60;
  }
  _scheduleStep(i,S,dt,lod){
    const s=this._slotFor(this.sched[i],this.hour); if(s!==this.slot[i]||this.state[i]===ST.IDLE&&this.slot[i]<0) this._beginSlot(i,S,s);
    const sl=this.schedules[this.sched[i]][this.slot[i]]; const state=this.state[i];
    if(state===ST.GOTO){
      const dx=this.tx[i]-this.px[i],dz=this.tz[i]-this.pz[i]; const dd=dx*dx+dz*dz; const v=S.walk;
      if(dd<0.2 || this.timer[i]<=0 && dd<1){
        const pi=this.placeAt[i];
        if(sl.act==='sit'&&this.seat[i]>=0){ const st=this.places[pi].seats[this.seat[i]]; this.px[i]=st.x;this.pz[i]=st.z;this.py[i]=st.y;this.yaw[i]=st.yaw; this.state[i]=ST.SIT; this.spd[i]=0; this._emit(EV.SIT,i,pi,this.sp[i]); }
        else if(sl.act==='route'&&this.route[i]>=0){ this.state[i]=ST.ROUTE; this.wp[i]=0; this._emit(EV.ARRIVE,i,pi,this.sp[i]); }
        else { this.state[i]=ST.DWELL; this.timer[i]=this.rr(3,9); this._emit(EV.ARRIVE,i,pi,this.sp[i]); }
        return;
      }
      this.timer[i]-=dt; this._move(i,S,v,dt,this.tx[i],this.ty[i],this.tz[i],false); this._setClip(i,CLIP.MOVE,v/S.walkClipSpeed); return;
    }
    if(state===ST.DWELL||state===ST.PAUSE){
      this.spd[i]*=0.8; this.timer[i]-=dt; const pi=this.placeAt[i];
      // alternate idle / talk; occasionally shuffle to another spot inside the place
      this._setClip(i,(this.tint[i]>0.5&&((this.t*0.2+this.phase[i])%2<1))?CLIP.TALK:CLIP.IDLE,1);
      if(this.timer[i]<=0 && pi>=0){ const a=this.rnd()*TAU,d=Math.sqrt(this.rnd())*this.pr_[pi]*0.8; this.tx[i]=this.px_[pi]+Math.sin(a)*d; this.tz[i]=this.pz_[pi]+Math.cos(a)*d; this.state[i]=ST.GOTO; this.timer[i]=30; if(state===ST.PAUSE) this.state[i]=ST.ROUTE; }
      return;
    }
    if(state===ST.ROUTE){
      const R=this.routes[this.route[i]]; if(!R){ this.state[i]=ST.DWELL; return; }
      let w=this.wp[i]; const tx=R.pts[w*2],tz=R.pts[w*2+1]; const dx=tx-this.px[i],dz=tz-this.pz[i];
      if(dx*dx+dz*dz<0.4){ w++; if(w>=R.n){ if(R.loop) w=0; else { this.state[i]=ST.DWELL; this.timer[i]=this.rr(3,8); return; } } this.wp[i]=w; this.state[i]=ST.PAUSE; this.timer[i]=this.rr(R.pause[0],R.pause[1]); return; }
      const v=S.walk; this._move(i,S,v,dt,tx,this._ground(tx,tz),tz,false); this._setClip(i,CLIP.MOVE,v/S.walkClipSpeed); return;
    }
    // fallback
    this._beginSlot(i,S,this.slot[i]);
  }
}
export default CreatureAI;
