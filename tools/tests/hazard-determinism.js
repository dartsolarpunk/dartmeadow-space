// node tools/tests/hazard-determinism.js
// ui/dm-hazardbubble.js: the habitable/toxic flag comes from its OWN stream (hash('hab:'+seed)); it must be
// deterministic per seed, must not consume or perturb Math.random / any shared RNG, and Sol bodies are fixed.
const fs=require('fs'), vm=require('vm');
const src=fs.readFileSync(__dirname+'/../../ui/dm-hazardbubble.js','utf8');
const win={addEventListener(){}}; const ctx={window:win,console,Math:Object.create(Math)};
let randCalls=0; ctx.Math.random=()=>{ randCalls++; return 0.5; };
vm.createContext(ctx); vm.runInContext(src,ctx);
const H=win.DM_HAZ; let bad=0; const ck=(c,m)=>{ if(!c){ bad++; console.log('FAIL',m); } };
for(const n of ['Mars','Titan','Moon','Venus','Pluto']) ck(H.habitable({name:n})===false,n+' not habitable');
for(const n of ['Earth','Solenne']) ck(H.habitable({name:n})===true,n+' habitable');
ck(H.habitable({name:'x',habitable:false,type:'Habitable',mcSeed:1})===false,'explicit flag wins');
ck(H.kind({name:'Mars'},{atmos:true})==='toxic','Mars toxic'); ck(H.kind({name:'Moon'},{atmos:false})==='airless','Moon airless'); ck(H.kind({name:'Earth'},{atmos:true})==='breathable','Earth breathable');
const types=['Habitable','Ocean','Desert','Rocky','Ice','Volcanic','Methane'], cnt={};
for(const t of types){ let y=0; for(let s=1;s<=2000;s++){ const a=H.habitable({name:'p'+s,type:t,mcSeed:s*7919}), b=H.habitable({name:'q'+s,type:t,mcSeed:s*7919}); ck(a===b,'deterministic '+t+s); if(a) y++; } cnt[t]=y/2000; }
ck(cnt.Habitable>0.85&&cnt.Habitable<0.95,'Habitable ~0.9 '+cnt.Habitable); ck(cnt.Volcanic===0&&cnt.Methane===0,'volcanic/methane never'); ck(cnt.Ocean>0.6&&cnt.Ocean<0.8,'Ocean ~0.7');
ck(randCalls===0,'Math.random untouched ('+randCalls+')');
console.log(bad?'FAILED '+bad:'OK',JSON.stringify(cnt)); process.exit(bad?1:0);
