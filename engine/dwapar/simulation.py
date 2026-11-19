"""The Simulation: one World advanced by Prakriti under Kala's clock, recorded by Smriti.

``Simulation.step`` is the only way the world changes. It is deterministic:
the outcome depends only on (config, starting state, number of ticks).
Thread-safety: all public methods take ``self.lock`` so a server thread can
read snapshots while a runner thread advances time.
"""

from __future__ import annotations

import threading
import time
from typing import TYPE_CHECKING, Optional

import numpy as np

from .brahmanda import resources
from .brahmanda.generate import generate_world
from .brahmanda.world import Terrain, World
from .config import WorldConfig
from .kala.calendar import Calendar
from .prakriti.processes import Prakriti

if TYPE_CHECKING:
    from .smriti.store import Store


class Simulation:
    def __init__(self, world: World, store: Optional["Store"] = None, world_id: Optional[int] = None):
        self.world = world
        self.prakriti = Prakriti(world)
        self.store = store
        self.world_id = world_id
        self.lock = threading.RLock()
        self.pending_events: list[dict] = []
        self.recent_events: list[dict] = []
        self.last_step_seconds = 0.0
        self.last_hour = {"precip": 0.0, "evap": 0.0, "burned": 0}
        self.validate_every = 24  # ticks

    # ----------------------------------------------------------- creation
    @classmethod
    def create(cls, cfg: WorldConfig, store: Optional["Store"] = None) -> "Simulation":
        world = generate_world(cfg)
        sim = cls(world, store)
        if store is not None:
            sim.world_id = store.create_world(cfg)
            sim.record_stats()
            store.add_events(sim.world_id, [{"tick": 0, "kind": "genesis", "x": None, "y": None,
                                             "message": f"World created from seed {cfg.seed}"}])
            store.save_checkpoint(sim.world_id, world, label="genesis")
        return sim

    @property
    def cfg(self) -> WorldConfig:
        return self.world.cfg

    @property
    def calendar(self) -> Calendar:
        return Calendar.at(self.world.tick, self.cfg)

    # ------------------------------------------------------------- stepping
    def step(self, n: int = 1) -> None:
        if n < 0:
            raise ValueError("cannot step backwards")
        with self.lock:
            self.world.validate()  # never advance from a corrupted state (e.g. bad external edit or load)
        for _ in range(n):
            with self.lock:
                t0 = time.perf_counter()
                self._step_once()
                self.last_step_seconds = time.perf_counter() - t0

    def _step_once(self) -> None:
        w = self.world
        cal = Calendar.at(w.tick, self.cfg)
        events: list[dict] = []
        self.last_hour = self.prakriti.step_hour(w, cal, events)
        w.tick += 1
        nxt = Calendar.at(w.tick, self.cfg)
        if nxt.is_day_start:
            self.prakriti.step_day(w, nxt, events)
        if w.tick % self.validate_every == 0:
            w.validate()  # refuse to continue from an impossible state
        self._emit(events)
        if nxt.is_day_start:
            self.record_stats()
            if self.store is not None and self.cfg.checkpoint_every_days and \
                    nxt.day_total % self.cfg.checkpoint_every_days == 0:
                self.checkpoint(label="auto")

    def _emit(self, events: list[dict]) -> None:
        if not events:
            return
        # Cap per-tick ignition spam: keep first 10 ignitions, summarise the rest.
        ign = [e for e in events if e["kind"] == "fire_ignition"]
        if len(ign) > 10:
            events = [e for e in events if e["kind"] != "fire_ignition"] + ign[:10]
            events.append({"tick": ign[0]["tick"], "kind": "fire_ignition", "x": None, "y": None,
                           "message": f"…and {len(ign) - 10} more ignitions this hour"})
        self.recent_events = (self.recent_events + events)[-200:]
        if self.store is not None and self.world_id is not None:
            self.store.add_events(self.world_id, events)

    # ------------------------------------------------------------ recording
    def stats(self) -> dict:
        w = self.world
        f = w.f
        land = ~w.is_ocean
        counts = np.bincount(w.terrain.ravel(), minlength=len(Terrain))
        res = resources.totals(w)
        return {
            "tick": w.tick,
            "day": self.calendar.day_total,
            "temp_land_mean": float(f["temperature"][land].mean()) if land.any() else None,
            "temp_ocean_mean": float(f["temperature"][~land].mean()) if (~land).any() else None,
            "temp_min": float(f["temperature"].min()),
            "temp_max": float(f["temperature"].max()),
            "soil_moisture_mean": float(w.soil_moisture[land].mean()) if land.any() else None,
            "fertility_mean": float(w.fertility[land].mean()) if land.any() else None,
            "vegetation_mean": float(w.vegetation_density[land].mean()) if land.any() else None,
            "biomass_total_kg_m2": float(f["biomass"].sum()),
            "burning_tiles": int((f["fire"] > 0).sum()),
            "fire_ignitions_total": int(w.meta.get("fire_ignitions", 0)),
            "snow_tiles": int(counts[Terrain.SNOW]),
            "precip_mean_mm_day": float(f["precip_ema"][land].mean()) if land.any() else None,
            "water_mm": self.water_budget(),
            "terrain": {t.name.lower(): int(counts[t]) for t in Terrain},
            "resources": res,
        }

    def water_budget(self) -> dict:
        f = self.world.f
        ocean = self.world.is_ocean
        return {
            "ocean": float(f["surface_water"][ocean].sum()),
            "land_surface": float(f["surface_water"][~ocean].sum()),
            "soil": float(f["soil_water"][~ocean].sum()),
            "ocean_soil_column": float(f["soil_water"][ocean].sum()),
            "atmosphere": float(f["atmo_water"].sum()),
            "snow": float(f["snow"].sum()),
        }

    def total_water(self) -> float:
        f = self.world.f
        return float(f["surface_water"].sum() + f["soil_water"].sum() + f["atmo_water"].sum() + f["snow"].sum())

    def record_stats(self) -> None:
        if self.store is not None and self.world_id is not None:
            self.store.add_stats(self.world_id, self.world.tick, self.stats())

    def checkpoint(self, label: str = "manual") -> Optional[int]:
        if self.store is None or self.world_id is None:
            return None
        with self.lock:
            cid = self.store.save_checkpoint(self.world_id, self.world, label=label)
            if label == "auto":
                self.store.prune_checkpoints(self.world_id, keep=self.cfg.checkpoint_retain)
            return cid

    # ------------------------------------------------------------ recovery
    @classmethod
    def from_checkpoint(cls, store: "Store", checkpoint_id: Optional[int] = None,
                        world_id: Optional[int] = None) -> "Simulation":
        world, wid = store.load_checkpoint(checkpoint_id=checkpoint_id, world_id=world_id)
        sim = cls(world, store, wid)
        store.truncate_after(wid, world.tick)  # history beyond the checkpoint never happened
        sim.prakriti.reclassify(world)
        return sim
