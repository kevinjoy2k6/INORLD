/* ============================================================================
 * WorldAtlas — the shape of the country
 *
 *  One 640 m valley holding four regions that borrow straight from the style
 *  DNA: a wildflower meadow at dusk, a red-rock canyon at golden hour, a cold
 *  alpine ridge, and a coastal strip at high noon. Each region owns its ground
 *  palette, its terrain character, its fog/sky tint and its landmarks.
 *
 *  Roads are polylines: the terrain grader flattens a corridor along them, the
 *  surface classifier paints them, and Landmarks.js lines them with utility
 *  poles and signage. Watchtowers and gas stations sit on the network so the
 *  map is navigable without a minimap.
 * ========================================================================== */
/**
 * The atlas is authored in a 640 m "design space" — numbers a person can
 * reason about. The built world is 3.2x that, a 2 km square. The scale is
 * applied below in one place so the layout, its regions and its noise
 * character all stretch together: the same valley, with hills 3.2x longer
 * and settlements 3.2x further apart.
 */
export const WORLD_SCALE = 3.2;

export const WORLD = {
  size: 640 * WORLD_SCALE,
  half: 320 * WORLD_SCALE,
  waterLevel: 1.1,
};

/* ------------------------------------------------------------------ *
 *  Regions
 * ------------------------------------------------------------------ */

export const REGIONS = [
  {
    id: 'meadow',
    label: 'Wildflower Meadow',
    mood: 'late dusk',
    // Metres: a soft rectangle in the west/centre of the valley.
    bounds: { x: [-320, 40], z: [-170, 60] },
    palette: {
      // Golden autumn grassland: the reference look is a bright, saturated
      // low-poly valley, not a dusty one. Dry grass over pale earth.
      ground: 0xd2a54c,
      groundAlt: 0xe3bd63,
      accent: 0xd9b45e,
      fog: 0xd9e8f4,
      skyTint: 0xfff2d2,
      sunTint: 0xfff7e4,
      ambient: 0x64727f,
      // Under linear tone mapping this value is a straight multiplier on the
      // phase exposure, so the old 1.02 lifted the whole meadow into the haze.
      exposure: 1.0,
      bloom: 0.12,
    },
    // Rolling and soft: squash the amplitude of the base noise.
    shape(h, x, z) {
      const wave = Math.sin(x * 0.012) * Math.cos(z * 0.009) * 1.2;
      return h * 0.72 + 2.0 + wave;
    },
  },
  {
    id: 'canyon',
    label: 'Red Rock Canyon',
    mood: 'golden hour',
    bounds: { x: [40, 320], z: [-170, 120] },
    palette: {
      ground: 0xa9613a,
      groundAlt: 0xc98a58,
      accent: 0x6f3f56,
      fog: 0xd7a07a,
      skyTint: 0xffd6a5,
      sunTint: 0xffc27a,
      ambient: 0x4a3d63,
      // Neutral: the canyon is the tuned reference and must not drift when the
      // region grade became a real multiplier instead of a per-frame nudge.
      exposure: 0.95,
      bloom: 0.13,
    },
    // Terraced benches: quantise the height into 7 m steps and blend.
    shape(h, x, z, noise) {
      const stepNoise = noise(x * 0.012, z * 0.012) * 3.2;
      const stepped = Math.round((h + stepNoise) / 7) * 7;
      const mesa = 0.55 + 0.45 * Math.sin(x * 0.006) * Math.cos(z * 0.0045);
      return h * 0.45 + stepped * 0.55 + 6 * mesa;
    },
  },
  {
    id: 'alpine',
    label: 'Alpine Ridge',
    mood: 'late afternoon',
    bounds: { x: [-320, 320], z: [120, 320] },
    palette: {
      // Alpine meadow under snow: green-grey grass, cool blue haze.
      ground: 0x9fb08a,
      groundAlt: 0xe9eff4,
      accent: 0x7d8f99,
      fog: 0xd6e6f4,
      skyTint: 0x9cc9e8,
      sunTint: 0xfff4dd,
      ambient: 0x55637a,
      // Snow has no shoulder to roll off under a linear curve: a small pull on
      // exposure is what keeps the ridge faceted instead of paper white.
      exposure: 0.93,
      bloom: 0.11,
    },
    shape(h, x, z) {
      const lift = Math.pow(Math.max(0, (z - 130) / 190), 1.6) * 26;
      return h + lift;
    },
  },
  {
    id: 'coast',
    label: 'Coastal Flats',
    mood: 'high noon',
    bounds: { x: [-320, 320], z: [-320, -170] },
    palette: {
      // Pale gold beach sand against bright water — the lake shore of the
      // reference frame rather than a bleached desert.
      ground: 0xdcc07c,
      groundAlt: 0xe9d69a,
      accent: 0x2f9fb4,
      fog: 0xd8eaf6,
      skyTint: 0x7fc5ee,
      sunTint: 0xfff7e6,
      ambient: 0x5a6878,
      exposure: 1.0,
      bloom: 0.1,
    },
    // Beach falls away to the sea; the water plane does the rest.
    shape(h, x, z) {
      const shore = 1 - Math.min(1, Math.max(0, (z + 320) / 150));
      const drop = Math.min(1, Math.max(0, (-170 - z) / 90));
      return h * (1 - shore * 0.55) + (1 - drop) * 2.4 - drop * 5.4;
    },
  },
];

/** Region containing a world position (first match, else the meadow). */
export function regionAt(x, z) {
  for (const region of REGIONS) {
    const [x0, x1] = region.bounds.x;
    const [z0, z1] = region.bounds.z;
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return region;
  }
  return REGIONS[0];
}

/* ------------------------------------------------------------------ *
 *  Roads and trails
 *
 *  `width` is the drivable half-width in metres. `kind` decides the surface:
 *  roads are graded hardpack, trails stay loose.
 * ------------------------------------------------------------------ */

export const ROADS = [
  {
    id: 'highway',
    name: 'Valley Highway',
    kind: 'road',
    width: 6.5,
    points: [
      [-30, -292], [-36, -238], [-48, -196], [-58, -150], [-52, -104],
      [-38, -60], [-18, -22], [4, 18], [20, 62], [26, 108], [18, 152],
      [4, 196], [-8, 244], [-14, 292],
    ],
  },
  {
    id: 'canyon',
    name: 'Mesa Canyon Road',
    kind: 'road',
    width: 5.5,
    points: [
      [4, 18], [58, 6], [112, 22], [154, 66], [176, 118], [214, 148],
      [262, 128], [292, 82], [286, 30], [244, -6], [186, -30], [128, -20],
      [74, 2], [4, 18],
    ],
  },
  {
    id: 'coast',
    name: 'Shoreline Road',
    kind: 'road',
    width: 5,
    points: [
      [-58, -150], [-104, -196], [-150, -236], [-120, -268], [-40, -282],
      [44, -276], [118, -252], [176, -220], [232, -196], [286, -206],
    ],
  },
  {
    id: 'ridge',
    name: 'Ridge Pass',
    kind: 'trail',
    width: 3.6,
    points: [
      [26, 108], [62, 128], [96, 156], [112, 196], [96, 236], [58, 258],
      [16, 246], [-14, 212], [-24, 172], [4, 140], [26, 108],
    ],
  },
  {
    id: 'meadow-trail',
    name: 'Meadow Track',
    kind: 'trail',
    width: 3.2,
    points: [
      [-52, -104], [-104, -92], [-152, -70], [-196, -34], [-232, 12],
      [-240, 60], [-206, 96], [-160, 104], [-116, 84], [-84, 40], [-62, -12],
      [-52, -104],
    ],
  },
  {
    id: 'wash',
    name: 'Dry Wash',
    kind: 'trail',
    width: 3,
    points: [
      [154, 66], [172, 40], [206, 8], [250, -18], [292, -44], [306, -86],
    ],
  },

  /* ---- the unmarked three ------------------------------------------
   * No signs, no fuel, no waypoints: these are the tracks a local knows.
   * They are narrow, they switchback hard, and they run the long way
   * round. Losing one costs you a climb, not a respawn.
   * ---------------------------------------------------------------- */
  {
    id: 'quarry-switchbacks',
    name: 'Quarry Switchbacks',
    kind: 'trail',
    width: 2.9,
    points: [
      [-268, -150], [-232, -128], [-268, -96], [-228, -64], [-266, -30],
      [-226, 2], [-262, 34], [-224, 66], [-258, 100], [-214, 120],
      [-176, 100], [-152, 64], [-160, 24], [-140, -16], [-116, -52],
      [-132, -96], [-108, -134], [-64, -150], [-24, -128],
    ],
  },
  {
    id: 'ridge-traverse',
    name: 'High Traverse',
    kind: 'trail',
    // A circuit on the meadow's rolling north shoulder. The old line climbed the
    // peak's flank, then crossed the canyon's 7 m benches, and had to link to a
    // road it could not reach at a climbable grade; a loop needs no link, has no
    // dead end, and stays off the terraces.
    width: 3.1,
    points: [
      [-300, 40], [-262, 92], [-218, 120], [-170, 108], [-138, 68],
      [-178, 28], [-248, 16], [-300, 40],
    ],
  },
];

/** Longest stretch used for grading quality checks. */
export function roadLength(road) {
  let total = 0;
  for (let i = 1; i < road.points.length; i += 1) {
    total += Math.hypot(
      road.points[i][0] - road.points[i - 1][0],
      road.points[i][1] - road.points[i - 1][1],
    );
  }
  return total;
}

/* ------------------------------------------------------------------ *
 *  Landmarks
 * ------------------------------------------------------------------ */

export const WATCHTOWERS = [
  { id: 'tower-meadow', name: 'Meadow Fire Tower', x: -186, z: 78, region: 'meadow' },
  { id: 'tower-west', name: 'West Spur Lookout', x: -268, z: 6, region: 'meadow' },
  { id: 'tower-canyon', name: 'Mesa Rim Tower', x: 196, z: 104, region: 'canyon' },
  { id: 'tower-basin', name: 'Canyon Basin Watch', x: 96, z: -44, region: 'canyon' },
  { id: 'tower-ridge', name: 'Ridge Pass Tower', x: 104, z: 214, region: 'alpine' },
  { id: 'tower-coast', name: 'Shoreline Beacon', x: -134, z: -238, region: 'coast' },
];

export const GAS_STATIONS = [
  { id: 'fuel-meadow', name: 'Meadow Sidings', x: -60, z: -98, region: 'meadow', heading: 0.4 },
  { id: 'fuel-canyon', name: 'Canyon Junction', x: 118, z: 26, region: 'canyon', heading: -0.8 },
  { id: 'fuel-coast', name: 'Shoreline Fuel', x: 36, z: -272, region: 'coast', heading: 0.1 },
  { id: 'fuel-ridge', name: 'Ridge Pass Depot', x: 12, z: 150, region: 'alpine', heading: 2.1 },
];

/** Trailhead signs: a label, a position, and the road it belongs to. */
export const SIGNS = [
  { text: 'VALLEY HIGHWAY', x: -34, z: -240 },
  { text: 'MESA CANYON RD', x: 60, z: 8 },
  { text: 'SHORELINE RD', x: -104, z: -198 },
  { text: 'RIDGE PASS', x: 28, z: 112 },
  { text: 'MEADOW TRACK', x: -152, z: -72 },
];


/* ================================================================== *
 *  Scale the atlas up to the built world
 *
 *  Everything above is authored in a 640 m design space — numbers a
 *  person can reason about. The world is 3.2x that, a 2 km square, and
 *  the stretch is applied here in one place rather than by rewriting
 *  every literal: the regions, their shape functions, every road and
 *  trail, and every landmark move together. Hills keep their authored
 *  amplitude but spread over 3.2x the ground, which is what turns the
 *  old 640 m valley into long, gentle 2 km slopes.
 * ================================================================== */
for (const region of REGIONS) {
  region.bounds = {
    x: [region.bounds.x[0] * WORLD_SCALE, region.bounds.x[1] * WORLD_SCALE],
    z: [region.bounds.z[0] * WORLD_SCALE, region.bounds.z[1] * WORLD_SCALE],
  };
  // Shape functions think in design metres, so hand them design metres.
  const shape = region.shape;
  region.shape = (h, x, z, noise) => shape(h, x / WORLD_SCALE, z / WORLD_SCALE, noise);
}

for (const road of ROADS) {
  road.points = road.points.map(([x, z]) => [x * WORLD_SCALE, z * WORLD_SCALE]);
  // Graded roads widen with the world; trails stay narrow, because the
  // challenge is the line you pick through them.
  // Narrower than they were: at 1.45× a graded road painted a 19 m band of
  // bare earth through the meadow, which reads as a construction site. A
  // two-track carriageway leaves grass on both shoulders.
  road.width = road.kind === 'road' ? road.width * 1.0 : road.width * 0.9;
}

for (const list of [WATCHTOWERS, GAS_STATIONS, SIGNS]) {
  for (const item of list) {
    item.x *= WORLD_SCALE;
    item.z *= WORLD_SCALE;
  }
}
