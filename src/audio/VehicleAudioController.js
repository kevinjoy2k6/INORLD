/* ============================================================================
 * VehicleAudioController — builds one frame of truth, then feeds every module
 *
 * The modules never reach into the vehicle themselves. This controller reads the
 * physics once per frame and hands them a single immutable-ish frame state, so
 * all seven layers agree on RPM, load, slip and surface, and so the cost of
 * sampling telemetry is paid once.
 *
 * It also owns the three things that span layers:
 *   perspective   camera mode decides exterior vs cab
 *   gear changes  the shift event every drivetrain sound hangs off
 *   load          throttle + RPM, with the shift torque cut folded in
 * ========================================================================== */

import { AudioMixer, smoothParam } from './AudioMixer.js';
import { SampleLibrary } from './SampleLibrary.js';
import { EngineAudio } from './EngineAudio.js';
import { ExhaustAudio } from './ExhaustAudio.js';
import { TransmissionAudio } from './TransmissionAudio.js';
import { TireAudio } from './TireAudio.js';
import { SuspensionAudio } from './SuspensionAudio.js';
import { CollisionAudio } from './CollisionAudio.js';
import { InteriorAudio } from './InteriorAudio.js';
import { EnvironmentAudio } from './EnvironmentAudio.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Surface roughness, shared with the modules that shake things. */
const ROUGHNESS = {
  asphalt: 0.18, hardpack: 0.22, trail: 0.4, gravel: 0.75, dirt: 0.5,
  mud: 0.45, snow: 0.35, rock: 0.95, sand: 0.5, water: 0.3, ice: 0.3,
};

export class VehicleAudioController {
  constructor({ vehicle, terrain = null, camera = null, atmosphere = null, winchSystem = null } = {}) {
    this.vehicle = vehicle;
    this.terrain = terrain;
    this.camera = camera;
    this.atmosphere = atmosphere;
    this.winchSystem = winchSystem;

    this.mixer = new AudioMixer();
    this.library = new SampleLibrary();

    this.engine = new EngineAudio({ mixer: this.mixer, library: this.library, vehicle });
    this.exhaust = new ExhaustAudio({ mixer: this.mixer, library: this.library });
    this.transmission = new TransmissionAudio({ mixer: this.mixer, library: this.library });
    this.tyres = new TireAudio({ mixer: this.mixer, library: this.library, vehicle });
    this.suspension = new SuspensionAudio({ mixer: this.mixer, vehicle });
    this.collisions = new CollisionAudio({ mixer: this.mixer, vehicle, library: this.library });
    this.interior = new InteriorAudio({ mixer: this.mixer, vehicle });
    this.environment = new EnvironmentAudio({ mixer: this.mixer, library: this.library, terrain, vehicle });

    this.engineVolume = 1;
    this.ambienceVolume = 1;
    this.enabled = true;
    this.perspective = 0; // 0 = outside, 1 = cab
    this.weather = 'clear';

    this._prevGear = null;
    this._perspectiveTarget = 0;
    this._lastThrottle = 0;
    this._ready = false;

    // Audio is a garnish, not a load-bearing system. A bad sample, a closed
    // context or a Web Audio edge case must degrade the mix, never stop the
    // truck, so every step goes through `_safe`. Keys are de-duplicated so a
    // fault that repeats every frame is logged once, not sixty times a second.
    this._faultKeys = new Set();
    this.faultCount = 0;
    this.lastFault = null;

    this.mixer.onReady = (ctx) => this._onReady(ctx);
    this.mixer.bindUnlock();
  }

  /** Named modules, so a fault can say which layer broke. */
  _modules() {
    return [
      ['engine', this.engine],
      ['exhaust', this.exhaust],
      ['transmission', this.transmission],
      ['tyres', this.tyres],
      ['suspension', this.suspension],
      ['collisions', this.collisions],
      ['interior', this.interior],
      ['environment', this.environment],
    ];
  }

  /**
   * Run an audio step. Anything thrown is reported once and swallowed: the
   * simulation is never allowed to fail because a sound did.
   */
  _safe(label, fn) {
    try {
      return fn();
    } catch (error) {
      this.reportFault(label, error);
      return undefined;
    }
  }

  /** Record an audio fault once, keep it inspectable, and carry on. */
  reportFault(label, error) {
    const message = error?.message || String(error);
    const key = `${label}: ${message}`;
    this.faultCount += 1;
    this.lastFault = { label, message, time: this.mixer.now };
    if (this._faultKeys.has(key)) return;
    this._faultKeys.add(key);
    if (typeof window !== 'undefined') {
      window.__audioFaults = window.__audioFaults || [];
      window.__audioFaults.push({ label, message, stack: error?.stack || null });
    }
    // warn, not error: the game is still running and this is not a crash.
    console.warn(`[audio] ${label} failed; the game continues without that layer.`, error);
  }

  _onReady(ctx) {
    this._safe('library', () => {
      this.library.attach(ctx);
      this.library.load();
    });
    for (const [name, module] of this._modules()) {
      this._safe(`attach.${name}`, () => module.attach(ctx));
    }
    this._safe('mixer', () => this.mixer.setVolume(this.mixer.volumes.master));
    // Ready even if a layer failed to attach: the other layers still play, and
    // the failed one is caught per frame rather than skipped silently forever.
    this._ready = true;
  }

  unlock() {
    try {
      return this.mixer.unlock();
    } catch (error) {
      this.reportFault('unlock', error);
      return false;
    }
  }

  get ready() {
    return this._ready;
  }

  /* --------------------------------------------------------- perspective */

  /**
   * Camera mode sets perspective. `amount` 0 is outside the truck, 1 is the cab;
   * the modules crossfade rather than switching, so a camera change never pops.
   */
  setPerspective(amount) {
    this._perspectiveTarget = clamp01(amount);
  }

  /** Convenience: derive perspective from a camera mode string. */
  setCameraMode(mode) {
    this.setPerspective(mode === 'cockpit' ? 1 : 0);
  }

  setWeather(weather) {
    this.weather = weather === 'snow' ? 'snow' : weather === 'rain' ? 'rain' : 'clear';
  }

  /* --------------------------------------------------------------- frame */

  update(dt, telemetry = null, context = {}) {
    if (!this.mixer.ready || !this.enabled) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    this._safe('update', () => this._updateFrame(dt, telemetry, context));
  }

  _updateFrame(dt, telemetry, context) {
    this.mixer.updateListener(this.camera);
    if (this.camera) {
      const e = this.camera.matrixWorld.elements;
      // Listener orientation is set here rather than by the camera class, so a
      // camera change is felt immediately in the panning.
      const listener = this.mixer.ctx.listener;
      if (listener.forwardX) {
        const t = this.mixer.now;
        smoothParam(listener.forwardX, -e[8], t, 0.03);
        smoothParam(listener.forwardY, -e[9], t, 0.03);
        smoothParam(listener.forwardZ, -e[10], t, 0.03);
      }
    }

    const vehicle = this.vehicle;
    const t = telemetry || vehicle.getTelemetry();
    const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

    const throttle = clamp01(num(context.throttle, this._lastThrottle));
    this._lastThrottle = throttle;
    const rpm = Math.max(0, num(t.rpm, 620));
    const rpmPct = clamp01(num(t.rpmPct, 0));
    const speedMs = Math.abs(num(t.speedKmh, 0)) / 3.6;

    const gearIndex = Number.isFinite(vehicle.gearIndex) ? vehicle.gearIndex : 1;
    const gearLabel = typeof t.gear === 'string' ? t.gear : String(gearIndex);
    const gearChanged = this._prevGear !== null && this._prevGear !== gearIndex;

    // Torque cut from a shift is subtracted from load for the engine note, which
    // is what makes a shift audible as a dip rather than a click.
    const shiftCut = this.transmission.shiftCut;
    const load = clamp01((throttle * 0.62 + rpmPct * 0.55) * (1 - shiftCut));

    if (gearChanged) {
      this.transmission.onShift({ to: gearIndex, gearIndex, load });
    }
    this._prevGear = gearIndex;

    // Chassis roll and pitch, from the body's own orientation.
    const q = vehicle.body.quaternion;
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    const rightY = 2 * (q.x * q.y - q.z * q.w);
    const roll = Math.atan2(rightY, Math.max(1e-4, upY));

    const surfaces = vehicle.wheelSurface || [];
    const comp = Array.from(vehicle.comp || []);
    const slip = Array.from(vehicle.slip || []);
    const omega = Array.from(vehicle.omega || []);
    const grounded = Array.isArray(vehicle.grounded) ? vehicle.grounded.slice() : [false, false, false, false];

    // Dominant surface: what the majority of touching wheels are on.
    const counts = Object.create(null);
    let touching = 0;
    for (let i = 0; i < surfaces.length; i += 1) {
      if (!grounded[i]) continue;
      touching += 1;
      const key = surfaces[i]?.key;
      if (key) counts[key] = (counts[key] || 0) + 1;
    }
    let surfaceKey = 'hardpack';
    let best = -1;
    for (const key of Object.keys(counts)) {
      if (counts[key] > best) {
        best = counts[key];
        surfaceKey = key;
      }
    }
    const roughness = ROUGHNESS[surfaceKey] ?? 0.4;

    // Perspective eases over ~150 ms so the filter sweep is a fade, not a snap.
    this.perspective += (this._perspectiveTarget - this.perspective) * Math.min(1, dt * 7);
    this.interior.setPerspective(this.perspective);
    this.exhaust.setInterior(this.perspective);
    this.tyres.setInterior(this.perspective);

    const weather = context.weather ?? this.atmosphere?.weatherMode ?? this.weather;
    const state = {
      dt,
      time: this.mixer.now,
      rpm,
      rpmPct,
      throttle,
      brake: clamp01(num(context.brake, 0)),
      load,
      shiftCut,
      speedKmh: speedMs * 3.6,
      speedMs,
      engineOn: t.engineOn !== false,
      running: t.engineOn !== false,
      gearIndex,
      gearLabel,
      gearChanged,
      slip,
      omega,
      comp,
      grounded,
      surfaces,
      surfaceKey,
      roughness,
      roll,
      diffLock: !!t.diffLock,
      position: {
        x: vehicle.body.position.x,
        y: vehicle.body.position.y,
        z: vehicle.body.position.z,
      },
      weather,
      night: !!this.atmosphere?.night,
    };

    // One layer per try/catch: a broken tyre voice must not silence the engine.
    for (const [name, module] of this._modules()) {
      this._safe(name, () => module.update(dt, state));
    }
  }

  /* ------------------------------------------------- compatibility API */

  /** Kept for the shift hooks in main.js; now sized by load inside the module. */
  clunk(amount = 1) {
    this._safe('clunk', () =>
      this.transmission.onShift({ to: this.vehicle?.gearIndex ?? 1, gearIndex: this.vehicle?.gearIndex ?? 1, load: amount }),
    );
  }

  setVolume(v) {
    this._safe('setVolume', () => this.mixer.setVolume(v));
  }

  setEngineVolume(v) {
    this.engineVolume = clamp01(Number(v) || 0);
    this._safe('setEngineVolume', () => this.mixer.setBusVolume('engine', this.engineVolume));
  }

  setAmbienceVolume(v) {
    this.ambienceVolume = clamp01(Number(v) || 0);
    this._safe('setAmbienceVolume', () => this.mixer.setBusVolume('ambience', this.ambienceVolume));
  }

  getStats() {
    return {
      ready: this._ready,
      context: this.mixer.ctx ? this.mixer.ctx.state : 'none',
      voices: this.mixer.voiceCount,
      perspective: +this.perspective.toFixed(2),
      weather: this.weather,
      faults: this.faultCount,
      lastFault: this.lastFault,
      samples: this.library.getStats(),
    };
  }

  dispose() {
    this._safe('dispose', () => this.mixer.dispose());
    this._ready = false;
  }
}
