# Dev harness: boot the REAL game headless (Playwright + Chromium + SwiftShader)

`tools/dev/boot-game.py` boots `index.html` exactly as served (real three.js r185 WebGPURenderer, real TSL, the real GLBs) in headless
Chromium, with no internet. Written for the Bird Temple "never loads" hunt, usable by anyone (lighting workers: use it to render real frames).

## How it gets around "no CDN in the sandbox"
* `index.html` loads three from an importmap: `https://cdn.jsdelivr.net/npm/three@0.185.0/{build/three.webgpu.js,build/three.tsl.js,examples/jsm/...}`.
  The harness `npm install`s `three@0.185.0` once into `~/.cache/dm-harness` (override with `DM_HARNESS_NODE`) and uses Playwright
  `route()` to answer every `https://cdn.jsdelivr.net/npm/three@0.185.0/...` request from `node_modules/three/` (CORS header added).
* Every other external URL (Google Fonts, `api.github.com` music scan, eruda, geojson, Apps Script) is answered 404 immediately (recorded in `game.net`).
  The game copes (fallback music list, system fonts).
* The repo is served by an in-process static server on `127.0.0.1:<random port>` (`.glb` as `model/gltf-binary`); the service worker is blocked
  (`service_workers='block'`), so `sw.js` caching is NOT exercised.
* `lite=True` (default) stubs `window.DM_MENUSCENE` before page scripts (Ariel + hair + shadow menu scene eats all the CPU under SwiftShader and is
  irrelevant for flight tests). Pass `lite=False` to boot the real menu.

## Two backends
| mode | how | what it proves |
|---|---|---|
| default | `--use-gl=angle --use-angle=swiftshader` (old headless shell) | game falls back to **WebGL2** (GLSL). Good for logic, scene graph, screenshots. NOT the WGSL path. |
| `webgpu=True` / `--webgpu` | full `chrome` binary with `--headless=new --enable-unsafe-webgpu --enable-features=Vulkan,WebGPU --use-webgpu-adapter=swiftshader` | **real WebGPU / WGSL** (what iPad Safari uses). Needs `http://127.0.0.1` (secure context) - the harness serves that. |

## Usage
```python
import importlib.util, json
spec = importlib.util.spec_from_file_location('bg', 'tools/dev/boot-game.py'); bg = importlib.util.module_from_spec(spec); spec.loader.exec_module(bg)

g = bg.Game(query='harness=1', webgpu=False, verbose=True,
            save={'dm_gfx_v2': json.dumps({'chosen': True, 'aaV': 2, 'preset': 'low'})})   # localStorage set before any page script
g.open()
g.start_flight()                       # enterApp() + launchFlight(), waits for flightInited && screen==='flight'
g.wait_for("BIRD_TEMPLE.group && BIRD_TEMPLE.spawned", timeout=600)
g.js("travelToBirdTemple()")           # any global function / `let`/`const` global (STATE, BIRD_TEMPLE, flightScene ...) is reachable by bare name
print(g.js("({vis: BIRD_TEMPLE.group.visible, inScene: (()=>{let r=BIRD_TEMPLE.group; while(r.parent) r=r.parent; return r===flightScene})()})"))
g.shot('/tmp/temple.png')              # page.screenshot (timeout 120 s: frames are slow)
print(g.logs[-20:], g.net)             # console / pageerror log and failed or blocked requests
g.close()
```
CLI smoke test: `python3 tools/dev/boot-game.py --wait 30 --shot /tmp/menu.png --eval "STATE.screen"` (`--webgpu`, `-v` available).
Run long scenarios as a background job and poll a log file (a flight boot takes minutes, see limits).

`localStorage` keys worth knowing: `dm_gfx_v2` (graphics choice; without it the first-launch GRAPHICS SETUP screen appears), `dm_autosave` (a `DM2` save; `buildSaveData('auto')` makes one in-game), `dm_saves`.
`launchFlight()` directly skips the JOTS consent / mode chooser that `startGame()` is wrapped in.

## Known limits (be honest about them)
* **Slow**: 2 shared CPU cores + software GL: ~1-4 fps at 480x300, flight boot (shader compile) takes several minutes, every `js()` call waits for the
  page's main thread. Other workers' Chromiums on the same box make it slower. Use small viewports (default 480x300), `preset: 'low'`, generous timeouts.
* Timing-dependent behaviour (anything that needs real frame pacing, LOD hysteresis over seconds) is not representative; state checks are.
* Not covered: Safari/iPad specifics (memory limits, 32 MB GLB decode pressure, GPU process loss), the service worker, touch input, audio.
* WebGL2 backend != WGSL: a WGSL compile error will only show with `webgpu=True`.
