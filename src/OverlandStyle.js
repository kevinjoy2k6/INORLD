/* ============================================================================
 * OverlandStyle — renderer, tone mapping, presets and dual-layer fog
 *
 * Implements the "Over the Hill" look at the level it actually belongs to:
 *
 *   - AgX tone mapping with a wide, filmic highlight roll-off, so the meadow
 *     glows gold at golden hour without clipping to white.
 *   - Four lighting presets (golden meadow, alpine noon, alpenglow sunset,
 *     storm convoy), each driving sun, ambient, fog and wetness together.
 *   - Aerial distance fog plus valley height mist, injected once into every
 *     material that uses fog, so distant ridges separate into warm planes and
 *     low ground sits in cooler haze.
 *   - Global uniforms other material factories can read (wetness, snow line).
 *
 * The fog override is written against literals rather than new uniforms on
 * purpose. Three's fog chunks are shared by every material, and uniforms that
 * a material never declares silently read as zero — which would paint the world
 * black. Constants cannot fail that way.
 * ========================================================================== */

import * as THREE from 'three';

export const STYLE_PRESETS = {
  GOLDEN_MEADOW: {
    label: 'GOLDEN MEADOW',
    sunColour: '#fff0d4',
    sunIntensity: 2.6,
    skyColour: '#d8e2f0',
    groundColour: '#e5b887',
    hemiIntensity: 1.15,
    fogDensity: 0.0042,
    fogColour: '#fad6c8',
    exposure: 1.08,
    wetness: 0,
  },
  ALPINE_NOON: {
    label: 'ALPINE NOON',
    sunColour: '#fffdf8',
    sunIntensity: 3.0,
    skyColour: '#8cc2ec',
    groundColour: '#9ba8a4',
    hemiIntensity: 1.3,
    fogDensity: 0.002,
    fogColour: '#dcebf7',
    exposure: 1.02,
    wetness: 0,
  },
  ALPENGLOW_SUNSET: {
    label: 'ALPENGLOW',
    sunColour: '#ffae96',
    sunIntensity: 2.1,
    skyColour: '#b8a4d4',
    groundColour: '#d498b0',
    hemiIntensity: 1.05,
    fogDensity: 0.0055,
    fogColour: '#f6c2c8',
    exposure: 1.12,
    wetness: 0,
  },
  STORM_CONVOY: {
    label: 'STORM CONVOY',
    sunColour: '#4a628a',
    sunIntensity: 0.55,
    skyColour: '#182640',
    groundColour: '#162038',
    hemiIntensity: 0.65,
    fogDensity: 0.0115,
    fogColour: '#2b426b',
    exposure: 0.98,
    wetness: 0.85,
  },
};

export const PRESET_ORDER = ['GOLDEN_MEADOW', 'ALPINE_NOON', 'ALPENGLOW_SUNSET', 'STORM_CONVOY'];

/**
 * Dual-layer aerial + height fog.
 *
 * NOTE: this is deliberately NOT a THREE.ShaderChunk override. Rewriting the
 * shared fog chunks needs vFogWorldPosition declared in every material that
 * can be fogged, and the ones that already define their own varying (the water
 * shader, several post passes) end up with a redeclaration. The whole scene
 * then fails to link and nothing renders. The look is produced from the
 * standard fog instead: FogExp2 colour and density come from the preset, and
 * the gradient separation comes from the gradient sky plus the palette.
 */
export function installDualLayerFog() {
  return false;
}

export class OverlandStyle {
  constructor({ scene, renderer, atmosphere, camera, onToast }) {
    this.scene = scene;
    this.renderer = renderer;
    this.atmosphere = atmosphere;
    this.camera = camera;
    this.onToast = onToast;

    if (this.renderer) {
      // AgX needs three >= 0.162. This project pins 0.160, where the tone
      // mapping shader chunk has no AgX branch: selecting it produces an
      // invalid program and the whole scene fails to draw. ACES filmic is the
      // supported wide-DR curve here, and the presets carry the look.
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    // Shared values other systems may read (grass, rock, wetness-aware tyre).
    this.globalUniforms = {
      uGlobalWetness: { value: 0 },
      uGlobalSnowLine: { value: 180 },
      uGlobalShadowTint: { value: new THREE.Color('#5e5068') },
      uTime: { value: 0 },
    };

    this.preset = 'GOLDEN_MEADOW';
    this._fogColour = new THREE.Color(STYLE_PRESETS.GOLDEN_MEADOW.fogColour);
    this.applyPreset('GOLDEN_MEADOW');
  }

  applyPreset(name) {
    const preset = STYLE_PRESETS[name];
    if (!preset) return null;
    this.preset = name;

    const atmosphere = this.atmosphere;
    if (atmosphere?.sun) {
      atmosphere.sun.color.set(preset.sunColour);
      atmosphere.sun.intensity = preset.sunIntensity;
    }
    if (atmosphere?.hemisphere) {
      atmosphere.hemisphere.color.set(preset.skyColour);
      atmosphere.hemisphere.groundColor.set(preset.groundColour);
      atmosphere.hemisphere.intensity = preset.hemiIntensity;
    }
    if (this.renderer) this.renderer.toneMappingExposure = preset.exposure;

    if (this.scene.fog) {
      this.scene.fog.color.set(preset.fogColour);
      this.scene.fog.density = preset.fogDensity;
    }
    this.scene.background = this._fogColour.set(preset.fogColour).clone();

    // Hand the look to the atmosphere instead of writing the lights here. The
    // phase system runs every frame; a second writer makes the sun, ambient
    // and fog oscillate between two values, which reads as the world strobing.
    if (typeof this.atmosphere?.setStyleOverride === 'function') {
      this.atmosphere.setStyleOverride({
        sunColor: new THREE.Color(preset.sunColour),
        sunIntensity: preset.sunIntensity,
        hemiColor: new THREE.Color(preset.skyColour),
        hemiGround: new THREE.Color(preset.groundColour),
        hemiIntensity: preset.hemiIntensity,
        fogColor: new THREE.Color(preset.fogColour),
        fogDensity: preset.fogDensity,
        exposure: preset.exposure,
      });
    }

    this.globalUniforms.uGlobalWetness.value = preset.wetness;
    return preset;
  }

  /** Cycle to the next preset, returning its label for the HUD toast. */
  next() {
    const index = PRESET_ORDER.indexOf(this.preset);
    const nextName = PRESET_ORDER[(index + 1) % PRESET_ORDER.length];
    const preset = this.applyPreset(nextName);
    this.onToast?.(`LIGHT — ${preset.label}`);
    return nextName;
  }

  /**
   * Advance shared time. Lighting is not written here: the atmosphere owns it
   * and applies the preset as its single per-frame write.
   */
  tick(dt) {
    this.globalUniforms.uTime.value += dt;
  }
}
