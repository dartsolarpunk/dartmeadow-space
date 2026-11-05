/* DART Meadow — atmospheric LEVEL: the pure maths. Quaternions are [x,y,z,w], vectors [x,y,z]; no THREE, no DOM.
 * level(q, up): the attitude with the nose's horizontal heading kept, pitch 0 and zero roll, relative to `up`
 * (the local radial up at the craft: normalize(pos - planetCentre), NOT world Y). Board convention = three.js camera:
 * nose -Z, right +X, up +Y. ease/slerp give the shortest-arc eased sweep. */
(function(root){
  'use strict';
  function dot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
  function cross(a,b){ return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
  function len(a){ return Math.sqrt(dot(a,a)); }
  function norm(a){ var l=len(a)||1; return [a[0]/l,a[1]/l,a[2]/l]; }
  function rot(q,v){   // rotate v by unit quaternion q
    var x=q[0],y=q[1],z=q[2],w=q[3], tx=2*(y*v[2]-z*v[1]), ty=2*(z*v[0]-x*v[2]), tz=2*(x*v[1]-y*v[0]);
    return [v[0]+w*tx+(y*tz-z*ty), v[1]+w*ty+(z*tx-x*tz), v[2]+w*tz+(x*ty-y*tx)];
  }
  function radialUp(pos,centre){ return norm([pos[0]-centre[0],pos[1]-centre[1],pos[2]-centre[2]]); }
  function fromBasis(r,u,b){   // columns right, up, back(+Z) -> quaternion
    var m00=r[0],m10=r[1],m20=r[2], m01=u[0],m11=u[1],m21=u[2], m02=b[0],m12=b[1],m22=b[2], tr=m00+m11+m22, s, q;
    if(tr>0){ s=0.5/Math.sqrt(tr+1); q=[(m21-m12)*s,(m02-m20)*s,(m10-m01)*s,0.25/s]; }
    else if(m00>m11&&m00>m22){ s=2*Math.sqrt(1+m00-m11-m22); q=[0.25*s,(m01+m10)/s,(m02+m20)/s,(m21-m12)/s]; }
    else if(m11>m22){ s=2*Math.sqrt(1+m11-m00-m22); q=[(m01+m10)/s,0.25*s,(m12+m21)/s,(m02-m20)/s]; }
    else { s=2*Math.sqrt(1+m22-m00-m11); q=[(m02+m20)/s,(m12+m21)/s,0.25*s,(m10-m01)/s]; }
    var l=Math.sqrt(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]+q[3]*q[3]); return [q[0]/l,q[1]/l,q[2]/l,q[3]/l];
  }
  /* heading kept = the nose projected onto the horizon plane. Nose within ~1 degree of straight up/down: use the
   * board's own up vector (the direction the nose is leaning toward) so the heading does not flip. */
  function level(q,up){
    up=norm(up);
    var f=rot(q,[0,0,-1]), h=[f[0]-up[0]*dot(f,up),f[1]-up[1]*dot(f,up),f[2]-up[2]*dot(f,up)];
    if(len(h)<0.02){ var bu=rot(q,[0,1,0]), s=dot(f,up)>0?-1:1;   // nose up -> heading is where the belly points
      h=[bu[0]*s-up[0]*dot(bu,up)*s,bu[1]*s-up[1]*dot(bu,up)*s,bu[2]*s-up[2]*dot(bu,up)*s];
      if(len(h)<1e-6){ var r=rot(q,[1,0,0]); h=cross(up,r); } }
    h=norm(h);
    var right=norm(cross(h,up));
    return fromBasis(right,up,[-h[0],-h[1],-h[2]]);
  }
  function slerp(a,b,t){   // shortest arc
    var d=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3], s=1, o;
    if(d<0){ d=-d; s=-1; }
    var k0,k1;
    if(d>0.9995){ k0=1-t; k1=t*s; }
    else { o=Math.acos(d); var so=Math.sin(o); k0=Math.sin((1-t)*o)/so; k1=Math.sin(t*o)/so*s; }
    var r=[k0*a[0]+k1*b[0],k0*a[1]+k1*b[1],k0*a[2]+k1*b[2],k0*a[3]+k1*b[3]], l=Math.sqrt(r[0]*r[0]+r[1]*r[1]+r[2]*r[2]+r[3]*r[3]);
    return [r[0]/l,r[1]/l,r[2]/l,r[3]/l];
  }
  function ease(t){ t=t<0?0:t>1?1:t; return t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2; }   // same in-out quad as space autoLevel
  function angle(a,b){ var d=Math.abs(a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3]); return 2*Math.acos(d>1?1:d); }
  /* duration scales with the angle to turn: 0.6 s for a nudge up to 1.2 s for a half-turn */
  function duration(a){ var k=a/Math.PI; return 0.6+0.6*(k>1?1:k); }
  var api={radialUp:radialUp,level:level,slerp:slerp,ease:ease,angle:angle,duration:duration,rot:rot};
  if(typeof module!=='undefined'&&module.exports) module.exports=api; else root.DMLevel=api;
})(typeof window!=='undefined'?window:this);
