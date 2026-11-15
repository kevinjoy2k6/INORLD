import * as THREE from 'three';

/* ============================================================================
 * VehicleMeshBuilder — a rigged Land-Rover-Defender-style 110, built from code.
 *
 * The hierarchy follows a real vehicle, not a pile of boxes:
 *
 *   group (physics transform)
 *    ├── bodyGroup            <- chassis body, rolls and pitches on its springs
 *    │    ├── chassis frame (ladder rails, cross members, skid plate, gearbox,
 *    │    │   transfer case, exhaust, fuel tank)
 *    │    ├── aluminium body (extruded side profile, arch cut-outs, bevels)
 *    │    ├── glasshouse, door seams, hinges, roof ribs, alpine windows
 *    │    ├── interior (dash, wheel, seats)
 *    │    └── sockets + accessories (snorkel, rack, cans, bullbar, spare)
 *    ├── axleFront / axleRear <- solid axles that articulate with the terrain
 *    │    ├── axle tube, diff pumpkin + cover, pinion, radius arms
 *    │    ├── panhard rod, sway bar + drop links
 *    │    ├── coil springs + dampers (spring length tracks suspension travel)
 *    │    └── brake lines, breather
 *    └── WheelRig x4          <- SteerPivot (Y) -> SpinPivot (X) -> tyre/rim/brake
 *
 * Every wheel keeps its own mud map, so a tyre that has been through the bog
 * stays brown until the river washes it off.
 * ========================================================================== */

/* ------------------------------------------------------------------ *
 *  Paint colours available to co-op players
 * ------------------------------------------------------------------ */
export const PAINT_COLORS = {
  sand: { id: 'sand', label: 'Sand Tan', hex: 0xc9a86a },
  olive: { id: 'olive', label: 'Olive Green', hex: 0x5f6b3c },
  orange: { id: 'orange', label: 'Rescue Orange', hex: 0xd4622a },
  blue: { id: 'blue', label: 'Alpine Blue', hex: 0x3d6b8c },
  white: { id: 'white', label: 'Alpine White', hex: 0xdcdcd2 },
};

export const PAINT_ORDER = ['sand', 'olive', 'orange', 'blue', 'white'];

/* ------------------------------------------------------------------ *
 *  Tyre pressure helpers — shared with the physics so the visual bulge
 *  and the contact-patch maths can never drift apart.
 * ------------------------------------------------------------------ */
export const BODY_DROP = 0.3;

export const PSI_RANGE = { min: 8, max: 35, ref: 20 };

export function tireDeflation(psi) {
  return THREE.MathUtils.clamp((PSI_RANGE.max - psi) / (PSI_RANGE.max - PSI_RANGE.min), 0, 1);
}

export function effectiveTireRadius(baseRadius, psi) {
  return baseRadius * (1 - 0.05 * tireDeflation(psi));
}

/* ------------------------------------------------------------------ *
 *  Accessories — mass and behaviour deltas the vehicle applies
 * ------------------------------------------------------------------ */
export const ACCESSORIES = {
  snorkel: {
    id: 'snorkel',
    label: 'Snorkel',
    short: 'SNORKEL',
    mass: 9,
    comRise: 0.0,
    waterDepth: 1.8,
    winchMultiplier: 1,
    description: 'Raises the fording limit from 0.8 m to 1.8 m',
  },
  roofRack: {
    id: 'roofRack',
    label: 'Safari Roof Rack',
    short: 'RACK',
    mass: 78,
    comRise: 0.05,
    waterDepth: 0.8,
    winchMultiplier: 1,
    description: 'Adds 78 kg of rooftop load and raises the centre of mass',
  },
  jerryCans: {
    id: 'jerryCans',
    label: 'Jerry Cans',
    short: 'CANS',
    mass: 58,
    comRise: 0.02,
    fuelBonus: 60,
    waterDepth: 0.8,
    winchMultiplier: 1,
    requires: 'roofRack',
    description: '+60 L reserve fuel, needs the roof rack',
  },
  bullbar: {
    id: 'bullbar',
    label: 'Bullbar + Winch',
    short: 'BULLBAR',
    mass: 52,
    comRise: 0.0,
    waterDepth: 0.8,
    winchMultiplier: 1.4,
    description: '+40% winch pull force',
  },
  spareWheel: {
    id: 'spareWheel',
    label: 'Spare Wheel',
    short: 'SPARE',
    mass: 34,
    comRise: 0.0,
    waterDepth: 0.8,
    winchMultiplier: 1,
    description: 'Rear door mount, 34 kg aft of the rear axle',
  },
};

export const ACCESSORY_ORDER = ['snorkel', 'roofRack', 'jerryCans', 'bullbar', 'spareWheel'];

/* ------------------------------------------------------------------ *
 *  Small geometry helpers
 * ------------------------------------------------------------------ */

/** A coil spring: a helix swept with a tube. Cheap, and it reads instantly. */
function helixGeometry(radius, height, turns = 6, tube = 0.021) {
  const points = [];
  const steps = turns * 16;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = t * Math.PI * 2 * turns;
    points.push(new THREE.Vector3(
      Math.cos(angle) * radius,
      t * height,
      Math.sin(angle) * radius,
    ));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, steps, tube, 6, false);
}

/** A round headlamp: parabolic bowl revolved from a short profile. */
function lampGeometry(radius) {
  const points = [];
  for (let i = 0; i <= 10; i += 1) {
    const t = i / 10;
    points.push(new THREE.Vector2(radius * Math.sin(t * Math.PI * 0.5), radius * (1 - t) * 0.55));
  }
  return new THREE.LatheGeometry(points, 22);
}

/** Soft tyre: lathe sidewall + moulded mud-terrain blocks baked into the mesh. */
function createTireGeometry(radius, width, columns = 22) {
  const halfWidth = width / 2;
  const profile = [
    new THREE.Vector2(radius * 0.48, -halfWidth),
    new THREE.Vector2(radius * 0.8, -halfWidth),
    new THREE.Vector2(radius * 0.93, -halfWidth * 0.82),
    new THREE.Vector2(radius * 0.975, -halfWidth * 0.45),
    new THREE.Vector2(radius, -halfWidth * 0.18),
    new THREE.Vector2(radius, halfWidth * 0.18),
    new THREE.Vector2(radius * 0.975, halfWidth * 0.45),
    new THREE.Vector2(radius * 0.93, halfWidth * 0.82),
    new THREE.Vector2(radius * 0.8, halfWidth),
    new THREE.Vector2(radius * 0.48, halfWidth),
  ];

  const geometry = new THREE.LatheGeometry(profile, columns * 2);
  // Lathe spins around +Y; lay the wheel on its axle (along +X).
  geometry.rotateZ(Math.PI / 2);

  const positions = geometry.attributes.position;
  const array = positions.array;

  for (let i = 0; i < array.length; i += 3) {
    const x = array[i]; // axial
    const y = array[i + 1];
    const z = array[i + 2];
    const radial = Math.hypot(y, z);
    if (radial < 1e-5) continue;

    const angle = Math.atan2(z, y);
    const column = Math.floor(((angle / (Math.PI * 2) + 0.5) % 1 + 1) % 1 * columns * 2);
    const lugRow = column % 2 === 0;
    const treadBand = Math.min(1, Math.max(0, (radial / radius - 0.9) / 0.1));
    // Centre groove: blocks sit either side of it, like a real MT pattern.
    const centreGroove = 1 - Math.min(1, Math.abs(x) / (halfWidth * 0.12));
    const bump = (lugRow ? 0.05 : -0.012) * treadBand * (1 - centreGroove * 0.75);

    const scale = (radial + bump) / radial;
    array[i + 1] = y * scale;
    array[i + 2] = z * scale;
  }

  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/* ------------------------------------------------------------------ *
 *  Materials shared by every part of one truck
 * ------------------------------------------------------------------ */
function createMaterials(paintHex) {
  return {
    paint: new THREE.MeshStandardMaterial({
      color: paintHex,
      roughness: 0.38,
      metalness: 0.26,
    }),
    paintDark: new THREE.MeshStandardMaterial({
      color: new THREE.Color(paintHex).multiplyScalar(0.72),
      roughness: 0.55,
      metalness: 0.2,
    }),
    darkPlastic: new THREE.MeshStandardMaterial({ color: 0x1b1e21, roughness: 0.88, metalness: 0.06 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x121316, roughness: 0.96, metalness: 0.0, flatShading: true }),
    rim: new THREE.MeshStandardMaterial({ color: 0x8b9198, roughness: 0.44, metalness: 0.85 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x6f757b, roughness: 0.42, metalness: 0.85 }),
    hub: new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.55, metalness: 0.55 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xc6ccd2, roughness: 0.22, metalness: 0.95 }),
    // Low metalness on purpose: there is no environment map to reflect, and a
    // metallic glass renders as opaque black, hiding the interior silhouette.
    glass: new THREE.MeshStandardMaterial({
      color: 0x1b2a35,
      roughness: 0.08,
      metalness: 0.2,
      transparent: true,
      opacity: 0.66,
      depthWrite: false,
    }),
    interior: new THREE.MeshStandardMaterial({ color: 0x24272b, roughness: 0.94, metalness: 0.02 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x6b5a48, roughness: 0.92, metalness: 0.0 }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0xfff6dc,
      emissive: 0xffe6ac,
      emissiveIntensity: 2.2,
      roughness: 0.28,
      metalness: 0.1,
    }),
    tail: new THREE.MeshStandardMaterial({
      color: 0x7d1510,
      emissive: 0xcc2318,
      emissiveIntensity: 0.9,
      roughness: 0.42,
    }),
    amber: new THREE.MeshStandardMaterial({
      color: 0xb06a12,
      emissive: 0xd98a19,
      emissiveIntensity: 0.8,
      roughness: 0.4,
    }),
    can: new THREE.MeshStandardMaterial({ color: 0x3f4a32, roughness: 0.72, metalness: 0.25 }),
    spring: new THREE.MeshStandardMaterial({ color: 0xd4661f, roughness: 0.5, metalness: 0.55 }),
    damper: new THREE.MeshStandardMaterial({ color: 0xe0e4e8, roughness: 0.36, metalness: 0.7 }),
  };
}

/* ------------------------------------------------------------------ *
 *  Per-wheel mud map. A 128x128 canvas painted dark rubber, then stamped
 *  with brown blotches as the tyre rolls through bog, and rinsed when it
 *  is running through water.
 * ------------------------------------------------------------------ */
function createMudMap() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#141518';
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  return { canvas, ctx, texture, amount: 0 };
}

export class VehicleMeshBuilder {
  constructor({
    paint = PAINT_COLORS.sand.hex,
    wheelRadius = 0.46,
    wheelWidth = 0.3,
    comHeight = 0.98,
    suspensionRest = 0.34,
    wheelMounts = [
      { id: 'FL', x: -0.86, z: 1.42 },
      { id: 'FR', x: 0.86, z: 1.42 },
      { id: 'RL', x: -0.86, z: -1.42 },
      { id: 'RR', x: 0.86, z: -1.42 },
    ],
  }) {
    this.paintHex = paint;
    this.wheelRadius = wheelRadius;
    this.wheelWidth = wheelWidth;
    this.comHeight = comHeight;
    this.suspensionRest = suspensionRest;
    this.attachY = -0.32;
    this.wheelMounts = wheelMounts;

    this.materials = createMaterials(paint);
    this.group = new THREE.Group();
    this.group.name = 'VehicleRoot';

    this.bodyGroup = new THREE.Group();
    this.bodyGroup.name = 'ChassisBody';
    // The physics body origin is the centre of mass; the body sheet metal is
    // modelled from the ground plane up, so shift it down by the CoM height.
    // The tub hangs 0.3 m lower than the rigid-body origin: that puts the arch
    // line level with the hub centre, so the tyres sit in the arches instead of
    // dangling below a body on stilts.
    this.bodyGroup.position.y = -comHeight - BODY_DROP;
    this.bodyBaseY = -comHeight - BODY_DROP;
    this.group.add(this.bodyGroup);

    this.sockets = {};
    this.accessoryGroups = {};
    this.headlightsOn = true;
    this.psi = PSI_RANGE.ref;
    this._roll = 0;
    this._pitch = 0;
    this.twist = 0;
    this.jitter = new THREE.Vector2(0, 0);
    this._mudTimer = [0, 0, 0, 0];

    this._buildChassis();
    this._buildBody();
    this._buildInterior();
    this._buildSockets();
    this._buildAccessories();

    this.tireGeometry = createTireGeometry(wheelRadius, wheelWidth);
    this.tireBase = Float32Array.from(this.tireGeometry.attributes.position.array);

    this.axles = {
      front: this._buildAxle(1.42, 'front'),
      rear: this._buildAxle(-1.42, 'rear'),
    };

    this.wheels = wheelMounts.map((mount) => this._buildWheel(mount));
    this.setTirePressure(PSI_RANGE.max);

    this.group.traverse((object) => {
      if (!object.isMesh) return;
      const material = object.material;
      const seeThrough = material === this.materials.glass || material.blending === THREE.AdditiveBlending;
      object.castShadow = !seeThrough;
      object.receiveShadow = !seeThrough;
    });
  }

  /* ================= chassis & drivetrain ================= */

  _buildChassis() {
    const m = this.materials;
    const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    const add = (mesh, x, y, z) => {
      mesh.position.set(x, y, z);
      this.bodyGroup.add(mesh);
      return mesh;
    };

    // ---- ladder frame: two rails and six cross members
    for (const side of [-1, 1]) {
      add(box(0.11, 0.17, 4.02, m.steel), side * 0.42, 0.66, 0);
      // outriggers under the sills
      for (const z of [-1.5, -0.9, -0.2, 0.5, 1.2]) {
        add(box(0.5, 0.07, 0.08, m.steel), side * 0.63, 0.66, z);
      }
    }
    for (const z of [-1.95, -1.3, -0.4, 0.5, 1.35, 1.95]) {
      add(box(0.94, 0.09, 0.1, m.steel), 0, 0.66, z);
    }

    // ---- skid plate and front cross member
    add(box(0.86, 0.05, 0.7, m.darkPlastic), 0, 0.6, 1.5);

    // ---- engine, gearbox, transfer case, propshafts
    add(box(0.62, 0.42, 0.86, m.darkPlastic), 0, 0.86, 1.32);
    add(box(0.5, 0.34, 0.72, m.hub), 0, 0.72, 0.42);
    add(box(0.42, 0.3, 0.46, m.hub), 0, 0.68, -0.3);
    for (const [z0, z1] of [[0.6, 1.32], [-0.3, -1.36]]) {
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, Math.abs(z1 - z0), 8),
        m.steel,
      );
      shaft.rotation.x = Math.PI / 2;
      add(shaft, 0, 0.62, (z0 + z1) / 2);
    }

    // ---- fuel tank and exhaust
    add(box(0.86, 0.26, 0.76, m.darkPlastic), 0, 0.5, -1.35);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 1.7, 8), m.steel);
    pipe.rotation.x = Math.PI / 2;
    add(pipe, 0.5, 0.44, -0.65);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 8), m.chrome);
    tip.rotation.x = Math.PI / 2;
    add(tip, 0.5, 0.44, -1.56);

    // ---- battery box and airbox, visible under the bonnet line
    add(box(0.3, 0.2, 0.36, m.darkPlastic), -0.36, 0.9, 0.9);
  }

  /* ================= body ================= */

  _buildBody() {
    const m = this.materials;
    const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    const add = (mesh, x, y, z) => {
      mesh.position.set(x, y, z);
      this.bodyGroup.add(mesh);
      return mesh;
    };

    /* ---- lower body: one extruded aluminium tub -------------------------
     * A Defender is a flat-sided box with cut-out arches. The tub carries the
     * sill, the arches and the waist line; the glasshouse above it is built
     * separately so the windows are openings rather than stickers on a slab. */
    const archRadius = 0.56;
    const sill = 0.54;
    const waist = 1.52;
    const shape = new THREE.Shape();
    shape.moveTo(-2.14, sill);
    shape.lineTo(-2.02, sill);
    shape.lineTo(-2.02, 0.6);
    shape.absarc(-1.42, 0.6, archRadius, Math.PI, 0, true);
    shape.lineTo(0.86, 0.6);
    shape.absarc(1.42, 0.6, archRadius, Math.PI, 0, true);
    shape.lineTo(1.98, 0.6);
    shape.lineTo(2.14, 0.62);
    shape.lineTo(2.16, 0.74);
    shape.lineTo(2.16, 1.46);
    shape.lineTo(2.02, waist);
    shape.lineTo(-2.08, waist);
    shape.lineTo(-2.14, 1.44);
    shape.lineTo(-2.14, sill);

    const hullGeometry = new THREE.ExtrudeGeometry(shape, {
      depth: 1.88,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.028,
      bevelSegments: 3,
      curveSegments: 16,
    });
    hullGeometry.rotateY(-Math.PI / 2);
    hullGeometry.translate(0.94, 0, 0);
    const hull = new THREE.Mesh(hullGeometry, m.paint);
    hull.name = 'BodyShell';
    this.bodyGroup.add(hull);

    /* ---- bonnet, wings and the waist-line trim ---- */
    const bonnet = box(1.78, 0.06, 1.06, m.paint);
    bonnet.rotation.x = -0.02;
    add(bonnet, 0, waist + 0.03, 1.52);
    add(box(0.66, 0.04, 0.34, m.darkPlastic), 0, waist + 0.055, 1.28); // vent

    for (const side of [-1, 1]) {
      add(box(0.04, 0.05, 4.02, m.darkPlastic), side * 0.955, waist - 0.02, 0); // belt trim
      add(box(0.5, 0.06, 0.94, m.paint), side * 0.62, waist + 0.02, 1.5); // wing top
    }

    /* ---- arch flares and liners ---- */
    for (const z of [1.42, -1.42]) {
      for (const side of [-1, 1]) {
        const flare = new THREE.Mesh(
          new THREE.TorusGeometry(archRadius + 0.02, 0.075, 6, 20, Math.PI),
          m.darkPlastic,
        );
        flare.geometry.rotateY(Math.PI / 2);
        flare.position.set(side * 0.955, 0.6, z);
        this.bodyGroup.add(flare);

        const liner = new THREE.Mesh(
          new THREE.CylinderGeometry(archRadius - 0.04, archRadius - 0.04, 0.03, 18, 1, true, 0, Math.PI),
          m.darkPlastic,
        );
        liner.rotation.x = Math.PI / 2;
        liner.rotation.z = Math.PI / 2;
        liner.position.set(side * 0.8, 0.6, z);
        this.bodyGroup.add(liner);
      }
    }

    /* ---- side steps / rock sliders ---- */
    for (const side of [-1, 1]) {
      add(box(0.2, 0.07, 1.56, m.darkPlastic), side * 0.9, 0.52, 0);
      add(box(0.12, 0.1, 0.1, m.steel), side * 0.9, 0.56, 0.62);
      add(box(0.12, 0.1, 0.1, m.steel), side * 0.9, 0.56, -0.62);
    }

    /* ---- front face: grille, round lamps, indicators, bumper ---- */
    add(box(1.56, 0.44, 0.07, m.darkPlastic), 0, 1.22, 2.16);
    for (let i = 0; i < 6; i += 1) {
      add(box(1.46, 0.026, 0.03, m.steel), 0, 1.06 + i * 0.062, 2.2);
    }
    add(box(0.22, 0.09, 0.04, m.paint), 0, 1.36, 2.2); // badge

    this.beams = [];
    for (const side of [-1, 1]) {
      const bowl = new THREE.Mesh(lampGeometry(0.175), m.darkPlastic);
      bowl.rotation.x = -Math.PI / 2;
      add(bowl, side * 0.6, 1.26, 2.14);

      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.16, 20), m.lamp);
      add(lens, side * 0.6, 1.26, 2.21);

      const indicator = new THREE.Mesh(new THREE.CircleGeometry(0.06, 12), m.amber);
      add(indicator, side * 0.87, 1.14, 2.18);

      const beam = new THREE.Mesh(
        new THREE.ConeGeometry(0.42, 3.4, 14, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xffe9b0,
          transparent: true,
          opacity: 0.08,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      beam.rotation.x = -Math.PI / 2;
      beam.position.set(side * 0.6, 1.26, 3.9);
      this.bodyGroup.add(beam);
      this.beams.push(beam);

      add(box(0.16, 0.26, 0.05, m.tail), side * 0.78, 1.2, -2.16);

      // mirrors on stalks
      add(box(0.06, 0.05, 0.22, m.darkPlastic), side * 0.96, 1.72, 0.78);
      add(box(0.05, 0.22, 0.14, m.darkPlastic), side * 1.08, 1.72, 0.78);
    }

    add(box(1.98, 0.18, 0.26, m.darkPlastic), 0, 0.8, 2.12);
    add(box(1.98, 0.18, 0.24, m.darkPlastic), 0, 0.8, -2.14);
    for (const side of [-1, 1]) {
      add(box(0.16, 0.09, 0.1, m.amber), side * 0.82, 0.8, 2.26);
    }

    /* ---- glasshouse: pillars, glass openings, flat roof ---- */
    add(box(1.84, 0.07, 2.82, m.paint), 0, 2.05, -0.68); // roof panel
    add(box(1.84, 0.09, 0.16, m.paint), 0, 2.01, 0.71); // screen header
    for (let i = 0; i < 4; i += 1) {
      add(box(1.66, 0.02, 0.05, m.paintDark), 0, 2.1, -1.5 + i * 0.5); // roof ribs
    }
    for (const side of [-1, 1]) {
      add(box(0.05, 0.06, 2.86, m.steel), side * 0.93, 2.0, -0.68); // gutter rail
    }

    // windscreen: upright, with its frame
    const windscreen = box(1.66, 0.52, 0.04, m.glass);
    windscreen.rotation.x = -0.16;
    add(windscreen, 0, 1.78, 0.76);
    const screenTop = box(1.76, 0.06, 0.1, m.paint);
    screenTop.rotation.x = -0.16;
    add(screenTop, 0, 2.04, 0.72);
    const screenBottom = box(1.76, 0.07, 0.1, m.paint);
    add(screenBottom, 0, 1.52, 0.84);

    // pillars
    for (const side of [-1, 1]) {
      const aPillar = box(0.08, 0.54, 0.09, m.paint);
      aPillar.rotation.x = -0.16;
      add(aPillar, side * 0.9, 1.78, 0.78);
      add(box(0.07, 0.52, 0.09, m.darkPlastic), side * 0.905, 1.78, -0.38); // B
      add(box(0.08, 0.52, 0.1, m.paint), side * 0.905, 1.78, -1.52); // C
      add(box(0.08, 0.52, 0.12, m.paint), side * 0.905, 1.78, -2.02); // D
    }

    // side glass: front door, rear door, rear quarter — sat in real openings
    for (const side of [-1, 1]) {
      add(box(0.03, 0.42, 1.1, m.glass), side * 0.935, 1.78, 0.18);
      add(box(0.03, 0.42, 1.06, m.glass), side * 0.935, 1.78, -0.96);
      add(box(0.03, 0.42, 0.42, m.glass), side * 0.935, 1.78, -1.78);
      // window rubbers make the glass read as glazing, not a hole
      add(box(0.04, 0.03, 1.14, m.darkPlastic), side * 0.94, 1.99, 0.18);
      add(box(0.04, 0.03, 1.1, m.darkPlastic), side * 0.94, 1.99, -0.96);
      add(box(0.04, 0.03, 1.14, m.darkPlastic), side * 0.94, 1.57, 0.18);
      add(box(0.04, 0.03, 1.1, m.darkPlastic), side * 0.94, 1.57, -0.96);
    }

    // rear door with its window
    add(box(1.72, 0.5, 0.04, m.glass), 0, 1.78, -2.12);
    add(box(1.8, 0.06, 0.08, m.paint), 0, 1.54, -2.12);
    add(box(0.2, 0.05, 0.05, m.chrome), 0.5, 1.32, -2.18);
    add(box(0.05, 0.16, 0.05, m.darkPlastic), 0.86, 1.6, -2.16);

    /* ---- panel seams: thin dark tubing reads as shut lines ---- */
    const seam = (points, radius = 0.008) => {
      const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, radius, 5, false), m.darkPlastic);
      this.bodyGroup.add(tube);
    };
    for (const side of [-1, 1]) {
      const x = side * 0.962;
      seam([[x, 1.5, 0.8], [x, 1.0, 0.8], [x, 0.82, 0.8]]);
      seam([[x, 1.5, -0.34], [x, 1.0, -0.34], [x, 0.82, -0.34]]);
      seam([[x, 1.5, -1.5], [x, 1.0, -1.5], [x, 0.82, -1.5]]);
      seam([[x, 1.42, 0.8], [x, 1.42, -2.0]]);

      add(box(0.05, 0.09, 0.05, m.darkPlastic), side * 0.955, 1.16, 0.74);
      add(box(0.05, 0.09, 0.05, m.darkPlastic), side * 0.955, 1.16, -0.4);
      add(box(0.12, 0.04, 0.04, m.darkPlastic), side * 0.965, 1.2, 0.5);
      add(box(0.12, 0.04, 0.04, m.darkPlastic), side * 0.965, 1.2, -0.74);
    }

    // rear body panel below the door window
    add(box(1.72, 0.12, 0.06, m.paint), 0, 1.48, -2.13);
    seam([[0, 2.02, -2.14], [0, 1.54, -2.14]]);

    /* ---- mud flaps behind each wheel ---- */
    for (const z of [0.86, -1.96]) {
      for (const side of [-1, 1]) {
        add(box(0.3, 0.32, 0.03, m.darkPlastic), side * 0.84, 0.3, z);
      }
    }
  }

  _buildInterior() {
    const m = this.materials;
    const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    const add = (mesh, x, y, z) => {
      mesh.position.set(x, y, z);
      this.bodyGroup.add(mesh);
      return mesh;
    };

    add(box(1.62, 0.05, 2.5, m.interior), 0, 1.0, -0.7); // floor
    add(box(1.56, 0.26, 0.4, m.interior), 0, 1.24, 0.62); // dash
    add(box(1.5, 0.08, 0.14, m.interior), 0, 1.33, 0.38); // dash lip

    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.022, 8, 20), m.darkPlastic);
    wheel.rotation.x = -1.15;
    add(wheel, 0.42, 1.42, 0.3);
    add(box(0.05, 0.3, 0.05, m.darkPlastic), 0.42, 1.24, 0.42);

    for (const x of [0.42, -0.42]) {
      add(box(0.44, 0.12, 0.44, m.seat), x, 1.08, -0.3);
      const back = box(0.44, 0.56, 0.14, m.seat);
      back.rotation.x = 0.16;
      add(back, x, 1.34, -0.54);
      add(box(0.2, 0.12, 0.12, m.seat), x, 1.62, -0.6);
    }

    add(box(1.34, 0.12, 0.44, m.seat), 0, 1.08, -1.3);
    const benchBack = box(1.34, 0.5, 0.13, m.seat);
    benchBack.rotation.x = 0.14;
    add(benchBack, 0, 1.32, -1.52);

    // cargo area: load bay floor and a pair of cubby boxes
    add(box(1.5, 0.04, 0.9, m.interior), 0, 1.0, -1.9);
    add(box(0.4, 0.3, 0.4, m.darkPlastic), -0.42, 1.18, -1.9);
  }

  _buildSockets() {
    const defs = {
      roof: [0, 2.1, -0.68],
      snorkel: [-0.92, 1.5, 0.84],
      frontBumper: [0, 0.82, 2.16],
      rearDoor: [0, 1.2, -2.22],
      hitch: [0, 0.6, -2.3],
      winchFront: [0, 0.84, 2.26],
      winchRear: [0, 0.68, -2.38],
    };

    for (const [name, [x, y, z]] of Object.entries(defs)) {
      const socket = new THREE.Object3D();
      socket.name = `socket_${name}`;
      socket.position.set(x, y, z);
      this.bodyGroup.add(socket);
      this.sockets[name] = socket;
    }
  }

  /** Socket position in the physics body frame (origin at the centre of mass). */
  socketLocal(name, target = new THREE.Vector3()) {
    const socket = this.sockets[name];
    if (!socket) return target.set(0, 0, 0);
    return target.set(socket.position.x, socket.position.y - this.comHeight, socket.position.z);
  }

  socketWorld(name, target = new THREE.Vector3()) {
    const socket = this.sockets[name];
    if (!socket) return target.set(0, 0, 0);
    return socket.getWorldPosition(target);
  }

  /* ================= accessories ================= */

  _buildAccessories() {
    const m = this.materials;
    const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

    /* ---- snorkel: A-pillar ram tube plus a head */
    const snorkel = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.0, 10), m.darkPlastic);
    tube.position.set(0, 0.62, 0.04);
    snorkel.add(tube);
    const elbow = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.3, 10), m.darkPlastic);
    elbow.rotation.x = -0.637;
    elbow.position.set(0, 1.18, -0.06);
    snorkel.add(elbow);
    const head = box(0.16, 0.16, 0.3, m.darkPlastic);
    head.position.set(0, 1.36, -0.14);
    snorkel.add(head);
    const intake = box(0.13, 0.13, 0.04, m.chrome);
    intake.position.set(0, 1.36, 0.02);
    snorkel.add(intake);
    this._registerAccessory('snorkel', snorkel, [0, 0, 0]);

    /* ---- roof rack + jerry cans */
    const rack = new THREE.Group();
    for (const side of [-1, 1]) {
      const rail = box(0.06, 0.06, 2.3, m.darkPlastic);
      rail.position.set(side * 0.8, 0.16, 0);
      rack.add(rail);
      for (const z of [-1.0, -0.33, 0.33, 1.0]) {
        const leg = box(0.06, 0.16, 0.06, m.darkPlastic);
        leg.position.set(side * 0.8, 0.07, z);
        rack.add(leg);
      }
    }
    for (const z of [-1.1, -0.72, -0.34, 0.04, 0.42, 0.8, 1.1]) {
      const slat = box(1.6, 0.035, 0.05, m.darkPlastic);
      slat.position.set(0, 0.17, z);
      rack.add(slat);
    }
    const rackFloor = box(1.58, 0.03, 2.2, m.darkPlastic);
    rackFloor.position.set(0, 0.155, 0);
    rack.add(rackFloor);
    this._registerAccessory('roofRack', rack, [0, 2.09, -0.68]);

    const cans = new THREE.Group();
    for (const x of [-0.42, 0, 0.42]) {
      const can = box(0.3, 0.34, 0.22, m.can);
      can.position.set(x, 0.34, -0.5);
      cans.add(can);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8), m.chrome);
      cap.position.set(x, 0.53, -0.5);
      cans.add(cap);
      const handle = box(0.24, 0.04, 0.04, m.darkPlastic);
      handle.position.set(x, 0.5, -0.5);
      cans.add(handle);
    }
    this._registerAccessory('jerryCans', cans, [0, 2.11, -0.68]);

    /* ---- bullbar and winch drum */
    const bullbar = new THREE.Group();
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.86, 10), m.chrome);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, 0.3, 0);
    bullbar.add(bar);
    for (const side of [-1, 1]) {
      const upright = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.85, 10), m.chrome);
      upright.position.set(side * 0.7, 0.0, 0.02);
      bullbar.add(upright);
    }
    for (const side of [-1, 1]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.045, 6, 14, Math.PI), m.chrome);
      hoop.position.set(side * 0.36, 0.24, 0.02);
      bullbar.add(hoop);
    }
    const winchDrum = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.42, 14), m.darkPlastic);
    winchDrum.rotation.z = Math.PI / 2;
    winchDrum.position.set(0, 0.08, -0.06);
    bullbar.add(winchDrum);
    const winchPlate = box(0.7, 0.16, 0.2, m.darkPlastic);
    winchPlate.position.set(0, 0.08, -0.06);
    bullbar.add(winchPlate);
    const fairlead = box(0.34, 0.08, 0.05, m.chrome);
    fairlead.position.set(0, 0.08, 0.1);
    bullbar.add(fairlead);
    this._registerAccessory('bullbar', bullbar, [0, 0.62, 2.22]);

    /* ---- spare wheel on the rear door */
    const spare = new THREE.Group();
    const spareTire = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.28, 20, 1), m.rubber);
    spareTire.rotation.z = Math.PI / 2;
    spare.add(spareTire);
    const spareRim = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.3, 14), m.rim);
    spareRim.rotation.z = Math.PI / 2;
    spare.add(spareRim);
    const bracket = box(0.1, 0.34, 0.1, m.darkPlastic);
    bracket.position.set(0, 0, -0.2);
    spare.add(bracket);
    this._registerAccessory('spareWheel', spare, [0, 1.42, -2.4]);

    /* ---- front and rear tow shackles (always fitted) */
    for (const [name, y, z] of [
      ['winchFront', 0.74, 0.2],
      ['winchRear', 0.66, -0.2],
    ]) {
      const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.022, 6, 12, Math.PI * 1.3), m.amber);
      shackle.position.set(0, y, z);
      shackle.rotation.y = Math.PI / 2;
      this.bodyGroup.add(shackle);
      this.sockets[name].userData.shackle = shackle;
    }
  }

  _registerAccessory(id, group, position) {
    group.position.set(position[0], position[1], position[2]);
    group.visible = false;
    group.traverse((object) => {
      if (object.isMesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    this.bodyGroup.add(group);
    this.accessoryGroups[id] = group;
  }

  setAccessory(id, enabled) {
    const group = this.accessoryGroups[id];
    if (!group) return false;
    group.visible = !!enabled;
    return group.visible;
  }

  isAccessoryVisible(id) {
    const group = this.accessoryGroups[id];
    return !!(group && group.visible);
  }

  /* ================= axles ================= */

  /**
   * A solid live axle. The group sits at hub height and tilts around Z as one
   * wheel climbs while the other drops — the articulation you can actually see
   * from the chase camera. Springs and dampers are stretched from the axle to
   * the chassis every frame by `updateSuspension`.
   */
  _buildAxle(z, which) {
    const m = this.materials;
    const axle = new THREE.Group();
    axle.name = `Axle_${which}`;
    axle.position.set(0, this.attachY, z);
    this.group.add(axle);

    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 1.52, 10), m.steel);
    tube.rotation.z = Math.PI / 2;
    axle.add(tube);

    // diff pumpkin, offset to the driver's side like the real thing
    const diff = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), m.steel);
    diff.scale.set(1, 0.92, 0.86);
    diff.position.set(0.14, 0.0, which === 'front' ? 0.02 : -0.02);
    axle.add(diff);

    const cover = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.06, 14), m.hub);
    cover.rotation.x = Math.PI / 2;
    cover.position.set(0.14, 0.0, which === 'front' ? 0.16 : -0.16);
    axle.add(cover);

    const pinion = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.2, 8), m.steel);
    pinion.rotation.x = Math.PI / 2;
    pinion.position.set(0.14, 0.04, which === 'front' ? -0.16 : 0.16);
    axle.add(pinion);

    // radius arms running forward to the chassis
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 1.0), m.steel);
      arm.position.set(side * 0.52, -0.1, which === 'front' ? 0.34 : -0.34);
      arm.rotation.x = which === 'front' ? 0.13 : -0.13;
      axle.add(arm);
    }

    // panhard rod
    const pan = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 1.3, 8), m.steel);
    pan.rotation.z = Math.PI / 2;
    pan.rotation.y = 0.1;
    pan.position.set(0, -0.02, which === 'front' ? -0.12 : 0.12);
    axle.add(pan);

    // sway bar across the axle, with drop links up to the chassis
    const sway = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 1.34, 8), m.hub);
    sway.rotation.z = Math.PI / 2;
    sway.position.set(0, 0.12, which === 'front' ? 0.2 : -0.2);
    axle.add(sway);
    for (const side of [-1, 1]) {
      const link = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 6), m.hub);
      link.position.set(side * 0.62, 0.22, which === 'front' ? 0.2 : -0.2);
      axle.add(link);
    }

    // brake lines + breather
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.9, 5), m.darkPlastic);
    line.rotation.z = Math.PI / 2;
    line.position.set(0, 0.06, which === 'front' ? 0.1 : -0.1);
    axle.add(line);

    const parts = { group: axle, springs: [], dampers: [], which, z };
    for (const side of [-1, 1]) {
      const spring = new THREE.Mesh(helixGeometry(0.085, 0.34, 6, 0.019), m.spring);
      spring.position.set(side * 0.5, 0, 0.02);
      spring.rotation.x = 0;
      axle.add(spring);
      parts.springs.push(spring);

      const damper = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.34, 8), m.damper);
      damper.position.set(side * 0.62, 0.02, which === 'front' ? -0.06 : 0.06);
      axle.add(damper);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 6), m.steel);
      rod.position.set(side * 0.62, 0.24, which === 'front' ? -0.06 : 0.06);
      axle.add(rod);
      parts.dampers.push(damper);
    }

    return parts;
  }

  /* ================= wheels ================= */

  _buildWheel(mount) {
    const m = this.materials;
    const radius = this.wheelRadius;
    const width = this.wheelWidth;

    // SteerPivot (Y) -> SpinPivot (X): never rotate one mesh on two axes.
    const pivot = new THREE.Group();
    pivot.name = `SteerPivot_${mount.id}`;
    pivot.position.set(mount.x, this.attachY - this.suspensionRest, mount.z);

    const spin = new THREE.Group();
    spin.name = `SpinPivot_${mount.id}`;

    const mud = createMudMap();
    const tireMaterial = m.rubber.clone();
    tireMaterial.map = mud.texture;
    tireMaterial.color.setHex(0xffffff);
    tireMaterial.needsUpdate = true;

    const tire = new THREE.Mesh(this.tireGeometry, tireMaterial);
    spin.add(tire);

    // rim barrel and beadlock rings
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.46, radius * 0.46, width * 0.9, 18, 1),
      m.rim,
    );
    barrel.rotation.z = Math.PI / 2;
    spin.add(barrel);
    for (const side of [-1, 1]) {
      const beadlock = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.47, 0.032, 6, 20), m.hub);
      beadlock.rotation.y = Math.PI / 2;
      beadlock.position.x = side * width * 0.45;
      spin.add(beadlock);
    }

    // six-spoke alloy
    const spokeLength = radius * 0.72;
    for (let i = 0; i < 6; i += 1) {
      const angle = (i / 6) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(width * 0.42, 0.075, spokeLength), m.rim);
      spoke.rotation.x = angle;
      spoke.position.set(0, -Math.sin(angle) * spokeLength * 0.42, Math.cos(angle) * spokeLength * 0.42);
      spin.add(spoke);
    }

    // hub cap + lug nuts
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.17, radius * 0.17, width * 0.55, 10),
      m.hub,
    );
    hub.rotation.z = Math.PI / 2;
    spin.add(hub);
    for (let i = 0; i < 5; i += 1) {
      const angle = (i / 5) * Math.PI * 2;
      const nut = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.03, 6), m.chrome);
      nut.rotation.z = Math.PI / 2;
      nut.position.set(width * 0.28, Math.sin(angle) * radius * 0.2, Math.cos(angle) * radius * 0.2);
      spin.add(nut);
    }

    // brake disc and caliper (they do not spin with the wheel, so they live on
    // the steer pivot)
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.42, radius * 0.42, 0.022, 20), m.steel);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = -Math.sign(mount.x) * 0.02;
    pivot.add(disc);
    const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.1), m.hub);
    caliper.position.set(-Math.sign(mount.x) * 0.04, 0.14, -0.12);
    pivot.add(caliper);

    pivot.add(spin);
    this.group.add(pivot);

    return {
      id: mount.id,
      pivot,
      spin,
      tire,
      tireMaterial,
      mud,
      radius,
      baseX: mount.x,
      baseZ: mount.z,
      normal: new THREE.Vector3(0, 0, 1),
    };
  }

  /** Rebuild the tyre cross-section for a new inflation pressure. */
  setTirePressure(psi) {
    this.psi = psi;
    const flatten = tireDeflation(psi);
    const radius = this.wheelRadius;
    const effectiveRadius = effectiveTireRadius(radius, psi);

    if (!this.tireGeometry) return;

    const positions = this.tireGeometry.attributes.position;
    const array = positions.array;
    const base = this.tireBase;
    let minY = Infinity;

    for (let i = 0; i < array.length; i += 3) {
      const bx = base[i];
      const by = base[i + 1];
      const bz = base[i + 2];
      const radial = Math.hypot(by, bz);

      if (radial < 1e-5) {
        array[i] = bx;
        array[i + 1] = by;
        array[i + 2] = bz;
        if (by < minY) minY = by;
        continue;
      }

      const t = Math.max(0, -by / radial); // 1 at the bottom of the circle
      const squash = 1 - 0.14 * flatten * Math.pow(t, 1.5);
      const ny = by * squash + (t > 0.85 ? (t - 0.85) * flatten * effectiveRadius * 0.18 : 0);
      const nz = bz * squash * (1 + 0.09 * flatten * t * t);
      const nx = bx * (1 + 0.3 * flatten * (0.55 + 0.45 * t));

      array[i] = nx;
      array[i + 1] = ny;
      array[i + 2] = nz;
      if (ny < minY) minY = ny;
    }

    positions.needsUpdate = true;
    this.tireGeometry.computeVertexNormals();

    // Sit the tread on the pivot's zero line. Applied as a delta so repeated
    // inflation changes cannot walk the wheel down through the floor.
    const lift = -effectiveRadius - minY;
    const drift = lift - (this._tireLift || 0);
    if (Math.abs(drift) > 1e-6) this.tireGeometry.translate(0, drift, 0);
    this._tireLift = lift;
    this.tireGeometry.computeBoundingSphere();
  }

  /* ================= rig animation ================= */

  /**
   * Called once per rendered frame by OffroadVehicle.
   *
   * `state` = {
   *   suspLen:   [FL, FR, RL, RR]   current strut length from the ray cast
   *   wheelSteer:[FL, FR]          steering angle per front wheel
   *   spin:      [FL, FR, RL, RR]  accumulated rotation
   *   attachY, bodyRoll, bodyPitch, dt,
   *   surfaces:  per-wheel surface objects (for mud)
   * }
   */
  updateRig(state) {
    const { suspLen, wheelSteer, spin, attachY, dt = 0.016 } = state;

    /* ---- solid axles: sit at hub height and roll with the terrain ---- */
    const frontY = attachY - (suspLen[0] + suspLen[1]) * 0.5;
    const rearY = attachY - (suspLen[2] + suspLen[3]) * 0.5;
    const frontRoll = (suspLen[0] - suspLen[1]) * 0.9;
    const rearRoll = (suspLen[2] - suspLen[3]) * 0.9;

    this.axles.front.group.position.y = frontY;
    this.axles.rear.group.position.y = rearY;
    this.axles.front.group.rotation.z = frontRoll;
    this.axles.rear.group.rotation.z = rearRoll;
    // A solid axle also twists slightly fore/aft as it articulates.
    this.axles.front.group.rotation.x = (suspLen[0] + suspLen[1]) * 0.06;
    this.axles.rear.group.rotation.x = -(suspLen[2] + suspLen[3]) * 0.06;

    /* ---- springs and dampers: compress visibly ---- */
    const springTop = attachY + 0.24;
    for (const axle of [this.axles.front, this.axles.rear]) {
      const hubY = axle.group.position.y;
      const gap = Math.max(0.16, springTop - hubY);
      for (const spring of axle.springs) {
        spring.scale.y = gap / 0.34;
      }
      for (const damper of axle.dampers) {
        damper.scale.y = gap / 0.34;
      }
    }

    /* ---- body roll and pitch from spring compression ---- */
    const rollTarget = (frontRoll + rearRoll) * 0.55;
    const pitchTarget = ((suspLen[0] + suspLen[1]) - (suspLen[2] + suspLen[3])) * 0.9;
    this._roll += (rollTarget - this._roll) * Math.min(1, dt * 8);
    this._pitch += (pitchTarget - this._pitch) * Math.min(1, dt * 8);
    // Torque twist and engine shiver come from TactileVFX; the rig adds them
    // on top of the suspension-driven roll so the two never fight for the
    // same transform.
    this.bodyGroup.rotation.z = -this._roll + this.twist;
    this.bodyGroup.rotation.x = this._pitch;
    this.bodyGroup.position.x = this.jitter.x;
    this.bodyGroup.position.y = this.bodyBaseY + this.jitter.y;

    /* ---- meaty tyre deformation already lives in the geometry (psi) ---- */

    /* ---- mud pickup and wash-off ---- */
    const surfaces = state.surfaces || [];
    for (let i = 0; i < this.wheels.length; i += 1) {
      const wheel = this.wheels[i];
      const surface = surfaces[i];
      const key = surface?.key;
      const moving = Math.abs(spin[i] - (this._mudTimer[i] || 0)) > 0.5;
      if (moving) this._mudTimer[i] = spin[i];

      if (key === 'mud' || (key === 'snow' && Math.random() < 0.4)) {
        if (moving) this._splatMud(wheel, key === 'snow' ? 0.35 : 1);
      } else if (key === 'water') {
        this._washMud(wheel, dt);
      } else if (key === 'sand' && moving && Math.random() < 0.35) {
        this._splatMud(wheel, 0.4, '#9a8358');
      }
    }
  }

  /** Stamp a brown blotch onto this wheel's mud map. */
  _splatMud(wheel, strength = 1, colour = '#4b3823') {
    const mud = wheel.mud;
    if (!mud || mud.amount > 0.98) return;
    const { ctx, texture } = mud;
    mud.amount = Math.min(1, mud.amount + 0.06 * strength);

    const blobs = 1 + Math.floor(strength * 2);
    for (let i = 0; i < blobs; i += 1) {
      const x = Math.random() * 128;
      const y = Math.random() * 128;
      const r = 5 + Math.random() * 13;
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.55 + Math.random() * 0.4;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    texture.needsUpdate = true;
  }

  /** River crossing rinses the tread clean. */
  _washMud(wheel, dt) {
    const mud = wheel.mud;
    if (!mud || mud.amount <= 0.01) return;
    mud.amount = Math.max(0, mud.amount - dt * 0.6);
    const { ctx, texture } = mud;
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#141518';
    for (let i = 0; i < 4; i += 1) {
      const x = Math.random() * 128;
      const y = Math.random() * 128;
      ctx.beginPath();
      ctx.arc(x, y, 10 + Math.random() * 14, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    texture.needsUpdate = true;
  }

  /* ================= shared controls ================= */

  setPaint(hex) {
    this.paintHex = hex;
    this.materials.paint.color.setHex(hex);
    this.materials.paintDark.color.setHex(hex).multiplyScalar(0.72);
  }

  setHeadlights(on) {
    this.headlightsOn = !!on;
    this.materials.lamp.emissiveIntensity = this.headlightsOn ? 2.2 : 0.05;
    for (const beam of this.beams) beam.visible = this.headlightsOn;
  }

  /** Exposed so co-op paint swaps and accessory changes stay in one place. */
  dispose() {
    this.group.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
    });
    for (const wheel of this.wheels || []) {
      if (wheel.tireMaterial) wheel.tireMaterial.dispose();
      if (wheel.mud?.texture) wheel.mud.texture.dispose();
    }
  }
}
