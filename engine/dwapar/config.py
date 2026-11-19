"""World configuration. Every field participates in deterministic generation."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields


class ConfigError(ValueError):
    """Raised when a configuration would produce an invalid world."""


@dataclass(frozen=True)
class WorldConfig:
    seed: int = 42
    width: int = 128
    height: int = 128
    #: Real-world edge length one tile represents (metres). 128 tiles * 2 km ≈ a
    #: 256 km continent fragment. Affects slopes and water routing.
    tile_size_m: float = 2000.0
    #: Fraction of the map that should end up below sea level.
    ocean_fraction: float = 0.38
    #: Latitude of the top and bottom map edges (degrees, + = north).
    lat_top: float = 48.0
    lat_bottom: float = -12.0
    #: Peak elevation scale (m). Mountains reach roughly this height.
    max_elevation_m: float = 4200.0
    #: Deepest ocean (m, positive number).
    max_depth_m: float = 3500.0
    #: Simulated hours per engine tick. 1 hour keeps the day/night cycle resolvable.
    hours_per_tick: int = 1
    #: Calendar: days per season; 4 seasons per year.
    days_per_season: int = 90
    #: Automatic checkpoint interval in simulated days (0 disables).
    checkpoint_every_days: int = 5
    #: How many automatic checkpoints to retain per world.
    checkpoint_retain: int = 12
    #: Prevailing wind direction (degrees, direction wind blows TOWARD; 90 = east).
    wind_dir_deg: float = 80.0
    wind_speed_tiles_per_hour: float = 0.35
    #: Pre-history spin-up: simulated days sampled in each season before tick 0 (0 disables).
    spinup_days_per_season: int = 6

    extra: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        if not isinstance(self.seed, int) or isinstance(self.seed, bool):
            raise ConfigError("seed must be an integer")
        if not (0 <= self.seed < 2**63):
            raise ConfigError("seed must be in [0, 2^63)")
        for name in ("width", "height"):
            v = getattr(self, name)
            if not isinstance(v, int) or v < 16 or v > 4096:
                raise ConfigError(f"{name} must be an int in [16, 4096], got {v!r}")
        if not (0.05 <= self.ocean_fraction <= 0.9):
            raise ConfigError("ocean_fraction must be in [0.05, 0.9]")
        if not (-90 <= self.lat_bottom < self.lat_top <= 90):
            raise ConfigError("latitudes must satisfy -90 <= lat_bottom < lat_top <= 90")
        if self.hours_per_tick not in (1, 2, 3, 4, 6):
            raise ConfigError("hours_per_tick must divide 24 and be <= 6")
        if self.days_per_season < 1:
            raise ConfigError("days_per_season must be >= 1")
        if self.tile_size_m <= 0 or self.max_elevation_m <= 0 or self.max_depth_m <= 0:
            raise ConfigError("physical scales must be positive")
        if self.checkpoint_every_days < 0 or self.checkpoint_retain < 1:
            raise ConfigError("invalid checkpoint settings")
        if not (0 <= self.spinup_days_per_season <= 90):
            raise ConfigError("spinup_days_per_season must be in [0, 90]")
        if not (0 <= self.wind_speed_tiles_per_hour <= 1.0):
            raise ConfigError("wind speed must be in [0, 1] tiles/hour (CFL stability)")

    # --- derived calendar -------------------------------------------------
    @property
    def ticks_per_day(self) -> int:
        return 24 // self.hours_per_tick

    @property
    def days_per_year(self) -> int:
        return self.days_per_season * 4

    # --- serialisation ----------------------------------------------------
    def to_dict(self) -> dict:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True)

    @classmethod
    def from_dict(cls, d: dict) -> "WorldConfig":
        known = {f.name for f in fields(cls)}
        unknown = set(d) - known
        if unknown:
            raise ConfigError(f"unknown config keys: {sorted(unknown)}")
        return cls(**d)
