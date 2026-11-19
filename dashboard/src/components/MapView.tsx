import { useCallback, useEffect, useRef, useState } from "react";
import type { Layer } from "../api";
import { LAYER_STYLES } from "../colormaps";

interface Props {
  layer: Layer | null;
  elevation: Layer | null;
  fire: Layer | null;
  layerKey: string;
  selected: { x: number; y: number } | null;
  onSelect: (x: number, y: number) => void;
}

interface View {
  scale: number;
  ox: number;
  oy: number;
}

function hillshade(elev: Layer): Float32Array {
  const { width: w, height: h } = elev;
  const e = elev.values as Float32Array;
  const out = new Float32Array(w * h);
  // light from the north-west, vertical exaggeration tuned for 2 km tiles
  const lx = -0.6, ly = -0.6, lz = 0.53;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const zl = e[y * w + Math.max(0, x - 1)], zr = e[y * w + Math.min(w - 1, x + 1)];
      const zu = e[Math.max(0, y - 1) * w + x], zd = e[Math.min(h - 1, y + 1) * w + x];
      const dx = (zr - zl) / 4000 * 6, dy = (zd - zu) / 4000 * 6;
      const len = Math.hypot(dx, dy, 1);
      const shade = (-dx * lx - dy * ly + lz) / len;
      out[i] = e[i] < 0 ? 1 : 0.55 + 0.75 * Math.max(0, Math.min(1, shade));
    }
  }
  return out;
}

export default function MapView({ layer, elevation, fire, layerKey, selected, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View>({ scale: 4, ox: 0, oy: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const shadeRef = useRef<{ tick: number; data: Float32Array } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; px: number; py: number } | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const fittedFor = useRef<string>("");

  // Build the layer bitmap (one pixel per tile) whenever new data arrives.
  useEffect(() => {
    if (!layer) return;
    const style = LAYER_STYLES[layerKey];
    const { width: w, height: h } = layer;
    const img = imageRef.current ?? document.createElement("canvas");
    img.width = w;
    img.height = h;
    const ctx = img.getContext("2d")!;
    const data = ctx.createImageData(w, h);
    const elev = elevation && elevation.width === w ? (elevation.values as Float32Array) : null;
    let shade: Float32Array | null = null;
    if (elevation && elev && (layerKey === "terrain" || layerKey === "elevation")) {
      if (!shadeRef.current || shadeRef.current.tick !== elevation.tick || shadeRef.current.data.length !== w * h) {
        shadeRef.current = { tick: elevation.tick, data: hillshade(elevation) };
      }
      shade = shadeRef.current.data;
    }
    const fireV = layerKey === "terrain" && fire && fire.width === w ? (fire.values as Float32Array) : null;
    for (let i = 0; i < w * h; i++) {
      let [r, g, b] = style.color(layer.values[i], elev ? elev[i] : 1);
      if (shade) {
        r *= shade[i]; g *= shade[i]; b *= shade[i];
      }
      if (fireV && fireV[i] > 0) {
        const t = 0.55 + 0.45 * fireV[i];
        r = r * (1 - t) + 255 * t; g = g * (1 - t) + 120 * t; b = b * (1 - t) + 20 * t;
      }
      data.data[i * 4] = r; data.data[i * 4 + 1] = g; data.data[i * 4 + 2] = b; data.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
    imageRef.current = img;
    const sig = `${w}x${h}`;
    if (fittedFor.current !== sig) {
      fittedFor.current = sig;
      fit(w, h);
    }
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, elevation, fire, layerKey]);

  const fit = useCallback((w: number, h: number) => {
    const s = Math.min(size.w / w, size.h / h) * 0.96;
    viewRef.current = { scale: s, ox: (size.w - w * s) / 2, oy: (size.h - h * s) / 2 };
  }, [size]);

  const draw = useCallback(() => {
    const c = canvasRef.current, img = imageRef.current;
    if (!c || !img) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#05080c";
    ctx.fillRect(0, 0, size.w, size.h);
    const { scale, ox, oy } = viewRef.current;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, ox, oy, img.width * scale, img.height * scale);
    // graticule every 16 tiles
    ctx.strokeStyle = "rgba(120,200,220,0.07)";
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= img.width; gx += 16) {
      ctx.beginPath(); ctx.moveTo(ox + gx * scale, oy); ctx.lineTo(ox + gx * scale, oy + img.height * scale); ctx.stroke();
    }
    for (let gy = 0; gy <= img.height; gy += 16) {
      ctx.beginPath(); ctx.moveTo(ox, oy + gy * scale); ctx.lineTo(ox + img.width * scale, oy + gy * scale); ctx.stroke();
    }
    if (selected) {
      ctx.strokeStyle = "#46d5c3";
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + selected.x * scale - 1, oy + selected.y * scale - 1, scale + 2, scale + 2);
    }
  }, [size, selected]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.max(200, width), h: Math.max(200, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    c.style.width = `${size.w}px`;
    c.style.height = `${size.h}px`;
    draw();
  }, [size, draw]);

  const toTile = (px: number, py: number) => {
    const { scale, ox, oy } = viewRef.current;
    return { x: Math.floor((px - ox) / scale), y: Math.floor((py - oy) / scale) };
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const v = viewRef.current;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const ns = Math.min(64, Math.max(1, v.scale * factor));
    viewRef.current = { scale: ns, ox: px - ((px - v.ox) * ns) / v.scale, oy: py - ((py - v.oy) * ns) / v.scale };
    draw();
  };

  const onDown = (e: React.MouseEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY, ox: viewRef.current.ox, oy: viewRef.current.oy, moved: false };
  };

  const onMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const d = dragRef.current;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      viewRef.current = { ...viewRef.current, ox: d.ox + dx, oy: d.oy + dy };
      draw();
    }
    const t = toTile(e.clientX - rect.left, e.clientY - rect.top);
    if (layer && t.x >= 0 && t.y >= 0 && t.x < layer.width && t.y < layer.height) {
      setHover({ ...t, px: e.clientX - rect.left, py: e.clientY - rect.top });
    } else setHover(null);
  };

  const onUp = (e: React.MouseEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.moved && layer) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const t = toTile(e.clientX - rect.left, e.clientY - rect.top);
      if (t.x >= 0 && t.y >= 0 && t.x < layer.width && t.y < layer.height) onSelect(t.x, t.y);
    }
  };

  const zoomBy = (f: number) => {
    const v = viewRef.current;
    const cx = size.w / 2, cy = size.h / 2;
    const ns = Math.min(64, Math.max(1, v.scale * f));
    viewRef.current = { scale: ns, ox: cx - ((cx - v.ox) * ns) / v.scale, oy: cy - ((cy - v.oy) * ns) / v.scale };
    draw();
  };

  const style = LAYER_STYLES[layerKey];
  const hv = hover && layer ? layer.values[hover.y * layer.width + hover.x] : null;

  return (
    <div className="map-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onWheel={onWheel}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => { dragRef.current = null; setHover(null); }}
      />
      <div className="map-zoom">
        <button onClick={() => zoomBy(1.4)} title="Zoom in">+</button>
        <button onClick={() => zoomBy(1 / 1.4)} title="Zoom out">−</button>
        <button onClick={() => { if (layer) { fit(layer.width, layer.height); draw(); } }} title="Fit world">⤢</button>
      </div>
      {style && style.gradient && (
        <div className="legend">
          <div className="legend-title">{style.label}</div>
          <div className="legend-bar" style={{ background: style.gradient }} />
          <div className="legend-ends"><span>{style.legend[0]}</span><span>{style.legend[1]}</span></div>
        </div>
      )}
      {hover && hv !== null && (
        <div className="map-tip" style={{ left: hover.px + 14, top: hover.py + 14 }}>
          <span className="mono">({hover.x}, {hover.y})</span> {style.format(hv)}
        </div>
      )}
      {!layer && <div className="map-empty">Awaiting telemetry…</div>}
    </div>
  );
}
