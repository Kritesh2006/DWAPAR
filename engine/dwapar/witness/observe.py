"""What WITNESS can see: a factual summary of the authoritative world state, and site selection.

Nothing here is invented: every number is read from the world, its life and its event log.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

import numpy as np

from ..brahmanda.world import Terrain

if TYPE_CHECKING:  # pragma: no cover
    from ..simulation import Simulation

COARSE = 8  # WITNESS remembers vegetation on an 8×8 grid of regions to notice degradation


def coarse_biomass(world) -> list[list[float]]:
    h, w = world.shape
    b = world.f["biomass"]
    out = []
    for j in range(COARSE):
        row = []
        for i in range(COARSE):
            blk = b[j * h // COARSE:(j + 1) * h // COARSE, i * w // COARSE:(i + 1) * w // COARSE]
            row.append(round(float(blk.mean()), 4))
        out.append(row)
    return out


def region_name(world, x: int, y: int) -> str:
    h, w = world.shape
    ns = "north" if y < h / 3 else "south" if y > 2 * h / 3 else ""
    ew = "west" if x < w / 3 else "east" if x > 2 * w / 3 else ""
    return (ns + ew) or "centre"


def observe(sim: "Simulation", prev_coarse: Optional[list] = None) -> dict:
    w = sim.world
    f = w.f
    land = ~w.is_ocean
    n_land = int(land.sum())
    counts = np.bincount(w.terrain.ravel(), minlength=len(Terrain))
    tile_km2 = (w.cfg.tile_size_m / 1000.0) ** 2
    elev = f["elevation"]
    peak = np.unravel_index(int(np.argmax(np.where(land, elev, -1e9))), elev.shape)
    obs: dict = {
        "tick": w.tick,
        "calendar": sim.calendar.to_dict(),
        "age_years": w.tick / (w.cfg.ticks_per_day * w.cfg.days_per_year),
        "land_km2": n_land * tile_km2,
        "land_fraction": n_land / land.size,
        "highest_peak_m": float(elev[peak]) - w.sea_level,
        "highest_peak_at": [int(peak[1]), int(peak[0])],
        "terrain": {t.name.lower(): int(counts[t]) for t in Terrain},
        "vegetation_mean": float(w.vegetation_density[land].mean()) if n_land else 0.0,
        "temp_land_c": float(f["temperature"][land].mean()) if n_land else 0.0,
        "sea_level_m": w.sea_level,
        "burning_tiles": int((f["fire"] > 0).sum()),
        "drought": bool(w.meta.get("drought_active", False)),
        "life": w.life.summary() if w.life is not None else None,
        "concerns": [],
    }
    # fires
    if obs["burning_tiles"]:
        ys, xs = np.nonzero(f["fire"] > 0)
        cx, cy = int(np.median(xs)), int(np.median(ys))
        near_life = False
        if w.life is not None:
            T = w.cfg.tile_size_m
            near_life = any(abs(o.x / T - cx) < 6 and abs(o.y / T - cy) < 6 for o in (*w.life.animals, *w.life.humans))
        obs["concerns"].append({"kind": "fire", "x": cx, "y": cy, "severity": min(1.0, obs["burning_tiles"] / 20.0 + (0.4 if near_life else 0.0)),
                                "text": f"{obs['burning_tiles']} tiles burning, centred in the {region_name(w, cx, cy)}"
                                        + (" near living creatures" if near_life else "")})
    if obs["drought"]:
        dry = land & (f["drought_days"] > 45) & (f["biomass"] > 1.0)
        if dry.any():
            ys, xs = np.nonzero(dry)
            cx, cy = int(np.median(xs)), int(np.median(ys))
            obs["concerns"].append({"kind": "drought", "x": cx, "y": cy, "severity": min(1.0, dry.sum() / max(1, n_land) * 4),
                                    "text": f"drought: {int(dry.sum())} vegetated tiles without rain for 45+ days, mostly in the {region_name(w, cx, cy)}"})
    # degradation since WITNESS last looked
    cur = coarse_biomass(w)
    obs["coarse_biomass"] = cur
    if prev_coarse:
        h, wd = w.shape
        worst, wi, wj = 0.0, 0, 0
        for j in range(COARSE):
            for i in range(COARSE):
                a, b = prev_coarse[j][i], cur[j][i]
                if a > 2.0 and (a - b) / a > worst:
                    worst, wi, wj = (a - b) / a, i, j
        if worst > 0.25:
            cx, cy = int((wi + 0.5) * wd / COARSE), int((wj + 0.5) * h / COARSE)
            obs["concerns"].append({"kind": "degradation", "x": cx, "y": cy, "severity": min(1.0, worst),
                                    "text": f"vegetation in the {region_name(w, cx, cy)} fell by {worst:.0%} since I last looked"})
    # life in trouble
    if w.life is not None and w.life.humans:
        suffering = [h for h in w.life.humans if h.hydration < 0.3 or h.energy < 0.2]
        if len(suffering) >= max(2, 0.2 * len(w.life.humans)):
            T = w.cfg.tile_size_m
            cx = int(np.median([h.x for h in suffering]) // T)
            cy = int(np.median([h.y for h in suffering]) // T)
            thirsty = sum(1 for h in suffering if h.hydration < 0.3)
            need = "water" if thirsty >= len(suffering) / 2 else "food"
            obs["concerns"].append({"kind": "humans_suffering", "need": need, "x": cx, "y": cy,
                                    "severity": min(1.0, 0.5 + len(suffering) / len(w.life.humans)),
                                    "text": f"{len(suffering)} of {len(w.life.humans)} humans near ({cx}, {cy}) lack {need}"})
    if w.life is not None:
        s = w.life.summary()
        for sp, n in s["animals"].items():
            if 0 < n < 4:
                obs["concerns"].append({"kind": "dwindling", "species": sp, "severity": 0.5, "x": None, "y": None,
                                        "text": f"only {n} {sp} remain"})
    return obs


def best_site(sim: "Simulation", purpose: str, avoid: Optional[list] = None,
              within: Optional[tuple[int, int, int]] = None) -> Optional[tuple[int, int, float]]:
    """Choose a tile for an act. Scores come from real fields: water nearby, plants, temperature,
    soil. Returns (x, y, score) or None when nowhere is suitable."""
    w = sim.world
    f = w.f
    land = ~w.is_ocean
    t = w.terrain
    from ..prana.habitat import Habitat, drinkable
    # permanent water matters for settling life: lakes and rivers count fully, streams half
    permanent = land & ((t == Terrain.LAKE) | (t == Terrain.RIVER))
    dist = np.minimum(Habitat._distance(permanent, land, max_iter=30), Habitat._distance(drinkable(w), land, max_iter=30) * 2.0)
    temp = f["temp_ema"]
    veg = w.vegetation_density
    fert = w.fertility
    ok = land & (f["ice"] < 50) & (f["lava"] < 0.05) & (t != Terrain.GLACIER)
    if purpose in ("animals", "humans", "ecosystem"):
        score = (np.exp(-dist / 2.0) * 1.0 + np.clip(veg / 0.4, 0, 1) * 0.8 + fert * 0.5
                 - np.clip(np.abs(temp - 18.0) / 15.0, 0, 1) * 1.0)
        if purpose == "humans":
            score -= (f["elevation"] > 1800) * 1.0
    elif purpose == "restore":
        # degraded but restorable: little vegetation, yet water and warmth not hopeless
        score = (1.0 - np.clip(veg / 0.3, 0, 1)) + np.exp(-dist / 3.0) * 0.7 - np.clip(np.abs(temp - 16.0) / 15.0, 0, 1)
        score -= (t == Terrain.DESERT) * 0.4  # deserts are a natural biome, not damage
    elif purpose == "lake":
        score = (np.clip(dist / 4.0, 0, 1) + fert * 0.5 + np.clip(veg / 0.4, 0, 1) * 0.3
                 - np.clip(np.abs(temp - 16.0) / 15.0, 0, 1) - (f["elevation"] - w.sea_level < 40) * 2.0)
    else:
        score = veg + fert
    score = np.where(ok, score, -1e9)
    if avoid:
        h, wd = w.shape
        yy, xx = np.mgrid[0:h, 0:wd]
        for (ax, ay, r) in avoid:
            score = np.where(np.hypot(xx - ax, yy - ay) < r, score - 2.0, score)
    if within is not None:
        h, wd = w.shape
        yy, xx = np.mgrid[0:h, 0:wd]
        score = np.where(np.hypot(xx - within[0], yy - within[1]) <= within[2], score, -1e9)
    j, i = np.unravel_index(int(np.argmax(score)), score.shape)
    if score[j, i] < -1e8:
        return None
    return int(i), int(j), float(score[j, i])
