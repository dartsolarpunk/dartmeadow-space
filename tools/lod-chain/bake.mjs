#!/usr/bin/env node
/* Offline LOD chain for a GLB node (far-range LOD, tools/ only - nothing here runs in the browser).
 *
 *   cd tools/lod-chain && npm install
 *   node bake.mjs <in.glb> <out.glb> [--node Mansion_LOD1] [--ratios 0.5,0.25,0.12] [--errors 0.6,1.6,4] [--inplace]
 *
 * For each ratio it adds a sibling node  <node>_E<k>  that shares the source's vertex buffers (no new vertex data: only a new, shorter INDEX buffer per primitive,
 * made with meshoptimizer's attribute-aware simplifier - uv and normals weighted so texture seams and creases hold) and the same materials.  Each added node carries
 *   extras: { dmError: <max geometric error in scene units (metres), absolute>, dmTris: <triangles>, dmChainOf: "<node>" }
 * (GLTFLoader puts extras in node.userData).  Runtime: ui/dm-facilities.js reads  userData.dmError  of the source node and its _E<k> siblings and picks the cheapest level whose
 * error projects to <= lod.tauPx pixels (DMLod.levelByError).  No _E nodes in the GLB = nothing changes at runtime.
 * meshoptimizer: Copyright (C) 2016-2026 Arseny Kapoulkine, MIT.   @gltf-transform: Don McCurdy, MIT.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { fileURLToPath } from 'node:url';

/* simplify one primitive's index list; returns { indices: Uint32Array, error: absolute } */
export function simplifyPrimitive(prim, ratio, opts = {}) {
  const pos = prim.getAttribute('POSITION'), idxAcc = prim.getIndices();
  if (!pos) return null;
  const P = pos.getArray(), n = pos.getCount();
  const I = idxAcc ? Uint32Array.from(idxAcc.getArray()) : Uint32Array.from({ length: n }, (_, i) => i);
  const target = Math.max(3, Math.floor(I.length * ratio / 3) * 3);
  // attributes: normal (weight 1) + uv (weight 0.5) packed into one float array
  const nor = prim.getAttribute('NORMAL'), uv = prim.getAttribute('TEXCOORD_0'), w = [], parts = [];
  if (nor) { parts.push(nor.getArray()); w.push(1, 1, 1); }
  if (uv) { parts.push(uv.getArray()); w.push(0.5, 0.5); }
  const stride = w.length; let out, err;
  if (stride) {
    const A = new Float32Array(n * stride); let o = 0;
    for (let i = 0; i < n; i++) { let k = o; if (nor) { A[k++] = nor.getArray()[i * 3]; A[k++] = nor.getArray()[i * 3 + 1]; A[k++] = nor.getArray()[i * 3 + 2]; } if (uv) { A[k++] = uv.getArray()[i * 2]; A[k++] = uv.getArray()[i * 2 + 1]; } o += stride; }
    [out, err] = MeshoptSimplifier.simplifyWithAttributes(I, P, 3, A, stride, w, null, target, opts.maxError ?? 1e6, ['ErrorAbsolute']);
  } else {
    [out, err] = MeshoptSimplifier.simplify(I, P, 3, target, opts.maxError ?? 1e6, ['ErrorAbsolute']);
  }
  return { indices: out, error: err };
}

function worldScale(node) { const s = node.getWorldMatrix ? node.getWorldMatrix() : null; return s ? Math.cbrt(Math.abs(s[0] * (s[5] * s[10] - s[6] * s[9]) - s[1] * (s[4] * s[10] - s[6] * s[8]) + s[2] * (s[4] * s[9] - s[5] * s[8]))) || 1 : 1; }

/* add <name>_E<k> siblings for each ratio; returns [{name, tris, error}] */
export async function bakeChain(doc, nodeName, ratios, errors) {
  await MeshoptSimplifier.ready;
  const src = doc.getRoot().listNodes().find(n => n.getName() === nodeName);
  if (!src) throw new Error('node not found: ' + nodeName);
  const parent = doc.getRoot().listNodes().find(n => n.listChildren().includes(src)), scene = doc.getRoot().listScenes()[0];
  const report = [];
  ratios.forEach((ratio, k) => {
    const name = nodeName + '_E' + (k + 1);
    let tris = 0, maxErr = 0;
    const clone = (n) => {
      const c = doc.createNode(n === src ? name : n.getName() + '_E' + (k + 1)).setTranslation(n.getTranslation()).setRotation(n.getRotation()).setScale(n.getScale());
      const mesh = n.getMesh();
      if (mesh) {
        const m2 = doc.createMesh(mesh.getName() + '_E' + (k + 1));
        for (const p of mesh.listPrimitives()) {
          const r = simplifyPrimitive(p, ratio, { maxError: errors ? errors[k] / worldScale(n) : undefined }); if (!r) continue;
          const big = r.indices.some(v => v > 65535), acc = doc.createAccessor().setType('SCALAR').setArray(big ? r.indices : Uint16Array.from(r.indices)).setBuffer(p.getIndices() ? p.getIndices().getBuffer() : doc.getRoot().listBuffers()[0]);
          const p2 = doc.createPrimitive().setIndices(acc).setMaterial(p.getMaterial()).setMode(p.getMode());
          for (const s of p.listSemantics()) p2.setAttribute(s, p.getAttribute(s));
          m2.addPrimitive(p2); tris += r.indices.length / 3; maxErr = Math.max(maxErr, r.error * worldScale(n));
        }
        c.setMesh(m2);
      }
      for (const ch of n.listChildren()) c.addChild(clone(ch));
      return c;
    };
    const c = clone(src);
    c.setExtras({ dmError: +maxErr.toFixed(4), dmTris: tris, dmChainOf: nodeName, dmRatio: ratio });
    if (parent) parent.addChild(c); else scene.addChild(c);
    report.push({ name, tris, error: maxErr });
  });
  return report;
}

function triCount(doc, nodeName) { let t = 0; const src = doc.getRoot().listNodes().find(n => n.getName() === nodeName); const walk = n => { const m = n.getMesh(); if (m) for (const p of m.listPrimitives()) t += (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3; n.listChildren().forEach(walk); }; if (src) walk(src); return t; }

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const a = process.argv.slice(2), flag = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const [inp, outp] = a.filter(x => !x.startsWith('--') && !['--node', '--ratios', '--errors'].includes(a[a.indexOf(x) - 1]));
  if (!inp || !outp) { console.error('usage: node bake.mjs <in.glb> <out.glb> [--node N] [--ratios 0.5,0.25,0.12] [--inplace]'); process.exit(2); }
  if (inp === outp && !a.includes('--inplace')) { console.error('refusing to overwrite the input without --inplace'); process.exit(2); }
  const nodeName = flag('--node', 'Mansion_LOD1'), errors = flag('--errors', '0.6,1.6,4').split(',').map(Number), ratios = flag('--ratios', '0.5,0.25,0.12').split(',').map(Number);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS), doc = await io.read(inp);
  const base = triCount(doc, nodeName), rep = await bakeChain(doc, nodeName, ratios, errors);
  await io.write(outp, doc);
  console.log(nodeName + ': ' + base + ' tris');
  for (const r of rep) console.log('  ' + r.name + ': ' + r.tris + ' tris, error <= ' + r.error.toFixed(3) + ' m');
}
