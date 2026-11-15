/* ============================================================================
 * ProvingGround — a surveyed test track carved into the valley
 *
 *  The main map is beautiful and useless for measuring anything: every patch of
 *  ground is a different grade, every surface is mixed, and there is no run-up
 *  long enough for a repeatable 0-60. This module adds an opt-in test range
 *  (?test in the URL) in the south-east corner of the map with:
 *
 *    PAD          62 x 40 m of dead-flat hardpack — acceleration and braking
 *    WASHBOARD    short-wavelength ripples — body shake and damper work
 *    WHOOPS       long rolling bumps — full suspension travel
 *    ARTICULATION staggered single-wheel bumps — axle articulation
 *    SIDE SLOPE   20% cross-fall — body roll and lateral grip
 *    HILL CLIMB   15 degree rock climb to a plateau — traction and gearing
 *    MUD PIT      a bowl of deep mud — sinkage, drag, and mud pickup
 *    SAND         loose gravel flat — high rolling resistance
 *    OBSTACLES    logs and concrete blocks — bump stops and clearance
 *
 *  Everything is expressed in the terrain's own 2 m height grid, so the visual
 *  mesh and the physics heightfield stay in lock-step; nothing here is faked
 *  with a separate collider.
 * ========================================================================== */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const PROVING_GROUND = {
  center: { x: 104, z: -140 },
  halfWidth: 76,
  halfDepth: 54,
  edge: 14,
  datum: 9.0,
  spawn: { lx: -66, lz: 0, heading: Math.PI / 2 },
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep01 = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
const lerp = (a, b, t) => a + (b - a) * t;

/** How far inside a zone's own edges we are, 0..1, fading over `fade` metres. */
function edgeFade(value, min, max, fade) {
  const d = Math.min(value - min, max - value);
  if (d <= 0) return 0;
  return smoothstep01(d / fade);
}

/**
 * The track surface itself, in local metres from the site centre.
 * Each zone returns a height OFFSET from the datum (0 = surveyed flat).
 */
export const ZONES = [
  {
    id: 'pad',
    label: 'Accel / brake pad',
    note: 'flat hardpack, 62 x 40 m',
    biome: 'hardpack',
    x: [-72, -6],
    z: [-20, 20],
    fade: 3,
    height: () => 0,
  },
  {
    id: 'washboard',
    label: 'Washboard',
    note: '7 m ripples, 0.17 m crest',
    biome: 'trail',
    x: [2, 72],
    z: [26, 34],
    fade: 2.5,
    height: (lx) => 0.17 * (0.5 - 0.5 * Math.cos((2 * Math.PI * lx) / 7)),
  },
  {
    id: 'whoops',
    label: 'Whoops',
    note: '15 m rollers, 0.8 m crest',
    biome: 'trail',
    x: [2, 72],
    z: [6, 20],
    fade: 3,
    height: (lx) => 0.8 * (0.5 - 0.5 * Math.cos((2 * Math.PI * lx) / 15)),
  },
  {
    id: 'articulation',
    label: 'Articulation',
    note: 'staggered 0.55 m wheel ramps',
    biome: 'rock',
    x: [2, 72],
    z: [-20, -6],
    fade: 3,
    height: (lx, lz) => {
      const seg = Math.floor(lx / 9);
      const frac = lx / 9 - seg;
      const side = seg % 2 === 0 ? -1 : 1;
      if ((lz < 0 ? -1 : 1) !== side) return 0;
      return 0.55 * Math.sin(Math.PI * clamp01(frac)) ** 2;
    },
  },
  {
    id: 'sideSlope',
    label: 'Side slope 20%',
    note: 'cross-fall toward the north',
    biome: 'hardpack',
    x: [-72, -24],
    z: [-50, -24],
    fade: 4,
    height: (lx, lz) => 0.2 * (lz + 50),
  },
  {
    id: 'hill',
    label: 'Hill climb 15 deg',
    note: '6.2 m of rock to a plateau',
    biome: 'rock',
    x: [16, 72],
    z: [-52, -26],
    fade: 4,
    height: (lx, lz) => smoothstep01((lz + 52) / 26) * 6.2,
  },
  {
    id: 'mud',
    label: 'Mud pit',
    note: '0.85 m bowl of deep mud',
    biome: 'mud',
    x: [-70, -40],
    z: [28, 48],
    fade: 4,
    height: (lx, lz) => {
      const cx = (lx + 55) / 15;
      const cz = (lz - 38) / 10;
      const bowl = 1 - (cx * cx + cz * cz);
      return -0.85 * clamp01(bowl);
    },
  },
  {
    id: 'sand',
    label: 'Sand',
    note: 'loose flat, high drag',
    biome: 'sand',
    x: [-34, -6],
    z: [28, 48],
    fade: 3,
    height: () => -0.05,
  },
  {
    id: 'obstacles',
    label: 'Obstacles',
    note: 'logs and blocks',
    biome: 'hardpack',
    x: [-2, 14],
    z: [-54, -44],
    fade: 2.5,
    height: () => 0,
  },
];

const ZONE_BY_ID = Object.create(null);
for (const zone of ZONES) ZONE_BY_ID[zone.id] = zone;

export function zoneById(id) {
  return ZONE_BY_ID[id] || null;
}

/** Local coordinates of a world position. */
export function toLocal(x, z) {
  return { lx: x - PROVING_GROUND.center.x, lz: z - PROVING_GROUND.center.z };
}

export function zoneAt(x, z) {
  const { lx, lz } = toLocal(x, z);
  for (const zone of ZONES) {
    if (lx >= zone.x[0] && lx <= zone.x[1] && lz >= zone.z[0] && lz <= zone.z[1]) return zone;
  }
  return null;
}

/**
 * Height + biome for one terrain-grid vertex.
 * Returns null outside the site so the generator keeps the natural terrain.
 */
export function shapeProvingGround(x, z, naturalHeight) {
  const { center, halfWidth, halfDepth, edge, datum } = PROVING_GROUND;
  const { lx, lz } = toLocal(x, z);

  const outsideX = Math.max(0, Math.abs(lx) - halfWidth);
  const outsideZ = Math.max(0, Math.abs(lz) - halfDepth);
  const outside = Math.hypot(outsideX, outsideZ);
  if (outside > edge) return null;

  const weight = 1 - smoothstep01(outside / edge);

  let offset = 0;
  let biome = null;
  for (const zone of ZONES) {
    if (lx < zone.x[0] || lx > zone.x[1] || lz < zone.z[0] || lz > zone.z[1]) continue;
    const fade = edgeFade(lx, zone.x[0], zone.x[1], zone.fade)
      * edgeFade(lz, zone.z[0], zone.z[1], zone.fade);
    if (fade <= 0) continue;
    offset = lerp(offset, zone.height(lx, lz), fade);
    if (fade > 0.5) biome = zone.biome;
    break;
  }

  return {
    height: lerp(naturalHeight, datum + offset, weight),
    biome,
    weight,
  };
}

/** Datum chosen once, from the natural ground at the site centre. */
export function resolveDatum(baseHeight) {
  const { center } = PROVING_GROUND;
  const natural = baseHeight(center.x, center.z);
  PROVING_GROUND.datum = Math.max(6.5, Math.min(11.5, natural));
  return PROVING_GROUND.datum;
}

export function spawnPoint(terrain) {
  const { center, spawn, datum } = PROVING_GROUND;
  const x = center.x + spawn.lx;
  const z = center.z + spawn.lz;
  return {
    position: new THREE.Vector3(x, terrain.getHeightAt(x, z) + 1.4, z),
    heading: spawn.heading,
  };
}

/* ================================================================== *
 *  Survey: measure what was actually built, so tests can cite numbers
 * ================================================================== */

export function auditProvingGround(terrain) {
  const report = [];
  for (const zone of ZONES) {
    let minH = Infinity;
    let maxH = -Infinity;
    let maxSlope = 0;
    let samples = 0;
    const inset = 3;
    for (let lx = zone.x[0] + inset; lx <= zone.x[1] - inset; lx += 2) {
      for (let lz = zone.z[0] + inset; lz <= zone.z[1] - inset; lz += 2) {
        const x = PROVING_GROUND.center.x + lx;
        const z = PROVING_GROUND.center.z + lz;
        const h = terrain.getHeightAt(x, z);
        minH = Math.min(minH, h);
        maxH = Math.max(maxH, h);
        const dx = terrain.getHeightAt(x + 1, z) - terrain.getHeightAt(x - 1, z);
        const dz = terrain.getHeightAt(x, z + 1) - terrain.getHeightAt(x, z - 1);
        maxSlope = Math.max(maxSlope, Math.hypot(dx, dz) / 2);
        samples += 1;
      }
    }
    report.push({
      id: zone.id,
      label: zone.label,
      samples,
      relief: +(maxH - minH).toFixed(3),
      maxGrade: +maxSlope.toFixed(3),
      surface: terrain.getSurfaceAt(
        PROVING_GROUND.center.x + (zone.x[0] + zone.x[1]) / 2,
        PROVING_GROUND.center.z + (zone.z[0] + zone.z[1]) / 2,
      ).key,
    });
  }
  return report;
}

/* ================================================================== *
 *  Props: signage, start/finish line, logs and blocks
 * ================================================================== */

function makeLabelTexture(text, sub) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(18,20,24,0.86)';
  ctx.fillRect(0, 0, 512, 160);
  ctx.strokeStyle = 'rgba(232,184,90,0.95)';
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, 500, 148);
  ctx.fillStyle = '#f2e7cf';
  ctx.font = 'bold 52px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, 256, 74);
  if (sub) {
    ctx.fillStyle = '#b9c3cc';
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillText(sub, 256, 120);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function buildZoneSign(zone, terrain) {
  const group = new THREE.Group();
  const postMaterial = new THREE.MeshStandardMaterial({ color: 0x3d4147, roughness: 0.7, metalness: 0.4 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.6, 8), postMaterial);
  post.position.y = 1.3;
  group.add(post);

  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 0.82),
    new THREE.MeshBasicMaterial({
      map: makeLabelTexture(zone.label, zone.note),
      transparent: true,
      side: THREE.DoubleSide,
    }),
  );
  board.position.y = 2.35;
  group.add(board);

  // Stand it off the far corner of the zone, turned back down the approach so
  // the driver reads it before entering rather than through the windscreen.
  const x = PROVING_GROUND.center.x + zone.x[1] + 3.2;
  const z = PROVING_GROUND.center.z + zone.z[1] + 3.2;
  group.position.set(x, terrain.getHeightAt(x, z), z);
  group.rotation.y = -Math.PI / 2;
  return group;
}

function addStaticBox(world, material, { x, y, z, hx, hy, hz, yaw = 0 }) {
  const body = new CANNON.Body({ mass: 0, material });
  body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
  body.position.set(x, y, z);
  body.quaternion.setFromEuler(0, yaw, 0);
  body.collisionFilterGroup = 1;
  body.userData = { surface: 'rock', obstacle: true };
  body.aabbNeedsUpdate = true;
  body.updateAABB();
  world.addBody(body);
  return body;
}

/**
 * Visual + physical props for the range. The logs and blocks are static on
 * purpose: repeatable obstacle tests beat knockable ones.
 */
export function createProvingProps({ scene, world, terrain, groundMaterial }) {
  const root = new THREE.Group();
  root.name = 'ProvingGround';
  scene.add(root);

  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.92 });
  const bark = new THREE.MeshStandardMaterial({ color: 0x4a3520, roughness: 0.96 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.85 });
  const paint = new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.6 });

  for (const zone of ZONES) {
    root.add(buildZoneSign(zone, terrain));
  }

  const { center } = PROVING_GROUND;
  const ground = (lx, lz) => terrain.getHeightAt(center.x + lx, center.z + lz);

  /* ---- start / finish line across the pad ---- */
  const lineZ = 0;
  for (let i = -19; i <= 19; i += 2) {
    const tile = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 0.9), paint);
    tile.position.set(center.x - 60, ground(-60, lineZ + i) + 0.03, center.z + lineZ + i);
    tile.receiveShadow = true;
    root.add(tile);
  }

  /* ---- distance boards every 20 m along the pad lane ---- */
  for (const marker of [20, 40, 60, 80, 100]) {
    const lx = -66 + marker;
    const x = center.x + lx;
    const z = center.z + lineZ - 8;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6), concrete);
    post.position.set(x, ground(lx, lineZ - 8) + 0.55, z);
    root.add(post);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.34), new THREE.MeshBasicMaterial({
      map: makeLabelTexture(`${marker} m`, ''),
      transparent: true,
      side: THREE.DoubleSide,
    }));
    flag.position.set(x, ground(lx, lineZ - 8) + 1.25, z);
    flag.rotation.y = -Math.PI / 2;
    root.add(flag);
  }

  /* ---- obstacle lane: three logs and two concrete blocks ---- */
  const logSpecs = [
    { lx: -1, lz: -47, radius: 0.24, length: 15 },
    { lx: 4, lz: -49, radius: 0.32, length: 15 },
    { lx: 9, lz: -51, radius: 0.4, length: 15 },
  ];
  for (const spec of logSpecs) {
    const x = center.x + spec.lx;
    const z = center.z + spec.lz;
    const y = ground(spec.lx, spec.lz) + spec.radius;
    const log = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.radius, spec.radius * 1.06, spec.length, 12),
      wood,
    );
    log.rotation.z = Math.PI / 2;
    log.position.set(x, y, z);
    log.castShadow = true;
    log.receiveShadow = true;
    root.add(log);

    for (const end of [-1, 1]) {
      const cap = new THREE.Mesh(
        new THREE.CircleGeometry(spec.radius * 1.02, 12),
        bark,
      );
      cap.position.set(x + (spec.length / 2) * end, y, z);
      cap.rotation.y = (Math.PI / 2) * end;
      root.add(cap);
    }

    addStaticBox(world, groundMaterial, {
      x, y, z,
      hx: spec.length / 2,
      hy: spec.radius,
      hz: spec.radius,
    });
  }

  const blockSpecs = [
    { lx: 12, lz: -46, w: 1.8, h: 0.55, d: 1.4 },
    { lx: -4, lz: -52, w: 1.4, h: 0.95, d: 1.2 },
  ];
  for (const spec of blockSpecs) {
    const x = center.x + spec.lx;
    const z = center.z + spec.lz;
    const y = ground(spec.lx, spec.lz) + spec.h / 2;
    const block = new THREE.Mesh(new THREE.BoxGeometry(spec.w, spec.h, spec.d), concrete);
    block.position.set(x, y, z);
    block.castShadow = true;
    block.receiveShadow = true;
    root.add(block);
    addStaticBox(world, groundMaterial, {
      x, y, z,
      hx: spec.w / 2,
      hy: spec.h / 2,
      hz: spec.d / 2,
    });
  }

  /* ---- a berm of stones at the far end of the pad, to stop runaways ---- */
  const stone = new THREE.MeshStandardMaterial({ color: 0x6a6259, roughness: 0.95, flatShading: true });
  const stoneGeometry = new THREE.IcosahedronGeometry(1, 0);
  for (let i = 0; i < 14; i += 1) {
    const lx = -4 + (i % 2) * 1.2;
    const lz = -18 + i * 2.6;
    const radius = 0.55 + (i % 3) * 0.18;
    const rock = new THREE.Mesh(stoneGeometry, stone);
    const x = center.x + lx;
    const z = center.z + lz;
    rock.position.set(x, ground(lx, lz) + radius * 0.55, z);
    rock.scale.set(radius, radius * 0.75, radius);
    rock.rotation.set(i * 0.7, i * 1.3, i * 0.4);
    rock.castShadow = true;
    root.add(rock);
    addStaticBox(world, groundMaterial, {
      x, y: ground(lx, lz) + radius * 0.5, z,
      hx: radius * 0.8, hy: radius * 0.5, hz: radius * 0.8,
    });
  }

  return root;
}

/* ================================================================== *
 *  Measurement harness
 * ================================================================== */

/**
 * Records a run while the player drives, so numbers come from the real
 * physics rather than from a separate model. Samples at 20 Hz:
 * speed, distance, articulation, wheels off the ground, body roll/pitch,
 * sinkage and slip. Everything is plain numbers so it can be logged or
 * copied out of the console.
 */
export function createProvingBench({ vehicle, terrain }) {
  const state = {
    active: false,
    label: null,
    clock: 0,
    distance: 0,
    samples: [],
    last: null,
    best: {
      topSpeed: 0,
      articulation: 0,
      bodyRoll: 0,
      bodyPitch: 0,
      sinkage: 0,
    },
  };

  const _p = new THREE.Vector3();
  const _up = new THREE.Vector3();
  let previous = null;
  let accumulator = 0;
  let peakSpeed = 0;
  let peakArticulation = 0;
  let peakRoll = 0;
  let peakPitch = 0;
  let peakSink = 0;
  let airborne = 0;

  function sampleRate() {
    return 0.05;
  }

  function resetRunStats() {
    peakSpeed = 0;
    peakArticulation = 0;
    peakRoll = 0;
    peakPitch = 0;
    peakSink = 0;
    airborne = 0;
  }

  function articulation() {
    const s = vehicle.suspLen;
    if (!s) return 0;
    return Math.max(
      Math.abs(s[0] - s[1]),
      Math.abs(s[2] - s[3]),
      Math.abs((s[0] + s[1]) * 0.5 - (s[2] + s[3]) * 0.5),
    );
  }

  function capture() {
    const telemetry = vehicle.getTelemetry();
    const body = vehicle.body;
    _p.copy(body.position);
    if (previous) state.distance += _p.distanceTo(previous);
    previous = previous ? previous.copy(_p) : _p.clone();

    const art = articulation();
    _up.set(0, 1, 0).applyQuaternion(body.quaternion);
    const roll = Math.abs(Math.atan2(_up.x, Math.max(0.05, _up.y)));
    const pitch = Math.abs(Math.atan2(-_up.z, Math.max(0.05, _up.y)));
    const sink = telemetry.sinkCm || 0;
    const speed = telemetry.speedKmh || 0;

    peakSpeed = Math.max(peakSpeed, speed);
    peakArticulation = Math.max(peakArticulation, art);
    peakRoll = Math.max(peakRoll, roll);
    peakPitch = Math.max(peakPitch, pitch);
    peakSink = Math.max(peakSink, sink);
    if ((telemetry.grounded ?? 4) < 4) airborne += 1;

    state.samples.push({
      t: +state.clock.toFixed(2),
      v: +speed.toFixed(2),
      d: +state.distance.toFixed(2),
      art: +art.toFixed(3),
      roll: +roll.toFixed(3),
      pitch: +pitch.toFixed(3),
      sink: +sink.toFixed(1),
      g: telemetry.grounded ?? 4,
      surf: telemetry.surface,
    });
  }

  function summarise() {
    const samples = state.samples;
    if (!samples.length) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    let maxDecel = 0;
    for (let i = 1; i < samples.length; i += 1) {
      const dt = samples[i].t - samples[i - 1].t;
      if (dt <= 0) continue;
      const decel = (samples[i - 1].v - samples[i].v) / 3.6 / dt;
      if (decel > maxDecel) maxDecel = decel;
    }
    const zone = zoneAt(lastPos().x, lastPos().z);
    return {
      label: state.label,
      zone: zone ? zone.id : null,
      seconds: +(last.t - first.t).toFixed(2),
      distance: +(last.d - first.d).toFixed(2),
      topSpeed: +peakSpeed.toFixed(2),
      endSpeed: +last.v.toFixed(2),
      articulation: +peakArticulation.toFixed(3),
      bodyRoll: +peakRoll.toFixed(3),
      bodyPitch: +peakPitch.toFixed(3),
      sinkageCm: +peakSink.toFixed(1),
      airborneSamples: airborne,
      maxDecel: +maxDecel.toFixed(2),
      samples: samples.length,
    };
  }

  function lastPos() {
    return vehicle.body.position;
  }

  return {
    get state() {
      return state;
    },
    get best() {
      return state.best;
    },
    get currentZone() {
      const p = lastPos();
      const zone = zoneAt(p.x, p.z);
      return zone ? zone.label : 'off-piste';
    },
    /** Begin recording. Pass a label like 'accel' or 'brake'. */
    record(label = 'run') {
      state.active = true;
      state.label = label;
      state.clock = 0;
      state.distance = 0;
      state.samples.length = 0;
      previous = null;
      accumulator = 0;
      resetRunStats();
      return { started: label };
    },
    /** Finish recording and return the summary (also stored as `last`). */
    stop() {
      state.active = false;
      const summary = summarise();
      if (summary) {
        state.last = summary;
        state.best.topSpeed = Math.max(state.best.topSpeed, summary.topSpeed);
        state.best.articulation = Math.max(state.best.articulation, summary.articulation);
        state.best.bodyRoll = Math.max(state.best.bodyRoll, summary.bodyRoll);
        state.best.bodyPitch = Math.max(state.best.bodyPitch, summary.bodyPitch);
        state.best.sinkage = Math.max(state.best.sinkage, summary.sinkageCm);
      }
      return summary;
    },
    /** Teleport to a zone (local id) and face along +x. */
    place(zoneId, { lx, lz, heading = Math.PI / 2 } = {}) {
      const zone = zoneById(zoneId);
      const { center } = PROVING_GROUND;
      const px = center.x + (lx !== undefined ? lx : zone ? (zone.x[0] + zone.x[1]) / 2 : 0);
      const pz = center.z + (lz !== undefined ? lz : zone ? (zone.z[0] + zone.z[1]) / 2 : 0);
      const y = terrain.getHeightAt(px, pz) + 1.2;
      vehicle.body.position.set(px, y, pz);
      vehicle.body.velocity.set(0, 0, 0);
      vehicle.body.angularVelocity.set(0, 0, 0);
      vehicle.body.quaternion.setFromEuler(0, heading, 0);
      vehicle.syncVisuals(1, 0);
      previous = null;
      return { x: px, z: pz, heading };
    },
    update(dt) {
      // Live bests are handy even when no run is being recorded.
      const art = articulation();
      state.best.articulation = Math.max(state.best.articulation, art);
      if (!state.active) return;
      state.clock += dt;
      accumulator += dt;
      const step = sampleRate();
      while (accumulator >= step) {
        accumulator -= step;
        capture();
      }
    },
  };
}

/* ================================================================== *
 *  On-screen readout: zone, speed, and the peaks the bench is holding
 * ================================================================== */

export function createProvingHud({ bench, vehicle }) {
  const panel = document.createElement('div');
  panel.className = 'pg-hud';
  panel.innerHTML = `
    <div class="pg-hud-title">PROVING GROUND</div>
    <div class="pg-hud-row"><span>Zone</span><b data-pg="zone">—</b></div>
    <div class="pg-hud-row"><span>Speed</span><b data-pg="speed">0 km/h</b></div>
    <div class="pg-hud-row"><span>Artic</span><b data-pg="artic">0.00 m</b></div>
    <div class="pg-hud-row"><span>Roll</span><b data-pg="roll">0.0°</b></div>
    <div class="pg-hud-row"><span>Run</span><b data-pg="run">idle</b></div>
  `;
  document.body.appendChild(panel);

  const fields = {
    zone: panel.querySelector('[data-pg="zone"]'),
    speed: panel.querySelector('[data-pg="speed"]'),
    artic: panel.querySelector('[data-pg="artic"]'),
    roll: panel.querySelector('[data-pg="roll"]'),
    run: panel.querySelector('[data-pg="run"]'),
  };

  let timer = 0;
  return {
    panel,
    update(dt) {
      timer += dt;
      if (timer < 0.15) return;
      timer = 0;
      const telemetry = vehicle.getTelemetry();
      fields.zone.textContent = bench.currentZone;
      fields.speed.textContent = `${telemetry.speedKmh.toFixed(0)} km/h`;
      fields.artic.textContent = `${bench.best.articulation.toFixed(2)} m`;
      fields.roll.textContent = `${(bench.best.bodyRoll * 57.2958).toFixed(1)}°`;
      const state = bench.state;
      fields.run.textContent = state.active
        ? `${state.label} ${state.clock.toFixed(1)}s`
        : state.last
          ? `${state.last.label}: ${state.last.distance.toFixed(0)} m`
          : 'idle';
    },
  };
}
