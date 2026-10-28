/* DART Meadow — iPhone Safari / WebKit polish (behaviour half; styles are in dm-webkit.css).
 * iOS-only quirks that cannot be expressed in CSS. Safe on every browser: each hook is feature-gated. */
(function(){
  'use strict';
  const iOS=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  if(!iOS) return;
  // `user-scalable=no` is ignored by iOS Safari since iOS 10: pinching a HUD button zooms the whole page and
  // strands it zoomed. Safari fires these proprietary gesture events for exactly that; cancelling them stops the zoom
  // without touching the canvases' own two-finger handling (those use touch events).
  const stop=e=>{ if(e.cancelable) e.preventDefault(); };
  ['gesturestart','gesturechange','gestureend'].forEach(t=>document.addEventListener(t,stop,{passive:false}));
  // Focusing the chat/sign-in field makes iOS scroll the (overflow:hidden) page to keep it above the keyboard and it
  // stays scrolled after the keyboard closes — pull the layout back.
  const reset=()=>{ setTimeout(()=>{ try{ if(window.scrollX||window.scrollY) window.scrollTo(0,0); }catch(e){} },60); };
  document.addEventListener('focusout',reset,true);
  window.addEventListener('orientationchange',reset);
})();
