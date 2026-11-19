"""Prakriti — coupled natural processes.

Every process reads and writes the shared World fields, so effects propagate:

    insolation → air & ocean temperature → (winds, currents carry heat) → evaporation
    → humidity (winds carry it) → precipitation / snow → infiltration → soil → aquifer
    → springs & rivers (multiple-flow routing) → erosion → sediment → deposition
    → sand/clay deposits & landforms;  soil moisture → vegetation → fuel → fire
    → organic matter → fertility;  plate motion → uplift, earthquakes, volcanoes
    → new rock, ash, fires, heat.

Conservation (checked by tests):
  * water moves only between surface/ocean, soil, groundwater, atmosphere and snow;
  * rock mass (elevation × area × density + loose sediment) changes only through the
    tectonic and volcanic source terms, which are counted in ``world.meta``;
  * sand+clay deposits change only by erosion/deposition/ash (counted); stone only by lava.
All formulae are simplified parameterisations; see WORLD_LAWS.md.
"""

from __future__ import annotations

import numpy as np

from ..brahmanda.noise import value_noise
from ..brahmanda.terrain import classify
from ..brahmanda.world import ROCK_DENSITY_T_M3, World
from ..grid import (
    NEIGHBOURS,
    advect_masked,
    advect_periodic,
    mfd_flow,
    move_along,
    neighbour,
    neighbour_mean,
    steepest_descent,
)
from ..kala.calendar import Calendar
from ..rng import generator
from .solar import (
    LAPSE_RATE,
    annual_mean_insolation,
    daily_mean_insolation,
    instantaneous_insolation,
    saturation_capacity_mm,
)

# ---- tunable constants (all documented in WORLD_LAWS.md) ----------------
TAU_LAND_H = 3.0          # air temperature relaxation over land (hours)
TAU_AIR_OCEAN_H = 12.0    # air over water relaxes toward the ocean surface temperature
TAU_SST_DAYS = 25.0       # ocean mixed layer relaxation toward radiative equilibrium
OCEAN_HEAT_DIFFUSION = 0.08   # per hour, eddy mixing between ocean tiles
AIR_HEAT_DIFFUSION = 0.03
DIURNAL_LAND_C = 16.0
DIURNAL_WATER_C = 3.0
INFILTRATION_MM_H = 8.0
SOIL_OVERFLOW = 0.95       # soil above this fraction of capacity spills to surface
PERCOLATION_H = 0.01       # fraction of soil water above 50 % capacity percolating per hour
SPRING_H = 0.0002          # fraction of groundwater discharging to the surface per hour (~200-day e-folding)
CAPILLARY_H = 0.0008
AQUIFER_POROSITY = 0.2
GW_LATERAL_FRACTION = 0.2  # per day, of the water-table head difference
FLOW_FRACTION = 0.45
MFD_EXPONENT = 4.0
PRECIP_EFFICIENCY = 0.5
SNOW_THRESHOLD_C = 0.5
MELT_MM_PER_DEG_H = 0.2
FLUX_EMA_H = 72.0
LIGHTNING_P_H = 3.0e-6
SPREAD_P_H = 0.12
VEG_GROWTH_DAY = 0.035
VEG_MORTALITY_DAY = 0.0006
DECOMP_DAY = 0.0015
EROSION_K = 1.0e-4         # transport capacity coefficient (m/day per √(mm/h) per unit slope)
DEPOSITION_FRACTION = 0.5
TALUS_SLOPE = 0.25
THERMAL_K = 2.0e-5
COAST_MIN_M = 0.5
QUAKE_LOAD_YEARS = 30.0    # years for a fully active boundary to load to failure
VOLCANO_RECURRENCE_YEARS = 60.0


def _veg_factors(temp_c: np.ndarray, soil_moisture: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    f_t = np.clip(temp_c / 12.0, 0, 1) * np.clip((42.0 - temp_c) / 10.0, 0, 1)
    f_w = np.clip((soil_moisture - 0.08) / 0.4, 0, 1)
    return f_t, f_w


def carrying_capacity(fertility: np.ndarray, precip_ema: np.ndarray) -> np.ndarray:
    return 28.0 * (0.3 + 0.7 * fertility) * np.clip(precip_ema / 3.0, 0.05, 1.0)


class Prakriti:
    """Holds caches derived purely from config/static fields and advances a World."""

    def __init__(self, world: World):
        cfg = world.cfg
        self.cfg = cfg
        self.lat_rad = np.deg2rad(world.f["latitude"])
        self.q_ann = annual_mean_insolation(self.lat_rad, cfg.days_per_year)
        lat_row = world.f["latitude"][:, :1]
        base = cfg.wind_speed_tiles_per_hour * cfg.hours_per_tick
        blend = np.tanh((np.abs(lat_row) - 25.0) / 6.0)  # -1 deep tropics .. +1 mid-latitudes
        self.wind_u = base * np.where(blend < 0, 0.8 * blend, blend)  # tiles per tick, +x = east
        self.wind_v = np.full_like(self.wind_u, 0.15 * base * np.sign(-np.sin(np.deg2rad(cfg.wind_dir_deg - 90))))
        self._weather_cache: dict[int, np.ndarray] = {}
        self.tile_area = cfg.tile_size_m ** 2
        self.last_precip = np.zeros(world.shape)   # visual/diagnostic only (not state)
        self.last_insolation = np.zeros(world.shape)

    # ------------------------------------------------------------------ utils
    def weather(self, day_total: int) -> np.ndarray:
        """Synoptic weather pattern for a day: smooth noise in [0,1]."""
        if day_total not in self._weather_cache:
            if len(self._weather_cache) > 8:
                self._weather_cache.clear()
            rng = generator(self.cfg.seed, "weather", day_total)
            self._weather_cache[day_total] = value_noise(self.cfg.width, self.cfg.height, 18.0, rng)
        return self._weather_cache[day_total]

    def weather_now(self, cal: Calendar) -> np.ndarray:
        a = self.weather(cal.day_total)
        b = self.weather(cal.day_total + 1)
        f = cal.hour / 24.0
        return a * (1 - f) + b * f

    def seasonal_equilibrium(self, w: World, doy: float, ocean: np.ndarray) -> np.ndarray:
        lag = self.cfg.days_per_year / 8.0
        q_day = daily_mean_insolation(self.lat_rad, doy - lag, self.cfg.days_per_year)
        t_ann = -38.0 + 210.0 * self.q_ann
        amp = np.where(ocean, 45.0, 95.0)
        return t_ann + amp * (q_day - self.q_ann) - LAPSE_RATE * np.maximum(w.f["elevation"], 0.0)

    def annual_mean_temperature(self, w: World) -> np.ndarray:
        return -38.0 + 210.0 * self.q_ann - LAPSE_RATE * np.maximum(w.f["elevation"], 0.0)

    def fire_risk(self, w: World) -> np.ndarray:
        """0..1 probability-like index: dry fuel, heat, and time since rain."""
        sm = w.soil_moisture
        dryness = np.clip(1.0 - sm / 0.35, 0, 1)
        drought = np.sqrt(np.clip(w.f["drought_days"] / 12.0, 0, 1))
        heat = np.clip((w.f["temperature"] - 5.0) / 25.0, 0, 1)
        fuel = np.clip(w.f["biomass"] / 5.0, 0, 1)
        wet_surface = w.f["surface_water"] > 50.0
        return np.where(w.is_ocean | wet_surface | (w.f["snow"] > 5), 0.0, dryness * drought * heat * fuel)

    def cloud_cover(self, w: World) -> np.ndarray:
        """Diagnostic 0..1 cloudiness from relative humidity (used by the dashboard)."""
        rh = w.f["atmo_water"] / saturation_capacity_mm(w.f["temperature"])
        return np.clip((rh - 0.6) / 0.4, 0, 1)

    # ================================================================ hourly
    def step_hour(self, w: World, cal: Calendar, events: list[dict]) -> dict:
        cfg, f = self.cfg, w.f
        dt = float(cfg.hours_per_tick)
        ocean = w.is_ocean
        land = ~ocean
        open_water = ocean | (f["surface_water"] > 300.0)
        weather = self.weather_now(cal)

        # 1. Radiation, ocean mixed layer, heat transport, air temperature --------
        doy = cal.day_of_year + cal.hour / 24.0
        insol = instantaneous_insolation(self.lat_rad, doy, cal.hour, cfg.days_per_year)
        self.last_insolation = insol
        q_today = daily_mean_insolation(self.lat_rad, doy, cfg.days_per_year)
        t_season = self.seasonal_equilibrium(w, doy, ocean)

        # Ocean: relax toward radiative equilibrium, exchange with air, carried by currents.
        sst = f["sst"]
        sst += (t_season - sst) * (dt / (24.0 * TAU_SST_DAYS)) + (f["temperature"] - sst) * (dt / 24.0 / 40.0)
        u_c = f["current_u"] * dt
        v_c = f["current_v"] * dt
        f["sst"] = np.where(ocean, advect_masked(sst, u_c, v_c, ocean, OCEAN_HEAT_DIFFUSION * dt), t_season)

        # Air: winds carry heat (periodic upwind advection + mixing), then relax to the surface.
        t_air = advect_periodic(f["temperature"], self.wind_u, self.wind_v)
        lap = (np.roll(t_air, 1, 0) + np.roll(t_air, -1, 0) + np.roll(t_air, 1, 1) + np.roll(t_air, -1, 1)
               - 4 * t_air)
        t_air = t_air + AIR_HEAT_DIFFUSION * dt * lap
        sm = w.soil_moisture
        diurnal = np.where(open_water, DIURNAL_WATER_C, DIURNAL_LAND_C * (1.0 - 0.5 * sm))
        surface_t = np.where(ocean, f["sst"], t_season)
        t_eq = surface_t + diurnal * (insol - q_today) * 2.0
        t_eq += (weather - 0.5) * 6.0
        t_eq -= np.where(f["snow"] > 20.0, 3.0, 0.0)  # snow albedo
        t_eq += 12.0 * f["fire"] + 25.0 * f["lava"]
        tau = np.where(open_water, TAU_AIR_OCEAN_H, TAU_LAND_H)
        f["temperature"] = t_air + (t_eq - t_air) * (1.0 - np.exp(-dt / tau))
        f["temp_day"] += (f["temperature"] - f["temp_day"]) * (dt / 24.0)
        f["temp_ema"] += (f["temperature"] - f["temp_ema"]) * (dt / (24.0 * cfg.days_per_season))
        temp = f["temperature"]

        # 2. Evaporation & transpiration --------------------------------------
        cap = saturation_capacity_mm(temp)
        rh = np.clip(f["atmo_water"] / cap, 0.0, 1.0)
        pet = 0.35 * (0.2 + insol) * np.exp(0.05 * (np.clip(temp, -20, 45) - 15.0)) * (1.0 - rh) * dt
        pet = np.where(temp < -5.0, pet * 0.1, pet)
        e_water = np.minimum(f["surface_water"], pet)
        f["surface_water"] -= e_water
        rem = pet - e_water
        e_soil = np.where(land, np.minimum(f["soil_water"], rem * 0.4 * sm), 0.0)
        f["soil_water"] -= e_soil
        e_veg = np.where(land, np.minimum(f["soil_water"], rem * 0.6 * sm * np.clip(f["biomass"] / 12.0, 0, 1)), 0.0)
        f["soil_water"] -= e_veg
        evap_total = e_water + e_soil + e_veg
        f["atmo_water"] += evap_total

        # 3. Atmospheric moisture transport ------------------------------------
        a = advect_periodic(f["atmo_water"], self.wind_u, self.wind_v)
        lap = np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1) - 4 * a
        f["atmo_water"] = a + 0.04 * dt * lap

        # 4. Precipitation -----------------------------------------------------
        cap_eff = cap * (0.78 + 0.42 * weather)
        excess = f["atmo_water"] - cap_eff
        precip = np.where(excess > 0, excess * min(1.0, PRECIP_EFFICIENCY * dt), 0.0)
        precip = np.minimum(precip, f["atmo_water"])
        f["atmo_water"] -= precip
        as_snow = (temp < SNOW_THRESHOLD_C) & land
        f["snow"] += np.where(as_snow, precip, 0.0)
        f["surface_water"] += np.where(as_snow, 0.0, precip)
        f["precip_today"] += precip
        self.last_precip = precip

        # 5. Snowmelt ----------------------------------------------------------
        melt = np.where(temp > 0, np.minimum(f["snow"], MELT_MM_PER_DEG_H * temp * dt), 0.0)
        f["snow"] -= melt
        f["surface_water"] += melt

        # 6. Soil & groundwater (land only) ------------------------------------
        fc = f["field_capacity"]
        room = np.maximum(fc - f["soil_water"], 0.0)
        inf = np.where(land, np.minimum(np.minimum(f["surface_water"], INFILTRATION_MM_H * dt), room), 0.0)
        f["surface_water"] -= inf
        f["soil_water"] += inf
        spill = np.where(land, np.maximum(f["soil_water"] - SOIL_OVERFLOW * fc, 0.0), 0.0)
        f["soil_water"] -= spill
        f["surface_water"] += spill
        gw, gcap = f["groundwater"], f["aquifer_capacity"]
        perc = np.where(land, np.minimum(np.maximum(f["soil_water"] - 0.5 * fc, 0.0) * min(1.0, PERCOLATION_H * dt),
                                         np.maximum(gcap - gw, 0.0)), 0.0)
        f["soil_water"] -= perc
        gw += perc
        rise = np.where(land, np.minimum(gw * CAPILLARY_H * dt * (1.0 - sm),
                                         np.maximum(0.5 * fc - f["soil_water"], 0.0)), 0.0)
        gw -= rise
        f["soil_water"] += rise
        springs = np.where(land, gw * min(1.0, SPRING_H * dt) + np.maximum(gw - gcap, 0.0), gw)  # ocean: all out
        gw -= springs
        f["surface_water"] += springs
        f["groundwater"] = np.maximum(gw, 0.0)

        # 7. Surface flow: multiple-flow-direction routing on the water surface -----
        hsurf = f["elevation"] + f["surface_water"] / 1000.0
        delta, out = mfd_flow(hsurf, f["surface_water"], FLOW_FRACTION, 1000.0, cfg.tile_size_m, MFD_EXPONENT)
        f["surface_water"] = np.maximum(f["surface_water"] + delta, 0.0)  # clamp -0.0 rounding only
        alpha = min(1.0, dt / FLUX_EMA_H)
        f["flow_flux"] += (np.where(land, out / dt, 0.0) - f["flow_flux"]) * alpha

        # 8. Fire --------------------------------------------------------------
        burned_now = self._fire(w, cal, events, precip, dt)
        return {"precip": float(precip.sum()), "evap": float(evap_total.sum()), "burned": burned_now}

    def _fire(self, w: World, cal: Calendar, events: list[dict], precip: np.ndarray, dt: float) -> int:
        f = w.f
        rng = generator(self.cfg.seed, "fire", cal.tick)
        risk = self.fire_risk(w)
        burning = f["fire"] > 0
        was_burning = int(burning.sum())
        storm = np.clip(f["atmo_water"] / saturation_capacity_mm(f["temperature"]), 0, 1)
        p_ign = LIGHTNING_P_H * dt * risk * (0.3 + storm)
        ignite = (rng.random(risk.shape) < p_ign) & ~burning
        spread_p = np.zeros_like(risk)
        for dy, dx, dist in NEIGHBOURS:
            src = neighbour(f["fire"], -dy, -dx, 0.0)
            wind_bonus = 1.0 + 0.6 * np.sign(dx) * np.sign(self.wind_u)
            spread_p = 1 - (1 - spread_p) * (1 - np.clip(SPREAD_P_H * dt * src * wind_bonus / dist, 0, 1))
        spread = (rng.random(risk.shape) < spread_p * risk * 3.0) & ~burning
        new = ignite | spread
        for y, x in zip(*np.nonzero(ignite)):
            events.append({"tick": cal.tick, "kind": "fire_ignition", "x": int(x), "y": int(y),
                           "message": f"Lightning ignited a fire at ({x}, {y}); risk {risk[y, x]:.2f}"})
        f["fire"] = np.where(new, 0.25, f["fire"])
        burning = f["fire"] > 0
        fuel_factor = np.clip(f["biomass"] / 6.0, 0, 1) * np.clip(risk * 2.0 + 0.2, 0, 1)
        f["fire"] = np.where(burning, np.clip(f["fire"] + 0.3 * dt * (fuel_factor - f["fire"]), 0, 1), 0.0)
        consumed = np.where(burning, np.minimum(f["biomass"], (0.08 * f["biomass"] + 0.05) * f["fire"] * dt), 0.0)
        f["biomass"] -= consumed
        f["organic_matter"] += 0.15 * consumed
        out = burning & ((precip > 0.3) | (f["biomass"] < 0.2) | (w.soil_moisture > 0.6) | (f["fire"] < 0.03))
        f["fire"] = np.where(out, 0.0, f["fire"])
        now = int((f["fire"] > 0).sum())
        meta = w.meta
        meta["burned_tile_hours"] = meta.get("burned_tile_hours", 0) + now
        meta["fire_ignitions"] = meta.get("fire_ignitions", 0) + int(ignite.sum())
        if now == 0 and was_burning > 0:
            events.append({"tick": cal.tick, "kind": "fires_out", "x": None, "y": None,
                           "message": "All active fires have been extinguished"})
        if now >= 40 and was_burning < 40:
            ys, xs = np.nonzero(f["fire"] > 0)
            events.append({"tick": cal.tick, "kind": "major_fire", "x": int(np.median(xs)), "y": int(np.median(ys)),
                           "message": f"Major wildfire: {now} tiles burning"})
        return now

    # ================================================================= daily
    def step_day(self, w: World, cal: Calendar, events: list[dict]) -> None:
        f = w.f
        ocean = w.is_ocean
        land = ~ocean
        rain_day = f["precip_today"]
        f["drought_days"] = np.where(rain_day > 1.0, 0.0, f["drought_days"] + 1.0)
        f["precip_ema"] += (rain_day - f["precip_ema"]) / self.cfg.days_per_season
        f["precip_today"][:] = 0.0

        self._vegetation(w, f["temp_day"], ocean)
        self._groundwater_lateral(w, ocean)
        self._sediment(w, land)
        self._tectonics(w, cal, events)
        self._volcanism(w, cal, events)
        f["lava"] *= 0.97  # lava fields cool over weeks–months
        f["lava"][f["lava"] < 1e-3] = 0.0

        self.reclassify(w)
        self._disaster_watch(w, cal, events, land)
        if cal.is_year_start and cal.year > 0:
            events.append({"tick": cal.tick, "kind": "year", "x": None, "y": None,
                           "message": f"Year {cal.year + 1} begins"})
        if cal.is_season_start:
            events.append({"tick": cal.tick, "kind": "season", "x": None, "y": None,
                           "message": f"{cal.season.capitalize()} begins (northern hemisphere)"})

    def _vegetation(self, w: World, t: np.ndarray, ocean: np.ndarray) -> None:
        f = w.f
        land = ~ocean
        sm = w.soil_moisture
        f_t, f_w = _veg_factors(t, sm)
        k = carrying_capacity(w.fertility, f["precip_ema"])
        flooded = f["surface_water"] > 600.0
        b = f["biomass"]
        growth = VEG_GROWTH_DAY * b * (1.0 - b / np.maximum(k, 1e-6)) * f_t * f_w
        growth = np.maximum(growth, -0.02 * b)
        seed_src = neighbour_mean(b)
        colon = f_t * f_w * (0.002 + 0.01 * np.clip(seed_src / 5.0, 0, 1))
        mort = VEG_MORTALITY_DAY * b
        mort += np.where(sm < 0.06, 0.01 * b, 0.0)
        mort += np.where(t < -8.0, 0.003 * b, 0.0)
        mort += np.where(flooded, 0.05 * b, 0.0)
        mort += np.where(f["lava"] > 0.2, 0.5 * b, 0.0)
        active = land & ~flooded & (f["lava"] < 0.2)
        gain = np.where(active, np.maximum(growth, 0.0) + colon, 0.0)
        loss = np.minimum(b, mort + np.where(active, np.maximum(-growth, 0.0), 0.0))
        f["biomass"] = np.where(ocean, 0.0, b + gain - loss)
        f["organic_matter"] += np.where(ocean, 0.0, loss)
        f["organic_matter"] *= 1.0 - DECOMP_DAY * f_t * (0.3 + 0.7 * f_w)
        f["organic_matter"] = np.where(ocean, 0.0, f["organic_matter"])

    def _groundwater_lateral(self, w: World, ocean: np.ndarray) -> None:
        """Aquifer water flows down the water-table gradient; discharge into the sea becomes ocean water."""
        f = w.f
        head = f["elevation"] + f["groundwater"] / 1000.0 / AQUIFER_POROSITY
        delta, _ = mfd_flow(head, f["groundwater"] * 0.5, GW_LATERAL_FRACTION, 1000.0 * AQUIFER_POROSITY,
                            self.cfg.tile_size_m, 1.0)
        gw = np.maximum(f["groundwater"] + delta, 0.0)
        f["surface_water"] += np.where(ocean, gw, 0.0)  # submarine groundwater discharge
        f["groundwater"] = np.where(ocean, 0.0, gw)

    def _take_surface_deposits(self, w: World, mass_t: np.ndarray) -> np.ndarray:
        """Remove eroded mass from the sand, then clay, deposits of each tile (bedrock below is not a
        resource). Returns the deposit mass removed (for the resource budget)."""
        f = w.f
        from_sand = np.minimum(f["sand"], mass_t)
        f["sand"] -= from_sand
        from_clay = np.minimum(f["clay"], mass_t - from_sand)
        f["clay"] -= from_clay
        return from_sand + from_clay

    def _sediment(self, w: World, land: np.ndarray) -> None:
        """Detachment-limited erosion, transport and deposition of sediment (mass-conserving)."""
        f, meta = w.f, w.meta
        rho_a = self.tile_area * ROCK_DENSITY_T_M3  # tonnes per metre of elevation on one tile
        elev = f["elevation"]
        direction, drop, slope = steepest_descent(elev, self.cfg.tile_size_m)
        cover = np.clip(f["biomass"] / 10.0, 0, 1)
        capacity_t = EROSION_K * np.sqrt(np.maximum(f["flow_flux"], 0)) * slope * (1.0 - 0.8 * cover) * rho_a
        still = (~land) | (f["surface_water"] > 1500.0)  # sea and lakes trap everything
        capacity_t = np.where(still, 0.0, capacity_t)
        sed = f["sediment"]

        # Erosion where the flow can carry more than it holds.
        deficit = np.where(land & (direction >= 0), np.maximum(capacity_t - sed, 0.0), 0.0)
        max_dz = np.minimum(0.25 * drop, np.maximum(elev - COAST_MIN_M, 0.0))
        thermal_dz = np.where(land & (slope > TALUS_SLOPE),
                              THERMAL_K * (slope - TALUS_SLOPE) * self.cfg.tile_size_m, 0.0)
        erode_dz = np.minimum(deficit / rho_a + thermal_dz, max_dz)
        erode_t = erode_dz * rho_a
        meta["sediment_eroded_t"] = meta.get("sediment_eroded_t", 0.0) + float(erode_t.sum())
        meta["deposits_eroded_t"] = meta.get("deposits_eroded_t", 0.0) + float(
            self._take_surface_deposits(w, erode_t).sum())
        elev = elev - erode_dz
        sed = sed + erode_t

        # Deposition where load exceeds capacity (all of it in still water).
        excess = np.maximum(sed - capacity_t, 0.0)
        dep_t = np.where(still, sed, DEPOSITION_FRACTION * excess)
        sed = sed - dep_t
        elev = elev + dep_t / rho_a
        f["sand"] += 0.6 * dep_t
        f["clay"] += 0.4 * dep_t
        meta["sediment_deposited_t"] = meta.get("sediment_deposited_t", 0.0) + float(dep_t.sum())

        # Transport: remaining load moves one tile downstream per day along the water surface.
        hsurf = elev + f["surface_water"] / 1000.0
        sdir, _, _ = steepest_descent(hsurf, self.cfg.tile_size_m)
        moving = np.where(sdir >= 0, sed, 0.0)
        f["sediment"] = np.maximum(sed + move_along(moving, sdir), 0.0)
        f["elevation"] = elev

    def _tectonics(self, w: World, cal: Calendar, events: list[dict]) -> None:
        f, meta = w.f, w.meta
        dpy = self.cfg.days_per_year
        rho_a = self.tile_area * ROCK_DENSITY_T_M3
        dz = f["uplift_rate"] / dpy
        f["elevation"] += dz
        meta["tectonic_rock_t"] = meta.get("tectonic_rock_t", 0.0) + float(dz.sum() * rho_a)

        # Elastic strain loads at active boundaries and is released in earthquakes.
        f["tectonic_stress"] += f["stress_rate"] / (QUAKE_LOAD_YEARS * dpy)
        critical = f["tectonic_stress"] >= 1.0
        if not critical.any():
            return
        rng = generator(self.cfg.seed, "earthquake", cal.day_total)
        if rng.random() > 0.25:  # failure timing is stochastic once critical
            return
        y, x = np.unravel_index(np.argmax(np.where(critical, f["tectonic_stress"], -1)), critical.shape)
        h, wd = critical.shape
        y0, y1, x0, x1 = max(0, y - 5), min(h, y + 6), max(0, x - 5), min(wd, x + 6)
        patch = f["tectonic_stress"][y0:y1, x0:x1]
        released = float(patch.sum())
        f["tectonic_stress"][y0:y1, x0:x1] = patch * 0.05 * rng.random(patch.shape)
        mag = 4.6 + 0.9 * np.log10(1.0 + released) + 0.3 * rng.normal()
        # Landslides: shaking moves loose material off slopes into the sediment load downslope.
        direction, drop, slope = steepest_descent(f["elevation"], self.cfg.tile_size_m)
        yy, xx = np.indices(critical.shape)
        r = 2 + int(max(0.0, mag - 5.0) * 2)
        zone = ((yy - y) ** 2 + (xx - x) ** 2 <= r * r) & (slope > 0.03) & (direction >= 0) & ~w.is_ocean
        slide_dz = np.where(zone, np.minimum(0.02 * (mag - 4.0) * slope * self.cfg.tile_size_m * 0.01,
                                             0.2 * drop), 0.0)
        slide_dz = np.minimum(slide_dz, np.maximum(f["elevation"] - COAST_MIN_M, 0.0))
        slide_t = slide_dz * rho_a
        f["elevation"] -= slide_dz
        meta["deposits_eroded_t"] = meta.get("deposits_eroded_t", 0.0) + float(
            self._take_surface_deposits(w, slide_t).sum())
        f["sediment"] += move_along(slide_t, direction) + slide_t  # debris lands on the downslope tile
        killed = np.where(zone, 0.3 * f["biomass"], 0.0)
        f["biomass"] -= killed
        f["organic_matter"] += killed
        meta["earthquakes"] = meta.get("earthquakes", 0) + 1
        events.append({"tick": cal.tick, "kind": "earthquake", "x": int(x), "y": int(y),
                       "message": f"Earthquake M{mag:.1f} at ({x}, {y}); {int(zone.sum())} tiles of landslides"})

    def _volcanism(self, w: World, cal: Calendar, events: list[dict]) -> None:
        f, meta = w.f, w.meta
        vents = f["volcano"] > 0
        if not vents.any():
            return
        rng = generator(self.cfg.seed, "volcano", cal.day_total)
        p = f["volcano"] / (VOLCANO_RECURRENCE_YEARS * self.cfg.days_per_year)
        erupt = vents & (rng.random(vents.shape) < p)
        if not erupt.any():
            return
        rho_a = self.tile_area * ROCK_DENSITY_T_M3
        yy, xx = np.indices(vents.shape)
        for y, x in zip(*np.nonzero(erupt)):
            vei = int(min(6, 1 + rng.exponential(0.9)))
            volume_m3 = 10.0 ** (4.5 + vei) * (0.5 + rng.random())
            r = 1 + vei
            d2 = (yy - y) ** 2 + (xx - x) ** 2
            lava_w = np.exp(-d2 / max(1.0, (r / 3.0) ** 2)) * (d2 <= (r / 2.0 + 1) ** 2)
            ash_w = np.exp(-d2 / max(1.0, (r / 1.5) ** 2)) * (d2 <= r * r)
            lava_dz = 0.6 * volume_m3 * lava_w / lava_w.sum() / self.tile_area
            ash_dz = 0.4 * volume_m3 * ash_w / ash_w.sum() / self.tile_area
            f["elevation"] += lava_dz + ash_dz
            f["stone"] += lava_dz * rho_a      # cooled lava is new rock
            f["clay"] += ash_dz * rho_a        # ash weathers to fertile fine soil
            meta["volcanic_rock_t"] = meta.get("volcanic_rock_t", 0.0) + float((lava_dz + ash_dz).sum() * rho_a)
            meta["volcanic_stone_t"] = meta.get("volcanic_stone_t", 0.0) + float(lava_dz.sum() * rho_a)
            meta["volcanic_clay_t"] = meta.get("volcanic_clay_t", 0.0) + float(ash_dz.sum() * rho_a)
            hot = lava_dz > 0.01
            f["lava"] = np.where(hot, 1.0, f["lava"])
            burnt = np.where(hot, f["biomass"], np.where(ash_w > 0.05, 0.4 * f["biomass"], 0.0))
            f["biomass"] -= burnt
            f["organic_matter"] += 0.1 * burnt
            f["surface_water"] += np.where(hot, f["snow"], 0.0)  # snow melted by lava runs off (lahar)
            f["snow"] = np.where(hot, 0.0, f["snow"])
            ring = (ash_w > 0.02) & ~hot & (f["biomass"] > 1.0)
            f["fire"] = np.where(ring, np.maximum(f["fire"], 0.6), f["fire"])
            meta["eruptions"] = meta.get("eruptions", 0) + 1
            events.append({"tick": cal.tick, "kind": "volcanic_eruption", "x": int(x), "y": int(y),
                           "message": f"Volcanic eruption (VEI {vei}) at ({x}, {y}); "
                                      f"{volume_m3 / 1e6:.1f} million m³ of lava and ash"})

    def _disaster_watch(self, w: World, cal: Calendar, events: list[dict], land: np.ndarray) -> None:
        """Report floods and droughts from the physical state (with hysteresis, so one episode = one event)."""
        f, meta = w.f, w.meta
        n_land = max(int(land.sum()), 1)
        flooded = land & (f["surface_water"] > 600.0) & (f["surface_water"] < 1500.0)  # not lakes
        frac_flood = flooded.sum() / n_land
        if frac_flood > 0.03 and not meta.get("flood_active"):
            ys, xs = np.nonzero(flooded)
            meta["flood_active"] = True
            meta["floods"] = meta.get("floods", 0) + 1
            events.append({"tick": cal.tick, "kind": "flood", "x": int(np.median(xs)), "y": int(np.median(ys)),
                           "message": f"Flooding: {int(flooded.sum())} land tiles under >0.6 m of water"})
        elif frac_flood < 0.01 and meta.get("flood_active"):
            meta["flood_active"] = False
        dry = land & (f["drought_days"] > 45) & (f["biomass"] > 1.0)
        frac_dry = dry.sum() / n_land
        if frac_dry > 0.2 and not meta.get("drought_active"):
            ys, xs = np.nonzero(dry)
            meta["drought_active"] = True
            meta["droughts"] = meta.get("droughts", 0) + 1
            events.append({"tick": cal.tick, "kind": "drought", "x": int(np.median(xs)), "y": int(np.median(ys)),
                           "message": f"Drought: {frac_dry:.0%} of vegetated land without rain for 45+ days"})
        elif frac_dry < 0.08 and meta.get("drought_active"):
            meta["drought_active"] = False

    def reclassify(self, w: World) -> None:
        f = w.f
        _, _, slope = steepest_descent(f["elevation"], self.cfg.tile_size_m)
        w.terrain = classify(f["elevation"], slope, f["surface_water"], w.soil_moisture, f["flow_flux"],
                             f["snow"], f["biomass"], f["precip_ema"])
