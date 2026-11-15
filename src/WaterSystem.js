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
    const mirror = tier === 'ULTRA' ? 512 : tier === 'ULTRA_LOW' || tier === 'LOW' ? 128 : 256;
    this.mirrorSkip = mirror >= 512 ? 1 : mirror >= 256 ? 2 : 3;
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

    // Throttle the reflection pass without touching Water's internals.
    const mirrorPass = this.water.onBeforeRender;
    this.water.onBeforeRender = (renderer, scene, camera, geo, mat, group) => {
      this._frame += 1;
      if (this.mirrorSkip > 1 && this._frame % this.mirrorSkip !== 0) return;
      mirrorPass.call(this.water, renderer, scene, camera, geo, mat, group);
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
        'uniform vec3 waterColor;\n\t\t\t\tvarying float vDepth;\n\t\t\t\tuniform float shoreTint;',
      )
      .replace(
        'gl_FragColor = vec4( outgoingLight, alpha );',
        `
        // ---- shoreline: shallow tint, thinning alpha, crawling foam ----
        float depth = max( vDepth, 0.0 );
        float shallow = 1.0 - smoothstep( 0.25, 2.6, depth );
        float foamBand = 1.0 - smoothstep( 0.0, 0.55, depth );

        vec3 bedTint = vec3( 0.42, 0.72, 0.68 );
        outgoingLight = mix( outgoingLight, bedTint, shallow * 0.32 * shoreTint );

        float ripple = 0.5 + 0.5 * sin( depth * 26.0 - time * 2.2 + surfaceNormal.x * 6.0 );
        float foam = foamBand * smoothstep( 0.35, 1.0, ripple ) * shoreTint;
        outgoingLight += vec3( 0.85, 0.93, 0.92 ) * foam * 0.22;

        float alphaOut = mix( 0.62, alpha, smoothstep( 0.0, 1.6, depth ) );
        alphaOut = min( 1.0, alphaOut + foam * 0.35 );
        gl_FragColor = vec4( outgoingLight, alphaOut );`,
      );

    material.uniforms.shoreTint = { value: 1 };
  }

  /** Called every frame: feed the clock, the sun and the camera position. */
  update(dt, camera, sunDirection) {
    if (!this.enabled) return;
    this.time += dt;

    const uniforms = this.water.material.uniforms;
    uniforms.time.value = this.time;
    uniforms.eye.value.copy(camera.position);
    if (sunDirection) uniforms.sunDirection.value.copy(sunDirection);

  }

  setQuality(tier) {
    const low = tier === 'LOW' || tier === 'COZY' || tier === 'ULTRA_LOW';
    this.water.material.uniforms.distortionScale.value = low ? 0.4 : 0.55;
    this.mirrorSkip = low ? 3 : 2;
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
