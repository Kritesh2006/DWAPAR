"""Brahmanda — procedural, seed-deterministic world generation.

Pipeline (each stage derives from the previous ones, never from hand-painted data):
    1. elevation from fractal + ridged noise with an ocean falloff
    2. latitude & equilibrium temperature from solar geometry
    3. a moisture proxy (distance from ocean + noise) as the initial climate guess
    4. depression filling (priority-flood) → initial lakes; D8 drainage → initial river flux
    5. soils (field capacity, organic matter), vegetation from climate suitability
    6. geological deposits (stone, sand, clay, iron, copper, coal)
    7. terrain classification from all of the above
The initial climate guess is then corrected by the real dynamics as the world runs.
"""

from __future__ import annotations

import heapq

import numpy as np

from ..config import WorldConfig
from ..grid import NEIGHBOURS, neighbour, steepest_descent
from ..prakriti.solar import saturation_capacity_mm, seasonal_temperature
from .noise import fbm, ridged
from .terrain import classify
from .world import World

TILE_AREA_M2_FACTOR = 1.0  # placeholder for non-square tiles in future


def _elevation(cfg: WorldConfig) -> np.ndarray:
    w, h, s = cfg.width, cfg.height, cfg.seed
    scale = max(w, h) / 128.0  # keep feature size proportional for larger maps
    base = fbm(w, h, s, "elev.base", base_cell=56 * scale, octaves=7)
    cont = fbm(w, h, s, "elev.continent", base_cell=110 * scale, octaves=3)
    ridge = ridged(w, h, s, "elev.ridge", base_cell=46 * scale, octaves=5)
    yy, xx = np.indices((h, w))
    nx = (xx + 0.5) / w * 2 - 1
    ny = (yy + 0.5) / h * 2 - 1
    edge = np.maximum(np.abs(nx), np.abs(ny)) ** 3  # squarish falloff: oceans at the rim
    radial = np.sqrt(nx**2 + ny**2) / np.sqrt(2)
    e = 0.45 * base + 0.35 * cont + 0.30 * ridge * (cont > 0.35) - 0.55 * edge - 0.15 * radial
    sea = np.quantile(e, cfg.ocean_fraction)
    out = np.empty_like(e)
    land = e >= sea
    lmax, lmin = e.max(), e.min()
    out[land] = ((e[land] - sea) / (lmax - sea)) ** 2.3 * cfg.max_elevation_m
    out[~land] = -(((sea - e[~land]) / (sea - lmin)) ** 0.65) * cfg.max_depth_m
    out[land] = np.maximum(out[land], 0.5)  # land is strictly above sea level
    out[~land] = np.minimum(out[~land], -1.0)
    return out


def _latitude(cfg: WorldConfig) -> np.ndarray:
    lat = np.linspace(cfg.lat_top, cfg.lat_bottom, cfg.height)
    return np.repeat(lat[:, None], cfg.width, axis=1)


def _distance_to_ocean(ocean: np.ndarray, max_steps: int = 64) -> np.ndarray:
    dist = np.where(ocean, 0.0, np.inf)
    frontier = ocean.copy()
    for step in range(1, max_steps + 1):
        grown = frontier.copy()
        for dy, dx, _ in NEIGHBOURS[:4]:
            grown |= neighbour(frontier.astype(float), dy, dx, 0.0) > 0
        new = grown & np.isinf(dist)
        if not new.any():
            break
        dist[new] = step
        frontier = grown
    dist[np.isinf(dist)] = max_steps
    return dist


def priority_flood(elev: np.ndarray, ocean: np.ndarray, epsilon: float = 0.0) -> np.ndarray:
    """Barnes et al. (2014) priority-flood. Returns elevation with depressions filled.

    With epsilon > 0 every filled flat gets a tiny gradient so drainage is defined."""
    h, w = elev.shape
    filled = elev.copy()
    closed = np.zeros((h, w), dtype=bool)
    heap: list[tuple[float, int, int]] = []
    border = np.zeros((h, w), dtype=bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    seeds = ocean | border
    for y, x in zip(*np.nonzero(seeds)):
        heapq.heappush(heap, (float(filled[y, x]), int(y), int(x)))
        closed[y, x] = True
    while heap:
        z, y, x = heapq.heappop(heap)
        for dy, dx, _ in NEIGHBOURS:
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not closed[ny, nx]:
                closed[ny, nx] = True
                if filled[ny, nx] <= z:
                    filled[ny, nx] = z + epsilon
                heapq.heappush(heap, (float(filled[ny, nx]), ny, nx))
    return filled


def _flow_accumulation(routing: np.ndarray, weight: np.ndarray, tile_size_m: float) -> np.ndarray:
    direction, _, _ = steepest_descent(routing, tile_size_m)
    h, w = routing.shape
    order = np.argsort(-routing, axis=None, kind="stable")
    acc = weight.ravel().copy()
    dirs = direction.ravel()
    for idx in order:
        d = dirs[idx]
        if d < 0:
            continue
        dy, dx, _ = NEIGHBOURS[d]
        y, x = divmod(int(idx), w)
        ty, tx = y + dy, x + dx
        if 0 <= ty < h and 0 <= tx < w:
            acc[ty * w + tx] += acc[idx]
    return acc.reshape(h, w)


def generate_world(cfg: WorldConfig) -> World:
    s, w, h = cfg.seed, cfg.width, cfg.height
    elev = _elevation(cfg)
    ocean = elev < 0
    lat = _latitude(cfg)
    lat_rad = np.deg2rad(lat)

    # --- climate seed -----------------------------------------------------
    temp = seasonal_temperature(lat_rad, 0, cfg.days_per_year, elev, ocean)
    dist = _distance_to_ocean(ocean)
    wet_noise = fbm(w, h, s, "climate.wet", base_cell=40, octaves=4)
    rain_shadow = np.clip(elev / cfg.max_elevation_m, 0, 1)
    proxy = np.clip(0.85 * np.exp(-dist / 14.0) + 0.7 * wet_noise - 0.3 - 0.35 * rain_shadow, 0.0, 1.0)
    precip_ema = 0.2 + 5.0 * proxy**1.5  # mm/day

    # --- hydrology seed ---------------------------------------------------
    _, _, slope = steepest_descent(elev, cfg.tile_size_m)
    filled = priority_flood(elev, ocean)
    lake_depth_m = np.where(ocean, 0.0, filled - elev)
    lake_depth_m[lake_depth_m < 0.5] = 0.0  # ignore numerical micro-pits
    routing = priority_flood(elev, ocean, epsilon=1e-3)
    runoff_mm_h = np.where(ocean, 0.0, precip_ema * 0.35 / 24.0)
    flux = _flow_accumulation(routing, runoff_mm_h, cfg.tile_size_m)
    flow_flux = np.where(ocean, 0.0, flux)

    surface_water = np.where(ocean, -elev * 1000.0, lake_depth_m * 1000.0)
    surface_water += np.where(ocean, 0.0, np.clip(flow_flux, 0, 200) * 0.5)

    # --- soils ------------------------------------------------------------
    texture = fbm(w, h, s, "soil.texture", base_cell=24, octaves=4)
    depth_factor = 1.0 - np.clip(slope * 6.0, 0.0, 0.75) - np.clip(elev / cfg.max_elevation_m, 0, 1) * 0.4
    field_capacity = np.where(ocean, 1.0, (70.0 + 230.0 * texture) * np.clip(depth_factor, 0.2, 1.0))
    soil_water = np.where(ocean, field_capacity, field_capacity * (0.12 + 0.7 * proxy))

    # --- vegetation & organic matter --------------------------------------
    f_t = np.clip(temp / 14.0, 0, 1) * np.clip((40.0 - temp) / 10.0, 0, 1)
    veg_noise = fbm(w, h, s, "veg.init", base_cell=16, octaves=4)
    deep = surface_water > 600.0
    biomass = np.where(ocean | deep, 0.0, 26.0 * f_t * proxy**1.3 * (0.6 + 0.6 * veg_noise))
    organic = np.where(ocean, 0.0, 1.0 + 14.0 * proxy * (0.4 + 0.6 * f_t) + 0.3 * biomass)

    # --- snow -------------------------------------------------------------
    snow = np.where(~ocean & (temp < 0), np.clip(-temp, 0, 30) * 12.0, 0.0)

    # --- geology (tonnes per tile) ----------------------------------------
    tile_km2 = (cfg.tile_size_m / 1000.0) ** 2
    e_norm = np.clip(elev / cfg.max_elevation_m, 0, 1)
    stone = np.where(ocean, 0.0, (0.15 + 1.6 * e_norm + 4.0 * np.clip(slope, 0, 0.5)) * 2.0e6 * tile_km2)
    coastal = (~ocean) & (dist <= 2) & (elev < 60)
    arid = np.clip(1.0 - proxy * 1.8, 0, 1)
    sand_n = fbm(w, h, s, "geo.sand", base_cell=20, octaves=4)
    sand = np.where(ocean, 0.0, (0.6 * coastal + 1.2 * arid * (elev < 1500)) * (0.4 + sand_n) * 4.0e5 * tile_km2)
    lowflat = np.clip(1.0 - elev / 600.0, 0, 1) * np.clip(1.0 - slope * 20, 0, 1)
    clay_n = fbm(w, h, s, "geo.clay", base_cell=18, octaves=4)
    clay = np.where(ocean, 0.0, lowflat * (0.3 + proxy) * (0.3 + clay_n) * 1.2e5 * tile_km2)

    iron_v = ridged(w, h, s, "geo.iron", base_cell=14, octaves=4)
    copper_v = ridged(w, h, s, "geo.copper", base_cell=11, octaves=4)
    coal_n = fbm(w, h, s, "geo.coal", base_cell=26, octaves=4)
    upland = np.clip((elev - 300.0) / 1500.0, 0, 1)
    iron = np.where(ocean, 0.0, np.clip(iron_v - 0.78, 0, None) / 0.22 * (0.3 + upland) * 3.0e5 * tile_km2)
    copper = np.where(ocean, 0.0, np.clip(copper_v - 0.86, 0, None) / 0.14 * upland * 6.0e4 * tile_km2)
    basin = np.clip(1.0 - np.abs(elev - 350.0) / 700.0, 0, 1)
    coal = np.where(ocean, 0.0, np.clip(coal_n - 0.62, 0, None) / 0.38 * basin * 2.5e5 * tile_km2)

    fields = {
        "elevation": elev,
        "temperature": temp,
        "surface_water": surface_water,
        "soil_water": soil_water,
        "atmo_water": saturation_capacity_mm(temp) * 0.55,
        "snow": snow,
        "biomass": biomass,
        "organic_matter": organic,
        "fire": np.zeros_like(elev),
        "drought_days": np.where(proxy < 0.15, 20.0, 0.0),
        "flow_flux": flow_flux,
        "precip_ema": precip_ema,
        "temp_ema": temp.copy(),
        "temp_day": temp.copy(),
        "precip_today": np.zeros_like(elev),
        "stone": stone,
        "sand": sand,
        "clay": clay,
        "iron_ore": iron,
        "copper_ore": copper,
        "coal": coal,
        "field_capacity": field_capacity,
        "latitude": lat,
    }
    soil_moist = np.clip(soil_water / np.maximum(field_capacity, 1e-9), 0, 1)
    terrain = classify(elev, slope, surface_water, soil_moist, flow_flux, snow, biomass, precip_ema)
    world = World(cfg, fields, terrain, tick=0)
    world.validate()
    return world
