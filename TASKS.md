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

## Last verified (session 3)
`cd engine && pytest`: **87 passed in 126 s**; `cd dashboard && npm run build`: strict TypeScript build clean.
Dashboard checked in headless Chrome: no console or page errors.

## Known issues / open items
- 🟡 **Snow accumulates without limit** on perennially cold tiles (no glacier flow, sublimation or
  calving), slowly moving water from ocean to land. Needed before millennial runs are meaningful
  for sea level.
- 🟡 **Sea level is fixed in elevation** (ocean = elevation < 0). Ocean water volume changes are
  measured but do not move coastlines.
- 🟡 **Spin-up samples only 6 days per season**: worlds dry for 1–4 years before stabilising.
- 🟡 **Rivers are wide.** With the 0.6 mm/h threshold, river tiles reach ~10 % of land in wet years
  on seed 42. That is plausible for 2 km tiles but should be reviewed visually.
- 🟡 Atmosphere wraps periodically at map edges while land and water do not.
- 🟡 Heat advection in the ocean is advective-form (not exactly conservative); documented in D-016.
- ⬜ `resources.extract("stone")` does not lower elevation yet.
- ⬜ CI (GitHub Actions) and dashboard UI tests.
- ⬜ Performance: 128² costs ~8 ms/tick (≈ 1.9 h per 100 simulated years on one core).
