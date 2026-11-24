/* ============================================================================
 * ExhaustAudio — the note after the engine, not inside it
 *
 * An exhaust is its own instrument: a pipe with a length, a rasp at the
 * tailpipe, and a burble on the overrun when hot gas meets cold air. It also has
 * to be able to shut up independently of the engine, because from inside the
 * cab it is mostly what the firewall takes away.
 * ========================================================================== */

import { smoothParam, oneShotEnvelope } from './AudioMixer.js';

export class ExhaustAudio {
  constructor({ mixer, library }) {
    this.mixer = mixer;
    this.library = library;
    this.ctx = null;
    this._crackleTimer = 0;
    this._heat = 0;
  }

  attach(ctx) {
    this.ctx = ctx;
    const ctx2 = this.ctx;

    this.out = ctx2.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.mixer.busInputs.engine);

    // Tailpipe resonance: narrow, around 180–320 Hz depending on RPM.
    this.pipe = ctx2.createBiquadFilter();
    this.pipe.type = 'bandpass';
    this.pipe.frequency.value = 240;
    this.pipe.Q.value = 1.6;

    this.raspGain = ctx2.createGain();
    this.raspGain.gain.value = 0.5;

    const rasp = this.mixer.noise();
    const raspBand = ctx2.createBiquadFilter();
    raspBand.type = 'highpass';
    raspBand.frequency.value = 1200;
    rasp.connect(raspBand).connect(this.raspGain).connect(this.pipe);

    this.pipe.connect(this.out);

    // Body: the low thump the cab feels more than hears from outside.
    this.thump = ctx2.createOscillator();
    this.thump.type = 'sawtooth';
    this.thump.frequency.value = 40;
    const thumpGain = ctx2.createGain();
    thumpGain.gain.value = 0.16;
    this.thump.connect(thumpGain).connect(this.out);
    this.thump.start();

    // Muffler volume is a real parameter: a straight pipe is loud and harsh.
    this.volume = 1;
  }

  update(dt, s) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const running = s.running;
    const load = s.load;

    smoothParam(this.out.gain, running ? (0.16 + load * 0.2) * this.volume : 0, now, 0.1);
    smoothParam(this.pipe.frequency, 200 + s.rpmPct * 260, now, 0.1);
    smoothParam(this.thump.frequency, Math.max(24, (s.rpm / 60) * 2 * 0.5), now, 0.06);
    smoothParam(this.raspGain.gain, 0.25 + s.rpmPct * 0.55, now, 0.12);

    // Overrun crackle: unburnt fuel igniting in a hot pipe. Only when the
    // engine is hot, throttled shut and still revving — the exact conditions
    // that make a real diesel pop.
    const popping = running && s.throttle < 0.05 && s.rpmPct > 0.42;
    this._heat += ((popping ? 1 : 0) - this._heat) * Math.min(1, dt * 3);
    this._crackleTimer -= dt;
    if (this._heat > 0.4 && this._crackleTimer <= 0) {
      this._crackleTimer = 0.09 + Math.random() * 0.22;
      if (this.mixer.canPlay('exhaust.crackle', 0.05)) this._crackle(this._heat);
    }
  }

  _crackle(strength) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = this.mixer.noise(now);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 320 + Math.random() * 520;
    band.Q.value = 1.1;
    const gain = ctx.createGain();
    oneShotEnvelope(gain, now, 0.05 + strength * 0.07 + Math.random() * 0.02, 0.004, 0.05 + Math.random() * 0.05);
    src.connect(band).connect(gain).connect(this.out);
    this.mixer.track(src, now + 0.12);
  }

  /** Interior mix pulls the tailpipe back but never fully removes it. */
  setInterior(amount) {
    this.volume = 1 - amount * 0.62;
  }
}
