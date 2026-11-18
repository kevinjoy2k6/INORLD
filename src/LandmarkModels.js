/* ============================================================================
 * LandmarkModels — modular low-poly stonework
 *
 *  The reference sets (3DGarden's castle collection and its kin) share one
 *  recipe: an eight-sided stone shaft, a corbel ring that flares out into a
 *  crenellated parapet, square merlons, a single dark doorway, a brazier and a
 *  pennant. Everything is built from a handful of primitives, flat shaded, and
 *  merged by material so a whole tower costs two or three draw calls instead
 *  of forty.
 *
 *  Every builder bakes its transform into the geometry and leaves the group at
 *  the origin, so `assemble()` can merge freely and the caller only ever sets
 *  position/rotation on the finished group.
 * ========================================================================== */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* ------------------------------------------------------------------ *
 *  helpers
 * ------------------------------------------------------------------ */

/** Small deterministic PRNG: the same seed is the same ruin on every boot. */
function rng(seed) {
  let s = (seed || 1) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function box(w, h, d, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function cyl(radiusTop, radiusBottom, height, segments, { x = 0, y = 0, z = 0, ry = 0 } = {}) {
  const g = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** A two-triangle pennant hanging off the pole at the origin. */
function pennant(width, height) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([0, 0, 0, width, -height * 0.5, 0, 0, -height, 0]),
      3,
    ),
  );
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0.5, 0, 1]), 2));
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ *
 *  materials
 * ------------------------------------------------------------------ */

export function createStoneMaterials() {
  return {
    stone: new THREE.MeshStandardMaterial({ color: 0x8f887d, roughness: 0.95, flatShading: true }),
    stoneLight: new THREE.MeshStandardMaterial({ color: 0xa9a294, roughness: 0.93, flatShading: true }),
    stoneDark: new THREE.MeshStandardMaterial({ color: 0x5e594f, roughness: 0.98, flatShading: true }),
    timber: new THREE.MeshStandardMaterial({ color: 0x6b5436, roughness: 0.95, flatShading: true }),
    iron: new THREE.MeshStandardMaterial({ color: 0x3a3936, roughness: 0.55, metalness: 0.65 }),
    flag: new THREE.MeshStandardMaterial({
      color: 0xb8402e,
      roughness: 0.85,
      side: THREE.DoubleSide,
      flatShading: true,
    }),
  };
}

/* ------------------------------------------------------------------ *
 *  assembly
 * ------------------------------------------------------------------ */

/**
 * Merge every part that shares a material into one mesh. Parts flagged
 * `separate` stay as their own mesh so a live material (the mission beacon)
 * keeps a handle on them.
 */
export function assemble(parts) {
  const buckets = new Map();
  const loose = [];
  for (const part of parts) {
    if (part.separate) {
      loose.push(part);
      continue;
    }
    const list = buckets.get(part.material);
    if (list) list.push(part.geometry);
    else buckets.set(part.material, [part.geometry]);
  }

  const group = new THREE.Group();
  for (const [material, geometries] of buckets) {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  for (const part of loose) {
    const mesh = new THREE.Mesh(part.geometry, part.material);
    mesh.castShadow = part.castShadow !== false;
    mesh.receiveShadow = true;
    // `live` parts carry a material something else animates (the beacon), so a
    // caller that bakes the group must leave them as their own mesh.
    mesh.userData.live = !!part.live;
    group.add(mesh);
  }
  return group;
}

/* ------------------------------------------------------------------ *
 *  castle tower — the watchtower POI
 * ------------------------------------------------------------------ */

export function castleTower({
  materials,
  emberMaterial = null,
  radius = 2.5,
  height = 11,
  seed = 7,
} = {}) {
  const m = materials;
  const parts = [];
  const shaftBase = 1.6;
  const shaftTop = shaftBase + height;
  const deckY = shaftTop + 0.9;
  const parapetTop = deckY + 1.15;

  // Foundation skirt: sinks into the slope so the tower never floats on a ridge.
  parts.push({
    geometry: cyl(radius * 1.04, radius * 1.42, 8, 8, { y: -3.6 }),
    material: m.stoneDark,
  });

  // Plinth + shaft.
  parts.push({ geometry: cyl(radius * 1.22, radius * 1.3, 1.6, 8, { y: 0.8 }), material: m.stoneLight });
  parts.push({
    geometry: cyl(radius * 0.92, radius * 1.06, height, 8, { y: shaftBase + height / 2 }),
    material: m.stone,
  });

  // String course, corbel ring, parapet.
  parts.push({
    geometry: cyl(radius * 0.99, radius * 0.99, 0.28, 8, { y: shaftBase + height * 0.66 }),
    material: m.stoneDark,
  });
  parts.push({ geometry: cyl(radius * 1.3, radius * 0.98, 0.9, 8, { y: shaftTop + 0.45 }), material: m.stoneDark });
  parts.push({
    geometry: cyl(radius * 1.28, radius * 1.28, 1.15, 8, { y: deckY + 0.575 }),
    material: m.stone,
  });

  // Merlons.
  const merlons = 8;
  for (let i = 0; i < merlons; i += 1) {
    const a = (i / merlons) * Math.PI * 2;
    parts.push({
      geometry: box(1.05, 1.0, 0.5, {
        x: Math.sin(a) * radius * 1.28,
        y: parapetTop + 0.5,
        z: Math.cos(a) * radius * 1.28,
        ry: a,
      }),
      material: m.stoneLight,
    });
  }

  // Door on the +Z face, arrow slits on the four quarter faces.
  parts.push({ geometry: box(1.35, 2.5, 0.8, { y: 1.25, z: radius }), material: m.stoneDark });
  parts.push({ geometry: box(0.9, 0.32, 0.5, { y: 2.62, z: radius + 0.1 }), material: m.stoneLight });
  for (const a of [0.72, 2.42, 3.86, 5.56]) {
    parts.push({
      geometry: box(0.18, 1.15, 0.24, {
        x: Math.sin(a) * radius * 1.02,
        y: shaftBase + height * 0.52,
        z: Math.cos(a) * radius * 1.02,
        ry: a,
      }),
      material: m.stoneDark,
    });
  }

  // Brazier on the deck: iron basket, embers, pole and pennant.
  parts.push({ geometry: cyl(0.78, 0.78, 0.12, 8, { y: deckY + 0.06 }), material: m.iron });
  parts.push({ geometry: cyl(0.62, 0.44, 0.6, 8, { y: deckY + 0.3 }), material: m.iron });
  if (emberMaterial) {
    const ember = new THREE.SphereGeometry(0.42, 8, 6);
    ember.translate(0, deckY + 0.66, 0);
    parts.push({ geometry: ember, material: emberMaterial, separate: true, live: true });
  }

  const poleX = radius * 0.52;
  parts.push({ geometry: cyl(0.06, 0.08, 3.8, 5, { x: poleX, y: deckY + 1.9 }), material: m.iron });
  parts.push({ geometry: cyl(0.16, 0.16, 0.14, 6, { x: poleX, y: deckY + 0.02 }), material: m.iron });
  const flag = pennant(1.7, 0.95);
  flag.translate(poleX + 0.05, deckY + 3.62, 0);
  parts.push({ geometry: flag, material: m.flag, separate: true });

  const group = assemble(parts);
  group.name = 'CastleTower';
  group.userData.seed = seed;
  return group;
}

/* ------------------------------------------------------------------ *
 *  gatehouse — the river crossing POI
 * ------------------------------------------------------------------ */

export function castleGate({ materials, clearWidth = 7.4, clearHeight = 6.0 } = {}) {
  const m = materials;
  const parts = [];
  const towerW = 2.7;
  const towerH = clearHeight + 2.6;
  const centres = [
    -(clearWidth / 2 + towerW / 2),
    clearWidth / 2 + towerW / 2,
  ];

  for (const cx of centres) {
    parts.push({ geometry: box(towerW + 0.56, 1.0, towerW + 0.56, { x: cx, y: 0.5 }), material: m.stoneLight });
    parts.push({ geometry: box(towerW, towerH, towerW, { x: cx, y: towerH / 2 + 0.4 }), material: m.stone });
    parts.push({
      geometry: box(towerW + 0.5, 0.34, towerW + 0.5, { x: cx, y: towerH + 0.4 }),
      material: m.stoneDark,
    });
    // Merlons: two on each face of the tower head.
    for (const dx of [-0.78, 0.78]) {
      for (const dz of [-0.78, 0.78]) {
        parts.push({
          geometry: box(0.92, 0.88, 0.92, { x: cx + dx, y: towerH + 1.02, z: dz }),
          material: m.stoneLight,
        });
      }
    }
    // Arrow slit facing the road.
    parts.push({
      geometry: box(0.2, 1.2, 0.26, { x: cx, y: 3.4, z: towerW / 2 }),
      material: m.stoneDark,
    });
  }

  // Lintel and the stepped arch beneath it.
  parts.push({
    geometry: box(clearWidth + towerW * 2 + 0.4, 1.0, towerW + 0.2, { y: clearHeight + 0.5 }),
    material: m.stone,
  });
  parts.push({
    geometry: box(clearWidth + towerW * 2 + 0.6, 0.34, towerW + 0.4, { y: clearHeight + 1.15 }),
    material: m.stoneDark,
  });
  for (const side of [-1, 1]) {
    parts.push({
      geometry: box(0.62, 1.9, towerW + 0.1, {
        x: side * (clearWidth / 2 - 0.66),
        y: clearHeight - 0.72,
        rz: side * -0.34,
      }),
      material: m.stoneLight,
    });
  }
  parts.push({
    geometry: box(0.9, 0.55, towerW + 0.12, { y: clearHeight - 0.16 }),
    material: m.stoneLight,
  });

  // Two timber doors standing open against the jambs.
  for (const side of [-1, 1]) {
    parts.push({
      geometry: box(0.16, 4.1, clearWidth / 2 - 0.3, {
        x: side * (clearWidth / 2 - 0.18),
        y: 2.05,
        z: -(clearWidth / 2 - 0.3) / 2 - 0.2,
      }),
      material: m.timber,
    });
  }

  const group = assemble(parts);
  group.name = 'CastleGate';
  return group;
}

/* ------------------------------------------------------------------ *
 *  ruins
 * ------------------------------------------------------------------ */

export function ruinedWall({ materials, length = 10, height = 3.4, seed = 3 } = {}) {
  const m = materials;
  const rand = rng(seed);
  const parts = [];
  // Two continuous courses carry the wall; only the top is broken. A wall made
  // of individually-heighted blocks in a single row reads as a line of graves,
  // not as masonry, because every second block leaves a gap in the silhouette.
  const base = height * 0.34;
  const middle = height * 0.24;
  parts.push({ geometry: box(length, base, 0.94, { y: base / 2 }), material: m.stoneDark });
  parts.push({
    geometry: box(length * 0.985, middle, 0.9, { y: base + middle / 2 }),
    material: m.stone,
  });

  const pieces = Math.max(4, Math.round(length / 1.15));
  const step = length / pieces;
  for (let i = 0; i < pieces; i += 1) {
    // The ragged crest: roughly half the length still stands above the courses.
    if (rand() < 0.42) continue;
    const h = height * 0.42 * (0.45 + rand() * 0.85);
    const x = -length / 2 + step * (i + 0.5);
    parts.push({
      geometry: box(step * 0.99, h, 0.86, { x, y: base + middle + h / 2, ry: (rand() - 0.5) * 0.04 }),
      material: i % 2 === 0 ? m.stoneLight : m.stone,
    });
  }

  // Buttress piers: the reason the standing stretch is still standing.
  for (const side of [-1, 1]) {
    const x = side * (length / 2 - step * 0.5);
    parts.push({
      geometry: box(0.95, height * 0.86, 1.25, { x, y: height * 0.43 }),
      material: m.stoneDark,
    });
  }

  const fallen = 3 + Math.floor(rand() * 3);
  for (let i = 0; i < fallen; i += 1) {
    parts.push({
      geometry: box(
        0.55 + rand() * 0.4,
        0.28 + rand() * 0.18,
        0.42 + rand() * 0.24,
        {
          x: -length / 2 + rand() * length,
          y: 0.16,
          z: 1.3 + rand() * 1.6,
          ry: rand() * Math.PI,
          rz: (rand() - 0.5) * 0.3,
        },
      ),
      material: m.stoneDark,
    });
  }

  const group = assemble(parts);
  group.name = 'RuinedWall';
  return group;
}

export function ruinStump({ materials, radius = 2.1, height = 3.4, seed = 9 } = {}) {
  const m = materials;
  const rand = rng(seed);
  const parts = [];
  parts.push({ geometry: cyl(radius * 1.06, radius * 1.24, 6, 8, { y: -2.4 }), material: m.stoneDark });
  parts.push({ geometry: cyl(radius, radius * 1.08, height, 8, { y: height / 2 }), material: m.stone });
  // Jagged crown: merlon remnants of uneven height.
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    const h = 0.45 + rand() * 1.1;
    parts.push({
      geometry: box(0.75, h, 0.6, {
        x: Math.sin(a) * radius * 1.02,
        y: height + h / 2,
        z: Math.cos(a) * radius * 1.02,
        ry: a,
      }),
      material: m.stoneLight,
    });
  }
  parts.push({
    geometry: box(0.7, 1.6, 0.6, { y: 0.8, z: radius * 0.96 }),
    material: m.stoneDark,
  });
  const group = assemble(parts);
  group.name = 'RuinStump';
  return group;
}

/* ------------------------------------------------------------------ *
 *  trail furniture
 * ------------------------------------------------------------------ */

/** Stacked flat stones, returned as loose geometry so many merge into one mesh. */
export function cairnGeometries(seed = 1, scale = 1) {
  const rand = rng(seed);
  const out = [];
  let y = 0;
  const count = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i += 1) {
    const r = Math.max(0.16, (0.6 - i * 0.082) * scale);
    const h = Math.max(0.1, (0.24 - i * 0.018) * scale);
    const g = new THREE.CylinderGeometry(r * 0.86, r, h, 7);
    g.translate((rand() - 0.5) * 0.1, y + h / 2, (rand() - 0.5) * 0.1);
    out.push(g);
    y += h * 0.9;
  }
  return out;
}

/**
 * Trailhead signpost. The board is a plane whose UVs are remapped into the
 * shared label atlas, so every sign in the world is one draw call.
 */
export function waymarker({ materials, boardMaterial, uv, height = 2.4 }) {
  const parts = [
    { geometry: box(0.22, height, 0.22, { y: height / 2 }), material: materials.timber },
    { geometry: box(0.72, 0.28, 0.72, { y: 0.14 }), material: materials.stoneDark },
  ];
  const group = assemble(parts);

  const board = new THREE.PlaneGeometry(2.9, 0.66);
  const attr = board.attributes.uv;
  for (let i = 0; i < attr.count; i += 1) {
    const u = attr.getX(i);
    const v = attr.getY(i);
    attr.setXY(i, uv.u0 + (uv.u1 - uv.u0) * u, uv.v0 + (uv.v1 - uv.v0) * v);
  }
  board.translate(0, height - 0.12, 0.16);
  const boardMesh = new THREE.Mesh(board, boardMaterial);
  boardMesh.castShadow = true;
  group.add(boardMesh);

  group.name = 'Waymarker';
  return group;
}
