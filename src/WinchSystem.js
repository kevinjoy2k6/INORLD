/* ============================================================================
 * WinchSystem — static anchors, truck-to-truck rescue, jerry-can fuel transfer
 *
 *   F  ......... hook the nearest cargo to the winch (teammate first, then a
 *                tree/rock/pole WinchAnchor within 18 m). F again releases.
 *   E  ......... hand 20 L from your jerry cans to a teammate within 6 m.
 *
 * The cable is a real 3D span (CylinderGeometry + hook sphere) rebuilt every
 * frame between the vehicle's hook and the anchor point.
 *
 * Co-op rescue: when the anchor is a teammate, the pull is shared over WebRTC.
 *  - the rescuer reels in: force along the cable pulls THEIR truck forward
 *  - a `force` packet tells the bogged client to pull ITS OWN truck toward the
 *    rescuer, so the rescue works from both sides of the wire
 * Physics only ever moves the truck that each client owns; remote mirrors are
 * driven by 20 Hz state ticks, so no client can dead-reckon another's body.
 * ========================================================================== */

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const WINCH_RANGE = 18; // m
const FUEL_RANGE = 6; // m
const FUEL_PER_TRANSFER = 20; // L
const MAX_CABLE_FORCE = 16000; // N
const REEL_SPEED = 2.1; // m/s of cable taken in
const MIN_CABLE = 1.6; // m, below this the hook is considered home
const FORCE_PACKET_HZ = 10;

export class WinchSystem {
  constructor({
    vehicle,
    scene,
    world,
    groundMaterial,
    terrain,
    networkManager = null,
  }) {
    this.vehicle = vehicle;
    this.scene = scene;
    this.world = world;
    this.groundMaterial = groundMaterial;
    this.terrain = terrain;
    this.networkManager = networkManager;

    this.anchors = new Map(); // id -> { id, kind, pos, pullPoint, body, mesh }
    this._anchorSeq = 0;
    this._registerTerrainAnchors();

    this.remoteVehicles = new Map(); // peerId -> { player, body, mesh, front, rear }

    this.activeHook = null; // 'front' | 'rear' | null
    this.activeAnchor = null; // { kind, id, pos }
    this.activeTargetVehicle = null;
    this.activeCoopWinch = false;
    this.cableLength = 0;
    this.cableTension = 0;
    this.motorDir = 0; // +1 reel in, -1 pay out

    this.cableRoot = null;
    this._forceAccum = 0;
    this._forceSent = 0;

    this.onToaster = null;

    // Hook points in the truck's local frame (this rig is ~3.9 m long).
    this.hooks = {
      front: new THREE.Vector3(0, 0.55, 2.15),
      rear: new THREE.Vector3(0, 0.55, -2.15),
    };
  }

  setToaster(fn) {
    this.onToaster = fn;
  }

  _toast(text, kind) {
    if (this.onToaster) this.onToaster(text, kind);
  }

  /* ================================================================== *
   *  static anchors (the terrain scatters trees / rocks / poles)
   * ================================================================== */

  _registerTerrainAnchors() {
    const list = this.terrain?.winchAnchors;
    if (!Array.isArray(list)) return;
    for (const a of list) {
      const pos = a.pullPoint || a.position;
      if (!pos) continue;
      this.addAnchor({
        id: a.id,
        kind: a.kind || 'tree',
        pos: new THREE.Vector3(pos.x, pos.y, pos.z),
        body: a.body || null,
      });
    }
  }

  addAnchor({ id, kind, pos, body, mesh }) {
    const entry = {
      id: id ?? `a${this._anchorSeq++}`,
      kind: kind || 'tree',
      pos: pos.clone(),
      body: body || null,
      mesh: mesh || null,
    };
    this.anchors.set(entry.id, entry);
    return entry;
  }

  /* ================================================================== *
   *  remote trucks (registered by NetworkManager)
   * ================================================================== */

  addRemoteVehicle(player, body, mesh) {
    const halfLength = 2.15;
    this.remoteVehicles.set(player.id, {
      player,
      body,
      mesh,
      front: new THREE.Vector3(0, 0.55, halfLength),
      rear: new THREE.Vector3(0, 0.55, -halfLength),
    });
  }

  removeRemoteVehicle(player) {
    const id = player?.id ?? player;
    if (this.activeTargetVehicle && this.activeTargetVehicle.player.id === id) {
      this.detachWinch(false);
    }
    this.remoteVehicles.delete(id);
  }

  /* ================================================================== *
   *  queries
   * ================================================================== */

  _vehiclePos() {
    return this.vehicle.body.position;
  }

  hookWorldPosition(which = 'front') {
    const local = this.hooks[which] || this.hooks.front;
    const q = this.vehicle.group.quaternion;
    return local.clone().applyQuaternion(q).add(this.vehicle.body.position);
  }

  _remoteHookPos(rv, which) {
    const local = which === 'front' ? rv.front : rv.rear;
    return local.clone().applyQuaternion(rv.body.quaternion).add(rv.body.position);
  }

  canWinchTo(targetPos) {
    return this._vehiclePos().distanceTo(targetPos) <= WINCH_RANGE;
  }

  findNearestAnchor(fromPos = this._vehiclePos()) {
    let best = null;
    let bestDist = Infinity;
    for (const anchor of this.anchors.values()) {
      const d = anchor.pos.distanceTo(fromPos);
      if (d < bestDist) {
        bestDist = d;
        best = anchor;
      }
    }
    return bestDist <= WINCH_RANGE ? best : null;
  }

  findNearestCoopVehicle(fromPos = this._vehiclePos()) {
    let best = null;
    let bestDist = Infinity;
    for (const rv of this.remoteVehicles.values()) {
      const d = rv.body.position.distanceTo(fromPos);
      if (d < bestDist) {
        bestDist = d;
        best = rv;
      }
    }
    return bestDist <= WINCH_RANGE ? best : null;
  }

  findNearestTeammateInRange(fromPos = this._vehiclePos(), maxDist = FUEL_RANGE) {
    let best = null;
    let bestDist = Infinity;
    for (const rv of this.remoteVehicles.values()) {
      const d = rv.body.position.distanceTo(fromPos);
      if (d < bestDist) {
        bestDist = d;
        best = rv;
      }
    }
    return bestDist <= maxDist ? best : null;
  }

  canTransferFuel() {
    return !!this.findNearestTeammateInRange();
  }

  /* ================================================================== *
   *  attach / detach
   * ================================================================== */

  tryAttachHook(dirHint = null) {
    if (this.activeHook) {
      this.detachWinch();
      return { ok: true, kind: 'released' };
    }

    const vPos = this._vehiclePos();

    // Teammates first: rescuing a bogged friend is the headline feature.
    const teammate = this.findNearestCoopVehicle(vPos);
    if (teammate) {
      const fDist = this._remoteHookPos(teammate, 'front').distanceTo(vPos);
      const rDist = this._remoteHookPos(teammate, 'rear').distanceTo(vPos);
      const useFront = fDist <= rDist;
      const hookPos = this._remoteHookPos(teammate, useFront ? 'front' : 'rear');

      this.activeHook = dirHint || (useFront ? 'rear' : 'front');
      this.activeTargetVehicle = teammate;
      this.activeCoopWinch = true;
      this.activeAnchor = {
        kind: 'coop',
        id: teammate.player.id,
        pos: hookPos,
      };
      this.cableLength = this.hookWorldPosition(this.activeHook).distanceTo(hookPos);
      this._buildCable();
      this._toast(`WINCHED TO ${String(teammate.player.name || 'TEAMMATE').toUpperCase()}`, 'good');

      this.networkManager?.onWinchFired(null, {
        action: 'attach',
        targetId: teammate.player.id,
        anchorPos: hookPos.toArray(),
      });
      return { ok: true, kind: 'coop', target: teammate.player.id };
    }

    // Then the static world: trees, boulders, poles.
    const anchor = this.findNearestAnchor(vPos);
    if (anchor) {
      this.activeHook = dirHint || 'front';
      this.activeCoopWinch = false;
      this.activeTargetVehicle = null;
      this.activeAnchor = { kind: anchor.kind, id: anchor.id, pos: anchor.pos.clone() };
      this.cableLength = this.hookWorldPosition(this.activeHook).distanceTo(anchor.pos);
      this._buildCable();
      this._toast(`WINCH ANCHORED — ${anchor.kind.toUpperCase()}`, 'good');
      return { ok: true, kind: 'anchor', target: anchor.id, anchorKind: anchor.kind };
    }

    this._toast('NOTHING IN WINCH RANGE (18M)');
    return { ok: false };
  }

  detachWinch(notifyNetwork = true) {
    const wasCoop = this.activeCoopWinch;
    const targetId = this.activeTargetVehicle?.player.id ?? null;

    this.activeHook = null;
    this.activeAnchor = null;
    this.activeTargetVehicle = null;
    this.activeCoopWinch = false;
    this.cableLength = 0;
    this.cableTension = 0;
    this.motorDir = 0;
    this._forceSent = 0;

    if (this.cableRoot) {
      this.scene.remove(this.cableRoot);
      this.cableRoot.traverse?.((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          o.material?.dispose?.();
        }
      });
      this.cableRoot = null;
    }

    if (notifyNetwork && wasCoop && this.networkManager) {
      this.networkManager.onWinchFired(null, { action: 'release', targetId });
    }
  }

  /* ================================================================== *
   *  per-frame
   * ================================================================== */

  update(dt, now = 0) {
    if (!this.activeAnchor) return;

    // A coop anchor tracks the teammate's current hook position.
    if (this.activeCoopWinch) {
      const rv = this.activeTargetVehicle;
      if (!rv || !this.remoteVehicles.has(rv.player.id)) {
        this.detachWinch(false);
        return;
      }
      this.activeAnchor.pos.copy(rv.body.position);
    }

    const hookPos = this.hookWorldPosition(this.activeHook);
    const anchorPos = this.activeAnchor.pos;
    const toAnchor = new THREE.Vector3().subVectors(anchorPos, hookPos);
    const dist = toAnchor.length();

    if (dist > WINCH_RANGE * 1.6) {
      this._toast('CABLE SNAPPED — TOO FAR');
      this.detachWinch();
      return;
    }

    // Reel in at a fixed rate; the cable then acts as a taut spring.
    this.cableLength = Math.max(MIN_CABLE, this.cableLength - REEL_SPEED * dt);

    const slack = dist - this.cableLength;
    if (slack > 0) {
      // Tension rises with stretch, capped so a bogged truck cannot be flung.
      this.cableTension = Math.min(MAX_CABLE_FORCE, slack * 5200 + 900);
      const dir = toAnchor.clone().normalize();
      const force = dir.multiplyScalar(this.cableTension);

      this.vehicle.body.applyForce(
        new CANNON.Vec3(force.x, force.y, force.z),
        new CANNON.Vec3(hookPos.x, hookPos.y, hookPos.z),
      );

      if (this.activeCoopWinch) this._relayCoopForce(dist, dt);
    } else {
      this.cableTension = Math.max(0, this.cableTension - 4000 * dt);
    }

    if (dist <= MIN_CABLE + 0.15) {
      this._toast('WINCHED IN');
      this.detachWinch();
      return;
    }

    this._updateCable(hookPos, anchorPos, this.cableTension);
  }

  /**
   * Tell the bogged client to pull its own truck toward us. Throttled to
   * 10 Hz — a per-frame packet would flood the data channel for no gain.
   */
  _relayCoopForce(dist, dt) {
    const net = this.networkManager;
    if (!net) return;

    this._forceAccum += dt;
    if (this._forceAccum < 1 / FORCE_PACKET_HZ) return;
    this._forceAccum = 0;

    const rv = this.activeTargetVehicle;
    if (!rv) return;

    const pullerPos = this._vehiclePos();
    const boggedPos = rv.body.position;
    const dir = new THREE.Vector3(
      pullerPos.x - boggedPos.x,
      pullerPos.y - boggedPos.y,
      pullerPos.z - boggedPos.z,
    );
    const d = dir.length() || 1;
    dir.divideScalar(d);

    const magnitude = Math.min(MAX_CABLE_FORCE * 0.9, this.cableTension * 0.9);
    const force = dir.multiplyScalar(magnitude);

    net.onWinchFired(null, {
      action: 'force',
      targetId: rv.player.id,
      force: [force.x, force.y, force.z],
      anchorPos: pullerPos.toArray(),
      distance: dist,
    });
  }

  /** A teammate's winch is pulling us — apply their force to our own truck. */
  applyExternalWinchForce(force, anchorPos) {
    if (!Array.isArray(force) || force.length !== 3) return;
    const f = new CANNON.Vec3(force[0], force[1], force[2]);
    const at = anchorPos
      ? new CANNON.Vec3(anchorPos[0], anchorPos[1], anchorPos[2])
      : this.vehicle.body.position;
    this.vehicle.body.applyForce(f, at);
    this.externalWinchActive = true;
    this.externalWinchUntil = performance.now() + 600;
  }

  /* ================================================================== *
   *  cable visual
   * ================================================================== */

  _buildCable() {
    if (this.cableRoot) {
      this.scene.remove(this.cableRoot);
      this.cableRoot = null;
    }

    const group = new THREE.Group();
    group.name = 'winch-cable';

    const cable = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 1, 6),
      new THREE.MeshStandardMaterial({ color: 0x6f6f6f, roughness: 0.55, metalness: 0.85 }),
    );
    cable.castShadow = true;
    group.add(cable);

    const hook = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xffb648, roughness: 0.4, metalness: 0.6 }),
    );
    group.add(hook);

    // A second, smaller hook marker at the anchor end.
    const eye = new THREE.Mesh(
      new THREE.TorusGeometry(0.12, 0.03, 6, 10),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5, metalness: 0.8 }),
    );
    group.add(eye);

    group.userData.cable = cable;
    group.userData.hook = hook;
    group.userData.eye = eye;

    this.scene.add(group);
    this.cableRoot = group;

    const hookPos = this.hookWorldPosition(this.activeHook);
    this._updateCable(hookPos, this.activeAnchor.pos, 0);
  }

  _updateCable(from, to, tension) {
    const root = this.cableRoot;
    if (!root) return;
    const cable = root.userData.cable;
    const hook = root.userData.hook;
    const eye = root.userData.eye;

    const delta = new THREE.Vector3().subVectors(to, from);
    const len = Math.max(0.1, delta.length());
    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);

    cable.scale.set(1, len, 1);
    cable.position.copy(mid);
    cable.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize());

    // A taut cable flexes slightly; a slack one sags.
    const taut = Math.min(1, this.cableTension / MAX_CABLE_FORCE);
    cable.material.color.setHSL(0.08, 0.05, 0.42 + taut * 0.12);

    hook.position.copy(from);
    eye.position.copy(to);
    eye.lookAt(from);
  }

  /* ================================================================== *
   *  fuel transfer
   * ================================================================== */

  tryTransferFuel() {
    if (!this.vehicle.hasAccessory('jerryCans')) {
      this._toast('NEED ROOF RACK JERRY CANS');
      return { ok: false, reason: 'no-jerrycans' };
    }

    const teammate = this.findNearestTeammateInRange();
    if (!teammate) {
      this._toast('NO TEAMMATE WITHIN 6M');
      return { ok: false, reason: 'out-of-range' };
    }

    const localFuel = this.vehicle.fuel;
    const amount = Math.min(FUEL_PER_TRANSFER, localFuel - 2);
    if (amount <= 0.5) {
      this._toast('YOUR TANK IS EMPTY');
      return { ok: false, reason: 'empty' };
    }

    this.vehicle.fuel = Math.max(0, localFuel - amount);

    if (this.networkManager) {
      this.networkManager.onFuelTransfer(null, {
        targetId: teammate.player.id,
        amount,
        fromAccessory: 'jerryCans',
      });
    }

    this._toast(`SENT ${amount.toFixed(0)}L TO ${String(teammate.player.name || 'TEAMMATE').toUpperCase()}`, 'good');
    return { ok: true, amount, targetId: teammate.player.id };
  }

  /* ================================================================== *
   *  remote events mirrored onto our copy of a teammate's truck
   * ================================================================== */

  onRemoteWinchFired(sourceId, payload) {
    // We cannot move someone else's physics body — they own it. What we can do
    // is mirror the cable so both players SEE the rescue happening.
    if (payload.action === 'attach' && payload.anchorPos && !this.activeHook) {
      const rv = this.remoteVehicles.get(payload.targetId) || this._remoteById(sourceId);
      if (rv) {
        this.mirrorCable = { from: rv.body.position.clone(), to: new THREE.Vector3(...payload.anchorPos) };
      }
    }
    if (payload.action === 'release') {
      this.mirrorCable = null;
    }
  }

  _remoteById(id) {
    for (const rv of this.remoteVehicles.values()) {
      if (rv.player.id === id) return rv;
    }
    return null;
  }

  /* ---------------- housekeeping ---------------- */

  reset() {
    this.detachWinch(false);
    this.remoteVehicles.clear();
    this.mirrorCable = null;
    this.externalWinchActive = false;
  }

  getStats() {
    return {
      anchors: this.anchors.size,
      hooks: this.remoteVehicles.size,
      active: !!this.activeHook,
      kind: this.activeAnchor?.kind ?? null,
      tension: Math.round(this.cableTension),
    };
  }
}
