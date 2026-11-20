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

Done in session 4:
- Glacier dynamics (compaction, Glen-law flow, melt, sublimation, calving)
- Dynamic sea level with moving coastlines (laws 1.6)
- Laws versioning; per-version experiments; continuation runs
- Engine optimisation (−21 %, proven bit-identical)
- Three.js 3D world explorer
- CI on Linux and Windows; Vitest and Playwright dashboard tests

Done in session 5 (visualisation only; laws unchanged):
- True-scale multiresolution 3D world as the default view: quadtree GPU terrain with
  rendering-only procedural detail, PBR surface blending, ocean, lakes and river ribbons.
- Deterministic trees, rocks and grass derived from simulated fields.
- Sky, shadows and haze.
- Free-flight camera from orbit to eye height; quality presets.
- Honesty controls (simulation grid, detail off).

Remaining:
- **Long-term experiments under laws 1.6** toward 1,000 → 10,000 years (EXPERIMENTS.md has
  progress and cost estimates). The 64² world needs ~6 h of CPU per 1,000 years.
- **Faster engine for millennial runs.** Compiled routing (Numba/C) with a documented laws or
  version change; a validated coarser "geologic tick"; parallel experiment workers.
- **Physics refinements.**
  - Connectivity-aware ocean (inland basins below sea level should be lakes, not ocean).
  - Thermal expansion, isostasy, ice shelves.
  - Sea ice; cloud radiative effects; slow plate motion over >10⁶ years.
  - Spin-up long enough to remove the 1–4-year drying adjustment.
  - Lower elevation when stone is extracted (needed before Phase 2).
- **3D refinements.**
  - Measure frame rates on real laptop GPUs and tune the presets.
  - Volumetric clouds and cloud shadows.
  - Waterfalls and rapids where rivers are steep.
  - Seasonal leaf colour from the temperature field.
  - Coastal cliffs.
  - A web worker for tree placement.

## Phase 2 — Prana (life) — requires authorisation
Organisms with metabolism drawing on the world's real energy and resources; reproduction with
heritable variation; selection by environment. No predetermined species or outcomes.

## Phase 3 — Buddhi (intelligence) — requires authorisation
Learning agents embodied in the world, acting only through physical interfaces (`resources.extract`
and successors). No hardcoded technology trees.

## Phase 4+ — Civilization
Observation tooling for emergent communication, cooperation, economies and science, measured against
human knowledge without leaking it in.
