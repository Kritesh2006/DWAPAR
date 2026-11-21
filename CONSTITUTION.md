# Constitution

These rules bind every contributor, human or AI. Changing one requires an entry in
DECISIONS.md and explicit approval from the project owner.

## Article I — Scope of the current phase
1. **Phase 1.5 — The Age Before Life** was authorised by the project owner on 2026-11-19.
   **Life and WITNESS** were authorised by the owner on 2026-11-21 (D-035). Animals, humans and
   their minds (`prana`, `buddhi`), divine commands (`divine`) and WITNESS (`witness`) may now exist.
2. No creature, structure or intervention may appear by itself. Every one comes from a validated
   divine command (Art. VI), issued by the Creator or by WITNESS and recorded in the world's log. A
   world with no commands has no life (a test enforces this).
3. Vegetation remains a continuous biomass field. Individual trees in the 3D view are rendering
   only (D-032).
4. The dashboard shows population figures only as read from the engine. It never invents or
   extrapolates them.
5. *Amended 2026-11-21 (D-035).* The laws themselves must never prevent natural collapse:
   die-off, drying, flooding, erosion and extinction happen as physics and ecology dictate.
   Interventions are allowed only as recorded divine commands. Programming errors are still the only
   thing fixed in code, and each fix must say which it was.

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

## Article VI — Intervention (added 2026-11-21, D-035)
1. A divine command is validated before it is queued, applied at the start of a tick before
   physics, and logged with its tick, issuer, parameters, reason and measured result.
2. A world must be reproducible from any checkpoint plus its command log alone. No decision-maker
   or language model may be needed to replay it.
3. Interventions respect the conservation audits.
   - Water is moved from the ocean, never created.
   - Rock added or removed is counted.
   - Seeded biomass and created creatures are counted.
4. WITNESS acts only through divine commands. It may never write to world state directly, and it
   must never claim to be acting while no engine process is running.
5. The Creator can disable WITNESS's autonomy, forbid intervention, and review every act.

