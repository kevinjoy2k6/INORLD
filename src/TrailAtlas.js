/* ============================================================================
 * TrailAtlas — a heading-up, low-poly map of the actual terrain grids
 *
 * Every ground mark is a cached triangle built from the finished heightfield,
 * biome, slope and water arrays. No contours, marching squares, raster map or
 * per-frame terrain sampling. The HUD calls draw() on its existing 12.5 Hz tick.
 * ========================================================================== */

import { ROADS, regionAt } from './WorldAtlas.js';

const RANGE_M = 200;
const STEP = 4; // 4 × 4.923 m terrain cells: broad, legible map facets.
const INSET = 7;
const CREAM = '#f4efe6';
const AMBER = '#f2be5c';
const INK = 'rgba(9, 11, 12, 0.82)';

const BASE_COLOURS = {
  meadow: 0xc7a45a,
  canyon: 0x89959a,
  alpine: 0xa6b2a7,
  coast: 0xddc58e,
  trail: 0xc9ad79,
  mud: 0x707158,
  rock: 0x78878f,
  snow: 0xdde6e8,
  sand: 0xd5ba7e,
  shallow: 0x62bcc0,
  water: 0x3b9da9,
  deep: 0x257786,
};

function colour(hex, factor) {
  const channel = (shift) => Math.max(0, Math.min(255, Math.round(((hex >> shift) & 255) * factor)));
  return `#${((channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).padStart(6, '0')}`;
}

const PALETTES = {};
for (const [key, hex] of Object.entries(BASE_COLOURS)) {
  PALETTES[key] = [0.84, 0.92, 1, 1.08, 1.16].map((factor) => colour(hex, factor));
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class TrailAtlas {
  constructor({ terrain, canvas }) {
    this.terrain = terrain;
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.ready = false;
    this.buildMs = 0;
    this.lastDrawMs = 0;
    this.facets = 0;
    this.pathCount = 0;
    this.rangeM = RANGE_M;
    this.step = STEP;
    this._size = { w: 0, h: 0, cssW: 0 };
    this._paths = null;
  }

  _build() {
    const terrain = this.terrain;
    if (!terrain?.heights || !terrain.waterGrid || !terrain.biomeGrid || !terrain.slopeGrid) return false;
    const t0 = performance.now();
    const verts = terrain.segments + 1;
    const cells = Math.floor(terrain.segments / STEP);
    const half = terrain.halfSize;
    const buckets = new Map();

    const addTriangle = (points, indices, i, j, triangle) => {
      let h = 0;
      let slope = 0;
      let water = 0;
      for (const index of indices) {
        h += terrain.heights[index];
        slope += terrain.slopeGrid[index];
        water += terrain.waterGrid[index];
      }
      h /= 3;
      slope /= 3;
      water /= 3;

      let base;
      let tone;
      if (water > 0.025) {
        base = water < 0.22 ? 'shallow' : water < 0.65 ? 'water' : 'deep';
        tone = 2;
      } else {
        const key = ['trail', 'hardpack', 'mud', 'sand', 'snow', 'rock', 'water'][terrain.biomeGrid[indices[0]]];
        const cx = (points[0][0] + points[1][0] + points[2][0]) / 3;
        const cz = (points[0][1] + points[1][1] + points[2][1]) / 3;
        const region = regionAt(cx, cz).id;
        if (key === 'trail') base = 'trail';
        else if (key === 'mud') base = 'mud';
        else if (key === 'snow' && slope <= 0.48) base = 'snow';
        else if (key === 'rock' || key === 'snow' || slope > 0.75) base = 'rock';
        else if (key === 'sand') base = region === 'coast' ? 'coast' : 'sand';
        else base = region;
        const facetVariation = ((i + j + triangle) & 1) ? 0.35 : -0.35;
        tone = clamp(Math.round(2 + (h - 12) / 24 - slope * 0.7 + facetVariation), 0, 4);
      }

      const bucketKey = `${base}:${tone}`;
      let path = buckets.get(bucketKey);
      if (!path) {
        path = new Path2D();
        buckets.set(bucketKey, path);
      }
      path.moveTo(points[0][0], points[0][1]);
      path.lineTo(points[1][0], points[1][1]);
      path.lineTo(points[2][0], points[2][1]);
      path.closePath();
      this.facets += 1;
    };

    for (let i = 0; i < cells; i += 1) {
      const gi = i * STEP;
      const ni = (i + 1) * STEP;
      const x0 = -half + gi * terrain.elementSize;
      const x1 = -half + ni * terrain.elementSize;
      for (let j = 0; j < cells; j += 1) {
        const gj = j * STEP;
        const nj = (j + 1) * STEP;
        const z0 = -half + gj * terrain.elementSize;
        const z1 = -half + nj * terrain.elementSize;
        const a = gi * verts + gj;
        const b = ni * verts + gj;
        const c = ni * verts + nj;
        const d = gi * verts + nj;
        addTriangle([[x0, z0], [x0, z1], [x1, z0]], [a, d, b], i, j, 0);
        addTriangle([[x1, z0], [x0, z1], [x1, z1]], [b, d, c], i, j, 1);
      }
    }

    const roadPath = new Path2D();
    const trailPath = new Path2D();
    const kinds = new Map(ROADS.map((road) => [road.id, road.kind]));
    const paths = terrain.trailPoints?.length ? terrain.trailPoints : ROADS.map((road) => road.points);
    const names = terrain.pathNames?.length ? terrain.pathNames : ROADS.map((road) => road.id);
    paths.forEach((points, index) => {
      const target = kinds.get(names[index]) === 'road' ? roadPath : trailPath;
      points.forEach(([x, z], k) => {
        if (k === 0) target.moveTo(x, z);
        else target.lineTo(x, z);
      });
    });

    this._paths = {
      facets: Array.from(buckets, ([key, path]) => {
        const split = key.lastIndexOf(':');
        return { path, colour: PALETTES[key.slice(0, split)][Number(key.slice(split + 1))] };
      }),
      roadPath,
      trailPath,
    };
    this.pathCount = this._paths.facets.length;
    this.buildMs = performance.now() - t0;
    this.ready = true;
    return true;
  }

  _syncSize() {
    if (!this.canvas || !this.ctx) return false;
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(48, Math.round(rect.width || 208));
    const cssH = Math.max(48, Math.round(rect.height || 144));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cssW * ratio);
    const h = Math.round(cssH * ratio);
    if (w !== this._size.w || h !== this._size.h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this._size = { w, h, cssW };
    }
    return true;
  }

  draw({ x, z, headingRad = 0, objective = null }) {
    if (!this._syncSize()) return;
    if (!this.ready && !this._build()) return;
    const t0 = performance.now();
    const ctx = this.ctx;
    const { w, h, cssW } = this._size;
    const u = w / cssW;
    const cx = w / 2;
    const cy = h / 2;
    const inset = INSET * u;
    const fw = w - inset * 2;
    const fh = h - inset * 2;
    const radius = 11 * u;
    const scale = Math.min(fw, fh) / (RANGE_M * 2);
    const paths = this._paths;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#bda777';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(inset, inset, fw, fh, radius);
    ctx.clip();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-headingRad);
    ctx.scale(scale, scale);
    ctx.translate(-x, -z);
    for (const facet of paths.facets) {
      ctx.fillStyle = facet.colour;
      ctx.fill(facet.path);
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(9,11,12,.64)';
    ctx.lineWidth = (4 * u) / scale;
    ctx.stroke(paths.roadPath);
    ctx.strokeStyle = '#ead3a2';
    ctx.lineWidth = (2.1 * u) / scale;
    ctx.stroke(paths.roadPath);
    ctx.strokeStyle = 'rgba(9,11,12,.55)';
    ctx.lineWidth = (2.6 * u) / scale;
    ctx.stroke(paths.trailPath);
    ctx.strokeStyle = '#bda373';
    ctx.lineWidth = (1.2 * u) / scale;
    ctx.setLineDash([(4 * u) / scale, (3 * u) / scale]);
    ctx.stroke(paths.trailPath);
    ctx.setLineDash([]);
    ctx.restore();

    let distanceLabel = null;
    if (objective?.zone?.pos) {
      const dx = objective.zone.pos.x - x;
      const dz = objective.zone.pos.z - z;
      const distance = Math.hypot(dx, dz);
      const rx = (Math.cos(headingRad) * dx + Math.sin(headingRad) * dz) * scale;
      const ry = (-Math.sin(headingRad) * dx + Math.cos(headingRad) * dz) * scale;
      const availableX = fw / 2 - 10 * u;
      const availableY = fh / 2 - 10 * u;
      const inside = Math.abs(rx) <= availableX && Math.abs(ry) <= availableY;
      distanceLabel = distance >= 1000 ? `${(distance / 1000).toFixed(1)} KM` : `${Math.round(distance)} M`;

      if (inside) {
        const mx = cx + rx;
        const my = cy + ry;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(mx, my);
        ctx.strokeStyle = 'rgba(242,190,92,.35)';
        ctx.lineWidth = u;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(mx, my - 5 * u);
        ctx.lineTo(mx + 5 * u, my);
        ctx.lineTo(mx, my + 5 * u);
        ctx.lineTo(mx - 5 * u, my);
        ctx.closePath();
      } else {
        const length = Math.max(0.001, Math.hypot(rx, ry));
        const rayScale = Math.min(availableX / Math.max(0.001, Math.abs(rx)), availableY / Math.max(0.001, Math.abs(ry)));
        const tipX = cx + rx * rayScale;
        const tipY = cy + ry * rayScale;
        const ux = rx / length;
        const uy = ry / length;
        const baseX = tipX - ux * 9 * u;
        const baseY = tipY - uy * 9 * u;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(baseX - uy * 5 * u, baseY + ux * 5 * u);
        ctx.lineTo(baseX + uy * 5 * u, baseY - ux * 5 * u);
        ctx.closePath();
      }
      ctx.fillStyle = AMBER;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2 * u;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    ctx.beginPath();
    ctx.roundRect(inset, inset, fw, fh, radius);
    ctx.strokeStyle = 'rgba(244,239,230,.28)';
    ctx.lineWidth = 1.2 * u;
    ctx.stroke();

    // North seeks around the fixed truck; no compass ring or contour clutter.
    const nx = -Math.sin(headingRad);
    const ny = -Math.cos(headingRad);
    const northX = inset + 14 * u;
    const northY = inset + 15 * u;
    ctx.beginPath();
    ctx.moveTo(northX + nx * 7 * u, northY + ny * 7 * u);
    ctx.lineTo(northX - nx * 5 * u - ny * 3 * u, northY - ny * 5 * u + nx * 3 * u);
    ctx.lineTo(northX - nx * 5 * u + ny * 3 * u, northY - ny * 5 * u - nx * 3 * u);
    ctx.closePath();
    ctx.fillStyle = CREAM;
    ctx.fill();
    ctx.font = `700 ${8 * u}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', northX + nx * 13 * u, northY + ny * 13 * u);

    // Fixed centre chevron: the vehicle always points up.
    ctx.beginPath();
    ctx.moveTo(cx, cy - 7.5 * u);
    ctx.lineTo(cx + 5.2 * u, cy + 6 * u);
    ctx.lineTo(cx, cy + 3 * u);
    ctx.lineTo(cx - 5.2 * u, cy + 6 * u);
    ctx.closePath();
    ctx.fillStyle = CREAM;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2 * u;
    ctx.fill();
    ctx.stroke();

    const bar = 50 * scale;
    const barX = inset + 10 * u;
    const barY = h - inset - 10 * u;
    ctx.beginPath();
    ctx.moveTo(barX, barY - 3 * u);
    ctx.lineTo(barX, barY);
    ctx.lineTo(barX + bar, barY);
    ctx.lineTo(barX + bar, barY - 3 * u);
    ctx.strokeStyle = 'rgba(244,239,230,.75)';
    ctx.lineWidth = u;
    ctx.stroke();
    ctx.font = `600 ${7.5 * u}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'left';
    ctx.fillStyle = CREAM;
    ctx.fillText('50 M', barX, barY - 6 * u);

    if (distanceLabel) {
      ctx.font = `700 ${8.5 * u}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = 'right';
      ctx.fillStyle = AMBER;
      ctx.fillText(distanceLabel, w - inset - 9 * u, h - inset - 10 * u);
    }

    this.lastDrawMs = performance.now() - t0;
  }
}
