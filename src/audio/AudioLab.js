/* ============================================================================
 * AudioLab — the test scene
 *
 * A scripted drive that exercises every layer in a fixed order, with meters on
 * each bus so the result is measured rather than assumed:
 *
 *   IDLE → REV → SHIFT → BRAKE → WHEELSPIN (mud) → GRAVEL → IMPACT → CABIN
 *
 * For each phase it records the peak of every bus, counts samples that hit the
 * limiter (clipping), tracks how many one-shot voices were alive at once, and
 * flags a phase that stayed silent when it should not have. The report is
 * available from the console and printed once at the end.
 *
 * Open the game with ?audiolab to run it automatically, or from the console:
 *   const lab = await import('./src/audio/AudioLab.js');
 *   window.__audioLab = new lab.AudioLab({ audio: __game.audio, vehicle: __game.vehicle,
 *     cameraController: __game.cameraController, terrain: __game.terrain });
 *   __audioLab.start();
 * ========================================================================== */

const PHASES = [
  { id: 'idle', seconds: 2.5, expect: ['engine', 'ambience'], note: 'engine at rest, valley audible' },
  { id: 'rev', seconds: 3, expect: ['engine', 'exhaust'], note: 'throttle to the floor from rest' },
  { id: 'shift', seconds: 3.5, expect: ['engine', 'drivetrain'], note: 'through the first shifts' },
  { id: 'brake', seconds: 2.5, expect: ['engine', 'tyres'], note: 'engine braking and tyres' },
  { id: 'wheelspin', seconds: 3, expect: ['tyres', 'engine'], note: 'mud, wheels spinning' },
  { id: 'gravel', seconds: 3, expect: ['tyres'], note: 'gravel at speed' },
  { id: 'impact', seconds: 2.5, expect: ['mechanical'], note: 'chassis impact from a drop' },
  { id: 'cabin', seconds: 3, expect: ['engine', 'mechanical'], note: 'interior perspective' },
];

export class AudioLab {
  constructor({ audio, vehicle, cameraController = null, terrain = null }) {
    this.audio = audio;
    this.vehicle = vehicle;
    this.cameraController = cameraController;
    this.terrain = terrain;

    this.active = false;
    this.phaseIndex = -1;
    this.phaseTime = 0;
    this.results = [];
    this.meters = null;
    this._current = null;
    this._maxVoices = 0;
    this._restorePerspective = null;
  }

  /* ---------------------------------------------------------------- meters */

  _buildMeters() {
    const ctx = this.audio.mixer.ctx;
    if (!ctx) return null;
    const meters = { master: this._analyser(ctx, this.audio.mixer.master) };
    for (const [name, bus] of Object.entries(this.audio.mixer.buses || {})) {
      meters[name] = this._analyser(ctx, bus);
    }
    return meters;
  }

  _analyser(ctx, node) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    node.connect(analyser);
    return { analyser, buffer: new Float32Array(analyser.fftSize), peak: 0, clipped: 0, sum: 0, frames: 0 };
  }

  _sampleMeters() {
    if (!this.meters) return;
    for (const meter of Object.values(this.meters)) {
      meter.analyser.getFloatTimeDomainData(meter.buffer);
      let peak = 0;
      let clipped = 0;
      let sum = 0;
      for (let i = 0; i < meter.buffer.length; i += 1) {
        const v = meter.buffer[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        if (a >= 0.995) clipped += 1;
        sum += v * v;
      }
      if (peak > meter.peak) meter.peak = peak;
      meter.clipped += clipped;
      meter.sum += sum / meter.buffer.length;
      meter.frames += 1;
    }
  }

  /* --------------------------------------------------------------- control */

  start() {
    if (!this.audio?.mixer?.ready) {
      console.warn('[audio-lab] the mixer is not unlocked yet — click the page first');
      return false;
    }
    this.meters = this._buildMeters();
    this.active = true;
    this.phaseIndex = -1;
    this.phaseTime = 0;
    this.results = [];
    this._maxVoices = 0;
    this._nextPhase();
    return true;
  }

  stop() {
    this.active = false;
    this._input(0, 0);
    return this.report();
  }

  /**
   * Take the wheel. The game reads `window.__audioLabInput` before the player's
   * keys, so the scripted phase keeps control through the normal input path
   * instead of fighting it.
   */
  _input(throttle, brake = 0, steer = 0) {
    this.vehicle.setThrottle(throttle);
    this.vehicle.setBrake(brake);
    this.vehicle.setSteer(steer);
    window.__audioLabInput = throttle || brake || steer ? { throttle, brake, steer } : null;
  }

  _nextPhase() {
    if (this._current) this._finishPhase();
    this.phaseIndex += 1;
    this.phaseTime = 0;
    if (this.phaseIndex >= PHASES.length) {
      this.active = false;
      this._input(0, 0);
      this._report();
      return;
    }

    const phase = PHASES[this.phaseIndex];
    this._current = phase;
    this._resetMeters();

    this._input(0, 0);

    switch (phase.id) {
      case 'idle':
        this._place(Math.floor(Math.random() * 3));
        break;
      case 'rev':
        this._input(1, 0);
        break;
      case 'shift':
        this._input(1, 0);
        break;
      case 'brake':
        this._input(0, 1);
        break;
      case 'wheelspin':
        this._placeOn('mud');
        this._input(1, 0);
        break;
      case 'gravel':
        this._placeOn('hardpack');
        this._input(1, 0);
        break;
      case 'impact':
        this._drop();
        break;
      case 'cabin':
        this._restorePerspective = this.audio.perspective;
        this.audio.setPerspective(1);
        this._input(0.4, 0);
        break;
      default:
        break;
    }
  }

  _finishPhase() {
    const phase = this._current;
    const buses = {};
    for (const [name, meter] of Object.entries(this.meters || {})) {
      buses[name] = {
        peak: +meter.peak.toFixed(3),
        rms: +Math.sqrt(meter.sum / Math.max(1, meter.frames)).toFixed(4),
        clipped: meter.clipped,
      };
    }
    const silent = phase.expect.filter((bus) => (buses[bus]?.peak ?? 0) < 0.001);
    this.results.push({
      phase: phase.id,
      note: phase.note,
      buses,
      silentExpected: silent,
      maxVoices: this._maxVoices,
    });
    if (this._lastPhaseId === 'cabin' && this._restorePerspective !== null) {
      this.audio.setPerspective(this._restorePerspective);
    }
    this._lastPhaseId = phase.id;
  }

  _resetMeters() {
    for (const meter of Object.values(this.meters || {})) {
      meter.peak = 0;
      meter.clipped = 0;
      meter.sum = 0;
      meter.frames = 0;
    }
  }

  update(dt) {
    if (!this.active) return;
    this._sampleMeters();
    if (this.audio.mixer.voiceCount > this._maxVoices) this._maxVoices = this.audio.mixer.voiceCount;
    this.phaseTime += dt;
    const phase = PHASES[this.phaseIndex];
    if (!phase) return;
    if (this.phaseTime >= phase.seconds) this._nextPhase();
  }

  /* ------------------------------------------------------------- scenario */

  /** Put the truck somewhere dry and flat, from a short list of safe spots. */
  _place(index = 0) {
    const spots = [[0, 0], [-40, 90], [120, -60]];
    const [x, z] = spots[index % spots.length];
    this._teleport(x, z, 1.2);
  }

  /** Find ground of a given surface near the truck and put the wheels on it. */
  _placeOn(surfaceKey) {
    const terrain = this.terrain;
    const body = this.vehicle.body;
    if (!terrain?.getSurfaceAt) return;

    const startX = body.position.x;
    const startZ = body.position.z;
    let best = null;
    for (let ring = 0; ring < 40 && !best; ring += 1) {
      const radius = 20 + ring * 12;
      for (let a = 0; a < 12; a += 1) {
        const angle = (a / 12) * Math.PI * 2;
        const x = startX + Math.cos(angle) * radius;
        const z = startZ + Math.sin(angle) * radius;
        const surf = terrain.getSurfaceAt(x, z);
        if (surf && surf.key === surfaceKey) {
          best = { x, z };
          break;
        }
      }
    }
    if (best) this._teleport(best.x, best.z, 1.2);
    else this._place(0);
  }

  _teleport(x, z, height) {
    const terrain = this.terrain;
    const ground = terrain ? terrain.getHeightAt(x, z) : 0;
    const body = this.vehicle.body;
    body.position.set(x, ground + height, z);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
  }

  /** Drop the truck so the suspension and collision layers both get a real hit. */
  _drop() {
    const body = this.vehicle.body;
    body.velocity.set(0, -7.5, 0);
    body.position.y += 2.5;
  }

  /* --------------------------------------------------------------- report */

  _report() {
    const rows = this.results.map((result) => ({
      phase: result.phase,
      peakMaster: result.buses.master?.peak ?? 0,
      clipping: Object.values(result.buses).reduce((n, bus) => n + bus.clipped, 0),
      silentExpected: result.silentExpected,
      voices: result.maxVoices,
    }));

    const clipping = rows.reduce((n, row) => n + row.clipping, 0);
    const silent = rows.flatMap((row) => row.silentExpected.map((bus) => `${row.phase}:${bus}`));
    const voices = rows.reduce((n, row) => Math.max(n, row.voices), 0);

    const report = {
      phases: rows,
      detail: this.results,
      verdict: {
        clipping,
        silentExpected: silent,
        maxVoices: voices,
        pass: clipping === 0 && silent.length === 0,
      },
    };

    this.reportData = report;
    console.group('[audio-lab] vehicle audio report');
    console.table(rows);
    if (silent.length) console.warn('silent when expected:', silent);
    if (clipping) console.warn('clipping samples:', clipping);
    console.log('max simultaneous one-shots:', voices);
    console.groupEnd();
    return report;
  }

  get report() {
    return this.reportData || this._report();
  }
}
