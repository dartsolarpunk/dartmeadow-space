/* DART Meadow — 3D UI layer (crunch 2).
   Gives the vector HUD (kite, side frames, mini kites, joysticks, minimap ring,
   loading screen, menus) a thin extruded-panel look with a perspective tilt that
   follows each element's place on screen, so panels lean toward the screen centre
   like a cockpit glass. Done on the compositor (CSS 3D transforms + one stacked
   drop-shadow for the extrusion), so the panels stay the real DOM elements: every
   tap, hover and joystick drag behaves exactly as before, and in AR the same DOM
   rides on top of passthrough via WebXR dom-overlay. Tilts are recomputed only on
   resize / orientation change / screen switch (never per frame), so the draw cost
   is one composited layer per panel and nothing on the GPU scene side.
   Off switch: localStorage['dm.ui3d']='0'.  API: window.DMUI3D.{refresh,enable,disable}. */
(function(){
  'use strict';
  if(window.DMUI3D) return;
  var SEL=['.hud-c','.hud-l','.hud-r','.mini-kite','.dm-frame','.joystick-base','#minimap','#loading-screen .ls-card','.menu-panel','.art-btns'];
  var MAX_DEG=9;          // largest lean at the screen corners
  var on=true;
  try{ on=localStorage.getItem('dm.ui3d')!=='0'; }catch(e){}
  var css=document.createElement('style');
  css.id='dm-ui3d-css';
  css.textContent=
    'body.dm-ui3d .dm-ui3d-p{rotate:var(--ui3d-rot,0deg);'+
    'filter:drop-shadow(var(--ui3d-ex,1px) var(--ui3d-ey,1.5px) 0 rgba(8,12,22,.55)) drop-shadow(calc(var(--ui3d-ex,1px)*2) calc(var(--ui3d-ey,1.5px)*2) 0 rgba(8,12,22,.35));'+
    'backface-visibility:hidden;will-change:transform}'+
    /* inner pieces of a tilted panel do not tilt again */
    'body.dm-ui3d .dm-ui3d-p .dm-ui3d-p{rotate:none;filter:none}'+
    'body.dm-ui3d .dm-ui3d-host{perspective:var(--ui3d-persp,900px)}'+
    '.dm-ar-btn{position:absolute;left:118px;top:116px;width:34px;height:24px;padding:0;border:1px solid rgba(160,200,255,.55);border-radius:5px;'+
    'background:rgba(14,22,40,.55);color:rgba(200,220,255,.95);font:700 11px/22px var(--font-mono,monospace);letter-spacing:.06em;cursor:pointer;z-index:4;pointer-events:auto}'+
    '.mini-kite .dm-ar-btn{left:104px;top:79px}'+
    '.dm-ar-btn.on{background:rgba(70,160,255,.85);color:#fff;border-color:#bfe0ff}'+
    '.dm-ar-btn[hidden]{display:none}';
  document.head.appendChild(css);

  function tiltOne(el,vw,vh,persp){
    var r=el.getBoundingClientRect();
    if(!r.width||!r.height) return;
    var nx=((r.left+r.width/2)/vw-0.5)*2, ny=((r.top+r.height/2)/vh-0.5)*2;   // -1..1
    nx=Math.max(-1,Math.min(1,nx)); ny=Math.max(-1,Math.min(1,ny));
    var s=el.style;
    // one axis-angle rotation (the CSS `rotate` property composes with each panel's own
    // `transform`, so existing centring / scale transforms are untouched): lean about an
    // axis perpendicular to the panel's offset from the screen centre
    var ax=ny*0.8, ay=-nx, a=Math.hypot(ax,ay)*MAX_DEG;
    s.setProperty('--ui3d-rot',a<0.3?'0deg':(ax.toFixed(3)+' '+ay.toFixed(3)+' 0 '+a.toFixed(2)+'deg'));
    // perspective comes from a full-screen host (only full-viewport parents, so no layout's
    // fixed-position containing block changes)
    var p=el.parentElement;
    if(p&&p!==document.body){ var pr=p.getBoundingClientRect(); if(pr.width>=vw*0.95&&pr.height>=vh*0.95){ p.classList.add('dm-ui3d-host'); p.style.setProperty('--ui3d-persp',persp+'px'); } }
    // extrusion shows on the side facing away from the centre
    s.setProperty('--ui3d-ex',(nx*1.6).toFixed(2)+'px');
    s.setProperty('--ui3d-ey',(0.6+ny*1.2).toFixed(2)+'px');
  }
  var pend=0;
  function refresh(){
    if(pend) return;
    pend=requestAnimationFrame(function(){
      pend=0;
      document.body.classList.toggle('dm-ui3d',on);
      if(!on) return;
      var vw=window.innerWidth||1, vh=window.innerHeight||1;
      // longer focal length on big screens, shorter on phones / portrait so the lean reads the same
      var persp=Math.round(Math.max(600,Math.min(1600,Math.min(vw,vh)*1.6)));
      document.querySelectorAll(SEL.join(',')).forEach(function(el){
        if(!el.classList.contains('dm-ui3d-p')) el.classList.add('dm-ui3d-p');
        // reset first so the measured rect is the untilted slot
        el.style.removeProperty('--ui3d-rot');
      });
      document.querySelectorAll('.dm-ui3d-p').forEach(function(el){ tiltOne(el,vw,vh,persp); });
    });
  }
  window.addEventListener('resize',refresh,{passive:true});
  window.addEventListener('orientationchange',function(){ setTimeout(refresh,250); },{passive:true});
  // screens switch by class: re-measure when any .screen toggles
  try{ new MutationObserver(function(m){ for(var i=0;i<m.length;i++){ var t=m[i].target; if(t&&t.classList&&(t.classList.contains('screen')||t.id==='loading-screen')){ refresh(); return; } } })
    .observe(document.body,{subtree:true,attributes:true,attributeFilter:['class']}); }catch(e){}
  window.DMUI3D={refresh:refresh,
    enable:function(){ on=true; try{localStorage.setItem('dm.ui3d','1');}catch(e){} refresh(); },
    disable:function(){ on=false; try{localStorage.setItem('dm.ui3d','0');}catch(e){} document.body.classList.remove('dm-ui3d'); }};
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',refresh); else refresh();
})();
