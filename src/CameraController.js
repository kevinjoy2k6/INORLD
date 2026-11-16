import * as THREE from 'three';
import * as CANNON from 'cannon-es';

export const CAMERA_MODE = {
  CINEMATIC: 'cinematic',
  TACTICAL: 'tactical',
};

export const CAMERA_MODE_LABEL = {
  cinematic: 'OVER THE HILL',
  tactical: 'SNOWRUNNER',
};

/** Short forms that fit the HUD column. */
export const CAMERA_MODE_SHORT = {
  cinematic: 'CINEMATIC',
  tactical: 'TACTICAL',
};

export const FOCUS_MODE = {
  AUTO: 'auto',
  WHEEL: 'wheel',
  TRAILER: 'trailer',
};

export const FOCUS_LABEL = {
  auto: 'AUTO',
  wheel: 'WHEEL',
  trailer: 'TRAILER',
};

const FOCUS_ORDER = [FOCUS_MODE.AUTO, FOCUS_MODE.WHEEL, FOCUS_MODE.TRAILER];

/** Frame-rate independent exponential damping. */
function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Same, but taking the short way around the circle. */
function angleDamp(current, target, lambda, dt) {
  let delta = target - current;
  delta = Math.atan2(Math.sin(delta), Math.cos(delta));
  return current + delta * (1 - Math.exp(-lambda * dt));
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * Dual-mode camera.
 *
 *  CINEMATIC  Wide, elevated follow camera with exponential spring damping,
 *             velocity look-ahead, climb-aware pitch and automatic framing
 *             that widens when a co-op truck is nearby.
 *  TACTICAL   Close inspection orbit: drag to look around, with presets for a
 *             wheel/underbody close-up and a trailer check.
 *
 * Mode changes do not cut: the desired pose jumps, and a temporarily softer
 * damping constant glides the camera across to it.
 */
export class CameraController {
  constructor(camera, { vehicle, trailer = null, world = null, groundMask = 1 } = {}) {
    this.camera = camera;
    // Phase 8 control settings (written by PerformanceOptimizer).
    this.invertX = false;
    this.invertY = false;
    this.vehicle = vehicle;
    this.trailer = trailer;
    this.world = world;
    this.groundMask = groundMask;

    this.mode = CAMERA_MODE.CINEMATIC;
    this.focus = FOCUS_MODE.AUTO;
    this.teammates = [];

    /* ---- cinematic state ---- */
    this.cineDistance = 10.4;
    this.cineDistanceTarget = 10.4;
    this.heading = 0;
    this.lead = new THREE.Vector3();
    this.pitchAdapt = 0;

    /* ---- tactical orbit state ---- */
    this.orbitYaw = 0;
    this.orbitYawTarget = 0;
    this.orbitPitch = 0.3;
    this.orbitPitchTarget = 0.3;
    this.orbitDistance = 7;
    this.orbitDistanceTarget = 7;

    /* ---- rendered pose, damped every frame ---- */
    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.fov = 58;
    this.transition = 0;
    this.initialised = false;
    // Distance actually used for the pose, after framing and rig adjustments.
    this._effectiveDistance = 10.4;

    this._forward = new THREE.Vector3();
    this._desiredPos = new THREE.Vector3();
    this._desiredTarget = new THREE.Vector3();
    this._wheelPos = new THREE.Vector3();
    this._trailerPos = new THREE.Vector3();
    this._tmp = new THREE.Vector3();

    this._rayFrom = new CANNON.Vec3();
    this._rayTo = new CANNON.Vec3();
    this._rayResult = new CANNON.RaycastResult();
    this._rayOptions = {
      collisionFilterGroup: 8,
      collisionFilterMask: groundMask,
      skipBackfaces: true,
      checkCollisionResponse: false,
    };
  }

  /* ================= public API ================= */

  setMode(mode) {
    if (!CAMERA_MODE_LABEL[mode] || mode === this.mode) return this.mode;
    this.mode = mode;
    this.transition = 0.85;

    if (mode === CAMERA_MODE.TACTICAL) {
      // Enter inspection mode already looking at the truck from a 3/4 angle.
      this.orbitYawTarget = 0.85;
      this.orbitPitchTarget = 0.26;
      this.orbitDistanceTarget = 7;
    }
    return this.mode;
  }

  toggleMode() {
    return this.setMode(
      this.mode === CAMERA_MODE.CINEMATIC ? CAMERA_MODE.TACTICAL : CAMERA_MODE.CINEMATIC,
    );
  }

  setFocus(focus) {
    if (!FOCUS_LABEL[focus]) return this.focus;
    this.focus = focus;

    switch (focus) {
      case FOCUS_MODE.WHEEL:
        // Negative yaw keeps the camera on the sunlit flank; viewed from the
        // shaded side the tyre reads as a black silhouette.
        this.orbitYawTarget = -1.15;
        this.orbitPitchTarget = 0.07;
        this.orbitDistanceTarget = 4.6;
        break;
      case FOCUS_MODE.TRAILER:
        this.orbitYawTarget = 0.9;
        this.orbitPitchTarget = 0.2;
        this.orbitDistanceTarget = 12;
        break;
      default:
        this.orbitYawTarget = 0.85;
        this.orbitPitchTarget = 0.26;
        this.orbitDistanceTarget = 7;
        break;
    }
    this.transition = 0.7;
    return this.focus;
  }

  cycleFocus() {
    if (this.mode !== CAMERA_MODE.TACTICAL) this.setMode(CAMERA_MODE.TACTICAL);
    const next = FOCUS_ORDER[(FOCUS_ORDER.indexOf(this.focus) + 1) % FOCUS_ORDER.length];
    return this.setFocus(next);
  }

  /** Called with the remote trucks' positions once co-op is live. */
  setTeammates(list) {
    this.teammates = Array.isArray(list) ? list : [];
  }

  orbit(deltaX, deltaY) {
    // Phase 8: the player can invert either orbit axis from Settings.
    const dx = this.invertX ? -deltaX : deltaX;
    const dy = this.invertY ? -deltaY : deltaY;
    if (this.mode === CAMERA_MODE.TACTICAL) {
      this.orbitYawTarget -= dx * 0.0065;
      this.orbitPitchTarget = clamp(this.orbitPitchTarget + dy * 0.0045, -0.15, 1.2);
    } else {
      // In cinematic mode a drag only nudges the yaw a little, then it recovers.
      this.cineDistanceTarget = clamp(this.cineDistanceTarget + dy * 0.02, 6, 20);
    }
  }

  /** Factor > 1 moves away, < 1 moves closer. */
  zoomBy(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (this.mode === CAMERA_MODE.TACTICAL) {
      this.orbitDistanceTarget = clamp(this.orbitDistanceTarget * factor, 3, 20);
    } else {
      this.cineDistanceTarget = clamp(this.cineDistanceTarget * factor, 6.5, 24);
    }
  }

  get modeLabel() {
    return CAMERA_MODE_LABEL[this.mode];
  }

  get modeShort() {
    return CAMERA_MODE_SHORT[this.mode];
  }

  get focusLabel() {
    return FOCUS_LABEL[this.focus];
  }

  getState() {
    return {
      mode: this.mode,
      focus: this.focus,
      modeLabel: this.modeLabel,
      focusLabel: this.focusLabel,
      fov: this.fov,
      distance: this._effectiveDistance,
    };
  }

  /* ================= per-frame ================= */

  update(dt) {
    const body = this.vehicle.body;
    const forward = this._forward.set(0, 0, 1).applyQuaternion(this.vehicle.group.quaternion);

    const heading = Math.atan2(forward.x, forward.z);
    // Cinematic tracks the heading tightly; tactical drifts so an inspection
    // angle survives a small steering input.
    const headingRate = this.mode === CAMERA_MODE.CINEMATIC ? 4.4 : 1.3;
    this.heading = angleDamp(this.heading, heading, headingRate, dt);

    this.transition = Math.max(0, this.transition - dt);

    const desired = this.mode === CAMERA_MODE.CINEMATIC
      ? this._cinematicPose(dt, forward)
      : this._tacticalPose(dt);

    /* ---- damp the rendered pose toward the desired one ---- */
    let positionLambda = this.mode === CAMERA_MODE.CINEMATIC ? 5.2 : 9.5;
    let targetLambda = this.mode === CAMERA_MODE.CINEMATIC ? 7.5 : 12;
    if (this.transition > 0) {
      // Softer while switching so the jump reads as a move, not a cut.
      positionLambda = 3.4;
      targetLambda = 4.2;
    }

    if (!this.initialised) {
      this.position.copy(desired.position);
      this.target.copy(desired.target);
      this.fov = desired.fov;
      this.initialised = true;
    } else {
      this.position.lerp(desired.position, 1 - Math.exp(-positionLambda * dt));
      this.target.lerp(desired.target, 1 - Math.exp(-targetLambda * dt));
      this.fov = damp(this.fov, desired.fov, 4, dt);
    }

    this._avoidGround(this.mode === CAMERA_MODE.TACTICAL ? 0.75 : 1.3);

    this.camera.position.copy(this.position);
    this.camera.lookAt(this.target);

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  _cinematicPose(dt, forward) {
    const body = this.vehicle.body;
    const position = this._desiredPos;
    const target = this._desiredTarget;

    /* ---- velocity look-ahead, capped so it never outruns the truck ---- */
    this._tmp.set(body.velocity.x * 0.3, 0, body.velocity.z * 0.3);
    if (this._tmp.length() > 3.5) this._tmp.setLength(3.5);
    this.lead.lerp(this._tmp, 1 - Math.exp(-dt * 3.2));

    /* ---- subtle climb adaptation: rise and look further up the slope ---- */
    const slope = forward.y;
    this.pitchAdapt = damp(this.pitchAdapt, slope * 0.85, 2.4, dt);

    this.cineDistance = damp(this.cineDistance, this.cineDistanceTarget, 3.5, dt);

    // Closer and lower than a surveillance drone: at 13.6 m and 24 degrees the
    // truck is a small yellow speck and you are looking down on the meadow
    // rather than across it. 10.4 m at 17 degrees puts the horizon back in the
    // frame and lets the truck carry the shot.
    let distance = this.cineDistance + Math.max(0, this.pitchAdapt) * 1.8;
    let pitch = 0.3 - this.pitchAdapt * 0.1;
    let fov = 58;
    let frameShift = 0;

    /* ---- co-op framing: widen and re-centre for a nearby partner ---- */
    if (this.teammates.length > 0) {
      let nearest = Infinity;
      let nearestTruck = null;
      for (const mate of this.teammates) {
        const dx = mate.x - body.position.x;
        const dz = mate.z - body.position.z;
        const distanceToMate = Math.hypot(dx, dz);
        if (distanceToMate < nearest) {
          nearest = distanceToMate;
          nearestTruck = mate;
        }
      }

      if (nearestTruck && nearest < 25) {
        const t = 1 - nearest / 25;
        const widen = t * t;
        distance += widen * 6.2;
        pitch += widen * 0.06;
        fov += widen * 5.5;
        frameShift = widen * 0.36;

        this._tmp.set(nearestTruck.x, nearestTruck.y, nearestTruck.z);
        target.copy(this._tmp).sub(this.vehicle.group.position).multiplyScalar(frameShift * 0.5);
        target.add(this.vehicle.group.position);
        target.y += 1.3;
      } else {
        target.set(body.position.x, body.position.y + 1.3, body.position.z);
      }
    } else {
      target.set(body.position.x, body.position.y + 1.3, body.position.z);
    }

    target.x += this.lead.x;
    target.z += this.lead.z;

    const yaw = this.heading;
    const horizontal = Math.cos(pitch) * distance;
    const height = Math.sin(pitch) * distance;

    position.set(
      target.x - Math.sin(yaw) * horizontal,
      target.y + height,
      target.z - Math.cos(yaw) * horizontal,
    );

    /* ---- speed opens the lens ----
     * A fixed field of view makes speed feel like a slideshow. Widening it
     * slightly as you gather pace (and easing the camera back a touch) is the
     * cheapest, most reliable way to make 40 km/h feel like 40 km/h. */
    const pace = Math.min(1, Math.abs(this.vehicle.speed || 0) / 22);
    const paceEase = pace * pace;
    fov += paceEase * 7.5;
    distance += paceEase * 0.9;

    this._effectiveDistance = distance;
    return { position, target, fov };
  }

  _tacticalPose(dt) {
    const body = this.vehicle.body;
    const position = this._desiredPos;
    const target = this._desiredTarget;

    this.orbitYaw = angleDamp(this.orbitYaw, this.orbitYawTarget, 9, dt);
    this.orbitPitch = damp(this.orbitPitch, this.orbitPitchTarget, 9, dt);
    this.orbitDistance = damp(this.orbitDistance, this.orbitDistanceTarget, 8, dt);

    // Local, so a rig-length override never fights the damped user distance.
    let distance = this.orbitDistance;

    /* ---- pick the focus point ---- */
    if (this.focus === FOCUS_MODE.WHEEL) {
      this._mostLoadedWheel(target);
      target.y += 0.12;
    } else if (this.focus === FOCUS_MODE.TRAILER && this.trailer) {
      const trailerBody = this.trailer.body;
      this._trailerPos.set(trailerBody.position.x, trailerBody.position.y, trailerBody.position.z);

      if (this.trailer.hitched) {
        // Frame the whole rig: aim between the truck and the trailer.
        target.set(
          (body.position.x + this._trailerPos.x) * 0.5,
          Math.max(body.position.y, this._trailerPos.y) + 1.1,
          (body.position.z + this._trailerPos.z) * 0.5,
        );
        const rigLength = Math.hypot(
          body.position.x - this._trailerPos.x,
          body.position.z - this._trailerPos.z,
        );
        distance = Math.max(distance, rigLength * 0.55 + 7);
      } else {
        target.copy(this._trailerPos);
        target.y += 1.0;
      }
    } else {
      target.set(body.position.x, body.position.y + 1.2, body.position.z);
    }

    const yaw = this.heading + this.orbitYaw;
    const horizontal = Math.cos(this.orbitPitch) * distance;
    const height = Math.sin(this.orbitPitch) * distance;

    position.set(
      target.x - Math.sin(yaw) * horizontal,
      target.y + height,
      target.z - Math.cos(yaw) * horizontal,
    );

    this._effectiveDistance = distance;
    return { position, target, fov: 62 };
  }

  _mostLoadedWheel(target) {
    const wheels = this.vehicle.wheelVisuals || [];
    if (wheels.length === 0) return target.copy(this.vehicle.group.position);

    // Only consider the flank facing the camera, or the close-up aims through
    // the body at a hidden far-side corner.
    const side = Math.sign(-Math.sin(this.orbitYaw)) || 1;
    let bestIndex = -1;
    let bestCompression = -Infinity;
    for (let i = 0; i < wheels.length; i += 1) {
      if (Math.sign(wheels[i].pivot.position.x) !== side) continue;
      const compression = this.vehicle.comp[i];
      if (compression > bestCompression) {
        bestCompression = compression;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) bestIndex = 0;
    wheels[bestIndex].pivot.getWorldPosition(target);
    return target;
  }

  /** Lift the camera out of the dirt when it dips below the surface. */
  _avoidGround(clearance) {
    if (!this.world) return;
    const position = this.position;
    this._rayFrom.set(position.x, position.y + 25, position.z);
    this._rayTo.set(position.x, position.y - 25, position.z);
    this._rayResult.reset();

    const hit = this.world.raycastClosest(
      this._rayFrom,
      this._rayTo,
      this._rayOptions,
      this._rayResult,
    );

    if (hit) {
      const groundY = this._rayResult.hitPointWorld.y;
      if (position.y < groundY + clearance) position.y = groundY + clearance;
    }
  }
}
