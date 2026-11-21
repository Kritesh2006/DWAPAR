# Tasks

Status legend: ✅ done and tested · 🟡 partial · ⬜ not started

## Phase 1 completion criteria — all ✅ (session 1; see JOURNAL.md)

## Phase 1.5 — The Age Before Life

| Area | Item | Status | Evidence |
|---|---|---|---|
| Laws | River routing without parallel channels (MFD + fine relief) | ✅ | `test_mfd_*`, `test_drainage_converges_into_channels`, `test_surface_flow_is_numerically_stable` |
| Laws | Horizontal heat transport + ocean currents (mixed layer) | ✅ | `test_masked_advection_*`, `test_ocean_currents_carry_heat`, `test_winds_carry_heat`, `test_ocean_temperature_responds_slowly` |
| Laws | Sediment transport and deposition | ✅ | `test_erosion_conserves_rock_mass`, `test_sediment_deposits_in_still_water_and_builds_sand` |
| Laws | Groundwater storage and movement | ✅ | `test_groundwater_*`, `test_water_conserved_with_groundwater` |
| Laws | Climate equilibrium at generation (spin-up) | 🟡 | `test_spinup_improves_initial_equilibrium`; experiments show a residual 1–4-year drying adjustment (EXPERIMENTS.md) |
| Laws | Tectonics (uplift, subsidence, earthquakes) | ✅ | `test_tectonic_uplift_*`, `test_earthquake_*` |
| Laws | Volcanism | ✅ | `test_volcanic_eruption_builds_land_adds_stone_and_closes_budget` |
| Laws | Physically consistent resource accounting | ✅ | `test_all_budgets_close_over_a_season`, `test_geological_deposits_change_only_through_audited_processes` |
| Experiment | Resumable harness, bounded sessions, portable checkpoints | ✅ | `test_experiment_resumes_from_portable_checkpoint` |
| Experiment | 10 years | ✅ | seed42-128 (34 y) and seed2026-64 (100 y) — EXPERIMENTS.md |
| Experiment | 100 years | 🟡 | seed2026-64 ✅ (100 y); seed42-128 at 34 y; seed7-128 not started |
| Experiment | 1,000 years | ⬜ | needs further bounded sessions (estimates in EXPERIMENTS.md) |
| Experiment | 10,000 years | ⬜ | needs a faster engine or many sessions (estimates in EXPERIMENTS.md) |
| Dashboard | Black/gold full-screen observatory, animated data-driven layers | ✅ | headless-Chrome screenshots, no console errors |
| Dashboard | Heatmaps, resource maps, disaster tracker, timeline, export, speeds, archive | ✅ | API tests `test_frame_*`, `test_load_world_by_id` |
| Windows | setup.bat, start.bat, start-headless.bat | 🟡 | written and reviewed; **not executed on Windows** (no Windows machine available) |

## Session 4 — laws 1.6 / engine 0.3

| Area | Item | Status | Evidence |
|---|---|---|---|
| Laws | Glacier dynamics: compaction, Glen-law flow, melt, sublimation, calving | ✅ | `tests/test_cryosphere_sea.py` (9 tests); experiments (EXPERIMENTS.md) |
| Laws | Dynamic sea level and moving coastlines | ✅ | `test_sea_falls_*`, `test_sea_rises_*`, `test_level_solver_is_accurate` |
| Engine | Optimisation without changing results | ✅ | `tests/test_performance.py`, golden fingerprints, A/B −21 % |
| Integrity | Laws versioning; old checkpoints preserved; versions separated | ✅ | `test_laws_history_records_continuation`; `experiments/laws-1.5` unchanged |
| 3D | Three.js world explorer from engine data | ✅ | Playwright `3D world renders the engine terrain with WebGL` |
| 3D | Terrain textures, vegetation, water shaders, atmosphere, camera controls | ✅ | visual review (screenshots in JOURNAL) |
| CI | GitHub Actions: Linux, Windows (incl. .bat scripts), dashboard | ✅ | final run 44630830532 green |
| Tests | Automated dashboard tests (Vitest 9, Playwright 6) | ✅ | `npm run test:unit`, `npm run test:e2e` |
| Experiment | Laws-1.6 runs: genesis seed2026-64 and continuation from laws-1.5 year 100 | 🟡 | both 110 years (100-y milestone ✅); 1,000 y pending |

## Session 5 — 3D visualisation (laws unchanged, 1.6)

| Area | Item | Status | Evidence |
|---|---|---|---|
| 3D | 3D world is the default view; 2D optional | ✅ | Playwright `3D world is the default view…` |
| 3D | Multiresolution terrain (quadtree LOD, GPU displacement, 4 m at ground) with rendering-only detail | ✅ | Vitest `render3d.test.ts` (macro passes through tiles, zero at coast, zero-mean, calmed in valleys, CPU/GPU constants match); screenshots |
| 3D | PBR surface blending by slope, altitude and simulated fields | ✅ | screenshots `docs/images/3d-*.jpg` |
| 3D | Ocean at sea level, lakes at engine level, river ribbons from engine flow | ✅ | Vitest hydrography tests; screenshots |
| 3D | Deterministic trees, rocks, grass from simulated fields | ✅ | screenshots (ground, coast canopy) |
| 3D | Free-flight camera to ground level, collision, walk, presets | ✅ | Playwright flies Ground → Orbit; altitude asserted |
| 3D | Sky, sun shadows, haze, clouds matching engine cover | ✅ | screenshots |
| 3D | Honesty: simulation grid, procedural detail off, permanent note | ✅ | Playwright toggles; screenshots |
| 3D | Quality presets + auto-downgrade + stats | ✅ | code; **laptop-GPU frame rate not measured** (software GL only) |

## Session 6 — WITNESS and life (engine 0.4, laws 1.6 unchanged, life model 0.1)

| Area | Item | Status | Evidence |
|---|---|---|---|
| Governance | Owner authorisation recorded; constitution amended (Art. I, new Art. VI) | ✅ | CONSTITUTION.md, D-035 |
| Divine | Validated, logged commands that change authoritative state | ✅ | `test_commands_change_persistent_state_and_are_logged`, `test_invalid_commands_are_refused_and_recorded` |
| Divine | Conservation audits stay closed under intervention | ✅ | `test_divine_acts_keep_conservation_audits_closed` (water, rock < 1e-12) |
| Divine | World replays exactly from the command log, no decision-maker | ✅ | `test_replaying_the_command_log_reproduces_the_world_exactly` |
| Laws | Lifeless worlds unchanged (bit-identical to 1.6) | ✅ | all 99 pre-existing tests incl. golden fingerprints; `test_no_life_without_a_recorded_command` |
| WITNESS | Awakens, introduces itself from real data, converses, acts, remembers across sessions | ✅ | `test_witness_awakens_talks_acts_and_remembers_across_sessions`; Playwright `WITNESS awakens…` |
| WITNESS | Autonomous cycle: observe → remember → reason → plan → act → verify → learn | ✅ | `test_witness_autonomy_cycle_verifies_and_learns` |
| WITNESS | Obeys "do not intervene"; autonomy switch; goals, acts and memories inspectable | ✅ | `test_witness_obeys_do_not_intervene`; UI tabs |
| WITNESS | Open-ended natural language | ⬜ | pattern-based only (D-036) |
| Animals | Needs, grazing, hunting, fleeing, territory, herds, breeding, heritable variation, learned wariness | ✅ v0.1 | `test_prey_flees…`, `test_grazing…`; ecology runs in JOURNAL |
| Animals | Calibrated long-term coexistence | 🟡 | predators often exhaust prey within 1–2 years without restocking (JOURNAL) |
| Humans | Individual minds; tiger encounter → flee, remember, warn, build shelter sooner | ✅ v0.1 | `test_human_meets_a_tiger…` (controlled vs no-tiger; passes on 4 seeds) |
| Humans | Skills by practice and teaching; families; births; shelters | ✅ v0.1 | `test_humans_learn_skills…`; 100-day runs: 12 → 17 humans |
| Civilization | Settlements, farming, tools as objects, cooperation beyond families | ⬜ | ROADMAP |
| Background | Runs in server and headless runner; never claims to act when stopped | ✅ | Observatory attaches WITNESS; UI "engine paused, so not acting" |
| Persistence | Life inside checkpoints; mid-day restore continues exactly | ✅ | `test_life_is_deterministic_and_survives_a_mid_day_checkpoint` |
| 3D | Creatures, shelters, markers, WITNESS's presence; trees clear of shelters | ✅ | screenshots `docs/images/life-*.jpg`, `witness-*.jpg` |

## Last verified (session 6)
- Engine: `pytest` **113 passed** (99 existing + 14 new), local.
- Dashboard: strict type-check and build clean; Vitest **22 passed**; Playwright **8 passed** (local, SwiftShader).
- CI: recorded below after the push.

## Previously verified (session 5)
- Engine: `pytest` **99 passed** (local); no engine code changed.
- Dashboard: strict type-check and build clean; Vitest **22 passed**; Playwright **7 passed** (local, SwiftShader).
- 3D screenshots reviewed: orbit, region (11 km), low flight (380 m), ground (1.7 m), coast, mountain, grid, detail-off and heatmap.
- CI run 44648353886 on `6505f80`: Linux, Windows (incl. .bat scripts) and dashboard (type-check, Vitest 22, Playwright 7 incl. the 3D ground-level test) all green on the first attempt.

## Previously verified (session 4)
- Engine: `pytest` **99 passed** (local). Final CI run 44630830532 (`aae4caa`): Linux, Windows (incl. .bat scripts) and dashboard (type-check, Vitest 9, Playwright 7) all green.
- Dashboard: strict type-check and build clean; Vitest 9 passed; Playwright 6 passed (local);
  Playwright 7 passed after the layout fix.

## Known issues / open items
- 🟡 **Laws-1.5 sea surface was not level** (−10 … +113 m). Fixed in 1.6; laws-1.5 lake and
  coastal results carry this caveat (EXPERIMENTS.md).
- 🟡 Laws 1.6 water closure is ~10⁻¹⁴ per simulated year, from rounding in the daily sea-level
  redistribution (1.5: ~10⁻¹⁷/yr). It is negligible but grows linearly; watch it in millennial runs.
- 🟡 Inland basins below sea level are treated as ocean (no connectivity test).
- 🟡 Spin-up samples only 6 days per season, so worlds dry for 1–4 years before stabilising.
- 🟡 3D frame rate on real laptop GPUs is unmeasured. Development and CI use software WebGL (about
  10 fps at 1600×950 regardless of preset). Geometry budget at medium: about 0.16 M triangles and
  76 draw calls at orbit; 1.1–2.4 M triangles and 200–330 draw calls near the ground.
- 🟡 3D: river ribbons are lifted up to 14 m at long range so coarse distant terrain cannot hide them.
  Field lookups are warped by under one tile. Both are rendering-only and documented (D-032).
- 🟡 3D: moonlight at night is representational; *Daylight* is a labelled viewing aid.
- 🟡 Atmosphere wraps periodically at map edges while land and water do not.
- 🟡 Life ecology is uncalibrated over decades. Predators can exhaust prey within 1–2 years, and
  WITNESS's restocking masks it. The two-year run without WITNESS lost its wolves.
- 🟡 Life step cost: about 60 s per simulated year with ~1,600 creatures on 48² (single-threaded
  Python). Capped at 20,000 animals (counted, shown).
- 🟡 WITNESS language is pattern-based; unknown requests get an honest "I do not understand".
- 🟡 Creatures are not drawn on the 2D map yet (3D and the Witness › Life tab only).
- ⬜ `resources.extract("stone")` does not lower elevation yet.
- ⬜ 1,000- and 10,000-year milestones.
