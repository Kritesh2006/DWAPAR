# Constitution

These rules bind every contributor, human or AI. Changing one requires an entry in
DECISIONS.md and explicit approval from the project owner.

## Article I — Scope of the current phase
1. **Phase 1.5 — The Age Before Life** is authorised by the project owner (2026-11-19). It covers
   world stabilisation, better environmental laws, long-term experiments and visualisation.
2. **No organisms, characters, intelligent agents, animals, civilizations or human inhabitants**
   may be introduced. Vegetation stays a continuous biomass field, not organisms.
3. `prana` (life) and `buddhi` (intelligence) stay empty until the owner explicitly authorises
   Phase 2. A test enforces this.
4. The dashboard must never show inhabitants or invented population statistics.
5. Natural collapse (vegetation die-off, drying, flooding, erosion) must not be artificially
   prevented. Only programming errors are fixed, and each fix must say which it was.

## Article II — Scientific integrity
1. Never fabricate scientific or experimental results.
2. Never claim a test passed unless it was executed successfully. Record actual
   numbers, including failures.
3. Every simplification of physics is documented in WORLD_LAWS.md. Do not claim the
   simulation reproduces real-world physics exactly.
4. The dashboard displays only values read from the engine. It never interpolates,
   smooths into fiction, or invents data.
5. No temporary mock implementation may be presented as a completed feature.

## Article III — Determinism and conservation
1. All randomness comes from `dwapar.rng.generator(seed, stream, tick)`. No wall-clock,
   global RNG or thread-timing dependence in simulation outcomes.
2. Identical seed and configuration must produce identical worlds. Identical starting
   state and tick count must produce identical futures, whatever the speed, frame rate,
   step granularity or restarts.
3. Water moves only between explicit stores. Rock mass changes only through counted tectonic and
   volcanic sources. Metal ores and coal only decrease, and only through `resources.extract`.
   Stone, sand and clay change only through counted geological processes.
4. The engine refuses to advance from an invalid state (NaN, negative mass,
   out-of-range values).

## Article IV — Progression
1. Never hardcode technological progression, crafting recipes or technology trees.
2. Resources are physical quantities, not unlock tokens.

## Article V — Engineering
1. Local first; free and open-source only; no paid APIs or cloud dependencies; never
   spend money or provision paid infrastructure.
2. The simulation engine is independent of visualisation. The world must run headless.
3. Small, meaningful commits. Never force-push. Never commit credentials.
4. Keep the project documents current at the end of every session.
