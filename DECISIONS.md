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

## Phase 1.5

### D-014 Multiple-flow-direction runoff + generated fine relief (replaces D8 + micro-relief)
D8 single-flow routing drew straight parallel channels on planar ramps. MFD (exponent 4) splits flow
among all lower neighbours, and generation adds ~±45 m relief so ramps are not planar.
*Alternative:* D∞. Rejected for its added complexity, which buys little at 2 km resolution.

### D-015 Flow stability: equalise at most 5 % of each height difference per tick
A cap per donor–receiver pair is not enough when 8 donors can fill one receiver at once. At 45 %
this produced ~250 m/h lake sloshing while every conservation law still held exactly. 5 % ≤ 1/(2·8)
is stable. River transport on real slopes is unaffected, because the cap there exceeds the water
available. *Lesson recorded:* conservation tests cannot detect oscillation, so a stability test now
exists.

### D-016 Mixed-layer ocean in advective form
A separate SST store gives the ocean memory (25-day relaxation). Coastline-blocked currents are
divergent, so a flux-form scheme manufactures heat at coasts (observed: 93 °C air). Advective form
keeps uniform fields uniform. Heat is therefore not exactly conserved by advection, only by
diffusion. That is an accepted approximation for an intensive scalar.

### D-017 Sediment as an explicit conserved store feeding sand/clay deposits
Erosion moves rock mass into `sediment`; deposition moves it into elevation and into sand (60 %) and
clay (40 %). Sand and clay are therefore renewable on geological timescales, so the old test
"sand never increases" was replaced by an audited budget. Bedrock below the deposits is not a
resource, so erosion is never limited by quarryable stock.

### D-018 Erosion rates calibrated against Earth, not tuned for spectacle
The first build eroded 97 mm/yr on average. The cause was raw 45° generated cliffs collapsing, not
rivers. Fixes: relax slopes during generation, measure slopes to sea level at coasts, and use
realistic talus and fluvial coefficients. Result: ~0.3 mm/yr, a few times Earth's average.
Landscape change is now geological: visible over millennia, not years.

### D-019 Groundwater lateral flow limited to Darcy-scale rates
At first half a tile's groundwater could move per day, which drained aquifers 93 % in 117 days.
At most 0.5 %/day now moves. Aquifers still respond to recharge on seasonal-to-decadal timescales.

### D-020 Spin-up instead of a guessed initial climate
Spin-up runs real physics across all four seasons, measures precipitation, and sets vegetation and
soil carbon to the model's analytic equilibrium. Generation takes ~6 s at 128² (was 0.1 s) in
exchange for removing most of the year-1 drift (+115 % wood in Phase 1).

### D-021 Simplified tectonics as static plates with constant velocities
Plates carry constant velocities, giving uplift/subsidence rates, stress loading and volcano
placement as pure functions of the seed. Plates do not move or reorganise over runs. That would
matter only over ~10⁶ years, far beyond any run so far.

### D-022 Experiments: sparse records, portable checkpoints in git
Recording runs yearly to 100 years, every 10 years to 1,000, and every 100 beyond, which keeps
results small enough to commit. The latest state per experiment is committed (~1.5–3 MB each) so
cloud sessions, which do not persist local files, can resume. Cost: a few MB of git history per
session that advances an experiment. *Alternative:* Git LFS, deferred because it adds setup for the
owner.

### D-023 Observatory renderer separated from data
The canvas renderer is a plain class with its own animation loop. React only passes it frames and
settings. Animated motion is extrapolated from engine wind and flow fields and is reset by every
new frame, so visuals can never drift from the simulation for more than one frame.

### D-024 Windows launchers as plain .bat files
Plain `.bat` files need no extra tooling. `setup.bat` creates `.venv` and builds the dashboard;
`start.bat` waits for the API before opening the browser. Line endings are pinned to CRLF in
`.gitattributes`. They have not yet been executed on Windows.
