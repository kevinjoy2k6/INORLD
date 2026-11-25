/* ============================================================================
 * FieldChart — the round, heading-up chart in the expedition pill
 *
 *  This replaces the old north-up raster minimap wholesale. Nothing survives
 *  from it: no baked bitmap, no pixelated blit, no fixed north. The chart is a
 *  vector drawing of the valley, rotated so the truck's nose is always up, the
 *  way a road-book or a rally co-driver's map is held.
 *
 *  What is on it: the ground as two flat elevation bands with hairline contours,
 *  the river and lakes as shorelines, the graded roads as sand ribbons and the
 *  trails as dashed tracks. Everything is built ONCE into Path2D objects in
 *  world coordinates at startup, so a frame is: clear, clip a circle, apply one
 *  rotate/scale/translate, fill four paths, stroke three, then draw the ring,
 *  the compass points, the truck and the objective. No sampling, no allocation,
 *  no per-frame geometry — the browser re-uses the same path data.
 *
 *  Cost: the one-off build is a marching-squares sweep over a half-resolution
 *  height grid (209²) for four contours; a frame is a handful of path fills at
 *  12.5 Hz. `chart.buildMs` and `chart.lastDrawMs` report both honestly.
 *
 *  Style: flat fills, cream hairlines, one amber accent for the objective. The
 *  contour step is deliberately coarse so the drawing reads as a low-poly map,
 *  not a topographic survey.
 * ========================================================================== */

import { ROADS } from './WorldAtlas.js';

/** Metres across the visible circle, edge to edge. */
const RANGE = 400;
const RADIUS_M = RANGE / 2;

/** CSS px between the circle's edge and the canvas edge. */
const EDGE_INSET = 7;

/** Contour grid decimation: every Nth terrain vertex. 2 ⇒ ~9.8 m cells. */
const STEP = 2;

const GROUND = '#121617';
/** Four elevation bands, darkest first. Quantile levels, so they always shade. */
const BANDS = ['#1d2420', '#262f29', '#313a32', '#3f4a3d'];
/** Share of the map below each band's level. */
const BAND_QUANTILES = [0.18, 0.42, 0.66, 0.86];
const CONTOUR_LINE = 'rgba(226, 220, 205, 0.16)';

const WATER = '#2b5560';
const WATER_DEEP = '#1b3d4b';
const SHORE_LINE = 'rgba(160, 213, 216, 0.30)';

const ROAD_CASING = 'rgba(9, 11, 12, 0.65)';
const ROAD_SAND = '#c7a679';
const TRAIL_SAND = '#8d7853';

const RING = 'rgba(244, 239, 230, 0.22)';
const RING_INNER = 'rgba(244, 239, 230, 0.10)';
const CREAM = '#f4efe6';
const AMBER = '#f2be5c';
const AMBER_FAR = '#e5a93c';
const INK = 'rgba(9, 11, 12, 0.85)';

/* ------------------------------------------------------------------ *
 *  marching squares
 *
 *  `sample` is indexed i * verts + j, where i runs along x and j along z
 *  (the terrain's own layout). Returns closed rings of [i, j] grid points;
 *  open chains (only possible at the grid border) are closed implicitly.
 * ------------------------------------------------------------------ */

function contourLoops(sample, verts, level) {
  const G = verts - 1;
  const pts = new Map();
  const segs = [];

  // Keys must identify the GRID edge, not the cell that touched it, or two
  // neighbouring cells produce different keys for the same crossing and no
  // contour can ever be chained. Horizontal edge (col i, row j) sits between
  // (i,j) and (i+1,j); vertical edge (col i, row j) between (i,j) and (i,j+1).
  const edgeKey = (type, col, row) => type * (verts * verts) + row * verts + col;
  const edgePoint = (type, col, row, ax, az, bx, bz, va, vb) => {
    const key = edgeKey(type, col, row);
    if (!pts.has(key)) {
      let t = (level - va) / (vb - va);
      if (!Number.isFinite(t)) t = 0.5;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      pts.set(key, [ax + (bx - ax) * t, az + (bz - az) * t]);
    }
    return key;
  };

  for (let j = 0; j < G; j += 1) {
    for (let i = 0; i < G; i += 1) {
      const a = sample[i * verts + j];
      const b = sample[(i + 1) * verts + j];
      const c = sample[(i + 1) * verts + j + 1];
      const d = sample[i * verts + j + 1];

      let mask = 0;
      if (a > level) mask |= 8;
      if (b > level) mask |= 4;
      if (c > level) mask |= 2;
      if (d > level) mask |= 1;
      if (mask === 0 || mask === 15) continue;

      const top = edgePoint(0, i, j, i, j, i + 1, j, a, b);
      const right = edgePoint(1, i + 1, j, i + 1, j, i + 1, j + 1, b, c);
      const bottom = edgePoint(0, i, j + 1, i, j + 1, i + 1, j + 1, d, c);
      const left = edgePoint(1, i, j, i, j, i, j + 1, a, d);

      switch (mask) {
        case 1: case 14: segs.push([left, bottom]); break;
        case 2: case 13: segs.push([bottom, right]); break;
        case 3: case 12: segs.push([left, right]); break;
        case 4: case 11: segs.push([top, right]); break;
        case 6: case 9: segs.push([top, bottom]); break;
        case 7: case 8: segs.push([top, left]); break;
        // Saddles: two crossings, resolved into two separate segments.
        case 5: segs.push([top, right], [bottom, left]); break;
        case 10: segs.push([top, left], [bottom, right]); break;
        default: break;
      }
    }
  }

  // Chain segments into rings by shared edge keys.
  const adj = new Map();
  for (let k = 0; k < segs.length; k += 1) {
    for (const key of segs[k]) {
      const list = adj.get(key);
      if (list) list.push(k);
      else adj.set(key, [k]);
    }
  }

  const used = new Uint8Array(segs.length);
  const rings = [];

  for (let k = 0; k < segs.length; k += 1) {
    if (used[k]) continue;
    used[k] = 1;
    const start = segs[k][0];
    let cur = segs[k][1];
    const ring = [pts.get(start), pts.get(cur)];

    while (cur !== start) {
      const list = adj.get(cur);
      if (!list) break;
      let next = -1;
      for (const candidate of list) {
        if (candidate !== k && !used[candidate]) { next = candidate; break; }
      }
      if (next < 0) break;
      used[next] = 1;
      const [a, b] = segs[next];
      cur = a === cur ? b : a;
      ring.push(pts.get(cur));
    }

    if (ring.length >= 3) rings.push(ring);
  }

  return rings;
}

/** Rings of grid points → one Path2D in world metres. */
function ringsToPath(rings, origin, cell) {
  const path = new Path2D();
  for (const ring of rings) {
    const [i0, j0] = ring[0];
    path.moveTo(origin + i0 * cell, origin + j0 * cell);
    for (let k = 1; k < ring.length; k += 1) {
      const [i, j] = ring[k];
      path.lineTo(origin + i * cell, origin + j * cell);
    }
    path.closePath();
  }
  return path;
}

/** Every STEP-th vertex of a terrain grid, as its own small field. */
function decimate(sample, verts, step) {
  const n = Math.floor((verts - 1) / step) + 1;
  const out = new Float32Array(n * n);
  for (let i = 0; i < n; i += 1) {
    const src = i * step * verts;
    const dst = i * n;
    for (let j = 0; j < n; j += 1) out[dst + j] = sample[src + j * step];
  }
  return { data: out, verts: n };
}

export class FieldChart {
  constructor({ terrain, canvas }) {
    this.terrain = terrain;
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.ready = false;
    this.buildMs = 0;
    this.lastDrawMs = 0;
    /** Diagnostic: how many contour segments went into the build. */
    this.segments = 0;
    this._size = { w: 0, h: 0 };
    this._paths = null;
  }

  /* ================================================================== *
   *  the one-off build
   * ================================================================== */

  _build() {
    const terrain = this.terrain;
    if (!terrain || !terrain.heights || !terrain.waterGrid) return false;

    const t0 = performance.now();
    const verts = terrain.segments + 1;
    const half = terrain.halfSize;
    const cell = terrain.elementSize * STEP;

    const heights = terrain.heights;

    // Band levels come from the height DISTRIBUTION, not from min/max: this
    // valley is a low plain with a few peaks, so percentage-of-range levels sat
    // above the whole playable floor and left nine tenths of the chart blank.
    const samples = [];
    for (let i = 0; i < heights.length; i += 13) samples.push(heights[i]);
    samples.sort((a, b) => a - b);
    const quantile = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))] || 0;

    const ground = decimate(heights, verts, STEP);
    const wet = decimate(terrain.waterGrid, verts, STEP);

    let count = 0;
    const build = (field, level) => {
      const rings = contourLoops(field.data, field.verts, level);
      count += rings.length;
      return ringsToPath(rings, -half, cell);
    };

    const bands = BAND_QUANTILES.map((p) => build(ground, quantile(p)));
    const shore = build(wet, 0.02);
    const deep = build(wet, 0.55);

    /* ---- roads and trails, straight from the atlas ---- */
    const roadPath = new Path2D();
    const trailPath = new Path2D();
    for (const road of ROADS) {
      const path = road.kind === 'road' ? roadPath : trailPath;
      road.points.forEach(([x, z], k) => {
        if (k === 0) path.moveTo(x, z);
        else path.lineTo(x, z);
      });
    }

    this._paths = { bands, shore, deep, roadPath, trailPath };
    this.segments = count;
    this.buildMs = performance.now() - t0;
    this.ready = true;
    return true;
  }

  /* ================================================================== *
   *  sizing
   * ================================================================== */

  _syncSize() {
    const canvas = this.canvas;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const css = Math.max(48, Math.round(rect.width || 132));
    const target = Math.round(css * Math.min(2.5, window.devicePixelRatio || 1));
    if (target !== this._size.w) {
      canvas.width = target;
      canvas.height = target;
      this._size.w = target;
      this._size.h = target;
    }
    return this.ctx !== null;
  }

  /* ================================================================== *
   *  per-tick draw — heading up, truck pinned at the centre
   * ================================================================== */

  /**
   * @param {object} frame
   * @param {number} frame.x  truck world x
   * @param {number} frame.z  truck world z
   * @param {number} frame.headingRad  truck yaw, atan2(forwardX, -forwardZ)
   * @param {?object} frame.objective  MissionManager.nextObjective() result
   */
  draw({ x, z, headingRad = 0, objective = null }) {
    if (!this.canvas || !this._syncSize()) return;
    if (!this.ready && !this._build()) return;

    const t0 = performance.now();
    const ctx = this.ctx;
    const w = this._size.w;
    const h = this._size.h;
    // Everything below is authored in CSS px against a 132 px chart, then
    // scaled by `u` so a retina backing store draws the same chart, sharper.
    const u = Math.max(1, w / 132);
    const cx = w / 2;
    const cy = h / 2;
    const r = w / 2 - EDGE_INSET * u;
    const s = r / RADIUS_M; // px per metre
    const paths = this._paths;

    const cos = Math.cos(headingRad);
    const sin = Math.sin(headingRad);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, w, h);

    /* ---- the valley, rotated so the nose points up ---- */
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-headingRad);
    ctx.scale(s, s);
    ctx.translate(-x, -z);

    // Darkest band first: each later fill sits inside the previous one.
    for (let k = 0; k < paths.bands.length; k += 1) {
      ctx.fillStyle = BANDS[k];
      ctx.fill(paths.bands[k]);
    }

    // Contour hairlines: the outline of each band, one pixel wide at any
    // device ratio (the transform is px/m, so the width is divided by it).
    ctx.strokeStyle = CONTOUR_LINE;
    ctx.lineWidth = u / s;
    for (const band of paths.bands) ctx.stroke(band);

    ctx.fillStyle = WATER;
    ctx.fill(paths.shore);
    ctx.strokeStyle = SHORE_LINE;
    ctx.lineWidth = u / s;
    ctx.stroke(paths.shore);
    ctx.fillStyle = WATER_DEEP;
    ctx.fill(paths.deep);

    // Roads: dark casing first so the sand reads on both water and rock.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.strokeStyle = ROAD_CASING;
    ctx.lineWidth = (3.6 * u) / s;
    ctx.stroke(paths.roadPath);
    ctx.strokeStyle = ROAD_SAND;
    ctx.lineWidth = (1.9 * u) / s;
    ctx.stroke(paths.roadPath);

    // Trails: a thinner casing and a dashed sand line.
    ctx.strokeStyle = ROAD_CASING;
    ctx.lineWidth = (2.4 * u) / s;
    ctx.stroke(paths.trailPath);
    ctx.strokeStyle = TRAIL_SAND;
    ctx.lineWidth = (1.1 * u) / s;
    ctx.setLineDash([(4 * u) / s, (3 * u) / s]);
    ctx.stroke(paths.trailPath);
    ctx.setLineDash([]);

    ctx.restore(); // end of the world transform; still clipped to the circle

    /* ---- range rings: 100 m and 200 m from the truck ---- */
    for (const metres of [100, RADIUS_M]) {
      ctx.beginPath();
      ctx.arc(cx, cy, metres * s, 0, Math.PI * 2);
      ctx.strokeStyle = RING_INNER;
      ctx.lineWidth = u;
      ctx.setLineDash([u * 2, u * 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* ---- objective ---- */
    let label = null;
    if (objective?.zone?.pos) {
      const dx = objective.zone.pos.x - x;
      const dz = objective.zone.pos.z - z;
      const distance = Math.hypot(dx, dz);
      // World offset in the chart's rotated frame.
      const rx = (cos * dx + sin * dz) * s;
      const rz = (-sin * dx + cos * dz) * s;
      const dist = Math.hypot(rx, rz);
      const limit = r - 11 * u;
      label = distance >= 1000 ? `${(distance / 1000).toFixed(1)} KM` : `${Math.round(distance)} M`;

      if (dist <= limit) {
        const mx = cx + rx;
        const my = cy + rz;
        ctx.beginPath();
        ctx.moveTo(mx, my - 5 * u);
        ctx.lineTo(mx + 5 * u, my);
        ctx.lineTo(mx, my + 5 * u);
        ctx.lineTo(mx - 5 * u, my);
        ctx.closePath();
        ctx.fillStyle = AMBER;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.4 * u;
        ctx.fill();
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(mx, my);
        ctx.strokeStyle = 'rgba(242, 190, 92, 0.30)';
        ctx.lineWidth = u;
        ctx.stroke();
      } else {
        // Off-chart: an arrowhead on the ring, still pointing the way.
        const angle = Math.atan2(rz, rx);
        const ax = Math.cos(angle);
        const ay = Math.sin(angle);
        const px = -ay;
        const py = ax;
        const tipX = cx + ax * (r - 4 * u);
        const tipY = cy + ay * (r - 4 * u);
        const baseX = cx + ax * (r - 12 * u);
        const baseY = cy + ay * (r - 12 * u);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(baseX + px * 5 * u, baseY + py * 5 * u);
        ctx.lineTo(baseX - px * 5 * u, baseY - py * 5 * u);
        ctx.closePath();
        ctx.fillStyle = AMBER_FAR;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.2 * u;
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.restore();

    /* ---- ring and compass points, rotated with the world ---- */
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = RING;
    ctx.lineWidth = 1.4 * u;
    ctx.stroke();

    ctx.font = `600 ${Math.round(8.5 * u)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let bearing = 0; bearing < 360; bearing += 30) {
      const radians = (bearing * Math.PI) / 180 - headingRad;
      const dirX = Math.sin(radians);
      const dirY = -Math.cos(radians);
      const cardinal = bearing % 90 === 0;
      const inner = r - (cardinal ? 15 * u : 9 * u);
      ctx.beginPath();
      ctx.moveTo(cx + dirX * (r - 4.5 * u), cy + dirY * (r - 4.5 * u));
      ctx.lineTo(cx + dirX * inner, cy + dirY * inner);
      ctx.strokeStyle = cardinal ? 'rgba(244, 239, 230, 0.55)' : RING;
      ctx.lineWidth = (cardinal ? 1.6 : 1) * u;
      ctx.stroke();

      if (cardinal) {
        ctx.fillStyle = bearing === 0 ? CREAM : 'rgba(244, 239, 230, 0.5)';
        ctx.fillText(
          ['N', 'E', 'S', 'W'][bearing / 90],
          cx + dirX * (r - 21 * u),
          cy + dirY * (r - 21 * u),
        );
      }
    }

    /* ---- the truck: cream chevron, always pointing up ---- */
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(u, u);
    ctx.beginPath();
    ctx.moveTo(0, -7.5);
    ctx.lineTo(5.2, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5.2, 6);
    ctx.closePath();
    ctx.fillStyle = CREAM;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    /* ---- distance to the objective, along the bottom of the circle ---- */
    if (label) {
      const text = `${label}`;
      const fontPx = Math.round(9 * u);
      ctx.font = `600 ${fontPx}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const width = ctx.measureText(text).width;
      const plateW = width + 10 * u;
      const plateH = 12 * u;
      ctx.fillStyle = 'rgba(9, 11, 12, 0.66)';
      ctx.beginPath();
      ctx.roundRect(cx - plateW / 2, cy + r - plateH - 5 * u, plateW, plateH, 3 * u);
      ctx.fill();
      ctx.fillStyle = AMBER;
      ctx.fillText(text, cx, cy + r - 5 * u - plateH / 2 + 0.5 * u);
    }

    this.lastDrawMs = performance.now() - t0;
  }
}
