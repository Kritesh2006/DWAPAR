# Architecture

```
                 ┌───────────────────────── Drishti (dashboard/) ─────────────────────────┐
                 │ React + TS · Canvas map · SVG charts · polls layers, listens on /ws    │
                 └───────────────▲───────────────────────────────▲────────────────────────┘
                         HTTP JSON (layers, tiles, stats)    WebSocket (status 2 Hz)
                 ┌───────────────┴──────────── api/server.py ────┴────────────────────────┐
                 │ FastAPI. Observes and issues clock commands; never edits world state.   │
                 └───────────────────────────────▲─────────────────────────────────────────┘
                                         observatory.py
                     ┌───────────────────────────┼──────────────────────────────┐
                     │                           │                              │
              kala/runner.py              simulation.py                   smriti/store.py
          real-time thread: speed,   step(n): Prakriti hourly + daily,    SQLite (WAL): worlds,
          pause/resume/step          validation, events, stats,           checkpoints (npz+sha256),
                                     auto-checkpoint                      events, stats
                                           │
                     ┌─────────────────────┼──────────────────────┐
              brahmanda/                prakriti/                kala/calendar.py
         world.py  generate.py      solar.py  processes.py      tick → hour/day/season/year
         terrain.py resources.py
```

## Systems

| System | Package | Responsibility |
|---|---|---|
| **Brahmanda** | `brahmanda/` | World state container (`World`), procedural generation, terrain classification, resource accounting and extraction |
| **Kala** | `kala/` | Calendar derived purely from the tick counter, plus a real-time `Runner` thread |
| **Prakriti** | `prakriti/` | Solar geometry and all coupled natural processes (hourly and daily) |
| **Smriti** | `smriti/` | Durable state: checkpoints, natural event timeline, daily statistics |
| **Drishti** | `api/` + `dashboard/` | Observation only |
| Prana, Buddhi | `prana/`, `buddhi/` | Reserved, empty |

## Key design properties

**State is a bundle of named float64 rasters** (`World.f`) plus a `uint8` terrain
raster, an integer tick and a small JSON `meta` dict of counters. Everything is
vectorised with numpy; no per-tile Python loops run during simulation.

**Time is a single integer.** `Calendar.at(tick, cfg)` derives hour, day, season and
year, so time cannot become inconsistent and a checkpoint stores only the tick.

**Randomness is a pure function** of `(seed, stream, tick)` (PCG64 via
`SeedSequence`). There is no RNG state to save, so a world restored at tick T continues
bit-for-bit like an uninterrupted run (tested).

**One mutation path.** Only `Simulation.step` changes the world, under an `RLock`.
API reads take the same lock, so they never see a half-updated tick. The runner thread
calls `step`; the dashboard only reads.

**Two process rates.** Fast processes (radiation, temperature, evaporation,
atmospheric transport, precipitation, snowmelt, infiltration, runoff, fire) run every
tick (1 simulated hour). Slow processes (vegetation, decomposition, erosion, drought
counters, terrain reclassification, statistics, checkpoints) run once per simulated day.

**Validation.** `World.validate()` (≈0.4 ms at 128²) runs before every `step()` call
and every 24 ticks. Any NaN, negative mass, or out-of-range value raises
`InvalidStateError`. The runner stops and records an `engine_halt` event instead of
continuing.

**Persistence and recovery.** Checkpoints are `np.savez_compressed` blobs (≈1.4 MB at
128²) with a SHA-256 checked on load. Automatic checkpoints are written every
`checkpoint_every_days` (default 5) and pruned to the newest 12. Genesis, manual and
shutdown checkpoints are kept. On start, `Observatory` resumes the most recent
checkpoint. After a hard kill, at most 5 simulated days are lost. Loading an older
checkpoint truncates later events and stats, because that future never happened.

**Frame-rate independence.** The runner converts real time to an integer number of
ticks. The dashboard pulls rasters at most about once a second. Neither affects
outcomes: stepping 240 ticks at once and one at a time give identical fingerprints
(tested).

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | clock, speed, measured ticks/s, last step time, errors |
| GET | `/api/config` | full WorldConfig |
| GET | `/api/layer/{name}` | base64 float32/uint8 raster + min/max; names: terrain, elevation, temperature, moisture, vegetation, water, minerals, fertility, snow, precipitation, fire, fire_risk |
| GET | `/api/tile/{x}/{y}` | every physical property and resource quantity of one tile |
| GET | `/api/stats`, `/api/stats/history` | current and daily-history environmental and resource statistics |
| GET | `/api/events` | natural event timeline |
| GET | `/api/checkpoints` | worlds and checkpoints |
| POST | `/api/control` | `{action: start\|pause\|resume\|step, ticks}` |
| POST | `/api/speed` | `{hours_per_second}` (0 = max) |
| POST | `/api/save`, `/api/load`, `/api/new` | save, restore, generate |
| WS | `/ws` | status (+ fresh events) every 500 ms |

## Scaling notes

The hot path is about 8 neighbour shifts per routing call, done twice per tick
(water flow and fire spread). Cost is linear in tile count: about 5.5 ms/tick at 128²,
23.5 ms at 256² and 125 ms at 512² (see TASKS.md). Generation uses one Python-loop
pass (priority-flood plus flow accumulation), which dominates at 512² (≈2 s). Options
for larger worlds are listed in ROADMAP.md.

## Phase 1.5 additions (engine 0.2)

**New state fields.** Dynamic: `groundwater`, `sediment`, `sst`, `tectonic_stress`, `lava`.
Static (pure functions of the config, recomputable): `plate_id`, `uplift_rate`, `stress_rate`,
`volcano`, `aquifer_capacity`, `current_u`, `current_v`. Checkpoints from engine 0.1 are upgraded on
load (`smriti/store.py::_upgrade_fields`): static fields are recomputed exactly and new stores start
empty.

**Process order per tick:** radiation → ocean mixed layer (relax, exchange, currents) → wind heat
transport → air relaxation → evaporation → moisture transport → precipitation → melt → soil →
groundwater (percolation, capillary rise, springs) → MFD runoff → fire.
**Per day:** drought counters → vegetation → lateral groundwater → erosion/sediment/deposition →
tectonics and earthquakes → volcanism → lava cooling → reclassification → disaster detection →
calendar events.

**Budgets.** `Simulation.budgets()` and `budget_errors()` audit water, rock mass, sand+clay, stone
and ores against the genesis baseline stored in `world.meta["baseline"]`. The API exposes them at
`/api/budgets`.

**Experiments** (`engine/dwapar/experiment.py`). Each experiment has a local working SQLite store
(`data/experiments/`, not committed). After every recorded year it also writes a *portable* latest
checkpoint (`experiments/checkpoints/<name>.npz`, committed), so a fresh clone or a new cloud session
resumes instead of restarting. Results go to `experiments/results/<name>.jsonl`: one record per
recorded year, tagged with the engine git commit. Progress is in `experiments/status.json`.
SIGTERM/SIGINT stop cleanly.

**Observatory rendering** (`dashboard/src/render/Renderer.ts`). Two clocks are kept apart. The
*data clock* is ~1 Hz `/api/frame` pulls (13 layers captured under one engine lock, so they
describe the same instant); it rebuilds the base bitmap. The *paint clock* (requestAnimationFrame)
only extrapolates cosmetic motion from engine data: particles follow `flow_dir`, clouds drift by
engine wind × elapsed simulated time, rain is drawn where the last hour's precipitation fell, and
fire flickers. Nothing rendered feeds back into the engine.

**API additions:** `/api/frame?layers=…`, `/api/dynamics` (winds, currents), `/api/budgets`,
`/api/load_world`, resource layers `res_<name>`, visual layers (`clouds`, `rain`, `insolation`,
`flow_dir`, `lava`, `sst`, `groundwater`, `sediment`, `uplift`, `plates`, `volcanoes`, `stress`).

## Session 4 additions (engine 0.3, laws 1.6)

**Laws versioning** (`engine/dwapar/laws.py`). `LAWS_VERSION` changes whenever physics changes
outcomes. Worlds store `meta.laws_version` and `meta.laws_history` (`[{from_tick, laws}]`).
`Simulation.from_checkpoint()` calls `adopt_current_laws()`, which appends the switch and logs a
`laws_change` event. Checkpoints from older engines load: missing fields are filled by
`_upgrade_fields`, with `ice` starting at zero and `sea_level` at 0.

**Cryosphere and sea level** run daily, after volcanism: `_cryosphere` (compaction, sublimation,
melt, Glen-law flow via `mfd_flow`, calving), then `_sea_level`. `World.is_ocean` is
`elevation < meta.sea_level` everywhere. The API exposes `sea_level` in `/api/frame` and
`/api/status`, plus the `ice` layer.

**Experiments by laws version.** Each version has its own directory:
`experiments/laws-<v>/{results,checkpoints,status.json}` plus `data/experiments/laws-<v>/`. A
`start_from` spec continues an older world under new laws. Records carry `laws_version` and
`laws_history`, and milestones count only the years simulated under the current laws.

**Performance (bit-identical).** `mfd_flow` reads padded views and accumulates in place; solar
geometry is evaluated per latitude row; fire spread is skipped when nothing burns.
`tests/test_performance.py` compares against verbatim copies of the 0.2 code, and three golden
fingerprints were unchanged. A/B best-of-6 at 128²: 6.93 → 5.45 ms/tick (−21 %). The new laws-1.6
processes then add about 0.3 ms/tick.

**3D world** (`dashboard/src/render3d/`, lazily loaded, the default view). Three.js r170, true
scale (1 unit = 1 m), logarithmic depth buffer. It is built only from engine frames and never
writes to the engine.

| Module | Role |
|---|---|
| `heightfield.ts` | The shared height function, in TypeScript (CPU) and GLSL (GPU) with the same formulas: `H = macro − riverCarve + detail`. **macro** is a Catmull-Rom interpolation of the engine's 2 km elevations; it passes exactly through every tile centre (unit-tested). **detail** is deterministic value noise, 12 octaves from 3.2 km to 1.6 m, seeded by the world seed. Its amplitude comes from height above sea (plains, hills, mountains), it is zero at the coastline, calmed by 95 % along river valleys and lake beds, and zero-mean (the bias of ridged noise is measured and removed). Beyond the map edge the ground sinks to −1.5 km over 14 km. Also `fieldWarp` (organic, under one tile, used for looking up surface fields) and `canopyFrac` (tree cover, shared by the shader and tree placement). |
| `hydro.ts` | Hydrography from simulated water. Rivers are tiles with discharge ≥ 0.6 mm/h, linked along engine flow directions, smoothed with deterministic meanders (≤ 0.22 tile), and given width from discharge. Lakes are connected lake tiles at their median engine water level. Rasterises a channel/valley mask texture. |
| `terrain.ts` | Quadtree LOD. One shared 32×32 grid with skirts is placed and scaled per chunk (leaf 128 m = 4 m spacing; never coarser than ~half a tile). Height and normals are computed in a patched `MeshStandardMaterial` vertex shader; each LOD level skips octaves it cannot represent. The fragment shader blends surfaces from slope, altitude and the simulated fields, adds close-range albedo and bump detail, and draws optional heatmap and simulation-grid overlays. A patched depth material casts shadows. |
| `water.ts` | Ocean plane at the engine sea level, tinted by depth (Gerstner-style wave normals, foam in the shallows, PMREM sky reflections). Lake planes clipped to the engine lake mask. River ribbons with a minimum on-screen width, flow-scrolled ripples, a water level that never runs uphill, and a small distance-based lift so coarse distant terrain cannot hide them. |
| `scatter.ts` | Trees, rocks and grass near the camera, in cells keyed by the world seed. Density, species, size, treeline and exclusions (sea, lakes, river channels, snow, deserts, steep slopes) come from the simulated fields at that spot. Instanced leaf-card trees use a procedurally drawn leaf and needle atlas, in near and far LODs, with wind sway. |
| `controls.ts` | Free-flight camera. Orbit around the ground under the cursor, look around when near the ground, grab-pan, wheel fly-to-cursor, and WASD with speed scaled by height. Terrain-following walk at 1.7 m eye height, collision, and wall-clock fly-to animations. |
| `World3D.ts` | Orchestrator. Field and elevation textures; river network rebuilt only when the river tiles change (at most once a minute while running); sky, environment map and sun from the engine calendar (`sunVector`, unit-tested); camera-following shadow frustum; altitude-dependent haze; cloud deck whose covered fraction matches the engine's cloud cover; CPU ray-march picking; quality presets with auto-downgrade; render statistics. |

The renderer has its own animation loop and never writes to the engine.

**CI** (`.github/workflows/ci.yml`):
- Linux pytest.
- A Windows job that runs `setup.bat`, the engine tests, `start-headless.bat` and `start.bat` on a
  real Windows runner.
- A dashboard job: type-check, build, Vitest unit tests, and Playwright end-to-end tests that
  start a real engine and drive both the 2D map and the WebGL 3D world (including flying to
  ground level and back, with any shader compile error failing the test).
