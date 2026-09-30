# Fields Galaxy template

Blender geometry-nodes galaxy used as the template for procedural galaxies.
`sampleFieldsGalaxy()` in `index.html` is a direct port of this node graph.

The `.glb` only holds the base plane: geometry nodes aren't baked on export,
so the `.blend` is the real source.

## Node graph (Geometry Nodes on `Plane`)
1. Curve Circle (r = 1) → Fill Curve → Distribute Points on Faces
   (random, density 1,000,000 → ~3.1M points on the unit disc).
2. Twist: Vector Rotate about Z by `(1 − |P|) · (4 + 0.3 · t)`. The core
   turns more than the rim, which winds everything into a spiral.
3. Noise Texture (3D FBM, scale 7, detail 8, roughness 0.7) sampled at the
   original position + `(0, 0, 0.001 · t)`.
4. Set Position = Linear Light(rotated P, noise colour), factor 0.10 at the
   core to 0.25 at the rim. The noise filaments become flocculent arms.
5. Set Point Radius = random(0 … 0.0006) × (1 − length).
6. Material: emission; colour = ramp(random) #1C48FF → #0F99FF, hue shifted
   up to +0.086 with radius; strength = (1 − length) + up to 30× hot knots
   where the noise peaks inside 0.605 of the radius. Compositor adds two
   streak glares.

`blender-top-view.png` is a Cycles render of the file (camera straight down);
`js-port-top-view.png` is the JavaScript port for comparison.
