#!/bin/bash
# Compress the staged GLBs in place: dedup + prune, WebP textures (<=1024px), and (static places only) KHR_mesh_quantization.
# Skinned creatures are NOT quantized (quantization moves a scale onto the mesh node, which skinning ignores). LOD node names
# and node hierarchy are kept (no flatten/join/instance/simplify). The game's GLTFLoader reads EXT_texture_webp + KHR_mesh_quantization natively
# (no Draco/meshopt decoder needed).  Usage: tools/places/compress_glbs.sh   (needs node + `npm i @gltf-transform/cli sharp`)
set -e; cd "$(dirname "$0")/../.."
OPT="--texture-compress webp --texture-size 1024 --simplify false --flatten false --join false --instance false --palette false --weld false"
for f in assets/places/*.glb;    do npx gltf-transform optimize "$f" "$f.tmp" --compress quantize $OPT >/dev/null && mv "$f.tmp" "$f"; done
for f in assets/creatures/*.glb; do npx gltf-transform optimize "$f" "$f.tmp" --compress false  $OPT >/dev/null && mv "$f.tmp" "$f"; done
