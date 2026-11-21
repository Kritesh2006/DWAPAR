"""Validation and application of divine commands. See the package docstring for the rules."""

from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np

from ..brahmanda.world import ROCK_DENSITY_T_M3, World


class CommandError(ValueError):
    """A command was refused. The message says why, in words fit to show the Creator."""


#: kind → (summary, parameter spec). Spec: name → (type, min, max, default or None = required).
COMMAND_KINDS: dict[str, tuple[str, dict[str, tuple]]] = {
    "shape_land": ("Raise (height > 0) or lower (height < 0) the land around a point", {
        "x": (int, 0, None, None), "y": (int, 0, None, None),
        "radius": (float, 0.5, 12.0, 2.0), "height_m": (float, -1500.0, 2500.0, None)}),
    "carve_channel": ("Cut a channel from one point to another so water can flow along it", {
        "x0": (int, 0, None, None), "y0": (int, 0, None, None), "x1": (int, 0, None, None),
        "y1": (int, 0, None, None), "depth_m": (float, 1.0, 120.0, 25.0)}),
    "create_lake": ("Hollow a basin and fill it with water drawn from the ocean", {
        "x": (int, 0, None, None), "y": (int, 0, None, None),
        "radius": (float, 0.5, 6.0, 1.5), "depth_m": (float, 1.0, 80.0, 12.0)}),
    "bring_rain": ("Lift ocean water into the air above a region; physics decides where it falls", {
        "x": (int, 0, None, None), "y": (int, 0, None, None),
        "radius": (float, 0.5, 15.0, 4.0), "amount_mm": (float, 1.0, 200.0, 40.0)}),
    "plant_forest": ("Seed vegetation on land (growth afterwards follows the laws)", {
        "x": (int, 0, None, None), "y": (int, 0, None, None),
        "radius": (float, 0.5, 12.0, 3.0), "biomass_kg_m2": (float, 0.5, 15.0, 6.0)}),
    "restore_ecosystem": ("Seed vegetation and soil organic matter, wet the soil from the ocean, put out fire", {
        "x": (int, 0, None, None), "y": (int, 0, None, None),
        "radius": (float, 0.5, 12.0, 3.0), "strength": (float, 0.1, 1.0, 0.6)}),
    "extinguish_fire": ("Put out fires around a point", {
        "x": (int, 0, None, None), "y": (int, 0, None, None), "radius": (float, 0.5, 20.0, 5.0)}),
    "climate_forcing": ("Warm (delta > 0) or cool a region for a number of days", {
        "x": (int, 0, None, None), "y": (int, 0, None, None), "radius": (float, 1.0, 25.0, 6.0),
        "delta_c": (float, -12.0, 12.0, None), "days": (float, 1.0, 360.0, 30.0)}),
    "create_animals": ("Create animals of one species around a point", {
        "species": (str, None, None, None), "x": (int, 0, None, None), "y": (int, 0, None, None),
        "count": (int, 1, 400, 20)}),
    "create_humans": ("Create humans around a point, each with their own mind", {
        "x": (int, 0, None, None), "y": (int, 0, None, None), "count": (int, 2, 60, 12)}),
}

ISSUERS = ("creator", "witness", "replay")


def _kernel(world: World, x: float, y: float, radius: float) -> np.ndarray:
    """Smooth weight 0..1 around (x, y) in tiles, zero beyond 2·radius."""
    h, w = world.shape
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.hypot(xx - x, yy - y)
    k = np.exp(-(d / radius) ** 2)
    k[d > 2.0 * radius] = 0.0
    return k


def validate(world: World, kind: str, params: dict[str, Any]) -> dict[str, Any]:
    """Return normalised parameters, or raise CommandError."""
    if kind not in COMMAND_KINDS:
        raise CommandError(f"unknown command '{kind}'")
    spec = COMMAND_KINDS[kind][1]
    unknown = set(params) - set(spec)
    if unknown:
        raise CommandError(f"unknown parameters for {kind}: {sorted(unknown)}")
    h, w = world.shape
    out: dict[str, Any] = {}
    for name, (typ, lo, hi, default) in spec.items():
        v = params.get(name, default)
        if v is None:
            raise CommandError(f"{kind} needs '{name}'")
        try:
            v = typ(v)
        except (TypeError, ValueError):
            raise CommandError(f"{name} must be {typ.__name__}") from None
        if typ is float and not math.isfinite(v):
            raise CommandError(f"{name} must be finite")
        if name in ("x", "x0", "x1"):
            hi = w - 1
        if name in ("y", "y0", "y1"):
            hi = h - 1
        if lo is not None and v < lo or hi is not None and v > hi:
            raise CommandError(f"{name}={v} is outside [{lo}, {hi}]")
        out[name] = v
    ocean = world.is_ocean
    if kind in ("plant_forest", "restore_ecosystem", "create_lake", "create_humans") and ocean[out["y"], out["x"]]:
        raise CommandError("that point is ocean; this act needs land")
    if kind == "create_animals":
        from ..prana.species import SPECIES
        if out["species"] not in SPECIES:
            raise CommandError(f"unknown species '{out['species']}' (known: {', '.join(SPECIES)})")
        habitat = SPECIES[out["species"]].habitat
        if habitat == "land" and ocean[out["y"], out["x"]]:
            raise CommandError(f"{out['species']} live on land; that point is ocean")
    if kind == "create_lake" and world.f["elevation"][out["y"], out["x"]] - out["depth_m"] <= world.sea_level + 1.0:
        raise CommandError("a basin that deep would open to the sea; choose higher ground or a shallower lake")
    if kind == "climate_forcing" and abs(out["delta_c"]) < 0.1:
        raise CommandError("delta_c is too small to matter")
    return out


def submit(world: World, kind: str, params: dict[str, Any], issuer: str, reason: str = "") -> dict:
    """Validate and queue a command for the next tick. Caller must hold the simulation lock."""
    if issuer not in ISSUERS:
        raise CommandError(f"unknown issuer '{issuer}'")
    p = validate(world, kind, params)
    seq = int(world.meta.get("command_seq", 0)) + 1
    world.meta["command_seq"] = seq
    cmd = {"seq": seq, "tick": int(world.tick), "issuer": issuer, "kind": kind, "params": p, "reason": reason[:500]}
    world.meta.setdefault("command_queue", []).append(cmd)
    return cmd


def _ledger(world: World) -> dict:
    return world.meta.setdefault("divine", {"rock_t": 0.0, "biomass_kg": 0.0, "organic_kg": 0.0,
                                            "water_moved_mm": 0.0, "creatures": 0, "acts": 0})


def _take_from_ocean(world: World, volume_mm_tiles: float) -> None:
    """Remove water evenly from ocean tiles (mm·tiles). The daily sea-level solve follows."""
    ocean = world.is_ocean
    n = int(ocean.sum())
    if n == 0:
        raise CommandError("there is no ocean to draw water from")
    per = volume_mm_tiles / n
    if per > float(world.f["surface_water"][ocean].min()) * 0.5:
        raise CommandError("the ocean is too shallow to give that much water")
    world.f["surface_water"][ocean] -= per
    _ledger(world)["water_moved_mm"] += float(volume_mm_tiles)


def _reshape(world: World, dz: np.ndarray) -> float:
    rho_a = world.cfg.tile_size_m ** 2 * ROCK_DENSITY_T_M3
    world.f["elevation"] += dz
    added = float(dz.sum() * rho_a)
    _ledger(world)["rock_t"] += added
    return added


def apply_command(world: World, cmd: dict, prakriti=None, life=None) -> dict:
    """Apply one validated command to the authoritative world state; return measured results."""
    kind = cmd["kind"]
    p = validate(world, kind, cmd["params"])  # world may have changed since submission
    f = world.f
    land = ~world.is_ocean
    led = _ledger(world)
    res: dict[str, Any] = {}

    if kind == "shape_land":
        k = _kernel(world, p["x"], p["y"], p["radius"])
        dz = p["height_m"] * k
        before = float(f["elevation"][p["y"], p["x"]])
        res["rock_t"] = _reshape(world, dz)
        res["elevation_before_m"] = before
        res["elevation_after_m"] = float(f["elevation"][p["y"], p["x"]])
        res["tiles"] = int((np.abs(dz) > 1.0).sum())
    elif kind == "carve_channel":
        n = int(max(abs(p["x1"] - p["x0"]), abs(p["y1"] - p["y0"]))) + 1
        dz = np.zeros(world.shape)
        for i in range(n):
            t = i / max(n - 1, 1)
            cx, cy = p["x0"] + (p["x1"] - p["x0"]) * t, p["y0"] + (p["y1"] - p["y0"]) * t
            dz = np.minimum(dz, -p["depth_m"] * (1.0 - 0.5 * t) * _kernel(world, cx, cy, 0.7))
        res["rock_t"] = _reshape(world, dz)
        res["tiles"] = int((dz < -1.0).sum())
    elif kind == "create_lake":
        k = _kernel(world, p["x"], p["y"], p["radius"]) * land
        dz = -p["depth_m"] * k
        res["rock_t"] = _reshape(world, dz)
        fill_mm = -dz * 1000.0  # fill the new hollow to the old ground level
        vol = float(fill_mm.sum())
        _take_from_ocean(world, vol)
        f["surface_water"] += fill_mm
        res["water_mm_tiles"] = vol
        res["tiles"] = int((k > 0.05).sum())
    elif kind == "bring_rain":
        k = _kernel(world, p["x"], p["y"], p["radius"])
        add = p["amount_mm"] * k
        vol = float(add.sum())
        _take_from_ocean(world, vol)
        f["atmo_water"] += add
        res["water_mm_tiles"] = vol
        res["tiles"] = int((k > 0.05).sum())
    elif kind in ("plant_forest", "restore_ecosystem"):
        k = _kernel(world, p["x"], p["y"], p["radius"]) * land * (f["ice"] < 100.0) * (f["lava"] < 0.2)
        area = world.cfg.tile_size_m ** 2
        if kind == "plant_forest":
            add_b = p["biomass_kg_m2"] * k
        else:
            s = p["strength"]
            add_b = np.maximum(0.0, 8.0 * s * k - f["biomass"] * k)  # bring degraded land up, never cut forest
            add_om = 6.0 * s * k
            f["organic_matter"] += add_om
            led["organic_kg"] += float(add_om.sum() * area)
            res["organic_kg"] = float(add_om.sum() * area)
            want = np.maximum(0.0, 0.7 * f["field_capacity"] - f["soil_water"]) * k * s
            vol = float(want.sum())
            if vol > 0:
                _take_from_ocean(world, vol)
                f["soil_water"] += want
            res["water_mm_tiles"] = vol
            burning = (f["fire"] > 0) & (k > 0.05)
            f["fire"][burning] = 0.0
            res["fires_extinguished"] = int(burning.sum())
        f["biomass"] += add_b
        led["biomass_kg"] += float(add_b.sum() * area)
        res["biomass_kg"] = float(add_b.sum() * area)
        res["tiles"] = int((k > 0.05).sum())
    elif kind == "extinguish_fire":
        k = _kernel(world, p["x"], p["y"], p["radius"])
        burning = (f["fire"] > 0) & (k > 0.05)
        f["fire"][burning] = 0.0
        res["fires_extinguished"] = int(burning.sum())
    elif kind == "climate_forcing":
        until = int(world.tick + p["days"] * world.cfg.ticks_per_day)
        world.meta.setdefault("forcings", []).append(
            {"seq": cmd["seq"], "x": p["x"], "y": p["y"], "radius": p["radius"], "delta_c": p["delta_c"],
             "until_tick": until})
        res["until_tick"] = until
    elif kind in ("create_animals", "create_humans"):
        if world.life is None:
            from ..prana.life import Life
            world.life = Life()
        made = world.life.create(world, kind, p, cmd["seq"])
        led["creatures"] += made
        res["created"] = made
    else:  # pragma: no cover - validate() rejects unknown kinds
        raise CommandError(kind)

    if kind in ("shape_land", "carve_channel", "create_lake") and prakriti is not None:
        prakriti.reclassify(world)
    led["acts"] += 1
    world.validate()
    return res


def schedule_replay(world: World, commands: list[dict]) -> int:
    """Queue logged commands (status 'applied', from ``Store.commands``) to re-apply at their ticks.

    Replaying a world's command log from an earlier checkpoint reproduces the world exactly, with
    no decision-maker or language model involved. Returns the number of commands scheduled."""
    todo = [c for c in commands if c.get("status", "applied") == "applied" and c["tick"] >= world.tick]
    q = world.meta.setdefault("command_queue", [])
    for c in sorted(todo, key=lambda c: c["seq"]):
        q.append({"seq": c["seq"], "tick": c["tick"], "issuer": c["issuer"], "kind": c["kind"],
                  "params": c["params"], "reason": c.get("reason", "")})
    if todo:
        world.meta["command_seq"] = max(int(world.meta.get("command_seq", 0)), max(c["seq"] for c in todo))
    return len(todo)


def apply_forcings(world: World) -> None:
    """Sustained regional warming/cooling from climate_forcing commands, applied after each hour.

    Air temperature relaxes toward its equilibrium with a ~3 h time constant; adding the same
    relaxation step toward (equilibrium + delta) shifts the regional climate by about delta while
    the forcing lasts, and the physics carries the anomaly on afterwards."""
    fs = world.meta.get("forcings")
    if not fs:
        return
    alive = [fc for fc in fs if fc["until_tick"] > world.tick]
    gain = 1.0 - math.exp(-1.0 / 3.0)
    for fc in alive:
        world.f["temperature"] += fc["delta_c"] * gain * _kernel(world, fc["x"], fc["y"], fc["radius"])
    if len(alive) != len(fs):
        world.meta["forcings"] = alive


def describe(cmd: dict, result: Optional[dict] = None, tile_m: float = 2000.0) -> str:
    """One line in plain words, for logs and for WITNESS's speech."""
    k, p = cmd["kind"], cmd["params"]
    where = f"({p.get('x', p.get('x0'))}, {p.get('y', p.get('y0'))})"
    text = {
        "shape_land": lambda: f"{'raised' if p['height_m'] > 0 else 'lowered'} the land at {where} by up to {abs(p['height_m']):.0f} m",
        "carve_channel": lambda: f"carved a channel {p['depth_m']:.0f} m deep from {where} to ({p['x1']}, {p['y1']})",
        "create_lake": lambda: f"hollowed a lake basin {p['depth_m']:.0f} m deep at {where} and filled it from the ocean",
        "bring_rain": lambda: f"lifted {p['amount_mm']:.0f} mm of ocean water into the sky over {where}",
        "plant_forest": lambda: f"seeded forest ({p['biomass_kg_m2']:.1f} kg/m²) around {where}",
        "restore_ecosystem": lambda: f"restored soil, water and vegetation around {where}",
        "extinguish_fire": lambda: f"put out fires around {where}",
        "climate_forcing": lambda: f"{'warmed' if p['delta_c'] > 0 else 'cooled'} the air around {where} by {abs(p['delta_c']):.1f} °C for {p['days']:.0f} days",
        "create_animals": lambda: f"created {p['count']} {p['species']} at {where}",
        "create_humans": lambda: f"created {p['count']} humans at {where}",
    }[k]()
    if result:
        extra = []
        if "biomass_kg" in result:
            extra.append(f"{result['biomass_kg'] / 1e9:.2f} Mt of vegetation")
        if "water_mm_tiles" in result and result["water_mm_tiles"]:
            extra.append(f"{result['water_mm_tiles'] * tile_m ** 2 / 1e12:.3f} km³ of water moved")
        if "created" in result:
            extra.append(f"{result['created']} came into being")
        if result.get("fires_extinguished"):
            extra.append(f"{result['fires_extinguished']} fires out")
        if extra:
            text += " — " + ", ".join(extra)
    return text
