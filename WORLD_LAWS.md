# World Laws

These are the physical rules of DWAPAR Phase 1 and every simplification behind them.
**This is a simplified model, not a reproduction of real-world physics.** Constants
live at the top of `engine/dwapar/prakriti/processes.py` and `brahmanda/terrain.py`.

## Geometry and time
- Square tiles, default 2 km edge (128 tiles ≈ 256 km). Sea level is 0 m. Map edges are
  closed for water; the atmosphere is periodic, so air leaving one edge enters the other.
- One tick = 1 simulated hour (configurable to 2, 3, 4 or 6). There are 24 h/day,
  4 seasons of 90 days, and 360 days/year. Day 0 is the northern spring equinox.
- Latitude spans 48° N (top) to 12° S (bottom) by default.

## Radiation and temperature
- Sun position comes from a circular orbit with a fixed 23.44° axial tilt. Day length,
  polar effects and opposite-hemisphere seasons emerge from `cos(zenith)`. There is no
  atmospheric attenuation, cloud radiative effect or orbital eccentricity.
- The daily-mean equilibrium temperature is `−38 + 210·Q_annual(lat)`, plus a seasonal
  term (amplitude ×95 on land, ×45 over water) lagged 1/8 year behind insolation. There
  is a 6.5 °C/km lapse rate, a diurnal term proportional to instantaneous minus
  daily-mean insolation (damped by soil moisture and water), ±3 °C weather-pattern
  anomalies, −3 °C over snow (albedo) and +12 °C × fire intensity.
- Air temperature relaxes toward equilibrium with time constant 3 h on land and 36 h
  over open water. There is no horizontal heat transport; this is the largest thermal
  simplification.

## Water cycle (conserved)
Stores per tile, all in mm: surface water (including oceans), soil water, atmospheric
precipitable water and snow (water equivalent). **No process creates or destroys
water.** Total water is checked to stay within 1×10⁻⁹ relative over hundreds of ticks.
Extraction (Phase 2+) is the only sink.
- **Saturation capacity** is 24 mm at 15 °C, scaling ~6.5 %/°C (Clausius–Clapeyron-like).
- **Evaporation**: potential rate = `0.35·(0.2+insolation)·e^{0.05(T−15)}·(1−RH)` mm/h.
  It draws first from open water, then soil (×0.4·moisture), then plant transpiration
  (×0.6·moisture·cover), and is reduced 90 % below −5 °C.
- **Transport**: conservative upwind advection by latitude-dependent prevailing winds
  (trade winds westward in the tropics and westerlies eastward at mid-latitudes,
  blended smoothly with tanh across 25°), plus small diffusion.
- **Precipitation**: half of the excess over capacity falls each hour. Effective
  capacity is modulated 0.78–1.20× by a seed-derived daily synoptic weather field.
  Orographic rain emerges because mountain air is colder. Precipitation falls as snow
  on land below 0.5 °C.
- **Snowmelt**: degree-hour model, 0.2 mm per °C·h.
- **Infiltration** up to 8 mm/h into remaining soil capacity. **Baseflow**: soil water
  above 75 % of field capacity drains 2 %/h to the surface (a stand-in for groundwater).
- **Runoff**: water moves to the steepest-descent neighbour (D8) of the water surface,
  equalising 45 % of the drop per tick. A fixed ±0.3 m micro-relief field breaks
  direction ties; it never changes stored elevation. Rivers and lakes are not drawn:
  they are tiles where sustained outflow or standing depth crosses a threshold.
- Oceans are ordinary deep surface water. Water reaching an ocean tile becomes
  saltwater; there is no salinity field or desalination by evaporation.
- **Known limitation:** single-direction (D8) routing produces straight parallel
  channels on planar slopes (visible on smooth coastal ramps). Multiple-flow-direction
  routing is on the roadmap.

## Soil and vegetation
- Field capacity (70–300 mm) comes from a texture field, thinner on steep or high ground.
- Fertility is derived, not stored: `0.55·(1−e^{−OM/8}) + 0.2·clay + 0.25·moisture`, in [0, 1].
- Vegetation is a continuous biomass field (kg/m²), **not organisms**. Daily logistic
  growth is 3.5 %/day × temperature factor (0 at ≤0 °C, full at 12–32 °C, 0 at 42 °C) ×
  moisture factor. Carrying capacity is ≤28 kg/m², scaled by fertility and seasonal
  precipitation. Seed colonisation is faster next to existing vegetation. Mortality has
  four terms: background, drought (moisture < 0.06), frost (< −8 °C) and drowning (> 0.6 m
  standing water). Dead biomass becomes organic matter, which decomposes at 0.15 %/day ×
  temperature and moisture factors. That carbon is not tracked further.
- Growth is accelerated relative to real forests (about a year rather than decades for
  visible recovery) so dynamics can be observed. Initial biomass is a climate guess, so
  the first simulated year shows the world settling toward its own equilibrium (wood
  stock rises sharply). That is spin-up, not a trend.

## Fire
- Fire risk = dryness (soil moisture) × √(days since >1 mm rain / 12) × heat ×
  fuel. It is zero on water, standing water and snow.
- Lightning ignition probability is 3×10⁻⁶ per tile-hour × risk × convective factor.
  Spread to the 8 neighbours is proportional to source intensity × target risk, with a
  1.6× downwind bonus.
- Burning consumes 8 %/h × intensity of biomass. 15 % of the consumed mass returns as
  char to organic matter and the rest leaves as gas (not tracked). Fires go out with rain
  over 0.3 mm/h, fuel below 0.2 kg/m², soil moisture over 0.6, or when intensity decays.
- Events: each ignition (location, risk), a major wildfire when 40+ tiles burn, and
  "all fires out".

## Erosion (mass-conserving)
- Fluvial erosion, once per day: `1e−4·√(outflow mm/h)·slope·(1−0.8·cover)` metres, moved
  to the steepest neighbour. Thermal (talus) erosion applies above slope 0.25. Each step
  is capped at a quarter of the drop. Land is never lowered below +0.5 m in one step, so
  coasts don't drown instantly. Sum of elevation is conserved (tested).
- Eroded material is not yet converted into sand or clay deposits; mineral fields are
  unchanged by erosion.

## Terrain classification (derived daily)
Priority, lowest to highest: plains (default) → desert (precip < 0.9 mm/d, soil < 0.22,
biomass < 2) → forest (biomass ≥ 9 kg/m²) → hills (≥ 750 m or slope ≥ 0.08) → mountains
(≥ 1900 m) → wetland (lowland, standing water ≥ 80 mm or soil ≥ 0.85) → snow (≥ 20 mm SWE)
→ river (outflow ≥ 4 mm/h) → lake (standing water ≥ 1.5 m) → ocean (elevation < 0).

## Resources
| Resource | Source of truth | Renewal |
|---|---|---|
| Freshwater (m³) | land surface + soil + snow water | water cycle only |
| Saltwater (m³) | ocean-tile water | reservoir |
| Wood (t) | 50 % of living biomass | vegetation growth only |
| Organic matter (t) | soil organic matter | litter and char inputs, decomposition losses |
| Stone, sand, clay, iron ore, copper ore, coal (t) | generated geology fields | **never**; finite |

Geology: stone follows elevation and slope; sand is coastal and arid; clay is lowland,
flat and wet; iron and copper are ridged-noise veins in uplands (copper rarer); coal
sits in mid-elevation sedimentary basins. Ocean-floor deposits are zero (inaccessible
by design). Quantities are plausible orders of magnitude, not survey data.
`resources.extract()` is the only operation that removes resources. It never removes
more than exists and rejects negative, NaN or out-of-bounds requests.
