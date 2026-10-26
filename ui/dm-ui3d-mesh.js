/* DART Meadow — 3D HUD meshes (crunch 2).
   The vector UI (kite, side frames, mini kites on the terrain / flight HUDs, main-menu
   panels, loading-screen cluster) is drawn as real three.js geometry: each panel is
   rasterized from its own live DOM/SVG (SVG foreignObject, so it is pixel-for-pixel the
   vector look) into ONE shared atlas texture, and all panels are merged into ONE mesh =
   one draw call, on its own overlay canvas. Each panel is a stack of quads (front face +
   3 darkened layers behind it) = a thin extrusion that follows the panel's real outline
   (kite diamond, not a box), and is turned about its centre by a tilt taken from its
   place on screen, seen through a perspective camera set so z=0 maps 1:1 to CSS pixels.
   The DOM panels stay exactly where they are at opacity 0, so every tap / drag still hits
   the real element. Panels re-rasterize only when their content changes (throttled,
   one panel per tick), the mesh rebuilds only on layout changes, and the overlay draws
   only when something changed. In AR (ui/dm-ar-core.js) the same mesh is drawn on a
   head-locked plate in front of the camera.
   Modes (localStorage 'dm.ui3d'): 'mesh' (default above the low preset), 'css' (the
   cheaper tilt-only fallback, ui/dm-ui3d-core.js; default on low), '0' (flat).
   Not converted (stay DOM with the CSS tilt): joysticks and the minimap (they move every
   frame, a raster round-trip would lag them), modals and dialogs. */
(function(){
  'use strict';
  if(window.DMUI3DMesh) return;
  var TARGETS=['#ls-ui-cluster','.mm-panel','.hud-c','.hud-l','.hud-r','.mini-kite'];
  var MAX_DEG=9, LAYERS=3, DEPTH=6, ATLAS=2048, PAD=2, MIN_MS=450;
  var PROPS=['display','position','left','top','right','bottom','width','height','min-width','min-height','max-width','max-height',
    'margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left','box-sizing',
    'border-top','border-right','border-bottom','border-left','border-radius','background-color','background-image','background-size','background-position','background-repeat',
    'color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-transform','text-shadow','white-space','text-overflow','overflow',
    'opacity','box-shadow','clip-path','transform','transform-origin','rotate','scale','translate','flex','flex-direction','flex-wrap','align-items','justify-content','gap','grid-template-columns',
    'z-index','visibility','fill','stroke','stroke-width','stroke-dasharray','stroke-dashoffset','font-variant-numeric','vertical-align','filter','mix-blend-mode','inset','object-fit'];
  var mode=(function(){ try{ return localStorage.getItem('dm.ui3d'); }catch(e){ return null; } })();
  function lowPreset(){ var G=null; try{ G=(0,eval)('typeof GFX!=="undefined"?GFX:null'); }catch(e){} return !!(G&&(G.preset==='low')); }
  function wantMesh(){ if(mode==='0'||mode==='css') return false; if(mode==='mesh') return true; return !lowPreset(); }

  var st=document.createElement('style'); st.textContent=
    'body.dm-ui3d-mesh .dm-ui3d-ghost{opacity:0!important;rotate:none!important;filter:none!important}'+
    '#dm-ui3d-canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:45}';
  document.head.appendChild(st);

  var R=null, scene, cam, mesh, mat, atlasCv, atlasCx, tex, panels=new Map(), dirty=true, raf=0, imgCache=new Map(), started=false, arHold=false;

  // ---------- raster ----------
  function inlineImg(src){ if(imgCache.has(src)) return imgCache.get(src);
    var p=fetch(src).then(function(r){ return r.blob(); }).then(function(b){ return new Promise(function(res){ var fr=new FileReader(); fr.onload=function(){ res(fr.result); }; fr.readAsDataURL(b); }); }).catch(function(){ return src; });
    imgCache.set(src,p); return p; }
  function copyStyle(o,c){ var cs=getComputedStyle(o), s=c.style; for(var i=0;i<PROPS.length;i++){ var v=cs.getPropertyValue(PROPS[i]); if(v) s.setProperty(PROPS[i],v); } }
  function within(p,ms,what){ return Promise.race([p,new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('timeout '+what)); },ms); })]); }
  async function raster(el,w,h){
    var c=el.cloneNode(true), os=[el], cs=[c];
    for(var k=0;k<os.length;k++){ var a=os[k].children, b=cs[k].children; for(var i=0;i<a.length&&i<b.length;i++){ os.push(a[i]); cs.push(b[i]); } }
    for(var j=0;j<os.length;j++){ if(!(os[j] instanceof SVGElement)||os[j].tagName.toLowerCase()==='svg') copyStyle(os[j],cs[j]); }
    var rs=c.style; rs.position='relative'; rs.left=rs.top='0'; rs.right=rs.bottom='auto'; rs.margin='0'; rs.transform='none'; rs.rotate='none'; rs.scale='none'; rs.translate='none'; rs.filter='none'; rs.opacity='1'; rs.width=w+'px'; rs.height=h+'px';
    c.classList.remove('dm-ui3d-ghost','dm-ui3d-p');
    var imgs=c.querySelectorAll('img'); for(var m=0;m<imgs.length;m++){ var src=imgs[m].currentSrc||imgs[m].src; if(src&&!/^data:/.test(src)) imgs[m].setAttribute('src',await within(inlineImg(src),4000,'img').catch(function(){ return src; })); }
    c.querySelectorAll('canvas,script,video,iframe').forEach(function(n){ n.remove(); });
    var xml=new XMLSerializer().serializeToString(c);
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:'+w+'px;height:'+h+'px;overflow:hidden">'+xml+'</div></foreignObject></svg>';
    var img=new Image(); img.decoding='async';
    await within(new Promise(function(res,rej){ img.onload=res; img.onerror=rej; img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg); }),8000,'decode');
    return img;
  }

  // ---------- layout ----------
  function collect(){
    var out=[], seen=new Set();
    document.querySelectorAll(TARGETS.join(',')).forEach(function(el){
      if(seen.has(el)) return; for(var p=el.parentElement;p;p=p.parentElement) if(seen.has(p)) return;
      if(el.closest('#dm-ar-toast')) return;
      var r=el.getBoundingClientRect(); if(r.width<8||r.height<8) return;
      var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return;
      // something (a modal, a menu) drawn over it: leave it to the DOM
      // a modal / dialog drawn over it: leave it to the DOM (HUD panels are often pointer-events:none, so
      // elementFromPoint falls through them to the game canvas — only real dialogs count as covering)
      var top=document.elementFromPoint(r.left+r.width/2,r.top+Math.min(r.height/2,20));
      if(top&&!el.contains(top)&&top.closest&&top.closest('[class*="modal"],[id*="modal"],[role="dialog"],dialog')) return;
      seen.add(el); out.push({el:el,r:r});
    });
    return out;
  }
  var shelfX=0, shelfY=0, shelfH=0;
  function alloc(w,h){ if(shelfX+w>ATLAS){ shelfX=0; shelfY+=shelfH+PAD; shelfH=0; } if(shelfY+h>ATLAS) return null; var a={x:shelfX,y:shelfY}; shelfX+=w+PAD; shelfH=Math.max(shelfH,h); return a; }

  function sync(){
    if(!R) return;
    var list=collect(), keep=new Set(), relayout=false;
    list.forEach(function(it){
      var el=it.el, P=panels.get(el), sig=[it.r.left,it.r.top,it.r.width,it.r.height].map(Math.round).join(',');
      if(!P){ P={el:el,sig:'',slot:null,ready:false,dirty:true,last:0,mo:null}; panels.set(el,P);
        P.mo=new MutationObserver(function(){ P.dirty=true; }); P.mo.observe(el,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','src','d','points','stroke-dashoffset']}); }
      if(P.sig!==sig){ P.sig=sig; P.rect=it.r; P.dirty=true; relayout=true; }
      keep.add(el);
    });
    panels.forEach(function(P,el){ if(!keep.has(el)){ el.classList.remove('dm-ui3d-ghost'); if(P.mo) P.mo.disconnect(); panels.delete(el); relayout=true; } });
    if(relayout){ shelfX=shelfY=shelfH=0; panels.forEach(function(P){ var w=Math.ceil(P.el.offsetWidth||P.rect.width), h=Math.ceil(P.el.offsetHeight||P.rect.height); P.w=w; P.h=h; P.slot=alloc(w,h); P.dirty=true; }); rebuild(); }
    // one raster per tick, oldest dirty first
    var now=performance.now(), pick=null; panels.forEach(function(P){ if(P.dirty&&!P.busy&&now-P.last>MIN_MS&&P.slot&&(!pick||P.last<pick.last)) pick=P; });
    if(pick){ pick.busy=true; pick.dirty=false; pick.last=now;
      raster(pick.el,pick.w,pick.h).then(function(img){ atlasCx.clearRect(pick.slot.x,pick.slot.y,pick.w,pick.h); atlasCx.drawImage(img,pick.slot.x,pick.slot.y,pick.w,pick.h);
        tex.needsUpdate=true; if(!pick.ready){ pick.ready=true; pick.el.classList.add('dm-ui3d-ghost'); rebuild(); } kick(); })
      .catch(function(e){ console.warn('[UI3D] raster failed',(pick.el.id||pick.el.className),e&&(e.message||e.type||e)); pick.fail=(pick.fail||0)+1; if(pick.fail>2){ pick.slot=null; } })
      .finally(function(){ pick.busy=false; }); }
  }

  // ---------- geometry: every ready panel → LAYERS+1 quads in ONE buffer ----------
  function rebuild(){
    if(!R) return; var T=window.THREE, vw=innerWidth, vh=innerHeight;
    var ready=[]; panels.forEach(function(P){ if(P.ready&&P.slot) ready.push(P); });
    var nQ=ready.length*(LAYERS+1), pos=new Float32Array(nQ*12), uv=new Float32Array(nQ*8), col=new Float32Array(nQ*12), idx=new Uint32Array(nQ*6);
    var q=0, v=new T.Vector3(), rot=new T.Quaternion(), ax=new T.Vector3();
    ready.forEach(function(P){
      var r=P.rect, cx=r.left+r.width/2-vw/2, cy=vh/2-(r.top+r.height/2), w=r.width/2, h=r.height/2;
      var nx=Math.max(-1,Math.min(1,cx/(vw/2))), ny=Math.max(-1,Math.min(1,cy/(vh/2)));
      ax.set(-ny*0.8,-nx,0); var ang=ax.length()*MAX_DEG*Math.PI/180; if(ax.lengthSq()>1e-6){ ax.normalize(); rot.setFromAxisAngle(ax,-ang); } else rot.identity();
      var u0=P.slot.x/ATLAS, u1=(P.slot.x+P.w)/ATLAS, v0=1-(P.slot.y+P.h)/ATLAS, v1=1-P.slot.y/ATLAS;
      for(var L=LAYERS;L>=0;L--){ // back to front
        var z=-DEPTH*L/LAYERS, shade=L===0?1:0.32-0.05*L, ox=L?nx*L*0.6:0, oy=L?-ny*L*0.4:0;
        var cs=[[-w,-h],[w,-h],[w,h],[-w,h]];
        for(var k=0;k<4;k++){ v.set(cs[k][0]+ox,cs[k][1]+oy,z).applyQuaternion(rot); pos.set([v.x+cx,v.y+cy,v.z],q*12+k*3); col.set([shade,shade,shade],q*12+k*3); }
        uv.set([u0,v0,u1,v0,u1,v1,u0,v1],q*8); var b=q*4; idx.set([b,b+1,b+2,b,b+2,b+3],q*6); q++;
      }
    });
    var g=new T.BufferGeometry(); g.setAttribute('position',new T.BufferAttribute(pos,3)); g.setAttribute('uv',new T.BufferAttribute(uv,2)); g.setAttribute('color',new T.BufferAttribute(col,3)); g.setIndex(new T.BufferAttribute(idx,1));
    if(mesh.geometry) mesh.geometry.dispose(); mesh.geometry=g; mesh.visible=nQ>0;
    // camera: z=0 plane is 1:1 with CSS pixels
    var fov=30, d=(vh/2)/Math.tan(fov*Math.PI/360); cam.fov=fov; cam.aspect=vw/vh; cam.near=d*0.5; cam.far=d*2; cam.position.set(0,0,d); cam.updateProjectionMatrix();
    R.setSize(vw,vh,false); kick();
  }
  function kick(){ dirty=true; }
  function loop(){ raf=requestAnimationFrame(loop); if(!R||arHold) return; if((loop.n=(loop.n||0)+1)%6===0) sync(); if(dirty){ dirty=false; R.render(scene,cam); } }

  async function start(){
    if(started||!wantMesh()) return; var T=window.THREE; if(!T||!T.WebGPURenderer) return setTimeout(start,800);
    started=true;
    var cv=document.createElement('canvas'); cv.id='dm-ui3d-canvas'; document.body.appendChild(cv);
    R=new T.WebGPURenderer({canvas:cv,alpha:true,antialias:true,powerPreference:'low-power'});
    try{ await R.init(); }catch(e){ console.warn('[UI3D] mesh renderer failed, CSS fallback',e); R=null; cv.remove(); return; }
    R.setPixelRatio(Math.min(2,devicePixelRatio||1)); R.setClearColor(0,0);
    scene=new T.Scene(); cam=new T.PerspectiveCamera(30,1,1,10);
    atlasCv=document.createElement('canvas'); atlasCv.width=atlasCv.height=ATLAS; atlasCx=atlasCv.getContext('2d');
    tex=new T.CanvasTexture(atlasCv); tex.colorSpace=T.SRGBColorSpace; tex.generateMipmaps=false; tex.minFilter=T.LinearFilter;
    mat=new T.MeshBasicNodeMaterial({map:tex,vertexColors:true,transparent:true,depthWrite:false,depthTest:false,side:T.DoubleSide});
    mesh=new T.Mesh(new T.BufferGeometry(),mat); mesh.frustumCulled=false; scene.add(mesh);
    document.body.classList.add('dm-ui3d-mesh');
    addEventListener('resize',function(){ panels.forEach(function(P){ P.sig=''; }); },{passive:true});
    loop();
  }
  function stop(){ cancelAnimationFrame(raf); panels.forEach(function(P,el){ el.classList.remove('dm-ui3d-ghost'); P.mo&&P.mo.disconnect(); }); panels.clear(); document.body.classList.remove('dm-ui3d-mesh');
    if(R){ try{ R.dispose(); }catch(e){} var c=document.getElementById('dm-ui3d-canvas'); c&&c.remove(); R=null; } started=false; }

  window.DMUI3DMesh={
    get active(){ return !!R&&!!mesh&&mesh.visible; }, get mesh(){ return mesh; }, get scene(){ return scene; }, get camera(){ return cam; },
    setMode:function(m){ mode=m; try{ localStorage.setItem('dm.ui3d',m); }catch(e){} if(wantMesh()) start(); else stop(); if(window.DMUI3D) DMUI3D.refresh(); },
    // AR: pause the overlay canvas; ui/dm-ar-core.js draws `mesh` itself on a head-locked plate
    arHold:function(on){ arHold=!!on; if(!on) kick(); },
    sync:function(){ sync(); },
    _stats:function(){ var o=[]; panels.forEach(function(P){ o.push({id:P.el.id||P.el.className,w:P.w,h:P.h,slot:!!P.slot,ready:P.ready,fail:P.fail||0,busy:!!P.busy}); }); return o; }
  };
  function boot(){ setTimeout(start,1200); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
