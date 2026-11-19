"""Deterministic random streams.

Every random draw in DWAPAR comes from a generator derived from
``(world seed, stream id, tick)``. Nothing depends on wall-clock time,
thread scheduling, or hidden global RNG state, so:

* the same seed + config always generates the same world;
* a world restored from a checkpoint at tick T continues exactly as an
  uninterrupted run would (no RNG state needs to be saved).
"""

from __future__ import annotations

import zlib

import numpy as np

# Stable integer ids for named streams (crc32 so they never change between runs).
def _stream_id(name: str) -> int:
    return zlib.crc32(name.encode("utf-8"))


def generator(seed: int, stream: str, tick: int = 0) -> np.random.Generator:
    """Return an independent PCG64 generator for (seed, stream, tick)."""
    ss = np.random.SeedSequence([seed & 0xFFFFFFFF, (seed >> 32) & 0xFFFFFFFF, _stream_id(stream), tick])
    return np.random.Generator(np.random.PCG64(ss))
