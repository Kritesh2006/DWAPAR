"""Long-term world experiments — bounded, resumable, honest.

An experiment is (name, seed, size, target_years). Each run session advances it for at
most ``budget_minutes`` of wall time, checkpointing at every recorded year, then stops.
The next session resumes from the latest checkpoint instead of restarting.

Outputs (committed to the repository):
    experiments/results/<name>.jsonl   one JSON record per recorded simulated year
    experiments/status.json            progress of every experiment
Checkpoints (local, not committed):
    data/experiments/<name>.sqlite

Recording cadence: every year up to year 100, every 10 years to 1,000, every 100 beyond.
Nothing here alters the physics or prevents collapse; it only observes.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

import numpy as np

from .brahmanda.world import InvalidStateError, Terrain
from .config import WorldConfig
from .simulation import Simulation
from .smriti.store import CheckpointError, Store

ROOT = Path(__file__).resolve().parents[2]
RESULTS = ROOT / "experiments" / "results"
STATUS = ROOT / "experiments" / "status.json"
CKPT_DIR = ROOT / "data" / "experiments"


@dataclass
class ExperimentSpec:
    name: str
    seed: int
    size: int = 128
    target_years: int = 10_000


def record_interval(year: int) -> int:
    return 1 if year < 100 else 10 if year < 1000 else 100


class YearAccumulator:
    """Samples the world once per simulated day to build annual statistics."""

    def __init__(self, sim: Simulation):
        self.sim = sim
        self.reset()

    def reset(self) -> None:
        self.days = 0
        self.t_land = 0.0
        self.t_ocean = 0.0
        self.precip = 0.0
        self.snow_tiles_max = 0
        self.burning_max = 0
        self.t_min = np.inf
        self.t_max = -np.inf
        self.m0 = dict(self.sim.world.meta)

    def sample(self) -> None:
        w = self.sim.world
        f = w.f
        land = ~w.is_ocean
        self.days += 1
        self.t_land += float(f["temperature"][land].mean())
        self.t_ocean += float(f["sst"][~land].mean()) if (~land).any() else 0.0
        self.precip += float(f["precip_ema"][land].mean())
        self.snow_tiles_max = max(self.snow_tiles_max, int((f["snow"] > 20).sum()))
        self.burning_max = max(self.burning_max, int((f["fire"] > 0).sum()))
        self.t_min = min(self.t_min, float(f["temperature"].min()))
        self.t_max = max(self.t_max, float(f["temperature"].max()))

    def record(self, year: int, wall_s: float, ms_tick: float) -> dict:
        sim, w = self.sim, self.sim.world
        f, m = w.f, w.meta
        land = ~w.is_ocean
        counts = np.bincount(w.terrain.ravel(), minlength=len(Terrain))
        b = sim.budgets()
        n = max(self.days, 1)

        def delta(key):
            return m.get(key, 0) - self.m0.get(key, 0)

        return {
            "year": year,
            "tick": w.tick,
            "wall_s": round(wall_s, 1),
            "ms_per_tick": round(ms_tick, 3),
            "budget_errors": {k: float(v) for k, v in sim.budget_errors().items()},
            "temp_land_mean_c": self.t_land / n,
            "sst_mean_c": self.t_ocean / n,
            "temp_extremes_c": [self.t_min, self.t_max],
            "precip_land_mm_day": self.precip / n,
            "soil_moisture_mean": float(w.soil_moisture[land].mean()),
            "groundwater_mean_mm": float(f["groundwater"][land].mean()),
            "vegetation_mean": float(w.vegetation_density[land].mean()),
            "wood_t": float((f["biomass"] * 0.5 * w.cfg.tile_size_m ** 2 / 1000.0).sum()),
            "organic_matter_mean_kg_m2": float(f["organic_matter"][land].mean()),
            "water_mm": sim.water_budget(),
            "ocean_tiles": int(w.is_ocean.sum()),
            "mean_ocean_depth_m": b["mean_ocean_depth_m"],
            "land_mean_elevation_m": b["land_mean_elevation_m"],
            "max_elevation_m": float(f["elevation"].max()),
            "sediment_in_transit_t": float(f["sediment"].sum()),
            "sand_clay_t": b["sand_clay_t"],
            "stone_t": b["stone_t"],
            "ores_t": b["ores_t"],
            "terrain": {t.name.lower(): int(counts[t]) for t in Terrain},
            "snow_tiles_max": self.snow_tiles_max,
            "burning_tiles_max": self.burning_max,
            "fire_ignitions": delta("fire_ignitions"),
            "burned_tile_hours": delta("burned_tile_hours"),
            "earthquakes": delta("earthquakes"),
            "eruptions": delta("eruptions"),
            "years_in_record": record_interval(year),
        }


def _load_status() -> dict:
    if STATUS.exists():
        return json.loads(STATUS.read_text())
    return {}


def _save_status(status: dict) -> None:
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    STATUS.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n")


def _code_version() -> str:
    """Git commit of the engine that produced a record (+ '-dirty' if uncommitted changes exist)."""
    import subprocess
    try:
        sha = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True,
                             text=True, timeout=5).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "engine/dwapar"],
                               capture_output=True, text=True, timeout=5).stdout.strip()
        return (sha or "unknown") + ("-dirty" if dirty else "")
    except Exception:
        return "unknown"


class _Stop(Exception):
    pass


def _install_signal_handlers() -> None:
    """Turn SIGTERM/SIGINT into a clean stop so status and checkpoints are always written."""
    import signal

    def handler(signum, frame):
        raise _Stop()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, handler)
        except ValueError:  # not in main thread (e.g. tests)
            pass


def run_experiment(spec: ExperimentSpec, budget_minutes: float, log=print) -> dict:
    RESULTS.mkdir(parents=True, exist_ok=True)
    CKPT_DIR.mkdir(parents=True, exist_ok=True)
    store = Store(CKPT_DIR / f"{spec.name}.sqlite")
    results_path = RESULTS / f"{spec.name}.jsonl"
    try:
        sim = Simulation.from_checkpoint(store)
        if sim.cfg.seed != spec.seed or sim.cfg.width != spec.size:
            raise RuntimeError(f"checkpoint for {spec.name} does not match its spec")
        resumed = True
    except CheckpointError:
        cfg = WorldConfig(seed=spec.seed, width=spec.size, height=spec.size, checkpoint_every_days=0)
        sim = Simulation.create(cfg)  # no store: experiments keep their own sparse history
        sim.world_id = store.create_world(cfg)
        store.save_checkpoint(sim.world_id, sim.world, label="genesis")
        resumed = False
    sim.store = None  # never write per-day stats/events for decade-to-millennium runs
    dpy, tpd = sim.cfg.days_per_year, sim.cfg.ticks_per_day
    year = sim.world.tick // (dpy * tpd)
    # Drop any result lines written after the checkpoint we resumed from (never double-count).
    if results_path.exists():
        lines = [ln for ln in results_path.read_text().splitlines() if ln.strip()]
        kept = [ln for ln in lines if json.loads(ln)["year"] <= year]
        results_path.write_text("".join(k + "\n" for k in kept))
    status = _load_status()
    entry = status.get(spec.name, {"spec": asdict(spec), "wall_s_total": 0.0, "notes": []})
    entry["spec"] = asdict(spec)
    version = _code_version()
    entry.setdefault("engine_versions", [])
    if version not in entry["engine_versions"]:
        entry["engine_versions"].append(version)
    log(f"[{spec.name}] {'resumed at' if resumed else 'created; starting at'} year {year} "
        f"(target {spec.target_years}, budget {budget_minutes} min)")

    deadline = time.monotonic() + budget_minutes * 60
    acc = YearAccumulator(sim)
    t_session = time.monotonic()
    prev_wood = None
    entry["state"] = "running"
    try:
        while year < spec.target_years:
            interval = record_interval(year)
            block_start = time.monotonic()
            ticks = 0
            acc.reset()
            for _ in range(interval * dpy):
                sim.step(tpd)
                ticks += tpd
                acc.sample()
                if time.monotonic() > deadline:
                    break
            if time.monotonic() > deadline and sim.world.tick % (dpy * tpd * interval) != 0:
                # Budget ran out mid-block: keep the last checkpoint; this partial block is discarded.
                entry["state"] = "paused (session budget reached)"
                break
            year += interval
            el = time.monotonic() - block_start
            rec = acc.record(year, entry["wall_s_total"] + (time.monotonic() - t_session), el / ticks * 1000)
            rec["engine"] = version
            sim.world.validate()
            with results_path.open("a") as fh:
                fh.write(json.dumps(rec) + "\n")
            store.save_checkpoint(sim.world_id, sim.world, label="auto")
            store.prune_checkpoints(sim.world_id, keep=3)
            if prev_wood and rec["wood_t"] < 0.5 * prev_wood:
                entry["notes"].append(f"year {year}: wood fell >50% ({prev_wood:.3g} -> {rec['wood_t']:.3g} t)")
            prev_wood = rec["wood_t"]
            entry.update(years_done=year, last_record=rec["year"], ms_per_tick=rec["ms_per_tick"])
            log(f"[{spec.name}] year {year:>5}: T_land {rec['temp_land_mean_c']:.2f} °C, "
                f"veg {rec['vegetation_mean']:.3f}, water err {rec['budget_errors']['water']:.1e}, "
                f"{rec['ms_per_tick']:.2f} ms/tick")
            if time.monotonic() > deadline:
                entry["state"] = "paused (session budget reached)"
                break
        else:
            entry["state"] = "complete"
    except _Stop:
        entry["state"] = "paused (stopped by signal; resumes from last checkpoint)"
        log(f"[{spec.name}] stopped by signal at year {year}")
    except (InvalidStateError, FloatingPointError) as exc:
        entry["state"] = f"halted: {type(exc).__name__}: {exc}"
        entry["notes"].append(f"halted near tick {sim.world.tick}: {exc}")
        log(f"[{spec.name}] HALTED: {exc}")
    finally:
        entry["wall_s_total"] = entry.get("wall_s_total", 0.0) + (time.monotonic() - t_session)
        entry["years_done"] = year
        status = _load_status()  # another process may have updated other experiments
        status[spec.name] = entry
        _save_status(status)
        store.close()
    return entry


DEFAULT_SUITE = [
    ExperimentSpec("seed42-128", 42, 128),
    ExperimentSpec("seed7-128", 7, 128),
    ExperimentSpec("seed2026-64", 2026, 64),
]


def run_suite(names: Optional[list[str]], budget_minutes: float, log=print) -> None:
    _install_signal_handlers()
    specs = [s for s in DEFAULT_SUITE if not names or s.name in names]
    if not specs:
        raise SystemExit(f"unknown experiment; choose from {[s.name for s in DEFAULT_SUITE]}")
    deadline = time.monotonic() + budget_minutes * 60
    for spec in specs:
        remaining = (deadline - time.monotonic()) / 60
        if remaining <= 0.1:
            break
        entry = run_experiment(spec, remaining, log)
        if entry.get("state", "").startswith("paused (stopped"):
            break
