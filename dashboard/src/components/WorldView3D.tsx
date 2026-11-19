import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Frame } from "../api";
import { World3D, type SunState } from "../render3d/World3D";
import type { ViewMode } from "../render/Renderer";

export interface View3DHandle {
  flyTo: (x: number, y: number) => void;
  overview: () => void;
  screenshot: () => Promise<Blob | null>;
  fps: () => number;
}

interface Props {
  frame: Frame | null;
  mode: ViewMode;
  simHoursPerSecond: number;
  windMean: number;
  onSelect: (x: number, y: number) => void;
}

const WorldView3D = forwardRef<View3DHandle, Props>(function WorldView3D({ frame, mode, simHoursPerSecond, windMean, onSelect }, ref) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<World3D | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exag, setExag] = useState(8);
  const [trees, setTrees] = useState(true);
  const [clouds, setClouds] = useState(true);
  const [shadows, setShadows] = useState(true);
  const [sun, setSun] = useState<SunState | null>(null);
  const down = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    try {
      world.current = new World3D(canvas.current!);
    } catch (e) {
      setError(`WebGL is not available in this browser (${(e as Error).message}). The 2D map still works.`);
      return;
    }
    const ro = new ResizeObserver(([e]) => world.current?.resize(e.contentRect.width, e.contentRect.height));
    ro.observe(wrap.current!);
    const t = setInterval(() => world.current && setSun({ ...world.current.sunState }), 1000);
    return () => { ro.disconnect(); clearInterval(t); world.current?.dispose(); world.current = null; };
  }, []);

  useEffect(() => { if (frame) world.current?.setFrame(frame); }, [frame]);
  useEffect(() => { world.current?.setMode(mode); }, [mode]);
  useEffect(() => { if (world.current) world.current.simHoursPerSecond = simHoursPerSecond; }, [simHoursPerSecond]);
  useEffect(() => { if (world.current) world.current.windMean = windMean; }, [windMean]);
  useEffect(() => { world.current?.setExaggeration(exag); }, [exag]);
  useEffect(() => { if (world.current) { world.current.showTrees = trees; if (frame) world.current.setFrame(frame); } }, [trees]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (world.current) world.current.showClouds = clouds; }, [clouds]);
  useEffect(() => { if (world.current) world.current.shadows = shadows; }, [shadows]);

  useImperativeHandle(ref, () => ({
    flyTo: (x, y) => world.current?.flyTo(x, y),
    overview: () => world.current?.overview(),
    screenshot: () => world.current ? world.current.screenshot() : Promise.resolve(null),
    fps: () => world.current?.fps ?? 0,
  }));

  return (
    <div className="stage three" ref={wrap}>
      <canvas ref={canvas}
        onPointerDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={(e) => {
          const d = down.current; down.current = null;
          if (d && Math.abs(d.x - e.clientX) + Math.abs(d.y - e.clientY) < 4) {
            const t = world.current?.pick(e.clientX, e.clientY);
            if (t) onSelect(t.x, t.y);
          }
        }} />
      {error && <div className="stage-empty">{error}</div>}
      <div className="cam3d glass">
        <label>Relief ×<b className="mono">{exag}</b>
          <input type="range" min={1} max={20} step={1} value={exag} onChange={(e) => setExag(Number(e.target.value))} />
        </label>
        <label><input type="checkbox" checked={trees} onChange={(e) => setTrees(e.target.checked)} />Forests</label>
        <label><input type="checkbox" checked={clouds} onChange={(e) => setClouds(e.target.checked)} />Clouds</label>
        <label><input type="checkbox" checked={shadows} onChange={(e) => setShadows(e.target.checked)} />Shadows</label>
        <button onClick={() => world.current?.overview()}>Overview</button>
        {sun && <span className="dim mono">sun {sun.elevationDeg.toFixed(0)}° {sun.isDay ? "☀" : "☾"}</span>}
        <span className="dim">drag orbit · right-drag pan · wheel zoom · WASD fly · Q/E turn · click inspect</span>
      </div>
    </div>
  );
});

export default WorldView3D;
