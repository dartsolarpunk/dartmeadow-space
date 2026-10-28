/* DART Meadow — thumbstick sub-buttons stay bound to their thumbsticks.
 *   Space HUD : #roll-row (roll L/R, anchor, auto) + #level-stack (gal, sys) around the LEFT stick #jL;
 *               #dart-pads (maneuver / DART cluster) + #assist-row (focus, idle) around the RIGHT stick #jR.
 *   Sky HUD   : #ap-btn-atmo above #atmo-steer-zone, #atmo-idle-btn above #atmo-climb-zone.
 * The buttons are placed from the sticks' MEASURED rects (so safe-area insets, the compact breakpoints and any
 * later stick resize are all picked up), in landscape beside/above the stick and in portrait stacked above it,
 * and re-placed on resize / orientationchange / visualViewport / ResizeObserver. If a landscape layout would
 * make two clusters touch (a very small window) it falls back to the stacked layout. No THREE objects, nothing
 * allocated per frame — it only runs on those events plus a slow 500 ms safety tick, and writes a style only
 * when its value changed. */
(function(){
  'use strict';
  var $=function(id){ return document.getElementById(id); };
  var LBL=18, GAP=10;   // the "LOOK / AIM" label above a stick; the gap between a stick and what sits beside it
  var probe=null, cache=Object.create(null), pending=0, ro=null, observed=[];
  function safe(){
    if(!probe){ probe=document.createElement('div'); probe.setAttribute('aria-hidden','true');
      probe.style.cssText='position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
      document.body.appendChild(probe); }
    var cs=getComputedStyle(probe);
    return {t:parseFloat(cs.paddingTop)||0,r:parseFloat(cs.paddingRight)||0,b:parseFloat(cs.paddingBottom)||0,l:parseFloat(cs.paddingLeft)||0};
  }
  function vis(e){ if(!e) return false; var r=e.getBoundingClientRect(); if(!(r.width>0&&r.height>0)) return false; var cs=getComputedStyle(e); return cs.display!=='none'&&cs.visibility!=='hidden'; }
  function size(e){ var r=e.getBoundingClientRect(); return {w:r.width,h:r.height}; }
  function put(e,x,y,par){   // x,y are viewport coords of the element's top-left; stored relative to its positioned parent
    var pr=par.getBoundingClientRect(), L=Math.round(x-pr.left), T=Math.round(y-pr.top), k=L+','+T;
    if(cache[e.id]===k&&e.style.getPropertyValue('left')===L+'px') return;
    cache[e.id]=k;
    e.style.setProperty('left',L+'px','important'); e.style.setProperty('top',T+'px','important');
    e.style.setProperty('right','auto','important'); e.style.setProperty('bottom','auto','important');
    e.style.setProperty('margin','0','important');
    e.style.setProperty('transition-property','background-color,border-color,box-shadow,color,opacity,transform','important');   // never animate left/top (would read as drift)
  }
  function hit(a,b){ return !(a.r<=b.l+1||a.l>=b.r-1||a.b<=b.t+1||a.t>=b.b-1); }
  function box(x,y,s){ return {l:x,t:y,r:x+s.w,b:y+s.h}; }
  function clampX(x,w,sf,W){ return Math.max(sf.l+4,Math.min(W-sf.r-4-w,x)); }

  // ── space HUD: four clusters around two sticks ──
  function space(){
    var jl=$('jL'), jr=$('jR'); if(!vis(jl)||!vis(jr)) return;
    var roll=$('roll-row'), lev=$('level-stack'), dart=$('dart-pads'), asst=$('assist-row');
    var par=jl.offsetParent&&jl.offsetParent!==document.body?(roll&&roll.offsetParent)||jl.offsetParent:(roll&&roll.offsetParent)||document.body;
    var W=window.innerWidth, H=window.innerHeight, sf=safe();
    var SL=jl.getBoundingClientRect(), SR=jr.getBoundingClientRect();
    var landscape=W>H;
    function build(land){
      var out={};
      var rs=roll&&vis(roll)?size(roll):null, ls=lev&&vis(lev)?size(lev):null, ds=dart&&vis(dart)?size(dart):null, as=asst&&vis(asst)?size(asst):null;
      if(land){
        if(ls) out.lev=box(clampX(SL.right+GAP,ls.w,sf,W),SL.bottom-ls.h,ls);
        if(rs) out.roll=box(clampX(SL.left,rs.w,sf,W),SL.top-LBL-rs.h,rs);
        if(ds) out.dart=box(clampX(SR.left-GAP-ds.w,ds.w,sf,W),SR.bottom-ds.h,ds);
        if(as) out.asst=box(clampX(SR.right-as.w,as.w,sf,W),SR.top-LBL-as.h,as);
      } else {   // portrait / fallback: each side stacked in a column above its stick
        var ty=SL.top-LBL;
        if(ls){ out.lev=box(clampX(SL.left,ls.w,sf,W),ty-ls.h,ls); ty-=ls.h+8; }
        if(rs) out.roll=box(clampX(SL.left,rs.w,sf,W),ty-rs.h,rs);
        var ry=SR.top-LBL;
        if(ds){ out.dart=box(clampX(SR.right-ds.w,ds.w,sf,W),ry-ds.h,ds); ry-=ds.h+8; }
        if(as) out.asst=box(clampX(SR.right-as.w,as.w,sf,W),ry-as.h,as);
      }
      return out;
    }
    function clash(o){
      var stickL={l:SL.left,t:SL.top,r:SL.right,b:SL.bottom}, stickR={l:SR.left,t:SR.top,r:SR.right,b:SR.bottom};
      var all=[o.lev,o.roll,o.dart,o.asst].filter(Boolean), i, j;
      for(i=0;i<all.length;i++){
        if(hit(all[i],stickL)||hit(all[i],stickR)) return true;
        for(j=i+1;j<all.length;j++) if(hit(all[i],all[j])) return true;
        if(all[i].t<sf.t+2||all[i].b>H) return true;
      }
      return false;
    }
    var o=build(landscape);
    if(landscape&&clash(o)) o=build(false);
    if(o.lev) put(lev,o.lev.l,o.lev.t,par);
    if(o.roll) put(roll,o.roll.l,o.roll.t,par);
    if(o.dart) put(dart,o.dart.l,o.dart.t,par);
    if(o.asst) put(asst,o.asst.l,o.asst.t,par);
  }

  // ── sky HUD: autopilot above the left stick, IDLE above the right ──
  function sky(){
    var sl=$('atmo-steer-zone'), sr=$('atmo-climb-zone'); if(!vis(sl)||!vis(sr)) return;
    var ap=$('ap-btn-atmo'), idle=$('atmo-idle-btn'), W=window.innerWidth, sf=safe();
    var a=sl.getBoundingClientRect(), b=sr.getBoundingClientRect();
    if(ap&&vis(ap)){ var s=size(ap); put(ap,clampX(a.left+a.width/2-s.w/2,s.w,sf,W),a.top-LBL-s.h-2,ap.offsetParent||document.body); }
    if(idle&&vis(idle)){ var t=size(idle); put(idle,clampX(b.left+b.width/2-t.w/2,t.w,sf,W),b.top-LBL-t.h-2,idle.offsetParent||document.body); }
  }

  function run(){ pending=0; try{ space(); sky(); watch(); }catch(e){} }
  function schedule(){ if(pending) return; pending=setTimeout(run,60); }
  function watch(){   // ResizeObserver on the sticks and the clusters (their size changes with the breakpoints)
    if(!window.ResizeObserver) return;
    if(!ro) ro=new ResizeObserver(schedule);
    ['jL','jR','roll-row','level-stack','dart-pads','assist-row','atmo-steer-zone','atmo-climb-zone','ap-btn-atmo','atmo-idle-btn'].forEach(function(id){
      var e=$(id); if(e&&observed.indexOf(e)<0){ observed.push(e); ro.observe(e); } });
  }
  window.addEventListener('resize',schedule);
  window.addEventListener('orientationchange',function(){ cache=Object.create(null); setTimeout(run,120); setTimeout(run,450); });
  if(window.visualViewport) window.visualViewport.addEventListener('resize',schedule);
  window.addEventListener('load',run);
  setInterval(run,500);
  window.DMPadBind={layout:run};
})();
