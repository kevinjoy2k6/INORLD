/* ============================================================================
 * WaterSystem — mirror water, harbour depth and shoreline foam
 *
 *  Modelled on the water in Tidelight Harbor:
 *
 *   - The normal map is generated in code, four crossing waves summed into a
 *     normal-mapped texture, so there are no image assets to load.
 *   - three/examples/jsm/objects/Water.js supplies the mirror reflection: it
 *     renders the scene from the mirrored camera every frame and distorts that
 *     reflection with the wave normals (distortionScale 0.55, wave size 1.5).
 *   - A per-vertex "depth under the surface" attribute is baked from the
 *     terrain heightfield. The fragment shader uses it for three things the
 *     reference does with an underwater render pass: a shallow tint that
 *     reveals the bed at the margins, a soft alpha ramp so the water thins at
 *     the bank, and a moving foam band where it meets the shore.
 *
 *  The result is the same read: dark deep water with a mirrored sky, a bright
 *  turquoise rim around every bank, and foam lines that crawl along the edge.
 * ========================================================================== */

import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';

/* ------------------------------------------------------------------ *
 *  procedural normal map (identical wave recipe to the reference)
 * ------------------------------------------------------------------ */

function makeWaterNormals(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const TAU = Math.PI * 2;
  const vector = new THREE.Vector3();

  for (let n = 0; n < size; n += 1) {
    for (let r = 0; r < size; r += 1) {
      const i = (r / size) * TAU;
      const a = (n / size) * TAU;

      const dx = Math.cos(i * 11 + a * 7) * 0.055 + Math.cos(i * 19 - a * 13) * 0.022;
      const dy = Math.sin(a * 9 + i * 5) * 0.055 + Math.sin(a * 23 - i * 17) * 0.018;

      vector.set(-dx, -dy, 1).normalize();
      const offset = (n * size + r) * 4;
      data[offset] = (vector.x * 0.5 + 0.5) * 255;
      data[offset + 1] = (vector.y * 0.5 + 0.5) * 255;
      data[offset + 2] = (vector.z * 0.5 + 0.5) * 255;
      data[offset + 3] = 255;
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

/* ------------------------------------------------------------------ *
 *  WaterSystem
 * ------------------------------------------------------------------ */

export class WaterSystem {
  constructor({ scene, terrain, atmosphere, quality, resolution = 200 }) {
    this.scene = scene;
    this.terrain = terrain;
    this.atmosphere = atmosphere;
    this.quality = quality;

    const size = terrain.size;
    this.level = terrain.waterLevel;

    // Subdivided so the depth attribute can carry the bank profile.
    const geometry = new THREE.PlaneGeometry(size, size, resolution, resolution);
    const depths = new Float32Array(geometry.attributes.position.count);

    // PlaneGeometry lies in XY before rotation: x → world x, y → world -z.
    const position = geometry.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const z = -position.getY(i);
      const ground = terrain.getHeightAt(x, z);
      depths[i] = Math.max(0, this.level - ground);
    }
    geometry.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
    // No geometry rotation: Water's mirror maths works off modelMatrix, and the
    // mesh itself is laid flat below.

    const sunDirection = new THREE.Vector3(0.55, 0.55, 0.4).normalize();

    // The mirror is a whole second render of the scene: size it to the tier and
    // refresh it less often on weaker hardware. A slightly stale reflection is
    // invisible at driving speed; the halved fill cost is not.
    const tier = (quality && quality.tier) || 'HIGH';
    const mirror = tier === 'ULTRA' ? 384 : tier === 'ULTRA_LOW' || tier === 'LOW' ? 128 : 192;
    this.mirrorSkip = mirror >= 384 ? 1 : mirror >= 192 ? 2 : 3;
    // Cadence in milliseconds, not frames. A frame-count throttle turns a
    // steady 60 FPS into alternating heavy and light frames, which reads as
    // stutter even though the average is fine; a lake reflection does not
    // change in 45 ms.
    this.mirrorInterval = tier === 'ULTRA' ? 0 : tier === 'LOW' || tier === 'COZY' || tier === 'ULTRA_LOW' ? 90 : 45;
    this._lastMirror = 0;
    this._frame = 0;

    this.water = new Water(geometry, {
      textureWidth: mirror,
      textureHeight: mirror,
      waterNormals: makeWaterNormals(256),
      sunDirection,
      sunColor: 0xffe6b2,
      waterColor: 0x123c46,
      distortionScale: 0.55,
      fog: true,
      alpha: 0.92,
    });

    // Ground cover is thousands of tiny instances that a 192 px reflection
    // cannot resolve anyway, but it is the most numerous thing the mirrored
    // camera would be asked to draw. Hide it for the mirror pass only.
    this.reflectionHidden = Array.isArray(terrain?._lodGroups)
      ? terrain._lodGroups.filter((group) => /grass|fern|reed|bush/i.test(group.name || ''))
      : [];

    // Throttle the reflection pass without touching Water's internals.
    const mirrorPass = this.water.onBeforeRender;
    this.water.onBeforeRender = (renderer, scene, camera, geo, mat, group) => {
      this._frame += 1;
      if (this.mirrorInterval > 0) {
        const now = performance.now();
        if (now - this._lastMirror < this.mirrorInterval) return;
        this._lastMirror = now;
      }
      const muted = [];
      for (const cover of this.reflectionHidden) {
        if (cover.visible) {
          cover.visible = false;
          muted.push(cover);
        }
      }
      mirrorPass.call(this.water, renderer, scene, camera, geo, mat, group);
      for (const cover of muted) cover.visible = true;
    };

    this.water.name = 'MirrorWater';
    this.water.position.y = this.level;
    this.water.rotation.x = -Math.PI / 2;
    this.water.renderOrder = 2;
    this.water.receiveShadow = false;
    this.water.material.uniforms.size.value = 1.5;

    this._patchShore();
    this.scene.add(this.water);

    // The simple blue plane from the terrain system steps aside.
    if (terrain.water) terrain.water.visible = false;

    this.enabled = true;
    this.time = 0;
  }

  /**
   * Depth-driven shallow tint, alpha ramp and foam. Written as string patches
   * against the reference shader so the mirror pass keeps working untouched.
   */
  _patchShore() {
    const material = this.water.material;

    material.vertexShader = material.vertexShader
      .replace(
        'uniform float time;',
        'uniform float time;\n\t\t\t\tattribute float aDepth;\n\t\t\t\tvarying float vDepth;',
      )
      .replace(
        'void main() {',
        'void main() {\n\t\t\t\t\tvDepth = aDepth;',
      );

    material.fragmentShader = material.fragmentShader
      .replace(
        'uniform vec3 waterColor;',
        'uniform vec3 waterColor;\n\t\t\t\tvarying float vDepth;\n\t\t\t\tuniform float shoreTint;\n\t\t\t\tuniform vec3 shallowTint;\n\t\t\t\tuniform vec3 foamColour;',
      )
      .replace(
        'gl_FragColor = vec4( outgoingLight, alpha );',
        `
        // ---- stylised depth ramp + binary shoreline foam ----
        // Shallow water is translucent grey-tan, deep water saturated turquoise,
        // with a hard step of white foam exactly at the waterline. No gradient
        // smoke: the style wants crisp cut-outs.
        float depth = max( vDepth, 0.0 );
        float shallow = 1.0 - smoothstep( 0.1, 1.4, depth );

        outgoingLight = mix( outgoingLight, shallowTint, shallow * 0.42 * shoreTint );

        float ripple = 0.5 + 0.5 * sin( depth * 18.0 - time * 1.6 + surfaceNormal.x * 4.0 );
        float foam = ( 1.0 - smoothstep( 0.0, 0.32, depth ) ) * step( 0.72, ripple ) * shoreTint;
        outgoingLight = mix( outgoingLight, foamColour, foam );

        float alphaOut = mix( 0.58, alpha, smoothstep( 0.0, 1.2, depth ) );
        alphaOut = max( alphaOut, foam );
        gl_FragColor = vec4( outgoingLight, alphaOut );`,
      );

    material.uniforms.shoreTint = { value: 1 };
    material.uniforms.shallowTint = { value: new THREE.Color(0x9ba8a4) };
    material.uniforms.foamColour = { value: new THREE.Color(0xffffff) };
  }

  /** Called every frame: feed the clock, the sun and the camera position. */
  update(dt, camera, sunDirection) {
    if (!this.enabled) return;
    this.time += dt;

    const uniforms = this.water.material.uniforms;
    uniforms.time.value = this.time;
    uniforms.eye.value.copy(camera.position);
    if (sunDirection) uniforms.sunDirection.value.copy(sunDirection);

    // The authored turquoise is added on top of the mirror, so it stays noon
    // bright at midnight while the reflected sky goes black. Scale the lit
    // colour ramp with the phase; the mirror itself already follows the sky.
    if (!this._baseWater) {
      this._baseWater = uniforms.waterColor.value.clone();
      this._baseShallow = uniforms.shallowTint ? uniforms.shallowTint.value.clone() : null;
      this._baseFoam = uniforms.foamColour ? uniforms.foamColour.value.clone() : null;
      this._baseSun = uniforms.sunColor ? uniforms.sunColor.value.clone() : null;
      this._light = 1;
    }
    const phase = this.atmosphere?.phaseId;
    const wanted = this.atmosphere?.night ? 0 : phase === 'overcast' ? 0.7 : phase === 'dawn' ? 0.6 : 1;
    this._light += (wanted - this._light) * Math.min(1, dt * 2);
    // These are linear-light multipliers, and the output is sRGB: 0.2 of the
    // turquoise still lands around #3d8bab on screen, which is why a night lake
    // stayed cyan at a quarter brightness. Night has to go to a few percent.
    const gain = 0.03 + 0.97 * this._light;
    uniforms.waterColor.value.copy(this._baseWater).multiplyScalar(gain);
    if (this._baseShallow) uniforms.shallowTint.value.copy(this._baseShallow).multiplyScalar(gain);
    if (this._baseFoam) uniforms.foamColour.value.copy(this._baseFoam).multiplyScalar(0.12 + 0.88 * this._light);
    // The warm glint is keyed to a daytime sun; left alone it is the brightest
    // thing in a night frame, a white smear across a black lagoon.
    if (this._baseSun) uniforms.sunColor.value.copy(this._baseSun).multiplyScalar(0.05 + 0.95 * this._light);
  }

  setQuality(tier) {
    const low = tier === 'LOW' || tier === 'COZY' || tier === 'ULTRA_LOW';
    this.water.material.uniforms.distortionScale.value = low ? 0.4 : 0.55;
    this.mirrorSkip = low ? 3 : 2;
    this.mirrorInterval = low ? 90 : tier === 'ULTRA' ? 0 : 45;
    this.enabled = true;
  }

  get stats() {
    const u = this.water.material.uniforms;
    return {
      level: +this.level.toFixed(2),
      distortion: +u.distortionScale.value.toFixed(2),
      size: +u.size.value.toFixed(2),
      time: +this.time.toFixed(1),
    };
  }
}
