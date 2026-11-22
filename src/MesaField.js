/* ============================================================================
 * MesaField — the red-rock country the valley was always supposed to be
 *
 *  The terrain heightfield stays exactly as the physics built it: 4.9 m cells,
 *  graded roads, a carved river, and a vertical scale that keeps every trail
 *  drivable. What the heightfield cannot afford is relief — a 90 m butte is
 *  nine thousand cells of mesh and a road that cannot climb it.
 *
 *  So the drama is scenery, not ground:
 *
 *   - terraced buttes and mesas, built as stacked rings with flat faces and
 *     banded sandstone vertex colours, clustered until their silhouettes merge
 *     into massifs;
 *   - palm oases hugging the river bends, trunk rings and drooping fronds;
 *   - bright low-poly scrub on the sand around them.
 *
 *  Everything is baked into three merged meshes (stone, trunks, fronds) plus a
 *  single instanced scrub mesh, so the whole country costs a handful of draw
 *  calls. Only the buttes near the road get a static collider; the rest are
 *  backdrop and you can drive to them but never through the ones you can hit.
 * ========================================================================== */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { REGIONS } from './WorldAtlas.js';

/* ------------------------------------------------------------------ *\
 *  Palette
 * ------------------------------------------------------------------ */

/** Sandstone strata, bottom to top: oxidised red at the foot, pale caprock. */
const STRATA = [
  0xc99174,
  0xd69e80,
  0xcf9678,
  0xdda889,
  0xc98c6d,
  0xe4b596,
  0xdba687,
  0xedc9ab,
];

/**
 * Per-face shade jitter. Sandstone is not one flat colour per band: every facet
 * catches the sun slightly differently, and in a flat-shaded model those
 * differences are the only thing separating two quads of the same band.
 */
function shade(hex, factor) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * factor));
  const b = Math.min(255, Math.round((hex & 255) * factor));
  return (r << 16) | (g << 8) | b;
}

const PALM_TRUNK = 0x8a6a48;
const PALM_TRUNK_DARK = 0x6f543a;
const PALM_FROND = 0x6ba649;
const PALM_FROND_TIP = 0x8cc35d;
const SCRUB_COLOURS = [0x77a84a, 0x86b653, 0x92c25c, 0x6b9a45];

/* ------------------------------------------------------------------ *\
 *  Small deterministic RNG, so the country is the same every load and
 *  agrees between co-op clients without sending any of it over the wire.
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *\
 *  Geometry builders
 *
 *  Both builders append raw triangles into shared arrays. Nothing is indexed:
 *  a mesa face is a facet, so it gets its own three vertices and its own normal
 *  — that is what makes the silhouette read as carved rather than moulded.
 * ------------------------------------------------------------------ */

class TriangleSoup {
  constructor() {
    this.positions = [];
    this.colors = [];
    this.color = new THREE.Color();
  }

  /** Adds one flat triangle with a single colour across it. */
  tri(a, b, c, hex) {
    this.color.setHex(hex);
    const { positions, colors, color } = this;
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i += 1) colors.push(color.r, color.g, color.b);
  }

  /** Adds a quad as two triangles; `winding` flips the order when needed. */
  quad(a, b, c, d, hex, flip = false) {
    if (flip) {
      this.tri(a, c, b, hex);
      this.tri(a, d, c, hex);
    } else {
      this.tri(a, b, c, hex);
      this.tri(a, c, d, hex);
    }
  }

  build() {
    if (!this.positions.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    // Non-indexed, so this produces one normal per face: hard low-poly shading.
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/**
 * One butte: a base talus flare, terraced cliff rings, and a flat caprock.
 *
 * The rings alternate wide ledge / narrow cliff, which is what sandstone does
 * under a hard cap and what gives the eye something to read at distance. Every
 * ring vertex gets its own radius jitter so no two faces end up coplanar, but
 * the jitter is shared by the quads of that ring so the wall does not tear.
 */
function appendMesa(soup, random, { cx, cy, cz, radius, height, sides, levels }, groundAt = null) {
  const rings = [];
  const angles = [];
  const step = (Math.PI * 2) / sides;
  for (let s = 0; s < sides; s += 1) angles.push(s * step + (random() - 0.5) * step * 0.45);

  for (let k = 0; k <= levels; k += 1) {
    const t = k / levels;
    // Profiles: a wide foot, then ledges that overhang the cliff below them.
    // A mesa is a wall under a hard cap, not a cone: it keeps most of its
    // footprint to the very top, and the ledges overhang the cliff below them.
    // Ledges barely overhang: a strong lip reads as a stack of pancakes, while
    // a near-vertical wall with one stepped band reads as a mesa.
    const ledge = k % 2 === 0;
    const shrink = 1 - 0.18 * Math.pow(t, 1.2);
    const profile = t === 0 ? 1.16 : shrink * (ledge ? 1.02 : 0.93);
    const y = cy + height * Math.pow(t, 0.92);
    const ring = [];
    for (let s = 0; s < sides; s += 1) {
      const wobble = 0.92 + random() * 0.16;
      const r = radius * profile * wobble;
      ring.push([cx + Math.cos(angles[s]) * r, y, cz + Math.sin(angles[s]) * r]);
    }
    rings.push({ ring, t, y });
  }

  for (let k = 0; k < rings.length - 1; k += 1) {
    const lower = rings[k];
    const upper = rings[k + 1];
    const band = STRATA[k % STRATA.length];
    for (let s = 0; s < sides; s += 1) {
      const n = (s + 1) % sides;
      soup.quad(lower.ring[s], lower.ring[n], upper.ring[n], upper.ring[s], shade(band, 0.9 + random() * 0.2), true);
    }
  }

  // Caprock: a fan from the centre of the top ring, one shade lighter.
  const top = rings[rings.length - 1];
  const capColour = STRATA[STRATA.length - 1];
  // The cap sits on a slight tilt, so the top edge is not a horizontal ruler.
  const centre = [cx + (random() - 0.5) * radius * 0.1, top.y + 0.25 + random() * 2.2, cz + (random() - 0.5) * radius * 0.1];
  for (let s = 0; s < sides; s += 1) {
    const n = (s + 1) % sides;
    soup.tri(centre, top.ring[s], top.ring[n], shade(capColour, 0.94 + random() * 0.12));
  }

  // Talus skirt: the sand slope that runs out from the foot of the cliff.
  // The apron has to follow the ground it lands on. A flat skirt ring sat
  // above the sand like a plate under the rock wherever the terrain fell away.
  const foot = rings[0];
  const outer = foot.ring.map((p, s) => {
    const dx = Math.cos(angles[s]) * radius * 0.5;
    const dz = Math.sin(angles[s]) * radius * 0.5;
    const px = p[0] + dx;
    const pz = p[2] + dz;
    const groundY = groundAt ? groundAt(px, pz) : cy - 3;
    return [px, Math.min(cy, groundY) + 0.2, pz];
  });
  for (let s = 0; s < sides; s += 1) {
    const n = (s + 1) % sides;
    soup.quad(outer[s], outer[n], foot.ring[n], foot.ring[s], STRATA[0], true);
  }
}

/**
 * A fallen block at the foot of a cliff. Six-sided and jittered: the rubble
 * apron is what tells the eye the wall is stone and not a painted backdrop.
 */
function appendChunk(soup, random, { x, y, z, size }) {
  const points = [];
  const sides = 5 + Math.floor(random() * 3);
  for (let s = 0; s < sides; s += 1) {
    const a = (s / sides) * Math.PI * 2;
    points.push([x + Math.cos(a) * size * (0.7 + random() * 0.5), y, z + Math.sin(a) * size * (0.7 + random() * 0.5)]);
  }
  const top = [x + (random() - 0.5) * size * 0.4, y + size * (0.6 + random() * 0.5), z + (random() - 0.5) * size * 0.4];
  const base = [x, y - size * 0.4, z];
  for (let s = 0; s < sides; s += 1) {
    const n = (s + 1) % sides;
    const band = STRATA[(s + Math.floor(y)) % STRATA.length];
    soup.tri(points[s], points[n], top, shade(band, 0.92 + random() * 0.16));
    soup.tri(base, points[n], points[s], shade(band, 0.72 + random() * 0.1));
  }
}

/**
 * One palm: a leaning ringed trunk and a crown of drooping fronds.
 * `scale` is the overall size; adult palms here run 7-12 m to the crown.
 */
function appendPalm(soup, random, { x, y, z, scale, lean = 0 }) {
  const height = 7.6 * scale;
  const leanX = Math.cos(lean) * height * 0.14;
  const leanZ = Math.sin(lean) * height * 0.14;
  const trunkSides = 5;
  const trunkRings = 5;
  const trunk = [];

  for (let k = 0; k <= trunkRings; k += 1) {
    const t = k / trunkRings;
    // Palms taper and curve: wider at the foot, thinner under the crown.
    const r = (0.34 - 0.16 * t) * scale;
    const bend = t * t;
    const ring = [];
    for (let s = 0; s < trunkSides; s += 1) {
      const a = (s / trunkSides) * Math.PI * 2 + t * 0.5;
      ring.push([
        x + leanX * bend + Math.cos(a) * r,
        y + height * t,
        z + leanZ * bend + Math.sin(a) * r,
      ]);
    }
    trunk.push(ring);
  }

  for (let k = 0; k < trunkRings; k += 1) {
    const shade = k % 2 === 0 ? PALM_TRUNK : PALM_TRUNK_DARK;
    for (let s = 0; s < trunkSides; s += 1) {
      const n = (s + 1) % trunkSides;
      soup.quad(trunk[k][s], trunk[k][n], trunk[k + 1][n], trunk[k + 1][s], shade, true);
    }
  }

  const crownX = x + leanX;
  const crownZ = z + leanZ;
  const crownY = y + height;
  const fronds = 14 + Math.floor(random() * 3);

  for (let f = 0; f < fronds; f += 1) {
    const a = (f / fronds) * Math.PI * 2 + random() * 0.3;
    // Alternate long low fronds with shorter lifted ones.
    const up = f % 2 === 0 ? 0.45 + random() * 0.3 : 0.95 + random() * 0.35;
    const length = (2.6 + random() * 1.2) * scale;
    const droop = (2.3 + random() * 1.0) * scale;
    const segments = 3;
    let previous = null;

    for (let s = 0; s <= segments; s += 1) {
      const t = s / segments;
      const out = length * t;
      const spread = Math.cos(a) * out;
      const spreadZ = Math.sin(a) * out;
      const rise = up * Math.sin(t * Math.PI * 0.62) - droop * t * t;
      // Fronds are ribbons: a raised midrib with the two edges dropped, so each
      // segment splits into two facets and catches the light in bands.
      const halfWidth = (0.78 - 0.5 * t) * scale;
      const cx = crownX + spread;
      const cz = crownZ + spreadZ;
      const cy = crownY + rise;
      const px = Math.cos(a + Math.PI / 2) * halfWidth;
      const pz = Math.sin(a + Math.PI / 2) * halfWidth;
      const edge = 0.14 * scale;
      const shade = t > 0.66 ? PALM_FROND_TIP : PALM_FROND;
      const left = [cx + px, cy - edge, cz + pz];
      const right = [cx - px, cy - edge, cz - pz];
      const mid = [cx, cy + edge * 0.6, cz];
      if (previous) {
        soup.quad(previous.mid, mid, left, previous.left, shade, true);
        soup.quad(previous.right, right, mid, previous.mid, shade);
      }
      previous = { mid, left, right };
    }
  }
}

/* ------------------------------------------------------------------ *\
 *  MesaField
 * ------------------------------------------------------------------ */

export class MesaField {
  constructor({ scene, terrain, world = null, seed = 0x5eed1a }) {
    this.scene = scene;
    this.terrain = terrain;
    this.world = world;
    this.random = mulberry32(seed);

    this.group = new THREE.Group();
    this.group.name = 'RedRockCountry';
    this.group.matrixAutoUpdate = false;

    this.stoneTriangles = 0;
    this.palms = 0;
    this.scrub = 0;
    this.mesas = 0;

    this._stoneMaterial = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 1,
    });

    this._buildMesas();
    this._buildOases();
    this._buildScrub();

    this.scene.add(this.group);
  }

  /* ---------------- placement helpers ---------------- */

  _height(x, z) {
    return this.terrain.getHeightAt(x, z);
  }

  _indexAt(x, z) {
    return typeof this.terrain._indexAt === 'function' ? this.terrain._indexAt(x, z) : -1;
  }

  _wet(x, z) {
    const index = this._indexAt(x, z);
    if (index >= 0 && this.terrain.waterGrid && this.terrain.waterGrid[index] > 0) return true;
    return this._height(x, z) < this.terrain.waterLevel + 0.35;
  }

  _trailDistance(x, z) {
    if (typeof this.terrain._trailFieldAt !== 'function') return 1e9;
    const field = this.terrain._trailFieldAt(x, z);
    return field ? field.distance - field.width : 1e9;
  }

  _insideCanyon(x, z) {
    const canyon = REGIONS.find((region) => region.id === 'canyon');
    if (!canyon) return false;
    const [x0, x1] = canyon.bounds.x;
    const [z0, z1] = canyon.bounds.z;
    return x >= x0 + 40 && x <= x1 - 40 && z >= z0 + 40 && z <= z1 - 40;
  }

  /** Big rock is allowed near the river; it just must not stand in it. */
  _canPlaceMesa(x, z, radius) {
    if (!this._insideCanyon(x, z)) return false;
    if (this._wet(x, z)) return false;
    const height = this._height(x, z);
    if (height < this.terrain.waterLevel + 1.2) return false;
    // Keep the graded corridor clear: a butte across the canyon road would be
    // a wall the truck cannot grade around, and the atlas says the road loops
    // the basin.
    if (this._trailDistance(x, z) < 18 + radius * 0.55) return false;
    // The stone keeps occupy the watchtower sites; do not bury a landmark.
    if (this.terrain.inProvingGround && this.terrain.inProvingGround(x, z)) return false;
    return true;
  }

  /* ---------------- buttes and massifs ---------------- */

  _buildMesas() {
    const random = this.random;
    const soup = new TriangleSoup();
    const colliders = [];

    // Massifs first: overlapping buttes read as one walled basin, which is the
    // shape the red-rock country is supposed to have. A lone butte on a plain
    // reads as a rock, not a canyon.
    const clusters = 9;
    for (let c = 0; c < clusters; c += 1) {
      let placed = false;
      // The first clusters are pinned to the river corridor, so the basin has
      // cliffs framing the water instead of mesas scattered across the map.
      const riverside = c < 5;
      for (let attempt = 0; attempt < 90 && !placed; attempt += 1) {
        const rx = 220 + random() * 700;
        const spread = riverside ? 70 + random() * 80 : 240;
        const x = riverside ? rx : 180 + random() * 780;
        const z = riverside
          ? this.terrain.riverZ(rx) + (random() < 0.5 ? -1 : 1) * spread
          : -480 + random() * 800;
        if (!this._canPlaceMesa(x, z, 50)) continue;
        placed = true;
        const members = 2 + Math.floor(random() * 3);
        for (let m = 0; m < members; m += 1) {
          const radius = 20 + random() * 26;
          const ox = (random() - 0.5) * radius * 2.2;
          const oz = (random() - 0.5) * radius * 2.2;
          const mx = x + ox;
          const mz = z + oz;
          if (!this._canPlaceMesa(mx, mz, radius)) continue;
          this._addMesa(soup, mx, mz, radius, 30 + random() * 52, colliders);
        }
      }
    }

    // Hero buttes: one wall of rock close enough to the water to fill a third
    // of the frame. The reference composition depends on one near cliff giving
    // scale to everything behind it, and clusters alone never provide that.
    for (let i = 0; i < 4; i += 1) {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const x = 300 + random() * 520;
        const riverZ = this.terrain.riverZ(x);
        const side = i % 2 === 0 ? -1 : 1;
        const z = riverZ + side * (95 + random() * 70);
        const radius = 34 + random() * 26;
        if (!this._canPlaceMesa(x, z, radius)) continue;
        this._addMesa(soup, x, z, radius, 55 + random() * 40, colliders);
        break;
      }
    }

    // A handful of lone mesas out in the washes, for scale cues between them.
    for (let i = 0; i < 14; i += 1) {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const x = 160 + random() * 820;
        const z = -500 + random() * 840;
        const radius = 12 + random() * 16;
        if (!this._canPlaceMesa(x, z, radius)) continue;
        this._addMesa(soup, x, z, radius, 16 + random() * 26, colliders);
        break;
      }
    }

    const geometry = soup.build();
    if (geometry) {
      const mesh = new THREE.Mesh(geometry, this._stoneMaterial);
      mesh.name = 'MesaStone';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.stoneTriangles = geometry.attributes.position.count / 3;
    }

    // Static colliders, generously oversized so the truck meets the talus
    // before it clips a cliff face.
    if (this.world) {
      for (const box of colliders) {
        const body = new CANNON.Body({ mass: 0, material: this.terrain.groundMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(box.radius * 0.78, box.height * 0.5, box.radius * 0.78)));
        body.position.set(box.x, box.y + box.height * 0.5, box.z);
        body.collisionFilterGroup = 1;
        body.userData = { surface: 'rock', mesa: true };
        body.aabbNeedsUpdate = true;
        body.updateAABB();
        this.world.addBody(body);
      }
    }
  }

  _addMesa(soup, x, z, radius, height, colliders) {
    const random = this.random;
    const base = this._height(x, z);
    const sides = 8 + Math.floor(random() * 5);
    // More, thinner rings: the reference walls are striated, and a 5 m band of
    // colour per terrace is what reads as sandstone rather than as clay.
    const levels = 10 + Math.floor(random() * 5);
    appendMesa(
      soup,
      random,
      {
        cx: x,
        cy: base - 1,
        cz: z,
        radius,
        height,
        sides,
        levels,
      },
      (gx, gz) => this._height(gx, gz),
    );
    // Rubble apron: blocks that have come off the cliff, half-buried in the
    // talus slope, big enough to read at a hundred metres.
    const blocks = 3 + Math.floor(this.random() * 4);
    for (let b = 0; b < blocks; b += 1) {
      const angle = this.random() * Math.PI * 2;
      const distance = radius * (0.95 + this.random() * 0.5);
      const bx = x + Math.cos(angle) * distance;
      const bz = z + Math.sin(angle) * distance;
      appendChunk(soup, this.random, {
        x: bx,
        y: this._height(bx, bz) + 0.4,
        z: bz,
        size: 1.8 + this.random() * 3.4,
      });
    }

    colliders.push({ x, z, y: base, radius, height });
    this.mesas += 1;
  }

  /* ---------------- palm oases along the river ---------------- */

  _buildOases() {
    const random = this.random;
    const trunkSoup = new TriangleSoup();
    const frondSoup = new TriangleSoup();
    const colliders = [];

    // Five oasis hearts on the canyon reach of the river, then palms scattered
    // along both banks between them. The river is the only reliable water in
    // the basin, so everything green is pinned to it.
    const oases = [];
    for (let i = 0; i < 5; i += 1) {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const x = 200 + random() * 700;
        if (!this._insideCanyon(x, 0)) continue;
        const riverZ = this.terrain.riverZ(x);
        const side = random() < 0.5 ? -1 : 1;
        const z = riverZ + side * (12 + random() * 18);
        if (this._wet(x, z)) continue;
        oases.push({ x, z });
        break;
      }
    }

    const addPalm = (x, z, scale) => {
      if (this._wet(x, z)) return false;
      if (this._trailDistance(x, z) < 5) return false;
      const y = this._height(x, z) - 0.2;
      const lean = random() * Math.PI * 2;
      appendPalm(trunkSoup, random, { x, y, z, scale, lean });
      appendPalm(frondSoup, random, { x, y, z, scale, lean });
      colliders.push({ x, z, y, height: 6.4 * scale });
      this.palms += 1;
      return true;
    };

    for (const oasis of oases) {
      const count = 10 + Math.floor(random() * 8);
      for (let i = 0; i < count; i += 1) {
        const angle = random() * Math.PI * 2;
        const distance = random() * 30;
        const x = oasis.x + Math.cos(angle) * distance;
        const z = oasis.z + Math.sin(angle) * distance;
        addPalm(x, z, 0.95 + random() * 0.5);
      }
    }

    // Loose palms following the water, so the river reads as a living corridor
    // rather than five isolated clumps.
    for (let i = 0; i < 90; i += 1) {
      const x = 170 + random() * 800;
      const riverZ = this.terrain.riverZ(x);
      const side = random() < 0.5 ? -1 : 1;
      const z = riverZ + side * (8 + random() * 16);
      addPalm(x, z, 0.9 + random() * 0.55);
    }

    const trunkGeometry = trunkSoup.build();
    if (trunkGeometry) {
      const trunks = new THREE.Mesh(
        trunkGeometry,
        new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
      );
      trunks.name = 'PalmTrunks';
      trunks.castShadow = true;
      trunks.matrixAutoUpdate = false;
      this.group.add(trunks);
    }

    const frondGeometry = frondSoup.build();
    if (frondGeometry) {
      const fronds = new THREE.Mesh(
        frondGeometry,
        new THREE.MeshLambertMaterial({
          vertexColors: true,
          flatShading: true,
          side: THREE.DoubleSide,
        }),
      );
      fronds.name = 'PalmFronds';
      fronds.castShadow = true;
      fronds.matrixAutoUpdate = false;
      this.group.add(fronds);
    }

    if (this.world) {
      for (const box of colliders) {
        const body = new CANNON.Body({ mass: 0, material: this.terrain.groundMaterial });
        body.addShape(new CANNON.Box(new CANNON.Vec3(0.32, box.height * 0.5, 0.32)));
        body.position.set(box.x, box.y + box.height * 0.5, box.z);
        body.collisionFilterGroup = 1;
        body.userData = { surface: 'hardpack', palm: true };
        body.aabbNeedsUpdate = true;
        body.updateAABB();
        this.world.addBody(body);
      }
    }
  }

  /* ---------------- scrub ---------------- */

  /**
   * Bright faceted bushes on the sand. One InstancedMesh, two triangles' worth
   * of shading each: an icosahedron squashed flat and coloured per instance.
   */
  _buildScrub() {
    const random = this.random;
    const COUNT = 1500;
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    const material = new THREE.MeshLambertMaterial({ flatShading: true });
    const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
    mesh.name = 'DesertScrub';
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();

    let placed = 0;
    for (let attempt = 0; attempt < COUNT * 12 && placed < COUNT; attempt += 1) {
      const x = 120 + random() * 900;
      const z = -520 + random() * 880;
      if (!this._insideCanyon(x, z)) continue;
      if (this._wet(x, z)) continue;
      if (this._trailDistance(x, z) < 3.5) continue;
      // Clumped, the way scrub grows: bare sand between thickets.
      const density = Math.sin(x * 0.021) * Math.cos(z * 0.017) + Math.sin(x * 0.006 + z * 0.008);
      if (density < -0.35 && random() > 0.2) continue;

      const y = this._height(x, z);
      const size = 0.7 + random() * 1.5;
      quaternion.setFromEuler(new THREE.Euler(random() * 0.4, random() * Math.PI * 2, random() * 0.4));
      position.set(x, y + size * 0.55, z);
      scale.set(size, size * (0.6 + random() * 0.45), size);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(placed, matrix);
      color.setHex(SCRUB_COLOURS[Math.floor(random() * SCRUB_COLOURS.length)]);
      mesh.setColorAt(placed, color);
      placed += 1;
    }

    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.scrub = placed;
  }

  get stats() {
    return {
      mesas: this.mesas,
      palms: this.palms,
      scrub: this.scrub,
      stoneTriangles: this.stoneTriangles,
    };
  }
}
