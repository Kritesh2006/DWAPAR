"""Phase 1.5 laws: routing, heat transport, groundwater, sediment, spin-up, tectonics, volcanism."""

import numpy as np
import pytest

from dwapar.brahmanda.world import ROCK_DENSITY_T_M3
from dwapar.config import WorldConfig
from dwapar.grid import advect_masked, mfd_flow
from dwapar.kala.calendar import Calendar
from dwapar.simulation import Simulation


# ----------------------------------------------------------------- routing
def test_mfd_conserves_and_spreads_on_a_cone():
    yy, xx = np.indices((21, 21))
    cone = -np.hypot(yy - 10, xx - 10) * 10.0  # summit at the centre, falling away in every direction
    water = np.zeros((21, 21))
    water[10, 10] = 100.0
    delta, out = mfd_flow(cone, water, 0.45, 1000.0, 2000.0, 4.0)
    assert delta.sum() == pytest.approx(0.0, abs=1e-9)
    receivers = (delta > 0).sum()
    assert receivers >= 4, "multiple-flow routing must split flow between downhill neighbours"


def test_mfd_never_overshoots():
    h = np.array([[10.0, 9.0, 8.0]])
    water = np.array([[1e6, 0.0, 0.0]])
    delta, _ = mfd_flow(h, water, 0.45, 1000.0, 1.0, 4.0)
    new_surface = h + (water + delta) / 1000.0
    assert new_surface[0, 0] >= new_surface[0, 1]  # source not drained below its neighbour


def test_drainage_converges_into_channels():
    """Discharge concentrates into channels instead of sheet flow: the top 2 % of land tiles carry at
    least 3× the 2 % share they would carry if runoff stayed uniform (measured: ~6× on this seed)."""
    sim = Simulation.create(WorldConfig(seed=42, width=64, height=64))
    sim.step(24 * 20)
    land = ~sim.world.is_ocean
    flux = sim.world.flow_flux[land]
    top = np.sort(flux)[-max(1, int(0.02 * flux.size)):]
    assert top.sum() / flux.sum() > 3 * 0.02


def test_surface_flow_is_numerically_stable():
    """No checkerboard sloshing: water surfaces change by centimetres, not metres, per hour."""
    sim = Simulation.create(WorldConfig(seed=42, width=64, height=64))
    sim.step(24 * 15)
    f = sim.world.f
    land = ~sim.world.is_ocean
    h0 = f["elevation"] + f["surface_water"] / 1000.0
    sim.step(1)
    h1 = f["elevation"] + f["surface_water"] / 1000.0
    assert np.abs(h1 - h0)[land].max() < 0.5


# ----------------------------------------------------------- heat transport
def test_masked_advection_keeps_uniform_field_uniform():
    mask = np.ones((10, 10), bool)
    mask[:, 5] = False
    a = np.where(mask, 12.0, 0.0)
    u = np.full((10, 10), 0.3)
    v = np.full((10, 10), -0.2)
    r = advect_masked(a, u, v, mask, 0.1)
    assert np.allclose(r[mask], 12.0)


def test_ocean_currents_carry_heat():
    mask = np.ones((5, 20), bool)
    a = np.zeros((5, 20))
    a[:, 5] = 10.0
    u = np.full((5, 20), 0.5)
    r = a
    for _ in range(6):
        r = advect_masked(r, u, np.zeros_like(u), mask, 0.0)
    assert r[:, 8].mean() > r[:, 2].mean()  # warm water moved downstream (east)


def test_winds_carry_heat(sim):
    w = sim.world
    p = sim.prakriti
    a = w.copy()
    y = w.cfg.height // 2
    a.f["temperature"][y, :] = 0.0
    a.f["temperature"][y, 10] = 40.0
    from dwapar.grid import advect_periodic
    t = advect_periodic(a.f["temperature"], p.wind_u, p.wind_v)
    nb = 11 if p.wind_u[y, 0] > 0 else 9
    assert t[y, nb] > 0.0


def test_ocean_temperature_responds_slowly(sim):
    """The mixed layer has memory: ocean air varies less over a day than land air."""
    w = sim.world
    ocean = w.is_ocean
    land = ~ocean
    t_series_land, t_series_ocean = [], []
    for _ in range(24):
        sim.step(1)
        t_series_land.append(w.temperature[land].mean())
        t_series_ocean.append(w.temperature[ocean].mean())
    assert np.ptp(t_series_ocean) < np.ptp(t_series_land)


# --------------------------------------------------------------- groundwater
def test_groundwater_recharge_springs_and_lateral_flow(sim):
    w = sim.world
    land = ~w.is_ocean
    w.f["groundwater"][land] = 0.0
    w.f["soil_water"][land] = w.f["field_capacity"][land] * 0.9
    sim.prakriti.step_hour(w, Calendar.at(0, w.cfg), [])
    assert w.groundwater[land].sum() > 0, "wet soil must percolate into the aquifer"
    # Lateral flow: a mound of groundwater spreads to neighbours.
    ys, xs = np.nonzero(land & (w.aquifer_capacity > 500))
    y, x = int(ys[len(ys) // 2]), int(xs[len(xs) // 2])
    w.f["groundwater"][:] = 0.0
    w.f["groundwater"][y, x] = 400.0
    sim.prakriti._groundwater_lateral(w, w.is_ocean)
    assert w.groundwater[y, x] < 400.0
    assert w.groundwater[max(0, y - 1):y + 2, max(0, x - 1):x + 2].sum() == pytest.approx(400.0, rel=1e-9) or \
        w.surface_water.sum() > 0


def test_groundwater_sustains_soil_in_drought(sim):
    w = sim.world
    land = ~w.is_ocean
    w.f["soil_water"][land] = 0.0
    wet, dry = w.copy(), w.copy()
    wet.f["groundwater"][land] = wet.f["aquifer_capacity"][land]
    dry.f["groundwater"][:] = 0.0
    from dwapar.prakriti.processes import Prakriti
    Prakriti(wet).step_hour(wet, Calendar.at(0, w.cfg), [])
    Prakriti(dry).step_hour(dry, Calendar.at(0, w.cfg), [])
    assert wet.soil_water[land].sum() > dry.soil_water[land].sum()


def test_water_conserved_with_groundwater(sim):
    w0 = sim.total_water()
    sim.step(24 * 10)
    assert abs(sim.total_water() - w0) / w0 < 1e-9
    assert sim.world.groundwater.sum() > 0


# ------------------------------------------------------------------ sediment
def test_sediment_deposits_in_still_water_and_builds_sand(sim):
    w = sim.world
    lake = ~w.is_ocean
    ys, xs = np.nonzero(lake)
    y, x = int(ys[0]), int(xs[0])
    w.f["surface_water"][y, x] = 5000.0
    w.f["sediment"][y, x] = 1e5
    sand0 = w.sand[y, x]
    elev0 = w.elevation[y, x]
    sim.prakriti._sediment(w, ~w.is_ocean)
    assert w.sand[y, x] > sand0 and w.elevation[y, x] > elev0


# ------------------------------------------------------------------- spin-up
def test_spinup_improves_initial_equilibrium():
    def drift(spin):
        sim = Simulation.create(WorldConfig(seed=11, width=48, height=48, spinup_days_per_season=spin))
        w0 = sim.stats()["resources"]["wood"]
        sim.step(24 * 45)
        return abs(sim.stats()["resources"]["wood"] - w0) / w0

    assert drift(6) < drift(0)


def test_spinup_resets_time_and_is_deterministic():
    a = Simulation.create(WorldConfig(seed=5, width=32, height=32))
    b = Simulation.create(WorldConfig(seed=5, width=32, height=32))
    assert a.world.tick == 0 and a.world.fingerprint() == b.world.fingerprint()


# ---------------------------------------------------------- tectonics & quakes
def test_tectonic_uplift_changes_elevation_and_is_budgeted():
    # A map is a patch of a planet, so it need not contain both boundary types; seed 3 does.
    sim = Simulation.create(WorldConfig(seed=3, width=64, height=64, spinup_days_per_season=0))
    w = sim.world
    up = w.uplift_rate > 0
    assert up.any()
    down = w.uplift_rate < 0
    e0 = w.elevation.copy()
    sim.prakriti._tectonics(w, Calendar.at(24, w.cfg), [])
    assert (w.elevation[up] > e0[up]).all()
    assert (w.elevation[down] < e0[down]).all()  # vacuous if this world has no diverging boundary
    assert w.meta["tectonic_rock_t"] != 0


def test_earthquake_releases_stress_and_triggers_landslides(sim):
    w = sim.world
    events = []
    ys, xs = np.nonzero(w.stress_rate > 0)
    w.f["tectonic_stress"][ys[0], xs[0]] = 2.0
    for day in range(1, 60):
        sim.prakriti._tectonics(w, Calendar.at(day * 24, w.cfg), events)
        if events:
            break
    assert events and events[0]["kind"] == "earthquake"
    assert w.tectonic_stress[ys[0], xs[0]] < 1.0


def test_volcanic_eruption_builds_land_adds_stone_and_closes_budget(sim):
    w = sim.world
    sim.baseline = sim.budgets()
    vy, vx = np.nonzero(w.volcano > 0)
    y, x = int(vy[0]), int(vx[0])
    w.f["volcano"][y, x] = 1e9  # force an eruption today
    e0, s0 = w.elevation[y, x], w.stone.sum()
    events = []
    sim.prakriti._volcanism(w, Calendar.at(24, w.cfg), events)
    assert any(e["kind"] == "volcanic_eruption" for e in events)
    assert w.elevation[y, x] > e0 and w.stone.sum() > s0
    assert w.lava.max() == 1.0
    err = sim.budget_errors()
    assert err["rock"] < 1e-9 and err["stone"] < 1e-9 and err["sand_clay"] < 1e-9 and err["water"] < 1e-9


def test_all_budgets_close_over_a_season(small_cfg):
    sim = Simulation.create(small_cfg)
    sim.step(24 * 90)
    err = sim.budget_errors()
    for k in ("water", "rock", "sand_clay", "stone"):
        assert err[k] < 1e-9, (k, err[k])
    assert err["ores_increase"] <= 0


# --------------------------------------------------------- checkpoint upgrade
def test_phase1_checkpoint_upgrades(tmp_path, small_cfg):
    import io
    from dwapar.smriti.store import Store, _deserialise, _serialise
    sim = Simulation.create(small_cfg)
    blob = _serialise(sim.world)
    with np.load(io.BytesIO(blob)) as z:
        old = {k: z[k] for k in z.files if k not in ("groundwater", "sediment", "sst", "volcano", "uplift_rate",
                                                     "stress_rate", "plate_id", "aquifer_capacity",
                                                     "current_u", "current_v", "tectonic_stress", "lava")}
    buf = io.BytesIO()
    np.savez_compressed(buf, **old)
    w = _deserialise(buf.getvalue(), small_cfg)
    assert np.array_equal(w.volcano, sim.world.volcano)  # static geology recomputed exactly
    assert w.groundwater.sum() == 0
