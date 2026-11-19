# Decisions

Each entry: decision, reasoning, alternatives considered.

### D-001 Grid of named numpy rasters, not tile objects
Vectorised fields make each process a few array operations (about 5 ms per tick at
128²). Per-tile objects would be about 100× slower and harder to checkpoint.
*Alternative:* ECS or tile classes. Rejected for performance and serialisation.

### D-002 Randomness keyed by (seed, stream, tick)
No RNG state needs saving, and restores are bit-exact. Streams are independent, so
adding a new random process never perturbs existing ones. *Alternative:* one global
generator saved in checkpoints. Rejected as fragile; it breaks when process order changes.

### D-003 Time is a single integer tick; 1 tick = 1 simulated hour
An hour resolves the day/night cycle and keeps hydrology stable. Calendar values are
derived, so they cannot drift. A 360-day year (4×90) keeps seasons aligned.

### D-004 Water as explicit mm stores, oceans included
Treating ocean as deep surface water lets one routing rule handle rivers, lakes and the
sea, and makes exact conservation testable. *Alternative:* fixed sea level boundary.
Rejected because it hides a sink/source.

### D-005 Terrain is derived, never stored as truth
Terrain is recomputed daily from physical fields, so it can never contradict the
physics (a burnt forest becomes plains automatically).

### D-006 Two process rates (hourly and daily)
Vegetation, erosion and classification change slowly. Running them daily saves about 40 %
of the compute with no visible loss.

### D-007 SQLite with compressed npz blobs plus SHA-256
SQLite is in the required stack, transactional and WAL-safe for power loss. npz is
exact, compact (≈1.4 MB) and dependency-free. The hash turns silent corruption into an
explicit error.

### D-008 Dashboard served by FastAPI from a static build
One process and one port for users. The Vite dev server with proxy remains available.
Charts are hand-written SVG (no chart library) to keep dependencies minimal.

### D-009 Layers transferred as base64 rasters over HTTP; WebSocket carries status only
A 128² float32 layer is about 87 KB. Pushing every layer at 2 Hz would waste bandwidth.
The client pulls the active layer at most once a second when the tick changed.
*Alternative:* binary WebSocket frames. Deferred until larger worlds need it.

### D-010 Validation before each `step()` and every 24 ticks
Discovered via a failing test: external corruption could be "laundered" by later
processes before periodic validation. Pre-step validation costs about 0.4 ms.

### D-011 Initial climate from a proxy, not an expensive spin-up
Generation stays fast (about 0.12 s). The dynamics then correct the guess during year 1,
which is visible and documented. An optional spin-up is a roadmap item.

### D-012 Micro-relief only for flow-direction choice
Breaks D8 axis bias without altering conserved elevation. It is a static field derived
from the seed, so it is not state.

### D-013 Stack as specified
Python, FastAPI, React+TS, Canvas, SQLite, WebSockets, Pytest and Git were all used
as specified. Additions: numpy (the core numeric engine), uvicorn (ASGI server), Vite
(build tool) and httpx (needed by FastAPI's TestClient). All are free and open source.
