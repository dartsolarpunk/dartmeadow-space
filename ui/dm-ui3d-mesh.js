/* DART Meadow — 3D HUD meshes (crunch 3: every HUD element, curved visor), default on; opt out: localStorage 'dm.ui3d'='css' (tilt) or '0' (flat).
   The CSS tilt (ui/dm-ui3d-core.js) is the runtime fallback when WebGPU or the mesh draw is unavailable; '0' = flat.

   No extra renderer / device: the HUD is drawn as an overlay pass right after the frame by whichever renderer owns
   the screen — the game's flightRenderer / terrain renderer (index.html: DMUI3DMesh.overlay(R)) in space, sky and on
   the ground, and the rock scene's renderer (ui/dm-menuscene.js: overlay(R,'menu')) on the loading screen and menu.

   (v151) Every HUD element is a panel: each visible root (flight HUD, surface / atmo overlays, the landing globe,
   menu, loading screen, mini loader) is walked and every "boxed" element (background, border, glow, clip-path,
   button, svg, text) that is not a full-screen layer becomes one panel. Panels are rasterized from their live
   DOM/SVG (pseudo-elements included) with text leaves made transparent into one atlas; live text is drawn per
   leaf into a text atlas (redrawn only when the value changes, ~15 Hz upload cap). Canvases (minimap, globe,
   compass halo) are live textures on their own quads. Joystick knobs are their own small meshes moved every
   frame from the DOM so they track the thumb.
   Visor: panels sit on a concave cylinder about the camera's Y axis (vertical edges stay straight): the centre is
   flat, panels toward the sides turn inward up to CURVE_DEG and come a little closer, each placed so it projects
   onto its DOM rectangle (taps hit the real DOM, kept at opacity 0). Extrusion is thin (DEPTH), glass keeps the
   CSS alpha (no blur), with a soft edge glow from the back layers and a faint top specular.
   (v206) 3D UI only: a panel's DOM is hidden once its art is in the atlas and STAYS hidden. Nothing here looks at the
   frame rate any more (no perfGuard, no 0.5 s un-ghost timer, no session-off latch); a stall, a relayout or an atlas
   re-pack keeps the last art on screen while the panel repaints. The only DOM HUD is the Profile > Legacy UI switch.
   Painters: foreignObject (data: URL, full CSS) and box2d (canvas 2D incl. linear/radial/conic gradients and the
   ::before/::after boxes) -- same look; box2d is chosen once if the engine taints foreignObject canvases.
   AR (ui/dm-ar-core.js) draws the same `mesh` group on a head-locked plate (drawTo / arHold). */
(function(){
  'use strict';
  if(window.DMUI3DMesh) return;
  var CURVE_DEG=28, PUSH=0.08, PAR=4, LAYERS=1, DEPTH=0.6, FOV=40, ATLAS=2048, TATLAS=2048, PAD=2, PG=6, LAYOUT_MS=1000, WALK_EVERY=3, TATLAS_H=4096, MISS_MAX=24, MAX_PAINTS=3;
  var SUB_SEL='.mini-kite,.hud-c';   // (v160) kites overflow their top bar: each is its own panel, cut out of the bar's raster
  var DYN_SEL='.joystick-knob,[id$="-knob"]', SKIP_SEL='#dm-perf-hud,#account-modal,#profile-modal,.modal,#warp-overlay,#jots-chat,script,style,video,iframe,template';
  var FORM_SEL='input:not([type=checkbox]):not([type=radio]):not([type=range]),select,textarea';
  var SVGP=['fill','stroke','stroke-width','stroke-dasharray','stroke-dashoffset','stroke-linecap','stroke-linejoin','opacity','fill-opacity','stroke-opacity','stop-color','stop-opacity','font-size','font-family','font-weight'];  /* (v206) the foreignObject has no stylesheet: SVG children (gauge rings) need their paint inlined or they fill black */
  var PROPS=['display','position','left','top','right','bottom','width','height','min-width','min-height','max-width','max-height',
    'margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left','box-sizing',
    'border-top','border-right','border-bottom','border-left','border-radius','background-color','background-image','background-size','background-position','background-repeat',
    'color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','text-shadow','white-space','text-overflow','overflow',
    'opacity','box-shadow','clip-path','transform','transform-origin','rotate','scale','translate','flex','flex-direction','flex-wrap','align-items','justify-content','gap','grid-template-columns',
    'z-index','visibility','fill','stroke','stroke-width','stroke-dasharray','stroke-dashoffset','font-variant-numeric','vertical-align','filter','mix-blend-mode','inset','object-fit','mask-image','-webkit-mask-image','mask-size','-webkit-mask-size'];
  var mode=(function(){ try{ return localStorage.getItem('dm.ui3d'); }catch(e){ return null; } })();
  // (v142) mesh HUD is the default everywhere (desktop, web app, AR). Opt out with dm.ui3d='css' (CSS tilt) or '0' (flat).
  // The WebGPU gate + watchdog still fall back to CSS at runtime on devices where it can't draw.
  // (v160) the 3D HUD is the default for everyone; only the player's Legacy UI choice (Profile > Display, kept in the
  // save as settings.legacyUI and mirrored to localStorage dm.ui3d for boot) turns it off. Nothing switches it off automatically.
  function legacy(){ try{ if(typeof STATE!=='undefined'&&STATE&&STATE.settings&&typeof STATE.settings.legacyUI==='boolean') return STATE.settings.legacyUI; }catch(e){} return mode==='css'||mode==='0'; }
  function on(){ return mode!=='0'&&!legacy(); }

  var st=document.createElement('style'); st.textContent=
    'body.dm-ui3d-mesh .dm-ui3d-ghost{opacity:0!important;rotate:none!important;filter:none!important}'+
    // the mesh does the lean: no CSS tilt under it (measured rects stay the untilted DOM slots)
    'body.dm-ui3d-mesh .dm-ui3d-p{rotate:none!important;filter:none!important}';
  document.head.appendChild(st);

  var T=null, root=null, scene=null, cam=null, art=null, txt=null, aCv, aCx, aTex, tCv, tCx, tTex;
  var panels=new Map(), cvs=new Map(), frameN=0, artDirty=false, txtGeoDirty=false, imgCache=new Map(), arHeld=false, ready=false;
  var okR=new WeakMap(), ghosted=false, ptr={x:0,y:0,ex:0,ey:0}, theme='', hudMs=0, hudN=0;
  function $(id){ return document.getElementById(id); }
  function inlineImg(src){ if(imgCache.has(src)) return imgCache.get(src);
    var p=fetch(src).then(function(r){ return r.blob(); }).then(function(b){ return new Promise(function(res){ var fr=new FileReader(); fr.onload=function(){ res(fr.result); }; fr.readAsDataURL(b); }); }).catch(function(){ return src; });
    imgCache.set(src,p); return p; }
  // (v206) SVG -> Image through a data: URL. A blob: URL taints the canvas in Chromium and WebKit alike (the v200 blob switch made every
  // panel fall to the box painter = outline + text only). The v200 memory growth was backdrop-filter (disabled in dm-hud.css), and
  // identical markup maps to the same cached data: image, so unchanged panels do not accumulate.
  function svgImg(str,ms){ var im=new Image();
    return within(new Promise(function(res,rej){ im.onload=function(){ res(im); }; im.onerror=rej; im.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(str); }),ms); }
  function dropImg(im){ if(!im) return; im.onload=im.onerror=null; try{ im.removeAttribute('src'); im.src=''; }catch(e){} }
  function dropCv(c){ if(c){ c.width=c.height=0; } }   // free the backing store now instead of at GC
  function within(p,ms){ return Promise.race([p,new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('timeout')); },ms); })]); }
  function inSub(n,el){ var k=n.closest&&n.closest(SUB_SEL); return !!(k&&k!==el&&el.contains(k)); }
  function isLeaf(el){ if(el instanceof SVGElement) return false; if(el.children.length) return false; var t=el.textContent; return !!(t&&t.trim()); }
  // (v206) text sitting directly inside an element that also has element children ('<i>⏻</i>EXIT', '→ <span>…</span>') is a text RUN: it gets its own
  // text-atlas slot from a Range rect. Before, only childless elements were leaves, so those labels (EXIT, HOME, MAP, CFG ... in the right frame)
  // only existed in the foreignObject raster and vanished with the box painter.
  function hasOwnText(n){ if(n instanceof SVGElement||!n.children.length) return false; for(var c=n.firstChild;c;c=c.nextSibling) if(c.nodeType===3&&c.data.trim()) return true; return false; }
  function runsOf(n,out){ if(!hasOwnText(n)) return; for(var c=n.firstChild;c;c=c.nextSibling){ if(c.nodeType===3&&c.data.trim()){ var rg=document.createRange(); rg.selectNodeContents(c); var r=rg.getBoundingClientRect(); if(r.width>=2&&r.height>=2) out.push({el:n,node:c,r:r,text:null}); } } }
  // a leaf whose ::before/::after carries inline text ('FPS' label) is measured by its own text node, so the live number does not draw over the label
  function pseudoInline(n){ if(n._dmPI===undefined){ n._dmPI=false; ['::before','::after'].forEach(function(pe){ var p=getComputedStyle(n,pe), ct=p.content; if(ct&&/^["'].+["']$/.test(ct)&&p.display!=='none'&&p.position!=='absolute'&&p.position!=='fixed') n._dmPI=true; }); } return n._dmPI; }
  function leafEntry(n){ var lr=visible(n); if(!lr) return null; if(pseudoInline(n)){ for(var c=n.firstChild;c;c=c.nextSibling){ if(c.nodeType===3&&c.data.trim()){ var rg=document.createRange(); rg.selectNodeContents(c); var r=rg.getBoundingClientRect(); if(r.width>=2&&r.height>=2) return {el:n,node:c,r:r,text:null}; } } } return {el:n,r:lr,text:null}; }
  async function raster(el,w,h){
    var c=el.cloneNode(true), os=[el], cs=[c];
    for(var k=0;k<os.length;k++){ var a=os[k].children, b=cs[k].children; for(var i=0;i<a.length&&i<b.length;i++){ os.push(a[i]); cs.push(b[i]); } }
    for(var j=0;j<os.length;j++){ var o=os[j], isSvgIn=(o instanceof SVGElement)&&o.tagName.toLowerCase()!=='svg';
      if(!isSvgIn){ var cst=getComputedStyle(o), s=cs[j].style; for(var q=0;q<PROPS.length;q++){ var v=cst.getPropertyValue(PROPS[q]); if(v) s.setProperty(PROPS[q],v); } softSh(s);
        // pseudo-elements (facet light, glows) become real spans: the foreignObject has no stylesheet
        if(!(o instanceof SVGElement)) ['::before','::after'].forEach(function(pe){ var p=getComputedStyle(o,pe), ct=p.content;
          if(!ct||ct==='none'||ct==='normal'||p.display==='none') return; var sp=document.createElement('span');
          for(var q2=0;q2<PROPS.length;q2++){ var v2=p.getPropertyValue(PROPS[q2]); if(v2) sp.style.setProperty(PROPS[q2],v2); } softSh(sp.style);
          var m=/^["'](.*)["']$/.exec(ct); sp.textContent=m?m[1]:''; if(pe==='::before') cs[j].insertBefore(sp,cs[j].firstChild); else cs[j].appendChild(sp); }); }
      else { var cs3=getComputedStyle(o), s3=cs[j].style; for(var q3=0;q3<SVGP.length;q3++){ var v3=cs3.getPropertyValue(SVGP[q3]); if(v3) s3.setProperty(SVGP[q3],v3); } }
      if(j&&o.matches&&o.matches(DYN_SEL)) cs[j].style.visibility='hidden';
      if(j&&o.matches&&o.matches(SUB_SEL)) cs[j].style.opacity='0';
      if(isLeaf(o)||hasOwnText(o)){ cs[j].style.color='transparent'; cs[j].style.textShadow='none'; } }
    var rs=c.style; rs.position='relative'; rs.left=rs.top=PG+'px'; rs.right=rs.bottom='auto'; rs.margin='0'; rs.transform='none'; rs.rotate='none'; rs.scale='none'; rs.translate='none'; rs.filter='none'; rs.opacity='1'; var lw=el.offsetWidth||w, lh=el.offsetHeight||h, kx=w/lw, ky=h/lh; rs.width=lw+'px'; rs.height=lh+'px'; if(Math.abs(kx-1)>.01||Math.abs(ky-1)>.01){ rs.transformOrigin='0 0'; rs.transform='scale('+kx+','+ky+')'; }   /* (v160) scaled ancestors (compact kite .72): lay out at CSS size, scale to screen size, else the raster crops */ rs.boxSizing='border-box';
    c.classList.remove('dm-ui3d-ghost','dm-ui3d-p');
    // (v204) <img> never goes inside the foreignObject: WebKit fires the outer SVG's onload before a nested image decodes, so on a
    // cold/slow load the logo/kite art rasterized as the broken-image white outline (intermittent). Imgs are drawn by drawImgs().
    c.querySelectorAll('img').forEach(function(n){ var sp=document.createElement('span'); sp.setAttribute('style',n.getAttribute('style')||''); sp.style.display='inline-block'; sp.style.visibility='hidden'; n.replaceWith(sp); });   // a src-less <img> still paints WebKit's grey placeholder frame
    c.querySelectorAll('canvas,script,video,iframe').forEach(function(n){ n.remove(); });
    var W=w+2*PG, H=h+2*PG;
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'"><foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:'+W+'px;height:'+H+'px;overflow:hidden">'+new XMLSerializer().serializeToString(c)+'</div></foreignObject></svg>';
    return svgImg(svg,10000);
  }

  // ---------- discovery: which elements are panels ----------
  function showing(el){ if(!el) return false; if(el.style.display==='none') return false; var cs=getComputedStyle(el); return cs.display!=='none'&&cs.visibility!=='hidden'&&parseFloat(cs.opacity)>0.98; }
  function menuHost(){ var m=$('screen-menu'); if(m&&m.classList.contains('active')) return true; var l=$('loading-screen'); return !!(l&&l.style.display!=='none'&&getComputedStyle(l).display!=='none'); }
  function roots(kind){ var o=[], f;
    if(kind==='menu'){ f=$('screen-menu'); if(f&&f.classList.contains('active')) o.push(f); ['loading-screen','mini-loader'].forEach(function(id){ var e=$(id); if(showing(e)) o.push(e); }); }
    else { f=$('screen-flight'); if(f&&f.classList.contains('active')) o.push(f); ['surface-overlay','atmo-overlay','dm-globe','mini-loader'].forEach(function(id){ var e=$(id); if(showing(e)) o.push(e); }); }
    // (v175) transition menus (story / multiplayer choosers) are 3D too; any overlay with a text field stays DOM (caret, autofill, sign-in)
    // (v197) .jots-ov is a root only (not in SKIP_SEL); skip one already inside another root so it is never painted twice
    document.querySelectorAll('.jots-ov').forEach(function(e){ if(!showing(e)||e.querySelector('input,textarea,select')) return; for(var i=0;i<o.length;i++) if(o[i].contains(e)) return; o.push(e); });
    return o; }
  function alphaOf2(c){ var m=/rgba?\(([^)]*)\)/.exec(c||''); if(!m) return c&&c!=='transparent'?1:0; var a=m[1].split(/[ ,\/]+/).filter(Boolean); return a.length>3?parseFloat(a[3]):1; }
  function boxed(el,cs){ var tn=el.tagName; if(tn==='BUTTON'||tn==='IMG'||tn.toLowerCase()==='svg'||tn==='A') return true;
    if(alphaOf2(cs.backgroundColor)>0.02||cs.backgroundImage!=='none') return true;
    if((parseFloat(cs.borderTopWidth)>0&&alphaOf2(cs.borderTopColor)>0.04)||(parseFloat(cs.borderBottomWidth)>0&&alphaOf2(cs.borderBottomColor)>0.04)||(parseFloat(cs.borderLeftWidth)>0&&alphaOf2(cs.borderLeftColor)>0.04)) return true;
    return cs.boxShadow!=='none'||cs.clipPath!=='none'; }
  function walk(el,out,vw,vh,depth){ for(var c=el.firstElementChild;c;c=c.nextElementSibling){
    if(c.matches(SKIP_SEL)) continue; if(c.classList.contains('jots-ov')&&c.querySelector('input,textarea,select')) continue; var cs=getComputedStyle(c);
    if(cs.display==='none'||cs.visibility==='hidden') continue;
    if(parseFloat(cs.opacity)<0.05&&!c.classList.contains('dm-ui3d-ghost')) continue;
    var r=c.getBoundingClientRect();
    if(c.tagName==='CANVAS'){ if(r.width>=8&&r.height>=8&&r.width*r.height<vw*vh*0.4) out.cv.push(c); continue; }
    if(r.width<1||r.height<1){ if(depth<12) walk(c,out,vw,vh,depth+1); continue; }
    if(r.right<0||r.bottom<0||r.left>vw||r.top>vh) continue;
    var big=r.width*r.height>vw*vh*0.4||r.width>vw*0.97&&r.height>vh*0.5;
    if(!big&&r.width>=6&&r.height>=4&&(c.matches(DYN_SEL)||boxed(c,cs)||isLeaf(c))){ out.w.push(c);
      c.querySelectorAll(DYN_SEL).forEach(function(k){ out.w.push(k); }); c.querySelectorAll(SUB_SEL).forEach(function(k){ out.w.push(k); }); c.querySelectorAll('canvas').forEach(function(k){ out.cv.push(k); }); }
    else if(depth<12) walk(c,out,vw,vh,depth+1); } }
  var found={w:[],cv:[]}, foundKind='';
  function discover(kind){ var o={w:[],cv:[]}, vw=innerWidth, vh=innerHeight; roots(kind).forEach(function(r){ walk(r,o,vw,vh,0); }); found=o; foundKind=kind; }
  // what must look different -> repaint (size, classes, inline styles, theme); position alone only moves the quads
  function paintSig(el,w,h){ var s=w+'x'+h+'|'+theme+'|'+el.className+(el.getAttribute('style')||'')+(el.disabled?'D':''), n=el.getElementsByTagName('*');
    for(var i=0;i<n.length&&i<80;i++){ var e=n[i]; if(e.matches(DYN_SEL)) continue; s+='|'+(e.getAttribute('class')||'')+(e.getAttribute('style')||'')+(e.checked?'C':'')+(e.hidden?'H':''); }
    return s; }
  function faded(el){ var o=1; for(var p=el;p&&p!==document.body;p=p.parentElement){ if(p.classList&&p.classList.contains('dm-ui3d-ghost')) continue; var c=getComputedStyle(p); if(c.visibility==='hidden'||c.display==='none') return true; o*=parseFloat(c.opacity); if(o<0.05) return true; } return false; }
  function visible(el){ var r=el.getBoundingClientRect(); if(r.width<2||r.height<2) return null; var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return null; return r; }

  // ---------- visor placement: concave cylinder about the camera's Y axis ----------
  function camD(){ return (innerHeight/2)/Math.tan(FOV/2*Math.PI/180); }
  function place(r){ var hw=innerWidth/2, cx=r.left+r.width/2-hw, cy=innerHeight/2-(r.top+r.height/2), nx=Math.max(-1,Math.min(1,cx/hw)), a=Math.abs(nx);
    var s=a<0.15?0:Math.min(1,(a-0.15)/0.8), e=s*s*(3-2*s), th=-(nx<0?-1:1)*CURVE_DEG*Math.PI/180*e, f=1-PUSH*e;
    return {cx:cx,cy:cy,th:th,f:f,c:Math.cos(th),s:Math.sin(th),zc:camD()*(1-f)}; }
  function xf(p,lx,ly,lz,out,o){ var x=lx*p.c+lz*p.s, z=-lx*p.s+lz*p.c; out[o]=(p.cx+x)*p.f; out[o+1]=(p.cy+ly)*p.f; out[o+2]=p.zc+z*p.f; }
  // (v207) wide, short panels (the surface/atmosphere top bar, the top media row, the CAM/HOME/../PROFILE row, their underline trims,
  // the throttle track) are one continuous ribbon on the SAME visor curve as the side tabs instead of one flat plate: it is cut into
  // vertical strips that share their edge vertices, and every vertex sits at the depth the tab curve gives its screen x (curveZ: the
  // integral of sin(tilt) from the centre, i.e. the ends come toward the camera). x stays on its DOM x (taps still hit the controls);
  // toward the ends the row grows taller about its own centre line (nearer = larger), so it reads as wrapped, like the tabs.
  var STRIP_PX=24, STRIP_MIN=96, STRIP_MAX=40, STRIP_RATIO=8;
  function nStrips(P){ var r=P.rect; if(!r||P.dyn||r.width<=Math.max(STRIP_MIN,innerWidth*0.1)||r.width<r.height*STRIP_RATIO) return 1; return Math.min(STRIP_MAX,Math.ceil(r.width/STRIP_PX)); }
  function curveZ(sx){ var hw=innerWidth/2, a=Math.min(Math.abs(sx),hw*1.2), n=Math.max(1,Math.ceil(a/16)), dx=a/n, z=0;
    for(var i=0;i<n;i++){ var x=(i+0.5)*dx, t=Math.min(1,x/hw), s=t<0.15?0:Math.min(1,(t-0.15)/0.8), e=s*s*(3-2*s); z+=Math.sin(CURVE_DEG*Math.PI/180*e)*dx; }
    return z; }
  // screen offset (sx right of centre, sy up from centre; yc = the row's own centre line) + layer depth -> mesh position
  function ribV(sx,sy,yc,lz,out,o){ var z=curveZ(sx), k=camD()/(camD()-z); out[o]=sx/k; out[o+1]=yc/k+(sy-yc); out[o+2]=z+lz; }
  var sx=0, sy=0, sh=0; function alloc(w,h,size,maxH){ if(sx+w>size){ sx=0; sy+=sh+PAD; sh=0; } if(sy+h>(maxH||size)) return null; var a={x:sx,y:sy,w:w,h:h}; sx+=w+PAD; sh=Math.max(sh,h); return a; }
  function pos4(r){ return [r.left,r.top,r.width,r.height].map(function(v){ return Math.round(v*2); }).join(','); }

  // (v204) never raster mid-transition: raster() copies each descendant's *computed* opacity/colour, so a panel painted while a
  // fade/slide runs (hover, class swap, panel open) bakes the dim in-between frame into the atlas, and paintSig (class/style only)
  // does not change when the transition ends -> frames/tabs/kite stayed ghost-dim with only the text leaves visible. Wait it out (<=~2 s), then paint.
  var SETTLE_MS=120, SETTLE_MAX=40;
  function settling(P){ if(!P.el.getAnimations||(P.settleN||0)>=SETTLE_MAX) return false;
    var run=false; try{ run=P.el.getAnimations({subtree:true}).some(function(a){ if(a.playState!=='running') return false; var t=a.effect&&a.effect.getTiming&&a.effect.getTiming(); return !(t&&t.iterations===Infinity); }); }catch(e){}
    if(run) P.settleN=(P.settleN||0)+1; return run; }
  function layout(kind){
    var dn=performance.now(); if(foundKind!==kind||dn-discT>=LAYOUT_MS*WALK_EVERY||discDirty){ discT=dn; discDirty=false; discover(kind); watch(); }
    panels.forEach(function(P){ P.leaves.forEach(function(L){ if(L.cs){ L.cs=null; L.text=null; } }); });   // (v156) leaf styles re-read once per layout
    theme=getComputedStyle(document.documentElement).getPropertyValue('--acc-rgb')+getComputedStyle(document.documentElement).getPropertyValue('--hi-rgb');
    var seen=new Set(), relay=false, now=performance.now(), pend=false, fresh=[];
    found.w.forEach(function(el){
      if(seen.has(el)||!el.isConnected) return; var r=visible(el); if(!r||faded(el)) return;   // (v160) a faded/hidden ancestor (space kite while the atmo/terrain kite shows) drops the panel: no double kite
      if(el.matches(FORM_SEL)||el.querySelector(FORM_SEL)) return;          // typed fields stay real DOM
      if(el.getAnimations&&el.getAnimations().some(function(a){ return a.playState==='running'&&a.effect&&a.effect.getTiming&&a.effect.getTiming().iterations!==Infinity; })){ if(panels.has(el)) seen.add(el); return; }   /* (v160) a mid-transition panel keeps its slot (dropping it re-packed the whole atlas) */   // mid-transition: leave it to CSS
      seen.add(el);
      var P=panels.get(el), w=Math.ceil(r.width), h=Math.ceil(r.height); if(P){ P.miss_n=0; if(P.miss){ P.miss=0; artDirty=true; txtGeoDirty=true; if(P.mesh) P.mesh.visible=P.ready; } }
      if(!P){ P={el:el,sig:'',ready:false,busy:false,leaves:[],dyn:el.matches(DYN_SEL),lp:0,mesh:null,miss:0,miss_n:0}; panels.set(el,P); }
      if(P.w!==w||P.h!==h){ P.w=w; P.h=h; artDirty=true; if(!P.cw){ P.cw=w+24; P.ch=h+4; fresh.push(P); } else if(w>P.cw||h>P.ch||w<P.cw-96){ P.cw=w+24; P.ch=h+4; relay=true; } }   /* (v160) slot slack: a readout growing a few px repaints in place instead of re-packing (and un-readying) every panel */
      var ps=pos4(r); if(ps!==P.ps){ P.ps=ps; P.rect=r; if(P.dyn) P.moved=true; else artDirty=true; txtGeoDirty=true; }
      var sg=paintSig(el,w,h); if(P.force&&now-P.lp<160) pend=true; else if(sg!==P.sig&&(now-P.lp>1000||!P.sig||P.force)){   /* (v160) forced repaints coalesce to <=10/s per panel */ P.sig=sg; P.ready=P.ready&&!!P.slot; P.want=true; P.force=false; }
      var Ls=[]; if(!P.dyn){ if(isLeaf(el)){ var le0=leafEntry(el); if(le0) Ls.push(le0); }
        else { if(hasOwnText(el)) runsOf(el,Ls); el.querySelectorAll('*').forEach(function(n){ if(n.closest(DYN_SEL)||inSub(n,el)) return; if(!isLeaf(n)){ if(hasOwnText(n)){ var rs0=[]; runsOf(n,rs0); rs0.forEach(function(L){ if(visible(n)) Ls.push(L); }); } return; } var le=leafEntry(n); if(le) Ls.push(le); }); } }
      if(Ls.length!==P.leaves.length||Ls.some(function(L,i){ var o=P.leaves[i]; return o.el!==L.el||o.node!==L.node||Math.round(o.r.left)!==Math.round(L.r.left)||Math.round(o.r.top)!==Math.round(L.r.top)||Math.round(o.r.width)!==Math.round(L.r.width); })){ P.leaves=Ls; txtGeoDirty=true; }
    });
    if(pend) layoutDirty=true;
    // (v206) a panel that is momentarily not 'seen' (mid-fade, a 0-size frame, a relayout) keeps its slot, art and ghosted DOM for MISS_MAX layouts:
    // it only stops drawing. Dropping it at once un-ghosted the DOM (the pop-in/out) and re-packed the atlas when it came back.
    panels.forEach(function(P,el){ if(seen.has(el)) return; if(el.isConnected&&++P.miss_n<MISS_MAX&&(P.miss=(P.miss||0)+1)){ if(P.miss===1){ artDirty=true; txtGeoDirty=true; if(P.mesh) P.mesh.visible=false; } return; }
      el.classList.remove('dm-ui3d-ghost'); if(P.mesh){ root.remove(P.mesh); P.mesh.geometry.dispose(); } panels.delete(el); artDirty=true; txtGeoDirty=true; });
    if(!relay&&fresh.length){ var AH0=aCv.height; fresh.forEach(function(P){ if(!relay){ P.slot=alloc(P.cw+2*PG,P.ch+2*PG,ATLAS); if(!P.slot||sy+sh>AH0) relay=true; else { P.ready=false; P.want=true; artDirty=true; } } }); }   // (v160) new panels go into free atlas space; only a full atlas re-packs
    if(relay){ var snap=null; try{ snap=scratch(aCv.width,aCv.height); snap.getContext('2d').drawImage(aCv,0,0); }catch(e){ snap=null; }   // (v206) re-pack keeps the old art: panels stay ready (no blank frame, no un-ghost) while they repaint
      sx=sy=sh=0; var list=[], olds=new Map(); panels.forEach(function(P){ list.push(P); olds.set(P,P.slot); }); list.sort(function(a,b){ return b.ch-a.ch; });
      list.forEach(function(P){ P.slot=alloc(P.cw+2*PG,P.ch+2*PG,ATLAS); });
      // the art atlas is only as tall as its slots (pow2): each finished panel raster re-uploads the whole texture
      var AH=64; while(AH<sy+sh&&AH<ATLAS) AH*=2; if(aCv.height!==AH){ aCv.height=AH; aTex.dispose(); aTex=tx(aCv); art.material.map=aTex; art.material.needsUpdate=true; panels.forEach(function(P){ if(P.mesh) P.mesh.material=art.material; }); } else aCx.clearRect(0,0,ATLAS,AH);
      panels.forEach(function(P){ var o=olds.get(P); if(snap&&o&&P.slot&&P.ready){ aCx.drawImage(snap,o.x,o.y,Math.min(o.w,P.slot.w),Math.min(o.h,P.slot.h),P.slot.x,P.slot.y,Math.min(o.w,P.slot.w),Math.min(o.h,P.slot.h)); } else P.ready=false; P.want=true; }); dropCv(snap); artDirty=true; }
    var nBusy=0; panels.forEach(function(P){ if(P.busy) nBusy++; });   // (v206) at most MAX_PAINTS rasters in flight: a 20-panel HUD no longer rasters everything in one frame (a stutter on load / theme change)
    panels.forEach(function(P){ if(P.want&&!P.busy&&P.slot&&now>=(P.nb||0)){ if(nBusy>=MAX_PAINTS){ pend=true; return; } if(settling(P)){ P.nb=now+SETTLE_MS; setTimeout(function(){ layoutDirty=true; },SETTLE_MS+20); return; } P.want=false; P.lp=now; P.settleN=0; nBusy++; paint(P); } });
    if(pend) layoutDirty=true;   // (v204) a failing panel waits out its backoff (P.nb) instead of re-rastering every frame
    // live canvases (minimap, globe, compass halo)
    var cseen=new Set();
    found.cv.forEach(function(c){ if(cseen.has(c)||!c.isConnected) return; var r=visible(c); if(!r||!c.width||!c.height||faded(c)) return; cseen.add(c);
      var C=cvs.get(c); if(!C){ var t=tx(c); t.generateMipmaps=false; var m=new T.Mesh(quadGeo(),mat(t)); m.renderOrder=1.5; m.frustumCulled=false; root.add(m); C={el:c,mesh:m,tex:t}; cvs.set(c,C); }
      if(C.tex.image!==c){ C.tex.image=c; C.tex.needsUpdate=true; }
      C.rect=r; C.p=place(r); });
    cvs.forEach(function(C,c){ if(!cseen.has(c)){ c.classList.remove('dm-ui3d-ghost'); root.remove(C.mesh); C.mesh.geometry.dispose(); C.mesh.material.dispose(); C.tex.dispose(); cvs.delete(c); } });
  }
  function quadGeo(){ var g=new T.BufferGeometry(); g.setAttribute('position',new T.BufferAttribute(new Float32Array([-.5,-.5,0,.5,-.5,0,.5,.5,0,-.5,.5,0]),3)); g.setAttribute('uv',new T.BufferAttribute(new Float32Array([0,0,1,0,1,1,0,1]),2)); g.setIndex([0,1,2,0,2,3]); return g; }
  function setXf(m,p,w,h){ m.position.set(p.cx*p.f,p.cy*p.f,p.zc); m.rotation.set(0,p.th,0); m.scale.set(w*p.f,h*p.f,p.f); }
  // (v148) WebKit taints any canvas that draws an SVG <foreignObject> image; a tainted atlas makes the texture
  // upload throw (SecurityError) and the watchdog dropped iPhone/iPad to the CSS tilt. Every raster now goes to a
  // scratch canvas first and is probed with getImageData; on taint we switch (once) to SAFE: a canvas-2D box
  // painter (backgrounds, borders, radius, glow, clip-path polygons) + inline <svg> drawn as plain SVG images
  // (no foreignObject = no taint). The shared atlas itself is never tainted.
  var foFails=0, SAFE=/[?&]ui3dsafe=1\b/.test(location.search), painter=SAFE?'box2d':'foreignObject';   // ?ui3dsafe=1: test the WebKit painter in Chromium; ?ui3dgl=1: allow the WebGL2 backend (headless checks)
  function scratch(w,h){ var c=document.createElement('canvas'); c.width=Math.max(1,w); c.height=Math.max(1,h); return c; }
  function clean(c){ try{ c.getContext('2d').getImageData(0,0,1,1); return true; }catch(e){ return false; } }
  function alphaOf(c){ var m=/rgba?\(([^)]*)\)/.exec(c||''); if(!m) return c&&c!=='transparent'?1:0; var a=m[1].split(/[ ,\/]+/).filter(Boolean); return a.length>3?parseFloat(a[3]):1; }
  function polyPath(cx,cp,x,y,w,h){ var m=/^polygon\((.*)\)$/.exec(cp||''); if(!m) return false; var pts=m[1].split(',');
    pts.forEach(function(pt,i){ var v=pt.trim().split(/\s+/), f=function(t,L){ return /%$/.test(t)?parseFloat(t)/100*L:parseFloat(t)||0; }; var px=x+f(v[0],w), py=y+f(v[1],h); if(i) cx.lineTo(px,py); else cx.moveTo(px,py); });
    cx.closePath(); return true; }
  // (v206) box2d fills: real CSS gradients (linear / radial / conic, stacked layers) so the theme colour pills and glass fills paint exactly
  // as they do in the DOM. The old painter took the first rgba stop and, for a panel root with no fill, a dark 'GLASS' rect -- that was the
  // black bar across the top (the transparent top-bar wrapper) and the outline-only look. A box with no background now paints nothing.
  function splitTop(str){ var o=[], d=0, b=0; for(var i=0;i<str.length;i++){ var ch=str.charAt(i); if(ch==='(') d++; else if(ch===')') d--; else if(ch===','&&!d){ o.push(str.slice(b,i).trim()); b=i+1; } } o.push(str.slice(b).trim()); return o; }
  function stopsOf(parts,len,isAng){ var st=[], n=parts.length;
    parts.forEach(function(t){ var m=/^(rgba?\([^)]*\)|color\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)\s*(.*)$/i.exec(t); if(!m) return; var pos=null, rest=m[2].trim();
      if(rest){ var pm=/^(-?[\d.]+)(%|px|deg|turn)?/.exec(rest); if(pm){ var v=parseFloat(pm[1]), u=pm[2]; pos=u==='%'?v/100:u==='px'?v/len:u==='deg'?v/360:u==='turn'?v:null; } }
      st.push({c:m[1],p:pos}); });
    if(!st.length) return st; if(st[0].p==null) st[0].p=0; if(st[st.length-1].p==null) st[st.length-1].p=1;
    var last=0; for(var i=1;i<st.length;i++){ if(st[i].p!=null){ var j=i, a0=st[last].p, gap=i-last; for(var k=last+1;k<i;k++) st[k].p=a0+(st[i].p-a0)*(k-last)/gap; last=i; } }
    var mx=-1e9; st.forEach(function(q){ q.p=Math.max(mx,q.p); mx=q.p; });
    // canvas gradients interpolate un-premultiplied (CSS: premultiplied): a transparent-black stop would grey the ramp, so it borrows its neighbour's rgb at alpha 0
    var rgbOf=function(c){ var m=/rgba?\(([^)]*)\)/.exec(c); if(!m) return null; var a=m[1].split(/[ ,\/]+/).filter(Boolean); return {r:a[0],g:a[1],b:a[2],a:a.length>3?parseFloat(a[3]):1}; };
    st.forEach(function(q,i){ var c=rgbOf(q.c); if(q.c==='transparent'||(c&&c.a===0)){ var nb=null, k; for(k=i-1;k>=0&&!nb;k--){ var t=rgbOf(st[k].c); if(t&&t.a>0) nb=t; } for(k=i+1;k<st.length&&!nb;k++){ var t2=rgbOf(st[k].c); if(t2&&t2.a>0) nb=t2; } if(nb) q.c='rgba('+nb.r+','+nb.g+','+nb.b+',0)'; } });
    return st; }
  function addStops(g,st){ st.forEach(function(q){ try{ g.addColorStop(Math.max(0,Math.min(1,q.p)),q.c); }catch(e){} }); }
  function posOf(tok,L,half){ if(tok==null) return half; var k={left:0,top:0,center:L/2,right:L,bottom:L}[tok]; if(k!==undefined) return k; if(/%$/.test(tok)) return parseFloat(tok)/100*L; return parseFloat(tok)||0; }
  function fillGrad(cx,fn,args,x,y,w,h){   // fills the current path (already clipped) with one gradient layer
    var parts=splitTop(args), head=parts[0], hasHead=!/^(rgba?\(|color\(|hsla?\(|#|[a-z]+\s*[\d.%]*\s*$)/i.test(head)||/^(to |from |at |circle|ellipse|closest|farthest|-?[\d.]+(deg|turn|rad)|in )/i.test(head);
    var body=hasHead?parts.slice(1):parts, g=null, st;
    if(fn==='linear-gradient'||fn==='repeating-linear-gradient'){ var th=Math.PI; if(hasHead){ var hm=/(-?[\d.]+)(deg|turn|rad)/.exec(head); if(hm){ var v=parseFloat(hm[1]); th=hm[2]==='deg'?v*Math.PI/180:hm[2]==='turn'?v*2*Math.PI:v; }
        else { var tm=/to\s+(top|bottom|left|right)(?:\s+(top|bottom|left|right))?/.exec(head); if(tm){ var d1=tm[1], d2=tm[2]||'', dd=Math.atan2(h,w);
          if(!d2) th={top:0,right:Math.PI/2,bottom:Math.PI,left:3*Math.PI/2}[d1];
          else { var hz=/left|right/.test(d1)?d1:d2, vt=/top|bottom/.test(d1)?d1:d2; th=vt==='top'?(hz==='right'?dd:-dd):(hz==='right'?Math.PI-dd:Math.PI+dd); } } } }
      var L=Math.abs(w*Math.sin(th))+Math.abs(h*Math.cos(th)), dx=Math.sin(th), dy=-Math.cos(th), mx=x+w/2, my=y+h/2;
      g=cx.createLinearGradient(mx-dx*L/2,my-dy*L/2,mx+dx*L/2,my+dy*L/2); st=stopsOf(body,L); }
    else if(fn==='radial-gradient'||fn==='repeating-radial-gradient'){ var at=/\bat\s+(\S+)(?:\s+(\S+))?/.exec(hasHead?head:''), ox=x+posOf(at&&at[1],w,w/2), oy=y+posOf(at&&(at[2]||(/^(top|bottom)$/.test(at[1])?'center':'center')),h,h/2);
      if(at&&at[1]&&/^(top|bottom)$/.test(at[1])&&!at[2]){ ox=x+w/2; oy=y+posOf(at[1],h,h/2); }
      var circ=/circle/.test(head)||(hasHead&&!/ellipse/.test(head)&&/^[\d.]+px(\s+at|$)/.test(head)), ddx=Math.max(Math.abs(ox-x),Math.abs(ox-x-w)), ddy=Math.max(Math.abs(oy-y),Math.abs(oy-y-h)), cdx=Math.min(Math.abs(ox-x),Math.abs(ox-x-w)), cdy=Math.min(Math.abs(oy-y),Math.abs(oy-y-h)), rx,ry;
      var exp=/^[^a]*?([\d.]+)px(?:\s+([\d.]+)px)?/.exec(hasHead?head.replace(/\bat\b.*$/,''):'');
      if(exp){ rx=parseFloat(exp[1]); ry=exp[2]?parseFloat(exp[2]):rx; }
      else if(/closest-side/.test(head)){ rx=circ?Math.min(cdx,cdy):cdx; ry=circ?rx:cdy; }
      else if(/farthest-side/.test(head)){ rx=circ?Math.max(ddx,ddy):ddx; ry=circ?rx:ddy; }
      else if(/closest-corner/.test(head)){ rx=circ?Math.hypot(cdx,cdy):cdx*Math.SQRT2; ry=circ?rx:cdy*Math.SQRT2; }
      else { rx=circ?Math.hypot(ddx,ddy):ddx*Math.SQRT2; ry=circ?rx:ddy*Math.SQRT2; }
      rx=Math.max(1,rx); ry=Math.max(1,ry); st=stopsOf(body,rx);
      cx.save(); cx.translate(ox,oy); cx.scale(1,ry/rx); g=cx.createRadialGradient(0,0,0,0,0,rx); addStops(g,st); cx.fillStyle=g; cx.fillRect(-(w+h)*2/1,-(w+h)*2/(ry/rx),(w+h)*4,(w+h)*4/(ry/rx)); cx.restore(); return; }
    else if(fn==='conic-gradient'){ var fm=/from\s+(-?[\d.]+)(deg|turn|rad)/.exec(hasHead?head:''), fa=fm?(fm[2]==='deg'?parseFloat(fm[1])*Math.PI/180:fm[2]==='turn'?parseFloat(fm[1])*2*Math.PI:parseFloat(fm[1])):0, ca=/\bat\s+(\S+)(?:\s+(\S+))?/.exec(hasHead?head:''), px=x+posOf(ca&&ca[1],w,w/2), py=y+posOf(ca&&ca[2],h,h/2);
      st=stopsOf(body,360,true); if(cx.createConicGradient){ g=cx.createConicGradient(fa-Math.PI/2,px,py); } else { cx.fillStyle=(st[0]&&st[0].c)||'transparent'; cx.fill(); return; } }
    if(!g) return; addStops(g,st); cx.fillStyle=g; cx.fill(); }
  function bgLayers(cx,cs,x,y,w,h){ var bi=cs.backgroundImage; if(!bi||bi==='none') return;
    var ls=splitTop(bi); for(var i=ls.length-1;i>=0;i--){ var m=/^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s.exec(ls[i]); if(m) try{ fillGrad(cx,(m[1]||'')+m[2]+'-gradient',m[3],x,y,w,h); }catch(e){ console.warn('[UI3D] gradient',e&&e.message); } } }
  // one CSS box (an element or a ::before/::after) onto the canvas: shadow, fill colour, gradient layers, border, radius / polygon clip
  function paintBox(cx,cs,x,y,w,h,root){
    var bg=cs.backgroundColor, bw=parseFloat(cs.borderTopWidth)||0, bc=cs.borderTopColor, bwR=parseFloat(cs.borderRightWidth)||0, bwB=parseFloat(cs.borderBottomWidth)||0, bwL=parseFloat(cs.borderLeftWidth)||0,
      uni=(bw===bwR&&bw===bwB&&bw===bwL&&bc===cs.borderBottomColor&&bc===cs.borderLeftColor&&bc===cs.borderRightColor), sideB=!uni&&(bw>0||bwR>0||bwB>0||bwL>0);   // (v206) one-sided borders (underline pills, rules) are drawn as strips
    if(sideB){ bw=0; } rad=Math.min(parseFloat(cs.borderTopLeftRadius)||0,w/2,h/2), hasG=cs.backgroundImage&&cs.backgroundImage!=='none'&&/gradient\(/.test(cs.backgroundImage);
    if(alphaOf(bg)<=0&&!hasG&&!sideB&&(bw<=0||alphaOf(bc)<=0)&&(!cs.boxShadow||cs.boxShadow==='none')) return;
    cx.save(); cx.globalAlpha=Math.min(1,parseFloat(cs.opacity)||1); cx.beginPath();
    if(!polyPath(cx,cs.clipPath,x,y,w,h)){ if(cx.roundRect) cx.roundRect(x+bw/2,y+bw/2,w-bw,h-bw,rad); else cx.rect(x+bw/2,y+bw/2,w-bw,h-bw); }
    var g=/(rgba?\([^)]*\)|#[0-9a-f]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/i.exec(cs.boxShadow||''); if(g&&!/inset/.test(cs.boxShadow)&&(alphaOf(bg)>0||hasG||bw>0)){ cx.shadowColor=soft(g[1]).replace(/,([\d.]+)\)$/,function(m,a){ return ','+(parseFloat(a)*0.7).toFixed(3)+')'; }); cx.shadowOffsetX=+g[2]; cx.shadowOffsetY=+g[3]; cx.shadowBlur=+g[4]; }
    if(alphaOf(bg)>0){ cx.fillStyle=bg; cx.fill(); }
    cx.shadowColor='transparent';
    if(hasG){ cx.save(); cx.clip(); bgLayers(cx,cs,x,y,w,h); cx.restore(); }   // gradients are clipped to the box (radius / polygon)
    if(bw>0&&alphaOf(bc)>0){ cx.lineWidth=bw; cx.strokeStyle=bc; cx.stroke(); }
    if(sideB){ var sd=[[cs.borderTopColor,bw0(cs.borderTopWidth),x,y,w,bw0(cs.borderTopWidth)],[cs.borderBottomColor,bwB,x,y+h-bwB,w,bwB],[cs.borderLeftColor,bwL,x,y,bwL,h],[cs.borderRightColor,bwR,x+w-bwR,y,bwR,h]];
      sd.forEach(function(d){ if(d[1]>0&&alphaOf(d[0])>0){ cx.fillStyle=d[0]; cx.fillRect(d[2],d[3],d[4],d[5]); } }); }
    cx.restore(); }
  function bw0(v){ return parseFloat(v)||0; }
  // (v206) static text that lives in a ::before/::after (the kite's 'FPS' label) has no DOM node for the text atlas: draw it with the box painter, on the element's content edge
  function pseudoText(cx,el,cs,r,x,y){ ['::before','::after'].forEach(function(pe){ var p=getComputedStyle(el,pe), ct=p.content; if(!ct||p.display==='none'||p.position==='absolute'||p.position==='fixed') return;
      var m=/^["'](.+)["']$/.exec(ct); if(!m) return; var t=m[1]; if(p.textTransform==='uppercase') t=t.toUpperCase();
      cx.save(); cx.font=(p.fontStyle||'normal')+' '+(p.fontWeight||400)+' '+p.fontSize+' '+p.fontFamily; try{ cx.letterSpacing=p.letterSpacing==='normal'?'0px':p.letterSpacing; }catch(e){}
      cx.fillStyle=p.color; cx.textBaseline='middle'; var pl=(parseFloat(cs.paddingLeft)||0)+(parseFloat(cs.borderLeftWidth)||0), pr=(parseFloat(cs.paddingRight)||0)+(parseFloat(cs.borderRightWidth)||0), ty=y+r.height/2;
      if(pe==='::before'){ cx.textAlign='left'; cx.fillText(t,x+pl,ty); } else { cx.textAlign='right'; cx.fillText(t,x+r.width-pr,ty); } cx.restore(); }); }
  function pseudoBoxes(cx,el,cs,r,x,y,under){ ['::before','::after'].forEach(function(pe){ var p=getComputedStyle(el,pe), ct=p.content; if(!ct||ct==='none'||ct==='normal'||p.display==='none') return; if((parseInt(p.zIndex,10)<0)!==under) return;   // z-index<0 pseudos sit behind the element's own fill
    if(p.position!=='absolute'&&p.position!=='fixed') return; var w=parseFloat(p.width), h=parseFloat(p.height); if(!(w>0)||!(h>0)) return;
    var bl=parseFloat(cs.borderLeftWidth)||0, bt=parseFloat(cs.borderTopWidth)||0, left=parseFloat(p.left), top=parseFloat(p.top);
    if(isNaN(left)) left=r.width-bl-w-(parseFloat(p.right)||0); if(isNaN(top)) top=r.height-bt-h-(parseFloat(p.bottom)||0);
    paintBox(cx,p,x+bl+left,y+bt+top,w,h); }); }
  async function paintSafe(P){
    var c=scratch(P.w+2*PG,P.h+2*PG), cx=c.getContext('2d'), base=P.el.getBoundingClientRect(), els=[P.el].concat([].slice.call(P.el.querySelectorAll('*')));
    for(var i=0;i<els.length;i++){ var el=els[i];
      if(el instanceof SVGElement&&el.tagName.toLowerCase()!=='svg') continue; if(i&&el.closest&&(el.closest(DYN_SEL)||inSub(el,P.el))) continue;
      var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity)===0) continue;
      var r=el.getBoundingClientRect(); if(r.width<1||r.height<1) continue; var x=r.left-base.left+PG, y=r.top-base.top+PG;
      if(el.tagName.toLowerCase()==='svg'){ var cl=el.cloneNode(true), so=[el].concat([].slice.call(el.querySelectorAll('*'))), sc=[cl].concat([].slice.call(cl.querySelectorAll('*')));
        for(var k=0;k<so.length;k++){ var s2=getComputedStyle(so[k]); ['fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','stroke-dasharray','stroke-linecap','stroke-linejoin','stop-color','stop-opacity','font-size','font-family','font-weight'].forEach(function(pn){ var v=s2.getPropertyValue(pn); if(v) sc[k].style.setProperty(pn,v); }); }
        ['position','left','top','right','bottom','inset','transform','rotate','translate','scale','margin'].forEach(function(pn){ cl.style.removeProperty(pn); }); cl.setAttribute('width',r.width); cl.setAttribute('height',r.height); cl.setAttribute('xmlns','http://www.w3.org/2000/svg');
        var im=null; try{ im=await svgImg(new XMLSerializer().serializeToString(cl),4000); cx.drawImage(im,x,y,r.width,r.height); }catch(e){ console.warn('[UI3D] svg paint',e&&(e.message||e.type)); } dropImg(im);
        continue; }
      // (v198) box2d painter drew boxes only, so the menu/loader logo <img> (static/dartmeadow-logo.svg) came out as an empty frame
      if(el.tagName==='IMG'){ if(!(el.complete&&el.naturalWidth)){ if(imgGaveUp(P,el)) continue; throw new Error('img not ready'); } if(el.complete&&el.naturalWidth){ try{ cx.save(); cx.globalAlpha=Math.min(1,parseFloat(cs.opacity)||1); cx.drawImage(el,x,y,r.width,r.height); cx.restore(); }catch(e){ console.warn('[UI3D] img paint',e&&e.message); } } continue; }
      pseudoBoxes(cx,el,cs,r,x,y,true); paintBox(cx,cs,x,y,r.width,r.height,i===0); pseudoBoxes(cx,el,cs,r,x,y,false); pseudoText(cx,el,cs,r,x,y); }
    if(!clean(c)) throw new Error('2D box painter canvas tainted');
    return c; }
  var IMG_TRIES=4;   // (v204) 'img not ready' retries per panel (~4 s with the backoff) before the panel paints without that image
  function imgGaveUp(P,el){ if(el&&el._dmGU) return true; if((P.imgFails||0)<IMG_TRIES) return false;
    if(el){ el._dmGU=1; el.addEventListener('load',function(){ el._dmGU=0; P.imgFails=0; P.force=true; P.sig=''; layoutDirty=true; },{once:true}); }   // a late image repaints the panel once it arrives
    return true; }
  async function drawImgs(P,cx){ var base=P.el.getBoundingClientRect(), ims=P.el.tagName==='IMG'?[P.el]:P.el.querySelectorAll('img');
    for(var i=0;i<ims.length;i++){ var el=ims[i]; if(el!==P.el&&el.closest(DYN_SEL)) continue; var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity)===0) continue;
      if(!(el.complete&&el.naturalWidth)){ if(imgGaveUp(P,el)) continue; try{ await within(el.decode?el.decode():Promise.reject(new Error('no decode')),1500); }catch(e){ throw new Error('img not ready'); } if(!(el.naturalWidth)){ if(imgGaveUp(P,el)) continue; throw new Error('img not ready'); } }   // retried a few times (backoff), then painted without the image: a 404/offline/undecodable img never blocks the panel
      var r=el.getBoundingClientRect(); cx.save(); cx.globalAlpha=Math.min(1,parseFloat(cs.opacity)||1); cx.drawImage(el,r.left-base.left+PG,r.top-base.top+PG,r.width,r.height); cx.restore(); } }
  async function paintSrc(P){
    if(P.el.tagName==='IMG'){ var ci=scratch(P.w+2*PG,P.h+2*PG); try{ await drawImgs(P,ci.getContext('2d')); if(clean(ci)) return ci; }catch(e){ dropCv(ci); throw e; } dropCv(ci); }   // (v204) a bare <img> panel (menu/loader logo, kite art) is drawn directly
    if(!SAFE){ var img=null, c=null; try{ img=await raster(P.el,P.w,P.h); c=scratch(P.w+2*PG,P.h+2*PG); var c2=c.getContext('2d'); c2.drawImage(img,0,0,P.w+2*PG,P.h+2*PG); dropImg(img); img=null; await drawImgs(P,c2); if(clean(c)){ foFails=0; return c; } dropCv(c); c=null;
        console.warn('[UI3D] foreignObject raster taints the canvas here (WebKit); switching to the 2D box painter'); }
      catch(e){ dropImg(img); dropCv(c); if(e&&e.message==='img not ready') throw e; if(++foFails<6){ console.warn('[UI3D] foreignObject raster failed ('+(e&&e.message)+'); retrying'); throw e; }   // (v204) a timeout while the scene loads is transient: retry, never latch box2d for the session
        console.warn('[UI3D] foreignObject raster failed '+foFails+'x; switching to the 2D box painter'); }
      SAFE=true; painter='box2d'; }
    return paintSafe(P); }
  function paint(P){ P.busy=true; var gen=P.slot;
    paints++; paintSrc(P).then(function(src){ if(P.slot!==gen||!P.slot){ dropCv(src); return; } aCx.clearRect(P.slot.x,P.slot.y,(P.cw||P.w)+2*PG,(P.ch||P.h)+2*PG); aCx.drawImage(src,P.slot.x,P.slot.y,P.w+2*PG,P.h+2*PG); dropCv(src); P.ready=true; P.failed=0; P.imgFails=0; artDirty=true; if(P.dyn) P.built=false; })
      .catch(function(e){ var n=performance.now(); P.failed=(P.failed||0)+1; if(e&&e.message==='img not ready') P.imgFails=(P.imgFails||0)+1; P.want=true; var d=Math.min(4000,300*Math.pow(2,Math.min(P.failed,5)-1)); P.nb=n+d; setTimeout(function(){ layoutDirty=true; },d+20); console.warn('[UI3D] raster',e&&e.message,'(retry in '+d+' ms, #'+P.failed+')'); }).finally(function(){ P.busy=false; layoutDirty=true; }); }

  // ---------- static art geometry: ONE merged buffer (knobs: one small mesh each) ----------
  var ID={cx:0,cy:0,th:0,f:1,c:1,s:0,zc:0};
  function quads(P,p,pos,uv,col,q){ var w=P.w/2+PG, h=P.h/2+PG, ox=P.rect?(P.rect.width-P.w)/2:0, AH=aCv.height, N=nStrips(P);
    var u0=P.slot.x/ATLAS, u1=(P.slot.x+P.w+2*PG)/ATLAS, v0=1-(P.slot.y+P.h+2*PG)/AH, v1=1-P.slot.y/AH, cs=[[-w,-h],[w,-h],[w,h],[-w,h]];
    for(var L=LAYERS;L>=0;L--){ var z=LAYERS?-DEPTH*L/LAYERS:0, k;
      if(N>1){   // one curved ribbon: N strips with shared edge vertices
        var R=P.rect, hw=innerWidth/2, x0=R.left+R.width/2+ox-w-hw, yc=innerHeight/2-(R.top+R.height/2), sw=2*w/N;
        for(var i=0;i<N;i++){ var xa=x0+i*sw, xb=xa+sw, ua=u0+(u1-u0)*i/N, ub=u0+(u1-u0)*(i+1)/N;
          ribV(xa,yc-h,yc,z,pos,q*12); ribV(xb,yc-h,yc,z,pos,q*12+3); ribV(xb,yc+h,yc,z,pos,q*12+6); ribV(xa,yc+h,yc,z,pos,q*12+9);
          for(k=0;k<4;k++){ if(L) col.set([0.8,0.86,1,0.12],q*16+k*4); else col.set([1,1,1,0.86],q*16+k*4); }
          uv.set([ua,v0,ub,v0,ub,v1,ua,v1],q*8); q++; }
        continue; }
      for(k=0;k<4;k++){ xf(p,cs[k][0]+ox,cs[k][1],z,pos,q*12+k*3);
        // back layers: dim, mostly transparent -> a thin glowing rim; front: the CSS glass as is, faint top sheen
        if(L) col.set([0.8,0.86,1,0.12],q*16+k*4); else col.set([1,1,1,0.86],q*16+k*4); }   // (v174) frosted glass: see-through front, faint rim, no gloss
      uv.set([u0,v0,u1,v0,u1,v1,u0,v1],q*8); q++; }
    return q; }
  function idxFor(n){ var idx=new Uint32Array(n*6); for(var q=0;q<n;q++){ var b=q*4; idx.set([b,b+1,b+2,b,b+2,b+3],q*6); } return idx; }
  function buildArt(){
    var rd=[]; panels.forEach(function(P){ if(P.ready&&P.slot&&!P.dyn&&!P.miss) rd.push(P); });
    rd.forEach(function(P){ P.p=place(P.rect); }); rd.sort(function(a,b){ return a.p.zc-b.p.zc; });   // far first (centre), the nearer sides after
    var nQ=rd.reduce(function(t,P){ return t+nStrips(P)*(LAYERS+1); },0), pos=new Float32Array(nQ*12), uv=new Float32Array(nQ*8), col=new Float32Array(nQ*16), q=0;
    rd.forEach(function(P){ q=quads(P,P.p,pos,uv,col,q); });
    setGeo(art,pos,uv,col,idxFor(q)); aTex.needsUpdate=true;
    panels.forEach(function(P){ if(P.dyn&&P.ready&&P.slot&&!P.built) buildDyn(P); });
    // DOM ghosting happens in ghostDrawn(), only after a frame actually rendered OK
  }
  function buildDyn(P){ var n=LAYERS+1, pos=new Float32Array(n*12), uv=new Float32Array(n*8), col=new Float32Array(n*16);
    var keep=P.rect; P.rect=null; quads(P,ID,pos,uv,col,0); P.rect=keep;
    if(!P.mesh){ P.mesh=new T.Mesh(new T.BufferGeometry(),art.material); P.mesh.renderOrder=1.6; P.mesh.frustumCulled=false; root.add(P.mesh); }
    setGeo(P.mesh,pos,uv,col,idxFor(n)); P.built=true; P.moved=true; }
  // (v200) reuse the BufferGeometry when the vertex count is unchanged (the usual case): copy in place + needsUpdate
  function setGeo(m,pos,uv,col,idx){ var o=m.geometry, op=o&&o.getAttribute('position');
    if(op&&op.array.length===pos.length&&o.index&&o.index.array.length===idx.length&&!!o.getAttribute('color')===!!col){
      op.array.set(pos); op.needsUpdate=true; var ou=o.getAttribute('uv'); ou.array.set(uv); ou.needsUpdate=true; if(col){ var oc=o.getAttribute('color'); oc.array.set(col); oc.needsUpdate=true; }
      m.visible=idx.length>0; return; }
    var g=new T.BufferGeometry(); g.setAttribute('position',new T.BufferAttribute(pos,3)); g.setAttribute('uv',new T.BufferAttribute(uv,2)); if(col) g.setAttribute('color',new T.BufferAttribute(col,4)); g.setIndex(new T.BufferAttribute(idx,1)); m.geometry.dispose(); m.geometry=g; m.visible=idx.length>0; }
  // knobs follow the thumb every frame (one getBoundingClientRect each)
  function trackDyn(){ panels.forEach(function(P){ if(!P.dyn||!P.mesh) return; var r=P.el.getBoundingClientRect(); if(r.width<1){ P.mesh.visible=false; return; }
    P.mesh.visible=P.ready; var p=place(r); P.mesh.position.set((p.cx)*p.f,p.cy*p.f,p.zc+1); P.mesh.rotation.set(0,p.th,0); P.mesh.scale.set(p.f,p.f,p.f); }); }

  // ---------- live text: per-leaf slot in the text atlas, redrawn only when its value changes ----------
  var DPR=1.5, TP=12;
  function lw(L){ return L.r.width+(L.node?4:0); }
  function buildText(){
    var all=[]; panels.forEach(function(P){ if(P.ready&&!P.dyn&&!P.miss) P.leaves.forEach(function(L){ L.P=P; all.push(L); }); });
    var cur0=[sx,sy,sh]; sx=sy=sh=0;   // text atlas packs with its own cursor; the art cursor is restored below
    var pos=new Float32Array(all.length*12), uv=new Float32Array(all.length*8), q=0;
    panels.forEach(function(P){ P.txtOk=true; });
    all.forEach(function(L){ var w=Math.ceil(lw(L)*DPR)+2*TP, h=Math.ceil(L.r.height*DPR)+2*TP;   /* (v160) TP margin so glow shadows fade out instead of ending in a hard box */ L.slot=alloc(w,h,TATLAS,TATLAS_H); L.sw=w; L.sh=h; L.text=null; if(!L.slot) L.P.txtOk=false; });
    var TH=32, tEnd=sy+sh; while(TH<tEnd&&TH<TATLAS_H) TH*=2; sx=cur0[0]; sy=cur0[1]; sh=cur0[2];
    if(tCv.height!==TH){ tCv.height=TH; tTex.dispose(); tTex=tx(tCv); txt.material.map=tTex; txt.material.needsUpdate=true; } else tCx.clearRect(0,0,TATLAS,TH);
    all.forEach(function(L){ var w=L.sw, h=L.sh; if(!L.slot) return;
      var p=L.P.p||place(L.P.rect), pr=L.P.rect;
      var lx=(L.r.left+lw(L)/2)-(pr.left+pr.width/2), ly=(pr.top+pr.height/2)-(L.r.top+L.r.height/2), hw=w/DPR/2, hh=h/DPR/2, cs=[[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]];
      if(nStrips(L.P)>1){ var hw2=innerWidth/2, ycp=innerHeight/2-(pr.top+pr.height/2), lcx=L.r.left+lw(L)/2-hw2, lcy=innerHeight/2-(L.r.top+L.r.height/2);   // ribbon panel: text rides the same curve
        for(var k2=0;k2<4;k2++) ribV(lcx+cs[k2][0],lcy+cs[k2][1],ycp,0.6,pos,q*12+k2*3); }
      else for(var k=0;k<4;k++) xf(p,lx+cs[k][0],ly+cs[k][1],0.6,pos,q*12+k*3);
      var u0=L.slot.x/TATLAS, u1=(L.slot.x+w)/TATLAS, v0=1-(L.slot.y+h)/TH, v1=1-L.slot.y/TH; uv.set([u0,v0,u1,v0,u1,v1,u0,v1],q*8); q++; });
    setGeo(txt,pos,uv,null,idxFor(q)); txt.userData.leaves=all;
  }
  // (v160) glyph glow is blended in linear light on the mesh, so a CSS-strength glow piles up into a solid pill behind small text: keep ~35%
  function soft(c){ var m=/rgba?\(([^)]*)\)/.exec(c); if(!m) return c; var a=m[1].split(/[ ,\/]+/).filter(Boolean); var al=a.length>3?parseFloat(a[3]):1; return 'rgba('+a[0]+','+a[1]+','+a[2]+','+(al*0.35).toFixed(3)+')'; }
  function drawLeaf(L,s){
    if(!L.cs){ var c0=getComputedStyle(L.el); L.cs={textTransform:c0.textTransform,fontStyle:c0.fontStyle,fontWeight:c0.fontWeight,fontSize:c0.fontSize,fontFamily:c0.fontFamily,letterSpacing:c0.letterSpacing,color:c0.color,textShadow:c0.textShadow,textAlign:L.node?'left':c0.textAlign,paddingLeft:L.node?'0px':c0.paddingLeft,k:(L.el.offsetWidth>0?Math.min(4,Math.max(.25,(L.node?L.el.getBoundingClientRect().width:L.r.width)/L.el.offsetWidth)):1)}; }
    if(L.cs.k<0.9&&L.P&&L.P.el.getAnimations&&L.P.el.getAnimations({subtree:true}).some(function(a){ return a.playState==='running'; })){ L.cs.k=1; layoutDirty=true; }   // (v204) mid scale-in: draw at 1:1, next layout re-reads
    var cs=L.cs, x=L.slot.x, y=L.slot.y; tCx.clearRect(x,y,L.sw,L.sh);   // (v156) style snapshot per layout, not a style read per redraw
    if(cs.textTransform==='uppercase') s=s.toUpperCase();
    tCx.save(); tCx.beginPath(); tCx.rect(x,y,L.sw,L.sh); tCx.clip(); var K=DPR*cs.k; tCx.scale(K,K);
    tCx.font=cs.fontStyle+' '+cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily; try{ tCx.letterSpacing=cs.letterSpacing==='normal'?'0px':cs.letterSpacing; }catch(e){}
    tCx.fillStyle=cs.color; tCx.textBaseline='middle';
    var ts=cs.textShadow; if(ts&&ts!=='none'){ var m=ts.match(/(rgba?\([^)]*\)|#[0-9a-f]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/i); if(m){ tCx.shadowColor=soft(m[1]); tCx.shadowOffsetX=+m[2]*K; tCx.shadowOffsetY=+m[3]*K; tCx.shadowBlur=+m[4]*K; } }
    var al=cs.textAlign, ox=x/K+TP/K, w=(L.sw-2*TP)/K; tCx.textAlign=al==='center'?'center':(al==='right'||al==='end')?'right':'left';
    var px=tCx.textAlign==='center'?ox+w/2:tCx.textAlign==='right'?ox+w:ox+(parseFloat(cs.paddingLeft)||0);
    var tw=tCx.measureText(s).width, fw=w-(tCx.textAlign==='left'?(parseFloat(cs.paddingLeft)||0):0);   // (v174) fit: a wider fallback font / phone scale must never clip ('DART ME')
    if(tw>fw&&fw>0){ var fx=fw/tw; tCx.translate(px,0); tCx.scale(fx,1); px=0; }
    tCx.fillText(s,px,y/K+L.sh/K/2); tCx.restore();
  }
  function updateText(){ var Ls=txt.userData.leaves||[], ch=false;
    for(var i=0;i<Ls.length;i++){ var L=Ls[i]; if(!L.slot) continue; var s=(L.node?L.node.data:L.el.textContent).trim(); if(s!==L.text){ L.text=s; drawLeaf(L,s); ch=true; } }
    if(ch) tTex.needsUpdate=true; }


  // ---------- change-driven layout (v156 ResizeObserver + 1 s fallback; v160 state-colour mutations refresh at once) ----------
  var cvT=0, layoutDirty=true, layoutT=0, lastKind=null, discT=-1e9, discDirty=false, ro=null, mo=null, roSeen=new WeakSet();
  function selfOnly(m){ if(m.attributeName!=='class') return false;   // our own ghost toggles must not re-trigger layout
    var a=(m.oldValue||'').replace(/\bdm-ui3d-ghost\b/g,'').trim().split(/\s+/).sort().join(' '), b=String(m.target.className&&m.target.className.baseVal!==undefined?m.target.className.baseVal:m.target.className).replace(/\bdm-ui3d-ghost\b/g,'').trim().split(/\s+/).sort().join(' ');
    return a===b; }
  function hasEl(nl){ for(var i=0;i<nl.length;i++) if(nl[i].nodeType===1) return true; return false; }
  var LOOK=/color|background|border|shadow|display|visibility|opacity|filter|fill|stroke/;
  function decl(v){ var o={}; String(v||'').split(';').forEach(function(d){ var i=d.indexOf(':'); if(i>0) o[d.slice(0,i).trim()]=d.slice(i+1).trim(); }); return o; }
  function styleLook(a,b){ var A=decl(a), B=decl(b), k; for(k in A) if(A[k]!==B[k]&&LOOK.test(k)) return true; for(k in B) if(!(k in A)&&LOOK.test(k)) return true; return false; }   // warning colours etc.
  function onMut(list){ for(var i=0;i<list.length;i++){ var m=list[i], t=m.target;
      if(m.type==='childList'){ if(hasEl(m.addedNodes)||hasEl(m.removedNodes)){ discDirty=true; layoutDirty=true; } continue; }   // text swaps are the live text path
      if(selfOnly(m)) continue;
      if(m.attributeName==='style'&&!styleLook(m.oldValue,t.getAttribute('style'))) continue;   // moves / sizes: ResizeObserver + 1 s net; knobs per frame
      layoutDirty=true;
      for(var n=t;n&&n.nodeType===1;n=n.parentElement){ var P=panels.get(n); if(P){ P.force=true; break; } } } }   // paintSig sees the change; force skips the 1 s gate, capped at 10/s
  function watch(){
    if(!ro&&window.ResizeObserver){ ro=new ResizeObserver(function(){ layoutDirty=true; }); addEventListener('resize',function(){ layoutDirty=true; }); }
    if(!mo&&window.MutationObserver) mo=new MutationObserver(onMut);
    var rs=roots(foundKind||'game'); rs.forEach(function(r){ if(mo&&!roSeen.has(r)){ roSeen.add(r); mo.observe(r,{subtree:true,attributes:true,attributeFilter:['class','style','hidden','disabled'],attributeOldValue:true,childList:true}); } });
    if(ro) panels.forEach(function(P,el){ if(!roSeen.has(el)){ roSeen.add(el); ro.observe(el); } }); }

  // (v183) the panel texture blends in linear light, so CSS glows/box-shadows that look faint on a page pile up into
  // an opaque halo filling the padded atlas cell (the 'light slab' look). Keep them as a hint: alpha x0.25.
  function softSh(st){ var v=st.getPropertyValue('box-shadow'); if(!v||v==='none') return;
    st.setProperty('box-shadow',v.replace(/rgba?\(([^)]+)\)/g,function(m,a){ var p=a.split(','); var al=p.length>3?parseFloat(p[3]):1; return 'rgba('+p[0]+','+p[1]+','+p[2]+','+(al*0.25).toFixed(3)+')'; })); }
  // (v206) perfGuard removed: the HUD never changes painter, rate or visibility with the frame rate. Readouts upload at a fixed 10 Hz.
  var TXT_MS=100;
  // ---------- overlay pass on the renderer that owns the screen ----------
  function tx(c){ var t=new T.CanvasTexture(c); t.colorSpace=T.SRGBColorSpace; t.generateMipmaps=false; t.minFilter=T.LinearFilter; t.premultiplyAlpha=true; return t; }
  // glass: no depth write / test (sorted by renderOrder + far-to-near buffer order), front faces only
  function mat(map,vc){ var m=new T.MeshBasicNodeMaterial({map:map,vertexColors:!!vc,transparent:true,depthWrite:false,depthTest:false,side:T.FrontSide}); m.toneMapped=false; m.premultipliedAlpha=true; return m; }
  function rOK(R){ var v=okR.get(R); if(v===undefined){ v=!!(R&&R.backend); okR.set(R,v); } return v; }   // (v160) WebGPU and its WebGL2 backend alike
  function setup(R){
    T=window.THREE; if(!T) return false;
    if(!rOK(R)) return false;   // not a node-material renderer: this pass simply does not run on it
    root=new T.Group(); scene=new T.Scene();   // own overlay scene: edgewarm (#215) only walks flightScene, so HUD meshes are never warmed/batched there
    scene.add(root); cam=new T.PerspectiveCamera(FOV,1,1,10);
    aCv=document.createElement('canvas'); aCv.width=ATLAS; aCv.height=64; aCx=aCv.getContext('2d');
    tCv=document.createElement('canvas'); tCv.width=TATLAS; tCv.height=32; tCx=tCv.getContext('2d');
    aTex=tx(aCv); tTex=tx(tCv);
    art=new T.Mesh(new T.BufferGeometry(),mat(aTex,true)); art.renderOrder=1;
    txt=new T.Mesh(new T.BufferGeometry(),mat(tTex,false)); txt.renderOrder=2;
    [art,txt].forEach(function(m){ m.frustumCulled=false; m.visible=false; root.add(m); });
    addEventListener('pointermove',function(e){ ptr.x=(e.clientX/innerWidth-0.5)*2; ptr.y=(e.clientY/innerHeight-0.5)*2; },{passive:true});
    // hover / press states repaint the panel under the pointer
    ['pointerover','pointerout','pointerdown','pointerup'].forEach(function(ev){ addEventListener(ev,function(e){ for(var n=e.target;n&&n.nodeType===1;n=n.parentElement){ var P=panels.get(n); if(P){ P.force=true; P.sig=''; break; } } },{passive:true}); });
    document.body.classList.add('dm-ui3d-mesh'); ready=true; return true;
  }
  function anyVis(){ if(art.visible||txt.visible) return true; var v=false; cvs.forEach(function(){ v=true; }); return v; }
  // ---------- fallback watchdog ----------
  var paints=0, txtT=0, drewOK=false, wdFrames=0, wdT0=0, WD_MS=15000, why0='';
  // (v206) One recovery path, for a render that THROWS (not for a slow frame): after 12 throws in a row the DOM HUD is shown and the pass retries
  // every 3 s until a frame draws again. No session latch, nothing frame-rate based; ghosting is sticky otherwise.
  var retryAt=0, wasOn=false, fails=0;
  function fallback(why){ why0=why; fails++; if(fails<12) return; console.warn('[UI3D] mesh HUD frame failed '+fails+'x ('+why+'); DOM shown, retrying in 3 s');
    try{ stop(); }catch(e){} drewOK=false; wdFrames=0; wdT0=0; retryAt=performance.now()+3000; layoutDirty=true; fails=0; }
  function ghostDrawn(){ ghosted=true;
    panels.forEach(function(P){ var g=P.ready&&P.slot&&(!P.dyn||P.mesh); if(g&&!P.g){ P.g=true; P.el.classList.add('dm-ui3d-ghost'); } });   // sticky: a ghosted panel is only un-ghosted when it leaves the page or Legacy UI is switched on
    cvs.forEach(function(C){ if(!C.g){ C.g=true; C.el.classList.add('dm-ui3d-ghost'); } }); }
  function unghost(){ ghosted=false; panels.forEach(function(P){ if(P.g){ P.g=false; P.el.classList.remove('dm-ui3d-ghost'); } }); cvs.forEach(function(C){ if(C.g){ C.g=false; C.el.classList.remove('dm-ui3d-ghost'); } }); }
  function introOn(){ try{ if(typeof INTRO!=='undefined'&&INTRO&&INTRO.on) return true; }catch(e){}
    var v=document.getElementById('intro-veil'); if(v&&v.isConnected){ var c=getComputedStyle(v); if(c.display!=='none'&&parseFloat(c.opacity)>0.01) return true; } return false; }
  function overlay(R,kind){ try{ overlayBody(R,kind||'game'); }catch(e){ fallback('overlay threw: '+(e&&e.message)); } }
  function camSet(){ var vw=innerWidth, vh=innerHeight, d=camD();
    // camera-locked visor: a few px of parallax toward the pointer (the flat centre does not move)
    ptr.ex+=(ptr.x-ptr.ex)*0.06; ptr.ey+=(ptr.y-ptr.ey)*0.06;
    cam.aspect=vw/vh; cam.near=d*0.3; cam.far=d*2; cam.position.set(ptr.ex*PAR,-ptr.ey*PAR,d); cam.lookAt(0,0,0); cam.updateProjectionMatrix(); }
  function overlayBody(R,kind){
    if(!on()){ if(wasOn){ wasOn=false; stop(); } return; } if(performance.now()<retryAt) return; if(!ready&&!setup(R)) return; wasOn=true;
    if((kind==='menu')!==menuHost()) return;
    if(introOn()) return;   // (v160) no HUD pass while the #197/#198 loading-intro veil or its dissolve is up (the veil covers the page; panels stay ghosted)
    if(!rOK(R)) return;
    var t0=performance.now();
    // (v156/v160) layout() forces a sync style+layout pass, so it is change-driven: a watched panel resizes, the window
    // resizes, a class/style changes inside the HUD (warning colours: immediate), the screen kind changes, or a 1 s safety net
    frameN++; var ln=performance.now();
    if((layoutDirty&&ln-layoutT>=100)||kind!==lastKind||ln-layoutT>=LAYOUT_MS){ layoutDirty=false; lastKind=kind; layoutT=ln; layout(kind); }
    if(artDirty){ artDirty=false; buildArt(); txtGeoDirty=true; }
    if(txtGeoDirty){ txtGeoDirty=false; buildText(); txtT=0; }
    trackDyn();
    cvs.forEach(function(C){ setXf(C.mesh,C.p,C.rect.width,C.rect.height); C.mesh.position.z+=0.8; });
    // readouts + live canvases re-upload at most ~15 Hz
    var tn=performance.now(); if(tn-txtT>=TXT_MS){ txtT=tn; updateText(); if(tn-cvT>=250){ cvT=tn; cvs.forEach(function(C){ if(C.mesh.visible&&C.el.width&&C.el.height) C.tex.needsUpdate=true; }); } }   // (v204) TXT_MS readouts; (v200) live canvases at 4 Hz, visible only
    // the DOM stays visible until a mesh frame draws OK; only a render throw or no art at all after 15 s (raster stall) falls back
    if(!drewOK&&!arHeld&&panels.size){ if(!wdT0) wdT0=performance.now(); wdFrames++; var anyArt=false; panels.forEach(function(P){ if(P.ready) anyArt=true; });
      if(!anyArt&&performance.now()-wdT0>WD_MS){ console.warn('[UI3D] no panel art after '+Math.round(performance.now()-wdT0)+' ms (painter '+painter+'): re-rastering'); wdT0=performance.now(); panels.forEach(function(P){ P.busy=false; P.want=true; }); } }   // (v160) 15 s watchdog re-rasters instead of switching to CSS
    if(arHeld||!anyVis()){ hudMs+=performance.now()-t0; hudN++; return; }
    camSet();
    var ac=R.autoClear, ok=false; R.autoClear=false;
    try{ R.clearDepth&&R.clearDepth(); R.render(scene,cam); ok=true; }
    catch(e){ R.autoClear=ac; fallback('render threw: '+(e&&e.message)); return; }
    finally { R.autoClear=ac; }
    if(ok){ drewOK=true; fails=0; ghostDrawn(); }
    var dtH=performance.now()-t0; hudMs+=dtH; hudN++;
  }
  // AR / camera passthrough: draw the HUD group on another renderer (layout/text keep updating in overlay())
  function drawTo(R){ if(!ready||!on()||!anyVis()) return false;
    if(root.parent!==scene) scene.add(root);
    camSet();
    var ac=R.autoClear; R.autoClear=false; try{ R.clearDepth&&R.clearDepth(); R.render(scene,cam); drewOK=true; ghostDrawn(); } finally { R.autoClear=ac; } return true;   // drewOK only after R.render returned without throwing
  }
  function stop(){ unghost(); try{ if(mo) mo.disconnect(); if(ro) ro.disconnect(); }catch(e){} mo=ro=null; roSeen=new WeakSet(); panels.forEach(function(P,el){ el.classList.remove('dm-ui3d-ghost'); if(P.mesh){ if(root) root.remove(P.mesh); P.mesh.geometry.dispose(); } }); panels.clear();
    cvs.forEach(function(C){ C.el.classList.remove('dm-ui3d-ghost'); if(root) root.remove(C.mesh); C.mesh.geometry.dispose(); C.mesh.material.dispose(); C.tex.dispose(); }); cvs.clear();   // (v200) dispose, not just hide
    sx=sy=sh=0; layoutDirty=true;
    drewOK=false; wdFrames=0; wdT0=0; if(ready){ art.visible=txt.visible=false; } document.body.classList.remove('dm-ui3d-mesh'); }

  window.DMUI3DMesh={
    get active(){ return on()&&ready&&!!(art&&(art.visible||txt.visible)); }, get mesh(){ return root; }, get scene(){ return scene; }, get camera(){ return cam; },
    overlay:overlay, drawTo:drawTo, _paintSafe:function(el){ var r=el.getBoundingClientRect(); return paintSafe({el:el,w:Math.ceil(r.width),h:Math.ceil(r.height)}).then(function(c){ return c.toDataURL(); }); },
    // what is really on screen: 'mesh' (overlay drew OK), 'css' (tilt fallback / opt-out), 'flat'
    get status(){ var m=mode==='0'||(window.DMUI3D&&DMUI3D.enabled===false)?'flat':(on()&&ready&&drewOK)?'mesh':(on()?'mesh?':'css');
      return {mode:m, reason:why0, painter:painter, pending:on()&&!drewOK?Math.round(wdT0?performance.now()-wdT0:0):0}; },
    setLegacy:function(v){ v=!!v; try{ if(typeof STATE!=='undefined'&&STATE&&STATE.settings) STATE.settings.legacyUI=v; }catch(e){} if(v){ this.setMode('0'); if(window.DMUI3D) DMUI3D.disable(); try{ localStorage.setItem('dm.ui3d','0'); }catch(e){} } else { if(window.DMUI3D) DMUI3D.enable(); this.setMode('mesh'); } },   // (v175) Legacy UI = the flat 2D HUD, live, no reload
    get legacy(){ return legacy(); },
    setMode:function(m){ mode=m; try{ localStorage.setItem('dm.ui3d',m); }catch(e){} if(!on()) stop(); else if(ready) document.body.classList.add('dm-ui3d-mesh'); if(window.DMUI3D) DMUI3D.refresh(); },
    // AR: ui/dm-ar-core.js draws `mesh` itself on a head-locked plate; on release it goes back here
    arHold:function(h){ arHeld=!!h; if(!h&&root&&scene&&root.parent!==scene) scene.add(root); },
    // CPU ms per overlay call (layout + text + draw submit), averaged since the last read
    hudCost:function(){ var v=hudN?hudMs/hudN:0; hudMs=0; hudN=0; return v; },
    _atlas:function(){ return aCv&&aCv.toDataURL(); },
    _stats:function(){ var o=[]; panels.forEach(function(P){ o.push({id:P.el.id||String(P.el.className).slice(0,30),w:P.rect?Math.round(P.rect.width):0,x:P.rect?Math.round(P.rect.left):0,y:P.rect?Math.round(P.rect.top):0,h:P.rect?Math.round(P.rect.height):0,strips:nStrips(P),ready:P.ready,g:!!P.g,dyn:P.dyn,leaves:P.leaves.length}); });
      return {on:on(),painter:painter,why:why0,ready:ready,frames:frameN,paints:paints,drewOK:drewOK,ghosted:ghosted,n:o.length,ready_n:o.filter(function(x){ return x.ready; }).length,canvases:cvs.size,panels:o.slice(0,60)}; }
  };
})();
