# Tasks

Status legend: ✅ done and tested · 🟡 partial · ⬜ not started

## Phase 1 completion criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Unique world from a seed | ✅ | `test_same_seed_same_world`, `test_different_seed_different_world` |
| 2 | Natural resources throughout the world | ✅ | `test_every_resource_exists_with_location`, `test_minerals_are_localised_not_uniform` |
| 3 | Time advances independently | ✅ | `test_runner_advances_unattended_and_recovers`; `dwapar run` headless |
| 4 | Environmental conditions interact and change | ✅ | 13 tests in `test_environment.py` |
| 5 | Runs without human interaction | ✅ | Runner thread + auto-checkpoint; SIGTERM and SIGKILL recovery verified manually |
| 6 | Dashboard displays actual simulation state | ✅ | `test_layer_reflects_actual_state`; dashboard viewed in headless Chrome |
| 7 | Save, close, restore | ✅ | `test_checkpoint_recovery_continues_identically` (bit-exact) |
| 8 | Core automated tests pass | ✅ | 64/64 passed (see below) |
| 9 | Local launch via documented instructions | ✅ | README.md, `start.sh` |
| 10 | No intelligent inhabitants | ✅ | `test_no_inhabitants_exist`; prana and buddhi empty |

## Last verified test run
`cd engine && pytest`: **64 passed in 15.0 s**; also 64 passed in a fresh venv via `pip install -e ".[dev]"`; re-run before the GitHub push: 64 passed in 17.5 s (Python 3.13.18, numpy 2.5.3, 2026-11-19).
Dashboard: `npm run build` passes strict TypeScript with no errors.

## Measured performance (2-core cloud container, `python -m dwapar bench`)
| World | Generation | ms/tick | ticks/s | sim-days/s | real time per sim-year |
|---|---|---|---|---|---|
| 128×128 | 142 ms | 5.49 | 182 | 7.6 | 47 s |
| 256×256 | 457 ms | 23.5 | 43 | 1.8 | 203 s |
| 512×512 | 2166 ms | 124.9 | 8 | 0.3 | 1079 s |

Under `serve` at max speed, with the dashboard polling, measured throughput was
130–175 ticks/s at 128². Checkpoint size is ≈1.4 MB at 128².

## Open items / known issues
- 🟡 D8 single-flow routing draws straight parallel rivers on planar slopes. Fix: MFD/D∞ routing.
- 🟡 No horizontal heat transport (ocean currents, advection of heat).
- 🟡 Eroded sediment is not deposited as sand/clay.
- 🟡 Year-1 spin-up: vegetation and wood rise sharply as initial guesses settle.
  Consider an optional generation-time spin-up.
- 🟡 Atmosphere wraps periodically at map edges while land and water do not.
- ⬜ Dashboard has no automated UI tests (verified manually via headless screenshots).
- ⬜ CI workflow (GitHub Actions) not yet added. Repository: https://github.com/Kritesh2006/dwapar (main).
- ⬜ Generation's Python-loop priority-flood is the 512² bottleneck.
