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
 *   3. The sky gets hand-painted cumulus billboards, and the whole frame is
 *      graded toward the current region's palette — warm highlights, lifted
 *      teal/violet shadows, teal-to-peach height fog.
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
 *  painted cumulus
 * ------------------------------------------------------------------ */

function paintCumulus(random, palette) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = Math.round(size * 0.55);
  const ctx = canvas.getContext('2d');
  const h = canvas.height;

  // Build a stack of lobes, big at the base, smaller at the crown.
  const lobes = 14 + Math.floor(random() * 8);
  const baseY = h * 0.86;
  const lobesData = [];
  for (let i = 0; i < lobes; i += 1) {
    const t = i / (lobes - 1);
    const spread = Math.sin(Math.PI * t) * 0.5 + 0.5;
    lobesData.push({
      x: size * (0.12 + 0.76 * t) + (random() - 0.5) * size * 0.06,
      y: baseY - h * 0.42 * Math.sin(Math.PI * Math.pow(t, 0.8)) * (0.6 + random() * 0.5),
      r: h * (0.16 + 0.2 * spread) * (0.7 + random() * 0.5),
    });
  }

  // Cool shadow pass.
  ctx.fillStyle = palette.shadow;
  for (const lobe of lobesData) {
    ctx.beginPath();
    ctx.arc(lobe.x, lobe.y + lobe.r * 0.12, lobe.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Lit body, biased upward so the sun reads from below-left.
  for (const lobe of lobesData) {
    const gradient = ctx.createRadialGradient(
      lobe.x - lobe.r * 0.3,
      lobe.y - lobe.r * 0.45,
      lobe.r * 0.1,
      lobe.x,
      lobe.y,
      lobe.r,
    );
    gradient.addColorStop(0, palette.lit);
    gradient.addColorStop(0.72, palette.mid);
    gradient.addColorStop(1, palette.shadow);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(lobe.x, lobe.y, lobe.r * 0.96, 0, Math.PI * 2);
    ctx.fill();
  }

  // Flat base — clouds sat on the haze line.
  ctx.fillStyle = palette.shadow;
  ctx.fillRect(0, baseY, size, h - baseY);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  return texture;
}

/**
 * A drifting deck of painted cloud cards. They follow the camera so the horizon
 * always has something to look at, and they never receive outlines.
 */
export function createCloudDeck(scene, { count = 14, seed = 7 } = {}) {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const palettes = [
    { lit: '#fff4dc', mid: '#f0dcc0', shadow: '#b9a7c4' },
    { lit: '#ffffff', mid: '#e6eff8', shadow: '#9db6cf' },
    { lit: '#ffe4b8', mid: '#f4c79b', shadow: '#a8798f' },
  ];

  const group = new THREE.Group();
  group.name = 'CloudDeck';
  scene.add(group);

  const cards = [];
  for (let i = 0; i < count; i += 1) {
    const palette = palettes[i % palettes.length];
    const texture = paintCumulus(random, palette);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      opacity: 0.92,
      fog: false,
    });
    const sprite = new THREE.Sprite(material);
    const angle = (i / count) * Math.PI * 2 + random() * 0.4;
    const radius = 420 + random() * 260;
    const height = 120 + random() * 150;
    const scale = 190 + random() * 200;
    sprite.position.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
    sprite.scale.set(scale, scale * 0.55, 1);
    group.add(sprite);
    cards.push({ sprite, angle, radius, height, scale, drift: 0.004 + random() * 0.006 });
  }

  return {
    group,
    cards,
    update(dt, camera) {
      for (const card of cards) {
        card.angle += card.drift * dt * 0.35;
        card.sprite.position.set(
          camera.position.x + Math.cos(card.angle) * card.radius,
          card.height,
          camera.position.z + Math.sin(card.angle) * card.radius,
        );
      }
      group.position.set(0, 0, 0);
    },
  };
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

    this.clouds = createCloudDeck(scene, { count: quality?.settings?.tier === 'LOW' ? 8 : 14 });
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
    this.clouds.update(dt, this.camera);

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
