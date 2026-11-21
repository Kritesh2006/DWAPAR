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

## Session 5 — An explorable world (visualisation only)

**Request.** The visuals looked like a small, cartoonish terrain map. Requirements:
- make the 3D world the default view;
- realistic, satellite-like terrain, water and vegetation, explorable down to ground level;
- multiresolution procedural detail that stays consistent with the simulation and is clearly
  distinguished from it;
- no changes to the laws, saves or determinism; no life.

**Built** (dashboard only; the engine is untouched, so the laws remain 1.6):
- A shared CPU/GPU height function: the simulated macro surface plus deterministic, zero-mean
  procedural relief that vanishes at coasts and calms in valleys.
- A quadtree LOD terrain displaced on the GPU, from 512 m to 4 m vertex spacing.
- PBR surface blending driven by the simulated fields.
- Ocean, lake and river-ribbon water.
- Field-derived instanced trees (leaf cards from a procedurally drawn atlas), rocks and grass.
- Sky and environment lighting, camera-following shadows, altitude haze, clouds matching engine
  cover.
- A free-flight camera with a terrain-following walk.
- Quality presets with auto-downgrade, and honesty controls.

Details: ARCHITECTURE.md; decisions D-031 to D-034.

**How it was judged.** Screenshots in software WebGL at 1600×950 after every change, from orbit
(182 km), region (11 km), low flight (380 m) and ground (1.7 m), plus coast, mountain, grid,
detail-off and heatmap views. Each round was reviewed for what looked wrong; final images are in
`docs/images/3d-*.jpg`.

**What looked wrong, and the fix**
1. First round:
   - the cloud deck was opaque and hid the world;
   - field textures showed the 2 km tiles as square blobs;
   - rivers read as white roads;
   - a hard line ran across the sky where the cloud plane's edge was seen edge-on;
   - trees were cartoon cones and blobs with black trunks (the instance tint multiplied the bark);
   - the forest floor was flat grey.

   Fixes:
   - cloud coverage set from the engine's cover fraction, with a horizon fade;
   - an organic field warp (under one tile);
   - rougher river water;
   - leaf-card trees from a procedural leaf and needle atlas, with crown normals and bark excluded
     from the tint;
   - close-range albedo detail;
   - a canopy function shared by the shader and tree placement.
2. Deserts read as snow (too pale), so they were darkened. The map ended in a vertical wall, so
   the ground now sinks into the sea beyond the edge (CPU and GPU).
3. Mountains showed banding from the rock-strata pattern aliasing at distance; it now fades out.
4. Rivers looked dashed from far away: distant chunks are too coarse to show the carved channel.
   Ribbons now get a small distance-based lift.

**Bugs found and fixed**
- The page froze on load: the river-mask rasteriser applied a canvas blur filter on every one of
  thousands of strokes. Each layer is now stroked sharp and blurred once.
- Shader compile errors: `uTime` was undeclared in the water shader, and `out` is a reserved word
  in GLSL. The screenshot harness now fails on any shader error, and the e2e test already fails on
  console errors.
- **A unit test caught a real bias:** ridged noise has mean 0.622, not 0.5, so procedural detail
  raised mountains by about 76 m on average above the simulated elevation. Now recentred
  (measured over 1.3 M samples), identically on CPU and GPU.
- Camera teleports (presets, `setView`) inherited a stale "on the ground" state and snapped back to
  the ground. A slow frame that completed a whole fly-to did the same.
- Fly-to animations used clamped frame time and crawled on slow machines (3.6 min e2e); they now
  use wall-clock time.
- Elevation refreshes every few simulated days would have rebuilt the river network repeatedly.
  It is now rebuilt only when the set of river tiles changes (at most once a minute while
  running); otherwise only the elevation texture updates.

**Tested**
- Engine: 99 passed (local).
- Dashboard: type-check and build clean; Vitest 22 passed (13 new for the 3D height function,
  warp, canopy and hydrography); Playwright 7 passed (the 3D test now opens in 3D by default,
  toggles grid and detail, flies to the ground and asserts eye height, then back to orbit).

**Not measured.** Frame rate on a real Windows laptop GPU. Only software rendering is available
here. The presets and auto-downgrade exist for this reason; the triangle and draw budgets are in
TASKS.md.

**Next**
- Measure on real hardware and tune the presets.
- Volumetric clouds and cloud shadows.
- Seasonal foliage colour from temperature.
- Waterfalls on steep river reaches.
- Laws-1.6 experiments toward 1,000 years.

## Session 6 — WITNESS and life

**Request.** Build WITNESS, a persistent autonomous intelligence that converses with its Creator,
observes the world and acts on it for real. Then introduce animals, humans with independent minds,
and the beginnings of civilisation, while preserving laws 1.6, determinism, saves and the 3D world.

**Governance first.** The constitution forbade all of this (Art. I) and forbids paid or cloud APIs
(Art. V). The owner's request is explicit authorisation, so the change is recorded as an amendment
(D-035) rather than bypassed. That rules out a cloud LLM for WITNESS, so its mind is local and
deterministic (D-036).

**Built**
- `divine`: ten command kinds; validation; tick-exact application before physics; a log; audits
  (water moved from the ocean; rock, biomass and creatures counted); exact replay.
- `prana` and `buddhi`:
  - six animal species and human minds;
  - spatial indexes per pool;
  - JSON state in checkpoints;
  - deterministic RNG streams.
- `witness`: persistent identity, state, chat and memories; the daily
  observe→remember→reason→plan→act→verify→learn cycle; goals and directives; grounded dialogue.
- API endpoints, the Witness tab, and creatures, shelters and WITNESS's presence in 3D.

**What went wrong, and the fix.** Found by running ecosystems and reading the outcomes, not by
assuming the code was right.
1. **Tigers:** 133 kills and 74 attacks on humans in 60 days, then starvation.
   - Carnivores now feast and fast.
   - Tigers no longer chase rabbits.
   - Humans are a last resort for a starving predator.
   - Most approaches end without an attack.
2. **Thirst deaths, two causes:**
   - A man in a local hollow with water just out of sight: "go downhill" pointed at his own tile.
     Humans now ask the people nearby, then search.
   - `move` tried only straight lines, so coasts trapped people. It now turns around obstacles.
3. **No births:** couples slept in separate shelters. Partners now share the better home.
4. **Performance:** `nearest()` took 53 % of the time. Per-pool indexes made it 3× faster.
5. **Population explosions:** insects and rabbits grew to 14,000 without predators.
   - Breeding is now density- and food-limited.
   - An explicit, counted cap of 20,000 animals.
6. **All 12 humans created by WITNESS died of thirst within 19 days while it brought rain
   elsewhere.**
   - Only 7 % of land counted as drinkable. Routed runoff ≥ 0.05 m³/s now counts as a stream
     (70 % of land).
   - WITNESS gained a "humans suffering" concern that overrides everything but "do not
     intervene".
   - Settlements are placed by permanent water.
   - Next run: 12 → 17 humans, no deaths in 100 days.
7. **WITNESS released wolves onto 42 plant-eaters.** Deer and rabbits went extinct, and it
   declared the ecosystem "holds" by counting insect colonies.
   - Balance is now judged on large prey; predators need 60+ prey; a predator release is judged by
     what happens to the prey.
   - Releasing predators too early is recorded as a mistake, and dwindling prey is restocked.
8. **WITNESS repeated rain over the same drought 9 times in 20 days.** Per-place cooldowns were
   added. Its learned value for rain converged near zero ("made little difference"), which is
   honest.
9. **3D:**
   - The chat overlapped (flex-shrink).
   - A shelter floated on the sea: the engine treated a whole coastal 2 km tile as land while the
     renderer draws a continuous coastline. Creatures now respect the interpolated coastline
     (D-040).
   - Rendering-only trees grew through shelters; they are now cleared.
10. **Tests:**
    - The e2e test first counted deer; the persistent test engine breeds them. It now asserts the
      engine's command record (`created: 12`).
    - The old "prana/buddhi must be empty" test had become hollow. It was replaced with "no life
      without a recorded command".

**Tested**
- Engine: 113 passed (99 pre-existing including golden fingerprints, so lifeless worlds are
  bit-identical; 14 new).
- The tiger, flight, replay and mid-day-restore tests also pass on seeds 3, 19 and 123.
- Dashboard: type-check and build clean; Vitest 22; Playwright 8 (new: WITNESS converses and its
  act creates 12 deer in the engine).

**Not done (stated plainly)**
- Open-ended language.
- Wind control.
- Farming, tools as objects, settlements and cooperation beyond families (Phase 5).
- An OS-level background service.
- Calibrated multi-decade ecology.
- Creatures on the 2D map.
- Real-hardware frame rates.

