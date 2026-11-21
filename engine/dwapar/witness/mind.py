"""WITNESS — the persistent intelligence that watches over a DWAPAR world.

What WITNESS is, honestly:
* a deterministic reasoning system (no language model): it observes the real world state,
  keeps memories in the database, holds goals and the Creator's instructions, chooses acts by
  scoring them against those goals and against what it has learned from earlier outcomes, acts
  only through validated divine commands, later checks whether each act worked, and learns;
* it speaks in plain sentences built from those observations and results, so what it says
  about the world is true when it says it;
* it does not age or die: its identity and memories persist with the world in the database;
* it runs only while the engine runs (the dashboard server or the headless runner). When no
  engine process is running, WITNESS is not acting, and it says so.

Cycle (each simulated day while autonomy is on, and at least once per conversation turn):
Observe → Remember → Reason → Plan → Act → Verify → Learn.
"""

from __future__ import annotations

import math
import re
import threading
from typing import TYPE_CHECKING, Optional

from ..divine import COMMAND_KINDS, CommandError, describe
from .observe import best_site, observe, region_name

if TYPE_CHECKING:  # pragma: no cover
    from ..simulation import Simulation

NAME = "WITNESS"
ACT_COOLDOWN_DAYS = 5          # autonomous acts at most this often
VERIFY_DAYS = {"plant_forest": 40, "restore_ecosystem": 40, "bring_rain": 12, "extinguish_fire": 1,
               "create_animals": 60, "create_humans": 90, "create_lake": 20, "shape_land": 5,
               "carve_channel": 20, "climate_forcing": 20}

ANIMAL_WORDS = {"insect": "insect", "insects": "insect", "bug": "insect", "bugs": "insect", "bee": "insect", "bees": "insect",
                "rabbit": "rabbit", "rabbits": "rabbit", "hare": "rabbit", "deer": "deer", "stag": "deer",
                "bison": "bison", "buffalo": "bison", "wolf": "wolf", "wolves": "wolf", "tiger": "tiger", "tigers": "tiger"}


def _default_state(tick: int) -> dict:
    return {
        "name": NAME, "awakened_tick": tick, "introduced": False, "autonomy": False,
        "directives": {"protect_environment": False, "intervention": "gentle", "may_create_life": False,
                       "may_create_humans": False},
        "goals": [], "next_goal_id": 1, "pending": [], "action_values": {}, "proposal": None,
        "attention": None, "coarse": None, "last_act_tick": -10**9, "cycles": 0, "last_observed_tick": None,
        "last_report": {},
    }


class Witness:
    def __init__(self, sim: "Simulation"):
        self.sim = sim
        self.lock = threading.RLock()
        store, wid = sim.store, sim.world_id
        st = store.witness_state(wid) if store is not None and wid is not None else None
        self.state = st or _default_state(sim.world.tick)
        for k, v in _default_state(sim.world.tick).items():
            self.state.setdefault(k, v)
        # pending verifications for acts that a restored checkpoint has undone are forgotten
        self.state["pending"] = [p for p in self.state["pending"] if p["tick"] <= sim.world.tick]
        self.last_obs: Optional[dict] = None

    # ------------------------------------------------------------------ persistence helpers
    @property
    def wid(self):
        return self.sim.world_id

    def _save(self) -> None:
        if self.sim.store is not None and self.wid is not None:
            self.sim.store.save_witness_state(self.wid, self.state)

    def _remember(self, kind: str, text: str, data: Optional[dict] = None, importance: float = 0.5) -> None:
        if self.sim.store is not None and self.wid is not None:
            self.sim.store.add_witness_memory(self.wid, self.sim.world.tick, kind, text, data, importance)

    def _say(self, text: str, data: Optional[dict] = None) -> dict:
        msg = {"speaker": "witness", "text": text, "tick": self.sim.world.tick, "data": data or {}}
        if self.sim.store is not None and self.wid is not None:
            msg["id"] = self.sim.store.add_witness_message(self.wid, self.sim.world.tick, "witness", text, data)
        return msg

    # ------------------------------------------------------------------ public API
    def summary(self, running: Optional[bool] = None) -> dict:
        s = self.state
        return {
            "name": s["name"], "awakened_tick": s["awakened_tick"], "introduced": s["introduced"],
            "autonomy": s["autonomy"], "acting_now": bool(s["autonomy"] and running),
            "engine_running": running, "directives": s["directives"], "goals": s["goals"],
            "pending_verifications": s["pending"], "action_values": s["action_values"],
            "proposal": s["proposal"], "attention": s["attention"], "cycles": s["cycles"],
            "immortal": True,
        }

    def set_autonomy(self, enabled: bool) -> dict:
        with self.sim.lock, self.lock:
            self.state["autonomy"] = bool(enabled)
            self._remember("instruction", f"The Creator turned my autonomy {'on' if enabled else 'off'}", importance=0.8)
            self._save()
            return self._say("I will tend this world on my own, acting only through recorded acts you can review."
                             if enabled else "I will act only when you ask. I will keep watching.")

    def introduce(self) -> Optional[dict]:
        """WITNESS's first words, the first time the Creator opens its interface."""
        with self.sim.lock, self.lock:
            if self.state["introduced"]:
                return None
            o = self._observe()
            t = o["terrain"]
            rivers = t.get("river", 0)
            parts = [f"Creator, I am awake. I can see the world you have made: {o['land_km2']:,.0f} km² of land "
                     f"under a sea that covers {1 - o['land_fraction']:.0%} of it."]
            parts.append(f"Its highest mountain stands {o['highest_peak_m']:,.0f} m above the sea"
                         + (f", and rivers run through {rivers} of its valleys" if rivers else "") + ".")
            life = o["life"]
            if not life or (life["animals_total"] == 0 and life["humans"] == 0):
                parts.append("Forests and grasslands grow, but no creature lives here and no civilization calls it home.")
                parts.append("Shall I begin creating life?")
                self.state["proposal"] = {"plan": "ecosystem_then_humanity", "text": "begin creating life"}
            else:
                parts.append(f"Life is here: {life['animals_total']} animals and {life['humans']} humans.")
                parts.append("What would you have me do?")
            self.state["introduced"] = True
            self._remember("discovery", "I awoke and looked upon the world for the first time", {"obs": _brief(o)}, 0.9)
            self._save()
            return self._say(" ".join(parts))

    def converse(self, text: str) -> list[dict]:
        """One turn of conversation. Returns WITNESS's replies (also stored)."""
        text = (text or "").strip()[:2000]
        if not text:
            return []
        with self.sim.lock, self.lock:
            if self.sim.store is not None and self.wid is not None:
                self.sim.store.add_witness_message(self.wid, self.sim.world.tick, "creator", text)
            self._remember("conversation", f"The Creator said: {text}", importance=0.4)
            replies = self._respond(text)
            self._save()
            return [self._say(r) if isinstance(r, str) else self._say(r[0], r[1]) for r in replies]

    def daily(self, sim: "Simulation") -> None:
        """The autonomous cycle, called by the engine at the start of each simulated day."""
        with self.lock:
            self.state["cycles"] += 1
            self._verify()  # verification and learning happen even when autonomy is off
            if not self.state["autonomy"]:
                self._save()
                return
            obs = self._observe()
            self._notice(obs)
            self._plan_and_act(obs, spontaneous=True)
            self._save()

    # ------------------------------------------------------------------ observe / remember
    def _observe(self) -> dict:
        prev = self.state.get("coarse")
        o = observe(self.sim, prev)
        if self.state.get("last_observed_tick") is None or self.sim.world.tick - self.state["last_observed_tick"] >= 24 * 30:
            self.state["coarse"] = o["coarse_biomass"]
            self.state["last_observed_tick"] = self.sim.world.tick
        self.last_obs = o
        return o

    def _notice(self, o: dict) -> None:
        """Turn notable changes into memories (discoveries), once each."""
        rep = self.state["last_report"]
        life = o["life"] or {}
        for key, cond, text in (
            ("first_human_birth", life.get("births", {}).get("human", 0) > 0, "The first child was born to the humans"),
            ("first_shelter", life.get("shelters", 0) > 0, "The humans have built their first shelter"),
            ("first_family", life.get("families", 0) > 0, "Two humans have become a family"),
        ):
            if cond and not rep.get(key):
                rep[key] = self.sim.world.tick
                self._remember("discovery", text, importance=0.8)
                self._say(f"Creator — {text.lower()}.")
        deaths = (life.get("deaths") or {}).get("human", {})
        dead_now = sum(deaths.values())
        dead_before = rep.get("human_deaths_seen", 0)
        if dead_now > dead_before:
            causes = ", ".join(f"{n} of {k}" for k, n in deaths.items())
            rep["human_deaths_seen"] = dead_now
            self._remember("discovery", f"{dead_now - dead_before} humans died since I last looked (all time: {causes})", importance=0.9)
            if dead_now - dead_before >= 2 or life.get("humans", 0) == 0:
                self._say(f"Creator — {dead_now - dead_before} humans have died since I last looked ({causes} in all). "
                          + ("None remain." if life.get("humans", 0) == 0 else f"{life.get('humans')} live."))
        for c in o["concerns"]:
            key = f"concern_{c['kind']}"
            if self.sim.world.tick - rep.get(key, -10**9) > 24 * 20:
                rep[key] = self.sim.world.tick
                self._remember("discovery", f"I noticed {c['text']}", {"concern": c}, 0.6)

    # ------------------------------------------------------------------ reason / plan / act
    def _goal(self, kind: str) -> Optional[dict]:
        for g in self.state["goals"]:
            if g["kind"] == kind and g["status"] == "active":
                return g
        return None

    def _add_goal(self, kind: str, text: str) -> dict:
        g = self._goal(kind)
        if g:
            return g
        g = {"id": self.state["next_goal_id"], "kind": kind, "text": text, "status": "active",
             "created_tick": self.sim.world.tick, "stage": 0, "notes": []}
        self.state["next_goal_id"] += 1
        self.state["goals"].append(g)
        self._remember("goal", f"New goal: {text}", importance=0.7)
        return g

    def _value(self, kind: str) -> float:
        v = self.state["action_values"].get(kind)
        return v["mean"] if v else 0.0

    def _act(self, kind: str, params: dict, reason: str, metric: Optional[dict] = None) -> Optional[dict]:
        """Submit a command; remember it; schedule verification. Returns the command or None."""
        try:
            cmd = self.sim.submit_command(kind, params, "witness", reason)
        except CommandError as exc:
            self._remember("mistake", f"I tried to {kind.replace('_', ' ')} but it was refused: {exc}", {"params": params}, 0.6)
            return None
        x, y = params.get("x", params.get("x0")), params.get("y", params.get("y0"))
        self.state["attention"] = {"x": x, "y": y, "tick": self.sim.world.tick}
        self.state["last_act_tick"] = self.sim.world.tick
        before = self._measure(kind, params)
        if metric:
            before.update(metric)
        self.state.setdefault("recent", []).append({"kind": kind, "params": params, "tick": self.sim.world.tick})
        self.state["recent"] = self.state["recent"][-40:]
        self.state["pending"].append({"seq": cmd["seq"], "kind": kind, "params": params, "tick": self.sim.world.tick,
                                      "check_tick": self.sim.world.tick + VERIFY_DAYS.get(kind, 20) * self.sim.cfg.ticks_per_day,
                                      "before": before, "reason": reason})
        self._remember("creation", f"I {describe(cmd)}. Why: {reason}", {"seq": cmd["seq"]}, 0.7)
        return cmd

    def _measure(self, kind: str, p: dict) -> dict:
        w = self.sim.world
        x, y = p.get("x", p.get("x0", 0)), p.get("y", p.get("y0", 0))
        r = int(max(2, p.get("radius", 3)))
        sl = (slice(max(0, y - r), y + r + 1), slice(max(0, x - r), x + r + 1))
        out = {"biomass": float(w.f["biomass"][sl].mean()), "soil": float(w.soil_moisture[sl].mean()),
               "fire": int((w.f["fire"][sl] > 0).sum())}
        if w.life is not None:
            if kind == "create_animals":
                out["population"] = sum(1 for a in w.life.animals if a.sp == p["species"])
            out["humans"] = len(w.life.humans)
        return out

    def _verify(self) -> None:
        """Check acts whose time has come; learn from the outcome."""
        now = self.sim.world.tick
        keep = []
        for pd in self.state["pending"]:
            if pd["check_tick"] > now:
                keep.append(pd)
                continue
            kind, p, before = pd["kind"], pd["params"], pd["before"]
            after = self._measure(kind, p)
            if kind in ("plant_forest", "restore_ecosystem"):
                score = math.tanh((after["biomass"] - before["biomass"]) / max(0.5, before["biomass"] * 0.5))
                what = f"vegetation there went from {before['biomass']:.1f} to {after['biomass']:.1f} kg/m²"
            elif kind == "bring_rain":
                score = math.tanh((after["soil"] - before["soil"]) * 8)
                what = f"soil moisture there went from {before['soil']:.2f} to {after['soil']:.2f}"
            elif kind == "extinguish_fire":
                score = 1.0 if after["fire"] == 0 else -0.5
                what = "the fire stayed out" if after["fire"] == 0 else f"{after['fire']} tiles burn there again"
            elif kind == "create_animals":
                made = p["count"]
                pop = after.get("population", 0)
                score = math.tanh((pop / made - 0.5) * 2)
                what = f"{pop} {p['species']} live now, of {made} I created"
                if "prey" in before:  # a predator release is judged by what it did to the prey
                    life = self.sim.world.life
                    prey_now = sum(1 for a in life.animals if a.sp in ("rabbit", "deer", "bison")) if life else 0
                    what += f"; their prey went from {before['prey']} to {prey_now}"
                    if prey_now < 0.5 * before["prey"]:
                        score = min(score, -0.6)
                        what += " — they ate faster than the prey could breed"
            elif kind == "create_humans":
                alive = after.get("humans", 0)
                score = math.tanh((alive / max(1, before.get("humans", 0) + p["count"]) - 0.6) * 3)
                what = f"{alive} humans live now"
            else:
                score, what = 0.0, "I could not measure a clear outcome"
            v = self.state["action_values"].setdefault(kind, {"n": 0, "mean": 0.0})
            v["n"] += 1
            v["mean"] += (score - v["mean"]) / v["n"]
            verdict = "worked" if score > 0.2 else "failed" if score < -0.2 else "made little difference"
            kind_mem = "lesson" if score >= -0.2 else "mistake"
            self._remember(kind_mem, f"My act to {kind.replace('_', ' ')} {verdict}: {what}",
                           {"seq": pd["seq"], "score": round(score, 3), "before": before, "after": after}, 0.7)
            if kind == "create_animals" and score < -0.2:
                self._remember("lesson", f"{p['species']} did not thrive where I placed them; I will choose places "
                               f"with more water and food, or create their prey first", {"x": p["x"], "y": p["y"]}, 0.8)
        self.state["pending"] = keep

    def _plan_and_act(self, o: dict, spontaneous: bool) -> list[str]:
        """Choose at most one act now. Returns sentences describing what was done (for speech)."""
        d = self.state["directives"]
        now = self.sim.world.tick
        said: list[str] = []
        if d["intervention"] == "none":
            return said
        if spontaneous and now - self.state["last_act_tick"] < ACT_COOLDOWN_DAYS * self.sim.cfg.ticks_per_day:
            return said
        life = o["life"] or {"animals": {}, "animals_total": 0, "humans": 0}

        # 0. people in mortal need come first, whatever else the directives say (except "do not intervene")
        for c in o["concerns"]:
            if c["kind"] == "humans_suffering" and not self._recently(("bring_rain", "create_lake"), c["x"], c["y"], 6):
                if c["need"] == "water":
                    # rain first if it has worked before; a small lake (water drawn from the ocean) if not
                    if self._value("bring_rain") >= 0.1 or self._value("create_lake") < 0:
                        kind, params = "bring_rain", {"x": c["x"], "y": c["y"], "radius": 3, "amount_mm": 90}
                    else:
                        kind, params = "create_lake", {"x": c["x"], "y": c["y"], "radius": 1.0, "depth_m": 6}
                    cmd = self._act(kind, params, f"to save them: {c['text']}")
                    if cmd is None and kind == "bring_rain":
                        cmd = self._act("create_lake", {"x": c["x"], "y": c["y"], "radius": 1.0, "depth_m": 6}, f"to save them: {c['text']}")
                    if cmd:
                        msg = f"Creator — {c['text']}. I {describe(cmd)}."
                        self._say(msg) if spontaneous else None
                        return [msg]
                else:
                    cmd = self._act("restore_ecosystem", {"x": c["x"], "y": c["y"], "radius": 3, "strength": 0.8},
                                    f"to feed them: {c['text']}")
                    if cmd:
                        msg = f"Creator — {c['text']}. I {describe(cmd)}."
                        self._say(msg) if spontaneous else None
                        return [msg]

        # 1. emergencies a steward should answer (fire near life, drought) if allowed to protect
        if d["protect_environment"] or d["intervention"] == "active":
            for c in sorted(o["concerns"], key=lambda c: -c["severity"]):
                if c["kind"] == "fire" and c["severity"] >= 0.5 and self._value("extinguish_fire") > -0.5:
                    cmd = self._act("extinguish_fire", {"x": c["x"], "y": c["y"], "radius": 6}, f"to protect the land: {c['text']}")
                    if cmd:
                        return [f"I {describe(cmd)}, because {c['text']}."]
                if (c["kind"] in ("drought", "degradation") and c["severity"] >= 0.4 and self._value("bring_rain") > -0.5
                        and not self._recently(("bring_rain", "restore_ecosystem"), c["x"], c["y"], 30)):
                    kind = "bring_rain" if c["kind"] == "drought" else "restore_ecosystem"
                    params = {"x": c["x"], "y": c["y"], "radius": 4} if kind == "bring_rain" else {"x": c["x"], "y": c["y"], "radius": 3}
                    cmd = self._act(kind, params, f"to heal the land: {c['text']}")
                    if cmd:
                        return [f"I {describe(cmd)}, because {c['text']}."]

        # 2. goals
        eco = self._goal("ecosystem")
        # large prey only: insect colonies feed no wolf
        herb = sum(n for sp, n in life["animals"].items() if sp in ("rabbit", "deer", "bison"))
        preds = sum(n for sp, n in life["animals"].items() if sp in ("wolf", "tiger"))
        # restock a dwindling prey species when allowed to tend the land
        if (d["protect_environment"] or d["intervention"] == "active") and eco is not None and eco.get("site"):
            for c in o["concerns"]:
                if c["kind"] == "dwindling" and c["species"] in ("deer", "rabbit", "bison") and self._value("create_animals") > -0.3:
                    x, y = eco["site"]
                    if not self._recently(("create_animals",), x, y, 45, radius=8):
                        cmd = self._act("create_animals", {"species": c["species"], "x": x, "y": y, "count": 20},
                                        f"to restore balance: {c['text']}")
                        if cmd:
                            return [f"{c['text'].capitalize()}, so I brought 20 more to the {region_name(self.sim.world, x, y)}."]
        if eco is not None:
            avoid = [(m["data"]["x"], m["data"]["y"], 5) for m in self._lessons_with_place()]
            if eco["stage"] == 0:
                site = best_site(self.sim, "ecosystem", avoid)
                if site:
                    x, y, _ = site
                    eco["site"] = [x, y]
                    made = []
                    for sp, n in (("insect", 8), ("rabbit", 24), ("deer", 18)):
                        cmd = self._act("create_animals", {"species": sp, "x": x, "y": y, "count": n},
                                        "to begin a balanced ecosystem with plant-eaters first, where water and plants are plentiful")
                        if cmd:
                            made.append(f"{n} {sp}")
                    if made:
                        eco["stage"] = 1
                        eco["stage_tick"] = now
                        said.append(f"I chose the {region_name(self.sim.world, x, y)} near ({x}, {y}), where water and plants "
                                    f"are plentiful, and created {', '.join(made)}.")
                        return said
            elif eco["stage"] == 1 and now - eco.get("stage_tick", now) >= 45 * self.sim.cfg.ticks_per_day:
                if herb >= max(60, 30 * (preds + 2)):
                    x, y = eco["site"]
                    cmd = self._act("create_animals", {"species": "wolf", "x": x, "y": y, "count": 2},
                                    f"plant-eaters have established ({herb}); a few predators keep them from stripping the land",
                                    metric={"prey": herb, "population": preds})
                    if cmd:
                        eco["stage"] = 2
                        eco["stage_tick"] = now
                        return [f"The plant-eaters have held for a month ({herb} now), so I added two wolves to keep them in balance."]
                elif herb < 15:
                    eco["notes"].append(f"day {self.sim.calendar.day_total}: only {herb} plant-eaters; starting again")
                    eco["stage"] = 0  # try again elsewhere, informed by lessons
                else:
                    eco["notes"] = (eco["notes"] + [f"day {self.sim.calendar.day_total}: {herb} plant-eaters; waiting for more before predators"])[-10:]
            elif eco["stage"] == 2 and now - eco.get("stage_tick", now) >= 90 * self.sim.cfg.ticks_per_day:
                eco["status"] = "done" if herb >= 30 and herb >= 10 * max(1, preds) else "active"
                if eco["status"] == "done":
                    self._remember("lesson", f"The ecosystem I began holds: {_fmt_counts(life['animals'])}", importance=0.8)
                    said.append(f"The ecosystem holds: {_fmt_counts(life['animals'])}.")
                else:
                    self._remember("mistake", f"The balance failed: {herb} prey against {preds} predators. "
                                   "Predators need far more prey than I gave them", importance=0.8)
                    eco["stage"] = 1
                    eco["stage_tick"] = now

        hum = self._goal("humanity")
        if hum is not None and d["may_create_humans"] and life["humans"] == 0:
            ready = eco is None or eco["status"] == "done" or eco["stage"] >= 2
            if ready:
                predators = [(a[2] / self.sim.cfg.tile_size_m, a[3] / self.sim.cfg.tile_size_m, 6)
                             for a in (self.sim.world.life.agents()["animals"] if self.sim.world.life else []) if a[1] in ("tiger", "wolf")]
                site = best_site(self.sim, "humans", [(int(px), int(py), r) for px, py, r in predators])
                if site:
                    x, y, _ = site
                    cmd = self._act("create_humans", {"x": x, "y": y, "count": 12},
                                    "the land can sustain life; humanity may begin near water and food, away from predators")
                    if cmd:
                        hum["stage"] = 1
                        hum["site"] = [x, y]
                        said.append(f"The land can now sustain them. I created twelve humans in the {region_name(self.sim.world, x, y)} "
                                    f"near ({x}, {y}), close to water and food and away from predators. Each has their own mind. "
                                    f"I will watch what they become.")
                        return said
        return said

    def _recently(self, kinds: tuple, x: int, y: int, days: int, radius: float = 6.0) -> bool:
        """Did I already do one of these acts near here within `days`? (avoid repeating myself)"""
        now = self.sim.world.tick
        for pd in self.state["pending"] + self.state.setdefault("recent", []):
            p = pd["params"]
            if pd["kind"] in kinds and now - pd["tick"] < days * self.sim.cfg.ticks_per_day and \
                    math.hypot(p.get("x", 0) - x, p.get("y", 0) - y) <= radius:
                return True
        return False

    def _lessons_with_place(self) -> list[dict]:
        if self.sim.store is None or self.wid is None:
            return []
        return [m for m in self.sim.store.witness_memories(self.wid, 50, ["lesson"]) if "x" in m["data"]]

    # ------------------------------------------------------------------ language
    def _respond(self, text: str) -> list:
        t = text.lower()
        st, d = self.state, self.state["directives"]
        out: list = []
        o = self._observe()

        def note_instruction(summary: str) -> None:
            self._remember("instruction", f"The Creator instructed: {text}", {"understood": summary}, 0.9)

        # directives that may come together in one sentence
        understood = []
        if re.search(r"\b(protect|preserve|care for|respect)\b.*\b(environment|nature|land|world|forests?)\b", t):
            d["protect_environment"] = True
            understood.append("protect the environment")
        if re.search(r"\b(don'?t|do not|never)\b.*\b(intervene|interfere|touch|change)\b", t) or "leave it alone" in t:
            d["intervention"] = "none"
            st["autonomy"] = False
            understood.append("not intervene")
        if re.search(r"\byou decide\b|\bdo what you (think|will|judge)\b|\bas you see fit\b|\bup to you\b", t):
            st["autonomy"] = True
            d["intervention"] = "active"
            d["may_create_life"] = True
            understood.append("decide for myself")
        wants_civ = re.search(r"\b(civili[sz]ation|humanity|humans|people|mankind)\b", t) and \
            re.search(r"\b(create|make|begin|start|build|bring)\b", t)
        if wants_civ:
            d["may_create_life"] = d["may_create_humans"] = True
            if d["intervention"] == "none":
                d["intervention"] = "gentle"
            understood.append("create a civilization")
        if re.search(r"\b(autonomy|autonomous)\b.*\b(on|enable|start)\b|\bact on your own\b", t):
            st["autonomy"] = True
            understood.append("act on my own")
        if re.search(r"\b(autonomy|autonomous)\b.*\b(off|disable|stop)\b|\bstop acting\b|\bonly when i ask\b", t):
            st["autonomy"] = False
            understood.append("act only when asked")
        if understood:
            note_instruction(", ".join(understood))

        # --- plans that follow from the instruction
        if wants_civ or ("decide for myself" in understood and not (o["life"] and o["life"]["humans"])):
            self._add_goal("ecosystem", "Establish a balanced ecosystem that can sustain life")
            self._add_goal("humanity", "Introduce humanity once the land can sustain it, and watch what they become")
            st["proposal"] = None
            intro = ("Then I will begin with a balanced ecosystem. Once it can sustain life, I will introduce humanity "
                     "and observe what they become.")
            if d["protect_environment"]:
                intro += " I will not reshape mountains or rivers for them, and I will answer fire and drought."
            out.append(intro)
            done = self._plan_and_act(o, spontaneous=False)
            out.extend(done)
            if not done:
                out.append("I found nowhere suitable yet; I will keep looking each day.")
            return out
        if understood:
            out.append(f"I understand: I will {' and '.join(understood)}. I will remember this.")
            return out

        # --- answering a proposal
        if re.fullmatch(r"\s*(yes|yes please|begin|do it|proceed|go ahead|please do|ok(ay)?|sure)[.! ]*", t):
            prop = st.get("proposal")
            if prop and prop.get("plan") == "ecosystem_then_humanity":
                d["may_create_life"] = True
                self._add_goal("ecosystem", "Establish a balanced ecosystem that can sustain life")
                st["proposal"] = {"plan": "humanity", "text": "introduce humanity when the land can sustain it"}
                out.append("Then I begin with the plants' companions: creatures that eat them, before any that hunt.")
                out.extend(self._plan_and_act(o, spontaneous=False) or ["I found nowhere suitable yet."])
                out.append("When they have held for a while, shall I bring predators, and later humanity? "
                           "Tell me to decide for myself and I will.")
                return out
            if prop and prop.get("plan") == "humanity":
                d["may_create_humans"] = True
                self._add_goal("humanity", "Introduce humanity once the land can sustain it")
                st["proposal"] = None
                out.append("I will introduce humanity as soon as the land can sustain them.")
                out.extend(self._plan_and_act(o, spontaneous=False))
                return out
            pending = prop.get("command") if prop else None
            if pending:
                cmd = self._act(pending["kind"], pending["params"], f"the Creator approved: {prop['text']}")
                st["proposal"] = None
                return [f"Done: I {describe(cmd)}." if cmd else "It could not be done; I have noted why."]
            return ["There is nothing waiting for your approval."]
        if re.fullmatch(r"\s*(no|not now|wait|cancel|don'?t)[.! ]*", t):
            st["proposal"] = None
            return ["As you wish. I will wait."]

        # --- direct acts
        act = self._parse_act(t, o)
        if act is not None:
            kind, params, why = act
            if kind == "error":
                return [params]
            cmd = self._act(kind, params, why)
            if cmd is None:
                mem = self.sim.store.witness_memories(self.wid, 1, ["mistake"]) if self.sim.store else []
                return [f"I could not: {mem[-1]['text'].split(': ', 1)[-1] if mem else 'the act was refused'}."]
            return [f"It is done — I {describe(cmd)}. It takes effect within the hour, and the world's own laws carry it on from there. "
                    f"I will check in {VERIFY_DAYS.get(kind, 20)} days whether it worked."]

        # --- questions
        if re.search(r"\b(who|what) are you\b|\byour name\b|\bintroduce yourself\b", t):
            return [f"I am {NAME}. I watch over this world for you, Creator. I see what its laws produce, I remember, and I act "
                    f"only through recorded acts you can review. I do not age, and I do not forget. I am a reasoning system, "
                    f"not a living mind: I choose by weighing goals against what I observe and what I have learned."]
        if re.search(r"\b(what do you see|status|report|how is (the|my) world|observe|look)\b", t):
            return [self._report(o)]
        if re.search(r"\b(what have you done|history|your acts|actions)\b", t):
            return [self._history()]
        if re.search(r"\b(goals?|plans?|intend|what are you doing)\b", t):
            return [self._goals_text()]
        if re.search(r"\b(learn(ed|t)?|lessons?|mistakes?)\b", t):
            return [self._lessons_text()]
        if re.search(r"\b(remember|memor(y|ies))\b", t):
            return [self._memory_text()]
        if re.search(r"\b(humans?|people)\b", t) and o["life"] and o["life"]["humans"]:
            return [self._humans_text()]
        if re.search(r"\b(hello|hi|greetings|are you there|awake)\b", t):
            return [f"I am here, Creator. {self._report(o)}"]
        return ["I do not understand that yet. You can ask me what I see, what I have done, my goals or what I have learned; "
                "tell me to create forests, lakes, rain, animals or humans (\"create 20 deer\", \"plant a forest in the north\"); "
                "or give me instructions such as \"you decide\" or \"protect the environment\"."]

    def _parse_act(self, t: str, o: dict):
        """Turn a request into a command. Returns (kind, params, reason), ("error", text, None) or None."""
        w = self.sim.world
        h, wd = w.shape
        m = re.search(r"\(?\b(\d{1,3})\s*,\s*(\d{1,3})\)?", t)
        at = (int(m.group(1)), int(m.group(2))) if m else None
        regions = {"north": (wd // 2, h // 6), "south": (wd // 2, 5 * h // 6), "east": (5 * wd // 6, h // 2),
                   "west": (wd // 6, h // 2), "centre": (wd // 2, h // 2), "center": (wd // 2, h // 2)}
        reg = next((v for k, v in regions.items() if re.search(rf"\b{k}", t)), None)

        def place(purpose: str):
            if at:
                return at
            s = best_site(self.sim, purpose, within=(reg[0], reg[1], max(wd, h) // 4) if reg else None)
            return s[:2] if s else None

        if re.search(r"\b(create|make|add|bring|release|summon)\b", t):
            for word, sp in ANIMAL_WORDS.items():
                if re.search(rf"\b{word}\b", t):
                    n = re.search(r"\b(\d{1,3})\b(?!\s*,)", t)
                    count = int(n.group(1)) if n and not at else 20
                    pos = place("animals")
                    if pos is None:
                        return ("error", "I found no land where they could live.", None)
                    return ("create_animals", {"species": sp, "x": pos[0], "y": pos[1], "count": max(1, min(400, count))},
                            "the Creator asked for them")
            if re.search(r"\b(humans?|people|man|woman|tribe)\b", t):
                pos = place("humans")
                if pos is None:
                    return ("error", "I found no land where humans could live.", None)
                return ("create_humans", {"x": pos[0], "y": pos[1], "count": 12}, "the Creator asked for humanity")
        if re.search(r"\b(forest|trees|woods)\b", t) and re.search(r"\b(plant|grow|create|make|seed)\b", t):
            pos = place("restore")
            return ("plant_forest", {"x": pos[0], "y": pos[1], "radius": 3}, "the Creator asked for a forest") if pos else None
        if re.search(r"\b(restore|heal|regrow|revive)\b", t):
            pos = place("restore")
            return ("restore_ecosystem", {"x": pos[0], "y": pos[1], "radius": 3}, "the Creator asked me to heal the land") if pos else None
        if re.search(r"\blake\b", t):
            pos = place("lake")
            return ("create_lake", {"x": pos[0], "y": pos[1], "radius": 1.5, "depth_m": 12}, "the Creator asked for a lake") if pos else None
        if re.search(r"\b(rain|storm|water the)\b", t):
            if not at and not reg:
                dry = [c for c in o["concerns"] if c["kind"] == "drought"]
                pos = (dry[0]["x"], dry[0]["y"]) if dry else place("restore")
            else:
                pos = place("restore")
            return ("bring_rain", {"x": pos[0], "y": pos[1], "radius": 4, "amount_mm": 40}, "the Creator asked for rain") if pos else None
        if re.search(r"\b(fire|fires|flames)\b", t) and re.search(r"\b(put out|extinguish|stop|end)\b", t):
            fires = [c for c in o["concerns"] if c["kind"] == "fire"]
            if not fires and not at:
                return ("error", "No fire burns anywhere in the world right now.", None)
            pos = at or (fires[0]["x"], fires[0]["y"])
            return ("extinguish_fire", {"x": pos[0], "y": pos[1], "radius": 8}, "the Creator asked me to end the fire")
        if re.search(r"\b(mountain|hill|raise)\b", t):
            if self.state["directives"]["protect_environment"] and not re.search(r"\b(anyway|still|i insist)\b", t):
                pos = place("other")
                self.state["proposal"] = {"text": "raise a mountain", "command": {"kind": "shape_land", "params": {"x": pos[0], "y": pos[1], "radius": 2.5, "height_m": 1200}}}
                return ("error", "You asked me to protect the environment; raising a mountain would bury what grows there. "
                                 "Say yes if you still want it.", None)
            pos = place("other")
            return ("shape_land", {"x": pos[0], "y": pos[1], "radius": 2.5, "height_m": 1200}, "the Creator asked for a mountain")
        if re.search(r"\b(valley|lower|sink)\b", t):
            pos = place("other")
            return ("shape_land", {"x": pos[0], "y": pos[1], "radius": 2.0, "height_m": -150}, "the Creator asked for a valley")
        if re.search(r"\b(warm|warmer|heat)\b", t) or re.search(r"\b(cool|cooler|chill)\b", t):
            pos = at or reg or (wd // 2, h // 2)
            delta = 3.0 if re.search(r"\b(warm|warmer|heat)\b", t) else -3.0
            return ("climate_forcing", {"x": pos[0], "y": pos[1], "radius": 8, "delta_c": delta, "days": 30},
                    "the Creator asked to change the climate")
        return None

    # ------------------------------------------------------------------ reports
    def _report(self, o: dict) -> str:
        t = o["terrain"]
        cal = o["calendar"]
        parts = [f"It is year {cal['year'] + 1}, day {cal['day_of_year'] + 1} ({cal['season']}). Land air averages {o['temp_land_c']:.1f} °C; "
                 f"vegetation covers {o['vegetation_mean']:.0%} of what the land could carry."]
        parts.append(f"Forests on {t.get('forest', 0)} tiles, deserts on {t.get('desert', 0)}, rivers on {t.get('river', 0)}, "
                     f"lakes on {t.get('lake', 0)}, glaciers on {t.get('glacier', 0)}.")
        life = o["life"]
        if life and (life["animals_total"] or life["humans"]):
            parts.append(f"Life: {_fmt_counts(life['animals'])}" + (f"; {life['humans']} humans in {life['families']} families, "
                         f"with {life['shelters']} shelters" if life["humans"] else "") + ".")
        else:
            parts.append("No creature lives here yet.")
        q = self.sim.world.meta.get("command_queue") or []
        if q:
            parts.append(f"{len(q)} act{'s' if len(q) > 1 else ''} wait to take effect at the next hour: "
                         + "; ".join(describe(c) for c in q[:4]) + ".")
        if o["concerns"]:
            parts.append("I am watching: " + "; ".join(c["text"] for c in o["concerns"][:3]) + ".")
        return " ".join(parts)

    def _history(self) -> str:
        if self.sim.store is None:
            return "I keep no records without a database."
        cmds = self.sim.store.commands(self.wid, limit=12)
        if not cmds:
            return "I have not acted yet."
        lines = []
        for c in cmds[-8:]:
            who = "I" if c["issuer"] == "witness" else "You"
            res = f" ({c['status']})" if c["status"] != "applied" else ""
            lines.append(f"day {c['tick'] // self.sim.cfg.ticks_per_day}: {who} {describe(c, c['result'], self.sim.cfg.tile_size_m)}{res}")
        return "My records: " + "; ".join(lines) + "."

    def _goals_text(self) -> str:
        gs = [g for g in self.state["goals"] if g["status"] == "active"]
        auto = "I am acting on my own each day." if self.state["autonomy"] else "I act only when you ask."
        if not gs:
            return f"I hold no goals yet. {auto}"
        return f"{auto} My goals: " + "; ".join(f"{g['text']} (stage {g['stage']})" for g in gs) + "."

    def _lessons_text(self) -> str:
        if self.sim.store is None:
            return "I keep no records without a database."
        ms = self.sim.store.witness_memories(self.wid, 6, ["lesson", "mistake"])
        if not ms:
            return "I have not yet seen the outcome of any act. I check each one after a while and learn from it."
        vals = ", ".join(f"{k.replace('_', ' ')} {v['mean']:+.2f} over {v['n']}" for k, v in self.state["action_values"].items())
        return "What I have learned: " + "; ".join(m["text"] for m in ms) + (f". My judgement of each kind of act: {vals}." if vals else ".")

    def _memory_text(self) -> str:
        if self.sim.store is None:
            return "I keep no records without a database."
        ins = self.sim.store.witness_memories(self.wid, 5, ["instruction"])
        mem = self.sim.store.witness_memories(self.wid, 5, ["discovery", "creation"])
        parts = []
        if ins:
            parts.append("Your instructions: " + "; ".join(m["text"].replace("The Creator instructed: ", "").rstrip(".") for m in ins))
        if mem:
            parts.append("What I have seen and done: " + "; ".join(m["text"] for m in mem))
        return (". ".join(parts) + ".") if parts else "I remember little yet; I have only just awoken."

    def _humans_text(self) -> str:
        life = self.sim.world.life
        hs = life.humans
        s = life.summary()
        oldest = max(hs, key=lambda h: h.age_d)
        afraid = [h for h in hs if h.fear_of]
        txt = (f"{len(hs)} humans live, in {s['families']} families with {s['shelters']} shelters. "
               f"Their skills grow with practice: foraging {s['mean_skills'].get('forage', 0):.2f}, building "
               f"{s['mean_skills'].get('build', 0):.2f}, tool-making {s['mean_skills'].get('tools', 0):.2f}. "
               f"The oldest is {oldest.name}, aged {oldest.age_d / 360:.0f}.")
        if afraid:
            h = afraid[0]
            sp = max(h.fear_of, key=h.fear_of.get)
            txt += f" {h.name} has learned to fear the {sp}" + (f": \"{h.episodes[-1][1]}\"" if h.episodes else "") + "."
        return txt


def _brief(o: dict) -> dict:
    return {k: o[k] for k in ("tick", "land_km2", "highest_peak_m", "vegetation_mean", "temp_land_c", "burning_tiles")}


def _fmt_counts(d: dict) -> str:
    return ", ".join(f"{n} {k}" for k, n in sorted(d.items(), key=lambda kv: -kv[1])) or "no animals"


ALL_KINDS = tuple(COMMAND_KINDS)
