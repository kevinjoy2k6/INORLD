import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { QualityManager, detectQualityTier } from './QualityManager.js';
import { OffroadVehicle, PHYS_GROUPS } from './OffroadVehicle.js';
import { TrailerRig } from './TrailerRig.js';
import { CameraController, CAMERA_MODE_LABEL, FOCUS_LABEL } from './CameraController.js';
import { TerrainSystem } from './TerrainSystem.js';
import { RutSystem } from './MudRutShader.js';
import { NetworkManager, vehicleSnapshot, normaliseRoomCode } from './NetworkManager.js';
import { WinchSystem } from './WinchSystem.js';
import { MissionManager } from './MissionManager.js';
import { UIManager } from './UIManager.js';
import { AtmosphereAndPostFX } from './AtmosphereAndPostFX.js';
import { TactileVFX } from './TactileVFX.js';
import { VehicleAudioController } from './audio/VehicleAudioController.js';
import { PerformanceOptimizer, loadStoredSettings, PRESET_ORDER } from './PerformanceOptimizer.js';
import { GraphicsSettingsUI } from './GraphicsSettingsUI.js';
import { ExpeditionHUD } from './ExpeditionHUD.js';
import { ACCESSORIES, ACCESSORY_ORDER, PAINT_COLORS, PAINT_ORDER } from './VehicleMeshBuilder.js';
import { Landmarks } from './Landmarks.js';
import { PointsOfInterest } from './PointsOfInterest.js';
import { MesaField } from './MesaField.js';
import { StyleDNA } from './StyleDNA.js';
import { WaterSystem } from './WaterSystem.js';
import { StyleOverhaul, applyStylePalette } from './StyleOverhaul.js';
import { OverlandStyle } from './OverlandStyle.js';
import { regionAt } from './WorldAtlas.js';
import {


  createProvingProps,
  createProvingBench,
  createProvingHud,
  auditProvingGround,
  PROVING_GROUND,
} from './ProvingGround.js';
/* ---- display refresh probe -----------------------------------------
 * A game cannot be smoother than the panel under it, and every budget in
 * here is derived from the refresh rate rather than assumed to be 60. Empty
 * animation frames measure the panel itself; 24 of them cost a fifth of a
 * second at 120 Hz and two fifths at 60, while the boot screen is already on
 * screen. Measuring the game's own frames instead would read a struggling
 * machine as a 60 Hz one and give up on 120 before trying.
 * ------------------------------------------------------------------ */
const KNOWN_REFRESH = [60, 75, 90, 100, 120, 144, 165, 240];

async function probeRefreshRate() {
  const deltas = [];
  const collected = new Promise((resolve) => {
    let last = 0;
    let ticks = 0;
    const tick = (stamp) => {
      if (last) deltas.push(stamp - last);
      last = stamp;
      ticks += 1;
      if (ticks >= 24) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // A hidden or backgrounded tab throttles animation frames to about 1 Hz, and
  // the probe must never hold the boot screen hostage while it waits for them.
  // With fewer than six samples the answer is "assume 60" either way.
  await Promise.race([collected, new Promise((resolve) => setTimeout(resolve, 800))]);
  if (deltas.length < 6) return { hz: 60, measured: 60, median: 16.7 };
  const sorted = deltas.slice(4).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 16.7;
  const measured = 1000 / median;
  let hz = 60;
  let best = Infinity;
  for (const candidate of KNOWN_REFRESH) {
    const delta = Math.abs(candidate - measured);
    if (delta < best) {
      best = delta;
      hz = candidate;
    }
  }
  // Only trust the snap to a known rate when it is close; otherwise keep the
  // measurement, floored at 60: a browser that throttled the probe (background
  // tab, virtual display, a slow first paint) must not turn into a 30 fps
  // target. `?hz=` exists for panels and virtual displays that lie.
  if (best / hz > 0.08) hz = Math.max(60, Math.round(measured));
  try {
    const forced = Number(new URLSearchParams(window.location.search).get('hz'));
    if (Number.isFinite(forced) && forced >= 60) hz = forced;
  } catch {
    /* no query string, no override */
  }
  return { hz, measured: Math.round(measured), median: Math.round(median * 100) / 100 };
}

const display = await probeRefreshRate();
window.__display = display;

/* ---- boot watchdog -------------------------------------------------
 * Records how long the world took to build and, more importantly, how
 * long the main thread was ever blocked. Terrain generation is sliced, so
 * the second number should stay small even though the first is not.
 * ------------------------------------------------------------------ */
const bootWatch = { start: performance.now(), buildMs: 0, marks: [], longTasks: [] };
const bootMark = (label) => bootWatch.marks.push([label, Math.round(performance.now() - bootWatch.start)]);
window.__boot = bootWatch;
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      bootWatch.longTasks.push({
        ms: Math.round(entry.duration),
        at: Math.round(entry.startTime - bootWatch.start),
      });
    }
  }).observe({ entryTypes: ['longtask'] });
} catch {
  // longtask observer is not available everywhere; the build time still is.
}


/* ================================================================== *
 *  DOM + error plumbing
 * ================================================================== */

const app = document.getElementById('app');
const boot = document.getElementById('boot');
const bootSub = boot.querySelector('.sub');
const bootTrack = boot.querySelector('.boot-track');
const bootFill = boot.querySelector('.boot-fill');
const bootDetail = boot.querySelector('.boot-detail');
const bootTip = document.getElementById('boot-tip');
window.__gameReady = false;

/* The render cap is a pixel budget, not just a ratio, but it can only be
 * applied once the governor exists. */
let renderBudgetReady = false;

/* Four short tips beat a spinner that says nothing. */
const BOOT_TIPS = [
  'W A S D or the arrow keys to drive · SPACE for the handbrake',
  'F drops the winch · H fires the SOS beacon',
  'R resets the truck if you end up on the roof',
  'B camps at a fire to refuel · C changes the camera',
];
let bootTipIndex = 0;
function cycleBootTip() {
  if (!bootTip) return;
  bootTip.textContent = BOOT_TIPS[bootTipIndex % BOOT_TIPS.length];
  bootTipIndex += 1;
}
cycleBootTip();
const bootTipTimer = setInterval(cycleBootTip, 2600);

function setBootProgress(fraction, label) {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  if (bootSub) bootSub.textContent = `LOADING ${percent}% — ${label}`;
  if (bootFill) bootFill.style.transform = `scaleX(${percent / 100})`;
  if (bootTrack) bootTrack.setAttribute('aria-valuenow', String(percent));
}
setBootProgress(0.02, 'INITIALISING HIGH-RESOLUTION RENDERING');

// The surveyed proving ground is opt-in: ?test in the URL, #test in the hash
// (some static hosts rewrite the query), or INORLD_TEST=1 in localStorage for
// a browser that cannot keep either.
function detectTestMode() {
  try {
    if (new URLSearchParams(window.location.search).has('test')) return true;
    const hash = window.location.hash.replace(/^#/, '');
    if (hash.split('&').includes('test')) return true;
    return window.localStorage.getItem('INORLD_TEST') === '1';
  } catch (error) {
    return false;
  }
}

const TEST_MODE = detectTestMode();

function showFatal(message, detail) {
  const overlay = document.getElementById('fatal');
  document.getElementById('fatal-message').textContent = message;
  document.getElementById('fatal-detail').textContent = detail || '';
  overlay.classList.add('show');
  boot.classList.add('done');
  boot.setAttribute('aria-hidden', 'true');
}

window.addEventListener('error', (event) => {
  // Keep the stack reachable for the console: the overlay only has room for a
  // line, and a one-line message is rarely enough to find the fault.
  window.__fatal = { message: event.message || String(event.error || event), stack: event.error?.stack || null };
  showFatal('An unexpected error stopped the game.', event.message || String(event.error || event));
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  showFatal('An unexpected error stopped the game.', reason && reason.stack ? reason.stack : String(reason));
});

/* ================================================================== *
 *  Renderer, camera, scene
 * ================================================================== */

const initialTier = detectQualityTier();

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    // Native resolution is the floor on every tier; keep MSAA on the direct
    // rendering path too instead of making LOW synonymous with jagged edges.
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
} catch (error) {
  showFatal('WebGL is not available in this browser.', String(error));
  throw error;
}

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// The palette is authored in display space; see OverlandStyle for why linear.
renderer.toneMapping = THREE.LinearToneMapping;
renderer.shadowMap.enabled = true;
// The shadow map is a second submission of every caster in the scene, and the
// sun follows the truck, so it only needs refreshing at a twentieth of a
// second. The render loop asks for an update on that cadence instead.
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
app.appendChild(renderer.domElement);

// A lost GPU context used to freeze the canvas with no explanation - on mobile
// the tab is usually reclaimed rather than crashed. Say what happened instead
// of showing a still image of the last frame forever; settings are persisted, so
// a reload is always safe.
renderer.domElement.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  window.__contextLost = true;
  showFatal(
    'The graphics context was lost.',
    'The GPU reset or the tab was reclaimed. Reload the page to continue — your settings and preset are saved.',
  );
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  window.__contextLost = false;
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa8bccd);
scene.fog = new THREE.Fog(0xa8bccd, 40, 260);

// Far plane has to reach across a 2 km map, or the far ridge clips away.
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 3200);
camera.position.set(0, 6, -16);

const quality = new QualityManager(renderer, scene, initialTier);

// Say what the game detected, so a weak GPU is never a mystery.
if (bootDetail) {
  bootDetail.textContent =
    `${quality.tier} TIER · ${window.innerWidth}×${window.innerHeight} · ` +
    `${(window.devicePixelRatio || 1).toFixed(1)}× DPR`;
}
scene.fog.near = quality.settings.fogNear;
scene.fog.far = quality.settings.fogFar;

/* ================================================================== *
 *  Sky dome
 * ================================================================== */

const skyUniforms = {
  topColor: { value: new THREE.Color(0x3f79b0).convertSRGBToLinear() },
  horizonColor: { value: new THREE.Color(0xc9d8e2).convertSRGBToLinear() },
  sunColor: { value: new THREE.Color(0xffe6b8).convertSRGBToLinear() },
  sunDirection: { value: new THREE.Vector3(0.55, 0.55, 0.4).normalize() },
};

const skyMaterial = new THREE.ShaderMaterial({
  uniforms: skyUniforms,
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  vertexShader: /* glsl */ `
    varying vec3 vWorldDirection;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorldDirection = normalize(world.xyz - cameraPosition);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 topColor;
    uniform vec3 horizonColor;
    uniform vec3 sunColor;
    uniform vec3 sunDirection;
    varying vec3 vWorldDirection;

    void main() {
      vec3 dir = normalize(vWorldDirection);
      float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
      float t = pow(clamp((h - 0.42) / 0.58, 0.0, 1.0), 0.85);
      vec3 color = mix(horizonColor, topColor, t);

      float sun = max(dot(dir, normalize(sunDirection)), 0.0);
      color += sunColor * pow(sun, 220.0) * 1.4;
      color += sunColor * pow(sun, 8.0) * 0.16;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
});

const sky = new THREE.Mesh(new THREE.SphereGeometry(600, quality.settings.skySegments, 20), skyMaterial);
sky.frustumCulled = false;
sky.renderOrder = -1;
scene.add(sky);

/* ================================================================== *
 *  Lighting
 * ================================================================== */

const hemisphere = new THREE.HemisphereLight(0xbfd6ea, 0x6b5a44, 1.0);
scene.add(hemisphere);

const sun = new THREE.DirectionalLight(0xfff1d6, 2.5);
sun.position.set(60, 92, 40);
sun.castShadow = true;
sun.shadow.camera.left = -48;
sun.shadow.camera.right = 48;
sun.shadow.camera.top = 48;
sun.shadow.camera.bottom = -48;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 280;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.035;
scene.add(sun);
scene.add(sun.target);

quality.registerShadowLight(sun);

/* ================================================================== *
 *  Physics world
 * ================================================================== */

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;
world.solver.iterations = quality.settings.solverIterations;
world.defaultContactMaterial.friction = 0.4;
world.defaultContactMaterial.restitution = 0.0;

const groundMaterial = new CANNON.Material('ground');
world.addContactMaterial(
  new CANNON.ContactMaterial(groundMaterial, groundMaterial, { friction: 0.4, restitution: 0.0 }),
);

/* ================================================================== *
 *  Terrain
 * ================================================================== */

// The palette is baked into terrain vertex colours at build time, so it has
// to be applied before the terrain exists.
applyStylePalette();

const terrain = new TerrainSystem({
  scene,
  world,
  groundMaterial,
  seed: 20261113,
  testMode: TEST_MODE,
});

// Generating 2 km of terrain is tens of millions of samples. It is built in
// slices that hand the main thread back every few milliseconds, so the boot
// screen keeps animating and the tab never locks up; the await here only
// delays the systems below, which all need a finished world.
await terrain.build((fraction, label) => {
  setBootProgress(0.05 + fraction * 0.55, label);
});
bootWatch.buildMs = Math.round(performance.now() - bootWatch.start);
bootMark('terrain');
setBootProgress(0.62, 'ASSEMBLING VEHICLE & EXPEDITION');

// Surveyed test range: flat pad, washboard, whoops, articulation ramps, side
// slope, hill climb, mud pit, sand and an obstacle lane.
if (TEST_MODE) {
  createProvingProps({ scene, world, terrain, groundMaterial });
  const survey = auditProvingGround(terrain);
  console.table(survey);
  window.__provingSurvey = survey;
}

// Poles, centre lines, junction signs and gas stations: the human layer.
const landmarks = new Landmarks({ scene, terrain, groundMaterial });

// Tyre ruts: a render-target stamp map on HIGH/MEDIUM, decal ribbons on LOW.
const rutSystem = new RutSystem({
  renderer,
  scene,
  terrain,
  quality,
  groundMask: PHYS_GROUPS.GROUND,
});

/* ================================================================== *
 *  Vehicle
 * ================================================================== */

const vehicle = new OffroadVehicle({
  world,
  scene,
  spawn: terrain.spawn.position,
  heading: terrain.spawn.heading,
  paint: PAINT_COLORS.yellow.hex,
  groundMaterial,
  surfaceProvider: (x, z) => terrain.getSurfaceAt(x, z),
  localPlayerId: 'player-1',
});

// Parked just behind the spawn so the drawbar is already within reach of the
// hitch — reverse a little and press T.
// Parked behind and off to one side so it does not sit in the camera's line.
const trailerSpawn = new THREE.Vector3(
  terrain.spawn.position.x
    - Math.sin(terrain.spawn.heading) * 6.0
    + Math.cos(terrain.spawn.heading) * 6.5,
  0,
  terrain.spawn.position.z
    - Math.cos(terrain.spawn.heading) * 6.0
    - Math.sin(terrain.spawn.heading) * 6.5,
);
trailerSpawn.y = terrain.getHeightAt(trailerSpawn.x, trailerSpawn.z) + 1.3;

const trailer = new TrailerRig({
  world,
  scene,
  vehicle,
  spawn: trailerSpawn,
  heading: terrain.spawn.heading,
  groundMaterial,
});

rutSystem.attachVehicle(vehicle);

/* ================================================================== *
 *  Co-op: network, winch, missions
 * ================================================================== */

const networkManager = new NetworkManager({
  worldSeed: 20261113,
  terrain,
  vehicle,
  trailer,
  scene,
  world,
  rutSystem,
  winchSystem: null, // wired after winchSystem is created
  missionManager: null, // wired after missionManager is created
});
networkManager.onToaster = toast;
// A failed co-op connection is not a fatal game error. A strict NAT, a wrong
// room code or a peer dropping must never end the solo drive the player is
// already in, so this reports it, tears the dead session down and hands the
// lobby back. Genuine engine faults still go through showFatal().
networkManager.onFatal = (message) => handleCoopFailure(message);

const winchSystem = new WinchSystem({
  vehicle,
  scene,
  world,
  groundMaterial,
  terrain,
  networkManager,
});
winchSystem.setToaster(toast);

// Help-ping convenience on the vehicle.
vehicle.toggleHelpPing = () => { vehicle.helpPingActive = !vehicle.helpPingActive; return vehicle.helpPingActive; };
vehicle.helpPingActive = false;

/* ================================================================== *
 *  3D rescue beacon — a floating marker over your truck while the help ping
 *  is active. Teammates get the same marker over your truck (NetworkManager
 *  builds one per remote player from the help flag in each state tick).
 * ================================================================== */

const rescueBeacon = new THREE.Group();
{
  const beaconMat = new THREE.MeshBasicMaterial({
    color: 0xffb648,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const beam = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.4, 14, 1, true), beaconMat);
  beam.rotation.x = Math.PI; // apex down, like a spotlight
  beam.position.y = 0.7;

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.85, 0.06, 8, 22),
    new THREE.MeshBasicMaterial({ color: 0xffb648, transparent: true, opacity: 0.85, depthWrite: false }),
  );
  ring.rotation.x = Math.PI / 2;

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xff8b3d }),
  );
  core.position.y = 1.5;

  rescueBeacon.add(beam, ring, core);
  rescueBeacon.visible = false;
  scene.add(rescueBeacon);
}

const missionManager = new MissionManager({
  terrain,
  vehicle,
  trailer,
  scene,
  world,
  groundMaterial,
  networkManager,
});
missionManager.setup();
missionManager.setToaster(toast);

// Stone keeps on the watchtower sites, a gatehouse at the river approach, cairns
// along every trail and three ruin fields. Built after the mission zones exist
// because it wraps their abstracts in architecture.
const pointsOfInterest = new PointsOfInterest({ scene, terrain, missionManager });
window.__poi = pointsOfInterest;

// The red-rock country itself: terraced buttes, palm oases on the river and
// scrub on the flats. Scenery only — the heightfield and its physics are
// untouched, so every trail still grades and every ford still crosses.
const mesaField = new MesaField({
  scene,
  terrain,
  world,
  // Rock is placed across the whole map now, so it has to go around the mill
  // and the bridge instead of only being kept out of the canyon basin.
  keepOut: [missionManager.millZone?.pos, missionManager.bridgeZone?.pos]
    .filter(Boolean)
    .map((pos) => ({ x: pos.x, z: pos.z, r: 70 })),
});
window.__mesa = mesaField;
setBootProgress(0.74, 'FINISHING FORESTS & LANDMARKS');

// Wire the cross-references so state-change notifications flow.
networkManager.winchSystem = winchSystem;
networkManager.missionManager = missionManager;

/* ================================================================== *
 *  Camera
 * ================================================================== */

const cameraController = new CameraController(camera, {
  vehicle,
  trailer,
  world,
  groundMask: PHYS_GROUPS.GROUND,
});

/* ================================================================== *
 *  Input
 * ================================================================== */

const keys = new Set();
const held = {
  throttle: false,
  brake: false,
  left: false,
  right: false,
  // Phase 8 analog channels written by the touch cockpit.
  throttleAxis: 0,
  brakeAxis: 0,
  steerAxis: 0,
};

/**
 * Drop every held input.
 *
 * Alt-tabbing with W down never delivers a keyup: the truck would be found
 * halfway across the map, still at full throttle, when the player comes back.
 */
function releaseHeldInputs() {
  keys.clear();
  held.throttle = false;
  held.brake = false;
  held.left = false;
  held.right = false;
  held.throttleAxis = 0;
  held.brakeAxis = 0;
  held.steerAxis = 0;
}
window.addEventListener('blur', releaseHeldInputs);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseHeldInputs();
});

// Phase 6 UI is constructed here, after the camera controller and the shared
// held-input object exist. Building it earlier would read `cameraController`
// before its declaration and throw.
const ui = new UIManager({
  vehicle,
  trailer,
  winchSystem,
  missionManager,
  networkManager,
  cameraController,
  quality,
  held,
});
ui.setNetworkCallbacks();
setBootProgress(0.78, 'PREPARING CONTROLS');

const toastElement = document.getElementById('toast');
let toastTimer = 0;
function toast(text) {
  toastElement.textContent = text;
  toastElement.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastElement.classList.remove('show'), 1400);
}

/* ================================================================== *
 *  Phase 7 — atmosphere/post-FX, tactile mechanical detail, audio
 * ================================================================== */

const atmosphere = new AtmosphereAndPostFX({
  renderer,
  scene,
  camera,
  sun,
  hemisphere,
  skyDome: sky,
  quality,
  vehicle,
  trailer,
  terrain,
  networkManager,
  missionManager,
});
atmosphere.setQuality(quality.settings);
// Pull the haze back so the painterly regions stay readable at distance.
atmosphere.fogScale = 0.34;

// Style DNA: toon hard surfaces, ink the hero truck, painted cumulus, region
// grading. The truck is cel-shaded once its material set is final.
const styleDNA = new StyleDNA({ scene, camera, atmosphere, vehicle, quality });
const toonMaterials = styleDNA.celShadeVehicle()
  + styleDNA.celShadeProps([landmarks.group, missionManager.group]);

// Mirror water with a depth-shaded shore, modelled on Tidelight Harbor.
const waterSystem = new WaterSystem({ scene, terrain, atmosphere, quality });
waterSystem.setQuality(quality.tier || 'HIGH');
const overlandStyle = new OverlandStyle({
  scene,
  renderer,
  atmosphere,
  onToast: (message) => toast(message),
});

const styleOverhaul = new StyleOverhaul({
  scene,
  atmosphere,
  renderer,
  terrain,
  vehicle,
  water: waterSystem,
  styleDNA,
});

const tactile = new TactileVFX({ scene, vehicle, trailer, terrain, quality });

// Test-range instrumentation: samples the real physics while you drive.
const provingBench = TEST_MODE ? createProvingBench({ vehicle, terrain }) : null;
const provingHud = TEST_MODE ? createProvingHud({ bench: provingBench, vehicle }) : null;

// Layered vehicle audio: engine, exhaust, drivetrain, tyres, suspension,
// collisions, interior mix and the valley around them. Each layer is its own
// module; this controller is the only place they are wired to the physics.
const audio = new VehicleAudioController({
  vehicle,
  terrain,
  camera,
  atmosphere,
  winchSystem,
});

setBootProgress(0.84, 'CONFIGURING THE RENDER PIPELINE');

// Exposed for the audio lab, the perf probes and console tuning.
window.__game = { audio, vehicle, cameraController, terrain, atmosphere, renderer, scene, camera, quality, world };

// ?audiolab runs the scripted test drive once the mixer is unlocked.
const audioLabEnabled = new URLSearchParams(window.location.search).has('audiolab');
let audioLab = null;
function tickAudioLab(dt) {
  if (!audioLabEnabled) return;
  if (!audioLab) {
    if (!audio.ready) return;
    import('./audio/AudioLab.js')
      .then(({ AudioLab }) => {
        audioLab = new AudioLab({ audio, vehicle, cameraController, terrain });
        window.__audioLab = audioLab;
        try {
          audioLab.start();
        } catch (error) {
          audio.reportFault('audioLab.start', error);
        }
      })
      .catch((error) => audio.reportFault('audioLab', error));
    return;
  }
  // The lab drives the same audio graph, so it gets the same treatment: a
  // broken measurement must not end the drive.
  try {
    audioLab.update(dt);
  } catch (error) {
    audio.reportFault('audioLab.update', error);
  }
}

quality.onChange(() => atmosphere.setQuality(quality.settings));

// Scenic campfire outposts beside each watchtower: park together, patch the
// truck up and skip the clock forward.
for (const [index, tower] of (missionManager.watchtowers || []).entries()) {
  const p = tower.pos || tower.position || tower.base;
  if (!p || typeof p.x !== 'number') continue;
  const cx = p.x + 6.5;
  const cz = p.z + 4.5;
  atmosphere.addCampfire(
    new THREE.Vector3(cx, terrain.getHeightAt(cx, cz), cz),
    `CAMP ${index + 1}`,
  );
}

// Joiners follow the host's clock; the host broadcasts it every few seconds.
networkManager.onTimeSync = (payload) => atmosphere.applyTimeSync(payload);
let timeSyncTimer = 0;

// Shift events feed the drivetrain clunk and the soot puff.
const originalShiftUp = vehicle.shiftUp.bind(vehicle);
const originalShiftDown = vehicle.shiftDown.bind(vehicle);
vehicle.shiftUp = () => {
  const result = originalShiftUp();
  audio.clunk(0.9);
  tactile.onGearShift();
  return result;
};
vehicle.shiftDown = () => {
  const result = originalShiftDown();
  audio.clunk(0.9);
  tactile.onGearShift();
  return result;
};

/* ================================================================== *
 *  Phase 8 — performance governor, settings drawer, expedition HUD
 * ================================================================== */

const optimizer = new PerformanceOptimizer({
  renderer,
  scene,
  camera,
  sun,
  world,
  vehicle,
  trailer,
  terrain,
  rutSystem,
  tactile,
  atmosphere,
  audio,
  cameraController,
  settings: loadStoredSettings(),
});

// Far-away props stop drawing rather than costing a draw call each frame.
optimizer.registerCullable(rescueBeacon, { margin: 0 });
optimizer.registerCullable(trailer.group, { margin: 40 });
for (const fire of atmosphere.campfires) optimizer.registerCullable(fire.group, { margin: 40 });

// ?preset=HIGH forces a preset for this session only. Handy on a borrowed
// machine, and it never overwrites what the player saved.
const forcedPreset = (new URLSearchParams(window.location.search).get('preset') || '').toUpperCase();
if (forcedPreset && PRESET_ORDER.includes(forcedPreset)) {
  optimizer.applySettings({ preset: forcedPreset }, { persist: false, markCustom: false });
}

const settingsUI = new GraphicsSettingsUI({
  optimizer,
  atmosphere,
  audio,
});

const expeditionHUD = new ExpeditionHUD({
  optimizer,
  vehicle,
  trailer,
  winchSystem,
  missionManager,
  networkManager,
  cameraController,
  atmosphere,
  audio,
  held,
  toast,
  settingsUI,
});

setBootProgress(0.9, 'PREPARING HIGH-RESOLUTION TARGETS');

// Keep the HUD in step with the photo-mode class the atmosphere sets.
const lobbyElement = document.getElementById('lobby');

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// Expose a smoothed FPS for the HUD's per-frame read.
let fpsSmoothed = 60;
function exposeFpsSmoothed(v) { fpsSmoothed = v; }
window.__fpsSmoothed = fpsSmoothed;


const PREVENTED_KEYS = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
]);

window.addEventListener('keydown', (event) => {
  // Never drive with the keys somebody is typing with. The room-code field and
  // the settings' numeric inputs are form controls: WASD and the arrows inside
  // them must edit text, not the truck, and Space must insert a space.
  const typingIn = event.target;
  if (
    typingIn instanceof HTMLElement
    && (typingIn.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(typingIn.tagName))
  ) {
    return;
  }
  if (PREVENTED_KEYS.has(event.code)) event.preventDefault();
  if (event.repeat) return;
  keys.add(event.code);

  switch (event.code) {
    case 'BracketRight':
      vehicle.shiftUp();
      toast(`GEAR ${vehicle.getTelemetry().gear}`);
      break;
    case 'BracketLeft':
      vehicle.shiftDown();
      toast(`GEAR ${vehicle.getTelemetry().gear}`);
      break;
    case 'KeyB': {
      // Phase-7: make camp at the nearest fire — repair, refuel, skip time.
      const camp = atmosphere.restAtNearestCampfire(vehicle, 14);
      toast(camp.ok ? `CAMPED — ${camp.phase}` : 'NO CAMPSITE NEARBY');
      break;
    }
    case 'KeyY':
      overlandStyle.next();
      break;
    case 'KeyN':
      toast(vehicle.toggleAWD() ? '4WD ENGAGED' : '2WD — REAR DRIVE');
      break;
    case 'KeyG':
      toast(vehicle.toggleDiffLock() ? 'DIFF LOCK ON' : 'DIFF LOCK OFF');
      break;
    case 'KeyZ':
      vehicle.adjustPSI(2);
      toast(`TYRES ${vehicle.psi.toFixed(1)} PSI`);
      break;
    case 'KeyX':
      vehicle.adjustPSI(-2);
      toast(`TYRES ${vehicle.psi.toFixed(1)} PSI`);
      break;
    case 'KeyR':
      trailer.unhitch();
      vehicle.reset();
      toast('VEHICLE RESET');
      break;
    case 'KeyC':
      toast(CAMERA_MODE_LABEL[cameraController.toggleMode()]);
      break;
    case 'KeyV':
      toast(`CAMERA ${FOCUS_LABEL[cameraController.cycleFocus()]}`);
      break;
    case 'KeyK': {
      const next = optimizer.cyclePreset(1);
      toast(`PRESET ${next.preset.replace('_', ' ')}`);
      break;
    }
    case 'KeyQ':
      vehicle.shiftDown();
      toast(`GEAR ${vehicle.getTelemetry().gear}`);
      break;
    case 'ShiftLeft':
    case 'ShiftRight': {
      const range = vehicle.getTelemetry().gearId;
      const next = range === 'H' ? 'L' : range === 'L' || range === 'L-' || range === 'L+' ? 'H' : 'L';
      vehicle.setGear(next);
      toast(`RANGE ${next === 'H' ? 'HIGH' : 'LOW'}`);
      break;
    }
    case 'Escape': {
      settingsUI.toggle();
      break;
    }
    case 'Space':
      vehicle.setHandbrake(true);
      break;
    case 'KeyT': {
      const result = trailer.toggleHitch();
      toast(result.message.toUpperCase());
      break;
    }
    case 'KeyM':
      // Cargo, not lighting: `Y` is the lighting-preset cycle above, and two
      // `case 'KeyY'` labels in one switch made this branch unreachable.
      if (trailer.toggleLoad()) toast('TIMBER LOADED');
      else toast('TIMBER UNLOADED');
      break;
    case 'KeyF': { // spec: F is the winch
      if (winchSystem.activeHook) {
        winchSystem.detachWinch();
      } else {
        const result = winchSystem.tryAttachHook(null);
        if (!result.ok) toast('NO TARGET IN RANGE');
      }
      break;
    }
    case 'KeyE': { // spec: E hands 20 L to a teammate
      const result = winchSystem.tryTransferFuel();
      if (!result.ok) toast(String(result.reason || 'FUEL TRANSFER FAILED').toUpperCase());
      break;
    }
    case 'KeyH': // spec: H pings the squad for a rescue
      vehicle.toggleHelpPing();
      toast(vehicle.helpPingActive ? 'HELP PING SENT' : 'HELP PING CLEARED');
      break;
    case 'KeyL':
    case 'KeyJ': {
      // Night beams: spotlights + volumetric cones + lamp faces.
      toast(atmosphere.toggleHeadlights() ? 'BEAMS ON' : 'BEAMS OFF');
      break;
    }
    case 'KeyP': {
      // Phase-7 photo mode: free-fly camera, FOV/DOF, INORLD watermark.
      const active = atmosphere.togglePhotoMode();
      toast(active ? 'PHOTO MODE — P TO EXIT' : 'PHOTO MODE OFF');
      break;
    }
    case 'KeyO': {
      const index = PAINT_ORDER.findIndex((key) => PAINT_COLORS[key].hex === vehicle.paintHex);
      const next = PAINT_ORDER[(index + 1) % PAINT_ORDER.length];
      vehicle.setPaint(PAINT_COLORS[next].hex);
      toast(PAINT_COLORS[next].label.toUpperCase());
      break;
    }
    case 'KeyU': { // legacy alias for the winch
      if (winchSystem.activeHook) winchSystem.detachWinch();
      else winchSystem.tryAttachHook(null);
      break;
    }
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
    case 'Digit4':
    case 'Digit5': {
      const id = ACCESSORY_ORDER[Number(event.code.slice(-1)) - 1];
      fitAccessory(id);
      break;
    }
    default:
      break;
  }
});

window.addEventListener('keyup', (event) => {
  keys.delete(event.code);
  if (event.code === 'Space') vehicle.setHandbrake(false);
});

window.addEventListener('blur', () => {
  keys.clear();
  vehicle.setThrottle(0);
  vehicle.setBrake(0);
  vehicle.setSteer(0);
  vehicle.setHandbrake(false);
});

/* ---- touch buttons ---- */

for (const button of document.querySelectorAll('[data-hold]')) {
  const action = button.dataset.hold;

  const press = (event) => {
    event.preventDefault();
    button.classList.add('active');
    if (action === 'throttle') held.throttle = true;
    if (action === 'brake') held.brake = true;
    if (action === 'steer-left') held.left = true;
    if (action === 'steer-right') held.right = true;
  };

  const release = (event) => {
    if (event) event.preventDefault();
    button.classList.remove('active');
    if (action === 'throttle') held.throttle = false;
    if (action === 'brake') held.brake = false;
    if (action === 'steer-left') held.left = false;
    if (action === 'steer-right') held.right = false;
  };

  button.addEventListener('pointerdown', press);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('pointerleave', release);
}

/* ---- action chips ---- */

function runAction(action) {
  switch (action) {
    case 'awd':
      toast(vehicle.toggleAWD() ? '4WD ENGAGED' : '2WD — REAR DRIVE');
      break;
    case 'diff':
      toast(vehicle.toggleDiffLock() ? 'DIFF LOCK ON' : 'DIFF LOCK OFF');
      break;
    case 'gear-up':
      vehicle.shiftUp();
      toast(`GEAR ${vehicle.getTelemetry().gear}`);
      break;
    case 'gear-down':
      vehicle.shiftDown();
      toast(`GEAR ${vehicle.getTelemetry().gear}`);
      break;
    case 'psi-up':
      vehicle.adjustPSI(2);
      toast(`TYRES ${vehicle.psi.toFixed(1)} PSI`);
      break;
    case 'psi-down':
      vehicle.adjustPSI(-2);
      toast(`TYRES ${vehicle.psi.toFixed(1)} PSI`);
      break;
    case 'reset':
      vehicle.reset();
      toast('VEHICLE RESET');
      break;
    case 'quality':
      toast(`QUALITY ${quality.cycle(1).label}`);
      break;
    case 'camera':
      toast(CAMERA_MODE_LABEL[cameraController.toggleMode()]);
      break;
    case 'focus':
      toast(`CAMERA ${FOCUS_LABEL[cameraController.cycleFocus()]}`);
      break;
    case 'hitch': {
      const result = trailer.toggleHitch();
      toast(result.message.toUpperCase());
      break;
    }
    case 'load':
      toast(trailer.toggleLoad() ? 'TIMBER LOADED' : 'TIMBER UNLOADED');
      break;
    case 'lights':
      toast(vehicle.setHeadlights(!vehicle.headlightsOn) ? 'LIGHTS ON' : 'LIGHTS OFF');
      break;
    case 'paint': {
      const index = PAINT_ORDER.findIndex((key) => PAINT_COLORS[key].hex === vehicle.paintHex);
      const next = PAINT_ORDER[(index + 1) % PAINT_ORDER.length];
      vehicle.setPaint(PAINT_COLORS[next].hex);
      toast(PAINT_COLORS[next].label.toUpperCase());
      break;
    }
    default:
      break;
  }
}

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => runAction(button.dataset.action));
}

function fitAccessory(id) {
  const def = ACCESSORIES[id];
  if (!def) return;
  const before = vehicle.hasAccessory(id);
  vehicle.toggleAccessory(id);
  const after = vehicle.hasAccessory(id);
  if (after === before && !after) {
    toast(`${def.label.toUpperCase()} NEEDS THE ROOF RACK`);
  } else {
    toast(after ? `${def.label.toUpperCase()} FITTED` : `${def.label.toUpperCase()} REMOVED`);
  }
}

// UIManager owns the lobby's accessory grid (#acc-grid) and binds those buttons
// itself. Binding them again here made every click toggle twice — once on, once
// off — so the truck appeared to ignore the button.
for (const button of document.querySelectorAll('[data-accessory]:not(#acc-grid [data-accessory])')) {
  button.addEventListener('click', () => fitAccessory(button.dataset.accessory));
}

/* ---- camera drag, pinch and wheel zoom ---- */

const canvas = renderer.domElement;
const pointers = new Map();
let pinchSpread = 0;

function currentSpread() {
  const values = Array.from(pointers.values());
  if (values.length < 2) return 0;
  return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
}

canvas.addEventListener('pointerdown', (event) => {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // The pointer can already be gone; capture is an optimisation, not a need.
  }
  if (pointers.size >= 2) pinchSpread = currentSpread();
});

canvas.addEventListener('pointermove', (event) => {
  const previous = pointers.get(event.pointerId);
  if (!previous) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size >= 2) {
    const spread = currentSpread();
    if (pinchSpread > 1 && spread > 1) cameraController.zoomBy(pinchSpread / spread);
    pinchSpread = spread;
    return;
  }

  cameraController.orbit(event.clientX - previous.x, event.clientY - previous.y);
});

function endPointer(event) {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinchSpread = 0;
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    cameraController.zoomBy(1 + event.deltaY * 0.0012);
  },
  { passive: false },
);

/* ================================================================== *
 *  HUD
 * ================================================================== */

const hud = {
  speed: document.getElementById('hud-speed'),
  gear: document.getElementById('hud-gear'),
  rpm: document.getElementById('hud-rpm'),
  rpmBar: document.getElementById('hud-rpm-bar'),
  fuel: document.getElementById('hud-fuel'),
  fuelBar: document.getElementById('hud-fuel-bar'),
  fuelRate: document.getElementById('hud-fuel-rate'),
  psi: document.getElementById('hud-psi'),
  sink: document.getElementById('hud-sink'),
  surface: document.getElementById('hud-surface'),
  quality: document.getElementById('hud-quality'),
  fps: document.getElementById('hud-fps'),
  physics: document.getElementById('hud-physics'),
  awd: document.getElementById('btn-awd'),
  diff: document.getElementById('btn-diff'),
  susp: Array.from(document.querySelectorAll('[data-susp]')),
  trailer: document.getElementById('hud-trailer'),
  hitch: document.getElementById('btn-hitch'),
  load: document.getElementById('btn-load'),
  lights: document.getElementById('btn-lights'),
  camera: document.getElementById('hud-camera'),
  cameraBtn: document.getElementById('btn-camera'),
  focusBtn: document.getElementById('btn-focus'),
  accessoryButtons: Array.from(document.querySelectorAll('[data-accessory]')),
};

let hudTimer = 0;
let shadowTimer = 0;
let hudRefresh = 0;

function updateHud(dt) {
  const telemetry = vehicle.getTelemetry();

  hud.speed.textContent = Math.round(telemetry.speedKmh).toString();
  hud.gear.textContent = telemetry.gear;
  hud.rpm.textContent = Math.round(telemetry.rpm).toString();
  hud.rpmBar.style.width = `${Math.round(telemetry.rpmPct * 100)}%`;
  hud.fuel.textContent = `${telemetry.fuel.toFixed(1)}/${telemetry.fuelCapacity.toFixed(0)}L`;
  hud.fuelBar.style.width = `${Math.round(telemetry.fuelPct * 100)}%`;
  hud.fuelBar.parentElement.classList.toggle('low', telemetry.fuelPct < 0.18);
  hud.fuelRate.textContent = telemetry.fuelLpm.toFixed(1);
  hud.psi.textContent = telemetry.psi.toFixed(1);
  hud.sink.textContent = telemetry.sinkCm.toFixed(1);
  hud.surface.textContent = telemetry.surface;
  hud.awd.classList.toggle('on', telemetry.awd);
  hud.diff.classList.toggle('on', telemetry.diffLock);
  hud.lights.classList.toggle('on', telemetry.headlights);

  if (hud.camera) hud.camera.textContent = cameraController.modeShort;
  if (hud.cameraBtn) hud.cameraBtn.classList.toggle('on', cameraController.mode !== 'cinematic');
  if (hud.focusBtn) hud.focusBtn.classList.toggle('on', cameraController.focus !== 'auto');

  for (const button of hud.accessoryButtons) {
    button.classList.toggle('on', !!telemetry.accessories[button.dataset.accessory]);
  }

  if (hud.trailer) hud.trailer.textContent = trailer.hitched ? 'HITCHED' : trailer.loaded ? 'FREE +LOAD' : 'FREE';
  if (hud.hitch) hud.hitch.classList.toggle('on', trailer.hitched);
  if (hud.load) hud.load.classList.toggle('on', trailer.loaded);

  for (let i = 0; i < hud.susp.length; i += 1) {
    const value = THREE.MathUtils.clamp(telemetry.suspension[i], 0, 1);
    hud.susp[i].style.height = `${Math.round(value * 100)}%`;
    hud.susp[i].classList.toggle('hot', value > 0.8);
  }

  fpsSmoothed += (1 / Math.max(dt, 1e-4) - fpsSmoothed) * 0.08;
  window.__fpsSmoothed = fpsSmoothed;
  exposeFpsSmoothed(fpsSmoothed);
  if (hud && hud.fps) hud.fps.textContent = Math.round(fpsSmoothed).toString();
}

quality.onChange((settings) => {
  scene.fog.near = settings.fogNear;
  scene.fog.far = settings.fogFar;
  world.solver.iterations = settings.solverIterations;
  terrain.setAnisotropy(settings.anisotropy);
  rutSystem.setQuality(settings);

  if (hud.quality) hud.quality.textContent = settings.label;
  if (hud.physics) hud.physics.textContent = `${Math.round((1 / settings.fixedTimeStep) * settings.physicsSubSteps)} Hz`;

  handleResize();
});

/* ---- co-op network panel --------------------------------------- */

const netState = document.getElementById('net-state');
const netCode = document.getElementById('net-code');
const netCodeRow = document.getElementById('net-code-row');
const netJoin = document.getElementById('net-join');
const joinCodeInput = document.getElementById('join-code');
const joinHostIdInput = document.getElementById('join-hostid');
const btnHost = document.querySelector('[data-net="host"]');
const btnJoin = document.querySelector('[data-net="join"]');
const btnLeave = document.querySelector('[data-net="leave"]');
const joinGoBtn = document.querySelector('[data-net="join-go"]');

// The Phase-5 co-op panel these helpers were written for is gone: the live
// status lives in the ExpeditionHUD (#hud-net-state). The ids below can be
// null, and a co-op error used to throw on `null.textContent` inside the error
// path itself. Each helper is a no-op when its markup is absent.
function setNetState(text, ok) {
  if (!netState) return;
  netState.textContent = text;
  netState.classList.toggle('online', !!ok);
}

function showNetCode(code) {
  if (!netCode) return;
  netCode.textContent = code || '—';
  if (netCodeRow) netCodeRow.style.display = code ? 'flex' : 'none';
}

function setJoinFormVisible(visible) {
  if (netJoin) netJoin.style.display = visible ? 'flex' : 'none';
  if (joinCodeInput) joinCodeInput.style.display = visible ? '' : 'none';
  if (joinHostIdInput) joinHostIdInput.style.display = 'none';
}

/**
 * Co-op failed: say so, drop the dead session and stay in the game. This is the
 * handler behind NetworkManager.onFatal, which fires for a rejected room code or
 * a blocked WebRTC handshake as well as for real faults. Treating those as fatal
 * used to throw the player out of a solo drive they were already enjoying.
 */
function handleCoopFailure(message) {
  const text = String(message || 'connection failed');
  toast(`CO-OP: ${text.toUpperCase()}`);
  try {
    networkManager.disconnect();
  } catch {
    /* the session may already be gone */
  }
  btnHost?.classList.remove('on');
  btnJoin?.classList.remove('on');
  if (btnLeave) btnLeave.style.display = 'none';
  setNetState('OFFLINE', false);
  showNetCode(null);
  setJoinFormVisible(false);
}

// When hosting, expose the peer id too so a friend can paste it as a fallback.
function exposeHostId(id) {
  // We keep the host id out of the main HUD to avoid confusion; it is printed
  // into the browser console once, and surfaced as a clip-on toast on request.
  if (id && !window.__hostPeerIdExposed) {
    window.__hostPeerIdExposed = id;
  }
}

btnHost?.addEventListener('click', () => {
  if (networkManager.isHost) {
    networkManager.disconnect();
    btnHost.classList.remove('on');
    btnLeave.style.display = 'none';
    setNetState('OFFLINE', false);
    showNetCode(null);
    setJoinFormVisible(false);
    toast('HOST STOPPED');
    return;
  }
  networkManager.startHost('You');
  btnHost.classList.add('on');
  btnLeave.style.display = '';
  setJoinFormVisible(false);
});

btnJoin?.addEventListener('click', () => {
  if (networkManager.isJoined) {
    networkManager.disconnect();
    btnJoin.classList.remove('on');
    btnLeave.style.display = 'none';
    setNetState('OFFLINE', false);
    showNetCode(null);
    setJoinFormVisible(false);
    toast('LEFT HOST');
    return;
  }
  setJoinFormVisible(true);
  joinCodeInput.focus();
});

joinGoBtn?.addEventListener('click', () => {
  // Accept "MUD842", "mud-842", "MUD 842" — anything that carries 6 characters.
  const code = normaliseRoomCode(joinCodeInput.value);
  if (!code) {
    toast('ENTER THE 6-CHARACTER ROOM CODE');
    return;
  }
  // The host's PeerJS id is derived from the room code itself, so the code is
  // all a friend needs — no host id to paste, no directory server.
  setJoinFormVisible(false);
  networkManager.startJoin(code, null, 'You');
  btnJoin.classList.add('on');
  btnLeave.style.display = '';
  showNetCode(code);
  toast(`CONNECTING TO ${code}`);
});

btnLeave?.addEventListener('click', () => {
  if (networkManager.isHost) {
    networkManager.disconnect();
    btnHost.classList.remove('on');
  } else if (networkManager.isJoined) {
    networkManager.disconnect();
    btnJoin.classList.remove('on');
  }
  btnLeave.style.display = 'none';
  setNetState('OFFLINE', false);
  showNetCode(null);
  setJoinFormVisible(false);
  toast('LEFT CO-OP');
});

// Network UI callbacks are owned by UIManager.setNetworkCallbacks(), which runs
// when the UI is constructed above. The old inline handlers are gone with the
// Phase-5 panel.

function handleResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  optimizer.resize();
  atmosphere.resize(width, height);
  // A resize changes the pixel budget: a smaller window may afford a sharper
  // buffer, a bigger one may not.
  applyPixelBudget();
}

window.addEventListener('resize', handleResize);
handleResize();

/* ================================================================== *
 *  Main loop
 * ================================================================== */

let lastTime = performance.now();
let accumulator = 0;
let started = false;
let warmFrames = 0;
let warmStart = 0;
const foliageTrucks = [];

let steerValue = 0;

/** True when the focused element is a text/number field or similar. */
function isFormControl(element) {
  if (!element || element === document.body) return false;
  return element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName || '');
}

/**
 * Phase 8 input shaping: keyboard, arrow pads and the analog touch channels all
 * funnel into one steering value, so sensitivity and self-centering apply
 * uniformly and the wheel never snaps.
 */
/* ---- gamepad --------------------------------------------------------
 * Standard mapping: left stick steers, the triggers drive, B is the handbrake.
 * A pad is only read while one is connected, so keyboard and touch behaviour
 * is untouched on machines that do not have one.
 * ------------------------------------------------------------------- */
const gamepad = { connected: false, id: '', steer: 0, throttle: 0, brake: 0, handbrake: false };
window.__gamepad = gamepad;

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : null;
  let pad = null;
  if (pads) {
    for (const candidate of pads) {
      if (candidate && candidate.connected) {
        pad = candidate;
        break;
      }
    }
  }
  gamepad.connected = !!pad;
  if (!pad) {
    gamepad.steer = 0;
    gamepad.throttle = 0;
    gamepad.brake = 0;
    gamepad.handbrake = false;
    return;
  }
  gamepad.id = pad.id;
  const stick = pad.axes[0] || 0;
  const trigger = (index) => (pad.buttons[index] ? pad.buttons[index].value || 0 : 0);
  gamepad.steer = Math.abs(stick) < 0.14 ? 0 : stick;
  gamepad.throttle = trigger(7);
  gamepad.brake = trigger(6);
  gamepad.handbrake = !!(pad.buttons[1] && pad.buttons[1].pressed);
}

function readDriverInput(dt) {
  const digitalThrottle = keys.has('KeyW') || keys.has('ArrowUp') || held.throttle ? 1 : 0;
  const digitalBrake = keys.has('KeyS') || keys.has('ArrowDown') || held.brake ? 1 : 0;

  let digitalSteer = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft') || held.left) digitalSteer -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight') || held.right) digitalSteer += 1;

  pollGamepad();

  const throttle = Math.max(digitalThrottle, Number(held.throttleAxis) || 0, gamepad.throttle);
  const brake = Math.max(digitalBrake, Number(held.brakeAxis) || 0, gamepad.brake);

  const analogSteer = Math.abs(gamepad.steer) > 0.01 ? gamepad.steer : Number(held.steerAxis) || 0;
  const target = Math.abs(analogSteer) > 0.01 ? analogSteer : digitalSteer;

  const sensitivity = optimizer.settings.steerSensitivity;
  const centering = optimizer.settings.steerCentering;
  const rate = Math.abs(target) > 0.01 ? 9 * sensitivity : 11 * centering;
  steerValue += (target - steerValue) * Math.min(1, rate * Math.max(0.001, dt));

  // A menu owns the controls while it is open. Without this, adjusting a slider
  // in the settings drawer with the arrow keys also steered and accelerated the
  // truck behind it, and a held key stayed held after the drawer closed.
  if (settingsUI.isOpen || isFormControl(document.activeElement)) {
    keys.clear();
    steerValue += (0 - steerValue) * Math.min(1, 11 * Math.max(0.001, dt));
    vehicle.setThrottle(0);
    vehicle.setBrake(0);
    vehicle.setSteer(Math.max(-1, Math.min(1, steerValue)));
    return;
  }

  // The audio lab drives the truck during its scripted phases; it is the only
  // thing allowed to take the wheel from the player, and only when it is running.
  const override = window.__audioLabInput;
  if (override) {
    vehicle.setThrottle(override.throttle || 0);
    vehicle.setBrake(override.brake || 0);
    vehicle.setSteer(override.steer || 0);
    return;
  }

  // The pad's handbrake shares the Space key's latch: released unless the pad
  // says otherwise, and never stuck on after the controller is unplugged.
  if (gamepad.connected) vehicle.setHandbrake(gamepad.handbrake || keys.has('Space'));

  vehicle.setThrottle(throttle);
  vehicle.setBrake(brake);
  vehicle.setSteer(Math.max(-1, Math.min(1, steerValue * sensitivity)));
}

/* ---- driver assist ---------------------------------------------------
 * The map is 2 km across with no minimap, a tank that can run dry and terrain
 * that can put the truck on its roof in a ravine. None of those should need a
 * wiki: detect the three states a driver actually gets stuck in and name the
 * key that fixes each one. Throttled so it never nags.
 * ------------------------------------------------------------------- */
const UP_AXIS = new CANNON.Vec3(0, 1, 0);
const _upWorld = new CANNON.Vec3();
const assist = { flip: 0, bog: 0, lastFlip: -1e9, lastBog: -1e9, tankDry: false };

function driverAssist(dt, now, telemetry) {
  // On the roof: the chassis' local up has tipped past 70 degrees from world up.
  vehicle.body.quaternion.vmult(UP_AXIS, _upWorld);
  if (_upWorld.y < 0.35) assist.flip += dt;
  else assist.flip = 0;
  if (assist.flip > 1.4 && now - assist.lastFlip > 12000) {
    assist.lastFlip = now;
    toast('ON THE ROOF — PRESS R TO RESET');
  }

  // Bogged: pedal down, no forward progress for five seconds.
  const throttling =
    keys.has('KeyW') || keys.has('ArrowUp') || held.throttle || held.throttleAxis > 0.2;
  if (throttling && Math.abs(telemetry.speedKmh) < 1.2 && assist.flip === 0) assist.bog += dt;
  else assist.bog = 0;
  if (assist.bog > 5 && now - assist.lastBog > 20000) {
    assist.lastBog = now;
    toast('BOGGED DOWN — WINCH (F) OR RESET (R)');
  }

  // Dry tank: say it once, and reset the flag if the tank is refilled.
  if (telemetry.fuel < 1.5 && !assist.tankDry) {
    assist.tankDry = true;
    toast('TANK EMPTY — CAMP AT A FIRE (B) OR REFUEL AT A STATION');
  } else if (telemetry.fuel > 5) {
    assist.tankDry = false;
  }
}

function frame(now) {
  if (!bootWatch.firstFrame) {
    bootWatch.firstFrame = Math.round(performance.now() - bootWatch.start);
    bootMark('first-frame');
  }
  requestAnimationFrame(frame);

  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  // Phase 8 governor: metering, auto-scaling, culling and physics sleeping.
  optimizer.update(dt, now);
  const shouldRender = optimizer.shouldRender(now);

  const settings = quality.settings;
  const step = optimizer.physicsStep;
  const subSteps = optimizer.physicsSubSteps;
  const subStep = step / subSteps;

  // The settings drawer is a pause. Without this the truck keeps rolling
  // downhill while the player is reading a slider.
  const paused = settingsUI.isOpen;
  if (!paused) readDriverInput(dt);

  // Never let a slow frame snowball. Catching up five physics ticks makes the
  // next frame slower again, and that is how a 20 FPS machine slides to 4. Three
  // ticks of catch-up keeps the truck responsive and stops the simulation from
  // eating the frame it is trying to save; anything older is simply dropped.
  if (paused) accumulator = 0;
  else accumulator += Math.min(dt, step * 3);
  let ticks = 0;
  while (!paused && accumulator >= step && ticks < 3) {
    vehicle.beginFrame();
    trailer.beginFrame();
    for (let i = 0; i < subSteps; i += 1) {
      vehicle.update(subStep);
      trailer.update(subStep);
      world.step(subStep);
    }
    accumulator -= step;
    ticks += 1;
  }
  if (ticks >= 3) accumulator = 0;

  vehicle.syncVisuals(accumulator / step, dt);
  trailer.syncVisuals(accumulator / step);
  // Photo mode owns the camera; everything else follows the truck.
  if (!atmosphere.photo.active) cameraController.update(dt);
  rutSystem.update(dt);

  // Phase-5: winch + missions run every frame; network ticks at 20 Hz inside
  // NetworkManager.update.
  winchSystem.update(dt, now);
  missionManager.update(dt, now);

  // Rescue beacon rides above our truck, bobbing while the ping is active.
  // (vehicle.helpPingActive is also sent in every state tick.)
  rescueBeacon.visible = !!vehicle.helpPingActive;
  if (rescueBeacon.visible) {
    const bp = vehicle.body.position;
    rescueBeacon.position.set(bp.x, bp.y + 3.4 + Math.sin(now * 0.003) * 0.12, bp.z);
    rescueBeacon.rotation.y += dt * 1.6;
  }
  // 20 Hz state ticks out, teammate ticks in, plus rut-stamp batching.
  networkManager.update(dt, now);

  /* ---- Phase 7 systems ---- */
  const telemetry = vehicle.getTelemetry();
  driverAssist(dt, now, telemetry);
  atmosphere.update(dt, now, telemetry);
  // Ground safety net. The heightfield is sampled at 2 m intervals, so a fast
  // wheel can step over a crest between collision steps and the truck drops
  // through the world. Catch it the same frame and put it back on the surface.
  const bp = vehicle.body.position;
  const groundHere = terrain.getHeightAt(bp.x, bp.z);
  if (Number.isFinite(groundHere) && bp.y < groundHere - 1.2) {
    bp.y = groundHere + 1.15;
    if (vehicle.body.velocity.y < 0) vehicle.body.velocity.y = 0;
    vehicle.body.aabbNeedsUpdate = true;
  }

  landmarks.update(dt, vehicle, atmosphere.night);
  styleDNA.update(dt);
  waterSystem.update(dt, camera, atmosphere.sunDirection);
  // Adaptive resolution: hold frame rate by bleeding pixels, then restore them.
  // Cheaper than cutting world detail, and invisible while driving fast.
  fpsGovernor(dt);
  tactile.update(dt, now, telemetry);
  if (provingBench) {
    provingBench.update(dt);
    provingHud.update(dt);
  }
  // Perspective follows the camera, weather follows the sky, so the mix reacts
  // to where you are rather than to a setting buried in a menu.
  audio.setCameraMode(cameraController.mode);
  audio.setWeather(
    atmosphere.weatherMode === 'snow'
      ? 'snow'
      : atmosphere.phase && atmosphere.phase.weather === 'rain'
        ? 'rain'
        : 'clear',
  );
  // Audio is decorative: a fault here is logged once and the drive continues.
  audio.update(
    dt,
    telemetry,
    {
      // Analog pedal first, keyboard as the fallback, so the diesel revs with
      // however far you actually pushed it.
      throttle: Math.max(
        keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0,
        held.throttleAxis || 0,
      ),
      brake: Math.max(keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0, held.brakeAxis || 0),
      terrain,
    },
  );
  tickAudioLab(dt);

  // Wind-bent foliage: our truck plus every teammate shoves the grass aside.
  foliageTrucks.length = 0;
  foliageTrucks.push({
    x: vehicle.body.position.x,
    y: vehicle.body.position.y,
    z: vehicle.body.position.z,
    radius: 3.2,
  });
  for (const entry of networkManager.remotePlayers || []) {
    const player = entry[1];
    if (player?.pos) {
      foliageTrucks.push({ x: player.pos.x, y: player.pos.y, z: player.pos.z, radius: 3.2 });
    }
  }
  terrain.updateFoliage(dt, foliageTrucks);
  // Distance LOD for props and ground cover: chunks past the fog are not drawn,
  // and chunks past the near threshold fall back to a proxy.
  terrain.updateLOD(camera);
  mesaField.update(camera);
  // Physics streams with the truck as well: only scenery colliders within reach
  // are in the world, which takes the per-step broadphase cost from ~13 ms to
  // under 2 ms.
  terrain.updateColliders(vehicle.body.position.x, vehicle.body.position.z);

  // Host owns the clock — ship it to the squad a few times a minute.
  if (networkManager.isHost) {
    timeSyncTimer += dt;
    if (timeSyncTimer > 6) {
      timeSyncTimer = 0;
      networkManager.sendMissionEvent('time-sync', atmosphere.getState());
    }
  }

  // Phase-6 HUD.
  if (ui) ui.update(dt);

  // Phase 8 instruments & settings telemetry.
  const inLobby = ui ? ui._inLobby !== false : !(lobbyElement && lobbyElement.style.display === 'none');
  if (inLobby && expeditionHUD.visible) expeditionHUD.hide();
  if (!inLobby && !expeditionHUD.visible) expeditionHUD.show();
  // Instruments and the settings panel are DOM writes: reading a dozen values
  // and pushing them into the page costs more than the render on a weak CPU.
  // Twelve refreshes a second is indistinguishable from sixty for readouts.
  hudRefresh += dt;
  if (hudRefresh >= 0.08) {
    hudRefresh = 0;
    expeditionHUD.update(dt, now, telemetry);
    settingsUI.update(dt);
  }

  // Throttled shadow refresh. autoUpdate is off, so this is what keeps the
  // sun's shadows following the truck; the cadence stretches as the frame
  // budget shrinks, so the pass lands on one frame in eight instead of one in two.
  shadowTimer += dt;
  if (shadowTimer >= governor.shadowInterval) {
    shadowTimer = 0;
    renderer.shadowMap.needsUpdate = true;
  }

  // The atmosphere owns the sun, the sky dome and the final render pass.
  sky.position.copy(camera.position);
  if (shouldRender) {
    atmosphere.render();
    optimizer.captureRenderStats();
    if (!started) {
      if (!warmStart) warmStart = performance.now();
      warmFrames += 1;
      setBootProgress(0.96 + Math.min(3, warmFrames) * (0.04 / 3), 'WARMING UP THE WORLD');
    }
  }

  hudTimer += dt;
  if (hudTimer > 0.1) {
    fpsSmoothed += (1 / Math.max(hudTimer, 1e-4) - fpsSmoothed) * 0.08;
    window.__fpsSmoothed = fpsSmoothed;
    hudTimer = 0;
  }

  // Three frames prove the whole pipeline runs. Two and a half seconds is the
  // ceiling on a GPU so slow that a third warm frame would be an unreasonable
  // wait — the loader has already bought the expensive part of the boot.
  const warmed = warmFrames >= 3 || (warmFrames >= 1 && performance.now() - warmStart > 2500);
  if (!started && warmed) {
    started = true;
    clearInterval(bootTipTimer);
    setBootProgress(1, 'READY');
    bootMark('ready');
    window.__gameReady = true;
    optimizer.scaleResolution(selectedPixelRatio);
    governor.current = selectedPixelRatio;
    window.__fpsScale = +selectedPixelRatio.toFixed(2);
    if (lobbyElement) lobbyElement.inert = false;
    boot.classList.add('done');
    boot.setAttribute('aria-hidden', 'true');
  }
}

// Handy from the browser console: __game.vehicle.setPSI(10), __game.quality.setTier('LOW'), etc.
/* ------------------------------------------------------------------ *
 *  Frame-rate governor
 * ------------------------------------------------------------------ */

/* Supersampling is capped by total pixels, not only by the device ratio: a 2×
 * buffer on a 4K panel is 33 MP of fill, which no machine needs for sharpness
 * and every machine pays for twice. */
const PIXEL_BUDGET = 4_200_000;
function pixelBudgetCap() {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const dpr = window.devicePixelRatio || 1;
  const budgetRatio = Math.sqrt(PIXEL_BUDGET / (width * height));
  return Math.max(1, Math.min(2, Math.min(dpr, budgetRatio)));
}
/** Re-apply the budget after a resize; this only ever clamps downward. */
function applyPixelBudget() {
  if (!renderBudgetReady) return;
  const cap = pixelBudgetCap();
  governor.cap = cap;
  if (governor.current > cap) {
    governor.current = cap;
    optimizer.scaleResolution(cap);
    window.__fpsScale = +cap.toFixed(2);
  }
}

const governor = {
  // Sixty is the performance target; faster panels may still render uncapped.
  // Chasing 120 used to destroy image quality on perfectly good 60 Hz GPUs.
  target: 60,
  // Supersample above native only while both the device and the pixel budget
  // allow it; 1 CSS pixel per drawing-buffer pixel is the hard floor.
  cap: pixelBudgetCap(),
  retryAfter: 0,
  floor: 1,
  current: 1,
  strikes: 0,
  degrade: 0,
  goodWindows: 0,
  recoverWindows: 0,
  hzChecks: 0,
  windowFps: [],
  smoothFps: 60,
  lastRungAt: 0,
  accumulator: 0,
  frames: 0,
  fps: 60,
  // The sun's shadow map is a second submission of every caster. Eight frames
  // a second of lag on a shadow is invisible; a 2048 shadow pass landing in an
  // 8.3 ms budget is not.
  shadowInterval: 0.08,
};
governor.current = governor.cap;
renderBudgetReady = true;

// Everything the ladder is allowed to take away, captured so it can be handed
// back later. `baseline` is the player's own settings, `ladderBase` is what the
// current frame-rate profile started from. Both are filled in once the
// optimizer exists.
const baseline = { settings: null };
let ladderBase = null;

/* What the ladder sheds, in the order it costs the most frame time per unit of
 * visible difference. Each step is cumulative and reversible. */
const DEGRADE_STEPS = [
  null, // 0 — the player's own settings
  { postProcessing: false },
  { shadows: 'HIGH_1024_SOFT', shadowInterval: 0.1 },
  { drawDistance: 190, foliageDensity: 0.35, particleBudget: 80 },
  { drawDistance: 130, foliageDensity: 0.1, particleBudget: 30 },
  { shadows: 'off', shadowInterval: 0.2 },
];

/** Recompute the frame configuration for a rung of the ladder, from the top. */
function applyLadder(level) {
  const clamped = Math.max(0, Math.min(DEGRADE_STEPS.length - 1, level));
  const base = ladderBase || baseline.settings || optimizer.settings;
  const patch = {
    postProcessing: base.postProcessing,
    shadows: base.shadows,
    drawDistance: base.drawDistance,
    foliageDensity: base.foliageDensity,
    particleBudget: base.particleBudget,
  };
  let shadowInterval = 0.08;
  for (let i = 1; i <= clamped; i += 1) {
    const step = DEGRADE_STEPS[i];
    if (step.postProcessing !== undefined) patch.postProcessing = step.postProcessing;
    if (step.shadows) patch.shadows = step.shadows;
    if (step.drawDistance) patch.drawDistance = step.drawDistance;
    if (step.foliageDensity !== undefined) patch.foliageDensity = step.foliageDensity;
    if (step.particleBudget !== undefined) patch.particleBudget = step.particleBudget;
    if (step.shadowInterval) shadowInterval = step.shadowInterval;
  }
  governor.shadowInterval = shadowInterval;
  // Re-applying unchanged settings rebuilds grass and re-uploads textures, which
  // is exactly the hitch a struggling machine cannot afford, so only the keys
  // that actually move are pushed.
  const changed = {};
  let count = 0;
  for (const key of Object.keys(patch)) {
    if (optimizer.settings[key] !== patch[key]) {
      changed[key] = patch[key];
      count += 1;
    }
  }
  if (count) {
    // Never persisted and never marked custom: the saved preset is the player's,
    // and it is what Settings has to keep reporting.
    optimizer.applySettings(changed, { persist: false, markCustom: false });
  }
  governor.degrade = clamped;
  window.__fpsDegrade = clamped;
}

function fpsGovernor(dt) {
  // A backgrounded tab has its animation frames throttled to about 1 Hz, which
  // is not the game's fault and must not make the governor slash resolution.
  if (document.hidden) {
    governor.stamp = 0;
    governor.frames = 0;
    return;
  }
  // Wall-clock, not the clamped simulation step: dt is capped at 0.1 s for
  // physics stability, which made a 10 FPS frame look like 60 FPS to this
  // governor and stopped it ever kicking in.
  const now = performance.now();
  if (!governor.stamp) governor.stamp = now;
  governor.accumulator = (now - governor.stamp) / 1000;
  governor.frames += 1;
  // Half a second: at 120 Hz a bad quality decision is 60 wasted frames, so
  // the loop has to be able to change its mind twice a second.
  if (governor.accumulator < 0.5) return;

  const fps = governor.frames / governor.accumulator;
  governor.stamp = now;
  governor.fps = fps;
  governor.accumulator = 0;
  governor.frames = 0;

  // Decide on the median of the last five windows, not on one of them. Every
  // real machine has a half-second of shader compilation or a tab switch in it,
  // and a governor that reacts to that single window strips the world bare and
  // never puts it back.
  governor.windowFps.push(fps);
  if (governor.windowFps.length > 5) governor.windowFps.shift();
  const sorted = governor.windowFps.slice().sort((a, b) => a - b);
  const smooth = sorted[Math.floor(sorted.length / 2)];
  governor.smoothFps = smooth;

  const target = governor.target;
  let next = governor.current;

  if (smooth < target * 0.92 && governor.current > governor.floor) {
    // A missed 60 FPS deadline on a small machine compounds, so this moves in
    // steps and immediately, rather than easing down over several windows.
    const step = fps < target * 0.7 ? 0.15 : 0.07;
    next = Math.max(governor.floor, governor.current - step);
    // Do not climb straight back into the ratio that just failed: give the 
    // machine four seconds before the resolution is allowed to grow again, so
    // the governor settles instead of breathing.
    governor.retryAfter = now + 4000;
    governor.goodWindows = 0;
  } else if (smooth >= target * 0.98 && governor.current < governor.cap && now > governor.retryAfter) {
    governor.goodWindows += 1;
    if (governor.goodWindows >= 4) {
      governor.goodWindows = 0;
      next = Math.min(governor.cap, governor.current + 0.04);
    }
  } else {
    governor.goodWindows = 0;
  }

  if (Math.abs(next - governor.current) > 0.001) {
    governor.current = next;
    // The optimizer owns the renderer and the post-processing targets, so the
    // scale goes through it and the bloom chain does not end up a different
    // size from the drawing buffer.
    if (typeof optimizer.scaleResolution === 'function') optimizer.scaleResolution(next);
    else renderer.setPixelRatio(next);
    window.__fpsScale = +next.toFixed(2);
  }

  // Only supersampled pixels are expendable. Native resolution is preserved;
  // once it is reached, post-FX, shadows, foliage and draw distance go first.
  const atFloor = governor.current <= governor.floor + 0.001;
  if (smooth < target * 0.9 && atFloor) governor.strikes += 1;
  else governor.strikes = Math.max(0, governor.strikes - 1);

  // One rung per 1.5 s at the earliest: the rung itself has to be allowed to
  // show what it bought before the next thing is taken away.
  const settled = now - governor.lastRungAt > 1500;
  if (governor.strikes >= 3 && settled && governor.degrade < DEGRADE_STEPS.length - 1) {
    governor.strikes = 0;
    governor.recoverWindows = 0;
    governor.lastRungAt = now;
    applyLadder(governor.degrade + 1);
  } else if (governor.degrade > 0 && smooth >= target * 0.99) {
    // Sustained headroom at a degraded rung: hand one thing back. Six windows
    // is three seconds, long enough that a corner or a shader compile cannot
    // trigger it.
    governor.recoverWindows += 1;
    if (governor.recoverWindows >= 6) {
      governor.recoverWindows = 0;
      governor.lastRungAt = now;
      applyLadder(governor.degrade - 1);
    }
  } else {
    governor.recoverWindows = 0;
  }

}

/* ---- remember the camera mode --------------------------------------- */
try {
  const savedCamera = localStorage.getItem('INORLD_CAMERA');
  if (savedCamera && CAMERA_MODE_LABEL[savedCamera]) cameraController.setMode(savedCamera);
  const setModeOriginal = cameraController.setMode.bind(cameraController);
  cameraController.setMode = (mode) => {
    const result = setModeOriginal(mode);
    try {
      localStorage.setItem('INORLD_CAMERA', result);
    } catch {
      // Private mode: the mode simply does not persist.
    }
    return result;
  };
} catch {
  // Storage blocked; nothing to restore.
}

window.__governor = governor;
window.__setDegrade = applyLadder;
// Input state for debugging stuck-key reports (see releaseHeldInputs).
window.__inputs = { keys, held };

/* One call that answers "is it actually hitting 60 on this machine?" */
window.__perf = () => {
  const stats = optimizer.renderStats || {};
  const snapshot = {
    fps: +fpsSmoothed.toFixed(1),
    governorFps: +governor.smoothFps.toFixed(1),
    target: governor.target,
    scale: +governor.current.toFixed(2),
    cap: +governor.cap.toFixed(2),
    degrade: governor.degrade,
    tier: quality.tier,
    preset: optimizer.settings.id || optimizer.settings.preset,
    calls: stats.calls ?? null,
    triangles: stats.triangles ?? null,
    buffer: [renderer.domElement.width, renderer.domElement.height],
    css: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio || 1,
    mesaTiles: mesaField.visibleChunks,
    boot: bootWatch.marks.map(([label, ms]) => `${label}@${ms}ms`),
  };
  console.log('%c[INORLD] performance snapshot', 'color:#e0b076;font-weight:600', snapshot);
  return snapshot;
};

window.__game = {
  scene, camera, renderer, world, vehicle, trailer, quality, cameraController,
  terrain, rutSystem, networkManager, winchSystem, missionManager, ui,
  atmosphere, tactile, audio,
  optimizer, settingsUI, expeditionHUD,
  test: provingBench, testHud: provingHud, provingGround: TEST_MODE ? PROVING_GROUND : null,
  landmarks, pointsOfInterest, styleDNA, regionAt, waterSystem, styleOverhaul, overlandStyle,
};

/* ---- native-resolution 60 FPS profile -------------------------------
 * The governor alone owns dynamic resolution. Its range is 1–2x: only pixels
 * above native can be surrendered, and the reversible ladder handles the rest.
 * ------------------------------------------------------------------- */
baseline.settings = { ...optimizer.settings };
optimizer.externalScaleControl = true;
ladderBase = { ...optimizer.settings };

governor.current = Math.min(governor.cap, optimizer.effectivePixelRatio || governor.cap);
window.__fpsScale = +governor.current.toFixed(2);
window.__targetFps = governor.target;

// Paint the loading stage before compilation begins. compileAsync yields where
// the driver supports parallel shader compilation; the sync fallback remains
// necessary on older WebGL implementations.
setBootProgress(0.94, 'COMPILING SHADERS');
const selectedPixelRatio = Math.max(1, optimizer.effectivePixelRatio || governor.current);
// Compile and warm into a native-size target. Supersampling is restored under
// cover of the loader's fade, so startup does not pay retina fill four times.
optimizer.scaleResolution(1);
governor.current = 1;
await new Promise((resolve) => setTimeout(resolve, 32));

/* ---- pre-compile shaders -------------------------------------------------
 * Every material in the scene compiles on the first draw. That is one huge
 * task — on a software renderer it froze the tab for eight seconds after the
 * world was already built. compileAsync hands compilation to the driver and
 * yields between programs, so the boot screen keeps animating.
 * ------------------------------------------------------------------------ */
try {
  // Some virtual drivers never signal the parallel-compile extension's
  // completion bit. Warm every program synchronously behind the painted loader,
  // then bound the optional async confirmation so boot can never hang here.
  renderer.compile(scene, camera);
  bootMark('compile-sync');
  if (typeof renderer.compileAsync === 'function') {
    bootMark('compile-async-start');
    await Promise.race([
      renderer.compileAsync(scene, camera),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
  }
} catch (error) {
  console.warn('Shader pre-compile failed; the first frame will compile instead.', error);
}
bootMark('compiled');
setBootProgress(0.96, 'WARMING UP THE WORLD');

requestAnimationFrame(frame);
