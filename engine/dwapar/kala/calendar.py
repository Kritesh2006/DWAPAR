"""Kala — the simulated calendar.

Time in DWAPAR is a single integer: the tick counter. Everything else
(hour, day, season, year) is derived from it, so time can never become
internally inconsistent and a checkpoint only needs to store the tick.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import WorldConfig

SEASONS = ("spring", "summer", "autumn", "winter")  # northern-hemisphere naming


@dataclass(frozen=True)
class Calendar:
    tick: int
    hour: float
    day_of_year: int  # 0-based
    day_total: int  # days since world creation
    season_index: int
    season: str
    year: int  # 0-based
    is_day_start: bool
    is_year_start: bool
    is_season_start: bool

    @classmethod
    def at(cls, tick: int, cfg: WorldConfig) -> "Calendar":
        if tick < 0:
            raise ValueError("tick must be non-negative")
        tpd = cfg.ticks_per_day
        day_total, sub = divmod(tick, tpd)
        year, doy = divmod(day_total, cfg.days_per_year)
        season_index = doy // cfg.days_per_season
        return cls(
            tick=tick,
            hour=sub * cfg.hours_per_tick,
            day_of_year=doy,
            day_total=day_total,
            season_index=season_index,
            season=SEASONS[season_index],
            year=year,
            is_day_start=sub == 0,
            is_year_start=sub == 0 and doy == 0,
            is_season_start=sub == 0 and doy % cfg.days_per_season == 0,
        )

    def label(self) -> str:
        return f"Year {self.year + 1}, Day {self.day_of_year + 1} ({self.season}), {int(self.hour):02d}:00"

    def to_dict(self) -> dict:
        return {
            "tick": self.tick,
            "hour": self.hour,
            "day_of_year": self.day_of_year,
            "day_total": self.day_total,
            "season": self.season,
            "year": self.year,
            "label": self.label(),
        }
