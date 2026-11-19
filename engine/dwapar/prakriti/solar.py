"""Solar geometry: day/night and seasons emerge from Earth-like orbital geometry.

Simplifications: circular orbit, fixed 23.44° axial tilt, no atmosphere
attenuation beyond the cos(zenith) factor. Insolation is returned
normalised to the solar constant (1.0 = sun directly overhead).
"""

from __future__ import annotations

import numpy as np

TILT = np.deg2rad(23.44)


def declination(day_of_year: float, days_per_year: int) -> float:
    # Day 0 = spring equinox (start of "spring" season).
    return TILT * np.sin(2 * np.pi * day_of_year / days_per_year)


def cos_zenith(lat_rad: np.ndarray, day_of_year: float, hour: float, days_per_year: int) -> np.ndarray:
    d = declination(day_of_year, days_per_year)
    h = np.deg2rad(15.0 * (hour - 12.0))
    return np.sin(lat_rad) * np.sin(d) + np.cos(lat_rad) * np.cos(d) * np.cos(h)


def instantaneous_insolation(lat_rad, day_of_year, hour, days_per_year) -> np.ndarray:
    return np.maximum(cos_zenith(lat_rad, day_of_year, hour, days_per_year), 0.0)


def daily_mean_insolation(lat_rad: np.ndarray, day_of_year: float, days_per_year: int) -> np.ndarray:
    """Analytic 24 h mean of max(cos z, 0) (Berger 1978 form)."""
    d = declination(day_of_year, days_per_year)
    x = np.clip(-np.tan(lat_rad) * np.tan(d), -1.0, 1.0)
    h0 = np.arccos(x)  # sunset hour angle (0 = polar night, pi = midnight sun)
    return (h0 * np.sin(lat_rad) * np.sin(d) + np.cos(lat_rad) * np.cos(d) * np.sin(h0)) / np.pi


def annual_mean_insolation(lat_rad: np.ndarray, days_per_year: int, samples: int = 24) -> np.ndarray:
    days = np.linspace(0, days_per_year, samples, endpoint=False)
    return np.mean([daily_mean_insolation(lat_rad, d, days_per_year) for d in days], axis=0)


LAPSE_RATE = 0.0065  # °C per metre


def seasonal_temperature(lat_rad, day_of_year, days_per_year, elevation_m, ocean_mask) -> np.ndarray:
    """Equilibrium daily-mean temperature for a tile on a given day (°C).

    Built as annual mean + seasonal anomaly; the anomaly is damped over oceans
    (thermal inertia) and lagged ~1/8 year behind insolation as on Earth."""
    q_ann = annual_mean_insolation(lat_rad, days_per_year)
    lag = days_per_year / 8.0
    q_day = daily_mean_insolation(lat_rad, day_of_year - lag, days_per_year)
    t_ann = -38.0 + 210.0 * q_ann
    amp = np.where(ocean_mask, 45.0, 95.0)
    t = t_ann + amp * (q_day - q_ann)
    return t - LAPSE_RATE * np.maximum(elevation_m, 0.0)


def saturation_capacity_mm(temp_c: np.ndarray) -> np.ndarray:
    """Max precipitable water (mm) an air column holds at a surface temperature.

    Clausius–Clapeyron-like ~6.5 %/°C scaling, 24 mm at 15 °C."""
    return 24.0 * np.exp(0.065 * (np.clip(temp_c, -60, 60) - 15.0))
