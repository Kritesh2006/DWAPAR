"""Grid helpers shared by all systems (8-neighbourhood, non-periodic)."""

from __future__ import annotations

import numpy as np

#: (dy, dx, distance in tile units) for the 8 neighbours, fixed order.
NEIGHBOURS: tuple[tuple[int, int, float], ...] = (
    (-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
    (-1, -1, 2**0.5), (-1, 1, 2**0.5), (1, -1, 2**0.5), (1, 1, 2**0.5),
)


def neighbour(a: np.ndarray, dy: int, dx: int, fill: float) -> np.ndarray:
    """Value of the neighbour at offset (dy, dx) for every cell; ``fill`` outside the map."""
    h, w = a.shape
    out = np.full_like(a, fill)
    ys_dst = slice(max(0, -dy), h - max(0, dy))
    xs_dst = slice(max(0, -dx), w - max(0, dx))
    ys_src = slice(max(0, dy), h - max(0, -dy))
    xs_src = slice(max(0, dx), w - max(0, -dx))
    out[ys_dst, xs_dst] = a[ys_src, xs_src]
    return out


def steepest_descent(height: np.ndarray, tile_size_m: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """For each cell: index (0..7, or -1 for pit) of steepest downhill neighbour,
    the height drop to it (m) and the slope (m/m)."""
    best_slope = np.zeros_like(height)
    best_dir = np.full(height.shape, -1, dtype=np.int8)
    best_drop = np.zeros_like(height)
    for i, (dy, dx, dist) in enumerate(NEIGHBOURS):
        nb = neighbour(height, dy, dx, np.inf)
        drop = height - nb
        slope = drop / (dist * tile_size_m)
        better = slope > best_slope
        best_slope = np.where(better, slope, best_slope)
        best_drop = np.where(better, drop, best_drop)
        best_dir = np.where(better, np.int8(i), best_dir)
    return best_dir, best_drop, best_slope


def target_index(direction: np.ndarray) -> np.ndarray:
    """Flat index of the neighbour selected by ``direction`` (−1 maps to self)."""
    h, w = direction.shape
    yy, xx = np.indices((h, w))
    dys = np.array([n[0] for n in NEIGHBOURS] + [0])
    dxs = np.array([n[1] for n in NEIGHBOURS] + [0])
    d = np.where(direction < 0, 8, direction)
    ty = np.clip(yy + dys[d], 0, h - 1)
    tx = np.clip(xx + dxs[d], 0, w - 1)
    return (ty * w + tx).ravel()


def move_along(amount: np.ndarray, direction: np.ndarray) -> np.ndarray:
    """Conservatively move ``amount`` from each cell to its ``direction`` neighbour.

    Returns the change field (sum is exactly zero up to float rounding)."""
    delta = -amount.ravel().copy()
    np.add.at(delta, target_index(direction), amount.ravel())
    return delta.reshape(amount.shape)


def neighbour_mean(a: np.ndarray) -> np.ndarray:
    acc = np.zeros_like(a)
    cnt = np.zeros_like(a)
    for dy, dx, _ in NEIGHBOURS:
        nb = neighbour(a, dy, dx, np.nan)
        ok = ~np.isnan(nb)
        acc += np.where(ok, nb, 0.0)
        cnt += ok
    return acc / np.maximum(cnt, 1)
