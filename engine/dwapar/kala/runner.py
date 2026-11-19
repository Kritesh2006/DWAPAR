"""Kala runner — drives a Simulation in real time, independent of any observer.

Speed is expressed in *simulated hours per real second*. 0 means "as fast as
the machine allows". Because the engine advances in whole, deterministic
ticks, the speed (and any dashboard frame rate) only changes how quickly
outcomes arrive, never what the outcomes are.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Optional

log = logging.getLogger("dwapar.kala")

SPEED_PRESETS = {"1h/s": 1, "6h/s": 6, "1d/s": 24, "5d/s": 120, "max": 0}


class Runner:
    def __init__(self, get_sim: Callable, speed: float = 24.0, on_error: Optional[Callable] = None):
        self._get_sim = get_sim  # callable so the observed world can be swapped (load/new)
        self.speed = float(speed)
        self.running = False
        self.error: Optional[str] = None
        self._on_error = on_error
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.ticks_per_second_measured = 0.0

    # ------------------------------------------------------------ control
    def start_thread(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="kala-runner", daemon=True)
        self._thread.start()

    def stop_thread(self, timeout: float = 10.0) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout)

    def resume(self) -> None:
        self.error = None
        self.running = True
        self._wake.set()

    start = resume

    def pause(self) -> None:
        self.running = False

    def set_speed(self, hours_per_second: float) -> None:
        if hours_per_second < 0 or hours_per_second > 100_000:
            raise ValueError("speed must be in [0, 100000] simulated hours per second (0 = max)")
        self.speed = float(hours_per_second)
        self._wake.set()

    def step(self, ticks: int = 1) -> None:
        """Advance exactly ``ticks`` (only while paused, so the step is well defined)."""
        if self.running:
            raise RuntimeError("pause the simulation before single-stepping")
        if ticks < 1 or ticks > 24 * 360 * 10:
            raise ValueError("ticks must be between 1 and 10 simulated years")
        self._get_sim().step(ticks)

    # --------------------------------------------------------------- loop
    def _loop(self) -> None:
        debt = 0.0
        last = time.perf_counter()
        window_start, window_ticks = last, 0
        while not self._stop.is_set():
            if not self.running:
                self._wake.wait(0.25)
                self._wake.clear()
                last = time.perf_counter()
                debt = 0.0
                continue
            sim = self._get_sim()
            now = time.perf_counter()
            hpt = sim.cfg.hours_per_tick
            try:
                if self.speed == 0:
                    sim.step(6)
                    window_ticks += 6
                    time.sleep(0)  # yield so API threads can take the lock
                else:
                    debt += (now - last) * self.speed / hpt
                    debt = min(debt, self.speed / hpt * 2 + 1)  # don't spiral after a stall
                    n = int(debt)
                    if n:
                        sim.step(n)
                        debt -= n
                        window_ticks += n
                    else:
                        time.sleep(min(0.05, max(0.001, (1 - debt) * hpt / self.speed)))
            except Exception as exc:  # invalid state etc: stop and surface, never continue silently
                log.exception("simulation halted")
                self.running = False
                self.error = f"{type(exc).__name__}: {exc}"
                if self._on_error:
                    self._on_error(self.error)
            last = now
            if now - window_start >= 1.0:
                self.ticks_per_second_measured = window_ticks / (now - window_start)
                window_start, window_ticks = now, 0
