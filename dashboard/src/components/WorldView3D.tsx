import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Frame, LifeData } from "../api";
import { World3D, type Preset, type Quality, type RenderStats, type SunState } from "../render3d/World3D";
import type { ViewMode } from "../render/Renderer";

export interface View3DHandle {
  flyTo: (x: number, y: number) => void;
  flyToMetres: (x: number, y: number) => void;
  overview: () => void;
  screenshot: () => Promise<Blob | null>;
  fps: () => number;
}

interface Props {
  frame: Frame | null;
  mode: ViewMode;
  seed: number;
  simHoursPerSecond: number;
  windMean: number;
  onSelect: (x: number, y: number) => void;
  life: LifeData | null;
  presence: { x: number; y: number } | null;
}

const stored = <T extends string>(k: string, ok: readonly T[], def: T): T => {
  try { const v = localStorage.getItem(k) as T | null; return v && ok.includes(v) ? v : def; } catch { return def; }
};

const PRESETS: [Preset, string, string][] = [
  ["orbit", "Orbit", "The whole simulated world from high above"],
  ["region", "Region", "A regional view, tens of kilometres across"],
  ["low", "Low flight", "A few hundred metres above the ground"],
  ["ground", "Ground", "Stand on the surface at eye height (1.7 m)"],
];

const WorldView3D = forwardRef<View3DHandle, Props>(function WorldView3D({ frame, mode, seed, simHoursPerSecond, windMean, onSelect, life, presence }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<World3D | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exag, setExag] = useState(1);
  const [quality, setQuality] = useState<Quality>(() => stored("drishti.quality", ["low", "medium", "high"] as const, "medium"));
  const [scatter, setScatter] = useState(true);
  const [clouds, setClouds] = useState(true);
  const [shadows, setShadows] = useState(true);
  const [detail, setDetail] = useState(true);
  const [grid, setGrid] = useState(false);
  const [daylight, setDaylight] = useState(false);
  const [sun, setSun] = useState<SunState | null>(null);
  const [stats, setStats] = useState<RenderStats | null>(null);
  const [showStats, setShowStats] = useState(false);
  const down = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    try {
      world.current = new World3D(canvas.current!);
    } catch (e) {
      setError(`WebGL 2 is not available in this browser (${(e as Error).message}). The 2D map still works.`);
      return;
    }
    world.current.onQualityChange = (q) => setQuality(q);
    const ro = new ResizeObserver(([e]) => world.current?.resize(e.contentRect.width, e.contentRect.height));
    ro.observe(wrap.current!);
    const t = setInterval(() => { if (world.current) { setSun({ ...world.current.sunState }); setStats({ ...world.current.stats }); } }, 1000);
    return () => { ro.disconnect(); clearInterval(t); world.current?.dispose(); world.current = null; };
  }, []);

  useEffect(() => { world.current?.setSeed(seed); }, [seed]);
  useEffect(() => { if (frame) world.current?.setFrame(frame); }, [frame]);
  useEffect(() => { world.current?.setMode(mode); }, [mode]);
  useEffect(() => { world.current?.setLife(life); }, [life]);
  useEffect(() => { world.current?.setPresence(presence); }, [presence, frame?.width]);
  useEffect(() => { if (world.current) world.current.simHoursPerSecond = simHoursPerSecond; }, [simHoursPerSecond]);
  useEffect(() => { if (world.current) world.current.windMean = windMean; }, [windMean]);
  useEffect(() => { world.current?.setExaggeration(exag); }, [exag]);
  useEffect(() => {
    world.current?.setQuality(quality);
    try { localStorage.setItem("drishti.quality", quality); } catch { /* storage unavailable */ }
  }, [quality]);
  useEffect(() => { if (world.current) world.current.showTrees = scatter; }, [scatter]);
  useEffect(() => { if (world.current) world.current.showClouds = clouds; }, [clouds]);
  useEffect(() => { if (world.current) world.current.shadows = shadows; }, [shadows]);
  useEffect(() => { world.current?.setDetail(detail); }, [detail]);
  useEffect(() => { world.current?.setGrid(grid); }, [grid]);
  useEffect(() => { if (world.current) world.current.alwaysDay = daylight; }, [daylight]);

  useImperativeHandle(ref, () => ({
    flyTo: (x, y) => world.current?.flyTo(x, y),
    flyToMetres: (x, y) => world.current?.flyToMetres(x, y),
    overview: () => world.current?.overview(),
    screenshot: () => world.current ? world.current.screenshot() : Promise.resolve(null),
    fps: () => world.current?.fps ?? 0,
  }));

  const alt = stats?.altitude ?? 0;
  const altLabel = alt >= 10000 ? `${(alt / 1000).toFixed(0)} km` : alt >= 1000 ? `${(alt / 1000).toFixed(1)} km` : `${alt.toFixed(alt < 10 ? 1 : 0)} m`;

  return (
    <div className="stage three" ref={wrap}>
      <canvas ref={canvas}
        onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={(e) => {
          const d = down.current; down.current = null;
          if (e.button === 0 && d && Math.abs(d.x - e.clientX) + Math.abs(d.y - e.clientY) < 4) {
            const t = world.current?.pick(e.clientX, e.clientY);
            if (t) onSelect(t.x, t.y);
          }
        }} />
      {error && <div className="stage-empty">{error}</div>}
      <div className="cam3d glass">
        <div className="row presets">
          {PRESETS.map(([k, label, title]) => <button key={k} title={title} onClick={() => world.current?.preset(k)}>{label}</button>)}
          <span className="dim mono alt" title="Camera height above the ground">↥ {altLabel}</span>
        </div>
        <div className="row">
          <label title="Vertical exaggeration. 1 = true scale.">Relief ×<b className="mono">{exag}</b>
            <input type="range" min={1} max={3} step={0.5} value={exag} onChange={(e) => setExag(Number(e.target.value))} />
          </label>
          <label title="Rendering quality. Lowers automatically if the frame rate drops.">Quality
            <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
              <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </select>
          </label>
        </div>
        <div className="row toggles3d">
          <label title="Relief finer than the 2 km simulation tiles. Rendering only."><input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} />Procedural detail</label>
          <label title="Individual trees, rocks and grass, placed from simulated vegetation, temperature, snow and slope. Rendering only."><input type="checkbox" checked={scatter} onChange={(e) => setScatter(e.target.checked)} />Trees &amp; rocks</label>
          <label title="Outline the 2 km tiles the engine actually simulates"><input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />Show simulation grid</label>
          <label><input type="checkbox" checked={clouds} onChange={(e) => setClouds(e.target.checked)} />Clouds</label>
          <label><input type="checkbox" checked={shadows} onChange={(e) => setShadows(e.target.checked)} />Shadows</label>
          <label title="Viewing aid: light the world as at mid-morning instead of the simulated hour"><input type="checkbox" checked={daylight} onChange={(e) => setDaylight(e.target.checked)} />Daylight</label>
        </div>
        <div className="row note">
          <span className="honesty">Simulated at 2 km per tile. Finer relief, river meanders, trees, rocks and grass are deterministic rendering, not simulated objects. Animals, humans and shelters are simulated; coloured dots mark them from afar. The golden form is where WITNESS last looked.</span>
        </div>
        <div className="row">
          {sun && <span className="dim mono">sun {sun.elevationDeg.toFixed(0)}° {sun.isDay ? "☀" : "☾"}{daylight ? " (viewing aid)" : ""}</span>}
          <button className="link" onClick={() => setShowStats((s) => !s)}>{showStats ? "hide stats" : "stats"}</button>
        </div>
        {showStats && stats && <div className="row mono dim stats3d">
          {stats.fps} fps · {stats.frameMs} ms cpu · {stats.calls} draws · {(stats.triangles / 1e6).toFixed(2)} M tris · {stats.chunks} chunks · {stats.trees} trees · {stats.rocks} rocks · {stats.grass} grass · {stats.creatures} creatures drawn
        </div>}
        <span className="dim help">drag orbit (look when near ground) · right-drag pan · wheel fly to cursor · WASD move · R/F up/down · Q/E turn · Shift fast · click inspect</span>
      </div>
    </div>
  );
});

export default WorldView3D;
