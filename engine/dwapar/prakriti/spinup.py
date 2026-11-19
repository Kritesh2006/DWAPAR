"""Pre-history spin-up: bring a freshly generated world close to climatic equilibrium.

Generation starts from a climate *guess* (a moisture proxy). Without spin-up the first
simulated year is dominated by the world correcting that guess (vegetation stock rose
~115 % in year 1 in Phase 1). The spin-up:

1. runs the real hourly/daily physics for a few days in each of the four seasons, so the
   water cycle, ocean temperatures and aquifers settle and an annual-mean precipitation is
   *measured* rather than guessed;
2. sets vegetation and soil organic matter to the analytic equilibrium of the vegetation
   model under that measured climate (logistic growth = mortality; litter = decomposition);
3. discards the spin-up's events and resets time to tick 0. All of this is deterministic.
"""

from __future__ import annotations

import numpy as np

from ..brahmanda.world import World
from ..kala.calendar import Calendar
from .processes import (
    DECOMP_DAY,
    VEG_GROWTH_DAY,
    VEG_MORTALITY_DAY,
    Prakriti,
    _veg_factors,
    carrying_capacity,
)


def spin_up(world: World, prakriti: Prakriti, days_per_season: int = 6, settle_days: int = 4) -> dict:
    cfg = world.cfg
    tpd = cfg.ticks_per_day
    sink: list[dict] = []
    precip_sum = np.zeros(world.shape)
    sm_sum = np.zeros(world.shape)
    n_days = 0
    for season in (1, 2, 3, 0):  # summer, autumn, winter, then spring (the world starts in spring)
        day0 = season * cfg.days_per_season
        for d in range(days_per_season):
            for h in range(tpd):
                prakriti.step_hour(world, Calendar.at((day0 + d) * tpd + h, cfg), sink)
            precip_sum += world.f["precip_today"]
            sm_sum += world.soil_moisture
            n_days += 1
            world.f["precip_today"][:] = 0.0
    # Settle the hydrology at the real start date without counting toward climate means.
    for d in range(settle_days):
        for h in range(tpd):
            prakriti.step_hour(world, Calendar.at(d * tpd + h, cfg), sink)
        world.f["precip_today"][:] = 0.0

    f = world.f
    ocean = world.is_ocean
    land = ~ocean
    measured = precip_sum / n_days
    # Blend measured precipitation with the prior so a few sampled days don't overfit weather noise.
    f["precip_ema"] = np.where(land, 0.7 * measured + 0.3 * f["precip_ema"], measured)
    f["temp_ema"] = f["temperature"].copy()
    f["temp_day"] = f["temperature"].copy()
    f["drought_days"] = np.zeros(world.shape)
    f["flow_flux"] = np.where(land, f["flow_flux"], 0.0)

    # Vegetation equilibrium under the annual-mean climate.
    t_ann = prakriti.annual_mean_temperature(world)
    sm_mean = sm_sum / n_days
    f_t, f_w = _veg_factors(t_ann, sm_mean)
    k = carrying_capacity(world.fertility, f["precip_ema"])
    growth = VEG_GROWTH_DAY * f_t * f_w
    with np.errstate(divide="ignore", invalid="ignore"):
        b_eq = np.where(growth > VEG_MORTALITY_DAY, k * (1.0 - VEG_MORTALITY_DAY / growth), 0.0)
    flooded = f["surface_water"] > 600.0
    b_eq = np.where(land & ~flooded, np.clip(b_eq, 0, None), 0.0)
    decomp = DECOMP_DAY * f_t * (0.3 + 0.7 * f_w)
    with np.errstate(divide="ignore", invalid="ignore"):
        om_eq = np.where(decomp > 1e-6, VEG_MORTALITY_DAY * b_eq / decomp, f["organic_matter"])
    f["biomass"] = b_eq
    # Cold/dry soils decompose slowly; cap the analytic value at a plausible soil-carbon ceiling.
    f["organic_matter"] = np.where(land, np.clip(np.maximum(om_eq, 0.5), 0, 60.0), 0.0)
    f["fire"][:] = 0.0
    world.tick = 0
    world.meta = {"spinup_days": n_days + settle_days}
    prakriti.reclassify(world)
    world.validate()
    return {"days": n_days + settle_days, "discarded_events": len(sink)}
