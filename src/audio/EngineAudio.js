/* ============================================================================
 * EngineAudio — four RPM layers, not one engine loop
 *
 * A diesel does not change timbre by being played faster. Idle is a slow, soft
 * combustion lope; low RPM is a heavy chuff with the exhaust almost closed; mid
 * is the working band with intake honk; high is hard, bright and thin. Each is
 * built as its own voice here and crossfaded by RPM, which is why lifting off
 * at 3,000 rpm sounds different from lugging at 1,100.
 *
 * The layers are:
 *   IDLE   half-order boom + soft pulse train, no intake
 *   LOW    strong pulse train, exhaust low-passed, body harmonics
 *   MID    brighter harmonics, intake honk appears
 *   HIGH   thin harmonics, wide-open filter, mechanical edge
 *   LOAD   throttle-driven intake/exhaust brightness, on top of the layers
 *   OVERRUN  engine braking: closed throttle, high vacuum, gritty rumble
 *   TURBO  spool whistle + air, rises with sustained load, flutters on lift
 *
 * If assets/audio/manifest.json maps engine.idle/low/mid/high, those loops are
 * used instead of the synthesisers and pitched by RPM.
 * ========================================================================== */

import { smoothParam, oneShotEnvelope } from './AudioMixer.js';

const LAYER_BANDS = [
  { id: 'engine.idle', from: 0.0, to: 0.2, peak: 0.12 },
  { id: 'engine.low', from: 0.1, to: 0.45, peak: 0.3 },
  { id: 'engine.mid', from: 0.34, to: 0.74, peak: 0.34 },
  { id: 'engine.high', from: 0.64, to: 1.0, peak: 0.3 },
];

/** Triangular crossfade: full in the middle of the band, absent at the edges. */
function bandWeight(pct, from, to) {
  if (pct <= from || pct >= to) return 0;
  const middle = (from + to) * 0.5;
  return pct < middle ? (pct - from) / (middle - from) : (to - pct) / (to - middle);
}

export class EngineAudio {
  constructor({ mixer, library, vehicle }) {
    this.mixer = mixer;
    this.library = library;
    this.vehicle = vehicle;

    this.ctx = null;
    this.layers = [];
    this._rpmSmooth = 0;
    this._loadSmooth = 0;
    this._turboSmooth = 0;
    this._overrun = 0;
    this._state = 'off'; // off | cranking | running | stopping
    this._stateTime = 0;
    this._wasOn = null;
    this._sampleLayers = null;
  }

  attach(ctx) {
    this.ctx = ctx;
    const out = this.mixer.busInputs.engine;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(out);
    this._buildLayers();
    this._buildLoad();
    this._buildOverrun();
    this._buildTurbo();
  }

  /* ---------------------------------------------------------------- build */

  _buildLayers() {
    const ctx = this.ctx;
    // One shared saturation stage so the four layers glue into one engine
    // instead of four engines playing at once.
    this.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    const norm = Math.tanh(2.3);
    for (let i = 0; i < 2048; i += 1) {
      const x = (i / 2047) * 2 - 1;
      curve[i] = Math.tanh(x * 2.3) / norm;
    }
    this.shaper.curve = curve;
    this.shaper.oversample = '2x';

    // Exhaust body: cutoff opens with load, so lugging is muffled and pulling
    // hard is loud without changing note.
    this.exhaustFilter = ctx.createBiquadFilter();
    this.exhaustFilter.type = 'lowpass';
    this.exhaustFilter.frequency.value = 380;
    this.exhaustFilter.Q.value = 1.05;

    this.body = ctx.createGain();
    this.body.gain.value = 0.9;

    this.body.connect(this.shaper).connect(this.exhaustFilter).connect(this.out);

    // Each layer is a pulse train + harmonic stack with its own gain, so the
    // crossfade is a real tonal change rather than a volume ramp.
    const specs = [
      { noiseBand: 150, noiseQ: 0.8, noiseGain: 0.2, harmonics: [[0.5, 0.62, 'sine'], [1, 0.16, 'sawtooth']] },
      { noiseBand: 230, noiseQ: 0.9, noiseGain: 0.34, harmonics: [[1, 0.3, 'sawtooth'], [2, 0.1, 'sawtooth']] },
      { noiseBand: 420, noiseQ: 1.0, noiseGain: 0.3, harmonics: [[1, 0.26, 'sawtooth'], [2, 0.14, 'sawtooth'], [3, 0.05, 'square']] },
      { noiseBand: 760, noiseQ: 1.2, noiseGain: 0.26, harmonics: [[1, 0.2, 'sawtooth'], [2, 0.16, 'sawtooth'], [4, 0.08, 'square']] },
    ];

    this.layers = LAYER_BANDS.map((band, index) => {
      const spec = specs[index];
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.body);

      const noise = this.mixer.noise();
      const bandFilter = ctx.createBiquadFilter();
      bandFilter.type = 'bandpass';
      bandFilter.frequency.value = spec.noiseBand;
      bandFilter.Q.value = spec.noiseQ;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = spec.noiseGain;
      noise.connect(bandFilter).connect(noiseGain).connect(gain);

      // The firing frequency chops the noise into separate combustion beats.
      const chop = ctx.createOscillator();
      chop.type = 'square';
      chop.frequency.value = 24;
      const chopDepth = ctx.createGain();
      chopDepth.gain.value = spec.noiseGain * 0.7;
      chop.connect(chopDepth).connect(noiseGain.gain);
      chop.start();

      const harmonics = spec.harmonics.map(([multiple, level, type]) => {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = 24 * multiple;
        const trim = ctx.createGain();
        trim.gain.value = level;
        osc.connect(trim).connect(gain);
        osc.start();
        return { osc, multiple };
      });

      return { ...band, gain, chop, noiseGain, bandFilter, harmonics };
    });

    // Sample-backed alternative, built lazily once buffers arrive.
    this._sampleGain = ctx.createGain();
    this._sampleGain.gain.value = 0;
    this._sampleGain.connect(this.body);
  }

  _buildLoad() {
    const ctx = this.ctx;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intakeBand = ctx.createBiquadFilter();
    this.intakeBand.type = 'bandpass';
    this.intakeBand.frequency.value = 780;
    this.intakeBand.Q.value = 2.2;
    this.mixer.noise().connect(this.intakeBand).connect(this.intakeGain).connect(this.body);
  }

  _buildOverrun() {
    const ctx = this.ctx;
    // Engine braking: intake shut, exhaust gas still moving. Gritty, not musical.
    this.overrunGain = ctx.createGain();
    this.overrunGain.gain.value = 0;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 520;
    band.Q.value = 0.7;
    this.mixer.noise().connect(band).connect(this.overrunGain).connect(this.body);
  }

  _buildTurbo() {
    const ctx = this.ctx;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboGain.connect(this.mixer.busInputs.engine);

    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.value = 1400;
    this.turboOsc.connect(this.turboGain);
    this.turboOsc.start();

    const air = this.mixer.noise();
    const airBand = ctx.createBiquadFilter();
    airBand.type = 'bandpass';
    airBand.frequency.value = 3100;
    airBand.Q.value = 3.2;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.4;
    this.turboAir = ctx.createGain();
    this.turboAir.gain.value = 0;
    air.connect(airBand).connect(airGain).connect(this.turboAir).connect(this.mixer.busInputs.engine);
  }

  /* ----------------------------------------------------------- behaviour */

  /** Startup: crank, catch, settle at idle. Layered, not a single sample. */
  start() {
    if (!this.ctx || this._state === 'running' || this._state === 'cranking') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this._state = 'cranking';
    this._stateTime = 0;

    // Six compression strokes of starter motor, accelerating as it catches.
    for (let i = 0; i < 6; i += 1) {
      const t0 = now + i * 0.1;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(52 + i * 9, t0);
      osc.frequency.exponentialRampToValueAtTime(30 + i * 7, t0 + 0.07);
      const gain = ctx.createGain();
      oneShotEnvelope(gain, t0, 0.16 + i * 0.02, 0.006, 0.09);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      osc.connect(lp).connect(gain).connect(this.mixer.busInputs.engine);
      osc.start(t0);
      osc.stop(t0 + 0.14);
    }

    // Starter whine over the cranking.
    const whine = ctx.createOscillator();
    whine.type = 'sawtooth';
    whine.frequency.setValueAtTime(180, now);
    whine.frequency.linearRampToValueAtTime(260, now + 0.55);
    const whineGain = ctx.createGain();
    oneShotEnvelope(whineGain, now, 0.05, 0.05, 0.5);
    const whineBand = ctx.createBiquadFilter();
    whineBand.type = 'bandpass';
    whineBand.frequency.value = 900;
    whineBand.Q.value = 3;
    whine.connect(whineBand).connect(whineGain).connect(this.mixer.busInputs.drivetrain);
    whine.start(now);
    whine.stop(now + 0.6);

    this._catchAt = now + 0.62;
  }

  /** Shutdown: fuel cut, revs fall, last few uneven strokes, silence. */
  stop() {
    if (!this.ctx || this._state === 'off' || this._state === 'stopping') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this._state = 'stopping';
    this._stateTime = 0;
    this._stopAt = now + 1.15;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(22, now + 0.9);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, now);
    lp.frequency.exponentialRampToValueAtTime(160, now + 0.9);
    const gain = ctx.createGain();
    oneShotEnvelope(gain, now, 0.1, 0.02, 0.85);
    osc.connect(lp).connect(gain).connect(this.mixer.busInputs.engine);
    osc.start(now);
    osc.stop(now + 1);

    // The last shudders as compression drops away.
    for (let i = 0; i < 3; i += 1) {
      const t0 = now + 0.35 + i * 0.22;
      const thud = ctx.createOscillator();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(64 - i * 8, t0);
      thud.frequency.exponentialRampToValueAtTime(34, t0 + 0.16);
      const thudGain = ctx.createGain();
      oneShotEnvelope(thudGain, t0, 0.09 * (1 - i * 0.3), 0.008, 0.2);
      thud.connect(thudGain).connect(this.mixer.busInputs.engine);
      thud.start(t0);
      thud.stop(t0 + 0.25);
    }
  }

  /* --------------------------------------------------------------- frame */

  update(dt, s) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // Engine on/off drives the state machine, not just a gain. The first frame
    // has no previous state to compare with: if the engine is already running
    // when the mix comes up, it is running, and no starter sound is played.
    if (this._wasOn === null && s.engineOn) this._state = 'running';
    if (s.engineOn !== this._wasOn && this._wasOn !== null) {
      if (s.engineOn) this.start();
      else this.stop();
    }
    this._wasOn = s.engineOn;

    this._stateTime += dt;
    if (this._state === 'cranking' && now >= this._catchAt) this._state = 'running';
    if (this._state === 'stopping' && now >= (this._stopAt ?? 0)) this._state = 'off';
    if (s.engineOn && this._state === 'off') this._state = 'running';

    const running = this._state === 'running' || this._state === 'cranking';
    const stopping = this._state === 'stopping';

    // RPM smoothing keeps the crossfade from chattering between layers on a
    // single noisy frame.
    this._rpmSmooth += (s.rpmPct - this._rpmSmooth) * Math.min(1, dt * 9);
    this._loadSmooth += (s.load - this._loadSmooth) * Math.min(1, dt * 6);
    const pct = Math.max(0, Math.min(1, this._rpmSmooth));
    const firing = Math.max(11, (s.rpm / 60) * 2);

    // The engine is the loudest layer, but it still has to leave room for tyres
    // and impacts: at full throttle it sits just under the limiter, not on it.
    const targetGain = stopping ? Math.max(0, 0.6 * (1 - this._stateTime / 1.1)) : running ? 0.6 : 0;
    smoothParam(this.out.gain, targetGain, now, 0.06);

    // Layer crossfade and tuning.
    for (const layer of this.layers) {
      const weight = running ? bandWeight(pct, layer.from, layer.to) : 0;
      smoothParam(layer.gain.gain, weight * (0.55 + this._loadSmooth * 0.45), now, 0.07);
      smoothParam(layer.chop.frequency, firing, now, 0.05);
      // The combustion band rides up with RPM, which is most of what makes the
      // top end read as "hard" rather than "louder".
      smoothParam(layer.bandFilter.frequency, layer.noiseBand * (0.75 + pct * 1.1), now, 0.1);
      for (const { osc, multiple } of layer.harmonics) {
        smoothParam(osc.frequency, firing * multiple, now, 0.05);
      }
    }

    // Exhaust opens with load, closes when coasting.
    smoothParam(this.exhaustFilter.frequency, 260 + pct * 900 + this._loadSmooth * 1100, now, 0.09);

    // Intake only makes noise under throttle.
    smoothParam(this.intakeGain.gain, running ? s.throttle * 0.05 : 0, now, 0.09);
    smoothParam(this.intakeBand.frequency, 700 + pct * 800, now, 0.12);

    // Engine braking: throttle shut but the engine still turning fast.
    const overrun = running && s.throttle < 0.06 && pct > 0.3 ? Math.min(1, (pct - 0.3) * 1.8) : 0;
    this._overrun += (overrun - this._overrun) * Math.min(1, dt * 5);
    smoothParam(this.overrunGain.gain, this._overrun * 0.075, now, 0.1);

    // Turbo spools only on sustained load and bleeds off with a flutter.
    const spool = this._loadSmooth > 0.55 ? (this._loadSmooth - 0.55) / 0.45 : 0;
    this._turboSmooth += (spool - this._turboSmooth) * Math.min(1, dt * (spool > this._turboSmooth ? 2.2 : 4.5));
    smoothParam(this.turboGain.gain, running ? this._turboSmooth * 0.04 : 0, now, 0.2);
    smoothParam(this.turboOsc.frequency, 1200 + pct * 2900, now, 0.18);
    smoothParam(this.turboAir.gain, running ? this._turboSmooth * 0.03 : 0, now, 0.2);

    // Recorded layers, when present, take over from the synthesisers.
    this._updateSamples(now, pct, running);
  }

  _updateSamples(now, pct, running) {
    const library = this.library;
    if (!library?.has('engine.idle')) return;

    if (!this._sampleLayers) this._sampleLayers = {};
    for (const band of LAYER_BANDS) {
      if (!library.has(band.id)) continue;
      const buffer = library.loop(band.id);
      if (!buffer) continue;

      let layer = this._sampleLayers[band.id];
      if (!layer) {
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(this._sampleGain);
        source.start();
        layer = { source, gain };
        this._sampleLayers[band.id] = layer;
      }
      const weight = running ? bandWeight(pct, band.from, band.to) : 0;
      smoothParam(layer.gain.gain, weight * 0.5, now, 0.08);
      // Playback rate tracks RPM inside the band so the loop does not sound
      // like a fixed clip, but stays near 1.0 to protect loop pitch.
      smoothParam(layer.source.playbackRate, 0.86 + pct * 0.4, now, 0.15);
    }

    // Fade the synthesisers out only once a layer is genuinely playing.
    const anyLoaded = Object.keys(this._sampleLayers).length > 0;
    smoothParam(this._sampleGain.gain, anyLoaded ? 1 : 0, now, 0.2);
    smoothParam(this.body.gain, anyLoaded ? 0.15 : 0.9, now, 0.2);
  }

  dispose() {
    // Sources are owned by the mixer's context; closing it tears everything down.
    this.ctx = null;
    this.layers = [];
  }
}
