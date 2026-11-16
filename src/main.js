import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { QualityManager, QUALITY_PRESETS, detectQualityTier } from './QualityManager.js';
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
import { ProceduralAudio } from './ProceduralAudio.js';
import { PerformanceOptimizer, loadStoredSettings } from './PerformanceOptimizer.js';
import { GraphicsSettingsUI } from './GraphicsSettingsUI.js';
import { ExpeditionHUD } from './ExpeditionHUD.js';
import { ACCESSORIES, ACCESSORY_ORDER, PAINT_COLORS, PAINT_ORDER } from './VehicleMeshBuilder.js';
import { Landmarks } from './Landmarks.js';
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

/* ================================================================== *
 *  DOM + error plumbing
 * ================================================================== */

const app = document.getElementById('app');
const boot = document.getElementById('boot');

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
}

window.addEventListener('error', (event) => {
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
    antialias: QUALITY_PRESETS[initialTier].antialias,
    powerPreference: 'high-performance',
    stencil: false,
  });
} catch (error) {
  showFatal('WebGL is not available in this browser.', String(error));
  throw error;
}

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa8bccd);
scene.fog = new THREE.Fog(0xa8bccd, 40, 260);

// Far plane has to reach across a 2 km map, or the far ridge clips away.
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 3200);
camera.position.set(0, 6, -16);

const quality = new QualityManager(renderer, scene, initialTier);
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
networkManager.onFatal = (message) => showFatal('Co-op connection error.', message);

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
  camera,
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

const audio = new ProceduralAudio({
  vehicle,
  winchSystem,
  camera,
  quality,
});

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
    case 'KeyY':
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
  if (hud.cameraBtn) hud.cameraBtn.classList.toggle('on', cameraController.mode === 'tactical');
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

function setNetState(text, ok) {
  netState.textContent = text;
  netState.classList.toggle('online', !!ok);
}

function showNetCode(code) {
  netCode.textContent = code || '—';
  netCodeRow.style.display = code ? 'flex' : 'none';
}

function setJoinFormVisible(visible) {
  netJoin.style.display = visible ? 'flex' : 'none';
  joinCodeInput.style.display = visible ? '' : 'none';
  joinHostIdInput.style.display = 'none';
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
}

window.addEventListener('resize', handleResize);
handleResize();

/* ================================================================== *
 *  Main loop
 * ================================================================== */

let lastTime = performance.now();
let accumulator = 0;
let started = false;
const foliageTrucks = [];

let steerValue = 0;

/**
 * Phase 8 input shaping: keyboard, arrow pads and the analog touch channels all
 * funnel into one steering value, so sensitivity and self-centering apply
 * uniformly and the wheel never snaps.
 */
function readDriverInput(dt) {
  const digitalThrottle = keys.has('KeyW') || keys.has('ArrowUp') || held.throttle ? 1 : 0;
  const digitalBrake = keys.has('KeyS') || keys.has('ArrowDown') || held.brake ? 1 : 0;

  let digitalSteer = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft') || held.left) digitalSteer -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight') || held.right) digitalSteer += 1;

  const throttle = Math.max(digitalThrottle, Number(held.throttleAxis) || 0);
  const brake = Math.max(digitalBrake, Number(held.brakeAxis) || 0);

  const analogSteer = Number(held.steerAxis) || 0;
  const target = Math.abs(analogSteer) > 0.01 ? analogSteer : digitalSteer;

  const sensitivity = optimizer.settings.steerSensitivity;
  const centering = optimizer.settings.steerCentering;
  const rate = Math.abs(target) > 0.01 ? 9 * sensitivity : 11 * centering;
  steerValue += (target - steerValue) * Math.min(1, rate * Math.max(0.001, dt));

  vehicle.setThrottle(throttle);
  vehicle.setBrake(brake);
  vehicle.setSteer(Math.max(-1, Math.min(1, steerValue * sensitivity)));
}

function frame(now) {
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

  readDriverInput(dt);

  accumulator += dt;
  let ticks = 0;
  while (accumulator >= step && ticks < 5) {
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
  if (ticks >= 5) accumulator = 0;

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
  overlandStyle.tick(dt);
  // Adaptive resolution: hold frame rate by bleeding pixels, then restore them.
  // Cheaper than cutting world detail, and invisible while driving fast.
  fpsGovernor(dt);
  tactile.update(dt, now, telemetry);
  if (provingBench) {
    provingBench.update(dt);
    provingHud.update(dt);
  }
  audio.update(dt, telemetry, {
    // Analog pedal first, keyboard as the fallback, so the diesel revs with
    // however far you actually pushed it.
    throttle: Math.max(
      keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0,
      held.throttleAxis || 0,
    ),
    terrain,
  });

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
  expeditionHUD.update(dt, now, telemetry);
  settingsUI.update(dt);

  // The atmosphere owns the sun, the sky dome and the final render pass.
  sky.position.copy(camera.position);
  if (shouldRender) {
    atmosphere.render();
    optimizer.captureRenderStats();
  }

  hudTimer += dt;
  if (hudTimer > 0.1) {
    fpsSmoothed += (1 / Math.max(hudTimer, 1e-4) - fpsSmoothed) * 0.08;
    window.__fpsSmoothed = fpsSmoothed;
    hudTimer = 0;
  }

  if (!started) {
    started = true;
    boot.classList.add('done');
  }
}

// Handy from the browser console: __game.vehicle.setPSI(10), __game.quality.setTier('LOW'), etc.
/* ------------------------------------------------------------------ *
 *  Frame-rate governor
 * ------------------------------------------------------------------ */

const governor = {
  cap: Math.min(window.devicePixelRatio || 1, 2),
  current: Math.min(window.devicePixelRatio || 1, 2),
  accumulator: 0,
  frames: 0,
  fps: 60,
};

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
  if (governor.accumulator < 0.75) return;

  governor.stamp = now;
  governor.fps = governor.frames / governor.accumulator;
  governor.accumulator = 0;
  governor.frames = 0;

  const target = 50;
  let next = governor.current;

  if (governor.fps < target - 8 && governor.current > 0.62) {
    next = Math.max(0.62, governor.current - 0.14);
  } else if (governor.fps > target + 12 && governor.current < governor.cap) {
    next = Math.min(governor.cap, governor.current + 0.08);
  }

  if (Math.abs(next - governor.current) > 0.01) {
    governor.current = next;
    renderer.setPixelRatio(next);
    window.__fpsScale = +next.toFixed(2);
  }
}

window.__governor = governor;

window.__game = {
  scene, camera, renderer, world, vehicle, trailer, quality, cameraController,
  terrain, rutSystem, networkManager, winchSystem, missionManager, ui,
  atmosphere, tactile, audio,
  optimizer, settingsUI, expeditionHUD,
  test: provingBench, testHud: provingHud, provingGround: TEST_MODE ? PROVING_GROUND : null,
  landmarks, styleDNA, regionAt, waterSystem, styleOverhaul, overlandStyle,
};

// Phase 7 adds a lot of new shader programs (wind-blown foliage, beams, post
// passes). Link them up front so the first frames never draw a half-linked
// program while the driver is still compiling in parallel.
renderer.compile(scene, camera);

requestAnimationFrame(frame);
