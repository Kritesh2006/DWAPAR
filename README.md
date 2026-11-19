# DWAPAR · द्वापर

**An Experiment in Digital Civilization**
*We create the world. They create the future.*

DWAPAR is a persistent, deterministic virtual world intended to eventually host an
autonomous artificial civilization. **Phase 1 builds only the world**: terrain,
climate, water, vegetation, fire, erosion, resources and time. It contains no
inhabitants, agents or animals.

![Drishti observer dashboard showing seed 42 at Year 1, Day 234: terrain map with rivers and lakes, tile inspector, environment statistics, historical charts, resource table, natural event timeline and checkpoint archive](docs/images/drishti-dashboard.jpg)

*The Drishti observatory monitoring world seed 42 at Year 1, Day 234 (autumn). Every value is live engine
state; the fire spike in the history chart is a real lightning-ignited wildfire season.*

## Quick start

Requirements: Python ≥ 3.10, Node ≥ 18 (only to build the dashboard). Everything is
free and open source and runs locally; nothing calls the network at run time.

```bash
# 1. engine dependencies
cd engine
pip install -e ".[dev]"          # numpy, fastapi, uvicorn (+ pytest, httpx)

# 2. dashboard (one-time build; FastAPI serves the built files)
cd ../dashboard
npm install
npm run build

# 3. launch the observatory
cd ../engine
python -m dwapar serve           # → http://127.0.0.1:8000
```

Or just run `./start.sh` from the repo root, which does steps 2 and 3.

### Commands

| Command | Purpose |
|---|---|
| `python -m dwapar serve [--seed 42] [--size 128] [--speed 24] [--paused] [--port 8000]` | API, WebSocket and dashboard; the world runs in a background thread |
| `python -m dwapar run [--days N] [--speed 0]` | Headless run with no dashboard. Ctrl-C/SIGTERM saves a final checkpoint |
| `python -m dwapar bench [--size 128] [--days 10]` | Measure engine performance |
| `cd engine && pytest` | Run the test suite |
| `cd dashboard && npm run dev` | Dashboard dev server on :5173 (proxies to the engine on :8000) |

`--speed` is in **simulated hours per real second**; `0` means as fast as possible.
The world database defaults to `data/dwapar.sqlite`. Restarting either command
**resumes the most recent checkpoint**; delete the file to start a fresh world.

## What you get

- A seeded procedural world (128×128 by default; 256² and 512² are tested) with
  ocean, lakes, rivers, wetlands, desert, plains, forest, hills, mountains and snow.
  Terrain classes are derived from the physical state every simulated day.
- Coupled processes: solar day/night and seasons → temperature → evaporation →
  wind-borne humidity → precipitation/snow → infiltration, runoff and rivers → soil
  moisture → vegetation → fuel and dryness → lightning wildfires → organic matter →
  fertility, plus fluvial and thermal erosion.
- Ten resources at physical locations: freshwater, saltwater, wood, stone, sand, clay,
  iron ore, copper ore, coal and organic matter. Minerals are finite; wood, freshwater
  and organic matter renew only through physics.
- A clock with start, pause, resume, single-step and adjustable speed. Results are
  identical at any speed or frame rate.
- SQLite persistence: automatic checkpoints, SHA-256-verified restore, event
  timeline, and daily statistics history.
- The Drishti dashboard: zoomable map with 12 layers, tile inspector, clock and speed
  controls, environment and resource panels, historical charts, event timeline, and
  save/load/new-world controls.

## Repository layout

```
engine/dwapar/
  config.py        WorldConfig (validated, serialisable)
  rng.py           deterministic random streams keyed by (seed, stream, tick)
  grid.py          neighbourhood / flow-routing helpers
  brahmanda/       world state, generation, terrain classification, resources
  kala/            calendar + real-time runner
  prakriti/        solar geometry and coupled natural processes
  smriti/          SQLite store (checkpoints, events, stats)
  api/             FastAPI + WebSocket server (Drishti backend)
  prana/ buddhi/   reserved, intentionally empty
  simulation.py    Simulation: the only thing that advances the world
  observatory.py   owns sim + store + runner; recovery and shutdown
engine/tests/      pytest suite
dashboard/         React + TypeScript + Canvas observer UI
```

See ARCHITECTURE.md (design), WORLD_LAWS.md (the physics and its simplifications),
CONSTITUTION.md (rules), TASKS.md (status), JOURNAL.md (history), DECISIONS.md
(reasoning) and ROADMAP.md (future phases).
