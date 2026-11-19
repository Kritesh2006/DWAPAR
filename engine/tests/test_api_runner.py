import base64
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from dwapar.api.server import create_app
from dwapar.config import WorldConfig
from dwapar.observatory import Observatory


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path / "api.sqlite", WorldConfig(seed=5, width=32, height=32), autostart=False)
    with TestClient(app) as c:
        yield c


def test_status_and_layers(client):
    st = client.get("/api/status").json()
    assert st["seed"] == 5 and st["running"] is False and st["calendar"]["tick"] == 0
    for name in ("terrain", "elevation", "temperature", "moisture", "vegetation", "water", "minerals",
                 "fertility", "fire_risk"):
        r = client.get(f"/api/layer/{name}").json()
        raw = base64.b64decode(r["data"])
        n = 32 * 32 * (1 if r["dtype"] == "uint8" else 4)
        assert len(raw) == n
    assert client.get("/api/layer/population").status_code == 404


def test_step_and_tile(client):
    r = client.post("/api/control", json={"action": "step", "ticks": 30}).json()
    assert r["calendar"]["tick"] == 30
    tile = client.get("/api/tile/10/10").json()
    assert "resources" in tile and "terrain" in tile
    assert client.get("/api/tile/99/0").status_code == 404
    hist = client.get("/api/stats/history").json()
    assert len(hist) == 2  # genesis + day 1


def test_layer_reflects_actual_state(client):
    a = client.get("/api/layer/temperature").json()
    client.post("/api/control", json={"action": "step", "ticks": 12})
    b = client.get("/api/layer/temperature").json()
    ta = np.frombuffer(base64.b64decode(a["data"]), dtype=np.float32)
    tb = np.frombuffer(base64.b64decode(b["data"]), dtype=np.float32)
    assert not np.array_equal(ta, tb) and b["tick"] == 12


def test_save_load_and_new(client):
    client.post("/api/control", json={"action": "step", "ticks": 5})
    cid = client.post("/api/save").json()["checkpoint_id"]
    client.post("/api/control", json={"action": "step", "ticks": 20})
    assert client.post("/api/load", json={"checkpoint_id": cid}).json()["calendar"]["tick"] == 5
    assert client.post("/api/load", json={"checkpoint_id": 9999}).status_code == 404
    r = client.post("/api/new", json={"seed": 77, "width": 32, "height": 32}).json()
    assert r["seed"] == 77 and r["calendar"]["tick"] == 0
    assert client.post("/api/new", json={"seed": 1, "width": 3, "height": 3}).status_code == 422


def test_invalid_commands(client):
    assert client.post("/api/control", json={"action": "explode"}).status_code == 422
    assert client.post("/api/speed", json={"hours_per_second": -4}).status_code == 422
    client.post("/api/control", json={"action": "start"})
    assert client.post("/api/control", json={"action": "step"}).status_code == 409
    client.post("/api/control", json={"action": "pause"})


def test_websocket_streams_status(client):
    with client.websocket_connect("/ws") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "status" and "calendar" in msg["status"]


def test_runner_advances_unattended_and_recovers(tmp_path):
    db = tmp_path / "run.sqlite"
    cfg = WorldConfig(seed=21, width=24, height=24)
    obs = Observatory(db, cfg, speed=0)  # max speed, no dashboard involved
    obs.start(run=True)
    time.sleep(1.5)
    obs.shutdown()
    tick = obs.sim.world.tick
    assert tick > 24, "world should advance without any observer"
    obs2 = Observatory(db, cfg)
    assert obs2.recovered and obs2.sim.world.tick == tick
    obs2.shutdown()


def test_runner_respects_speed(tmp_path):
    obs = Observatory(tmp_path / "s.sqlite", WorldConfig(seed=2, width=24, height=24), speed=20)
    obs.start(run=True)
    time.sleep(2.0)
    obs.shutdown()
    assert 25 <= obs.sim.world.tick <= 55  # ~40 expected at 20 sim-hours/s


def test_frame_dynamics_resources_and_budgets(client):
    client.post("/api/control", json={"action": "step", "ticks": 3})
    fr = client.get("/api/frame?layers=terrain,clouds,insolation,rain,flow_dir,lava,sst,res_iron_ore").json()
    assert fr["tick"] == 3 and set(fr["layers"]) == {"terrain", "clouds", "insolation", "rain", "flow_dir", "lava",
                                                     "sst", "res_iron_ore"}
    assert client.get("/api/frame?layers=population").status_code == 404
    dyn = client.get("/api/dynamics").json()
    assert len(dyn["wind_u_rows"]) == 32
    b = client.get("/api/budgets").json()
    assert b["closure_errors"]["water"] < 1e-9
    st = client.get("/api/status").json()
    assert st["world_age_years"] > 0 and st["engine_version"] == "0.2.0"


def test_load_world_by_id(client):
    first = client.get("/api/status").json()["world_id"]
    client.post("/api/new", json={"seed": 9, "width": 32, "height": 32})
    r = client.post("/api/load_world", json={"world_id": first}).json()
    assert r["world_id"] == first
    assert client.post("/api/load_world", json={"world_id": 999}).status_code == 404
