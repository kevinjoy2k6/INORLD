/* ============================================================================
 * AudioMixer — one AudioContext, one bus tree, one voice budget
 *
 * Every module in this folder talks to the mixer instead of the context, so
 * there is exactly one place that decides how loud something may be, how many
 * one-shots may be alive at once, and what the master limiter is doing. That is
 * what keeps a crash landing on a river from clipping the master.
 *
 *   master ─ limiter ─ destination
 *     ├ engine     (interior filter is applied on this bus)
 *     ├ drivetrain
 *     ├ tyres      (per-wheel panners feed this)
 *     ├ mechanical (suspension, creaks, impacts)
 *     ├ ambience   (wind, weather, wildlife)
 *     └ UI
 * ========================================================================== */

/** Web Audio throws on a non-finite AudioParam, and one NaN used to kill the
 *  whole session. Every write goes through here. */
export function smoothParam(param, value, time, constant = 0.08) {
  // Callers may pass either an AudioParam or the node that owns one; accepting
  // both removes a whole class of "silent because the write went nowhere" bugs.
  if (param && typeof param.setTargetAtTime !== 'function' && param.gain) param = param.gain;
  if (!param || typeof param.setTargetAtTime !== 'function' || !Number.isFinite(value) || !Number.isFinite(time)) return;
  param.setTargetAtTime(value, time, Number.isFinite(constant) ? constant : 0.08);
}

/** Exponential fade that never reaches zero (Web Audio rejects 0 for exp ramps). */
export function oneShotEnvelope(param, now, peak, attack, decay, hold = 0) {
  if (param && typeof param.cancelScheduledValues !== 'function' && param.gain) param = param.gain;
  if (!param || typeof param.cancelScheduledValues !== 'function' || !Number.isFinite(peak) || peak <= 0) return;
  param.cancelScheduledValues(now);
  param.setValueAtTime(0.0001, now);
  param.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + attack);
  if (hold > 0) param.setValueAtTime(Math.max(0.0002, peak), now + attack + hold);
  param.exponentialRampToValueAtTime(0.0001, now + attack + hold + decay);
}

export const BUS_NAMES = ['engine', 'drivetrain', 'tyres', 'mechanical', 'ambience', 'ui'];

/** Bus trims: a tyre loop must not sit as loud as the engine under load. */
const BUS_TRIM = {
  engine: 0.9,
  drivetrain: 0.75,
  tyres: 0.8,
  mechanical: 0.85,
  ambience: 0.7,
  ui: 0.6,
};

export class AudioMixer {
  constructor({ maxOneShots = 18 } = {}) {
    this.ctx = null;
    this.ready = false;
    this.maxOneShots = maxOneShots;
    this._voices = new Set();
    this._cooldowns = new Map();
    this.volumes = { master: 0.55, engine: 1, ambience: 1, tyres: 1, mechanical: 1 };
    this.trims = { engine: 1, drivetrain: 1, tyres: 1, mechanical: 1, ambience: 1, ui: 1 };
    this._unlockBound = false;
    this.onReady = null;

    // Animation frames stop in a hidden tab but the WebAudio graph keeps
    // running, so the engine drone used to play on with nobody driving. Park the
    // context with the tab and bring it back on return; unlock() already resumes
    // a suspended context, so this needs no extra state.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) {
          const pending = this.ctx.suspend?.();
          if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        } else if (this.ready) {
          this.unlock();
        }
      });
    }
  }

  /** Autoplay policy: the context can only start from a gesture. */
  bindUnlock() {
    if (this._unlockBound) return;
    this._unlockBound = true;
    const unlock = () => this.unlock();
    for (const event of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(event, unlock, { once: true, passive: true });
    }
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
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
    this.master = ctx.createGain();
    this.master.gain.value = this.volumes.master;

    // A limiter, not a compressor doing tone shaping: transients from an impact
    // over an engine under load should duck, not clip.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    // Two parallel paths leave the master: dry (outside the truck) and a cab
    // path that loses its highs. InteriorAudio crossfades between them, which
    // is cheaper and more coherent than filtering every bus separately.
    this.exteriorPath = ctx.createGain();
    this.exteriorPath.gain.value = 1;
    this.exteriorPath.connect(this.limiter);

    this.interiorFilter = ctx.createBiquadFilter();
    this.interiorFilter.type = 'lowpass';
    this.interiorFilter.frequency.value = 1500;
    this.interiorFilter.Q.value = 0.4;

    // The cab has a resonance around 180 Hz — the boom you hear inside a diesel.
    this.cabinPeak = ctx.createBiquadFilter();
    this.cabinPeak.type = 'peaking';
    this.cabinPeak.frequency.value = 185;
    this.cabinPeak.Q.value = 1.1;
    this.cabinPeak.gain.value = 5;

    this.interiorPath = ctx.createGain();
    this.interiorPath.gain.value = 0;
    this.interiorFilter.connect(this.cabinPeak).connect(this.interiorPath).connect(this.limiter);

    this.master.connect(this.exteriorPath);
    this.master.connect(this.interiorFilter);
    this.limiter.connect(ctx.destination);

    this.buses = {};
    this.busInputs = {};
    for (const name of BUS_NAMES) {
      const gain = ctx.createGain();
      gain.gain.value = BUS_TRIM[name] ?? 1;
      gain.connect(this.master);
      this.buses[name] = gain;
      // Modules write here so a module-level trim never fights the mixer.
      this.busInputs[name] = ctx.createGain();
      this.busInputs[name].connect(gain);
    }

    // 4 s of white noise, shared by every noise-based layer in the game.
    const length = ctx.sampleRate * 4;
    this.noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;

    this.ready = true;
    if (this.onReady) this.onReady(this.ctx);
    return true;
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * Looping noise source, started here exactly once. Callers own the node graph
   * after this, but must never call start() on it again: Web Audio throws
   * "cannot call start more than once" and that error used to reach the fatal
   * overlay the first time an impact, splash or thunder fired.
   *
   * One-shots that need the burst to begin with their envelope pass `startAt`
   * (normally `ctx.currentTime`); omitting it starts the loop immediately.
   */
  noise(startAt = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.start(Number.isFinite(startAt) ? startAt : 0);
    return src;
  }

  /** A positional chain: panner → bus. Returns the input node to feed. */
  panner(bus, { refDistance = 3.5, maxDistance = 90, rolloff = 1.1, panningModel = 'HRTF' } = {}) {
    const ctx = this.ctx;
    const pan = ctx.createPanner();
    pan.panningModel = panningModel;
    pan.distanceModel = 'inverse';
    pan.refDistance = refDistance;
    pan.maxDistance = maxDistance;
    pan.rolloffFactor = rolloff;
    pan.connect(this.busInputs[bus] || this.buses[bus]);
    return pan;
  }

  /** Smoothly aim a panner at a world position (Web Audio has no matrix API). */
  setPannerPosition(pan, x, y, z, time = this.now) {
    if (!pan || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    if (pan.positionX) {
      smoothParam(pan.positionX, x, time, 0.02);
      smoothParam(pan.positionY, y, time, 0.02);
      smoothParam(pan.positionZ, z, time, 0.02);
      return;
    }
    pan.setPosition(x, y, z);
  }

  /** Listener follows the camera so attenuation and panning stay honest. */
  updateListener(camera) {
    if (!this.ctx || !camera) return;
    const listener = this.ctx.listener;
    const p = camera.position;
    const e = camera.matrixWorld.elements;
    // Camera looks down its local -Z.
    const fx = -e[8];
    const fy = -e[9];
    const fz = -e[10];
    const ux = e[4];
    const uy = e[5];
    const uz = e[6];

    if (listener.positionX) {
      const t = this.now;
      smoothParam(listener.positionX, p.x, t, 0.02);
      smoothParam(listener.positionY, p.y, t, 0.02);
      smoothParam(listener.positionZ, p.z, t, 0.02);
      smoothParam(listener.forwardX, fx, t, 0.02);
      smoothParam(listener.forwardY, fy, t, 0.02);
      smoothParam(listener.forwardZ, fz, t, 0.02);
      smoothParam(listener.upX, ux, t, 0.02);
      smoothParam(listener.upY, uy, t, 0.02);
      smoothParam(listener.upZ, uz, t, 0.02);
    } else {
      listener.setPosition(p.x, p.y, p.z);
      listener.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /**
   * Budgeted one-shot. Returns false when the voice was dropped, which is the
   * correct answer under load: better a missing tick than a stuttering frame.
   */
  canPlay(id, cooldownSeconds = 0.05) {
    if (!this.ctx) return false;
    if (this._voices.size >= this.maxOneShots) return false;
    const last = this._cooldowns.get(id) ?? -Infinity;
    const now = this.now;
    if (now - last < cooldownSeconds) return false;
    this._cooldowns.set(id, now);
    return true;
  }

  /** Track a source so the budget knows when it is done. */
  track(source, stopAt = null) {
    this._voices.add(source);
    source.onended = () => {
      this._voices.delete(source);
      try {
        source.disconnect();
      } catch {
        /* already gone */
      }
    };
    if (stopAt !== null) {
      try {
        source.stop(stopAt);
      } catch {
        /* never started */
      }
    }
    return source;
  }

  get voiceCount() {
    return this._voices.size;
  }

  setVolume(v) {
    this.volumes.master = Math.min(1, Math.max(0, Number(v) || 0));
    if (this.master) smoothParam(this.master.gain, this.volumes.master, this.now, 0.1);
  }

  setBusVolume(name, v) {
    this.volumes[name] = Math.min(1, Math.max(0, Number(v) || 0));
    this._applyBusGain(name);
  }

  /**
   * A runtime trim, separate from the user's volume. The interior mix moves
   * these every frame; the settings slider writes `volumes`. Keeping them apart
   * means sitting in the cab never silently overwrites a saved preference.
   */
  setBusTrim(name, v) {
    this.trims[name] = Math.max(0, Number(v) || 0);
    this._applyBusGain(name);
  }

  _applyBusGain(name) {
    const bus = this.buses?.[name];
    if (!bus) return;
    const trim = BUS_TRIM[name] ?? 1;
    smoothParam(bus.gain, (this.volumes[name] ?? 1) * (this.trims[name] ?? 1) * trim, this.now, 0.1);
  }

  dispose() {
    for (const source of this._voices) {
      try {
        source.stop();
      } catch {
        /* not started */
      }
    }
    this._voices.clear();
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {
        /* already closing */
      }
    }
    this.ctx = null;
    this.ready = false;
  }
}
