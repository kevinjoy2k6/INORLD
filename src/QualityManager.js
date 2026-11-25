import * as THREE from 'three';

/**
 * Live-switchable quality tiers.
 *
 * Every numeric knob a rendering or simulation system might care about lives in
 * these presets, so switching a tier is a data change rather than a code branch.
 * Notes on the fields that cannot be changed by a simple assignment:
 *
 *   - `antialias` is read once when the WebGLRenderer is constructed (MSAA cannot
 *     be toggled on an existing context), so the manager only reports it.
 *   - `shadowType` can be changed live, but three.js needs every material in the
 *     scene recompiled afterwards. `QualityManager` does that for you.
 *   - `physicsSubSteps` is consumed by the fixed-step loop in main.js, which runs
 *     `subSteps` solver iterations of `fixedTimeStep / subSteps` each tick.
 */
export const QUALITY_PRESETS = {
  LOW: {
    id: 'LOW',
    label: 'LOW',
    hint: 'Mobile / integrated GPU',
    maxPixelRatio: 1,
    antialias: true,
    shadows: true,
    shadowMapSize: 1024,
    shadowType: THREE.PCFShadowMap,
    shadowRadius: 1,
    physicsSubSteps: 1,
    fixedTimeStep: 1 / 60,
    solverIterations: 8,
    enableGpuMudRuts: false,
    enableCanvasTracks: true,
    particleBudget: 0,
    anisotropy: 1,
    fogNear: 30,
    fogFar: 210,
    skySegments: 16,
    toneExposure: 1.0,
  },
  MEDIUM: {
    id: 'MEDIUM',
    label: 'MEDIUM',
    hint: 'Laptop / mid-range GPU',
    maxPixelRatio: 2,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    shadowType: THREE.PCFSoftShadowMap,
    shadowRadius: 3,
    physicsSubSteps: 2,
    fixedTimeStep: 1 / 60,
    solverIterations: 12,
    enableGpuMudRuts: true,
    enableCanvasTracks: true,
    particleBudget: 140,
    anisotropy: 8,
    fogNear: 50,
    fogFar: 400,
    skySegments: 32,
    toneExposure: 1.0,
  },
  HIGH: {
    id: 'HIGH',
    label: 'HIGH',
    hint: 'Desktop GPU',
    maxPixelRatio: 2,
    antialias: true,
    shadows: true,
    // 2048 is the crisp/efficient balance for the 96 m shadow camera; 4096
    // costs four times the shadow memory and fill for little visible gain.
    shadowMapSize: 2048,
    shadowType: THREE.PCFSoftShadowMap,
    shadowRadius: 4,
    physicsSubSteps: 3,
    fixedTimeStep: 1 / 60,
    solverIterations: 16,
    enableGpuMudRuts: true,
    enableCanvasTracks: true,
    particleBudget: 420,
    anisotropy: 16,
    fogNear: 70,
    fogFar: 540,
    skySegments: 48,
    toneExposure: 1.05,
  },
};

export const QUALITY_ORDER = ['LOW', 'MEDIUM', 'HIGH'];

/** Best-effort device classification used for the very first frame only. */
export function detectQualityTier() {
  const coarsePointer = window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;

  let gpu = '';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        gpu = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
      }
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    }
  } catch {
    /* GPU sniffing is optional; fall through to the core-count heuristic. */
  }

  const integrated = /(intel|uhd graphics|iris|radeon graphics|apple gpu|mali|adreno|powervr|swiftshader|llvmpipe)/.test(gpu);
  const discrete = /(rtx|gtx|radeon rx|arc a|apple m[1-9]|geforce)/.test(gpu) && !integrated;

  if (coarsePointer) return 'LOW';
  if (discrete) return 'HIGH';
  if (integrated) return cores >= 8 && memory >= 8 ? 'MEDIUM' : 'LOW';
  if (cores >= 8 && memory >= 8) return 'HIGH';
  return 'MEDIUM';
}

export class QualityManager {
  constructor(renderer, scene, tier = null) {
    this.renderer = renderer;
    this.scene = scene;
    this.tier = QUALITY_PRESETS[tier] ? tier : detectQualityTier();
    this._listeners = new Set();
    this._shadowLights = new Set();
    this._lastShadowType = null;

    this.apply();
  }

  get settings() {
    return QUALITY_PRESETS[this.tier];
  }

  /** Actual pixel ratio the renderer will use for the current device. */
  get effectivePixelRatio() {
    const device = window.devicePixelRatio || 1;
    return Math.min(device, this.settings.maxPixelRatio);
  }

  /** Register a callback fired with (settings, tier) immediately and on every change. */
  onChange(callback) {
    this._listeners.add(callback);
    callback(this.settings, this.tier);
    return () => this._listeners.delete(callback);
  }

  /** Lights whose shadow map resolution should track the tier. */
  registerShadowLight(light) {
    if (!light || !light.shadow) return;
    this._shadowLights.add(light);
    this._applyShadowLight(light);
  }

  setTier(tier) {
    if (!QUALITY_PRESETS[tier] || tier === this.tier) return this.settings;
    this.tier = tier;
    this.apply();
    return this.settings;
  }

  cycle(direction = 1) {
    const index = QUALITY_ORDER.indexOf(this.tier);
    const next = (index + direction + QUALITY_ORDER.length) % QUALITY_ORDER.length;
    return this.setTier(QUALITY_ORDER[next]);
  }

  /** Push the current preset into the renderer, lights and materials. */
  apply() {
    const renderer = this.renderer;
    const settings = this.settings;

    renderer.setPixelRatio(this.effectivePixelRatio);

    renderer.shadowMap.enabled = settings.shadows;
    renderer.toneMappingExposure = settings.toneExposure;

    const typeChanged = this._lastShadowType !== null && this._lastShadowType !== settings.shadowType;
    if (renderer.shadowMap.type !== settings.shadowType) {
      renderer.shadowMap.type = settings.shadowType;
    }
    this._lastShadowType = settings.shadowType;
    renderer.shadowMap.needsUpdate = true;

    if (typeChanged) this._recompileMaterials();

    for (const light of this._shadowLights) this._applyShadowLight(light);

    for (const listener of this._listeners) listener(settings, this.tier);
    return settings;
  }

  _applyShadowLight(light) {
    const settings = this.settings;
    const size = settings.shadowMapSize;
    light.castShadow = settings.shadows;
    if (light.shadow.mapSize.x !== size || light.shadow.mapSize.y !== size) {
      light.shadow.mapSize.set(size, size);
      // A shadow map's texture is allocated at its first render; drop it so the
      // new resolution actually takes effect.
      if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null;
      }
    }
    light.shadow.radius = settings.shadowRadius;
    light.shadow.needsUpdate = true;
  }

  _recompileMaterials() {
    if (!this.scene) return;
    this.scene.traverse((object) => {
      const material = object.material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      for (const entry of list) entry.needsUpdate = true;
    });
  }
}
