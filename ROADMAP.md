# Roadmap

Phases are plans, not promises. **No phase introducing life starts without explicit authorisation
from the project owner.**

## Phase 1 — The Creation of a World ✅
Seeded terrain, climate, water, vegetation, fire, erosion, resources, time, persistence, dashboard.

## Phase 1.5 — The Age Before Life (current, authorised 2026-11-19)
Done in session 3:
- MFD river networks, ocean mixed layer with currents, wind heat transport
- Groundwater (percolation, springs, capillary rise, lateral flow)
- Sediment transport and deposition into sand/clay; calibrated erosion
- Climate spin-up and vegetation equilibrium at generation
- Plate tectonics (uplift, subsidence, earthquakes, landslides) and volcanism (lava, ash)
- Audited budgets for water, rock, deposits and ores
- Resumable long-term experiment harness
- Black-and-gold observatory; Windows launchers

Remaining:
- **Long-term experiments.** Advance the suite to 100 → 1,000 → 10,000 simulated years, analyse
  results in EXPERIMENTS.md, and fix only genuine programming errors. See EXPERIMENTS.md for the
  wall-time estimates; 10,000 years at 128² needs ~230 CPU-hours at current speed.
- **Performance for long runs.** Numba or vectorised C for routing; optional coarser-tick "geologic
  mode" with validated equivalence; multi-process experiment workers.
- **Physics refinements.**
  - Sea-level response: oceans are defined by elevation < 0, so sea level is fixed in elevation;
    track a global sea-surface height so the water budget and the coastline interact.
  - Sea ice; cloud radiative effects; slow plate motion over >10⁶ years.
  - Lowering elevation when stone is extracted (needed before Phase 2).
- **Verification.** Run the Windows `.bat` scripts on real Windows; add CI (GitHub Actions) and
  dashboard UI tests.

## Phase 2 — Prana (life) — requires authorisation
Organisms with metabolism drawing on the world's real energy and resources; reproduction with
heritable variation; selection by environment. No predetermined species or outcomes.

## Phase 3 — Buddhi (intelligence) — requires authorisation
Learning agents embodied in the world, acting only through physical interfaces (`resources.extract`
and successors). No hardcoded technology trees.

## Phase 4+ — Civilization
Observation tooling for emergent communication, cooperation, economies and science, measured against
human knowledge without leaking it in.
