import { useEffect, useState } from "react";
import { api, type Checkpoint, type Stats, type Status, type Tile, type WorldEvent, type WorldInfo } from "../api";
import { RESOURCE_NAMES, RESOURCE_UNITS, TERRAIN_CLASSES, TERRAIN_COLORS, fmtBig } from "../colormaps";

export const kindIcon: Record<string, string> = {
  genesis: "✦", fire_ignition: "ϟ", major_fire: "▲", fires_out: "○", season: "◐", year: "◎", engine_halt: "⚠",
  earthquake: "≋", volcanic_eruption: "♨", flood: "≈", drought: "☼",
};
export const DISASTERS = ["volcanic_eruption", "earthquake", "major_fire", "flood", "drought"];
export const DISASTER_LABEL: Record<string, string> = {
  volcanic_eruption: "Eruptions", earthquake: "Earthquakes", major_fire: "Wildfires", flood: "Floods", drought: "Droughts",
};

// ------------------------------------------------------------------ inspector
const ROWS: [string, string, (v: number) => string][] = [
  ["elevation_m", "Elevation", (v) => `${v.toFixed(0)} m`],
  ["latitude", "Latitude", (v) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? "N" : "S"}`],
  ["temperature_c", "Air temperature", (v) => `${v.toFixed(1)} °C`],
  ["sst_c", "Ocean temperature", (v) => `${v.toFixed(1)} °C`],
  ["temperature_season_mean_c", "Seasonal mean", (v) => `${v.toFixed(1)} °C`],
  ["precip_mean_mm_day", "Precipitation", (v) => `${v.toFixed(2)} mm/day`],
  ["soil_moisture", "Soil moisture", (v) => v.toFixed(3)],
  ["groundwater_mm", "Groundwater", (v) => `${v.toFixed(0)} mm`],
  ["surface_water_mm", "Surface water", (v) => `${fmtBig(v)} mm`],
  ["flow_flux_mm_h", "Discharge", (v) => `${v.toFixed(2)} mm/h`],
  ["snow_mm", "Snowpack", (v) => `${v.toFixed(1)} mm`],
  ["soil_fertility", "Fertility", (v) => v.toFixed(3)],
  ["vegetation_density", "Vegetation", (v) => v.toFixed(3)],
  ["biomass_kg_m2", "Biomass", (v) => `${v.toFixed(2)} kg/m²`],
  ["organic_matter_kg_m2", "Organic matter", (v) => `${v.toFixed(2)} kg/m²`],
  ["sediment_t", "Sediment load", (v) => `${fmtBig(v)} t`],
  ["uplift_mm_yr", "Tectonic uplift", (v) => `${v.toFixed(2)} mm/yr`],
  ["fault_stress", "Fault stress", (v) => v.toFixed(2)],
  ["drought_days", "Days since rain", (v) => v.toFixed(0)],
  ["fire_risk", "Fire risk", (v) => v.toFixed(3)],
  ["fire_intensity", "Fire", (v) => v.toFixed(2)],
  ["lava", "Lava heat", (v) => v.toFixed(2)],
];

export function Inspector({ sel, tick }: { sel: { x: number; y: number } | null; tick: number }) {
  const [tile, setTile] = useState<Tile | null>(null);
  const bucket = Math.floor(tick / 3);
  useEffect(() => {
    if (!sel) return;
    let live = true;
    api.tile(sel.x, sel.y).then((t) => live && setTile(t)).catch(() => {});
    return () => { live = false; };
  }, [sel, bucket]);
  if (!sel) return <p className="hint">Select any point on the planet to read its instruments.</p>;
  if (!tile) return <p className="hint">Reading instruments…</p>;
  const c = TERRAIN_COLORS[tile.terrain];
  return (
    <div className="inspector">
      <div className="ins-head">
        <i className="sw" style={{ background: c ? `rgb(${c.join(",")})` : "#888" }} />
        <b>{tile.terrain}</b>
        <span className="mono dim">{tile.x}, {tile.y} · plate {String(tile.plate_id)}</span>
      </div>
      <dl className="kv">
        {ROWS.filter(([k]) => tile[k] !== undefined && tile[k] !== null).map(([k, label, fmt]) => (
          <div key={k}><dt>{label}</dt><dd className="mono">{fmt(tile[k] as number)}</dd></div>
        ))}
      </dl>
      <h4>Resources here</h4>
      <dl className="kv">
        {Object.entries(tile.resources).filter(([, v]) => v > 0).map(([k, v]) => (
          <div key={k}><dt>{RESOURCE_NAMES[k] ?? k}</dt><dd className="mono">{fmtBig(v)} {tile.resource_units[k]}</dd></div>
        ))}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------- planet
export function PlanetPanel({ status, stats, first, errors, fps }: {
  status: Status | null; stats: Stats | null; first: Stats | null; errors: Record<string, number> | null; fps: number;
}) {
  if (!stats || !status) return <p className="hint">Waiting for the first daily survey…</p>;
  const total = Object.values(stats.terrain).reduce((a, b) => a + b, 0);
  const vitals: [string, string][] = [
    ["World age", `${status.world_age_years.toFixed(2)} years`],
    ["Land air", `${stats.temp_land_mean.toFixed(1)} °C`],
    ["Ocean surface", `${stats.sst_mean?.toFixed(1)} °C`],
    ["Rainfall (land)", `${stats.precip_mean_mm_day.toFixed(2)} mm/day`],
    ["Soil moisture", stats.soil_moisture_mean.toFixed(3)],
    ["Groundwater", `${stats.groundwater_mean_mm?.toFixed(0)} mm`],
    ["Vegetation", stats.vegetation_mean.toFixed(3)],
    ["Fertility", stats.fertility_mean.toFixed(3)],
    ["Sediment moving", `${fmtBig(stats.sediment_in_transit_t ?? 0)} t`],
    ["Active fires", `${stats.burning_tiles} tiles`],
  ];
  const engine: [string, string][] = [
    ["Tick", status.calendar.tick.toLocaleString()],
    ["Step time", `${status.last_step_ms} ms`],
    ["Throughput", `${status.measured_ticks_per_second} ticks/s`],
    ["Render", `${fps} fps`],
    ["Engine", `v${status.engine_version}`],
  ];
  return (
    <div className="planet">
      <dl className="kv">{vitals.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}</dl>
      <h4>Surface composition</h4>
      <div className="tbar">
        {TERRAIN_CLASSES.map((t) => (
          <span key={t} title={`${t}: ${stats.terrain[t]}`} style={{ width: `${(stats.terrain[t] / total) * 100}%`, background: `rgb(${TERRAIN_COLORS[t].join(",")})` }} />
        ))}
      </div>
      <div className="tlegend">
        {TERRAIN_CLASSES.map((t) => (
          <span key={t}><i style={{ background: `rgb(${TERRAIN_COLORS[t].join(",")})` }} />{t}<b className="mono">{((stats.terrain[t] / total) * 100).toFixed(1)}%</b></span>
        ))}
      </div>
      <h4>Conservation audit</h4>
      <dl className="kv">
        {errors && Object.entries(errors).filter(([k]) => k !== "ores_increase").map(([k, v]) => (
          <div key={k}><dt>{k.replace("_", " + ")} closure</dt><dd className={`mono ${v < 1e-9 ? "ok" : "bad"}`}>{v.toExponential(1)}</dd></div>
        ))}
      </dl>
      <h4>Resources</h4>
      <table className="res">
        <tbody>
          {Object.entries(stats.resources).map(([k, v]) => {
            const b = first?.resources[k];
            const d = b ? ((v - b) / b) * 100 : 0;
            return (
              <tr key={k}>
                <td>{RESOURCE_NAMES[k]}</td>
                <td className="mono">{fmtBig(v)} {RESOURCE_UNITS[k]}</td>
                <td className={`mono ${Math.abs(d) < 0.05 ? "dim" : d > 0 ? "ok" : "bad"}`}>{b ? `${d >= 0 ? "+" : ""}${d.toFixed(2)}%` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h4>Engine</h4>
      <dl className="kv">{engine.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}</dl>
    </div>
  );
}

// ----------------------------------------------------------------- disasters
export function DisasterPanel({ events, tpd, dpy, onLocate }: {
  events: WorldEvent[]; tpd: number; dpy: number; onLocate: (x: number, y: number) => void;
}) {
  const [kind, setKind] = useState<string>("all");
  const list = events.filter((e) => DISASTERS.includes(e.kind) && (kind === "all" || e.kind === kind));
  const counts = Object.fromEntries(DISASTERS.map((k) => [k, events.filter((e) => e.kind === k).length]));
  return (
    <div className="disasters">
      <div className="dgrid">
        {DISASTERS.map((k) => (
          <button key={k} className={`dcard ${kind === k ? "on" : ""}`} onClick={() => setKind(kind === k ? "all" : k)}>
            <span className={`dicon k-${k}`}>{kindIcon[k]}</span>
            <b className="mono">{counts[k]}</b>
            <small>{DISASTER_LABEL[k]}</small>
          </button>
        ))}
      </div>
      <ol className="elist">
        {list.length === 0 && <li className="hint">No natural disasters recorded{kind !== "all" ? " of this kind" : ""} in the loaded history.</li>}
        {list.map((e, i) => {
          const day = Math.floor(e.tick / tpd);
          return (
            <li key={`${e.tick}-${i}`} className={`k-${e.kind}`}>
              <span className="eicon">{kindIcon[e.kind]}</span>
              <span className="mono dim">Y{Math.floor(day / dpy) + 1}·D{(day % dpy) + 1}</span>
              <span className="emsg">{e.message}</span>
              {e.x !== null && <button className="link" onClick={() => onLocate(e.x!, e.y!)}>view</button>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ------------------------------------------------------------------- archive
export function Archive({ status, onChange, onClose }: { status: Status | null; onChange: (s: Status) => void; onClose: () => void }) {
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [cps, setCps] = useState<Checkpoint[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [seed, setSeed] = useState("");
  const [size, setSize] = useState(128);
  const [busy, setBusy] = useState(false);
  const refresh = () => api.checkpoints().then((r) => { setWorlds(r.worlds); setCps(r.checkpoints); }).catch(() => {});
  useEffect(() => { refresh(); }, []);
  const act = (p: Promise<Status>, ok: string) => {
    setBusy(true);
    p.then((s) => { onChange(s); setMsg(ok); refresh(); }).catch((e) => setMsg(e.message)).finally(() => setBusy(false));
  };
  const tpd = status?.ticks_per_day ?? 24, dpy = status?.days_per_year ?? 360;
  const age = (tick: number | null) => (tick === null ? "—" : `${(tick / tpd / dpy).toFixed(2)} y`);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>World archive <span className="dim">· Smriti</span></h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </header>
        {msg && <div className="note">{msg}</div>}
        <div className="arch">
          <section>
            <h4>Worlds</h4>
            <table className="res">
              <thead><tr><th>World</th><th>Seed</th><th>Age</th><th /></tr></thead>
              <tbody>
                {worlds.map((w) => (
                  <tr key={w.id} className={w.id === status?.world_id ? "cur" : ""}>
                    <td className="mono">W{w.id}</td><td className="mono">{w.seed}</td><td className="mono">{age(w.latest_tick)}</td>
                    <td>{w.id === status?.world_id ? <span className="tag">observing</span>
                      : <button className="link" disabled={busy} onClick={() => act(api.loadWorld(w.id), `Now observing world ${w.id}`)}>observe</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h4>Create a world</h4>
            <div className="row">
              <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="seed" inputMode="numeric" />
              <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
                {[64, 128, 192, 256].map((s) => <option key={s} value={s}>{s}×{s}</option>)}
              </select>
              <button className="gold" disabled={busy} onClick={() => {
                const s = Number.parseInt(seed, 10);
                if (!Number.isFinite(s) || s < 0) { setMsg("Seed must be a non-negative integer"); return; }
                setMsg("Generating and spinning up climate — this takes a few seconds…");
                act(api.newWorld(s, size, size), `World generated from seed ${s}`);
              }}>Generate</button>
            </div>
          </section>
          <section>
            <h4>Checkpoints <button className="link" onClick={() => api.save().then((r) => { setMsg(`Saved checkpoint #${r.checkpoint_id}`); refresh(); })}>save now</button></h4>
            <ol className="cps">
              {cps.slice(0, 60).map((c) => (
                <li key={c.id} className={c.world_id === status?.world_id ? "" : "other"}>
                  <span className="mono">#{c.id}</span>
                  <span className={`tag t-${c.label}`}>{c.label}</span>
                  <span className="mono dim">W{c.world_id} · {age(c.tick)}</span>
                  <span className="dim">{(c.size_bytes / 1048576).toFixed(1)} MB</span>
                  <button className="link" disabled={busy} onClick={() => act(api.load(c.id), `Restored checkpoint #${c.id} (paused)`)}>restore</button>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
