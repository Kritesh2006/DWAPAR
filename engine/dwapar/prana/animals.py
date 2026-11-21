"""Animals: individual creatures with needs, perception, simple learning and heritable variation.

Each hour an animal senses (predators, prey, kin, water, food, temperature), updates its needs,
chooses the most pressing behaviour (flee > drink > eat/hunt > rest > mate > roam), and acts on
the authoritative world: grazing removes biomass from the tile it stands on; a carcass returns
its mass to the soil's organic matter. Nothing is scripted per individual.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING

from .species import SPECIES

if TYPE_CHECKING:  # pragma: no cover
    from .life import Life


@dataclass
class Animal:
    id: int
    sp: str
    x: float
    y: float
    sex: int
    age_d: float
    energy: float = 0.8
    hydration: float = 0.9
    fatigue: float = 0.2
    wariness: float = 0.2      # learned: rises after surviving danger, decays slowly
    speed_gene: float = 1.0    # heritable: offspring vary around the parent's value
    size_gene: float = 1.0
    home_x: float = 0.0
    home_y: float = 0.0
    last_birth_d: float = -1e9
    starving_h: float = 0.0
    parent: int = 0
    generation: int = 0
    danger: list = field(default_factory=list)  # remembered [x, y, tick] of recent attacks
    water_x: float = -1.0     # remembered: where it last drank
    water_y: float = -1.0
    action: str = "roam"

    def to_dict(self) -> dict:
        return asdict(self)


def _away(ax: float, ay: float, fx: float, fy: float) -> tuple[float, float]:
    dx, dy = ax - fx, ay - fy
    d = math.hypot(dx, dy) or 1.0
    return dx / d, dy / d


def step_animal(a: Animal, life: "Life", hour: int, rng) -> None:
    sp = SPECIES[a.sp]
    hab = life.hab
    tile = hab.tile
    night = hour >= 20 or hour < 5
    temp = hab.at(hab.temp, a.x, a.y)
    a.age_d += 1.0 / 24.0

    # ---- needs
    cold = max(0.0, sp.min_temp_c + 10.0 - temp) / 20.0
    heat = max(0.0, temp - (sp.max_temp_c - 10.0)) / 20.0
    # carnivores feast and fast (a big cat eats a large kill about once a week); herbivores graze daily
    drain = 0.0022 if sp.diet == "meat" else (sp.intake_frac_day / 0.04) * 0.006
    a.energy -= drain * (1.0 + cold) / a.size_gene ** 0.25
    a.hydration -= 0.012 * (1.0 + 2.0 * heat)
    a.fatigue = min(1.0, a.fatigue + (0.0 if night else 0.02))
    a.wariness = max(0.1, a.wariness * 0.9995)

    # ---- perceive
    perc = sp.perception_km * 1000.0 * (1.0 + 0.5 * a.wariness)
    threat = None
    if sp.diet == "plants" or sp.name == "wolf":
        threat = life.nearest(a.x, a.y, perc, lambda o: o is not a and a.sp in SPECIES[o.sp].prey
                              and (o.energy < 0.75 or math.hypot(o.x - a.x, o.y - a.y) < perc * 0.5), pool="predators")
    pos = a.x, a.y
    move = 0.0
    target = None

    # ---- decide and act
    if threat is not None:
        a.action = "flee"
        ux, uy = _away(a.x, a.y, threat.x, threat.y)
        move = sp.run_kmh * 1000.0 * a.speed_gene * 0.5
        target = (a.x + ux * move, a.y + uy * move)
        a.fatigue = min(1.0, a.fatigue + 0.1)
        a.danger = (a.danger + [[threat.x, threat.y, life.tick]])[-3:]
        a.wariness = min(1.0, a.wariness + 0.05)
    elif a.hydration < 0.45:
        a.action = "drink"
        if hab.near_water(a.x, a.y):
            a.hydration = 1.0
            a.water_x, a.water_y = a.x, a.y
        else:
            target = hab.water_step(a.x, a.y, sp.perception_km * 1000.0 / tile + 6)
            if target is None and a.water_x >= 0:
                target = (a.water_x, a.water_y)  # go back to where it last drank
            if target is None:
                low = hab.downhill(a.x, a.y)
                target = low if hab.tile_of(*low) != hab.tile_of(a.x, a.y) else life.wander(a, rng, sp.walk_kmh * 3000.0)
            move = sp.walk_kmh * 1000.0
    elif a.energy < 0.7 and not (night and a.fatigue > 0.6):
        if sp.diet == "plants":
            a.action = "graze"
            avail = hab.at(hab.biomass, a.x, a.y)
            if avail > 0.3:
                want = sp.mass_kg * a.size_gene * sp.intake_frac_day / 6.0  # kg in one hour of feeding
                life.eat_plants(a.x, a.y, want)
                a.energy = min(1.0, a.energy + 0.2 * min(1.0, avail / 2.0))
            else:
                target = life.greener(a.x, a.y)
                move = sp.walk_kmh * 1000.0
        else:
            a.action = "hunt"
            # humans are a last resort: only a starving predator turns to them, and only if no other prey is near
            prey = None
            for s in sp.prey:
                if s == "human":
                    continue
                cand = life.nearest(a.x, a.y, sp.perception_km * 1000.0, lambda o: True, pool="sp:" + s)
                if cand is not None and (prey is None or math.hypot(cand.x - a.x, cand.y - a.y) < math.hypot(prey.x - a.x, prey.y - a.y)):
                    prey = cand
            if prey is None and "human" in sp.prey and a.energy < 0.3:
                prey = life.nearest(a.x, a.y, sp.perception_km * 1000.0, life.catchable, pool="humans")
            if prey is not None:
                target = (prey.x, prey.y)
                move = sp.run_kmh * 1000.0 * a.speed_gene * 0.6
                d = math.hypot(prey.x - a.x, prey.y - a.y)
                if d <= move:
                    life.attack(a, prey, rng)
                    target = (prey.x, prey.y)
            else:
                # follow tracks and scent toward the nearest prey within a day's travel
                far = None
                for s in sp.prey:
                    if s == "human":
                        continue
                    cand = life.nearest(a.x, a.y, 15000.0, lambda o: True, pool="sp:" + s)
                    if cand is not None and (far is None or math.hypot(cand.x - a.x, cand.y - a.y) < math.hypot(far.x - a.x, far.y - a.y)):
                        far = cand
                target = (far.x, far.y) if far is not None else life.wander(a, rng, sp.walk_kmh * 1000.0)
                move = sp.walk_kmh * 1000.0
                a.action = "track" if far is not None else "hunt"
    elif night or a.fatigue > 0.75:
        a.action = "rest"
        a.fatigue = max(0.0, a.fatigue - 0.12)
    else:
        a.action = "roam"
        # mating: mature, fed, female with a mate nearby, interval passed
        mature = a.age_d >= sp.maturity_y * 360
        if (a.sex == 1 and mature and a.energy > 0.55 and a.age_d - a.last_birth_d >= sp.birth_interval_y * 360
                and life.crowding(a) < sp.max_density_km2 * life.local_food(a)
                and life.nearest(a.x, a.y, 3000.0, lambda o: o.sex == 0 and o.age_d >= sp.maturity_y * 360,
                                 pool="sp:" + a.sp) is not None):
            life.give_birth(a, rng)
        target = life.wander(a, rng, sp.walk_kmh * 1000.0 * 0.6)
        move = sp.walk_kmh * 1000.0 * 0.6
        if sp.territory_km > 0:
            rival = life.nearest(a.x, a.y, sp.territory_km * 1000.0, lambda o: o is not a and o.sex == a.sex,
                                 pool="sp:" + a.sp)
            if rival is not None:
                ux, uy = _away(a.x, a.y, rival.x, rival.y)
                target = (a.x + ux * move, a.y + uy * move)
                a.action = "patrol"
        elif sp.group:
            kin = life.nearest(a.x, a.y, 8000.0, lambda o: o is not a, pool="sp:" + a.sp)
            if kin is not None and math.hypot(kin.x - a.x, kin.y - a.y) > 1500.0:
                target = (kin.x, kin.y)
                a.action = "join herd"

    if target is not None and move > 0:
        life.move(a, target, move)

    # ---- death
    if a.energy <= 0 or a.hydration <= 0:
        a.starving_h += 1
        a.energy, a.hydration = max(a.energy, 0.0), max(a.hydration, 0.0)
        if a.starving_h > 72:
            life.die(a, "starvation" if a.energy <= 0 else "thirst")
            return
    else:
        a.starving_h = 0.0
    if temp < sp.min_temp_c - 5 and rng.random() < 0.02:
        life.die(a, "cold")
        return
    max_age = sp.max_age_y * 360
    if a.age_d > 0.6 * max_age:
        # mortality rises steeply toward the species' maximum age (per-hour hazard)
        if rng.random() < (math.exp(4.0 * (a.age_d / max_age - 1.0)) * 0.002):
            life.die(a, "old age")
            return
    if not (night) and pos == (a.x, a.y) and a.action == "rest":
        a.fatigue = max(0.0, a.fatigue - 0.02)
