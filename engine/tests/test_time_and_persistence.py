import numpy as np
import pytest

from dwapar.brahmanda.world import InvalidStateError
from dwapar.config import WorldConfig
from dwapar.kala.calendar import Calendar
from dwapar.simulation import Simulation
from dwapar.smriti.store import CheckpointError, Store


# ---------------------------------------------------------------- time
def test_calendar_progression():
    cfg = WorldConfig(seed=1, width=32, height=32)
    assert Calendar.at(0, cfg).label() == "Year 1, Day 1 (spring), 00:00"
    c = Calendar.at(24 * 90, cfg)
    assert (c.season, c.day_of_year, c.is_season_start) == ("summer", 90, True)
    c = Calendar.at(24 * 360 + 13, cfg)
    assert (c.year, c.day_of_year, c.hour) == (1, 0, 13)
    with pytest.raises(ValueError):
        Calendar.at(-1, cfg)


def test_calendar_with_multi_hour_ticks():
    cfg = WorldConfig(seed=1, width=32, height=32, hours_per_tick=6)
    assert cfg.ticks_per_day == 4
    assert Calendar.at(4, cfg).day_total == 1


def test_time_advances_by_ticks(sim):
    sim.step(30)
    assert sim.world.tick == 30
    assert sim.calendar.day_total == 1 and sim.calendar.hour == 6
    with pytest.raises(ValueError):
        sim.step(-1)


def test_season_and_year_events(small_cfg):
    cfg = WorldConfig(seed=3, width=24, height=24, days_per_season=2)
    sim = Simulation.create(cfg)
    sim.step(cfg.ticks_per_day * cfg.days_per_year + 1)
    kinds = [e["kind"] for e in sim.recent_events]
    assert kinds.count("season") == 4 and kinds.count("year") == 1


# ---------------------------------------------------------------- reproducibility
def test_simulation_reproducible(small_cfg):
    a, b = Simulation.create(small_cfg), Simulation.create(small_cfg)
    a.step(24 * 10)
    b.step(24 * 10)
    assert a.world.fingerprint() == b.world.fingerprint()


def test_step_granularity_irrelevant(small_cfg):
    """Stepping 240 ticks at once or one-by-one gives identical worlds (frame-rate independence)."""
    a, b = Simulation.create(small_cfg), Simulation.create(small_cfg)
    a.step(240)
    for _ in range(240):
        b.step(1)
    assert a.world.fingerprint() == b.world.fingerprint()


# ---------------------------------------------------------------- persistence
def test_checkpoint_roundtrip_exact(sim, store):
    sim.step(50)
    wid = store.create_world(sim.cfg)
    cid = store.save_checkpoint(wid, sim.world)
    loaded, lwid = store.load_checkpoint(cid)
    assert lwid == wid
    assert loaded.fingerprint() == sim.world.fingerprint()


def test_checkpoint_recovery_continues_identically(small_cfg, tmp_path):
    """Run A for 300 ticks uninterrupted. Run B for 150, 'shut down', reopen the DB, run 150 more."""
    a = Simulation.create(small_cfg)
    a.step(300)

    db = tmp_path / "world.sqlite"
    s1 = Store(db)
    b = Simulation.create(small_cfg, s1)
    b.step(150)
    b.checkpoint("manual")
    s1.close()
    del b

    s2 = Store(db)
    c = Simulation.from_checkpoint(s2)
    assert c.world.tick == 150
    c.step(150)
    assert c.world.fingerprint() == a.world.fingerprint()
    s2.close()


def test_auto_checkpoints_and_pruning(tmp_path):
    cfg = WorldConfig(seed=9, width=24, height=24, checkpoint_every_days=1, checkpoint_retain=3)
    st = Store(tmp_path / "w.sqlite")
    sim = Simulation.create(cfg, st)
    sim.step(24 * 6)
    cps = st.list_checkpoints(sim.world_id)
    labels = [c["label"] for c in cps]
    assert labels.count("auto") == 3 and labels.count("genesis") == 1
    assert max(c["tick"] for c in cps) == 24 * 6
    assert len(st.stats_history(sim.world_id)) == 7  # genesis + 6 days


def test_rewind_truncates_future_history(tmp_path, small_cfg):
    st = Store(tmp_path / "w.sqlite")
    sim = Simulation.create(small_cfg, st)
    sim.step(24 * 2)
    cid = sim.checkpoint("manual")
    sim.step(24 * 6)
    assert max(s["tick"] for s in st.stats_history(sim.world_id)) == 24 * 8
    sim2 = Simulation.from_checkpoint(st, checkpoint_id=cid)
    assert max(s["tick"] for s in st.stats_history(sim2.world_id)) == 24 * 2


def test_corrupt_checkpoint_rejected(sim, store):
    wid = store.create_world(sim.cfg)
    cid = store.save_checkpoint(wid, sim.world)
    store.conn.execute("UPDATE checkpoints SET state = ? WHERE id = ?", (b"garbage", cid))
    with pytest.raises(CheckpointError):
        store.load_checkpoint(cid)


def test_missing_checkpoint(store):
    with pytest.raises(CheckpointError):
        store.load_checkpoint()


# ---------------------------------------------------------------- invalid state
def test_invalid_state_detected(sim):
    sim.world.f["soil_water"][3, 3] = -5.0
    with pytest.raises(InvalidStateError):
        sim.world.validate()
    sim.world.f["soil_water"][3, 3] = 0.0
    sim.world.f["temperature"][1, 1] = np.nan
    with pytest.raises(InvalidStateError):
        sim.world.validate()


def test_engine_refuses_to_continue_from_invalid_state(sim):
    sim.world.f["biomass"][2, 2] = np.inf
    with pytest.raises(InvalidStateError):
        sim.step(sim.validate_every)


def test_invalid_state_never_reached_in_long_run(small_cfg):
    sim = Simulation.create(small_cfg)
    sim.validate_every = 1
    sim.step(24 * 120)  # validates every tick for 120 simulated days
    sim.world.validate()


def test_no_inhabitants_exist(sim):
    """Phase 1 constitution: the world contains no agents of any kind."""
    import dwapar.buddhi as buddhi
    import dwapar.prana as prana
    assert [n for n in dir(prana) if not n.startswith("_")] == []
    assert [n for n in dir(buddhi) if not n.startswith("_")] == []
    assert not any(k in sim.world.f for k in ("population", "agents", "inhabitants", "animals"))
