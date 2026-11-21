"""Divine commands, life (animals and humans) and WITNESS — authorised by the owner (D-035)."""

import math

import numpy as np
import pytest

from dwapar.config import WorldConfig
from dwapar.divine import CommandError, schedule_replay
from dwapar.observatory import Observatory
from dwapar.simulation import Simulation
from dwapar.smriti.store import Store


@pytest.fixture(scope="module")
def base_cfg():
    return WorldConfig(seed=77, width=40, height=40, spinup_days_per_season=2)


def _land_spot(world, min_bio=6.0):
    ys, xs = np.nonzero((~world.is_ocean) & (world.f["biomass"] > min_bio) & (world.f["elevation"] - world.sea_level > 30))
    k = len(xs) // 2
    return int(xs[k]), int(ys[k])


# ---------------------------------------------------------------- divine commands
def test_commands_change_persistent_state_and_are_logged(base_cfg, tmp_path):
    store = Store(tmp_path / "w.sqlite")
    sim = Simulation.create(base_cfg, store)
    x, y = _land_spot(sim.world)
    b0 = float(sim.world.f["biomass"][y, x])
    sim.submit_command("plant_forest", {"x": x, "y": y, "radius": 2, "biomass_kg_m2": 8}, "creator", "test")
    assert sim.world.f["biomass"][y, x] == b0  # queued, not yet applied
    sim.step(1)
    assert sim.world.f["biomass"][y, x] > b0 + 7.0
    sim.checkpoint("manual")
    world, _ = store.load_checkpoint(world_id=sim.world_id)
    assert world.f["biomass"][y, x] > b0 + 7.0  # it persisted
    log = store.commands(sim.world_id)
    assert [(c["kind"], c["status"], c["issuer"]) for c in log] == [("plant_forest", "applied", "creator")]
    assert log[0]["result"]["biomass_kg"] > 0
    assert world.meta["divine"]["biomass_kg"] == pytest.approx(log[0]["result"]["biomass_kg"])
    store.close()


def test_invalid_commands_are_refused_and_recorded(base_cfg, tmp_path):
    store = Store(tmp_path / "w.sqlite")
    sim = Simulation.create(base_cfg, store)
    ys, xs = np.nonzero(sim.world.is_ocean)
    with pytest.raises(CommandError, match="ocean"):
        sim.submit_command("plant_forest", {"x": int(xs[0]), "y": int(ys[0])}, "witness")
    with pytest.raises(CommandError):
        sim.submit_command("shape_land", {"x": 1, "y": 1, "height_m": 99999}, "creator")
    with pytest.raises(CommandError, match="unknown species"):
        sim.submit_command("create_animals", {"species": "dragon", "x": 1, "y": 1}, "creator")
    assert {c["status"] for c in store.commands(sim.world_id)} == {"rejected"}
    store.close()


def test_divine_acts_keep_conservation_audits_closed(base_cfg):
    sim = Simulation.create(base_cfg)
    x, y = _land_spot(sim.world)
    for kind, p in (("create_lake", {"x": x, "y": y, "radius": 1.5, "depth_m": 10}),
                    ("bring_rain", {"x": x, "y": y, "amount_mm": 60}),
                    ("restore_ecosystem", {"x": x, "y": y}),
                    ("shape_land", {"x": x, "y": y, "radius": 2, "height_m": 600}),
                    ("carve_channel", {"x0": x, "y0": y, "x1": min(x + 6, 39), "y1": y}),
                    ("climate_forcing", {"x": x, "y": y, "delta_c": 4, "days": 3})):
        sim.submit_command(kind, p, "creator")
    sim.step(24 * 4)
    err = sim.budget_errors()
    assert err["water"] < 1e-12  # water was moved from the ocean, never created
    assert err["rock"] < 1e-12   # reshaped rock is counted in meta["divine"]["rock_t"]
    assert sim.world.meta["divine"]["rock_t"] != 0


def test_climate_forcing_warms_the_region_while_it_lasts(base_cfg):
    a, b = Simulation.create(base_cfg), Simulation.create(base_cfg)
    x, y = 20, 20
    a.submit_command("climate_forcing", {"x": x, "y": y, "radius": 5, "delta_c": 6, "days": 5}, "creator")
    a.step(24 * 3)
    b.step(24 * 3)
    assert a.world.f["temperature"][y, x] - b.world.f["temperature"][y, x] > 3.0


def test_replaying_the_command_log_reproduces_the_world_exactly(base_cfg, tmp_path):
    store = Store(tmp_path / "w.sqlite")
    live = Simulation.create(base_cfg, store)
    x, y = _land_spot(live.world)
    live.step(5)
    live.submit_command("plant_forest", {"x": x, "y": y}, "creator")
    live.step(7)
    live.submit_command("create_animals", {"species": "deer", "x": x, "y": y, "count": 10}, "witness", "test")
    live.submit_command("create_humans", {"x": x, "y": y, "count": 4}, "witness", "test")
    live.step(30)
    live.submit_command("bring_rain", {"x": x, "y": y}, "creator")
    live.step(24 * 3)
    # replay from genesis, with no decision-maker: only the log
    genesis = [c for c in store.list_checkpoints(live.world_id) if c["label"] == "genesis"][0]
    world, _ = store.load_checkpoint(checkpoint_id=genesis["id"])
    replay = Simulation(world)
    assert schedule_replay(replay.world, store.commands(live.world_id)) == 4
    replay.step(live.world.tick)
    assert replay.world.fingerprint() == live.world.fingerprint()
    store.close()


# ---------------------------------------------------------------- life
def test_life_is_deterministic_and_survives_a_mid_day_checkpoint(base_cfg, tmp_path):
    store = Store(tmp_path / "w.sqlite")
    sim = Simulation.create(base_cfg, store)
    x, y = _land_spot(sim.world)
    for sp, n in (("deer", 15), ("rabbit", 15), ("wolf", 2)):
        sim.submit_command("create_animals", {"species": sp, "x": x, "y": y, "count": n}, "creator")
    sim.submit_command("create_humans", {"x": x, "y": y, "count": 8}, "creator")
    sim.step(24 * 2 + 13)  # mid-day
    cid = sim.checkpoint("manual")
    sim.step(24 * 5)
    restored = Simulation.from_checkpoint(store, checkpoint_id=cid)
    restored.step(24 * 5)
    assert restored.world.life is not None and len(restored.world.life.humans) > 0
    assert restored.world.fingerprint() == sim.world.fingerprint()
    store.close()


def test_prey_flees_a_hungry_predator_and_learns_wariness(base_cfg):
    sim = Simulation.create(base_cfg)
    x, y = _land_spot(sim.world)
    sim.submit_command("create_animals", {"species": "deer", "x": x, "y": y, "count": 1}, "creator")
    sim.submit_command("create_animals", {"species": "wolf", "x": x, "y": y, "count": 1}, "creator")
    sim.step(1)
    life = sim.world.life
    deer = next(a for a in life.animals if a.sp == "deer")
    wolf = next(a for a in life.animals if a.sp == "wolf")
    wolf.energy, deer.hydration, deer.energy = 0.3, 1.0, 1.0
    wolf.x, wolf.y = deer.x + 600.0, deer.y
    d0, w0 = 600.0, deer.wariness
    sim.step(1)
    if deer.id in {a.id for a in life.animals}:  # it may also have been caught — then the hunt worked
        assert deer.action == "flee"
        assert math.hypot(deer.x - wolf.x, deer.y - wolf.y) > d0 or deer.wariness > w0
        assert deer.wariness > w0


def test_grazing_and_death_change_the_physical_world(base_cfg):
    sim = Simulation.create(base_cfg)
    x, y = _land_spot(sim.world)
    sim.submit_command("create_animals", {"species": "bison", "x": x, "y": y, "count": 40}, "creator")
    sim.step(24 * 10)
    led = sim.world.life.ledger
    assert led["plants_eaten_kg"] > 0
    assert sim.budget_errors()["water"] < 1e-12


def _tiger_trial(cfg, with_tiger: bool):
    sim = Simulation.create(cfg)
    x, y = _land_spot(sim.world)
    sim.submit_command("create_humans", {"x": x, "y": y, "count": 10}, "creator")
    sim.step(1)
    life = sim.world.life
    if with_tiger:
        sim.submit_command("create_animals", {"species": "tiger", "x": x, "y": y, "count": 1}, "creator")
        sim.step(1)
        tiger = next(a for a in life.animals if a.sp == "tiger")
        h0 = life.humans[0]
        tiger.x, tiger.y, tiger.energy = h0.x + 350.0, h0.y, 0.25  # hungry, close
    fled, first_shelter = False, None
    for t in range(24 * 25):
        sim.step(1)
        fled = fled or any(h.action == "flee" for h in life.humans)
        if first_shelter is None and any(s.get("done") for s in life.structures.values()):
            first_shelter = t
    return sim, fled, first_shelter


def test_human_meets_a_tiger_flees_remembers_tells_others_and_builds_shelter(base_cfg):
    """The brief's example, as an experiment: the same humans with and without a tiger nearby.
    Nothing is scripted; the differences come from perception, memory, learned fear and choice."""
    sim, fled, shelter_t = _tiger_trial(base_cfg, with_tiger=True)
    ctrl, ctrl_fled, ctrl_shelter_t = _tiger_trial(base_cfg, with_tiger=False)
    humans = sim.world.life.humans
    tick = sim.world.tick
    assert fled and not ctrl_fled
    # remembered: learned fear above the innate level, the place of danger, and the episode itself
    afraid = [h for h in humans if h.fear_of.get("tiger", 0) > 0.3]
    assert afraid
    assert any(d[3] == "tiger" for h in afraid for d in h.places["danger"])
    assert any("tiger" in e[1] for h in afraid for e in h.episodes)
    # told others: someone learned of the tiger from another person
    assert any("warned me of a tiger" in e[1] or "killed" in e[1] for h in humans for e in h.episodes)
    # sought protection: the remembered threat makes shelter more valuable, so it comes sooner
    assert max(h.threat_level(tick) for h in humans) > max((h.threat_level(ctrl.world.tick) for h in ctrl.world.life.humans), default=0)
    assert shelter_t is not None
    assert ctrl_shelter_t is None or shelter_t < ctrl_shelter_t


def test_humans_learn_skills_by_practice_and_teaching(base_cfg):
    sim = Simulation.create(base_cfg)
    x, y = _land_spot(sim.world)
    sim.submit_command("create_humans", {"x": x, "y": y, "count": 8}, "creator")
    sim.step(1)
    start = {h.id: dict(h.skills) for h in sim.world.life.humans}
    sim.step(24 * 40)
    grown = [h for h in sim.world.life.humans if h.id in start and h.skills["forage"] > start[h.id]["forage"] + 0.05]
    assert grown, "foraging skill should grow with practice"
    assert not any(k not in ("forage", "hunt", "build", "tools") for h in sim.world.life.humans for k in h.skills)


# ---------------------------------------------------------------- WITNESS
def test_witness_awakens_talks_acts_and_remembers_across_sessions(tmp_path):
    db = tmp_path / "w.sqlite"
    obs = Observatory(db, WorldConfig(seed=11, width=40, height=40, spinup_days_per_season=2), speed=0)
    intro = obs.witness.introduce()["text"]
    assert intro.startswith("Creator, I am awake.")
    assert "no civilization calls it home" in intro
    assert f"{obs.sim.world.f['elevation'].max() - obs.sim.world.sea_level:,.0f} m" in intro  # real numbers
    assert obs.witness.introduce() is None  # introduces itself once

    replies = obs.witness.converse("You decide. Create a civilization, but protect the environment.")
    text = " ".join(r["text"] for r in replies)
    assert "balanced ecosystem" in text and "humanity" in text
    queued = obs.sim.world.meta["command_queue"]
    assert queued and all(c["issuer"] == "witness" and c["kind"] == "create_animals" for c in queued)
    obs.sim.step(1)
    assert obs.sim.world.life is not None and len(obs.sim.world.life.animals) > 0  # a real act of creation
    assert all(c["status"] == "applied" for c in obs.store.commands(obs.sim.world_id))
    summary = obs.witness.summary(running=False)
    assert summary["autonomy"] and summary["directives"]["protect_environment"] and not summary["acting_now"]
    obs.shutdown()

    obs2 = Observatory(db, None, speed=0)  # a new session
    st = obs2.witness.state
    assert st["autonomy"] and st["directives"]["may_create_humans"] and st["introduced"]
    mem = " ".join(r["text"] for r in obs2.witness.converse("What do you remember?"))
    assert "protect the environment" in mem
    hist = " ".join(r["text"] for r in obs2.witness.converse("What have you done?"))
    assert "created" in hist
    obs2.shutdown()


def test_witness_autonomy_cycle_verifies_and_learns(tmp_path):
    obs = Observatory(tmp_path / "w.sqlite", WorldConfig(seed=11, width=40, height=40, spinup_days_per_season=2), speed=0)
    obs.witness.converse("You decide. Create a civilization, but protect the environment.")
    obs.sim.step(24 * 70)  # the daily cycle runs inside the engine step
    st = obs.witness.state
    assert st["cycles"] >= 69
    assert st["action_values"].get("create_animals", {}).get("n", 0) >= 1  # outcomes checked and learned from
    lessons = obs.store.witness_memories(obs.sim.world_id, kinds=["lesson", "mistake"])
    assert lessons and any("create animals" in m["text"] for m in lessons)
    # every change WITNESS made is a logged command
    assert all(c["issuer"] in ("witness", "creator") for c in obs.store.commands(obs.sim.world_id))
    obs.shutdown()


def test_witness_obeys_do_not_intervene(tmp_path):
    obs = Observatory(tmp_path / "w.sqlite", WorldConfig(seed=11, width=40, height=40, spinup_days_per_season=2), speed=0)
    obs.witness.converse("Do not intervene. Just watch.")
    assert obs.witness.state["directives"]["intervention"] == "none"
    obs.witness.set_autonomy(True)
    obs.sim.step(24 * 20)
    assert obs.store.commands(obs.sim.world_id) == []
    obs.shutdown()


# ---------------------------------------------------------------- API
def test_witness_and_life_api(tmp_path):
    from fastapi.testclient import TestClient
    from dwapar.api.server import create_app
    app = create_app(tmp_path / "api.sqlite", WorldConfig(seed=5, width=32, height=32, spinup_days_per_season=2), autostart=False)
    with TestClient(app) as c:
        w = c.get("/api/witness").json()
        assert w["name"] == "WITNESS" and w["immortal"] and w["acting_now"] is False
        intro = c.post("/api/witness/introduce").json()["messages"]
        assert intro and intro[0]["text"].startswith("Creator, I am awake.")
        assert c.post("/api/witness/introduce").json()["messages"] == []
        assert c.get("/api/life").json()["present"] is False
        r = c.post("/api/witness/message", json={"text": "create 12 deer"}).json()
        assert "It is done" in r["messages"][0]["text"]
        c.post("/api/control", json={"action": "step", "ticks": 2})
        life = c.get("/api/life").json()
        assert life["present"] and life["summary"]["animals"]["deer"] == 12
        aid = life["agents"]["animals"][0][0]
        assert c.get(f"/api/life/{aid}").json()["sp"] == "deer"
        assert c.post("/api/commands", json={"kind": "plant_forest", "params": {"x": 999, "y": 0}}).status_code == 422
        cmds = c.get("/api/commands").json()
        assert [x["status"] for x in cmds["commands"]].count("applied") == 1 and "create_humans" in cmds["kinds"]
        msgs = c.get("/api/witness/messages").json()["messages"]
        assert [m["speaker"] for m in msgs] == ["witness", "creator", "witness"]
        assert c.get("/api/witness/memories?kind=creation").json()["memories"]
        assert c.post("/api/witness/autonomy", json={"enabled": True}).json()["witness"]["autonomy"] is True
        obs = c.get("/api/witness/observe").json()
        assert obs["life"]["animals"]["deer"] == 12
