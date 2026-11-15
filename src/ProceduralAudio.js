/* ============================================================================
 * ProceduralAudio — a complete vehicle + wilderness soundscape with zero assets
 *
 * Everything is synthesised from oscillators and filtered noise:
 *
 *   ENGINE      saw + triangle stack through a resonant low-pass, with an
 *               exhaust pulse modulator (LFO -> gain) and a turbo whistle
 *               (sine + bandpassed noise) that rises with load.
 *   DRIVETRAIN  short metallic clunk on gear changes and diff-lock, plus the
 *               electric winch whine whose pitch tracks cable tension.
 *   TYRES       pneumatic hiss (white noise -> bandpass) whenever PSI moves.
 *   SURFACES    looping noise beds per biome: mud squelch, snow crunch,
 *               gravel crackle, and rushing water that rises near the river.
 *   WILDERNESS  filtered wind whose level rises with altitude.
 *
 * The AudioContext is created lazily on the first user gesture (browser
 * autoplay policy), then everything runs from `update(dt, telemetry)`.
 * ========================================================================== */

const SURFACE_PROFILES = {
  mud: { gain: 0.5, band: 420, q: 1.4, rate: 1.0, kind: 'squelch' },
  snow: { gain: 0.42, band: 2400, q: 0.9, rate: 1.0, kind: 'crunch' },
  sand: { gain: 0.3, band: 1600, q: 0.7, rate: 1.0, kind: 'crunch' },
  rock: { gain: 0.35, band: 3000, q: 1.1, rate: 1.0, kind: 'crackle' },
  hardpack: { gain: 0.2, band: 2200, q: 0.8, rate: 1.0, kind: 'crackle' },
  water: { gain: 0.5, band: 900, q: 0.6, rate: 1.0, kind: 'wash' },
  trail: { gain: 0.22, band: 1900, q: 0.8, rate: 1.0, kind: 'crackle' },
};

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/** Soft asymmetric saturation — the grit that makes a diesel sound mechanical. */
function saturationCurve(amount = 2.2) {
  const n = 2048;
  const curve = new Float32Array(n);
  const norm = Math.tanh(amount);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / norm;
  }
  return curve;
}

/* ------------------------------------------------------------------ *
 *  AudioParam writes
 *
 *  Web Audio throws a TypeError when an AudioParam is handed a non-finite
 *  value, and one NaN inside the engine model used to take the whole game
 *  down with it. Every smoothing write goes through here: a bad frame skips
 *  its step instead of killing the session.
 * ------------------------------------------------------------------ */

function smoothParam(param, value, time, constant) {
  if (!param || !Number.isFinite(value) || !Number.isFinite(time)) return;
  param.setTargetAtTime(value, time, Number.isFinite(constant) ? constant : 0.1);
}

export class ProceduralAudio {
  constructor({ vehicle, winchSystem = null, camera = null, quality = null }) {
    this.vehicle = vehicle;
    this.winchSystem = winchSystem;
    this.camera = camera;
    this.quality = quality;

    this.ctx = null;
    this.enabled = true;
    this.masterVolume = 0.55;
    this.engineVolume = 1;
    this.ambienceVolume = 1;
    this.unlocked = false;

    this._lastPsi = vehicle?.psi ?? 22;
    this._lastGear = null;
    this._lastDiff = null;
    this._surfaceKey = 'trail';
    this._whineOn = false;
    this._hissUntil = 0;
    this._shiftUntil = 0;
    this._throttleCut = 0;
    this._lastBottomOut = 0;

    this._bindUnlock();
  }

  /* ================================================================== *
   *  setup (must happen after a gesture)
   * ================================================================== */

  _bindUnlock() {
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('touchstart', unlock, { once: true });
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;

    try {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
    } catch {
      return false;
    }

    const ctx = this.ctx;

    /* ---- master chain ---- */
    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.ratio.value = 4;
    this.master.connect(this.compressor).connect(ctx.destination);

    /* ---- shared noise buffer (2 s of white noise) ---- */
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;

    this._buildEngine();
    this._buildSurfaceBed();
    this._buildWind();
    this._buildWinch();
    this._buildWater();

    this.unlocked = true;
    return true;
  }

  _noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    return src;
  }

  /**
   * Four-cylinder turbo-diesel.
   *
   * A diesel does not sound like a filtered saw — it sounds like a train of
   * combustion impulses. This builds it that way:
   *
   *   PULSES   filtered noise chopped at the firing frequency (2 per rev for a
   *            4-cylinder four-stroke) — the "chug" you can almost feel.
   *   BODY     a sine at half firing frequency plus two saws for the harmonic
   *            growl, all summed and driven through a tanh saturation stage so
   *            the peaks clip like a real exhaust instead of beeping.
   *   EXHAUST  a low-pass whose cutoff opens with load, so lugging is muffled
   *            and pulling hard is loud.
   *   INTAKE   a narrow band-pass honk that only appears under throttle.
   *   TURBO    sine whistle + band-passed air that spools with sustained load.
   */
  _buildEngine() {
    const ctx = this.ctx;

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0;

    this.engineSum = ctx.createGain();
    this.engineSum.gain.value = 0.9;

    this.engineShaper = ctx.createWaveShaper();
    this.engineShaper.curve = saturationCurve(2.4);
    this.engineShaper.oversample = '2x';

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 480;
    this.engineFilter.Q.value = 1.1;

    this.engineSum
      .connect(this.engineShaper)
      .connect(this.engineFilter)
      .connect(this.engineBus)
      .connect(this.master);

    /* ---- combustion pulse train ---- */
    const pulseNoise = this._noiseSource();
    this.combBand = ctx.createBiquadFilter();
    this.combBand.type = 'bandpass';
    this.combBand.frequency.value = 190;
    this.combBand.Q.value = 0.85;

    this.combGain = ctx.createGain();
    this.combGain.gain.value = 0.26;

    pulseNoise.connect(this.combBand).connect(this.combGain).connect(this.engineSum);
    pulseNoise.start();

    // The firing-frequency square chops the noise into separate beats.
    this.exhaustLfo = ctx.createOscillator();
    this.exhaustLfo.type = 'square';
    this.exhaustLfo.frequency.value = 24;
    this.exhaustDepth = ctx.createGain();
    this.exhaustDepth.gain.value = 0.17;
    this.exhaustLfo.connect(this.exhaustDepth).connect(this.combGain.gain);

    /* ---- harmonic body ---- */
    this.oscA = ctx.createOscillator(); // firing fundamental
    this.oscA.type = 'sawtooth';
    this.oscA.frequency.value = 24;

    this.oscB = ctx.createOscillator(); // second harmonic growl
    this.oscB.type = 'sawtooth';
    this.oscB.frequency.value = 48;
    this.oscB.detune.value = -8;

    this.oscC = ctx.createOscillator(); // half-order boom
    this.oscC.type = 'sine';
    this.oscC.frequency.value = 12;

    const gainA = ctx.createGain();
    gainA.gain.value = 0.15;
    const gainB = ctx.createGain();
    gainB.gain.value = 0.06;
    const gainC = ctx.createGain();
    gainC.gain.value = 0.5;

    this.oscA.connect(gainA).connect(this.engineSum);
    this.oscB.connect(gainB).connect(this.engineSum);
    this.oscC.connect(gainC).connect(this.engineSum);

    /* ---- intake honk ---- */
    const intakeNoise = this._noiseSource();
    this.intakeBand = ctx.createBiquadFilter();
    this.intakeBand.type = 'bandpass';
    this.intakeBand.frequency.value = 820;
    this.intakeBand.Q.value = 2.4;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    intakeNoise.connect(this.intakeBand).connect(this.intakeGain).connect(this.engineSum);
    intakeNoise.start();

    /* ---- turbo ---- */
    this.turbo = ctx.createGain();
    this.turbo.gain.value = 0;
    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.value = 1600;
    this.turboOsc.connect(this.turbo).connect(this.master);

    const turboNoise = this._noiseSource();
    const turboBand = ctx.createBiquadFilter();
    turboBand.type = 'bandpass';
    turboBand.frequency.value = 3200;
    turboBand.Q.value = 3.5;
    const turboNoiseGain = ctx.createGain();
    turboNoiseGain.gain.value = 0.45;
    turboNoise.connect(turboBand).connect(turboNoiseGain).connect(this.turbo);
    turboNoise.start();

    /* ---- tyre scrub + vegetation rustle ---- */
    const tyreNoise = this._noiseSource();
    this.tyreBand = ctx.createBiquadFilter();
    this.tyreBand.type = 'bandpass';
    this.tyreBand.frequency.value = 760;
    this.tyreBand.Q.value = 1.2;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;
    tyreNoise.connect(this.tyreBand).connect(this.tyreGain).connect(this.master);
    tyreNoise.start();

    const rustleNoise = this._noiseSource();
    const rustleBand = ctx.createBiquadFilter();
    rustleBand.type = 'highpass';
    rustleBand.frequency.value = 2600;
    this.rustleGain = ctx.createGain();
    this.rustleGain.gain.value = 0;
    rustleNoise.connect(rustleBand).connect(this.rustleGain).connect(this.master);
    rustleNoise.start();

    /* ---- wilderness birds ---- */
    this.birdGain = ctx.createGain();
    this.birdGain.gain.value = 0.5;
    this.birdGain.connect(this.master);
    this._birdTimer = 3.5;

    for (const o of [this.oscA, this.oscB, this.oscC, this.exhaustLfo, this.turboOsc]) o.start();
  }

  /* ---- biome surface bed ---- */
  _buildSurfaceBed() {
    const ctx = this.ctx;
    this.surfaceGain = ctx.createGain();
    this.surfaceGain.gain.value = 0;

    this.surfaceBand = ctx.createBiquadFilter();
    this.surfaceBand.type = 'bandpass';
    this.surfaceBand.frequency.value = 1800;
    this.surfaceBand.Q.value = 1;

    const src = this._noiseSource();
    src.connect(this.surfaceBand).connect(this.surfaceGain).connect(this.master);
    src.start();
    this.surfaceSrc = src;
  }

  /* ---- mountain wind ---- */
  _buildWind() {
    const ctx = this.ctx;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.05;

    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 700;

    const src = this._noiseSource();
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();

    // A slow LFO makes the gusts breathe.
    this.gustLfo = ctx.createOscillator();
    this.gustLfo.type = 'sine';
    this.gustLfo.frequency.value = 0.13;
    this.gustDepth = ctx.createGain();
    this.gustDepth.gain.value = 0.045;
    this.gustLfo.connect(this.gustDepth).connect(this.windGain.gain);
    this.gustLfo.start();
  }

  /* ---- river proximity ---- */
  _buildWater() {
    const ctx = this.ctx;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;

    this.waterBand = ctx.createBiquadFilter();
    this.waterBand.type = 'bandpass';
    this.waterBand.frequency.value = 620;
    this.waterBand.Q.value = 0.7;

    const src = this._noiseSource();
    src.connect(this.waterBand).connect(this.waterGain).connect(this.master);
    src.start();
  }

  /* ---- winch motor ---- */
  _buildWinch() {
    const ctx = this.ctx;
    this.winchGain = ctx.createGain();
    this.winchGain.gain.value = 0;

    this.winchOsc = ctx.createOscillator();
    this.winchOsc.type = 'sawtooth';
    this.winchOsc.frequency.value = 120;

    this.winchFilter = ctx.createBiquadFilter();
    this.winchFilter.type = 'bandpass';
    this.winchFilter.frequency.value = 900;
    this.winchFilter.Q.value = 6;

    this.winchOsc.connect(this.winchFilter).connect(this.winchGain).connect(this.master);
    this.winchOsc.start();
  }

  /* ================================================================== *
   *  one-shots
   * ================================================================== */

  /** Metallic drivetrain clunk (gear change, hitch, diff lock). */
  clunk(amount = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(58, now + 0.12);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 320;
    filter.Q.value = 2.2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.32 * amount, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.24);

    // A short noise tick on top for the mechanical "snap".
    const tick = this._noiseSource();
    const tickFilter = ctx.createBiquadFilter();
    tickFilter.type = 'highpass';
    tickFilter.frequency.value = 1800;
    const tickGain = ctx.createGain();
    tickGain.gain.setValueAtTime(0.14 * amount, now);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
    tick.connect(tickFilter).connect(tickGain).connect(this.master);
    tick.start(now);
    tick.stop(now + 0.08);
  }

  /** Pneumatic tyre hiss while inflating or deflating. */
  hiss(duration = 0.9, amount = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const src = this._noiseSource();
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(2600, now);
    band.frequency.exponentialRampToValueAtTime(1300, now + duration);
    band.Q.value = 1.6;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2 * amount, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    src.connect(band).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + duration + 0.05);
  }

  /** Short water splash burst (ford entry, wheel in the river). */
  splash(amount = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = this._noiseSource();
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(1200, now);
    band.frequency.exponentialRampToValueAtTime(420, now + 0.4);
    band.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.26 * amount, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    src.connect(band).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + 0.55);
  }

  /** Suspension bottom-out: a dull wooden thud through the chassis. */
  thud(amount = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(44, now + 0.18);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.24 * amount, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);

    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.26);

    // Bump stop squeak: a breath of high noise on top.
    const tick = this._noiseSource();
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1600;
    band.Q.value = 3;
    const tickGain = ctx.createGain();
    tickGain.gain.setValueAtTime(0.06 * amount, now);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    tick.connect(band).connect(tickGain).connect(this.master);
    tick.start(now);
    tick.stop(now + 0.1);
  }

  /** Gear change: torque cut plus the drivetrain clunk, like a real shift. */
  shiftKick(amount = 1) {
    this._throttleCut = Math.max(this._throttleCut, 0.55 * amount);
    this.clunk(0.55 * amount);
  }

  /** A distant bird — two falling whistles. Keeps the valley alive at idle. */
  chirp() {
    if (!this.ctx || !this.birdGain) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 3);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = Math.random() * 1.6 - 0.8;
      pan.connect(this.birdGain);
    }
    const base = 1700 + Math.random() * 900;

    for (let i = 0; i < notes; i += 1) {
      const t0 = now + i * (0.07 + Math.random() * 0.05);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f = base * (0.9 + Math.random() * 0.4);
      osc.frequency.setValueAtTime(f, t0);
      osc.frequency.exponentialRampToValueAtTime(f * (1.2 + Math.random() * 0.25), t0 + 0.035);
      osc.frequency.exponentialRampToValueAtTime(f * 0.85, t0 + 0.09);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.05 + Math.random() * 0.03, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);

      osc.connect(gain).connect(pan || this.birdGain);
      osc.start(t0);
      osc.stop(t0 + 0.13);
    }
  }

  /* ================================================================== *
   *  per-frame
   * ================================================================== */

  update(dt, telemetry, context = {}) {
    if (!this.ctx || !this.enabled) return;
    const t = telemetry || this.vehicle.getTelemetry();
    const now = this.ctx.currentTime;

    // Every value below feeds an AudioParam. Web Audio throws a TypeError on a
    // non-finite value and that killed the whole game, so nothing unguarded is
    // allowed through.
    const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
    const rpm = Math.max(0, num(t.rpm, 700));
    const rpmPct = clamp01(num(t.rpmPct, 0));
    const speed = Math.abs(num(t.speedKmh, 0));
    const throttle = clamp01(num(context.throttle, 0));
    // A shift briefly lifts the throttle: that pause is what makes a gearbox
    // feel like a gearbox.
    this._throttleCut = Math.max(0, this._throttleCut - dt * 3.4);
    const load = clamp01((throttle * 0.6 + rpmPct * 0.7) * (1 - this._throttleCut));

    /* ---- engine ---- */
    // A 4-cylinder four-stroke fires twice per revolution.
    const firingHz = Math.max(11, (rpm / 60) * 2);
    const running = t.engineOn !== false;
    const level = running ? clamp01(0.1 + load * 0.24 + rpmPct * 0.1) : 0;

    smoothParam(this.oscA.frequency, firingHz, now, 0.05);
    smoothParam(this.oscB.frequency, firingHz * 2, now, 0.05);
    smoothParam(this.oscC.frequency, firingHz * 0.5, now, 0.05);
    smoothParam(this.exhaustLfo.frequency, firingHz, now, 0.05);

    // Exhaust opens with load, not just rpm: that is what makes lugging sound
    // different from revving.
    smoothParam(this.engineFilter.frequency, 240 + rpmPct * 900 + load * 1150, now, 0.08);
    smoothParam(this.combBand.frequency, 150 + rpmPct * 190, now, 0.1);
    smoothParam(this.combGain.gain, (0.2 + load * 0.14) * (running ? 1 : 0), now, 0.08);
    smoothParam(this.intakeGain.gain, running ? throttle * 0.05 : 0, now, 0.1);
    smoothParam(this.intakeBand.frequency, 700 + rpmPct * 700, now, 0.12);
    smoothParam(this.engineBus.gain, level * this.engineVolume, now, 0.08);

    // Turbo: spools up under sustained load only.
    const turboLevel = load > 0.62 ? (load - 0.62) * 0.9 : 0;
    smoothParam(this.turbo.gain, turboLevel * 0.045, now, 0.25);
    smoothParam(this.turboOsc.frequency, 1500 + rpmPct * 2600, now, 0.2);

    /* ---- tyre scrub: slip you can hear ---- */
    const slip = t.slip || [0, 0, 0, 0];
    let slipAvg = 0;
    for (let i = 0; i < slip.length; i += 1) slipAvg += Math.abs(slip[i] || 0);
    slipAvg /= Math.max(1, slip.length);
    const motionNow = clamp01(speed / 30);
    const scrub = clamp01(slipAvg * 1.6) * (0.03 + motionNow * 0.09);
    smoothParam(this.tyreGain.gain, scrub * this.ambienceVolume, now, 0.08);
    smoothParam(this.tyreBand.frequency, 520 + motionNow * 1100, now, 0.15);

    /* ---- meadow rustle when the wheels are in vegetation ---- */
    const wheels = this.vehicle?.wheelSurface || [];
    let inFoliage = false;
    for (let i = 0; i < wheels.length; i += 1) if (wheels[i] && wheels[i].foliage) { inFoliage = true; break; }
    this.rustleGain.gain.setTargetAtTime(
      (inFoliage ? 0.05 + motionNow * 0.09 : 0) * this.ambienceVolume, now, 0.15,
    );

    /* ---- surface bed ---- */
    const key = this._dominantSurface();
    this._surfaceKey = key;
    const profile = SURFACE_PROFILES[key] || SURFACE_PROFILES.trail;
    const motion = clamp01(speed / 26);
    smoothParam(this.surfaceGain.gain, profile.gain * motion * 0.55 * this.ambienceVolume, now, 0.12);
    smoothParam(this.surfaceBand.frequency, profile.band * (0.8 + motion * 0.5), now, 0.15);
    smoothParam(this.surfaceBand.Q, profile.q, now, 0.15);
    // Playing back faster at speed is what makes the crunch read as motion.
    if (this.surfaceSrc) {
      smoothParam(this.surfaceSrc.playbackRate, 0.65 + motion * 1.15, now, 0.2);
    }

    /* ---- wind: rises with altitude, never loud ---- */
    const y = this.vehicle.body.position.y;
    const altitude = clamp01((y - 6) / 70);
    smoothParam(this.windGain.gain, (0.03 + altitude * 0.14) * this.ambienceVolume, now, 0.4);
    smoothParam(this.windFilter.frequency, 520 + altitude * 900, now, 0.4);

    /* ---- river proximity ---- */
    const terrain = context.terrain;
    let waterNear = 0;
    if (terrain?.getWaterDepthAt) {
      const p = this.vehicle.body.position;
      const depth = terrain.getWaterDepthAt(p.x, p.z) || 0;
      if (depth > 0) waterNear = 1;
      else {
        // Cheap probe: any water within 14 m of the truck?
        for (const [dx, dz] of [[10, 0], [-10, 0], [0, 10], [0, -10]]) {
          if ((terrain.getWaterDepthAt(p.x + dx, p.z + dz) || 0) > 0) {
            waterNear = 0.55;
            break;
          }
        }
      }
    }
    smoothParam(this.waterGain.gain, waterNear * 0.22 * this.ambienceVolume, now, 0.5);

    /* ---- winch whine ---- */
    const winch = this.winchSystem;
    const tension = winch?.cableTension || 0;
    const winching = !!winch?.activeAnchor;
    smoothParam(this.winchGain.gain, winching ? 0.05 + Math.min(1, tension / 16000) * 0.09 : 0, now, 0.15);
    smoothParam(this.winchFilter.frequency, 700 + Math.min(1, tension / 16000) * 1500, now, 0.2);
    smoothParam(this.winchOsc.frequency, 90 + Math.min(1, tension / 16000) * 180, now, 0.2);

    /* ---- discrete events ---- */
    if (this._lastGear !== null && t.gearId !== this._lastGear) this.shiftKick(0.9);
    this._lastGear = t.gearId;

    // Suspension bottoming out: only when it just happened, never repeatedly.
    const susp = t.suspension;
    if (susp && susp.length) {
      let maxComp = 0;
      for (let i = 0; i < susp.length; i += 1) if (susp[i] > maxComp) maxComp = susp[i];
      const nowMs = now * 1000;
      if (maxComp > 0.98 && this._lastBottomOut < 0.9 && nowMs - (this._bottomOutAt || 0) > 260) {
        this.thud(0.8 + Math.min(0.5, speed / 60));
        this._bottomOutAt = nowMs;
      }
      this._lastBottomOut = maxComp;
    }

    if (this._lastDiff !== null && !!t.diffLock !== !!this._lastDiff) this.clunk(0.75);
    this._lastDiff = !!t.diffLock;

    if (Math.abs((t.psi ?? 22) - this._lastPsi) > 0.4) {
      this.hiss(0.55, 0.7);
      this._lastPsi = t.psi;
    }

    const wasWater = this._wasWater;
    if (waterNear > 0.9 && !wasWater) this.splash(1);
    this._wasWater = waterNear > 0.9;

    /* ---- wilderness life: birdsong fades in when you slow down ---- */
    this._birdTimer = (this._birdTimer ?? 4) - dt;
    if (this._birdTimer <= 0) {
      this._birdTimer = 3.5 + Math.random() * 7;
      const quiet = 1 - clamp01(speed / 45);
      if (this.ambienceVolume > 0.08 && quiet > 0.25) {
        if (this.birdGain) smoothParam(this.birdGain.gain, 0.5 * quiet * this.ambienceVolume, now, 0.5);
        this.chirp();
      }
    }
  }

  /** Most common surface under the four wheels, as a SURFACE_PROFILES key. */
  _dominantSurface() {
    const wheels = this.vehicle?.wheelSurface;
    if (!wheels) return 'hardpack';
    const counts = Object.create(null);
    for (const s of wheels) {
      const k = s?.key;
      if (k) counts[k] = (counts[k] || 0) + 1;
    }
    let best = 'hardpack';
    let bestCount = -1;
    for (const k of Object.keys(counts)) {
      if (counts[k] > bestCount) {
        bestCount = counts[k];
        best = k;
      }
    }
    return best;
  }

  /** Phase 8 mixer channels. */
  setEngineVolume(v) {
    this.engineVolume = Math.min(1, Math.max(0, Number(v) || 0));
  }

  setAmbienceVolume(v) {
    this.ambienceVolume = Math.min(1, Math.max(0, Number(v) || 0));
  }

  setVolume(v) {
    this.masterVolume = clamp01(v);
    if (this.master) smoothParam(this.master.gain, this.masterVolume, this.ctx.currentTime, 0.1);
  }

  getStats() {
    return {
      unlocked: this.unlocked,
      state: this.ctx ? this.ctx.state : 'none',
      engineHz: this.oscA ? +this.oscA.frequency.value.toFixed(1) : 0,
      surface: this._surfaceKey,
    };
  }

  dispose() {
    if (!this.ctx) return;
    try {
      this.ctx.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
    this.unlocked = false;
  }
}
