# Journal

## Session 1 — 2026-11-19 · Phase 1 founding build

**Implemented**
- Repository, packaging (`engine/pyproject.toml`), launcher (`start.sh`).
- Brahmanda: seeded value-noise fBm and ridged noise from scratch; elevation with
  ocean falloff and quantile sea level; priority-flood depression filling (initial
  lakes); D8 flow accumulation (initial river flux); soils, vegetation, snow and six
  geological deposits; terrain classification derived from physical state;
  resources view and `extract()` gateway.
- Kala: tick-derived calendar; real-time runner (speed in sim-hours per second, max
  mode, pause/resume/single-step, error halting).
- Prakriti: solar geometry; hourly temperature, evaporation and transpiration,
  advection, precipitation and snow, melt, infiltration and baseflow, runoff, and fire;
  daily drought counters, vegetation, decomposition, erosion, reclassification and
  calendar events.
- Smriti: SQLite (WAL) store with SHA-256-verified compressed checkpoints, pruning,
  events, daily stats and history truncation on rewind.
- Drishti: FastAPI + WebSocket server; React/TS dashboard with canvas map (zoom, pan,
  hillshade, fire overlay, 12 layers), tile inspector, clock and speed controls,
  environment and resource panels, six history charts, event timeline, and
  save/load/new-world.
- All nine project documents.

**Tested**: 64 automated tests, all passing (see TASKS.md for the exact run). Manual
checks: headless SIGTERM shutdown → resumed from the shutdown checkpoint; SIGKILL →
resumed from the latest auto checkpoint; dashboard screenshots in headless Chrome
showing live state.

**What failed along the way (and was fixed)**
- First terrain mix had about 30 % snow and no desert (latitudes too poleward, land too
  high). Retuned the elevation exponent, latitude span and moisture proxy.
- Thermal erosion was about 2,500× too strong: 92 coastal tiles drowned in 60
  simulated days. Lowered the coefficient and added a coastal floor.
- `test_engine_refuses_to_continue_from_invalid_state` failed: a corrupted ocean tile
  was overwritten by a later process before periodic validation ran, silently hiding
  the corruption. `step()` now validates before advancing.
- Dashboard review exposed a vegetation seam at 25° latitude (an abrupt wind reversal)
  and axis-aligned river tie-breaking. Smoothed the wind belt and added micro-relief for
  direction choice. Parallel rivers on genuinely planar ramps remain (documented).

**Incomplete**: see the open items in TASKS.md.

**Next**: MFD routing; horizontal heat transport; sediment deposition; optional spin-up;
CI; dashboard UI tests. Phase 2 requires explicit owner authorisation.

## Session 2 — 2026-11-19 · Publication to GitHub

- Connected the local repository to https://github.com/Kritesh2006/dwapar (remote was empty:
  no branches, no commits). Pushed `main` with the full Phase 1 history; no force-push.
- Pre-push audit: 57 tracked files, no secrets, credentials, caches, virtual environments,
  `node_modules`, builds or databases.
- Added the dashboard screenshot (`docs/images/drishti-dashboard.jpg`) to README.md and a
  `CLAUDE.md` naming this repository as the single source of truth for future sessions.
- Re-ran the test suite before pushing (result recorded in TASKS.md).
- No engine or world changes this session. Phase 2 not started.
