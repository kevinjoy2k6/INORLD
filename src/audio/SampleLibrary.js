/* ============================================================================
 * SampleLibrary — slots for recorded audio, synthesis when a slot is empty
 *
 * The game ships no recordings, so every layer has a synthesiser behind it. Drop
 * WAV files into assets/audio/ matching the ids in assets/audio/manifest.json
 * and this loader will prefer them: loops replace the synth bed, and impact
 * sets replace the synthesised thumps. Nothing else in the audio code has to
 * change, because every module asks the library first and falls back on its own.
 *
 * Recommended source format (see assets/audio/README.md): 48 kHz, 24-bit WAV,
 * seamless loops with the loop point at a zero crossing, peak-normalised to
 * roughly -3 dBFS so one hot file cannot dominate the mix.
 * ========================================================================== */

const MANIFEST_URL = 'assets/audio/manifest.json';

export class SampleLibrary {
  constructor({ basePath = '' } = {}) {
    this.basePath = basePath;
    this.ctx = null;
    this.manifest = { loops: {}, sets: {}, sampleRate: 48000, bitsPerSample: 24 };
    this._buffers = new Map();
    this._pending = new Set();
    this._failed = new Set();
  }

  /** Called once the mixer has an AudioContext. */
  attach(ctx) {
    this.ctx = ctx;
  }

  /**
   * Read the manifest if one is present. A 404 is the normal case until the
   * owner drops their recordings in, so it is silent, not an error.
   */
  async load() {
    try {
      const response = await fetch(`${this.basePath}${MANIFEST_URL}`, { cache: 'no-cache' });
      if (!response.ok) return false;
      const manifest = await response.json();
      if (manifest && typeof manifest === 'object') {
        this.manifest = {
          loops: manifest.loops || {},
          sets: manifest.sets || {},
          sampleRate: manifest.sampleRate || 48000,
          bitsPerSample: manifest.bitsPerSample || 24,
        };
      }
      return true;
    } catch {
      return false;
    }
  }

  /** True when a recorded file is mapped and could be loaded for this id. */
  has(id) {
    return !!(this.manifest.loops[id] || this.manifest.sets[id]);
  }

  /** Number of variations mapped for a one-shot set. */
  variationCount(id) {
    const set = this.manifest.sets[id];
    return Array.isArray(set) ? set.length : 0;
  }

  /** A loaded loop buffer, or null while it is missing/still loading. */
  loop(id) {
    if (!this.ctx) return null;
    const buffer = this._buffers.get(id);
    if (buffer) return buffer;
    if (!this._pending.has(id) && !this._failed.has(id)) this._fetch(id, this.manifest.loops[id]);
    return null;
  }

  /** A loaded one-shot variation, or null. */
  variation(id, index = 0) {
    if (!this.ctx) return null;
    const set = this.manifest.sets[id];
    if (!Array.isArray(set) || set.length === 0) return null;
    const file = set[((index % set.length) + set.length) % set.length];
    const key = `${id}#${file}`;
    const buffer = this._buffers.get(key);
    if (buffer) return buffer;
    if (!this._pending.has(key) && !this._failed.has(key)) this._fetch(key, file);
    return null;
  }

  _fetch(key, file) {
    if (!file || !this.ctx) return;
    this._pending.add(key);
    const url = /^https?:|^\//.test(file) ? file : `${this.basePath}assets/audio/${file}`;
    fetch(url)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
      .then((data) => this.ctx.decodeAudioData(data))
      .then((buffer) => {
        this._buffers.set(key, buffer);
        this._pending.delete(key);
      })
      .catch(() => {
        // Missing file: the module keeps using its synthesiser. Deliberately
        // quiet, because a half-filled asset folder is a supported state.
        this._pending.delete(key);
        this._failed.add(key);
      });
  }

  /** Statistics for the audio lab: how many layers are sample-backed. */
  getStats() {
    const loops = Object.keys(this.manifest.loops);
    const sets = Object.keys(this.manifest.sets);
    return {
      loopsMapped: loops.length,
      setsMapped: sets.length,
      buffersLoaded: this._buffers.size,
      pending: this._pending.size,
      failed: this._failed.size,
      sampleRate: this.manifest.sampleRate,
      bitsPerSample: this.manifest.bitsPerSample,
    };
  }
}
