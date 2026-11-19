# World Laws

These are the physical rules of DWAPAR (engine 0.2, Phase 1.5) and every simplification behind them.
**This is a simplified model, not a reproduction of real-world physics.** Constants live at the
top of `engine/dwapar/prakriti/processes.py`, `brahmanda/terrain.py` and `brahmanda/tectonics.py`.

## Geometry and time
- Square tiles, default 2 km edge (128 tiles ≈ 256 km). Sea level is 0 m. Map edges are closed to
  water, sediment and groundwater. The atmosphere is periodic, so air leaving one edge re-enters
  the opposite one.
- One tick = 1 simulated hour. There are 24 h/day, 4 seasons of 90 days, and 360 days/year. Day 0
  is the northern spring equinox. Latitude spans 48° N to 12° S by default.
- The map spans ~2° of longitude, so all tiles share one local solar time and the whole world is
  in day or night together. This is physically correct at this scale.

## Generation and pre-history
1. **Plates and elevation.** Elevation comes from fractal + ridged noise, plus mountain belts
   along convergent plate boundaries and troughs along divergent ones. Fine relief (~±45 m) is
   added so lowlands are never perfectly planar.
2. **Slope relaxation.** Over-steep slopes (> 0.45 m/m, measured to sea level at coasts)
   collapse to a stable angle before time starts (mass-conserving).
3. **Initial guesses.** Priority-flood fills depressions to form initial lakes. A moisture proxy
   gives an initial climate guess. Soils, vegetation, aquifers and geological deposits follow.
4. **Spin-up** (`spinup_days_per_season`, default 6). The real physics runs 6 days in each season,
   plus 4 settling days. Annual-mean precipitation is *measured* during this run. Vegetation and
   soil carbon are then set to the analytic equilibrium of the vegetation model under that climate
   (logistic growth = mortality; litter = decomposition). Spin-up events are discarded and the
   clock resets to tick 0. It is deterministic.

## Radiation, ocean and air temperature
- Sun position comes from a circular orbit with a fixed 23.44° tilt. Seasons and day length
  emerge from `cos(zenith)`.
- Radiative equilibrium: `−38 + 210·Q_annual(lat)`, plus a seasonal term (×95 on land, ×45 at sea)
  lagged 1/8 year, with a lapse rate of 6.5 °C/km.
- **Ocean mixed layer (SST).** Relaxes to radiative equilibrium with a 25-day time constant and
  exchanges heat with the air over 40 days. Surface **currents** carry it: zonal flow follows the
  winds (westward trades, eastward westerlies), with a weak gyre-like meridional component.
  Currents stop at coastlines. Because blocked currents are not divergence-free, heat is
  advected in *advective form*, which keeps uniform fields uniform. A flux form was tried first
  and piled heat against coasts until air temperature reached 93 °C, which the validator caught.
  Eddy diffusion between ocean tiles is 0.08/h and conserves heat exactly.
- **Air.** Winds carry heat (periodic upwind advection + mixing, 0.03/h). Air then relaxes toward
  the surface temperature: land radiative value over 3 h, SST over 12 h. The diurnal term is
  damped by soil moisture and water. Weather anomalies are ±3 °C; snow albedo −3 °C; fire +12 °C ×
  intensity; lava +25 °C × heat.
- Not modelled: clouds' radiative effect, greenhouse gases, sea ice, deep ocean, vertical structure.

## Water cycle (conserved)
Stores per tile, all in mm: surface water (ocean included), soil water, **groundwater**,
atmospheric water, and snow (water equivalent). No process creates or destroys water: closure
error is ≤ 3.2×10⁻¹⁵ relative after 100 simulated years (experiment seed2026-64).
- **Evaporation and transport.** Potential evaporation `0.35·(0.2+insolation)·e^{0.05(T−15)}·(1−RH)`
  mm/h, drawn from open water, then soil, then transpiration. Winds carry moisture; saturation
  capacity is 24 mm at 15 °C, +6.5 %/°C.
- **Precipitation.** Half of the excess over capacity falls each hour. Capacity is modulated
  0.78–1.20× by a seed-derived daily weather field. Snow falls below 0.5 °C on land. Melt is
  0.2 mm per °C·h. **Known limitation:** no glacier flow, sublimation or calving, so perennial snow
  accumulates without bound (measured ≈ 2×10⁴ mm·tiles/yr on seed2026-64; see EXPERIMENTS.md).
- **Soil.** Infiltration up to 8 mm/h. Soil above 95 % of capacity spills to the surface.
- **Groundwater.** Aquifer capacity is 400–3000 mm (porous lowlands store more, mountains less).
  - Percolation: 1 %/h of soil water above 35 % of capacity.
  - Springs: 0.02 %/h discharge to the surface (~200-day e-folding), plus any overflow.
  - Capillary rise: water returns to dry soil, which sustains vegetation in drought.
  - Lateral flow: aquifer water follows the water-table gradient, moving at most 0.5 % of a
    tile's store per day, a Darcy-scale mm/day flux. A first version moved 50 %/day and drained
    93 % of aquifers in 117 days. Discharge into the sea becomes ocean water.
- **Runoff.** Multiple-flow-direction routing (Freeman/Holmgren, exponent 4) on the water surface.
  Each tile splits outflow among all lower neighbours. **Stability:** at most 5 % of each
  pairwise height difference is equalised per tick, because up to 8 donors can fill one receiver
  at once. A 45 % fraction produced a checkerboard instability with lake surfaces sloshing
  ~250 m/h; conservation still held exactly, so it was found only by inspecting the state.
- **Rivers, lakes and wetlands are not drawn.** They are tiles whose sustained discharge, depth
  or saturation crosses a threshold. A river is a tile with outflow ≥ 0.6 mm/h, about the top
  2 % of land, draining ~25× its own rainfall.

## Soil and vegetation
- Fertility is derived: `0.55·(1−e^{−OM/8}) + 0.2·clay + 0.25·moisture`. Volcanic ash adds clay,
  which makes it fertile.
- Vegetation is a continuous biomass field (kg/m²), **not organisms**. It grows logistically at
  3.5 %/day × temperature × moisture factors, toward a carrying capacity of ≤ 28 kg/m² set by
  fertility and precipitation. Colonisation is seeded by neighbours. Mortality has five terms:
  background, drought, frost, drowning and lava.
- Dead biomass becomes organic matter, which decomposes at 0.15 %/day × temperature and moisture
  factors.

## Fire
- Fire risk combines dryness, days since rain, heat and fuel. Lightning ignites at 3×10⁻⁶ per
  tile-hour × risk × convective factor. Fire spreads to neighbours, faster downwind. Fires go out
  with rain, wet soil or lack of fuel. 15 % of burned biomass becomes char in the soil.

## Erosion, sediment and deposition (mass-conserving)
- **Transport capacity** (t/day) = `2×10⁻⁶ · √discharge · slope · (1 − 0.8·cover)` × tile mass per
  metre. Slopes are measured to sea level for coastal tiles. Lakes (> 1.5 m deep) and the sea
  have zero capacity.
- **Erosion and deposition.** Where the load is below capacity the bed erodes: up to 25 % of the
  drop per day, and never below +0.5 m on land in one step. Where it is above capacity, 50 % of
  the excess deposits; in still water all of it does.
- **Talus creep** on slopes > 0.25 moves about 0.1 m/yr on a 45° slope.
- **Transport.** The remaining load moves one tile downstream per day.
- **Deposits.** Eroded mass comes out of the sand deposit first, then clay; bedrock beneath is not
  a resource. Deposited mass becomes sand (60 %) and clay (40 %), so deltas and alluvial plains
  accumulate sand and clay.
- **Measured rate.** Average land erosion is ≈ 0.3 mm/yr (seed 42, first 120 days). Earth's
  average is ~0.05–0.1 mm/yr, faster in mountains. A first version ran at 97 mm/yr because raw
  generated cliffs collapsed; fixed by the pre-history relaxation.
- Bulk density is 2.0 t/m³.

## Tectonics, earthquakes, volcanism
- **Plates.** ~7 per 128² world (Voronoi with warped boundaries), each with a constant velocity.
  Convergence across each boundary gives uplift up to 4 mm/yr in a belt a few tiles wide;
  divergence gives subsidence up to 1.5 mm/yr. A map is a patch of a planet, so it can contain
  only one boundary type.
- **Earthquakes.** Elastic stress loads at boundaries; a fully active boundary reaches failure in
  ~30 years. Once a tile is critical, failure happens with a 25 % chance per day. A quake releases
  stress within 5 tiles, with magnitude `4.6 + 0.9·log10(1+released) ± 0.3`. Shaking moves debris
  off slopes (> 0.03) into the downslope sediment load, which is a landslide, and kills 30 % of
  vegetation in the zone.
- **Volcanoes.** Vents sit on strong convergent belts and at seed-placed hotspots, at least 6
  tiles apart (~10 per 128² world). Mean recurrence is 60 years per unit vent strength. An
  eruption draws its VEI from an exponential tail, with volume `10^(4.5+VEI)` m³.
  - 60 % becomes lava near the vent: elevation and **stone** increase, vegetation is destroyed,
    and lava heat lingers and cools 3 %/day.
  - 40 % becomes ash over a wider radius: elevation and **clay** increase, and 40 % of vegetation
    is burned.
  - Fires ignite around the edge. Snow on lava melts into surface water (lahars).
  - No volcanic gases, climate forcing or magmatic water. The water budget stays closed.

## Natural-disaster detection (from state, with hysteresis)
- **Flood:** more than 3 % of land under 0.6–1.5 m of standing water; ends below 1 %.
- **Drought:** more than 20 % of vegetated land without 1 mm of rain for 45+ days; ends below 8 %.
- **Major wildfire:** 40+ tiles burning at once. Earthquakes and eruptions are logged where they
  occur.

## Conservation laws (audited every day, shown in the dashboard)
| Law | Closure (measured) |
|---|---|
| Total water (all five stores) | ≤ 3.2×10⁻¹⁵ over 100 years (seed2026-64) |
| Rock mass = Σ elevation × area × ρ + sediment in transit, changed only by tectonic and volcanic counters | ≤ 2.4×10⁻¹³ over 100 years (float accumulation) |
| Sand + clay, changed only by deposition, erosion and ash counters | ~10⁻¹⁶ |
| Stone, changed only by lava counter | exact |
| Iron ore, copper ore, coal | never increase (only `extract()` reduces them) |

## Resources
| Resource | Source of truth | Renewal |
|---|---|---|
| Freshwater (m³) | land surface + soil + snow + groundwater | water cycle only |
| Saltwater (m³) | ocean-tile water | reservoir |
| Wood (t) | 50 % of living biomass | vegetation growth only |
| Organic matter (t) | soil organic matter | litter and char inputs, decomposition losses |
| Sand, clay (t) | deposits | erosion removes; sediment deposition and ash add (geologic timescales) |
| Stone (t) | exposed rock | lava adds |
| Iron ore, copper ore, coal (t) | buried deposits | **never**; finite |

`resources.extract()` remains the only removal path for future inhabitants. It does not yet lower
elevation when stone is quarried, a known limitation for Phase 2+.
