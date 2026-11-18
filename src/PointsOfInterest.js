/* ============================================================================
 * PointsOfInterest — stone landmarks and the furniture that marks a trail
 *
 *  The mission layer owns three abstract circles in the world: watchtowers,
 *  a lumber mill and a broken bridge. This module gives them a silhouette you
 *  can navigate by — an eight-sided castle keep with a brazier on top, a
 *  gatehouse ruin at the river approach — and hangs the trails with cairns and
 *  named signposts so a track reads as a track from the driver's seat.
 *
 *  Everything is merged by material: six keeps, a gatehouse, three ruin fields
 *  and ~100 cairns cost well under twenty draw calls.
 * ========================================================================== */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROADS, regionAt } from './WorldAtlas.js';
import {
  createStoneMaterials,
  castleTower,
  castleGate,
  ruinedWall,
  ruinStump,
  cairnGeometries,
  waymarker,
  assemble,
} from './LandmarkModels.js';

const MARKER_SPACING = 62; // metres between cairns along a trail
const MARKER_OFFSET = 1.7; // metres past the graded shoulder

/** Ruin fields: the valley was settled long before the expedition arrived. */
const RUIN_SITES = [
  { x: -470, z: 96, yaw: 0.6, seed: 21 },
  { x: 560, z: 244, yaw: -1.15, seed: 34 },
  { x: -330, z: -742, yaw: 2.2, seed: 47 },
];

export class PointsOfInterest {
  constructor({ scene, terrain, missionManager = null }) {
    this.scene = scene;
    this.terrain = terrain;
    this.missionManager = missionManager;

    this.group = new THREE.Group();
    this.group.name = 'PointsOfInterest';
    this.scene.add(this.group);

    this.materials = createStoneMaterials();
    this._flagMaterials = new Map();
    this.stats = { towers: 0, gates: 0, walls: 0, cairns: 0, signs: 0, ruins: 0 };
    this._buckets = new Map();
    this._live = [];
    // Where the trail furniture ended up, for HUD hints and for tests.
    this.signs = [];
    this.markers = [];

    this._buildWatchtowers();
    this._buildRiverGate();
    this._buildTrails();
    this._buildRuins();
    this._flush();
  }

  /* ---------------- placement helpers ---------------- */

  /** True when a world position is dry, solid ground well above the shoreline. */
  _dry(x, z) {
    const terrain = this.terrain;
    if (typeof terrain._indexAt === 'function' && terrain.waterGrid) {
      const index = terrain._indexAt(x, z);
      if (index >= 0 && terrain.waterGrid[index] > 0) return false;
    }
    const y = terrain.getHeightAt(x, z);
    return Number.isFinite(y) && y > 1.4;
  }

  /**
   * Fold a finished landmark into the layer's merged meshes. Static stonework
   * has no reason to be its own draw call: six keeps, a gatehouse, three ruin
   * fields and five signposts come out as about a dozen meshes in total.
   * Meshes flagged `live` (the beacon embers) keep their own mesh so the
   * mission can still pulse their material.
   */
  _bake(group) {
    group.updateMatrixWorld(true);
    group.traverse((child) => {
      if (!child.isMesh) return;
      const geometry = child.geometry.clone();
      geometry.applyMatrix4(child.matrixWorld);
      if (child.userData.live) {
        this._live.push({ geometry, material: child.material });
        return;
      }
      const bucket = this._buckets.get(child.material);
      if (bucket) bucket.push(geometry);
      else this._buckets.set(child.material, [geometry]);
    });
  }

  /** One mesh per material for the whole layer, once every landmark is placed. */
  _flush() {
    for (const [material, geometries] of this._buckets) {
      const merged = geometries.length === 1
        ? geometries[0]
        : mergeGeometries(geometries, false) || geometries[0];
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `POI_${material.name || material.uuid.slice(0, 6)}`;
      this.group.add(mesh);
    }
    for (const item of this._live) {
      const mesh = new THREE.Mesh(item.geometry, item.material);
      mesh.name = 'BeaconEmber';
      this.group.add(mesh);
    }
    this._buckets.clear();
    this._live.length = 0;
  }

  _flagMaterial(hex) {
    if (!this._flagMaterials.has(hex)) {
      const material = new THREE.MeshStandardMaterial({
        color: hex,
        roughness: 0.85,
        side: THREE.DoubleSide,
        flatShading: true,
      });
      this._flagMaterials.set(hex, material);
    }
    return this._flagMaterials.get(hex);
  }

  /* ---------------- watchtowers ---------------- */

  _buildWatchtowers() {
    const towers = this.missionManager?.watchtowers || [];
    towers.forEach((tw, index) => {
      const region = regionAt(tw.pos.x, tw.pos.z);
      const materials = {
        ...this.materials,
        // Each keep flies its region's accent colour, so a tower is legible as
        // "the canyon one" from a ridge away.
        flag: this._flagMaterial(region.palette.accent),
      };
      const keep = castleTower({
        materials,
        emberMaterial: tw.beaconMat || null,
        radius: 2.5,
        height: 10 + (index % 2) * 1.6,
        seed: index * 17 + 5,
      });
      keep.position.copy(tw.pos);
      keep.rotation.y = (tw.pos.x * 0.013 + tw.pos.z * 0.021) % (Math.PI * 2);
      this._bake(keep);

      // The timber lookout is superseded: the keep is the tower now. Its beacon
      // material is reused by the brazier, so the mission's pulse still works.
      if (tw.group) tw.group.visible = false;
      tw.keep = keep;
      this.stats.towers += 1;
    });
  }

  /* ---------------- river crossing ---------------- */

  _buildRiverGate() {
    const zone = this.missionManager?.bridgeZone;
    if (!zone) return;
    const yaw = zone.yaw || 0;
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const across = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));

    let site = null;
    for (const back of [13, 16, 20, 25, 30]) {
      for (const sign of [-1, 1]) {
        const p = zone.pos.clone().addScaledVector(forward, back * sign);
        if (this._dry(p.x, p.z)) {
          site = p;
          break;
        }
      }
      if (site) break;
    }
    if (!site) return;

    site.y = this.terrain.getHeightAt(site.x, site.z);
    const gate = castleGate({ materials: this.materials, clearWidth: 7.6, clearHeight: 6.2 });
    gate.position.copy(site);
    gate.rotation.y = yaw;
    this._bake(gate);
    this.stats.gates += 1;

    // A stub of curtain wall either side of the gatehouse.
    for (const side of [-1, 1]) {
      const wallSite = site.clone().addScaledVector(across, side * 9.2);
      if (!this._dry(wallSite.x, wallSite.z)) continue;
      const wall = ruinedWall({
        materials: this.materials,
        length: 8.4,
        height: 3.2,
        seed: 60 + side * 7,
      });
      wall.position.set(wallSite.x, this.terrain.getHeightAt(wallSite.x, wallSite.z), wallSite.z);
      wall.rotation.y = yaw + Math.PI / 2;
      this._bake(wall);
      this.stats.walls += 1;
    }
  }

  /* ---------------- trails ---------------- */

  _buildTrails() {
    const trails = ROADS.filter((road) => road.kind === 'trail');
    if (!trails.length) return;

    const atlas = this._buildSignAtlas(trails.map((road) => road.name));
    const cairnGeometriesAll = [];

    for (const road of trails) {
      let side = 1;
      this._walk(road.points, MARKER_SPACING, (point) => {
        const offset = road.width + MARKER_OFFSET;
        const x = point.x + point.dirZ * offset * side;
        const z = point.z - point.dirX * offset * side;
        side *= -1;
        if (!this._dry(x, z)) return;

        const y = this.terrain.getHeightAt(x, z);
        const seed = cairnGeometriesAll.length * 13 + 3;
        const turn = (seed * 0.618) % (Math.PI * 2);
        const scale = 0.85 + ((seed * 7) % 5) * 0.07;
        for (const geometry of cairnGeometries(seed, scale)) {
          geometry.rotateY(turn);
          geometry.translate(x, y - 0.06, z);
          cairnGeometriesAll.push(geometry);
        }
        this.markers.push({ x, y, z });
        this.stats.cairns += 1;
      });

      // A named signpost at the trailhead, just off the shoulder.
      const head = road.points[0];
      const next = road.points[1] || road.points[0];
      const dx = next[0] - head[0];
      const dz = next[1] - head[1];
      const len = Math.hypot(dx, dz) || 1;
      const sx = head[0] + (dz / len) * (road.width + 2.6);
      const sz = head[1] - (dx / len) * (road.width + 2.6);

      if (!this._dry(sx, sz)) continue;
      const uv = atlas.uvFor(road.name);
      const sign = waymarker({
        materials: this.materials,
        boardMaterial: atlas.material,
        uv,
        height: 2.4,
      });
      sign.position.set(sx, this.terrain.getHeightAt(sx, sz), sz);
      sign.rotation.y = Math.atan2(dx, dz) + Math.PI / 2;
      this._bake(sign);
      this.signs.push({ name: road.name, x: sx, z: sz, yaw: sign.rotation.y });
      this.stats.signs += 1;
    }

    if (cairnGeometriesAll.length) {
      // One mesh for every cairn on every trail. mergeGeometries returns null if
      // the inputs disagree on attributes; fall back to the first cairn rather
      // than dropping the whole set.
      const geometry = cairnGeometriesAll.length === 1
        ? cairnGeometriesAll[0]
        : mergeGeometries(cairnGeometriesAll, false) || cairnGeometriesAll[0];
      const mesh = new THREE.Mesh(geometry, this.materials.stone);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'TrailCairns';
      this.group.add(mesh);
    }
  }

  /** Walk a polyline at a fixed spacing, handing back position + unit tangent. */
  _walk(points, spacing, visit) {
    if (points.length < 2) return;
    let carry = 0;
    for (let i = 1; i < points.length; i += 1) {
      const [x0, z0] = points[i - 1];
      const [x1, z1] = points[i];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const length = Math.hypot(dx, dz);
      if (length < 1e-4) continue;
      const dirX = dx / length;
      const dirZ = dz / length;
      let travelled = carry;
      while (travelled < length) {
        const t = travelled / length;
        visit({ x: x0 + dx * t, z: z0 + dz * t, dirX, dirZ });
        travelled += spacing;
      }
      carry = travelled - length;
    }
  }

  /** One canvas holding every trail name, so all signboards share one texture. */
  _buildSignAtlas(names) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const band = canvas.height / names.length;
    ctx.fillStyle = 'rgba(18,20,24,0.94)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    names.forEach((name, index) => {
      const top = index * band;
      ctx.fillStyle = index % 2 ? '#23262b' : '#1c1f24';
      ctx.fillRect(0, top, canvas.width, band);
      ctx.strokeStyle = '#e8b85a';
      ctx.lineWidth = 5;
      ctx.strokeRect(8, top + 10, canvas.width - 16, band - 20);
      ctx.fillStyle = '#f4ecdc';
      ctx.font = `bold ${Math.round(band * 0.4)}px system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(`◀ ${name.toUpperCase()}`, 44, top + band * 0.52);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.8,
      side: THREE.DoubleSide,
    });

    return {
      material,
      uvFor: (name) => {
        const index = Math.max(0, names.indexOf(name));
        const v1 = 1 - index / names.length;
        const v0 = 1 - (index + 1) / names.length;
        // Inset the band so the mip chain cannot sample a neighbour's stripe.
        return { u0: 0.01, u1: 0.99, v0: v0 + 0.004, v1: v1 - 0.004 };
      },
    };
  }

  /* ---------------- ruins ---------------- */

  _buildRuins() {
    for (const site of RUIN_SITES) {
      let x = site.x;
      let z = site.z;
      let found = false;
      for (const nudge of [0, 18, -18, 36, -36]) {
        if (this._dry(x + nudge, z)) {
          x += nudge;
          found = true;
          break;
        }
      }
      if (!found) continue;

      const y = this.terrain.getHeightAt(x, z);
      const cluster = new THREE.Group();
      cluster.position.set(x, y, z);
      cluster.rotation.y = site.yaw;

      const stump = ruinStump({ materials: this.materials, radius: 2.1, height: 3.6, seed: site.seed });
      cluster.add(stump);

      const wall = ruinedWall({
        materials: this.materials,
        length: 11,
        height: 3.6,
        seed: site.seed + 3,
      });
      wall.position.set(6.4, 0, 1.2);
      cluster.add(wall);

      const short = ruinedWall({
        materials: this.materials,
        length: 6.5,
        height: 2.6,
        seed: site.seed + 9,
      });
      short.position.set(-5.6, 0, 2.4);
      short.rotation.y = -0.5;
      cluster.add(short);

      this._bake(cluster);
      this.stats.ruins += 1;
    }
  }

  /** The nearest landmark worth a HUD hint, if anything is close enough. */
  nearestTower(x, z) {
    let best = null;
    for (const tw of this.missionManager?.watchtowers || []) {
      const distance = Math.hypot(tw.pos.x - x, tw.pos.z - z);
      if (!best || distance < best.distance) best = { tower: tw, distance };
    }
    return best;
  }

  dispose() {
    this.scene.remove(this.group);
    this.materials.stone.dispose?.();
  }
}
