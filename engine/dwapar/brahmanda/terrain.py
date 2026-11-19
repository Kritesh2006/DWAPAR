"""Terrain classification — derived from environmental state, never painted.

Classification is a pure function of the current physical fields, so a
forest that burns becomes plains, a drying lake becomes plains/wetland,
and a cooling climate grows snowfields without special-case code.
"""

from __future__ import annotations

import numpy as np

from .world import Terrain

# Thresholds (documented in WORLD_LAWS.md)
LAKE_DEPTH_MM = 1500.0      # standing water deeper than 1.5 m on land
RIVER_FLUX_MM_H = 0.6      # sustained outflow ≈ top 2 % of land: draining ~25× the tile's own rainfall
WETLAND_WATER_MM = 80.0
WETLAND_SOIL = 0.85
SNOW_SWE_MM = 20.0
MOUNTAIN_M = 1900.0
HILL_M = 750.0
HILL_SLOPE = 0.08
DESERT_PRECIP_MM_DAY = 0.9
DESERT_SOIL = 0.22
FOREST_BIOMASS = 9.0


def classify(
    elevation: np.ndarray,
    slope: np.ndarray,
    surface_water: np.ndarray,
    soil_moisture: np.ndarray,
    flow_flux: np.ndarray,
    snow: np.ndarray,
    biomass: np.ndarray,
    precip_ema: np.ndarray,
) -> np.ndarray:
    t = np.full(elevation.shape, Terrain.PLAINS, dtype=np.uint8)
    land = elevation >= 0

    # Lowest priority first; later assignments override.
    desert = land & (precip_ema < DESERT_PRECIP_MM_DAY) & (soil_moisture < DESERT_SOIL) & (biomass < 2.0)
    t[desert] = Terrain.DESERT
    t[land & (biomass >= FOREST_BIOMASS)] = Terrain.FOREST
    t[land & ((elevation >= HILL_M) | (slope >= HILL_SLOPE)) & (biomass < FOREST_BIOMASS * 1.6)] = Terrain.HILLS
    t[land & (elevation >= MOUNTAIN_M)] = Terrain.MOUNTAINS
    wet = land & (elevation < HILL_M) & (slope < HILL_SLOPE) & (
        (surface_water >= WETLAND_WATER_MM) | (soil_moisture >= WETLAND_SOIL)
    )
    t[wet] = Terrain.WETLAND
    t[land & (snow >= SNOW_SWE_MM)] = Terrain.SNOW
    t[land & (flow_flux >= RIVER_FLUX_MM_H)] = Terrain.RIVER
    t[land & (surface_water >= LAKE_DEPTH_MM)] = Terrain.LAKE
    t[~land] = Terrain.OCEAN
    return t
