/* DART Meadow — 3D HUD meshes (crunch 2), default on; opt out: localStorage 'dm.ui3d'='css' (tilt) or '0' (flat).
   The CSS tilt (ui/dm-ui3d-core.js) is the runtime fallback when WebGPU or the mesh draw is unavailable; '0' = flat.

   No second renderer / device: the HUD is drawn by the game's own flightRenderer as an overlay pass
   right after the frame (index.html calls DMUI3DMesh.overlay(flightRenderer) next to _shotGrab).

   Static art: each in-game HUD panel (.hud-c kite, .hud-l, .hud-r, .mini-kite) is rasterized ONCE
   (and again only if its size/position changes) from its live DOM/SVG via SVG foreignObject with every
   text leaf made transparent, into one atlas that is uploaded once per layout. Each panel becomes a thin
   extrusion (front quad + 3 darkened layers) turned by a tilt from its place on screen; all panels are
   merged into ONE geometry = one draw.
   Live values: every text leaf (altitude, speed, Mach, FPS, names...) is its own small quad textured from
   a shared text atlas, drawn with the leaf's real computed font/colour/letter-spacing/glow by canvas 2D.
   textContent is compared every frame; a leaf is redrawn (and the text atlas re-uploaded) only on the
   frame its value changes — no snapshot lag. Text quads share the panel's tilt, slightly in front.
   Minimap: its canvas is a live CanvasTexture on its own tilted quad, refreshed every frame.
   The DOM panels stay where they are at opacity 0, so every tap / drag still hits the real element.
   AR (ui/dm-ar-core.js) draws the same `mesh` group on a head-locked plate. */
(function(){
  'use strict';
  if(window.DMUI3DMesh) return;
  var TARGETS=['.hud-c','.hud-l','.hud-r','.mini-kite'];
  var MAX_DEG=18, LAYERS=6, DEPTH=24, FOV=40, ATLAS=2048, TATLAS=1024, PAD=2, LAYOUT_EVERY=20;   // (v156) superseded by LAYOUT_MS + ResizeObserver below
  var PROPS=['display','position','left','top','right','bottom','width','height','min-width','min-height','max-width','max-height',
    'margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left','box-sizing',
    'border-top','border-right','border-bottom','border-left','border-radius','background-color','background-image','background-size','background-position','background-repeat',
    'color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','text-shadow','white-space','text-overflow','overflow',
    'opacity','box-shadow','clip-path','transform','transform-origin','rotate','scale','translate','flex','flex-direction','flex-wrap','align-items','justify-content','gap','grid-template-columns',
    'z-index','visibility','fill','stroke','stroke-width','stroke-dasharray','stroke-dashoffset','font-variant-numeric','vertical-align','filter','mix-blend-mode','inset','object-fit'];
  var mode=(function(){ try{ return localStorage.getItem('dm.ui3d'); }catch(e){ return null; } })();
  // (v142) mesh HUD is the default everywhere (desktop, web app, AR). Opt out with dm.ui3d='css' (CSS tilt) or '0' (flat).
  // The WebGPU gate + watchdog still fall back to CSS at runtime on devices where it can't draw.
  function on(){ return mode!=='css'&&mode!=='0'; }

  var st=document.createElement('style'); st.textContent=
    'body.dm-ui3d-mesh .dm-ui3d-ghost{opacity:0!important;rotate:none!important;filter:none!important}';
  document.head.appendChild(st);

  var T=null, root=null, scene=null, cam=null, art=null, txt=null, mm=null, aCv, aCx, aTex, tCv, tCx, tTex;
  var layoutDirty=true, layoutT=0, lastFlight=null, LAYOUT_MS=1000, ro=null, roSeen=new WeakSet();
  function watch(){ if(!ro&&window.ResizeObserver){ ro=new ResizeObserver(function(){ layoutDirty=true; }); addEventListener('resize',function(){ layoutDirty=true; }); }
    if(ro) panels.forEach(function(P,el){ if(!roSeen.has(el)){ roSeen.add(el); ro.observe(el); } }); }
  var panels=new Map(), frameN=0, artDirty=false, txtGeoDirty=false, imgCache=new Map(), arHeld=false, ready=false;

  // ---------- one-time static raster (text leaves transparent) ----------
  function inlineImg(src){ if(imgCache.has(src)) return imgCache.get(src);
    var p=fetch(src).then(function(r){ return r.blob(); }).then(function(b){ return new Promise(function(res){ var fr=new FileReader(); fr.onload=function(){ res(fr.result); }; fr.readAsDataURL(b); }); }).catch(function(){ return src; });
    imgCache.set(src,p); return p; }
  function within(p,ms){ return Promise.race([p,new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('timeout')); },ms); })]); }
  function isLeaf(el){ if(el instanceof SVGElement) return false; if(el.children.length) return false; var t=el.textContent; return !!(t&&t.trim()); }
  async function raster(el,w,h){
    var c=el.cloneNode(true), os=[el], cs=[c];
    for(var k=0;k<os.length;k++){ var a=os[k].children, b=cs[k].children; for(var i=0;i<a.length&&i<b.length;i++){ os.push(a[i]); cs.push(b[i]); } }
    for(var j=0;j<os.length;j++){ var o=os[j]; if(!(o instanceof SVGElement)||o.tagName.toLowerCase()==='svg'){ var cst=getComputedStyle(o), s=cs[j].style; for(var q=0;q<PROPS.length;q++){ var v=cst.getPropertyValue(PROPS[q]); if(v) s.setProperty(PROPS[q],v); } }
      if(isLeaf(o)){ cs[j].style.color='transparent'; cs[j].style.textShadow='none'; } }
    var rs=c.style; rs.position='relative'; rs.left=rs.top='0'; rs.right=rs.bottom='auto'; rs.margin='0'; rs.transform='none'; rs.rotate='none'; rs.scale='none'; rs.translate='none'; rs.filter='none'; rs.opacity='1'; rs.width=w+'px'; rs.height=h+'px';
    c.classList.remove('dm-ui3d-ghost','dm-ui3d-p');
    var imgs=c.querySelectorAll('img'); for(var m=0;m<imgs.length;m++){ var src=imgs[m].currentSrc||imgs[m].src; if(src&&!/^data:/.test(src)) imgs[m].setAttribute('src',await within(inlineImg(src),4000).catch(function(){ return src; })); }
    c.querySelectorAll('canvas,script,video,iframe').forEach(function(n){ n.remove(); });
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:'+w+'px;height:'+h+'px;overflow:hidden">'+new XMLSerializer().serializeToString(c)+'</div></foreignObject></svg>';
    var img=new Image();
    await within(new Promise(function(res,rej){ img.onload=res; img.onerror=rej; img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg); }),10000);
    return img;
  }

  // ---------- layout (every LAYOUT_EVERY frames; values are per frame) ----------
  function visible(el){ var r=el.getBoundingClientRect(); if(r.width<8||r.height<8) return null; var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return null; return r; }
  function flightOn(){ var f=document.getElementById('screen-flight'); return !!(f&&f.classList.contains('active')); }
  function tilt(r){ var vw=innerWidth, vh=innerHeight, cx=r.left+r.width/2-vw/2, cy=vh/2-(r.top+r.height/2);
    var nx=Math.max(-1,Math.min(1,cx/(vw/2))), ny=Math.max(-1,Math.min(1,cy/(vh/2))), ax=new T.Vector3(-ny*0.8,-nx,0), q=new T.Quaternion();
    if(ax.lengthSq()>1e-6){ var ang=ax.length()*MAX_DEG*Math.PI/180; ax.normalize(); q.setFromAxisAngle(ax,-ang); }
    return {q:q,cx:cx,cy:cy,nx:nx,ny:ny}; }
  var sx=0, sy=0, sh=0; function alloc(w,h,size){ if(sx+w>size){ sx=0; sy+=sh+PAD; sh=0; } if(sy+h>size) return null; var a={x:sx,y:sy}; sx+=w+PAD; sh=Math.max(sh,h); return a; }
  function layout(){
    var seen=new Set(), relay=false;
    if(flightOn()) document.querySelectorAll(TARGETS.join(',')).forEach(function(el){
      for(var p=el.parentElement;p;p=p.parentElement) if(seen.has(p)) return;
      var r=visible(el); if(!r) return; seen.add(el);
      var P=panels.get(el), sig=[r.left,r.top,r.width,r.height].map(Math.round).join(',');
      if(!P){ P={el:el,sig:'',ready:false,busy:false,leaves:[]}; panels.set(el,P); }
      if(P.sig!==sig){ P.sig=sig; P.rect=r; P.w=Math.ceil(r.width); P.h=Math.ceil(r.height); P.ready=false; relay=true; }
      // leaves: positions follow layout; text is checked every frame
      var Ls=[]; el.querySelectorAll('*').forEach(function(n){ if(!isLeaf(n)) return; var lr=visible(n); if(lr) Ls.push({el:n,r:lr,text:null}); });
      if(Ls.length!==P.leaves.length||Ls.some(function(L,i){ var o=P.leaves[i]; return o.el!==L.el||Math.round(o.r.left)!==Math.round(L.r.left)||Math.round(o.r.top)!==Math.round(L.r.top)||Math.round(o.r.width)!==Math.round(L.r.width); })){ P.leaves=Ls; txtGeoDirty=true; }
    });
    panels.forEach(function(P,el){ if(!seen.has(el)){ el.classList.remove('dm-ui3d-ghost'); panels.delete(el); relay=true; txtGeoDirty=true; } });
    if(relay){ sx=sy=sh=0; panels.forEach(function(P){ P.slot=alloc(P.w,P.h,ATLAS); });
      // (v149) the art atlas is only as tall as its slots (pow2): each finished panel raster re-uploads the whole texture
      var AH=64; while(AH<sy+sh&&AH<ATLAS) AH*=2; if(aCv.height!==AH){ aCv.height=AH; aTex.dispose(); aTex=tx(aCv); art.material.map=aTex; art.material.needsUpdate=true; } else aCx.clearRect(0,0,ATLAS,AH); panels.forEach(function(P){ P.ready=false; }); artDirty=true; }
    panels.forEach(function(P){ P.leaves.forEach(function(L){ if(L.cs){ L.cs=null; L.text=null; } }); });   // restyle (state colours) at most once per layout
    panels.forEach(function(P){ if(!P.ready&&!P.busy&&P.slot) paint(P); });
    // minimap: live canvas texture
    var mc=document.getElementById('minimap-canvas'), mr=mc&&flightOn()&&visible(document.getElementById('minimap')||mc);
    if(mr){ if(!mm.material.map||mm.material.map.image!==mc){ mm.material.map=new T.CanvasTexture(mc); mm.material.map.colorSpace=T.SRGBColorSpace; mm.material.needsUpdate=true; }
      var t=tilt(mr); mm.position.set(t.cx,t.cy,1); mm.quaternion.copy(t.q); mm.scale.set(mr.width,mr.height,1); mm.visible=true; mm.userData.el=document.getElementById('minimap'); }
    else if(mm.visible){ mm.visible=false; var me=document.getElementById('minimap'); me&&me.classList.remove('dm-ui3d-ghost'); }
  }
  // (v148) WebKit taints any canvas that draws an SVG <foreignObject> image; a tainted atlas makes the texture
  // upload throw (SecurityError) and the watchdog dropped iPhone/iPad to the CSS tilt. Every raster now goes to a
  // scratch canvas first and is probed with getImageData; on taint we switch (once) to SAFE: a canvas-2D box
  // painter (backgrounds, borders, radius, glow, clip-path polygons) + inline <svg> drawn as plain SVG images
  // (no foreignObject = no taint). The shared atlas itself is never tainted.
  var SAFE=/[?&]ui3dsafe=1\b/.test(location.search), painter=SAFE?'box2d':'foreignObject';   // ?ui3dsafe=1: test the WebKit painter in Chromium; ?ui3dgl=1: allow the WebGL2 backend (headless checks)
  function scratch(w,h){ var c=document.createElement('canvas'); c.width=Math.max(1,w); c.height=Math.max(1,h); return c; }
  function clean(c){ try{ c.getContext('2d').getImageData(0,0,1,1); return true; }catch(e){ return false; } }
  function alphaOf(c){ var m=/rgba?\(([^)]*)\)/.exec(c||''); if(!m) return c&&c!=='transparent'?1:0; var a=m[1].split(/[ ,\/]+/).filter(Boolean); return a.length>3?parseFloat(a[3]):1; }
  function polyPath(cx,cp,x,y,w,h){ var m=/^polygon\((.*)\)$/.exec(cp||''); if(!m) return false; var pts=m[1].split(',');
    pts.forEach(function(pt,i){ var v=pt.trim().split(/\s+/), f=function(t,L){ return /%$/.test(t)?parseFloat(t)/100*L:parseFloat(t)||0; }; var px=x+f(v[0],w), py=y+f(v[1],h); if(i) cx.lineTo(px,py); else cx.moveTo(px,py); });
    cx.closePath(); return true; }
  async function paintSafe(P){
    var c=scratch(P.w,P.h), cx=c.getContext('2d'), base=P.el.getBoundingClientRect(), els=[P.el].concat([].slice.call(P.el.querySelectorAll('*')));
    for(var i=0;i<els.length;i++){ var el=els[i];
      if(el instanceof SVGElement&&el.tagName.toLowerCase()!=='svg') continue;
      var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity)===0) continue;
      var r=el.getBoundingClientRect(); if(r.width<1||r.height<1) continue; var x=r.left-base.left, y=r.top-base.top;
      if(el.tagName.toLowerCase()==='svg'){ var cl=el.cloneNode(true), so=[el].concat([].slice.call(el.querySelectorAll('*'))), sc=[cl].concat([].slice.call(cl.querySelectorAll('*')));
        for(var k=0;k<so.length;k++){ var s2=getComputedStyle(so[k]); ['fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','stroke-dasharray','stroke-linecap','stroke-linejoin','stop-color','stop-opacity','font-size','font-family','font-weight'].forEach(function(pn){ var v=s2.getPropertyValue(pn); if(v) sc[k].style.setProperty(pn,v); }); }
        ['position','left','top','right','bottom','inset','transform','rotate','translate','scale','margin'].forEach(function(pn){ cl.style.removeProperty(pn); }); cl.setAttribute('width',r.width); cl.setAttribute('height',r.height); cl.setAttribute('xmlns','http://www.w3.org/2000/svg');
        var im=new Image(); try{ await within(new Promise(function(res,rej){ im.onload=res; im.onerror=rej; im.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(cl)); }),4000); cx.drawImage(im,x,y,r.width,r.height); }catch(e){ console.warn('[UI3D] svg paint',e&&(e.message||e.type)); }
        continue; }
      var bg=cs.backgroundColor, bw=parseFloat(cs.borderTopWidth)||0, bc=cs.borderTopColor, rad=Math.min(parseFloat(cs.borderTopLeftRadius)||0,r.width/2,r.height/2);
      if(alphaOf(bg)<=0&&(bw<=0||alphaOf(bc)<=0)) continue;
      cx.save(); cx.globalAlpha=Math.min(1,parseFloat(cs.opacity)||1); cx.beginPath();
      if(!polyPath(cx,cs.clipPath,x,y,r.width,r.height)){ if(cx.roundRect) cx.roundRect(x+bw/2,y+bw/2,r.width-bw,r.height-bw,rad); else cx.rect(x+bw/2,y+bw/2,r.width-bw,r.height-bw); }
      var g=/(rgba?\([^)]*\)|#[0-9a-f]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/i.exec(cs.boxShadow||''); if(g&&!/inset/.test(cs.boxShadow)){ cx.shadowColor=g[1]; cx.shadowOffsetX=+g[2]; cx.shadowOffsetY=+g[3]; cx.shadowBlur=+g[4]; }
      if(alphaOf(bg)>0){ cx.fillStyle=bg; cx.fill(); cx.shadowColor='transparent'; }
      if(bw>0&&alphaOf(bc)>0){ cx.lineWidth=bw; cx.strokeStyle=bc; cx.stroke(); }
      cx.restore(); }
    if(!clean(c)) throw new Error('2D box painter canvas tainted');
    return c; }
  async function paintSrc(P){
    if(!SAFE){ try{ var img=await raster(P.el,P.w,P.h), c=scratch(P.w,P.h); c.getContext('2d').drawImage(img,0,0,P.w,P.h); if(clean(c)) return c;
        console.warn('[UI3D] foreignObject raster taints the canvas here (WebKit); switching to the 2D box painter'); }
      catch(e){ console.warn('[UI3D] foreignObject raster failed ('+(e&&e.message)+'); switching to the 2D box painter'); }
      SAFE=true; painter='box2d'; }
    return paintSafe(P); }
  function paint(P){ P.busy=true; var gen=P.sig;
    paints++; paintSrc(P).then(function(src){ if(P.sig!==gen||!P.slot) return; aCx.clearRect(P.slot.x,P.slot.y,P.w,P.h); aCx.drawImage(src,P.slot.x,P.slot.y,P.w,P.h); P.ready=true; artDirty=true; })
      .catch(function(e){ P.failed=(P.failed||0)+1; console.warn('[UI3D] raster',e&&e.message); }).finally(function(){ P.busy=false; }); }

  // ---------- static art geometry: ONE merged buffer ----------
  function buildArt(){
    var rd=[]; panels.forEach(function(P){ if(P.ready&&P.slot) rd.push(P); });
    var nQ=rd.length*(LAYERS+1), pos=new Float32Array(nQ*12), uv=new Float32Array(nQ*8), col=new Float32Array(nQ*12), idx=new Uint32Array(nQ*6), q=0, v=new T.Vector3();
    rd.forEach(function(P){ var t=tilt(P.rect), w=P.rect.width/2, h=P.rect.height/2;
      var u0=P.slot.x/ATLAS, u1=(P.slot.x+P.w)/ATLAS, v0=1-(P.slot.y+P.h)/aCv.height, v1=1-P.slot.y/aCv.height;
      for(var L=LAYERS;L>=0;L--){ var z=-DEPTH*L/LAYERS, sh=L===0?1:0.55-0.06*L, ox=L?t.nx*L*1.1:0, oy=L?-t.ny*L*0.8:0, cs=[[-w,-h],[w,-h],[w,h],[-w,h]];
        for(var k=0;k<4;k++){ v.set(cs[k][0]+ox,cs[k][1]+oy,z).applyQuaternion(t.q); pos.set([v.x+t.cx,v.y+t.cy,v.z],q*12+k*3); col.set([sh,sh,sh],q*12+k*3); }
        uv.set([u0,v0,u1,v0,u1,v1,u0,v1],q*8); var b=q*4; idx.set([b,b+1,b+2,b,b+2,b+3],q*6); q++; } });
    setGeo(art,pos,uv,col,idx); aTex.needsUpdate=true;
    // DOM ghosting happens in ghostDrawn(), only after a frame actually rendered OK
  }
  function setGeo(m,pos,uv,col,idx){ var g=new T.BufferGeometry(); g.setAttribute('position',new T.BufferAttribute(pos,3)); g.setAttribute('uv',new T.BufferAttribute(uv,2)); if(col) g.setAttribute('color',new T.BufferAttribute(col,3)); g.setIndex(new T.BufferAttribute(idx,1)); m.geometry.dispose(); m.geometry=g; m.visible=idx.length>0; }

  // ---------- live text: per-leaf slot in the text atlas, redrawn only when its value changes ----------
  var DPR=1.5;
  function buildText(){
    var all=[]; panels.forEach(function(P){ if(P.ready) P.leaves.forEach(function(L){ L.P=P; all.push(L); }); });
    sx=sy=sh=0;
    var pos=new Float32Array(all.length*12), uv=new Float32Array(all.length*8), idx=new Uint32Array(all.length*6), v=new T.Vector3(), q=0;
    all.forEach(function(L){ var w=Math.ceil(L.r.width*DPR)+8, h=Math.ceil(L.r.height*DPR)+8; L.slot=alloc(w,h,TATLAS); L.sw=w; L.sh=h; L.text=null; });
    // (v149) the text atlas is only as tall as the slots need (pow2): every changed readout re-uploads the whole
    // texture, and a full 1024² RGBA upload per HUD tick was a 4 MB texSubImage per frame on the tablet
    var TH=32; while(TH<sy+sh&&TH<TATLAS) TH*=2;
    if(tCv.height!==TH){ tCv.height=TH; tTex.dispose(); tTex=tx(tCv); txt.material.map=tTex; txt.material.needsUpdate=true; } else tCx.clearRect(0,0,TATLAS,TH);
    all.forEach(function(L){ var w=L.sw, h=L.sh; if(!L.slot) return;
      var t=tilt(L.P.rect), pc={x:L.P.rect.left+L.P.rect.width/2-innerWidth/2, y:innerHeight/2-(L.P.rect.top+L.P.rect.height/2)};
      var lx=L.r.left+L.r.width/2-innerWidth/2-pc.x, ly=innerHeight/2-(L.r.top+L.r.height/2)-pc.y, hw=w/DPR/2, hh=h/DPR/2, cs=[[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]];
      for(var k=0;k<4;k++){ v.set(lx+cs[k][0],ly+cs[k][1],0.5).applyQuaternion(t.q); pos.set([v.x+t.cx,v.y+t.cy,v.z],q*12+k*3); }
      var u0=L.slot.x/TATLAS, u1=(L.slot.x+w)/TATLAS, v0=1-(L.slot.y+h)/TH, v1=1-L.slot.y/TH; uv.set([u0,v0,u1,v0,u1,v1,u0,v1],q*8); var b=q*4; idx.set([b,b+1,b+2,b,b+2,b+3],q*6); q++; });
    setGeo(txt,pos,uv,null,idx.subarray(0,q*6)); txt.userData.leaves=all;
  }
  function drawLeaf(L,s){
    if(!L.cs){ var c0=getComputedStyle(L.el); L.cs={textTransform:c0.textTransform,fontStyle:c0.fontStyle,fontWeight:c0.fontWeight,fontSize:c0.fontSize,fontFamily:c0.fontFamily,letterSpacing:c0.letterSpacing,color:c0.color,textShadow:c0.textShadow,textAlign:c0.textAlign,paddingLeft:c0.paddingLeft}; }
    var cs=L.cs, x=L.slot.x, y=L.slot.y; tCx.clearRect(x,y,L.sw,L.sh);   // (v156) style snapshot per layout, not a style read per redraw
    if(cs.textTransform==='uppercase') s=s.toUpperCase();
    tCx.save(); tCx.beginPath(); tCx.rect(x,y,L.sw,L.sh); tCx.clip(); tCx.scale(DPR,DPR);
    tCx.font=cs.fontStyle+' '+cs.fontWeight+' '+cs.fontSize+' '+cs.fontFamily; try{ tCx.letterSpacing=cs.letterSpacing==='normal'?'0px':cs.letterSpacing; }catch(e){}
    tCx.fillStyle=cs.color; tCx.textBaseline='middle';
    var ts=cs.textShadow; if(ts&&ts!=='none'){ var m=ts.match(/(rgba?\([^)]*\)|#[0-9a-f]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/i); if(m){ tCx.shadowColor=m[1]; tCx.shadowOffsetX=+m[2]*DPR; tCx.shadowOffsetY=+m[3]*DPR; tCx.shadowBlur=+m[4]*DPR; } }
    var al=cs.textAlign, ox=x/DPR+4/DPR, w=(L.sw-8)/DPR; tCx.textAlign=al==='center'?'center':(al==='right'||al==='end')?'right':'left';
    var px=tCx.textAlign==='center'?ox+w/2:tCx.textAlign==='right'?ox+w:ox+(parseFloat(cs.paddingLeft)||0);
    tCx.fillText(s,px,y/DPR+L.sh/DPR/2); tCx.restore();
  }
  function updateText(){ var Ls=txt.userData.leaves||[], ch=false;
    for(var i=0;i<Ls.length;i++){ var L=Ls[i]; if(!L.slot) continue; var s=L.el.textContent.trim(); if(s!==L.text){ L.text=s; drawLeaf(L,s); ch=true; } }
    if(ch) tTex.needsUpdate=true; }

  // ---------- overlay pass on the game's renderer ----------
  function tx(c){ var t=new T.CanvasTexture(c); t.colorSpace=T.SRGBColorSpace; t.generateMipmaps=false; t.minFilter=T.LinearFilter; return t; }
  function setup(R){
    T=window.THREE; if(!T) return false;
    if(!(R&&R.backend&&(R.backend.isWebGPUBackend||/[?&]ui3dgl=1\b/.test(location.search)))){ fallback('renderer backend is not WebGPU'); return false; }
    root=new T.Group(); scene=new T.Scene(); scene.add(root); cam=new T.PerspectiveCamera(FOV,1,1,10);
    aCv=document.createElement('canvas'); aCv.width=aCv.height=ATLAS; aCx=aCv.getContext('2d');
    tCv=document.createElement('canvas'); tCv.width=tCv.height=TATLAS; tCx=tCv.getContext('2d');
    aTex=tx(aCv); tTex=tx(tCv);
    function mat(map,vc){ var m=new T.MeshBasicNodeMaterial({map:map,vertexColors:!!vc,transparent:true,depthWrite:false,depthTest:false,side:T.DoubleSide}); m.toneMapped=false; return m; }
    art=new T.Mesh(new T.BufferGeometry(),mat(aTex,true)); art.renderOrder=1;
    txt=new T.Mesh(new T.BufferGeometry(),mat(tTex,false)); txt.renderOrder=2;
    mm=new T.Mesh(new T.PlaneGeometry(1,1),mat(null,false)); mm.renderOrder=1; mm.visible=false;
    [art,txt,mm].forEach(function(m){ m.frustumCulled=false; root.add(m); });
    document.body.classList.add('dm-ui3d-mesh'); ready=true; return true;
  }
  // ---------- fallback watchdog ----------
  var paints=0, txtT=0, drewOK=false, wdFrames=0, wdT0=0, WD_MS=15000, why0='';
  function fallback(why){ why0=why; console.warn('[UI3D] mesh HUD failed ('+why+'); falling back to CSS tilt');
    try{ stop(); }catch(e){} mode='css'; drewOK=false; wdFrames=0; wdT0=0; try{ if(window.DMUI3D) DMUI3D.refresh(); }catch(e){} }
  function ghostDrawn(){ panels.forEach(function(P){ if(P.ready&&P.slot) P.el.classList.add('dm-ui3d-ghost'); });
    if(mm.visible&&mm.userData.el) mm.userData.el.classList.add('dm-ui3d-ghost'); }
  function overlay(R){ try{ overlayBody(R); }catch(e){ fallback('overlay threw: '+(e&&e.message)); } }
  function overlayBody(R){
    if(!on()) return; if(!ready&&!setup(R)) return;
    // (v156) layout() forces a synchronous style+layout pass (getBoundingClientRect/getComputedStyle on every panel and
    // leaf) right after the game wrote the HUD text: run every 20 frames it was a ~3 Hz hitch. Now it runs when a
    // watched panel resizes, the window resizes, flight toggles, or as a slow 1 s safety net.
    frameN++; var ln=performance.now(), fo=flightOn();
    if(layoutDirty||fo!==lastFlight||ln-layoutT>=LAYOUT_MS){ layoutDirty=false; lastFlight=fo; layoutT=ln; layout(); watch(); }
    if(artDirty){ artDirty=false; buildArt(); txtGeoDirty=true; }
    if(txtGeoDirty){ txtGeoDirty=false; buildText(); txtT=0; }
    // (v149) readouts + minimap re-upload at most ~15 Hz (was every frame: a full texture upload per frame)
    var tn=performance.now(); if(tn-txtT>=66){ txtT=tn; updateText(); if(mm.visible&&mm.material.map) mm.material.map.needsUpdate=true; }
    // (v148) the old 30-frame / 1 s watchdog ran while the panels were still rasterizing (no art = nothing to draw),
    // so a tablet/phone whose first raster took >1 s always fell back to CSS. Now: the DOM stays visible until a
    // mesh frame draws OK; only a render throw or no art at all after 15 s (raster stall) falls back.
    if(!drewOK&&!arHeld&&panels.size){ if(!wdT0) wdT0=performance.now(); wdFrames++; var anyArt=false; panels.forEach(function(P){ if(P.ready) anyArt=true; });
      if(!anyArt&&performance.now()-wdT0>WD_MS){ fallback('no panel art after '+Math.round(performance.now()-wdT0)+' ms (raster stall, painter '+painter+')'); return; } }
    if(arHeld||!(art.visible||txt.visible||mm.visible)) return;
    var vw=innerWidth, vh=innerHeight, d=(vh/2)/Math.tan(FOV/2*Math.PI/180);
    cam.aspect=vw/vh; cam.near=d*0.5; cam.far=d*2; cam.position.set(0,0,d); cam.updateProjectionMatrix();
    var ac=R.autoClear, ok=false; R.autoClear=false;
    try{ R.clearDepth&&R.clearDepth(); R.render(scene,cam); ok=true; }
    catch(e){ R.autoClear=ac; fallback('render threw: '+(e&&e.message)); return; }
    finally { R.autoClear=ac; }
    if(ok){ drewOK=true; ghostDrawn(); }
  }
  // AR / camera passthrough: draw the HUD group on another renderer (layout/text keep updating in overlay())
  function drawTo(R){ if(!ready||!on()||!(art.visible||txt.visible||mm.visible)) return false;
    if(root.parent!==scene) scene.add(root);
    var vw=innerWidth, vh=innerHeight, d=(vh/2)/Math.tan(FOV/2*Math.PI/180);
    cam.aspect=vw/vh; cam.near=d*0.5; cam.far=d*2; cam.position.set(0,0,d); cam.updateProjectionMatrix();
    var ac=R.autoClear; R.autoClear=false; try{ R.clearDepth&&R.clearDepth(); R.render(scene,cam); drewOK=true; ghostDrawn(); } finally { R.autoClear=ac; } return true;   // drewOK only after R.render returned without throwing
  }
  function stop(){ panels.forEach(function(P,el){ el.classList.remove('dm-ui3d-ghost'); }); panels.clear(); var me=document.getElementById('minimap'); me&&me.classList.remove('dm-ui3d-ghost');
    drewOK=false; wdFrames=0; wdT0=0; if(ready){ art.visible=txt.visible=mm.visible=false; } document.body.classList.remove('dm-ui3d-mesh'); }

  window.DMUI3DMesh={
    get active(){ return on()&&ready&&!!(art&&(art.visible||txt.visible)); }, get mesh(){ return root; }, get scene(){ return scene; }, get camera(){ return cam; },
    overlay:overlay, drawTo:drawTo, _paintSafe:function(el){ var r=el.getBoundingClientRect(); return paintSafe({el:el,w:Math.ceil(r.width),h:Math.ceil(r.height)}).then(function(c){ return c.toDataURL(); }); },
    // what is really on screen: 'mesh' (WebGPU overlay drew OK), 'css' (tilt fallback / opt-out), 'flat'
    get status(){ var m=mode==='0'||(window.DMUI3D&&DMUI3D.enabled===false)?'flat':(on()&&ready&&drewOK)?'mesh':(on()?'mesh?':'css');
      return {mode:m, reason:why0, painter:painter, pending:on()&&!drewOK?Math.round(wdT0?performance.now()-wdT0:0):0}; },
    setMode:function(m){ mode=m; try{ localStorage.setItem('dm.ui3d',m); }catch(e){} if(!on()) stop(); else if(ready) document.body.classList.add('dm-ui3d-mesh'); if(window.DMUI3D) DMUI3D.refresh(); },
    // AR: ui/dm-ar-core.js draws `mesh` itself on a head-locked plate; on release it goes back here
    arHold:function(h){ arHeld=!!h; if(!h&&root&&scene&&root.parent!==scene) scene.add(root); },
    _stats:function(){ var o=[]; panels.forEach(function(P){ o.push({cls:P.el.className,ready:P.ready,leaves:P.leaves.length}); }); return {on:on(),painter:painter,why:why0,ready:ready,frames:frameN,paints:paints,drewOK:drewOK,panels:o,minimap:!!(mm&&mm.visible)}; }
  };
})();
