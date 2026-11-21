"""Observatory — owns the live Simulation, its Store and its Runner.

Used both by the headless CLI and by the API server. On start it recovers the
most recent checkpoint if one exists (so a reboot resumes the same world), and
on shutdown it writes a final checkpoint.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Optional

from .config import WorldConfig
from .kala.runner import Runner
from .simulation import Simulation
from .smriti.store import CheckpointError, Store

log = logging.getLogger("dwapar")


class Observatory:
    def __init__(self, db_path: str | Path, default_cfg: Optional[WorldConfig] = None, speed: float = 24.0):
        self.store = Store(db_path)
        self._swap = threading.RLock()
        try:
            self.sim = Simulation.from_checkpoint(self.store)
            log.info("recovered world %s at tick %s", self.sim.world_id, self.sim.world.tick)
            self.recovered = True
        except CheckpointError:
            self.sim = Simulation.create(default_cfg or WorldConfig(), self.store)
            log.info("generated new world %s (seed %s)", self.sim.world_id, self.sim.cfg.seed)
            self.recovered = False
        self.runner = Runner(lambda: self.sim, speed=speed, on_error=self._on_error)
        self._attach_witness()

    def _attach_witness(self) -> None:
        """WITNESS lives with the world: its identity and memories are loaded from the database
        and its daily cycle runs inside the engine's step (so it acts only while the engine runs)."""
        from .witness import Witness
        self.witness = Witness(self.sim)
        self.sim.day_hooks = [self.witness.daily]

    def _on_error(self, msg: str) -> None:
        if self.sim.store is not None and self.sim.world_id is not None:
            self.store.add_events(self.sim.world_id, [{"tick": self.sim.world.tick, "kind": "engine_halt",
                                                       "x": None, "y": None, "message": f"Engine halted: {msg}"}])

    def start(self, run: bool = False) -> None:
        self.runner.start_thread()
        if run:
            self.runner.resume()

    def shutdown(self) -> None:
        self.runner.pause()
        self.runner.stop_thread()
        try:
            self.sim.world.validate()
            self.sim.checkpoint(label="shutdown")
        except Exception:  # never checkpoint an invalid world over a good one
            log.exception("final checkpoint skipped")
        self.store.close()

    # ---------------------------------------------------------- world ops
    def new_world(self, cfg: WorldConfig) -> Simulation:
        with self._swap:
            was = self.runner.running
            self.runner.pause()
            with self.sim.lock:
                self.sim.checkpoint(label="manual")
                self.sim = Simulation.create(cfg, self.store)
                self._attach_witness()
            if was:
                self.runner.resume()
            return self.sim

    def load(self, checkpoint_id: int) -> Simulation:
        with self._swap:
            self.runner.pause()
            with self.sim.lock:
                self.sim = Simulation.from_checkpoint(self.store, checkpoint_id=checkpoint_id)
                self._attach_witness()
            return self.sim
