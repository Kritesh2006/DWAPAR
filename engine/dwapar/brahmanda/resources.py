"""Natural resources: measurable quantities at physical locations.

Renewable resources are *views* of physical state, so they regenerate only
when the physics allows it (wood = living biomass grows only with warmth,
water and fertile soil; freshwater is replenished only by precipitation).
Metal ores and coal are finite: nothing increases them and only ``extract``
reduces them. Stone, sand and clay are finite on human timescales but are
reworked by geology: erosion removes sand/clay, deposition of transported
sediment adds sand/clay, and eruptions add stone (lava) and clay (ash). Every
such change is counted in ``world.meta`` so the budget can be audited.
"""

from __future__ import annotations

import numpy as np

from .world import MINERAL_FIELDS, World

RENEWABLE = ("freshwater", "wood", "organic_matter")
NONRENEWABLE = MINERAL_FIELDS
NEVER_INCREASING = ("iron_ore", "copper_ore", "coal")
GEOLOGICAL = ("stone", "sand", "clay")
FINITE_RESERVOIR = ("saltwater",)  # practically unlimited but still measured
ALL_RESOURCES = ("freshwater", "saltwater", "wood", "stone", "sand", "clay", "iron_ore", "copper_ore", "coal",
                 "organic_matter")

UNITS = {
    "freshwater": "m³", "saltwater": "m³", "wood": "t", "organic_matter": "t",
    "stone": "t", "sand": "t", "clay": "t", "iron_ore": "t", "copper_ore": "t", "coal": "t",
}

WOODY_FRACTION = 0.5  # share of above-ground biomass that is usable wood


class ResourceError(ValueError):
    pass


def tile_area_m2(world: World) -> float:
    return world.cfg.tile_size_m ** 2


def resource_field(world: World, name: str) -> np.ndarray:
    """Per-tile quantity of a resource in its unit (see UNITS)."""
    f, area = world.f, tile_area_m2(world)
    land = ~world.is_ocean
    if name == "freshwater":
        mm = (f["surface_water"] + f["soil_water"] + f["snow"] + f["groundwater"] + f["ice"]) * land
        return mm / 1000.0 * area
    if name == "saltwater":
        return f["surface_water"] * world.is_ocean / 1000.0 * area
    if name == "wood":
        return f["biomass"] * WOODY_FRACTION * area / 1000.0
    if name == "organic_matter":
        return f["organic_matter"] * area / 1000.0
    if name in MINERAL_FIELDS:
        return f[name]
    raise ResourceError(f"unknown resource {name!r}")


def totals(world: World) -> dict[str, float]:
    return {name: float(resource_field(world, name).sum()) for name in ALL_RESOURCES}


def at_tile(world: World, y: int, x: int) -> dict[str, float]:
    return {name: float(resource_field(world, name)[y, x]) for name in ALL_RESOURCES}


def extract(world: World, name: str, y: int, x: int, amount: float) -> float:
    """Remove up to ``amount`` of a resource from tile (y, x). Returns what was actually removed.

    This is the single gateway future inhabitants (Phase 2+) will use. It can never
    remove more than exists, never accepts negative amounts, and never creates mass.
    """
    if not (0 <= y < world.cfg.height and 0 <= x < world.cfg.width):
        raise ResourceError("tile out of bounds")
    if not np.isfinite(amount) or amount < 0:
        raise ResourceError("amount must be a finite non-negative number")
    f, area = world.f, tile_area_m2(world)
    available = float(resource_field(world, name)[y, x])
    take = min(amount, available)
    if take <= 0:
        return 0.0
    if name in MINERAL_FIELDS:
        f[name][y, x] = max(f[name][y, x] - take, 0.0)
    elif name == "wood":
        f["biomass"][y, x] = max(f["biomass"][y, x] - take * 1000.0 / area / WOODY_FRACTION, 0.0)
    elif name == "organic_matter":
        f["organic_matter"][y, x] = max(f["organic_matter"][y, x] - take * 1000.0 / area, 0.0)
    elif name in ("freshwater", "saltwater"):
        mm = take / area * 1000.0
        order = ("surface_water",) if name == "saltwater" else ("surface_water", "soil_water", "snow", "groundwater", "ice")
        for store in order:
            d = min(mm, f[store][y, x])
            f[store][y, x] -= d
            mm -= d
            if mm <= 0:
                break
    else:
        raise ResourceError(f"unknown resource {name!r}")
    return take
