/* DART Meadow — 3D HUD meshes (crunch 2), opt-in: localStorage 'dm.ui3d'='mesh'.
   Default stays the CSS tilt (ui/dm-ui3d-core.js); '0' = flat.

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
  var MAX_DEG=9, LAYERS=3, DEPTH=6, ATLAS=2048, TATLAS=1024, PAD=2, LAYOUT_EVERY=20;
  var PROPS=['display','position','left','top','right','bottom','width','height','min-width','min-height','max-width','max-height',
    'margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left','box-sizing',
    'border-top','border-right','border-bottom','border-left','border-radius','background-color','background-image','background-size','background-position','background-repeat',
    'color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','text-shadow','white-space','text-overflow','overflow',
    'opacity','box-shadow','clip-path','transform','transform-origin','rotate','scale','translate','flex','flex-direction','flex-wrap','align-items','justify-content','gap','grid-template-columns',
    'z-index','visibility','fill','stroke','stroke-width','stroke-dasharray','stroke-dashoffset','font-variant-numeric','vertical-align','filter','mix-blend-mode','inset','object-fit'];
  var mode=(function(){ try{ return localStorage.getItem('dm.ui3d'); }catch(e){ return null; } })();
  function on(){ return mode==='mesh'; }

  var st=document.createElement('style'); st.textContent=
    'body.dm-ui3d-mesh .dm-ui3d-ghost{opacity:0!important;rotate:none!important;filter:none!important}';
  document.head.appendChild(st);

  var T=null, root=null, scene=null, cam=null, art=null, txt=null, mm=null, aCv, aCx, aTex, tCv, tCx, tTex;
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
    if(relay){ sx=sy=sh=0; panels.forEach(function(P){ P.slot=alloc(P.w,P.h,ATLAS); }); aCx.clearRect(0,0,ATLAS,ATLAS); panels.forEach(function(P){ P.ready=false; }); artDirty=true; }
    panels.forEach(function(P){ if(!P.ready&&!P.busy&&P.slot) paint(P); });
    // minimap: live canvas texture
    var mc=document.getElementById('minimap-canvas'), mr=mc&&flightOn()&&visible(document.getElementById('minimap')||mc);
    if(mr){ if(!mm.material.map||mm.material.map.image!==mc){ mm.material.map=new T.CanvasTexture(mc); mm.material.map.colorSpace=T.SRGBColorSpace; mm.material.needsUpdate=true; }
      var t=tilt(mr); mm.position.set(t.cx,t.cy,1); mm.quaternion.copy(t.q); mm.scale.set(mr.width,mr.height,1); mm.visible=true; mm.userData.el=document.getElementById('minimap'); mm.userData.el&&mm.userData.el.classList.add('dm-ui3d-ghost'); }
    else if(mm.visible){ mm.visible=false; var me=document.getElementById('minimap'); me&&me.classList.remove('dm-ui3d-ghost'); }
  }
  function paint(P){ P.busy=true; var gen=P.sig;
    raster(P.el,P.w,P.h).then(function(img){ if(P.sig!==gen||!P.slot) return; aCx.clearRect(P.slot.x,P.slot.y,P.w,P.h); aCx.drawImage(img,P.slot.x,P.slot.y,P.w,P.h); P.ready=true; artDirty=true; P.el.classList.add('dm-ui3d-ghost'); })
      .catch(function(e){ console.warn('[UI3D] raster',e&&e.message); }).finally(function(){ P.busy=false; }); }

  // ---------- static art geometry: ONE merged buffer ----------
  function buildArt(){
    var rd=[]; panels.forEach(function(P){ if(P.ready&&P.slot) rd.push(P); });
    var nQ=rd.length*(LAYERS+1), pos=new Float32Array(nQ*12), uv=new Float32Array(nQ*8), col=new Float32Array(nQ*12), idx=new Uint32Array(nQ*6), q=0, v=new T.Vector3();
    rd.forEach(function(P){ var t=tilt(P.rect), w=P.rect.width/2, h=P.rect.height/2;
      var u0=P.slot.x/ATLAS, u1=(P.slot.x+P.w)/ATLAS, v0=1-(P.slot.y+P.h)/ATLAS, v1=1-P.slot.y/ATLAS;
      for(var L=LAYERS;L>=0;L--){ var z=-DEPTH*L/LAYERS, sh=L===0?1:0.32-0.05*L, ox=L?t.nx*L*0.6:0, oy=L?-t.ny*L*0.4:0, cs=[[-w,-h],[w,-h],[w,h],[-w,h]];
        for(var k=0;k<4;k++){ v.set(cs[k][0]+ox,cs[k][1]+oy,z).applyQuaternion(t.q); pos.set([v.x+t.cx,v.y+t.cy,v.z],q*12+k*3); col.set([sh,sh,sh],q*12+k*3); }
        uv.set([u0,v0,u1,v0,u1,v1,u0,v1],q*8); var b=q*4; idx.set([b,b+1,b+2,b,b+2,b+3],q*6); q++; } });
    setGeo(art,pos,uv,col,idx); aTex.needsUpdate=true;   // the atlas upload happens only here (layout change)
  }
  function setGeo(m,pos,uv,col,idx){ var g=new T.BufferGeometry(); g.setAttribute('position',new T.BufferAttribute(pos,3)); g.setAttribute('uv',new T.BufferAttribute(uv,2)); if(col) g.setAttribute('color',new T.BufferAttribute(col,3)); g.setIndex(new T.BufferAttribute(idx,1)); m.geometry.dispose(); m.geometry=g; m.visible=idx.length>0; }

  // ---------- live text: per-leaf slot in the text atlas, redrawn only when its value changes ----------
  var DPR=1.5;
  function buildText(){
    var all=[]; panels.forEach(function(P){ if(P.ready) P.leaves.forEach(function(L){ L.P=P; all.push(L); }); });
    sx=sy=sh=0; tCx.clearRect(0,0,TATLAS,TATLAS);
    var pos=new Float32Array(all.length*12), uv=new Float32Array(all.length*8), idx=new Uint32Array(all.length*6), v=new T.Vector3(), q=0;
    all.forEach(function(L){ var w=Math.ceil(L.r.width*DPR)+8, h=Math.ceil(L.r.height*DPR)+8; L.slot=alloc(w,h,TATLAS); L.sw=w; L.sh=h; L.text=null; if(!L.slot) return;
      var t=tilt(L.P.rect), pc={x:L.P.rect.left+L.P.rect.width/2-innerWidth/2, y:innerHeight/2-(L.P.rect.top+L.P.rect.height/2)};
      var lx=L.r.left+L.r.width/2-innerWidth/2-pc.x, ly=innerHeight/2-(L.r.top+L.r.height/2)-pc.y, hw=w/DPR/2, hh=h/DPR/2, cs=[[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]];
      for(var k=0;k<4;k++){ v.set(lx+cs[k][0],ly+cs[k][1],0.5).applyQuaternion(t.q); pos.set([v.x+t.cx,v.y+t.cy,v.z],q*12+k*3); }
      var u0=L.slot.x/TATLAS, u1=(L.slot.x+w)/TATLAS, v0=1-(L.slot.y+h)/TATLAS, v1=1-L.slot.y/TATLAS; uv.set([u0,v0,u1,v0,u1,v1,u0,v1],q*8); var b=q*4; idx.set([b,b+1,b+2,b,b+2,b+3],q*6); q++; });
    setGeo(txt,pos,uv,null,idx.subarray(0,q*6)); txt.userData.leaves=all;
  }
  function drawLeaf(L,s){
    var cs=getComputedStyle(L.el), x=L.slot.x, y=L.slot.y; tCx.clearRect(x,y,L.sw,L.sh);
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
  function setup(){
    T=window.THREE; if(!T) return false;
    root=new T.Group(); scene=new T.Scene(); scene.add(root); cam=new T.PerspectiveCamera(30,1,1,10);
    aCv=document.createElement('canvas'); aCv.width=aCv.height=ATLAS; aCx=aCv.getContext('2d');
    tCv=document.createElement('canvas'); tCv.width=tCv.height=TATLAS; tCx=tCv.getContext('2d');
    function tx(c){ var t=new T.CanvasTexture(c); t.colorSpace=T.SRGBColorSpace; t.generateMipmaps=false; t.minFilter=T.LinearFilter; return t; }
    aTex=tx(aCv); tTex=tx(tCv);
    function mat(map,vc){ var m=new T.MeshBasicNodeMaterial({map:map,vertexColors:!!vc,transparent:true,depthWrite:false,depthTest:false,side:T.DoubleSide}); m.toneMapped=false; return m; }
    art=new T.Mesh(new T.BufferGeometry(),mat(aTex,true)); art.renderOrder=1;
    txt=new T.Mesh(new T.BufferGeometry(),mat(tTex,false)); txt.renderOrder=2;
    mm=new T.Mesh(new T.PlaneGeometry(1,1),mat(null,false)); mm.renderOrder=1; mm.visible=false;
    [art,txt,mm].forEach(function(m){ m.frustumCulled=false; root.add(m); });
    document.body.classList.add('dm-ui3d-mesh'); ready=true; return true;
  }
  function overlay(R){
    if(!on()) return; if(!ready&&!setup()) return;
    if(frameN++%LAYOUT_EVERY===0) layout();
    if(artDirty){ artDirty=false; buildArt(); txtGeoDirty=true; }
    if(txtGeoDirty){ txtGeoDirty=false; buildText(); }
    updateText(); if(mm.visible&&mm.material.map) mm.material.map.needsUpdate=true;
    if(arHeld||!(art.visible||txt.visible||mm.visible)) return;
    var vw=innerWidth, vh=innerHeight, d=(vh/2)/Math.tan(15*Math.PI/180);
    cam.aspect=vw/vh; cam.near=d*0.5; cam.far=d*2; cam.position.set(0,0,d); cam.updateProjectionMatrix();
    var ac=R.autoClear; R.autoClear=false;
    try{ R.clearDepth&&R.clearDepth(); R.render(scene,cam); } finally { R.autoClear=ac; }
  }
  function stop(){ panels.forEach(function(P,el){ el.classList.remove('dm-ui3d-ghost'); }); panels.clear(); var me=document.getElementById('minimap'); me&&me.classList.remove('dm-ui3d-ghost');
    if(ready){ art.visible=txt.visible=mm.visible=false; } document.body.classList.remove('dm-ui3d-mesh'); }

  window.DMUI3DMesh={
    get active(){ return on()&&ready&&!!(art&&(art.visible||txt.visible)); }, get mesh(){ return root; }, get scene(){ return scene; }, get camera(){ return cam; },
    overlay:overlay,
    setMode:function(m){ mode=m; try{ localStorage.setItem('dm.ui3d',m); }catch(e){} if(!on()) stop(); else if(ready) document.body.classList.add('dm-ui3d-mesh'); if(window.DMUI3D) DMUI3D.refresh(); },
    // AR: ui/dm-ar-core.js draws `mesh` itself on a head-locked plate; on release it goes back here
    arHold:function(h){ arHeld=!!h; if(!h&&root&&scene&&root.parent!==scene) scene.add(root); },
    _stats:function(){ var o=[]; panels.forEach(function(P){ o.push({cls:P.el.className,ready:P.ready,leaves:P.leaves.length}); }); return {on:on(),ready:ready,frames:frameN,panels:o,minimap:!!(mm&&mm.visible)}; }
  };
})();
