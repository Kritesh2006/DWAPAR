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
