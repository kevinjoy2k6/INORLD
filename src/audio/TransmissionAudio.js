/* ============================================================================
 * TransmissionAudio — the gearbox tells you what it is doing
 *
 * Four things live here, all driven by the real drivetrain state:
 *   SHIFT      a mechanical thunk on gear engagement, sized by how much torque
 *              is going through it, plus the torque cut that makes a shift felt
 *   WHINE      gear-mesh whine whose pitch tracks road speed and gear, loudest
 *              in first and reverse, almost gone in top
 *   DIFF       a second, higher whine from the differential, only under load
 *   SHAFT      driveshaft rumble: a low irregular vibration that rises with
 *              speed and vanishes when the truck is stopped
 *   CLUTCH     slip noise when pulling away from rest, fading as the road speed
 *              catches the engine
 * ========================================================================== */

import { smoothParam, oneShotEnvelope } from './AudioMixer.js';

export class TransmissionAudio {
  constructor({ mixer, library }) {
    this.mixer = mixer;
    this.library = library;
    this.ctx = null;
    this._whineGain = null;
    this._lastGear = null;
    this._shiftAt = -Infinity;
    this._duck = 0;
    this._clutch = 0;
  }

  attach(ctx) {
    this.ctx = ctx;
    const ctx2 = this.ctx;
    const bus = this.mixer.busInputs.drivetrain;

    // ---- gear whine: pitched by road speed, not by RPM ----
    this.whineGain = ctx2.createGain();
    this.whineGain.gain.value = 0;
    this.whineGain.connect(bus);

    this.whineOsc = ctx2.createOscillator();
    this.whineOsc.type = 'triangle';
    this.whineOsc.frequency.value = 220;
    const whineBand = ctx2.createBiquadFilter();
    whineBand.type = 'bandpass';
    whineBand.frequency.value = 900;
    whineBand.Q.value = 4.5;
    this.whineOsc.connect(whineBand).connect(this.whineGain);
    this.whineOsc.start();

    // ---- differential: a thin, higher harmonic under load ----
    this.diffGain = ctx2.createGain();
    this.diffGain.gain.value = 0;
    this.diffGain.connect(bus);
    this.diffOsc = ctx2.createOscillator();
    this.diffOsc.type = 'sine';
    this.diffOsc.frequency.value = 640;
    this.diffOsc.connect(this.diffGain);
    this.diffOsc.start();

    // ---- driveshaft rumble ----
    this.shaftGain = ctx2.createGain();
    this.shaftGain.gain.value = 0;
    const shaftBand = ctx2.createBiquadFilter();
    shaftBand.type = 'lowpass';
    shaftBand.frequency.value = 160;
    this.mixer.noise().connect(shaftBand).connect(this.shaftGain).connect(bus);

    // ---- clutch slip ----
    this.clutchGain = ctx2.createGain();
    this.clutchGain.gain.value = 0;
    const clutchBand = ctx2.createBiquadFilter();
    clutchBand.type = 'bandpass';
    clutchBand.frequency.value = 1150;
    clutchBand.Q.value = 1.4;
    this.mixer.noise().connect(clutchBand).connect(this.clutchGain).connect(bus);
  }

  /** How much torque the shift cut should remove, 0..1, decaying over time. */
  get shiftCut() {
    return this._duck;
  }

  /** Called by the controller when the gearbox actually changes gear. */
  onShift({ from = null, to = null, gearIndex = 1, load = 0 } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (now - this._shiftAt < 0.18) return;
    this._shiftAt = now;

    // A shift under load is a bang; a shift off throttle is a click.
    const strength = 0.45 + Math.min(0.55, load);
    this._duck = Math.max(this._duck, 0.35 + load * 0.4);

    // Selector fork engagement.
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(150 + Math.random() * 30, now);
    osc.frequency.exponentialRampToValueAtTime(64, now + 0.1);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 340;
    band.Q.value = 2.4;
    const gain = ctx.createGain();
    oneShotEnvelope(gain, now, 0.22 * strength, 0.005, 0.16);
    osc.connect(band).connect(gain).connect(this.mixer.busInputs.drivetrain);
    osc.start(now);
    osc.stop(now + 0.2);

    // Synchro tick.
    const tick = this.mixer.noise(now);
    const tickHigh = ctx.createBiquadFilter();
    tickHigh.type = 'highpass';
    tickHigh.frequency.value = 2200;
    const tickGain = ctx.createGain();
    oneShotEnvelope(tickGain, now + 0.01, 0.08 * strength, 0.003, 0.05);
    tick.connect(tickHigh).connect(tickGain).connect(this.mixer.busInputs.drivetrain);
    this.mixer.track(tick, now + 0.08);

    this._lastGear = to ?? gearIndex;
  }

  update(dt, s) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const speed = Math.max(0, s.speedMs);
    const driving = s.engineOn;

    // Torque cut recovers over roughly a third of a second.
    this._duck = Math.max(0, this._duck - dt * 3.2);

    // Gear-mesh whine: road speed sets pitch, gear sets level. Reverse is the
    // loudest because the gears are straight-cut.
    const reverse = typeof s.gearLabel === 'string' && /r/i.test(s.gearLabel.slice(0, 1));
    const gearIdx = Number.isFinite(s.gearIndex) ? s.gearIndex : 1;
    const gearLevel = reverse ? 0.9 : Math.max(0.08, 0.32 - gearIdx * 0.045);
    const speedFactor = Math.min(1, speed / 26);
    smoothParam(this.whineGain.gain, driving ? gearLevel * speedFactor * 0.05 : 0, now, 0.12);
    smoothParam(
      this.whineOsc.frequency,
      (reverse ? 300 : 150) + speed * (reverse ? 46 : 30) + gearIdx * 12,
      now,
      0.1,
    );

    // Differential only complains under load or when AWD/diff-lock is engaged.
    const diffLoad = s.load * (s.diffLock ? 1 : 0.55);
    smoothParam(this.diffGain.gain, driving ? diffLoad * speedFactor * 0.022 : 0, now, 0.16);
    smoothParam(this.diffOsc.frequency, 420 + speed * 34, now, 0.12);

    // Driveshaft rumble: irregular, low, gone at a standstill.
    const shaft = Math.min(1, speed / 34) * (0.4 + s.load * 0.6);
    smoothParam(this.shaftGain.gain, driving ? shaft * 0.035 : 0, now, 0.2);

    // Clutch slip: moving off from rest with throttle down.
    const slipTarget = driving && speed < 4.5 && s.throttle > 0.15 ? Math.min(1, s.throttle) * (1 - speed / 4.5) : 0;
    this._clutch += (slipTarget - this._clutch) * Math.min(1, dt * 6);
    smoothParam(this.clutchGain.gain, this._clutch * 0.05, now, 0.1);
  }
}
