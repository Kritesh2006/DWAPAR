"""Life — every animal, human and structure in a world, advanced one hour at a time.

* State is plain JSON (floats round-trip exactly), stored inside checkpoints, so a world with life
  restores and continues exactly like an uninterrupted run.
* All randomness comes from ``rng.generator(seed, "life", tick)``; creatures act in id order.
* Everything a creature senses is computed from the *current* state each hour (cached only when
  the inputs are unchanged), so restoring mid-day cannot change outcomes.
* Effects on the physical world are real and counted in ``ledger``: plants eaten, wood cut for
  shelters, and bodies returned to soil organic matter.
"""

from __future__ import annotations

import json
import math
from typing import Callable, Iterable, Optional

import numpy as np

from ..brahmanda.world import World
from ..buddhi.mind import SHELTER_LABOUR_H, Human, make_name, step_human
from ..rng import generator
from .animals import Animal, step_animal
from .habitat import Habitat
from .species import SPECIES

LIFE_VERSION = "0.1"
CELL_M = 2000.0
#: Computational limit, not an ecological one: above this many animals no more are born, and every
#: birth prevented is counted in stats["births_capped"] so the limit is never hidden.
MAX_ANIMALS = 20000


class Life:
    def __init__(self):
        self.animals: list[Animal] = []
        self.humans: list[Human] = []
        self.structures: dict[int, dict] = {}
        self.next_id = 1
        self.ledger = {"plants_eaten_kg": 0.0, "wood_cut_kg": 0.0, "bodies_to_soil_kg": 0.0}
        self.stats = {"births": {}, "deaths": {}, "attacks_on_humans": 0, "humans_killed": 0, "shelters_built": 0}
        self.hab: Optional[Habitat] = None
        self.tick = 0
        self.by_id: dict[int, object] = {}
        self._dead: set[int] = set()
        self._grid: dict[tuple[int, int], list] = {}
        self._pools: dict[str, dict] = {}
        self._events: list[dict] = []
        self._water_key: Optional[bytes] = None

    # ------------------------------------------------------------------ persistence
    def to_json(self) -> str:
        return json.dumps({
            "version": LIFE_VERSION, "next_id": self.next_id,
            "animals": [a.to_dict() for a in self.animals], "humans": [h.to_dict() for h in self.humans],
            "structures": {str(k): v for k, v in self.structures.items()},
            "ledger": self.ledger, "stats": self.stats,
        }, sort_keys=True)

    @classmethod
    def from_json(cls, s: str) -> "Life":
        d = json.loads(s)
        life = cls()
        life.next_id = d["next_id"]
        life.animals = [Animal(**a) for a in d["animals"]]
        life.humans = [Human(**h) for h in d["humans"]]
        life.structures = {int(k): v for k, v in d["structures"].items()}
        life.ledger = d["ledger"]
        life.stats = d["stats"]
        return life

    def copy(self) -> "Life":
        return Life.from_json(self.to_json())

    # ------------------------------------------------------------------ creation
    def create(self, world: World, kind: str, p: dict, seq: int) -> int:
        self._ensure_habitat(world)
        rng = generator(world.cfg.seed, f"creation-{seq}", world.tick)
        tile = world.cfg.tile_size_m
        made = 0
        for k in range(p["count"]):
            for _ in range(20):  # find a land spot near the requested tile
                x = (p["x"] + 0.5) * tile + rng.normal(0, tile * (0.4 + 0.05 * math.sqrt(p["count"])))
                y = (p["y"] + 0.5) * tile + rng.normal(0, tile * (0.4 + 0.05 * math.sqrt(p["count"])))
                if self.hab.is_land(x, y):
                    break
            else:
                continue
            if kind == "create_animals":
                sp = SPECIES[p["species"]]
                a = Animal(id=self.next_id, sp=sp.name, x=x, y=y, sex=k % 2,
                           age_d=float(rng.uniform(sp.maturity_y, sp.maturity_y * 2.0) * 360),
                           energy=0.85, hydration=0.9, home_x=x, home_y=y,
                           speed_gene=float(1.0 + rng.normal(0, 0.05)), size_gene=float(1.0 + rng.normal(0, 0.05)))
                self.animals.append(a)
            else:
                hmn = Human(id=self.next_id, name=make_name(int(rng.integers(0, 2**31))), sex=k % 2, x=x, y=y,
                            age_d=float(rng.uniform(17, 30) * 360))
                hmn.remember(world.tick, "I awoke in this world")
                self.humans.append(hmn)
            self.next_id += 1
            made += 1
        self._index()
        return made

    # ------------------------------------------------------------------ stepping
    def _ensure_habitat(self, world: World) -> None:
        if self.hab is None or self.hab.h != world.shape[0]:
            self.hab = Habitat(world)
            self._water_key = None
        hab = self.hab
        # cheap hourly refresh from the current state; the costly water map only when water changed
        f = world.f
        hab.ocean = world.is_ocean
        hab.land = ~hab.ocean
        hab.sea = world.sea_level
        hab.biomass, hab.temp, hab.elev, hab.stone, hab.fire = f["biomass"], f["temperature"], f["elevation"], f["stone"], f["fire"]
        hab.forest = np.clip(f["biomass"] / 25.0, 0.0, 1.0)
        from .habitat import drinkable
        water = drinkable(world)
        key = np.packbits(water).tobytes() + np.packbits(hab.land).tobytes()
        if key != self._water_key:
            hab.water = water
            hab.dist = Habitat._distance(water, hab.land)
            self._water_key = key

    def step_hour(self, world: World, cal, events: list[dict]) -> None:
        if not self.animals and not self.humans:
            return
        self.tick = world.tick
        self._ensure_habitat(world)
        self.world = world
        self._dead = set()
        self._events = []
        self._index()
        rng = generator(world.cfg.seed, "life", world.tick)
        hour = cal.hour
        for a in list(self.animals):
            if a.id not in self._dead:
                step_animal(a, self, hour, rng)
        for h in list(self.humans):
            if h.id not in self._dead:
                step_human(h, self, hour, rng)
        if self._dead:
            self.animals = [a for a in self.animals if a.id not in self._dead]
            self.humans = [h for h in self.humans if h.id not in self._dead]
            alive_species = {a.sp for a in self.animals}
            for sp in sorted(self.stats.setdefault("present", [])):
                if sp not in alive_species and sp != "human":
                    self._events.append({"tick": world.tick, "kind": "extinction", "x": None, "y": None,
                                         "message": f"The last {sp} has died; the species is gone from this world"})
            if "human" in self.stats["present"] and not self.humans:
                self._events.append({"tick": world.tick, "kind": "extinction", "x": None, "y": None,
                                     "message": "The last human has died"})
        self.stats["present"] = sorted({a.sp for a in self.animals} | ({"human"} if self.humans else set()))
        events.extend(self._events)
        self.world = None

    def _index(self) -> None:
        """Spatial indexes per pool, so a deer looking for predators scans only predators."""
        self.by_id = {}
        self._grid = {}
        self._pools: dict[str, dict] = {}
        for o in (*self.animals, *self.humans):
            self.by_id[o.id] = o
            cell = (int(o.x // CELL_M), int(o.y // CELL_M))
            self._grid.setdefault(cell, []).append(o)
            sp = getattr(o, "sp", "human")
            pools = ["sp:" + sp, "humans" if sp == "human" else "animals"]
            if sp in SPECIES and SPECIES[sp].diet == "meat":
                pools.append("predators")
            for pool in pools:
                self._pools.setdefault(pool, {}).setdefault(cell, []).append(o)

    # ------------------------------------------------------------------ queries used by minds
    def nearest(self, x: float, y: float, r: float, ok: Callable, pool: str = "") -> object | None:
        """Closest object within r passing ``ok`` (ties broken by id). ``pool`` narrows the search:
        "predators", "animals", "humans" or "sp:<species>"."""
        grid = self._pools.get(pool, {}) if pool else self._grid
        if not grid:
            return None
        best, bd = None, r
        c = int(math.ceil(r / CELL_M))
        cx, cy = int(x // CELL_M), int(y // CELL_M)
        for j in range(cy - c, cy + c + 1):
            for i in range(cx - c, cx + c + 1):
                for o in grid.get((i, j), ()):
                    if o.id in self._dead:
                        continue
                    d = math.hypot(o.x - x, o.y - y)
                    if d <= bd and (best is None or d < bd or o.id < best.id) and ok(o):
                        best, bd = o, d
        return best

    def people_near(self, h: Human, r: float) -> list[Human]:
        out = []
        c = int(math.ceil(r / CELL_M))
        cx, cy = int(h.x // CELL_M), int(h.y // CELL_M)
        grid = self._pools.get("humans", {})
        for j in range(cy - c, cy + c + 1):
            for i in range(cx - c, cx + c + 1):
                for o in grid.get((i, j), ()):
                    if o is not h and o.id not in self._dead and math.hypot(o.x - h.x, o.y - h.y) <= r:
                        out.append(o)
        return sorted(out, key=lambda o: o.id)

    def children_near(self, h: Human) -> Iterable[Human]:
        return [p for p in self.people_near(h, 1000.0) if h.id in (p.mother, p.father) and p.age_d < 10 * 360]

    def crowding(self, a: Animal) -> float:
        """Conspecifics per km² within 2.5 km."""
        n = 0
        cx, cy = int(a.x // CELL_M), int(a.y // CELL_M)
        grid = self._pools.get("sp:" + a.sp, {})
        for j in range(cy - 2, cy + 3):
            for i in range(cx - 2, cx + 3):
                for o in grid.get((i, j), ()):
                    if o.id not in self._dead and math.hypot(o.x - a.x, o.y - a.y) < 2500:
                        n += 1
        return n / (math.pi * 2.5 ** 2)

    def local_food(self, a: Animal) -> float:
        """0..1.5 — how much the ground can feed (plant eaters: vegetation; meat eaters: prey nearby)."""
        sp = SPECIES[a.sp]
        if sp.diet == "plants":
            return min(1.5, self.hab.at(self.hab.biomass, a.x, a.y) / 8.0)
        prey = 0
        c = int(15000 // CELL_M) + 1
        cx, cy = int(a.x // CELL_M), int(a.y // CELL_M)
        for s in sp.prey:
            grid = self._pools.get("sp:" + s, {})
            for j in range(cy - c, cy + c + 1):
                for i in range(cx - c, cx + c + 1):
                    prey += len(grid.get((i, j), ()))
        return min(1.5, prey / 40.0)

    def catchable(self, o) -> bool:
        return not getattr(o, "in_shelter", False)

    def greener(self, x: float, y: float) -> tuple[float, float]:
        hab = self.hab
        i, j = hab.tile_of(x, y)
        best, bi, bj = hab.biomass[j, i], i, j
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                a, b = i + di, j + dj
                if 0 <= a < hab.w and 0 <= b < hab.h and hab.land[b, a] and hab.biomass[b, a] > best:
                    best, bi, bj = hab.biomass[b, a], a, b
        if (bi, bj) == (i, j):  # nothing greener in sight: set off to search
            ang = (x * 0.001 + y * 0.0007 + self.tick * 0.37) % (2 * math.pi)
            return (x + math.cos(ang) * 6000.0, y + math.sin(ang) * 6000.0)
        return ((bi + 0.5) * hab.tile, (bj + 0.5) * hab.tile)

    def wander(self, o, rng, dist: float) -> tuple[float, float]:
        ang = float(rng.uniform(0, 2 * math.pi))
        tx, ty = o.x + math.cos(ang) * dist, o.y + math.sin(ang) * dist
        hx, hy = getattr(o, "home_x", 0.0), getattr(o, "home_y", 0.0)
        if hx and math.hypot(o.x - hx, o.y - hy) > 15000.0:  # drift back toward the home range
            tx, ty = (tx + hx) / 2, (ty + hy) / 2
        return tx, ty

    def move(self, o, target: tuple[float, float], metres: float) -> None:
        dx, dy = target[0] - o.x, target[1] - o.y
        d = math.hypot(dx, dy)
        if d < 1e-6:
            return
        step = min(metres, d)
        ang = math.atan2(dy, dx)
        # walk around water and coastlines: try the direct heading, then turn progressively further
        for turn in (0.0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8):
            for frac in (1.0, 0.5, 0.25):
                nx = o.x + math.cos(ang + turn) * step * frac
                ny = o.y + math.sin(ang + turn) * step * frac
                if self.hab.is_land(nx, ny):
                    o.x, o.y = nx, ny
                    return

    # ------------------------------------------------------------------ effects on the world
    def eat_plants(self, x: float, y: float, kg: float) -> None:
        i, j = self.hab.tile_of(x, y)
        area = self.hab.tile ** 2
        b = self.world.f["biomass"]
        take = min(kg / area, float(b[j, i]))
        b[j, i] -= take
        self.ledger["plants_eaten_kg"] += take * area

    def die(self, o, cause: str) -> None:
        if o.id in self._dead:
            return
        self._dead.add(o.id)
        kind = getattr(o, "sp", "human")
        self.stats["deaths"].setdefault(kind, {}).setdefault(cause, 0)
        self.stats["deaths"][kind][cause] += 1
        mass = SPECIES[kind].mass_kg if kind in SPECIES else 60.0
        i, j = self.hab.tile_of(o.x, o.y)
        if self.hab.land[j, i]:
            self.world.f["organic_matter"][j, i] += mass / self.hab.tile ** 2
            self.ledger["bodies_to_soil_kg"] += mass
        if isinstance(o, Human):
            self._events.append({"tick": self.tick, "kind": "human_death", "x": i, "y": j,
                                 "message": f"{o.name} died ({cause}) aged {o.age_d / 360:.0f}"})
            for other in self.humans:
                if other.id in (o.partner, o.mother, o.father) or o.id in (other.mother, other.father, other.partner):
                    other.remember(self.tick, f"{o.name} died ({cause})")
                    if other.partner == o.id:
                        other.partner = 0

    def attack(self, pred: Animal, prey, rng) -> None:
        sp = SPECIES[pred.sp]
        if isinstance(prey, Human):
            if rng.random() > 0.35:
                return  # most approaches end without an attack: big cats are wary of people
            shelter = self.structures.get(prey.shelter) if prey.shelter else None
            protect = shelter["quality"] if shelter and shelter.get("done") and \
                math.hypot(shelter["x"] - prey.x, shelter["y"] - prey.y) < 300 else 0.0
            group = len([p for p in self.people_near(prey, 400.0) if p.age_d > 15 * 360])
            p = min(0.6, sp.danger_to_humans * 2.0 * (1.0 - protect) / (1.0 + group) * (1.0 - 0.4 * prey.fear))
            self.stats["attacks_on_humans"] += 1
            i, j = self.hab.tile_of(prey.x, prey.y)
            if rng.random() < p:
                prey.health -= 0.75
                if prey.health <= 0:
                    self.stats["humans_killed"] += 1
                    pred.energy = min(1.0, pred.energy + 0.7)
                    self.die(prey, f"killed by a {pred.sp}")
                    for o in self.people_near(prey, 2500.0):
                        o.fear_of[pred.sp] = min(1.0, max(o.fear_of.get(pred.sp, 0.25), 0.5) + 0.3)
                        o.note_place("danger", pred.x, pred.y, self.tick, pred.sp)
                        o.remember(self.tick, f"A {pred.sp} killed {prey.name}")
                    return
                prey.remember(self.tick, f"A {pred.sp} attacked and wounded me")
            else:
                prey.remember(self.tick, f"A {pred.sp} attacked me" + (" at my shelter" if protect else "") + "; I escaped")
            prey.fear = 1.0
            prey.fear_of[pred.sp] = min(1.0, prey.fear_of.get(pred.sp, 0.25) + 0.4)
            prey.note_place("danger", pred.x, pred.y, self.tick, pred.sp)
            self._events.append({"tick": self.tick, "kind": "attack", "x": i, "y": j,
                                 "message": f"A {pred.sp} attacked {prey.name}"})
            return
        psp = SPECIES[prey.sp]
        # most hunts fail (wolves ~15 %, big cats ~20 %); herds are vigilant; faster, warier prey escape more
        herd = 0
        if psp.group:
            herd = sum(1 for o in self._pools.get("sp:" + prey.sp, {}).get((int(prey.x // CELL_M), int(prey.y // CELL_M)), ())
                       if o is not prey and o.id not in self._dead)
        p = (0.2 + 1.0 * (pred.speed_gene - prey.speed_gene) - 0.15 * prey.wariness + 0.1 * prey.fatigue
             - 0.02 * min(herd, 6))
        if rng.random() < min(0.5, max(0.03, p)):
            pred.energy = min(1.0, pred.energy + min(0.8, psp.mass_kg / (sp.mass_kg * sp.intake_frac_day * 6)))
            self.die(prey, f"killed by a {pred.sp}")
        else:
            prey.wariness = min(1.0, prey.wariness + 0.25)  # survivors become warier (learning)
            prey.danger = (prey.danger + [[pred.x, pred.y, self.tick]])[-3:]

    def give_birth(self, mother: Animal, rng) -> None:
        sp = SPECIES[mother.sp]
        n = max(1, int(rng.poisson(sp.litter)))
        if len(self.animals) + n > MAX_ANIMALS:
            self.stats["births_capped"] = self.stats.get("births_capped", 0) + n
            mother.last_birth_d = mother.age_d
            return
        mother.last_birth_d = mother.age_d
        mother.energy -= 0.15
        for _ in range(n):
            kid = Animal(id=self.next_id, sp=sp.name, x=mother.x, y=mother.y, sex=int(rng.integers(0, 2)), age_d=0.0,
                         energy=0.7, hydration=0.8, home_x=mother.x, home_y=mother.y, parent=mother.id,
                         generation=mother.generation + 1,
                         speed_gene=float(max(0.6, mother.speed_gene * (1.0 + rng.normal(0, 0.03)))),
                         size_gene=float(max(0.6, mother.size_gene * (1.0 + rng.normal(0, 0.03)))),
                         wariness=0.5 * mother.wariness + 0.1)
            self.next_id += 1
            self.animals.append(kid)
        self.stats["births"][sp.name] = self.stats["births"].get(sp.name, 0) + n

    def human_birth(self, mother: Human, father: Human, rng) -> None:
        kid = Human(id=self.next_id, name=make_name(int(rng.integers(0, 2**31))), sex=int(rng.integers(0, 2)),
                    x=mother.x, y=mother.y, age_d=0.0, energy=0.9, hydration=0.9, mother=mother.id, father=father.id,
                    generation=max(mother.generation, father.generation) + 1, shelter=mother.shelter)
        # children start with little skill; they learn by being taught and by practice
        kid.skills = {k: 0.1 * (mother.skills[k] + father.skills[k]) / 2 for k in mother.skills}
        self.next_id += 1
        self.humans.append(kid)
        mother.last_birth_d = mother.age_d
        mother.energy -= 0.2
        self.stats["births"]["human"] = self.stats["births"].get("human", 0) + 1
        for p in (mother, father):
            p.remember(self.tick, f"Our child {kid.name} was born")
        i, j = self.hab.tile_of(kid.x, kid.y)
        self._events.append({"tick": self.tick, "kind": "human_birth", "x": i, "y": j,
                             "message": f"{kid.name} was born to {mother.name} and {father.name}"})

    def build(self, h: Human, rng) -> None:
        s = self.structures.get(h.shelter) if h.shelter else None
        threat = h.threat_level(self.tick)
        if s is None or (s.get("done") and s["quality"] < 0.35 + 0.5 * threat and
                         math.hypot(s["x"] - h.x, s["y"] - h.y) > 300):
            if s is not None and s.get("done"):
                pass  # improve in place below once back home
            else:
                sid = self.next_id
                self.next_id += 1
                s = {"id": sid, "kind": "shelter", "x": h.x, "y": h.y, "owner": h.id, "progress": 0.0,
                     "done": False, "quality": 0.0, "started_tick": self.tick, "builders": [h.id]}
                self.structures[sid] = s
                h.shelter = sid
                if h.partner and h.partner in self.by_id:
                    self.by_id[h.partner].shelter = sid
                h.remember(self.tick, "Began building a shelter")
        if math.hypot(s["x"] - h.x, s["y"] - h.y) > 300:
            self.move(h, (s["x"], s["y"]), 4000.0)
            return
        wood = 25.0  # kg of wood per labour hour
        i, j = self.hab.tile_of(h.x, h.y)
        area = self.hab.tile ** 2
        b = self.world.f["biomass"]
        take = min(wood / area, float(b[j, i]))
        b[j, i] -= take
        self.ledger["wood_cut_kg"] += take * area
        if h.id not in s["builders"]:
            s["builders"].append(h.id)
        stone = self.hab.stone[j, i] > 0
        skill = h.skills["build"]
        if not s["done"]:
            s["progress"] += 1.0
            if s["progress"] >= SHELTER_LABOUR_H:
                s["done"] = True
                s["quality"] = round(min(0.95, 0.3 + 0.55 * skill + (0.1 if stone else 0.0)), 4)
                s["built_tick"] = self.tick
                self.stats["shelters_built"] += 1
                h.remember(self.tick, f"Finished a shelter (quality {s['quality']:.2f})")
                self._events.append({"tick": self.tick, "kind": "shelter_built", "x": i, "y": j,
                                     "message": f"{h.name} finished a shelter (quality {s['quality']:.2f})"})
        else:  # improving an existing shelter: quality rises with skill and effort
            target = min(0.95, 0.4 + 0.55 * skill + (0.1 if stone else 0.0))
            s["quality"] = round(min(target, s["quality"] + 0.01 + 0.02 * skill), 4)
        h.skills["build"] = min(1.0, skill + 0.012 * (1.0 - skill))

    def has_something_to_teach(self, h: Human, people: list[Human]) -> bool:
        return any(h.skills[k] - p.skills[k] > 0.1 for p in people for k in h.skills)

    def teach(self, h: Human, people: list[Human]) -> None:
        for p in people:
            for k in h.skills:
                gap = h.skills[k] - p.skills[k]
                if gap > 0.05:
                    p.skills[k] += 0.1 * gap
                    if h.id not in p.taught_by:
                        p.taught_by = (p.taught_by + [h.id])[-5:]
                        p.remember(self.tick, f"{h.name} taught me")
            for kind in ("water", "danger"):
                for pl in h.places[kind]:
                    p.note_place(kind, pl[0], pl[1], pl[2], pl[3] if len(pl) > 3 else "")

    # ------------------------------------------------------------------ observation
    def summary(self) -> dict:
        by: dict[str, int] = {}
        for a in self.animals:
            by[a.sp] = by.get(a.sp, 0) + 1
        adults = [h for h in self.humans if h.age_d >= 15 * 360]
        return {
            "life_version": LIFE_VERSION,
            "animals": by,
            "animals_total": len(self.animals),
            "humans": len(self.humans),
            "humans_adult": len(adults),
            "families": len({tuple(sorted((h.id, h.partner))) for h in self.humans if h.partner}),
            "shelters": sum(1 for s in self.structures.values() if s.get("done")),
            "shelters_in_progress": sum(1 for s in self.structures.values() if not s.get("done")),
            "mean_skills": {k: round(float(np.mean([h.skills[k] for h in adults])), 3) for k in ("forage", "hunt", "build", "tools")} if adults else {},
            "births": self.stats["births"],
            "deaths": self.stats["deaths"],
            "attacks_on_humans": self.stats["attacks_on_humans"],
            "births_capped": self.stats.get("births_capped", 0),
            "max_animals": MAX_ANIMALS,
            "humans_killed": self.stats["humans_killed"],
            "ledger": self.ledger,
            "insects_note": "each insect agent is a colony of many individuals",
        }

    def agents(self) -> dict:
        return {
            "animals": [[a.id, a.sp, round(a.x, 1), round(a.y, 1), a.action] for a in self.animals],
            "humans": [[h.id, h.name, round(h.x, 1), round(h.y, 1), h.action, round(h.age_d / 360, 1)] for h in self.humans],
            "structures": [[s["id"], s["kind"], round(s["x"], 1), round(s["y"], 1), s["quality"], s["done"]]
                           for s in self.structures.values()],
        }

    def describe_agent(self, aid: int) -> Optional[dict]:
        for o in (*self.animals, *self.humans):
            if o.id == aid:
                d = o.to_dict()
                d["kind"] = "human" if isinstance(o, Human) else "animal"
                return d
        s = self.structures.get(aid)
        return dict(s, kind="structure") if s else None
