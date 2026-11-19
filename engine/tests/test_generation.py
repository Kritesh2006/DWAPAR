import numpy as np
import pytest

from dwapar.brahmanda.generate import generate_world
from dwapar.brahmanda.world import Terrain
from dwapar.config import ConfigError, WorldConfig


def test_same_seed_same_world():
    a = generate_world(WorldConfig(seed=99, width=64, height=64))
    b = generate_world(WorldConfig(seed=99, width=64, height=64))
    assert a.fingerprint() == b.fingerprint()


def test_different_seed_different_world():
    a = generate_world(WorldConfig(seed=1, width=64, height=64))
    b = generate_world(WorldConfig(seed=2, width=64, height=64))
    assert a.fingerprint() != b.fingerprint()
    assert not np.allclose(a.elevation, b.elevation)


def test_config_change_changes_world():
    a = generate_world(WorldConfig(seed=5, width=64, height=64))
    b = generate_world(WorldConfig(seed=5, width=64, height=64, ocean_fraction=0.5))
    assert a.fingerprint() != b.fingerprint()


def test_default_world_is_128_and_has_all_terrain_types():
    w = generate_world(WorldConfig(seed=42))
    assert w.shape == (128, 128)
    present = set(np.unique(w.terrain).tolist())
    assert present == {int(t) for t in Terrain}, f"missing {set(map(int, Terrain)) - present}"


def test_ocean_fraction_respected():
    cfg = WorldConfig(seed=3, width=96, height=96, ocean_fraction=0.4)
    w = generate_world(cfg)
    assert abs(w.is_ocean.mean() - 0.4) < 0.01


def test_larger_world_supported():
    w = generate_world(WorldConfig(seed=8, width=256, height=192))
    assert w.shape == (192, 256)
    w.validate()


def test_tile_properties_present_and_physical():
    w = generate_world(WorldConfig(seed=11, width=64, height=64))
    land = ~w.is_ocean
    assert (w.elevation[land] > 0).all() and (w.elevation[~land] < 0).all()
    assert 0 <= w.soil_moisture.min() and w.soil_moisture.max() <= 1
    assert 0 <= w.fertility.min() and w.fertility.max() <= 1
    assert 0 <= w.vegetation_density.min() and w.vegetation_density.max() <= 1
    assert (w.biomass[~land] == 0).all()
    assert w.temperature.min() > -60 and w.temperature.max() < 50


def test_terrain_is_derived_from_conditions():
    w = generate_world(WorldConfig(seed=42))
    t = w.terrain
    land = ~w.is_ocean
    assert (t[~land] == Terrain.OCEAN).all()
    assert (w.elevation[t == Terrain.MOUNTAINS] >= 1900).all()
    assert (w.surface_water[t == Terrain.LAKE] >= 1500).all()
    assert (w.snow[t == Terrain.SNOW] >= 20).all()
    assert (w.biomass[t == Terrain.FOREST] >= 9).all()


@pytest.mark.parametrize("bad", [
    dict(width=8), dict(height=5000), dict(seed=-1), dict(ocean_fraction=0.99),
    dict(hours_per_tick=5), dict(lat_top=-20, lat_bottom=10), dict(wind_speed_tiles_per_hour=2.0),
])
def test_invalid_config_rejected(bad):
    with pytest.raises(ConfigError):
        WorldConfig(**bad)


def test_config_roundtrip():
    cfg = WorldConfig(seed=77, width=40, height=50)
    assert WorldConfig.from_dict(cfg.to_dict()) == cfg
    with pytest.raises(ConfigError):
        WorldConfig.from_dict({**cfg.to_dict(), "inhabitants": 10})
