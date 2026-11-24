/* ============================================================================
 * AtmosphereAndPostFX — living sky, golden hour, night trail runs, bloom
 *
 *  - Real three.js Sky shader + PMREM environment lighting (sun reflections on
 *    paint, chrome and snow) regenerated only when the light actually changes.
 *  - A full day/night cycle through four authored phases:
 *        Dawn Mist -> Golden Hour -> Overcast (rain/snow) -> Night
 *    The host owns the clock and broadcasts it, so a squad watches the same
 *    sunset (see sendTimeSync/applyTimeSync).
 *  - FogExp2 whose density grows with height and with the selected phase.
 *  - EffectComposer (RenderPass + bloom + grade + sharpen + OutputPass, all
 *    linear) on MEDIUM/HIGH; a plain forward pass on LOW.
 *  - Night driving: SpotLight headlights, additive volumetric cones, glowing
 *    tail, brake and reverse lamps on truck + trailer.
 *  - Campfire outposts (flicker + embers) with a co-op rest action, and a
 *    cinematic photo mode with free-fly camera, FOV/DOF controls and a
 *    stylised INORLD watermark.
 * ========================================================================== */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* ---- authored phases --------------------------------------------- */
/* `t` runs 0..1 across a full day. Each phase owns its look. */
const PHASES = [
  {
    id: 'dawn',
    label: 'DAWN MIST',
    t0: 0.0,
    // 4 degrees put almost no light on flat ground (N.L = sin(4 deg) = 0.07),
    // so the basin read as flat blue-grey and only the cliff tops caught any
    // sun. Nine degrees still gives long shadows but lights the valley floor.
    elevation: 9,
    azimuth: 100,
    sunColor: 0xffd2a4,
    sunIntensity: 1.9,
    ambient: 0xdbe5ef,
    ambientIntensity: 1.05,
    fogColor: 0xc2d0dc,
    fogDensity: 0.0095,
    exposure: 1.0,
    bloom: 0.1,
    turbidity: 7.0,
    rayleigh: 2.6,
    mieCoefficient: 0.006,
    mieDirectionalG: 0.82,
    night: false,
    weather: 'mist',
  },
  {
    id: 'golden',
    label: 'GOLDEN HOUR',
    t0: 0.25,
    // 13 degrees lit the ground at 0.22 of full strength: every flat surface
    // went brown while the cliff faces blazed. The reference sun sits high
    // enough to light the whole basin evenly.
    elevation: 42,
    azimuth: 205,
    // These are the tuned values, not the pre-linear ones. The phase used to
    // sit under a latched GOLDEN_MEADOW preset, so its own 3.1-intensity orange
    // sun was never actually rendered; under linear tone mapping that value
    // clips every lit surface to white. The high-key palette lives here now.
    sunColor: 0xfff2d8,
    sunIntensity: 1.35,
    ambient: 0xf0e2d4,
    ambientIntensity: 1.18,
    fogColor: 0xedc9b7,
    fogDensity: 0.0042,
    exposure: 0.95,
    bloom: 0.12,
    turbidity: 2.4,
    rayleigh: 1.6,
    mieCoefficient: 0.0035,
    mieDirectionalG: 0.86,
    night: false,
    weather: 'clear',
  },
  {
    id: 'overcast',
    label: 'OVERCAST',
    t0: 0.5,
    elevation: 40,
    azimuth: 330,
    // Diffuse, not dim: an overcast lid is mostly ambient, and with linear
    // tone mapping a weak key plus a dark sky just went muddy. The grey comes
    // from turbidity below, the light from the hemisphere.
    sunColor: 0xc3ceda,
    sunIntensity: 1.0,
    ambient: 0xb4c2d0,
    // 1.5 of ambient against a pale lid erased every facet on the alpine ridge:
    // white snow, white fog and a white sky. Keep a little key and less fill.
    ambientIntensity: 1.3,
    fogColor: 0x93a3b2,
    fogDensity: 0.0075,
    exposure: 1.0,
    bloom: 0.07,
    turbidity: 16.0,
    rayleigh: 0.5,
    mieCoefficient: 0.02,
    mieDirectionalG: 0.55,
    night: false,
    weather: 'rain',
  },
  {
    id: 'night',
    label: 'NIGHT TRAIL',
    t0: 0.75,
    // A moon above the ridge, not a sun below it. At -14 degrees the key light
    // contributed nothing to the ground, and the old ACES curve happened to
    // lift the ambient into a legible blue; under linear tone mapping the same
    // numbers collapsed to near-black, and the headlights only lit the ruts.
    elevation: 16,
    azimuth: 25,
    sunColor: 0xa9c0ec,
    sunIntensity: 0.4,
    ambient: 0x2f4665,
    ambientIntensity: 0.62,
    fogColor: 0x0b1522,
    fogDensity: 0.014,
    exposure: 1.3,
    bloom: 0.34,
    turbidity: 1.2,
    rayleigh: 0.35,
    mieCoefficient: 0.001,
    mieDirectionalG: 0.9,
    night: true,
    weather: 'clear',
  },
];

const DAY_SECONDS = 300; // one full cycle in 5 minutes of driving

/*
 * Edge sharpen, applied after the grade and before tone mapping.
 *
 * The low-poly look lives or dies on crisp silhouettes: bloom, fog and the
 * half-resolution output buffer all smear edges, and soft edges make a
 * faceted world read as a blurry one. A nine-tap unsharp mask takes back about
 * a pixel of that without the ringing a full-strength sharpen leaves on the
 * sky. The amount is modulated by local contrast so flat areas (fog, haze,
 * paint) stay smooth and only real edges get the boost.
 */
const SHARPEN_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uStrength: { value: 1.15 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uStrength;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D( tDiffuse, vUv );
      vec3 c = base.rgb;

      vec3 n = texture2D( tDiffuse, vUv + vec2( 0.0, uTexel.y ) ).rgb;
      vec3 s = texture2D( tDiffuse, vUv - vec2( 0.0, uTexel.y ) ).rgb;
      vec3 e = texture2D( tDiffuse, vUv + vec2( uTexel.x, 0.0 ) ).rgb;
      vec3 w = texture2D( tDiffuse, vUv - vec2( uTexel.x, 0.0 ) ).rgb;
      vec3 ne = texture2D( tDiffuse, vUv + uTexel ).rgb;
      vec3 nw = texture2D( tDiffuse, vUv + vec2( -uTexel.x, uTexel.y ) ).rgb;
      vec3 se = texture2D( tDiffuse, vUv + vec2( uTexel.x, -uTexel.y ) ).rgb;
      vec3 sw = texture2D( tDiffuse, vUv - uTexel ).rgb;

      vec3 blur = ( n + s + e + w ) * 0.15 + ( ne + nw + se + sw ) * 0.1;
      vec3 detail = c - blur;

      // Only crisp real edges: haze and flat paint keep their gradient.
      float edge = smoothstep( 0.003, 0.045, length( detail ) );
      float amount = uStrength * ( 0.4 + 0.6 * edge );

      gl_FragColor = vec4( clamp( c + detail * amount, 0.0, 1.0 ), base.a );
    }`,
};

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(out, a, b, t) {
  out.setHex(a).lerp(new THREE.Color(b), t);
  return out;
}

export class AtmosphereAndPostFX {
  constructor({
    renderer,
    scene,
    camera,
    sun,
    hemisphere,
    skyDome = null,
    quality,
    vehicle,
    trailer,
    terrain,
    networkManager = null,
    missionManager = null,
  }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.sun = sun;
    this.hemisphere = hemisphere;
    this.skyDome = skyDome;
    this.quality = quality;
    this.vehicle = vehicle;
    this.trailer = trailer;
    this.terrain = terrain;
    this.networkManager = networkManager;
    this.missionManager = missionManager;

    this.time = 0.28; // start in golden hour
    this.running = true;
    this.phase = PHASES[1];
    // A style preset can lock the lights to a fixed look. This is the ONLY
    // other writer of sun/ambient/fog besides the phase blend below, and it is
    // applied as part of that single write. Two systems each setting the sun
    // every frame makes the whole world strobe.
    this.styleOverride = null;
    this.night = false;
    this.weather = 'clear';
    this.daySeconds = DAY_SECONDS;

    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._pmrem.compileEquirectangularShader();
    // Sun direction the current environment map was built from, so the rebuild
    // can be skipped while the sky is effectively unchanged.
    this._lastEnvDir = new THREE.Vector3();
    this._envRT = null;
    this._envDirty = true;
    this._envTimer = 0;

    this._tmpColor = new THREE.Color();
    this._snowFog = new THREE.Color(0xd6e2ec);
    this.weatherMode = 'clear';
    // 240 m was the whole draw of a 640 m valley. On 2 km of ground the
    // treeline has to be two or three ridges out before the haze takes it.
    this.viewDistance = 380;
    this._sunDir = new THREE.Vector3();

    /* ---- sky ---- */
    if (this.skyDome) this.skyDome.visible = false; // replaced by the Sky shader
    this.sky = new Sky();
    // The camera far plane is 1200 m, so the dome has to live inside it —
    // the Sky shader only cares about view direction, not distance.
    this.sky.scale.setScalar(900);
    this.sky.material.depthWrite = false;
    this.scene.add(this.sky);

    const u = this.sky.material.uniforms;
    u.turbidity.value = 2.4;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.0035;
    u.mieDirectionalG.value = 0.86;

    /* ---- fog + ambient ---- */
    this.scene.fog = new THREE.FogExp2(0xd9c9b0, 0.008);
    this.scene.background = null; // the Sky shader is the background now

    /* ---- post ---------------------------------------------------- */
    this.composer = null;
    this._buildComposer();

    /* ---- vehicle lighting ---- */
    this._buildVehicleLights();

    /* ---- campfires ---- */
    this.campfires = [];
    this._emberGeometry = new THREE.BufferGeometry();
    this._emberPool = null;

    /* ---- photo mode ---- */
    this.photo = {
      active: false,
      fov: 55,
      dof: 0.35,
      yaw: 0,
      pitch: 0,
      pos: new THREE.Vector3(),
      dragging: false,
    };
    this._photoKeys = new Set();
    this._buildPhotoUI();
    this._bindPhotoInput();

    // Legacy day-time beam ghosts belong to the new system now.
    this.vehicle.setHeadlights?.(false);
    this.setHeadlights(false);
    this.applyPhase(0, true);
  }

  /* ================================================================== *
   *  composer
   * ================================================================== */

  _buildComposer() {
    const size = this.renderer.getSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 0,
    });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      0.3, // strength
      // A tight radius keeps the glow on the lamp it belongs to. A wide one
      // bleeds across silhouettes and undoes the faceted read of the world.
      0.32, // radius
      0.95, // threshold
    );
    // Bloom is a chain of full-screen mip blurs, so its cost is pure fill. At
    // the strength the game actually runs it (0.12) the difference between a
    // full-resolution and a half-resolution bloom chain is invisible, and the
    // halved fill is the cheapest frame time in the whole pipeline.
    const bloomSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (width, height) => {
      bloomSetSize(Math.max(64, Math.round(width * 0.5)), Math.max(64, Math.round(height * 0.5)));
    };
    this.composer.addPass(this.bloom);

    // Film grade: lift saturation, add a gentle S-curve and split the shadows
    // cool and the highlights warm. This is what stops the toon shading from
    // reading as flat grey paste under the fog.
    this.grade = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        // Part of the grade's chroma now lives in the baked palette so the
        // no-post path keeps it. Measured back: palette ×1.15 plus 1.2 here
        // reproduces the old 1.3 on screen (chroma 94 → 95 on canyon sand).
        saturation: { value: 1.24 },
        // More punch, less lift: a 0.04 lift on every channel was washing the
        // shadows grey and flattening the facets the style depends on.
        contrast: { value: 1.12 },
        lift: { value: 0.02 },
        warm: { value: new THREE.Vector3(1.04, 1.0, 0.94) },
        cool: { value: new THREE.Vector3(0.93, 0.98, 1.09) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float saturation;
        uniform float contrast;
        uniform float lift;
        uniform vec3 warm;
        uniform vec3 cool;
        varying vec2 vUv;

        void main() {
          vec4 texel = texture2D( tDiffuse, vUv );
          vec3 c = texel.rgb;

          float luma = dot( c, vec3( 0.299, 0.587, 0.114 ) );
          c = mix( vec3( luma ), c, saturation );
          c = ( c - 0.5 ) * contrast + 0.5 + lift;

          float shadowWeight = 1.0 - smoothstep( 0.0, 0.55, luma );
          float highlightWeight = smoothstep( 0.45, 1.0, luma );
          c *= mix( vec3( 1.0 ), cool, shadowWeight * 0.55 );
          c *= mix( vec3( 1.0 ), warm, highlightWeight * 0.4 );

          gl_FragColor = vec4( clamp( c, 0.0, 1.0 ), texel.a );
        }`,
    });
    this.composer.addPass(this.grade);

    this.sharpen = new ShaderPass(SHARPEN_SHADER);
    this.composer.addPass(this.sharpen);

    this.composer.addPass(new OutputPass());

    this.composer.setSize(size.x, size.y);
    this._syncSharpenTexel();
    // The palette is authored in display space, so the composer must not
    // re-shape it: linear keeps the pastel rock pink instead of bleaching it.
    this.renderer.toneMapping = THREE.LinearToneMapping;
  }

  /** One sharpen texel, in drawing-buffer pixels, so the radius holds at any DPR. */
  _syncSharpenTexel() {
    if (!this.sharpen) return;
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.sharpen.uniforms.uTexel.value.set(1 / Math.max(1, buffer.x), 1 / Math.max(1, buffer.y));
  }

  /** Phase 8: post-processing can be toggled independently of the tier. */
  /** Live sun direction, for water and anything else that mirrors the sky. */
  get sunDirection() {
    return this._sunDir;
  }

  setPostProcessing(on) {
    this.composerEnabled = !!on;
    if (this.bloom) this.bloom.enabled = this.composerEnabled;
    if (this.grade) this.grade.enabled = this.composerEnabled;
    if (this.sharpen) this.sharpen.enabled = this.composerEnabled;
  }

  /** Phase 8: how far the world is drawn; fog is clamped to hide the cut. */
  setViewDistance(distance) {
    this.viewDistance = distance;
  }

  onResolutionChanged() {
    const size = this.renderer.getSize(new THREE.Vector2());
    if (this.composer) this.composer.setSize(size.x, size.y);
    if (this.bloom) this.bloom.resolution.set(size.x, size.y);
    this._syncSharpenTexel();
  }

  /** Phase 8: the player can pin the clock from Settings. */
  setDynamicCycle(on) {
    this.running = !!on;
    if (this.running) {
      this.weatherMode = 'clear';
      // Letting the clock run has to win over a latched look, or the world
      // sits in one preset while the sun marches across the sky behind it.
      this.clearStyleOverride();
    }
  }

  setTimePreset(id) {
    const map = { dawn: 0.02, golden: 0.29, overcast: 0.52, snow: 0.40, night: 0.78 };
    if (!(id in map)) return;
    this.running = false;
    this.weatherMode = id === 'snow' ? 'snow' : 'clear';
    // Picking a time of day is an explicit request for that phase's look.
    this.clearStyleOverride();
    this.skipTo(map[id]);
  }

  setQuality(settings) {
    const tier = this.quality.tier;
    this.composerEnabled = tier !== 'LOW';
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer.setSize(size.x, size.y);
    if (this.bloom) this.bloom.enabled = this.composerEnabled;
    if (this.sharpen) this.sharpen.enabled = this.composerEnabled;
    if (this._spotLights) {
      for (const s of this._spotLights) s.castShadow = tier === 'HIGH';
    }
  }

  resize(width, height) {
    if (!this.composer) return;
    this.composer.setSize(width, height);
    if (this.bloom) this.bloom.resolution.set(width, height);
    this._syncSharpenTexel();
  }

  /* ================================================================== *
   *  day / night
   * ================================================================== */

  setTime(t) {
    this.time = ((t % 1) + 1) % 1;
    this.applyPhase(0);
  }

  /** Advance the clock (host authoritative; joiners follow sync packets). */
  advance(dt) {
    if (!this.running) return;
    this.time = (this.time + dt / this.daySeconds) % 1;
  }

  skipTo(nextTime) {
    this.time = ((nextTime % 1) + 1) % 1;
    this.applyPhase(0, true);
    this._envDirty = true;
  }

  _phaseFor(t) {
    // Find the phase segment containing t and blend into the next one.
    let a = PHASES[PHASES.length - 1];
    let b = PHASES[0];
    for (let i = 0; i < PHASES.length; i += 1) {
      const cur = PHASES[i];
      const next = PHASES[(i + 1) % PHASES.length];
      const start = cur.t0;
      const end = next.t0 > cur.t0 ? next.t0 : next.t0 + 1;
      const local = t >= start ? (t - start) / (end - start) : (t + 1 - start) / (end - start);
      if (t >= start && t < end) {
        a = cur;
        b = next;
        return { a, b, k: Math.min(1, Math.max(0, local)) };
      }
    }
    return { a, b, k: 0 };
  }

  /**
   * Lock (or release, with null) a fixed lighting look on top of the phase
   * cycle. Applied inside applyPhase so there is still only one writer per
   * frame.
   */
  setStyleOverride(override) {
    this.styleOverride = override || null;
    this.applyPhase(0, true);
  }

  /**
   * Hand the lights back to the clock. A latched preset used to survive every
   * time-of-day change, so "night" still rendered as golden hour with a low
   * sun and the phase system looked broken.
   */
  clearStyleOverride() {
    if (!this.styleOverride) return;
    this.styleOverride = null;
    this.applyPhase(0, true);
  }

  /**
   * Blend the two neighbouring phases into the live lights/sky/fog.
   * `force` regenerates the environment map immediately.
   */
  applyPhase(_dt = 0, force = false) {
    const { a, b, k } = this._phaseFor(this.time);
    const smooth = k * k * (3 - 2 * k);

    const elevation = lerp(a.elevation, b.elevation, smooth);
    const azimuth = lerp(a.azimuth, b.azimuth, smooth);

    // Sun / moon direction from spherical angles.
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this._sunDir.setFromSphericalCoords(1, phi, theta);

    // Sky shader uses the sun direction uniform.
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this._sunDir);
    // Scattering belongs to the phase as much as the lights do. High turbidity
    // with almost no Rayleigh is what turns the shader's clear blue into an
    // overcast lid; a thin, dark atmosphere is what lets night read as night
    // rather than a dim blue noon.
    u.turbidity.value = lerp(a.turbidity ?? 2.4, b.turbidity ?? 2.4, smooth);
    u.rayleigh.value = lerp(a.rayleigh ?? 1.6, b.rayleigh ?? 1.6, smooth);
    u.mieCoefficient.value = lerp(a.mieCoefficient ?? 0.0035, b.mieCoefficient ?? 0.0035, smooth);
    u.mieDirectionalG.value = lerp(a.mieDirectionalG ?? 0.86, b.mieDirectionalG ?? 0.86, smooth);

    // The scene's directional light follows it, riding along with the truck.
    const bodyPos = this.vehicle.body.position;
    this.sun.position.set(
      bodyPos.x + this._sunDir.x * 120,
      bodyPos.y + Math.max(18, this._sunDir.y * 120),
      bodyPos.z + this._sunDir.z * 120,
    );
    this.sun.target.position.set(bodyPos.x, bodyPos.y, bodyPos.z);
    this.sun.intensity = lerp(a.sunIntensity, b.sunIntensity, smooth);
    this.sun.color.copy(lerpColor(this._tmpColor, a.sunColor, b.sunColor, smooth));

    this.hemisphere.color.copy(lerpColor(new THREE.Color(), a.ambient, b.ambient, smooth));
    this.hemisphere.intensity = lerp(a.ambientIntensity, b.ambientIntensity, smooth);

    // Fog: density grows with the phase, plus the height factor below.
    const fogColor = lerpColor(new THREE.Color(), a.fogColor, b.fogColor, smooth);
    this.scene.fog.color.copy(fogColor);
    this.baseFogDensity = lerp(a.fogDensity, b.fogDensity, smooth);

    this.renderer.toneMappingExposure = lerp(a.exposure, b.exposure, smooth);

    const style = this.styleOverride;
    if (style) {
      if (style.sunColor) this.sun.color.copy(style.sunColor);
      if (style.sunIntensity != null) this.sun.intensity = style.sunIntensity;
      if (style.hemiColor) this.hemisphere.color.copy(style.hemiColor);
      if (style.hemiGround) this.hemisphere.groundColor.copy(style.hemiGround);
      if (style.hemiIntensity != null) this.hemisphere.intensity = style.hemiIntensity;
      if (style.fogColor) this.scene.fog.color.copy(style.fogColor);
      if (style.fogDensity != null) this.baseFogDensity = style.fogDensity;
      if (style.exposure != null) this.renderer.toneMappingExposure = style.exposure;
    }

    const bloomStrength = lerp(a.bloom, b.bloom, smooth);
    if (this.bloom) this.bloom.strength = bloomStrength;

    this.night = smooth > 0.5 ? b.night : a.night;
    this.phaseLabel = smooth > 0.5 ? b.label : a.label;
    this.phaseId = smooth > 0.5 ? b.id : a.id;

    if (this.night && !this._wasNight) this.setHeadlights(true);
    if (!this.night && this._wasNight) this.setHeadlights(false);
    this._wasNight = this.night;

    if (force || this._envDirty) {
      this._updateEnvironment();
      this._envDirty = false;
    }
  }

  _updateEnvironment() {
    // Render the live sky into a PMREM cubemap so metal and paint reflect it.
    // The capture scene/sky are built once and reused — rebuilding them every
    // few seconds would leak geometry into GPU memory.
    if (!this._envScene) {
      this._envScene = new THREE.Scene();
      this._envSky = new Sky();
      // PMREMGenerator's capture camera far plane is 1000 m.
      this._envSky.scale.setScalar(400);
      this._envScene.add(this._envSky);
    }
    const skyCopy = this._envSky;
    const src = this.sky.material.uniforms;
    skyCopy.material.uniforms.turbidity.value = src.turbidity.value;
    skyCopy.material.uniforms.rayleigh.value = src.rayleigh.value;
    skyCopy.material.uniforms.mieCoefficient.value = src.mieCoefficient.value;
    skyCopy.material.uniforms.mieDirectionalG.value = src.mieDirectionalG.value;
    skyCopy.material.uniforms.sunPosition.value.copy(this._sunDir);
    const skyScene = this._envScene;

    try {
      if (this._envRT) this._envRT.dispose();
      this._envRT = this._pmrem.fromScene(skyScene, 0.02);
      this.scene.environment = this._envRT.texture;
      this.scene.environmentIntensity = this.night ? 0.22 : 0.5;
      this._lastEnvDir.copy(this._sunDir);
    } catch {
      // PMREM can fail on very small GPUs; the scene just keeps its last env.
    }
  }

  /* ================================================================== *
   *  vehicle lights (headlights, brake, reverse)
   * ================================================================== */

  _buildVehicleLights() {
    const group = this.vehicle.group;
    this._spotLights = [];
    this._cones = [];
    this._lamps = {};

    // Beam volume: a cone whose alpha fades from the lamp to the tip so it
    // reads as light in the air rather than a solid translucent shape.
    const coneMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0xfff0c4) },
        uOpacity: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying float vAlong;
        void main() {
          // Apex (y = +5.5) sits at the lamp; base (y = -5.5) is the far tip.
          vAlong = clamp((5.5 - position.y) / 11.0, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlong;
        void main() {
          float alpha = uOpacity * pow(1.0 - vAlong, 1.6);
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
    });

    for (const side of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff3d0, 0, 62, Math.PI / 7.2, 0.42, 1.35);
      spot.position.set(side * 0.62, 0.55, 2.0);
      spot.target.position.set(side * 0.5, -0.4, 24);
      spot.castShadow = false; // shadows from two spots would double the shadow pass
      group.add(spot);
      group.add(spot.target);
      this._spotLights.push(spot);

      // Volumetric-ish cone: an additive truncated cone in front of the lamp.
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.5, 11, 16, 1, true), coneMaterial);
      cone.rotation.x = -Math.PI / 2; // apex at the lamp, opening toward +z
      cone.position.set(side * 0.62, 0.42, 2.0 + 5.5);
      cone.renderOrder = 3;
      cone.visible = false;
      group.add(cone);
      this._cones.push(cone);
    }

    // Glowing lamp faces: headlamps, tail/brake, reverse.
    const lamp = (color, position, size) => {
      const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], 0.06), mat);
      mesh.position.set(position[0], position[1], position[2]);
      group.add(mesh);
      return mat;
    };

    this._lamps.head = [
      lamp(0xfff6d8, [-0.62, 0.55, 2.36], [0.34, 0.16]),
      lamp(0xfff6d8, [0.62, 0.55, 2.36], [0.34, 0.16]),
    ];
    this._lamps.brake = [
      lamp(0x5a0c0c, [-0.72, 0.62, -2.32], [0.26, 0.14]),
      lamp(0x5a0c0c, [0.72, 0.62, -2.32], [0.26, 0.14]),
    ];
    this._lamps.reverse = [
      lamp(0x2a2a2a, [-0.42, 0.5, -2.34], [0.18, 0.1]),
      lamp(0x2a2a2a, [0.42, 0.5, -2.34], [0.18, 0.1]),
    ];

    // The trailer gets its own pair of tail/brake and reverse lamps.
    const trailerBody = this.trailer?.bodyGroup;
    if (trailerBody) {
      const trailerLamp = (color, x, y, z, w, h) => {
        const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), mat);
        mesh.position.set(x, y, z);
        trailerBody.add(mesh);
        return mat;
      };
      this._lamps.brake.push(
        trailerLamp(0x5a0c0c, -0.72, 0.86, -1.86, 0.28, 0.13),
        trailerLamp(0x5a0c0c, 0.72, 0.86, -1.86, 0.28, 0.13),
      );
      this._lamps.reverse.push(
        trailerLamp(0x2a2a2a, -0.38, 0.82, -1.86, 0.16, 0.1),
        trailerLamp(0x2a2a2a, 0.38, 0.82, -1.86, 0.16, 0.1),
      );
    }

    this.headlightsOn = false;
  }

  setHeadlights(on) {
    this.headlightsOn = !!on;
    for (const s of this._spotLights) s.intensity = on ? 220 : 0;
    for (const c of this._cones) {
      c.visible = on;
      c.material.uniforms.uOpacity.value = on ? 0.34 : 0;
    }
    for (const m of this._lamps.head) m.color.setHex(on ? 0xfff6d8 : 0x2a2a26);
    this.vehicle.setHeadlights?.(on);
  }

  toggleHeadlights() {
    this.setHeadlights(!this.headlightsOn);
    return this.headlightsOn;
  }

  /** Brake / reverse lamps follow the pedals and gear. */
  _updateLamps(telemetry) {
    const braking = telemetry.brake > 0.05 || telemetry.handbrake;
    const reversing = telemetry.gearId === 'R' || telemetry.speedKmh < -0.5;
    for (const m of this._lamps.brake) {
      m.color.setHex(braking ? 0xff3b25 : this.headlightsOn ? 0x8c1a12 : 0x5a0c0c);
    }
    for (const m of this._lamps.reverse) m.color.setHex(reversing ? 0xe8f3ff : 0x2a2a2a);
  }

  /* ================================================================== *
   *  campfires
   * ================================================================== */

  addCampfire(position, name = 'CAMP') {
    const group = new THREE.Group();
    group.position.copy(position);

    const stone = new THREE.MeshStandardMaterial({ color: 0x6b625a, roughness: 0.95 });
    for (let i = 0; i < 9; i += 1) {
      const a = (i / 9) * Math.PI * 2;
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), stone);
      s.position.set(Math.cos(a) * 0.85, 0.08, Math.sin(a) * 0.85);
      s.castShadow = true;
      group.add(s);
    }

    // Logs.
    const logMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.95 });
    for (let i = 0; i < 4; i += 1) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.3, 6), logMat);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = (i / 4) * Math.PI;
      log.position.y = 0.16;
      group.add(log);
    }

    // Flame: two crossed additive quads that flicker.
    const flameMat = new THREE.MeshBasicMaterial({
      color: 0xff8a2b,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.15, 10, 1, true), flameMat);
    flame.position.y = 0.72;
    group.add(flame);

    const light = new THREE.PointLight(0xff9a45, 14, 22, 2);
    light.position.y = 1.0;
    group.add(light);

    this.scene.add(group);

    const fire = {
      name,
      position: position.clone(),
      group,
      flame,
      light,
      phase: Math.random() * Math.PI * 2,
      radius: 9,
    };
    this.campfires.push(fire);
    return fire;
  }

  /** Camp rest: repair, refuel, jump the clock forward. Call once per press. */
  restAtNearestCampfire(vehicle, maxDistance = 12) {
    const v = vehicle.body.position;
    let near = null;
    let best = Infinity;
    for (const f of this.campfires) {
      const d = Math.hypot(f.position.x - v.x, f.position.z - v.z);
      if (d < best) {
        best = d;
        near = f;
      }
    }
    if (!near || best > maxDistance) return { ok: false, reason: 'NO CAMP NEARBY' };

    vehicle.fuel = vehicle.fuelCapacity;
    if (typeof vehicle.repair === 'function') vehicle.repair();
    vehicle.chassisDamage = 0;

    // Fast-forward to the next phase, keeping the squad in sync.
    const next = (Math.floor(this.time * 4) + 1) / 4;
    this.skipTo(next);
    this.networkManager?.sendTimeSync?.(this.getState());

    return { ok: true, camp: near.name, time: this.time, phase: this.phaseLabel };
  }

  /* ================================================================== *
   *  per-frame
   * ================================================================== */

  update(dt, now, telemetry) {
    this.advance(dt);

    // Blending every frame is cheap; the PMREM rebuild is throttled hard.
    this.applyPhase(dt);

    // Rebuilding the PMREM cubemap is a multi-millisecond GPU job, and in eight
    // seconds the sun moves a few degrees. Rebuilding it every 2.5 s spent a
    // dropped frame on a reflection almost nobody can see; now it only happens
    // when the sky has actually changed enough to be worth the hitch.
    this._envTimer += dt;
    if (this._envTimer > 8) {
      this._envTimer = 0;
      if (this._lastEnvDir.angleTo(this._sunDir) > 0.005) {
        this._envDirty = true;
        this.applyPhase(dt, true);
      }
    }

    // Height-based exponential fog: thin air up high, soup in the valley.
    const camY = this.camera.position.y;
    const heightFactor = THREE.MathUtils.clamp(1 - (camY - 4) / 90, 0.35, 1.4);
    const reveal = this.missionManager ? this.missionManager.discovered.size : 0;
    // 0.8 on the authored haze: at full strength a 300 m butte was a pale ghost
    // and the valley read as milk. The floor below still hides the draw cut.
    let density = this.baseFogDensity * (this.fogScale ?? 1) * heightFactor * (1 - reveal * 0.1) * 0.8;
    // Keep the draw-distance cut in the murk instead of a visible wall. The
    // floor has to stay below the authored haze or it becomes the whole look:
    // at 1.45 / 350 m the valley disappeared into a white sheet at 200 m, with
    // haze thick enough to erase every ridge and every mesa behind them.
    // The floor hides the prop/draw cut, but it must not swallow the country.
    // At 350 m the cut is far enough that 0.6 / viewDistance is a whisper; at
    // the low preset's 130 m the same formula is 0.0046 and the canyon's mesas
    // became pale ghosts by 200 m. Cap the divisor so short draw distances keep
    // the haze they need and no more.
    if (this.viewDistance) density = Math.max(density, 0.6 / Math.max(this.viewDistance, 240));
    if (this.weatherMode === 'snow') density *= 1.3;
    this.scene.fog.density = density;
    if (this.weatherMode === 'snow') {
      this.scene.fog.color.lerp(this._snowFog, 0.45);
    }

    // Campfire flicker + embers.
    for (const f of this.campfires) {
      const flicker = 0.78 + 0.22 * Math.sin(now * 0.011 + f.phase) + 0.08 * Math.sin(now * 0.037);
      f.light.intensity = 9 + flicker * 9;
      f.flame.scale.set(1 + 0.08 * Math.sin(now * 0.02 + f.phase), 0.85 + flicker * 0.35, 1);
      f.flame.material.opacity = 0.6 + flicker * 0.3;
    }

    if (telemetry) this._updateLamps(telemetry);

    // Keep the dome centred on the camera and inside the far plane, which the
    // performance governor changes with the draw distance.
    this.sky.position.copy(this.camera.position);
    const domeScale = Math.min(880, Math.max(260, this.camera.far * 0.86));
    if (Math.abs(this.sky.scale.x - domeScale) > 1) this.sky.scale.setScalar(domeScale);

    if (this.photo.active) this._updatePhoto(dt);
  }

  /** Draw the scene through the composer when the tier allows it. */
  render() {
    if (this.composerEnabled && !this.photo.raw) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /* ================================================================== *
   *  co-op clock sync
   * ================================================================== */

  getState() {
    return { time: this.time, running: this.running };
  }

  applyTimeSync(payload) {
    if (!payload || typeof payload.time !== 'number') return;
    // Joiners follow the host's clock.
    this.time = payload.time;
    if (typeof payload.running === 'boolean') this.running = payload.running;
    this._envDirty = true;
  }

  /* ================================================================== *
   *  photo mode
   * ================================================================== */

  _buildPhotoUI() {
    const wrap = document.createElement('div');
    wrap.id = 'photo-mode';
    wrap.className = 'photo-mode';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="photo-bars" aria-hidden="true"></div>
      <div class="photo-mark">INORLD</div>
      <div class="photo-panel">
        <div class="photo-title">PHOTO MODE</div>
        <label>FOV <input id="photo-fov" type="range" min="24" max="95" value="55" /></label>
        <label>DOF <input id="photo-dof" type="range" min="0" max="100" value="35" /></label>
        <label>TIME <input id="photo-time" type="range" min="0" max="100" value="28" /></label>
        <div class="photo-hint">DRAG TO LOOK &middot; WASD MOVE &middot; Q/E UP/DOWN &middot; P EXIT</div>
      </div>
    `;
    document.body.appendChild(wrap);
    this.photoEl = wrap;

    const fov = wrap.querySelector('#photo-fov');
    const dof = wrap.querySelector('#photo-dof');
    const time = wrap.querySelector('#photo-time');
    fov?.addEventListener('input', () => {
      this.photo.fov = parseFloat(fov.value);
      this.camera.fov = this.photo.fov;
      this.camera.updateProjectionMatrix();
    });
    dof?.addEventListener('input', () => {
      this.photo.dof = parseFloat(dof.value) / 100;
    });
    time?.addEventListener('input', () => {
      this.setTime(parseFloat(time.value) / 100);
    });
  }

  _bindPhotoInput() {
    const dom = this.renderer.domElement;
    const onDown = (e) => {
      if (!this.photo.active) return;
      this.photo.dragging = true;
      this.photo.lastX = e.clientX;
      this.photo.lastY = e.clientY;
    };
    const onUp = () => { this.photo.dragging = false; };
    const onMove = (e) => {
      if (!this.photo.active || !this.photo.dragging) return;
      const dx = e.clientX - this.photo.lastX;
      const dy = e.clientY - this.photo.lastY;
      this.photo.lastX = e.clientX;
      this.photo.lastY = e.clientY;
      this.photo.yaw -= dx * 0.0035;
      this.photo.pitch = THREE.MathUtils.clamp(this.photo.pitch - dy * 0.0035, -1.2, 1.2);
    };
    dom.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointermove', onMove);

    window.addEventListener('keydown', (e) => {
      if (!this.photo.active) return;
      this._photoKeys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this._photoKeys.delete(e.code));
  }

  enterPhotoMode() {
    if (this.photo.active) return;
    this.photo.active = true;
    this.photo.pos.copy(this.camera.position);
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.photo.yaw = euler.y;
    this.photo.pitch = euler.x;
    this.photo.fov = this.camera.fov;
    document.body.classList.add('photo-active');
    if (this.photoEl) this.photoEl.hidden = false;
    this.photo.raw = false;
    const t = this.photoEl?.querySelector('#photo-time');
    if (t) t.value = String(Math.round(this.time * 100));
  }

  exitPhotoMode() {
    if (!this.photo.active) return;
    this.photo.active = false;
    document.body.classList.remove('photo-active');
    if (this.photoEl) this.photoEl.hidden = true;
    this.camera.fov = 58;
    this.camera.updateProjectionMatrix();
    this._photoKeys.clear();
  }

  togglePhotoMode() {
    if (this.photo.active) this.exitPhotoMode();
    else this.enterPhotoMode();
    return this.photo.active;
  }

  _updatePhoto(dt) {
    const speed = this._photoKeys.has('ShiftLeft') ? 42 : 14;
    const forward = new THREE.Vector3(0, 0, -1).applyEuler(
      new THREE.Euler(this.photo.pitch, this.photo.yaw, 0, 'YXZ'),
    );
    const right = new THREE.Vector3(1, 0, 0).applyEuler(new THREE.Euler(0, this.photo.yaw, 0, 'YXZ'));

    if (this._photoKeys.has('KeyW')) this.photo.pos.addScaledVector(forward, speed * dt);
    if (this._photoKeys.has('KeyS')) this.photo.pos.addScaledVector(forward, -speed * dt);
    if (this._photoKeys.has('KeyA')) this.photo.pos.addScaledVector(right, -speed * dt);
    if (this._photoKeys.has('KeyD')) this.photo.pos.addScaledVector(right, speed * dt);
    if (this._photoKeys.has('KeyQ')) this.photo.pos.y -= speed * dt;
    if (this._photoKeys.has('KeyE')) this.photo.pos.y += speed * dt;

    this.camera.position.copy(this.photo.pos);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.photo.pitch, this.photo.yaw, 0, 'YXZ'));

    // Cheap depth-of-field stand-in: narrow the aperture by lowering FOV and
    // letting bloom bleed the highlights (real BokehPass is too hot for LOW).
    if (this.bloom) {
      this.bloom.strength = 0.25 + this.photo.dof * 1.15;
      this.bloom.radius = 0.4 + this.photo.dof * 0.9;
    }
  }

  dispose() {
    if (this._envRT) this._envRT.dispose();
    this._pmrem.dispose();
    this.scene.remove(this.sky);
  }
}

export { PHASES, DAY_SECONDS };
