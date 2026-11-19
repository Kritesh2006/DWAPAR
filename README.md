# DWAPAR · द्वापर

**An Experiment in Digital Civilization**
*We create the world. They create the future.*

DWAPAR is a persistent, deterministic virtual world intended to eventually host an autonomous
artificial civilization. The world comes first.

- **Phase 1** built the world: terrain, climate, water, vegetation, fire, erosion, resources and time.
- **Phase 1.5** ("The Age Before Life", current) deepens its laws: river networks, ocean currents,
  groundwater, sediment, tectonics and volcanoes. It also runs the world for long periods to test
  its stability.

There are no organisms, inhabitants, agents or animals.

![The Drishti observatory: full-screen living-planet map in black and gold, with observation layers on the left, planet vitals and conservation audit on the right, and the world timeline and history charts below](docs/images/drishti-dashboard.jpg)

*The Drishti observatory watching world seed 42 at age 34 years (resumed from the long-term experiment). Rivers, lakes, deserts, snow and deltas emerged from the simulated physics; everything on screen is live engine state.*

## Windows quick start

You need [Python 3.10+](https://www.python.org/downloads/) (tick **"Add python.exe to PATH"**) and
[Node.js LTS](https://nodejs.org/) (only to build the dashboard). Then, in the project folder:

| Double-click | What it does |
|---|---|
| **`setup.bat`** | One-time setup. Creates `.venv`, installs the engine, builds the dashboard. Run it again after pulling updates. |
| **`start.bat`** | Starts the world in a window named *DWAPAR engine* and opens the observatory in your browser at http://127.0.0.1:8000. Close that window to stop. The world is saved and resumes next time. |
| **`start-headless.bat`** | Runs the world with no dashboard, as fast as the computer allows. Press Ctrl+C to stop. |

Options can be passed on a command line, for example `start.bat --seed 7 --size 192`,
`start-headless.bat --days 360`, or `start-headless.bat experiment --budget-minutes 60` (advances
the long-term experiments; see EXPERIMENTS.md).

> The `.bat` scripts were written and reviewed carefully, but they have **not yet been run on a
> real Windows machine**, because development happens on Linux. Please report any problem.

## macOS / Linux quick start

```bash
cd engine && pip install -e ".[dev]"            # numpy, fastapi, uvicorn (+ pytest, httpx)
cd ../dashboard && npm install && npm run build   # one-time dashboard build
cd ../engine && python -m dwapar serve            # → http://127.0.0.1:8000
```

Or run `./start.sh` from the repo root.

### Commands (run inside `engine/`)

| Command | Purpose |
|---|---|
| `python -m dwapar serve [--seed 42] [--size 128] [--speed 24] [--paused] [--port 8000]` | Simulation + API + observatory |
| `python -m dwapar run [--days N] [--speed 0]` | Headless run; Ctrl-C/SIGTERM saves a final checkpoint |
| `python -m dwapar experiment [--name seed42-128] [--budget-minutes 30]` | Advance the resumable long-term experiments |
| `python -m dwapar bench [--size 128] [--days 10]` | Measure engine performance |
| `pytest` | Run the test suite |

`--speed` is in **simulated hours per real second**; `0` means as fast as possible. The world
database is `data/dwapar.sqlite`. Every launch **resumes the most recent checkpoint**; delete that
file to start a fresh world.

## What the world contains

- **Terrain.** A seeded procedural planet patch (128² by default, 256² and 512² tested) with ocean,
  lakes, rivers, wetlands, desert, plains, forest, hills, mountains and snow. Terrain classes are
  derived from physical state every simulated day.
- **Climate.** Solar seasons and day/night. Ocean mixed layer moved by currents; winds carry heat
  and moisture; precipitation, snow and melt.
- **Water.** Groundwater aquifers with springs and capillary rise; multiple-flow-direction river
  networks.
- **Vegetation.** Vegetation and soil carbon as continuous fields (not organisms),
  plus lightning wildfires.
- **Geology.** Erosion → sediment transport → deposition (deltas, alluvium). Plate tectonics with
  uplift, subsidence and earthquakes; volcanoes erupting lava and ash.
- **Disasters.** Eruptions, earthquakes, wildfires, floods and droughts, all detected from state.
- **Resources.** Ten resources at physical locations (freshwater, saltwater, wood, stone, sand,
  clay, iron ore, copper ore, coal, organic matter), with audited budgets.
- **Conservation.** Water, rock mass and mineral budgets are audited and close to ~10⁻¹⁶.
- **Time.** Deterministic and reproducible, identical at any speed or frame rate. Checkpoints are
  SHA-256 verified, and the world recovers after a crash or power loss.

## The observatory (Drishti)

- **Living-planet view.** A full-screen map with animated river flow, clouds drifting on engine
  winds, rain, wildfire and lava glow, and day/night, all driven by engine data.
- **Observation layers.** 16 environmental heatmaps and 10 resource distribution maps.
- **Disaster tracker.** Map markers and fly-to for every recorded disaster.
- **History.** A world timeline and history charts.
- **Planet panel.** Planet vitals and the live conservation audit.
- **Controls.** Six simulation speeds, PNG screenshot export, and a world archive for selecting
  worlds, restoring checkpoints and generating new worlds.

Rendering runs on its own animation loop and never touches the simulation.

## Repository layout

```
engine/dwapar/
  config.py         WorldConfig (validated, serialisable)
  rng.py            deterministic random streams keyed by (seed, stream, tick)
  grid.py           neighbourhoods, MFD routing, advection helpers
  brahmanda/        world state, generation, tectonics, terrain classes, resources
  kala/             calendar + real-time runner
  prakriti/         solar geometry, coupled processes, spin-up
  smriti/           SQLite store (checkpoints, events, stats, upgrades)
  api/              FastAPI + WebSocket server (Drishti backend)
  experiment.py     resumable long-term experiment harness
  prana/ buddhi/    reserved, intentionally empty
engine/tests/       pytest suite
dashboard/          React + TypeScript + Canvas observatory
experiments/        committed experiment results (JSONL) and status
setup.bat start.bat start-headless.bat   Windows launchers
```

See EXPERIMENTS.md (long-term results), WORLD_LAWS.md (the physics and its simplifications),
ARCHITECTURE.md, CONSTITUTION.md, TASKS.md, JOURNAL.md, DECISIONS.md and ROADMAP.md.
