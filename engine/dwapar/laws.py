"""Versioned laws of the world.

A *laws version* changes whenever the physics changes what a world does (not for refactors that
are proven bit-identical, nor for display code). Every world records which laws governed which
part of its history in ``world.meta["laws_history"]``; experiments are stored per laws version
(``experiments/laws-<version>/``) so results produced under different physics are never mixed.
"""

LAWS_VERSION = "1.6"

CHANGELOG = {
    "1.0": "Phase 1 (engine 0.1): D8 runoff, fixed sea level, no groundwater/sediment/tectonics.",
    "1.5": "Phase 1.5 (engine 0.2, commit 9acf670): MFD runoff, ocean mixed layer + currents, wind heat "
           "transport, groundwater, sediment transport/deposition, spin-up, plate tectonics, earthquakes, "
           "volcanism, audited budgets. Sea level fixed at 0 m; snow had no sink besides melt.",
    "1.6": "Phase 1.5 session 4 (engine 0.3): glacier ice (firn compaction, Glen-like flow, melt, "
           "sublimation, calving) and dynamic sea level solved daily from ocean volume (moving "
           "coastlines). Engine optimisations proven bit-identical to 1.5 before these changes.",
}


def note_laws(meta: dict, tick: int) -> bool:
    """Record the current laws in a world's history. Returns True if the laws changed for this world."""
    hist = meta.setdefault("laws_history", [])
    current = meta.get("laws_version")
    if current == LAWS_VERSION:
        return False
    if current is None and not hist:
        # Worlds created before versioning existed: everything before now ran under 1.5 or earlier.
        if tick > 0:
            hist.append({"from_tick": 0, "laws": "1.5-or-earlier"})
    hist.append({"from_tick": int(tick), "laws": LAWS_VERSION})
    meta["laws_version"] = LAWS_VERSION
    return current is not None or tick > 0
