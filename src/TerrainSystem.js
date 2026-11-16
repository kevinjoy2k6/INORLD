import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { REGIONS, ROADS, regionAt, WORLD } from './WorldAtlas.js';
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

const SIZE = WORLD.size;
const SEGMENTS = 320;
const ELEMENT = SIZE / SEGMENTS;
const VERTS = SEGMENTS + 1;
const WATER_LEVEL = 1.1;
// Deepest water is WATER_LEVEL - RIVER_BED: 0.95 m, past a stock intake (0.8 m)
// and comfortably inside a snorkel's 1.8 m.
const RIVER_BED = 0.15;

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

    this._generateHeightGrid();
    this._buildMesh();
    this._buildPhysics();
    this._buildWater();
    this._scatter();
    this._buildFoliage();

    this.spawn = this._resolveSpawn();
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
    const paths = [loop, spur];
    for (const road of ROADS) {
      paths.push(road.points);
      this.pathWidths.push(road.width);
    }
    this.roadPaths = ROADS;
    return paths;
  }

  riverZ(x) {
    return -26 + 16 * Math.sin(x * 0.0095) + 5 * Math.sin(x * 0.028 + 1.6);
  }

  bogCentre() {
    return { x: -78, z: -62 };
  }

  /* ---------------- height ---------------- */

  _baseHeight(x, z) {
    const a = this.noiseA;
    const b = this.noiseB;
    const c = this.noiseC;

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

  _trailDistanceAndHeight(x, z) {
    if (!this.trailHeights) return { distance: Infinity, height: 0, width: 3 };
    const widths = this.pathWidths || [];
    let best = null;
    for (let p = 0; p < this.trailPoints.length; p += 1) {
      const path = this.trailPoints[p];
      const heights = this.trailHeights[p];
      for (let i = 1; i < path.length; i += 1) {
        const [x0, z0] = path[i - 1];
        const [x1, z1] = path[i];
        const dx = x1 - x0;
        const dz = z1 - z0;
        const lengthSq = dx * dx + dz * dz;
        if (lengthSq < 1e-6) continue;
        let t = ((x - x0) * dx + (z - z0) * dz) / lengthSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const distance = Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t));
        if (!best || distance < best.distance) {
          best = {
            distance,
            height: lerp(heights[i - 1], heights[i], t),
            width: widths[p] ?? 3,
          };
        }
      }
    }
    return best || { distance: Infinity, height: 0, width: 3 };
  }

  /** Base terrain + the region's own character (meadow rolls, canyon steps). */
  _shapedHeight(x, z) {
    let h = this._baseHeight(x, z);
    const coast = z < -170;
    if (!coast && h < 2.15) h = 2.15;
    const region = regionAt(x, z);
    if (region.shape) h = region.shape(h, x, z, (a, b) => this.noiseB(a, b));
    if (!coast && h < 1.6) h = 1.6;
    return h;
  }

  _generateHeightGrid() {
    // Sample every waypoint so the trail can be flattened to its own grade.
    this.trailHeights = this.trailPoints.map((path) =>
      path.map(([x, z]) => this._shapedHeight(x, z)),
    );

    if (this.testMode) {
      this.provingDatum = resolveDatum((x, z) => this._baseHeight(x, z));
    }

    for (let j = 0; j < VERTS; j += 1) {
      const z = -this.halfSize + j * ELEMENT;
      for (let i = 0; i < VERTS; i += 1) {
        const x = -this.halfSize + i * ELEMENT;
        const index = i * VERTS + j;

        let h = this._shapedHeight(x, z);

        // Flatten the corridor to the path's own grade. Roads cut wider than
        // trails so they read as graded carriageway rather than a footpath.
        const trail = this._trailDistanceAndHeight(x, z);
        const corridor = trail.width + 5;
        if (trail.distance < corridor) {
          const inner = trail.width * 0.6;
          const w = 1 - smoothstep(inner, corridor, trail.distance);
          h = lerp(h, trail.height, w * 0.95);
        }

        // Carve the river last so it cuts through the trail at the ford.
        const riverDistance = Math.abs(z - this.riverZ(x));
        if (riverDistance < 34) {
          const w = 1 - smoothstep(4.5, 34, riverDistance);
          h = lerp(h, RIVER_BED, w * w);
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

    this._classifyBiomes();
  }

  _classifyBiomes() {
    const bog = this.bogCentre();

    for (let j = 0; j < VERTS; j += 1) {
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
        const trail = this._trailDistanceAndHeight(x, z);

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

  _buildMesh() {
    const count = VERTS * VERTS;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);

    const color = new THREE.Color();
    const tint = new THREE.Color();

    for (let j = 0; j < VERTS; j += 1) {
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
          const trail = this._trailDistanceAndHeight(x, z);
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

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: this.detailTexture,
      roughness: 0.93,
      metalness: 0.02,
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

  _buildPhysics() {
    const matrix = [];
    for (let i = 0; i < VERTS; i += 1) {
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

  _scatter() {
    const random = mulberry32(this.seed ^ 0x2545f491);

    const trunkGeometry = new THREE.CylinderGeometry(0.22, 0.32, 3.2, 6);
    const pineGeometry = new THREE.ConeGeometry(1.9, 6.4, 7);
    const boulderGeometry = new THREE.IcosahedronGeometry(1, 1);
    const poleGeometry = new THREE.CylinderGeometry(0.13, 0.15, 4.6, 6);

    const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.95 });
    const pineMaterial = new THREE.MeshStandardMaterial({ color: 0x2c4a32, roughness: 0.9, flatShading: true });
    const boulderMaterial = new THREE.MeshStandardMaterial({ color: 0x6a6259, roughness: 0.94, flatShading: true });
    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x6d5433, roughness: 0.9 });

    const TREES = 340;
    const BOULDERS = 150;
    const POLES = 46;

    const trunkMesh = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, TREES);
    const pineMesh = new THREE.InstancedMesh(pineGeometry, pineMaterial, TREES);
    const boulderMesh = new THREE.InstancedMesh(boulderGeometry, boulderMaterial, BOULDERS);
    const poleMesh = new THREE.InstancedMesh(poleGeometry, poleMaterial, POLES);

    for (const mesh of [trunkMesh, pineMesh, boulderMesh, poleMesh]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      this.group.add(mesh);
    }

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();

    let trees = 0;
    let attempts = 0;
    while (trees < TREES && attempts < TREES * 40) {
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
      const trail = this._trailDistanceAndHeight(x, z);
      if (trail.distance < trail.width + 5) continue;

      const density = fbm(this.noiseD, x * 0.012, z * 0.012, 3);
      if (density < -0.12 && random() > 0.22) continue;

      const height = 0.82 + random() * 0.62;
      const yaw = random() * Math.PI * 2;

      quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));

      position.set(x, h + 1.6 * height, z);
      scale.set(1, height, 1);
      matrix.compose(position, quaternion, scale);
      trunkMesh.setMatrixAt(trees, matrix);

      position.set(x, h + 4.4 * height, z);
      matrix.compose(position, quaternion, scale);
      pineMesh.setMatrixAt(trees, matrix);

      const body = new CANNON.Body({ mass: 0, material: this.groundMaterial });
      body.addShape(new CANNON.Box(new CANNON.Vec3(0.3, 1.7 * height, 0.3)));
      body.position.set(x, h + 1.7 * height, z);
      body.collisionFilterGroup = 1;
      body.userData = { surface: 'hardpack', tree: true };
      body.aabbNeedsUpdate = true;
      body.updateAABB();
      this.world.addBody(body);

      this._addAnchor('tree', new THREE.Vector3(x, h, z), 0.45, body, 1.9);
      this.treeColliders.push(body);
      trees += 1;
    }

    trunkMesh.count = trees;
    pineMesh.count = trees;
    this.stats.trees = trees;

    // Phase-7 wind: the pulse trees and their trunks keep references so the
    // shared sway uniforms can be animated from updateFoliage().
    this.treeMaterials = { trunk: trunkMaterial, pine: pineMaterial };
    this.treeMeshes = { trunk: trunkMesh, pine: pineMesh };

    let boulders = 0;
    attempts = 0;
    while (boulders < BOULDERS && attempts < BOULDERS * 40) {
      attempts += 1;
      const x = (random() * 2 - 1) * (this.halfSize - 10);
      const z = (random() * 2 - 1) * (this.halfSize - 10);
      const index = this._indexAt(x, z);
      const h = this.heights[index];
      const key = BIOME_KEYS[this.biomeGrid[index]];
      if (this.inProvingGround(x, z)) continue;
      if (key === 'water' || this.waterGrid[index] > 0) continue;
      const road = this._trailDistanceAndHeight(x, z);
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
      boulderMesh.setMatrixAt(boulders, matrix);

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
      this.world.addBody(body);

      if (movable) {
        this.boulderBodies.push({ body, index: boulders, radius, squash });
      }

      this._addAnchor('boulder', new THREE.Vector3(x, h, z), radius, body, radius * 0.7);
      boulders += 1;
    }
    boulderMesh.count = boulders;
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
      const steps = Math.max(1, Math.round(length / 26));

      for (let s = 0; s < steps && poles < POLES; s += 1) {
        const t = (s + 0.5) / steps;
        const nx = -dz;
        const nz = dx;
        const side = s % 2 === 0 ? 1 : -1;
        const x = x0 + (x1 - x0) * t + nx * 5.2 * side;
        const z = z0 + (z1 - z0) * t + nz * 5.2 * side;
        const h = this.getHeightAt(x, z);
        // No markers standing in the ford.
        if (h < WATER_LEVEL + 0.7 || this.waterGrid[this._indexAt(x, z)] > 0) continue;
        const yaw = random() * Math.PI * 2;

        quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));
        position.set(x, h + 2.3, z);
        scale.set(1, 1, 1);
        matrix.compose(position, quaternion, scale);
        poleMesh.setMatrixAt(poles, matrix);

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
        this.world.addBody(body);

        this._addAnchor('pole', new THREE.Vector3(x, h, z), 0.3, body, 2.4);
        poles += 1;
      }
    }
    poleMesh.count = poles;
    this.stats.poles = poles;
    this.stats.anchors = this.winchAnchors.length;

    for (const mesh of [trunkMesh, pineMesh, boulderMesh, poleMesh]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }

    this.props = { trunkMesh, pineMesh, boulderMesh, poleMesh };
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
  _patchFoliageMaterial(material, { sway = 0.3, rootY = 0.0, topY = 1.0, bend = 0.55 } = {}) {
    material.userData.windUniforms = this.windUniforms;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.windUniforms.uTime;
      shader.uniforms.uTruckPos = this.windUniforms.uTruckPos;
      shader.vertexShader = `
        uniform float uTime;
        uniform vec4 uTruckPos[4];
      ` + shader.vertexShader;

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
    };
    material.customProgramCacheKey = () => 'inorld-foliage';
    material.needsUpdate = true;
    return material;
  }

  _buildFoliage() {
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

    const makePatch = (name, geometry, material, slots, accept) => {
      const mesh = new THREE.InstancedMesh(geometry, material, slots);
      mesh.userData.maxInstances = slots;
      this._foliageMeshes.push(mesh);
      mesh.name = `Foliage_${name}`;
      mesh.castShadow = name !== 'grass';
      mesh.receiveShadow = false;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(slots * 3), 3);

      let placed = 0;
      let attempts = 0;
      const limit = slots * 26;
      while (placed < slots && attempts < limit) {
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
        mesh.setMatrixAt(placed, matrix);

        color.copy(material.userData.baseColor || material.color);
        color.offsetHSL((random() - 0.5) * 0.03, (random() - 0.5) * 0.12, (random() - 0.5) * 0.16);
        mesh.setColorAt(placed, color);
        if (name === 'grass') {
          const cell = this._indexAt(x, z);
          if (this.foliageMask[cell] < 3) this.foliageMask[cell] += 1;
        }
        placed += 1;
      }

      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      return placed;
    };

    /* --- tall prairie grass --- */
    const grassGeo = new THREE.ConeGeometry(0.15, 1.35, 3, 1, true);
    grassGeo.translate(0, 0.675, 0);
    const grassMat = new THREE.MeshStandardMaterial({
      color: 0x8a9a4a,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
      flatShading: true,
    });
    grassMat.userData.baseColor = new THREE.Color(0x8a9a4a);
    this._patchFoliageMaterial(grassMat, { sway: 0.4, rootY: 0, topY: 1.35, bend: 0.72 });

    const grass = makePatch('grass', grassGeo, grassMat, 2400, ({ h, key, slope, random }) => {
      if (h < 3.4 || h > 34) return false;
      if (slope > 0.45) return false;
      if (key === 'water' || key === 'rock' || key === 'mud' || key === 'snow') return false;
      return random() < (key === 'trail' ? 0.55 : 0.95);
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
    this._patchFoliageMaterial(fernMat, { sway: 0.16, rootY: 0, topY: 0.45, bend: 0.42 });

    const ferns = makePatch('fern', fernGeo, fernMat, 620, ({ h, key, slope, density, random }) => {
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
    this._patchFoliageMaterial(reedMat, { sway: 0.42, rootY: 0, topY: 1.75, bend: 0.85 });

    const reeds = makePatch('reed', reedGeo, reedMat, 480, ({ h, key, random }) => {
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

    const bushes = makePatch('bush', bushGeo, bushMat, 380, ({ h, key, slope, random }) => {
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
    if (this.boulderBodies.length && this.props) {
      const mesh = this.props.boulderMesh;
      for (let i = 0; i < this.boulderBodies.length; i += 1) {
        const entry = this.boulderBodies[i];
        const p = entry.body.position;
        const q = entry.body.quaternion;
        this._bp.set(p.x, p.y, p.z);
        this._bq.set(q.x, q.y, q.z, q.w);
        this._bs.set(entry.radius, entry.radius * entry.squash, entry.radius);
        this._bm.compose(this._bp, this._bq, this._bs);
        mesh.setMatrixAt(entry.index, this._bm);
      }
      mesh.instanceMatrix.needsUpdate = true;
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
      mesh.visible = count > 0;
    }

    const keep = Math.floor(this.stats.trees * d);
    if (this.props) {
      this.props.trunkMesh.count = keep;
      this.props.pineMesh.count = keep;
      this.props.trunkMesh.visible = keep > 0;
      this.props.pineMesh.visible = keep > 0;
    }
    for (let i = 0; i < this.treeColliders.length; i += 1) {
      const active = i < keep;
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
