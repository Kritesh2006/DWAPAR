"""Optimisations must not change results: compare against verbatim copies of the 0.2 code."""

import numpy as np

from dwapar.grid import NEIGHBOURS, mfd_flow, neighbour
from dwapar.prakriti.solar import daily_mean_insolation, instantaneous_insolation


def mfd_flow_reference(height, available, fraction, scale, tile_size_m, exponent=4.0):
    """Engine 0.2 implementation, kept verbatim as the oracle."""
    drops, weights = [], []
    for dy, dx, dist in NEIGHBOURS:
        nb = neighbour(height, dy, dx, np.inf)
        d = np.maximum(height - nb, 0.0)
        drops.append(d)
        weights.append((d / (dist * tile_size_m)) ** exponent)
    total_w = np.sum(weights, axis=0)
    has = total_w > 0
    safe_total = np.where(has, total_w, 1.0)
    ratio = np.full(height.shape, np.inf)
    for d, wgt in zip(drops, weights):
        wi = wgt / safe_total
        ratio = np.where(wi > 0, np.minimum(ratio, d / np.where(wi > 0, wi, 1.0)), ratio)
    cap = np.where(has, fraction * ratio * scale, 0.0)
    out = np.minimum(available, cap)
    delta = -out
    for (dy, dx, _), wgt in zip(NEIGHBOURS, weights):
        delta = delta + neighbour(out * (wgt / safe_total), -dy, -dx, 0.0)
    return delta, out


def test_optimised_mfd_is_bit_identical_to_reference():
    rng = np.random.default_rng(0)
    for shape in ((17, 23), (64, 64)):
        h = rng.normal(0, 50, shape).cumsum(axis=0)
        avail = rng.random(shape) * 1000
        for exp in (1.0, 4.0):
            d1, o1 = mfd_flow(h, avail, 0.05, 1000.0, 2000.0, exp)
            d0, o0 = mfd_flow_reference(h, avail, 0.05, 1000.0, 2000.0, exp)
            assert np.array_equal(o1, o0)
            assert np.array_equal(d1, d0)


def test_row_wise_solar_geometry_is_identical():
    lat = np.deg2rad(np.repeat(np.linspace(48, -12, 40)[:, None], 30, axis=1))
    col = lat[:, :1].copy()
    for doy in (0.0, 47.5, 180.25):
        assert np.array_equal(np.broadcast_to(daily_mean_insolation(col, doy, 360), lat.shape),
                              daily_mean_insolation(lat, doy, 360))
        for hour in (3.0, 12.0):
            assert np.array_equal(np.broadcast_to(instantaneous_insolation(col, doy, hour, 360), lat.shape),
                                  instantaneous_insolation(lat, doy, hour, 360))
