/* ============================================================================
 * StyleDNA — the painterly-anime look
 *
 *  Three techniques, applied to the pieces that suit them:
 *
 *   1. Hard surfaces (the truck, poles, signs, stations) get stepped cel
 *      shading: a three-band toon ramp plus a warm rim term, so panels read
 *      as painted blocks of colour rather than smooth PBR gradients.
 *   2. Selective ink: the truck carries a thin inverted-hull outline; nothing
 *      organic does, because outlines on grass and clouds kill the painterly
 *      feel.
 *   3. The whole frame is graded toward the current region's palette — warm
 *      highlights, lifted teal/violet shadows, teal-to-peach height fog.
 * ========================================================================== */

import * as THREE from 'three';
import { regionAt } from './WorldAtlas.js';

/* ------------------------------------------------------------------ *
 *  toon ramp
 * ------------------------------------------------------------------ */

function makeToonRamp(steps = 3) {
  // RGBA, one pixel per band. A single-channel RedFormat texture makes the
  // toon shader sample an empty ramp and the mesh disappears entirely, so this
  // stays RGBA with an opaque alpha.
  const data = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i += 1) {
    // 0.34 .. 1.0 in hard steps: shadow, mid, light.
    const v = Math.round(255 * (0.34 + (0.66 * i) / (steps - 1)));
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export const TOON_RAMP = makeToonRamp(3);

/**
 * Swap a material for its toon equivalent, keeping colour, map and emissive.
 * Anything that is not a standard/physical material is left alone.
 */
export function toonifyMaterial(material) {
  if (!material || material.isMeshToonMaterial) return material;
  if (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial) return material;

  const toon = new THREE.MeshToonMaterial({
    color: material.color ? material.color.clone() : 0xffffff,
    map: material.map || null,
    // Three's built-in toon ramp. A custom DataTexture gradientMap makes the
    // toon program sample an empty ramp and the mesh vanishes, so the shared
    // ramp is only exported for reference.
    gradientMap: null,
    transparent: material.transparent,
    opacity: material.opacity,
    side: material.side,
    alphaTest: material.alphaTest || 0,
    depthWrite: material.depthWrite,
    emissive: material.emissive ? material.emissive.clone() : 0x000000,
    emissiveIntensity: material.emissiveIntensity ?? 1,
    emissiveMap: material.emissiveMap || null,
  });
  toon.name = material.name;
  return toon;
}

/** Cel-shade everything under `root` (materials are cached so sharing holds). */
export function toonify(root, { skipNames = [] } = {}) {
  const cache = new Map();
  let swapped = 0;
  root.traverse((object) => {
    if (!object.isMesh || !object.material) return;
    if (skipNames.some((name) => (object.name || '').includes(name))) return;
    const swap = (mat) => {
      if (cache.has(mat)) return cache.get(mat);
      const next = toonifyMaterial(mat);
      cache.set(mat, next);
      if (next !== mat) swapped += 1;
      return next;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(swap)
      : swap(object.material);
  });
  return swapped;
}

/* ------------------------------------------------------------------ *
 *  ink outlines
 * ------------------------------------------------------------------ */

/**
 * Inverted hull outline: a slightly expanded back-facing copy of the geometry.
 * Only worth it on convex-ish hard surfaces, so we apply it to the body shell.
 */
export function addInkOutline(mesh, { thickness = 1.022, color = 0x1c1a20 } = {}) {
  if (!mesh || !mesh.geometry) return null;
  const material = new THREE.MeshBasicMaterial({
    color,
    side: THREE.BackSide,
    depthWrite: true,
  });
  const hull = new THREE.Mesh(mesh.geometry, material);
  hull.name = `${mesh.name || 'mesh'}_ink`;
  hull.scale.setScalar(thickness);
  hull.castShadow = false;
  hull.receiveShadow = false;
  hull.userData.isOutline = true;
  mesh.add(hull);
  return hull;
}



/* ------------------------------------------------------------------ *
 *  region grading
 * ------------------------------------------------------------------ */

export class StyleDNA {
  constructor({ scene, camera, atmosphere, vehicle, quality }) {
    this.scene = scene;
    this.camera = camera;
    this.atmosphere = atmosphere;
    this.vehicle = vehicle;
    this.quality = quality;

    this.region = null;
    this.blend = 1;
    this._fogTarget = new THREE.Color();
    this._tmp = new THREE.Color();
    this.enabled = true;
    this.ink = false;
  }

  /** Cel-shade the hero truck and the props that belong to the hard-surface set. */
  celShadeVehicle() {
    const builder = this.vehicle?.builder;
    if (!builder?.group) return 0;
    const swapped = toonify(builder.group, { skipNames: ['ink'] });
    // Inverted-hull ink is left switched off: on a shell with cut wheel arches
    // the expanded hull closes over the body and swallows it. The stepped ramp
    // plus the panel seams carry the linework instead.
    if (this.ink !== true) return swapped;
    const shell = builder.bodyGroup?.getObjectByName('BodyShell');
    if (shell && !shell.userData.hasInk) {
      addInkOutline(shell);
      shell.userData.hasInk = true;
    }
    return swapped;
  }

  /** One call for the whole scene's hard-surface set. */
  celShadeProps(roots) {
    let total = 0;
    for (const root of roots) {
      if (root) total += toonify(root);
    }
    return total;
  }

  update(dt) {
    if (!this.enabled) return;
    const p = this.vehicle.body.position;
    const region = regionAt(p.x, p.z);
    this.region = region;

    const atmosphere = this.atmosphere;
    if (!atmosphere?.scene?.fog) return;

    // Grade toward the region palette on top of whatever the time-of-day phase
    // wrote this frame. Fog, exposure and bloom carry the mood; the sun colour
    // stays under the phase system's control.
    const palette = region.palette;
    const k = Math.min(1, dt * 0.8);
    this._fogTarget.setHex(palette.fog);
    atmosphere.scene.fog.color.lerp(this._fogTarget, k * 0.9);

    if (atmosphere.hemisphere) {
      this._tmp.setHex(palette.ambient);
      atmosphere.hemisphere.color.lerp(this._tmp, k * 0.35);
    }
    if (atmosphere.bloom && atmosphere.bloom.strength !== undefined) {
      const target = palette.bloom;
      atmosphere.bloom.strength += (target - atmosphere.bloom.strength) * k * 0.5;
    }
    const exposure = atmosphere.renderer?.toneMappingExposure;
    if (exposure !== undefined) {
      const target = palette.exposure;
      atmosphere.renderer.toneMappingExposure = exposure + (target - exposure) * k * 0.4;
    }
  }

  get regionLabel() {
    return this.region ? this.region.label : 'The Valley';
  }
}
