import numpy as np
import pytest

from dwapar.brahmanda import resources
from dwapar.brahmanda.generate import generate_world
from dwapar.config import WorldConfig


@pytest.fixture
def world():
    return generate_world(WorldConfig(seed=42))


def test_every_resource_exists_with_location(world):
    for name in resources.ALL_RESOURCES:
        field = resources.resource_field(world, name)
        assert field.shape == world.shape
        assert (field >= 0).all()
        assert field.sum() > 0, f"{name} absent from world"
        assert (field > 0).sum() >= 5, f"{name} must exist at physical locations"


def test_minerals_are_localised_not_uniform(world):
    for name in ("iron_ore", "copper_ore", "coal"):
        field = resources.resource_field(world, name)
        share = (field > 0).mean()
        assert 0.005 < share < 0.6, f"{name} covers {share:.1%} of tiles"


def test_extraction_depletes_and_never_goes_negative(world):
    field = resources.resource_field(world, "iron_ore")
    y, x = np.unravel_index(np.argmax(field), field.shape)
    before = float(field[y, x])
    got = resources.extract(world, "iron_ore", y, x, before / 2)
    assert got == pytest.approx(before / 2)
    got2 = resources.extract(world, "iron_ore", y, x, before * 10)
    assert got2 == pytest.approx(before / 2)
    assert world.iron_ore[y, x] == 0.0
    assert resources.extract(world, "iron_ore", y, x, 1.0) == 0.0


def test_total_conserved_under_extraction(world):
    total0 = resources.totals(world)["coal"]
    field = resources.resource_field(world, "coal")
    ys, xs = np.nonzero(field)
    taken = sum(resources.extract(world, "coal", int(y), int(x), 1000.0) for y, x in zip(ys[:50], xs[:50]))
    assert resources.totals(world)["coal"] == pytest.approx(total0 - taken, rel=1e-12)


@pytest.mark.parametrize("name", ["wood", "freshwater", "saltwater", "stone", "organic_matter"])
def test_extract_each_kind(world, name):
    field = resources.resource_field(world, name)
    y, x = np.unravel_index(np.argmax(field), field.shape)
    before = float(field[y, x])
    got = resources.extract(world, name, int(y), int(x), before * 0.25)
    after = float(resources.resource_field(world, name)[y, x])
    assert after == pytest.approx(before - got, rel=1e-9)


def test_invalid_extraction_rejected(world):
    with pytest.raises(resources.ResourceError):
        resources.extract(world, "iron_ore", 0, 0, -5)
    with pytest.raises(resources.ResourceError):
        resources.extract(world, "iron_ore", 999, 0, 1)
    with pytest.raises(resources.ResourceError):
        resources.extract(world, "mithril", 0, 0, 1)
    with pytest.raises(resources.ResourceError):
        resources.extract(world, "coal", 0, 0, float("nan"))


def test_nonrenewables_never_regenerate(sim):
    before = {m: sim.world.f[m].copy() for m in resources.NONRENEWABLE}
    sim.step(24 * 20)
    for m in resources.NONRENEWABLE:
        assert (sim.world.f[m] <= before[m] + 1e-9).all(), f"{m} increased"
        assert np.array_equal(sim.world.f[m], before[m])


def test_wood_regrows_only_where_conditions_allow(sim):
    w = sim.world
    land = ~w.is_ocean
    # Clear-cut every land tile, then let a growing season pass.
    w.f["biomass"][:] = 0.0
    w.f["temp_day"][:] = 20.0
    sim.prakriti.step_day(w, sim.calendar, [])
    grown = w.f["biomass"]
    assert grown[land].sum() > 0, "wood should start to regrow"
    # A frozen, bone-dry tile must not regrow.
    w.f["biomass"][:] = 0.0
    w.f["temp_day"][:] = -15.0
    sim.prakriti.step_day(w, sim.calendar, [])
    assert w.f["biomass"].sum() == 0.0
