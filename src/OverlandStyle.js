/* ============================================================================
 * OverlandStyle — renderer, tone mapping, presets and dual-layer fog
 *
 * Implements the "Over the Hill" look at the level it actually belongs to:
 *
 *   - Linear tone mapping plus a display-space grade, so the flat pastel
 *     palette survives to the screen without being rolled toward grey.
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
    sunColour: '#fff2d8',
    sunIntensity: 1.35,
    // The hemisphere's sky colour is what lights every up-facing surface in
    // this renderer, so a cool blue sky tint turns the sand grey. Warm it: the
    // dunes should read peach even where the sun is at a grazing angle.
    skyColour: '#f0e2d4',
    groundColour: '#f0c298',
    // High-key light: the sun is barely stronger than the sky fill, so a rock
    // face turned away from it stays pale sandstone instead of going black.
    // Reference frames have no pixel darker than about #6d4a3f.
    hemiIntensity: 1.18,
    fogDensity: 0.0042,
    fogColour: '#edc9b7',
    exposure: 0.95,
  },
  ALPINE_NOON: {
    label: 'ALPINE NOON',
    // A 3.0 key was written for ACES, which folded the top of the range back
    // into white paint. Linear clips it instead, so snow at noon needs a key
    // near the golden preset and a slightly under-exposed frame.
    sunColour: '#fffdf8',
    sunIntensity: 1.55,
    skyColour: '#a8cdf0',
    groundColour: '#b8c4c6',
    hemiIntensity: 1.35,
    fogDensity: 0.0022,
    fogColour: '#d6e7f4',
    exposure: 0.92,
  },
  ALPENGLOW_SUNSET: {
    label: 'ALPENGLOW',
    sunColour: '#ffae96',
    sunIntensity: 1.7,
    skyColour: '#b8a4d4',
    groundColour: '#d498b0',
    hemiIntensity: 1.15,
    fogDensity: 0.0055,
    fogColour: '#f6c2c8',
    exposure: 1.0,
  },
  STORM_CONVOY: {
    label: 'STORM CONVOY',
    sunColour: '#4a628a',
    sunIntensity: 0.7,
    skyColour: '#2c3a52',
    groundColour: '#162038',
    hemiIntensity: 0.9,
    fogDensity: 0.0115,
    fogColour: '#2b426b',
    // Storm is meant to be the dark one, but linear has no shoulder to lift
    // it: 0.98 left the trail a black cutout under a bright grey sky.
    exposure: 1.05,
  },
};

export const PRESET_ORDER = ['GOLDEN_MEADOW', 'ALPINE_NOON', 'ALPENGLOW_SUNSET', 'STORM_CONVOY'];

export class OverlandStyle {
  constructor({ scene, renderer, atmosphere, onToast }) {
    this.scene = scene;
    this.renderer = renderer;
    this.atmosphere = atmosphere;
    this.onToast = onToast;

    if (this.renderer) {
      // AgX needs three >= 0.162. This project pins 0.160, where the tone
      // mapping shader chunk has no AgX branch: selecting it produces an
      // invalid program and the whole scene fails to draw. ACES filmic is the
      // supported wide-DR curve here, and the presets carry the look.
      // Not ACES. The whole look is flat pastel albedo, and ACES rolls a
      // saturated peach straight into grey-white: measured on screen, the
      // authored sky #fad6c8 came out #e1e1e1 and sunlit sandstone #d7670a.
      // A linear curve keeps authored colours where the palette put them, so
      // the grade below is the only thing shaping contrast.
      this.renderer.toneMapping = THREE.LinearToneMapping;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    // Record the default without latching it. A locked preset is a deliberate
    // choice (`Y`), and booting into one meant the day/night cycle painted a
    // new sun position every frame under a fixed golden exposure.
    this.preset = 'GOLDEN_MEADOW';
    this.applyPreset('GOLDEN_MEADOW', { lock: false });
  }

  applyPreset(name, { lock = true } = {}) {
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
    this.scene.background = new THREE.Color(preset.fogColour);

    // Hand the look to the atmosphere instead of writing the lights here. The
    // phase system runs every frame; a second writer makes the sun, ambient
    // and fog oscillate between two values, which reads as the world strobing.
    if (lock && typeof this.atmosphere?.setStyleOverride === 'function') {
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
}
