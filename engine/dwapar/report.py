"""Summarise experiment records into Markdown tables (numbers come only from the JSONL files).

    python -m dwapar.report            # prints the tables used in EXPERIMENTS.md
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path

from .experiment import DEFAULT_SUITE, RESULTS, STATUS

MILESTONES = (10, 100, 1000, 10000)


def load(name: str) -> list[dict]:
    p = RESULTS / f"{name}.jsonl"
    if not p.exists():
        return []
    return [json.loads(ln) for ln in p.read_text().splitlines() if ln.strip()]


def fmt(v: float, nd: int = 2) -> str:
    return f"{v:.{nd}f}"


def summarise() -> str:
    status = json.loads(STATUS.read_text()) if STATUS.exists() else {}
    out = ["| Experiment | World | Years done | Milestones reached | State | Engine | ms/tick (median) | Est. wall time per 100 y |",
           "|---|---|---|---|---|---|---|---|"]
    detail = []
    for spec in DEFAULT_SUITE:
        recs = load(spec.name)
        st = status.get(spec.name, {})
        done = recs[-1]["year"] if recs else 0
        reached = [m for m in MILESTONES if done >= m]
        ms = statistics.median(r["ms_per_tick"] for r in recs) if recs else float("nan")
        per100 = ms * 24 * 360 * 100 / 3600_000 if recs else float("nan")
        engines = sorted({r.get("engine", "?") for r in recs})
        out.append(f"| {spec.name} | seed {spec.seed}, {spec.size}² | {done} | "
                   f"{', '.join(map(str, reached)) or 'none yet'} | {st.get('state', 'not started')} | "
                   f"{', '.join(engines) or '—'} | {fmt(ms) if recs else '—'} | "
                   f"{fmt(per100, 1) + ' h' if recs else '—'} |")
        if not recs:
            continue
        a, b = recs[0], recs[-1]
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
            f"\n### {spec.name} — seed {spec.seed}, {spec.size}×{spec.size}, years 1–{done}\n",
            "| Quantity | Year 1 | Year " + str(done) + " | Range over run |",
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
        if st.get("notes"):
            detail.append("Harness notes: " + "; ".join(st["notes"]))
    return "\n".join(out + detail) + "\n"


if __name__ == "__main__":
    print(summarise())
