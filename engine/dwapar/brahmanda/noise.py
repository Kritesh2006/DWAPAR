"""Seeded, vectorised gradient-free value noise (fractal Brownian motion).

Implemented from scratch on numpy so generation has no native dependency
whose output could differ between library versions.
"""

from __future__ import annotations

import numpy as np

from ..rng import generator


def _smooth(t: np.ndarray) -> np.ndarray:
    # quintic fade (Perlin 2002)
    return t * t * t * (t * (t * 6 - 15) + 10)


def value_noise(width: int, height: int, cell: float, rng: np.random.Generator) -> np.ndarray:
    """Single octave of value noise in [0, 1] with lattice spacing ``cell`` tiles."""
    gw = int(np.ceil(width / cell)) + 2
    gh = int(np.ceil(height / cell)) + 2
    lattice = rng.random((gh, gw))
    ox, oy = rng.random(2)  # random sub-cell offset avoids lattice alignment between octaves
    xs = np.arange(width) / cell + ox
    ys = np.arange(height) / cell + oy
    x0 = np.floor(xs).astype(int)
    y0 = np.floor(ys).astype(int)
    fx = _smooth(xs - x0)[None, :]
    fy = _smooth(ys - y0)[:, None]
    a = lattice[np.ix_(y0, x0)]
    b = lattice[np.ix_(y0, x0 + 1)]
    c = lattice[np.ix_(y0 + 1, x0)]
    d = lattice[np.ix_(y0 + 1, x0 + 1)]
    top = a + (b - a) * fx
    bot = c + (d - c) * fx
    return top + (bot - top) * fy


def fbm(
    width: int,
    height: int,
    seed: int,
    stream: str,
    base_cell: float = 48.0,
    octaves: int = 6,
    persistence: float = 0.5,
    lacunarity: float = 2.0,
) -> np.ndarray:
    """Fractal noise normalised to [0, 1]."""
    rng = generator(seed, f"noise:{stream}")
    total = np.zeros((height, width))
    amp, cell, norm = 1.0, base_cell, 0.0
    for _ in range(octaves):
        total += amp * value_noise(width, height, max(cell, 1.0), rng)
        norm += amp
        amp *= persistence
        cell /= lacunarity
    total /= norm
    lo, hi = total.min(), total.max()
    return (total - lo) / (hi - lo + 1e-12)


def ridged(width: int, height: int, seed: int, stream: str, base_cell: float = 40.0, octaves: int = 5) -> np.ndarray:
    """Ridged multifractal-ish noise in [0, 1]: sharp crests, used for ranges and ore veins."""
    n = fbm(width, height, seed, stream, base_cell, octaves)
    r = 1.0 - np.abs(2.0 * n - 1.0)
    return r**2
