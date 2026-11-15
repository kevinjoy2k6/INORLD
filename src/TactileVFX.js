/* ============================================================================
 * TactileVFX — the gritty mechanical layer
 *
 *  1. Chassis torque twist: the body leans against the engine's torque in low
 *     gears and shivers at high RPM / over rocks.
 *  2. Visible running gear: solid axle housings, coil springs that really
 *     compress with each wheel, panhard bars and spinning driveshafts.
 *  3. Mud / snow coating: tyres and lower panels pick up wet muck or packed
 *     snow that washes off in the river.
 *  4. GPU-instanced particles: rooster tails of mud/sand/snow, diesel soot
 *     from the exhaust (or snorkel), and river splash + expanding foam rings.
 *
 * Everything is pooled and instanced — no allocation in the frame loop.
 * ========================================================================== */

import * as THREE from 'three';

const PARTICLE_MAX = {
  throw: 260,
  exhaust: 140,
  splash: 90,
  ripple: 36,
};

function damp(current, target, lambda, dt) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/* ------------------------------------------------------------------ */
class ParticlePool {
  constructor(count, geometry, material, { gravity = -9.8, drag = 0.6 } = {}) {
    this.count = count;
    this.gravity = gravity;
    this.drag = drag;

    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.count = count;

    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.size = new Float32Array(count);

    this.cursor = 0;
    this.limit = count; // Phase 8: particle budget cuts this at runtime
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();

    // Park every instance at the origin, scaled to nothing.
    this._m.makeScale(0, 0, 0);
    for (let i = 0; i < count; i += 1) this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  spawn(x, y, z, vx, vy, vz, life, size) {
    if (this.limit <= 0) return;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.limit;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
  }

  update(dt) {
    const { pos, vel, life, maxLife, size } = this;
    const count = this.limit;
    for (let i = 0; i < count; i += 1) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      const i3 = i * 3;
      const k = Math.exp(-this.drag * dt);
      vel[i3] *= k;
      vel[i3 + 1] = vel[i3 + 1] * k + this.gravity * dt;
      vel[i3 + 2] *= k;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      const t = Math.max(0, life[i] / maxLife[i]);
      const s = size[i] * (0.35 + 0.65 * t);
      this._p.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
      this._s.set(s, s, s);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
      if (life[i] <= 0) {
        this._m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this._m);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
export class TactileVFX {
  constructor({ scene, vehicle, trailer, terrain, quality }) {
    this.scene = scene;
    this.vehicle = vehicle;
    this.trailer = trailer;
    this.terrain = terrain;
    this.quality = quality;

    this.mud = 0; // 0..1 mud coating
    this.snow = 0; // 0..1 snow coating
    this.twist = 0;
    this.shake = 0;

    this._tmpV = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);

    this._buildParticles();
    this._captureMaterials();
  }

  /* ================================================================== *
   *  running gear (axles, springs, driveshafts, panhard bars)
   * ================================================================== */

  /* ================================================================== *
   *  particles
   * ================================================================== */

  _buildParticles() {
    // Mud / sand / snow clods thrown by spinning tyres.
    const chunkGeo = new THREE.IcosahedronGeometry(0.085, 0);
    const chunkMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });
    chunkMat.color.setHex(0xffffff); // multiplied by the per-instance colour
    this.throwPool = new ParticlePool(PARTICLE_MAX.throw, chunkGeo, chunkMat, { gravity: -13, drag: 1.4 });
    this.throwPool.mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(PARTICLE_MAX.throw * 3).fill(1),
      3,
    );
    this.scene.add(this.throwPool.mesh);
    this._throwColorPrefix = new Float32Array(PARTICLE_MAX.throw * 3);

    // Diesel soot / idle vapour: soft billboards.
    const puffGeo = new THREE.SphereGeometry(0.16, 6, 5);
    const puffMat = new THREE.MeshBasicMaterial({
      color: 0x22201e,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    this.exhaustPool = new ParticlePool(PARTICLE_MAX.exhaust, puffGeo, puffMat, { gravity: 0.55, drag: 1.1 });
    this.scene.add(this.exhaustPool.mesh);

    // Water droplets.
    const dropGeo = new THREE.SphereGeometry(0.06, 5, 4);
    const dropMat = new THREE.MeshBasicMaterial({ color: 0xdfeef6, transparent: true, opacity: 0.75 });
    this.splashPool = new ParticlePool(PARTICLE_MAX.splash, dropGeo, dropMat, { gravity: -11, drag: 1.2 });
    this.scene.add(this.splashPool.mesh);

    // Expanding foam rings on the water surface.
    const ringGeo = new THREE.RingGeometry(0.28, 0.42, 16);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xf2fbff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ripplePool = new ParticlePool(PARTICLE_MAX.ripple, ringGeo, ringMat, { gravity: 0, drag: 0.9 });
    this.scene.add(this.ripplePool.mesh);
    this._rippleScale = new Float32Array(PARTICLE_MAX.ripple);

    this._throwTimer = 0;
    this._exhaustTimer = 0;
    this._splashTimer = 0;
  }

  /** Grab the truck's shared materials so their colours can be coated. */
  _captureMaterials() {
    const mats = this.vehicle.builder?.materials;
    if (!mats) return;

    this.coat = {
      rubber: mats.rubber || null,
      paint: mats.paint || null,
      plastic: mats.darkPlastic || null,
      rim: mats.rim || null,
    };

    if (this.coat.rubber) {
      this.coat.rubberColor = this.coat.rubber.color.clone();
      this.coat.rubberRough = this.coat.rubber.roughness;
    }
    if (this.coat.plastic) {
      this.coat.plasticColor = this.coat.plastic.color.clone();
    }
  }

  /* ================================================================== *
   *  per-frame
   * ================================================================== */

  update(dt, now, telemetry) {
    const t = telemetry || this.vehicle.getTelemetry();
    this._updateTorqueAndShake(dt, t);
    this._updateCoating(dt, t);
    this._updateParticles(dt, t);

    this.throwPool.update(dt);
    this.exhaustPool.update(dt);
    this.splashPool.update(dt);
    this.ripplePool.update(dt);
  }

  _updateTorqueAndShake(dt, t) {
    const builder = this.vehicle.builder;
    if (!builder?.bodyGroup) return;

    // Torque twist: low-range + throttle leans the body against the driveline.
    const lowGear = t.gearId === 'L-' || t.gearId === 'L' ? 1 : t.gearId === 'L+' ? 0.6 : 0.25;
    const load = Math.min(1, (t.rpmPct || 0) * 0.7 + Math.abs(t.speedKmh) / 90 * 0.3);
    const targetTwist = -0.035 * lowGear * load * (0.4 + 0.6 * Math.min(1, t.rpmPct || 0));
    this.twist = damp(this.twist, targetTwist, 4.5, dt);

    // High-frequency shiver from the engine and from rough ground.
    const roughKey = this._roughSurface();
    const rough = roughKey === 'rock' || roughKey === 'snow' ? 1 : 0.35;
    const impact = (t.grounded ?? 4) < 4 ? 1.6 : 0;
    const amp = (0.0016 + 0.0042 * (t.rpmPct || 0)) * rough + impact * 0.004;
    this.shake = damp(this.shake, amp, 9, dt);
    const jitterY = (Math.random() - 0.5) * this.shake;
    const jitterX = (Math.random() - 0.5) * this.shake * 0.6;

    // The rig writes bodyGroup.rotation/position each frame; hand it the
    // twist and shiver instead of overwriting its suspension work.
    builder.twist = this.twist;
    builder.jitter.set(jitterX, jitterY);
  }

  /* ================================================================== *
   *  mud / snow coating
   * ================================================================== */

  _updateCoating(dt, t) {
    const v = this.vehicle;
    const key = (t.surface || '').toLowerCase();

    let mudGain = 0;
    let snowGain = 0;
    let wash = 0;

    for (let i = 0; i < 4; i += 1) {
      if (!v.grounded?.[i]) continue;
      const surf = v.wheelSurface?.[i]?.key || 'hardpack';
      const slip = Math.min(1, Math.abs(v.slip?.[i] || 0));
      if (surf === 'mud') mudGain += 0.35 + slip * 1.6;
      else if (surf === 'snow') snowGain += 0.3 + slip * 1.2;
      else if (surf === 'sand') mudGain += 0.08 * slip;
      else if (surf === 'water') wash += 1;
    }

    // The river crossing washes the truck clean: SURFACES has no water key,
    // so ask the terrain how deep it is here.
    const depth = this.terrain?.getWaterDepthAt?.(v.body.position.x, v.body.position.z) || 0;
    if (depth > 0.05) wash = Math.max(wash, 4);

    this.mud = THREE.MathUtils.clamp(this.mud + (mudGain * dt - wash * 1.9 * dt - 0.004 * dt), 0, 1);
    this.snow = THREE.MathUtils.clamp(this.snow + (snowGain * dt - wash * 1.9 * dt - 0.004 * dt), 0, 1);

    const coat = this.coat;
    if (!coat) return;

    if (coat.rubber && coat.rubberColor) {
      const target = new THREE.Color(0x121316);
      if (this.mud > 0.02) target.lerp(new THREE.Color(0x4a3620), this.mud * 0.85);
      if (this.snow > 0.02) target.lerp(new THREE.Color(0xd8e4ec), this.snow * 0.8);
      coat.rubber.color.copy(target);
      // Wet mud is glossier than dry rubber, packed snow is rougher.
      coat.rubber.roughness = THREE.MathUtils.clamp(
        coat.rubberRough - this.mud * 0.25 + this.snow * 0.04,
        0.4,
        1,
      );
    }

    if (coat.plastic && coat.plasticColor) {
      const target = coat.plasticColor.clone();
      if (this.mud > 0.02) target.lerp(new THREE.Color(0x3b2a17), this.mud * 0.8);
      if (this.snow > 0.02) target.lerp(new THREE.Color(0xc9d7e0), this.snow * 0.65);
      coat.plastic.color.copy(target);
    }
  }

  /* ================================================================== *
   *  particle emission
   * ================================================================== */

  _updateParticles(dt, t) {
    const v = this.vehicle;
    const speed = Math.abs(t.speedKmh || 0) / 3.6;

    /* --- tyre rooster tails ------------------------------------ */
    this._throwTimer += dt;
    const emitRate = this.quality.tier === 'LOW' ? 0.09 : 0.045;
    if (this._throwTimer > emitRate) {
      this._throwTimer = 0;
      for (let i = 0; i < 4; i += 1) {
        if (!v.grounded?.[i]) continue;
        const slip = Math.abs(v.slip?.[i] || 0);
        const surf = v.wheelSurface?.[i];
        if (!surf || surf.sinkage <= 0.02) continue;
        if (slip < 0.18 && speed < 1.5) continue;

        const c = v.contactPoint[i];
        const q = v.group.quaternion;
        // Rear wheels throw hardest; front wheels spray a little forward.
        const rear = i >= 2;
        const power = (rear ? 1 : 0.45) * (0.35 + Math.min(1.4, slip * 1.6));
        const back = new THREE.Vector3(0, 0.25, rear ? -1 : 0.4)
          .applyQuaternion(q)
          .multiplyScalar(1.6 + slip * 3.2);
        const jitter = () => (Math.random() - 0.5) * 2.2;

        const color = this._chunkColorFor(surf.key);
        const count = this.quality.tier === 'LOW' ? 1 : 2;
        for (let n = 0; n < count; n += 1) {
          const idx = this.throwPool.cursor;
          this.throwPool.spawn(
            c.x + jitter() * 0.18,
            c.y + 0.12,
            c.z + jitter() * 0.18,
            back.x * power + jitter(),
            1.4 + Math.random() * 2.4 * power,
            back.z * power + jitter(),
            0.5 + Math.random() * 0.5,
            0.7 + Math.random() * 0.9,
          );
          this._writeInstanceColor(this.throwPool.mesh, idx, color);
        }
      }
    }

    /* --- exhaust ------------------------------------------------- */
    this._exhaustTimer += dt;
    const puffs = t.rpmPct > 0.55 ? 0.05 : 0.24;
    if (this._exhaustTimer > puffs) {
      this._exhaustTimer = 0;
      const ex = this._exhaustPosition();
      const heavy = t.rpmPct > 0.55;
      const q = v.group.quaternion;
      const dir = new THREE.Vector3(0.1, 0.18, -1).applyQuaternion(q).normalize();
      this.exhaustPool.spawn(
        ex.x, ex.y, ex.z,
        dir.x * (1.2 + (heavy ? 1.6 : 0.4)) + (Math.random() - 0.5) * 0.4,
        dir.y * (1.2 + (heavy ? 1.6 : 0.4)) + (heavy ? 0.6 : 0.2),
        dir.z * (1.2 + (heavy ? 1.6 : 0.4)) + (Math.random() - 0.5) * 0.4,
        heavy ? 1.35 : 1.9,
        heavy ? 1.5 : 0.85,
      );
      this.exhaustPool.mesh.material.opacity = heavy ? 0.38 : 0.16;
    }

    /* --- water fording ------------------------------------------- */
    this._splashTimer += dt;
    const depthHere = this.terrain?.getWaterDepthAt?.(v.body.position.x, v.body.position.z) || 0;
    const inWater =
      depthHere > 0.05 ||
      (t.sinkCm || 0) > 8 ||
      (v.wheelSurface || []).some((s) => s?.key === 'water');
    if (inWater && speed > 0.6 && this._splashTimer > 0.06) {
      this._splashTimer = 0;
      for (let i = 0; i < 4; i += 1) {
        if (!v.grounded?.[i]) continue;
        const c = v.contactPoint[i];
        for (let n = 0; n < 2; n += 1) {
          this.splashPool.spawn(
            c.x + (Math.random() - 0.5) * 0.8,
            c.y + 0.15,
            c.z + (Math.random() - 0.5) * 0.8,
            (Math.random() - 0.5) * 3.2,
            2.2 + Math.random() * 3.2,
            (Math.random() - 0.5) * 3.2,
            0.55 + Math.random() * 0.4,
            1 + Math.random() * 1.4,
          );
        }
        // Foam ring spreading on the surface.
        this.ripplePool.spawn(c.x, c.y + 0.05, c.z, 0, 0, 0, 1.15, 0.5 + speed * 0.06);
      }
    }
    this._growRipples(dt);
  }

  _growRipples(dt) {
    const pool = this.ripplePool;
    const { pos, life, maxLife, size, count } = pool;
    const m = pool._m;
    const q = pool._q;
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i += 1) {
      if (life[i] <= 0) continue;
      const age = 1 - life[i] / maxLife[i];
      const scale = size[i] * (1 + age * 7);
      p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      s.set(scale, 1, scale);
      m.compose(p, q, s);
      pool.mesh.setMatrixAt(i, m);
    }
    pool.mesh.instanceMatrix.needsUpdate = true;
  }

  _exhaustPosition() {
    const v = this.vehicle;
    const local = v.accessories?.snorkel
      ? new THREE.Vector3(0.72, 1.55, 0.5) // snorkel top
      : new THREE.Vector3(-0.55, 0.28, -2.25); // tailpipe
    return local.applyQuaternion(v.group.quaternion).add(v.body.position);
  }

  /** Roughest surface currently under a wheel (rocks and snow shake you). */
  _roughSurface() {
    const wheels = this.vehicle?.wheelSurface;
    if (!wheels) return 'hardpack';
    const order = { rock: 3, snow: 2, mud: 1 };
    let best = 'hardpack';
    let bestRank = 0;
    for (const s of wheels) {
      const rank = order[s?.key] || 0;
      if (rank > bestRank) {
        bestRank = rank;
        best = s.key;
      }
    }
    return best;
  }

  _chunkColorFor(key) {
    switch (key) {
      case 'mud':
        return new THREE.Color(0x3a2a17);
      case 'snow':
        return new THREE.Color(0xe6f1f8);
      case 'sand':
        return new THREE.Color(0xc9ab74);
      case 'water':
        return new THREE.Color(0xcfe6ef);
      case 'rock':
        return new THREE.Color(0x6a6259);
      default:
        return new THREE.Color(0x7a6242);
    }
  }

  _writeInstanceColor(mesh, index, color) {
    if (!mesh.instanceColor) return;
    const arr = mesh.instanceColor.array;
    arr[index * 3] = color.r;
    arr[index * 3 + 1] = color.g;
    arr[index * 3 + 2] = color.b;
    mesh.instanceColor.needsUpdate = true;
  }

  /* ---- events from the vehicle ---------------------------------- */
  onGearShift() {
    const ex = this._exhaustPosition();
    for (let i = 0; i < 5; i += 1) {
      this.exhaustPool.spawn(
        ex.x, ex.y, ex.z,
        (Math.random() - 0.5) * 1.4,
        0.8 + Math.random() * 1.2,
        (Math.random() - 0.5) * 1.4,
        0.9 + Math.random() * 0.5,
        1.2 + Math.random(),
      );
    }
  }

  /** Phase 8: 0..1 share of each pool that may exist at once. */
  setParticleBudget(fraction) {
    const f = Math.min(1, Math.max(0, Number(fraction) || 0));
    this.particleScale = f;
    for (const pool of [this.throwPool, this.exhaustPool, this.splashPool, this.ripplePool]) {
      if (!pool) continue;
      pool.limit = Math.floor(pool.count * f);
      pool.mesh.count = pool.limit;
      pool.mesh.visible = pool.limit > 0;
      if (pool.limit === 0) pool.cursor = 0;
    }
  }

  getStats() {
    return {
      mud: +this.mud.toFixed(2),
      snow: +this.snow.toFixed(2),
      twist: +this.twist.toFixed(3),
      shake: +this.shake.toFixed(4),
      springs: this.vehicle.builder?.axles?.front?.springs?.length ?? 0,
      shafts: this.vehicle.builder?.axles?.front?.dampers?.length ?? 0,
    };
  }
}


