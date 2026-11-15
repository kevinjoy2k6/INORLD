import * as THREE from 'three';

/**
 * Tyre deformation visuals.
 *
 * HIGH / MEDIUM
 *   A single top-down render target covers the whole map. Every frame each
 *   grounded tyre stamps a soft blob whose intensity is proportional to that
 *   wheel's current sinkage, using max-blending so ruts accumulate but never
 *   saturate. The terrain material samples that map in the vertex shader to
 *   displace geometry downward, and in the fragment shader to darken wet mud
 *   and compress snow.
 *
 * LOW
 *   No render target and no shader work: quads are laid along each tyre's path
 *   as the vehicle drives. The physical sinkage and drag maths in
 *   OffroadVehicle is completely untouched by the tier.
 */

const MAX_STAMP_DEPTH = 0.34;

const STAMP_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    vUv = uv;
    vDepth = clamp(sink / maxDepth, 0.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STAMP_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  varying float vDepth;
  uniform vec3 uChannel;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float falloff = smoothstep(1.0, 0.18, r);
    if (falloff <= 0.001) discard;
    // uChannel already carries the depth; multiplying by vDepth again would
    // square it into invisibility.
    gl_FragColor = vec4(uChannel * falloff, falloff);
  }
`;

class RibbonTrail {
  constructor(scene, { maxSegments = 220, color = 0x3b2a1c, width = 0.34, y = 0.045 }) {
    this.maxSegments = maxSegments;
    this.width = width;
    this.lift = y;
    this.count = 0;
    this.cursor = 0;

    const positions = new Float32Array(maxSegments * 6 * 3);
    const colors = new Float32Array(maxSegments * 6 * 3);
    const indices = new Uint32Array(maxSegments * 6);
    for (let i = 0; i < maxSegments * 6; i += 1) indices[i] = i;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      side: THREE.DoubleSide,
    });
    this.material.color.setHex(color);

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);

    this.geometry = geometry;
    this.last = new THREE.Vector3();
    this.hasLast = false;
  }

  push(x, y, z, dirX, dirZ, tint) {
    if (!this.hasLast) {
      this.last.set(x, y, z);
      this.hasLast = true;
      return;
    }

    const dx = x - this.last.x;
    const dz = z - this.last.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.16) return;
    if (length > 3) {
      // Teleport / respawn: start a fresh trail rather than smearing a ribbon.
      this.last.set(x, y, z);
      return;
    }

    const nx = dirZ;
    const nz = -dirX;
    const half = this.width * 0.5;

    const ax = this.last.x + nx * half;
    const az = this.last.z + nz * half;
    const bx = this.last.x - nx * half;
    const bz = this.last.z - nz * half;
    const cx = x + nx * half;
    const cz = z + nz * half;
    const dxp = x - nx * half;
    const dzp = z - nz * half;

    const base = this.cursor * 6;
    const pos = this.geometry.attributes.position.array;
    const col = this.geometry.attributes.color.array;
    const y0 = this.last.y + this.lift;
    const y1 = y + this.lift;

    const quad = [
      [ax, y0, az], [bx, y0, bz], [cx, y1, cz],
      [bx, y0, bz], [dxp, y1, dzp], [cx, y1, cz],
    ];

    for (let i = 0; i < 6; i += 1) {
      const o = (base + i) * 3;
      pos[o] = quad[i][0];
      pos[o + 1] = quad[i][1];
      pos[o + 2] = quad[i][2];
      col[o] = tint.r;
      col[o + 1] = tint.g;
      col[o + 2] = tint.b;
    }

    this.cursor = (this.cursor + 1) % this.maxSegments;
    this.count = Math.min(this.count + 1, this.maxSegments);
    this.geometry.setDrawRange(0, this.count * 6);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;

    this.last.set(x, y, z);
  }

  clear() {
    this.count = 0;
    this.cursor = 0;
    this.hasLast = false;
    this.geometry.setDrawRange(0, 0);
  }
}

export class RutSystem {
  constructor({ renderer, scene, terrain, quality, groundMask = 1 }) {
    this.renderer = renderer;
    this.scene = scene;
    this.terrain = terrain;
    this.quality = quality;
    this.groundMask = groundMask;
    this.vehicle = null;

    this.mode = 'off';
    this.rtSize = 0;
    this.accumulator = 0;
    this.stampInterval = 0.055;

    this.halfSize = terrain ? terrain.halfSize : 200;
    this.mapSize = terrain ? terrain.size : 400;

    this._tmpVec = new THREE.Vector3();
    this._tmpColor = new THREE.Color();
    this._stampBounds = new THREE.Box3();

    this.ribbons = null;
    this.stamps = null;
    this.rt = null;

    /* Co-op rut sharing: local stamps queue up here until NetworkManager
     * drains them, and teammates' stamps are re-stamped into our map. */
    this._outbox = [];
    this.remoteTrail = null;

    this.uniforms = {
      uRutMap: { value: null },
      uRutOrigin: { value: new THREE.Vector2(-this.halfSize, -this.halfSize) },
      uRutSize: { value: this.mapSize },
      uRutDepth: { value: MAX_STAMP_DEPTH },
      uRutEnabled: { value: 0 },
    };

    this._patchTerrainMaterial();
    this.setQuality(quality.settings);
  }

  /* ---------------- material ---------------- */

  _patchTerrainMaterial() {
    const material = this.terrain && this.terrain.material;
    if (!material) return;

    // Keep whatever was there so a future material pass is not silently lost.
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (previous) previous(shader, renderer);

      shader.uniforms.uRutMap = this.uniforms.uRutMap;
      shader.uniforms.uRutOrigin = this.uniforms.uRutOrigin;
      shader.uniforms.uRutSize = this.uniforms.uRutSize;
      shader.uniforms.uRutDepth = this.uniforms.uRutDepth;
      shader.uniforms.uRutEnabled = this.uniforms.uRutEnabled;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vRutWorld;
           uniform sampler2D uRutMap;
           uniform vec2 uRutOrigin;
           uniform float uRutSize;
           uniform float uRutDepth;
           uniform float uRutEnabled;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vec3 rutWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
           vRutWorld = rutWorld;
           vec2 rutUv = (rutWorld.xz - uRutOrigin) / uRutSize;
           rutUv.y = 1.0 - rutUv.y;
           vec4 rutSample = texture2D(uRutMap, rutUv);
           float rutMask = step(0.0, rutUv.x) * step(rutUv.x, 1.0)
                         * step(0.0, rutUv.y) * step(rutUv.y, 1.0);
           transformed.y -= rutSample.r * uRutDepth * rutMask * uRutEnabled;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3 vRutWorld;
           uniform sampler2D uRutMap;
           uniform vec2 uRutOrigin;
           uniform float uRutSize;
           uniform float uRutEnabled;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           if (uRutEnabled > 0.5) {
             vec2 rutUvF = (vRutWorld.xz - uRutOrigin) / uRutSize;
             rutUvF.y = 1.0 - rutUvF.y;
             vec4 rut = texture2D(uRutMap, rutUvF);
             // Mud and dirt go dark and glossy where the tyres have been.
             diffuseColor.rgb *= mix(vec3(1.0), vec3(0.15, 0.12, 0.09), clamp(rut.r * 3.4, 0.0, 1.0));
             // Snow is compacted rather than darkened.
             diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.08 + 0.03, rut.b);
           }`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           if (uRutEnabled > 0.5) {
             vec2 rutUvN = (vRutWorld.xz - uRutOrigin) / uRutSize;
             rutUvN.y = 1.0 - rutUvN.y;
             float rutE = 0.0016;
             float hx = texture2D(uRutMap, rutUvN + vec2(rutE, 0.0)).r
                      - texture2D(uRutMap, rutUvN - vec2(rutE, 0.0)).r;
             float hz = texture2D(uRutMap, rutUvN + vec2(0.0, rutE)).r
                      - texture2D(uRutMap, rutUvN - vec2(0.0, rutE)).r;
             float rutH = texture2D(uRutMap, rutUvN).r;
             // A shallow wall: the rut is 0.3 m deep over ~0.4 m, not a cliff.
             vec3 tilted = normalize(vec3(-hx * 1.1, 1.0, -hz * 1.1));
             vec3 tiltedView = normalize((viewMatrix * vec4(tilted, 0.0)).xyz);
             normal = normalize(mix(normal, tiltedView, clamp(rutH * 0.55, 0.0, 0.45)));
           }`,
        );
    };

    material.needsUpdate = true;
  }

  /* ---------------- quality ---------------- */

  get wantsMap() {
    return !!this.quality.settings.enableGpuMudRuts;
  }

  setQuality(settings) {
    const useMap = !!settings.enableGpuMudRuts;

    if (useMap && !this.rt) this._createRenderTarget(settings.id === 'HIGH' ? 2048 : 1024);
    if (!useMap && this.rt) this._disposeRenderTarget();

    if (!useMap && !this.ribbons) this._createRibbons();

    this.mode = useMap ? 'map' : 'ribbon';
    this.uniforms.uRutEnabled.value = useMap ? 1 : 0;
    if (this.ribbons) this.ribbons.forEach((trail) => { trail.mesh.visible = !useMap; });
  }

  /**
   * Phase 8: explicit deformation mode hot swap.
   *   'GPU_1024' / 'GPU_512' -> render-target stamp map
   *   'DECALS'               -> cheap ribbon decals
   *   'MATH_ONLY'            -> no visual ruts at all (physics only)
   */
  setDeformMode(mode) {
    this.deformMode = mode;
    if (mode === 'MATH_ONLY') {
      if (this.rt) this._disposeRenderTarget();
      if (this.ribbons) this.ribbons.forEach((trail) => { trail.mesh.visible = false; });
      this.mode = 'off';
      this.uniforms.uRutEnabled.value = 0;
      return;
    }

    if (mode === 'DECALS') {
      if (this.rt) this._disposeRenderTarget();
      if (!this.ribbons) this._createRibbons();
      this.mode = 'ribbon';
      this.uniforms.uRutEnabled.value = 0;
      if (this.ribbons) this.ribbons.forEach((trail) => { trail.mesh.visible = true; });
      return;
    }

    const size = mode === 'GPU_512' ? 1024 : 2048;
    if (this.ribbons) this.ribbons.forEach((trail) => { trail.mesh.visible = false; });
    if (!this.rt || this.rtSize !== size) {
      if (this.rt) this._disposeRenderTarget();
      this._createRenderTarget(size);
      this._clearRenderTarget();
    }
    this.mode = 'map';
    this.uniforms.uRutEnabled.value = 1;
  }

  attachVehicle(vehicle) {
    this.vehicle = vehicle;
    vehicle.rutTrail = this;
  }

  /* ---------------- render target ---------------- */

  _createRenderTarget(size) {
    this.rtSize = size;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
    });
    this.rt.texture.colorSpace = THREE.NoColorSpace;

    this.stampScene = new THREE.Scene();
    this.stampCamera = new THREE.OrthographicCamera(
      -this.halfSize,
      this.halfSize,
      this.halfSize,
      -this.halfSize,
      0.1,
      600,
    );
    this.stampCamera.position.set(0, 260, 0);
    // A straight-down camera always mirrors one axis. -Z up keeps world X on the
    // U axis, so world Z runs backwards along V; the shader flips V to match.
    this.stampCamera.up.set(0, 0, -1);
    this.stampCamera.lookAt(0, 0, 0);

    const geometry = new THREE.PlaneGeometry(1, 1);
    this.stamps = [0, 1, 2, 3].map(() => {
      const material = new THREE.ShaderMaterial({
        vertexShader: `uniform float sink; uniform float maxDepth; ${STAMP_VERTEX}`,
        fragmentShader: `${STAMP_FRAGMENT}`,
        uniforms: {
          sink: { value: 0 },
          maxDepth: { value: MAX_STAMP_DEPTH },
          uChannel: { value: new THREE.Vector3(0, 0, 0) },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.MaxEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendEquationAlpha: THREE.MaxEquation,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneFactor,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.order = 'YXZ';
      mesh.rotation.x = -Math.PI / 2;
      mesh.frustumCulled = false;
      this.stampScene.add(mesh);
      return mesh;
    });

    this._clearRenderTarget();
    this.uniforms.uRutMap.value = this.rt.texture;
  }

  _clearRenderTarget() {
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousColor = new THREE.Color();
    renderer.getClearColor(previousColor);
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);

    renderer.setClearColor(previousColor, previousAlpha);
    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);
  }

  _disposeRenderTarget() {
    if (this.rt) this.rt.dispose();
    if (this.stamps) {
      for (const stamp of this.stamps) stamp.material.dispose();
      this.stamps[0].geometry.dispose();
    }
    this.rt = null;
    this.stamps = null;
    this.uniforms.uRutMap.value = null;
  }

  /* ---------------- ribbon fallback ---------------- */

  _createRibbons() {
    this.ribbons = [0, 1, 2, 3].map(() => new RibbonTrail(this.scene, { maxSegments: 240 }));
  }

  /* ---------------- per-frame ---------------- */

  /** Ground contact point for a wheel, backed out of the sinkage offset. */
  _contactGround(vehicle, index, out) {
    const contact = vehicle.contactPoint[index];
    const normal = vehicle.contactNormal[index];
    const sink = vehicle.sink[index];
    out.set(
      contact.x + normal.x * sink,
      contact.y + normal.y * sink,
      contact.z + normal.z * sink,
    );
    return out;
  }

  update(dt) {
    const vehicle = this.vehicle;
    if (!vehicle || !vehicle.body) return;

    if (this.mode === 'map') this._updateMap(dt, vehicle);
    else if (this.mode === 'ribbon') this._updateRibbons(vehicle);
  }

  _updateMap(dt, vehicle) {
    if (!this.rt || !this.stamps) return;

    this.accumulator += dt;
    if (this.accumulator < this.stampInterval) return;
    this.accumulator = 0;

    const quaternion = vehicle.group.quaternion;
    const forward = this._tmpVec.set(0, 0, 1).applyQuaternion(quaternion);
    const yaw = Math.atan2(forward.x, forward.z);
    const ground = new THREE.Vector3();

    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousScissorTest = renderer.getScissorTest();

    renderer.setRenderTarget(this.rt);
    renderer.autoClear = false;
    renderer.setScissorTest(true);

    let stamped = false;

    for (let i = 0; i < 4; i += 1) {
      const sink = vehicle.sink[i];
      if (!vehicle.grounded[i] || sink < 0.004) continue;

      const surface = vehicle.wheelSurface[i];
      const key = surface ? surface.key : 'hardpack';
      const channel = this._channelFor(key, sink);
      if (channel === null) continue;

      this._contactGround(vehicle, i, ground);
      const stamp = this.stamps[i];
      stamp.position.set(ground.x, ground.y + 0.02, ground.z);
      stamp.rotation.y = yaw;
      // Wider than the contact patch: a rut is the tread plus the wall it pushes
      // up, and at this map resolution a bare 0.4 m footprint is sub-pixel.
      stamp.scale.set((vehicle.tireWidth || 0.4) * 2.8, 1.7, 1);
      stamp.material.uniforms.sink.value = sink;
      stamp.material.uniforms.uChannel.value.copy(channel);

      this._scissorToStamp(stamp, sink);
      renderer.render(this.stampScene, this.stampCamera);
      this._recordStamp(ground, sink, yaw, key);
      stamped = true;
    }

    renderer.setScissorTest(previousScissorTest);
    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);

    if (stamped) this.uniforms.uRutMap.value = this.rt.texture;
  }

  _channelFor(key, sink) {
    // Square root: a couple of centimetres on hardpack still leaves a readable
    // track, without mud ever reaching full black.
    const depth = Math.min(1, Math.sqrt(Math.max(0, sink) / MAX_STAMP_DEPTH));
    switch (key) {
      case 'mud':
        return this._channel.set(depth, 1, 0);
      case 'snow':
        return this._channel.set(depth * 0.8, 0, 1);
      case 'sand':
        return this._channel.set(depth * 0.7, 0.35, 0);
      case 'water':
        return this._channel.set(depth * 0.6, 0.8, 0);
      default:
        return depth > 0.02 ? this._channel.set(depth * 0.8, 0.12, 0) : null;
    }
  }

  _scissorToStamp(stamp, sink) {
    const size = this.rtSize;
    const half = 0.5 * Math.max(stamp.scale.x, stamp.scale.y) + 0.35;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let c = 0; c < 4; c += 1) {
      const px = stamp.position.x + (c === 0 || c === 3 ? -half : half);
      const pz = stamp.position.z + (c === 0 || c === 1 ? -half : half);
      const projected = this._tmpVec.set(px, stamp.position.y, pz).project(this.stampCamera);
      const sx = (projected.x * 0.5 + 0.5) * size;
      const sy = (projected.y * 0.5 + 0.5) * size;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }

    const pad = 3;
    const x = Math.max(0, Math.floor(minX - pad));
    const y = Math.max(0, Math.floor(minY - pad));
    const w = Math.min(size - x, Math.ceil(maxX - minX) + pad * 2);
    const h = Math.min(size - y, Math.ceil(maxY - minY) + pad * 2);
    // setScissor multiplies by the device pixel ratio unconditionally, even
    // when the target is a render target sized in its own pixels.
    const ratio = this.renderer.getPixelRatio() || 1;
    this.renderer.setScissor(
      x / ratio,
      y / ratio,
      Math.max(1, w) / ratio,
      Math.max(1, h) / ratio,
    );
  }

  _updateRibbons(vehicle) {
    if (!this.ribbons) return;

    const quaternion = vehicle.group.quaternion;
    const forward = this._tmpVec.set(0, 0, 1).applyQuaternion(quaternion);
    const yaw = Math.atan2(forward.x, forward.z);
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    const ground = new THREE.Vector3();

    for (let i = 0; i < 4; i += 1) {
      if (!vehicle.grounded[i]) continue;
      const sink = vehicle.sink[i];
      const surface = vehicle.wheelSurface[i];
      if (!surface || surface.sinkage <= 0) continue;
      if (sink < 0.012) continue;

      this._contactGround(vehicle, i, ground);
      const tint = this._tmpColor.setHex(surface.color || 0x3b2a1c).multiplyScalar(0.75);
      this.ribbons[i].push(ground.x, ground.y, ground.z, dirX, dirZ, tint);
      this._recordStamp(ground, sink, yaw, surface.key || 'hardpack');
    }
  }

  /* ---------------- co-op rut sharing ---------------- */

  /** Queue one compact stamp: [x, z, depth, radius, yaw, keyIndex]. */
  _recordStamp(ground, sink, yaw, key) {
    this._outbox.push([
      Math.round(ground.x * 100) / 100,
      Math.round(ground.z * 100) / 100,
      Math.round(sink * 1000) / 1000,
      Math.round((this.vehicle?.tireWidth || 0.4) * 140) / 100,
      Math.round(yaw * 100) / 100,
      RUT_KEYS.indexOf(key) < 0 ? 0 : RUT_KEYS.indexOf(key),
    ]);
    if (this._outbox.length > 96) this._outbox.shift();
  }

  /** NetworkManager drains the queue and broadcasts it. */
  takeLocalStamps() {
    if (!this._outbox.length) return null;
    const out = this._outbox;
    this._outbox = [];
    return out;
  }

  /**
   * Re-stamp teammates' tracks so a following truck sees (and can follow) the
   * ruts carved in front of it. `stamps` is the same compact format above.
   */
  applyRemoteStamps(stamps) {
    if (!Array.isArray(stamps) || !stamps.length) return;
    const terrain = this.terrain;
    if (!terrain || typeof terrain.getHeightAt !== 'function') return;

    if (this.mode === 'map') {
      if (!this.rt || !this.stamps) return;
      const renderer = this.renderer;
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      const prevScissor = renderer.getScissorTest();

      renderer.setRenderTarget(this.rt);
      renderer.autoClear = false;
      renderer.setScissorTest(true);

      const stamp = this.stamps[0];
      for (const s of stamps) {
        const [x, z, depth, radius, yaw, keyIndex] = s;
        if (!(depth > 0.002) || radius <= 0) continue;
        const y = terrain.getHeightAt(x, z);
        stamp.position.set(x, y + 0.02, z);
        stamp.rotation.y = yaw || 0;
        stamp.scale.set(radius * 2, 1.7, 1);
        stamp.material.uniforms.sink.value = depth;
        stamp.material.uniforms.uChannel.value.copy(
          this._channelFor(RUT_KEYS[keyIndex] || 'hardpack', depth) ||
            this._channel.set(0.2, 0.1, 0),
        );
        this._scissorToStamp(stamp, depth);
        renderer.render(this.stampScene, this.stampCamera);
      }

      renderer.setScissorTest(prevScissor);
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
      this.uniforms.uRutMap.value = this.rt.texture;
      return;
    }

    if (this.mode === 'ribbon') {
      if (!this.remoteTrail) {
        this.remoteTrail = new RibbonTrail(this.scene, { maxSegments: 480 });
      }
      const tint = this._tmpColor.setHex(0x3b2a1c).multiplyScalar(0.75);
      for (const s of stamps) {
        const [x, z, depth, , yaw] = s;
        if (!(depth > 0.008)) continue;
        const y = terrain.getHeightAt(x, z);
        this.remoteTrail.push(x, y, z, Math.sin(yaw || 0), Math.cos(yaw || 0), tint);
      }
    }
  }

  clear() {
    if (this.rt) this._clearRenderTarget();
    if (this.ribbons) this.ribbons.forEach((trail) => trail.clear());
    if (this.remoteTrail) this.remoteTrail.clear();
    this._outbox = [];
  }

  getStats() {
    return {
      mode: this.mode,
      rtSize: this.rtSize,
      ribbons: this.ribbons ? this.ribbons.length : 0,
    };
  }
}

// A reusable scratch vector for the stamp channel.
RutSystem.prototype._channel = new THREE.Vector3();

// Biome keys travel over the wire as small numbers, not strings.
const RUT_KEYS = ['hardpack', 'mud', 'snow', 'sand', 'water'];
