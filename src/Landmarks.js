/* ============================================================================
 * Landmarks — the human layer of the map
 *
 *  Utility poles marching along every road, dashed centre lines, junction
 *  signs, gas stations you can actually refuel at, and the pylons that make a
 *  stretch of valley legible from a distance. Everything here is instanced or
 *  merged where it repeats, because there are several hundred poles.
 * ========================================================================== */

import * as THREE from 'three';
import { ROADS, SIGNS, GAS_STATIONS, regionAt } from './WorldAtlas.js';

/* ------------------------------------------------------------------ *
 *  small helpers
 * ------------------------------------------------------------------ */

function canvasLabel(text, sub, { width = 512, height = 160, accent = '#e8b85a' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(20,23,28,0.92)';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, width - 12, height - 12);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f4ecdc';
  ctx.font = `bold ${Math.round(height * 0.36)}px system-ui, sans-serif`;
  ctx.fillText(text, width / 2, height * 0.52);
  if (sub) {
    ctx.fillStyle = '#c3ccd6';
    ctx.font = `${Math.round(height * 0.18)}px system-ui, sans-serif`;
    ctx.fillText(sub, width / 2, height * 0.8);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

/** Walk a polyline at a fixed spacing, yielding position + tangent. */
function walkPath(points, spacing, visit) {
  const total = polylineLength(points);
  let travelled = 0;
  let target = 0;
  for (let i = 1; i < points.length; i += 1) {
    const [x0, z0] = points[i - 1];
    const [x1, z1] = points[i];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const segLength = Math.hypot(dx, dz);
    if (segLength < 1e-4) continue;
    const dirX = dx / segLength;
    const dirZ = dz / segLength;

    while (target <= travelled + segLength) {
      const t = (target - travelled) / segLength;
      visit({
        x: x0 + dx * t,
        z: z0 + dz * t,
        dirX,
        dirZ,
        distance: target,
      });
      target += spacing;
    }
    travelled += segLength;
  }
  return total;
}

/* ------------------------------------------------------------------ *
 *  Landmarks
 * ------------------------------------------------------------------ */

export class Landmarks {
  constructor({ scene, terrain, groundMaterial }) {
    this.scene = scene;
    this.terrain = terrain;
    this.groundMaterial = groundMaterial;
    this.group = new THREE.Group();
    this.group.name = 'Landmarks';
    this.scene.add(this.group);

    this.stations = [];
    this.stats = { poles: 0, dashes: 0, stations: 0, signs: 0 };
    this.fuelRate = 14; // litres per second while parked on an apron
    this.status = null;

    this._materials = this._makeMaterials();
    this._buildRoadFurniture();
    this._buildStations();
    this._buildSigns();
    this._buildNotice();
  }

  _makeMaterials() {
    return {
      pole: new THREE.MeshStandardMaterial({ color: 0x8d7f6a, roughness: 0.92 }),
      poleDark: new THREE.MeshStandardMaterial({ color: 0x5d5347, roughness: 0.95 }),
      wire: new THREE.LineBasicMaterial({ color: 0x2f3338, transparent: true, opacity: 0.7 }),
      paint: new THREE.MeshStandardMaterial({ color: 0xe9e3d1, roughness: 0.75 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0xa9a49b, roughness: 0.9 }),
      canopy: new THREE.MeshStandardMaterial({ color: 0xd8d3c6, roughness: 0.6, metalness: 0.15 }),
      canopyEdge: new THREE.MeshStandardMaterial({ color: 0xb8402e, roughness: 0.55 }),
      pump: new THREE.MeshStandardMaterial({ color: 0xc9ccc9, roughness: 0.5, metalness: 0.35 }),
      glass: new THREE.MeshStandardMaterial({
        color: 0x2a3d4a,
        roughness: 0.15,
        metalness: 0.4,
        transparent: true,
        opacity: 0.62,
      }),
      lamp: new THREE.MeshBasicMaterial({ color: 0xfff1c6 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x6b5436, roughness: 0.95 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x717a80, roughness: 0.5, metalness: 0.8 }),
    };
  }

  /* ---------------- poles, wires, markings ---------------- */

  _buildRoadFurniture() {
    const m = this._materials;
    const terrain = this.terrain;

    const polePositions = [];
    const poleYaw = [];
    const dashPositions = [];
    const dashYaw = [];
    const wirePairs = [];

    for (const road of ROADS) {
      const isRoad = road.kind === 'road';
      const offset = road.width + 4.2;

      walkPath(road.points, isRoad ? 26 : 34, (p) => {
        // Poles stand on the outside of the bend, alternating sides.
        const side = polePositions.length % 2 === 0 ? 1 : -1;
        const px = p.x + p.dirZ * offset * side;
        const pz = p.z - p.dirX * offset * side;
        const index = terrain._indexAt(px, pz);
        if (terrain.waterGrid[index] > 0) return;
        const ground = terrain.getHeightAt(px, pz);
        polePositions.push({ x: px, y: ground, z: pz, side });
        poleYaw.push(Math.atan2(p.dirX, p.dirZ));
      });

      // Dashes down the middle of the carriageway.
      if (isRoad) {
        walkPath(road.points, 7, (p) => {
          const ground = terrain.getHeightAt(p.x, p.z);
          if (terrain.waterGrid[terrain._indexAt(p.x, p.z)] > 0) return;
          dashPositions.push({ x: p.x, y: ground + 0.045, z: p.z });
          dashYaw.push(Math.atan2(p.dirX, p.dirZ));
        });
      }
    }

    /* ---- pole trunks + crossarms as instances ---- */
    const P = polePositions.length;
    if (P > 0) {
      const trunkGeo = new THREE.CylinderGeometry(0.14, 0.2, 7.4, 6);
      trunkGeo.translate(0, 3.7, 0);
      const trunks = new THREE.InstancedMesh(trunkGeo, m.pole, P);
      trunks.castShadow = true;
      trunks.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      const armGeo = new THREE.BoxGeometry(2.1, 0.12, 0.12);
      const arms = new THREE.InstancedMesh(armGeo, m.poleDark, P * 2);
      arms.castShadow = true;
      arms.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      const matrix = new THREE.Matrix4();
      const quat = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scale = new THREE.Vector3(1, 1, 1);
      const euler = new THREE.Euler();

      for (let i = 0; i < P; i += 1) {
        const p = polePositions[i];
        const yaw = poleYaw[i];
        euler.set(0, yaw, 0);
        quat.setFromEuler(euler);
        pos.set(p.x, p.y, p.z);
        matrix.compose(pos, quat, scale);
        trunks.setMatrixAt(i, matrix);

        for (let arm = 0; arm < 2; arm += 1) {
          pos.set(p.x, p.y + 6.5 - arm * 0.85, p.z);
          matrix.compose(pos, quat, scale);
          arms.setMatrixAt(i * 2 + arm, matrix);
        }
      }
      trunks.count = P;
      arms.count = P * 2;
      this.group.add(trunks, arms);
      this.stats.poles = P;

      /* ---- catenary wires between consecutive poles on the same road ---- */
      const vertices = [];
      for (let i = 1; i < P; i += 1) {
        const a = polePositions[i - 1];
        const b = polePositions[i];
        const span = Math.hypot(b.x - a.x, b.z - a.z);
        if (span > 42) continue; // poles on different roads: no wire
        const sag = Math.min(1.1, span * 0.035);
        const steps = 5;
        for (let s = 0; s < steps; s += 1) {
          const t0 = s / steps;
          const t1 = (s + 1) / steps;
          for (const level of [6.5, 5.65]) {
            const y0 = a.y + level + Math.sin(Math.PI * t0) * -sag;
            const y1 = a.y + level + Math.sin(Math.PI * t1) * -sag;
            vertices.push(
              a.x + (b.x - a.x) * t0, y0, a.z + (b.z - a.z) * t0,
              a.x + (b.x - a.x) * t1, y1, a.z + (b.z - a.z) * t1,
            );
          }
        }
        wirePairs.push([a, b]);
      }
      if (vertices.length) {
        const wireGeo = new THREE.BufferGeometry();
        wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        this.group.add(new THREE.LineSegments(wireGeo, m.wire));
      }
    }

    /* ---- centre-line dashes ---- */
    const D = dashPositions.length;
    if (D > 0) {
      const dashGeo = new THREE.BoxGeometry(3.2, 0.04, 0.18);
      const dashes = new THREE.InstancedMesh(dashGeo, m.paint, D);
      dashes.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const matrix = new THREE.Matrix4();
      const quat = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      const scale = new THREE.Vector3(1, 1, 1);
      const euler = new THREE.Euler();
      for (let i = 0; i < D; i += 1) {
        const d = dashPositions[i];
        euler.set(0, dashYaw[i], 0);
        quat.setFromEuler(euler);
        pos.set(d.x, d.y, d.z);
        matrix.compose(pos, quat, scale);
        dashes.setMatrixAt(i, matrix);
      }
      dashes.count = D;
      dashes.receiveShadow = true;
      this.group.add(dashes);
      this.stats.dashes = D;
    }
  }

  /* ---------------- gas stations ---------------- */

  _buildStations() {
    for (const def of GAS_STATIONS) {
      const station = this._buildStation(def);
      this.stations.push(station);
    }
    this.stats.stations = this.stations.length;
  }

  _buildStation(def) {
    const m = this._materials;
    const terrain = this.terrain;
    const group = new THREE.Group();
    group.name = `Station_${def.id}`;

    const ground = terrain.getHeightAt(def.x, def.z);
    group.position.set(def.x, ground, def.z);
    group.rotation.y = def.heading || 0;
    this.group.add(group);

    /* ---- concrete apron ---- */
    const apron = new THREE.Mesh(new THREE.BoxGeometry(22, 0.16, 16), m.concrete);
    apron.position.y = 0.05;
    apron.receiveShadow = true;
    group.add(apron);

    /* ---- canopy: four columns and a slab ---- */
    for (const cx of [-5.4, 5.4]) {
      for (const cz of [-3.4, 3.4]) {
        const column = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 5.0, 8), m.steel);
        column.position.set(cx, 2.5, cz);
        column.castShadow = true;
        group.add(column);
      }
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(13.4, 0.35, 9.4), m.canopy);
    roof.position.set(0, 5.1, 0);
    roof.castShadow = true;
    group.add(roof);
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(13.6, 0.5, 9.6), m.canopyEdge);
    fascia.position.set(0, 4.78, 0);
    group.add(fascia);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(12.6, 8.6), m.lamp);
    glow.rotation.x = Math.PI / 2;
    glow.position.set(0, 4.6, 0);
    group.add(glow);

    /* ---- two pumps on islands ---- */
    for (const px of [-2.6, 2.6]) {
      const island = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.22, 3.4), m.concrete);
      island.position.set(px, 0.16, 0);
      group.add(island);

      const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.7, 0.6), m.pump);
      body.position.set(px, 1.05, 0);
      body.castShadow = true;
      group.add(body);

      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.3), m.glass);
      screen.position.set(px, 1.44, 0.31);
      group.add(screen);

      const light = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.16), m.lamp);
      light.position.set(px, 1.78, 0.31);
      group.add(light);
    }

    /* ---- kiosk with a lit window ---- */
    const kiosk = new THREE.Mesh(new THREE.BoxGeometry(5.2, 2.9, 3.6), m.canopy);
    kiosk.position.set(-8.6, 1.45, -4.4);
    kiosk.castShadow = true;
    group.add(kiosk);
    const windowMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.3), m.glass);
    windowMesh.position.set(-8.6, 1.8, -2.58);
    group.add(windowMesh);

    /* ---- pylon sign ---- */
    const pylonPole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 6.2, 8), m.steel);
    pylonPole.position.set(8.4, 3.1, 5.6);
    group.add(pylonPole);
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(4.4, 1.6),
      new THREE.MeshBasicMaterial({
        map: canvasLabel(def.name.toUpperCase(), 'FUEL · 24H', { accent: '#b8402e' }),
        side: THREE.DoubleSide,
        transparent: true,
      }),
    );
    board.position.set(8.4, 6.6, 5.6);
    board.rotation.y = Math.PI / 4;
    group.add(board);

    /* ---- a warm bulb so the place reads at dusk ---- */
    const bulb = new THREE.PointLight(0xffd9a0, 0.0, 26, 2);
    bulb.position.set(0, 4.4, 0);
    group.add(bulb);

    return {
      ...def,
      group,
      bulb,
      radius: 11,
      centre: new THREE.Vector3(def.x, ground, def.z),
      refuelling: false,
    };
  }

  /* ---------------- junction signs ---------------- */

  _buildSigns() {
    const m = this._materials;
    for (const sign of SIGNS) {
      const ground = this.terrain.getHeightAt(sign.x, sign.z);
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.3, 6), m.poleDark);
      post.position.set(sign.x, ground + 1.15, sign.z);
      this.group.add(post);

      const board = new THREE.Mesh(
        new THREE.PlaneGeometry(3.2, 0.95),
        new THREE.MeshBasicMaterial({
          map: canvasLabel(sign.text, 'OVER THE HILL', { height: 150 }),
          side: THREE.DoubleSide,
          transparent: true,
        }),
      );
      board.position.set(sign.x, ground + 2.55, sign.z);
      this.group.add(board);
      this.stats.signs += 1;
    }
  }

  /* ---------------- refuel notice ---------------- */

  _buildNotice() {
    const el = document.createElement('div');
    el.className = 'pg-hud';
    el.style.top = 'auto';
    el.style.bottom = '210px';
    el.style.right = '22px';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="pg-hud-title">FUEL</div>
      <div class="pg-hud-row"><span>Station</span><b data-lm="name">—</b></div>
      <div class="pg-hud-row"><span>Tank</span><b data-lm="tank">—</b></div>
    `;
    document.body.appendChild(el);
    this.notice = {
      el,
      name: el.querySelector('[data-lm="name"]'),
      tank: el.querySelector('[data-lm="tank"]'),
      timer: 0,
    };
  }

  /**
   * Called once per frame. Refuels any vehicle parked on an apron, keeps the
   * canopy lights on at dusk and the notice panel in sync.
   */
  update(dt, vehicle, night = false) {
    const p = vehicle.body.position;
    let near = null;
    for (const station of this.stations) {
      const distance = Math.hypot(p.x - station.centre.x, p.z - station.centre.z);
      const inside = distance < station.radius;
      station.bulb.intensity = night ? 1.6 : inside ? 0.9 : 0.0;
      if (inside && (!near || distance < near.distance)) near = { station, distance };
    }

    const speed = vehicle.speed ? Math.abs(vehicle.speed) : 0;
    const capacity = vehicle.fuelCapacity || 90;
    let refuelling = false;

    if (near && speed < 2.5 && vehicle.fuel < capacity - 0.01) {
      vehicle.fuel = Math.min(capacity, vehicle.fuel + this.fuelRate * dt);
      refuelling = true;
    }

    for (const station of this.stations) station.refuelling = refuelling && station === near?.station;

    if (near) {
      this.notice.el.style.display = 'block';
      this.notice.name.textContent = near.station.name;
      const litres = vehicle.fuel ?? 0;
      this.notice.tank.textContent = refuelling
        ? `filling ${litres.toFixed(0)}/${capacity} L`
        : `${litres.toFixed(0)}/${capacity} L`;
    } else {
      this.notice.el.style.display = 'none';
    }

    this.status = near ? { station: near.station.name, refuelling } : null;
    return this.status;
  }

  /** Nearest station to a world position, for HUD hints and tests. */
  nearestStation(x, z) {
    let best = null;
    for (const station of this.stations) {
      const distance = Math.hypot(x - station.centre.x, z - station.centre.z);
      if (!best || distance < best.distance) best = { station, distance };
    }
    return best;
  }

  regionLabel(x, z) {
    const region = regionAt(x, z);
    return region ? region.label : 'The Valley';
  }
}
