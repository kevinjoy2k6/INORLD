/* ============================================================================
 * EnvironmentAudio — the valley, the weather, and the water
 *
 * Wind rises with altitude and speed, birds only sing when the truck is quiet
 * and it is not precipitating, rain and snow are separate noise beds (snow is
 * softer and denser, rain has a patter transient), thunder is scheduled
 * stochastically while it rains, and a stream is audible near the river and
 * follows you as you drive along it.
 * ========================================================================== */

import { smoothParam, oneShotEnvelope } from './AudioMixer.js';

export class EnvironmentAudio {
  constructor({ mixer, library, terrain, vehicle }) {
    this.mixer = mixer;
    this.library = library;
    this.terrain = terrain;
    this.vehicle = vehicle;
    this.ctx = null;
    this._birdTimer = 6;
    this._thunderTimer = 12;
    this._windLevel = 0;
    this._stream = 0;
  }

  attach(ctx) {
    this.ctx = ctx;
    const ctx2 = this.ctx;
    const bus = this.mixer.busInputs.ambience;

    // ---- wind ----
    this.windGain = ctx2.createGain();
    this.windGain.gain.value = 0.02;
    this.windFilter = ctx2.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 620;
    this.mixer.noise().connect(this.windFilter).connect(this.windGain).connect(bus);

    // A slow gust LFO makes the wind breathe instead of hiss.
    this.gust = ctx2.createOscillator();
    this.gust.type = 'sine';
    this.gust.frequency.value = 0.11;
    const gustDepth = ctx2.createGain();
    gustDepth.gain.value = 0.03;
    this.gust.connect(gustDepth).connect(this.windGain.gain);
    this.gust.start();

    // ---- forest rustle: leaves moving, only near the tree line ----
    this.forestGain = ctx2.createGain();
    this.forestGain.gain.value = 0;
    const leafBand = ctx2.createBiquadFilter();
    leafBand.type = 'bandpass';
    leafBand.frequency.value = 3200;
    leafBand.Q.value = 0.7;
    this.mixer.noise().connect(leafBand).connect(this.forestGain).connect(bus);

    // ---- rain ----
    this.rainGain = ctx2.createGain();
    this.rainGain.gain.value = 0;
    const rainHigh = ctx2.createBiquadFilter();
    rainHigh.type = 'highpass';
    rainHigh.frequency.value = 1400;
    this.mixer.noise().connect(rainHigh).connect(this.rainGain).connect(bus);

    // ---- snowstorm: a dense, lower wash with wind behind it ----
    this.snowGain = ctx2.createGain();
    this.snowGain.gain.value = 0;
    const snowBand = ctx2.createBiquadFilter();
    snowBand.type = 'bandpass';
    snowBand.frequency.value = 700;
    snowBand.Q.value = 0.5;
    this.mixer.noise().connect(snowBand).connect(this.snowGain).connect(bus);

    // ---- stream ----
    this.streamGain = ctx2.createGain();
    this.streamGain.gain.value = 0;
    const streamBand = ctx2.createBiquadFilter();
    streamBand.type = 'bandpass';
    streamBand.frequency.value = 900;
    streamBand.Q.value = 0.6;
    this.mixer.noise().connect(streamBand).connect(this.streamGain).connect(bus);
  }

  update(dt, s) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const speed = s.speedMs;
    const altitude = Math.max(0, Math.min(1, (s.position.y - 6) / 70));

    // ---- wind: altitude plus your own speed ----
    this._windLevel += ((0.025 + altitude * 0.13 + Math.min(1, speed / 34) * 0.09) - this._windLevel) * Math.min(1, dt * 0.8);
    smoothParam(this.windGain.gain, this._windLevel, now, 0.4);
    smoothParam(this.windFilter.frequency, 480 + altitude * 700 + Math.min(1, speed / 30) * 300, now, 0.35);

    // ---- weather ----
    const raining = s.weather === 'rain';
    const snowing = s.weather === 'snow';
    smoothParam(this.rainGain.gain, raining ? 0.09 : 0, now, 1.2);
    smoothParam(this.snowGain.gain, snowing ? 0.11 : 0, now, 1.5);

    if (raining) {
      this._thunderTimer -= dt;
      if (this._thunderTimer <= 0) {
        this._thunderTimer = 14 + Math.random() * 26;
        this._thunder();
      }
    }

    // ---- forest: present below the treeline, gone on the alpine shelf ----
    const forest = altitude < 0.55 ? (1 - altitude / 0.55) * (s.night ? 0.4 : 1) : 0;
    smoothParam(this.forestGain.gain, forest * 0.03, now, 0.8);

    // ---- stream: within ~25 m of water, louder as you get closer ----
    let waterNear = 0;
    if (this.terrain?.getWaterDepthAt) {
      const p = s.position;
      for (const [dx, dz, falloff] of [[0, 0, 1], [12, 0, 0.8], [-12, 0, 0.8], [0, 12, 0.8], [0, -12, 0.8], [22, 0, 0.45], [-22, 0, 0.45]]) {
        const depth = this.terrain.getWaterDepthAt(p.x + dx, p.z + dz) || 0;
        if (depth > 0) waterNear = Math.max(waterNear, falloff);
      }
    }
    this._stream += (waterNear - this._stream) * Math.min(1, dt * 1.2);
    smoothParam(this.streamGain.gain, this._stream * 0.06, now, 0.6);

    // ---- birdsong: only when it is quiet, dry and not night ----
    this._birdTimer -= dt;
    if (this._birdTimer <= 0) {
      this._birdTimer = 4 + Math.random() * 9;
      const calm = 1 - Math.min(1, speed / 30);
      if (!raining && !snowing && !s.night && calm > 0.35 && this.mixer.canPlay('env.bird', 0.1)) {
        this._chirp(calm);
      }
    }
  }

  _chirp(calm) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 3);
    const base = 1700 + Math.random() * 900;

    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const dest = pan ? pan.connect(this.mixer.busInputs.ambience) : this.mixer.busInputs.ambience;
    if (pan) pan.pan.value = Math.random() * 1.6 - 0.8;

    for (let i = 0; i < notes; i += 1) {
      const t0 = now + i * (0.08 + Math.random() * 0.05);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f = base * (0.9 + Math.random() * 0.4);
      osc.frequency.setValueAtTime(f, t0);
      osc.frequency.exponentialRampToValueAtTime(f * (1.2 + Math.random() * 0.25), t0 + 0.035);
      osc.frequency.exponentialRampToValueAtTime(f * 0.85, t0 + 0.09);
      const gain = ctx.createGain();
      oneShotEnvelope(gain, t0, (0.03 + Math.random() * 0.02) * calm, 0.012, 0.1);
      osc.connect(gain).connect(dest);
      osc.start(t0);
      osc.stop(t0 + 0.14);
    }
  }

  /** Thunder: a long low rumble with a crack on top, silent in a snowstorm. */
  _thunder() {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = this.mixer.noise(now);

    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.setValueAtTime(240, now);
    low.frequency.exponentialRampToValueAtTime(90, now + 2.4);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.35);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 1.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.2);

    src.connect(low).connect(gain).connect(this.mixer.busInputs.ambience);
    this.mixer.track(src, now + 3.3);
  }
}
