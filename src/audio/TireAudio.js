/* ============================================================================
 * TireAudio — one voice per wheel, chosen by what that wheel is touching
 *
 * Ten surfaces, each with its own noise character rather than one hiss with a
 * different EQ: asphalt is a smooth roar, gravel is granular and random, mud is
 * a wet slap with a suction tail, snow is a dense crunch, ice is a thin scrape
 * with almost no body, rock is sharp and intermittent, water is a wash with
 * spray on entry. Wet mud is mud with the suction and spray turned up.
 *
 * Every wheel is panned at its own position and gated on real contact: a wheel
 * in the air is silent, and a wheel spinning in mud is louder than one rolling.
 * ========================================================================== */

import { smoothParam, oneShotEnvelope } from './AudioMixer.js';

/**
 * `band` is the centre of the rolling noise, `q` its width, `rate` how much it
 * speeds up with wheel velocity, `crunch` how granular the layer is, `body` the
 * low thump, `slip` how much extra noise comes from slipping.
 */
const SURFACES = {
  asphalt: { band: 900, q: 0.6, rate: 1.1, crunch: 0.05, body: 0.55, slip: 0.5, gain: 0.3 },
  gravel: { band: 1750, q: 0.9, rate: 1.35, crunch: 0.42, body: 0.3, slip: 1.0, gain: 0.4 },
  dirt: { band: 1300, q: 0.8, rate: 1.2, crunch: 0.26, body: 0.35, slip: 0.9, gain: 0.34 },
  mud: { band: 620, q: 0.7, rate: 0.9, crunch: 0.2, body: 0.7, slip: 1.5, gain: 0.42 },
  'wet mud': { band: 520, q: 0.6, rate: 0.85, crunch: 0.16, body: 0.85, slip: 1.9, gain: 0.48 },
  grass: { band: 2100, q: 0.55, rate: 1.1, crunch: 0.3, body: 0.15, slip: 0.6, gain: 0.22 },
  snow: { band: 1250, q: 0.75, rate: 1.0, crunch: 0.62, body: 0.25, slip: 0.8, gain: 0.4 },
  ice: { band: 2800, q: 1.6, rate: 0.7, crunch: 0.08, body: 0.05, slip: 2.2, gain: 0.18 },
  rocks: { band: 2300, q: 1.1, rate: 1.5, crunch: 0.55, body: 0.2, slip: 1.2, gain: 0.3 },
  water: { band: 780, q: 0.5, rate: 1.4, crunch: 0.1, body: 0.4, slip: 1.1, gain: 0.44 },
};

/** Game surface keys → the audio profile that fits them. */
const SURFACE_MAP = {
  hardpack: 'asphalt',
  trail: 'dirt',
  mud: 'mud',
  sand: 'gravel',
  snow: 'snow',
  rock: 'rocks',
  water: 'water',
};

/** Wheel offsets in the chassis frame, metres. Matches the vehicle's wheels. */
const WHEEL_OFFSETS = [
  [-0.86, -0.3, 1.42],
  [0.86, -0.3, 1.42],
  [-0.86, -0.3, -1.42],
  [0.86, -0.3, -1.42],
];

export class TireAudio {
  constructor({ mixer, library, vehicle }) {
    this.mixer = mixer;
    this.library = library;
    this.vehicle = vehicle;
    this.ctx = null;
    this.wheels = [];
    this.volume = 1;
    this.interior = 0;
  }

  attach(ctx) {
    this.ctx = ctx;
    const ctx2 = this.ctx;

    this.wheels = WHEEL_OFFSETS.map((offset, index) => {
      const panner = this.mixer.panner('tyres', { refDistance: 3, maxDistance: 70 });
      const out = ctx2.createGain();
      out.gain.value = 0;
      out.connect(panner);

      // Rolling noise.
      const band = ctx2.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1400;
      band.Q.value = 0.8;
      const gain = ctx2.createGain();
      gain.gain.value = 0;
      this.mixer.noise().connect(band).connect(gain).connect(out);

      // Granular layer: the crunch/grit on top of the roar.
      const crunchSource = this.mixer.noise();
      const crunchBand = ctx2.createBiquadFilter();
      crunchBand.type = 'bandpass';
      crunchBand.frequency.value = 2600;
      crunchBand.Q.value = 1.3;
      const crunchGain = ctx2.createGain();
      crunchGain.gain.value = 0;
      crunchSource.connect(crunchBand).connect(crunchGain).connect(out);

      // Low body: what you feel through the floor rather than hear.
      const body = ctx2.createOscillator();
      body.type = 'sine';
      body.frequency.value = 70;
      const bodyGain = ctx2.createGain();
      bodyGain.gain.value = 0;
      body.connect(bodyGain).connect(out);
      body.start();

      // Recorded surface loop, lazily created when a file is mapped. One source
      // per wheel, swapped when the wheel changes surface, so a full set of
      // recordings costs four voices and never stacks up.
      const sampleGain = ctx2.createGain();
      sampleGain.gain.value = 0;
      sampleGain.connect(out);

      return {
        index, offset, panner, out, band, gain, crunchBand, crunchGain, body, bodyGain,
        sampleGain, sample: null, sampleKey: null, wasWet: false,
      };
    });
  }

  update(dt, s) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const body = this.vehicle.body;

    for (const wheel of this.wheels) {
      const i = wheel.index;
      const grounded = !!s.grounded[i];
      const surfaceKey = s.surfaces[i]?.key ?? 'hardpack';
      const wet = surfaceKey === 'mud' && (s.surfaces[i]?.waterDepth ?? 0) > 0.05;
      const profileKey = wet ? 'wet mud' : SURFACE_MAP[surfaceKey] || 'dirt';
      const profile = SURFACES[profileKey];

      // Wheel velocity: rolling speed plus whatever it is scrabbling through.
      const omega = Math.abs(s.omega?.[i] ?? 0);
      const roll = omega * 0.46;
      const slip = Math.abs(s.slip?.[i] ?? 0);
      const motion = Math.min(1, roll / 12) * 0.75 + Math.min(1, slip * 1.5) * 0.55;
      const contact = grounded ? 1 : 0;
      const sampleId = `tyre.${profileKey.replace(/\s+/g, '')}`;

      // Level: contact × motion, plus a floor so a crawling wheel still reads.
      const level = contact * Math.min(1.6, motion * profile.gain + (grounded && roll > 0.2 ? 0.12 : 0));
      smoothParam(wheel.out.gain, level * this.volume, now, 0.05);
      smoothParam(wheel.band.frequency, profile.band * (0.75 + Math.min(1, roll / 18) * 0.7), now, 0.08);

      // Recorded loop takes over from the noise bed for this wheel, if present.
      if (wheel.sampleKey !== sampleId) {
        const buffer = this.library?.loop(sampleId);
        if (buffer) this._swapSample(wheel, buffer, sampleId);
      }
      const sampleMix = wheel.sample ? 1 : 0;
      if (wheel.sample) {
        const rate = Math.max(0.6, Math.min(1.9, 0.75 + roll / 14));
        smoothParam(wheel.sample.source.playbackRate, rate, now, 0.15);
        smoothParam(wheel.sample.gain.gain, level * 0.7, now, 0.08);
      }
      smoothParam(wheel.gain.gain, level * (1 - sampleMix * 0.75), now, 0.08);
      smoothParam(wheel.band.Q, profile.q, now, 0.1);
      smoothParam(wheel.crunchBand.frequency, profile.band * 1.7, now, 0.08);
      // Inside the cab the grit is filtered out by the floor pan; the body thump
      // survives, which is why a muddy trail sounds duller from the driver's seat.
      smoothParam(
        wheel.crunchGain.gain,
        contact * profile.crunch * Math.min(1, motion) * 0.5 * (1 - this.interior * 0.55) * (1 - sampleMix * 0.7),
        now,
        0.06,
      );
      smoothParam(wheel.bodyGain.gain, contact * profile.body * Math.min(1, roll / 10) * 0.12, now, 0.09);
      smoothParam(wheel.body.frequency, 55 + Math.min(1, roll / 14) * 40, now, 0.1);

      // Position the wheel in the world so panned audio follows the chassis.
      const q = body.quaternion;
      const [ox, oy, oz] = wheel.offset;
      const rx = ox * (1 - 2 * (q.y * q.y + q.z * q.z)) + oy * 2 * (q.x * q.y - q.z * q.w) + oz * 2 * (q.x * q.z + q.y * q.w);
      const ry = ox * 2 * (q.x * q.y + q.z * q.w) + oy * (1 - 2 * (q.x * q.x + q.z * q.z)) + oz * 2 * (q.y * q.z - q.x * q.w);
      const rz = ox * 2 * (q.x * q.z - q.y * q.w) + oy * 2 * (q.y * q.z + q.x * q.w) + oz * (1 - 2 * (q.x * q.x + q.y * q.y));
      this.mixer.setPannerPosition(wheel.panner, body.position.x + rx, body.position.y + ry, body.position.z + rz, now);

      // Entry splash: wheel going from dry to water is a discrete event, not a
      // level change, so it gets its own transient.
      if (wet && !wheel.wasWet && speedOf(body) > 1.5 && this.mixer.canPlay(`tyre.splash.${i}`, 0.4)) {
        this._splash(i, Math.min(1, speedOf(body) / 8));
      }
      wheel.wasWet = wet;
    }
  }

  /** Cross-fade one wheel from its previous surface loop to a new one. */
  _swapSample(wheel, buffer, key) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const previous = wheel.sample;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(wheel.sampleGain);
    source.start(now);

    if (previous) {
      smoothParam(previous.gain.gain, 0, now, 0.12);
      try {
        previous.source.stop(now + 0.5);
      } catch {
        /* already stopped */
      }
      previous.source.onended = () => {
        try {
          previous.source.disconnect();
          previous.gain.disconnect();
        } catch {
          /* already gone */
        }
      };
    }

    wheel.sample = { source, gain };
    wheel.sampleKey = key;
  }

  _splash(index, strength) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = this.mixer.noise();
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(1500, now);
    band.frequency.exponentialRampToValueAtTime(420, now + 0.35);
    band.Q.value = 0.8;
    const gain = ctx.createGain();
    oneShotEnvelope(gain, now, 0.1 + strength * 0.16, 0.01, 0.4);
    src.connect(band).connect(gain).connect(this.mixer.busInputs.tyres);
    src.start(now);
    this.mixer.track(src, now + 0.45);
  }

  /** Interior mix hears tyres through the floor: keep the body, lose the grit. */
  setInterior(amount) {
    this.interior = Math.max(0, Math.min(1, amount));
  }
}

function speedOf(body) {
  const v = body.velocity;
  return Math.hypot(v.x, v.z);
}
