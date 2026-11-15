import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PHYS_GROUPS, SURFACES } from './OffroadVehicle.js';

/**
 * Two-axle timber trailer.
 *
 * It runs the same raycast-strut suspension scheme as the SUV so the bed sits
 * on its own springs instead of being glued to a fixed ride height, and the
 * drawbar is held by a PointToPointConstraint that can be added and removed at
 * runtime (T key). Unhitched, the trailer applies a parking brake so it does not
 * roll away down the test hill.
 */
const TRAILER = {
  massEmpty: 920,
  massLoaded: 3400,
  comHeight: 0.86,
  wheelRadius: 0.42,
  wheelWidth: 0.26,
  attachY: -0.17,
  restLength: 0.3,
  maxCompression: 0.18,
  maxDroop: 0.08,
  springStiffness: 72000,
  dampingCompression: 3600,
  dampingRebound: 4600,
  lateralStiffness: 0.72,
  parkingBrakeDamping: 5200,
  hitchLocal: { x: 0, y: -0.24, z: 2.72 },
  wheelOffsets: [
    { id: 'TL', x: -0.92, z: 1.15 },
    { id: 'TR', x: 0.92, z: 1.15 },
    { id: 'BL', x: -0.92, z: -1.15 },
    { id: 'BR', x: 0.92, z: -1.15 },
  ],
};

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export class TrailerRig {
  constructor({
    heading = 0, world, scene, vehicle, spawn = new THREE.Vector3(8, 1.2, -12), groundMaterial = null }) {
    this.world = world;
    this.scene = scene;
    this.vehicle = vehicle;
    this.spawn = spawn.clone();

    this.hitched = false;
    this.loaded = false;
    this.constraint = null;

    this.suspLen = new Float32Array(4).fill(TRAILER.restLength);
    this.prevLen = new Float32Array(4).fill(TRAILER.restLength);
    this.comp = new Float32Array(4);
    this.load = new Float32Array(4).fill((TRAILER.massEmpty * 9.82) / 4);
    this.grounded = [false, false, false, false];
    this.wheelSurface = [SURFACES.hardpack, SURFACES.hardpack, SURFACES.hardpack, SURFACES.hardpack];
    this.contactPoint = [new CANNON.Vec3(), new CANNON.Vec3(), new CANNON.Vec3(), new CANNON.Vec3()];
    this.contactNormal = [
      new CANNON.Vec3(0, 1, 0),
      new CANNON.Vec3(0, 1, 0),
      new CANNON.Vec3(0, 1, 0),
      new CANNON.Vec3(0, 1, 0),
    ];

    this.material = new CANNON.Material('trailer');
    this.rayResult = new CANNON.RaycastResult();
    this.rayOptions = {
      collisionFilterGroup: PHYS_GROUPS.RAY,
      collisionFilterMask: PHYS_GROUPS.GROUND,
      skipBackfaces: true,
      checkCollisionResponse: false,
    };

    const body = new CANNON.Body({
      mass: TRAILER.massEmpty,
      material: this.material,
      linearDamping: 0.05,
      angularDamping: 0.4,
      allowSleep: false,
    });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.95, 0.5, 1.9)), new CANNON.Vec3(0, -0.06, -0.15));
    body.position.set(spawn.x, spawn.y, spawn.z);
    this.spawnHeading = heading;
    if (heading) body.quaternion.setFromEuler(0, heading, 0);
    body.collisionFilterGroup = PHYS_GROUPS.VEHICLE;
    body.collisionFilterMask = PHYS_GROUPS.GROUND | PHYS_GROUPS.REMOTE;
    world.addBody(body);
    this.body = body;

    if (groundMaterial) {
      world.addContactMaterial(
        new CANNON.ContactMaterial(groundMaterial, this.material, {
          friction: 0.3,
          restitution: 0.02,
          contactEquationStiffness: 1e7,
          contactEquationRelaxation: 3,
        }),
      );
    }

    this._prevPos = new CANNON.Vec3(spawn.x, spawn.y, spawn.z);
    this._prevQuat = new CANNON.Quaternion();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
    this._firstStep = true;

    this._buildMesh();
    this.syncVisuals(1);
  }

  /* ================= mesh ================= */

  _buildMesh() {
    const paint = new THREE.MeshStandardMaterial({ color: 0x9c5f2c, roughness: 0.62, metalness: 0.15 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x4a4e52, roughness: 0.55, metalness: 0.75 });
    const timber = new THREE.MeshStandardMaterial({ color: 0xa8763f, roughness: 0.92, metalness: 0.0 });
    const timberEnd = new THREE.MeshStandardMaterial({ color: 0xd7b483, roughness: 0.9, metalness: 0.0 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x121316, roughness: 0.96, flatShading: true });
    const rim = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.36, metalness: 0.88 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0x6d120d, emissive: 0xc41f14, emissiveIntensity: 0.8 });
    const amber = new THREE.MeshStandardMaterial({ color: 0x9a5c12, emissive: 0xd98a19, emissiveIntensity: 0.7 });

    this.group = new THREE.Group();
    this.bodyGroup = new THREE.Group();
    this.bodyGroup.position.y = -TRAILER.comHeight;
    this.group.add(this.bodyGroup);

    const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    const add = (mesh, x, y, z) => {
      mesh.position.set(x, y, z);
      this.bodyGroup.add(mesh);
      return mesh;
    };

    add(box(1.9, 0.1, 3.4, timber), 0, 0.76, -0.1); // deck
    add(box(1.24, 0.18, 3.2, steel), 0, 0.63, -0.1); // subframe
    add(box(1.94, 0.07, 0.14, steel), 0, 0.79, 1.6); // front rail
    add(box(1.94, 0.07, 0.14, steel), 0, 0.79, -1.8); // rear rail

    // stake pockets
    for (const x of [-0.92, 0.92]) {
      for (const z of [-1.55, -0.5, 0.55, 1.55]) {
        add(box(0.07, 0.5, 0.07, steel), x, 1.05, z);
      }
    }

    // headboard
    add(box(1.86, 0.62, 0.08, timber), 0, 1.13, 1.6);
    add(box(1.9, 0.06, 0.1, steel), 0, 1.46, 1.6);

    // drawbar A-frame and coupling
    for (const side of [-1, 1]) {
      const arm = box(0.1, 0.1, 1.6, steel);
      arm.rotation.y = side * 0.22;
      add(arm, side * 0.34, 0.63, 2.1);
    }
    add(box(0.16, 0.16, 0.5, steel), 0, 0.62, 2.6);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.035, 8, 14), steel);
    ring.rotation.x = Math.PI / 2;
    add(ring, 0, 0.62, 2.86);

    // axles and mudguards
    for (const z of [1.15, -1.15]) {
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.92, 10), steel);
      axle.rotation.z = Math.PI / 2;
      add(axle, 0, 0.42, z);
      const guard = box(2.0, 0.05, 0.62, steel);
      add(guard, 0, 0.86, z);
      for (const side of [-1, 1]) {
        const skirt = box(0.05, 0.12, 0.62, steel);
        add(skirt, side * 0.98, 0.8, z);
      }
    }

    // rear light bar
    add(box(1.5, 0.1, 0.1, steel), 0, 0.7, -1.86);
    for (const side of [-1, 1]) {
      add(box(0.16, 0.12, 0.06, lamp), side * 0.62, 0.7, -1.9);
      add(box(0.08, 0.08, 0.06, amber), side * 0.8, 0.7, -1.9);
    }

    // ---- timber load, hidden until loaded
    this.logGroup = new THREE.Group();
    const logRadius = 0.21;
    const logLength = 3.3;
    const rows = [
      { y: 1.0, xs: [-0.63, -0.21, 0.21, 0.63] },
      { y: 1.36, xs: [-0.42, 0, 0.42] },
      { y: 1.72, xs: [-0.21, 0.21] },
    ];
    for (const row of rows) {
      for (const x of row.xs) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(logRadius, logRadius, logLength, 10), timber);
        log.rotation.x = Math.PI / 2;
        log.position.set(x, row.y, -0.15);
        this.logGroup.add(log);

        for (const side of [-1, 1]) {
          const cap = new THREE.Mesh(
            new THREE.CircleGeometry(logRadius * 0.96, 10),
            timberEnd,
          );
          cap.position.set(x, row.y, -0.15 + side * (logLength / 2 + 0.005));
          cap.rotation.y = side > 0 ? 0 : Math.PI;
          this.logGroup.add(cap);
        }
      }
    }
    this.logGroup.visible = false;
    this.bodyGroup.add(this.logGroup);

    this.bodyGroup.traverse((object) => {
      if (object.isMesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });

    // ---- wheels
    const tireGeometry = new THREE.CylinderGeometry(
      TRAILER.wheelRadius,
      TRAILER.wheelRadius,
      TRAILER.wheelWidth,
      20,
      4,
    );
    tireGeometry.rotateZ(Math.PI / 2);
    const rimGeometry = new THREE.CylinderGeometry(
      TRAILER.wheelRadius * 0.58,
      TRAILER.wheelRadius * 0.58,
      TRAILER.wheelWidth * 1.05,
      14,
      1,
    );
    rimGeometry.rotateZ(Math.PI / 2);

    this.wheelVisuals = [];
    for (const offset of TRAILER.wheelOffsets) {
      const pivot = new THREE.Group();
      pivot.position.set(offset.x, TRAILER.attachY - TRAILER.restLength, offset.z);

      const spin = new THREE.Group();
      const tire = new THREE.Mesh(tireGeometry, rubber);
      tire.castShadow = true;
      const barrel = new THREE.Mesh(rimGeometry, rim);
      spin.add(tire, barrel);
      pivot.add(spin);
      this.group.add(pivot);

      this.wheelVisuals.push({ pivot, spin });
    }

    this.scene.add(this.group);
  }

  /* ================= towing ================= */

  vehicleHitchWorld(target = new CANNON.Vec3()) {
    const local = this.vehicle.builder.socketLocal('hitch', new THREE.Vector3());
    return this.vehicle.body.pointToWorldFrame(new CANNON.Vec3(local.x, local.y, local.z), target);
  }

  trailerHitchWorld(target = new CANNON.Vec3()) {
    return this.body.pointToWorldFrame(
      new CANNON.Vec3(TRAILER.hitchLocal.x, TRAILER.hitchLocal.y, TRAILER.hitchLocal.z),
      target,
    );
  }

  distanceToHitch() {
    const a = this.vehicleHitchWorld();
    const b = this.trailerHitchWorld();
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  hitch() {
    if (this.constraint) return { ok: true, message: 'Already hitched' };
    if (this.distanceToHitch() > 4) {
      return { ok: false, message: 'Trailer too far — reverse closer' };
    }

    const pivotA = this.vehicleHitchWorld();
    const pivotB = this.body.quaternion.vmult(
      new CANNON.Vec3(TRAILER.hitchLocal.x, TRAILER.hitchLocal.y, TRAILER.hitchLocal.z),
    );

    // Snap the ring over the ball before constraining, so the solver never has
    // to yank the trailer across the gap.
    this.body.position.set(pivotA.x - pivotB.x, pivotA.y - pivotB.y, pivotA.z - pivotB.z);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);

    const localA = this.vehicle.builder.socketLocal('hitch', new THREE.Vector3());
    this.constraint = new CANNON.PointToPointConstraint(
      this.vehicle.body,
      new CANNON.Vec3(localA.x, localA.y, localA.z),
      this.body,
      new CANNON.Vec3(TRAILER.hitchLocal.x, TRAILER.hitchLocal.y, TRAILER.hitchLocal.z),
      1e6,
    );
    this.world.addConstraint(this.constraint);
    this.hitched = true;
    this._prevPos.set(this.body.position.x, this.body.position.y, this.body.position.z);
    return { ok: true, message: 'Trailer hitched' };
  }

  unhitch() {
    if (!this.constraint) return { ok: true, message: 'Not hitched' };
    this.world.removeConstraint(this.constraint);
    this.constraint = null;
    this.hitched = false;
    return { ok: true, message: 'Trailer released' };
  }

  toggleHitch() {
    return this.hitched ? this.unhitch() : this.hitch();
  }

  setLoaded(loaded) {
    this.loaded = !!loaded;
    this.logGroup.visible = this.loaded;
    this.body.mass = this.loaded ? TRAILER.massLoaded : TRAILER.massEmpty;
    this.body.updateMassProperties();
    this.body.wakeUp();
    return this.loaded;
  }

  toggleLoad() {
    return this.setLoaded(!this.loaded);
  }

  reset() {
    this.unhitch();
    this.body.position.set(this.spawn.x, this.spawn.y, this.spawn.z);
    if (this.spawnHeading) this.body.quaternion.setFromEuler(0, this.spawnHeading, 0);
    else this.body.quaternion.set(0, 0, 0, 1);
    this.body.velocity.set(0, 0, 0);
    this.body.angularVelocity.set(0, 0, 0);
    this.suspLen.fill(TRAILER.restLength);
    this.comp.fill(0);
    // See OffroadVehicle.reset(): a teleport must refresh the cached AABB.
    this.body.aabbNeedsUpdate = true;
    this._prevPos.set(this.spawn.x, this.spawn.y, this.spawn.z);
    this._prevQuat.set(
      this.body.quaternion.x,
      this.body.quaternion.y,
      this.body.quaternion.z,
      this.body.quaternion.w,
    );
    this.syncVisuals(1);
  }

  /* ================= simulation ================= */

  beginFrame() {
    this._prevPos.set(this.body.position.x, this.body.position.y, this.body.position.z);
    this._prevQuat.set(
      this.body.quaternion.x,
      this.body.quaternion.y,
      this.body.quaternion.z,
      this.body.quaternion.w,
    );
  }

  update(dt) {
    const body = this.body;
    const up = new CANNON.Vec3();
    body.quaternion.vmult(new CANNON.Vec3(0, 1, 0), up);
    const down = new CANNON.Vec3(-up.x, -up.y, -up.z);

    const rayLength = TRAILER.restLength + TRAILER.maxDroop + TRAILER.wheelRadius + 0.06;
    const minLen = TRAILER.restLength - TRAILER.maxCompression;
    const maxLen = TRAILER.restLength + TRAILER.maxDroop;

    /* ---- suspension ---- */
    for (let i = 0; i < 4; i += 1) {
      const offset = TRAILER.wheelOffsets[i];
      const attach = body.pointToWorldFrame(
        new CANNON.Vec3(offset.x, TRAILER.attachY, offset.z),
        new CANNON.Vec3(),
      );
      const rayEnd = new CANNON.Vec3(
        attach.x + down.x * rayLength,
        attach.y + down.y * rayLength,
        attach.z + down.z * rayLength,
      );

      this.rayResult.reset();
      const hit = this.world.raycastClosest(attach, rayEnd, this.rayOptions, this.rayResult);

      if (!hit) {
        this.grounded[i] = false;
        this.suspLen[i] = maxLen;
        this.comp[i] = -TRAILER.maxDroop;
        this.load[i] = 0;
        continue;
      }

      const result = this.rayResult;
      const hitBody = result.body;
      this.wheelSurface[i] =
        hitBody && hitBody.userData && SURFACES[hitBody.userData.surface]
          ? SURFACES[hitBody.userData.surface]
          : SURFACES.hardpack;

      const normal = new CANNON.Vec3(
        result.hitNormalWorld.x,
        result.hitNormalWorld.y,
        result.hitNormalWorld.z,
      );
      normal.normalize();

      const length = clamp(result.distance - TRAILER.wheelRadius, minLen, maxLen);
      this.suspLen[i] = length;
      this.comp[i] = TRAILER.restLength - length;

      const compressionVelocity = this._firstStep ? 0 : (this.prevLen[i] - length) / dt;
      const damping = compressionVelocity > 0 ? TRAILER.dampingCompression : TRAILER.dampingRebound;
      const force = Math.max(0, TRAILER.springStiffness * this.comp[i] + damping * compressionVelocity);

      this.prevLen[i] = length;
      this.load[i] = force;
      this.grounded[i] = true;
      this.contactNormal[i].set(normal.x, normal.y, normal.z);
      this.contactPoint[i].set(result.hitPointWorld.x, result.hitPointWorld.y, result.hitPointWorld.z);
      body.applyLocalForce(
        new CANNON.Vec3(0, force, 0),
        new CANNON.Vec3(offset.x, TRAILER.attachY, offset.z),
      );
    }
    this._firstStep = false;

    /* ---- tyre friction and parking brake ---- */
    for (let i = 0; i < 4; i += 1) {
      if (!this.grounded[i]) continue;

      const contact = this.contactPoint[i];
      const normal = this.contactNormal[i];

      const fwd = new CANNON.Vec3();
      body.quaternion.vmult(new CANNON.Vec3(0, 0, 1), fwd);
      const projection = fwd.dot(normal);
      fwd.set(fwd.x - normal.x * projection, fwd.y - normal.y * projection, fwd.z - normal.z * projection);
      if (fwd.normalize() < 0.2) fwd.set(0, 0, 1);

      const side = new CANNON.Vec3();
      normal.cross(fwd, side);
      side.normalize();

      const velocity = body.getVelocityAtWorldPoint(contact, new CANNON.Vec3());
      const vLong = velocity.dot(fwd);
      const vLat = velocity.dot(side);

      const surface = this._surfaceOf(i);
      const cap = surface.grip * this.load[i];

      let forceLong = -Math.sign(vLong) * surface.rollResistance * this.load[i];
      if (!this.hitched) forceLong -= vLong * TRAILER.parkingBrakeDamping;
      forceLong = clamp(forceLong, -cap, cap);

      const forceLat = -clamp(vLat * TRAILER.lateralStiffness, -1, 1) * cap;

      const relative = new CANNON.Vec3(
        contact.x - body.position.x,
        contact.y - body.position.y,
        contact.z - body.position.z,
      );
      body.applyForce(
        new CANNON.Vec3(
          fwd.x * forceLong + side.x * forceLat,
          fwd.y * forceLong + side.y * forceLat,
          fwd.z * forceLong + side.z * forceLat,
        ),
        relative,
      );
    }
  }

  _surfaceOf(index) {
    return this.wheelSurface[index] || SURFACES.hardpack;
  }

  /* ================= visuals ================= */

  syncVisuals(alpha = 1) {
    const body = this.body;
    const t = clamp(alpha, 0, 1);

    this.group.position.set(
      this._prevPos.x + (body.position.x - this._prevPos.x) * t,
      this._prevPos.y + (body.position.y - this._prevPos.y) * t,
      this._prevPos.z + (body.position.z - this._prevPos.z) * t,
    );

    this._qa.set(this._prevQuat.x, this._prevQuat.y, this._prevQuat.z, this._prevQuat.w);
    this._qb.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    this._qa.slerp(this._qb, t);
    this.group.quaternion.copy(this._qa);

    for (let i = 0; i < 4; i += 1) {
      const visual = this.wheelVisuals[i];
      const offset = TRAILER.wheelOffsets[i];
      visual.pivot.position.set(offset.x, TRAILER.attachY - this.suspLen[i], offset.z);
    }
  }

  getTelemetry() {
    return {
      hitched: this.hitched,
      loaded: this.loaded,
      distance: this.distanceToHitch(),
      mass: this.body.mass,
      grounded: this.grounded.filter(Boolean).length,
      compression: Array.from(this.comp),
    };
  }
}

export const TRAILER_TUNE = TRAILER;
