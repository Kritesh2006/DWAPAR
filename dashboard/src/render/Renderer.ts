// Drishti renderer — draws engine frames; never computes or alters simulation state.
//
// Two clocks are kept strictly apart:
//   * data clock  — a new Frame arrives from the engine (≈1 Hz); the base map is rebuilt from it;
//   * paint clock — requestAnimationFrame; only cosmetic motion is computed here (river particles,
//     cloud drift, rain streaks, fire flicker). Every animated element's *existence, position and
//     intensity* comes from the latest frame; motion between frames is extrapolated from engine
//     wind / flow data and the current simulation speed, and is reset when the next frame arrives.

import type { Frame, WorldEvent } from "../api";
import { HEATMAPS, naturalColor, type HeatStyle } from "../colormaps";

export type ViewMode = { kind: "living" } | { kind: "heatmap"; layer: string } | { kind: "resource"; layer: string; style: HeatStyle };

export interface Overlays {
  clouds: boolean;
  daynight: boolean;
  rivers: boolean;
  weather: boolean;
  fire: boolean;
  grid: boolean;
  markers: boolean;
}

interface View { scale: number; ox: number; oy: number }

// NEIGHBOURS order in engine/dwapar/grid.py: N, S, W, E, NW, NE, SW, SE  (dy, dx)
const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

const MAX_PARTICLES = 1800;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private base = document.createElement("canvas");
  private overlay = document.createElement("canvas");
  private cloud = document.createElement("canvas");
  private frame: Frame | null = null;
  private shade: Float32Array | null = null;
  private view: View = { scale: 4, ox: 0, oy: 0 };
  private target: View = { scale: 4, ox: 0, oy: 0 };
  private raf = 0;
  private w = 800;
  private h = 600;
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private pa = new Float32Array(MAX_PARTICLES);
  private riverCells: Int32Array = new Int32Array(0);
  private riverWeights: Float32Array = new Float32Array(0);
  private fitted = "";
  private lastPaint = performance.now();
  private fpsAcc = 0;
  private fpsN = 0;
  fps = 0;
  mode: ViewMode = { kind: "living" };
  overlays: Overlays = { clouds: true, daynight: true, rivers: true, weather: true, fire: true, grid: false, markers: true };
  windRows: number[] = [];
  simHoursPerSecond = 0;
  selected: { x: number; y: number } | null = null;
  markers: (WorldEvent & { age: number })[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() { cancelAnimationFrame(this.raf); }

  resize(w: number, h: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.frame && this.fitted !== `${w}x${h}`) this.fit(true);
  }

  // ------------------------------------------------------------------ data
  setFrame(f: Frame) {
    const sizeChanged = !this.frame || this.frame.width !== f.width || this.frame.height !== f.height;
    if (f.layers.elevation) {
      this.shade = this.hillshade(f.layers.elevation as Float32Array, f.width, f.height);
    } else if (this.frame && !sizeChanged) {
      f.layers.elevation = this.frame.layers.elevation; // elevation is refreshed less often
    }
    this.frame = f;
    if (sizeChanged) { this.fit(true); this.px.fill(-1); }
    this.rebuildBase();
    this.indexRivers();
  }

  setMode(m: ViewMode) { this.mode = m; this.rebuildBase(); }

  get hasFrame() { return !!this.frame; }
  get worldSize() { return this.frame ? { w: this.frame.width, h: this.frame.height } : null; }

  private hillshade(e: Float32Array, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const zl = e[y * w + Math.max(0, x - 1)], zr = e[y * w + Math.min(w - 1, x + 1)];
      const zu = e[Math.max(0, y - 1) * w + x], zd = e[Math.min(h - 1, y + 1) * w + x];
      const dx = ((zr - zl) / 4000) * 7, dy = ((zd - zu) / 4000) * 7;
      const s = (dx * 0.62 + dy * 0.62 + 0.48) / Math.hypot(dx, dy, 1);
      out[i] = e[i] < 0 ? 0.92 + 0.08 * Math.min(1, -e[i] / 3000) : 0.55 + 0.8 * Math.max(0, Math.min(1, s)); // flat ≈ 0.93
    }
    return out;
  }

  private rebuildBase() {
    const f = this.frame;
    if (!f) return;
    const { width: w, height: h } = f;
    for (const c of [this.base, this.overlay, this.cloud]) { c.width = w; c.height = h; }
    const ctx = this.base.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    const L = f.layers;
    const elev = L.elevation as Float32Array | undefined;
    const shade = this.shade && this.shade.length === w * h ? this.shade : null;
    const m = this.mode;
    let heat: HeatStyle | null = null;
    let src: Float32Array | Uint8Array | undefined;
    if (m.kind === "heatmap") { heat = HEATMAPS[m.layer]; src = L[m.layer]; }
    if (m.kind === "resource") { heat = m.style; src = L[m.layer]; }
    for (let i = 0; i < w * h; i++) {
      const e = elev ? elev[i] - f.sea_level : 1; // height above the current sea level
      let c: [number, number, number];
      if (heat && src) c = heat.color(src[i], e);
      else c = naturalColor({
        elev: e, veg: (L.vegetation as Float32Array)?.[i] ?? 0, moist: (L.moisture as Float32Array)?.[i] ?? 0.3,
        snow: (L.snow as Float32Array)?.[i] ?? 0, water: (L.water as Float32Array)?.[i] ?? 0,
        flow: (L.flow as Float32Array)?.[i] ?? 0, lava: (L.lava as Float32Array)?.[i] ?? 0,
        ice: (L.ice as Float32Array)?.[i] ?? 0,
      });
      const s = shade ? (heat ? 0.8 + 0.2 * shade[i] : shade[i]) : 1;
      img.data[i * 4] = Math.min(255, c[0] * s);
      img.data[i * 4 + 1] = Math.min(255, c[1] * s);
      img.data[i * 4 + 2] = Math.min(255, c[2] * s);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // Cloud texture (actual relative-humidity cloudiness) — drawn with wind drift each paint.
    const cl = L.clouds as Float32Array | undefined;
    if (cl) {
      const cctx = this.cloud.getContext("2d")!;
      const cimg = cctx.createImageData(w, h);
      const rain = L.rain as Float32Array | undefined;
      for (let i = 0; i < w * h; i++) {
        const a = cl[i];
        const storm = rain ? Math.min(1, rain[i] / 2) : 0;
        const g = 236 - storm * 110;
        cimg.data[i * 4] = g; cimg.data[i * 4 + 1] = g; cimg.data[i * 4 + 2] = g + 6;
        cimg.data[i * 4 + 3] = Math.min(170, a * a * 150 + storm * 40);
      }
      cctx.putImageData(cimg, 0, 0);
    }
  }

  private indexRivers() {
    const f = this.frame;
    if (!f || !f.layers.flow) return;
    const flow = f.layers.flow as Float32Array;
    const idx: number[] = [];
    const wts: number[] = [];
    for (let i = 0; i < flow.length; i++) if (flow[i] > 0.6) { idx.push(i); wts.push(1 + Math.log10(flow[i] / 0.6)); }
    this.riverCells = Int32Array.from(idx);
    const cum = new Float32Array(wts.length);
    let s = 0;
    for (let i = 0; i < wts.length; i++) { s += wts[i]; cum[i] = s; }
    this.riverWeights = cum;
  }

  private spawn(k: number) {
    const n = this.riverCells.length;
    const f = this.frame!;
    if (!n) { this.px[k] = -1; return; }
    const total = this.riverWeights[n - 1];
    const r = Math.random() * total;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.riverWeights[mid] < r) lo = mid + 1; else hi = mid; }
    const cell = this.riverCells[lo];
    this.px[k] = (cell % f.width) + Math.random();
    this.py[k] = Math.floor(cell / f.width) + Math.random();
    this.pa[k] = 0;
  }

  // ------------------------------------------------------------------ view
  /** Screen area not covered by docked panels (px): the world is fitted into this rectangle. */
  insets = { left: 0, right: 0, top: 0, bottom: 0 };

  fit(immediate = false) {
    if (!this.frame) return;
    const { width: w, height: h } = this.frame;
    const { left, right, top, bottom } = this.insets;
    const aw = Math.max(100, this.w - left - right), ah = Math.max(100, this.h - top - bottom);
    const s = Math.min(aw / w, ah / h) * 0.98;
    this.target = { scale: s, ox: left + (aw - w * s) / 2, oy: top + (ah - h * s) / 2 };
    if (immediate) this.view = { ...this.target };
    this.fitted = `${this.w}x${this.h}`;
  }

  zoomAt(px: number, py: number, factor: number) {
    const v = this.target;
    const ns = Math.min(80, Math.max(0.5, v.scale * factor));
    this.target = { scale: ns, ox: px - ((px - v.ox) * ns) / v.scale, oy: py - ((py - v.oy) * ns) / v.scale };
  }

  panBy(dx: number, dy: number) {
    this.target = { ...this.target, ox: this.target.ox + dx, oy: this.target.oy + dy };
    this.view = { ...this.view, ox: this.view.ox + dx, oy: this.view.oy + dy };
  }

  flyTo(x: number, y: number, scale?: number) {
    const s = scale ?? Math.max(this.target.scale, 10);
    this.target = { scale: s, ox: this.w / 2 - (x + 0.5) * s, oy: this.h / 2 - (y + 0.5) * s };
  }

  toTile(px: number, py: number) {
    const { scale, ox, oy } = this.view;
    return { x: Math.floor((px - ox) / scale), y: Math.floor((py - oy) / scale) };
  }

  // ----------------------------------------------------------------- paint
  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - this.lastPaint) / 1000);
    this.lastPaint = now;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 1) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }
    // smooth zoom / pan
    const k = 1 - Math.pow(0.0005, dt);
    this.view = {
      scale: this.view.scale + (this.target.scale - this.view.scale) * k,
      ox: this.view.ox + (this.target.ox - this.view.ox) * k,
      oy: this.view.oy + (this.target.oy - this.view.oy) * k,
    };
    this.paint(now / 1000, dt);
  }

  private paint(t: number, dt: number) {
    const ctx = this.ctx;
    ctx.fillStyle = "#030303";
    ctx.fillRect(0, 0, this.w, this.h);
    const f = this.frame;
    if (!f) return;
    const { scale, ox, oy } = this.view;
    const W = f.width * scale, H = f.height * scale;
    const living = this.mode.kind === "living";
    // Below ~4 px per tile smoothing hides aliasing; above it, crisp tiles show the true data resolution.
    ctx.imageSmoothingEnabled = scale < 4;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.base, ox, oy, W, H);

    // Simulated hours elapsed since this frame was captured (0 when paused); capped to one update.
    const simH = Math.min(2, ((performance.now() - f.receivedAt) / 1000) * this.simHoursPerSecond);

    if (living && this.overlays.rivers) this.paintRivers(dt, scale, ox, oy);
    if (this.overlays.fire) this.paintFire(t, scale, ox, oy);
    if (living && this.overlays.weather) this.paintRain(t, scale, ox, oy);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, W, H);
    ctx.clip(); // atmospheric overlays never spill outside the world
    if (living && this.overlays.clouds && f.layers.clouds) this.paintClouds(simH, scale, ox, oy);
    // Above ~12 simulated hours per second the hour changes several times per frame; shading would strobe,
    // so it fades out and the map shows daily-mean light instead.
    const nightStrength = Math.max(0, Math.min(1, 1 - (this.simHoursPerSecond - 6) / 12));
    if (living && this.overlays.daynight && f.layers.insolation && nightStrength > 0) this.paintNight(scale, ox, oy, nightStrength);
    ctx.restore();
    if (this.overlays.grid) this.paintGrid(scale, ox, oy);
    if (this.overlays.markers) this.paintMarkers(t, scale, ox, oy);
    if (this.selected) {
      ctx.strokeStyle = "#e9c46a";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ox + this.selected.x * scale - 1, oy + this.selected.y * scale - 1, scale + 2, scale + 2);
    }
    // world border
    ctx.strokeStyle = "rgba(201,162,74,0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox - 0.5, oy - 0.5, W + 1, H + 1);
  }

  private paintRivers(dt: number, scale: number, ox: number, oy: number) {
    const f = this.frame!;
    const dir = f.layers.flow_dir as Uint8Array | undefined;
    const flow = f.layers.flow as Float32Array | undefined;
    if (!dir || !flow || !this.riverCells.length) return;
    const ctx = this.ctx;
    const n = Math.min(MAX_PARTICLES, Math.max(60, this.riverCells.length * 3));
    ctx.fillStyle = "rgba(150,215,235,0.75)";
    const sz = Math.max(1, Math.min(3, scale * 0.18));
    for (let k = 0; k < n; k++) {
      if (this.px[k] < 0 || this.pa[k] > 1) { this.spawn(k); continue; }
      const cx = Math.floor(this.px[k]), cy = Math.floor(this.py[k]);
      if (cx < 0 || cy < 0 || cx >= f.width || cy >= f.height) { this.px[k] = -1; continue; }
      const i = cy * f.width + cx;
      const d = dir[i];
      if (d === 0 || flow[i] < 0.3 || f.layers.elevation && (f.layers.elevation as Float32Array)[i] < f.sea_level) { this.px[k] = -1; continue; }
      const [dy, dx] = DIRS[d - 1];
      const speed = 0.6 + Math.log10(1 + flow[i] * 4) * 0.8; // tiles per real second (visual), direction = engine data
      const norm = Math.hypot(dx, dy);
      this.px[k] += (dx / norm) * speed * dt;
      this.py[k] += (dy / norm) * speed * dt;
      this.pa[k] += dt * 0.35;
      const a = Math.sin(Math.PI * Math.min(1, this.pa[k]));
      ctx.globalAlpha = 0.25 + 0.6 * a;
      ctx.fillRect(ox + this.px[k] * scale - sz / 2, oy + this.py[k] * scale - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  private paintFire(t: number, scale: number, ox: number, oy: number) {
    const f = this.frame!;
    const fire = f.layers.fire as Float32Array | undefined;
    const lava = f.layers.lava as Float32Array | undefined;
    if (!fire && !lava) return;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "lighter";
    const r = Math.max(2, scale * 1.4);
    for (let i = 0; i < f.width * f.height; i++) {
      const fi = fire ? fire[i] : 0;
      const la = lava ? lava[i] : 0;
      if (fi <= 0 && la <= 0.02) continue;
      const x = ox + ((i % f.width) + 0.5) * scale, y = oy + (Math.floor(i / f.width) + 0.5) * scale;
      const flick = 0.75 + 0.25 * Math.sin(t * 9 + i * 1.7) * Math.sin(t * 5.3 + i * 0.37);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * (1 + (la > 0 ? 0.6 : 0)));
      if (la > 0.02) {
        g.addColorStop(0, `rgba(255,120,40,${0.75 * la * (0.85 + 0.15 * Math.sin(t * 2 + i))})`);
        g.addColorStop(1, "rgba(120,20,0,0)");
      } else {
        g.addColorStop(0, `rgba(255,200,90,${0.85 * fi * flick})`);
        g.addColorStop(0.4, `rgba(255,90,20,${0.5 * fi * flick})`);
        g.addColorStop(1, "rgba(120,20,0,0)");
      }
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 2, y - r * 2, r * 4, r * 4);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private paintRain(t: number, scale: number, ox: number, oy: number) {
    const f = this.frame!;
    const rain = f.layers.rain as Float32Array | undefined;
    if (!rain || scale < 3) return;
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(190,215,235,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const len = Math.min(10, scale * 0.6);
    for (let i = 0; i < f.width * f.height; i++) {
      const r = rain[i];
      if (r < 0.15) continue;
      const drops = Math.min(4, Math.ceil(r * 2));
      const bx = ox + (i % f.width) * scale, by = oy + Math.floor(i / f.width) * scale;
      for (let d = 0; d < drops; d++) {
        const ph = (t * 1.6 + ((i * 7919 + d * 104729) % 1000) / 1000) % 1;
        const x = bx + (((i * 31 + d * 17) % 97) / 97) * scale;
        const y = by + ph * scale;
        ctx.moveTo(x, y); ctx.lineTo(x - len * 0.25, y + len);
      }
    }
    ctx.stroke();
  }

  private paintClouds(simH: number, scale: number, ox: number, oy: number) {
    const f = this.frame!;
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    const bands = 16;
    const bh = f.height / bands;
    for (let b = 0; b < bands; b++) {
      const row = Math.min(f.height - 1, Math.floor((b + 0.5) * bh));
      const drift = (this.windRows[row] ?? 0) * simH; // tiles moved by the engine's wind since capture
      const sy = b * bh;
      for (const wrap of [0, -f.width, f.width]) {
        const dx = ox + (drift + wrap) * scale;
        if (dx > this.w || dx + f.width * scale < 0) continue;
        ctx.drawImage(this.cloud, 0, sy, f.width, bh, dx, oy + sy * scale, f.width * scale, bh * scale);
      }
    }
  }

  private paintNight(scale: number, ox: number, oy: number, strength: number) {
    const f = this.frame!;
    const ins = f.layers.insolation as Float32Array;
    const octx = this.overlay.getContext("2d")!;
    const img = octx.createImageData(f.width, f.height);
    for (let i = 0; i < f.width * f.height; i++) {
      const s = ins[i];
      const dark = 1 - Math.min(1, s / 0.18); // civil-twilight-ish softness
      img.data[i * 4] = 2; img.data[i * 4 + 1] = 5; img.data[i * 4 + 2] = 18;
      img.data[i * 4 + 3] = Math.round(dark * dark * 170 * strength);
    }
    octx.putImageData(img, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.overlay, ox, oy, f.width * scale, f.height * scale);
  }

  private paintGrid(scale: number, ox: number, oy: number) {
    const f = this.frame!;
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(201,162,74,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 0; gx <= f.width; gx += 16) { ctx.moveTo(ox + gx * scale, oy); ctx.lineTo(ox + gx * scale, oy + f.height * scale); }
    for (let gy = 0; gy <= f.height; gy += 16) { ctx.moveTo(ox, oy + gy * scale); ctx.lineTo(ox + f.width * scale, oy + gy * scale); }
    ctx.stroke();
  }

  private paintMarkers(t: number, scale: number, ox: number, oy: number) {
    const ctx = this.ctx;
    for (const m of this.markers) {
      if (m.x === null || m.y === null) continue;
      const x = ox + (m.x + 0.5) * scale, y = oy + (m.y + 0.5) * scale;
      const fade = Math.max(0.15, 1 - m.age / 60);
      const color = m.kind === "volcanic_eruption" ? "255,110,60" : m.kind === "earthquake" ? "233,196,106"
        : m.kind === "flood" ? "110,180,255" : m.kind === "drought" ? "220,170,90" : "255,150,70";
      const pulse = (t * 0.8 + (m.tick % 97) / 97) % 1;
      ctx.strokeStyle = `rgba(${color},${(1 - pulse) * 0.8 * fade})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 4 + pulse * Math.max(10, scale * 2.5), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgba(${color},${0.9 * fade})`;
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------- export
  async screenshot(caption: string): Promise<Blob | null> {
    const c = document.createElement("canvas");
    c.width = this.canvas.width; c.height = this.canvas.height;
    const x = c.getContext("2d")!;
    x.drawImage(this.canvas, 0, 0);
    const dpr = c.width / this.w;
    x.scale(dpr, dpr);
    x.fillStyle = "rgba(0,0,0,0.6)";
    x.fillRect(0, this.h - 30, this.w, 30);
    x.fillStyle = "#e9c46a";
    x.font = "600 13px Georgia, serif";
    x.fillText("DWAPAR · द्वापर", 14, this.h - 11);
    x.fillStyle = "#d8cfb8";
    x.font = "12px ui-monospace, monospace";
    x.fillText(caption, 140, this.h - 11);
    return new Promise((res) => c.toBlob(res, "image/png"));
  }
}
