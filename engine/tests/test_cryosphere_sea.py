"""Laws 1.6: glacier ice and dynamic sea level. Every test also checks water is conserved."""

import numpy as np
import pytest

from dwapar.config import WorldConfig
from dwapar.kala.calendar import Calendar
from dwapar.simulation import Simulation


@pytest.fixture
def s():
    return Simulation.create(WorldConfig(seed=2026, width=40, height=40, spinup_days_per_season=0))


def land_peak(sim):
    w = sim.world
    e = np.where(w.is_ocean, -np.inf, w.elevation)
    return np.unravel_index(np.argmax(e), e.shape)


def test_deep_snow_compacts_into_ice(s):
    w = s.world
    y, x = land_peak(s)
    w.f["snow"][y, x] = 5000.0
    w0 = s.total_water()
    s.prakriti._cryosphere(w, Calendar.at(24, w.cfg))
    assert w.ice[y, x] > 0 and w.snow[y, x] < 5000.0
    assert s.total_water() == pytest.approx(w0, rel=1e-13)


def test_ice_flows_downhill_and_is_conserved(s):
    w = s.world
    y, x = land_peak(s)
    w.f["temp_day"][:] = -30.0
    w.f["atmo_water"][:] = 1e6  # saturated air: no sublimation, isolate flow
    w.f["ice"][y, x] = 2.0e6     # ~2 km thick ice cap
    before = w.ice.sum()
    s.prakriti._cryosphere(w, Calendar.at(24, w.cfg))
    assert w.ice[y, x] < 2.0e6
    assert (w.ice > 0).sum() > 1, "ice should spread to neighbouring tiles"
    assert w.ice.sum() == pytest.approx(before, rel=1e-12)  # nothing reached the sea or melted


def test_warm_ice_melts_into_runoff(s):
    w = s.world
    y, x = land_peak(s)
    w.f["ice"][y, x] = 1000.0
    w.f["snow"][y, x] = 0.0
    w.f["temp_day"][y, x] = 10.0
    sw0 = w.surface_water[y, x]
    s.prakriti._cryosphere(w, Calendar.at(24 * 100, w.cfg))
    assert w.ice[y, x] < 1000.0 - 60.0  # ~70 mm/day at 10 °C
    assert w.surface_water[y, x] > sw0


def test_dry_cold_snow_sublimates_to_atmosphere(s):
    w = s.world
    land = ~w.is_ocean
    w.f["snow"][land] = 100.0
    w.f["temp_day"][:] = -10.0
    w.f["atmo_water"][:] = 0.0
    w0 = s.total_water()
    s.prakriti._cryosphere(w, Calendar.at(24 * 90, w.cfg))  # summer sun
    assert w.atmo_water.sum() > 0 and w.snow[land].sum() < 100.0 * land.sum()
    assert s.total_water() == pytest.approx(w0, rel=1e-13)


def test_ice_reaching_the_sea_calves(s):
    w = s.world
    oy, ox = np.argwhere(w.is_ocean)[0]
    w.f["ice"][oy, ox] = 500.0
    w0 = s.total_water()
    s.prakriti._cryosphere(w, Calendar.at(24, w.cfg))
    assert w.ice[oy, ox] == 0.0
    assert s.total_water() == pytest.approx(w0, rel=1e-13)


def test_sea_falls_when_ocean_water_is_locked_on_land(s):
    w = s.world
    ocean = w.is_ocean
    n0, level0, w0 = int(ocean.sum()), w.sea_level, s.total_water()
    # Lock 2 % of the ocean in an ice sheet on land (as an ice age would).
    take = w.f["surface_water"][ocean] * 0.02
    w.f["surface_water"][ocean] -= take
    y, x = land_peak(s)
    w.f["ice"][y, x] += take.sum()
    events = []
    s.prakriti._sea_level(w, Calendar.at(24, w.cfg), events)
    assert w.sea_level < level0 - 1.0
    assert int(w.is_ocean.sum()) < n0, "new land should emerge as the sea retreats"
    assert s.total_water() == pytest.approx(w0, rel=1e-12)
    assert any(e["kind"] == "sea_level" for e in events)


def test_sea_rises_and_floods_coasts_when_ice_melts(s):
    w = s.world
    n0, level0, w0 = int(w.is_ocean.sum()), w.sea_level, s.total_water()
    ocean = w.is_ocean
    w.f["surface_water"][ocean] += 30_000.0  # +30 m of meltwater on every ocean tile
    w0 = s.total_water()
    s.prakriti._sea_level(w, Calendar.at(24, w.cfg), [])
    assert w.sea_level > level0 + 10.0
    assert int(w.is_ocean.sum()) > n0, "rising sea must flood low coasts"
    assert s.total_water() == pytest.approx(w0, rel=1e-12)
    flat = (w.elevation + w.surface_water / 1000.0)[w.is_ocean]
    assert np.ptp(flat) < 1e-6  # one common sea surface


def test_level_solver_is_accurate():
    from dwapar.prakriti.processes import Prakriti
    elev = np.linspace(-100, 100, 201)
    vol = float(np.maximum(5.0 - elev, 0).sum() * 1000.0)
    assert Prakriti._level_for_volume(elev, vol) == pytest.approx(5.0, abs=1e-9)


def test_all_budgets_close_with_cryosphere_over_a_year():
    sim = Simulation.create(WorldConfig(seed=2026, width=32, height=32))
    sim.step(24 * 360)
    err = sim.budget_errors()
    assert err["water"] < 1e-12 and err["rock"] < 1e-12 and err["sand_clay"] < 1e-12


def test_laws_history_records_continuation(tmp_path):
    """A world created under older laws records the tick at which the current laws took over."""
    from dwapar.laws import LAWS_VERSION
    from dwapar.smriti.store import Store
    sim = Simulation.create(WorldConfig(seed=4, width=24, height=24, spinup_days_per_season=0))
    sim.step(48)
    sim.world.meta.pop("laws_version")
    sim.world.meta.pop("laws_history")  # pretend it is a pre-versioning (1.5) world
    st = Store(tmp_path / "w.sqlite")
    wid = st.create_world(sim.cfg)
    st.save_checkpoint(wid, sim.world)
    cont = Simulation.from_checkpoint(st)
    hist = cont.world.meta["laws_history"]
    assert hist[0]["laws"] == "1.5-or-earlier" and hist[-1] == {"from_tick": 48, "laws": LAWS_VERSION}
    assert any(e["kind"] == "laws_change" for e in cont.recent_events)
