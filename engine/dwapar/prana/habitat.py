"""What creatures can sense of the physical world, rebuilt once per simulated day.

Everything here is read from the authoritative fields; nothing is invented. The water-distance
map stands for a creature's knowledge of its surroundings: animals use it within their
perception range, and humans use it only within sight (otherwise they rely on memory and
exploration).
"""

from __future__ import annotations

import numpy as np

from ..brahmanda.world import Terrain, World


#: A tile's runoff counts as a drinkable stream when it carries at least this much water (m³/s).
#: 0.05 m³/s (50 L/s) is a small permanent creek; on a 2 km tile that is ~0.045 mm/h of flow_flux.
STREAM_M3S = 0.05


def drinkable(world: World) -> np.ndarray:
    """Tiles where a creature can drink: lakes, rivers, wetlands, standing water, or a stream
    (the tile's runoff, from the engine's flow routing, carries at least STREAM_M3S)."""
    f = world.f
    land = ~world.is_ocean
    t = world.terrain
    stream_mm_h = STREAM_M3S * 3600.0 / (world.cfg.tile_size_m ** 2) * 1000.0
    return land & ((f["surface_water"] > 20.0) | (t == Terrain.LAKE) | (t == Terrain.RIVER) | (t == Terrain.WETLAND)
                   | (f["flow_flux"] >= stream_mm_h))


class Habitat:
    def __init__(self, world: World):
        self.tile = world.cfg.tile_size_m
        self.h, self.w = world.shape
        self.rebuild(world)

    def rebuild(self, world: World) -> None:
        f = world.f
        self.ocean = world.is_ocean
        self.land = ~self.ocean
        self.sea = world.sea_level
        self.water = drinkable(world)
        self.biomass = f["biomass"]
        self.temp = f["temperature"]
        self.elev = f["elevation"]
        self.stone = f["stone"]
        self.fire = f["fire"]
        self.forest = np.clip(f["biomass"] / 25.0, 0.0, 1.0)
        self.dist = self._distance(self.water, self.land)
        self.version = world.tick

    @staticmethod
    def _distance(src: np.ndarray, passable: np.ndarray, max_iter: int = 80) -> np.ndarray:
        big = 1e6
        d = np.where(src, 0.0, big)
        for _ in range(max_iter):
            p = np.pad(d, 1, constant_values=big)
            m = np.minimum.reduce([p[1:-1, :-2], p[1:-1, 2:], p[:-2, 1:-1], p[2:, 1:-1]]) + 1.0
            m2 = np.minimum.reduce([p[:-2, :-2], p[:-2, 2:], p[2:, :-2], p[2:, 2:]]) + 1.4142
            nd = np.where(passable, np.minimum(d, np.minimum(m, m2)), big)
            nd[src] = 0.0
            if np.array_equal(nd, d):
                break
            d = nd
        return d

    # ------------------------------------------------------------------ helpers
    def tile_of(self, x: float, y: float) -> tuple[int, int]:
        return (min(self.w - 1, max(0, int(x // self.tile))), min(self.h - 1, max(0, int(y // self.tile))))

    def is_land(self, x: float, y: float) -> bool:
        """Dry ground at this exact point: the surface interpolated between tile centres must be at
        least 0.5 m above the sea, so creatures and shelters respect the same continuous coastline
        that the 3D view draws (a coastal 2 km tile is partly sea)."""
        if x < 0 or y < 0 or x >= self.w * self.tile or y >= self.h * self.tile:
            return False
        i, j = self.tile_of(x, y)
        if not self.land[j, i]:
            return False
        gx = min(self.w - 1.0, max(0.0, x / self.tile - 0.5))
        gy = min(self.h - 1.0, max(0.0, y / self.tile - 0.5))
        i0, j0 = int(gx), int(gy)
        i1, j1 = min(i0 + 1, self.w - 1), min(j0 + 1, self.h - 1)
        fx, fy = gx - i0, gy - j0
        e = self.elev
        z = (e[j0, i0] * (1 - fx) + e[j0, i1] * fx) * (1 - fy) + (e[j1, i0] * (1 - fx) + e[j1, i1] * fx) * fy
        return bool(z > self.sea + 0.5)

    def near_water(self, x: float, y: float) -> bool:
        i, j = self.tile_of(x, y)
        return float(self.dist[j, i]) <= 1.0

    def water_step(self, x: float, y: float, max_tiles: float) -> tuple[float, float] | None:
        """Centre of the neighbouring tile closest to water, if water lies within max_tiles."""
        i, j = self.tile_of(x, y)
        if self.dist[j, i] > max_tiles:
            return None
        best, bi, bj = self.dist[j, i], i, j
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                a, b = i + di, j + dj
                if 0 <= a < self.w and 0 <= b < self.h and self.dist[b, a] < best:
                    best, bi, bj = self.dist[b, a], a, b
        return ((bi + 0.5) * self.tile, (bj + 0.5) * self.tile)

    def downhill(self, x: float, y: float) -> tuple[float, float]:
        """Centre of the lowest neighbouring land tile — water gathers in low ground."""
        i, j = self.tile_of(x, y)
        best, bi, bj = self.elev[j, i], i, j
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                a, b = i + di, j + dj
                if 0 <= a < self.w and 0 <= b < self.h and self.land[b, a] and self.elev[b, a] < best:
                    best, bi, bj = self.elev[b, a], a, b
        return ((bi + 0.5) * self.tile, (bj + 0.5) * self.tile)

    def at(self, arr: np.ndarray, x: float, y: float) -> float:
        i, j = self.tile_of(x, y)
        return float(arr[j, i])
