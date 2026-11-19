# Roadmap

Phases are plans, not promises. **No phase beyond 1 starts without explicit
authorisation from the project owner.**

## Phase 1 — The Creation of a World (current)
Completed in session 1. Hardening backlog (no new world features required):
- Multiple-flow-direction (MFD/D∞) runoff to remove parallel channels on planar slopes.
- Horizontal heat transport (advection and diffusion; simple ocean mixed layer).
- Sediment transport: eroded rock deposited as sand, clay and alluvium; deltas.
- Groundwater store with lateral flow (replaces the baseflow stand-in).
- Optional generation-time spin-up to an equilibrated climate.
- Volcanism and tectonics as rare long-period events (would change finite deposits
  only through physical processes).
- CI (GitHub Actions running pytest and the dashboard type-check); dashboard UI tests.
- Performance for ≥ 512²: binary WebSocket layers, priority-flood in compiled code
  (numba or a small C extension), tiled or chunked processing.

## Phase 2 — Prana (life), requires authorisation
Organisms with metabolism drawing on the world's real energy and resources;
reproduction with heritable variation; selection by environment. Vegetation may become
populations of plant lineages. No predetermined species or evolutionary outcomes.

## Phase 3 — Buddhi (intelligence), requires authorisation
Learning agents embodied in the world, interacting with it only through physical
actions (`resources.extract` and future physical interfaces). No hardcoded technology
trees; any language, tools or knowledge must emerge.

## Phase 4+ — Civilization
Observation tooling for emergent communication, cooperation, economies and science.
Instrumentation to compare discoveries against human knowledge without leaking it in.
