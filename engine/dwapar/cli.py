"""Command line entry point.

    python -m dwapar serve   [--seed 42] [--db data/dwapar.sqlite] [--port 8000]
    python -m dwapar run     [--seed 42] [--db ...] [--days N] [--speed 0]   # headless
    python -m dwapar bench   [--size 128] [--days 10]
    python -m dwapar experiment [--name seed42-128] [--budget-minutes 30]   # resumable long runs
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from pathlib import Path

from .config import WorldConfig

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = ROOT / "data" / "dwapar.sqlite"
DEFAULT_STATIC = ROOT / "dashboard" / "dist"


def _cfg(args) -> WorldConfig:
    return WorldConfig(seed=args.seed, width=args.size, height=args.size)


def cmd_serve(args) -> None:
    import uvicorn

    from .api.server import create_app

    app = create_app(args.db, _cfg(args), autostart=not args.paused, speed=args.speed, static_dir=args.static)
    print(f"DWAPAR observatory on http://{args.host}:{args.port}  (db: {args.db})")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


def cmd_run(args) -> None:
    from .observatory import Observatory

    obs = Observatory(args.db, _cfg(args), speed=args.speed)
    sim = obs.sim
    print(f"{'Recovered' if obs.recovered else 'Created'} world {sim.world_id} seed={sim.cfg.seed} "
          f"at {sim.calendar.label()}")
    stop = {"flag": False}

    def handler(signum, frame):
        stop["flag"] = True

    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)
    target = sim.world.tick + args.days * sim.cfg.ticks_per_day if args.days else None
    obs.start(run=True)
    t0 = time.time()
    try:
        while not stop["flag"]:
            time.sleep(1.0)
            s = obs.sim
            print(f"\r{s.calendar.label()}  {obs.runner.ticks_per_second_measured:7.1f} ticks/s  "
                  f"burning={int((s.world.f['fire'] > 0).sum())}   ", end="", flush=True)
            if obs.runner.error:
                print(f"\nengine halted: {obs.runner.error}")
                break
            if target is not None and s.world.tick >= target:
                break
    finally:
        obs.shutdown()
        print(f"\nStopped after {time.time() - t0:.1f}s at {obs.sim.calendar.label()}; checkpoint saved.")


def cmd_bench(args) -> None:
    import numpy as np

    from .brahmanda.generate import generate_world
    from .simulation import Simulation

    cfg = _cfg(args)
    t = time.perf_counter()
    generate_world(cfg)
    gen = time.perf_counter() - t
    sim = Simulation.create(cfg)
    ticks = args.days * cfg.ticks_per_day
    t = time.perf_counter()
    sim.step(ticks)
    el = time.perf_counter() - t
    print(f"world {cfg.width}x{cfg.height}  generation {gen * 1000:.0f} ms")
    print(f"{ticks} ticks in {el:.2f} s -> {el / ticks * 1000:.2f} ms/tick, "
          f"{ticks / el:.0f} ticks/s, {ticks / el / cfg.ticks_per_day:.1f} sim-days/s, "
          f"{el / args.days * cfg.days_per_year:.0f} s per sim-year")
    print(f"python {sys.version.split()[0]}, numpy {np.__version__}")


def cmd_experiment(args) -> None:
    from .experiment import run_suite

    run_suite(args.name or None, args.budget_minutes)


def main(argv=None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    p = argparse.ArgumentParser(prog="dwapar", description="DWAPAR — An Experiment in Digital Civilization")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("serve", "run", "bench"):
        sp = sub.add_parser(name)
        sp.add_argument("--seed", type=int, default=42)
        sp.add_argument("--size", type=int, default=128)
        if name != "bench":
            sp.add_argument("--db", default=str(DEFAULT_DB))
            sp.add_argument("--speed", type=float, default=24.0, help="simulated hours per second; 0 = max")
        if name == "serve":
            sp.add_argument("--host", default="127.0.0.1")
            sp.add_argument("--port", type=int, default=8000)
            sp.add_argument("--paused", action="store_true")
            sp.add_argument("--static", default=str(DEFAULT_STATIC))
        if name == "run":
            sp.add_argument("--days", type=int, default=0, help="stop after N simulated days (0 = forever)")
        if name == "bench":
            sp.add_argument("--days", type=int, default=10)
    ex = sub.add_parser("experiment", help="advance the long-term experiment suite (resumable)")
    ex.add_argument("--name", action="append", help="experiment name (repeatable); default: all")
    ex.add_argument("--budget-minutes", type=float, default=30.0)
    args = p.parse_args(argv)
    {"serve": cmd_serve, "run": cmd_run, "bench": cmd_bench, "experiment": cmd_experiment}[args.cmd](args)


if __name__ == "__main__":
    main()
