# INORLD — "Over The Hill" — Project File

> **Purpose of this document.** It is the single self-contained reference for the
> project. Every section below is written to be read *on its own*: it states the
> files involved, the exact constants, the ownership rules, and the traps, so a
> reader (human or agent) working on one section never needs another file to
> understand it. If something here disagrees with the code, the code wins —
> update this file in the same change.

---

## 0. Contents

1. [What this is](#1-what-this-is)
2. [Running, serving, deploying](#2-running-serving-deploying)
3. [Repository map](#3-repository-map)
4. [Boot sequence (exact order)](#4-boot-sequence-exact-order)
5. [The frame loop (exact order)](#5-the-frame-loop-exact-order)
6. [Performance architecture — the native-resolution 60 FPS budget](#6-performance-architecture--the-native-resolution-60-fps-budget)
7. [Quality system (tiers, presets, settings, persistence)](#7-quality-system-tiers-presets-settings-persistence)
8. [Rendering and visual stack](#8-rendering-and-visual-stack)
9. [World: atlas, terrain, props, colliders](#9-world-atlas-terrain-props-colliders)
10. [Vehicle physics and construction](#10-vehicle-physics-and-construction)
11. [Trailer](#11-trailer)
12. [Camera](#12-camera)
13. [Input and controls (complete)](#13-input-and-controls-complete)
14. [UI, HUD and DOM contract](#14-ui-hud-and-dom-contract)
15. [Co-op networking](#15-co-op-networking)
16. [Missions and winch](#16-missions-and-winch)
17. [Audio](#17-audio)
18. [Style: DNA, overhaul, overland presets](#18-style-dna-overhaul-overland-presets)
19. [Proving ground and instrumentation](#19-proving-ground-and-instrumentation)
20. [Debug console API](#20-debug-console-api)
21. [Invariants, traps and conventions](#21-invariants-traps-and-conventions)
22. [Performance changelog](#22-performance-changelog)
23. [Verification checklist](#23-verification-checklist)

---

## 1. What this is

A browser off-road expedition game: a procedurally built 2 km valley, a
raycast-suspended 4×4 with a manual H-gear box and CTIS tyre pressure, a two-axle
timber trailer, winching, scouting and hauling missions, and 4-player co-op over
WebRTC. No build step, no bundler, no npm install: ES modules loaded straight
from disk, three.js / cannon-es / PeerJS from jsDelivr via an import map.

- **Runtime:** modern browser with WebGL2. ES modules + top-level `await` required.
- **Entry point:** `index.html` → `src/main.js` (module).
- **Everything is code-generated.** No image or audio assets are required; the
  vehicle, terrain, sky, water normals, textures, signs and sounds are all built
  at runtime. `assets/audio/` exists only as optional sample slots.
- **Deterministic world:** seed `20261113`, used for terrain noise, scatter and
  co-op world agreement.

---

## 2. Running, serving, deploying

### 2.1 Local

```bash
python3 serve.py            # port 3000 by default
python3 serve.py 8080       # explicit port
```

`serve.py` is a threaded `SimpleHTTPRequestHandler` rooted at the repo directory
that sends `Cache-Control: no-store`, `Pragma: no-cache`, `Expires: 0` and
`Access-Control-Allow-Origin: *` on every response, and binds `0.0.0.0` so a
preview tunnel can reach it. It prints `serving <root> on 0.0.0.0:<port>`.

Opening `index.html` via `file://` will **not** work (module CORS).

### 2.2 CDN dependencies (import map, `index.html` lines 233–245)

| name | version | URL |
|---|---|---|
| `three` | 0.160.0 | `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js` |
| `three/addons/` | 0.160.0 | `https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/` |
| `cannon-es` | 0.20.0 | `https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js` |
| PeerJS | 1.5.1 | classic `<script>` — sets `window.Peer` (it has **no** ESM export) |

Stylesheets: `./styles.css?v=10` and `./src/hud-styles.css?v=2`. Bump the query
string when you change them, because the dev server disables caching.

### 2.3 URL parameters / feature flags

| flag | effect |
|---|---|
| `?test` (or `#test`, or `localStorage.INORLD_TEST=1`) | enables the surveyed proving ground, the physics bench and its HUD |
| `?audiolab` | runs `src/audio/AudioLab.js` scripted test drive once the AudioContext unlocks |
| `?hz=NNN` | overrides the detected display refresh rate (testing/odd panels). Values ≥ 60 only. |

Detection order for test mode: query → hash → localStorage.

### 2.4 Packaging

`INORLD.zip` is a distribution snapshot, rebuilt with:

```bash
zip -qr INORLD.zip index.html styles.css src serve.py README.md assets
```

`shots/` is scratch output and stays untracked. Do not add it to the zip.

---

## 3. Repository map

Line counts are current at the time of writing; treat them as a size signal, not
a contract.

### 3.1 Root

| file | role |
|---|---|
| `index.html` (247) | canvas mount `#app`, lobby overlay, HUD skeleton, boot overlay, fatal overlay, toast, import map |
| `styles.css` (1952) | all main-page styling: lobby, HUD legacy panels, touch cockpit, settings modal, responsive rules |
| `src/hud-styles.css` (1410) | the ExpeditionHUD instrument cluster (own stylesheet, `?v=2`) |
| `serve.py` (40) | static server described above |
| `README.md` | one line: `# INORLD` |
| `INORLD.zip` | distribution snapshot (see 2.4) |
| `assets/audio/manifest.json` | optional sample catalogue (`sampleRate 48000`, `bitsPerSample 24`, `loops {}`, `sets {}`) |
| `assets/audio/README.md` | recording/spec guidance for dropping real samples in |
| `PROJECT.md` | this document |

### 3.2 `src/` — game systems

| file | lines | exports / responsibility |
|---|---|---|
| `main.js` | ~1755 | composition root: renderer, scene, physics world, boot order, input, frame loop, **frame-rate governor**, `window.__game` |
| `WorldAtlas.js` | 316 | `WORLD_SCALE`, `WORLD`, `REGIONS`, `regionAt()`, `ROADS`, `roadLength()`, `WATCHTOWERS`, `GAS_STATIONS`, `SIGNS` |
| `TerrainSystem.js` | ~2347 | `mulberry32`, `makeNoise2D`, `fbm`, `BIOME`, `BIOMES`, `TerrainSystem` — heightfield, ground chunks, biome/prop scatter, LOD, collider streaming, foliage, water plane |
| `ProvingGround.js` | 714 | `PROVING_GROUND`, `ZONES`, `zoneById`, `zoneAt`, `shapeProvingGround`, `resolveDatum`, `spawnPoint`, `auditProvingGround`, `createProvingProps`, `createProvingBench`, `createProvingHud` |
| `OffroadVehicle.js` | ~1173 | `PHYS_GROUPS`, `SURFACES`, `OffroadVehicle`; also re-exports `VEHICLE_TUNE`, `VEHICLE_ACCESSORIES`, `VEHICLE_GEARS` |
| `VehicleMeshBuilder.js` | 1299 | `PAINT_COLORS`, `PAINT_ORDER`, `PSI_RANGE`, `tireDeflation`, `effectiveTireRadius`, `ACCESSORIES`, `ACCESSORY_ORDER`, `VehicleMeshBuilder` (including static-body merge) |
| `TrailerRig.js` | 680 | `TrailerRig` (+ `TRAILER_TUNE`) |
| `CameraController.js` | 504 | `CAMERA_MODE`, `CAMERA_MODE_LABEL`, `CAMERA_MODE_SHORT`, `FOCUS_MODE`, `FOCUS_LABEL`, `CameraController` |
| `QualityManager.js` | 220 | `QUALITY_PRESETS` (LOW/MEDIUM/HIGH), `QUALITY_ORDER`, `detectQualityTier`, `QualityManager` |
| `PerformanceOptimizer.js` | ~740 | `SETTINGS_KEY`, `PRESET_ORDER`, `SHADOW_MODES`, `MUD_MODES`, `PRESETS`, `readGpuString`, `detectHardwareTier`, `presetSettings`, `recommendedSettings`, `loadStoredSettings`, `PerformanceOptimizer` |
| `AtmosphereAndPostFX.js` | ~930 | `AtmosphereAndPostFX`: day cycle, sky dome, PMREM env, fog, campfires, headlights, photo mode, bloom/grade composer |
| `MudRutShader.js` | 701 | `RutSystem`: GPU rut stamp map (HIGH/MEDIUM) or decal ribbons (LOW) |
| `WaterSystem.js` | 239 | `WaterSystem`: mirror water, depth ramp, foam, throttled reflection |
| `Landmarks.js` | 417 | `Landmarks`: poles, centre lines, signs, gas stations, DOM notices |
| `LandmarkModels.js` | 505 | `createStoneMaterials`, `assemble`, `castleTower`, `castleGate`, `ruinedWall`, `ruinStump`, `cairnGeometries`, `waymarker` — modular low-poly stonework |
| `PointsOfInterest.js` | 400 | `PointsOfInterest`: keeps on the watchtower sites, river gatehouse, ruin fields, trail cairns and signposts |
| `MesaField.js` | ~610 | `MesaField`: terraced buttes/massifs, palm oases on the river, instanced desert scrub — the red-rock country's relief without touching the heightfield |
| `MissionManager.js` | 611 | `MissionManager`: watchtower scouting, timber hauling, bridge reconstruction |
| `WinchSystem.js` | 541 | `WinchSystem`: static anchors, truck-to-truck rescue, fuel transfer |
| `NetworkManager.js` | 1180 | `STUN_SERVERS`, `MAX_PEERS`, `makeRoomCode`, `normaliseRoomCode`, `roomCodeToPeerId`, `isPeerIdValidForRoom`, `vehicleSnapshot`, `NetworkManager` |
| `UIManager.js` | 905 | `UIManager`: lobby DOM, legacy HUD wiring, touch controls |
| `ExpeditionHUD.js` | 918 | `ExpeditionHUD`: gear gate, CTIS cluster, drivetrain switches, expedition pill, mobile cockpit |
| `GraphicsSettingsUI.js` | 574 | `GraphicsSettingsUI`: three-tab settings drawer, hardware banner, live hot-swap |
| `StyleDNA.js` | 203 | `TOON_RAMP`, `toonifyMaterial`, `toonify`, `addInkOutline`, `StyleDNA` |
| `StyleOverhaul.js` | 437 | `PALETTE`, `applyStylePalette`, `StyleOverhaul` |
| `OverlandStyle.js` | 144 | `STYLE_PRESETS`, `PRESET_ORDER`, `OverlandStyle`: tone mapping, 4 lighting presets, dual-layer fog |
| `TactileVFX.js` | 513 | `TactileVFX`: torque twist, running gear, mud coating, instanced particles |

### 3.3 `src/audio/` — layered vehicle audio

| file | lines | role |
|---|---|---|
| `AudioMixer.js` (305) | `smoothParam`, `oneShotEnvelope`, `BUS_NAMES`, `AudioMixer` — one AudioContext, bus tree, voice budget, master limiter |
| `VehicleAudioController.js` (267) | reads physics once per frame, feeds all layers; owns perspective, gear events, load |
| `EngineAudio.js` (392) | four RPM layers (idle/low/mid/high) crossfaded by RPM |
| `ExhaustAudio.js` (101) | tailpipe note + overrun burble, independently mutable |
| `TransmissionAudio.js` (161) | shift thunk, gear whine, diff whine, shaft rumble, clutch slip |
| `TireAudio.js` (244) | one panned voice per wheel, chosen by contact surface |
| `SuspensionAudio.js` (169) | compression/rebound one-shots + cabin creak + rattle beds |
| `CollisionAudio.js` (174) | impact sized by normal impulse; separate scrape layer |
| `InteriorAudio.js` (90) | cab as a filter (HF loss, ~180 Hz resonance, trims) |
| `EnvironmentAudio.js` (183) | wind/altitude, birds, rain, snow, thunder, stream proximity |
| `SampleLibrary.js` (121) | prefers files from `assets/audio/` by manifest id, else synthesis |
| `AudioLab.js` (309) | `?audiolab` scripted drive with per-bus peak metering |

`BUS_NAMES = ['engine', 'drivetrain', 'tyres', 'mechanical', 'ambience', 'ui']`.
Master chain: `master → limiter → destination`.

---

## 4. Boot sequence (exact order)

All of this is top-level in `src/main.js`; the module uses top-level `await`.

1. **Display refresh probe** (`probeRefreshRate`). 24 empty `requestAnimationFrame`
   deltas, first 4 discarded, median → measured Hz, snapped to the nearest of
   `[60, 75, 90, 100, 120, 144, 165, 240]` when within 8 %. Falls back to 60 with
   fewer than 6 samples; 800 ms hard timeout so a throttled background tab can
   never hold the boot screen. Result on `window.__display = { hz, measured, median }`.
   `?hz=NNN` overrides.
2. **Boot watchdog** `window.__boot = { start, buildMs, marks, longTasks[] }`, with
   a `PerformanceObserver` on `longtask`.
3. **Fatal overlay plumbing**: `window.__fatal = { message, stack }`, `#fatal`
   gets `.show`, `#boot` gets `.done`.
4. **Renderer**: `WebGLRenderer({ antialias: preset.antialias, powerPreference:
   'high-performance', stencil: false })`; `outputColorSpace = SRGB`;
   `toneMapping = LinearToneMapping`; `shadowMap.enabled = true`;
   **`shadowMap.autoUpdate = false`** (shadows are requested by cadence, see §5).
5. **Scene + camera**: background `0xa8bccd`, `Fog(40, 260)` placeholder (replaced
   later by `FogExp2` in `AtmosphereAndPostFX`); `PerspectiveCamera(58°, aspect, 0.1, 3200)`.
6. **QualityManager** for the detected tier; fog near/far from `quality.settings`.
7. **Sky dome**: `SphereGeometry(600, settings.skySegments, 20)`, `BackSide`,
   `depthWrite:false`, custom shader with `pow(sun, 220)` and `pow(sun, 8)`.
   `frustumCulled = false`, `renderOrder = -1`.
8. **Lights**: `HemisphereLight(0xbfd6ea, 0x6b5a44, 1.0)`;
   `DirectionalLight(0xfff1d6, 2.5)` at `(60, 92, 40)` with a ±48 m ortho shadow
   camera, `near 1`, `far 280`, `bias -0.0006`, `normalBias 0.035`;
   `quality.registerShadowLight(sun)`.
9. **Physics world**: `CANNON.World({ gravity: -9.82 })`, **`SAPBroadphase`**,
   `allowSleep`, solver iterations from quality, ground contact material
   (friction 0.4, restitution 0).
10. **`applyStylePalette()`** — must run before terrain because the palette is
    baked into vertex colours.
11. **`new TerrainSystem({ scene, world, groundMaterial, seed: 20261113, testMode })`**,
    then `await terrain.build(progress => …)` which updates `#boot .sub` text
    (`LOADING n% — <label>`). Build time recorded as `__boot.buildMs`.
12. **Optional proving ground** (`?test`): `createProvingProps`, `auditProvingGround`
    → `console.table` + `window.__provingSurvey`.
13. **Landmarks**, then **RutSystem** (`renderer, scene, terrain, quality, groundMask`).
14. **`new OffroadVehicle(...)`** at `terrain.spawn`, paint `PAINT_COLORS.yellow.hex`,
    `surfaceProvider: terrain.getSurfaceAt`, `localPlayerId: 'player-1'`.
15. **`new TrailerRig(...)`** parked 6 m behind and 6.5 m to the side of spawn,
    `y = getHeightAt + 1.3`. `rutSystem.attachVehicle(vehicle)`.
16. **NetworkManager**, **WinchSystem**, rescue beacon group, **MissionManager**
    (`setup()`), then cross-wire `networkManager.winchSystem/missionManager`.
    Immediately after `setToaster()`: **`new PointsOfInterest({ scene, terrain, missionManager })`**
    (`window.__poi`), which dresses the mission zones in architecture, then
    **`new MesaField({ scene, terrain, world, keepOut })`** (`window.__mesa`), which
    adds the buttes, palms and scrub across the whole map; `keepOut` carries the mill
    and bridge positions so rock does not land on them.
17. **CameraController**, input collections (`keys`, `held`), **UIManager**
    (`ui.setNetworkCallbacks()`), `toast()`.
18. **AtmosphereAndPostFX** (`atmosphere.setQuality(...)`, `fogScale = 0.34`),
    **StyleDNA** (`celShadeVehicle()` + `celShadeProps([landmarks.group, missionManager.group])`),
    **WaterSystem**, **OverlandStyle**, **StyleOverhaul**, **TactileVFX**,
    optional proving bench/HUD, **VehicleAudioController**.
19. `window.__game` (first assignment, pre-optimizer) and gear-shift audio hooks
    (`vehicle.shiftUp/Down` wrapped to add `audio.clunk()` + `tactile.onGearShift()`).
20. **PerformanceOptimizer** with `loadStoredSettings()`; register cullables
    (rescue beacon, trailer group, campfires); **GraphicsSettingsUI**;
    **ExpeditionHUD**.
21. **Governor + quality ladder** definitions, then the **high-refresh profile**
    (only when `governor.target >= 100`).
22. **`window.__game`** (second, complete assignment), then the loader is staged at
    `COMPILING SHADERS`: the chosen pixel ratio is captured and the renderer is held at
    **1×**, so boot never pays retina fill four times.
23. **Shader warm-up behind the loader**: `renderer.compile(scene, camera)` compiles
    every program synchronously; `compileAsync` may then confirm in parallel, raced
    against an 8 s timeout so a virtual driver that never signals cannot hang boot.
    `bootMark('compile-sync')`, `bootMark('compiled')`, then `WARMING UP THE WORLD`.
24. `requestAnimationFrame(frame)`. `#boot` stays up and `#lobby` stays `inert` until
    **three frames have actually been rendered** at 1× — or one frame has and
    **2.5 s** of warm-up has elapsed, whichever comes first, so a very slow GPU is
    not held for three multi-second frames. Release restores the selected
    (possibly 2×) ratio, sets `window.__gameReady = true`, adds `.done` to `#boot`,
    stops the boot-tip rotation and releases the lobby. The loader shows the
    detected tier, viewport and DPR in `.boot-detail` and rotates four control
    tips in `.boot-tip`.

---

## 5. The frame loop (exact order)

`function frame(now)` — request the next frame **first**, then:

```
dt = min(0.1, (now - lastTime)/1000)
optimizer.update(dt, now)                 // metering, culling, sleeping (see §6)
shouldRender = optimizer.shouldRender(now) // fpsCap gate
readDriverInput(dt)                        // keyboard + analog → vehicle
physics accumulator (max 3 ticks)          // see below
vehicle.syncVisuals(alpha, dt); trailer.syncVisuals(alpha)
cameraController.update(dt)                // unless photo mode is active
rutSystem.update(dt)
winchSystem.update(dt, now)
missionManager.update(dt, now)
rescue beacon visibility/rotation
networkManager.update(dt, now)             // 20 Hz tick, interpolation
driverAssist(dt, now, telemetry)           // rollover / bogged / dry-tank prompts
atmosphere.update(dt, now, telemetry)      // clock, fog, campfires, sky scale
ground safety net                          // if body.y < terrainY - 1.2 → snap to +1.15
landmarks.update(dt, vehicle, atmosphere.night)
styleDNA.update(dt)
waterSystem.update(dt, camera, sunDirection)
fpsGovernor(dt)                             // the governor, §6
tactile.update(dt, now, telemetry)
provingBench/provingHud.update (test mode)
audio.setCameraMode / setWeather / audio.update
tickAudioLab(dt)
terrain.updateFoliage(dt, foliageTrucks)   // our truck + remote trucks push grass
terrain.updateLOD(camera)                  // props + ground chunk LOD
terrain.updateColliders(truckX, truckZ)    // scenery collider streaming
host: send time-sync every 6 s
ui.update(dt)
lobby → expeditionHUD show/hide
if (hudRefresh >= 0.08) expeditionHUD.update + settingsUI.update   // 12.5 Hz
if (shadowTimer >= governor.shadowInterval) request shadow update
sky.position.copy(camera.position)
if (shouldRender) atmosphere.render(); optimizer.captureRenderStats()
if (hudTimer > 0.1) smooth FPS into window.__fpsSmoothed / __fpsSmoothed
first frame → #boot.classList.add('done')
```

**Physics stepping.** `step = 1 / max(30, settings.physicsHz)` (60 Hz default),
`subSteps = physicsHz >= 55 ? 1 : 2`, `subStep = step / subSteps`.
`accumulator += min(dt, step * 3)`; the loop runs at most **3 ticks**, each doing
`vehicle.beginFrame(); trailer.beginFrame();` then `subSteps × (vehicle.update,
trailer.update, world.step)`. If 3 ticks were consumed the accumulator is zeroed —
deliberately dropping time rather than death-spiralling.

**Hard rules in the loop:** no allocation in hot paths where avoidable; DOM writes
only on their throttles (HUD 12.5 Hz, shadow cadence, FPS 10 Hz); the governor
runs near the end so its measurement includes everything the frame did.

---

## 6. Performance architecture — the native-resolution 60 FPS budget

**Ownership.** `main.js`'s `governor` owns *dynamic* resolution and the quality
ladder. `PerformanceOptimizer` owns the static preset, renderer/composer plumbing
and culling. `QualityManager` owns the player-facing tier. Any two of these
writing the same value is a bug: `optimizer.externalScaleControl = true` disables
the optimizer's own `_autoScale()` so it cannot fight the governor.

### 6.1 Measured baseline (cloud VM, virtualised Apple M4 GPU string)

| metric | value |
|---|---|
| JS subsystem time per frame (canvas hidden) | **0.74 ms** (of 4.99 ms total, 4.25 ms of which is three.js submit in this VM) |
| `world.step` before collider streaming | 14.5 ms |
| `world.step` after collider streaming | 0.08 ms |
| draw calls / triangles at HIGH, post-FX on, 2048 shadows, native 1× | **~525 / 236 300** |
| submitted triangles before the tiled mesa pass | **~595 000** |
| median canvas frame time, before → after the pass | **~359 ms → ~244 ms** |

The MesaField tiling pass removed roughly 60 % of submitted geometry from the
same camera. The VM has no hardware GPU path: `requestAnimationFrame` is pinned
to 60 Hz and a canvas readback stalls ~400 ms, so **this environment cannot
display or measure 60 FPS**. The pass is validated by draw-call/triangle counts,
the submitted-geometry reduction and JS-time accounting; real-hardware frame
rate is unverified.

### 6.2 Governor state (`window.__governor`)

| field | meaning |
|---|---|
| `target` | `60` — one target on every panel |
| `cap` | `pixelBudgetCap()` — `min(2, dpr, sqrt(4.2 MP / viewport))`, floored at 1; a 4K or retina panel cannot ask for 33 MP of fill |
| `floor` | `1` — native 1:1 is the lowest pixel ratio ever used |
| `current` | pixel ratio currently applied |
| `retryAfter` | timestamp before which resolution may not grow again |
| `windowFps[5]`, `smoothFps` | median-of-5 windows decision input |
| `strikes` | consecutive deficient windows while at the floor |
| `degrade` | ladder rung 0…5 |
| `shadowInterval` | seconds between shadow-map refreshes (0.08 s) |
| `lastRungAt`, `goodWindows`, `recoverWindows`, `hzChecks` | hysteresis bookkeeping |

### 6.3 Decision loop (every 0.5 s, wall clock)

1. `fps = frames / windowSeconds`; push into the 5-window ring; `smooth = median`.
   A single bad half-second (shader compile, tab switch) cannot move the median.
2. **Down** if `smooth < 0.92 × target` and above the native floor:
   step `0.15` when `fps < 0.7 × target`, else `0.07`; then `retryAfter = now + 4000`.
   The floor is 1×, so this only ever gives back supersampled pixels.
3. **Up** if `smooth >= 0.98 × target`, `current < cap`, `now > retryAfter`, and
   4 consecutive good windows: `+0.04`. The retry delay is what stops the classic
   breathing between two ratios.
4. Applied through `optimizer.scaleResolution(v)`, which resizes the renderer, the
   drawing buffer **and** the post-processing targets together.
5. **Ladder** escalates only when at the native floor and `smooth < 0.9 × target`
   for 3 windows, at most once per 1.5 s. It restores one rung after 6 windows
   (3 s) at `smooth >= 0.99 × target`. Once resolution is at 1×, image detail
   (post-FX, shadows, foliage, draw distance) is what pays — the canvas is never
   shrunk below native again.

### 6.4 The ladder (`DEGRADE_STEPS`, reversible, never persisted)

| rung | what it sheds |
|---|---|
| 0 | player/profile settings |
| 1 | post-processing off (bloom + film grade + OutputPass) |
| 2 | shadows `HIGH_1024_SOFT`, cadence 0.1 s |
| 3 | `drawDistance 190`, `foliageDensity 0.35`, `particleBudget 80` |
| 4 | `drawDistance 130`, `foliageDensity 0.1`, `particleBudget 30` |
| 5 | shadows off entirely, cadence 0.2 s |

`applyLadder(level)` recomputes the whole rung from a base snapshot (`ladderBase`)
so it is idempotent and reversible, and it **only pushes keys whose value actually
changed** — re-applying identical settings rebuilds grass and re-uploads textures,
which is precisely the hitch a struggling machine cannot afford. Exposed as
`window.__setDegrade(n)` for testing.

Two snapshots exist: `baseline.settings` (the player's own settings, taken before
the high-refresh profile) and `ladderBase` (what the active profile started from).
Rung 0 restores `ladderBase`; the 60 Hz correction restores `baseline`.

### 6.5 Native-resolution profile (applied at boot, every panel)

```js
governor.target = 60        // one target; no 120 Hz chase that starves the buffer
governor.floor = 1          // native 1:1 is never surrendered
governor.cap = min(2, dpr)  // supersample only while there is headroom
optimizer.externalScaleControl = true
```

Compilation and the three warm-up frames run at 1×; the player's own ratio is
restored under the loader fade. Nothing here is persisted and it never marks the
preset `CUSTOM`, so the Settings panel keeps reporting what the player chose.

### 6.6 Costs removed or throttled for stability

| cost | treatment |
|---|---|
| scenery colliders (2 865 bodies) | streamed in/out inside a **95 m** radius around the truck; re-scan every **10 m** of travel. `terrain.colliderStats = { total, live }` |
| prop horizon | `terrain.viewCutoff` (120–320 m, default 320) instead of a bogus 480–518 m (see trap §21.1) |
| shadow pass | `autoUpdate = false`; requested every `governor.shadowInterval` |
| PMREM environment rebuild | every 8 s **and** only if the sun moved > 0.005 rad |
| material recompile | only when the shadow *sampling type* or enable state changes, not on map-size changes |
| physics catch-up | max 3 ticks per frame |
| HUD DOM writes | 12.5 Hz (0.08 s), FPS text 10 Hz |
| rut stamping | GPU map at a fixed cadence / decals on LOW; batches sent at 10 Hz |
| water surface | 128² quads (32 768 triangles) instead of 200²; mirror refreshed every 90 ms (140 ms on LOW/COZY/ULTRA_LOW); grass hidden from the mirror pass |
| fuel stations | stationary parts baked by material + shadow mode (20 meshes → ~8 per station) and hidden beyond `max(150, viewCutoff)` |
| netcode | state ticks 20 Hz, interpolation delay 110 ms |

---

## 7. Quality system (tiers, presets, settings, persistence)

There are **two** layers and they are intentionally independent:

- `QualityManager` / `QUALITY_PRESETS` — the **tier** (`LOW` / `MEDIUM` / `HIGH`),
  chosen from hardware, cycle with the HUD quality button. Drives fog distances,
  sky segments, shadow type/size, anisotropy, MSAA (construction-time only),
  physics sub-steps.
- `PerformanceOptimizer` / `PRESETS` — the **player-facing preset** (`COZY`,
  `ULTRA_LOW`, `LOW`, `MEDIUM`, `HIGH`), persisted, hot-swapped, editable field by
  field in the settings drawer.

### 7.1 Tier presets (exact values)

| field | LOW | MEDIUM | HIGH |
|---|---|---|---|
| `maxPixelRatio` | 1 | 2 | 2 |
| `antialias` | true | true | true |
| `shadowMapSize` | 1024 | 2048 | 2048 |
| `shadowType` | PCF | PCFSoft | PCFSoft |
| `shadowRadius` | 1 | 3 | 4 |
| `physicsSubSteps` | 1 | 2 | 3 |
| `fixedTimeStep` | 1/60 | 1/60 | 1/60 |
| `solverIterations` | 8 | 12 | 16 |
| `enableGpuMudRuts` | false | true | true |
| `enableCanvasTracks` | true | true | true |
| `particleBudget` | 0 | 140 | 420 |
| `anisotropy` | 1 | 8 | 16 |
| `fogNear / fogFar` | 30 / 210 | 50 / 400 | 70 / 540 |
| `skySegments` | 16 | 32 | 48 |
| `toneExposure` | 1.0 | 1.0 | 1.05 |

`detectQualityTier()`: coarse pointer → LOW; discrete GPU (`rtx|gtx|radeon rx|arc
a|apple m[1-9]|geforce` and not integrated) → HIGH; integrated → cores ≥ 8 &&
memory ≥ 8 ? MEDIUM : LOW; ≥ 8 cores and ≥ 8 GB → HIGH; else MEDIUM.

### 7.2 Optimizer presets (exact values)

| field | COZY | ULTRA_LOW | LOW | MEDIUM | HIGH |
|---|---|---|---|---|---|
| `pixelRatio` | 1.25 | 1 | 1 | 1.25 | 2 |
| `shadows` | MED_1024 | off | LOW_512 | MED_1024 | HIGH_2048_SOFT |
| `postProcessing` | true | false | false | false | true |
| `mudDeformMode` | GPU_512 | MATH_ONLY | DECALS | GPU_512 | GPU_1024 |
| `foliageDensity` | 1 | 0 | 0.25 | 0.6 | 1 |
| `particleBudget` | 200 | 20 | 60 | 150 | 520 |
| `terrainSegments` | 128 | 64 | 96 | 128 | 192 |
| `drawDistance` | 260 | 110 | 170 | 240 | 350 |
| `fpsCap` | 60 | 30 | 60 | 60 | 0 |
| `physicsHz` | 60 | 45 | 60 | 60 | 60 |
| `anisotropy` | 4 | 1 | 2 | 4 | 16 |
| `solverIterations` | 12 | 6 | 8 | 12 | 16 |

`pixelRatio` resolves as `min(deviceRatio, preset.pixelRatio)`; the governor never
goes below native 1×. `deviceRatio()` clamps the reported DPR to 0.75–3.

`SHADOW_MODES`: `off` (0 px), `LOW_512` (PCF), `MED_1024` (PCF),
`HIGH_1024_SOFT` (PCFSoft), `HIGH_2048_SOFT` (PCFSoft, the HIGH preset — enough
for cliff edges at a quarter of the 4096 memory and fill), `HIGH_4096_SOFT`
(retained for manual selection only).
`MUD_MODES`: `GPU_1024` (2048 stamp map), `GPU_512` (1024), `DECALS`, `MATH_ONLY`.

### 7.3 Player settings (`PLAYER_DEFAULTS`, stored alongside the preset)

`inputMode` (`auto|keyboard|touch`), `steeringStyle` (`wheel|arrows|tilt`),
`transmission` (`manual|auto`), `steerSensitivity`, `steerCentering`, `touchScale`,
`hudOpacity`, `invertOrbitX`, `invertOrbitY`, `masterVolume`, `engineVolume`,
`ambienceVolume`, `timeOverride` (`auto|dawn|golden|overcast|snow|night`),
`autoScaleResolution`.

### 7.4 Persistence and sanitisation

- Storage key: **`INORLD_SETTINGS`** (`localStorage`), JSON of the whole settings
  object. Written on every persisted `applySettings`; `loadStoredSettings()`
  merges over the recommended set and **sanitises**: `pixelRatio` 1–2,
  `drawDistance` 100–350, `foliageDensity` 0–1, `fpsCap ∈ {0,30,60}`, numbers
  coerced, unknown keys dropped. A corrupted store cannot brick the game.
- `applySettings(partial, { persist = true, markCustom = true })`; passing
  `preset` swaps every preset field. Internal callers always pass
  `{ persist: false, markCustom: false }` so automated quality changes never look
  like the player's choice.

### 7.5 Hardware detection

`readGpuString()` reads `WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL` on a
throwaway canvas and loses the context. `detectHardwareTier()` classifies
software (`swiftshader|llvmpipe|software`) → ULTRA_LOW; mobile UA or coarse
pointer → Apple with ≥ 6 cores ? LOW : ULTRA_LOW; NVIDIA / Radeon ≥ 8 cores /
Apple ≥ 8 GB → HIGH; Intel/Mali/Adreno → MEDIUM or LOW; else HIGH/MEDIUM by
cores and memory. Result cached on `window.__inorldHardware`.

---

## 8. Rendering and visual stack

Order of ownership for "how it looks": `QualityManager` (tier) →
`PerformanceOptimizer` (preset) → `OverlandStyle` (tonemap/fog presets) →
`StyleOverhaul` (palette/materials/water) → `StyleDNA` (toon shading, ink) →
`AtmosphereAndPostFX` (sky, sun, fog, post chain).

### 8.1 Sky and environment

- Sky dome is a 600-unit sphere materialised per tier segment count, scaled with
  `min(880, max(260, camera.far * 0.86))`, re-centred on the camera each frame.
- `AtmosphereAndPostFX` **replaces** `scene.fog` with `THREE.FogExp2` in its
  constructor. Height-based density:
  `density = baseFogDensity × fogScale(0.34) × heightFactor(1 - (camY-4)/90, clamped 0.35–1.4) × (1 - discovered×0.1)`,
  floored at `1.45 / viewDistance` so the draw-distance cut stays hidden; snow
  multiplies by 1.3.
- Environment lighting: PMREM from a private `Sky` scene, 8 s cadence, skipped
  while the sun direction has moved less than 0.005 rad. `environmentIntensity`
  0.5 day / 0.22 night.
- Day cycle phases (dawn/golden/overcast/night) blend sun colour/intensity,
  hemisphere, fog, exposure and bloom strength. Campfires are point lights with
  flicker + ember billboards; `setHeadlights` adds spots, cones and lamp faces;
  photo mode (`P`) free-fly + DOF + watermark.

### 8.2 Post chain

`EffectComposer` with a half-resolution `UnrealBloomPass` (its `setSize` is
overridden to 0.5× and a 64 px floor), a grade pass, a sharpen pass and an
`OutputPass`. The sharpen is a nine-tap unsharp mask (`SHARPEN_SHADER`,
`uStrength` 0.9) whose amount is gated by local contrast, so haze and flat paint
keep their gradients; `uTexel` comes from `renderer.getDrawingBufferSize()` via
`_syncSharpenTexel()` on every resize so the radius holds at any DPR. Bloom
radius is 0.32 and phase/region strengths stay below 0.16 — a wide bloom halo
bleeds across the faceted silhouettes the style depends on. Disabled
entirely (`composerEnabled = false`) on LOW tiers, when `postProcessing` is false,
in the high-refresh profile, at ladder rung ≥ 1, and in photo mode's raw mode.

### 8.3 Water

`Water` from three addons with a code-generated 256² crossing-wave normal map, a
192² (128² on low tiers) mirror target, a throttled mirror pass (45 ms / 90 ms),
grass layers hidden from the mirror, a baked `aDepth` attribute for shallow tint,
shore alpha ramp and moving foam. The scene's simple water plane from
`TerrainSystem` is hidden.

### 8.4 Ruts

`RutSystem` owns a top-down stamp render target (2048 on GPU_1024, 1024 on
GPU_512) with max-blending blobs per grounded wheel, sampled by the terrain
material in vertex (displacement) and fragment (darkening/compression). On LOW it
emits quads along each tyre path instead; on MATH_ONLY the physics sinkage stays
and nothing is drawn.

### 8.5 Style

`StyleDNA`: three-band toon ramp (`makeToonRamp(3)`) + warm rim, inverted-hull ink
on the truck only (`thickness 1.022`, `0x1c1a20`), region palette grading per
frame (`fog.color`, hemisphere colour, bloom strength, tone exposure).
`StyleOverhaul`: flat albedo palette, matte materials, distance + height fog
written as literal patches, water as a depth colour ramp.
`OverlandStyle`: linear tone mapping, four presets
(`GOLDEN_MEADOW`, `ALPINE_NOON`, `ALPENGLOW_SUNSET`, `STORM_CONVOY`) cycling with
`Y`, global `wetness` / `snowLine` uniforms. Tone mapping is **`LinearToneMapping`,
not ACES**: the palette is authored in display space and ACES turned an authored
sky `#fad6c8` into `#e1e1e1` on screen. Lighting is deliberately high-key
(`sunIntensity 1.35`, `hemiIntensity 1.18`) so a face turned away from the sun
stays pale stone instead of going black.

**The clock owns the look; a preset is a latch.** `AtmosphereAndPostFX`'s four
phases (`dawn`, `golden`, `overcast`, `night`) carry their own sun, ambient, fog,
exposure and sky scattering. Booting into a latched preset was a bug: the cycle
kept moving the sun while the lights stayed golden, so night rendered as dusk.
`OverlandStyle` therefore records `GOLDEN_MEADOW` without locking at boot, `Y`
locks a preset, and any time-of-day change (`setTimePreset`, `setDynamicCycle`)
calls `clearStyleOverride()`.

**One country, four lights.** The region palettes in `WorldAtlas.REGIONS` are all
sandstone now — the canyon is the reference and the meadow, ridge and coast are
the same ground under a different sky (exposure, fog, sun tint). `applyStylePalette`
tints every region ground into the same warm family, the terrain paint lerps 74 %
toward it (32 % on trails), and the only cool note left is the sea. Snow is gated
to the alpine region instead of any ground above 30 m, which had been dusting the
meadow's hills white. If you add a region, give it a sandstone-family ground or
the map will read as two games stitched together.

**Two rendering paths, one look.** `LOW`/`MEDIUM` and any governor rung that
sheds post-processing draw straight to the canvas: no grade, no sharpen, at a
pixel ratio of 1×, the lowest the governor now uses. Two things therefore live outside the
composer. (1) Grade chroma moved partly into the baked palette: `saturate()`
raises `BIOME_COLOURS` and every region ground tint by 1.15 in
`applyStylePalette` (guarded, once), and the grade pass runs at 1.24 instead of
1.3. Measured on canyon sand: graded chroma 94.5 → 96, ungraded 70.2 → 79.4.
The grade is `saturation 1.06 / contrast 1.04 / lift 0.02`: the reference look is a
bright pastel diorama, and the earlier 1.24 saturation on gold albedo pushed the
field into mustard and left orange slivers for grass. The unsharp mask runs at
0.5 with an edge gate from 0.003 — at 1.15 it drew dark halos around every
pebble and blade. Brightness comes from the light rig instead: sun 2.2 / hemi
1.9 / exposure 1.45. Authored haze is multiplied by 0.8 in
`AtmosphereAndPostFX.update` — at full strength a 300 m butte was a pale ghost —
while the `0.6 / max(viewDistance, 240)` floor still hides the draw cut. The sky
dome's phases are desert values (deeper zenith, 44–46 % cloud) with a 10th-power
sun glow at 0.42, so golden hour has a light source in frame. Ground colour
carries two baked break-up bands: fine grit ±3 % and a broad mottle ±4 % at
~125 m, because one 2 % grain left the sand as a single brown swatch. A baked
vignette in the same grade pass darkens the corners to 0.86 without tinting, so
the frame reads centred and a soft upscaled edge is less obvious.
(2) The fog floor is `0.6 / max(viewDistance, 240)`: at the low preset's 130 m
draw the old `0.6 / viewDistance` was 0.0046 and turned the mesas into 85% haze
by 200 m; the cap keeps the draw cut hidden without erasing the country. Never
make the floor depend on draw distance again without checking LOW. The visible sky is `StyleOverhaul`'s dome, not the
atmosphere's `Sky` shader, so the dome carries a `SKY_PHASES` palette (horizon,
zenith, cloud lit/shade, cloud cover, sun glow) and eases to it in
`onBeforeRender`. Water dims with the phase in `WaterSystem.update` — the authored
turquoise is a linear-space multiplier, so night needs a few percent, not a
quarter, to stop the lake glowing.

---

## 9. World: atlas, terrain, props, colliders

### 9.1 Atlas (`WorldAtlas.js`)

Authored in a 640 m design space, multiplied by **`WORLD_SCALE = 3.2`**:
`WORLD = { size: 2048, half: 1024, waterLevel: 1.1 }`.

Four regions, each with `bounds`, `palette` (ground, groundAlt, accent, fog,
skyTint, sunTint, ambient, exposure, bloom) and a `shape(h, x, z)` height modifier:

| id | label | mood | bounds (design space) |
|---|---|---|---|
| `meadow` | Wildflower Meadow | late dusk | x −320…40, z −170…60 |
| `canyon` | Red Rock Canyon | golden hour | x 40…320, z −170…120 |
| `alpine` | Alpine Ridge | late afternoon | remaining north/east |
| `coast` | Coastal Flats | high noon | remaining south/west |

`regionAt(x, z)` returns the region owning the point (used by `StyleDNA`, the
surface classifier and Landmarks). Roads are polylines (`id`, `name`, `kind`,
`width`, `points[]`), e.g. `highway` *Valley Highway* 6.5 m wide; the grader
flattens a corridor along them and Landmarks lines them with poles/signs.
`WATCHTOWERS`, `GAS_STATIONS`, `SIGNS` are placed on the network.

### 9.2 Terrain constants (`TerrainSystem.js`)

| constant | value | meaning |
|---|---|---|
| `SIZE` | 2048 m | square world |
| `SEGMENTS` | 416 | quads per side |
| `ELEMENT` | `SIZE / SEGMENTS` ≈ 4.92 m | heightfield cell |
| `VERTS` | 417 | samples per side |
| `WATER_LEVEL` | 1.1 | river/lake surface |
| `RIVER_BED` | 0.15 | carved bed |
| `FORD_FLOOR` | `WATER_LEVEL - 0.25` | drivable ford floor |
| `TRAIL_MAX_GRADE` | 0.2 | grader limit |
| `PATH_BLEND_RADIUS` | 16 m | corridor smoothing |
| `PATH_SPACING` | 40 m | trail sampling |
| `CHUNKS` | 8 | ground chunks per side (64 total) |
| `_chunkSize` | 150 m | prop/LOD chunk size |
| trees / boulders / poles | 9000 / 900 / 260 | scatter counts (largest map-wide count the HIGH tier carries) |
| larches | ~50 % of trees | second stand, own chunk group and collider list, gold crowns |
| pebbles | 26000 | near-field stone, no colliders, culled at `0.2 ×` view distance |
| grass | 100000 | blades, 60 % of them within 45 m of a trail |

Unmarked trails: `quarry-switchbacks`, `ridge-traverse`, `river-run`.

Biomes (`BIOMES`, 7 keys `trail, hardpack, mud, sand, snow, rock, water`) carry
`friction`, `softness`, `viscousDrag`, `maxSinkage`, `waterDepth`, `grip`,
`sinkage`, `dig`, `viscosity`, `rollResistance`, `color`. Trail starts at
grip 0.88 / viscosity 110 / rollResistance 0.028.

Noise: seeded `mulberry32` → permutation → 2D simplex → `fbm(noise, x, y,
octaves = 4, lacunarity = 2.03, gain = 0.5)`.

### 9.3 Build, physics, queries

`await terrain.build(onProgress)` slices work and yields, reporting
`(fraction, label)`. It creates: the ground mesh (chunked ×64, Lambert material,
vertex colours, detail texture), the `CANNON.Heightfield` (`elementSize =
ELEMENT`) added **always** to the world, water plane, prop scatter, foliage mask
and meshes, and the LOD groups. Key methods:

- `getHeightAt(x, z)`, `getSurfaceAt(x, z)` (biome + grip for the vehicle)
- `setAnisotropy(v)`, `setFoliageDensity(d)` (0–1; also culls tree colliders)
- `updateFoliage(dt, trucks)` — wind + push-aside from our truck and teammates
- `updateLOD(camera)` — **prop horizon = `min(viewCutoff, scene.fog.far ?? 320)`**,
  per-group `nearScale`/`maxScale`, full mesh inside near, far proxy between, and
  ground chunks culled past `1.6 ×` that horizon
- `setViewDistance(d)` — clamps `viewCutoff` to 120–320 m
- `updateColliders(x, z, radius = 95)` — add/remove scenery bodies with a 10 m
  hysteresis; sets `world.broadphase.dirty = true`; `colliderStats = { total, live }`

### 9.4 Landmarks

Instanced utility poles (one side of the road), dashed centre lines, canvas-drawn
junction signs, gas stations with refuel radii, pylons, and DOM `notice` text.
`landmarks.update(dt, vehicle, night)` is called every frame and must stay cheap.

### 9.5 Points of interest

`PointsOfInterest` wraps the mission zones in architecture, so a watchtower is a
place you can see from a ridge rather than a circle in the HUD.

| Set | Placement | Count |
| --- | --- | --- |
| Castle keeps | one per `WATCHTOWERS` entry, replacing the timber lookout | 6 |
| Gatehouse + curtain walls | 13–30 m back from `bridgeZone.pos` on dry ground | 1 + 2 |
| Cairns | both shoulders of every `road.kind === 'trail'`, every 62 m | 132 |
| Named signposts | trailhead of each trail; label from a shared canvas atlas | 5 |
| Ruin fields | `RUIN_SITES`: knobbled wall, stub tower, fallen blocks | 3 |

Rules that keep it cheap and safe:

- **Bake once.** `_bake(group)` clones each mesh, applies `matrixWorld` and
  buckets the geometry by material; `_flush()` merges each bucket. The whole
  layer is **17 meshes / ~24.5k triangles**, of which 6 are the live embers.
- **`userData.live`** marks a part whose material is animated elsewhere (the
  beacon ember reuses `tw.beaconMat`), so it survives baking as its own mesh and
  the mission's pulse still reaches it.
- **Nothing here owns state.** `tw.group.visible = false` retires the old timber
  lookout; `tw.keep` keeps a handle for tests. No colliders are added: these are
  scenery, and the vehicle drives through the gate opening by geometry alone.
- **Placement is water-aware.** `_dry(x, z)` rejects `waterGrid > 0` and any
  ground below 1.4 m; if a site is wet it nudges outward (gate: 13→30 m, ruins:
  ±36 m) instead of drowning.
- Builders bake transforms into geometry and leave the group at the origin, so
  `assemble()` can merge freely. Keep that convention when adding a model.

### 9.6 Red-rock country (`MesaField`)

`TerrainSystem` owns the drivable ground, and its vertical scale is fixed by
physics: 4.9 m cells, graded corridors, a carved river and trails that must stay
under `TRAIL_MAX_GRADE`. A 90 m butte is therefore **scenery**, not heightfield.
`MesaField` supplies the relief the heightfield cannot afford.

The rock is no longer a canyon feature: mesas, palms and scrub are placed across
the **whole 2 km map**, and every region's ground palette is the same sandstone
family under its own light (§8.5, `WorldAtlas.REGIONS`).

| Set | How | Count (default seed) |
| --- | --- | --- |
| Massifs | 24 clusters of 2–4 overlapping buttes across all four regions; the first 10 are pinned 70–150 m off the river | ~85 buttes |
| Hero buttes | 7 large walls 95–165 m off the river, radius 34–60, height 55–95 | 7 |
| Lone mesas | one jittered-grid candidate per 170 m cell, 45 % of cells filled, radius 12–30 | ~75 |
| Palm oases | 9 river-bank hearts along the whole river except the alpine reach, plus loose palms on both banks | ~155 palms |
| Scrub | one `InstancedMesh` of faceted icosahedra, clumped by noise | up to 2600 |

Measured on the built terrain with the default seed: 119 mesas, 146 palms, 2600
scrub, **39 176 stone triangles across 127 spatial tiles**. Coverage check on the
same placement code: the nearest butte is 91 m away at the median point of the
map, 197 m at p95, so no horizon is empty.

Rules:

- **256 m spatial tiles, not one mesh.** Every butte, block and talus triangle
  goes into a `SpatialTriangleSoup`; trunk rings and frond ribbons each get their
  own; the scrub is instanced per tile. Geometry and colliders are deterministic
  and unchanged, but `update(camera)` hides whole tiles beyond
  `max(170, viewCutoff × 1.35)` — at the spawn camera only **5** of 127 tiles are
  submitted, instead of the country's whole 39k triangles on every frame and
  again in the water mirror.
- **Non-indexed geometry on purpose.** `computeVertexNormals()` on a non-indexed
  soup gives one normal per face — that is the hard low-poly facet. Do not merge
  or index it.
- **Strata are vertex colours**, `STRATA` bottom to top from oxidised red to
  pale caprock, with a per-face `shade()` jitter so two quads of the same band
  still separate.
- **Profile is a wall, not a cone.** Rings alternate a barely-overhanging ledge
  and a near-vertical face (`shrink 0.18`); a strong lip reads as stacked
  pancakes. About one ring in three is a wide bench.
- **The talus apron follows the ground.** `appendMesa` takes a `groundAt(x, z)`
  callback and drops each outer skirt vertex onto the terrain; a flat skirt ring
  floats above falling ground like a plate under the rock.
- **Placement is water-, road- and building-aware, and world-wide.**
  `_canPlaceMesa` rejects anything within 24 m of the world edge, a wet or
  low footprint (centre **and** a ring at `0.6 × radius`, so a butte cannot
  stand in the river with its talus), a corridor narrower than
  `18 + radius × 0.55` from any graded trail, the proving ground, and every
  keep-out: watchtowers (52 m), gas stations (44 m), signs (24 m), the spawn
  (110 m) and whatever `keepOut` the caller passes — `main.js` passes the mill
  and bridge zones at 70 m. Palms additionally keep 10 m off trails and out of
  the alpine region.
- **Colliders:** each butte gets one oversized static box (radius × 0.78), each
  palm a thin trunk box, all in `PHYS_GROUPS.GROUND`. Rubble blocks are scenery
  only; the scrub has none.
- **No state.** The layer is built once, in the constructor, from the terrain's
  own height grid and river curve; it never updates per frame and co-op clients
  agree because the seed and the terrain are deterministic.

---

## 10. Vehicle physics and construction

> **Rule:** the physics controller in `OffroadVehicle.js` is the one thing that
> visual/builder work must never rewrite. Change `VehicleMeshBuilder.js` or the
> style layers instead.

### 10.1 Collision groups (`PHYS_GROUPS`)

`GROUND: 1`, `RAY: 2`, `VEHICLE: 4`, `REMOTE: 8`. The suspension ray sees ground
but never the body that starts it.

### 10.2 Tune (`TUNE`, exported as `VEHICLE_TUNE`)

| key | value | key | value |
|---|---|---|---|
| `chassisMass` | 1900 kg | `maxCompression` | 0.24 m |
| `comHeight` | 0.98 | `maxDroop` | 0.1 m |
| `attachY` | −0.32 | `springStiffness` | 34 000 |
| `wheelRadius` | 0.46 m | `dampingCompression` | 3 400 |
| `wheelWidth` | 0.3 m | `dampingRebound` | 4 600 |
| `wheelInertia` | 7.4 | `antiRollStiffness` | 9 500 |
| `restLength` | 0.34 m | `antiSquat` | 0.55 |
| `wheelBase` | 2.84 m | `trackWidth` | 1.72 m |
| `throttleRamp` | 0.55 s | `chassisOffsetY` | 0.06 |
| `maxSteerLowSpeed` | 0.56 rad | `maxSteerHighSpeed` | 0.2 rad |
| `steerRate` | 3.4 | `finalDrive` | 4.1 |
| `drivetrainEfficiency` | 0.88 | `idleRpm` / `maxRpm` | 780 / 4400 |
| `maxBrakeTorque` | 2400 | `handbrakeTorque` | 3600 |
| `slipStiffness` | 6.2 | `lateralStiffness` | 1.3 |
| `tankCapacity` | 80 L | PSI | 8–35, ref 20 |
| `maxAngularVelocity` | 6 rad/s | | |

Torque is a 4.2 L turbo-diesel curve interpolated by `torqueAtRpm(rpm)`; throttle
ramps in 0.55 s so it feels turbo-diesel rather than instant.

**Suspension force model — three rules that are easy to break:**

1. **The anti-roll bar lifts the compressed corner.** `arbForce[i] = +k ·
   (compᵢ − comp_opposite)` for the compressed side, negative for the extended
   one. The reversed sign is not a subtle handling preference: it feeds roll
   instead of damping it. Measured, a truck parked across a 23° sidehill went
   onto its roof in 4 s; with the sign correct it settles at 24.5° and stays
   there.
2. **Clamp the bar, not the corner.** Each corner's *total* support ceiling is
   the strut ceiling (`1.15 × weight`); only the ARB term is limited to `0.45 ×
   weight`. Capping the total at 0.45 W meant two wheels could carry at most
   90 % of the truck, so any time the uphill pair unloaded the body had to fall.
3. **Filter before damping.** The damper reads a low-passed shaft speed
   (`dampVel`, ~30 Hz) from the raw ray length. Raw frame-to-frame length on
   this faceted terrain stepped a 3 cm facet into a 2.2 m/s spike and 10 kN on
   one corner.

The bar and the spring use *smoothed* travel (`smoothLen`), never `comp`, which
is the raw ray and therefore full of facet steps.

### 10.3 Gears

`GEAR_ORDER = ['L-', 'L', 'L+', 'AUTO', 'H', 'R']` (re-exported as
`VEHICLE_GEARS`). `Shift` toggles high/low range; `Q`/`E` and the HUD gate move
through the order. The HUD gear strip shows `R / N / A / H / L- / L / L+`.

### 10.4 Surfaces (`SURFACES`)

Schema: `{ key, label, grip, sinkage, dig, viscosity, rollResistance, color }`.
Defined: `hardpack` (grip 0.9, sinkage 0, viscosity 60, RR 0.018),
`mud` (0.35, 0.45, 1100, 0.16), `sand` (0.45, 0.26, 700, 0.13),
`snow` (0.3, 0.5, 500, 0.1), `rock`. Terrain supplies the same fields through
`getSurfaceAt`.

### 10.5 Construction and accessories

`VehicleMeshBuilder` builds a Defender-style 110 from code with a real hierarchy:
chassis frame, aluminium body, glasshouse, interior, sockets. The static body is
**merged** (191 → 11 meshes) for draw-call reasons — keep it merged. Wheel parts
are merged the same way per material (16 → 4 meshes inside each `SpinPivot`,
~48 fewer draws per truck per pass) by `_mergeWheelParts`; the tyre is excluded
because `setTirePressure` rewrites its shared geometry and it owns the mud-map
material.

`PAINT_COLORS` / `PAINT_ORDER` = `yellow, teal, rust, cream, slate`.
`ACCESSORIES` / `ACCESSORY_ORDER` = `snorkel` (Snorkel), `roofRack` (Safari Roof
Rack), `jerryCans` (Jerry Cans — needs the roof rack), `bullbar` (Bullbar +
Winch), `spareWheel` (Spare Wheel — required before the bullbar).
`PSI_RANGE = { min: 8, max: 35, ref: 20 }`; `effectiveTireRadius` shrinks the
radius as pressure drops, which is what makes sand/snow floatation work.

### 10.6 Telemetry

`vehicle.getTelemetry()` returns speed, gear/gearId, rpm/rpmPct, fuel/
fuelCapacity/fuelPct/fuelLpm, psi, sinkage (`sinkCm`), surface label, awd,
diffLock, headlights, accessories map and per-wheel `suspension[]`. It is called
several times per frame by different systems, so keep it allocation-light.

---

## 11. Trailer

`TrailerRig`: two-axle timber trailer, same raycast-strut suspension scheme,
`massEmpty 920 kg`, `massLoaded 3400 kg` (`TRAILER_TUNE`). The drawbar is a
`PointToPointConstraint` added/removed at runtime (`T`). Unhitched it applies a
parking brake. `toggleLoad()` adds/removes timber bundles (mission cargo);
`syncVisuals(alpha)` interpolates like the truck.

Its stability model follows the truck's suspension rules: ray length low-passed
at ~18 Hz, damper shaft speed at ~30 Hz, and anti-roll bars (`antiRollStiffness`
16 000) that lift the compressed corner from smoothed travel. The bar alone is
clamped to `0.45 × trailer weight`; a corner may reach `1.15 × trailer weight`.
Tyre lateral force uses slip angle (`atan2(vLat, max(|vLong|, 2))`, cornering
stiffness 9 rad⁻¹), not raw sideways velocity, and longitudinal/lateral forces
share one friction budget. Overrun brakes follow the truck pedal with a short
lag (`brakeGain` 0.62). The ball joint adds equal-and-opposite yaw damping
(20 000 N·m·s/rad) and a ~70° jackknife stop; `getTelemetry()` exposes `brake`
and `relYaw` for probes.

---

## 12. Camera

`CAMERA_MODE`: `cinematic` ("OVER THE HILL"), `tactical` ("SNOWRUNNER"),
`cockpit` ("INSIDE THE CAB"). `FOCUS_MODE`: `auto`, `wheel`, `trailer` (labels via
`FOCUS_LABEL`). `C` cycles mode, `V` cycles focus, pointer drag orbits, wheel and
pinch zoom, `zoomBy(factor)`. The controller can raycast the ground mask for
collision-aware framing. Photo mode takes the camera over entirely.

---

## 13. Input and controls (complete)

### 13.1 Keyboard (`window.keydown`, repeats ignored)

| key | action |
|---|---|
| `W` / `↑` | throttle |
| `S` / `↓` | brake / reverse |
| `A` / `D` / `←` / `→` | steer (analog-shaped, self-centring) |
| `Space` | handbrake (hold) |
| `Q` / `[` | gear down |
| `]` | gear up |
| `Shift` | toggle high/low range |
| `N` | toggle 4WD |
| `G` | toggle diff lock |
| `Z` / `X` | tyre pressure +2 / −2 PSI |
| `R` | unhitch + reset vehicle |
| `T` | hitch / unhitch trailer |
| `M` | load / unload timber on the trailer |
| `Y` | cycle the OverlandStyle lighting preset |
| `C` | camera mode |
| `V` | camera focus |
| `K` | cycle optimizer preset |
| `F` or `U` | winch attach/release |
| `E` | hand 20 L fuel to a teammate within 6 m (NOT gear up) |
| `H` | help ping (beacon over the truck, broadcast to the squad) |
| `L` / `J` | headlights on/off |
| `P` | photo mode |
| `O` | cycle paint |
| `1`–`5` | fit/remove accessory in `ACCESSORY_ORDER` |
| `B` | camp at the nearest campfire (repair, refuel, skip phase) |
| `Esc` | settings drawer |

`PREVENTED_KEYS` stops the page scrolling for Space/arrows/WASD. `blur` clears
all held inputs.

### 13.2 Pointer, wheel, touch

Canvas pointer events feed orbit (`pointermove`), pinch zoom (two pointers) and
`contextmenu` is prevented; wheel zooms with `1 + deltaY × 0.0012`.
Buttons with `[data-hold]` (`throttle`, `brake`, `steer-left`, `steer-right`) set
`held.*`; `[data-action]` chips run `runAction()`; `[data-accessory]` outside
`#acc-grid` fits accessories; the touch cockpit (in `ExpeditionHUD`) writes
`held.throttleAxis / brakeAxis / steerAxis` and is multi-touch by `pointerId`.

`readDriverInput(dt)` merges digital and analog channels, applies
`steerSensitivity` and `steerCentering` (`rate = 9 × sensitivity` toward the
target, `11 × centering` back), clamps to ±1, and honours an audio-lab override
(`window.__audioLabInput`).

---

## 14. UI, HUD and DOM contract

### 14.1 Shell (`index.html`)

`#app` (canvas), `#boot` (loading, `.done` on first frame), `#fatal`
(`#fatal-message`, `#fatal-detail`, `.show`), `#lobby` (paint grid `#paint-grid`,
accessories `#acc-grid`, play buttons `[data-lobby="solo|host|join|join-go"]`,
`#join-row`, `#join-code-input`, `#copy-room-code`), `#toast`, `#hud`, touch
cockpit `#touch-ui`, settings modal, expedition panels `#panel-gearbox`,
`#panel-psi`, `#panel-squad`, `#gear-grid`, `#psi-slider`, `#squad-list`,
`#squad-count`, `#touch-psi`, `#touch-psi-val`, `#hud-copy-code`,
`#hud-net*`, `#hud-patch`, `#hud-timber`, `#hud-watchtowers`, `#hud-tier`,
`#btn-awd|diff|winch|hitch|refuel|help|camera|tier|touch`, plus the legacy
readouts `#hud-speed|gear|rpm|rpm-bar|fuel|fuel-bar|fuel-rate|psi|sink|surface|
quality|fps|physics|camera|trailer`.

### 14.2 Who owns what

- `UIManager` — lobby overlay, paint/accessory grids, legacy HUD wiring, touch
  buttons, network callbacks, `_inLobby` flag.
- `ExpeditionHUD` — gear gate, CTIS cluster, drivetrain rockers, expedition pill
  (room, squad distances, watchtower/timber counters and the **NEXT** row: the
  objective label + live distance from `MissionManager.nextObjective()`), mobile
  cockpit. Never owns simulation state; calls the same APIs as the keyboard.
- `GraphicsSettingsUI` — three tabs (Graphics & Performance / Controls & Mobile UI
  / Audio & Atmosphere), hardware banner, presets, every optimizer knob.
- `main.js` — the legacy HUD element cache, `toast()`, and the co-op failure
  handler. Note: the Phase-5 `#net-*` panel is gone (`setNetState` /
  `showNetCode` are null-safe no-ops), and `updateHud()` is dead code — the live
  cluster is `ExpeditionHUD`. Neither is required for the game to run.

### 14.3 Rates

HUD/telemetry DOM: **12.5 Hz** (`hudRefresh >= 0.08`). FPS text and smoothing:
10 Hz. Settings drawer: 12.5 Hz. Nothing else writes DOM per frame.

---

## 15. Co-op networking

- **Transport:** PeerJS public cloud for signalling only; gameplay over a reliable
  WebRTC `DataChannel`. STUN: `stun.l.google.com:19302`,
  `stun1.l.google.com:19302`. No TURN: symmetric NATs can fail (documented
  limitation).
- **Addressing:** room code = 3 letters + 3 digits (e.g. `MUD-842`,
  `normaliseRoomCode` accepts `mud 842` etc.); the host's peer id is derived from
  the code (`roomCodeToPeerId`, prefix `oth1-`), so no directory server exists.
  `MAX_PEERS = 3` → 4 trucks.
- **Rates:** `TICK_MS = 50` (20 Hz state), `RUT_BATCH_MS = 100` (10 Hz rut stamps),
  `INTERP_DELAY_MS = 110` (remote trucks render 110 ms in the past),
  `PLAYER_TIMEOUT_MS = 30000` (backgrounded tabs pause rAF).
- **Messages:** `host-sync` (seed, players, missions, spawn), `state-tick`
  (pos/quat/vel/steer/wheels/psi/paint), `rut-stamp` (`[x, z, depth, radius, yaw]`),
  `winch-event`, `fuel-transfer`, `mission-event`, `player-left`, `player-hint`.
- **Topology:** star. The host relays joiner traffic and owns the seed, clock and
  mission state. Remote trucks are `KINEMATIC` mirrors — no client dead-reckons
  another's body. Physics only ever moves the truck its client owns.
- `vehicleSnapshot(body)` produces the compact state payload.

---

## 16. Missions and winch

`MissionManager`:
- **Scout:** three `WATCHTOWERS` on high ground, discovery `radius 13 m`; finding
  one clears its beacon and pushes fog back for everyone.
- **Timber:** a Lumber Mill (`radius 11 m`) loads bundles; the broken bridge
  (`radius 13 m`) takes delivery; `BUNDLES_NEEDED = 2`, `BUNDLE_MIN = 1` → a solo
  driver needs two trips. Delivering both builds a driveable bridge for the room.
  Bridge site search samples a 190 m half-extent on an 8 m grid and prefers a
  water crossing.
- State crosses the wire via `getState()/setState()` and `mission-event`.
- `nextObjective(position)` is the single source of truth for "where now": the
  bridge while `bundlesInTrailer > 0`, else the nearest undiscovered watchtower,
  else the mill while fewer than two bundles are delivered. Returns
  `{ kind, label, zone, distance }` or `null` when everything is done. The HUD
  formats it as `LABEL` + `123 M` / `1.2 KM`.
- **Driver assist** (`driverAssist()` in `main.js`, once per frame): 1.4 s with the
  chassis up-vector below 0.35 → `ON THE ROOF — PRESS R TO RESET` (12 s cooldown);
  5 s of throttle with |speed| < 1.2 km/h → `BOGGED DOWN — WINCH (F) OR RESET (R)`
  (20 s cooldown); tank below 1.5 L once → `TANK EMPTY — CAMP AT A FIRE (B) OR
  REFUEL AT A STATION` (re-arms above 5 L). Every prompt names an existing key.

`WinchSystem`: `F` hooks the nearest cargo (teammate first, then a tree/rock/pole
`WinchAnchor` within 18 m), `F` again releases; `E` transfers 20 L within 6 m.
The cable is a rebuilt `CylinderGeometry` span plus hook sphere. Truck-to-truck
rescues are cooperative: the rescuer reels in and a `force` packet makes the
bogged client pull itself toward the rescuer.

---

## 17. Audio

One `AudioContext`, one bus tree (`engine`, `drivetrain`, `tyres`, `mechanical`,
`ambience`, `ui`), a master limiter and a one-shot voice budget. Every module asks
`SampleLibrary` first and falls back to its own synthesiser. Key behaviours:

- Engine: four RPM layers crossfaded (idle lope → heavy chuff → working band with
  intake honk → hard/thin top end).
- Tyres: one panned voice per wheel, gated on real contact, per-surface character
  (asphalt, gravel, dirt, mud, wet mud, grass, snow, ice, rocks, water).
- Transmission: shift thunk sized by torque, gear whine by speed/gear, diff whine
  under load, shaft rumble, clutch slip.
- Suspension: separate compression/rebound one-shots, cabin creak, equipment rattle.
- Collisions: impulse-driven impact body/tick sets + continuous scrape layer.
- Interior: cab as a filter (HF loss, ~180 Hz resonance, trims).
- Environment: wind with altitude/speed, birds when quiet, separate rain/snow beds,
  stochastic thunder, stream proximity.
- Sample slots live in `assets/audio/manifest.json` (`engine.*`, `tyre.*`,
  `impact.body`, `impact.tick`); 48 kHz / 24-bit, seamless loops, ≈ −3 dBFS.
- `mixer.noise(startAt)` is the only way to get a noise source: it starts the
  loop exactly once, at `startAt` (default: immediately). One-shot bursts pass
  `ctx.currentTime` so the noise begins with its envelope. Never call `start()`
  on the returned node — Web Audio throws `InvalidStateError` and that used to
  reach the fatal overlay.
- `?audiolab` runs `AudioLab`: IDLE → REV → SHIFT → BRAKE → WHEELSPIN → GRAVEL →
  IMPACT → CABIN with per-bus peak metering and clipping counts.
- **Audio is non-fatal.** `VehicleAudioController` wraps its frame step, each
  module's `update`/`attach`, `clunk`, the volume setters, `unlock`, `dispose`
  and the audio lab in `_safe()`. A throw is reported once per label + message
  through `reportFault()` (`console.warn`, recorded in `window.__audioFaults`
  and `getStats().faults`); that layer stays silent and the simulation keeps
  running. One failing layer does not stop the other seven, because each module
  is guarded separately. An audio fault must never reach the `#fatal` overlay.

---

## 18. Style: DNA, overhaul, overland presets

- `StyleDNA` — `TOON_RAMP` (3 bands), `toonifyMaterial/toonify/addInkOutline`;
  inks the truck only; grades fog/hemisphere/bloom/exposure toward the current
  `regionAt()` palette each frame. `celShadeVehicle()` and
  `celShadeProps([roots])` return the count of converted materials.
- `StyleOverhaul` — `PALETTE`, `applyStylePalette()` (runs **before** terrain so
  vertex colours pick it up), flat matte materials, dual-layer fog, water ramp.
- `OverlandStyle` — linear tone mapping (ACES is wrong for this palette), four
  presets (`GOLDEN_MEADOW`, `ALPINE_NOON`, `ALPENGLOW_SUNSET`, `STORM_CONVOY`)
  cycled with `Y`, global `wetness`/`snowLine` uniforms for material factories.
  Presets **latch**; the day phases are the default and any time change clears
  the latch (see §8.5).
- `AtmosphereAndPostFX.PHASES` — the only writer of sun/ambient/fog/exposure
  (`applyPhase`), plus per-phase sky scattering. Retuned for linear: golden is
  the high-key reference (`1.35` sun / `1.18` fill / `0.95` exposure), overcast
  is ambient-dominant (`1.0` key / `1.3` fill, turbidity `16`, Rayleigh `0.5`),
  night is a moonlit phase (sun elevation `16°`, `0.4` key, `1.3` exposure), and
  dawn keeps a low-but-real key at `9°`.
- `StyleOverhaul.SKY_PHASES` — the dome is the visible sky; its colours follow
  `atmosphere.phaseId`.
- Region grading in `StyleDNA` is a **stable weight**, not a per-frame lerp: the
  phase rewrites fog/exposure every frame, so the old `dt * 0.8` nudges were
  invisible. Night weights it to `0.02` because colours mix in linear light.

Order matters: palette → terrain build → materials → toon pass → atmosphere.

---

## 19. Proving ground and instrumentation

`?test` carves a surveyed range in the south-east corner with deterministic zones:

| zone | purpose |
|---|---|
| `PAD` 62 × 40 m hardpack | acceleration / braking |
| `WASHBOARD` | short-wavelength ripples, damper work |
| `WHOOPS` | long rolling bumps, full travel |
| `ARTICULATION` | staggered single-wheel bumps |
| `SIDE SLOPE` | 20 % cross-fall, roll and lateral grip |
| `HILL CLIMB` | 15° rock climb to a plateau |
| `MUD PIT` | deep mud bowl: sinkage, drag, mud pickup |
| `SAND` | loose gravel flat, high rolling resistance |

`auditProvingGround(terrain)` prints a table and stores `window.__provingSurvey`.
`createProvingBench` samples real physics while driving; `createProvingHud` shows
it. Test mode never changes normal play.

---

## 20. Debug console API

Everything below is on `window` after boot. These are the intended instrumentation
hooks; prefer them over editing code to observe behaviour.

| global | contents |
|---|---|
| `__display` | `{ hz, measured, median }` — panel refresh probe |
| `__targetFps` | governor target (always 60) |
| `__perf()` | prints and returns `{ fps, governorFps, target, scale, cap, degrade, tier, preset, calls, triangles, buffer, css, dpr, mesaTiles, boot }` |
| `__inputs` | live `{ keys, held }` — what a stuck-key report should be checked against |
| `__fpsScale` | current dynamic pixel ratio |
| `__fpsDegrade` | current ladder rung 0–5 |
| `__fpsSmoothed` | smoothed frame rate |
| `__governor` | the whole governor state object (§6.2) |
| `__setDegrade(n)` | force a ladder rung (0 = restore) |
| `__game` | `{ audio, vehicle, trailer, cameraController, terrain, rutSystem, networkManager, winchSystem, missionManager, ui, atmosphere, tactile, quality, renderer, scene, camera, world, optimizer, settingsUI, expeditionHUD, landmarks, styleDNA, waterSystem, styleOverhaul, overlandStyle, regionAt, test, testHud, provingGround }` |
| `__boot` | `{ start, buildMs, firstFrame, marks[], longTasks[] }` |
| `__fatal` | `{ message, stack }` when something threw |
| `__inorldHardware` | detected `{ preset, gpu, vendor, cores, memory, mobile, coarse }` |
| `__provingSurvey` | proving-ground audit (test mode only) |
| `__audioLab`, `__audioLabInput` | scripted audio test + its input override |

Common probes:

```js
__game.renderer.info.render            // calls, triangles (autoReset is off)
__game.renderer.getPixelRatio()
__game.optimizer.settings              // live preset object
__game.terrain.colliderStats            // { total, live }
__game.terrain.lodStats                 // groups/chunks/near/far/hidden/ground*
__governor.smoothFps, __governor.windowFps
```

`renderer.info.autoReset = false` — the optimizer resets it after each drawn
frame, so read the stats after a render or via `captureRenderStats`.

---

## 21. Invariants, traps and conventions

1. **`FogExp2` has no `far`.** `QualityManager` still assigns `scene.fog.far` for
   the linear fog it expects; after `AtmosphereAndPostFX` swaps in `FogExp2`, any
   code reading `fog.far` sees the assigned number and silently draws far too much.
   `TerrainSystem.updateLOD` therefore clamps to `min(viewCutoff, fog.far ?? 320)`.
   Do not "fix" this by removing `viewCutoff`.
2. **Never rewrite the vehicle physics controller.** Visual/builder/style changes
   only; `OffroadVehicle.js` physics is the reference behaviour.
3. **One owner per value.** Dynamic resolution belongs to `governor`
   (`optimizer.externalScaleControl` keeps the optimizer out); presets belong to
   `PerformanceOptimizer`; tiers belong to `QualityManager`.
4. **No material recompiles on quality changes.** Only a shadow *type*/enable
   change may set `material.needsUpdate`; `_shadowSignature` keys on that, not on
   map size.
5. **`applySettings` sanitises.** Values are clamped (pixel ratio ≥ 1, draw
   distance 100–350, `fpsCap` ∈ {0,30,60}); a governor scale below the clamp would
   be silently raised.
6. **Never re-apply identical settings.** `applyLadder` diffs before applying;
   `setFoliageDensity` rebuilds grass and tree colliders, which is a visible hitch.
7. **Ladder changes are never persisted** and never mark the preset `CUSTOM`.
8. **`shadowMap.autoUpdate = false`.** If the shadow map stops following the
   truck, the cadence in `frame()` is the thing to check.
9. **PeerJS is a classic script.** Importing it as an ES module breaks the graph;
   `window.Peer` is read lazily.
10. **No assets required.** Textures/sounds are generated; a missing file must
    always have a synthesiser fallback.
11. **Deterministic world.** Keep the seed (`20261113`) and the atlas math stable
    or clients will disagree about terrain.
12. **Hot-loop discipline.** No allocation in the frame path where it can be
    hoisted; DOM writes only on their throttles; telemetry functions are called
    many times per frame.
13. **The zip is a snapshot.** Rebuild it whenever shipped files change (§2.4);
    never include `shots/`.
14. **Menus own the input.** `readDriverInput` returns zeroed controls while
    `settingsUI.isOpen` or a form control has focus, and `keydown` ignores events
    whose target is an input/textarea/select/contenteditable. Without both, arrow
    keys adjust a slider *and* steer, and a key held when the drawer closes keeps
    driving.
15. **Co-op failures are not fatal.** `NetworkManager.onFatal` routes to
    `handleCoopFailure()` (toast + disconnect + lobby reset). Only engine faults
    reach the `#fatal` overlay. The legacy `#net-*` elements no longer exist, so
    `setNetState` / `showNetCode` / `setJoinFormVisible` are no-ops when their
    markup is absent — never index into them directly.
16. **A lost GPU is explained, not frozen.** `webglcontextlost` prevents the
    default and shows the fatal overlay with a reload instruction; settings are
    persisted, so a reload always recovers the player's configuration.
17. **Audio failures are never fatal.** `VehicleAudioController._safe(label, fn)`
    is the only way audio work is invoked from the frame loop; `reportFault()`
    de-duplicates by `label: message`, so a fault that recurs every frame is
    logged once. Never call into a mixer, module or the audio lab unguarded from
    `main.js`, and never let an audio error reach `showFatal()` — the truck, the
    world and the netcode must survive a dead speaker.
18. **An audio node is started once.** `AudioMixer.noise(startAt)` starts the
    shared noise loop itself; callers schedule it by passing a time, never by
    calling `start()` a second time (`InvalidStateError: cannot call start more
    than once`, which reached the fatal overlay mid-drive). The same rule covers
    oscillators and buffer sources: build a new node per one-shot, or start the
    existing one exactly once.

---

## 22. Performance changelog

| commit | change |
|---|---|
| `cc3352b` | merged the truck body (191 → 11 meshes), baked cloud noise into the sky dome, terrain material Standard → Lambert |
| `ab0c60b` | quality cascade behind the resolution floor (last resort before dropping the world) |
| `a1d82d2` | scenery collider streaming around the truck: `world.step` 14.5 ms → 0.08 ms, world bodies 2 868 → ~15 |
| `8394969` | **120 Hz frame budget**: display refresh probe, governor target/cap/floor rewrite, reversible quality ladder, high-refresh boot profile, shadow-cadence and recompile fixes, `viewCutoff` LOD clamp, PMREM gating |
| `071c117` | audit fixes: unreachable timber key → `M`, truthful lobby legend, co-op failures no longer fatal (plus null-safe legacy net helpers), typing/menu input guards, WebGL context-loss message, audio context suspended with a hidden tab |
| `f23f0a2` | gameplay: `MissionManager.nextObjective()` + HUD **NEXT** distance row, driver-assist prompts for rollover, being bogged and a dry tank |
| `9eeb085` | landmarks: `LandmarkModels` + `PointsOfInterest` — castle keeps on the watchtower sites, gatehouse and curtain walls at the river crossing, three ruin fields, 132 trail cairns and named trailhead signposts; whole layer baked to 17 meshes / 24.5k triangles |
| red-rock country | **`MesaField`**: terraced buttes/massifs, palm oases and instanced scrub baked to 4 draw calls / ~11.8k stone triangles; fog floor `1.45 / viewDistance` → `0.6 / viewDistance` (the floor, not the authored haze, was whitewashing the valley); ACES → `LinearToneMapping`; high-key sun/hemisphere; canyon ground retinted to sun-bleached sand; water pulled toward its own colour so the river stays turquoise against a pale sky |
| car stability | **suspension solver fixes**: anti-roll bar sign corrected (it was adding roll — a truck parked across a 23° sidehill rolled onto its roof in 4 s, now holds at 24.5° indefinitely), per-corner support clamp raised from `0.45 W` total to the `1.15 W` strut ceiling (two wheels could previously carry only 90 % of the truck), ARB taken from smoothed travel instead of the raw ray, damper shaft speed low-passed at ~30 Hz, lateral stiffness 0.62 → 1.3 (sidehill creep 1.6 → 0.6 m/s), 6 rad/s angular-velocity clamp against solver artefacts. Corner body roll in a 0.85-lock slalom 29° → 17.3°, rough-ground roll 6.2° → 3.3°, top speed and rest jitter unchanged |
| trailer stability | **yaw/jackknife fixes**: slip-angle trailer tyres replace force-per-m/s lateral grip, overrun brakes stop the 3.4 t trailer pushing through the ball, equal-and-opposite hitch yaw damping (20 000 N·m·s/rad) plus a ~70° stop, filtered trailer suspension and correctly signed anti-roll bars. Loaded 50 km/h slalom 126–180° fold → 6.2–6.3° maximum hitch angle on repeated runs; 50 km/h panic stop straight 15.3 m with 0° fold, braking while turning 16.1°; 70 km/h steer-pulse sway decays to zero; 23° sidehill holds at 24.0° truck / 25.1° trailer with all eight wheels grounded |
| whole-map desert | **one red-rock country**: every region ground repainted into the canyon's sandstone family, terrain paint lerped 74 % to the region tint, snow confined to the alpine band, palms along the whole river; `MesaField` un-gated from the canyon (24 massifs, 7 hero buttes, 48 lone mesas, 2600 scrub → 127 mesas / 155 palms / 41k stone triangles, still 4 draw calls) with footprint-aware water rejection and keep-outs for landmarks, spawn, mill and bridge; HIGH tier raised to 4096 soft shadows, DPR 2.5, 16× anisotropy, 540 m fog, 512² ground detail |
| autumn diorama pass | **reference-style palette**: region ground tints and `BIOME_COLOURS` moved from red sandstone to pale gold field / cool granite / turquoise water, `SKY_PHASES` dawn and golden replaced by bright-day blue with soft white cloud, `MesaField` strata and boulders regraded grey, scrub recoloured to gold/straw; a second tree stand (gold larch, own chunk group and collider list) splits the forest ~50/50 with green fir, trees 1900 → 9000, grass 46000 → 100000 biased to the driving corridor, roads narrowed (1.45× → 1.0×) and the spawn keep-out 110 → 60 m so the drop point is not a bare plain; grade softened to 1.06 sat / 1.04 contrast, sharpen 1.15 → 0.5, light raised to sun 2.2 / hemi 1.9 / exposure 1.45 |
| low-quality path | **desert read without the grade**: fog floor `0.6 / viewDistance` → `0.6 / Math.max(viewDistance, 240)` (at 130 m the old value fogged the mesas to 85% haze by 200 m); palette albedo saturation ×1.15 via `saturate()` in `applyStylePalette` with grade saturation 1.3 → 1.2 — graded frame unchanged (canyon chroma 94.5 → 96.0), ungraded frame +13% chroma (70.2 → 79.4) at the governor's 0.4 pixel ratio |
| phase audit | **every region × every phase checked under linear tone mapping**: presets no longer latch over the clock (night used to render as golden hour), `PHASES` retuned for a linear curve (golden high-key reference, ambient-dominant overcast with turbidity 16 / Rayleigh 0.5, moonlit night, 9° dawn), sky dome follows `phaseId` via `SKY_PHASES`, night water dimmed to a few percent in linear space, region grading made a stable weight (night `0.02`), alpine snow albedo `0xeef2f5` → `0xdfe8f0` with rock painted onto steep faces, coast/alpine ground tints warmed/cooled to match their regions |
| ten improvements | **superresolution budget** (`sqrt(4.2 MP / viewport)` caps the governor, re-applied on resize), **warm-up ceiling** (release after 3 frames or 2.5 s), **loader tips + detected tier line**, **`prefers-reduced-motion`** for spinner/bar/pulse, **input release on blur or tab hide** (a held key never fires keyup on alt-tab), **low-fuel HUD pulse**, **`?preset=` session override**, **shadow-map texel snapping** (stops shadow crawl as the truck creeps), **`__perf()` snapshot**, `__inputs` debug handle |
| high-res / 60 FPS | **native-resolution pass + gated boot**: governor target 120 → 60 with a native 1× floor and optional 1–2× supersampling; degradation now sheds post-FX/shadows/foliage/draw distance instead of shrinking the canvas; loading screen with a progress bar over an inert lobby, three rendered warm frames before release; `MesaField` rebaked into 256 m tiles (127 chunks, ~236k submitted triangles vs ~595k, 39.2k stone triangles); water 128² quads and 90/140 ms mirror cadence; station meshes merged and distance-culled; HIGH shadows 4096 → 2048 and DPR 2.5 → 2; MSAA enabled on LOW |
| low-poly/sharp | **low-poly + crisp pass**: nine-tap unsharp-mask `ShaderPass` (strength 0.9, contrast-gated) after the grade, bloom strength cut across all phases and region palettes (0.34 → 0.16 max) with a 0.32 radius, grade contrast 1.1 → 1.16, five-sided trunks/poles, six-sided pines, 20-facet boulders, all flat-shaded |

Earlier work still in force: 150 m chunked props with distance LOD and far proxies,
catenary wires removed, poles on one side only, shadow pass throttled, water mirror
cadence, ground chunks culled past `1.6 ×` fog, half-res bloom, physics catch-up
capped at 3 ticks, HUD at 12.5 Hz, atmosphere fog scale 0.34.

---

## 23. Verification checklist

**Static**

```bash
for f in src/*.js src/audio/*.js; do node --check "$f" || echo "FAIL $f"; done
```

**Runtime smoke** (any browser)

1. `python3 serve.py` → open the page. `#boot` must gain `.done`; `window.__fatal`
   must stay `undefined`.
2. Start **SOLO EXPEDITION** from the lobby; the truck must settle on its wheels
   (no sinking, no launch), HUD speed/gear/RPM must live-update.
3. Drive through mud and water; check surface label, sinkage, ruts, water splash.
4. `?test`: the proving-ground audit table prints and every zone is reachable.
5. Co-op: host a room, join from another tab with the code; both trucks mirror at
   20 Hz, mission and winch events propagate.

**Performance**

1. `__targetFps` must be `60`; `__fpsScale` must never fall below `1`.
2. Watch `__fpsScale` and `__fpsDegrade` while driving: the ratio may fall toward
   1×, then the ladder should only move when the frame rate is genuinely short and
   should hand rungs back after sustained headroom.
3. `__game.renderer.info.render.calls` after a drawn frame: expect ≈ 500–540 calls
   / ~236k triangles (the mesa tiles are culled), not ~595k.
4. `__game.terrain.colliderStats.live` should stay small (≈ 5–15) and follow the
   truck as you drive; `total` should match the scattered props.
5. `__boot.longTasks` should show no multi-hundred-ms tasks during play.
6. **Cloud VM caveat:** this environment's rAF is pinned to 60 Hz and its virtual
   GPU stalls ~400 ms per canvas readback, so a 60 FPS readout is impossible there
   by construction. Validate with draw-call/triangle counts and JS timings, and
   state honestly that the frame rate itself was not observed.
