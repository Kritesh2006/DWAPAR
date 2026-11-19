"""Drishti backend — FastAPI + WebSocket view onto the live world.

The server only *observes* and issues clock commands; it never edits world
state directly. Layers are sent as base64-encoded float32/uint8 rasters so a
128×128 layer is ~87 KB of JSON.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..brahmanda import resources
from ..brahmanda.world import Terrain
from ..config import ConfigError, WorldConfig
from ..observatory import Observatory
from ..smriti.store import CheckpointError

log = logging.getLogger("dwapar.api")

LAYERS = {
    "terrain": ("class", ""),
    "elevation": ("elevation", "m"),
    "temperature": ("temperature", "°C"),
    "moisture": ("soil_moisture", "0–1"),
    "vegetation": ("vegetation_density", "0–1"),
    "water": ("surface_water", "mm"),
    "minerals": ("mineral_total", "t"),
    "fertility": ("fertility", "0–1"),
    "snow": ("snow", "mm SWE"),
    "precipitation": ("precip_ema", "mm/day"),
    "fire": ("fire", "0–1"),
    "fire_risk": ("fire_risk", "0–1"),
}


def layer_array(obs: Observatory, name: str) -> np.ndarray:
    sim = obs.sim
    w = sim.world
    if name == "terrain":
        return w.terrain
    if name not in LAYERS:
        raise KeyError(name)
    attr = LAYERS[name][0]
    if attr == "fire_risk":
        return sim.prakriti.fire_risk(w)
    if attr in w.f:
        return w.f[attr]
    return getattr(w, attr)


def encode(arr: np.ndarray) -> dict:
    if arr.dtype == np.uint8:
        data = arr.astype(np.uint8)
        dtype = "uint8"
    else:
        data = arr.astype(np.float32)
        dtype = "float32"
    return {"dtype": dtype, "data": base64.b64encode(np.ascontiguousarray(data).tobytes()).decode(),
            "min": float(arr.min()), "max": float(arr.max())}


class ControlBody(BaseModel):
    action: str = Field(pattern="^(start|pause|resume|step)$")
    ticks: int = 1


class SpeedBody(BaseModel):
    hours_per_second: float


class NewWorldBody(BaseModel):
    seed: int
    width: int = 128
    height: int = 128


class LoadBody(BaseModel):
    checkpoint_id: int


def create_app(db_path: str | Path = "data/dwapar.sqlite", default_cfg: Optional[WorldConfig] = None,
               autostart: bool = True, speed: float = 24.0, static_dir: Optional[str | Path] = None) -> FastAPI:
    holder: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        obs = Observatory(db_path, default_cfg, speed=speed)
        obs.start(run=autostart)
        holder["obs"] = obs
        yield
        obs.shutdown()

    app = FastAPI(title="DWAPAR Drishti API", version="0.1.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                       allow_methods=["*"], allow_headers=["*"])

    def obs() -> Observatory:
        return holder["obs"]

    def status() -> dict:
        o = obs()
        sim = o.sim
        with sim.lock:
            return {
                "world_id": sim.world_id,
                "seed": sim.cfg.seed,
                "width": sim.cfg.width,
                "height": sim.cfg.height,
                "ticks_per_day": sim.cfg.ticks_per_day,
                "days_per_year": sim.cfg.days_per_year,
                "calendar": sim.calendar.to_dict(),
                "running": o.runner.running,
                "speed_hours_per_second": o.runner.speed,
                "measured_ticks_per_second": round(o.runner.ticks_per_second_measured, 1),
                "last_step_ms": round(sim.last_step_seconds * 1000, 2),
                "burning_tiles": int((sim.world.f["fire"] > 0).sum()),
                "error": o.runner.error,
                "recovered_from_checkpoint": o.recovered,
            }

    # ---------------------------------------------------------- reads
    @app.get("/api/status")
    def get_status():
        return status()

    @app.get("/api/config")
    def get_config():
        return obs().sim.cfg.to_dict()

    @app.get("/api/layers")
    def list_layers():
        return [{"name": k, "unit": v[1]} for k, v in LAYERS.items()] + \
               [{"terrain_classes": [t.name.lower() for t in Terrain]}]

    @app.get("/api/layer/{name}")
    def get_layer(name: str):
        sim = obs().sim
        with sim.lock:
            try:
                arr = layer_array(obs(), name)
            except KeyError:
                raise HTTPException(404, f"unknown layer {name}")
            out = encode(np.array(arr))
            out.update(name=name, width=sim.cfg.width, height=sim.cfg.height, tick=sim.world.tick,
                       unit=LAYERS[name][1])
        return out

    @app.get("/api/tile/{x}/{y}")
    def get_tile(x: int, y: int):
        sim = obs().sim
        w = sim.world
        if not (0 <= x < w.cfg.width and 0 <= y < w.cfg.height):
            raise HTTPException(404, "tile out of bounds")
        with sim.lock:
            f = w.f
            return {
                "x": x, "y": y, "tick": w.tick,
                "terrain": Terrain(int(w.terrain[y, x])).name.lower(),
                "latitude": float(f["latitude"][y, x]),
                "elevation_m": float(f["elevation"][y, x]),
                "temperature_c": float(f["temperature"][y, x]),
                "temperature_day_mean_c": float(f["temp_day"][y, x]),
                "temperature_season_mean_c": float(f["temp_ema"][y, x]),
                "soil_moisture": float(w.soil_moisture[y, x]),
                "soil_water_mm": float(f["soil_water"][y, x]),
                "field_capacity_mm": float(f["field_capacity"][y, x]),
                "surface_water_mm": float(f["surface_water"][y, x]),
                "atmo_water_mm": float(f["atmo_water"][y, x]),
                "snow_mm": float(f["snow"][y, x]),
                "precip_mean_mm_day": float(f["precip_ema"][y, x]),
                "drought_days": float(f["drought_days"][y, x]),
                "flow_flux_mm_h": float(f["flow_flux"][y, x]),
                "soil_fertility": float(w.fertility[y, x]),
                "vegetation_density": float(w.vegetation_density[y, x]),
                "biomass_kg_m2": float(f["biomass"][y, x]),
                "organic_matter_kg_m2": float(f["organic_matter"][y, x]),
                "fire_intensity": float(f["fire"][y, x]),
                "fire_risk": float(sim.prakriti.fire_risk(w)[y, x]),
                "resources": resources.at_tile(w, y, x),
                "resource_units": resources.UNITS,
            }

    @app.get("/api/stats")
    def get_stats():
        sim = obs().sim
        with sim.lock:
            return sim.stats()

    @app.get("/api/stats/history")
    def get_history(limit: int = 1500):
        sim = obs().sim
        return obs().store.stats_history(sim.world_id, limit=min(limit, 20000))

    @app.get("/api/events")
    def get_events(limit: int = 200, kind: Optional[str] = None):
        sim = obs().sim
        return obs().store.events(sim.world_id, limit=min(limit, 2000), kinds=kind.split(",") if kind else None)

    @app.get("/api/checkpoints")
    def get_checkpoints():
        return {"worlds": obs().store.list_worlds(), "checkpoints": obs().store.list_checkpoints()[:200]}

    # ------------------------------------------------------- commands
    @app.post("/api/control")
    def control(body: ControlBody):
        r = obs().runner
        try:
            if body.action in ("start", "resume"):
                r.resume()
            elif body.action == "pause":
                r.pause()
            elif body.action == "step":
                r.step(body.ticks)
        except (RuntimeError, ValueError) as exc:
            raise HTTPException(409, str(exc))
        return status()

    @app.post("/api/speed")
    def speed_ctl(body: SpeedBody):
        try:
            obs().runner.set_speed(body.hours_per_second)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        return status()

    @app.post("/api/save")
    def save():
        cid = obs().sim.checkpoint(label="manual")
        return {"checkpoint_id": cid, "tick": obs().sim.world.tick}

    @app.post("/api/load")
    def load(body: LoadBody):
        try:
            obs().load(body.checkpoint_id)
        except CheckpointError as exc:
            raise HTTPException(404, str(exc))
        return status()

    @app.post("/api/new")
    def new_world(body: NewWorldBody):
        try:
            cfg = WorldConfig(seed=body.seed, width=body.width, height=body.height)
        except ConfigError as exc:
            raise HTTPException(422, str(exc))
        obs().new_world(cfg)
        return status()

    # ------------------------------------------------------- realtime
    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        last_day = None
        last_event_tick = -1
        try:
            while True:
                st = await asyncio.to_thread(status)
                msg = {"type": "status", "status": st}
                sim = obs().sim
                fresh = [e for e in sim.recent_events if e["tick"] > last_event_tick][-20:]
                if fresh:
                    msg["events"] = fresh
                    last_event_tick = fresh[-1]["tick"]
                if st["calendar"]["day_total"] != last_day:
                    last_day = st["calendar"]["day_total"]
                    msg["new_day"] = True
                await socket.send_json(msg)
                await asyncio.sleep(0.5)
        except (WebSocketDisconnect, RuntimeError):
            return

    # -------------------------------------------------------- static UI
    if static_dir and Path(static_dir).is_dir():
        sd = Path(static_dir)
        app.mount("/assets", StaticFiles(directory=sd / "assets"), name="assets")

        @app.get("/")
        def index():
            return FileResponse(sd / "index.html")

    return app
