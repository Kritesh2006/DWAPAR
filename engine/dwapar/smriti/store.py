"""Smriti — persistent memory of the world (SQLite).

Tables:
    worlds       one row per generated world (seed + full config)
    checkpoints  full state snapshots (compressed .npz blob + sha256)
    events       natural event timeline
    stats        daily environmental statistics (JSON)

Writes use WAL mode and one transaction per operation, so a crash or power
loss leaves the database at the last committed checkpoint. Each blob carries
a SHA-256 that is verified on load; a corrupt checkpoint is rejected rather
than silently producing a damaged world.
"""

from __future__ import annotations

import hashlib
import io
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np

from ..brahmanda.world import ALL_FLOAT_FIELDS, World
from ..config import WorldConfig

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS worlds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seed INTEGER NOT NULL,
    config TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id INTEGER NOT NULL REFERENCES worlds(id),
    tick INTEGER NOT NULL,
    label TEXT NOT NULL,
    created_at REAL NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    state BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ckpt_world ON checkpoints(world_id, tick);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id INTEGER NOT NULL REFERENCES worlds(id),
    tick INTEGER NOT NULL,
    kind TEXT NOT NULL,
    x INTEGER, y INTEGER,
    message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_world ON events(world_id, tick);
CREATE TABLE IF NOT EXISTS stats (
    world_id INTEGER NOT NULL REFERENCES worlds(id),
    tick INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (world_id, tick)
);
"""


class CheckpointError(RuntimeError):
    pass


def _serialise(world: World) -> bytes:
    buf = io.BytesIO()
    arrays = {name: world.f[name] for name in ALL_FLOAT_FIELDS}
    arrays["terrain"] = world.terrain
    arrays["__tick"] = np.array([world.tick], dtype=np.int64)
    arrays["__meta"] = np.frombuffer(json.dumps(world.meta, sort_keys=True).encode(), dtype=np.uint8)
    np.savez_compressed(buf, **arrays)
    return buf.getvalue()


def _deserialise(blob: bytes, cfg: WorldConfig) -> World:
    with np.load(io.BytesIO(blob), allow_pickle=False) as z:
        fields = {name: z[name] for name in ALL_FLOAT_FIELDS}
        terrain = z["terrain"]
        tick = int(z["__tick"][0])
        meta = json.loads(bytes(z["__meta"]).decode()) if "__meta" in z.files else {}
    world = World(cfg, fields, terrain, tick, meta)
    world.validate()
    return world


class Store:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        with self._lock:
            self.conn.executescript(SCHEMA)
            self.conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)",
                              (str(SCHEMA_VERSION),))

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    def _tx(self, sql: str, params=()):
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                cur = self.conn.execute(sql, params)
                self.conn.execute("COMMIT")
                return cur
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    # ------------------------------------------------------------- worlds
    def create_world(self, cfg: WorldConfig) -> int:
        cur = self._tx("INSERT INTO worlds(seed, config, created_at) VALUES (?, ?, ?)",
                       (cfg.seed, cfg.to_json(), time.time()))
        return int(cur.lastrowid)

    def world_config(self, world_id: int) -> WorldConfig:
        with self._lock:
            row = self.conn.execute("SELECT config FROM worlds WHERE id=?", (world_id,)).fetchone()
        if row is None:
            raise CheckpointError(f"world {world_id} not found")
        return WorldConfig.from_dict(json.loads(row[0]))

    def list_worlds(self) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT w.id, w.seed, w.created_at, MAX(c.tick) FROM worlds w "
                "LEFT JOIN checkpoints c ON c.world_id = w.id GROUP BY w.id ORDER BY w.id").fetchall()
        return [{"id": r[0], "seed": r[1], "created_at": r[2], "latest_tick": r[3]} for r in rows]

    # -------------------------------------------------------- checkpoints
    def save_checkpoint(self, world_id: int, world: World, label: str = "manual") -> int:
        blob = _serialise(world)
        digest = hashlib.sha256(blob).hexdigest()
        cur = self._tx(
            "INSERT INTO checkpoints(world_id, tick, label, created_at, sha256, size_bytes, state) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (world_id, world.tick, label, time.time(), digest, len(blob), blob))
        return int(cur.lastrowid)

    def list_checkpoints(self, world_id: Optional[int] = None) -> list[dict]:
        q = "SELECT id, world_id, tick, label, created_at, size_bytes FROM checkpoints"
        args: tuple = ()
        if world_id is not None:
            q += " WHERE world_id=?"
            args = (world_id,)
        with self._lock:
            rows = self.conn.execute(q + " ORDER BY id DESC", args).fetchall()
        return [dict(zip(("id", "world_id", "tick", "label", "created_at", "size_bytes"), r)) for r in rows]

    def load_checkpoint(self, checkpoint_id: Optional[int] = None,
                        world_id: Optional[int] = None) -> tuple[World, int]:
        """Load a checkpoint by id, or the latest one (optionally for a given world)."""
        with self._lock:
            if checkpoint_id is not None:
                row = self.conn.execute("SELECT world_id, sha256, state FROM checkpoints WHERE id=?",
                                        (checkpoint_id,)).fetchone()
            elif world_id is not None:
                row = self.conn.execute("SELECT world_id, sha256, state FROM checkpoints WHERE world_id=? "
                                        "ORDER BY tick DESC, id DESC LIMIT 1", (world_id,)).fetchone()
            else:
                row = self.conn.execute("SELECT world_id, sha256, state FROM checkpoints "
                                        "ORDER BY created_at DESC, id DESC LIMIT 1").fetchone()
        if row is None:
            raise CheckpointError("no checkpoint found")
        wid, digest, blob = row
        if hashlib.sha256(blob).hexdigest() != digest:
            raise CheckpointError(f"checkpoint integrity check failed (world {wid})")
        return _deserialise(blob, self.world_config(wid)), int(wid)

    def prune_checkpoints(self, world_id: int, keep: int) -> int:
        """Delete old *automatic* checkpoints beyond ``keep``. Manual saves and genesis are kept."""
        cur = self._tx(
            "DELETE FROM checkpoints WHERE world_id=? AND label='auto' AND id NOT IN "
            "(SELECT id FROM checkpoints WHERE world_id=? AND label='auto' ORDER BY tick DESC LIMIT ?)",
            (world_id, world_id, keep))
        return cur.rowcount

    def truncate_after(self, world_id: int, tick: int) -> None:
        """Remove history recorded after ``tick`` (used when rewinding to an older checkpoint)."""
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            self.conn.execute("DELETE FROM events WHERE world_id=? AND tick>?", (world_id, tick))
            self.conn.execute("DELETE FROM stats WHERE world_id=? AND tick>?", (world_id, tick))
            self.conn.execute("COMMIT")

    # ------------------------------------------------------ events/stats
    def add_events(self, world_id: int, events: list[dict]) -> None:
        if not events:
            return
        with self._lock:
            self.conn.execute("BEGIN IMMEDIATE")
            self.conn.executemany(
                "INSERT INTO events(world_id, tick, kind, x, y, message) VALUES (?, ?, ?, ?, ?, ?)",
                [(world_id, e["tick"], e["kind"], e.get("x"), e.get("y"), e["message"]) for e in events])
            self.conn.execute("COMMIT")

    def events(self, world_id: int, limit: int = 200, kinds: Optional[list[str]] = None) -> list[dict]:
        q = "SELECT tick, kind, x, y, message FROM events WHERE world_id=?"
        args: list = [world_id]
        if kinds:
            q += f" AND kind IN ({','.join('?' * len(kinds))})"
            args += kinds
        q += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self.conn.execute(q, args).fetchall()
        return [dict(zip(("tick", "kind", "x", "y", "message"), r)) for r in rows]

    def add_stats(self, world_id: int, tick: int, data: dict) -> None:
        self._tx("INSERT OR REPLACE INTO stats(world_id, tick, data) VALUES (?, ?, ?)",
                 (world_id, tick, json.dumps(data)))

    def stats_history(self, world_id: int, limit: int = 2000) -> list[dict]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT data FROM (SELECT tick, data FROM stats WHERE world_id=? ORDER BY tick DESC LIMIT ?) "
                "ORDER BY tick ASC", (world_id, limit)).fetchall()
        return [json.loads(r[0]) for r in rows]
