# Parallax on every tier (sw v259/v260)

Renders here come from `tools/tests/px-render.py` (software GL, for A/B pictures and shader-compile checks, not frame times):
`ground-<class>-<tier>.png` (ground library, `tools/tests/ground-harness.html`), `cliff-*.png` (`structure-harness.html`), `bt-hull-*.png` (`bt-harness.html`, the real `ui/dm-bt-pbr.js`), `*-off.png` = `?px=0`.

Tier table: `ui/dm-parallax.js` TIERS (check with `node tools/tests/parallax-tiers.js`). Worst-case march fetches per pixel (steps + 2 + relief + shadow taps + 3 lookups):

| class | tier | steps (floor) | relief | shadow | depth | reach | ground tile | height cap | worst | typical |
|---|---|---|---|---|---|---|---|---|---|---|
| desktop | low | 4 (2) | - | - | 0.5 | 0.55 | 96 | 256 | 9 | 6.4 |
| desktop | medium | 16 (3) | - | - | 0.8 | 0.85 | 160 | 512 | 21 | 10.4 |
| desktop | high | 20 (4) | yes | yes | 1.0 | 1.0 | 192 | 512 | 33 | 16.6 |
| desktop | ultra | 24 (4) | yes | yes | 1.1 | 1.2 | 256 | 1024 | 37 | 17.9 |
| mobile | low | 3 (2) | - | - | 0.45 | 0.5 | 96 | 256 | 8 | 6.0 |
| mobile | medium | 8 (3) | - | - | 0.7 | 0.7 | 128 | 256 | 13 | 7.7 |
| mobile | high | 12 (3) | yes | - | 0.9 | 0.9 | 160 | 512 | 18 | 9.7 |
| mobile | ultra | 16 (4) | yes | yes | 1.0 | 1.0 | 192 | 512 | 25 | 12.8 |

Nothing is ever off: the quality governor (continuous q) and the DMBudget ladder shrink steps / depth / reach toward the floor row; `?px=0` is the only kill switch.
