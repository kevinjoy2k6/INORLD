/* ============================================================================
 * StyleOverhaul — Stylized Low-Poly / Flat-Shaded Adventure
 *
 * One owner for the whole look: palette, materials, lighting, fog and water.
 * The rest of the game keeps producing geometry and physics; this module
 * decides how all of it is drawn, so the style can be retuned from one file.
 *
 * The rules it implements:
 *   - flat / hard-edged shading, zero texture noise, matte surfaces
 *   - a fixed palette of flat albedos instead of PBR bitmaps
 *   - aggressive distance + height fog that shifts distance toward peach
 *   - warm golden-hour sun with a lifted lavender-blue ambient fill
 *   - water as a depth colour ramp with binary white foam at the edge
 * ========================================================================== */

import * as THREE from 'three';
import { BIOMES } from './TerrainSystem.js';
import { REGIONS } from './WorldAtlas.js';

export const PALETTE = {
  grassLit: 0xf3b552,
  grassShade: 0xd88b28,
  pineMid: 0x4e6e3a,
  pineDeep: 0x2c4223,
  autumnYellow: 0xe8c547,
  autumnOrange: 0xd96b38,
  stoneSunlit: 0xb8bcc2,
  stoneShaded: 0x8e949e,
  waterDeep: 0x48b8d0,
  waterShallow: 0x88c4c8,
  hazeNear: 0xdec4b8,
  hazeFar: 0xfce0d2,
  skyHorizon: 0xfad6c8,
  skyUpper: 0xe4eff7,
  sun: 0xfff0d6,
  ambientSky: 0xd8e2f0,
  ambientGround: 0xf0cfa0,
  vehicleYellow: 0xe8c638,
  vehicleTeal: 0x389890,
  vehicleRed: 0xd9383a,
  waterShaderDeep: 0x3ba8c4,
  waterShaderShallow: 0x9ba8a4,
};

/** Ground colours the terrain's biome lookup should use under the new palette. */
const BIOME_COLOURS = {
  trail: 0xb08a55,
  hardpack: 0xd8b36a,
  mud: 0x7d5f3d,
  sand: 0xe8c98a,
  snow: 0xeef2f5,
  rock: 0x9aa0a8,
  water: 0x5f9aa2,
};

/**
 * Apply the palette before any geometry is built: terrain colours are baked
 * into vertex colours at construction time, so this has to run first.
 */
export function applyStylePalette() {
  for (const [key, colour] of Object.entries(BIOME_COLOURS)) {
    const biome = BIOMES[key];
    if (biome) biome.color = colour;
  }
  const regionTints = {
    meadow: 0xf3b552,
    canyon: 0xd96b38,
    alpine: 0xa9b3bd,
    coast: 0xe8c98a,
  };
  for (const region of REGIONS) {
    const tint = regionTints[region.id];
    if (tint !== undefined && region.palette) region.palette.ground = tint;
  }
}

export class StyleOverhaul {
  constructor({ scene, atmosphere, renderer, terrain, vehicle, water, styleDNA }) {
    this.scene = scene;
    this.atmosphere = atmosphere;
    this.renderer = renderer;
    this.terrain = terrain;
    this.vehicle = vehicle;
    this.water = water;
    this.styleDNA = styleDNA;

    this.enabled = true;
    this.fogColour = new THREE.Color(PALETTE.hazeFar);
    this.sunColour = new THREE.Color(PALETTE.sun);
    this.skyColour = new THREE.Color(PALETTE.ambientSky);
    this.groundColour = new THREE.Color(PALETTE.ambientGround);

    // Region ground tints keep the four regions distinct inside the new
    // palette: golden meadow, rust canyon, cold alpine, bleached coast.
    this._regionTints = {
      meadow: 0xf0b455,
      canyon: 0xd0884a,
      alpine: 0xa9b3bd,
      coast: 0xe3c48f,
    };
    this._applyPalette();
    this._applyMaterials();
    this._buildSky();
    this._applyWater();
    this.tick(1);
  }

  /* ---------------- palette ---------------- */

  _applyPalette() {
    applyStylePalette();
  }

  /* ---------------- materials ---------------- */

  /**
   * Convert a subtree to matte, flat-shaded Lambert. Textures are dropped:
   * the style is flat albedo, so a bitmap map would only reintroduce noise.
   */
  flatShade(root, { keepMaps = false, skip = [] } = {}) {
    if (!root) return 0;
    let swapped = 0;

    root.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      if (skip.includes(object.name)) return;

      const apply = (material) => {
        if (!material || material.isShaderMaterial) return material;
        if (material.userData?.flatShaded) return material;

        // Sprites and glass keep their own blending behaviour.
        if (material.transparent && material.opacity < 0.9) return material;

        const flat = new THREE.MeshLambertMaterial({
          color: material.color ? material.color.clone() : new THREE.Color(0xffffff),
          vertexColors: !!material.vertexColors,
          flatShading: true,
          transparent: material.transparent,
          opacity: material.opacity,
          side: material.side,
          map: keepMaps ? material.map : null,
        });
        flat.userData.flatShaded = true;
        flat.name = material.name;
        material.dispose?.();
        swapped += 1;
        return flat;
      };

      if (Array.isArray(object.material)) object.material = object.material.map(apply);
      else object.material = apply(object.material);
    });

    return swapped;
  }

  _applyMaterials() {
    // Terrain: vertex-coloured flat ground, no detail bitmap, smooth normals so
    // the big planes stay clean instead of faceting into triangles.
    const terrain = this.terrain;
    if (terrain?.material) {
      terrain.material.map = null;
      terrain.material.vertexColors = true;
      terrain.material.roughness = 1;
      terrain.material.metalness = 0;
      terrain.material.needsUpdate = true;
    }

    // Props, landmarks, the truck and the trailer all go matte and faceted.
    const roots = [this.terrain?.group, this.styleDNA?.scene];
    for (const root of roots) {
      if (root) this.flatShade(root, { skip: ['MirrorWater', 'SkyDome', 'StyleSky'] });
    }

    // The 64 terrain chunks each ended up with their own cloned material, which
    // meant 64 material switches per frame and only one of them face-shaded.
    // Collapse them onto one shared material and turn flat shading on.
    const chunks = this.terrain?.chunks || [];
    if (chunks.length) {
      const groundMaterial = chunks[0].material;
      groundMaterial.flatShading = true;
      groundMaterial.needsUpdate = true;
      for (const chunk of chunks) chunk.material = groundMaterial;
    }
  }

  /* ---------------- water ---------------- */

  _applyWater() {
    const water = this.water?.water;
    if (!water?.material) return;
    const uniforms = water.material.uniforms;
    if (uniforms.waterColor) uniforms.waterColor.value.setHex(PALETTE.waterShaderDeep);
    if (uniforms.distortionScale) uniforms.distortionScale.value = 0.35;
    if (uniforms.size) uniforms.size.value = 1.5;
    if (uniforms.shallow) uniforms.shallow.value = new THREE.Color(PALETTE.waterShallow);
    if (uniforms.foam) uniforms.foam.value = new THREE.Color(0xffffff);
  }

  /* ---------------- sky ---------------- */

  /**
   * A two-colour gradient dome. The physical Sky shader is beautiful but its
   * colours are meteorological, not art-directed: this locks the horizon to
   * warm peach and the zenith to pale blue, which is what makes distant ridges
   * separate into planes.
   */
  _buildSky() {
    const atmosphere = this.atmosphere;
    if (atmosphere?.sky) atmosphere.sky.visible = false;

    const geometry = new THREE.SphereGeometry(1, 32, 20);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        horizonColour: { value: new THREE.Color(PALETTE.skyHorizon) },
        zenithColour: { value: new THREE.Color(PALETTE.skyUpper) },
        sunDir: { value: new THREE.Vector3(0.4, 0.6, 0.3) },
        sunColour: { value: new THREE.Color(PALETTE.sun) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize( position );
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: `
        uniform vec3 horizonColour;
        uniform vec3 zenithColour;
        uniform vec3 sunColour;
        uniform vec3 sunDir;
        varying vec3 vDir;

        void main() {
          float h = clamp( vDir.y, -1.0, 1.0 );
          vec3 colour = mix( horizonColour, zenithColour, smoothstep( -0.02, 0.62, h ) );

          // Warm bloom around the sun, and a slightly warmer haze band low down.
          float sun = max( dot( normalize( vDir ), normalize( sunDir ) ), 0.0 );
          colour += sunColour * pow( sun, 18.0 ) * 0.35;
          colour = mix( colour, horizonColour, smoothstep( 0.18, -0.12, h ) * 0.55 );

          gl_FragColor = vec4( colour, 1.0 );
        }`,
    });

    const dome = new THREE.Mesh(geometry, material);
    dome.name = 'StyleSky';
    dome.frustumCulled = false;
    dome.renderOrder = -1;
    this.scene.add(dome);
    this.sky = dome;
    return dome;
  }

  /* ---------------- lighting & atmosphere ---------------- */

  /**
   * Reassert the look after the day/night phase system has had its say, so the
   * style survives the phase change instead of drifting back to its own colours.
   */
  tick(blend = 0.25) {
    if (!this.enabled) return;
    const atmosphere = this.atmosphere;
    if (!atmosphere) return;

    const k = THREE.MathUtils.clamp(blend, 0, 1);

    if (atmosphere.sun) {
      atmosphere.sun.color.lerp(this.sunColour, k);
      atmosphere.sun.intensity = 1.45;
    }
    if (atmosphere.hemisphere) {
      atmosphere.hemisphere.color.lerp(this.skyColour, k);
      atmosphere.hemisphere.groundColor.lerp(this.groundColour, k);
      atmosphere.hemisphere.intensity = 1.25;
    }

    const fog = this.scene?.fog;
    if (fog) {
      fog.color.lerp(this.fogColour, k);
      // 0.018 from the style sheet is dense enough to erase the 640 m world;
      // 0.0075 keeps three readable depth planes and still buries the edges.
      fog.density = THREE.MathUtils.lerp(fog.density, 0.0075, k);
    }

    if (this.sky) {
      this.sky.position.copy(this.atmosphere.camera.position);
      const scale = Math.max(700, this.atmosphere.camera.far * 0.92);
      this.sky.scale.setScalar(scale);
      const dir = atmosphere.sunDirection;
      if (dir) this.sky.material.uniforms.sunDir.value.copy(dir);
    }

    // Bloom fights the matte look: keep it at a whisper.
    if (atmosphere.bloom) {
      atmosphere.bloom.strength = 0.12;
      atmosphere.bloom.threshold = 1.05;
    }
    if (this.renderer) {
      this.renderer.toneMappingExposure = THREE.MathUtils.lerp(
        this.renderer.toneMappingExposure,
        1.05,
        k,
      );
    }
  }
}
