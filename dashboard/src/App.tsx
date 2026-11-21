import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, wsUrl, type Frame, type LifeData, type Stats, type Status, type WorldEvent } from "./api";
import { HEATMAPS, RESOURCE_NAMES, cssGradient, resourceStyle } from "./colormaps";
import HistoryChart from "./components/HistoryChart";
import MapStage, { type MapHandle } from "./components/MapStage";
import type { View3DHandle } from "./components/WorldView3D";

// The 3D explorer (Three.js, ~500 kB) is loaded only when first opened.
const WorldView3D = lazy(() => import("./components/WorldView3D"));
import { Archive, DisasterPanel, Inspector, PlanetPanel } from "./components/Panels";
import WorldTimeline from "./components/WorldTimeline";
import { WitnessPanel } from "./components/Witness";
import type { Overlays, ViewMode } from "./render/Renderer";

const LIVING_LAYERS = ["terrain", "vegetation", "moisture", "snow", "water", "flow", "flow_dir", "clouds", "rain",
  "insolation", "fire", "lava", "temperature", "ice"];
const FRAME_MS = 1000;
const SPEEDS: [string, number][] = [["1h", 1], ["6h", 6], ["1d", 24], ["5d", 120], ["30d", 720], ["Max", 0]];
const GROUPS = ["Environment", "Water", "Geology", "Hazards"] as const;

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [linked, setLinked] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [modeKey, setModeKey] = useState("living");
  const [overlays, setOverlays] = useState<Overlays>({ clouds: true, daynight: true, rivers: true, weather: true, fire: true, grid: false, markers: true });
  const [windRows, setWindRows] = useState<number[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<Stats[]>([]);
  const [events, setEvents] = useState<WorldEvent[]>([]);
  const [errors, setErrors] = useState<Record<string, number> | null>(null);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const [tab, setTab] = useState<"witness" | "planet" | "inspect" | "disasters">("planet");
  const [life, setLife] = useState<LifeData | null>(null);
  const [presence, setPresence] = useState<{ x: number; y: number } | null>(null);

  // simulated life and WITNESS's attention (where it last looked), polled from the engine
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const [l, w] = await Promise.all([api.life(), api.witness()]);
        if (!alive) return;
        setLife(l.present ? l : null);
        setPresence(w.attention ? { x: w.attention.x, y: w.attention.y } : null);
      } catch { /* engine restarting */ }
    };
    pull();
    const t = setInterval(pull, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [status?.world_id]);
  const [drawer, setDrawer] = useState(true);
  const [archive, setArchive] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const map = useRef<MapHandle>(null);
  const bar = useRef<HTMLElement>(null);
  const [barBottom, setBarBottom] = useState(78);
  // Panels sit below the *measured* top bar: fonts differ between machines and the bar may wrap.
  // Measured synchronously before the first paint (no frame with overlapping panels), then kept
  // up to date as the bar resizes (window width, font loading).
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const apply = () => {
      const b = Math.ceil(el.getBoundingClientRect().bottom) + 8;
      setBarBottom(b);
      document.documentElement.style.setProperty("--bar-bottom", `${b}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener("resize", apply);
    document.fonts?.ready.then(apply).catch(() => {});
    return () => { ro.disconnect(); window.removeEventListener("resize", apply); };
  }, []);
  const view3d = useRef<View3DHandle>(null);
  const [dim, setDim] = useState<"2d" | "3d">(() => { try { return localStorage.getItem("drishti.view") === "2d" ? "2d" : "3d"; } catch { return "3d"; } });
  useEffect(() => { try { localStorage.setItem("drishti.view", dim); } catch { /* storage unavailable */ } }, [dim]);
  const fetching = useRef(false);
  const lastFrame = useRef({ tick: -1, world: -1, key: "", at: 0, elevAt: -1e9 });
  const lastDay = useRef({ day: -1, world: -1 });

  // ---- live status ----------------------------------------------------------------------------
  useEffect(() => {
    let ws: WebSocket | null = null, timer: number | undefined, closed = false;
    const connect = () => {
      ws = new WebSocket(wsUrl());
      ws.onopen = () => setLinked(true);
      ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.type === "status") setStatus(msg.status); };
      ws.onclose = () => { setLinked(false); if (!closed) timer = window.setTimeout(connect, 1500); };
    };
    connect();
    api.status().then(setStatus).catch(() => {});
    const f = setInterval(() => setFps(view3d.current?.fps() ?? map.current?.fps() ?? 0), 1000);
    return () => { closed = true; clearInterval(f); window.clearTimeout(timer); ws?.close(); };
  }, []);

  const worldId = status?.world_id;
  useEffect(() => { if (worldId !== undefined) api.dynamics().then((d) => setWindRows(d.wind_u_rows)).catch(() => {}); }, [worldId]);

  // ---- view mode ------------------------------------------------------------------------------
  const resMax = frame?.ranges[modeKey]?.[1];
  const mode: ViewMode = useMemo(() => {
    if (modeKey.startsWith("res_")) return { kind: "resource", layer: modeKey, style: resourceStyle(modeKey.slice(4), resMax ?? 1) };
    if (modeKey !== "living") return { kind: "heatmap", layer: modeKey };
    return { kind: "living" };
  }, [modeKey, resMax]);

  // ---- frames: pulled from the engine only when it has advanced --------------------------------
  const pull = useCallback(async (force = false) => {
    if (!status || fetching.current) return;
    const lf = lastFrame.current, now = performance.now();
    const changed = status.calendar.tick !== lf.tick || status.world_id !== lf.world || modeKey !== lf.key;
    if (!force && (!changed || now - lf.at < FRAME_MS)) return;
    fetching.current = true;
    try {
      const names = new Set(LIVING_LAYERS);
      if (modeKey !== "living") names.add(modeKey);
      const elevStale = status.world_id !== lf.world || status.calendar.tick - lf.elevAt > 24 * 5 || status.calendar.tick < lf.elevAt;
      if (elevStale) names.add("elevation");
      const f = await api.frame([...names]);
      lastFrame.current = { tick: f.tick, world: status.world_id, key: modeKey, at: now, elevAt: elevStale ? f.tick : lf.elevAt };
      setFrame(f);
    } catch { /* engine restarting */ } finally { fetching.current = false; }
  }, [status, modeKey]);

  useEffect(() => { pull(); }, [pull]);
  useEffect(() => { pull(true); }, [modeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- daily data ------------------------------------------------------------------------------
  const refreshDaily = useCallback(() => {
    api.stats().then(setStats).catch(() => {});
    api.history().then(setHistory).catch(() => {});
    api.events().then(setEvents).catch(() => {});
    api.budgets().then((b) => setErrors(b.closure_errors)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!status) return;
    const d = lastDay.current;
    if (d.day === status.calendar.day_total && d.world === status.world_id) return;
    lastDay.current = { day: status.calendar.day_total, world: status.world_id };
    refreshDaily();
  }, [status, refreshDaily]);

  const onStatus = (s: Status) => { setStatus(s); lastDay.current = { day: -1, world: -1 }; lastFrame.current.world = -1; };
  const run = (p: Promise<Status>) => p.then((s) => { setErr(null); onStatus(s); }).catch((e) => setErr(e.message));

  const tpd = status?.ticks_per_day ?? 24, dpy = status?.days_per_year ?? 360;
  const nowTick = status?.calendar.tick ?? 0;
  const markers = useMemo(() => events
    .filter((e) => ["volcanic_eruption", "earthquake", "major_fire", "flood", "drought"].includes(e.kind))
    .map((e) => ({ ...e, age: (nowTick - e.tick) / tpd })).filter((e) => e.age < 120), [events, nowTick, tpd]);

  const locate = (x: number, y: number) => {
    setSelected({ x, y }); setTab("inspect"); map.current?.flyTo(x, y); view3d.current?.flyTo(x, y);
  };

  const shoot = async () => {
    const caption = `seed ${status?.seed} · W${status?.world_id} · ${status?.calendar.label} · ${modeKey === "living" ? "living view" : modeKey}`;
    const blob = dim === "3d" ? await view3d.current?.screenshot() : await map.current?.screenshot(caption);
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dwapar-seed${status?.seed}-tick${status?.calendar.tick}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const days = history.map((h) => h.day);
  const col = (fn: (s: Stats) => number | null | undefined) => history.map((h) => fn(h) ?? null);
  const legend = mode.kind === "heatmap" ? HEATMAPS[mode.layer] : mode.kind === "resource" ? mode.style : null;
  const c = status?.calendar;
  const simHps = status?.running ? (status.speed_hours_per_second || status.measured_ticks_per_second) : 0;

  return (
    <div className={`app ${drawer ? "" : "drawer-closed"}`}>
      {dim === "2d" ? (
        <MapStage ref={map} frame={frame} mode={mode} overlays={overlays} windRows={windRows} simHoursPerSecond={simHps}
          selected={selected} markers={markers}
          insets={{ left: 206, right: 352, top: barBottom, bottom: drawer ? 236 : 54 }} onSelect={(x, y) => { setSelected({ x, y }); setTab("inspect"); }} />
      ) : (
        <Suspense fallback={<div className="stage-empty">Loading the 3D world…</div>}>
          <WorldView3D ref={view3d} frame={frame} mode={mode} seed={status?.seed ?? 1} life={life} presence={presence} simHoursPerSecond={simHps}
            windMean={windRows.length ? windRows.reduce((a, b) => a + b, 0) / windRows.length : 0}
            onSelect={(x, y) => { setSelected({ x, y }); setTab("inspect"); }} />
        </Suspense>
      )}

      <header className="bar glass" ref={bar}>
        <div className="brand">
          <div className="wordmark"><span className="en">DWAPAR</span><span className="hi">द्वापर</span></div>
          <div className="tag-lines"><span>An Experiment in Digital Civilization</span><em>We create the world. They create the future.</em></div>
        </div>
        <div className="clock">
          <div className="age"><span className="dim">WORLD AGE</span><b className="mono">{status ? status.world_age_years.toFixed(3) : "—"}</b><span className="dim">years</span></div>
          <div className="date">
            <div className="mono">{c?.label ?? "—"}</div>
            <div className="sub"><i className={`dot ${status?.running ? "live" : ""}`} />{status?.running ? "running" : "paused"} · seed <span className="mono">{status?.seed}</span> · W{status?.world_id} · {status?.width}×{status?.height} · laws {status?.laws_version ?? "—"} · sea {status ? `${status.sea_level_m >= 0 ? "+" : ""}${status.sea_level_m.toFixed(2)} m` : "—"}</div>
          </div>
          <div className="ctl">
            {status?.running ? <button className="gold" onClick={() => run(api.control("pause"))}>❚❚ Pause</button>
              : <button className="gold" onClick={() => run(api.control("resume"))}>▶ Run</button>}
            <button disabled={status?.running} onClick={() => run(api.control("step", 1))} title="Advance one hour">+1h</button>
            <button disabled={status?.running} onClick={() => run(api.control("step", 24))} title="Advance one day">+1d</button>
            <div className="seg">{SPEEDS.map(([l, v]) => (
              <button key={l} className={status?.speed_hours_per_second === v ? "on" : ""} onClick={() => run(api.speed(v))} title={v ? `${v} simulated hours per second` : "as fast as possible"}>{l}</button>
            ))}</div>
          </div>
        </div>
        <div className="tools">
          <div className="seg dimseg">
            <button className={dim === "2d" ? "on" : ""} onClick={() => setDim("2d")} title="Flat observatory map">2D map</button>
            <button className={dim === "3d" ? "on" : ""} onClick={() => setDim("3d")} title="Explore the world in 3D">3D world</button>
          </div>
          <button onClick={shoot} title="Export a PNG of the current view">⤓ Capture</button>
          <button className={`witness-btn ${tab === "witness" ? "on" : ""}`} onClick={() => setTab("witness")} title="Speak with WITNESS, the world's steward">✦ WITNESS</button>
          <button onClick={() => setArchive(true)}>Archive</button>
          <span className={`link-state ${linked ? "" : "down"}`}><i className={`dot ${linked ? "live" : "down"}`} />{linked ? "telemetry" : "reconnecting"}</span>
        </div>
      </header>
      {(err || status?.error) && <div className="alert glass">{err ?? `Engine halted: ${status?.error}`}</div>}

      <nav className="dock left glass">
        <h3>Observe</h3>
        <button className={`lv ${modeKey === "living" ? "on" : ""}`} onClick={() => setModeKey("living")}>◉ Living planet</button>
        {GROUPS.map((g) => (
          <div key={g} className="grp">
            <h4>{g}</h4>
            {Object.entries(HEATMAPS).filter(([, s]) => s.group === g).map(([k, s]) => (
              <button key={k} className={modeKey === k ? "on" : ""} onClick={() => setModeKey(k)}>{s.label}</button>
            ))}
          </div>
        ))}
        <div className="grp">
          <h4>Resources</h4>
          {Object.keys(RESOURCE_NAMES).map((k) => (
            <button key={k} className={modeKey === `res_${k}` ? "on" : ""} onClick={() => setModeKey(`res_${k}`)}>{RESOURCE_NAMES[k]}</button>
          ))}
        </div>
        {dim === "2d" && <h3>Overlays</h3>}
        {dim === "2d" && <div className="toggles">
          {([["clouds", "Clouds"], ["daynight", "Day / night"], ["rivers", "River flow"], ["weather", "Rain"], ["fire", "Fire & lava"], ["markers", "Disasters"], ["grid", "Grid"]] as [keyof Overlays, string][]).map(([k, l]) => (
            <label key={k}><input type="checkbox" checked={overlays[k]} onChange={(e) => setOverlays({ ...overlays, [k]: e.target.checked })} />{l}</label>
          ))}
        </div>}
        {dim === "2d" && <div className="zoom">
          <button onClick={() => map.current?.zoom(1.5)}>+</button>
          <button onClick={() => map.current?.zoom(1 / 1.5)}>−</button>
          <button onClick={() => map.current?.fit()}>Fit</button>
        </div>}
      </nav>

      {legend && (
        <div className="legend glass">
          <div className="lt">{legend.label}</div>
          <div className="lb" style={{ background: cssGradient(legend.stops) }} />
          <div className="le"><span>{legend.legend[0]}</span><span>{legend.legend[1]}</span></div>
        </div>
      )}

      <aside className="dock right glass">
        <div className="tabs">
          {([["witness", "Witness"], ["planet", "Planet"], ["inspect", "Inspector"], ["disasters", "Disasters"]] as const).map(([k, l]) => (
            <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="tab-body">
          {tab === "witness" && <WitnessPanel status={status} life={life} onLocate={(x, y) => { setDim("3d"); setTimeout(() => view3d.current?.flyToMetres(x, y), 50); }} />}
          {tab === "planet" && <PlanetPanel status={status} stats={stats} first={history[0] ?? null} errors={errors} fps={fps} />}
          {tab === "inspect" && <Inspector sel={selected} tick={nowTick} />}
          {tab === "disasters" && <DisasterPanel events={events} tpd={tpd} dpy={dpy} onLocate={locate} />}
        </div>
      </aside>

      <section className={`drawer glass ${drawer ? "open" : ""}`}>
        <button className="handle" onClick={() => setDrawer(!drawer)}>{drawer ? "▾" : "▴"} World history</button>
        {drawer && (
          <>
            <WorldTimeline events={events} tick={nowTick} tpd={tpd} dpy={dpy} onLocate={locate} />
            <div className="charts">
              <HistoryChart title="Temperature" unit="°C" x={days} series={[
                { label: "land", color: "#e9c46a", values: col((h) => h.temp_land_mean) },
                { label: "ocean", color: "#5aa9d6", values: col((h) => h.sst_mean ?? h.temp_ocean_mean) }]} />
              <HistoryChart title="Water" unit="" x={days} format={(v) => v.toFixed(2)} series={[
                { label: "rain mm/d", color: "#7fb8ff", values: col((h) => h.precip_mean_mm_day) },
                { label: "soil×5", color: "#46d5c3", values: col((h) => h.soil_moisture_mean * 5) },
                { label: "aquifer m", color: "#9b8cff", values: col((h) => (h.groundwater_mean_mm ?? 0) / 1000) }]} />
              <HistoryChart title="Biosphere" unit="" x={days} format={(v) => v.toFixed(3)} series={[
                { label: "vegetation", color: "#7cc46a", values: col((h) => h.vegetation_mean) },
                { label: "fertility", color: "#c9a24a", values: col((h) => h.fertility_mean) }]} />
              <HistoryChart title="Fire · snow · lava" unit="tiles" x={days} format={(v) => v.toFixed(0)} series={[
                { label: "burning", color: "#ff7a3d", values: col((h) => h.burning_tiles) },
                { label: "snow", color: "#e6ecf2", values: col((h) => h.snow_tiles) },
                { label: "lava", color: "#ff3d2e", values: col((h) => h.lava_tiles ?? 0) }]} />
              <HistoryChart title="Wood stock" unit="Mt" x={days} format={(v) => v.toFixed(0)} series={[
                { label: "wood Mt", color: "#8fbf6a", values: col((h) => h.resources.wood / 1e6) }]} />
              <HistoryChart title="Sediment in motion" unit="Mt" x={days} format={(v) => v.toFixed(2)} series={[
                { label: "load Mt", color: "#c9a24a", values: col((h) => (h.sediment_in_transit_t ?? 0) / 1e6) }]} />
            </div>
          </>
        )}
      </section>

      {archive && <Archive status={status} onChange={onStatus} onClose={() => setArchive(false)} />}
    </div>
  );
}
