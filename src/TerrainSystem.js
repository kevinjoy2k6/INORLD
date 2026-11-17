import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { REGIONS, ROADS, regionAt, WORLD, WORLD_SCALE } from './WorldAtlas.js';
import {
  shapeProvingGround,
  resolveDatum,
  spawnPoint,
  PROVING_GROUND,
} from './ProvingGround.js';

/* ================================================================== *
 *  Deterministic noise
 *  A seeded mulberry32 feeds a permutation table; the permutation
 *  drives 2D simplex noise, and fBm stacks it into terrain.
 * ================================================================== */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

export function makeNoise2D(seed) {
  const random = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) p[i] = i;
  for (let i = 255; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i += 1) perm[i] = p[i & 255];

  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;

  return function noise2D(x, y) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;

    const g0 = GRAD2[perm[ii + perm[jj]] % 8];
    const g1 = GRAD2[perm[ii + i1 + perm[jj + j1]] % 8];
    const g2 = GRAD2[perm[ii + 1 + perm[jj + 1]] % 8];

    let n0 = 0;
    let n1 = 0;
    let n2 = 0;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      t0 *= t0;
      n0 = t0 * t0 * (g0[0] * x0 + g0[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      t1 *= t1;
      n1 = t1 * t1 * (g1[0] * x1 + g1[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      t2 *= t2;
      n2 = t2 * t2 * (g2[0] * x2 + g2[1] * y2);
    }

    return 70 * (n0 + n1 + n2);
  };
}

export function fbm(noise, x, y, octaves = 4, lacunarity = 2.03, gain = 0.5) {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o += 1) {
    sum += amplitude * noise(x * frequency, y * frequency);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampNumber = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/* ================================================================== *
 *  Biomes
 *  `friction` / `softness` / `viscousDrag` / `maxSinkage` are the public
 *  contract; `grip` / `sinkage` / `dig` / `viscosity` / `rollResistance`
 *  are the aliases OffroadVehicle already consumes.
 * ================================================================== */

export const BIOME = {
  TRAIL: 'trail',
  HARDPACK: 'hardpack',
  MUD: 'mud',
  SAND: 'sand',
  SNOW: 'snow',
  ROCK: 'rock',
  WATER: 'water',
};

const BIOME_KEYS = ['trail', 'hardpack', 'mud', 'sand', 'snow', 'rock', 'water'];
const BIOME_INDEX = {};
BIOME_KEYS.forEach((key, index) => {
  BIOME_INDEX[key] = index;
});

export const BIOMES = {
  trail: {
    key: 'trail',
    biome: 'trail',
    label: 'Valley Trail',
    friction: 0.88,
    softness: 0.05,
    viscousDrag: 110,
    maxSinkage: 0.05,
    waterDepth: 0,
    grip: 0.88,
    sinkage: 0.05,
    dig: 0.35,
    viscosity: 110,
    rollResistance: 0.028,
    color: 0x7d6845,
  },
  hardpack: {
    key: 'hardpack',
    biome: 'hardpack',
    label: 'Hardpack',
    friction: 0.92,
    softness: 0.015,
    viscousDrag: 60,
    maxSinkage: 0.015,
    waterDepth: 0,
    grip: 0.92,
    sinkage: 0.015,
    dig: 0.1,
    viscosity: 60,
    rollResistance: 0.019,
    color: 0x6d5b40,
  },
  mud: {
    key: 'mud',
    biome: 'mud',
    label: 'Deep Mud',
    friction: 0.33,
    softness: 0.95,
    viscousDrag: 1100,
    maxSinkage: 0.34,
    waterDepth: 0,
    grip: 0.33,
    sinkage: 0.34,
    dig: 1.15,
    viscosity: 1100,
    rollResistance: 0.17,
    color: 0x3a2a1c,
  },
  sand: {
    key: 'sand',
    biome: 'sand',
    label: 'Sand',
    friction: 0.46,
    softness: 0.6,
    viscousDrag: 380,
    maxSinkage: 0.12,
    waterDepth: 0,
    grip: 0.46,
    sinkage: 0.12,
    dig: 0.72,
    viscosity: 380,
    rollResistance: 0.075,
    color: 0xbda274,
  },
  snow: {
    key: 'snow',
    biome: 'snow',
    label: 'Deep Snow',
    friction: 0.3,
    softness: 0.9,
    viscousDrag: 420,
    maxSinkage: 0.22,
    waterDepth: 0,
    grip: 0.3,
    sinkage: 0.22,
    dig: 0.5,
    viscosity: 500,
    rollResistance: 0.1,
    color: 0xdfe9f2,
  },
  rock: {
    key: 'rock',
    biome: 'rock',
    label: 'Rock',
    friction: 0.95,
    softness: 0,
    viscousDrag: 0,
    maxSinkage: 0,
    waterDepth: 0,
    grip: 0.95,
    sinkage: 0,
    dig: 0,
    viscosity: 0,
    rollResistance: 0.03,
    color: 0x615a52,
  },
  water: {
    key: 'water',
    biome: 'water',
    label: 'River Bed',
    friction: 0.42,
    softness: 0.4,
    viscousDrag: 900,
    maxSinkage: 0.08,
    waterDepth: 0,
    grip: 0.42,
    sinkage: 0.08,
    dig: 0.5,
    viscosity: 900,
    rollResistance: 0.11,
    color: 0x4a4436,
  },
};

/* ================================================================== *
 *  TerrainSystem
 * ================================================================== */

/**
 * A single tuft of prairie grass: three tapered blades crossed around the
 * vertical axis.
 *
 * The cone this replaces was one closed spike — from any distance a meadow of
 * them reads as a field of green traffic cones. Three crossed triangles cost
 * the same three triangles (double-sided, so each blade shows from both
 * sides), and because they are flat planes the root-to-tip ramp shades them as
 * a soft sheet instead of shading a cone's facets.
 */
const clampIndex = (v) => {
  const i = Math.round(v);
  return i < 0 ? 0 : i > VERTS - 1 ? VERTS - 1 : i;
};

function createGrassTuftGeometry(height = 1.35, halfWidth = 0.09) {
  const positions = [];
  const normals = [];
  const uvs = [];

  const BLADES = 3;
  for (let b = 0; b < BLADES; b += 1) {
    // Blades fan around the trunk, each leaning slightly so the tuft has a
    // silhouette from every angle.
    const angle = (b / BLADES) * Math.PI * 2 + 0.35;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const lean = 0.16;
    const tall = height * (0.82 + 0.18 * ((b + 1) / BLADES));

    positions.push(
      -dx * halfWidth, 0, -dz * halfWidth,
      dx * halfWidth, 0, dz * halfWidth,
      dx * lean, tall, dz * lean,
    );
    // Up-facing normals: the material patch re-aims them anyway, but this
    // keeps the raw geometry sane if the patch is ever skipped.
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    uvs.push(0, 0, 1, 0, 0.5, 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

const SIZE = WORLD.size;
// 176 cells over 640 m = 3.6 m facets. The flat-shaded style wants planes you
// can read as planes; 2 m cells were small enough to look smooth.
const SEGMENTS = 416;
const ELEMENT = SIZE / SEGMENTS;
const VERTS = SEGMENTS + 1;
const WATER_LEVEL = 1.1;
// Deepest water is WATER_LEVEL - RIVER_BED: 0.95 m, past a stock intake (0.8 m)
// and comfortably inside a snorkel's 1.8 m.
const RIVER_BED = 0.15;
// A graded trail sits this far above the water at its deepest crossing, so a
// ford runs 0.25 m deep instead of inheriting the 0.95 m riverbed that drowns
// a stock intake.
const FORD_FLOOR = WATER_LEVEL - 0.25;
// Steepest leg a trail may have, as a tangent. The truck's 1.9 t on 0.9-grip
// tyres pulls about 7.4 kN, so it climbs to roughly 21 degrees and stalls
// beyond it, and the engine can only just hold 18. 0.2 is 11.3 degrees: after
// the couple of degrees the surface gains where a trail blends into a steeper
// road at a junction it stays around 15, which leaves the truck real margin.
const TRAIL_MAX_GRADE = 0.2;

// Nearby tracks blend their grades over this radius; path bounds have to reach
// as far, or a path just outside another's box cannot contribute. It is wide on
// purpose: where two tracks cross at different heights the blend turns the
// difference into a ramp spread over twice this distance instead of a step.
const PATH_BLEND_RADIUS = 16;
// Waypoint spacing after resampling: fine enough that the corridor follows the
// authored line, coarse enough that the nearest-path pass stays quick.
const PATH_SPACING = 40;

/** The trails with no signpost and no services: the three local lines. */
const UNMARKED_TRAILS = new Set(['quarry-switchbacks', 'ridge-traverse', 'river-run']);

export class TerrainSystem {
  constructor({ scene, world, seed = 20261113, groundMaterial, testMode = false }) {
    this.testMode = !!testMode;
    this.scene = scene;
    this.world = world;
    this.seed = seed >>> 0;
    this.groundMaterial = groundMaterial;

    this.size = SIZE;
    this.segments = SEGMENTS;
    this.elementSize = ELEMENT;
    this.waterLevel = WATER_LEVEL;
    this.halfSize = SIZE / 2;

    this.heights = new Float32Array(VERTS * VERTS);
    // 255 = "let the normal classifier decide". The proving ground writes its
    // own surface keys here so a flat pad stays hardpack and a bowl stays mud.
    this.biomeOverride = new Uint8Array(VERTS * VERTS).fill(255);
    this.biomeGrid = new Uint8Array(VERTS * VERTS);
    this.waterGrid = new Float32Array(VERTS * VERTS);
    this.slopeGrid = new Float32Array(VERTS * VERTS);

    this.noiseA = makeNoise2D(this.seed);
    this.noiseB = makeNoise2D(this.seed + 7717);
    this.noiseC = makeNoise2D(this.seed + 15485863);
    this.noiseD = makeNoise2D(this.seed + 32452843);
    this.random = mulberry32(this.seed ^ 0x9e3779b9);

    this.winchAnchors = [];
    this.treeColliders = [];
    this.boulderBodies = [];
    // Scenery colliders are streamed in and out of the physics world around the
    // truck (see updateColliders).
    this._propBodies = [];
    this._colliderX = Infinity;
    this._colliderZ = Infinity;
    this._colliderRadius = 0;
    this.foliageMask = new Uint8Array(VERTS * VERTS);
    this._foliageMeshes = [];
    this.group = new THREE.Group();
    this.group.name = 'Terrain';
    this.stats = { trees: 0, boulders: 0, poles: 0, anchors: 0 };

    // Scratch objects so the per-frame boulder sync never allocates.
    this._bm = new THREE.Matrix4();
    this._bp = new THREE.Vector3();
    this._bq = new THREE.Quaternion();
    this._bs = new THREE.Vector3();

    // Props and foliage are split into square chunks so each one can be culled
    // on its own. One 2 km-wide instanced mesh can never be frustum-culled, so
    // without this every tree and blade in the valley is submitted on every
    // frame and again in every shadow pass.
    this._chunkSize = 150;
    this._lodGroups = [];
    this._lodChunks = [];
    this._densityMeshes = [];
    this.lodStats = { groups: 0, chunks: 0, near: 0, far: 0, hidden: 0 };

    // Tall grass is scenery, not a wall. Where it grows thick the surface gets
    // a hair less grip and a little more rolling resistance, which reads as
    // "the truck is swishing through a meadow" instead of "the truck hit a
    // brick". Pre-built so the physics tick never allocates a surface object.
    this._grassSurfaces = Object.create(null);
    for (const key of ['trail', 'hardpack', 'sand', 'rock']) {
      const base = BIOMES[key];
      this._grassSurfaces[key] = {
        ...base,
        grip: base.grip * 0.95,
        viscosity: base.viscosity + 50,
        rollResistance: base.rollResistance + 0.011,
        foliage: true,
      };
    }

    this.trailPoints = this._buildTrailLayout();
    // Time of the last hand-back to the browser, and the shared record the
    // trail-field lookup fills in. Both are build/terrain-wide, not per-call.
    this._yieldAt = 0;
    this._trailSample = { distance: 0, height: 0, width: 0 };
  }

  /* ---------------- sliced build ---------------- */

  /**
   * Build the 2 km world without freezing the page.
   *
   * Generation is tens of millions of samples. Done in one pass it is a
   * single seven-second task and the browser cannot paint, respond to a
   * click, or even show a spinner. Every heavy loop below yields the main
   * thread whenever it has run for more than a few milliseconds, so the
   * boot screen stays live and the tab never reports as unresponsive.
   */
  async build(onProgress = null) {
    const report = (fraction, label) => onProgress?.(fraction, label);

    report(0.03, 'GRADING TRAILS');
    await this._generateHeightGrid();

    report(0.38, 'BUILDING GROUND');
    await this._buildMesh();

    report(0.62, 'SOLID GROUND');
    await this._buildPhysics();
    this._buildWater();

    report(0.74, 'PLANTING');
    await this._scatter();

    report(0.84, 'SEEDING THE MEADOW');
    await this._buildFoliage();

    this.spawn = this._resolveSpawn();
    report(1, 'READY');
  }

  /**
   * Hand the main thread back if this slice has had its budget. 6 ms keeps
   * every task well under a frame at 60 Hz, which is what stops the page
   * feeling locked while generation runs.
   */
  async _yield() {
    if (performance.now() - this._yieldAt < 6) return;
    // A MessageChannel hop is a macrotask with no clamp. setTimeout(0) is
    // delayed to a full second in a background tab, which turned a chunked
    // build that yields properly into a minute of sitting at 3% for anyone who
    // opened the game in a background tab.
    await this._nextTask();
    this._yieldAt = performance.now();
  }

  _nextTask() {
    if (!this._taskHop) {
      const channel = new MessageChannel();
      this._taskHop = { channel, queue: [] };
      channel.port1.onmessage = () => {
        const resolve = this._taskHop.queue.shift();
        if (resolve) resolve();
      };
    }
    return new Promise((resolve) => {
      this._taskHop.queue.push(resolve);
      this._taskHop.channel.port2.postMessage(0);
    });
  }

  /* ---------------- layout ---------------- */

  _buildTrailLayout() {
    // A loop through the valley, dipping through the river twice.
    const loop = [
      [-152, -54], [-126, -40], [-104, -34], [-72, -32], [-40, -30],
      [-16, -26], [2, -18], [16, -2], [34, 16], [54, 34], [66, 58],
      [56, 84], [26, 96], [-8, 92], [-46, 78], [-80, 58], [-108, 30],
      [-134, 2], [-152, -54],
    ];
    // A spur climbing toward the alpine shelf.
    const spur = [[34, 16], [58, 12], [84, 22], [104, 44]];

    // The main network from the atlas grades corridors through every region.
    this.pathWidths = [3.4, 3.0];
    // The loop and spur above are authored in the atlas' 640 m design space
    // like everything else, so they have to be stretched with the world —
    // otherwise they stay a tiny ring in the middle of a 2 km map.
    const scalePath = (path) => path.map(([x, z]) => [x * WORLD_SCALE, z * WORLD_SCALE]);
    this.pathNames = ['valley-loop', 'meadow-spur'];
    const paths = [scalePath(loop), scalePath(spur)];
    for (const road of ROADS) {
      paths.push(road.points);
      this.pathWidths.push(road.width);
      this.pathNames.push(road.id);
    }

    // River Run follows the river's own meander at a fixed offset on the north
    // bank. Authored as a straight line in the atlas it spent its length in up
    // to 3.5 m of water; the bank is dry and still hugs the river.
    const bank = [];
    for (let x = -this.halfSize + 90; x <= this.halfSize - 90; x += 60) {
      bank.push([x, clampNumber(this.riverZ(x) + 55, -this.halfSize + 70, this.halfSize - 70)]);
    }
    paths.push(bank);
    this.pathWidths.push(3.4);
    this.pathNames.push('river-run');

    // The unmarked trails must join the network rather than stop in a field.
    for (let i = 0; i < paths.length; i += 1) {
      if (UNMARKED_TRAILS.has(this.pathNames[i])) paths[i] = this._linkEnds(paths[i], paths);
    }

    // Resample to a workable spacing. Atlas waypoints are up to 158 m apart, so
    // a junction fell in the middle of a straight leg where neither track had a
    // waypoint and the two grades could not be made to agree there.
    for (let i = 0; i < paths.length; i += 1) paths[i] = this._resample(paths[i], PATH_SPACING);

    // Per-path bounding box, used to skip paths that cannot possibly be the
    // nearest. With eleven paths over 174k grid points this is the difference
    // between a 20 second load and a fast one.
    this.pathBounds = paths.map((path, index) => {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of path) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const margin = (this.pathWidths[index] ?? 3) + PATH_BLEND_RADIUS;
      return { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
    });

    return paths;
  }

  /** Densify a polyline to at most `maxSpacing` metres between waypoints. */
  _resample(points, maxSpacing) {
    const out = [points[0]];
    for (let i = 1; i < points.length; i += 1) {
      const [x0, z0] = points[i - 1];
      const [x1, z1] = points[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / maxSpacing));
      for (let s = 1; s <= steps; s += 1) {
        out.push([x0 + ((x1 - x0) * s) / steps, z0 + ((z1 - z0) * s) / steps]);
      }
    }
    return out;
  }

  /**
   * Extend a trail's ends to the nearest point on any other track when they are
   * otherwise stranded. A trail that stops in open country is a dead end: you
   * have to turn around, which is not why anyone takes one.
   */
  _linkEnds(points, allPaths) {
    const nearestOnOtherPaths = (px, pz) => {
      let best = null;
      for (const path of allPaths) {
        if (path === points) continue;
        for (const [x, z] of path) {
          const d = Math.hypot(x - px, z - pz);
          if (!best || d < best.d) best = { d, x, z };
        }
      }
      return best;
    };

    // A closed circuit already ends where it starts; there is nothing to link.
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1) return points;

    const out = points.slice();
    const head = nearestOnOtherPaths(out[0][0], out[0][1]);
    if (head && head.d > 40) out.unshift([head.x, head.z]);
    const tail = nearestOnOtherPaths(out[out.length - 1][0], out[out.length - 1][1]);
    if (tail && tail.d > 40) out.push([tail.x, tail.z]);
    return out;
  }

  /**
   * Round the vertical profile: a moving average over waypoint heights, which
   * turns a crease between a climb and a drop into a curve the truck can drive
   * over instead of beaching on.
   */
  _smoothTrailProfile(path, heights, pinned = null) {
    const source = heights.slice();
    for (let i = 1; i < heights.length - 1; i += 1) {
      if (pinned && pinned[i] !== null && pinned[i] !== undefined) continue;
      heights[i] = (source[i - 1] + source[i] * 2 + source[i + 1]) / 4;
    }
  }

  /**
   * Where a trail's end lands on another track, both are pinned to one height.
   * The link leg is otherwise graded to its own ends, and meeting a road that
   * is already at another height leaves a step right where the trail starts.
   */
  _pinSharedEnds() {
    const paths = this.trailPoints;
    const heights = this.trailHeights;
    const pins = this.trailPins;

    for (let p = 0; p < paths.length; p += 1) {
      for (const end of [0, paths[p].length - 1]) {
        const [x, z] = paths[p][end];
        for (let q = 0; q < paths.length; q += 1) {
          if (q === p) continue;
          for (let k = 0; k < paths[q].length; k += 1) {
            const apart = Math.hypot(paths[q][k][0] - x, paths[q][k][1] - z);
            if (apart > 1) continue;
            // Only worth pinning when the trail can actually arrive there: a pin
            // it cannot reach inside the grade limit is a step at the very end.
            const previous = end === 0 ? 1 : paths[p].length - 2;
            const run = Math.hypot(paths[p][previous][0] - x, paths[p][previous][1] - z);
            if (Math.abs(heights[p][end] - heights[q][k]) > run * TRAIL_MAX_GRADE) continue;
            const h = (heights[p][end] + heights[q][k]) / 2;
            heights[p][end] = h;
            pins[p][end] = h;
            heights[q][k] = h;
            pins[q][k] = h;
          }
        }
      }
    }
  }

  /**
   * Put a waypoint on both tracks at every place they cross, at one shared
   * height, and pin it. Two independently graded lines cannot agree in the
   * middle of a leg without this, and the difference becomes a wall where the
   * trail crosses a road that is climbing.
   */
  _stitchCrossings() {
    const paths = this.trailPoints;
    const heights = this.trailHeights;
    const pins = this.trailPins;
    const inserts = paths.map(() => []);

    for (let p = 0; p < paths.length; p += 1) {
      for (let q = p + 1; q < paths.length; q += 1) {
        for (let i = 1; i < paths[p].length; i += 1) {
          const [ax, az] = paths[p][i - 1];
          const [bx, bz] = paths[p][i];
          const rx = bx - ax;
          const rz = bz - az;
          for (let k = 1; k < paths[q].length; k += 1) {
            const [cx, cz] = paths[q][k - 1];
            const [dx, dz] = paths[q][k];
            const sx = dx - cx;
            const sz = dz - cz;
            const denom = rx * sz - rz * sx;
            if (Math.abs(denom) < 1e-9) continue;
            const t = ((cx - ax) * sz - (cz - az) * sx) / denom;
            const u = ((cx - ax) * rz - (cz - az) * rx) / denom;
            // Endpoints are already shared waypoints; only interior crossings need one.
            if (t < 0.02 || t > 0.98 || u < 0.02 || u > 0.98) continue;

            const h = (lerp(heights[p][i - 1], heights[p][i], t)
              + lerp(heights[q][k - 1], heights[q][k], u)) / 2;
            const x = ax + rx * t;
            const z = az + rz * t;
            inserts[p].push({ i, x, z, h });
            inserts[q].push({ i: k, x, z, h });
          }
        }
      }
    }

    for (let p = 0; p < paths.length; p += 1) {
      const list = inserts[p].sort((a, b) => b.i - a.i);
      for (const insert of list) {
        paths[p].splice(insert.i, 0, [insert.x, insert.z]);
        heights[p].splice(insert.i, 0, insert.h);
        pins[p].splice(insert.i, 0, insert.h);
      }
    }
  }

  /**
   * Limit a trail's own grade so that no leg becomes a wall. The corridor is
   * graded to these heights, which is what decides how steep the drive is; the
   * atlas waypoints follow raw terrain, including 65 degree cone flanks and the
   * canyon's 7 m benches.
   */
  _limitTrailGrade(path, heights, pinned = null) {
    const stepAt = (i) => {
      const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      return d * TRAIL_MAX_GRADE;
    };
    // Junction heights are fixed points the grade has to arrive at rather than
    // slide past, so a pinned waypoint is never moved; its neighbours are
    // relaxed toward it instead. Sweeping both ways a few times is enough for
    // every leg to end up within the limit reachable from its nearest pin.
    const isPinned = (i) => pinned !== null && pinned[i] !== null && pinned[i] !== undefined;
    // A circuit closes on itself, so its two ends are the same waypoint: they
    // have to hold one height, or the leg that joins them is never graded and
    // the loop has a wall at the seam.
    const n = heights.length;
    const closed = n > 2
      && Math.hypot(path[0][0] - path[n - 1][0], path[0][1] - path[n - 1][1]) < 1;
    if (closed) heights[n - 1] = heights[0];

    for (let sweep = 0; sweep < 3; sweep += 1) {
      if (closed) heights[n - 1] = heights[0];
      for (let i = 1; i < heights.length; i += 1) {
        if (isPinned(i)) continue;
        const step = stepAt(i);
        heights[i] = clampNumber(heights[i], heights[i - 1] - step, heights[i - 1] + step);
      }
      for (let i = heights.length - 2; i >= 0; i -= 1) {
        if (isPinned(i)) continue;
        const step = stepAt(i + 1);
        heights[i] = clampNumber(heights[i], heights[i + 1] - step, heights[i + 1] + step);
      }
    }
  }

  riverZ(x) {
    // Same meander, scaled: the river has to cross a 2 km map, not 640 m.
    const dx = x / WORLD_SCALE;
    return WORLD_SCALE * (-26 + 16 * Math.sin(dx * 0.0095) + 5 * Math.sin(dx * 0.028 + 1.6));
  }

  bogCentre() {
    return { x: -78 * WORLD_SCALE, z: -62 * WORLD_SCALE };
  }

  /* ---------------- height ---------------- */

  /** Height at a world position: metres in, design-space noise inside. */
  _baseHeight(xMetres, zMetres) {
    const a = this.noiseA;
    const b = this.noiseB;
    const c = this.noiseC;

    // The shape below was authored for a 640 m valley. Sampling it in design
    // space stretches the same ridges, peaks and ledges across the 2 km map,
    // so the terrain keeps its character but every slope is 3.2x longer —
    // which is what makes it smooth to drive instead of a field of bumps.
    const x = xMetres / WORLD_SCALE;
    const z = zMetres / WORLD_SCALE;

    // Rolling valley floor.
    let h = 6.4 + fbm(a, x * 0.0065, z * 0.0065, 4) * 3.6;
    h += fbm(c, x * 0.021, z * 0.021, 2) * 0.5;

    // Mountain wall to the north.
    const north = smoothstep(48, 168, z);
    if (north > 0) {
      const ridge = 1 - Math.abs(fbm(b, x * 0.0042, z * 0.0042, 4));
      h += north * Math.pow(clamp01(ridge), 2.2) * 58;
    }

    // Alpine peak.
    const peakDistance = Math.hypot((x - 68) * 0.85, z - 148);
    if (peakDistance < 108) {
      h += Math.pow(1 - peakDistance / 108, 1.9) * 74;
    }

    // Rocky ledges to the west, quantised into steps.
    const west = smoothstep(-88, -178, x);
    if (west > 0.01) {
      const stepNoise = fbm(b, x * 0.012, z * 0.012, 2);
      const stepped = Math.round((h + stepNoise * 3) / 4.2) * 4.2;
      h = lerp(h, stepped + 14, west);
    }

    // Mud bog basin.
    const bog = this.bogCentre();
    const bogDistance = Math.hypot(x - bog.x, z - bog.z);
    if (bogDistance < 58) {
      h -= (1 - smoothstep(12, 58, bogDistance)) * 4.9;
    }

    return h;
  }

  /** Base terrain + the region's own character (meadow rolls, canyon steps). */
  _shapedHeight(x, z) {
    let h = this._baseHeight(x, z);
    const coast = z < -170 * WORLD_SCALE;
    if (!coast && h < 2.15) h = 2.15;
    const region = regionAt(x, z);
    if (region.shape) h = region.shape(h, x, z, (a, b) => this.noiseB(a, b));
    if (!coast && h < 1.6) h = 1.6;
    return h;
  }

  async _generateHeightGrid() {
    // Sample every waypoint so the trail can be flattened to its own grade,
    // with fords kept shallow and every leg climbable.
    this.trailHeights = this.trailPoints.map((path) =>
      path.map(([x, z]) => Math.max(this._shapedHeight(x, z), FORD_FLOOR)),
    );
    // Every leg climbable, then pinned where tracks cross, then graded again to
    // meet those pins: the corridor is graded to these heights, so this is what
    // decides how steep the drive is.
    this.trailPins = this.trailPoints.map((path) => path.map(() => null));
    const limitAll = () => this.trailPoints.forEach((path, index) =>
      this._limitTrailGrade(path, this.trailHeights[index], this.trailPins[index]));
    limitAll();
    this._stitchCrossings();
    this._pinSharedEnds();
    limitAll();
    // Grade alone leaves creases: a crest that turns from a climb straight into
    // a drop is where a 2.8 m wheelbase beaches itself, so the profile is
    // rounded and graded again.
    for (let pass = 0; pass < 2; pass += 1) {
      this.trailPoints.forEach((path, index) =>
        this._smoothTrailProfile(path, this.trailHeights[index], this.trailPins[index]));
      limitAll();
    }

    if (this.testMode) {
      this.provingDatum = resolveDatum((x, z) => this._baseHeight(x, z));
    }

    // The nearest-path search is the expensive part of generation, and it was
    // being redone in the height, surface and colour passes — three times the
    // work for the same answer. Solve it once into a grid and read the grid.
    await this._buildTrailField();

    for (let j = 0; j < VERTS; j += 1) {
      await this._yield();
      const z = -this.halfSize + j * ELEMENT;
      for (let i = 0; i < VERTS; i += 1) {
        const x = -this.halfSize + i * ELEMENT;
        const index = i * VERTS + j;

        let h = this._shapedHeight(x, z);

        // Flatten the corridor to the path's own grade. Roads cut wider than
        // trails so they read as graded carriageway rather than a footpath.
        const trail = this._trailFieldAt(x, z);
        const corridor = trail.width + 5;
        let trailWeight = 0;
        if (trail.distance < corridor) {
          // The flat core is never narrower than one grid cell: a 3 m trail in a
          // 5 m grid would otherwise have raw hillside bleeding into the
          // centreline, which showed up as a 35 degree kink in the surface.
          const inner = Math.max(trail.width * 0.6, ELEMENT * 0.6);
          const w = 1 - smoothstep(inner, corridor, trail.distance);
          trailWeight = w * 0.98;
          h = lerp(h, trail.height, trailWeight);
        }

        // Carve the river last, but never through the graded trail itself: the
        // carve used to run unopposed and dropped every ford back to the 0.95 m
        // bed, past the depth a stock intake can breathe. Scaling it by the
        // trail's own weight leaves a shallow crossing at the trail's grade.
        const riverDistance = Math.abs(z - this.riverZ(x));
        if (riverDistance < 34) {
          const w = 1 - smoothstep(4.5, 34, riverDistance);
          h = lerp(h, RIVER_BED, w * w * (1 - trailWeight));
        }

        if (this.testMode) {
          const shaped = shapeProvingGround(x, z, h);
          if (shaped) {
            h = shaped.height;
            if (shaped.biome) this.biomeOverride[index] = BIOME_INDEX[shaped.biome];
          }
        }

        this.heights[index] = h;
        this.waterGrid[index] = Math.max(0, WATER_LEVEL - h);
      }
    }

    await this._classifyBiomes();
  }

  /**
   * Nearest trail/path distance, grade height and width, sampled once on the
   * terrain grid. Generation passes read this instead of searching the paths
   * again, which is roughly a third of the boot cost on a 2 km map.
   */
  async _buildTrailField() {
    const count = VERTS * VERTS;
    const distance = new Float32Array(count);
    const height = new Float32Array(count);
    const width = new Float32Array(count);
    // Where two tracks run within metres of each other — every junction, and
    // the trails that share a shoulder with a road — taking the nearest one
    // snapped the grade between them, which is a step of several metres across
    // a few metres of track. Average the grades instead.
    const BLEND_RADIUS = PATH_BLEND_RADIUS;
    const paths = this.trailPoints;
    const bounds = this.pathBounds;
    const trailHeights = this.trailHeights;
    const widths = this.pathWidths;

    for (let j = 0; j < VERTS; j += 1) {
      await this._yield();
      const z = -this.halfSize + j * ELEMENT;
      for (let i = 0; i < VERTS; i += 1) {
        const x = -this.halfSize + i * ELEMENT;
        const index = i * VERTS + j;
        // Direct search here: this IS the field being built.
        let nearest = Infinity;
        let nearestHeight = 0;
        let nearestWidth = 3;
        let heightSum = 0;
        let weightSum = 0;

        for (let p = 0; p < paths.length; p += 1) {
          const box = bounds[p];
          if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
          const path = paths[p];
          const heights = trailHeights[p];
          for (let k = 1; k < path.length; k += 1) {
            const [x0, z0] = path[k - 1];
            const [x1, z1] = path[k];
            const dx = x1 - x0;
            const dz = z1 - z0;
            const lengthSq = dx * dx + dz * dz;
            if (lengthSq < 1e-6) continue;
            const t = clamp01(((x - x0) * dx + (z - z0) * dz) / lengthSq);
            const d = Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t));
            if (d > BLEND_RADIUS && d >= nearest) continue;
            const h = lerp(heights[k - 1], heights[k], t);
            if (d < nearest) {
              nearest = d;
              nearestHeight = h;
              nearestWidth = widths[p] ?? 3;
            }
            if (d < BLEND_RADIUS) {
              const w = 1 / ((d + 2) * (d + 2));
              heightSum += h * w;
              weightSum += w;
            }
          }
        }

        distance[index] = nearest === Infinity ? 1e9 : nearest;
        height[index] = weightSum > 0 ? heightSum / weightSum : nearestHeight;
        width[index] = nearestWidth;
      }
    }

    this.trailField = { distance, height, width };
  }

  /**
   * Field lookup: nearest-path distance, its blended grade height and width.
   * Returns a shared record because this runs a quarter of a million times per
   * build, so a fresh object per call is pure garbage. Read it where you get it.
   */
  _trailFieldAt(x, z) {
    // build() lays the field down before anything reads it, so no guard here.
    const field = this.trailField;
    const i = clampIndex((x + this.halfSize) / ELEMENT);
    const j = clampIndex((z + this.halfSize) / ELEMENT);
    const index = i * VERTS + j;

    const sample = this._trailSample;
    sample.distance = field.distance[index];
    sample.height = field.height[index];
    sample.width = field.width[index];
    return sample;
  }

  async _classifyBiomes() {
    const bog = this.bogCentre();

    for (let j = 0; j < VERTS; j += 1) {
      await this._yield();
      const z = -this.halfSize + j * ELEMENT;
      for (let i = 0; i < VERTS; i += 1) {
        const x = -this.halfSize + i * ELEMENT;
        const index = i * VERTS + j;
        const h = this.heights[index];

        const hx = this.heights[Math.min(VERTS - 1, i + 1) * VERTS + j]
          - this.heights[Math.max(0, i - 1) * VERTS + j];
        const hz = this.heights[i * VERTS + Math.min(VERTS - 1, j + 1)]
          - this.heights[i * VERTS + Math.max(0, j - 1)];
        const slope = Math.hypot(hx, hz) / (2 * ELEMENT);
        this.slopeGrid[index] = slope;

        const riverDistance = Math.abs(z - this.riverZ(x));
        const bogDistance = Math.hypot(x - bog.x, z - bog.z);
        const trail = this._trailFieldAt(x, z);

        const region = regionAt(x, z);
        let key = 'hardpack';

        if (h < WATER_LEVEL - 0.02) {
          key = 'water';
        } else if (bogDistance < 40 && h < 4.4) {
          key = 'mud';
        } else if (trail.distance < trail.width * 0.95) {
          // The graded corridor wins over whatever it crosses.
          key = 'trail';
        } else if (region.id === 'canyon') {
          key = slope > 0.55 ? 'rock' : 'sand';
        } else if (region.id === 'coast') {
          key = h < WATER_LEVEL + 1.4 ? 'sand' : 'hardpack';
        } else if (region.id === 'alpine') {
          key = h > 30 ? 'snow' : slope > 0.62 ? 'rock' : 'hardpack';
        } else if (riverDistance < 22 && h < WATER_LEVEL + 1.6) {
          key = 'sand';
        } else if (h > 52 || (h > 34 && slope < 0.5)) {
          key = 'snow';
        } else if (slope > 0.72) {
          key = 'rock';
        }

        const override = this.biomeOverride[index];
        this.biomeGrid[index] = override === 255 ? BIOME_INDEX[key] : override;
      }
    }
  }

  /* ---------------- public queries ---------------- */

  getHeightAt(x, z) {
    const fx = (x + this.halfSize) / ELEMENT;
    const fz = (z + this.halfSize) / ELEMENT;
    const i = Math.min(VERTS - 2, Math.max(0, Math.floor(fx)));
    const j = Math.min(VERTS - 2, Math.max(0, Math.floor(fz)));
    const tx = clamp01(fx - i);
    const tz = clamp01(fz - j);

    const h00 = this.heights[i * VERTS + j];
    const h10 = this.heights[(i + 1) * VERTS + j];
    const h01 = this.heights[i * VERTS + (j + 1)];
    const h11 = this.heights[(i + 1) * VERTS + (j + 1)];

    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  /** Nearest grid sample index for a world position. */
  _indexAt(x, z) {
    const i = Math.min(VERTS - 1, Math.max(0, Math.round((x + this.halfSize) / ELEMENT)));
    const j = Math.min(VERTS - 1, Math.max(0, Math.round((z + this.halfSize) / ELEMENT)));
    return i * VERTS + j;
  }

  /**
   * Surface contract consumed by OffroadVehicle every physics tick:
   * { biome, friction, softness, viscousDrag, maxSinkage, waterDepth }.
   * Dry results are shared, frozen objects; only water allocates.
   */
  getSurfaceAt(x, z) {
    const index = this._indexAt(x, z);
    const key = BIOME_KEYS[this.biomeGrid[index]];
    const base = BIOMES[key] || BIOMES.hardpack;
    const grassy = this.foliageMask[index] > 0 ? this._grassSurfaces[key] : null;
    const surface = grassy || base;
    const waterDepth = this.waterGrid[index];

    if (waterDepth <= 0.001) return surface;

    return {
      ...surface,
      waterDepth,
    };
  }

  getWaterDepthAt(x, z) {
    return this.waterGrid[this._indexAt(x, z)];
  }

  findAnchorNear(x, z, maxDistance = 22) {
    let best = null;
    let bestDistance = maxDistance;
    for (const anchor of this.winchAnchors) {
      const distance = Math.hypot(anchor.position.x - x, anchor.position.z - z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = anchor;
      }
    }
    return best;
  }

  _resolveSpawn() {
    if (this.testMode) return spawnPoint(this);

    // Start on the valley highway, in the meadow, facing up the road.
    const path = this.trailPoints[2] || this.trailPoints[0];
    const target = path[7] || path[0];
    const x = target[0];
    const z = target[1];
    const next = path[8] || path[6] || path[0];
    const heading = Math.atan2(next[0] - x, next[1] - z);
    return {
      position: new THREE.Vector3(x, this.getHeightAt(x, z) + 1.4, z),
      heading,
    };
  }

  /* ---------------- visual mesh ---------------- */

  _buildDetailTexture() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const random = mulberry32(this.seed ^ 0x51ed270b);

    ctx.fillStyle = '#c8c8c8';
    ctx.fillRect(0, 0, size, size);

    for (let i = 0; i < 5200; i += 1) {
      const x = random() * size;
      const y = random() * size;
      const r = 0.5 + random() * 1.9;
      const shade = 150 + Math.floor(random() * 90);
      ctx.fillStyle = `rgba(${shade},${shade - 6},${shade - 16},${0.16 + random() * 0.34})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  }

  async _buildMesh() {
    const count = VERTS * VERTS;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);

    const color = new THREE.Color();
    const tint = new THREE.Color();

    for (let j = 0; j < VERTS; j += 1) {
      await this._yield();
      for (let i = 0; i < VERTS; i += 1) {
        const index = i * VERTS + j;
        const x = -this.halfSize + i * ELEMENT;
        const z = -this.halfSize + j * ELEMENT;
        const h = this.heights[index];

        positions[index * 3] = x;
        positions[index * 3 + 1] = h;
        positions[index * 3 + 2] = z;

        uvs[index * 2] = x / 7.5;
        uvs[index * 2 + 1] = z / 7.5;

        const key = BIOME_KEYS[this.biomeGrid[index]];
        const def = BIOMES[key];
        color.setHex(def.color);

        // Region palette: the meadow reads olive-gold, the canyon rust,
        // the coast bleached sand, the ridge cold grey-green.
        const region = regionAt(x, z);
        if (key !== 'water' && key !== 'mud') {
          color.lerp(tint.setHex(region.palette.ground), key === 'trail' ? 0.28 : 0.62);
        }

        // The trail itself: bare packed earth worn through the grass, fading
        // out over the shoulder instead of ending on a hard line. Painting it
        // into the ground is why a trail looks driven-on rather than laid on.
        if (key === 'trail' || key === 'road') {
          const trail = this._trailFieldAt(x, z);
          if (trail.distance < trail.width * 0.5 + 2.4) {
            const scar = 1 - smoothstep(trail.width * 0.5, trail.width * 0.5 + 2.4, trail.distance);
            const dirt = new THREE.Color(region.palette.dirt ?? 0x6a573c);
            color.lerp(dirt, scar * 0.82);
            // Tyre-worn bands, wide enough to survive the 2 m cell size.
            const rut = Math.max(
              1 - Math.abs(trail.distance - 0.85) / 0.6,
              1 - Math.abs(trail.distance + 0.85) / 0.6,
            );
            if (rut > 0) color.multiplyScalar(1 - Math.max(0, rut) * 0.16);
          }
        }

        // Blend snow in over the alpine band, and grit into everything else.
        const snowBlend = smoothstep(30, 52, h);
        if (snowBlend > 0 && key !== 'snow') color.lerp(tint.setHex(BIOMES.snow.color), snowBlend * 0.85);

        // Flat-shaded style: no per-pixel ground noise. A 2% break-up only
        // keeps huge fields from reading as one solid colour swatch.
        const grit = 0.98 + (this.noiseD(x * 0.045, z * 0.045) * 0.5 + 0.5) * 0.04;
        color.multiplyScalar(grit);

        // Broad green patches through the gold. Without this the meadow is one
        // flat ochre field; with it the ground reads as grassland with damp
        // hollows, in two flat tone bands rather than a gradient.
        if (key !== 'water' && key !== 'mud' && key !== 'snow' && key !== 'trail') {
          const patch = this.noiseD(x * 0.012 + 40, z * 0.012 - 15);
          const green = THREE.MathUtils.clamp((patch + 0.22) * 1.9, 0, 1);
          if (green > 0) color.lerp(tint.setHex(0x6f8d43), green * 0.5);
        }

        // Wet sheen on the riverbed and bog floor.
        if (key === 'water' || key === 'mud') color.multiplyScalar(0.86);

        colors[index * 3] = color.r;
        colors[index * 3 + 1] = color.g;
        colors[index * 3 + 2] = color.b;
      }
    }

    const indices = new Uint32Array(SEGMENTS * SEGMENTS * 6);
    let cursor = 0;
    for (let j = 0; j < SEGMENTS; j += 1) {
      for (let i = 0; i < SEGMENTS; i += 1) {
        const a = i * VERTS + j;
        const b = (i + 1) * VERTS + j;
        const c = (i + 1) * VERTS + (j + 1);
        const d = i * VERTS + (j + 1);
        indices[cursor] = a;
        indices[cursor + 1] = d;
        indices[cursor + 2] = b;
        indices[cursor + 3] = b;
        indices[cursor + 4] = d;
        indices[cursor + 5] = c;
        cursor += 6;
      }
    }

    this.detailTexture = this._buildDetailTexture();

    // Lambert, not Standard. The ground is flat-shaded, rough, and fills half
    // the screen, so PBR's specular and Fresnel terms are pure waste per pixel;
    // diffuse + fog is all this surface has ever shown.
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      map: this.detailTexture,
    });
    this.material.name = 'TerrainMaterial';

    // ---- split into chunks ----
    // One 205,000-triangle mesh can never be culled: it is always partly on
    // screen, so the whole world is submitted every frame. Cut into an 8x8
    // grid and each chunk gets its own bounding sphere, so the off-screen
    // two-thirds of the map costs nothing.
    this.mesh = new THREE.Group();
    this.mesh.name = 'TerrainMesh';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    this.group.add(this.mesh);

    const CHUNKS = 8;
    const cellsPerChunk = SEGMENTS / CHUNKS;
    const vertsPerChunk = cellsPerChunk + 1;
    const chunkVerts = vertsPerChunk * vertsPerChunk;
    this.chunks = [];

    for (let cj = 0; cj < CHUNKS; cj += 1) {
      await this._yield();
      for (let ci = 0; ci < CHUNKS; ci += 1) {
        const chunkPos = new Float32Array(chunkVerts * 3);
        const chunkCol = new Float32Array(chunkVerts * 3);
        const chunkUv = new Float32Array(chunkVerts * 2);

        // i outer, j inner so the chunk keeps the global (i * VERTS + j)
        // vertex ordering its index buffer is built from.
        let w = 0;
        for (let i = 0; i < vertsPerChunk; i += 1) {
          for (let j = 0; j < vertsPerChunk; j += 1) {
            const src = (ci * cellsPerChunk + i) * VERTS + (cj * cellsPerChunk + j);
            chunkPos[w * 3] = positions[src * 3];
            chunkPos[w * 3 + 1] = positions[src * 3 + 1];
            chunkPos[w * 3 + 2] = positions[src * 3 + 2];
            chunkCol[w * 3] = colors[src * 3];
            chunkCol[w * 3 + 1] = colors[src * 3 + 1];
            chunkCol[w * 3 + 2] = colors[src * 3 + 2];
            chunkUv[w * 2] = uvs[src * 2];
            chunkUv[w * 2 + 1] = uvs[src * 2 + 1];
            w += 1;
          }
        }

        const chunkIndices = new Uint32Array(cellsPerChunk * cellsPerChunk * 6);
        let cursor = 0;
        for (let j = 0; j < cellsPerChunk; j += 1) {
          for (let i = 0; i < cellsPerChunk; i += 1) {
            const a = i * vertsPerChunk + j;
            const b = (i + 1) * vertsPerChunk + j;
            const c = (i + 1) * vertsPerChunk + (j + 1);
            const d = i * vertsPerChunk + (j + 1);
            chunkIndices[cursor] = a;
            chunkIndices[cursor + 1] = d;
            chunkIndices[cursor + 2] = b;
            chunkIndices[cursor + 3] = b;
            chunkIndices[cursor + 4] = d;
            chunkIndices[cursor + 5] = c;
            cursor += 6;
          }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(chunkPos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(chunkCol, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(chunkUv, 2));
        geo.setIndex(new THREE.BufferAttribute(chunkIndices, 1));
        geo.computeVertexNormals();
        geo.computeBoundingSphere();

        const chunk = new THREE.Mesh(geo, this.material);
        chunk.name = `TerrainChunk_${ci}_${cj}`;
        chunk.receiveShadow = true;
        chunk.castShadow = false;
        chunk.matrixAutoUpdate = false;
        chunk.updateMatrix();
        this.mesh.add(chunk);
        this.chunks.push(chunk);
      }
    }

    this.scene.add(this.group);
  }

  /* ---------------- physics ---------------- */

  async _buildPhysics() {
    const matrix = [];
    for (let i = 0; i < VERTS; i += 1) {
      await this._yield();
      const column = new Array(VERTS);
      for (let j = 0; j < VERTS; j += 1) {
        // Cannon maps local (i*E, j*E) to world (x = -half + i*E, z = +half - j*E).
        column[VERTS - 1 - j] = this.heights[i * VERTS + j];
      }
      matrix.push(column);
    }

    const shape = new CANNON.Heightfield(matrix, { elementSize: ELEMENT });
    const body = new CANNON.Body({ mass: 0, material: this.groundMaterial });
    body.addShape(shape);
    body.position.set(-this.halfSize, 0, this.halfSize);
    body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    body.collisionFilterGroup = 1;
    body.userData = { surface: 'hardpack', terrain: true };
    body.aabbNeedsUpdate = true;
    body.updateAABB();
    this.world.addBody(body);

    this.body = body;
    this.heightfield = shape;
  }

  /* ---------------- water ---------------- */

  _buildWater() {
    const geometry = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
    const material = new THREE.MeshStandardMaterial({
      color: 0x2f6f86,
      transparent: true,
      opacity: 0.72,
      roughness: 0.12,
      metalness: 0.25,
      depthWrite: false,
    });

    this.water = new THREE.Mesh(geometry, material);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set(0, WATER_LEVEL, 0);
    this.water.receiveShadow = false;
    this.water.renderOrder = 2;
    this.group.add(this.water);
  }

  /* ---------------- scatter ---------------- */

  /**
   * Register a prop's collider without putting it in the world yet.
   *
   * Every trunk, outcrop and marker post used to be a body for the whole
   * session. That is two and a half thousand extra bodies, and the broadphase
   * has to walk all of them on every single physics step — more than the rest
   * of the simulation put together — even though a tree two hundred metres
   * behind the truck can never be touched. updateColliders() swaps in the ones
   * within reach instead.
   */
  _registerPropBody(body, x, z) {
    this._propBodies.push({ body, x, z, inWorld: false });
    return body;
  }

  /**
   * Keep only the scenery colliders the truck can reach inside the physics
   * world. Cheap to call every frame: it re-scans only after the truck has
   * moved far enough for the answer to change.
   */
  updateColliders(x, z, radius = 95) {
    const world = this.world;
    if (!world || !this._propBodies.length) return;
    const dx = x - this._colliderX;
    const dz = z - this._colliderZ;
    if (this._colliderRadius === radius && dx * dx + dz * dz < 100) return;
    this._colliderX = x;
    this._colliderZ = z;
    this._colliderRadius = radius;

    const radiusSq = radius * radius;
    let live = 0;
    for (const entry of this._propBodies) {
      const ox = entry.x - x;
      const oz = entry.z - z;
      const near = ox * ox + oz * oz < radiusSq;
      if (near === entry.inWorld) {
        if (near) live += 1;
        continue;
      }
      if (near) {
        world.addBody(entry.body);
        entry.body.aabbNeedsUpdate = true;
        entry.body.updateAABB();
        entry.inWorld = true;
        live += 1;
      } else {
        // A stone shoved out of the bubble stops where it lies rather than
        // tumbling on forever in a world that is no longer stepping it.
        if (entry.body.mass > 0) entry.body.sleep();
        world.removeBody(entry.body);
        entry.inWorld = false;
      }
    }
    // SAPBroadphase caches a sorted axis list, so tell it membership changed.
    if (world.broadphase && 'dirty' in world.broadphase) world.broadphase.dirty = true;
    this.colliderStats = { total: this._propBodies.length, live };
  }

  _addAnchor(kind, position, radius, body, pullHeight) {
    const anchor = {
      id: this.winchAnchors.length,
      kind,
      position,
      radius,
      body,
      // Where a hook would actually attach on this prop.
      pullPoint: new THREE.Vector3(position.x, position.y + pullHeight, position.z),
    };
    this.winchAnchors.push(anchor);
    return anchor;
  }

  /** True inside the proving ground site (plus a small margin). */
  inProvingGround(x, z) {
    if (!this.testMode) return false;
    const { center, halfWidth, halfDepth } = PROVING_GROUND;
    return Math.abs(x - center.x) < halfWidth + 6 && Math.abs(z - center.z) < halfDepth + 6;
  }

  /* ---------------- render chunking + distance LOD ---------------- */

  /**
   * Split a set of placed instances into spatial chunks.
   *
   * Instances keep their world matrices, so a chunk is just a smaller instanced
   * mesh that covers one square of the map. `near` distances swap in a cheap
   * proxy geometry (`far`) so a tree two hundred metres away is a silhouette
   * instead of a seven-sided cone, and anything past the fog is not drawn at
   * all. `trackRefs` records where each global instance ended up, which is what
   * lets a rolling boulder keep its visual in sync with its rigid body.
   */
  _chunkify({ name, sources, far = null, nearScale = 0.55, maxScale = 1.05, trackRefs = false }) {
    const chunkSize = this._chunkSize;
    const base = sources[0];
    const count = base.matrices.length;
    const buckets = new Map();
    const indexMap = trackRefs ? new Array(count).fill(null) : null;

    for (let i = 0; i < count; i += 1) {
      const e = base.matrices[i].elements;
      const key = `${Math.floor(e[12] / chunkSize)},${Math.floor(e[14] / chunkSize)}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { key, items: [] };
        buckets.set(key, bucket);
      }
      bucket.items.push(i);
    }

    const group = { name, chunks: [], nearScale, maxScale, hasFar: !!far };

    for (const bucket of buckets.values()) {
      const items = bucket.items;
      const n = items.length;
      let centerX = 0;
      let centerZ = 0;
      for (const i of items) {
        centerX += base.matrices[i].elements[12];
        centerZ += base.matrices[i].elements[14];
      }
      const chunk = {
        name,
        indices: items,
        center: new THREE.Vector3(centerX / n, 0, centerZ / n),
        radius: chunkSize * 0.75,
        meshes: [],
        farMeshes: [],
      };

      for (const source of sources) {
        const mesh = new THREE.InstancedMesh(source.geometry, source.material, n);
        mesh.name = `${name}Chunk_${bucket.key}`;
        mesh.castShadow = !!source.castShadow;
        mesh.receiveShadow = !!source.receiveShadow;
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        const palette = source.colors
          ? new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3)
          : null;
        for (let k = 0; k < n; k += 1) {
          const gi = items[k];
          mesh.setMatrixAt(k, source.matrices[gi]);
          if (palette) {
            const c = source.colors[gi];
            palette.setXYZ(k, c.r, c.g, c.b);
          }
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (palette) mesh.instanceColor = palette;
        mesh.userData.maxInstances = n;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
        chunk.meshes.push(mesh);
        if (indexMap) {
          for (let k = 0; k < n; k += 1) indexMap[items[k]] = { near: { mesh, index: k }, far: null };
        }
      }

      if (far) {
        const farMesh = new THREE.InstancedMesh(far.geometry, far.material, n);
        farMesh.name = `${name}Far_${bucket.key}`;
        farMesh.castShadow = false;
        farMesh.receiveShadow = false;
        farMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        for (let k = 0; k < n; k += 1) farMesh.setMatrixAt(k, base.matrices[items[k]]);
        farMesh.instanceMatrix.needsUpdate = true;
        farMesh.computeBoundingSphere();
        farMesh.visible = false;
        this.group.add(farMesh);
        chunk.farMeshes.push(farMesh);
        if (indexMap) {
          for (let k = 0; k < n; k += 1) {
            const entry = indexMap[items[k]];
            if (entry) entry.far = { mesh: farMesh, index: k };
          }
        }
      }

      group.chunks.push(chunk);
      this._lodChunks.push(chunk);
    }

    // `indexMap` is only built when the caller needs to follow individual
    // instances (rolling stones); it is null otherwise.
    group.indexMap = indexMap;
    this._lodGroups.push(group);
    return group;
  }

  /**
   * Distance LOD, once per frame.
   *
   * The fog distance sets the outer limit: anything the fog has already erased
   * costs nothing to leave out. Between the near and far thresholds a chunk is
   * drawn with its proxy geometry, and only chunks inside the near distance get
   * the full mesh, shadows included.
   */
  updateLOD(camera) {
    if (!this._lodGroups.length || !camera) return;
    const fogFar = this.scene?.fog?.far ?? 320;
    const outer = Math.max(140, fogFar * 1.08);
    const cx = camera.position.x;
    const cz = camera.position.z;
    let near = 0;
    let far = 0;

    for (const group of this._lodGroups) {
      const nearDist = Math.max(55, outer * group.nearScale);
      const farDist = Math.min(outer, outer * group.maxScale);
      for (const chunk of group.chunks) {
        const dx = chunk.center.x - cx;
        const dz = chunk.center.z - cz;
        const d = Math.sqrt(dx * dx + dz * dz) - chunk.radius;
        const showNear = d < nearDist;
        const showFar = !showNear && group.hasFar && d < farDist;
        for (const mesh of chunk.meshes) {
          mesh.visible = showNear && mesh.userData.active !== false && mesh.count > 0;
        }
        for (const mesh of chunk.farMeshes) {
          mesh.visible = showFar && mesh.count > 0;
        }
        if (showNear) near += 1;
        else if (showFar) far += 1;
      }
    }

    this.lodStats.groups = this._lodGroups.length;
    this.lodStats.chunks = this._lodChunks.length;
    this.lodStats.near = near;
    this.lodStats.far = far;
    this.lodStats.hidden = this._lodChunks.length - near - far;

    // Ground chunks past the fog line are a flat wash of fog colour, but they
    // still cover pixels, and on a fill-limited GPU that is the most expensive
    // thing in the frame. Beyond 1.6x the fog distance the terrain is
    // indistinguishable from the haze behind it, so stop drawing it.
    this.lodStats.groundChunks = this.chunks.length;
    if (this.chunks.length) {
      const cutoff = fogFar * 1.6;
      let groundVisible = 0;
      for (const chunk of this.chunks) {
        const sphere = chunk.geometry.boundingSphere;
        if (!sphere) continue;
        const dx = sphere.center.x - cx;
        const dz = sphere.center.z - cz;
        const d = Math.sqrt(dx * dx + dz * dz) - sphere.radius;
        const show = d < cutoff;
        if (chunk.visible !== show) chunk.visible = show;
        if (show) groundVisible += 1;
      }
      this.lodStats.groundVisible = groundVisible;
    }
  }

  async _scatter() {
    const random = mulberry32(this.seed ^ 0x2545f491);

    const trunkGeometry = new THREE.CylinderGeometry(0.22, 0.32, 3.2, 6);
    const pineGeometry = new THREE.ConeGeometry(1.9, 6.4, 7);
    const boulderGeometry = new THREE.IcosahedronGeometry(1, 1);
    const poleGeometry = new THREE.CylinderGeometry(0.13, 0.15, 4.6, 6);

    const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.95 });
    const pineMaterial = new THREE.MeshStandardMaterial({ color: 0x2c4a32, roughness: 0.9, flatShading: true });
    const boulderMaterial = new THREE.MeshStandardMaterial({ color: 0x6a6259, roughness: 0.94, flatShading: true });
    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x6d5433, roughness: 0.9 });

    // Counts scale with the map area, or 2 km reads as an empty plain.
    const TREES = 1900;
    const BOULDERS = 900;
    const POLES = 260;

    // Placement collects matrices; the instanced meshes are built per spatial
    // chunk afterwards so the renderer can cull them (see _chunkify).
    const trunkMatrices = [];
    const pineMatrices = [];
    const boulderMatrices = [];
    const poleMatrices = [];

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();

    let trees = 0;
    let attempts = 0;
    while (trees < TREES && attempts < TREES * 40) {
      if ((attempts & 255) === 0) await this._yield();
      attempts += 1;
      const x = (random() * 2 - 1) * (this.halfSize - 12);
      const z = (random() * 2 - 1) * (this.halfSize - 12);
      const index = this._indexAt(x, z);
      const h = this.heights[index];
      const slope = this.slopeGrid[index];
      const key = BIOME_KEYS[this.biomeGrid[index]];

      if (h < 3.2 || h > 40) continue;
      if (this.inProvingGround(x, z)) continue;
      if (slope > 0.42) continue;
      if (key === 'mud' || key === 'water' || key === 'sand') continue;
      if (this.waterGrid[index] > 0) continue;
      const trail = this._trailFieldAt(x, z);
      if (trail.distance < trail.width + 5) continue;

      const density = fbm(this.noiseD, x * 0.012, z * 0.012, 3);
      if (density < -0.12 && random() > 0.22) continue;

      const height = 0.82 + random() * 0.62;
      const yaw = random() * Math.PI * 2;

      quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));

      position.set(x, h + 1.6 * height, z);
      scale.set(1, height, 1);
      matrix.compose(position, quaternion, scale);
      trunkMatrices.push(matrix.clone());

      position.set(x, h + 4.4 * height, z);
      matrix.compose(position, quaternion, scale);
      pineMatrices.push(matrix.clone());

      const body = new CANNON.Body({ mass: 0, material: this.groundMaterial });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.3, 1.7 * height, 0.3)));
      body.position.set(x, h + 1.7 * height, z);
      body.collisionFilterGroup = 1;
      body.userData = { surface: 'hardpack', tree: true };
      body.aabbNeedsUpdate = true;
      body.updateAABB();
      this._registerPropBody(body, x, z);

      this._addAnchor('tree', new THREE.Vector3(x, h, z), 0.45, body, 1.9);
      this.treeColliders.push(body);
      trees += 1;
    }

    this.stats.trees = trees;

    // Phase-7 wind: the pine and trunk materials are the ones patched with the
    // shared sway uniforms in _buildFoliage(), so the chunks inherit the wind
    // by sharing them.
    this.treeMaterials = { trunk: trunkMaterial, pine: pineMaterial };

    let boulders = 0;
    attempts = 0;
    while (boulders < BOULDERS && attempts < BOULDERS * 40) {
      if ((attempts & 255) === 0) await this._yield();
      attempts += 1;
      const x = (random() * 2 - 1) * (this.halfSize - 10);
      const z = (random() * 2 - 1) * (this.halfSize - 10);
      const index = this._indexAt(x, z);
      const h = this.heights[index];
      const key = BIOME_KEYS[this.biomeGrid[index]];
      if (this.inProvingGround(x, z)) continue;
      if (key === 'water' || this.waterGrid[index] > 0) continue;
      const road = this._trailFieldAt(x, z);
      if (road.distance < road.width + 3.5) continue;

      const radius = 0.55 + random() * 1.5;
      const yaw = random() * Math.PI * 2;
      const squash = 0.7 + random() * 0.5;
      quaternion.setFromEuler(new THREE.Euler(random() * 0.6, yaw, random() * 0.6));
      // Small stones poke out of the grass, so they sit high enough to be seen
      // before the bumper reaches them.
      const lift = radius < 1.15 ? 0.62 : 0.36;
      position.set(x, h + radius * lift, z);
      scale.set(radius, radius * squash, radius);
      matrix.compose(position, quaternion, scale);
      boulderMatrices.push(matrix.clone());

      // Anything the truck could plausibly shoulder aside is a dynamic body.
      // Only genuine outcrops stay immovable, and those are big and obvious.
      const movable = radius < 1.15;
      const body = new CANNON.Body(
        movable
          ? {
            mass: 60 + radius * 130,
            material: this.groundMaterial,
            linearDamping: 0.32,
            angularDamping: 0.55,
            allowSleep: true,
            sleepSpeedLimit: 0.22,
            sleepTimeLimit: 0.7,
          }
          : { mass: 0, material: this.groundMaterial },
      );
      // A collider a touch smaller than the mesh keeps the truck from being
      // stopped by a rock it visually clears.
      body.addShape(new CANNON.Sphere(radius * (movable ? 0.7 : 0.9)));
      body.position.set(position.x, position.y, position.z);
      body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
      body.collisionFilterGroup = 1;
      body.userData = { surface: 'rock', boulder: true };
      body.aabbNeedsUpdate = true;
      body.updateAABB();
      this._registerPropBody(body, x, z);

      if (movable) {
        this.boulderBodies.push({ body, index: boulders, radius, squash });
      }

      this._addAnchor('boulder', new THREE.Vector3(x, h, z), radius, body, radius * 0.7);
      boulders += 1;
    }
    this.stats.boulders = boulders;

    // Trail markers along the loop, offset from the driving line.
    const loop = this.trailPoints[0];
    let poles = 0;
    for (let i = 1; i < loop.length && poles < POLES; i += 1) {
      const [x0, z0] = loop[i - 1];
      const [x1, z1] = loop[i];
      const length = Math.hypot(x1 - x0, z1 - z0);
      const dx = (x1 - x0) / length;
      const dz = (z1 - z0) / length;
      const steps = Math.max(1, Math.round(length / 34));

      for (let s = 0; s < steps && poles < POLES; s += 1) {
        const t = (s + 0.5) / steps;
        const nx = -dz;
        const nz = dx;
        // Every marker on the same side of the trail. Alternating sides placed
        // them in a slalom across the road, which read as poles criss-crossing
        // the trail instead of running along its shoulder.
        const x = x0 + (x1 - x0) * t + nx * 5.6;
        const z = z0 + (z1 - z0) * t + nz * 5.6;
        const h = this.getHeightAt(x, z);
        // No markers standing in the ford.
        if (h < WATER_LEVEL + 0.7 || this.waterGrid[this._indexAt(x, z)] > 0) continue;
        // Face along the trail so a post reads as a line marker, not a stick
        // dropped at a random angle.
        const yaw = Math.atan2(dx, dz);

        quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));
        position.set(x, h + 2.3, z);
        scale.set(1, 1, 1);
        matrix.compose(position, quaternion, scale);
        poleMatrices.push(matrix.clone());

        // The posts are route markers. They still exist as winch anchors, but
        // they never collide — clipping a twig-thin stick should not stop a
        // two-tonne truck dead in tall grass.
        const body = new CANNON.Body({ mass: 0, material: this.groundMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(0.16, 2.3, 0.16)));
        body.position.set(x, h + 2.3, z);
        body.collisionFilterGroup = 0;
        body.collisionResponse = false;
        body.userData = { surface: 'hardpack', pole: true };
        body.aabbNeedsUpdate = true;
        body.updateAABB();
        this._registerPropBody(body, x, z);

        this._addAnchor('pole', new THREE.Vector3(x, h, z), 0.3, body, 2.4);
        poles += 1;
      }
    }
    this.stats.poles = poles;
    this.stats.anchors = this.winchAnchors.length;

    /* ---- far proxies: what a distant prop is allowed to cost ---- */
    // A pine at 300 m is a green silhouette, so it becomes a four-sided cone.
    const farPineGeometry = new THREE.ConeGeometry(1.9, 6.4, 4, 1);
    farPineGeometry.translate(0, 0, 0);
    const farPineMaterial = pineMaterial.clone();
    farPineMaterial.flatShading = true;
    // A stone becomes a tetrahedron; its shading already reads as a lump.
    const farBoulderGeometry = new THREE.TetrahedronGeometry(1, 0);
    const farBoulderMaterial = boulderMaterial.clone();
    farBoulderMaterial.flatShading = true;

    this.treeChunks = this._chunkify({
      name: 'Tree',
      sources: [
        { geometry: trunkGeometry, material: trunkMaterial, matrices: trunkMatrices, castShadow: true, receiveShadow: true },
        { geometry: pineGeometry, material: pineMaterial, matrices: pineMatrices, castShadow: true, receiveShadow: true },
      ],
      far: { geometry: farPineGeometry, material: farPineMaterial },
      nearScale: 0.52,
      maxScale: 1.06,
    });

    const boulderChunks = this._chunkify({
      name: 'Boulder',
      sources: [
        { geometry: boulderGeometry, material: boulderMaterial, matrices: boulderMatrices, castShadow: true, receiveShadow: true },
      ],
      far: { geometry: farBoulderGeometry, material: farBoulderMaterial },
      nearScale: 0.46,
      maxScale: 0.92,
      trackRefs: true,
    });

    this.poleChunks = this._chunkify({
      name: 'Pole',
      sources: [
        { geometry: poleGeometry, material: poleMaterial, matrices: poleMatrices, castShadow: true, receiveShadow: true },
      ],
      nearScale: 0.9,
      maxScale: 1.0,
    });

    // Rolling stones follow their body: resolve each one to the chunk instance
    // that draws it, near and far.
    for (const entry of this.boulderBodies) {
      const refs = boulderChunks.indexMap[entry.index];
      entry.near = refs ? refs.near : null;
      entry.far = refs ? refs.far : null;
    }

    // Density and culling share these lists.
    this._densityMeshes = [
      ...this.treeChunks.chunks.flatMap((chunk) => chunk.meshes),
      ...boulderChunks.chunks.flatMap((chunk) => chunk.meshes),
      ...this.poleChunks.chunks.flatMap((chunk) => chunk.meshes),
    ];
    this.treeMeshes = { chunks: this.treeChunks.chunks };
    this.props = { treeChunks: this.treeChunks, boulderChunks, poleChunks: this.poleChunks };
  }

  /* ---------------- Phase 7: living wilderness ---------------- */

  /**
   * Wind + truck-bend vertex deformation.
   *
   * `bendHeight` describes where the plant is anchored in local space, so a
   * blade bends from its root and a pine sways from its trunk base. Every
   * foliage material shares the same uniform objects, so one write per frame
   * moves the whole wilderness.
   */
  _patchFoliageMaterial(material, {
    sway = 0.3,
    rootY = 0.0,
    topY = 1.0,
    bend = 0.55,
    rootTint = null,
    tipTint = null,
    softenNormal = 0,
  } = {}) {
    material.userData.windUniforms = this.windUniforms;
    const tinted = Boolean(rootTint && tipTint);
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.windUniforms.uTime;
      shader.uniforms.uTruckPos = this.windUniforms.uTruckPos;
      shader.vertexShader = `
        uniform float uTime;
        uniform vec4 uTruckPos[4];
        ${tinted ? 'varying float vBladeT;' : ''}
      ` + shader.vertexShader;

      // Blade normals are softened toward straight up. A grass cone's own
      // normals point sideways, so half of every blade faces away from the sun
      // and the meadow reads as dark spikes rooted in the ground. Aiming the
      // normals up makes the field shade as one continuous velvet surface,
      // which is the look the style wants.
      if (softenNormal > 0) {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <beginnormal_vertex>',
          /* glsl */ `
          #include <beginnormal_vertex>
          objectNormal = normalize(mix(objectNormal, vec3(0.0, 1.0, 0.0), ${softenNormal.toFixed(3)}));
          `,
        );
      }

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>

        #ifdef USE_INSTANCING
          vec3 instOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #else
          vec3 instOrigin = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        #endif

        // Height factor: 0 at the root, 1 at the tip.
        float hNorm = clamp((position.y - ${rootY.toFixed(3)}) / ${(topY - rootY).toFixed(3)}, 0.0, 1.0);
        float hBend = hNorm * hNorm;
        ${tinted ? 'vBladeT = hNorm;' : ''}

        // Gentle travelling wind wave, phase-shifted per plant.
        float phase = uTime * 1.45 + instOrigin.x * 0.24 + instOrigin.z * 0.19;
        float gust = sin(phase) * 0.65 + sin(phase * 2.17 + 1.7) * 0.35;
        float amp = ${sway.toFixed(3)} * hBend;
        transformed.x += gust * amp;
        transformed.z += cos(phase * 0.83) * amp * 0.6;

        // The trucks physically shove the grass aside. Each slot is
        // (x, y, z) with w = influence radius; inactive slots have w = 0.
        vec2 flatPos = instOrigin.xz;
        for (int i = 0; i < 4; i++) {
          vec4 truck = uTruckPos[i];
          if (truck.w > 0.0) {
            vec2 delta = flatPos - truck.xz;
            float dist = length(delta);
            float push = 1.0 - smoothstep(0.0, truck.w, dist);
            if (dist > 0.01) {
              float shell = ${bend.toFixed(3)} * push * (0.35 + hBend);
              transformed.x += (delta.x / dist) * shell;
              transformed.z += (delta.y / dist) * shell;
              // Trampled plants also flatten a touch.
              transformed.y -= push * 0.18 * hBend;
            }
          }
        }
        `,
      );
      if (tinted) {
        const root = new THREE.Color(rootTint);
        const tip = new THREE.Color(tipTint);
        shader.fragmentShader = `varying float vBladeT;\n` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          // Root-to-tip ramp: the base of the blade sits in its own shadow and
          // is pulled toward the soil colour, so no plant has a visible dark
          // foot; the tip catches the low sun.
          vec3 bladeRoot = vec3(${root.r.toFixed(3)}, ${root.g.toFixed(3)}, ${root.b.toFixed(3)});
          vec3 bladeTip = vec3(${tip.r.toFixed(3)}, ${tip.g.toFixed(3)}, ${tip.b.toFixed(3)});
          diffuseColor.rgb *= mix(bladeRoot, bladeTip, smoothstep(0.0, 0.85, vBladeT));
          `,
        );
      }
    };
    material.customProgramCacheKey = () => 'inorld-foliage';
    material.needsUpdate = true;
    return material;
  }

  async _buildFoliage() {
    this.windUniforms = {
      uTime: { value: 0 },
      uTruckPos: {
        value: [
          new THREE.Vector4(0, -999, 0, 0),
          new THREE.Vector4(0, -999, 0, 0),
          new THREE.Vector4(0, -999, 0, 0),
          new THREE.Vector4(0, -999, 0, 0),
        ],
      },
    };

    // Pines and their trunks sway too — the Over the Hill breeze.
    if (this.treeMaterials) {
      this._patchFoliageMaterial(this.treeMaterials.pine, {
        sway: 0.16,
        rootY: -3.2,
        topY: 3.2,
        bend: 0.2,
      });
      this._patchFoliageMaterial(this.treeMaterials.trunk, {
        sway: 0.07,
        rootY: -1.6,
        topY: 1.6,
        bend: 0.1,
      });
    }

    const random = mulberry32(this.seed ^ 0x51ed2701);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    const color = new THREE.Color();

    // How far each layer is allowed to be drawn. Grass is the expensive one and
    // the least missed at distance, so it goes first; a bush reads as part of
    // the ground anyway and can stay a little longer.
    const LAYER_REACH = { grass: 0.24, fern: 0.3, reed: 0.34, bush: 0.42 };

    const makePatch = async (name, geometry, material, slots, accept) => {
      const matrices = [];
      const colors = [];

      let placed = 0;
      let attempts = 0;
      const limit = slots * 26;
      while (placed < slots && attempts < limit) {
        if ((attempts & 511) === 0) await this._yield();
        attempts += 1;
        const x = (random() * 2 - 1) * (this.halfSize - 8);
        const z = (random() * 2 - 1) * (this.halfSize - 8);
        const index = this._indexAt(x, z);
        const h = this.heights[index];
        const key = BIOME_KEYS[this.biomeGrid[index]];
        const slope = this.slopeGrid[index];
        const density = fbm(this.noiseD, x * 0.03, z * 0.03, 2);

        if (this.inProvingGround(x, z)) continue;
        if (!accept({ x, z, h, key, slope, density, random })) continue;

        const s = 0.72 + random() * 0.85;
        const yaw = random() * Math.PI * 2;
        quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));
        position.set(x, h - 0.05, z);
        scale.set(s, s * (0.8 + random() * 0.55), s);
        matrix.compose(position, quaternion, scale);
        matrices.push(matrix.clone());

        color.copy(material.userData.baseColor || material.color);
        color.offsetHSL((random() - 0.5) * 0.03, (random() - 0.5) * 0.12, (random() - 0.5) * 0.16);
        colors.push(color.clone());

        if (name === 'grass') {
          const cell = this._indexAt(x, z);
          if (this.foliageMask[cell] < 3) this.foliageMask[cell] += 1;
        }
        placed += 1;
      }

      // Chunked rather than one 2 km instanced mesh: the near chunks draw, the
      // rest cost nothing at all.
      const reach = LAYER_REACH[name] ?? 0.3;
      const group = this._chunkify({
        name: `Foliage_${name}`,
        sources: [{
          geometry,
          material,
          matrices,
          colors,
          castShadow: name !== 'grass',
          receiveShadow: false,
        }],
        nearScale: reach,
        maxScale: reach,
      });

      for (const chunk of group.chunks) {
        for (const mesh of chunk.meshes) this._foliageMeshes.push(mesh);
      }
      return placed;
    };

    /* --- tall prairie grass --- */
    const grassGeo = createGrassTuftGeometry(1.35, 0.09);
    const grassMat = new THREE.MeshStandardMaterial({
      color: 0x8a9a4a,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
      // Not flat-shaded: flat shading derives normals from screen-space
      // derivatives, which ignores the up-facing normal override below and
      // leaves the meadow a field of hard dark facets.
      flatShading: false,
    });
    grassMat.userData.baseColor = new THREE.Color(0x8a9a4a);
    this._patchFoliageMaterial(grassMat, {
      sway: 0.4,
      rootY: 0,
      topY: 1.35,
      bend: 0.72,
      rootTint: '#8a8f3e',
      tipTint: '#ffe08a',
      softenNormal: 0.82,
    });

    // 2,400 blades over a 640 m map is one tuft every thirteen metres — the
    // meadow reads as bare ground with a few spikes on it. Grass is one
    // instanced draw of six triangles per blade and casts no shadow, so the
    // count can go up an order of magnitude for almost nothing.
    const grass = await makePatch('grass', grassGeo, grassMat, 46000, ({ h, key, slope, density, random }) => {
      if (h < 3.4 || h > 34) return false;
      if (slope > 0.45) return false;
      if (key === 'water' || key === 'rock' || key === 'mud' || key === 'snow') return false;
      // Clump into drifts rather than spraying evenly: bare earth shows
      // between stands, which is what breaks up the flat ochre.
      const drift = density > -0.02 ? 0.96 : 0.35;
      return random() < (key === 'trail' ? 0.45 : drift);
    });

    /* --- ferns in the damp, shaded spots --- */
    const fernGeo = new THREE.IcosahedronGeometry(0.46, 0);
    fernGeo.scale(1.25, 0.5, 1.25);
    fernGeo.translate(0, 0.22, 0);
    const fernMat = new THREE.MeshStandardMaterial({
      color: 0x4f7a3a,
      roughness: 0.88,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    fernMat.userData.baseColor = new THREE.Color(0x4f7a3a);
    this._patchFoliageMaterial(fernMat, {
      sway: 0.16,
      rootY: 0,
      topY: 0.45,
      bend: 0.42,
      rootTint: '#6f8a55',
      tipTint: '#bfd68c',
      softenNormal: 0.45,
    });

    const ferns = await makePatch('fern', fernGeo, fernMat, 8000, ({ h, key, slope, density, random }) => {
      if (h < 3.6 || h > 26) return false;
      if (slope > 0.5) return false;
      if (key !== 'hardpack' && key !== 'trail') return false;
      return density > 0.05 && random() < 0.7;
    });

    /* --- reeds fringing the mud bog and the river --- */
    const reedGeo = new THREE.ConeGeometry(0.055, 1.75, 3, 1, true);
    reedGeo.translate(0, 0.875, 0);
    const reedMat = new THREE.MeshStandardMaterial({
      color: 0x6f7d3c,
      roughness: 0.95,
      side: THREE.DoubleSide,
    });
    reedMat.userData.baseColor = new THREE.Color(0x6f7d3c);
    this._patchFoliageMaterial(reedMat, {
      sway: 0.42,
      rootY: 0,
      topY: 1.75,
      bend: 0.85,
      rootTint: '#6d7a3c',
      tipTint: '#d8c078',
      softenNormal: 0.7,
    });

    const reeds = await makePatch('reed', reedGeo, reedMat, 2600, ({ h, key, random }) => {
      if (h < WATER_LEVEL + 0.05 || h > WATER_LEVEL + 2.1) return false;
      if (key === 'water') return false;
      return random() < 0.75;
    });

    /* --- snow-dusted alpine bushes --- */
    const bushGeo = new THREE.IcosahedronGeometry(0.46, 0);
    bushGeo.translate(0, 0.34, 0);
    const bushMat = new THREE.MeshStandardMaterial({
      color: 0xa9b9a6,
      roughness: 0.9,
      flatShading: true,
    });
    bushMat.userData.baseColor = new THREE.Color(0xa9b9a6);
    this._patchFoliageMaterial(bushMat, { sway: 0.14, rootY: 0, topY: 0.8, bend: 0.32 });

    const bushes = await makePatch('bush', bushGeo, bushMat, 2100, ({ h, key, slope, random }) => {
      if (h < 14 || slope > 0.55) return false;
      if (key !== 'snow' && key !== 'rock') return false;
      return random() < 0.65;
    });

    this.stats.foliage = grass + ferns + reeds + bushes;
    this.foliage = { grass, ferns, reeds, bushes };
  }

  /**
   * Animate wind and shove the grass aside for every truck in the squad.
   * `trucks` is an array of { x, y, z, radius }. Missing slots are parked
   * far away so the shader ignores them.
   */
  updateFoliage(dt, trucks = []) {
    if (!this.windUniforms) return;
    this.windUniforms.uTime.value += dt;

    // Pushable stones follow their rigid body, so a shoved boulder rolls away
    // visually instead of sliding through the meadow like a ghost.
    if (this.boulderBodies.length) {
      for (let i = 0; i < this.boulderBodies.length; i += 1) {
        const entry = this.boulderBodies[i];
        const p = entry.body.position;
        const q = entry.body.quaternion;
        this._bp.set(p.x, p.y, p.z);
        this._bq.set(q.x, q.y, q.z, q.w);
        this._bs.set(entry.radius, entry.radius * entry.squash, entry.radius);
        this._bm.compose(this._bp, this._bq, this._bs);
        // A stone is drawn twice (full mesh up close, tetrahedron far away), so
        // both copies have to follow the body.
        if (entry.near) {
          entry.near.mesh.setMatrixAt(entry.near.index, this._bm);
          entry.near.mesh.instanceMatrix.needsUpdate = true;
        }
        if (entry.far) {
          entry.far.mesh.setMatrixAt(entry.far.index, this._bm);
          entry.far.mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
    const slots = this.windUniforms.uTruckPos.value;
    for (let i = 0; i < slots.length; i += 1) {
      const truck = trucks[i];
      if (truck) slots[i].set(truck.x, truck.y, truck.z, truck.radius ?? 2.4);
      else slots[i].set(0, -999, 0, 0);
    }
  }

  /**
   * Phase 8: living-wilderness density, 0 (bare) .. 1 (lush).
   * Instance counts change instantly; tree colliders are toggled in lockstep so
   * the player can never hit an invisible trunk.
   */
  setFoliageDensity(density) {
    const d = Math.min(1, Math.max(0, Number(density) || 0));
    this.foliageDensity = d;

    for (const mesh of this._foliageMeshes || []) {
      const max = mesh.userData.maxInstances || mesh.count;
      const count = Math.floor(max * d);
      mesh.count = count;
      mesh.userData.active = count > 0;
      mesh.visible = count > 0;
    }

    // Trees thin out per chunk, and each hidden instance takes its collider
    // with it, so nobody can drive into a trunk that is not being drawn.
    const activeTree = new Uint8Array(this.stats.trees);
    for (const chunk of this.treeChunks?.chunks || []) {
      const n = chunk.indices.length;
      const keep = Math.floor(n * d);
      for (const mesh of chunk.meshes) {
        mesh.count = keep;
        mesh.userData.active = keep > 0;
      }
      for (const mesh of chunk.farMeshes) mesh.count = keep;
      for (let k = 0; k < keep; k += 1) activeTree[chunk.indices[k]] = 1;
    }

    for (let i = 0; i < this.treeColliders.length; i += 1) {
      const active = i < activeTree.length ? activeTree[i] === 1 : true;
      const body = this.treeColliders[i];
      if (body.collisionResponse !== active) {
        body.collisionResponse = active;
        body.collisionFilterGroup = active ? 1 : 0;
      }
    }
    this.stats.foliageVisible = this._foliageMeshes.reduce((sum, mesh) => sum + mesh.count, 0);
  }

  /* ---------------- lifecycle ---------------- */

  setAnisotropy(value) {
    this.detailTexture.anisotropy = value;
    this.detailTexture.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.group);
    if (this.chunks) for (const chunk of this.chunks) chunk.geometry.dispose();
    this.mesh.traverse((o) => o.geometry?.dispose());
    this.material.dispose();
    this.detailTexture.dispose();
    this.water.geometry.dispose();
    this.water.material.dispose();
  }
}
