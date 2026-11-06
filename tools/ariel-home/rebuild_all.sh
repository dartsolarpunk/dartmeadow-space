#!/bin/bash
# Full offline rebuild of Ariel's mansion (exterior LOD0/LOD1 desktop + mobile, collision grid, interior GLBs + nav, baked GI, lamp plan).  Blender 4.2+ on PATH or $BLENDER.
#   tools/ariel-home/rebuild_all.sh SCRATCH_DIR            (needs python3 + PIL + numpy + scipy, node >= 18, ffmpeg)
set -e; HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../.."; S="${1:?scratch dir}"; B="${BLENDER:-blender}"; A="$ROOT/assets/ariel-home"
mkdir -p "$S/tex1k" "$S/ext" "$S/atlas" "$S/int"
python3 - "$A/tex" "$S/tex1k" <<'PY'
import sys, os
from PIL import Image
S, D = sys.argv[1:3]
for f in os.listdir(S):
    if f.endswith('-2k.webp'):
        im = Image.open(f'{S}/{f}'); im.resize((1024, 1024), Image.LANCZOS).save(f'{D}/' + f.replace('-2k', '-1k'), 'WEBP', quality=80, method=6); im.save(f'{D}/{f}', 'WEBP', quality=90)
PY
$B -b -P "$HERE/build_mansion.py" -- "$S/tex1k" "$S/ext" > "$S/ext.log" 2>&1
$B -b -P "$HERE/build_mansion.py" -- "$S/tex1k" "$S/ext" --mobile > "$S/extm.log" 2>&1
python3 "$HERE/make_interior_atlas.py" "$S/tex1k" "$S/atlas"
$B -b -P "$HERE/build_interior.py" -- "$S/ext/ariel-home.glb" "$S/atlas" "$S/int" > "$S/int.log" 2>&1
cp "$S/ext/ariel-home.glb" "$S/ext/ariel-home-512.glb" "$S/ext/ariel-home-collide.json" "$S/int/"* "$A/"
python3 "$HERE/shrink_glb_textures.py" "$A/ariel-home-512.glb" 512   # phone GLB: true 512 px images (memory lane); the desktop GLB keeps its 1K set
node "$HERE/plan_lamps.js"
node "$HERE/bake_gi.js"
