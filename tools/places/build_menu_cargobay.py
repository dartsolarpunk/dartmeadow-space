#!/usr/bin/env python3
"""Build a compact, PBR-textured cargo-bay / observation-hangar GLB for the
JOTS menu, Articren select, Articren editor, and duo-launch arrival.

Canonical frame (meters, Y-up, opening toward -Z):
  width=16  depth=18  height=10  opening_z=-8  deck_y=0
  z: -8 (bay doors / space)  ...  +10 (closed aft bulkhead)

Run:
  blender --background --python tools/places/build_menu_cargobay.py -- \\
      /path/to/assets/places/menu_cargobay.glb
"""
from __future__ import annotations

import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector, Matrix, Euler

# ── dimensions (also stamped on the root empty) ──────────────────────────
W, D, H = 16.0, 18.0, 10.0
OPEN_Z = -8.0
AFT_Z = 10.0
HALF_W = W * 0.5
WALL_T = 0.28
DECK_T = 0.22

OUT = None
for i, a in enumerate(sys.argv):
    if a == "--" and i + 1 < len(sys.argv):
        OUT = sys.argv[i + 1]
        break
if not OUT:
    OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "assets", "places", "menu_cargobay.glb"))

TEXDIR = "/tmp/cbay-build/tex"
os.makedirs(TEXDIR, exist_ok=True)


# ── textures (numpy, packed later) ───────────────────────────────────────
def _save_png(path, arr):
    import numpy as np
    from pathlib import Path
    arr = np.clip(arr, 0, 255).astype("uint8")
    # write via Blender's image API so we don't need Pillow inside Blender
    h, w = arr.shape[0], arr.shape[1]
    ch = arr.shape[2] if arr.ndim == 3 else 1
    img = bpy.data.images.new(Path(path).stem, width=w, height=h, alpha=(ch == 4), float_buffer=False)
    flat = (arr.astype("float32") / 255.0).reshape(-1, ch)
    if ch == 3:
        px = [0.0] * (w * h * 4)
        for i, c in enumerate(flat):
            px[i * 4 + 0] = float(c[0]); px[i * 4 + 1] = float(c[1]); px[i * 4 + 2] = float(c[2]); px[i * 4 + 3] = 1.0
    elif ch == 4:
        px = flat.reshape(-1).tolist()
    else:
        px = [0.0] * (w * h * 4)
        for i, c in enumerate(flat):
            v = float(c[0]); px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 1.0
    img.pixels = px
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def write_textures():
    import numpy as np
    rng = np.random.RandomState(7)

    def fbm(h, w, octaves=4, scale=8.0, seed=1):
        # cheap value-noise fbm
        out = np.zeros((h, w), np.float32)
        amp, freq = 0.5, 1.0
        tot = 0.0
        for o in range(octaves):
            gh, gw = max(2, int(h / (scale / freq))), max(2, int(w / (scale / freq)))
            g = np.random.RandomState(seed + o).rand(gh + 1, gw + 1).astype(np.float32)
            ys = np.linspace(0, gh, h, endpoint=False)
            xs = np.linspace(0, gw, w, endpoint=False)
            y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
            fy = (ys - y0)[:, None]; fx = (xs - x0)[None, :]
            fy = fy * fy * (3 - 2 * fy); fx = fx * fx * (3 - 2 * fx)
            y1 = np.clip(y0 + 1, 0, gh); x1 = np.clip(x0 + 1, 0, gw)
            v00 = g[y0[:, None], x0[None, :]]
            v10 = g[y1[:, None], x0[None, :]]
            v01 = g[y0[:, None], x1[None, :]]
            v11 = g[y1[:, None], x1[None, :]]
            v = v00 * (1 - fy) * (1 - fx) + v10 * fy * (1 - fx) + v01 * (1 - fy) * fx + v11 * fy * fx
            out += v * amp
            tot += amp
            amp *= 0.5
            freq *= 2.0
        return out / tot

    # ---- hull brushed gunmetal, 1024 ----
    S = 1024
    n = fbm(S, S, 5, 10.0, 11)
    n2 = fbm(S, S, 3, 48.0, 23)
    # panel grid
    gy = (np.arange(S)[:, None] % 128)
    gx = (np.arange(S)[None, :] % 128)
    seam = ((gy < 3) | (gy > 125) | (gx < 3) | (gx > 125)).astype(np.float32)
    rivet = (((gy - 8) % 32 < 2) & ((gx - 8) % 32 < 2)).astype(np.float32)
    # brushed streaks (horizontal)
    brush = fbm(S, 32, 3, 4.0, 41)
    brush = np.repeat(brush, S // 32, axis=1)[:, :S]
    base = np.array([0.22, 0.24, 0.27], np.float32)
    hi = np.array([0.38, 0.40, 0.44], np.float32)
    lo = np.array([0.10, 0.11, 0.13], np.float32)
    alb = base[None, None, :] * (0.82 + 0.28 * n[:, :, None]) + (hi - base)[None, None, :] * (brush[:, :, None] * 0.22)
    alb = alb * (1.0 - 0.45 * seam[:, :, None]) + lo[None, None, :] * (0.55 * seam[:, :, None])
    alb = alb + rivet[:, :, None] * 0.08
    alb = np.clip(alb + (n2[:, :, None] - 0.5) * 0.04, 0, 1)
    hull_alb = (alb * 255).astype(np.uint8)
    ao = np.clip(0.72 + 0.28 * n - 0.35 * seam - 0.05 * rivet, 0.25, 1)
    rough = np.clip(0.38 + 0.22 * n2 + 0.18 * seam - 0.08 * brush, 0.18, 0.85)
    metal = np.clip(0.82 - 0.15 * seam + 0.08 * rivet, 0.55, 0.95)
    hull_orm = np.stack([ao, rough, metal], axis=2)
    hull_orm = (hull_orm * 255).astype(np.uint8)

    # ---- deck plates, 1024 ----
    n = fbm(S, S, 5, 14.0, 71)
    n2 = fbm(S, S, 4, 40.0, 83)
    cell = 96
    gy = (np.arange(S)[:, None] % cell)
    gx = (np.arange(S)[None, :] % cell)
    seam = ((gy < 4) | (gy > cell - 5) | (gx < 4) | (gx > cell - 5)).astype(np.float32)
    # per-plate tint
    pid = (np.arange(S)[:, None] // cell) * 17 + (np.arange(S)[None, :] // cell) * 9
    tint = ((pid * 13) % 7).astype(np.float32) / 7.0
    base = np.array([0.09, 0.10, 0.12], np.float32)
    hi = np.array([0.16, 0.17, 0.19], np.float32)
    alb = (base + (hi - base) * tint[:, :, None]) * (0.88 + 0.2 * n[:, :, None])
    alb = alb * (1.0 - 0.7 * seam[:, :, None]) + np.array([0.03, 0.03, 0.035])[None, None, :] * seam[:, :, None]
    # subtle scuffs
    alb = np.clip(alb + (n2[:, :, None] - 0.5) * 0.05, 0, 1)
    deck_alb = (alb * 255).astype(np.uint8)
    ao = np.clip(0.78 + 0.22 * n - 0.45 * seam, 0.2, 1)
    rough = np.clip(0.62 + 0.25 * n2 + 0.15 * seam, 0.4, 0.95)
    metal = np.clip(0.12 + 0.08 * (1 - seam) * n, 0.04, 0.35)
    deck_orm = (np.stack([ao, rough, metal], axis=2) * 255).astype(np.uint8)

    # ---- hazard stripes, 512 ----
    T = 512
    yy, xx = np.indices((T, T))
    stripe = (((xx + yy) // 28) % 2).astype(np.float32)
    haz = np.zeros((T, T, 3), np.float32)
    haz[:] = np.array([0.04, 0.04, 0.045])
    haz[stripe > 0.5] = np.array([0.93, 0.64, 0.06])
    # wear
    nw = fbm(T, T, 3, 20.0, 101)
    haz = haz * (0.88 + 0.18 * nw[:, :, None])
    haz_alb = np.clip(haz * 255, 0, 255).astype(np.uint8)
    haz_orm = np.zeros((T, T, 3), np.uint8)
    haz_orm[:, :, 0] = 200
    haz_orm[:, :, 1] = (80 + 40 * stripe + 30 * nw).clip(40, 200).astype(np.uint8)
    haz_orm[:, :, 2] = (40 + 20 * (1 - stripe)).astype(np.uint8)

    _save_png(os.path.join(TEXDIR, "hull_alb.png"), hull_alb)
    _save_png(os.path.join(TEXDIR, "hull_orm.png"), hull_orm)
    _save_png(os.path.join(TEXDIR, "deck_alb.png"), deck_alb)
    _save_png(os.path.join(TEXDIR, "deck_orm.png"), deck_orm)
    _save_png(os.path.join(TEXDIR, "haz_alb.png"), haz_alb)
    _save_png(os.path.join(TEXDIR, "haz_orm.png"), haz_orm)
    # downscale ORM already 512/1024; leave as-is
    return {
        "hull_alb": os.path.join(TEXDIR, "hull_alb.png"),
        "hull_orm": os.path.join(TEXDIR, "hull_orm.png"),
        "deck_alb": os.path.join(TEXDIR, "deck_alb.png"),
        "deck_orm": os.path.join(TEXDIR, "deck_orm.png"),
        "haz_alb": os.path.join(TEXDIR, "haz_alb.png"),
        "haz_orm": os.path.join(TEXDIR, "haz_orm.png"),
    }


# ── blender scene helpers ────────────────────────────────────────────────
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # empty start: drop default if any
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def make_mat(name, *, alb=None, orm=None, color=(0.2, 0.2, 0.22, 1), metal=0.6, rough=0.4, emit=None, emit_str=0.0, uv_scale=(1, 1)):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (-200, 0)
    out.location = (200, 0)
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Base Color"].default_value = color
    if alb:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(alb)
        tex.image.colorspace_settings.name = "sRGB"
        tex.location = (-700, 200)
        uv = nt.nodes.new("ShaderNodeUVMap")
        uv.location = (-900, 200)
        mapn = nt.nodes.new("ShaderNodeMapping")
        mapn.inputs["Scale"].default_value = (uv_scale[0], uv_scale[1], 1)
        mapn.location = (-800, 200)
        tc = nt.nodes.new("ShaderNodeTexCoord")
        tc.location = (-1100, 200)
        nt.links.new(tc.outputs["UV"], mapn.inputs["Vector"])
        nt.links.new(mapn.outputs["Vector"], tex.inputs["Vector"])
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if orm:
            otex = nt.nodes.new("ShaderNodeTexImage")
            otex.image = bpy.data.images.load(orm)
            otex.image.colorspace_settings.name = "Non-Color"
            otex.location = (-700, -150)
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            sep.location = (-450, -150)
            nt.links.new(mapn.outputs["Vector"], otex.inputs["Vector"])
            nt.links.new(otex.outputs["Color"], sep.inputs["Color"])
            # AO multiplies base, G=rough, B=metal
            try:
                mix = nt.nodes.new("ShaderNodeMix")
                mix.data_type = "RGBA"
                mix.blend_type = "MULTIPLY"
                mix.inputs["Factor"].default_value = 0.85
                col_a, col_b, col_out = "A", "B", "Result"
            except Exception:
                mix = nt.nodes.new("ShaderNodeMixRGB")
                mix.blend_type = "MULTIPLY"
                mix.inputs["Fac"].default_value = 0.85
                col_a, col_b, col_out = "Color1", "Color2", "Color"
            mix.location = (-400, 200)
            for l in list(nt.links):
                if l.to_socket == bsdf.inputs["Base Color"]:
                    nt.links.remove(l)
            nt.links.new(tex.outputs["Color"], mix.inputs[col_a])
            nt.links.new(sep.outputs["Red"], mix.inputs[col_b])
            # if Mix node uses Color sockets:
            try:
                nt.links.new(tex.outputs["Color"], mix.inputs["A"])
            except Exception:
                pass
            nt.links.new(mix.outputs[col_out] if col_out in mix.outputs else mix.outputs[0], bsdf.inputs["Base Color"])
            nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
            nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    if emit_str > 0 and emit is not None:
        # emission mixed on top (fixtures)
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = (emit[0], emit[1], emit[2], 1)
        em.inputs["Strength"].default_value = emit_str
        em.location = (-200, -300)
        add = nt.nodes.new("ShaderNodeAddShader")
        add.location = (40, -80)
        nt.links.new(bsdf.outputs["BSDF"], add.inputs[0])
        nt.links.new(em.outputs["Emission"], add.inputs[1])
        nt.links.new(add.outputs["Shader"], out.inputs["Surface"])
    else:
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return m


def make_emit(name, color, strength):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (color[0], color[1], color[2], 1)
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return m


def new_mesh(name, verts, faces, mat=None, smooth=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.update()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    if mat:
        if obj.data.materials:
            obj.data.materials[0] = mat
        else:
            obj.data.materials.append(mat)
    return obj


def box(name, loc, size, mat, rot=(0, 0, 0)):
    """Axis-aligned box, loc=center, size=full extents."""
    hx, hy, hz = size[0] * 0.5, size[1] * 0.5, size[2] * 0.5
    # build in local, then transform
    v = [
        (-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
        (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz),
    ]
    f = [
        (0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0),
    ]
    obj = new_mesh(name, v, f, mat)
    obj.location = Vector(loc)
    obj.rotation_euler = Euler(rot)
    return obj


def cylinder(name, loc, radius, depth, mat, rot=(0, 0, 0), segs=12, axis="Z"):
    bpy.ops.mesh.primitive_cylinder_add(vertices=segs, radius=radius, depth=depth, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = Euler(rot)
    if mat:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    return obj


def uv_cube_project(obj, scale=1.0):
    """Simple box UV so tiled textures land reasonably."""
    me = obj.data
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.active.data
    # need loops
    me.calc_loop_triangles()
    # compute world-ish local positions
    for poly in me.polygons:
        n = poly.normal
        ax = 0 if abs(n.x) >= abs(n.y) and abs(n.x) >= abs(n.z) else (1 if abs(n.y) >= abs(n.z) else 2)
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if ax == 0:
                u, v = co.y, co.z
            elif ax == 1:
                u, v = co.x, co.z
            else:
                u, v = co.x, co.y
            uv[li].uv = (u * scale, v * scale)


def apply_and_uv(obj, scale=0.35):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    uv_cube_project(obj, scale)
    obj.select_set(False)


def join_named(name, objs, mat=None, uv_scale=0.35):
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    if len(objs) == 1:
        objs[0].name = name
        apply_and_uv(objs[0], uv_scale)
        return objs[0]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    apply_and_uv(obj, uv_scale)
    if mat:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    bpy.ops.object.select_all(action="DESELECT")
    return obj


# ── build the hangar ─────────────────────────────────────────────────────
def build(tex):
    M_HULL = make_mat("BayHull", alb=tex["hull_alb"], orm=tex["hull_orm"], metal=0.8, rough=0.35, uv_scale=(0.35, 0.35))
    M_DECK = make_mat("BayDeck", alb=tex["deck_alb"], orm=tex["deck_orm"], metal=0.15, rough=0.7, uv_scale=(0.45, 0.45))
    M_HAZ = make_mat("BayHazard", alb=tex["haz_alb"], orm=tex["haz_orm"], metal=0.15, rough=0.5, uv_scale=(1.2, 1.2))
    M_TRIM = make_mat("BayTrim", color=(0.08, 0.09, 0.11, 1), metal=0.85, rough=0.28)
    M_CYAN = make_emit("BayEmitCyan", (0.35, 0.85, 1.0), 12.0)
    M_AMBER = make_emit("BayEmitAmber", (1.0, 0.62, 0.18), 10.0)
    M_LAMP = make_emit("BayEmitLamp", (1.0, 0.94, 0.82), 18.0)
    M_LAMP_SOFT = make_mat("BayLampHousing", color=(0.12, 0.13, 0.15, 1), metal=0.7, rough=0.32, emit=(1.0, 0.95, 0.85), emit_str=0.4)

    root = bpy.data.objects.new("MenuCargoBay", None)
    bpy.context.collection.objects.link(root)
    root["bay_width"] = W
    root["bay_depth"] = D
    root["bay_height"] = H
    root["opening_z"] = OPEN_Z
    root["deck_y"] = 0.0

    opening = bpy.data.objects.new("Opening", None)
    bpy.context.collection.objects.link(opening)
    opening.location = (0, H * 0.45, OPEN_Z)
    opening.parent = root

    # ---- deck (solid slab + lip) ----
    deck = box("Deck", (0, -DECK_T * 0.5, (OPEN_Z + AFT_Z) * 0.5), (W - 0.04, DECK_T, D - 0.04), M_DECK)
    # slightly raised center plates
    # launch rail recess (center strip)
    rail_well = box("RailWell", (0, 0.01, 1.0), (1.6, 0.04, D - 3.2), M_TRIM)
    rail_l = box("RailL", (-0.62, 0.05, 1.0), (0.08, 0.08, D - 3.4), M_HULL)
    rail_r = box("RailR", (0.62, 0.05, 1.0), (0.08, 0.08, D - 3.4), M_HULL)
    # chevrons along the rail (amber emit boxes)
    chevs = []
    for i in range(8):
        z = OPEN_Z + 1.6 + i * 1.55
        for s in (-1, 1):
            c = box(f"Chev_{i}_{s}", (s * 0.28, 0.03, z), (0.9, 0.025, 0.12), M_AMBER, rot=(0, s * 0.55, 0))
            chevs.append(c)
    # hazard lip at the opening
    haz = box("HazardLip", (0, 0.02, OPEN_Z + 0.28), (W - 0.6, 0.03, 0.55), M_HAZ)
    # guide light strips on the deck edges
    strip_l = box("DeckStripL", (-HALF_W + 0.55, 0.025, 1.0), (0.07, 0.02, D - 1.6), M_CYAN)
    strip_r = box("DeckStripR", (HALF_W - 0.55, 0.025, 1.0), (0.07, 0.02, D - 1.6), M_CYAN)

    deck_grp = [deck, rail_well, rail_l, rail_r, haz, strip_l, strip_r] + chevs
    for o in deck_grp:
        o.parent = root

    # ---- walls, ceiling, aft bulkhead ----
    wall_l = box("WallL", (-HALF_W - WALL_T * 0.5, H * 0.5, (OPEN_Z + AFT_Z) * 0.5), (WALL_T, H, D), M_HULL)
    wall_r = box("WallR", (HALF_W + WALL_T * 0.5, H * 0.5, (OPEN_Z + AFT_Z) * 0.5), (WALL_T, H, D), M_HULL)
    ceil = box("Ceiling", (0, H + WALL_T * 0.5, (OPEN_Z + AFT_Z) * 0.5), (W + WALL_T * 2, WALL_T, D), M_HULL)
    aft = box("Bulkhead", (0, H * 0.5, AFT_Z + WALL_T * 0.5), (W + WALL_T * 2, H, WALL_T), M_HULL)
    # kick plates
    kick_l = box("KickL", (-HALF_W + 0.12, 0.35, 1.0), (0.18, 0.7, D - 1.2), M_TRIM)
    kick_r = box("KickR", (HALF_W - 0.12, 0.35, 1.0), (0.18, 0.7, D - 1.2), M_TRIM)

    struct = [wall_l, wall_r, ceil, aft, kick_l, kick_r]

    # vertical wall ribs + ceiling beams (9 stations)
    N_RIB = 9
    ribs = []
    for i in range(N_RIB):
        z = OPEN_Z + 0.9 + i * (D - 1.6) / (N_RIB - 1)
        for sx in (-1, 1):
            # I-beam-ish: flange + web
            web = box(f"RibWeb_{i}_{sx}", (sx * (HALF_W - 0.18), H * 0.5, z), (0.12, H - 0.2, 0.22), M_HULL)
            fl1 = box(f"RibFl1_{i}_{sx}", (sx * (HALF_W - 0.32), H * 0.5, z), (0.22, H - 0.4, 0.08), M_TRIM)
            ribs += [web, fl1]
        beam = box(f"Beam_{i}", (0, H - 0.16, z), (W - 0.3, 0.22, 0.28), M_HULL)
        beam_cap = box(f"BeamCap_{i}", (0, H - 0.30, z), (W - 0.5, 0.08, 0.38), M_TRIM)
        ribs += [beam, beam_cap]
        # recessed ceiling strip along each beam
        rec = box(f"CeilStrip_{i}", (0, H - 0.36, z), (W - 1.4, 0.04, 0.08), M_CYAN)
        ribs.append(rec)
    struct += ribs
    for o in struct:
        o.parent = root

    # ---- blast-door / observation frame at the opening ----
    # jambs, header, sill, inner bevel
    jamb_l = box("JambL", (-HALF_W + 0.22, H * 0.5, OPEN_Z + 0.12), (0.55, H, 0.55), M_HULL)
    jamb_r = box("JambR", (HALF_W - 0.22, H * 0.5, OPEN_Z + 0.12), (0.55, H, 0.55), M_HULL)
    header = box("Header", (0, H - 0.28, OPEN_Z + 0.12), (W, 0.55, 0.7), M_HULL)
    sill = box("Sill", (0, 0.08, OPEN_Z + 0.16), (W - 0.2, 0.16, 0.5), M_TRIM)
    # inner amber frame
    fr_l = box("FrameL", (-HALF_W + 0.48, H * 0.5, OPEN_Z + 0.02), (0.08, H - 0.3, 0.12), M_AMBER)
    fr_r = box("FrameR", (HALF_W - 0.48, H * 0.5, OPEN_Z + 0.02), (0.08, H - 0.3, 0.12), M_AMBER)
    fr_t = box("FrameT", (0, H - 0.52, OPEN_Z + 0.02), (W - 0.9, 0.08, 0.12), M_AMBER)
    fr_b = box("FrameB", (0, 0.14, OPEN_Z + 0.02), (W - 0.9, 0.06, 0.12), M_AMBER)
    frame = [jamb_l, jamb_r, header, sill, fr_l, fr_r, fr_t, fr_b]

    # structural pillars just inside the opening (4)
    pillars = []
    for i, x in enumerate((-5.4, -2.15, 2.15, 5.4)):
        col = box(f"Pillar_{i}", (x, H * 0.5, OPEN_Z + 0.55), (0.48, H, 0.48), M_HULL)
        cap = box(f"PillarCap_{i}", (x, H - 0.08, OPEN_Z + 0.55), (0.62, 0.16, 0.62), M_TRIM)
        base = box(f"PillarBase_{i}", (x, 0.18, OPEN_Z + 0.55), (0.62, 0.36, 0.62), M_TRIM)
        # LED strips on the inner face of each pillar
        led = box(f"PillarLed_{i}", (x, H * 0.45, OPEN_Z + 0.30), (0.06, H * 0.82, 0.05), M_CYAN)
        # amber marker at top / mid
        mk = box(f"PillarMark_{i}", (x, H - 0.7, OPEN_Z + 0.28), (0.14, 0.10, 0.08), M_AMBER)
        pillars += [col, cap, base, led, mk]
    frame += pillars
    for o in frame:
        o.parent = root

    # ---- catwalks + railings along both walls ----
    walks = []
    walk_y = 4.15
    for sx in (-1, 1):
        plat = box(f"Walk_{sx}", (sx * (HALF_W - 0.85), walk_y, 1.2), (1.1, 0.08, D - 2.4), M_HULL)
        walks.append(plat)
        # posts + rails
        for i in range(8):
            z = OPEN_Z + 1.2 + i * (D - 2.6) / 7
            post = box(f"Post_{sx}_{i}", (sx * (HALF_W - 0.38), walk_y + 0.55, z), (0.05, 1.1, 0.05), M_TRIM)
            walks.append(post)
        rail_t = box(f"RailT_{sx}", (sx * (HALF_W - 0.38), walk_y + 1.08, 1.2), (0.04, 0.04, D - 2.5), M_CYAN)
        rail_m = box(f"RailM_{sx}", (sx * (HALF_W - 0.38), walk_y + 0.62, 1.2), (0.035, 0.03, D - 2.5), M_TRIM)
        walks += [rail_t, rail_m]
    for o in walks:
        o.parent = root

    # ---- overhead light fixtures (real housings + emitters) ----
    # 2 x 4 grid, hanging from ceiling beams, stems + rectangular housings
    fixtures = []
    xs = (-3.2, 3.2)
    zs = (-5.2, -1.4, 2.4, 6.2)
    idx = 0
    for x in xs:
        for z in zs:
            idx += 1
            fy = H - 0.85
            # stem
            stem = cylinder(f"LightStem_{idx:02d}", (x, H - 0.50, z), 0.045, 0.55, M_TRIM, segs=8)
            # housing: shallow inverted box with lip
            house = box(f"LightHouse_{idx:02d}", (x, fy, z), (1.35, 0.16, 0.72), M_LAMP_SOFT)
            bezel = box(f"LightBezel_{idx:02d}", (x, fy - 0.10, z), (1.22, 0.05, 0.60), M_TRIM)
            # recessed emitter panel (the lamp itself)
            lamp = box(f"LightLamp_{idx:02d}", (x, fy - 0.14, z), (1.08, 0.03, 0.48), M_LAMP)
            # empty at the beam origin (bottom of lamp) so JS can hang shafts
            hook = bpy.data.objects.new(f"Light_{idx:02d}", None)
            bpy.context.collection.objects.link(hook)
            hook.location = (x, fy - 0.18, z)
            hook["fixture"] = idx
            hook.parent = root
            for o in (stem, house, bezel, lamp):
                o.parent = root
                fixtures.append(o)
            fixtures.append(hook)

    # wall sconces (alternating cyan / amber)
    sconces = []
    for i in range(6):
        z = OPEN_Z + 2.0 + i * 2.4
        for sx in (-1, 1):
            body = box(f"Sconce_{sx}_{i}", (sx * (HALF_W - 0.08), 2.4, z), (0.08, 0.35, 0.22), M_TRIM)
            glow = box(f"SconceGlow_{sx}_{i}", (sx * (HALF_W - 0.14), 2.4, z), (0.04, 0.22, 0.14), M_CYAN if (i + (sx > 0)) % 2 == 0 else M_AMBER)
            sconces += [body, glow]
    for o in sconces:
        o.parent = root

    # lip LEDs along the opening sill
    lip_leds = []
    for i in range(16):
        x = -HALF_W + 0.8 + i * ((W - 1.6) / 15)
        led = box(f"LipLed_{i}", (x, 0.12, OPEN_Z + 0.22), (0.10, 0.04, 0.06), M_CYAN if i % 4 else M_AMBER)
        lip_leds.append(led)
        led.parent = root

    # far gantry hints leaving the hull (adds depth through the opening)
    gantries = []
    for sx, zoff in ((-1, -18), (1, -22)):
        g = box(f"Gantry_{sx}", (sx * 7.4, 0.4, OPEN_Z + zoff * 0.35), (0.55, 0.55, 14.0), M_HULL)
        gantries.append(g)
        g.parent = root
        for i in range(5):
            mk = box(f"GantryLed_{sx}_{i}", (sx * 7.4, 0.75, OPEN_Z - 3 - i * 2.4), (0.18, 0.18, 0.18), M_CYAN)
            mk.parent = root
            gantries.append(mk)
    # one mast
    mast = box("Mast", (-7.4, 5.5, OPEN_Z - 9), (0.35, 9.0, 0.35), M_HULL)
    mast_lit = box("MastLit", (-7.4, 10.2, OPEN_Z - 9), (0.28, 0.28, 0.28), M_AMBER)
    mast.parent = root
    mast_lit.parent = root

    # ── sliding blast doors (two armored leaves, authored closed) ──
    # Each leaf is a hook empty (Door_L / Door_R) the runtime translates on X.
    # Children stay out of the per-material bay join so they can animate.
    def add_leaf(side):
        name = "Door_L" if side < 0 else "Door_R"
        leaf_w = HALF_W + 0.18
        thick = 0.46
        z = OPEN_Z - 0.28
        cx = side * (leaf_w * 0.5 - 0.10)
        hook = bpy.data.objects.new(name, None)
        bpy.context.collection.objects.link(hook)
        hook.empty_display_type = "CUBE"
        hook.empty_display_size = 0.5
        hook.location = (cx, 0.0, 0.0)
        hook["slide"] = 8.25
        hook["side"] = int(side)
        hook["closedX"] = cx
        hook["openX"] = cx + side * 8.25
        hook.parent = root
        parts = []
        def loc(x, y, zz):
            return (x - cx, y, zz)
        slab = box(name + "_Slab", loc(cx, H * 0.5, z), (leaf_w, H - 0.12, thick), M_HULL)
        parts.append(slab)
        # face ribs + vertical stiffeners (trim)
        for i in range(5):
            y = 0.9 + i * ((H - 1.8) / 4)
            parts.append(box(name + f"_Rib{i}", loc(cx, y, z - thick * 0.38), (leaf_w - 0.5, 0.14, 0.12), M_TRIM))
        for k, fx in enumerate((-0.72, -0.28, 0.28, 0.72)):
            vx = cx + fx * leaf_w * 0.42
            parts.append(box(name + f"_Stile{k}", loc(vx, H * 0.5, z - thick * 0.38), (0.14, H - 0.55, 0.12), M_TRIM))
        # meeting-edge amber lamp and an outer frame lip
        meet = cx + side * (-leaf_w * 0.5 + 0.07)
        parts.append(box(name + "_Edge", loc(meet, H * 0.5, z - thick * 0.22), (0.09, H - 0.35, 0.18), M_AMBER))
        parts.append(box(name + "_Lip", loc(cx + side * (leaf_w * 0.5 - 0.1), H * 0.5, z + thick * 0.15), (0.16, H - 0.2, 0.14), M_TRIM))
        # diagonal brace on the inner face
        # (kept as axis-aligned boxes — a chevron pair)
        midy = H * 0.5
        parts.append(box(name + "_ChevA", loc(cx, midy + 1.6, z - thick * 0.40), (leaf_w * 0.55, 0.10, 0.08), M_TRIM))
        parts.append(box(name + "_ChevB", loc(cx, midy - 1.6, z - thick * 0.40), (leaf_w * 0.55, 0.10, 0.08), M_TRIM))
        for o in parts:
            o.parent = hook
        # per-leaf merge so each door is a handful of draw calls
        from collections import defaultdict as _dd
        buckets = _dd(list)
        for o in list(hook.children):
            if o.type != "MESH":
                continue
            mat = o.data.materials[0] if o.data.materials else None
            buckets[mat.name if mat else "_none"].append(o)
        for key, objs in buckets.items():
            mat = objs[0].data.materials[0] if objs[0].data.materials else None
            joined = join_named(name + "_" + key, objs, mat, uv_scale=0.32)
            if joined is not None:
                joined.parent = hook
        # collision body follows the leaf (invisible mesh; runtime hides Collide_* )
        col = box("Collide_" + name, (0.0, H * 0.5, z), (leaf_w, H - 0.12, thick), M_HULL)
        col.parent = hook
        col["collider"] = 1
        return hook

    add_leaf(-1)
    add_leaf(1)

    # Static collision bodies as meshes (hidden at runtime) so glTF keeps a reliable world AABB
    def collide(name, loc, size):
        o = box(name, loc, size, M_HULL)
        o.parent = root
        o["collider"] = 1
        return o

    collide("Collide_Floor", (0, -DECK_T * 0.5, (OPEN_Z + AFT_Z) * 0.5), (W, DECK_T, D))
    collide("Collide_Ceiling", (0, H + WALL_T * 0.5, (OPEN_Z + AFT_Z) * 0.5), (W + WALL_T * 2, WALL_T, D))
    collide("Collide_WallL", (-HALF_W - WALL_T * 0.5, H * 0.5, (OPEN_Z + AFT_Z) * 0.5), (WALL_T, H, D))
    collide("Collide_WallR", (HALF_W + WALL_T * 0.5, H * 0.5, (OPEN_Z + AFT_Z) * 0.5), (WALL_T, H, D))
    collide("Collide_Aft", (0, H * 0.5, AFT_Z + WALL_T * 0.5), (W, H, WALL_T))
    collide("Collide_JambL", (-HALF_W + 0.22, H * 0.5, OPEN_Z + 0.12), (0.55, H, 0.55))
    collide("Collide_JambR", (HALF_W - 0.22, H * 0.5, OPEN_Z + 0.12), (0.55, H, 0.55))
    collide("Collide_Header", (0, H - 0.28, OPEN_Z + 0.12), (W, 0.55, 0.7))

    # Merge mesh primitives per material so one bay instance is ~8 draw calls, not 228.
    # Light_* empties, Door_* hooks, and Collide_* bodies stay as placement / physics hooks.
    from collections import defaultdict
    buckets = defaultdict(list)
    for o in list(root.children):
        if o.type != "MESH":
            continue
        if o.name.startswith("Door_") or o.name.startswith("Collide_"):
            continue
        mat = o.data.materials[0] if o.data.materials else None
        buckets[mat.name if mat else "_none"].append(o)
    for key, objs in buckets.items():
        mat = objs[0].data.materials[0] if objs[0].data.materials else None
        scale = 0.28 if key in ("BayDeck", "BayHazard") else 0.32
        joined = join_named("Bay_" + key, objs, mat, uv_scale=scale)
        if joined is not None:
            joined.parent = root

    return root, fixtures


def export_glb(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    # The builder authors a Y-up frame (x, height, depth). Blender itself is
    # Z-up, and export_yup then maps (x, y, z) → (x, z, -y). Rotating the
    # root +90° about X first yields a glTF that stays Y-up, opening at -Z.
    root = bpy.data.objects.get("MenuCargoBay")
    if root:
        root.rotation_euler[0] += math.radians(90.0)
        bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="SELECT")
    kw = dict(
        filepath=path,
        export_format="GLB",
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_apply=True,
        export_yup=True,
        export_image_format="AUTO",
        export_jpeg_quality=82,
        export_unused_images=False,
        export_keep_originals=False,
    )
    # Draco if the exporter accepts it
    # No Draco: the game's GLTFLoader has no DRACOLoader. Other place GLBs use
    # WebP + KHR_mesh_quantization via tools/places/compress_glbs.sh instead.
    kw["export_draco_mesh_compression_enable"] = False
    kw["export_extras"] = True
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError:
        kw.pop("export_jpeg_quality", None)
        kw.pop("export_unused_images", None)
        kw.pop("export_keep_originals", None)
        kw.pop("export_draco_mesh_compression_enable", None)
        bpy.ops.export_scene.gltf(**kw)
    print("exported", path, "bytes", os.path.getsize(path) if os.path.exists(path) else 0)


def main():
    reset_scene()
    print("writing textures…")
    tex = write_textures()
    print("building hangar…")
    build(tex)
    print("exporting", OUT)
    export_glb(OUT)
    if os.path.exists(OUT):
        print("OK", OUT, os.path.getsize(OUT))
    else:
        raise SystemExit("export failed: " + OUT)


if __name__ == "__main__":
    main()
