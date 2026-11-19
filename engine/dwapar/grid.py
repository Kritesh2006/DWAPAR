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


def mfd_flow(height: np.ndarray, available: np.ndarray, fraction: float, scale: float,
             tile_size_m: float, exponent: float = 4.0) -> tuple[np.ndarray, np.ndarray]:
    """Multiple-flow-direction routing (Freeman/Holmgren style), exactly mass-conserving.

    Each cell sends water (or any conserved quantity) to *all* lower neighbours with weights
    ∝ slope**exponent. The total outflow M is capped so that no neighbour receives more
    than ``fraction`` of the height difference to it (×``scale`` converts metres to the
    quantity's unit): this guarantees no pairwise overshoot.

    Implementation note (engine 0.3): neighbours are read as views into one +inf-padded copy and
    inflows are accumulated into one zero-padded buffer, instead of allocating a shifted copy per
    direction. The arithmetic and its order are unchanged, so results are bit-identical to the
    0.2 implementation (``tests/test_performance.py`` checks this against a reference copy).

    Returns (delta field, outflow per cell). Nothing leaves the map edges.
    """
    h, w = height.shape
    hp = np.full((h + 2, w + 2), np.inf)
    hp[1:-1, 1:-1] = height
    drops = []
    weights = []
    for dy, dx, dist in NEIGHBOURS:
        nb = hp[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
        d = np.maximum(height - nb, 0.0)
        drops.append(d)
        weights.append((d / (dist * tile_size_m)) ** exponent)
    total_w = np.sum(weights, axis=0)
    has = total_w > 0
    safe_total = np.where(has, total_w, 1.0)
    ratio = np.full(height.shape, np.inf)
    fractions = []
    tmp = np.empty(height.shape)
    for d, wgt in zip(drops, weights):
        wi = wgt / safe_total
        fractions.append(wi)
        pos = wi > 0
        np.divide(d, wi, out=tmp, where=pos)
        np.minimum(ratio, tmp, out=ratio, where=pos)
    cap = np.where(has, fraction * ratio * scale, 0.0)
    out = np.minimum(available, cap)
    acc = np.zeros((h + 2, w + 2))
    acc[1:-1, 1:-1] = -out
    for (dy, dx, _), wi in zip(NEIGHBOURS, fractions):
        acc[1 + dy:1 + dy + h, 1 + dx:1 + dx + w] += out * wi
    return acc[1:-1, 1:-1].copy(), out


def advect_periodic(a: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Conservative first-order upwind advection on a periodic grid (|u|,|v| < 1 cell/step)."""
    out_e, out_w = np.maximum(u, 0) * a, np.maximum(-u, 0) * a
    out_s, out_n = np.maximum(v, 0) * a, np.maximum(-v, 0) * a
    a = a - out_e - out_w - out_s - out_n
    a = a + np.roll(out_e, 1, axis=1) + np.roll(out_w, -1, axis=1)
    return a + np.roll(out_s, 1, axis=0) + np.roll(out_n, -1, axis=0)


def advect_masked(a: np.ndarray, u: np.ndarray, v: np.ndarray, mask: np.ndarray, diffusion: float) -> np.ndarray:
    """Upwind *advective-form* transport of an intensive scalar (e.g. temperature) plus diffusion,
    restricted to faces between two cells of ``mask``.

    Surface currents that stop at coastlines are not divergence-free, so the flux form would pile
    heat against coasts; the advective form keeps a uniform field uniform. Diffusion uses the
    flux form and conserves the masked total exactly."""
    m = mask.astype(float)
    res = a.copy()
    for dy, dx, vel in ((0, -1, np.maximum(u, 0)), (0, 1, np.maximum(-u, 0)),
                        (-1, 0, np.maximum(v, 0)), (1, 0, np.maximum(-v, 0))):
        # (dy, dx) points at the *upstream* neighbour for that velocity sign
        open_face = m * neighbour(m, dy, dx, 0.0)
        res = res - vel * open_face * (a - neighbour(a, dy, dx, 0.0))
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        open_face = m * neighbour(m, dy, dx, 0.0)
        res = res + diffusion * open_face * (neighbour(a, dy, dx, 0.0) - a)
    return res
