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
  waterShaderDeep: 0x42a4cb,
  waterShaderShallow: 0x9ba8a4,
};

/*
 * Sky palette per day phase. This dome is the sky the player actually sees
 * (it hides the atmosphere's Sky shader), so it cannot be authored once at
 * golden hour: a fixed pastel horizon left night looking like an overexposed
 * dusk and overcast like a clear dawn. Values are display-space colours.
 */
const SKY_PHASES = {
  dawn: { horizon: 0xf3cbb2, zenith: 0xb9c9dc, cloudLit: 0xffe8d8, cloudShade: 0x9fadc2, sun: 0xffc8a0, cover: 0.55 },
  golden: { horizon: 0xfad6c8, zenith: 0xdfeaf4, cloudLit: 0xfff8f2, cloudShade: 0xd8b8b8, sun: 0xfff0d6, cover: 0.62 },
  // Darker than a real overcast lid needs to be, because the ground under it is
  // still lit and snow is near-white: a pale sky leaves no silhouette anywhere.
  overcast: { horizon: 0x96a4b1, zenith: 0x6c7a87, cloudLit: 0xb6c1ca, cloudShade: 0x5f6b78, sun: 0x8e9aa6, cover: 0.34 },
  night: { horizon: 0x1c2b46, zenith: 0x060b16, cloudLit: 0x2e3d58, cloudShade: 0x0b1220, sun: 0x9fb6e0, cover: 0.5 },
};

/** Ground colours the terrain's biome lookup should use under the new palette. */
const BIOME_COLOURS = {
  trail: 0xd2ab7f,
  hardpack: 0xeccb9f,
  mud: 0xb08e68,
  sand: 0xedbf9c,
  // Not paper white. Linear tone mapping clips at 1.0 with no highlight
  // roll-off, and a full-white albedo under a 1.35 key plus 1.18 fill was the
  // whole alpine region turning into a blank sheet.
  snow: 0xdfe8f0,
  rock: 0xd6a88c,
  water: 0x5f9aa2,
};

/**
 * Push a display-space colour's saturation up. The grade pass is what adds the
 * final chroma on MEDIUM/HIGH, and it does not run at all on the low preset —
 * so a slice of that saturation lives in the albedo instead, where both paths
 * get it.
 */
function saturate(hex, amount) {
  const colour = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  colour.getHSL(hsl);
  colour.setHSL(hsl.h, Math.min(1, hsl.s * amount), hsl.l);
  return colour.getHex();
}

/** The palette is baked once; a second call must not saturate it twice. */
let paletteApplied = false;

/**
 * Apply the palette before any geometry is built: terrain colours are baked
 * into vertex colours at construction time, so this has to run first.
 */
export function applyStylePalette() {
  if (paletteApplied) return;
  paletteApplied = true;
  // 1.15 here plus grade saturation 1.13 (instead of 1.3) keeps the graded look
  // where it was and gives the ungraded path about a third of the chroma back.
  const GROUND_SATURATION = 1.15;
  for (const [key, colour] of Object.entries(BIOME_COLOURS)) {
    const biome = BIOMES[key];
    if (biome) biome.color = saturate(colour, GROUND_SATURATION);
  }
  // Ground tints: the canyon is sun-bleached sand and oxidised red rock, not
  // pure orange. The rock gets its colour from MesaField's strata; the ground
  // under it has to be pale enough for the strata to sit on top of.
  // One sandstone family for the whole map: the canyon was the reference, and
  // the other three are the same ground under a different sky.
  const regionTints = {
    meadow: 0xd9ab70,
    canyon: 0xe0a888,
    alpine: 0xc49570,
    coast: 0xe7c79c,
  };
  for (const region of REGIONS) {
    const tint = regionTints[region.id];
    if (tint !== undefined && region.palette) {
      region.palette.ground = saturate(tint, GROUND_SATURATION);
    }
  }
}

/**
 * Tileable value-noise cloud field, baked once into a texture.
 *
 * The sky used to evaluate four octaves of noise in the fragment shader for
 * every pixel above the horizon; on an integrated GPU that was a fifth of the
 * frame. The same field is now built on the CPU at start-up and read back with
 * two texture fetches, which is free in comparison and looks identical.
 */
function makeCloudNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const hash = (x, y) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const wrap = (i, period) => ((i % period) + period) % period;
  const noise = (x, y, period) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash(wrap(x0, period), wrap(y0, period));
    const b = hash(wrap(x0 + 1, period), wrap(y0, period));
    const c = hash(wrap(x0, period), wrap(y0 + 1, period));
    const d = hash(wrap(x0 + 1, period), wrap(y0 + 1, period));
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let value = 0;
      let amp = 0.5;
      let period = 4;
      for (let octave = 0; octave < 4; octave += 1) {
        value += noise(u * period, v * period, period) * amp;
        amp *= 0.5;
        period *= 2;
      }
      const shade = Math.max(0, Math.min(255, Math.round((value / 0.94) * 255)));
      const i = (y * size + x) * 4;
      data[i] = shade;
      data[i + 1] = shade;
      data[i + 2] = shade;
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
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
      meadow: 0xe9b667,
      canyon: 0xe0a888,
      alpine: 0x9fb4c6,
      coast: 0xefd9b3,
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
      // Foliage must keep its own material. Their shading comes from a patched
      // onBeforeCompile shader (wind, truck shove, root-to-tip ramp, up-facing
      // normals); swapping in a fresh Lambert here silently deletes it and the
      // meadow goes back to hard dark spikes.
      if (object.name?.startsWith('Foliage_')) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some((m) => m?.userData?.windUniforms || m?.userData?.keepMaterial)) return;

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
          // Keep any texture the material already had. The tyres carry their
          // tread and mud in a canvas map on a white base colour; dropping the
          // map here left four brilliant white wheels on the truck.
          map: material.map || null,
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

    // Three's Water shader shades water almost entirely by what it reflects,
    // which under a pale sky is pale sky: the basin river came out grey-white.
    // Pulling the final radiance toward the water colour itself is what makes
    // a desert river read turquoise while still showing the mirror.
    const material = water.material;
    if (material.fragmentShader.includes('vec3 outgoingLight = albedo;')) {
      material.fragmentShader = material.fragmentShader.replace(
        'vec3 outgoingLight = albedo;',
        'vec3 outgoingLight = mix( albedo, waterColor * 1.35, 0.6 );',
      );
      material.needsUpdate = true;
    }
    if (uniforms.waterColor) uniforms.waterColor.value.setHex(PALETTE.waterShaderDeep);
    if (uniforms.distortionScale) uniforms.distortionScale.value = 0.22;
    if (uniforms.size) uniforms.size.value = 1.5;
    if (uniforms.shallow) uniforms.shallow.value = new THREE.Color(PALETTE.waterShallow);
    // The basin river is a saturated turquoise that stays blue against a pale
    // sky: the reflection alone was washing it out to grey-white.
    if (uniforms.shallowTint) uniforms.shallowTint.value.setHex(0x84cfe2);
    if (uniforms.shoreTint) uniforms.shoreTint.value = 1;
    if (uniforms.foam) uniforms.foam.value = new THREE.Color(0xf4fbff);
    if (uniforms.foam) uniforms.foam.value = new THREE.Color(0xffffff);
  }

  /* ---------------- sky ---------------- */

  /**
   * A two-colour gradient dome with procedural cumulus, shaded into the sky
   * itself. Clouds painted into the dome cost nothing extra to draw and cannot
   * be sorted, depth-tested or faded out of the frame the way separate cloud
   * geometry can: whatever the camera does, the sky shows them.
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
        cloudLit: { value: new THREE.Color(0xfff8f2) },
        cloudShade: { value: new THREE.Color(0xd8b8b8) },
        cloudNoise: { value: makeCloudNoiseTexture(256) },
        uCloudCover: { value: 0.62 },
        uTime: { value: 0 },
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
        uniform vec3 cloudLit;
        uniform vec3 cloudShade;
        uniform float uCloudCover;
        uniform float uTime;
        uniform sampler2D cloudNoise;
        varying vec3 vDir;

        void main() {
          vec3 dir = normalize( vDir );
          float h = clamp( dir.y, -1.0, 1.0 );
          // The blue has to arrive within the top third of the frame: the camera
          // sits on a hillside looking at the horizon, so a gradient that only
          // turns blue overhead paints the whole sky one flat peach.
          vec3 colour = mix( horizonColour, zenithColour, smoothstep( 0.0, 0.32, h ) );

          // A thin streaked veil rather than cumulus: the reference sky is a
          // pale wash, and heavy cloud detail competes with the rock.
          // Warm bloom around the sun, and a slightly warmer haze band low down.
          float sun = max( dot( dir, normalize( sunDir ) ), 0.0 );
          colour += sunColour * pow( sun, 18.0 ) * 0.3;
          colour = mix( colour, horizonColour, smoothstep( 0.16, -0.1, h ) * 0.42 );

          // Everything below the horizon is painted over by terrain, so skip
          // the cloud maths there: it is most of the dome, and noise is not
          // free on an integrated GPU.
          if ( h < 0.004 ) {
            gl_FragColor = vec4( colour, 1.0 );
            return;
          }

          // --- cumulus -------------------------------------------------
          // Project the view ray onto a cloud plane. Dividing by height gives
          // the deck perspective: clouds crowd toward the horizon and open out
          // overhead instead of hanging like wallpaper behind the ridge. The
          // plane is clamped so the horizon does not smear into infinity.
          vec2 uv = dir.xz / max( h, 0.045 );
          uv = uv * 0.55 + vec2( uTime * 0.005, uTime * 0.002 );

          // The noise field is a baked, tileable texture: two fetches replace
          // what used to be six analytic octaves per pixel.
          float mass = texture2D( cloudNoise, uv * 0.32 ).r;
          float detail = texture2D( cloudNoise, uv * 1.15 + vec2( 0.37, 0.11 ) ).r;
          float density = mass * 0.75 + detail * 0.45;
          float cover = smoothstep( uCloudCover, uCloudCover + 0.09, density );
          // Dissolve into the haze band at the horizon rather than ending on a
          // hard cut above the ridge line.
          cover *= smoothstep( 0.004, 0.07, h );
          // Wispy, not billowing: the sky is a pale wash and the rock is the
          // subject. Heavy cloud detail only competes with the mesas.
          cover *= 0.62;

          // Bright tops, cool bellies: density doubles as a height cue.
          float lit = 0.05 + 0.95 * smoothstep( 0.16, 0.52, density );
          vec3 cloud = mix( cloudShade, cloudLit, lit );
          cloud += sunColour * pow( sun, 6.0 ) * 0.16;

          colour = mix( colour, cloud, cover * 0.94 );

          gl_FragColor = vec4( colour, 1.0 );
        }`,
    });

    const dome = new THREE.Mesh(geometry, material);
    dome.name = 'StyleSky';
    dome.frustumCulled = false;
    dome.renderOrder = -1;
    // Advance the drift and re-centre the dome on the camera at draw time. The
    // dome used to be positioned once in tick(), so as soon as the truck drove
    // far enough the camera sat outside the sphere and the shader (and every
    // cloud in it) was simply never seen. onBeforeRender runs before three
    // builds the model-view matrix, so moving the dome here is safe and keeps
    // the sky glued to the horizon wherever the truck goes.
    let lastSky = performance.now();
    const skyTarget = new THREE.Color();
    dome.onBeforeRender = (renderer, scene, camera) => {
      const now = performance.now();
      const dt = Math.min(0.25, (now - lastSky) / 1000);
      lastSky = now;
      const u = material.uniforms;
      u.uTime.value = now * 0.001;
      dome.position.copy(camera.position);
      dome.scale.setScalar(Math.max(700, camera.far * 0.92));
      dome.updateMatrixWorld(true);

      // Follow the clock. The shader's colours are its own, so a phase change
      // has to be pushed into them here; two seconds of easing is enough that
      // the authored 25% crossfade between phases is not doubled into a snap.
      const phase = SKY_PHASES[atmosphere?.phaseId] || SKY_PHASES.golden;
      const k = 1 - Math.exp(-dt * 2.2);
      u.horizonColour.value.lerp(skyTarget.setHex(phase.horizon), k);
      u.zenithColour.value.lerp(skyTarget.setHex(phase.zenith), k);
      u.cloudLit.value.lerp(skyTarget.setHex(phase.cloudLit), k);
      u.cloudShade.value.lerp(skyTarget.setHex(phase.cloudShade), k);
      u.sunColour.value.lerp(skyTarget.setHex(phase.sun), k);
      u.uCloudCover.value += (phase.cover - u.uCloudCover.value) * k;
    };
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
