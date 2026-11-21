"""Divine commands — the only way anything outside physics may change a world.

Every intervention (by the Creator or by WITNESS) is a *command*: a small JSON record
``{seq, tick, issuer, kind, params}``. Commands are validated, queued in ``world.meta`` (so
checkpoints carry them), applied at the start of a tick before physics, and written to the
``commands`` table. A world can therefore be replayed from any checkpoint by re-applying the
logged commands at their ticks: no language model or decision-maker has to run again.

Conservation (CONSTITUTION Art. III as amended in D-035):
* water is never created: lakes, rain and restored soil water are *moved* from the ocean;
* rock added or removed by reshaping land is counted in ``meta["divine"]["rock_t"]`` and the rock
  audit expects it;
* vegetation seeded by a command is counted in ``meta["divine"]["biomass_kg"]`` (biomass is not a
  conserved quantity in the laws, but every external addition is still recorded);
* creatures created by a command are counted in ``meta["divine"]["creatures"]``.
"""

from .commands import (COMMAND_KINDS, CommandError, apply_command, apply_forcings, describe,
                       schedule_replay, submit, validate)

__all__ = ["COMMAND_KINDS", "CommandError", "apply_command", "apply_forcings", "describe", "schedule_replay", "submit",
           "validate"]
