import pytest

from dwapar.config import WorldConfig
from dwapar.simulation import Simulation
from dwapar.smriti.store import Store


@pytest.fixture
def small_cfg():
    # 48x48 keeps the suite fast while exercising every code path.
    return WorldConfig(seed=1234, width=48, height=48)


@pytest.fixture
def sim(small_cfg):
    return Simulation.create(small_cfg)


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "test.sqlite")
    yield s
    s.close()
