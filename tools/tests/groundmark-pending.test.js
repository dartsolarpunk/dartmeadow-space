// receivers handed to DMGroundMark before the projectors can be built must attach later, not be dropped
const fs=require('fs'), vm=require('vm');
const src=fs.readFileSync(__dirname+'/../../ui/dm-groundmark.js','utf8');
const got=[]; const win={THREE:{},location:{search:''}};
win.window=win; const ctx=vm.createContext(win);
vm.runInContext(src,ctx);
const G=win.DMGroundMark; let fails=0; const ok=(c,m)=>{ if(!c){ fails++; console.log('FAIL',m); } };
ok(!!G,'DMGroundMark exported');
const m1={isNodeMaterial:true}, m2={isNodeMaterial:true};
ok(G.receive(m1)===false&&G.receive(m2)===false,'dropped nothing silently: returns false before projectors exist');
ok(G._pend.length===2,'both remembered'); G.receive(m1); ok(G._pend.length===2,'no duplicates');
win.uniform=function(){ return {value:0}; };
win.DMProjector={create:()=>({}),receive:(m)=>{ got.push(m); return true; }};
ok(G._flushPend()===2&&got.length===2&&G._pend.length===0,'flush attaches the early materials');
console.log(fails?fails+' FAILED':'groundmark-pending: all passed'); process.exit(fails?1:0);
