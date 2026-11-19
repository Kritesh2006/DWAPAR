import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Frame, WorldEvent } from "../api";
import { HEATMAPS, TERRAIN_CLASSES, fmtBig, type HeatStyle } from "../colormaps";
import { Renderer, type Overlays, type ViewMode } from "../render/Renderer";

export interface MapHandle {
  flyTo: (x: number, y: number) => void;
  fit: () => void;
  zoom: (f: number) => void;
  screenshot: (caption: string) => Promise<Blob | null>;
  fps: () => number;
}

interface Props {
  frame: Frame | null;
  mode: ViewMode;
  overlays: Overlays;
  windRows: number[];
  simHoursPerSecond: number;
  selected: { x: number; y: number } | null;
  markers: (WorldEvent & { age: number })[];
  insets: { left: number; right: number; top: number; bottom: number };
  onSelect: (x: number, y: number) => void;
}

function describe(frame: Frame, mode: ViewMode, x: number, y: number): string {
  const i = y * frame.width + x;
  const L = frame.layers;
  if (mode.kind === "heatmap") {
    const v = L[mode.layer]?.[i];
    return v === undefined ? "" : HEATMAPS[mode.layer].format(v);
  }
  if (mode.kind === "resource") {
    const v = L[mode.layer]?.[i];
    return v === undefined ? "" : (mode.style as HeatStyle).format(v);
  }
  const t = L.terrain ? TERRAIN_CLASSES[L.terrain[i]] : "";
  const e = L.elevation ? (L.elevation as Float32Array)[i] : NaN;
  const temp = L.temperature ? `${(L.temperature as Float32Array)[i].toFixed(1)} °C` : "";
  return `${t} · ${Number.isFinite(e) ? `${e.toFixed(0)} m` : ""} ${temp ? `· ${temp}` : ""}${
    L.flow && (L.flow as Float32Array)[i] > 0.6 ? ` · river ${fmtBig((L.flow as Float32Array)[i])} mm/h` : ""}`;
}

const MapStage = forwardRef<MapHandle, Props>(function MapStage(
  { frame, mode, overlays, windRows, simHoursPerSecond, selected, markers, insets, onSelect }, ref,
) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const r = useRef<Renderer | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    r.current = new Renderer(canvas.current!);
    const ro = new ResizeObserver(([e]) => r.current?.resize(e.contentRect.width, e.contentRect.height));
    ro.observe(wrap.current!);
    return () => { ro.disconnect(); r.current?.destroy(); };
  }, []);

  useEffect(() => { if (frame) r.current?.setFrame(frame); }, [frame]);
  useEffect(() => { r.current?.setMode(mode); }, [mode]);
  useEffect(() => { if (r.current) r.current.overlays = overlays; }, [overlays]);
  useEffect(() => { if (r.current) r.current.windRows = windRows; }, [windRows]);
  useEffect(() => { if (r.current) r.current.simHoursPerSecond = simHoursPerSecond; }, [simHoursPerSecond]);
  useEffect(() => { if (r.current) r.current.selected = selected; }, [selected]);
  useEffect(() => { if (r.current) r.current.markers = markers; }, [markers]);
  useEffect(() => { if (r.current) { r.current.insets = insets; r.current.fit(); } }, [insets.left, insets.right, insets.top, insets.bottom]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    flyTo: (x, y) => r.current?.flyTo(x, y),
    fit: () => r.current?.fit(),
    zoom: (f) => { const c = canvas.current!; r.current?.zoomAt(c.clientWidth / 2, c.clientHeight / 2, f); },
    screenshot: (caption) => r.current ? r.current.screenshot(caption) : Promise.resolve(null),
    fps: () => r.current?.fps ?? 0,
  }));

  const local = (e: React.MouseEvent | React.WheelEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return { px: e.clientX - rect.left, py: e.clientY - rect.top };
  };

  return (
    <div className="stage" ref={wrap}>
      <canvas
        ref={canvas}
        onWheel={(e) => { const { px, py } = local(e); r.current?.zoomAt(px, py, Math.exp(-e.deltaY * 0.0016)); }}
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (d) {
            const dx = e.clientX - d.x, dy = e.clientY - d.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
            r.current?.panBy(dx, dy);
            d.x = e.clientX; d.y = e.clientY;
          }
          const { px, py } = local(e);
          const t = r.current?.toTile(px, py);
          if (frame && t && t.x >= 0 && t.y >= 0 && t.x < frame.width && t.y < frame.height) setHover({ ...t, px, py });
          else setHover(null);
        }}
        onMouseUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved && frame) {
            const { px, py } = local(e);
            const t = r.current!.toTile(px, py);
            if (t.x >= 0 && t.y >= 0 && t.x < frame.width && t.y < frame.height) onSelect(t.x, t.y);
          }
        }}
        onMouseLeave={() => { drag.current = null; setHover(null); }}
      />
      {hover && frame && (
        <div className="tip" style={{ left: hover.px + 16, top: hover.py + 16 }}>
          <span className="mono gold">{hover.x},{hover.y}</span> {describe(frame, mode, hover.x, hover.y)}
        </div>
      )}
      {!frame && <div className="stage-empty">Establishing telemetry link…</div>}
    </div>
  );
});

export default MapStage;
