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
| CI | GitHub Actions: Linux, Windows (incl. .bat scripts), dashboard | ✅ | run 44626326913 green |
| Tests | Automated dashboard tests (Vitest 9, Playwright 6) | ✅ | `npm run test:unit`, `npm run test:e2e` |
| Experiment | Laws-1.6 runs: genesis seed2026-64 and continuation from laws-1.5 year 100 | 🟡 | both 110 years (100-y milestone ✅); 1,000 y pending |

## Last verified (session 4)
- Engine: `pytest` **99 passed** (189 s, local). CI run 44626326913 (`e1ed88a`): Linux, Windows (incl. .bat scripts) and dashboard jobs all green.
- Dashboard: strict type-check and build clean; Vitest 9 passed; Playwright 6 passed (local);
  Playwright 7 passed after the layout fix.

## Known issues / open items
- 🟡 **Laws-1.5 sea surface was not level** (−10 … +113 m). Fixed in 1.6; laws-1.5 lake and
  coastal results carry this caveat (EXPERIMENTS.md).
- 🟡 Laws 1.6 water closure is ~10⁻¹⁴ per simulated year, from rounding in the daily sea-level
  redistribution (1.5: ~10⁻¹⁷/yr). It is negligible but grows linearly; watch it in millennial runs.
- 🟡 Inland basins below sea level are treated as ocean (no connectivity test).
- 🟡 Spin-up samples only 6 days per season, so worlds dry for 1–4 years before stabilising.
- 🟡 The 3D view uses one vertex per tile, so relief is smooth but coarse at close range. Forests
  and moonlight are representational.
- 🟡 Atmosphere wraps periodically at map edges while land and water do not.
- ⬜ `resources.extract("stone")` does not lower elevation yet.
- ⬜ 1,000- and 10,000-year milestones.
