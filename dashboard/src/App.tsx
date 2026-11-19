import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, wsUrl, type Layer, type Stats, type Status, type WorldEvent } from "./api";
import { LAYER_ORDER, LAYER_STYLES } from "./colormaps";
import HistoryChart from "./components/HistoryChart";
import MapView from "./components/MapView";
import { ClockPanel, EnvironmentPanel, Panel, ResourcePanel, SaveLoad, TileInspector, Timeline } from "./components/Panels";

const LAYER_REFRESH_MS = 900;

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [connected, setConnected] = useState(false);
  const [layerKey, setLayerKey] = useState("terrain");
  const [layer, setLayer] = useState<Layer | null>(null);
  const [elevation, setElevation] = useState<Layer | null>(null);
  const [fire, setFire] = useState<Layer | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<Stats[]>([]);
  const [events, setEvents] = useState<WorldEvent[]>([]);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const lastFetch = useRef({ tick: -1, at: 0, key: "", world: -1 });
  const lastDayFetch = useRef({ day: -1, world: -1 });

  // ---- realtime status over WebSocket (reconnects automatically) ----------
  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(wsUrl());
      ws.onopen = () => setConnected(true);
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.type === "status") setStatus(msg.status);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = window.setTimeout(connect, 1500);
      };
    };
    connect();
    api.status().then(setStatus).catch(() => {});
    return () => { closed = true; window.clearTimeout(timer); ws?.close(); };
  }, []);

  // ---- pull layers when the world has actually advanced -------------------
  const fetchLayers = useCallback(async (force = false) => {
    if (!status) return;
    const now = performance.now();
    const lf = lastFetch.current;
    const changed = status.calendar.tick !== lf.tick || layerKey !== lf.key || status.world_id !== lf.world;
    if (!force && (!changed || now - lf.at < LAYER_REFRESH_MS)) return;
    lastFetch.current = { tick: status.calendar.tick, at: now, key: layerKey, world: status.world_id };
    try {
      const [l, e, f] = await Promise.all([
        api.layer(layerKey),
        // elevation changes only through slow erosion: refresh every ~10 simulated days
        !elevation || elevation.width !== status.width || status.calendar.tick - elevation.tick > 240 || elevation.tick > status.calendar.tick
          ? api.layer("elevation") : Promise.resolve(elevation),
        layerKey === "terrain" ? api.layer("fire") : Promise.resolve(null),
      ]);
      setLayer(l);
      setElevation(e);
      setFire(f);
    } catch { /* server restarting; next status tick retries */ }
  }, [status, layerKey, elevation]);

  useEffect(() => { fetchLayers(); }, [fetchLayers]);
  useEffect(() => { fetchLayers(true); }, [layerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- daily data: stats, history, events ----------------------------------
  useEffect(() => {
    if (!status) return;
    const d = lastDayFetch.current;
    if (d.day === status.calendar.day_total && d.world === status.world_id) return;
    lastDayFetch.current = { day: status.calendar.day_total, world: status.world_id };
    api.stats().then(setStats).catch(() => {});
    api.history().then(setHistory).catch(() => {});
    api.events().then(setEvents).catch(() => {});
  }, [status]);

  // also refresh events/stats a few times a day at high resolution speeds
  useEffect(() => {
    const t = setInterval(() => {
      api.events().then(setEvents).catch(() => {});
      api.stats().then(setStats).catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, []);

  const onStatus = (s: Status) => {
    setStatus(s);
    lastDayFetch.current = { day: -1, world: -1 };
  };

  const days = useMemo(() => history.map((h) => h.day), [history]);
  const col = (fn: (s: Stats) => number | null | undefined) => history.map((h) => { const v = fn(h); return v ?? null; });
  const first = history.length ? history[0] : null;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <div className="brand-mark">
            <span className="brand-en">DWAPAR</span>
            <span className="brand-hi">द्वापर</span>
          </div>
          <div className="brand-sub">
            <span>An Experiment in Digital Civilization</span>
            <span className="motto">We create the world. They create the future.</span>
          </div>
        </div>
        <ClockPanel status={status} onChange={onStatus} />
        <div className="station">
          <div><span className="dim">STATION</span> Drishti · Phase 1</div>
          <div><span className="dim">SEED</span> <span className="mono">{status?.seed ?? "—"}</span>
            <span className="dim"> · W</span><span className="mono">{status?.world_id ?? "—"}</span>
            <span className="dim"> · </span><span className="mono">{status ? `${status.width}×${status.height}` : ""}</span></div>
          <div><span className={`dot ${connected ? "live" : "down"}`} />{connected ? "telemetry link" : "link lost — retrying"}</div>
        </div>
      </header>

      <main className="grid">
        <section className="map-col">
          <div className="layers">
            {LAYER_ORDER.map((k) => (
              <button key={k} className={layerKey === k ? "on" : ""} onClick={() => setLayerKey(k)}>{LAYER_STYLES[k].label}</button>
            ))}
          </div>
          <MapView layer={layer} elevation={elevation} fire={fire} layerKey={layerKey} selected={selected}
            onSelect={(x, y) => setSelected({ x, y })} />
          <div className="map-foot dim">
            Scroll to zoom · drag to pan · click to inspect. Showing live engine state at tick{" "}
            <span className="mono">{layer?.tick ?? "—"}</span>. No inhabitants exist in Phase 1.
          </div>
        </section>

        <aside className="side">
          <Panel title="Tile inspector"><TileInspector sel={selected} tick={status?.calendar.tick ?? 0} /></Panel>
          <Panel title="Environment"><EnvironmentPanel stats={stats} /></Panel>
        </aside>

        <section className="bottom">
          <Panel title="Historical record" right={<span className="dim small">{history.length} daily samples</span>}>
            <div className="charts">
              <HistoryChart title="Temperature" unit="°C" x={days} series={[
                { label: "land", color: "#e3a04f", values: col((h) => h.temp_land_mean) },
                { label: "ocean", color: "#4aa3df", values: col((h) => h.temp_ocean_mean) },
              ]} />
              <HistoryChart title="Precipitation & soil" unit="" x={days} format={(v) => v.toFixed(2)} series={[
                { label: "precip mm/d", color: "#6fb7ff", values: col((h) => h.precip_mean_mm_day) },
                { label: "soil moisture×5", color: "#46d5c3", values: col((h) => h.soil_moisture_mean * 5) },
              ]} />
              <HistoryChart title="Vegetation" unit="" x={days} format={(v) => v.toFixed(3)} series={[
                { label: "density", color: "#6cc070", values: col((h) => h.vegetation_mean) },
                { label: "fertility", color: "#c9c35a", values: col((h) => h.fertility_mean) },
              ]} />
              <HistoryChart title="Fire & snow" unit="tiles" x={days} format={(v) => v.toFixed(0)} series={[
                { label: "burning", color: "#ff7a3d", values: col((h) => h.burning_tiles) },
                { label: "snow", color: "#d7e3ee", values: col((h) => h.snow_tiles) },
              ]} />
              <HistoryChart title="Water stores" unit="km³" x={days} format={(v) => v.toFixed(1)} series={[
                { label: "soil", color: "#b08a5a", values: col((h) => h.water_mm.soil * 4e-6) },
                { label: "land surface", color: "#4aa3df", values: col((h) => h.water_mm.land_surface * 4e-6) },
                { label: "atmosphere", color: "#a7b6c7", values: col((h) => h.water_mm.atmosphere * 4e-6) },
                { label: "snow", color: "#e8eef4", values: col((h) => h.water_mm.snow * 4e-6) },
              ]} />
              <HistoryChart title="Wood stock" unit="Mt" x={days} format={(v) => v.toFixed(0)} series={[
                { label: "wood Mt", color: "#8fbf6a", values: col((h) => h.resources.wood / 1e6) },
              ]} />
            </div>
          </Panel>
          <Panel title="Natural resources"><ResourcePanel stats={stats} first={first} /></Panel>
          <Panel title="Natural event timeline">
            <Timeline events={events} ticksPerDay={status?.ticks_per_day ?? 24} daysPerYear={status?.days_per_year ?? 360} onLocate={(x, y) => setSelected({ x, y })} />
          </Panel>
          <Panel title="World archive (Smriti)"><SaveLoad status={status} onChange={onStatus} /></Panel>
        </section>
      </main>
    </div>
  );
}
