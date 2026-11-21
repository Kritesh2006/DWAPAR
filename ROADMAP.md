# Roadmap

Phases are plans, not promises. Life and WITNESS were authorised by the owner on 2026-11-21 (D-035).

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

## WITNESS and life (authorised 2026-11-21) — the owner's six phases

| Phase | Status | What exists | What does not yet |
|---|---|---|---|
| 1 The Awakening | ✅ implemented, v0.1 | Persistent identity and memory; introduction from real observations; conversation; instructions remembered across sessions; real acts of creation; the WITNESS interface | Open-ended language: understanding is pattern-based |
| 2 Divine powers | ✅ mostly | Reshape land, carve channels, create lakes (ocean water), bring rain (ocean water), plant and restore vegetation, put out fire, regional warming/cooling. All logged, audited and replayable | Wind control; river creation is indirect (carve a channel, physics routes the water) |
| 3 Animals | ✅ v0.1 | Six species; needs; grazing; hunting with realistic failure rates; fleeing; territory; herds; density-limited breeding; heritable variation; learned wariness; death causes | Calibrated population dynamics over decades; more species; fish and birds; disease |
| 4 Humanity | ✅ v0.1 | Individual minds: needs, fear, places and episodes, learned species fear, alarms, teaching, skills by practice, families and children, shelters from local wood, the tiger behaviour | Durable tools as objects; farming; clothing; fire use; language |
| 5 Civilization | 🟡 begun | Knowledge transfer (skills, places, dangers); family homes; shelter improvement by skill | Settlements, cooperation beyond families, farming, trade, institutions — emergent only, no tech tree |
| 6 Autonomous universe | 🟡 partial | Autonomy runs in the engine loop of both the server and the headless runner (`start-headless.bat`); the daily verify-and-learn cycle | A Windows service or scheduled task; scaling beyond 20,000 animals (vectorised or compiled minds); multi-decade civilisation runs |

### Next
1. **Calibrate the ecology** with multi-year runs per seed: predator–prey coexistence without
   WITNESS restocking, and human population stability.
2. **Phase 5 seeds:**
   - plant gathering that leaves seeds, so farming can be discovered, not unlocked;
   - fire use;
   - cooperation in building;
   - a settlement measure (clusters of shelters).
3. **WITNESS:**
   - longer-horizon plans;
   - explaining any act on request ("why");
   - an optional local language model for phrasing only, never for deciding.
4. **Performance:** vectorised animal steps; a time-sliced life step for large populations.
5. Show creatures on the 2D map.

## Later — Civilization research
Observation tooling for emergent communication, cooperation, economies and science, measured against
human knowledge without leaking it in.
