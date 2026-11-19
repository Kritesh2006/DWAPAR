"""Static geological framework derived deterministically from the seed.

Simplified plate tectonics: a Voronoi partition into rigid plates, each with a
constant velocity. Relative motion across plate boundaries sets a long-term
vertical rate (uplift at convergent boundaries, subsidence at divergent ones),
earthquake stress loading, and the locations of volcanoes (subduction arcs and
hotspots). Everything here is a pure function of the config, so old
checkpoints can be upgraded by recomputing it.
"""

from __future__ import annotations

import numpy as np

from ..config import WorldConfig
from ..grid import NEIGHBOURS, neighbour, neighbour_mean
from ..rng import generator
from .noise import fbm

#: m/yr of vertical motion per unit of normalised convergence (real orogens: ~1–10 mm/yr)
UPLIFT_M_PER_YR = 0.004
SUBSIDENCE_M_PER_YR = 0.0015


def plate_layout(cfg: WorldConfig) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (plate_id, seeds_yx, velocity_yx) — velocity in tiles per year (dimensionless direction*speed)."""
    h, w = cfg.height, cfg.width
    rng = generator(cfg.seed, "tectonics.plates")
    n = int(np.clip(round(7 * np.sqrt(w * h / (128 * 128))), 4, 24))
    seeds = rng.random((n, 2)) * np.array([h, w])
    vel = rng.normal(0.0, 1.0, (n, 2))
    yy, xx = np.indices((h, w))
    # Warp the distance field so boundaries are irregular rather than straight Voronoi edges.
    warp_y = (fbm(w, h, cfg.seed, "tectonics.warp_y", base_cell=30, octaves=3) - 0.5) * 18
    warp_x = (fbm(w, h, cfg.seed, "tectonics.warp_x", base_cell=30, octaves=3) - 0.5) * 18
    d = ((yy[None] + warp_y[None] - seeds[:, 0, None, None]) ** 2 +
         (xx[None] + warp_x[None] - seeds[:, 1, None, None]) ** 2)
    pid = np.argmin(d, axis=0)
    return pid.astype(np.int32), seeds, vel


def boundary_convergence(pid: np.ndarray, seeds: np.ndarray, vel: np.ndarray) -> np.ndarray:
    """Signed convergence at each tile (+ converging, − diverging, 0 interior)."""
    conv = np.zeros(pid.shape)
    count = np.zeros(pid.shape)
    for dy, dx, _ in NEIGHBOURS[:4]:
        other = neighbour(pid.astype(float), dy, dx, -1).astype(int)
        mask = (other >= 0) & (other != pid)
        if not mask.any():
            continue
        a, b = pid[mask], other[mask]
        normal = seeds[b] - seeds[a]
        normal /= np.linalg.norm(normal, axis=1, keepdims=True) + 1e-9
        rel = vel[a] - vel[b]  # motion of this plate relative to the neighbour
        conv[mask] += np.einsum("ij,ij->i", rel, normal)
        count[mask] += 1
    return np.where(count > 0, conv / np.maximum(count, 1), 0.0)


def orogeny(cfg: WorldConfig) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(plate_id, raw boundary convergence, smoothed normalised belt in [-1, 1])."""
    pid, seeds, vel = plate_layout(cfg)
    conv = boundary_convergence(pid, seeds, vel)
    # Spread boundary effects over a belt a few tiles wide.
    belt = conv.copy()
    for _ in range(4):
        belt = 0.5 * belt + 0.5 * neighbour_mean(belt)
    belt /= max(np.abs(belt).max(), 1e-9)
    return pid, conv, belt


def build_static(cfg: WorldConfig, elevation: np.ndarray) -> dict[str, np.ndarray]:
    """Compute static tectonic/hydrogeological fields for a world."""
    pid, conv, belt = orogeny(cfg)
    uplift = np.where(belt > 0, belt * UPLIFT_M_PER_YR, belt * SUBSIDENCE_M_PER_YR)

    boundary = np.abs(conv) > 0
    stress_rate = np.where(boundary, np.abs(conv) / max(np.abs(conv).max(), 1e-9), 0.0)

    # Volcanoes: arcs on the over-riding side of strong convergence, plus a few hotspots.
    rng = generator(cfg.seed, "tectonics.volcanoes")
    potential = np.clip(belt, 0, None) ** 2
    hot_n = max(1, (cfg.width * cfg.height) // 6000)
    yy, xx = np.indices(pid.shape)
    for _ in range(hot_n):
        cy, cx = rng.random(2) * np.array(pid.shape)
        potential += 0.8 * np.exp(-((yy - cy) ** 2 + (xx - cx) ** 2) / 8.0)
    jitter = rng.random(pid.shape) * 0.05
    score = potential + jitter
    volcano = np.zeros(pid.shape)
    n_volc = max(3, (cfg.width * cfg.height) // 1500)
    order = np.argsort(-score, axis=None)
    taken = 0
    for idx in order:
        y, x = divmod(int(idx), cfg.width)
        if score[y, x] < 0.15:
            break
        y0, y1, x0, x1 = max(0, y - 5), y + 6, max(0, x - 5), x + 6
        if volcano[y0:y1, x0:x1].any():
            continue  # keep volcanoes at least 6 tiles apart
        volcano[y, x] = float(np.clip(score[y, x], 0.2, 1.0))
        taken += 1
        if taken >= n_volc:
            break

    # Aquifer storage capacity (mm of water): thick porous sediments in lowlands, thin on mountains.
    porous = fbm(cfg.width, cfg.height, cfg.seed, "hydro.aquifer", base_cell=28, octaves=4)
    e_norm = np.clip(elevation / cfg.max_elevation_m, 0, 1)
    aquifer = np.where(elevation < 0, 0.0,  # generation-time sea level is 0
 (400.0 + 2600.0 * porous) * (1.0 - 0.8 * e_norm))

    # Surface ocean currents (tiles/hour): wind-driven zonal flow; land blocking handled at run time.
    lat = np.linspace(cfg.lat_top, cfg.lat_bottom, cfg.height)[:, None]
    blend = np.tanh((np.abs(lat) - 25.0) / 6.0)
    base = cfg.wind_speed_tiles_per_hour * 0.12
    cur_u = np.repeat(base * np.where(blend < 0, 0.8 * blend, blend), cfg.width, axis=1)
    # Weak meridional component: equatorward on the east side of basins, poleward on the west (gyre-like).
    xs = np.linspace(-1, 1, cfg.width)[None, :]
    toward_equator = -np.sign(lat - 0.0)
    cur_v = np.repeat(base * 0.5 * toward_equator, cfg.width, axis=1) * xs  # +y = south

    return {
        "plate_id": pid.astype(np.float64),
        "uplift_rate": uplift,
        "stress_rate": stress_rate,
        "volcano": volcano,
        "aquifer_capacity": aquifer,
        "current_u": cur_u,
        "current_v": cur_v,
    }
