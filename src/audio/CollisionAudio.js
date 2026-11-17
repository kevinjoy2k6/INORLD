/* ============================================================================
 * CollisionAudio — impacts sized by the physics, not by a fixed sample
 *
 * The chassis body fires a cannon-es `collide` event for every contact. The
 * impulse's velocity along the contact normal is what decides the sound: a
 * 1 m/s nudge is a panel tick, 6 m/s is a body slam with a metallic ring, and
 * the pitch of the ring drops as the mass behind it drops (so a rock sounds
 * different from a loaded landing).
 *
 * Scraping is separate: sustained tangential contact with a hard body, which is
 * a continuous filtered noise layer rather than a series of thuds.
 * ========================================================================== */

import { smoothParam, oneShotEnvelope } from './AudioMixer.js';

export class CollisionAudio {
  constructor({ mixer, vehicle, library = null }) {
    this.mixer = mixer;
    this.vehicle = vehicle;
    this.library = library;
    this.ctx = null;
    this._bound = false;
    this._lastImpact = -Infinity;
    this._scrape = 0;
    this._scrapeUntil = 0;
  }

  attach(ctx) {
    this.ctx = ctx;

    const scrapeBand = ctx.createBiquadFilter();
    scrapeBand.type = 'bandpass';
    scrapeBand.frequency.value = 1900;
    scrapeBand.Q.value = 0.9;
    this.scrapeGain = ctx.createGain();
    this.scrapeGain.gain.value = 0;
    this.mixer.noise().connect(scrapeBand).connect(this.scrapeGain).connect(this.mixer.busInputs.mechanical);

    this._bind();
  }

  _bind() {
    if (this._bound) return;
    const body = this.vehicle?.body;
    if (!body || typeof body.addEventListener !== 'function') return;
    this._bound = true;

    body.addEventListener('collide', (event) => {
      if (!this.ctx) return;
      try {
        this._onCollide(event);
      } catch {
        // A malformed contact must never take down the frame.
      }
    });
  }

  _onCollide(event) {
    const contact = event.contact;
    if (!contact) return;

    // Velocity of the impact along the contact normal, in m/s. This is the only
    // honest measure of "how hard" available to audio.
    let speed = 0;
    if (typeof contact.getImpactVelocityAlongNormal === 'function') {
      speed = Math.abs(contact.getImpactVelocityAlongNormal());
    } else if (typeof contact.ni === 'object') {
      const v = this.vehicle.body.velocity;
      speed = Math.abs(v.x * contact.ni.x + v.y * contact.ni.y + v.z * contact.ni.z);
    }

    if (!Number.isFinite(speed) || speed < 1.1) return;

    const now = this.ctx.currentTime;
    const nowMs = now * 1000;
    // Impacts on consecutive substeps are one impact to the ear.
    const cooldown = speed > 5 ? 90 : 140;
    if (nowMs - this._lastImpact < cooldown) return;
    this._lastImpact = nowMs;

    if (speed > 2.6) this._impact(speed);
    else this._tick(speed);

    // Fast, glancing contact rings on for a moment as a scrape.
    if (speed > 3 && Math.random() < 0.5) this._scrapeUntil = nowMs + 220;
  }

  /** Body slam: sub-bass drop + metallic ring, pitch and level by impact speed. */
  _impact(speed) {
    if (!this.mixer.canPlay('impact.body', 0.08)) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const strength = Math.min(1, (speed - 2.2) / 9);

    // A recorded impact, if one is mapped, replaces the synthesised slam but
    // keeps the same velocity scaling so hits stay proportional.
    const recorded = this.library?.variation('impact.body', Math.floor(Math.random() * 8));
    if (recorded) {
      this._play(recorded, 0.25 + strength * 0.55, 0.9 + Math.random() * 0.25, now);
      return;
    }

    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(120 + strength * 40, now);
    thud.frequency.exponentialRampToValueAtTime(34, now + 0.22);
    const thudGain = ctx.createGain();
    oneShotEnvelope(thudGain, now, 0.22 + strength * 0.32, 0.004, 0.26);
    thud.connect(thudGain).connect(this.mixer.busInputs.mechanical);
    thud.start(now);
    thud.stop(now + 0.3);

    // Sheet metal: band-passed noise burst. Heavier hits ring lower.
    const metal = this.mixer.noise();
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(1500 - strength * 600 + Math.random() * 300, now);
    band.Q.value = 3.4;
    const metalGain = ctx.createGain();
    oneShotEnvelope(metalGain, now, 0.1 + strength * 0.2, 0.003, 0.18 + strength * 0.2);
    metal.connect(band).connect(metalGain).connect(this.mixer.busInputs.mechanical);
    metal.start(now);
    this.mixer.track(metal, now + 0.45);
  }

  /** Small knock: a rock under the floor, a branch on the bumper. */
  _tick(speed) {
    if (!this.mixer.canPlay('impact.tick', 0.05)) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const strength = Math.min(1, (speed - 1.1) / 2);

    const recorded = this.library?.variation('impact.tick', Math.floor(Math.random() * 6));
    if (recorded) {
      this._play(recorded, 0.1 + strength * 0.25, 0.95 + Math.random() * 0.2, now);
      return;
    }

    const src = this.mixer.noise();
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900 + Math.random() * 900;
    band.Q.value = 2.2;
    const gain = ctx.createGain();
    oneShotEnvelope(gain, now, 0.05 + strength * 0.1, 0.002, 0.07);
    src.connect(band).connect(gain).connect(this.mixer.busInputs.mechanical);
    src.start(now);
    this.mixer.track(src, now + 0.1);
  }

  /** One recorded impact, tracked by the mixer's voice budget. */
  _play(buffer, gainValue, rate, now) {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    source.connect(gain).connect(this.mixer.busInputs.mechanical);
    source.start(now);
    this.mixer.track(source, now + buffer.duration / rate + 0.05);
  }

  update(dt, s) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const nowMs = now * 1000;

    // Scrape decays on its own; sustained contact keeps re-arming it.
    const target = nowMs < this._scrapeUntil ? Math.min(0.08, s.speedMs * 0.006) : 0;
    this._scrape += (target - this._scrape) * Math.min(1, dt * 12);
    smoothParam(this.scrapeGain.gain, this._scrape, now, 0.05);
  }
}
