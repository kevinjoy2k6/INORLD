import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  VehicleMeshBuilder,
  ACCESSORIES,
  ACCESSORY_ORDER,
  PSI_RANGE,
  effectiveTireRadius,
} from './VehicleMeshBuilder.js';

/* ------------------------------------------------------------------ *
 *  Collision groups
 *  The suspension ray must see the terrain but never the vehicle that
 *  starts it, so vehicle bodies live in their own group.
 * ------------------------------------------------------------------ */
export const PHYS_GROUPS = {
  GROUND: 1,
  RAY: 2,
  VEHICLE: 4,
  REMOTE: 8, // co-op teammates' trucks
};

/* ------------------------------------------------------------------ *
 *  Terrain surfaces
 *  grip            coulomb friction coefficient on this surface
 *  sinkage         maximum wheel sink depth (m) for a loaded wheel
 *  dig             how strongly wheelspin deepens the rut
 *  viscosity       N per (m/s) per metre of sinkage — the drag of the medium
 *  rollResistance  rolling resistance coefficient
 * ------------------------------------------------------------------ */
export const SURFACES = {
  hardpack: {
    key: 'hardpack',
    label: 'Hardpack',
    grip: 0.9,
    sinkage: 0.0,
    dig: 0.0,
    viscosity: 60,
    rollResistance: 0.018,
    color: 0x8a7752,
  },
  mud: {
    key: 'mud',
    label: 'Deep Mud',
    grip: 0.35,
    sinkage: 0.45,
    dig: 1.1,
    viscosity: 1100,
    rollResistance: 0.16,
    color: 0x3a2a1e,
  },
  sand: {
    key: 'sand',
    label: 'Sand',
    grip: 0.45,
    sinkage: 0.26,
    dig: 0.7,
    viscosity: 700,
    rollResistance: 0.13,
    color: 0xbfa878,
  },
  snow: {
    key: 'snow',
    label: 'Deep Snow',
    grip: 0.3,
    sinkage: 0.5,
    dig: 0.5,
    viscosity: 500,
    rollResistance: 0.1,
    color: 0xdde6ee,
  },
  rock: {
    key: 'rock',
    label: 'Rock',
    grip: 0.95,
    sinkage: 0.0,
    dig: 0.0,
    viscosity: 0,
    rollResistance: 0.03,
    color: 0x6a6259,
  },
};

/* ------------------------------------------------------------------ *
 *  Engine torque curve — a 4.2 L turbo-diesel, interpolated linearly
 *  between measured points rather than fitted to a formula.
 * ------------------------------------------------------------------ */
const TORQUE_CURVE = [
  [500, 0],
  [750, 255],
  [1100, 360],
  [1600, 415],
  [2100, 430],
  [2600, 416],
  [3100, 378],
  [3600, 320],
  [4100, 220],
  [4400, 70],
  [4600, 0],
];

function torqueAtRpm(rpm) {
  if (rpm <= TORQUE_CURVE[0][0]) return 0;
  const last = TORQUE_CURVE[TORQUE_CURVE.length - 1];
  if (rpm >= last[0]) return 0;
  for (let i = 1; i < TORQUE_CURVE.length; i += 1) {
    const [x1, y1] = TORQUE_CURVE[i];
    if (rpm <= x1) {
      const [x0, y0] = TORQUE_CURVE[i - 1];
      const t = (rpm - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 *  Gearbox — high/low transfer case plus a 4-speed auto and overdrive
 * ------------------------------------------------------------------ */
const GEARBOX = [
  { id: 'L-', label: 'L-', ratio: 2.8, lowRange: 2.28 },
  { id: 'L', label: 'L', ratio: 1.95, lowRange: 2.28 },
  { id: 'L+', label: 'L+', ratio: 1.3, lowRange: 2.28 },
  { id: 'AUTO', label: 'A', auto: [3.3, 1.95, 1.3, 0.9] },
  { id: 'H', label: 'H', ratio: 0.78 },
  { id: 'R', label: 'R', ratio: -3.2 },
];
const GEAR_ORDER = ['L-', 'L', 'L+', 'AUTO', 'H', 'R'];
const AUTO_GEAR_INDEX = GEAR_ORDER.indexOf('AUTO');

const WHEELS = [
  { id: 'FL', x: -0.86, z: 1.42, steer: true, axle: 'front' },
  { id: 'FR', x: 0.86, z: 1.42, steer: true, axle: 'front' },
  { id: 'RL', x: -0.86, z: -1.42, steer: false, axle: 'rear' },
  { id: 'RR', x: 0.86, z: -1.42, steer: false, axle: 'rear' },
];

/* ------------------------------------------------------------------ *
 *  Vehicle tuning — every magic number lives here so it can be tweaked
 *  without hunting through the solver.
 * ------------------------------------------------------------------ */
const TUNE = {
  chassisMass: 1900,
  comHeight: 0.98,
  attachY: -0.32,
  wheelRadius: 0.46,
  wheelWidth: 0.3,
  wheelInertia: 7.4,
  restLength: 0.34,
  maxCompression: 0.24,
  maxDroop: 0.1,
  springStiffness: 34000,
  dampingCompression: 3400,
  dampingRebound: 4600,
  antiRollStiffness: 9500,
  // Fraction of the wheelie/dive moment cancelled by the axle links, i.e. the
  // anti-squat percentage. Without it a 0.9-grip launch puts the front struts
  // at full droop and pitches the truck over backwards.
  antiSquat: 0.55,
  // Diesel torque build: throttle takes this many seconds to reach the request.
  // Long enough to feel like a turbo-diesel spooling, short enough that the
  // pedal answers you.
  throttleRamp: 0.55,
  // Vertical offset of the chassis box inside the body. The body origin is the
  // centre of mass, so this is subtracted from as accessories raise the CoM.
  chassisOffsetY: 0.06,
  wheelBase: 2.84,
  trackWidth: 1.72,
  maxSteerLowSpeed: 0.56,
  maxSteerHighSpeed: 0.2,
  steerRate: 3.4,
  finalDrive: 4.1,
  drivetrainEfficiency: 0.88,
  idleRpm: 780,
  maxRpm: 4400,
  maxBrakeTorque: 2400,
  handbrakeTorque: 3600,
  slipStiffness: 6.2,
  // Lateral force is a damper on sideways velocity, so it can only hold a
  // sidehill once the truck is already creeping. At 0.62 that creep settled at
  // ~1.6 m/s; 1.3 halves it without touching the cornering limit (the force is
  // capped by grip either way).
  lateralStiffness: 1.3,
  // A rollover is under 2 rad/s. Anything past this is a solver artefact from a
  // single bad contact, and letting it through is how a curb becomes a flip.
  maxAngularVelocity: 6,
  minPsi: PSI_RANGE.min,
  maxPsi: PSI_RANGE.max,
  tireRefPsi: PSI_RANGE.ref,
  tankCapacity: 80,
};

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function moveTowards(current, target, maxDelta) {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/* ------------------------------------------------------------------ *
 *  The 4x4 itself: rigid body, four independent raycast struts, the
 *  drivetrain, tyre pressure and fuel model. The visual shell, wheels
 *  and modular accessories belong to VehicleMeshBuilder.
 * ------------------------------------------------------------------ */
export class OffroadVehicle {
  constructor({
    surfaceProvider = null,
    heading = 0, world, scene, spawn = new THREE.Vector3(0, 0.98, 0), paint = 0xc9a86a, groundMaterial = null,
    localPlayerId = 'local' }) {
    this.world = world;
    this.scene = scene;
    this.spawn = spawn.clone();

    /* ---------------- driver / drivetrain state ---------------- */
    this.psi = 22;
    this.fuel = TUNE.tankCapacity;
    this.engineOn = true;
    this.gearIndex = AUTO_GEAR_INDEX;
    this.autoGear = 1;
    this.shiftCooldown = 0;
    this.throttle = 0;
    this.throttleTarget = 0;
    this.brakeInput = 0;
    this.steerInput = 0;
    this.steerAngle = 0;
    this.handbrake = false;
    this.awd = true;
    this.diffLock = false;
    this.rpm = TUNE.idleRpm;
    this.speed = 0;
    this.fuelLpm = 0;
    this.gearLabel = 'A1';
    this.currentRatio = 0;
    this.groundedCount = 0;
    this.surfaceKey = 'hardpack';
    this.sinkAvg = 0;

    /* ---------------- per wheel state ---------------- */
    this.comp = new Float32Array(4);
    this.suspLen = new Float32Array(4).fill(TUNE.restLength);
    this.prevLen = new Float32Array(4).fill(TUNE.restLength);
    this.springForce = new Float32Array(4);
    // Ray length is heavily smoothed before it drives the damper. The terrain
    // is faceted, so the raw distance to the ground steps at every facet edge;
    // feeding that step into a spring damper turns a 3 cm ledge into a
    // thousands-of-newtons spike and the truck bucks.
    this.smoothLen = new Float32Array(4).fill(TUNE.restLength);
    this.arbForce = new Float32Array(4);
    // Damper shaft speed, low-passed: the raw frame-to-frame length delta spikes
    // at every facet edge on this low-poly terrain.
    this.dampVel = new Float32Array(4);
    this.load = new Float32Array(4).fill((TUNE.chassisMass * 9.82) / 4);
    this.omega = new Float32Array(4);
    this.slip = new Float32Array(4);
    this.sink = new Float32Array(4);
    this.wheelSteer = new Float32Array(4);
    this.wheelTorque = new Float32Array(4);
    this.spinAngle = new Float32Array(4);
    this.cap = new Float32Array(4);
    this.driveCap = new Float32Array(4);
    this.grounded = [false, false, false, false];
    this.wheelSurface = [SURFACES.hardpack, SURFACES.hardpack, SURFACES.hardpack, SURFACES.hardpack];
    this.contactPoint = [new CANNON.Vec3(), new CANNON.Vec3(), new CANNON.Vec3(), new CANNON.Vec3()];
    this.contactNormal = [
      new CANNON.Vec3(0, 1, 0),
      new CANNON.Vec3(0, 1, 0),
      new CANNON.Vec3(0, 1, 0),
      new CANNON.Vec3(0, 1, 0),
    ];

    this._firstStep = true;
    this._prevPos = new CANNON.Vec3(spawn.x, spawn.y, spawn.z);
    this._prevQuat = new CANNON.Quaternion();
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();

    /* ---------------- rigid body ---------------- */
    this.chassisMaterial = new CANNON.Material('chassis');
    this.rayResult = new CANNON.RaycastResult();
    this.rayOptions = {
      collisionFilterGroup: PHYS_GROUPS.RAY,
      collisionFilterMask: PHYS_GROUPS.GROUND,
      skipBackfaces: true,
      checkCollisionResponse: false,
    };

    const body = new CANNON.Body({
      mass: TUNE.chassisMass,
      material: this.chassisMaterial,
      linearDamping: 0.02,
      angularDamping: 0.34,
      allowSleep: false,
    });
    // Same belly line as the original box (so the body sits on its wheels
    // exactly as before), but shorter and with rounded skid spheres front and
    // rear. A square corner digs into a crest and stops the truck dead; a
    // sphere rides over the same crest.
    const bellyY = TUNE.chassisOffsetY - 0.52; // -0.46: the old box floor
    const skidRadius = 0.3;
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(0.86, 0.36, 1.84)),
      new CANNON.Vec3(0, bellyY + 0.36, 0),
    );
    body.addShape(
      new CANNON.Sphere(skidRadius),
      new CANNON.Vec3(0, bellyY + skidRadius, 1.9),
    );
    body.addShape(
      new CANNON.Sphere(skidRadius),
      new CANNON.Vec3(0, bellyY + skidRadius, -1.9),
    );
    body.position.set(spawn.x, spawn.y, spawn.z);
    body.collisionFilterGroup = PHYS_GROUPS.VEHICLE;
    body.collisionFilterMask = PHYS_GROUPS.GROUND | PHYS_GROUPS.REMOTE;
    world.addBody(body);
    this.body = body;
    this.spawnHeading = heading;
    if (heading) body.quaternion.setFromEuler(0, heading, 0);
    this.surfaceProvider = surfaceProvider;
    this.tireWidth = 0.4;
    this.waterDepth = 0;
    this.maxWaterDepth = 0;
    this.flooded = false;
    this.drainTimer = 0;

    if (groundMaterial) {
      world.addContactMaterial(
        // The belly is meant to skate over a crest, not catch on it. Low
        // friction here is the difference between "scraped the skid plate" and
        // "the truck stopped dead for no reason".
        new CANNON.ContactMaterial(groundMaterial, this.chassisMaterial, {
          friction: 0.05,
          restitution: 0.05,
          contactEquationStiffness: 1e7,
          contactEquationRelaxation: 4,
        }),
      );
    }

    /* ---------------- visuals ---------------- */
    this.group = new THREE.Group();
    this.builder = new VehicleMeshBuilder({
      paint,
      wheelRadius: TUNE.wheelRadius,
      wheelWidth: TUNE.wheelWidth,
      comHeight: TUNE.comHeight,
      suspensionRest: TUNE.restLength,
      wheelMounts: WHEELS,
    });
    this.group.add(this.builder.group);
    this.wheelVisuals = this.builder.wheels;
    this.paintHex = paint;
    scene.add(this.group);

    this.accessories = {};
    for (const id of ACCESSORY_ORDER) this.accessories[id] = false;
    this.headlightsOn = true;

    // Phase-5: a stable id so remote peers can match state to a player.
    this.localPlayerId = localPlayerId ?? 'local';
    this.wheelSink = [0, 0, 0, 0];
    this.wheelBounds = [0, 0, 0, 0];
    this.steeringAngle = 0;
    this.wheelRotation = 0;

    this._applyAccessories();
    this._applyTireDeflation();
    this._updateGearLabel();
    this.syncVisuals(1);
  }

  /* ================= public controls ================= */

  get deflation() {
    return clamp((TUNE.maxPsi - this.psi) / (TUNE.maxPsi - TUNE.minPsi), 0, 1);
  }

  get psiGripFactor() {
    return clamp(Math.sqrt(TUNE.tireRefPsi / this.psi), 0.72, 1.45);
  }

  _effRadius() {
    return effectiveTireRadius(TUNE.wheelRadius, this.psi);
  }

  setThrottle(value) {
    this.throttleTarget = clamp(value, 0, 1);
  }

  setBrake(value) {
    this.brakeInput = clamp(value, 0, 1);
  }

  setSteer(value) {
    this.steerInput = clamp(value, -1, 1);
  }

  setHandbrake(on) {
    this.handbrake = !!on;
  }

  toggleAWD() {
    this.awd = !this.awd;
    return this.awd;
  }

  toggleDiffLock() {
    this.diffLock = !this.diffLock;
    return this.diffLock;
  }

  toggleEngine() {
    this.engineOn = !this.engineOn && this.fuel > 0;
    return this.engineOn;
  }

  setGear(id) {
    const index = GEAR_ORDER.indexOf(id);
    if (index < 0) return;
    this.gearIndex = index;
    this.autoGear = 1;
    this.shiftCooldown = 0.35;
    this._updateGearLabel();
  }

  shiftUp() {
    this.gearIndex = (this.gearIndex + 1) % GEAR_ORDER.length;
    this.autoGear = 1;
    this.shiftCooldown = 0.35;
    this._updateGearLabel();
  }

  shiftDown() {
    this.gearIndex = (this.gearIndex - 1 + GEAR_ORDER.length) % GEAR_ORDER.length;
    this.autoGear = 1;
    this.shiftCooldown = 0.35;
    this._updateGearLabel();
  }

  setPSI(value) {
    const next = clamp(value, TUNE.minPsi, TUNE.maxPsi);
    if (Math.abs(next - this.psi) < 0.01) return;
    this.psi = next;
    this._applyTireDeflation();
  }

  adjustPSI(delta) {
    this.setPSI(this.psi + delta);
  }

  reset() {
    const body = this.body;
    body.position.set(this.spawn.x, this.spawn.y, this.spawn.z);
    if (this.spawnHeading) body.quaternion.setFromEuler(0, this.spawnHeading, 0);
    else body.quaternion.set(0, 0, 0, 1);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    body.force.set(0, 0, 0);
    body.torque.set(0, 0, 0);
    this.omega.fill(0);
    this.sink.fill(0);
    this.slip.fill(0);
    this.gearIndex = AUTO_GEAR_INDEX;
    this.autoGear = 1;
    this.steerAngle = 0;
    // Teleporting a body does not invalidate its cached AABB, and the SAP
    // broadphase would keep pairing it from the old position.
    body.aabbNeedsUpdate = true;
    this._prevPos.set(body.position.x, body.position.y, body.position.z);
    this._prevQuat.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    this.flooded = false;
    this.drainTimer = 0;
    this.waterDepth = 0;
    if (this.fuel > 0) this.engineOn = true;
    this._updateGearLabel();
    this.syncVisuals(1);
  }

  /* ================= simulation ================= */

  /**
   * Snapshot the pose before the physics sub-steps run, so the renderer can
   * interpolate the whole tick instead of just the last sub-step.
   */
  beginFrame() {
    // A tunnelled contact or a degenerate suspension solve can push the body to
    // a non-finite pose. Once a CANNON body goes NaN it never recovers, and
    // every system downstream (camera, audio, HUD) inherits the poison and the
    // screen goes black. Catch it here and rebuild at the spawn point instead.
    const p = this.body.position;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      console.warn('[vehicle] non-finite pose, recovering at spawn');
      this.reset();
      return;
    }
    this._prevPos.set(this.body.position.x, this.body.position.y, this.body.position.z);
    this._prevQuat.set(this.body.quaternion.x, this.body.quaternion.y, this.body.quaternion.z, this.body.quaternion.w);
  }

  update(dt) {
    this.throttle = moveTowards(this.throttle, this.throttleTarget, TUNE.throttleRamp * dt);
    this._updateSteering(dt);
    this._updateEngine(dt);
    this._sampleSuspension(dt);
    this._updateWater(dt);
    this._applyTireForces(dt);
    this._updateFuel(dt);

    for (let i = 0; i < 4; i += 1) {
      this.spinAngle[i] = (this.spinAngle[i] + this.omega[i] * dt) % (Math.PI * 2);
    }

    this.speed = Math.hypot(this.body.velocity.x, this.body.velocity.z);

    // Safety net for the rigid body as a whole. Suspension and contact forces
    // are capped individually, but a bad frame can still hand the solver a
    // torque impulse; an unbounded spin is unrecoverable, a clamped one settles.
    const av = this.body.angularVelocity;
    const spin = Math.hypot(av.x, av.y, av.z);
    if (spin > TUNE.maxAngularVelocity) {
      const scale = TUNE.maxAngularVelocity / spin;
      av.x *= scale; av.y *= scale; av.z *= scale;
    }

    this._firstStep = false;
  }

  _updateGearLabel() {
    const gear = GEARBOX[this.gearIndex];
    this.gearLabel = gear.id === 'AUTO' ? `A${this.autoGear}` : gear.label;
    this.currentRatio = gear.auto ? gear.auto[this.autoGear - 1] : gear.ratio;
  }

  _updateSteering(dt) {
    const speedFactor = clamp(this.speed / 22, 0, 1);
    const maxSteer = THREE.MathUtils.lerp(TUNE.maxSteerLowSpeed, TUNE.maxSteerHighSpeed, speedFactor);
    // +1 steer input is "screen right", which is a negative rotation about +Y.
    const target = -this.steerInput * maxSteer;
    const rate = TUNE.steerRate * (1 - 0.45 * speedFactor);
    this.steerAngle = moveTowards(this.steerAngle, target, rate * dt);

    const halfTrack = TUNE.trackWidth * 0.5;
    let inner = 0;
    let outer = 0;
    if (Math.abs(this.steerAngle) > 1e-3) {
      const radius = TUNE.wheelBase / Math.tan(Math.abs(this.steerAngle));
      const sign = Math.sign(this.steerAngle);
      inner = sign * Math.atan(TUNE.wheelBase / Math.max(0.8, radius - halfTrack));
      outer = sign * Math.atan(TUNE.wheelBase / (radius + halfTrack));
    }

    const innerOnPositiveX = this.steerAngle > 0;
    for (let i = 0; i < 4; i += 1) {
      const wheel = WHEELS[i];
      if (!wheel.steer) {
        this.wheelSteer[i] = 0;
        continue;
      }
      const onPositiveX = wheel.x > 0;
      this.wheelSteer[i] = onPositiveX === innerOnPositiveX ? inner : outer;
    }
  }

  _updateEngine(dt) {
    const gear = GEARBOX[this.gearIndex];

    /* --- automatic shifting inside the AUTO gear --- */
    if (gear.auto) {
      this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
      if (this.shiftCooldown === 0) {
        if (this.rpm > 2750 && this.autoGear < gear.auto.length && this.throttle > 0.05) {
          this.autoGear += 1;
          this.shiftCooldown = 0.5;
        } else if (this.rpm < 1450 && this.autoGear > 1) {
          this.autoGear -= 1;
          this.shiftCooldown = 0.5;
        }
      }
    }
    this._updateGearLabel();

    let ratio = this.currentRatio;
    if (gear.lowRange) ratio *= gear.lowRange;
    const totalRatio = ratio * TUNE.finalDrive;

    /* --- engine speed from the driven wheels, with converter slip --- */
    const driven = this.awd ? [0, 1, 2, 3] : [2, 3];
    let omegaAvg = 0;
    for (const index of driven) omegaAvg += this.omega[index];
    omegaAvg /= driven.length;

    const wheelRpm = (Math.abs(omegaAvg * totalRatio) * 60) / (2 * Math.PI);
    let rpm = Math.max(wheelRpm, TUNE.idleRpm);
    if (this.throttle > 0.05 && wheelRpm < 1400) {
      rpm = Math.max(rpm, TUNE.idleRpm + this.throttle * 900 * (1 - wheelRpm / 1400));
    }
    this.rpm = clamp(rpm, TUNE.idleRpm, TUNE.maxRpm + 40);

    const running = this.engineOn && this.fuel > 0;
    const limiter = this.rpm >= TUNE.maxRpm ? 0.15 : 1;
    const torque = torqueAtRpm(this.rpm) * this.throttle * limiter * (running ? 1 : 0);

    const effRadius = this._effRadius();
    const axleForce = (torque * totalRatio * TUNE.drivetrainEfficiency) / effRadius;

    // 40 % front / 60 % rear when in AWD, otherwise rear-wheel drive only.
    const shares = this.awd ? [0.2, 0.2, 0.3, 0.3] : [0, 0, 0.5, 0.5];

    // Engine braking: closing the throttle drags against wheel rotation.
    const engineBrake = running && this.throttle < 0.05 ? -(Math.sign(omegaAvg) || 0) * (this.rpm / TUNE.maxRpm) * 900 : 0;

    for (let i = 0; i < 4; i += 1) {
      const force = axleForce * shares[i] + engineBrake * (shares[i] > 0 ? 1 : 0);
      this.wheelTorque[i] = force * effRadius;
    }
  }

  _sampleSuspension(dt) {
    const body = this.body;
    const up = new CANNON.Vec3();
    body.quaternion.vmult(new CANNON.Vec3(0, 1, 0), up);
    const down = new CANNON.Vec3(-up.x, -up.y, -up.z);

    const effRadius = this._effRadius();
    const rayLength = TUNE.restLength + TUNE.maxDroop + effRadius + 0.06;
    const minLen = TUNE.restLength - TUNE.maxCompression;
    const maxLen = TUNE.restLength + TUNE.maxDroop;
    const refLoad = (TUNE.chassisMass * 9.82) / 4;
    const refPatch = refLoad / (TUNE.tireRefPsi * 6894.76);
    const patchArea = refPatch * (TUNE.tireRefPsi / this.psi);
    const flotation = clamp(Math.sqrt(patchArea / refPatch), 0.72, 1.45);

    let groundedCount = 0;
    let sinkTotal = 0;
    this.maxWaterDepth = 0;

    for (let i = 0; i < 4; i += 1) {
      const wheel = WHEELS[i];
      const attachLocal = new CANNON.Vec3(wheel.x, TUNE.attachY, wheel.z);
      const attach = body.pointToWorldFrame(attachLocal, new CANNON.Vec3());
      const rayEnd = new CANNON.Vec3(
        attach.x + down.x * rayLength,
        attach.y + down.y * rayLength,
        attach.z + down.z * rayLength,
      );

      this.rayResult.reset();
      const hit = this.world.raycastClosest(attach, rayEnd, this.rayOptions, this.rayResult);

      if (!hit) {
        // Rescue cast. If the strut has sunk so far that its downward ray now
        // starts below the surface (a crest, a landing, a steep facet), the
        // ray finds nothing and the truck is treated as airborne — so it keeps
        // falling through ground that is visibly right there. Cast back up
        // from below the failed ray end to see whether it is underground.
        const under = new CANNON.Vec3(
          rayEnd.x - down.x * 1.6,
          rayEnd.y - down.y * 1.6,
          rayEnd.z - down.z * 1.6,
        );
        this.rayResult.reset();
        const rescue = this.world.raycastClosest(under, attach, this.rayOptions, this.rayResult);
        if (rescue) {
          const buried = this.rayResult.distance + effRadius;
          const surf = this.surfaceProvider
            ? this.surfaceProvider(this.rayResult.hitPointWorld.x, this.rayResult.hitPointWorld.z)
            : SURFACES.hardpack;
          this.grounded[i] = true;
          this.suspLen[i] = clamp(buried, minLen, maxLen);
          this.comp[i] = TUNE.restLength - this.suspLen[i];
          this.smoothLen[i] = this.suspLen[i];
          this.prevLen[i] = this.suspLen[i];
          this.sink[i] = Math.max(0, buried - TUNE.restLength + effRadius);
          this.springForce[i] = TUNE.springStiffness * this.comp[i];
          this.load[i] = this.springForce[i];
          this.wheelSurface[i] = surf;
          this.contactNormal[i].set(0, 1, 0);
          this.contactPoint[i].set(
            this.rayResult.hitPointWorld.x,
            this.rayResult.hitPointWorld.y,
            this.rayResult.hitPointWorld.z,
          );
          groundedCount += 1;
          sinkTotal += this.sink[i];
          continue;
        }

        this.grounded[i] = false;
        this.suspLen[i] = maxLen;
        this.comp[i] = -TUNE.maxDroop;
        this.springForce[i] = 0;
        this.load[i] = 0;
        this.sink[i] = Math.max(0, this.sink[i] - dt * 2);
        this.wheelSurface[i] = SURFACES.hardpack;
        continue;
      }

      const result = this.rayResult;
      const hitBody = result.body;
      // Props keep their own tag; the terrain heightfield defers to the
      // provider so biome friction/sinkage can vary across the map.
      const propSurface =
        hitBody && hitBody.userData && !hitBody.userData.terrain && SURFACES[hitBody.userData.surface]
          ? SURFACES[hitBody.userData.surface]
          : null;
      const surface = propSurface
        || (this.surfaceProvider
          ? this.surfaceProvider(result.hitPointWorld.x, result.hitPointWorld.z)
          : SURFACES.hardpack);

      const wheelWater = surface.waterDepth || 0;
      if (wheelWater > this.maxWaterDepth) this.maxWaterDepth = wheelWater;

      const normal = new CANNON.Vec3(result.hitNormalWorld.x, result.hitNormalWorld.y, result.hitNormalWorld.z);
      normal.normalize();

      /* --- soft soil sinkage --- */
      if (surface.sinkage <= 0) {
        this.sink[i] = Math.max(0, this.sink[i] - dt * 3);
      } else {
        const loaded = clamp((this.load[i] || refLoad) / refLoad, 0.35, 1.8);
        const dig = 1 + surface.dig * Math.min(1, Math.abs(this.slip[i])) * (this.load[i] > refLoad * 0.5 ? 1 : 0.3);
        const target = Math.min(surface.sinkage * 1.6, surface.sinkage * (1 - 0.55 * this.deflation) * loaded * dig);
        this.sink[i] += (target - this.sink[i]) * Math.min(1, dt * 2.4);
      }

      /* --- strut length from the ray, sinking the wheel into soft ground --- */
      let length = result.distance + this.sink[i] - effRadius;
      length = clamp(length, minLen, maxLen);
      this.suspLen[i] = length;
      this.comp[i] = TUNE.restLength - length;

      // Low-pass the ray length at ~18 Hz: fast enough to follow a bump,
      // slow enough that facet edges are ironed out.
      this.smoothLen[i] += (length - this.smoothLen[i]) * Math.min(1, dt * 18);
      const smoothComp = TUNE.restLength - this.smoothLen[i];

      // Shaft speed from the raw ray, low-passed at ~30 Hz. The raw delta is
      // right for a real bump but spikes at every facet edge; left alone it
      // slammed the damper into its ceiling (10 kN on one corner) over ground
      // this low-poly. Filtering keeps the bump response and drops the spikes.
      const rawVel = this._firstStep ? 0 : (this.prevLen[i] - length) / dt;
      this.dampVel[i] += (clamp(rawVel, -2.2, 2.2) - this.dampVel[i]) * Math.min(1, dt * 30);
      let compressionVelocity = this.dampVel[i];
      const damping = compressionVelocity > 0 ? TUNE.dampingCompression : TUNE.dampingRebound;
      const force = TUNE.springStiffness * smoothComp + damping * compressionVelocity;

      // Force ceiling: a wheel can hold up a corner of the truck, not launch it.
      const maxStrutForce = (TUNE.chassisMass * 9.82) * 1.15;
      this.springForce[i] = clamp(force, 0, maxStrutForce);
      this.load[i] = this.springForce[i];
      this.prevLen[i] = length;
      this.grounded[i] = true;
      this.wheelSurface[i] = surface;
      this.contactNormal[i].set(normal.x, normal.y, normal.z);
      this.contactPoint[i].set(
        result.hitPointWorld.x - normal.x * this.sink[i],
        result.hitPointWorld.y - normal.y * this.sink[i],
        result.hitPointWorld.z - normal.z * this.sink[i],
      );

      groundedCount += 1;
      sinkTotal += this.sink[i];
    }

    /* --- anti-roll bars: resist roll by lifting the compressed side --- */
    // The sign matters more than the stiffness. A compressed corner has to be
    // pushed UP (and the extended one down) to produce a righting moment; the
    // old code did the opposite, so the bars fed roll instead of damping it and
    // a truck parked across a 23 degree sidehill lay down on its roof in four
    // seconds. The difference is also taken from the smoothed compression, not
    // the raw ray: facet edges are 3 cm steps and were being read as roll.
    this.arbForce.fill(0);
    const smoothComp = (i) => TUNE.restLength - this.smoothLen[i];
    if (this.grounded[0] && this.grounded[1]) {
      const diff = smoothComp(0) - smoothComp(1);
      this.arbForce[0] = TUNE.antiRollStiffness * diff;
      this.arbForce[1] = -TUNE.antiRollStiffness * diff;
    }
    if (this.grounded[2] && this.grounded[3]) {
      const diff = smoothComp(2) - smoothComp(3);
      this.arbForce[2] = TUNE.antiRollStiffness * diff;
      this.arbForce[3] = -TUNE.antiRollStiffness * diff;
    }

    const springCeiling = (TUNE.chassisMass * 9.82) * 1.15;
    const arbLimit = (TUNE.chassisMass * 9.82) * 0.45;
    for (let i = 0; i < 4; i += 1) {
      if (!this.grounded[i]) continue;
      // Clamp the bar's own contribution, not the corner's total. Capping the
      // total at 45 % of the vehicle weight meant two wheels could only ever
      // carry 90 % of it: as soon as the uphill pair unloaded, the truck had to
      // fall, which is the other half of the sidehill rollover.
      const arb = clamp(this.arbForce[i], -arbLimit, arbLimit);
      const total = clamp(this.springForce[i] + arb, 0, springCeiling);
      this.load[i] = total;
      this.body.applyLocalForce(
        new CANNON.Vec3(0, total, 0),
        new CANNON.Vec3(WHEELS[i].x, TUNE.attachY, WHEELS[i].z),
      );
    }

    this.groundedCount = groundedCount;
    this.sinkAvg = groundedCount > 0 ? sinkTotal / groundedCount : 0;

    // Phase-5 multiplayer: publish per-wheel sinkage so teammates see your
    // tracks and co-op winch can read how bogged a vehicle is.
    for (let i = 0; i < 4; i += 1) {
      this.wheelSink[i] = this.sink[i];
      this.wheelBounds[i] = this.comp[i] > 0 ? 1 : 0;
    }
    this.steeringAngle = this.steerAngle;
    this.wheelRotation = this.spinAngle[3];

    /* --- dominant surface for the HUD --- */
    const counts = {};
    for (let i = 0; i < 4; i += 1) {
      if (!this.grounded[i]) continue;
      const key = this.wheelSurface[i].key;
      counts[key] = (counts[key] || 0) + 1;
    }
    let best = 'hardpack';
    let bestCount = -1;
    for (const key of Object.keys(counts)) {
      if (counts[key] > bestCount) {
        best = key;
        bestCount = counts[key];
      }
    }
    this.surfaceKey = best;
    let bestLabel = '';
    for (let i = 0; i < 4; i += 1) {
      if (!this.grounded[i]) continue;
      if (this.wheelSurface[i].key === best) {
        bestLabel = this.wheelSurface[i].label || best;
        break;
      }
    }
    this.surfaceLabel = bestLabel || best;
  }

  /**
   * Water: below the fording limit it is drag at each contact patch; above it
   * the engine floods and stalls until the intake is clear again.
   */
  _updateWater(dt) {
    this.waterDepth = this.maxWaterDepth;
    const limit = this.waterDepthLimit;

    if (this.waterDepth > limit) {
      if (!this.flooded) {
        this.flooded = true;
        this.engineOn = false;
        this.throttle = 0;
        this.throttleTarget = 0;
      }
      this.drainTimer = 1.6;
    } else if (this.flooded) {
      this.drainTimer = Math.max(0, this.drainTimer - dt);
      if (this.drainTimer === 0) {
        this.flooded = false;
        this.engineOn = true;
      }
    }
  }

  _applyTireForces(dt) {
    const body = this.body;
    const effRadius = this._effRadius();
    let antiSquatForce = 0;

    /* --- friction capacity per wheel, needed for the diff model --- */
    for (let i = 0; i < 4; i += 1) {
      const surface = this.wheelSurface[i];
      let mu = surface.grip * this.psiGripFactor;
      if (surface.sinkage > 0) {
        mu *= 1 - 0.22 * clamp(this.sink[i] / surface.sinkage, 0, 1);
      }
      this.cap[i] = this.grounded[i] ? mu * this.load[i] : 0;
    }

    /* --- open differential: an axle is limited by its weakest wheel --- */
    for (const axle of ['front', 'rear']) {
      const pair = axle === 'front' ? [0, 1] : [2, 3];
      if (this.diffLock) {
        this.driveCap[pair[0]] = this.cap[pair[0]];
        this.driveCap[pair[1]] = this.cap[pair[1]];
      } else {
        const shared = Math.min(this.cap[pair[0]], this.cap[pair[1]]);
        this.driveCap[pair[0]] = shared;
        this.driveCap[pair[1]] = shared;
      }
    }

    for (let i = 0; i < 4; i += 1) {
      const wheel = WHEELS[i];
      const surface = this.wheelSurface[i];
      const grounded = this.grounded[i];
      const normalLoad = this.load[i];
      const steer = this.wheelSteer[i];

      /* --- build the wheel's contact frame on the surface plane --- */
      let fwd = new CANNON.Vec3();
      body.quaternion.vmult(new CANNON.Vec3(0, 0, 1), fwd);
      const n = this.contactNormal[i];
      if (grounded) {
        const projection = fwd.dot(n);
        fwd.set(fwd.x - n.x * projection, fwd.y - n.y * projection, fwd.z - n.z * projection);
        if (fwd.normalize() < 0.2) fwd.set(0, 0, 1);
        if (Math.abs(steer) > 1e-4) {
          const steerQuat = new CANNON.Quaternion();
          steerQuat.setFromAxisAngle(n, steer);
          steerQuat.vmult(fwd, fwd);
        }
      } else {
        fwd.normalize();
      }

      const side = new CANNON.Vec3();
      n.cross(fwd, side);
      side.normalize();

      const contact = this.contactPoint[i];
      const velocity = body.getVelocityAtWorldPoint(contact, new CANNON.Vec3());
      const vLong = velocity.dot(fwd);
      const vLat = velocity.dot(side);

      const surfaceSpeed = this.omega[i] * effRadius;
      const referenceSpeed = Math.max(Math.abs(vLong), 2);
      const slipRatio = (surfaceSpeed - vLong) / referenceSpeed;
      this.slip[i] = slipRatio;

      let forceLong = 0;
      let forceLat = 0;

      if (grounded) {
        const cap = this.cap[i];
        forceLong = cap * Math.tanh(slipRatio * TUNE.slipStiffness);
        forceLat = -clamp(vLat * TUNE.lateralStiffness, -1, 1) * cap;

        const magnitude = Math.hypot(forceLong, forceLat);
        if (magnitude > cap && magnitude > 1e-6) {
          const scale = cap / magnitude;
          forceLong *= scale;
          forceLat *= scale;
        }

        /* rolling resistance grows as the tyres flatten */
        const roll = surface.rollResistance * (1 + 1.1 * this.deflation) * normalLoad;
        if (Math.abs(vLong) > 0.05) forceLong -= Math.sign(vLong) * roll;

        antiSquatForce += forceLong;

        /* water pushes back hard once the tyre is submerged */
        const waterDepth = surface.waterDepth || 0;
        if (waterDepth > 0) {
          const waterDrag = 700 * waterDepth;
          body.applyForce(
            new CANNON.Vec3(
              -velocity.x * waterDrag,
              -velocity.y * waterDrag,
              -velocity.z * waterDrag,
            ),
            new CANNON.Vec3(contact.x - body.position.x, contact.y - body.position.y, contact.z - body.position.z),
          );
        }

        /* viscous drag of a deep medium, applied separately at the contact */
        const viscous = surface.viscosity * this.sink[i];
        if (viscous > 0) {
          body.applyForce(
            new CANNON.Vec3(-velocity.x * viscous, -velocity.y * viscous, -velocity.z * viscous),
            new CANNON.Vec3(contact.x - body.position.x, contact.y - body.position.y, contact.z - body.position.z),
          );
        }

        body.applyForce(
          new CANNON.Vec3(
            fwd.x * forceLong + side.x * forceLat,
            fwd.y * forceLong + side.y * forceLat,
            fwd.z * forceLong + side.z * forceLat,
          ),
          new CANNON.Vec3(contact.x - body.position.x, contact.y - body.position.y, contact.z - body.position.z),
        );
      }

      /* --- wheel spin: drive torque in, friction reaction out --- */
      const driveTorque = clamp(this.wheelTorque[i], -this.driveCap[i] * effRadius, this.driveCap[i] * effRadius);
      let angularAccel = (driveTorque - forceLong * effRadius) / TUNE.wheelInertia;
      if (!grounded) angularAccel = driveTorque / TUNE.wheelInertia;
      this.omega[i] += angularAccel * dt;

      const brakeTorque =
        this.brakeInput * TUNE.maxBrakeTorque * (this.handbrake && wheel.axle === 'rear' ? 1.5 : 1);
      this.omega[i] = moveTowards(this.omega[i], 0, (brakeTorque / TUNE.wheelInertia) * dt);
      this.omega[i] = clamp(this.omega[i], -160, 160);
    }

    /* --- anti-squat: the axle links absorb part of the pitch moment that the
       horizontal tyre force would otherwise put into the chassis. --- */
    if (antiSquatForce !== 0) {
      const right = new CANNON.Vec3();
      body.quaternion.vmult(new CANNON.Vec3(1, 0, 0), right);
      const moment = antiSquatForce * TUNE.comHeight * TUNE.antiSquat;
      body.torque.x += right.x * moment;
      body.torque.y += right.y * moment;
      body.torque.z += right.z * moment;
    }

    /* --- handbrake when no brake pedal is held still locks the rear axle --- */
    if (this.handbrake && this.brakeInput < 0.05) {
      for (const index of [2, 3]) {
        this.omega[index] = moveTowards(this.omega[index], 0, (TUNE.handbrakeTorque / TUNE.wheelInertia) * dt);
      }
    }
  }

  _updateFuel(dt) {
    const rpmNorm = clamp((this.rpm - TUNE.idleRpm) / (TUNE.maxRpm - TUNE.idleRpm), 0, 1.15);
    let lpm = 0;

    if (this.engineOn && this.fuel > 0) {
      const load = this.throttle * rpmNorm;
      lpm = 0.45 + load * 5.2;
      if (this.awd) lpm *= 1.07;
      if (this.diffLock) lpm *= 1.03;
      lpm += this.sinkAvg * 3.2 * Math.min(1, this.speed / 4);
      lpm += this.deflation * (this.surfaceKey === 'hardpack' ? 0.35 : 0.12);
      lpm += Math.min(0.6, this.speed * 0.012);
    }

    this.fuelLpm = this.fuelLpm + (lpm - this.fuelLpm) * Math.min(1, dt * 3);
    this.fuel = Math.max(0, this.fuel - (this.fuelLpm / 60) * dt);
    if (this.fuel <= 0) this.engineOn = false;
  }

  /* ================= visuals ================= */

  _applyTireDeflation() {
    if (this.builder) this.builder.setTirePressure(this.psi);
  }

  syncVisuals(alpha = 1, dt = 1 / 60) {
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
      // The pivot now lives on the axle group, which already carries the
      // suspension travel and the beam's roll, so only steering and spin are
      // written here.
      const visual = this.wheelVisuals[i];
      visual.pivot.rotation.y = this.wheelSteer[i];
      visual.spin.rotation.x = this.spinAngle[i];
    }

    // Phase 9: the rest of the running gear — articulating axles, springs that
    // compress, body roll/pitch and the mud that comes home on the treads.
    if (this.builder && this.builder.updateRig) {
      this.builder.updateRig({
        suspLen: this.suspLen,
        wheelSteer: this.wheelSteer,
        spin: this.spinAngle,
        attachY: TUNE.attachY,
        surfaces: this.wheelSurface,
        dt,
      });
    }
  }

  /* ================= modular accessories ================= */

  get fuelCapacity() {
    return TUNE.tankCapacity + (this.accessories.jerryCans ? ACCESSORIES.jerryCans.fuelBonus : 0);
  }

  get waterDepthLimit() {
    return this.accessories.snorkel ? ACCESSORIES.snorkel.waterDepth : 0.8;
  }

  get winchMultiplier() {
    return this.accessories.bullbar ? ACCESSORIES.bullbar.winchMultiplier : 1;
  }

  hasAccessory(id) {
    return !!this.accessories[id];
  }

  setAccessory(id, enabled) {
    const def = ACCESSORIES[id];
    if (!def) return false;
    const on = !!enabled;

    if (on && def.requires && !this.accessories[def.requires]) return false;

    this.accessories[id] = on;
    if (!on && id === 'roofRack') this.accessories.jerryCans = false;

    if (id === 'jerryCans') {
      this.fuel = on ? Math.min(this.fuelCapacity, this.fuel + def.fuelBonus) : Math.min(this.fuel, this.fuelCapacity);
    }

    this._applyAccessories();
    return this.accessories[id];
  }

  toggleAccessory(id) {
    return this.setAccessory(id, !this.accessories[id]);
  }

  /**
   * Mass, centre-of-mass height and the visual groups all follow from the
   * fitted accessory set. The body origin is the centre of mass, so lowering
   * the chassis shape within it is what actually raises the CoM.
   */
  _applyAccessories() {
    let mass = TUNE.chassisMass;
    let comRise = 0;

    for (const id of ACCESSORY_ORDER) {
      const on = !!this.accessories[id];
      const def = ACCESSORIES[id];
      if (on) {
        mass += def.mass;
        comRise += def.comRise;
      }
      this.builder.setAccessory(id, on);
    }

    this.body.mass = mass;
    this.body.shapeOffsets[0].set(0, TUNE.chassisOffsetY - comRise, 0);
    // Moving a shape does not invalidate the cached AABB either; a stale or
    // non-finite AABB silently drops the body out of every broadphase pair.
    this.body.aabbNeedsUpdate = true;
    this.body.updateMassProperties();
    this.body.wakeUp();
  }

  setPaint(hex) {
    this.paintHex = hex;
    this.builder.setPaint(hex);
  }

  setHeadlights(on) {
    this.headlightsOn = !!on;
    this.builder.setHeadlights(this.headlightsOn);
    return this.headlightsOn;
  }

  get hitchLocalPoint() {
    return this.builder.socketLocal('hitch');
  }

  getTelemetry() {
    return {
      speedKmh: this.speed * 3.6,
      rpm: this.rpm,
      rpmPct: clamp(this.rpm / TUNE.maxRpm, 0, 1),
      gear: this.gearLabel,
      gearId: GEAR_ORDER[this.gearIndex],
      helpPing: !!this.helpPingActive,
      fuel: this.fuel,
      fuelLpm: this.fuelLpm,
      fuelPct: this.fuel / this.fuelCapacity,
      fuelCapacity: this.fuelCapacity,
      psi: this.psi,
      psiGrip: this.psiGripFactor,
      deflation: this.deflation,
      awd: this.awd,
      diffLock: this.diffLock,
      engineOn: this.engineOn,
      surface: this.surfaceLabel,
      sinkCm: this.sinkAvg * 100,
      grounded: this.groundedCount,
      suspension: Array.from(this.comp).map((value) => value / TUNE.maxCompression),
      slip: Array.from(this.slip),
      wheels: WHEELS.map((wheel) => wheel.id),
      accessories: { ...this.accessories },
      waterDepth: this.waterDepthLimit,
      winchMultiplier: this.winchMultiplier,
      headlights: this.headlightsOn,
      paintHex: this.paintHex,
      // Phase-5 multiplayer telemetry (populated by WinchSystem / NetworkManager).
      wheelSink: this.wheelSink ?? [0, 0, 0, 0],
      wheelBounds: this.wheelBounds ?? [0, 0, 0, 0],
      steeringAngle: this.steeringAngle ?? 0,
      wheelRotation: this.wheelRotation ?? 0,
      localPlayerId: this.localPlayerId,
    };
  }
}

export const VEHICLE_TUNE = TUNE;

export const VEHICLE_ACCESSORIES = ACCESSORIES;
export const VEHICLE_GEARS = GEAR_ORDER;
