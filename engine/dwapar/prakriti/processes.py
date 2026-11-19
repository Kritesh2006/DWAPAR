"""Prakriti — coupled natural processes.

Every process reads and writes the shared World fields, so effects
propagate: insolation → temperature → evaporation → humidity →
precipitation → soil moisture → vegetation → fuel/dryness → fire →
organic matter → fertility → vegetation, and runoff → erosion → terrain.

All water moves between explicit stores (ocean/surface, soil, atmosphere,
snow); no process creates or destroys water, which the test-suite checks.
All formulae are simplified parameterisations; see WORLD_LAWS.md.
"""

from __future__ import annotations

import numpy as np

from ..brahmanda.noise import value_noise
from ..brahmanda.terrain import classify
from ..brahmanda.world import World
from ..grid import NEIGHBOURS, move_along, neighbour, neighbour_mean, steepest_descent
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
TAU_LAND_H = 3.0          # thermal relaxation time, land (hours)
TAU_WATER_H = 36.0        # thermal relaxation time, open water
DIURNAL_LAND_C = 16.0     # peak-to-mean diurnal forcing on dry land
DIURNAL_WATER_C = 3.0
INFILTRATION_MM_H = 8.0
BASEFLOW_FRACTION_H = 0.02
BASEFLOW_THRESHOLD = 0.75  # fraction of field capacity above which soil drains to surface
FLOW_FRACTION = 0.45       # fraction of the water-surface drop equalised per tick
PRECIP_EFFICIENCY = 0.5
SNOW_THRESHOLD_C = 0.5
MELT_MM_PER_DEG_H = 0.2
FLUX_EMA_H = 72.0
LIGHTNING_P_H = 3.0e-6     # ignition probability per tile-hour at risk = 1
SPREAD_P_H = 0.12
VEG_GROWTH_DAY = 0.035
VEG_MORTALITY_DAY = 0.0006
DECOMP_DAY = 0.0015
EROSION_K = 1.0e-4
TALUS_SLOPE = 0.25
THERMAL_K = 2.0e-5         # fraction of excess slope × tile size moved per day
COAST_MIN_M = 0.5


class Prakriti:
    """Holds static caches (derived purely from config) and advances a World."""

    def __init__(self, world: World):
        cfg = world.cfg
        self.cfg = cfg
        self.lat_rad = np.deg2rad(world.f["latitude"])
        self.q_ann = annual_mean_insolation(self.lat_rad, cfg.days_per_year)
        lat_row = world.f["latitude"][:, :1]
        # Trade winds blow west in the tropics, westerlies blow east at mid-latitudes.
        base = cfg.wind_speed_tiles_per_hour * cfg.hours_per_tick
        # Smooth transition across the ~25° subtropical ridge (avoids an artificial convergence seam).
        blend = np.tanh((np.abs(lat_row) - 25.0) / 6.0)  # -1 deep tropics .. +1 mid-latitudes
        self.wind_u = base * np.where(blend < 0, 0.8 * blend, blend)  # tiles per tick, +x = east
        self.wind_v = np.full_like(self.wind_u, 0.15 * base * np.sign(-np.sin(np.deg2rad(cfg.wind_dir_deg - 90))))
        self._weather_cache: dict[int, np.ndarray] = {}
        # Static sub-tile micro-relief (±0.3 m, seed-derived). Used only to choose flow direction so
        # uniform slopes don't all drain along the same grid axis. It never changes stored elevation.
        rough = generator(cfg.seed, "micro_relief").random((cfg.height, cfg.width))
        self.micro_relief = (rough - 0.5) * 0.6

    # ------------------------------------------------------------------ utils
    def weather(self, day_total: int) -> np.ndarray:
        """Synoptic weather pattern for a day: smooth noise in [0,1] drifting with the westerlies."""
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

    # ------------------------------------------------------------ processes
    def fire_risk(self, w: World) -> np.ndarray:
        """0..1 probability-like index: dry fuel, heat, and time since rain."""
        sm = w.soil_moisture
        dryness = np.clip(1.0 - sm / 0.35, 0, 1)
        drought = np.sqrt(np.clip(w.f["drought_days"] / 12.0, 0, 1))
        heat = np.clip((w.f["temperature"] - 5.0) / 25.0, 0, 1)
        fuel = np.clip(w.f["biomass"] / 5.0, 0, 1)
        wet_surface = w.f["surface_water"] > 50.0
        return np.where(w.is_ocean | wet_surface | (w.f["snow"] > 5), 0.0, dryness * drought * heat * fuel)

    def step_hour(self, w: World, cal: Calendar, events: list[dict]) -> dict:
        cfg, f = self.cfg, w.f
        dt = float(cfg.hours_per_tick)
        ocean = w.is_ocean
        land = ~ocean
        open_water = ocean | (f["surface_water"] > 300.0)
        weather = self.weather_now(cal)

        # 1. Radiation & temperature ---------------------------------------
        doy = cal.day_of_year + cal.hour / 24.0
        insol = instantaneous_insolation(self.lat_rad, doy, cal.hour, cfg.days_per_year)
        lag = cfg.days_per_year / 8.0
        q_day = daily_mean_insolation(self.lat_rad, doy - lag, cfg.days_per_year)
        q_today = daily_mean_insolation(self.lat_rad, doy, cfg.days_per_year)
        t_ann = -38.0 + 210.0 * self.q_ann
        amp = np.where(ocean, 45.0, 95.0)
        t_season = t_ann + amp * (q_day - self.q_ann) - LAPSE_RATE * np.maximum(f["elevation"], 0.0)
        sm = w.soil_moisture
        diurnal = np.where(open_water, DIURNAL_WATER_C, DIURNAL_LAND_C * (1.0 - 0.5 * sm))
        t_eq = t_season + diurnal * (insol - q_today) * 2.0
        t_eq += (weather - 0.5) * 6.0
        t_eq -= np.where(f["snow"] > 20.0, 3.0, 0.0)  # snow albedo
        t_eq += 12.0 * f["fire"]
        tau = np.where(open_water, TAU_WATER_H, TAU_LAND_H)
        f["temperature"] += (t_eq - f["temperature"]) * (1.0 - np.exp(-dt / tau))
        f["temp_day"] += (f["temperature"] - f["temp_day"]) * (dt / 24.0)
        f["temp_ema"] += (f["temperature"] - f["temp_ema"]) * (dt / (24.0 * cfg.days_per_season))
        temp = f["temperature"]

        # 2. Evaporation & transpiration -----------------------------------
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

        # 3. Atmospheric transport (conservative upwind advection + diffusion, periodic)
        a = f["atmo_water"]
        u, v = self.wind_u, self.wind_v
        out_e, out_w = np.maximum(u, 0) * a, np.maximum(-u, 0) * a
        out_s, out_n = np.maximum(v, 0) * a, np.maximum(-v, 0) * a
        a = a - out_e - out_w - out_s - out_n
        a = a + np.roll(out_e, 1, axis=1) + np.roll(out_w, -1, axis=1)
        a = a + np.roll(out_s, 1, axis=0) + np.roll(out_n, -1, axis=0)
        kd = 0.04 * dt
        lap = np.roll(a, 1, 0) + np.roll(a, -1, 0) + np.roll(a, 1, 1) + np.roll(a, -1, 1) - 4 * a
        f["atmo_water"] = a + kd * lap

        # 4. Precipitation (supersaturation, lowered by weather systems & orography)
        cap_eff = cap * (0.78 + 0.42 * weather)
        excess = f["atmo_water"] - cap_eff
        precip = np.where(excess > 0, excess * min(1.0, PRECIP_EFFICIENCY * dt), 0.0)
        precip = np.minimum(precip, f["atmo_water"])
        f["atmo_water"] -= precip
        as_snow = (temp < SNOW_THRESHOLD_C) & land
        f["snow"] += np.where(as_snow, precip, 0.0)
        f["surface_water"] += np.where(as_snow, 0.0, precip)
        f["precip_today"] += precip

        # 5. Snowmelt ------------------------------------------------------
        melt = np.where(temp > 0, np.minimum(f["snow"], MELT_MM_PER_DEG_H * temp * dt), 0.0)
        f["snow"] -= melt
        f["surface_water"] += melt

        # 6. Infiltration & baseflow (land only) ---------------------------
        room = np.maximum(f["field_capacity"] - f["soil_water"], 0.0)
        inf = np.where(land, np.minimum(np.minimum(f["surface_water"], INFILTRATION_MM_H * dt), room), 0.0)
        f["surface_water"] -= inf
        f["soil_water"] += inf
        drain_excess = np.maximum(f["soil_water"] - BASEFLOW_THRESHOLD * f["field_capacity"], 0.0)
        base = np.where(land, drain_excess * min(1.0, BASEFLOW_FRACTION_H * dt), 0.0)
        f["soil_water"] -= base
        f["surface_water"] += base

        # 7. Surface flow (steepest descent on the water surface) ----------
        hsurf = f["elevation"] + f["surface_water"] / 1000.0
        # Land micro-relief breaks direction ties; the moved volume uses the true drop only.
        rough = np.where(f["surface_water"] < 300.0, self.micro_relief, 0.0) * (f["elevation"] >= 0)
        direction, _, _ = steepest_descent(hsurf + rough, cfg.tile_size_m)
        from ..grid import target_index
        true_drop = hsurf.ravel() - hsurf.ravel()[target_index(direction)]
        drop = np.maximum(true_drop.reshape(hsurf.shape), 0.0)
        move = np.where(direction >= 0, np.minimum(f["surface_water"], FLOW_FRACTION * drop * 1000.0), 0.0)
        f["surface_water"] += move_along(move, direction)
        np.maximum(f["surface_water"], 0.0, out=f["surface_water"])  # clamp -0.0 rounding only
        alpha = min(1.0, dt / FLUX_EMA_H)
        f["flow_flux"] += (np.where(land, move / dt, 0.0) - f["flow_flux"]) * alpha

        # 8. Fire ----------------------------------------------------------
        burned_now = self._fire(w, cal, events, precip, dt)

        return {"precip": float(precip.sum()), "evap": float(evap_total.sum()), "burned": burned_now}

    def _fire(self, w: World, cal: Calendar, events: list[dict], precip: np.ndarray, dt: float) -> int:
        f = w.f
        rng = generator(self.cfg.seed, "fire", cal.tick)
        risk = self.fire_risk(w)
        burning = f["fire"] > 0
        was_burning = int(burning.sum())

        # Natural ignition by lightning: more likely under convective weather (moist air, unstable).
        storm = np.clip(f["atmo_water"] / saturation_capacity_mm(f["temperature"]), 0, 1)
        p_ign = LIGHTNING_P_H * dt * risk * (0.3 + storm)
        ignite = (rng.random(risk.shape) < p_ign) & ~burning
        # Spread from burning neighbours, favoured downwind.
        spread_p = np.zeros_like(risk)
        for dy, dx, dist in NEIGHBOURS:
            src = neighbour(f["fire"], -dy, -dx, 0.0)  # fire intensity of the cell upstream of (dy,dx)
            wind_bonus = 1.0 + 0.6 * np.sign(dx) * np.sign(self.wind_u)
            spread_p = 1 - (1 - spread_p) * (1 - np.clip(SPREAD_P_H * dt * src * wind_bonus / dist, 0, 1))
        spread = (rng.random(risk.shape) < spread_p * risk * 3.0) & ~burning
        new = ignite | spread
        for y, x in zip(*np.nonzero(ignite)):
            events.append({"tick": cal.tick, "kind": "fire_ignition", "x": int(x), "y": int(y),
                           "message": f"Lightning ignited a fire at ({x}, {y}); risk {risk[y, x]:.2f}"})
        f["fire"] = np.where(new, 0.25, f["fire"])

        # Burning: consume fuel, intensify with dry fuel, extinguish on rain / no fuel / wet soil.
        burning = f["fire"] > 0
        fuel_factor = np.clip(f["biomass"] / 6.0, 0, 1) * np.clip(risk * 2.0 + 0.2, 0, 1)
        f["fire"] = np.where(burning, np.clip(f["fire"] + 0.3 * dt * (fuel_factor - f["fire"]), 0, 1), 0.0)
        consumed = np.where(burning, np.minimum(f["biomass"], (0.08 * f["biomass"] + 0.05) * f["fire"] * dt), 0.0)
        f["biomass"] -= consumed
        f["organic_matter"] += 0.15 * consumed  # char & ash; the rest leaves as combustion gases
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

    # ---------------------------------------------------------------- daily
    def step_day(self, w: World, cal: Calendar, events: list[dict]) -> None:
        f = w.f
        ocean = w.is_ocean
        land = ~ocean
        rain_day = f["precip_today"]
        f["drought_days"] = np.where(rain_day > 1.0, 0.0, f["drought_days"] + 1.0)
        f["precip_ema"] += (rain_day - f["precip_ema"]) / self.cfg.days_per_season
        f["precip_today"][:] = 0.0

        # Vegetation --------------------------------------------------------
        t = f["temp_day"]
        sm = w.soil_moisture
        f_t = np.clip(t / 12.0, 0, 1) * np.clip((42.0 - t) / 10.0, 0, 1)
        f_w = np.clip((sm - 0.08) / 0.4, 0, 1)
        fert = w.fertility
        k = 28.0 * (0.3 + 0.7 * fert) * np.clip(f["precip_ema"] / 3.0, 0.05, 1.0)
        flooded = f["surface_water"] > 600.0
        b = f["biomass"]
        growth = VEG_GROWTH_DAY * b * (1.0 - b / np.maximum(k, 1e-6)) * f_t * f_w
        growth = np.maximum(growth, -0.02 * b)  # over-capacity dieback is gradual
        seed_src = neighbour_mean(b)
        colon = f_t * f_w * (0.002 + 0.01 * np.clip(seed_src / 5.0, 0, 1))
        mort = VEG_MORTALITY_DAY * b
        mort += np.where(sm < 0.06, 0.01 * b, 0.0)       # drought stress
        mort += np.where(t < -8.0, 0.003 * b, 0.0)       # frost damage
        mort += np.where(flooded, 0.05 * b, 0.0)         # drowning
        active = land & ~flooded
        gain = np.where(active, np.maximum(growth, 0.0) + colon, 0.0)
        loss = np.minimum(b, mort + np.where(active, np.maximum(-growth, 0.0), 0.0))
        f["biomass"] = np.where(ocean, 0.0, b + gain - loss)
        f["organic_matter"] += np.where(ocean, 0.0, loss)  # dead biomass becomes litter

        # Decomposition (temperature & moisture limited) --------------------
        f["organic_matter"] *= 1.0 - DECOMP_DAY * f_t * (0.3 + 0.7 * f_w)
        f["organic_matter"] = np.where(ocean, 0.0, f["organic_matter"])

        # Erosion: fluvial (flow × slope, vegetation protects) + thermal (talus) — mass-conserving.
        elev = f["elevation"]
        direction, drop, slope = steepest_descent(elev, self.cfg.tile_size_m)
        cover = np.clip(f["biomass"] / 10.0, 0, 1)
        fluvial = EROSION_K * np.sqrt(np.maximum(f["flow_flux"], 0)) * slope * (1.0 - 0.8 * cover)
        thermal = np.where(slope > TALUS_SLOPE, THERMAL_K * (slope - TALUS_SLOPE) * self.cfg.tile_size_m, 0.0)
        dz = np.where((direction >= 0) & land, np.minimum(fluvial + thermal, 0.25 * drop), 0.0)
        # Land is lowered towards, never below, the coastal minimum in one step (no instant drowning).
        dz = np.minimum(dz, np.maximum(elev - COAST_MIN_M, 0.0))
        f["elevation"] = elev + move_along(dz, direction)

        # Reclassify terrain from the new state ----------------------------
        self.reclassify(w)

        # Calendar events --------------------------------------------------
        if cal.is_year_start and cal.year > 0:
            events.append({"tick": cal.tick, "kind": "year", "x": None, "y": None,
                           "message": f"Year {cal.year + 1} begins"})
        if cal.is_season_start:
            events.append({"tick": cal.tick, "kind": "season", "x": None, "y": None,
                           "message": f"{cal.season.capitalize()} begins (northern hemisphere)"})

    def reclassify(self, w: World) -> None:
        f = w.f
        _, _, slope = steepest_descent(f["elevation"], self.cfg.tile_size_m)
        w.terrain = classify(f["elevation"], slope, f["surface_water"], w.soil_moisture, f["flow_flux"],
                             f["snow"], f["biomass"], f["precip_ema"])
