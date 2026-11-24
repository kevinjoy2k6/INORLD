/* ============================================================================
 * SuspensionAudio — the truck's bodywork answers the ground
 *
 * Compression and rebound are separate sounds: compression is a solid thump
 * (the spring taking load), rebound is a softer, hollow release. On top of that
 * live two continuous layers — a cabin creak that tracks body roll and a loose
 * equipment rattle that tracks how rough the surface is — so the truck sounds
 * like a machine with panels rather than a rigid box.
 * ========================================================================== */

import { smoothParam, oneShotEnvelope } from './AudioMixer.js';

/** Roughness per surface: how much a panel rattles on it. */
const ROUGHNESS = {
  asphalt: 0.18,
  trail: 0.4,
  hardpack: 0.22,
  gravel: 0.75,
  dirt: 0.5,
  mud: 0.45,
  snow: 0.35,
  rock: 0.95,
  sand: 0.5,
  water: 0.3,
  ice: 0.3,
};

export class SuspensionAudio {
  constructor({ mixer, vehicle }) {
    this.mixer = mixer;
    this.vehicle = vehicle;
    this.ctx = null;
    this._prevComp = [0, 0, 0, 0];
    this._lastEvent = [-Infinity, -Infinity, -Infinity, -Infinity];
    this._creakTimer = 0;
    this._rattle = 0;
    this.roll = 0;
  }

  attach(ctx) {
    this.ctx = ctx;
    const ctx2 = this.ctx;

    this.creakGain = ctx2.createGain();
    this.creakGain.gain.value = 0;
    const creakBand = ctx2.createBiquadFilter();
    creakBand.type = 'bandpass';
    creakBand.frequency.value = 420;
    creakBand.Q.value = 6;
    this.mixer.noise().connect(creakBand).connect(this.creakGain).connect(this.mixer.busInputs.mechanical);

    // Level and chop are separate stages on purpose. An LFO connected straight
    // to a level param sets the *base* level to the LFO's peak, so an idle truck
    // would rattle at full volume; here the LFO only modulates a gate that is
    // already scaled by the level gain upstream.
    this.rattleGain = ctx2.createGain();
    this.rattleGain.gain.value = 0;
    this.rattleGate = ctx2.createGain();
    this.rattleGate.gain.value = 0.5;
    const rattleBand = ctx2.createBiquadFilter();
    rattleBand.type = 'highpass';
    rattleBand.frequency.value = 2400;
    this.mixer.noise()
      .connect(rattleBand)
      .connect(this.rattleGain)
      .connect(this.rattleGate)
      .connect(this.mixer.busInputs.mechanical);

    // The rattle is intermittent, so it is chopped by a slow square rather than
    // being a constant hiss.
    this.rattleChop = ctx2.createOscillator();
    this.rattleChop.type = 'square';
    this.rattleChop.frequency.value = 9;
    const chopDepth = ctx2.createGain();
    chopDepth.gain.value = 0.45;
    this.rattleChop.connect(chopDepth).connect(this.rattleGate.gain);
    this.rattleChop.start();
  }

  update(dt, s) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const nowMs = now * 1000;

    // ---- per-wheel compression events ----
    for (let i = 0; i < 4; i += 1) {
      const comp = s.comp?.[i] ?? 0;
      const velocity = (comp - this._prevComp[i]) / Math.max(1e-4, dt);
      this._prevComp[i] = comp;

      // 0.6 normalised units per second is a real bump, not suspension noise.
      if (velocity > 0.6 && nowMs - this._lastEvent[i] > 120) {
        this._lastEvent[i] = nowMs;
        this._thump(0.35 + Math.min(0.65, velocity * 0.35), true);
      } else if (velocity < -0.55 && nowMs - this._lastEvent[i] > 160) {
        this._lastEvent[i] = nowMs;
        this._thump(0.2 + Math.min(0.4, -velocity * 0.2), false);
      }

      // Bottoming out on the bump stop is its own, heavier sound.
      if (comp > 0.97 && nowMs - (this._bottomAt ?? 0) > 300) {
        this._bottomAt = nowMs;
        this._bottomOut();
      }
    }

    // ---- cabin creak: body roll and steering load twist the shell ----
    const roll = Math.abs(s.roll ?? 0);
    const speed = Math.min(1, s.speedMs / 22);
    const creakTarget = Math.min(1, roll * 1.6) * speed * 0.06;
    smoothParam(this.creakGain.gain, creakTarget, now, 0.25);

    // ---- loose equipment / dash rattle from surface roughness ----
    const roughness = ROUGHNESS[s.surfaceKey] ?? 0.4;
    const target = Math.min(1, speed * 1.2) * roughness * 0.09;
    this._rattle += (target - this._rattle) * Math.min(1, dt * 5);
    smoothParam(this.rattleGain.gain, this._rattle, now, 0.15);
    smoothParam(this.rattleChop.frequency, 6 + speed * 16, now, 0.3);
  }

  /** Compression (solid) or rebound (hollow) thump through the chassis. */
  _thump(strength, compression) {
    if (!this.mixer.canPlay('suspension.thump', 0.06)) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f0 = compression ? 96 : 140;
    const f1 = compression ? 42 : 78;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + 0.14);

    const gain = ctx.createGain();
    oneShotEnvelope(gain, now, Math.min(0.26, strength * 0.3), 0.006, compression ? 0.2 : 0.13);

    osc.connect(gain).connect(this.mixer.busInputs.mechanical);
    osc.start(now);
    osc.stop(now + 0.24);
  }

  /** Bump stop: a hard knock with a metallic edge, audible from inside. */
  _bottomOut() {
    if (!this.mixer.canPlay('suspension.bottom', 0.2)) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(46, now + 0.18);
    const gain = ctx.createGain();
    oneShotEnvelope(gain, now, 0.3, 0.004, 0.24);
    osc.connect(gain).connect(this.mixer.busInputs.mechanical);
    osc.start(now);
    osc.stop(now + 0.28);

    const tick = this.mixer.noise(now);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1500;
    band.Q.value = 2.6;
    const tickGain = ctx.createGain();
    oneShotEnvelope(tickGain, now, 0.07, 0.003, 0.09);
    tick.connect(band).connect(tickGain).connect(this.mixer.busInputs.mechanical);
    this.mixer.track(tick, now + 0.12);
  }
}
