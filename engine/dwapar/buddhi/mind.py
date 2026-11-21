"""Human minds. Every human is an individual with needs, emotions, memory, learning and a family.

The decision each hour is a utility choice over behaviours, computed from *this* person's
perception, needs, memories, learned fears and skills. Nothing is scripted for an individual and
no technology tree exists (CONSTITUTION Art. IV):
* skills (foraging, hunting, building, tool-making) are continuous numbers that grow only through
  practice and through being taught by someone more skilled;
* a shelter is a physical structure built from wood taken from the tile's vegetation (and stone
  where there is stone); its quality comes from the builder's skill at that moment;
* fear of a species is learned from experience (one's own encounters, or being told by others),
  starting from a mild innate wariness of large predators.

The canonical example: a human who meets a tiger sees it, fears it, runs (toward a shelter or
other people if there are any), remembers the place and the species, tells the people near them,
and — because the remembered threat raises the value of shelter — later builds or improves one.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from ..prana.life import Life

SYLL = ("ka", "ri", "ta", "mo", "an", "su", "ve", "la", "do", "ni", "ar", "ye", "bu", "sha", "ol", "pe")
INNATE_FEAR = 0.25          # mild wariness of any large carnivore never met before
SHELTER_LABOUR_H = 30.0     # person-hours to complete a basic shelter


def make_name(seed_int: int) -> str:
    s = seed_int
    parts = []
    for _ in range(2 + s % 2):
        parts.append(SYLL[s % len(SYLL)])
        s //= len(SYLL)
    return "".join(parts).capitalize()


@dataclass
class Human:
    id: int
    name: str
    sex: int
    x: float
    y: float
    age_d: float
    energy: float = 0.8
    hydration: float = 0.9
    fatigue: float = 0.2
    fear: float = 0.0
    loneliness: float = 0.0
    health: float = 1.0
    partner: int = 0
    mother: int = 0
    father: int = 0
    generation: int = 0
    skills: dict = field(default_factory=lambda: {"forage": 0.2, "hunt": 0.05, "build": 0.0, "tools": 0.0})
    fear_of: dict = field(default_factory=dict)        # species → learned fear 0..1
    places: dict = field(default_factory=lambda: {"water": [], "food": [], "danger": []})
    episodes: list = field(default_factory=list)       # [tick, text]
    shelter: int = 0
    in_shelter: bool = False
    last_birth_d: float = -1e9
    starving_h: float = 0.0
    action: str = "wake"
    taught_by: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

    # ------------------------------------------------------------------ memory
    def remember(self, tick: int, text: str) -> None:
        if self.episodes and self.episodes[-1][1] == text:
            return
        self.episodes.append([tick, text])
        if len(self.episodes) > 40:
            self.episodes = self.episodes[-40:]

    def note_place(self, kind: str, x: float, y: float, tick: int, extra: str = "") -> None:
        lst = self.places[kind]
        for p in lst:
            if math.hypot(p[0] - x, p[1] - y) < 2500.0 and (len(p) < 4 or p[3] == extra):
                p[0], p[1], p[2] = x, y, tick
                return
        lst.append([x, y, tick, extra] if extra else [x, y, tick])
        if len(lst) > 8:
            lst.sort(key=lambda p: p[2])
            del lst[0]

    def threat_level(self, tick: int) -> float:
        """How dangerous this person believes the world is: learned fears and recent danger."""
        recent = sum(1 for d in self.places["danger"] if tick - d[2] < 24 * 120)
        return min(1.0, max(self.fear_of.values(), default=0.0) * 0.8 + 0.15 * recent)

    def danger_near(self, x: float, y: float, tick: int, radius: float = 3500.0) -> list | None:
        for d in self.places["danger"]:
            if tick - d[2] < 24 * 60 and math.hypot(d[0] - x, d[1] - y) < radius:
                return d
        return None


def _toward(h: Human, tx: float, ty: float) -> tuple[float, float]:
    return tx, ty


def step_human(h: Human, life: "Life", hour: int, rng) -> None:
    from ..prana.species import SPECIES
    hab = life.hab
    tick = life.tick
    night = hour >= 20 or hour < 5
    temp = hab.at(hab.temp, h.x, h.y)
    adult = h.age_d >= 15 * 360
    child = h.age_d < 10 * 360
    h.age_d += 1.0 / 24.0

    # ---- body
    shelter = life.structures.get(h.shelter) if h.shelter else None
    sheltered = shelter is not None and math.hypot(shelter["x"] - h.x, shelter["y"] - h.y) < 300.0
    cold = max(0.0, 12.0 - temp) / 25.0 * (0.3 if sheltered else 1.0)
    h.energy -= 0.0045 * (1.0 + cold)
    h.hydration -= 0.018 * (1.0 + max(0.0, temp - 28.0) / 15.0)
    h.fatigue = min(1.0, h.fatigue + (0.012 if night else 0.03))
    h.fear *= 0.8
    h.loneliness = min(1.0, h.loneliness + 0.01)
    h.in_shelter = False

    # ---- perceive (sight shrinks in dense forest)
    sight = 900.0 * (1.0 - 0.45 * hab.at(hab.forest, h.x, h.y))
    pred = life.nearest(h.x, h.y, sight, lambda o: SPECIES[o.sp].mass_kg >= 30, pool="predators")
    people = life.people_near(h, 3000.0)
    if people:
        h.loneliness = max(0.0, h.loneliness - 0.08 * len(people))
    if hab.near_water(h.x, h.y):
        h.note_place("water", h.x, h.y, tick)
    if hab.at(hab.biomass, h.x, h.y) > 3.0:
        h.note_place("food", h.x, h.y, tick)

    if pred is not None:
        learned = h.fear_of.get(pred.sp, INNATE_FEAR)
        dist = math.hypot(pred.x - h.x, pred.y - h.y)
        h.fear = max(h.fear, min(1.0, learned + 0.6 * (1.0 - dist / sight)))
        if h.fear > 0.3:
            first = pred.sp not in h.fear_of
            h.fear_of[pred.sp] = min(1.0, learned + 0.1)
            h.note_place("danger", pred.x, pred.y, tick, pred.sp)
            h.remember(tick, f"Saw a {pred.sp} {dist:.0f} m away" + (" — the first I have ever seen" if first else ""))

    # ---- choose
    u: dict[str, float] = {}
    if pred is not None and h.fear > 0.3:
        u["flee"] = 1.5 + h.fear
    u["drink"] = (1.0 - h.hydration) ** 1.5 * 2.0 + (1.5 if h.hydration < 0.25 else 0.0)  # thirst overrides plans
    u["eat"] = (1.0 - h.energy) ** 1.5 * 1.8 + (1.0 if h.energy < 0.2 else 0.0)
    u["sleep"] = (h.fatigue ** 2) * (1.6 if night else 0.6)
    threat = h.threat_level(tick)
    if adult and not night:
        need_shelter = shelter is None or shelter["quality"] < 0.35 + 0.5 * threat
        if need_shelter:
            # value of shelter: innate (cold nights) + learned threat + exposure felt last night
            u["build"] = 0.12 + 0.75 * threat + 0.3 * cold
    if adult and h.loneliness > 0.5:
        u["seek people"] = h.loneliness * 0.7
    if people and adult and not night:
        u["teach"] = 0.15 if life.has_something_to_teach(h, people) else 0.0
    u["explore"] = 0.1
    action = max(sorted(u), key=lambda k: u[k])
    h.action = action

    walk = 4000.0 * (0.5 if child else 1.0) * (0.6 + 0.4 * h.health)
    if action == "flee":
        # run away from the predator, toward safety if safety is known and not behind it
        refuge = None
        if shelter is not None:
            refuge = (shelter["x"], shelter["y"])
        elif people:
            far = [p for p in people if math.hypot(p.x - pred.x, p.y - pred.y) > math.hypot(h.x - pred.x, h.y - pred.y)]
            if far:
                refuge = (far[0].x, far[0].y)
        dx, dy = h.x - pred.x, h.y - pred.y
        d = math.hypot(dx, dy) or 1.0
        run = walk * 2.2
        if refuge is not None and (refuge[0] - h.x) * dx + (refuge[1] - h.y) * dy > 0:
            life.move(h, refuge, run)
        else:
            life.move(h, (h.x + dx / d * run, h.y + dy / d * run), run)
        h.fatigue = min(1.0, h.fatigue + 0.15)
        h.remember(tick, f"Ran from a {pred.sp}")
        for p in people:  # alarm: others learn of the danger by being told
            p.fear_of[pred.sp] = max(p.fear_of.get(pred.sp, INNATE_FEAR), h.fear_of[pred.sp] * 0.7)
            p.note_place("danger", pred.x, pred.y, tick, pred.sp)
            p.remember(tick, f"{h.name} warned me of a {pred.sp}")
    elif action == "drink":
        if hab.near_water(h.x, h.y):
            h.hydration = 1.0
        else:
            # water within sight (river valleys and green ground show from ~10 km), else memory, else ask
            # the people nearby, else low ground, else search in a widening wander
            tgt = hab.water_step(h.x, h.y, 5.0) or _recall(h, "water", tick)
            if tgt is None:
                for p in people:
                    if p.places["water"]:
                        w0 = min(p.places["water"], key=lambda q: math.hypot(q[0] - h.x, q[1] - h.y))
                        h.note_place("water", w0[0], w0[1], w0[2])
                        h.remember(tick, f"{p.name} told me where to find water")
                        tgt = (w0[0], w0[1])
                        break
            if tgt is None:
                low = hab.downhill(h.x, h.y)
                if hab.tile_of(*low) != hab.tile_of(h.x, h.y):
                    tgt = low
                else:
                    tgt = life.wander(h, rng, walk * 3)
            life.move(h, _avoid(h, tgt, tick), walk)
    elif action == "eat":
        avail = hab.at(hab.biomass, h.x, h.y)
        prey = life.nearest(h.x, h.y, 1200.0, lambda o: o.sp in ("rabbit", "deer"), pool="animals")
        if prey is not None and h.energy < 0.6 and adult:
            p_hit = 0.08 + 0.35 * h.skills["hunt"] + 0.2 * h.skills["tools"]
            life.move(h, (prey.x, prey.y), walk)
            if rng.random() < p_hit:
                gain = 0.9 if prey.sp == "deer" else 0.35
                life.die(prey, "hunted by humans")
                h.energy = min(1.0, h.energy + gain)
                for p in people:  # food is shared with those nearby
                    p.energy = min(1.0, p.energy + gain * 0.5)
                h.remember(tick, f"Hunted a {prey.sp}")
                _practice(h, "hunt", 0.04)
            else:
                _practice(h, "hunt", 0.01)
        elif avail > 0.5:
            yield_ = 0.06 + 0.12 * h.skills["forage"] + 0.06 * h.skills["tools"]
            life.eat_plants(h.x, h.y, 1.5)
            h.energy = min(1.0, h.energy + yield_ * min(1.0, avail / 4.0))
            _practice(h, "forage", 0.005)
            if hab.at(hab.stone, h.x, h.y) > 0:
                _practice(h, "tools", 0.002)  # shaping stones while gathering
            for c in life.children_near(h):
                c.energy = min(1.0, c.energy + 0.05)
        else:
            tgt = _recall(h, "food", tick) or life.greener(h.x, h.y)
            life.move(h, _avoid(h, tgt, tick), walk)
    elif action == "sleep":
        if shelter is not None and not sheltered and math.hypot(shelter["x"] - h.x, shelter["y"] - h.y) < 6000.0:
            life.move(h, (shelter["x"], shelter["y"]), walk)
        else:
            h.fatigue = max(0.0, h.fatigue - 0.12)
            h.in_shelter = sheltered
    elif action == "build":
        if hab.at(hab.biomass, h.x, h.y) < 2.0:
            life.move(h, _avoid(h, life.greener(h.x, h.y), tick), walk)
        else:
            life.build(h, rng)
    elif action == "seek people":
        other = life.nearest(h.x, h.y, 40000.0, lambda o: o is not h, pool="humans")
        if other is not None:
            life.move(h, (other.x, other.y), walk)
    elif action == "teach":
        life.teach(h, people)
    elif h.partner and h.partner in life.by_id and math.hypot(life.by_id[h.partner].x - h.x, life.by_id[h.partner].y - h.y) > 1500 and action == "explore":
        p = life.by_id[h.partner]
        life.move(h, (p.x, p.y), walk)
        h.action = "join partner"
    else:  # explore: wander, but never back into remembered danger
        tgt = life.wander(h, rng, walk * 0.7)
        life.move(h, _avoid(h, tgt, tick), walk * 0.7)
        if child:
            mom = life.by_id.get(h.mother)
            if mom is not None:
                life.move(h, (mom.x, mom.y), walk)

    if night and sheltered:
        h.in_shelter = True

    # ---- family
    if adult and not h.partner and not night:
        mate = life.nearest(h.x, h.y, 3000.0, lambda o: o is not h
                            and o.sex != h.sex and not o.partner and o.age_d >= 15 * 360
                            and o.id not in (h.mother, h.father) and h.id not in (o.mother, o.father), pool="humans")
        if mate is not None and h.loneliness + mate.loneliness > 0.3:
            h.partner, mate.partner = mate.id, h.id
            h.remember(tick, f"Became partners with {mate.name}")
            mate.remember(tick, f"Became partners with {h.name}")
            # a couple shares one home: the better of their shelters
            homes = [life.structures[s] for s in (h.shelter, mate.shelter) if s in life.structures]
            if homes:
                best = max(homes, key=lambda s: (s.get("done", False), s["quality"], -s["id"]))
                h.shelter = mate.shelter = best["id"]
    if (h.sex == 1 and h.partner and 16 * 360 <= h.age_d <= 42 * 360 and h.energy > 0.6
            and h.age_d - h.last_birth_d > 2.5 * 360 and night and rng.random() < 0.004):
        p = life.by_id.get(h.partner)
        if p is not None and math.hypot(p.x - h.x, p.y - h.y) < 2000.0:
            life.human_birth(h, p, rng)

    # ---- death
    if h.energy <= 0 or h.hydration <= 0:
        h.starving_h += 1
        h.energy, h.hydration = max(h.energy, 0.0), max(h.hydration, 0.0)
        h.health = max(0.0, h.health - 0.01)
        if h.starving_h > (48 if h.hydration <= 0 else 400):
            life.die(h, "thirst" if h.hydration <= 0 else "starvation")
            return
    else:
        h.starving_h = 0.0
        h.health = min(1.0, h.health + 0.002)
    if h.health <= 0:
        life.die(h, "wounds")
        return
    if h.age_d > 45 * 360 and rng.random() < math.exp((h.age_d / 360 - 80) / 8.0) * 0.0004:
        life.die(h, "old age")


def _practice(h: Human, skill: str, rate: float) -> None:
    h.skills[skill] = min(1.0, h.skills[skill] + rate * (1.0 - h.skills[skill]))


def _recall(h: Human, kind: str, tick: int):
    best = None
    for p in h.places[kind]:
        if best is None or math.hypot(p[0] - h.x, p[1] - h.y) < math.hypot(best[0] - h.x, best[1] - h.y):
            best = p
    return (best[0], best[1]) if best is not None else None


def _avoid(h: Human, tgt, tick: int):
    """Steer a destination away from remembered danger (learned avoidance)."""
    if tgt is None:
        return (h.x, h.y)
    d = h.danger_near(tgt[0], tgt[1], tick)
    if d is None:
        return tgt
    dx, dy = tgt[0] - d[0], tgt[1] - d[1]
    n = math.hypot(dx, dy) or 1.0
    return (d[0] + dx / n * 4000.0, d[1] + dy / n * 4000.0)
