"""Summarise experiment records into Markdown tables (numbers come only from the JSONL files).

    python -m dwapar.report              # every laws version, each in its own section
    python -m dwapar.report --laws 1.6   # one version

Results produced under different laws versions are never combined in one table.
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

import sys

from .experiment import ROOT

MILESTONES = (10, 100, 1000, 10000)


def load(name: str, results: Path) -> list[dict]:
    p = results / f"{name}.jsonl"
    if not p.exists():
        return []
    return [json.loads(ln) for ln in p.read_text().splitlines() if ln.strip()]


def fmt(v: float, nd: int = 2) -> str:
    return f"{v:.{nd}f}"


def summarise(exp_root: Path) -> str:
    status_path, results = exp_root / "status.json", exp_root / "results"
    status = json.loads(status_path.read_text()) if status_path.exists() else {}
    out = ["| Experiment | World | Years simulated under these laws | Milestones reached | State | Engine | ms/tick (median) | Est. wall time per 100 y |",
           "|---|---|---|---|---|---|---|---|"]
    detail = []
    names = sorted(set(status) | {p.stem for p in results.glob("*.jsonl")})
    for name in names:
        st = status.get(name, {})
        sp = st.get("spec", {})

        class spec:  # noqa: N801 — lightweight view of the stored spec
            pass
        cfg_path = exp_root / "checkpoints" / f"{name}.config.json"
        cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {}
        spec.name, spec.seed, spec.size = name, sp.get("seed", cfg.get("seed", "?")), sp.get("size", cfg.get("width", "?"))
        recs = load(name, results)
        done = recs[-1]["year"] if recs else 0
        start = st.get("start_year", (recs[0]["year"] - 1) if recs else 0)
        simulated = done - start  # years simulated under these laws (continuations start mid-history)
        reached = [m for m in MILESTONES if simulated >= m]
        ms = statistics.median(r["ms_per_tick"] for r in recs) if recs else float("nan")
        per100 = ms * 24 * 360 * 100 / 3600_000 if recs else float("nan")
        engines = sorted({r.get("engine", "?") for r in recs})
        years_txt = f"{simulated}" if start == 0 else f"{simulated} (world years {start}→{done})"
        out.append(f"| {spec.name} | seed {spec.seed}, {spec.size}² | {years_txt} | "
                   f"{', '.join(map(str, reached)) or 'none yet'} | {st.get('state', 'not started')} | "
                   f"{', '.join(engines) or '—'} | {fmt(ms) if recs else '—'} | "
                   f"{fmt(per100, 1) + ' h' if recs else '—'} |")
        if not recs:
            continue
        a, b = recs[0], recs[-1]
        y0 = a["year"]
        werr = max(r["budget_errors"]["water"] for r in recs)
        rerr = max(r["budget_errors"]["rock"] for r in recs)
        scerr = max(r["budget_errors"]["sand_clay"] for r in recs)
        ores = max(r["budget_errors"]["ores_increase"] for r in recs)
        veg = [r["vegetation_mean"] for r in recs]
        tl = [r["temp_land_mean_c"] for r in recs]
        sst = [r["sst_mean_c"] for r in recs]
        pr = [r["precip_land_mm_day"] for r in recs]
        gw = [r["groundwater_mean_mm"] for r in recs]
        wood = [r["wood_t"] for r in recs]
        eru = sum(r["eruptions"] for r in recs)
        eq = sum(r["earthquakes"] for r in recs)
        ign = sum(r["fire_ignitions"] for r in recs)
        burn_max = max(r["burning_tiles_max"] for r in recs)
        tmin = min(r["temp_extremes_c"][0] for r in recs)
        tmax = max(r["temp_extremes_c"][1] for r in recs)
        detail += [
            f"\n### {spec.name} — seed {spec.seed}, {spec.size}×{spec.size}, years {y0}–{done}\n",
            "| Quantity | Year " + str(y0) + " | Year " + str(done) + " | Range over run |",
            "|---|---|---|---|",
            f"| Mean land air temperature (°C, annual) | {fmt(tl[0])} | {fmt(tl[-1])} | {fmt(min(tl))} – {fmt(max(tl))} |",
            f"| Mean ocean surface temperature (°C) | {fmt(sst[0])} | {fmt(sst[-1])} | {fmt(min(sst))} – {fmt(max(sst))} |",
            f"| Land precipitation (mm/day) | {fmt(pr[0])} | {fmt(pr[-1])} | {fmt(min(pr))} – {fmt(max(pr))} |",
            f"| Mean groundwater (mm) | {fmt(gw[0], 0)} | {fmt(gw[-1], 0)} | {fmt(min(gw), 0)} – {fmt(max(gw), 0)} |",
            f"| Vegetation density (0–1) | {fmt(veg[0], 3)} | {fmt(veg[-1], 3)} | {fmt(min(veg), 3)} – {fmt(max(veg), 3)} |",
            f"| Wood stock (Mt) | {fmt(wood[0] / 1e6, 1)} | {fmt(wood[-1] / 1e6, 1)} | {fmt(min(wood) / 1e6, 1)} – {fmt(max(wood) / 1e6, 1)} |",
            f"| Mean ocean depth (m) | {fmt(a['mean_ocean_depth_m'], 3)} | {fmt(b['mean_ocean_depth_m'], 3)} | |",
            f"| Ocean tiles | {a['ocean_tiles']} | {b['ocean_tiles']} | |",
            f"| Mean land elevation (m) | {fmt(a['land_mean_elevation_m'], 3)} | {fmt(b['land_mean_elevation_m'], 3)} | |",
            f"| Highest point (m) | {fmt(a['max_elevation_m'], 1)} | {fmt(b['max_elevation_m'], 1)} | |",
            f"| Sand + clay deposits (Gt) | {fmt(a['sand_clay_t'] / 1e9, 3)} | {fmt(b['sand_clay_t'] / 1e9, 3)} | |",
            f"| Lakes / rivers / wetlands / deserts / forests (tiles) | "
            f"{a['terrain']['lake']}/{a['terrain']['river']}/{a['terrain']['wetland']}/{a['terrain']['desert']}/{a['terrain']['forest']} | "
            f"{b['terrain']['lake']}/{b['terrain']['river']}/{b['terrain']['wetland']}/{b['terrain']['desert']}/{b['terrain']['forest']} | |",
            "",
            f"Conservation, worst value over the run: water {werr:.1e}, rock mass {rerr:.1e}, sand+clay {scerr:.1e}; "
            f"ore/coal increase {ores:.1e} t. Air temperature extremes: {fmt(tmin, 1)} … {fmt(tmax, 1)} °C.",
            f"Events over the run: {eru} volcanic eruptions, {eq} earthquakes, {ign} lightning ignitions "
            f"(peak {burn_max} tiles burning at once).",
        ]
        if "sea_level_m" in b:
            sl = [r.get("sea_level_m", 0.0) for r in recs]
            ice = [r["water_mm"].get("ice", 0.0) for r in recs]
            snow = [r["water_mm"]["snow"] for r in recs]
            detail.append(f"Sea level: {sl[0]:+.3f} m → {sl[-1]:+.3f} m (range {min(sl):+.3f} … {max(sl):+.3f}). "
                          f"Snow: {snow[0]:.3g} → {snow[-1]:.3g} mm·tiles; glacier ice: {ice[0]:.3g} → {ice[-1]:.3g} mm·tiles; "
                          f"glacier tiles {a['terrain'].get('glacier', 0)} → {b['terrain'].get('glacier', 0)}.")
        hist = b.get("laws_history")
        if hist:
            detail.append("Laws history of this world: " + "; ".join(f"{h['laws']} from tick {h['from_tick']}" for h in hist))
        if st.get("notes"):
            detail.append("Harness notes: " + "; ".join(st["notes"]))
    return "\n".join(out + detail) + "\n"


def main(argv: list[str]) -> None:
    roots = sorted((ROOT / "experiments").glob("laws-*"))
    if "--laws" in argv:
        roots = [ROOT / "experiments" / f"laws-{argv[argv.index('--laws') + 1]}"]
    for r in roots:
        print(f"## Laws {r.name.removeprefix('laws-')}\n")
        print(summarise(r))


if __name__ == "__main__":
    main(sys.argv[1:])
