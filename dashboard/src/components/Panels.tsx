import { useEffect, useState } from "react";
import { api, type Checkpoint, type Stats, type Status, type Tile, type WorldEvent } from "../api";
import { TERRAIN_CLASSES, TERRAIN_COLORS } from "../colormaps";

const big = (v: number) =>
  v >= 1e12 ? `${(v / 1e12).toFixed(2)} T` : v >= 1e9 ? `${(v / 1e9).toFixed(2)} B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)} M`
    : v >= 1e3 ? `${(v / 1e3).toFixed(1)} k` : v.toFixed(v < 10 ? 2 : 0);

export const RESOURCE_LABELS: Record<string, string> = {
  freshwater: "Freshwater", saltwater: "Saltwater", wood: "Wood", stone: "Stone", sand: "Sand", clay: "Clay",
  iron_ore: "Iron ore", copper_ore: "Copper ore", coal: "Coal", organic_matter: "Organic matter",
};
const RESOURCE_UNITS: Record<string, string> = {
  freshwater: "m³", saltwater: "m³", wood: "t", stone: "t", sand: "t", clay: "t", iron_ore: "t", copper_ore: "t",
  coal: "t", organic_matter: "t",
};
const RENEWABLE = new Set(["freshwater", "wood", "organic_matter"]);

export function Panel({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="panel">
      <header><h3>{title}</h3>{right}</header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

// ------------------------------------------------------------------ clock
const SPEEDS: [string, number][] = [["1 h/s", 1], ["6 h/s", 6], ["1 d/s", 24], ["5 d/s", 120], ["Max", 0]];

export function ClockPanel({ status, onChange }: { status: Status | null; onChange: (s: Status) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const run = (p: Promise<Status>) => p.then((s) => { setErr(null); onChange(s); }).catch((e) => setErr(String(e.message)));
  if (!status) return null;
  const c = status.calendar;
  return (
    <div className="clock">
      <div className="clock-time">
        <div className="clock-label mono">{c.label}</div>
        <div className="clock-sub">
          <span className={`dot ${status.running ? "live" : ""}`} />{status.running ? "RUNNING" : "PAUSED"}
          <span className="sep">·</span>tick <span className="mono">{c.tick.toLocaleString()}</span>
          <span className="sep">·</span><span className="mono">{status.measured_ticks_per_second}</span> ticks/s
          <span className="sep">·</span><span className="mono">{status.last_step_ms}</span> ms/step
        </div>
      </div>
      <div className="clock-controls">
        {status.running
          ? <button className="primary" onClick={() => run(api.control("pause"))}>❚❚ Pause</button>
          : <button className="primary" onClick={() => run(api.control("resume"))}>▶ Run</button>}
        <button disabled={status.running} onClick={() => run(api.control("step", 1))} title="Advance one hour">+1 h</button>
        <button disabled={status.running} onClick={() => run(api.control("step", 24))} title="Advance one day">+1 d</button>
        <div className="seg">
          {SPEEDS.map(([label, v]) => (
            <button key={label} className={status.speed_hours_per_second === v ? "on" : ""} onClick={() => run(api.speed(v))}>{label}</button>
          ))}
        </div>
      </div>
      {(err || status.error) && <div className="error">{err ?? `Engine halted: ${status.error}`}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ tile
const TILE_ROWS: [string, string, (v: number) => string][] = [
  ["elevation_m", "Elevation", (v) => `${v.toFixed(0)} m`],
  ["latitude", "Latitude", (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? "N" : "S"}`],
  ["temperature_c", "Temperature", (v) => `${v.toFixed(1)} °C`],
  ["temperature_day_mean_c", "Daily mean temp.", (v) => `${v.toFixed(1)} °C`],
  ["temperature_season_mean_c", "Seasonal mean temp.", (v) => `${v.toFixed(1)} °C`],
  ["soil_moisture", "Soil moisture", (v) => v.toFixed(3)],
  ["soil_fertility", "Soil fertility", (v) => v.toFixed(3)],
  ["surface_water_mm", "Surface water", (v) => `${big(v)} mm`],
  ["flow_flux_mm_h", "Outflow", (v) => `${v.toFixed(2)} mm/h`],
  ["precip_mean_mm_day", "Precipitation", (v) => `${v.toFixed(2)} mm/day`],
  ["atmo_water_mm", "Air moisture", (v) => `${v.toFixed(1)} mm`],
  ["snow_mm", "Snowpack", (v) => `${v.toFixed(1)} mm`],
  ["vegetation_density", "Vegetation density", (v) => v.toFixed(3)],
  ["biomass_kg_m2", "Biomass", (v) => `${v.toFixed(2)} kg/m²`],
  ["organic_matter_kg_m2", "Organic matter", (v) => `${v.toFixed(2)} kg/m²`],
  ["drought_days", "Days since rain", (v) => v.toFixed(0)],
  ["fire_risk", "Fire risk", (v) => v.toFixed(3)],
  ["fire_intensity", "Fire intensity", (v) => v.toFixed(2)],
];

export function TileInspector({ sel, tick }: { sel: { x: number; y: number } | null; tick: number }) {
  const [tile, setTile] = useState<Tile | null>(null);
  useEffect(() => {
    if (!sel) return;
    let live = true;
    api.tile(sel.x, sel.y).then((t) => live && setTile(t)).catch(() => {});
    return () => { live = false; };
  }, [sel, Math.floor(tick / 2)]);
  if (!sel) return <div className="hint">Click any tile on the map to inspect its physical state.</div>;
  if (!tile) return <div className="hint">Reading tile…</div>;
  const color = TERRAIN_COLORS[tile.terrain];
  return (
    <div className="tile">
      <div className="tile-head">
        <span className="swatch" style={{ background: color ? `rgb(${color.join(",")})` : "#888" }} />
        <b>{tile.terrain.toUpperCase()}</b>
        <span className="mono dim">({tile.x}, {tile.y}) · tick {String(tile.tick)}</span>
      </div>
      <dl className="kv">
        {TILE_ROWS.map(([k, label, fmt]) => (
          <div key={k}><dt>{label}</dt><dd className="mono">{fmt(tile[k] as number)}</dd></div>
        ))}
      </dl>
      <h4>Resources on this tile</h4>
      <dl className="kv">
        {Object.entries(tile.resources).filter(([, v]) => v > 0).map(([k, v]) => (
          <div key={k}><dt>{RESOURCE_LABELS[k] ?? k}</dt><dd className="mono">{big(v)} {tile.resource_units[k]}</dd></div>
        ))}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------- environment
export function EnvironmentPanel({ stats }: { stats: Stats | null }) {
  if (!stats) return <div className="hint">No statistics yet.</div>;
  const rows: [string, string][] = [
    ["Mean land temp.", `${stats.temp_land_mean.toFixed(1)} °C`],
    ["Mean ocean temp.", `${stats.temp_ocean_mean.toFixed(1)} °C`],
    ["Range", `${stats.temp_min.toFixed(1)} … ${stats.temp_max.toFixed(1)} °C`],
    ["Precipitation (land)", `${stats.precip_mean_mm_day.toFixed(2)} mm/day`],
    ["Soil moisture (land)", stats.soil_moisture_mean.toFixed(3)],
    ["Soil fertility (land)", stats.fertility_mean.toFixed(3)],
    ["Vegetation density", stats.vegetation_mean.toFixed(3)],
    ["Active fires", `${stats.burning_tiles} tiles`],
    ["Lightning ignitions", `${stats.fire_ignitions_total}`],
  ];
  const total = Object.values(stats.terrain).reduce((a, b) => a + b, 0);
  return (
    <>
      <dl className="kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}</dl>
      <h4>Terrain composition</h4>
      <div className="terrain-bar">
        {TERRAIN_CLASSES.map((t) => (
          <span key={t} title={`${t}: ${stats.terrain[t]} tiles`}
            style={{ width: `${(stats.terrain[t] / total) * 100}%`, background: `rgb(${TERRAIN_COLORS[t].join(",")})` }} />
        ))}
      </div>
      <div className="terrain-legend">
        {TERRAIN_CLASSES.map((t) => (
          <span key={t}><i style={{ background: `rgb(${TERRAIN_COLORS[t].join(",")})` }} />{t}
            <b className="mono">{((stats.terrain[t] / total) * 100).toFixed(1)}%</b></span>
        ))}
      </div>
    </>
  );
}

export function ResourcePanel({ stats, first }: { stats: Stats | null; first: Stats | null }) {
  if (!stats) return null;
  return (
    <table className="res">
      <thead><tr><th>Resource</th><th>Total</th><th>Δ since genesis</th><th /></tr></thead>
      <tbody>
        {Object.entries(stats.resources).map(([k, v]) => {
          const base = first?.resources[k];
          const d = base ? ((v - base) / base) * 100 : 0;
          return (
            <tr key={k}>
              <td>{RESOURCE_LABELS[k] ?? k}</td>
              <td className="mono">{big(v)} {RESOURCE_UNITS[k]}</td>
              <td className={`mono ${d > 0.05 ? "up" : d < -0.05 ? "down" : "dim"}`}>
                {base ? `${d >= 0 ? "+" : ""}${d.toFixed(2)}%` : "—"}</td>
              <td><span className={`tag ${RENEWABLE.has(k) ? "renew" : k === "saltwater" ? "" : "finite"}`}>
                {RENEWABLE.has(k) ? "renewable" : k === "saltwater" ? "reservoir" : "finite"}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ events
const EVENT_ICON: Record<string, string> = {
  genesis: "✦", fire_ignition: "⚡", major_fire: "🔥", fires_out: "◌", season: "◐", year: "◎", engine_halt: "⚠",
};

export function Timeline({ events, ticksPerDay, daysPerYear, onLocate }: {
  events: WorldEvent[]; ticksPerDay: number; daysPerYear: number; onLocate: (x: number, y: number) => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const kinds = ["all", "fire", "season", "year"];
  const shown = events.filter((e) => filter === "all" || e.kind.includes(filter) || (filter === "fire" && e.kind === "major_fire"));
  return (
    <>
      <div className="seg small">
        {kinds.map((k) => <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{k}</button>)}
      </div>
      <ol className="timeline">
        {shown.length === 0 && <li className="hint">No natural events recorded yet.</li>}
        {shown.map((e, i) => {
          const day = Math.floor(e.tick / ticksPerDay);
          return (
            <li key={`${e.tick}-${i}`} className={`ev ev-${e.kind}`}>
              <span className="ev-icon">{EVENT_ICON[e.kind] ?? "•"}</span>
              <span className="mono dim ev-time">Y{Math.floor(day / daysPerYear) + 1} D{(day % daysPerYear) + 1}</span>
              <span className="ev-msg">{e.message}</span>
              {e.x !== null && e.y !== null && <button className="link" onClick={() => onLocate(e.x!, e.y!)}>locate</button>}
            </li>
          );
        })}
      </ol>
    </>
  );
}

// -------------------------------------------------------------- save/load
export function SaveLoad({ status, onChange }: { status: Status | null; onChange: (s: Status) => void }) {
  const [cps, setCps] = useState<Checkpoint[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [seed, setSeed] = useState<string>("");
  const refresh = () => api.checkpoints().then((r) => setCps(r.checkpoints)).catch(() => {});
  useEffect(() => { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); }, []);
  const save = () => api.save().then((r) => { setMsg(`Saved checkpoint #${r.checkpoint_id} at tick ${r.tick}`); refresh(); })
    .catch((e) => setMsg(e.message));
  const load = (id: number) => api.load(id).then((s) => { onChange(s); setMsg(`Loaded checkpoint #${id} (paused)`); refresh(); })
    .catch((e) => setMsg(e.message));
  const create = () => {
    const s = Number.parseInt(seed, 10);
    if (!Number.isFinite(s) || s < 0) { setMsg("Seed must be a non-negative integer"); return; }
    api.newWorld(s, status?.width ?? 128, status?.height ?? 128)
      .then((st) => { onChange(st); setMsg(`Generated world from seed ${s}`); refresh(); }).catch((e) => setMsg(e.message));
  };
  return (
    <div className="saveload">
      <div className="row">
        <button className="primary" onClick={save}>Save checkpoint</button>
        <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="new seed" inputMode="numeric" />
        <button onClick={create}>Generate world</button>
      </div>
      {msg && <div className="note">{msg}</div>}
      <ol className="cps">
        {cps.slice(0, 30).map((c) => (
          <li key={c.id} className={c.world_id === status?.world_id ? "" : "other"}>
            <span className="mono">#{c.id}</span>
            <span className={`tag ${c.label}`}>{c.label}</span>
            <span className="mono dim">W{c.world_id} · day {Math.floor(c.tick / (status?.ticks_per_day ?? 24))}</span>
            <span className="dim">{(c.size_bytes / 1024).toFixed(0)} KB</span>
            <button className="link" onClick={() => load(c.id)}>load</button>
          </li>
        ))}
      </ol>
    </div>
  );
}
