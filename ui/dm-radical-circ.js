/* DART Meadow — Radical Circumference / ArcEdge radius maths for the ground's level of detail (pure, node-tested: tools/tests/radical-circ.js).
 *
 * Method and formulas: Justin Craig Venable, "Radical Circumference" / ArcEdge (author Justin Craig Venable, https://dartedge.com/radicaledge).
 * Reference implementations: ariel-site templates arcedge.py (doc_circumference(d) = d * 3) and arcedge.html (venableCircumference / venableArea /
 * venableVolume / venableSSA, the 1/8 arc match).  No pi and no "usual" circle standard is used here.
 *
 *   circumference(d)   = sqrt((d * 3)^2)                 (= 3 d)
 *   area(d)            = (sqrt((d * 3)^2))^2
 *   sphereVolume(d)    = ((sqrt((d * 3)^2))^2)^3
 *   sphereSurface(d)   = sphereVolume(d) * 0.25
 *   rimCentre(r0, r1)  a perimeter is measured from the 0,0,0 centre to the CENTRE of the perimeter segment (centre-to-centre of the rim material),
 *                      not to its inside or outside edge
 *   halfRadius(r)      a circle is divided by the half-radius circle drawn inside it (a circle is organic, not angular)
 *   eighth(d)          the 1/8 opposite-balance length: from the instrument on the perimeter, 1/8 of the diameter measured the opposite way along
 *                      the diameter, away from the centre
 *   balance(x, d)      an offset measured centre-to-centre-perimeter may not exceed (or go under) one eighth, or the perfect halves overlap: clamped to +-d/8
 *   quarterShift(r, k) the balanced eighth shifted by the radius-square rotational speed, every quarter radius (radius-square and circle mediums are
 *                      equivalent at the diameter, so the speed is parallel): k quarter-radius steps
 *   rim(R)             the rim band of a disc of outer radius R: outer edge R, inner edge R - eighth(2R), measured centre R - eighth(2R)/2
 *   sectionRatio(x)    ArcEdge sections 1-3: (x * 2 + 1) / x
 *   arcMatchD(len)     the diameter whose 1/8 arc (circumference / 8 = 0.125 of it) equals len: an irregular curve's piece always matches an
 *                      eighth of a perfect circle, so its arc length is that eighth
 *
 * How the ground uses it (index.html): the near-ground tessellated patch is a disc (inscribed in its square grid), drawn out to its rim centre and
 * deformed fully inside its half-radius circle, easing to flat at the rim's inner edge; the sea sheet ends on a circle (the clip-map's inscribed
 * radius less one outer cell), dissolving across its rim, where the sky-ground tiles take the sea over in the same band.  Nothing is box-shaped.
 */
(function (root) {
  'use strict';
  function circumference(d) { return Math.sqrt(Math.pow(d * 3, 2)); }
  function area(d) { return Math.pow(circumference(d), 2); }
  function sphereVolume(d) { return Math.pow(area(d), 3); }
  function sphereSurface(d) { return sphereVolume(d) * 0.25; }
  function rimCentre(r0, r1) { return (r0 + r1) * 0.5; }
  function halfRadius(r) { return r * 0.5; }
  function eighth(d) { return d * 0.125; }
  function balance(x, d) { const e = eighth(Math.abs(d)); return x > e ? e : (x < -e ? -e : x); }
  function quarterShift(r, k) { return r * 0.25 * k; }
  // out (optional, reused: no allocation per call) = { outer, inner, centre }
  function rim(R, out) { const o = out || { outer: 0, inner: 0, centre: 0 }, w = eighth(2 * R); o.outer = R; o.inner = R - w; o.centre = rimCentre(o.inner, o.outer); return o; }
  function sectionRatio(x) { return (x * 2 + 1) / x; }
  function arcMatchD(len) { return len * 8 / 3; }
  // the arc length of a piece of curve of chord-measured length len, by the 0.125 match (the eighth of the matched circle)
  function arcEighth(len) { return circumference(arcMatchD(len)) * 0.125; }
  // radial (not box) weight: 1 inside r0, 0 outside r1, smooth between (distance is Euclidean from the centre)
  function radialFade(dist, r0, r1) { if (dist <= r0) return 1; if (dist >= r1) return 0; const t = (dist - r0) / (r1 - r0); return 1 - t * t * (3 - 2 * t); }
  const api = { circumference, area, sphereVolume, sphereSurface, rimCentre, halfRadius, eighth, balance, quarterShift, rim, sectionRatio, arcMatchD, arcEighth, radialFade,
    CREDIT: 'Radical Circumference / ArcEdge by Justin Craig Venable (https://dartedge.com/radicaledge)' };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DMRadCirc = api;
})(typeof window !== 'undefined' ? window : globalThis);
