/* (v314) View gate: "is this body relevant to the view" decisions that do not thrash at the screen edge, and per-frame work that is time-sliced.
 *   Why: a planet that swings across the screen edge flips every decision keyed on "is it in the frustum" on a single frame - the atmosphere pass
 *   (full-screen scene-through-RT vs plain scene draw), its per-planet pipeline (built on entry, disposed when another planet became the nearest),
 *   any lazily built per-body state.  A body hovering at the edge flipped these every frame or every few frames, and each flip is a render-context /
 *   pipeline change that lands inside the frame the planet slides in (the freeze).  This module holds the pure parts, testable in node:
 *     DMView.inView(...)      sphere vs the camera's view cone, with an angular + radius pad (no THREE objects: takes the camera's matrixWorldInverse
 *                             elements and the projection's tan half-angles)
 *     DMView.Gate             enter/exit hysteresis: arms on a TIGHT pad, drops only after the body has been outside a WIDE pad for `holdMs`
 *     DMView.runBudget(q,ms)  runs queued tasks until `ms` of wall time is used (at least one per call), the rest wait for the next frame
 *     DMView.EdgeLog          ring buffer of enter/leave breadcrumbs, attached to the >60 ms hitch record (tools/pull-perf.sh shows them)
 */
(function (root) {
  'use strict';
  // m = camera.matrixWorldInverse.elements (column-major), tx/ty = tan(half fov) horizontal/vertical, c = [x,y,z] world, r = radius,
  // pad = extra half-angle in radians, rk = radius multiplier.  Camera looks down -Z.  Far plane ignored (bodies are never far-clipped here).
  function inView(m, tx, ty, near, c, r, pad, rk) {
    const x = c[0], y = c[1], z = c[2];
    const px = m[0] * x + m[4] * y + m[8] * z + m[12];
    const py = m[1] * x + m[5] * y + m[9] * z + m[13];
    const pz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const R = r * (rk || 1), f = -pz;                      // f = distance in front of the camera
    if (f + R < (near || 0)) return false;                 // wholly behind the near plane
    if (Math.sqrt(px * px + py * py + pz * pz) <= R) return true;   // camera inside the sphere
    const a = pad || 0;
    const ex = Math.tan(Math.min(1.5, Math.atan(tx) + a)), ey = Math.tan(Math.min(1.5, Math.atan(ty) + a));
    // signed distance to each side plane (normalised), positive = outside
    const dx = (Math.abs(px) - ex * f) / Math.sqrt(1 + ex * ex);
    const dy = (Math.abs(py) - ey * f) / Math.sqrt(1 + ey * ey);
    return dx <= R && dy <= R;
  }

  // enter on `tight`, leave only after `wide` has been false for holdMs.  update() returns the active flag; `changes` counts flips.
  function Gate(holdMs) { this.hold = holdMs == null ? 1500 : holdMs; this.active = false; this.lastIn = -1e12; this.changes = 0; this.since = 0; }
  Gate.prototype.update = function (now, tight, wide) {
    if (!this.active) {
      if (tight) { this.active = true; this.lastIn = now; this.since = now; this.changes++; }
    } else {
      if (wide || tight) this.lastIn = now;
      else if (now - this.lastIn >= this.hold) { this.active = false; this.since = now; this.changes++; }
    }
    return this.active;
  };

  // Runs tasks (functions) from the front of `q` until the budget is used.  Always runs one task when the queue is not empty so work cannot starve.
  // Returns the number run.  A task may return false to say "not done, try again next frame" (it is re-queued at the back).
  function runBudget(q, ms, now) {
    const clock = now || (typeof performance !== 'undefined' ? () => performance.now() : Date.now);
    const t0 = clock(); let n = 0, guard = q.length;
    while (q.length && guard-- > 0) {
      const f = q.shift(); n++;
      let again = false; try { again = f() === false; } catch (e) {}
      if (again) q.push(f);
      if (clock() - t0 >= ms) break;
    }
    return n;
  }

  const EdgeLog = { buf: [], cap: 24, add(kind, name, t) { const b = this.buf; b.push([t == null ? (typeof performance !== 'undefined' ? performance.now() : 0) : t, kind, name]); if (b.length > this.cap) b.shift(); },
    recent(now, win) { const out = []; for (const e of this.buf) if (now - e[0] <= win) out.push(e[1] + ':' + e[2]); return out; } };

  root.DMView = { inView: inView, Gate: Gate, runBudget: runBudget, EdgeLog: EdgeLog };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DMView;
})(typeof window !== 'undefined' ? window : globalThis);
