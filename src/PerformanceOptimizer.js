/* ============================================================================
 * PerformanceOptimizer — deterministic hardware profiler, live hot-swapper and
 * frame governor for INORLD.
 *
 *   • Detects a starting preset from cores / memory / pointer type / GPU string
 *     and stores the player's real settings in localStorage (INORLD_SETTINGS).
 *   • applySettings() pushes every change into the live renderer, shadow map,
 *     post-FX chain, rut deformation, foliage counts, particle pools, camera
 *     far plane and fog — no reload, ever.
 *   • update() meters FPS, optionally rescales resolution to protect the frame
 *     rate, caps the render rate, sleeps distant physics bodies and culls far
 *     props.
 *
 * Zero allocations inside the per-frame path: every scratch object used by the
 * governor lives at module scope.
 * ========================================================================== */

import * as THREE from 'three';

export const SETTINGS_KEY = 'INORLD_SETTINGS';
export const PRESET_ORDER = ['COZY', 'ULTRA_LOW', 'LOW', 'MEDIUM', 'HIGH'];

/* Shadows are stored as a symbolic mode so the UI can name them exactly. */
export const SHADOW_MODES = {
  off: { label: 'Off', size: 0, type: THREE.BasicShadowMap },
  LOW_512: { label: 'Low (512px)', size: 512, type: THREE.PCFShadowMap },
  MED_1024: { label: 'Medium (1024px)', size: 1024, type: THREE.PCFShadowMap },
  // Same filtering as the top mode, a quarter of the fill: the frame governor
  // can drop shadow resolution without changing a single shader define.
  HIGH_1024_SOFT: { label: 'High Soft (1024px)', size: 1024, type: THREE.PCFSoftShadowMap },
  HIGH_2048_SOFT: { label: 'High Soft (2048px)', size: 2048, type: THREE.PCFSoftShadowMap },
  HIGH_4096_SOFT: { label: 'Ultra Soft (4096px)', size: 4096, type: THREE.PCFSoftShadowMap },
};

export const MUD_MODES = {
  GPU_1024: { label: 'GPU 3D Ruts (High)', map: true, size: 2048 },
  GPU_512: { label: 'GPU 3D Ruts (Med)', map: true, size: 1024 },
  DECALS: { label: '2D Track Decals (Fast)', map: false, size: 0 },
  MATH_ONLY: { label: 'Physics-Only (Max FPS)', map: false, size: 0 },
};

/* ====================================================================== *
 *  Presets (exact values from the Phase 8 specification)
 * ====================================================================== */

export const PRESETS = {
  COZY: {
    id: 'COZY',
    label: 'COZY DRIVE',
    hint: 'Golden hour, full foliage, no post-FX cost',
    pixelRatio: 1.25,
    shadows: 'MED_1024',
    postProcessing: true,
    mudDeformMode: 'GPU_512',
    foliageDensity: 1,
    particleBudget: 200,
    terrainSegments: 128,
    drawDistance: 260,
    fpsCap: 60,
    physicsHz: 60,
    anisotropy: 4,
    solverIterations: 12,
  },
  ULTRA_LOW: {
    id: 'ULTRA_LOW',
    label: 'ULTRA LOW',
    hint: 'Potato / mobile battery saver',
    pixelRatio: 0.7,
    shadows: 'off',
    postProcessing: false,
    mudDeformMode: 'MATH_ONLY',
    foliageDensity: 0,
    particleBudget: 20,
    terrainSegments: 64,
    drawDistance: 110,
    fpsCap: 30,
    physicsHz: 45,
    anisotropy: 1,
    solverIterations: 6,
  },
  LOW: {
    id: 'LOW',
    label: 'LOW',
    hint: 'Mobile balanced / integrated GPU',
    pixelRatio: 1,
    shadows: 'LOW_512',
    postProcessing: false,
    mudDeformMode: 'DECALS',
    foliageDensity: 0.25,
    particleBudget: 60,
    terrainSegments: 96,
    drawDistance: 170,
    fpsCap: 60,
    physicsHz: 60,
    anisotropy: 2,
    solverIterations: 8,
  },
  MEDIUM: {
    id: 'MEDIUM',
    label: 'MEDIUM',
    hint: 'Mainstream laptop / tablet',
    pixelRatio: 1.25,
    shadows: 'MED_1024',
    postProcessing: false,
    mudDeformMode: 'GPU_512',
    foliageDensity: 0.6,
    particleBudget: 150,
    terrainSegments: 128,
    drawDistance: 240,
    fpsCap: 60,
    physicsHz: 60,
    anisotropy: 4,
    solverIterations: 12,
  },
  HIGH: {
    id: 'HIGH',
    label: 'HIGH',
    hint: 'Desktop ultra',
    pixelRatio: 2.5,
    // 4096 soft: the mesas are tall walls and their shadow edges are the main
    // read on the relief, so this is the one setting worth its fill rate.
    shadows: 'HIGH_4096_SOFT',
    postProcessing: true,
    mudDeformMode: 'GPU_1024',
    foliageDensity: 1,
    particleBudget: 520,
    terrainSegments: 192,
    drawDistance: 350,
    fpsCap: 0,
    physicsHz: 60,
    anisotropy: 16,
    solverIterations: 16,
  },
};

/** Fields that belong to the player, not to a graphics preset. */
const PLAYER_DEFAULTS = {
  // controls & mobile UI
  inputMode: 'auto', // 'auto' | 'keyboard' | 'touch'
  steeringStyle: 'wheel', // 'wheel' | 'arrows' | 'tilt'
  transmission: 'manual', // 'manual' | 'auto'
  steerSensitivity: 1,
  steerCentering: 1,
  touchScale: 1,
  hudOpacity: 0.92,
  invertOrbitX: false,
  invertOrbitY: false,
  // audio & atmosphere
  masterVolume: 0.7,
  engineVolume: 1,
  ambienceVolume: 1,
  timeOverride: 'auto', // 'auto' | 'dawn' | 'golden' | 'overcast' | 'snow' | 'night'
  // governor
  autoScaleResolution: true,
};

const PRESET_FIELDS = [
  'pixelRatio',
  'shadows',
  'postProcessing',
  'mudDeformMode',
  'foliageDensity',
  'particleBudget',
  'terrainSegments',
  'drawDistance',
  'fpsCap',
  'physicsHz',
  'anisotropy',
  'solverIterations',
];

/** Device pixel ratio, guarded against exotic values. */
function deviceRatio() {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(3, Math.max(0.75, dpr));
}

/* ====================================================================== *
 *  Hardware profiling
 * ====================================================================== */

export function readGpuString() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return '';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') : '';
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return gpu;
  } catch {
    return '';
  }
}

/**
 * Classify the machine and return the recommended preset plus the diagnostic
 * facts that the Settings banner shows.
 */
export function detectHardwareTier() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const mobileUA = /android|iphone|ipad|ipod|mobile|silk|kindle/i.test(navigator.userAgent || '');
  const gpu = readGpuString();
  const g = gpu.toLowerCase();

  const isAdreno = g.includes('adreno');
  const isMali = g.includes('mali');
  const isApple = g.includes('apple gpu') || g.includes('apple m');
  const isIntel = g.includes('intel') || g.includes('uhd graphics') || g.includes('iris');
  const isNvidia = g.includes('nvidia') || g.includes('geforce') || g.includes('rtx') || g.includes('gtx');
  const isRadeon = g.includes('radeon') || g.includes('amd');
  const isSoftware = g.includes('swiftshader') || g.includes('llvmpipe') || g.includes('software');

  let preset;
  if (isSoftware) preset = 'ULTRA_LOW';
  else if (mobileUA || coarse) {
    // Phones and tablets: flagship Apple silicon can take LOW, everything else
    // starts on the battery saver preset.
    preset = isApple && cores >= 6 ? 'LOW' : 'ULTRA_LOW';
  } else if (isNvidia || (isRadeon && cores >= 8) || (isApple && memory >= 8)) {
    preset = 'HIGH';
  } else if (isIntel || isMali || isAdreno) {
    preset = cores >= 8 && memory >= 8 ? 'MEDIUM' : 'LOW';
  } else if (cores >= 8 && memory >= 8) {
    preset = 'HIGH';
  } else {
    preset = 'MEDIUM';
  }

  return {
    preset,
    gpu: gpu || 'Unknown GPU',
    vendor: isNvidia ? 'NVIDIA' : isRadeon ? 'Radeon' : isApple ? 'Apple GPU' : isIntel ? 'Intel' : isAdreno ? 'Adreno' : isMali ? 'Mali' : 'Unknown',
    cores,
    memory,
    mobile: mobileUA,
    coarse,
  };
}

/** Full settings object for a preset id, including the player's own options. */
export function presetSettings(id) {
  const preset = PRESETS[id] || PRESETS.MEDIUM;
  const out = { ...PLAYER_DEFAULTS, preset: preset.id };
  for (const field of PRESET_FIELDS) out[field] = preset[field];
  // ULTRA_LOW deliberately renders below native resolution (0.70x); the rest
  // are capped at the device ratio, exactly as the preset table describes.
  out.pixelRatio = preset.id === 'ULTRA_LOW' ? 0.7 : Math.min(deviceRatio(), preset.pixelRatio);
  return out;
}

/** The recommended settings for this machine (used on first launch + reset). */
export function recommendedSettings() {
  const hw = detectHardwareTier();
  if (typeof window !== 'undefined') window.__inorldHardware = hw;
  const settings = presetSettings(hw.preset);
  settings.autoDetectedPreset = hw.preset;
  settings.gpu = hw.gpu;
  return settings;
}

function sanitise(raw) {
  const base = recommendedSettings();
  if (!raw || typeof raw !== 'object') return base;
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (raw[key] === undefined) continue;
    const type = typeof base[key];
    if (type === 'number') {
      const n = Number(raw[key]);
      if (Number.isFinite(n)) out[key] = n;
    } else if (type === 'boolean') {
      out[key] = !!raw[key];
    } else if (type === 'string') {
      out[key] = String(raw[key]);
    }
  }
  // Numeric guards so a corrupted store cannot brick the game.
  out.pixelRatio = Math.min(2, Math.max(0.4, out.pixelRatio));
  out.drawDistance = Math.min(350, Math.max(100, out.drawDistance));
  out.foliageDensity = Math.min(1, Math.max(0, out.foliageDensity));
  out.particleBudget = Math.min(400, Math.max(0, out.particleBudget));
  out.fpsCap = [0, 30, 60].includes(out.fpsCap) ? out.fpsCap : 60;
  out.physicsHz = [45, 50, 60].includes(out.physicsHz) ? out.physicsHz : 60;
  out.touchScale = Math.min(1.4, Math.max(0.8, out.touchScale));
  out.hudOpacity = Math.min(1, Math.max(0.4, out.hudOpacity));
  out.steerSensitivity = Math.min(2, Math.max(0.5, out.steerSensitivity));
  out.steerCentering = Math.min(2, Math.max(0.5, out.steerCentering));
  if (!PRESETS[out.preset]) out.preset = 'CUSTOM';
  return out;
}

/** Synchronous read used before the world is built (terrain, etc.). */
export function loadStoredSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return recommendedSettings();
    return sanitise(JSON.parse(raw));
  } catch {
    return recommendedSettings();
  }
}

/* ====================================================================== *
 *  Scratch objects — nothing here allocates during a frame
 * ====================================================================== */

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _mat4 = new THREE.Matrix4();
const _frustum = new THREE.Frustum();

/* ====================================================================== */

export class PerformanceOptimizer {
  constructor({
    renderer,
    scene,
    camera,
    sun = null,
    terrain = null,
    rutSystem = null,
    tactile = null,
    atmosphere = null,
    audio = null,
    cameraController = null,
    world = null,
    vehicle = null,
    trailer = null,
    settings = null,
  } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.sun = sun;
    this.terrain = terrain;
    this.rutSystem = rutSystem;
    this.tactile = tactile;
    this.atmosphere = atmosphere;
    this.audio = audio;
    this.cameraController = cameraController;
    this.world = world;
    this.vehicle = vehicle;
    this.trailer = trailer;

    this.settings = sanitise(settings || loadStoredSettings());
    this.hardware = window.__inorldHardware || detectHardwareTier();
    this.listeners = new Set();

    /* --- metering --- */
    this.fps = 60;
    this.frameMs = 16.7;
    this._frameTimes = new Float32Array(90);
    this._frameIndex = 0;
    this._frameCount = 0;
    this._telemetryTimer = 0;
    this._lastRenderAt = 0;

    /* --- culling / sleeping --- */
    this.cullables = [];
    this._sleepTimer = 0;

    // With the composer multiple passes render per frame; without this the
    // telemetry would only ever report the last fullscreen quad.
    if (this.renderer && this.renderer.info) this.renderer.info.autoReset = false;
    this.renderStats = { calls: 0, triangles: 0 };

    this._applyAll(this.settings, { persist: false, silent: true });
  }

  /* ================= persistence & pub/sub ================= */

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(reason) {
    for (const fn of this.listeners) fn(this.settings, reason);
  }

  save() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* Private-mode storage is best-effort. */
    }
  }

  getPreset() {
    return PRESETS[this.settings.preset] || null;
  }

  get physicsStep() {
    return 1 / Math.max(30, this.settings.physicsHz);
  }

  get physicsSubSteps() {
    return this.settings.physicsHz >= 55 ? 1 : 2;
  }

  /* ================= public mutation API ================= */

  /** Merge + apply + persist. Passing a preset id switches every preset field. */
  applySettings(partial, { persist = true, markCustom = true } = {}) {
    if (partial && partial.preset && PRESETS[partial.preset]) {
      const merged = { ...this.settings };
      for (const field of PRESET_FIELDS) merged[field] = PRESETS[partial.preset][field];
      merged.preset = partial.preset;
      for (const key of Object.keys(partial)) {
        if (key === 'preset') continue;
        if (key in merged) merged[key] = partial[key];
      }
      this.settings = merged;
    } else {
      this.settings = { ...this.settings, ...partial };
      if (markCustom && partial && Object.keys(partial).some((k) => PRESET_FIELDS.includes(k))) {
        this.settings.preset = 'CUSTOM';
      }
    }

    this.settings = sanitise(this.settings);
    this._applyAll(this.settings, { persist, silent: false });
    this._emit('settings');
    return this.settings;
  }

  setPreset(id) {
    return this.applySettings({ preset: id }, { markCustom: false });
  }

  resetToRecommended() {
    const next = recommendedSettings();
    this.settings = next;
    this._applyAll(next, { persist: true, silent: false });
    this._emit('reset');
    return this.settings;
  }

  cyclePreset(direction = 1) {
    const order = ['ULTRA_LOW', 'LOW', 'MEDIUM', 'HIGH'];
    const current = order.indexOf(this.settings.preset);
    const nextIndex = current < 0 ? (direction > 0 ? 0 : order.length - 1) : (current + direction + order.length) % order.length;
    return this.setPreset(order[nextIndex]);
  }

  /* ================= live application ================= */

  _applyAll(settings, { persist, silent }) {
    this._applyPixelRatio(settings.pixelRatio);
    this._applyShadows(settings);
    this._applyPostProcessing(settings);
    this._applyMudMode(settings);
    this._applyFoliage(settings);
    this._applyParticles(settings);
    this._applyViewDistance(settings);
    this._applyAudio(settings);
    this._applyAtmosphere(settings);
    this._applyControls(settings);
    if (persist) this.save();
    if (!silent) this._emit('apply');
  }

  _applyPixelRatio(ratio) {
    const renderer = this.renderer;
    if (!renderer) return;
    const value = Math.min(2.5, Math.max(0.4, ratio));
    const width = Math.round(window.innerWidth * value);
    const height = Math.round(window.innerHeight * value);
    // Every ratio change reallocates the drawing buffer and the composer's
    // targets. Resizing costs milliseconds, so skip the no-ops: a window resize
    // still gets through because the size changed, not the ratio.
    if (this.effectivePixelRatio === value && this.renderedWidth === width && this.renderedHeight === height) {
      return value;
    }
    renderer.setPixelRatio(value);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (renderer.domElement) {
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
    }
    this.effectivePixelRatio = value;
    this.renderedWidth = width;
    this.renderedHeight = height;
    if (this.atmosphere && typeof this.atmosphere.onResolutionChanged === 'function') {
      this.atmosphere.onResolutionChanged(value);
    }
    return value;
  }

  /**
   * Dynamic-resolution hook for the frame governor. Applies a full scale change
   * (renderer, drawing buffer, composer) without touching persistence or the
   * player's preset, and returns the value actually used.
   */
  scaleResolution(ratio) {
    const value = this._applyPixelRatio(ratio) ?? Math.min(2.5, Math.max(0.4, ratio));
    this.settings.pixelRatio = value;
    this.effectivePixelRatio = value;
    return value;
  }

  _applyShadows(settings) {
    const renderer = this.renderer;
    if (!renderer) return;
    const mode = SHADOW_MODES[settings.shadows] || SHADOW_MODES.off;
    const enabled = mode.size > 0;
    // Recompiling every material in the scene is a multi-frame hitch, so it may
    // only happen when the shadow *sampling* changes. The map resolution is a
    // texture size, not a define, so dropping it from 2048 to 1024 must not
    // recompile the world — otherwise the frame governor's first rung costs the
    // machine it is trying to rescue several hundred milliseconds.
    const definesKey = `${mode.type}:${enabled}`;
    const changed = definesKey !== this._shadowSignature;
    this._shadowSignature = definesKey;

    renderer.shadowMap.enabled = enabled;
    renderer.shadowMap.type = mode.type;
    renderer.shadowMap.needsUpdate = true;

    if (this.sun && this.sun.shadow) {
      this.sun.castShadow = enabled;
      if (mode.size > 0) {
        if (this.sun.shadow.mapSize.x !== mode.size) {
          this.sun.shadow.mapSize.set(mode.size, mode.size);
          // The map is allocated on first use; drop it so the new size lands.
          if (this.sun.shadow.map) {
            this.sun.shadow.map.dispose();
            this.sun.shadow.map = null;
          }
        }
        this.sun.shadow.radius = mode.type === THREE.PCFSoftShadowMap ? 2.4 : 1.2;
        this.sun.shadow.needsUpdate = true;
      }
    }

    // Toggling the shadow map changes every material's program.
    if (changed && this.scene) {
      this.scene.traverse((object) => {
        if (!object.material) return;
        const list = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of list) material.needsUpdate = true;
      });
    }
  }

  _applyPostProcessing(settings) {
    if (this.atmosphere && typeof this.atmosphere.setPostProcessing === 'function') {
      this.atmosphere.setPostProcessing(settings.postProcessing);
    }
  }

  _applyMudMode(settings) {
    if (this.rutSystem && typeof this.rutSystem.setDeformMode === 'function') {
      this.rutSystem.setDeformMode(settings.mudDeformMode);
    }
  }

  _applyFoliage(settings) {
    if (this.terrain && typeof this.terrain.setFoliageDensity === 'function') {
      this.terrain.setFoliageDensity(settings.foliageDensity);
    }
  }

  _applyParticles(settings) {
    if (this.tactile && typeof this.tactile.setParticleBudget === 'function') {
      this.tactile.setParticleBudget(settings.particleBudget / 400);
    }
  }

  _applyViewDistance(settings) {
    const distance = Math.min(400, Math.max(90, settings.drawDistance));
    if (this.camera) {
      this.camera.far = distance * 2.2; // keep the sky dome inside the frustum
      this.camera.updateProjectionMatrix();
    }
    if (this.atmosphere && typeof this.atmosphere.setViewDistance === 'function') {
      this.atmosphere.setViewDistance(distance);
    }
    // The prop and ground-cover horizon has to move with the view distance, or
    // the fog hides a cut that still costs a full draw call per chunk.
    if (this.terrain && typeof this.terrain.setViewDistance === 'function') {
      this.terrain.setViewDistance(distance);
    }
    if (this.terrain && this.terrain.mesh) {
      this.terrain.mesh.frustumCulled = true;
    }
  }

  _applyAudio(settings) {
    if (!this.audio) return;
    if (typeof this.audio.setVolume === 'function') this.audio.setVolume(settings.masterVolume);
    if (typeof this.audio.setEngineVolume === 'function') this.audio.setEngineVolume(settings.engineVolume);
    if (typeof this.audio.setAmbienceVolume === 'function') this.audio.setAmbienceVolume(settings.ambienceVolume);
  }

  _applyAtmosphere(settings) {
    if (!this.atmosphere) return;
    if (typeof this.atmosphere.setDynamicCycle === 'function') {
      this.atmosphere.setDynamicCycle(settings.timeOverride === 'auto');
    }
    if (settings.timeOverride !== 'auto' && typeof this.atmosphere.setTimePreset === 'function') {
      this.atmosphere.setTimePreset(settings.timeOverride);
    }
  }

  _applyControls(settings) {
    if (!this.cameraController) return;
    this.cameraController.invertX = !!settings.invertOrbitX;
    this.cameraController.invertY = !!settings.invertOrbitY;
  }

  /* ================= culling + sleeping ================= */

  /** Objects whose visibility should follow the player's draw distance. */
  registerCullable(object, { margin = 24 } = {}) {
    if (!object) return;
    this.cullables.push({ object, margin });
  }

  _updateCulling(camera) {
    if (!camera) return;
    camera.updateMatrixWorld();
    _mat4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_mat4);

    const far = camera.far;
    for (const entry of this.cullables) {
      const object = entry.object;
      if (!object) continue;
      object.getWorldPosition(_v3a);
      const visible = _v3a.distanceTo(camera.position) < far && _frustum.containsPoint(_v3a);
      object.visible = visible && object.userData.forceVisible !== true;
    }
  }

  _updatePhysicsSleeping(cameraPosition) {
    if (!this.world || !this.vehicle) return;
    for (const body of this.world.bodies) {
      if (!body.mass) continue; // static props are not simulated anyway
      if (body === this.vehicle.body) continue;
      if (this.trailer && body === this.trailer.body) continue;
      body.position && _v3a.set(body.position.x, body.position.y, body.position.z);
      if (_v3a.distanceTo(cameraPosition) > 60 && body.sleepState !== 2) body.sleep();
      else if (_v3a.distanceTo(cameraPosition) <= 60 && body.sleepState === 2) body.wakeUp();
    }
  }

  /* ================= frame governor ================= */

  /**
   * Feed one rendered frame. Returns the FPS average used by the HUD and the
   * auto-scaler.
   */
  update(dt, nowMs) {
    const ms = Math.max(0.1, dt * 1000);
    this._frameTimes[this._frameIndex] = ms;
    this._frameIndex = (this._frameIndex + 1) % this._frameTimes.length;
    this._frameCount = Math.min(this._frameCount + 1, this._frameTimes.length);

    let total = 0;
    for (let i = 0; i < this._frameCount; i += 1) total += this._frameTimes[i];
    this.frameMs = total / Math.max(1, this._frameCount);
    this.fps = this.frameMs > 0 ? 1000 / this.frameMs : 0;

    this._telemetryTimer += dt;
    if (this._telemetryTimer >= 0.5) {
      this._telemetryTimer = 0;
      this._autoScale(nowMs);
      this._updateCulling(this.camera);
      this._updatePhysicsSleeping(this.camera ? this.camera.position : _v3b.set(0, 0, 0));
    }
  }

  /** Render-rate limiter; true when this frame should draw. */
  shouldRender(nowMs) {
    const cap = this.settings.fpsCap;
    if (!cap) {
      this._lastRenderAt = nowMs;
      return true;
    }
    const interval = 1000 / cap - 1.5;
    if (nowMs - this._lastRenderAt >= interval) {
      this._lastRenderAt = nowMs;
      return true;
    }
    return false;
  }

  _autoScale(nowMs) {
    // When the frame governor owns the resolution, a second auto-scaler writing
    // its own value a few times a second just makes the image breathe.
    if (this.externalScaleControl) return;
    if (!this.settings.autoScaleResolution) return;
    if (this._frameCount < 45) return;
    if (this.fps >= 42) return;
    if (this.settings.pixelRatio <= 0.56) return;
    const next = Math.max(0.55, Math.round((this.settings.pixelRatio - 0.15) * 100) / 100);
    this.settings.pixelRatio = next;
    this._applyPixelRatio(next);
    this.save();
    this._emit('autoscale');
    if (this.atmosphere && this.atmosphere.onResolutionChanged) {
      this.atmosphere.onResolutionChanged(next, nowMs);
    }
  }

  /** Window resize hook: re-apply the scale and keep the composer in sync. */
  resize() {
    this._applyPixelRatio(this.settings.pixelRatio);
  }

  /** Called once per drawn frame, right after the final pass. */
  captureRenderStats() {
    if (!this.renderer) return;
    const info = this.renderer.info.render;
    this.renderStats.calls = info.calls;
    this.renderStats.triangles = info.triangles;
    this.renderer.info.reset();
  }

  getTelemetry() {
    const info = this.renderStats || { calls: 0, triangles: 0 };
    return {
      fps: Math.round(this.fps),
      frameMs: Math.round(this.frameMs * 10) / 10,
      calls: info.calls,
      triangles: info.triangles,
      gpu: this.settings.gpu || this.hardware.gpu,
      preset: this.settings.preset,
      health: this.fps >= 50 ? 'good' : this.fps >= 30 ? 'warn' : 'bad',
      pixelRatio: this.effectivePixelRatio,
      renderedWidth: this.renderedWidth,
      renderedHeight: this.renderedHeight,
    };
  }
}

export { PLAYER_DEFAULTS, PRESET_FIELDS, deviceRatio };
