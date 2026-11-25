/* ============================================================================
 * MissionManager — shared scouting and shared timber hauling
 *
 *  SCOUT  — three Watchtowers sit on high ground. Driving inside a tower's
 *           radius marks it found for the whole squad: the beacon goes out and
 *           the world's fog is pushed back a little further for everyone.
 *
 *  TIMBER — a Lumber Mill loads the logging trailer with timber bundles and a
 *           broken bridge across the river is the delivery point. A solo driver
 *           needs two trips (one bundle each); a squad of two can load both
 *           bundles in one convoy run. Delivering both permanently builds a
 *           driveable wooden bridge for every player in the room.
 *
 * Progress is serialised by getState()/setState() for the join handshake and
 * every change is broadcast as a `mission-event` through NetworkManager.
 *
 * A solo expedition also writes itself to localStorage (`INORLD_EXPEDITION`), so
 * scouted towers, the delivered timber count and the finished bridge survive a
 * reload. Co-op still comes from the host: a joiner is handed the room's state
 * in `host-sync` and never writes that state over its own local expedition.
 * ========================================================================== */

import * as THREE from 'three';
import { WATCHTOWERS } from './WorldAtlas.js';
import * as CANNON from 'cannon-es';

const BUNDLES_NEEDED = 2;
const BUNDLE_MIN = 1;

const STORAGE_KEY = 'INORLD_EXPEDITION';
const SAVE_VERSION = 1;

/** Stored numbers come from a browser that may be on an older/newer build. */
function clampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export class MissionManager {
  constructor({
    terrain,
    vehicle,
    trailer,
    scene,
    world,
    groundMaterial,
    networkManager = null,
  }) {
    this.terrain = terrain;
    this.vehicle = vehicle;
    this.trailer = trailer;
    this.scene = scene;
    this.world = world;
    this.groundMaterial = groundMaterial;
    this.networkManager = networkManager;

    this.watchtowers = [];
    this.discovered = new Set();

    this.millZone = null;
    this.bridgeZone = null;
    this.timberLoaded = false;
    this.bundlesInTrailer = 0;
    this.bundlesDelivered = 0;
    this.bridgeBuilt = false;

    this.bridgeMesh = null;
    this.bridgeBody = null;

    this.onToaster = null;
    this.onStateChange = null;

    this._lastTowerCount = 0;
    this._lastDelivered = 0;
    this._bridgeSite = null;
  }

  setToaster(fn) {
    this.onToaster = fn;
  }

  _toast(text, kind) {
    if (this.onToaster) this.onToaster(text, kind);
  }

  /* ================================================================== *
   *  setup
   * ================================================================== */

  setup() {
    const terrain = this.terrain;
    const spawn = terrain.spawn.position;

    /* ---- watchtowers: one per region, sited by the world atlas ---- */
    const towerDefs = WATCHTOWERS.map((def) => ({
      id: def.id,
      name: def.name,
      x: def.x,
      z: def.z,
    }));

    this.watchtowers = towerDefs.map((def) => {
      const y = terrain.getHeightAt(def.x, def.z) || 0;
      const tw = {
        id: def.id,
        name: def.name,
        pos: new THREE.Vector3(def.x, y, def.z),
        radius: 13,
      };
      this._buildWatchtower(tw);
      return tw;
    });

    /* ---- lumber mill, on the hardpack near spawn ---- */
    const millX = spawn.x + 8;
    const millZ = spawn.z - 14;
    this.millZone = {
      id: 'mill',
      name: 'Lumber Mill',
      pos: new THREE.Vector3(millX, terrain.getHeightAt(millX, millZ) || 0, millZ),
      radius: 11,
    };
    this._buildMill(this.millZone);

    /* ---- broken bridge: the nearest river crossing to spawn ---- */
    this._bridgeSite = this._findRiverCrossing(spawn);
    this.bridgeZone = {
      id: 'bridge',
      name: 'Broken River Bridge',
      pos: this._bridgeSite.pos.clone(),
      yaw: this._bridgeSite.yaw,
      radius: 13,
    };
    this._buildBrokenBridge(this.bridgeZone);
    this._buildBridgeSpan(this.bridgeZone);

    // Everything the save refers to now exists, so the last expedition can be
    // put back: towers, delivered loads and the span itself.
    this._restoreLocal();
  }

  /* ================================================================== *
   *  placement helpers
   * ================================================================== */

  _findRiverCrossing(spawn) {
    const terrain = this.terrain;
    let best = null;
    let bestDist = Infinity;

    // Coarse scan over the terrain: cheapest water cell close to the trail.
    const step = 8;
    const half = 190;
    for (let x = -half; x <= half; x += step) {
      for (let z = -half; z <= half; z += step) {
        const surf = terrain.getSurfaceAt ? terrain.getSurfaceAt(x, z) : null;
        if (!surf) continue;
        if (surf.biome !== 'water') continue;
        const d = Math.hypot(x - spawn.x, z - spawn.z);
        // Far enough that hauling timber is a real trip, not a lap of the spawn.
        if (d < bestDist && d > 70) {
          bestDist = d;
          best = { x, z };
        }
      }
    }

    if (!best) {
      // No water found (dry seed): fall back to a fixed site beside the trail.
      return {
        pos: new THREE.Vector3(spawn.x - 40, terrain.getHeightAt(spawn.x - 40, spawn.z + 30) || 0, spawn.z + 30),
        yaw: 0,
      };
    }

    // Orient the span across the flow: sample two neighbouring cells.
    const axisX = terrain.getSurfaceAt(best.x + 6, best.z)?.biome === 'water';
    const yaw = axisX ? Math.PI / 2 : 0;
    const y = terrain.getHeightAt(best.x, best.z);

    return { pos: new THREE.Vector3(best.x, y, best.z), yaw };
  }

  /* ================================================================== *
   *  watchtower visual
   * ================================================================== */

  _buildWatchtower(tw) {
    const group = new THREE.Group();
    group.position.copy(tw.pos);

    const wood = new THREE.MeshStandardMaterial({ color: 0x8b7355, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x5d4a34, roughness: 0.95 });

    // Four legs.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 4.4, 6), dark);
        leg.position.set(sx * 0.75, 2.2, sz * 0.75);
        leg.castShadow = true;
        group.add(leg);
      }
    }

    // Deck.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.16, 2.3), wood);
    deck.position.y = 4.4;
    deck.castShadow = true;
    deck.receiveShadow = true;
    group.add(deck);

    // Cab roof.
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 1.1, 4), new THREE.MeshStandardMaterial({ color: 0x3f4a3a, roughness: 0.9 }));
    roof.position.y = 5.6;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);

    // Signal beacon.
    const beaconMat = new THREE.MeshStandardMaterial({
      color: 0xe0685c,
      emissive: 0xe0685c,
      emissiveIntensity: 0.9,
    });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 8), beaconMat);
    beacon.position.y = 6.3;
    group.add(beacon);

    group.position.y = tw.pos.y;
    this.scene.add(group);
    tw.group = group;
    tw.beaconMat = beaconMat;
  }

  /* ================================================================== *
   *  lumber mill visual
   * ================================================================== */

  _buildMill(zone) {
    const group = new THREE.Group();
    group.position.copy(zone.pos);

    const wood = new THREE.MeshStandardMaterial({ color: 0x8b7355, roughness: 0.9 });
    const logMat = new THREE.MeshStandardMaterial({ color: 0x6d5433, roughness: 0.95 });

    // Saw bench.
    const bench = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.35, 1.2), wood);
    bench.position.y = 0.6;
    bench.castShadow = true;
    bench.receiveShadow = true;
    group.add(bench);

    // Legs.
    for (const sx of [-1.3, 1.3]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.9), wood);
      leg.position.set(sx, 0.3, 0);
      group.add(leg);
    }

    // The bundle stack that shrinks as timber is hauled away.
    const stack = new THREE.Group();
    stack.position.set(-2.6, 0, 0);
    for (let row = 0; row < 2; row += 1) {
      for (let i = 0; i < 3; i += 1) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 3.0, 7), logMat);
        log.rotation.z = Math.PI / 2;
        log.position.set(0, 0.25 + row * 0.38, (i - 1) * 0.42);
        log.castShadow = true;
        stack.add(log);
      }
    }
    group.add(stack);
    zone.stack = stack;

    // Sign post.
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 6), wood);
    post.position.set(1.7, 0.8, 0.6);
    group.add(post);
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.5, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xd9c79a, roughness: 0.8 }),
    );
    sign.position.set(1.7, 1.5, 0.6);
    group.add(sign);

    this.scene.add(group);
    zone.group = group;
  }

  /* ================================================================== *
   *  broken bridge visual (pillars + a gap)
   * ================================================================== */

  _buildBrokenBridge(zone) {
    const group = new THREE.Group();
    group.position.copy(zone.pos);
    group.rotation.y = zone.yaw;

    const stone = new THREE.MeshStandardMaterial({ color: 0x6f665b, roughness: 0.95 });
    const plank = new THREE.MeshStandardMaterial({ color: 0x8b7355, roughness: 0.9 });

    for (const side of [-1, 1]) {
      // Abutment.
      const abut = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.4, 4.4), stone);
      abut.position.set(side * 4.2, 0.7, 0);
      abut.castShadow = true;
      abut.receiveShadow = true;
      group.add(abut);

      // A few surviving planks, cantilevered and broken.
      for (let i = 0; i < 3; i += 1) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 0.9), plank);
        p.position.set(side * (3.2 - i * 0.9), 1.45, (i - 1) * 1.1);
        p.rotation.z = side * (0.05 + i * 0.05);
        p.castShadow = true;
        group.add(p);
      }
    }

    // Warning barrier at the near edge.
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.1, 6), plank);
      post.position.set(side * 1.6, 1.9, -2.4);
      group.add(post);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.16, 0.08), new THREE.MeshStandardMaterial({ color: 0xd9922b, roughness: 0.7 }));
    bar.position.set(0, 2.35, -2.4);
    group.add(bar);

    this.scene.add(group);
    zone.group = group;
  }

  /* ---- the span that appears when both bundles are delivered ---- */

  _buildBridgeSpan(zone) {
    const span = new THREE.Group();
    span.position.copy(zone.pos);
    span.rotation.y = zone.yaw;

    const beamMat = new THREE.MeshStandardMaterial({ color: 0x7d6142, roughness: 0.9 });
    const deckMat = new THREE.MeshStandardMaterial({ color: 0xa89273, roughness: 0.95 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x6b5a44, roughness: 0.9 });

    // Beams along the span.
    for (const side of [-1, 1]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 8.6), beamMat);
      beam.position.set(side * 1.35, 1.42, 0);
      beam.castShadow = true;
      span.add(beam);
    }

    // Decking.
    for (let z = -4.1; z <= 4.1; z += 0.46) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.1, 0.4), deckMat);
      plank.position.set(0, 1.6, z);
      plank.castShadow = true;
      plank.receiveShadow = true;
      span.add(plank);
    }

    // Railings.
    for (const side of [-1, 1]) {
      for (const y of [1.95, 2.25]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 8.4), railMat);
        rail.position.set(side * 1.55, y, 0);
        span.add(rail);
      }
      for (let z = -4; z <= 4; z += 1.35) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.85, 6), railMat);
        post.position.set(side * 1.55, 1.98, z);
        span.add(post);
      }
    }

    span.visible = false;
    this.scene.add(span);
    this.bridgeMesh = span;
  }

  _addBridgeCollider() {
    if (this.bridgeBody) return;
    const zone = this.bridgeZone;
    const body = new CANNON.Body({
      mass: 0,
      material: this.groundMaterial,
      shape: new CANNON.Box(new CANNON.Vec3(1.8, 0.12, 4.4)),
    });
    body.position.set(zone.pos.x, zone.pos.y + 1.62, zone.pos.z);
    body.quaternion.setFromEuler(0, zone.yaw, 0);
    body.aabbNeedsUpdate = true;
    body.updateAABB();
    this.world.addBody(body);
    this.bridgeBody = body;
  }

  /* ================================================================== *
   *  per-frame checks
   * ================================================================== */

  /**
   * What the player should do next, as one place both the HUD and the squad can
   * agree on. A 2 km valley with no minimap needs a direction, not just a
   * counter: the trailer comes first when loaded, then the nearest unscouted
   * tower, then the next load.
   */
  nextObjective(position = null) {
    const p = position || this.vehicle.body.position;
    const nearest = (zones, keep) => {
      let best = null;
      let bestDistance = Infinity;
      for (const zone of zones) {
        if (!zone || (keep && !keep(zone))) continue;
        const distance = Math.hypot(zone.pos.x - p.x, zone.pos.z - p.z);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = zone;
        }
      }
      return best ? { zone: best, distance: bestDistance } : null;
    };

    if (this.bundlesInTrailer > 0 && !this.bridgeBuilt) {
      const drop = nearest([this.bridgeZone]);
      if (drop) return { kind: 'deliver', label: 'BRIDGE', ...drop };
    }

    const tower = nearest(this.watchtowers, (tw) => !this.discovered.has(tw.id));
    if (tower) return { kind: 'scout', label: 'TOWER', ...tower };

    if (this.bundlesDelivered < BUNDLES_NEEDED && !this.bridgeBuilt) {
      const load = nearest([this.millZone]);
      if (load) return { kind: 'load', label: 'MILL', ...load };
    }

    return null;
  }

  update(dt, now = 0) {
    const v = this.vehicle.body.position;

    // ---- scouting
    for (const tw of this.watchtowers) {
      const found = this.discovered.has(tw.id);
      const d = Math.hypot(tw.pos.x - v.x, tw.pos.z - v.z);
      if (!found && d < tw.radius) this.discoverTower(tw.id);

      if (tw.beaconMat) {
        const pulse = found ? 0.05 : 0.55 + 0.45 * Math.sin(now * 0.004 + tw.pos.x * 0.01);
        tw.beaconMat.emissiveIntensity = pulse;
      }
    }

    // ---- timber loading at the mill
    if (this.bundlesInTrailer < BUNDLES_NEEDED && this.bundlesDelivered < BUNDLES_NEEDED) {
      const dm = Math.hypot(this.millZone.pos.x - v.x, this.millZone.pos.z - v.z);
      if (dm < this.millZone.radius) this.loadTimber();
    }

    // ---- timber delivery at the bridge
    if (this.bundlesInTrailer > 0 && !this.bridgeBuilt) {
      const dd = Math.hypot(this.bridgeZone.pos.x - v.x, this.bridgeZone.pos.z - v.z);
      if (dd < this.bridgeZone.radius) this.deliverTimber();
    }
  }

  /* ================================================================== *
   *  scouting
   * ================================================================== */

  discoverTower(towerId) {
    if (this.discovered.has(towerId)) return false;
    const tw = this.watchtowers.find((t) => t.id === towerId);
    if (!tw) return false;

    this.discovered.add(towerId);
    this._applyFogReveal(this.discovered.size);

    this._toast(`SCOUTED ${this.discovered.size}/3 — ${tw.name.toUpperCase()}`, 'good');
    this._notify();

    this.networkManager?.sendMissionEvent('discover', { towerId });
    return true;
  }

  /** Each tower permanently pushes the fog wall back for the whole squad. */
  _applyFogReveal(count) {
    const fog = this.scene.fog;
    if (!fog) return;
    const base = this._fogBase || (this._fogBase = { near: fog.near, far: fog.far });
    fog.near = base.near + count * 26;
    fog.far = base.far + count * 120;
  }

  /* ================================================================== *
   *  timber
   * ================================================================== */

  _squadSize() {
    return this.networkManager ? 1 + this.networkManager.remotePlayerCount : 1;
  }

  loadTimber() {
    if (this.bundlesInTrailer >= BUNDLES_NEEDED) return;
    if (this.bundlesDelivered + this.bundlesInTrailer >= BUNDLES_NEEDED) return;

    // A convoy loads both bundles at once; solo takes one trip per bundle.
    const capacity = Math.max(BUNDLE_MIN, Math.min(BUNDLES_NEEDED, this._squadSize()));
    const room = BUNDLES_NEEDED - this.bundlesDelivered;
    const take = Math.max(0, Math.min(capacity, room));
    if (take <= 0) return;

    this.bundlesInTrailer = take;
    this.timberLoaded = true;
    this._syncTrailerVisual();

    this._toast(
      take > 1 ? `LOADED ${take} TIMBER BUNDLES — CONVOY RUN` : 'LOADED 1 TIMBER BUNDLE',
      'good',
    );
    this._notify();
    this.networkManager?.sendMissionEvent('timber-load', { bundles: take });
  }

  unloadTimber() {
    if (!this.bundlesInTrailer) return;
    this.bundlesInTrailer = 0;
    this.timberLoaded = false;
    this._syncTrailerVisual();
    this._persistLocal();
    this.networkManager?.sendMissionEvent('timber-load', { bundles: 0 });
  }

  deliverTimber() {
    if (!this.bundlesInTrailer) return;
    const amount = this.bundlesInTrailer;

    this.bundlesInTrailer = 0;
    this.timberLoaded = false;
    this.bundlesDelivered = Math.min(BUNDLES_NEEDED, this.bundlesDelivered + amount);
    this._syncTrailerVisual();

    if (this.bundlesDelivered >= BUNDLES_NEEDED) {
      this.buildBridge(false);
    } else {
      this._toast(`DELIVERED ${this.bundlesDelivered}/${BUNDLES_NEEDED} — ONE MORE LOAD`, 'good');
    }

    this._notify();
    this.networkManager?.sendMissionEvent('timber-deliver', {
      bundles: amount,
      delivered: this.bundlesDelivered,
    });
  }

  /** The side effects of a finished bridge, silent so a save can replay them. */
  _applyBridgeBuilt() {
    this.bridgeBuilt = true;
    this.bundlesDelivered = BUNDLES_NEEDED;
    if (this.bridgeMesh) this.bridgeMesh.visible = true;
    this._addBridgeCollider();
    if (this.millZone?.stack) this.millZone.stack.visible = false;
  }

  buildBridge(broadcast = true) {
    if (this.bridgeBuilt) return;
    this._applyBridgeBuilt();

    this._toast('BRIDGE BUILT — RIVER CROSSING OPEN', 'good');
    this._notify();
    if (broadcast) this.networkManager?.sendMissionEvent('timber-deliver', { bundles: 0, delivered: BUNDLES_NEEDED });
  }

  _syncTrailerVisual() {
    if (!this.trailer) return;
    if (typeof this.trailer.setLoaded === 'function') {
      this.trailer.setLoaded(this.bundlesInTrailer > 0);
    }
  }

  /* ================================================================== *
   *  network
   * ================================================================== */

  applyEvent(sourceId, payload) {
    if (!payload) return;
    const type = payload.event ?? payload.type;
    if (!type) return;

    switch (type) {
      case 'discover': {
        const tw = this.watchtowers.find((t) => t.id === payload.towerId);
        if (tw && !this.discovered.has(tw.id)) {
          this.discovered.add(tw.id);
          this._applyFogReveal(this.discovered.size);
          this._toast(`TEAMMATE SCOUTED ${tw.name.toUpperCase()}`);
          this._notify();
        }
        break;
      }

      case 'timber-load': {
        const bundles = Number(payload.bundles) || 0;
        // A teammate hauling does not move OUR trailer; only our own load shows.
        if (payload.playerId === this.networkManager?.localPeerId) break;
        this._toast(bundles > 0 ? `TEAMMATE LOADED ${bundles} BUNDLE${bundles > 1 ? 'S' : ''}` : 'TIMBER UNLOADED');
        break;
      }

      case 'timber-deliver': {
        const delivered = Number(payload.delivered) || 0;
        if (delivered >= BUNDLES_NEEDED) {
          if (!this.bridgeBuilt) {
            this._toast('TEAMMATE FINISHED THE BRIDGE', 'good');
            this.buildBridge(true);
          }
        } else if (delivered > this.bundlesDelivered) {
          this.bundlesDelivered = delivered;
          this._toast(`DELIVERED ${delivered}/${BUNDLES_NEEDED}`);
          this._notify();
        }
        break;
      }

      default:
        break;
    }
  }

  /* ================================================================== *
   *  local persistence
   * ================================================================== */

  /**
   * Co-op mission state belongs to the host. A joiner's copy is whatever the
   * host's `host-sync` delivered, so writing it back would erase this player's
   * own expedition after one session with a squad. Solo play and hosting save.
   */
  _canPersist() {
    return this.networkManager?.role !== 'joiner';
  }

  _persistLocal() {
    if (!this._canPersist()) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        v: SAVE_VERSION,
        discovered: [...this.discovered],
        bundlesDelivered: this.bundlesDelivered,
        bundlesInTrailer: this.bundlesInTrailer,
        bridgeBuilt: this.bridgeBuilt,
        savedAt: Date.now(),
      }));
    } catch {
      // Private mode or a full quota: the expedition simply does not persist.
    }
  }

  _notify() {
    this._persistLocal();
    this.onStateChange?.(this.getState());
  }

  /** Put a saved expedition back, silently. Runs once, after setup(). */
  _restoreLocal() {
    let saved = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      saved = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!saved || typeof saved !== 'object') return false;

    // A tower that this build no longer has is dropped rather than trusted.
    const known = new Set(this.watchtowers.map((tw) => tw.id));
    const discovered = Array.isArray(saved.discovered)
      ? saved.discovered.filter((id) => known.has(id))
      : [];
    this.discovered = new Set(discovered);
    if (this.discovered.size) this._applyFogReveal(this.discovered.size);

    this.bundlesDelivered = clampInt(saved.bundlesDelivered, 0, BUNDLES_NEEDED);
    this.bundlesInTrailer = clampInt(
      saved.bundlesInTrailer,
      0,
      BUNDLES_NEEDED - this.bundlesDelivered,
    );
    this.timberLoaded = this.bundlesInTrailer > 0;
    this._syncTrailerVisual();

    if (saved.bridgeBuilt || this.bundlesDelivered >= BUNDLES_NEEDED) {
      this._applyBridgeBuilt();
    }

    this._lastTowerCount = this.discovered.size;
    this._lastDelivered = this.bundlesDelivered;
    return true;
  }

  /* ================================================================== *
   *  serialisation
   * ================================================================== */

  getState() {
    return {
      discovered: [...this.discovered],
      bundlesDelivered: this.bundlesDelivered,
      bridgeBuilt: this.bridgeBuilt,
      timberLoaded: this.bundlesInTrailer > 0,
      bundlesInTrailer: this.bundlesInTrailer,
    };
  }

  setState(state) {
    if (!state) return;

    this.discovered = new Set(state.discovered || []);
    this._applyFogReveal(this.discovered.size);

    this.bundlesDelivered = Math.min(BUNDLES_NEEDED, Number(state.bundlesDelivered) || 0);
    const built = !!state.bridgeBuilt || this.bundlesDelivered >= BUNDLES_NEEDED;

    if (built) {
      this.bridgeBuilt = false; // allow buildBridge to run its side effects
      this.buildBridge(false);
    }

    this._lastTowerCount = this.discovered.size;
    this._lastDelivered = this.bundlesDelivered;
  }

  /* ---- HUD convenience ---- */
  getProgress() {
    return {
      towers: this.discovered.size,
      towersTotal: this.watchtowers.length,
      bundlesDelivered: this.bundlesDelivered,
      bundlesTotal: BUNDLES_NEEDED,
      bridgeBuilt: this.bridgeBuilt,
    };
  }
}
