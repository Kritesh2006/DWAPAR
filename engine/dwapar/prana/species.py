"""Species of animals. Parameters are rough real-world magnitudes, documented in WORLD_LAWS.md § Life.

Units: mass kg; speeds km per hour of movement; perception km; ages and intervals in years
(360-day years); intake as a fraction of body mass per day (dry plant matter or meat).

Insects are far too numerous to simulate one by one, so an "insect" agent is a *colony*
(one agent stands for many individuals). This is stated wherever insects are shown.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Species:
    name: str
    diet: str                 # "plants" or "meat"
    mass_kg: float
    walk_kmh: float           # foraging / travelling speed
    run_kmh: float            # escape or chase speed (sustained for part of an hour)
    perception_km: float
    max_age_y: float
    maturity_y: float
    birth_interval_y: float
    litter: int
    intake_frac_day: float    # food per day as a fraction of body mass
    prey: tuple[str, ...] = ()
    territory_km: float = 0.0  # >0: avoids others of its kind inside this radius
    group: bool = False        # stays near others of its kind
    habitat: str = "land"
    min_temp_c: float = -30.0
    max_temp_c: float = 45.0
    colony: bool = False       # one agent = a colony of many individuals
    danger_to_humans: float = 0.0  # relative risk of a starving individual attacking a human
    max_density_km2: float = 10.0  # breeding stops where kin are this dense nearby (food/space competition)


SPECIES: dict[str, Species] = {
    s.name: s for s in (
        Species("insect", "plants", 0.5, 0.3, 0.5, 0.2, 3.0, 0.2, 0.25, 2, 0.5, colony=True,
                min_temp_c=0.0, max_temp_c=45.0, max_density_km2=0.3),
        Species("rabbit", "plants", 2.0, 1.0, 6.0, 0.4, 7.0, 0.4, 0.3, 4, 0.06, min_temp_c=-25.0, max_density_km2=15.0),
        Species("deer", "plants", 80.0, 2.0, 12.0, 0.9, 16.0, 1.5, 1.0, 1, 0.025, group=True, max_density_km2=12.0),
        Species("bison", "plants", 600.0, 2.0, 9.0, 0.8, 22.0, 3.0, 1.5, 1, 0.02, group=True,
                min_temp_c=-35.0, max_density_km2=3.0),
        Species("wolf", "meat", 40.0, 4.0, 10.0, 1.5, 12.0, 2.0, 1.0, 4, 0.06, prey=("rabbit", "deer"),
                group=True, min_temp_c=-40.0, danger_to_humans=0.01, max_density_km2=0.12),
        Species("tiger", "meat", 200.0, 3.0, 9.0, 1.2, 18.0, 3.5, 2.0, 2, 0.04, prey=("deer", "bison", "human"),
                territory_km=6.0, min_temp_c=-30.0, danger_to_humans=0.15, max_density_km2=0.04),
    )
}


def describe_species() -> list[dict]:
    return [dict(s.__dict__) for s in SPECIES.values()]
