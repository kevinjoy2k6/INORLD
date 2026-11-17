# Recording slots for the vehicle audio

The game makes every sound it needs from synthesis. This folder is where your own
recordings replace that synthesis — no code changes, no rebuild: drop files in,
map them in `manifest.json`, reload.

## How it works

`src/audio/SampleLibrary.js` reads `assets/audio/manifest.json` once the audio
context starts. Every module asks the library first and falls back to its own
synthesiser if the slot is empty or the file is missing, so a half-filled folder
is a supported state rather than a broken one.

- `loops` maps an id to one file. That file loops for as long as the layer is
  active and its pitch (playback rate) follows the engine or wheel speed.
- `sets` maps an id to a list of files. One is chosen at random per event, so a
  single impact does not repeat.

## Source format

| Property | Value | Why |
| --- | --- | --- |
| Container | WAV | No decoder drift, no bitrate artefacts on a loop point |
| Sample rate | 48 kHz | Matches the context rate, so no resampling on playback |
| Bit depth | 24-bit | Headroom for engine layers that are later filtered and compressed |
| Channels | mono for loops, mono or stereo for impacts | Loops are panned by the wheel/engine position; mono keeps that honest |
| Loudness | peak ≈ −3 dBFS, similar across files | The mixer trims layers, not amplitudes |
| Loop | seamless, loop point on a zero crossing | A click at 30 Hz reads as a fault in the engine |

Two checks before you add a file:

1. **The loop seam.** Copy the file twice, play it, and listen at the join. If you
   cannot hear the join, the loop point is good.
2. **The level.** Peak-normalise to about −3 dBFS. A file that is 10 dB hotter
   than the rest will dominate the mix even after the module trims it.

## Engine layers

Four loops, each recorded at a steady state, crossfaded by real RPM:

| Id | Record at | Notes |
| --- | --- | --- |
| `engine.idle` | warm idle, 600–750 rpm | no throttle movement, no turbo whistle |
| `engine.low` | 1200–1800 rpm under load | exhaust closed, heavy chuff |
| `engine.mid` | 2000–2800 rpm under load | intake audible |
| `engine.high` | 3200 rpm upward | hard, thin, mechanical edge |

Record each one long enough (8–15 s) that the ear cannot pick up the loop, and at
a constant RPM: the game pitches them by RPM within the band, so a loop recorded
while revving will fight that.

Startup, shutdown, overrun crackle and turbo spool stay synthesised — they are
short, transient, and very hard to record cleanly. They will mix with your loops
as they are.

## Tyres

One loop per surface. Record them at a steady 30–45 km/h on a straight line, then
trim to 3–6 s. The game sets the playback rate from wheel speed, so a loop
recorded at 40 km/h will run at about 1.0 there and shift around it elsewhere.

Ids: `tyre.asphalt`, `tyre.gravel`, `tyre.dirt`, `tyre.mud`, `tyre.wetmud`,
`tyre.grass`, `tyre.snow`, `tyre.ice`, `tyre.rocks`, `tyre.water`.

## Impacts

`impact.body` and `impact.tick` are sets. Give each 4–8 variations; the game picks
one at random and scales its gain by the real collision velocity, so record them
at a consistent level and let the physics decide how loud a hit is.

## Adding a file

```json
{
  "loops": {
    "engine.idle": "engine/idle.wav",
    "tyre.gravel": "tyres/gravel.wav"
  },
  "sets": {
    "impact.body": ["impact/body-01.wav", "impact/body-02.wav", "impact/body-03.wav"]
  }
}
```

Paths are relative to this folder. Absolute paths and `http(s)` URLs also work.
`catalogue` is documentation only and is ignored by the loader.

## Verifying

Open the game with `?audiolab` and it runs a scripted test drive: idle, revving,
shifting, braking, wheelspin in mud, gravel, a chassis impact, then the cab view.
The console prints a table of peak level and clipping per bus for each phase, and
warns if a phase that should make noise stayed silent.
