/* ============================================================================
 * InteriorAudio — the cab is a filter, not a volume knob
 *
 * Sitting inside a truck does four things to the mix: it takes the top off
 * everything (glass and trim absorb highs), it adds a low resonance around
 * 180 Hz, it brings the mechanical noises forward because they travel through
 * the frame you are sitting on, and it pushes the exhaust and the environment
 * back. All of that is one filtered path in the mixer plus per-module trims, so
 * switching perspective never re-triggers a single sound.
 * ========================================================================== */

import { smoothParam, oneShotEnvelope } from './AudioMixer.js';

export class InteriorAudio {
  constructor({ mixer, vehicle }) {
    this.mixer = mixer;
    this.vehicle = vehicle;
    this.ctx = null;
    this.amount = 0;
    this._dashRattle = 0;
    this._rattleTimer = 0;
  }

  attach(ctx) {
    this.ctx = ctx;
    const ctx2 = this.ctx;

    // Dashboard buzz, only present in the cab: a tight rattle excited by the
    // same surface roughness that shakes the panels.
    this.dashGain = ctx2.createGain();
    this.dashGain.gain.value = 0;
    const band = ctx2.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 3400;
    band.Q.value = 5;
    this.mixer.noise().connect(band).connect(this.dashGain).connect(this.mixer.busInputs.mechanical);
  }

  /** 0 = outside, 1 = fully inside. Driven by the camera mode. */
  setPerspective(amount) {
    this.amount = Math.max(0, Math.min(1, amount));
  }

  update(dt, s) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const target = this.amount;

    // Crossfade the two paths. Equal-power would dip in the middle, so the
    // interior path is slightly hot to compensate for the low-pass loss.
    smoothParam(this.mixer.exteriorPath.gain, 1 - target, now, 0.18);
    smoothParam(this.mixer.interiorPath.gain, target * 1.25, now, 0.18);
    // Open the cab filter a little with speed: wind noise through the glass.
    smoothParam(this.mixer.interiorFilter.frequency, 1250 + Math.min(1, s.speedMs / 30) * 700, now, 0.25);
    smoothParam(this.mixer.cabinPeak.gain, 3 + target * 4, now, 0.25);

    // Mechanical sounds come forward inside, ambience goes back. These are
    // trims, not volumes: the player's slider still owns `volumes`.
    this.mixer.setBusTrim('mechanical', 1 + target * 0.35);
    this.mixer.setBusTrim('ambience', 1 - target * 0.4);

    // Dash rattle: speed × roughness, gated to the cab.
    const roughness = s.roughness ?? 0.4;
    const targetRattle = target * Math.min(1, s.speedMs / 18) * roughness * 0.05;
    this._dashRattle += (targetRattle - this._dashRattle) * Math.min(1, dt * 4);
    smoothParam(this.dashGain.gain, this._dashRattle, now, 0.12);

    // Occasional trim buzz on a bad surface — irregular, so it is scheduled
    // rather than continuous.
    this._rattleTimer -= dt;
    if (target > 0.5 && roughness > 0.7 && s.speedMs > 6 && this._rattleTimer <= 0) {
      this._rattleTimer = 0.4 + Math.random() * 1.2;
      this._buzz(Math.min(1, s.speedMs / 20) * roughness);
    }
  }

  _buzz(strength) {
    if (!this.ctx || !this.mixer.canPlay('interior.buzz', 0.3)) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 1800 + Math.random() * 1400;
    const gain = ctx.createGain();
    oneShotEnvelope(gain, now, 0.012 + strength * 0.02, 0.004, 0.06 + Math.random() * 0.08);
    osc.connect(gain).connect(this.mixer.busInputs.mechanical);
    osc.start(now);
    osc.stop(now + 0.16);
  }
}
