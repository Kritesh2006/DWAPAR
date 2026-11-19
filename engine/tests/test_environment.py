"""Environmental interactions are causal, not cosmetic: perturb one driver, observe the effect."""

import numpy as np
import pytest

from dwapar.prakriti.solar import daily_mean_insolation, instantaneous_insolation


def land_tile(sim, min_elev=50, max_elev=500):
    w = sim.world
    mask = (~w.is_ocean) & (w.elevation > min_elev) & (w.elevation < max_elev) & (w.surface_water < 50)
    ys, xs = np.nonzero(mask)
    assert len(ys) > 0
    return int(ys[len(ys) // 2]), int(xs[len(xs) // 2])


def test_water_is_conserved(sim):
    w0 = sim.total_water()
    sim.step(24 * 15)
    assert abs(sim.total_water() - w0) / w0 < 1e-9


def test_rainfall_increases_soil_moisture(sim):
    w = sim.world
    y, x = land_tile(sim)
    w.f["soil_water"][y, x] = 0.1 * w.f["field_capacity"][y, x]
    w.f["surface_water"][y, x] = 0.0
    # Heavy supersaturated air over the tile -> precipitation -> infiltration.
    a, b = w.copy(), w
    b.f["atmo_water"][y, x] += 200.0
    from dwapar.kala.calendar import Calendar
    from dwapar.prakriti.processes import Prakriti
    pa = Prakriti(a)
    pa.step_hour(a, Calendar.at(a.tick, a.cfg), [])
    sim.prakriti.step_hour(b, Calendar.at(b.tick, b.cfg), [])
    assert b.precip_today[y, x] > a.precip_today[y, x]
    assert b.soil_water[y, x] > a.soil_water[y, x]


def test_soil_moisture_drives_vegetation_growth(sim):
    from dwapar.kala.calendar import Calendar
    w = sim.world
    land = (~w.is_ocean) & (w.surface_water < 300)
    w.f["temp_day"][:] = 20.0
    w.f["biomass"][land] = 5.0
    wet, dry = w.copy(), w.copy()
    wet.f["soil_water"][:] = wet.f["field_capacity"] * 0.7
    dry.f["soil_water"][:] = dry.f["field_capacity"] * 0.03
    cal = Calendar.at(0, w.cfg)
    sim.prakriti.step_day(wet, cal, [])
    sim.prakriti.step_day(dry, cal, [])
    assert wet.biomass[land].sum() > 5.0 * land.sum()  # grew
    assert dry.biomass[land].sum() < 5.0 * land.sum()  # drought stress killed some


def test_drought_increases_fire_risk(sim):
    w = sim.world
    land = (~w.is_ocean) & (w.surface_water < 50) & (w.snow < 5)
    w.f["biomass"][land] = 10.0
    w.f["temperature"][:] = 28.0
    wet, dry = w.copy(), w.copy()
    wet.f["soil_water"][:] = wet.f["field_capacity"] * 0.6
    wet.f["drought_days"][:] = 0
    dry.f["soil_water"][:] = dry.f["field_capacity"] * 0.05
    dry.f["drought_days"][:] = 30
    assert sim.prakriti.fire_risk(wet)[land].mean() == 0.0
    assert sim.prakriti.fire_risk(dry)[land].mean() > 0.5


def test_fire_consumes_biomass_and_spreads_in_dry_fuel(sim):
    from dwapar.kala.calendar import Calendar
    w = sim.world
    land = (~w.is_ocean) & (w.surface_water < 50)
    w.f["biomass"][land] = 15.0
    w.f["soil_water"][:] = w.f["field_capacity"] * 0.02
    w.f["drought_days"][:] = 40
    w.f["temperature"][:] = 32.0
    w.f["snow"][:] = 0
    y, x = land_tile(sim, 0, 3000)
    w.f["fire"][y, x] = 1.0
    b0 = w.biomass.sum()
    om0 = w.organic_matter.sum()
    for t in range(12):
        sim.prakriti._fire(w, Calendar.at(t, w.cfg), [], np.zeros(w.shape), 1.0)
    assert (w.fire > 0).sum() > 1, "fire should spread through dry fuel"
    assert w.biomass.sum() < b0
    assert w.organic_matter.sum() > om0  # char returns to soil


def test_rain_extinguishes_fire(sim):
    from dwapar.kala.calendar import Calendar
    w = sim.world
    y, x = land_tile(sim)
    w.f["biomass"][y, x] = 15.0
    w.f["fire"][y, x] = 0.8
    rain = np.zeros(w.shape)
    rain[y, x] = 5.0
    sim.prakriti._fire(w, Calendar.at(0, w.cfg), [], rain, 1.0)
    assert w.fire[y, x] == 0.0


def test_day_night_cycle():
    lat = np.deg2rad(np.array([[30.0]]))
    noon = instantaneous_insolation(lat, 45, 12, 360)
    midnight = instantaneous_insolation(lat, 45, 0, 360)
    assert noon[0, 0] > 0.5 and midnight[0, 0] == 0.0


def test_seasons_follow_insolation():
    north = np.deg2rad(np.array([[45.0]]))
    south = np.deg2rad(np.array([[-30.0]]))
    summer, winter = 90, 270  # solstices in a 360-day year
    assert daily_mean_insolation(north, summer, 360) > daily_mean_insolation(north, winter, 360) * 2
    assert daily_mean_insolation(south, summer, 360) < daily_mean_insolation(south, winter, 360)


def test_daytime_warmer_than_night(sim):
    w = sim.world
    land = ~w.is_ocean
    temps = {}
    for _ in range(48):
        h = sim.calendar.hour
        sim.step(1)
        if h in (4.0, 14.0):
            temps.setdefault(h, []).append(w.temperature[land].mean())
    assert np.mean(temps[14.0]) > np.mean(temps[4.0]) + 2


def test_snow_accumulates_when_cold_and_melts_when_warm(sim):
    from dwapar.kala.calendar import Calendar
    w = sim.world
    y, x = land_tile(sim)
    # Whole air mass is cold (a single cold tile would now be mixed away by wind heat transport).
    w.f["atmo_water"][y - 1:y + 2, x - 1:x + 2] = 300.0
    w.f["temperature"][:] = -15.0
    sim.prakriti.step_hour(w, Calendar.at(0, w.cfg), [])
    assert w.snow[y, x] > 0
    snow = w.snow[y, x]
    w.f["temperature"][:] = 15.0
    w.f["atmo_water"][:] = 0.0
    # temperature relaxes toward equilibrium within the step; still well above 0 °C after one step
    sim.prakriti.step_hour(w, Calendar.at(14, w.cfg), [])
    assert w.snow[y, x] < snow


def test_water_flows_downhill(sim):
    w = sim.world
    from dwapar.grid import steepest_descent
    d, drop, _ = steepest_descent(w.elevation, w.cfg.tile_size_m)
    ys, xs = np.nonzero((~w.is_ocean) & (drop > 20) & (w.surface_water < 10))
    y, x = int(ys[0]), int(xs[0])
    w.f["surface_water"][y, x] = 500.0
    from dwapar.kala.calendar import Calendar
    sim.prakriti.step_hour(w, Calendar.at(0, w.cfg), [])
    assert w.surface_water[y, x] < 500.0 - 8.0  # more left than infiltration alone can remove


def test_erosion_conserves_rock_mass(sim):
    """Elevation × area × density + sediment in transit is conserved by erosion/deposition."""
    from dwapar.brahmanda.world import ROCK_DENSITY_T_M3
    from dwapar.kala.calendar import Calendar
    w = sim.world
    w.f["flow_flux"][:] = 50.0
    rho_a = w.cfg.tile_size_m ** 2 * ROCK_DENSITY_T_M3
    w.f["uplift_rate"][:] = 0.0  # isolate surface processes
    w.f["volcano"][:] = 0.0
    m0 = w.elevation.sum() * rho_a + w.sediment.sum()
    elev_before = w.elevation.copy()
    sim.prakriti.step_day(w, Calendar.at(24, w.cfg), [])
    m1 = w.elevation.sum() * rho_a + w.sediment.sum()
    assert m1 == pytest.approx(m0, rel=1e-12)
    assert not np.array_equal(w.elevation, elev_before)
    assert w.sediment.sum() > 0
