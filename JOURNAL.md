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

## Session 3 — 2026-11-19 · Phase 1.5: The Age Before Life (authorised by owner)

**Implemented**
- **Laws.**
  - MFD runoff and fine generated relief.
  - Ocean mixed layer with coast-blocked currents; wind heat transport.
  - Groundwater: percolation, springs, capillary rise, lateral flow.
  - Erosion → sediment transport → deposition into sand/clay.
  - Climate spin-up with vegetation and soil-carbon equilibrium.
  - Voronoi plate tectonics: uplift, subsidence, earthquakes, landslides; volcanoes erupting lava
    and ash.
  - Flood and drought detection.
  - Audited budgets for water, rock mass, sand+clay, stone and ores, shown live in the dashboard.
  - Checkpoint upgrade path from engine 0.1.
- **Experiments.** Resumable harness (`python -m dwapar experiment`), sparse yearly records tagged
  with the engine commit, portable checkpoints committed to git, clean stop on SIGTERM,
  `python -m dwapar.report`.
- **Observatory.** Black-and-gold rebuild with a standalone renderer: living-planet view, animated
  data-driven rivers, clouds, rain, fire, lava and day/night; 16 heatmaps; 10 resource maps;
  disaster tracker; world timeline; 6 speeds; PNG export; world archive.
- **Windows.** `setup.bat`, `start.bat`, `start-headless.bat`, plus `.gitattributes` for CRLF.

**What failed, and how it was found and fixed**
1. *Ocean heat advection piled heat at coasts:* 93 °C air during spin-up, caught by `validate()`.
   Coast-blocked currents are divergent; switched to advective form.
2. *Two tests encoded Phase 1 laws* (sand never increases; elevation sum conserved). Replaced with
   audited-budget tests, because the laws changed on purpose.
3. *Test-authoring errors:* a cone built as a pit (double negation), and a tectonics test assuming
   every map has both boundary types.
4. Visual inspection of the running dashboard revealed four physics defects that **every
   conservation test passed through**:
   - **Checkerboard flow instability:** lake surfaces sloshed ~250 m/h because 8 donors could
     overfill one receiver. Flow fraction 0.45 → 0.05; stability test added.
   - **Rivers were mostly instability artefacts.** The threshold was recalibrated from the real
     discharge distribution to 0.6 mm/h.
   - **Aquifers drained 93 % in 117 days:** lateral flow limited to 0.5 %/day.
   - **Erosion ran at 97 mm/yr:** raw 45° cliffs were collapsing. Slopes are now relaxed at
     generation and measured to sea level; talus and fluvial coefficients recalibrated, giving
     0.3 mm/yr.
5. The first experiment runs used the defective engine. They were stopped, archived as
   `experiments/pilot-superseded/` (not used for conclusions) and restarted on the fixed engine.
6. *Harness bug:* SIGTERM killed workers without saving status. Now handled.
7. *Planning gap:* experiment checkpoints were local-only, so a new cloud session could not
   resume. Portable checkpoints are now committed.

**Tested**: 87 automated tests pass (126 s); dashboard type-checks and builds; headless-Chrome review shows no page errors. Experiments: 100 years (64²) and 34 years (128²) on engine 9acf670, all budgets closed.

**Incomplete**: 1,000- and 10,000-year experiments; Windows scripts not executed on Windows;
glacier dynamics; dynamic sea level.

**Next**:
- Resume the experiments (`start-headless.bat experiment --budget-minutes N`, or the CLI).
- Implement glacier flow / ablation before millennial runs.
- Improve spin-up length.
- Run the `.bat` files on Windows.
- Profile and optimise for 10,000-year runs.

## Session 4 — 2026-11-19 · Laws 1.6, 3D world, CI

**Owner's priorities:** glaciers; dynamic sea level; optimisation without losing determinism;
Three.js 3D world; textures, water, atmosphere and camera; CI with dashboard tests; preserve
checkpoints and separate experiments by laws version.

**Implemented**
- **Optimisation.** −21 % (A/B best-of-6, 128²: 6.93 → 5.45 ms/tick), proven **bit-identical**:
  three golden fingerprints unchanged, plus oracle tests against verbatim 0.2 code. Compiled
  kernels deferred (D-025).
- **Laws 1.6.**
  - Glacier ice: compaction, Glen-law flow, melt, sublimation, calving; GLACIER terrain.
  - Daily sea level from ocean volume over the sea-floor hypsometry, with flooding/emerging coasts.
  - Erosion grades to the moving sea.
- **Versioning.** `laws.py`; `laws_history` per world; `laws_change` events.
  `experiments/laws-1.5` moved verbatim (git history preserved) and frozen; `experiments/laws-1.6`
  is new; continuation experiments via `start_from`; the report is per version and counts
  milestones per laws.
- **3D explorer** (Three.js r170, lazy-loaded):
  - engine-elevation terrain with procedural detail, slope rock, beaches, snow and ice;
  - ocean shader at the engine sea level using the real sea-floor depth;
  - lakes, river-flow particles, instanced forests, fire and lava;
  - physical sky with the sun from the engine's date, hour and latitude; cloud decks; moonlight;
  - orbit, pan and zoom, WASD/QE flight, click-to-inspect, capture.
- **CI** (GitHub Actions).
  - Linux pytest.
  - Windows: `setup.bat`, the engine tests, `start-headless.bat` and `start.bat` on a real Windows
    runner.
  - Dashboard: type-check, Vitest (9 tests), Playwright end-to-end (7 tests, real engine, WebGL).

**What failed and was fixed**
1. First glacier flow law (∝ H²) left thin ice immobile, so ice still accumulated. Replaced with
   Glen-law H⁴·slope³ before any experiment.
2. Report bugs: the continuation was credited with the 100-year milestone from world age, and seeds
   showed "?" while runs were in progress. Fixed.
3. The 3D cloud deck sliced through mountains at close range; it now fades near the camera.
   The night scene was pitch black; representational moonlight added.
4. A test caught my narrow-screen CSS hiding the motto (required branding).
5. **CI caught a real layout bug the local tests missed:** with the CI machine's fonts the top bar
   wrapped and covered the panel tabs. Panels are now positioned from the measured bar height;
   a new test checks 1280/1440/1920 px. That test then failed once in CI (run 44630138226) by
   reading the layout before it settled. It exposed a one-frame overlap: the bar is now measured
   before the first paint and on font load, and the test waits for layout to settle.
6. **Discovered while continuing the laws-1.5 world:** the laws-1.5 sea surface was not level
   (−10 … +113 m), because ocean water equalised only diffusively. It inflated the 1.5
   "lakes fill basins" finding. That finding is corrected in EXPERIMENTS.md.

**Tested**
- Engine: 99 passed (local).
- Dashboard: build clean; Vitest 9 passed; Playwright 7 passed (local).
- CI run 44626326913 on `e1ed88a`: all three jobs green (Linux, Windows scripts + tests,
  dashboard). The final run's result is recorded in TASKS.md.

**Experiments (laws 1.6, physics commit 2498ae7):**
- 110 years from genesis (seed 2026, 64²) and 110 years continuing the laws-1.5 year-100 world.
- Frozen water converges to the same equilibrium (~9.5×10⁵ mm·tiles) from below and from above.
- The sea is level to 10⁻¹² m.
- Groundwater settles at ~338 mm in both runs.

**Incomplete**
- 1,000 and 10,000 years.
- 128² laws-1.6 runs not started.
- Connectivity-aware ocean.
- Sub-tile 3D terrain detail.

**Next**
- Advance laws-1.6 experiments toward 1,000 years (~5.3 h per 64² run).
- Profile again and consider compiled kernels with an explicit laws/engine note.
- Connectivity-aware ocean.
- 3D LOD and sub-tile detail.
