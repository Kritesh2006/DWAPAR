"""The World: a bundle of named per-tile arrays plus static geometry.

Units (documented in WORLD_LAWS.md):
    elevation        m above sea level (sea level = 0)
    temperature      °C (near-surface air)
    surface_water    mm of standing/flowing water (oceans included)
    soil_water       mm held in the soil column
    field_capacity   mm the soil column can hold (static)
    atmo_water       mm precipitable water in the air column
    snow             mm snow-water-equivalent
    biomass          kg/m² living vegetation (dry mass)
    organic_matter   kg/m² dead organic carbon in soil and litter
    fire             0..1 fire intensity (0 = not burning)
    drought_days     days since meaningful rain (>1 mm/day)
    *_ore, coal, stone, sand, clay   tonnes per tile (finite)
    flow_flux        mm/h surface water leaving the tile (exponential moving average)
    precip_ema       mm/day precipitation (slow moving average, ~1 season)
    temp_ema         °C temperature (slow moving average, ~1 season)
    temp_day         °C temperature (fast moving average, ~1 day)
    precip_today     mm precipitation accumulated since local midnight
"""

from __future__ import annotations

from enum import IntEnum

import numpy as np

from ..config import WorldConfig


class Terrain(IntEnum):
    OCEAN = 0
    LAKE = 1
    RIVER = 2
    WETLAND = 3
    DESERT = 4
    PLAINS = 5
    FOREST = 6
    HILLS = 7
    MOUNTAINS = 8
    SNOW = 9


#: Dynamic state arrays that evolve during simulation (float64).
DYNAMIC_FIELDS = (
    "elevation",
    "temperature",
    "surface_water",
    "soil_water",
    "atmo_water",
    "snow",
    "biomass",
    "organic_matter",
    "fire",
    "drought_days",
    "flow_flux",
    "precip_ema",
    "temp_ema",
    "temp_day",
    "precip_today",
)

#: Finite, nonrenewable deposits (tonnes per tile). Only extraction may reduce them.
MINERAL_FIELDS = ("stone", "sand", "clay", "iron_ore", "copper_ore", "coal")

#: Static properties fixed at generation.
STATIC_FIELDS = ("field_capacity", "latitude")

ALL_FLOAT_FIELDS = DYNAMIC_FIELDS + MINERAL_FIELDS + STATIC_FIELDS

#: Fields that must stay >= 0.
NON_NEGATIVE = (
    "surface_water", "soil_water", "atmo_water", "snow", "biomass", "organic_matter",
    "fire", "drought_days", "flow_flux", "precip_ema", "precip_today", "field_capacity",
) + MINERAL_FIELDS


class InvalidStateError(RuntimeError):
    """The world reached a physically impossible state. The engine refuses to continue."""


class World:
    def __init__(self, cfg: WorldConfig, fields: dict[str, np.ndarray], terrain: np.ndarray, tick: int = 0,
                 meta: dict | None = None):
        self.cfg = cfg
        self.tick = int(tick)
        #: Small JSON-serialisable counters (e.g. cumulative burned tiles). Persisted with checkpoints.
        self.meta: dict = dict(meta or {})
        shape = (cfg.height, cfg.width)
        missing = set(ALL_FLOAT_FIELDS) - set(fields)
        if missing:
            raise InvalidStateError(f"missing fields: {sorted(missing)}")
        self.f: dict[str, np.ndarray] = {}
        for name in ALL_FLOAT_FIELDS:
            arr = np.asarray(fields[name], dtype=np.float64)
            if arr.shape != shape:
                raise InvalidStateError(f"{name} has shape {arr.shape}, expected {shape}")
            self.f[name] = arr.copy()
        self.terrain = np.asarray(terrain, dtype=np.uint8).copy()
        if self.terrain.shape != shape:
            raise InvalidStateError("terrain shape mismatch")

    # Convenience attribute access: world.temperature etc.
    def __getattr__(self, name: str) -> np.ndarray:
        f = self.__dict__.get("f")
        if f is not None and name in f:
            return f[name]
        raise AttributeError(name)

    @property
    def shape(self) -> tuple[int, int]:
        return self.cfg.height, self.cfg.width

    @property
    def is_ocean(self) -> np.ndarray:
        return self.f["elevation"] < 0.0

    @property
    def soil_moisture(self) -> np.ndarray:
        """Relative soil moisture 0..1."""
        return np.clip(self.f["soil_water"] / np.maximum(self.f["field_capacity"], 1e-9), 0.0, 1.0)

    @property
    def fertility(self) -> np.ndarray:
        """Soil fertility 0..1, derived (not stored): organic matter, clay content and moisture.

        A soil with ~15 kg/m² organic carbon, some clay and adequate moisture scores ~1."""
        om = 1.0 - np.exp(-self.f["organic_matter"] / 8.0)
        clay = np.clip(self.f["clay"] / 4.0e5, 0.0, 1.0)
        wet = np.clip(self.soil_moisture / 0.5, 0.0, 1.0)
        fert = (0.55 * om + 0.2 * clay + 0.25 * wet) * (~self.is_ocean)
        return np.clip(fert, 0.0, 1.0)

    @property
    def vegetation_density(self) -> np.ndarray:
        """0..1, fraction of a mature closed-canopy forest (25 kg/m²)."""
        return np.clip(self.f["biomass"] / 25.0, 0.0, 1.0)

    @property
    def mineral_total(self) -> np.ndarray:
        return sum(self.f[m] for m in ("iron_ore", "copper_ore", "coal"))

    def copy(self) -> "World":
        return World(self.cfg, self.f, self.terrain, self.tick, dict(self.meta))

    def validate(self) -> None:
        """Raise InvalidStateError if any invariant is broken."""
        for name, arr in self.f.items():
            if not np.all(np.isfinite(arr)):
                raise InvalidStateError(f"{name} contains NaN/inf at tick {self.tick}")
        for name in NON_NEGATIVE:
            mn = float(self.f[name].min())
            if mn < -1e-9:
                raise InvalidStateError(f"{name} is negative ({mn}) at tick {self.tick}")
        if float(self.f["fire"].max()) > 1.0 + 1e-9:
            raise InvalidStateError("fire intensity above 1")
        if np.any(self.terrain > max(Terrain)):
            raise InvalidStateError("unknown terrain class")
        t = self.f["temperature"]
        if float(t.min()) < -90 or float(t.max()) > 70:
            raise InvalidStateError(f"temperature out of physical range [{t.min():.1f}, {t.max():.1f}]")

    def fingerprint(self) -> str:
        """Stable hash of the full state, used by reproducibility tests."""
        import hashlib

        h = hashlib.sha256()
        h.update(self.cfg.to_json().encode())
        h.update(str(self.tick).encode())
        for name in ALL_FLOAT_FIELDS:
            h.update(name.encode())
            h.update(np.ascontiguousarray(self.f[name]).tobytes())
        h.update(self.terrain.tobytes())
        import json as _json
        h.update(_json.dumps(self.meta, sort_keys=True).encode())
        return h.hexdigest()
