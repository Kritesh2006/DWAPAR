// Hydrography for the 3D world, derived from SIMULATED water only.
// Rivers: every land tile with engine discharge ≥ 0.6 mm/h (the engine's river threshold), linked
// downstream along the engine's flow directions. Width follows hydraulic geometry w ≈ 4·Q^0.5 from
// the engine discharge Q. The smooth course between tile centres and its meanders are rendering-only
// (deterministic noise), and stay within about a tile of the simulated river.
// Lakes: connected engine lake tiles, drawn at the engine's own water level.

import { vnoise } from "./heightfield";

// NEIGHBOURS order in engine/dwapar/grid.py: N, S, W, E, NW, NE, SW, SE  (dy, dx)
const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];

export interface RiverPath { x: number[]; z: number[]; width: number[]; discharge: number[] }
export interface Lake { level: number; x0: number; z0: number; x1: number; z1: number; tiles: number }

export interface Hydro {
  rivers: RiverPath[];
  lakes: Lake[];
  maskRes: number;
  mask: Uint8Array;     // RGBA, R = channel, G = valley
  lakeMask: Uint8Array; // W×H, 255 = lake tile
}

export interface HydroInput {
  width: number; height: number; tile: number; sea: number; seed: number;
  elev: Float32Array; flow: Float32Array; flowDir: Uint8Array; water: Float32Array; terrain?: Uint8Array;
}

export function buildHydro(opts: HydroInput): Hydro {
  const { rivers, lakes, lakeMask } = hydrography(opts);
  const { width: W, height: H, tile } = opts;
  const maskRes = Math.min(2048, Math.max(512, W * 16));
  const mask = rasterise(rivers, maskRes, W * tile, H * tile, lakeMask, W, H);
  return { rivers, lakes, maskRes, mask, lakeMask };
}

/** Rivers and lakes from simulated water only (pure; no rendering). */
export function hydrography(opts: HydroInput): Pick<Hydro, "rivers" | "lakes" | "lakeMask"> {
  const { width: W, height: H, tile, sea, elev, flow, flowDir, water, terrain, seed } = opts;
  const n = W * H;
  const land = (i: number) => elev[i] >= sea;
  const isLake = new Uint8Array(n);
  for (let i = 0; i < n; i++) isLake[i] = land(i) && (water[i] > 1500 || (terrain ? terrain[i] === 1 : false)) ? 1 : 0;
  const isRiver = (i: number) => land(i) && !isLake[i] && flow[i] >= 0.6;
  const cx = (i: number) => ((i % W) + 0.5 - W / 2) * tile;
  const cz = (i: number) => (Math.floor(i / W) + 0.5 - H / 2) * tile;
  const next = new Int32Array(n).fill(-1);
  const upstream = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!isRiver(i) || flowDir[i] === 0) continue;
    const [dy, dx] = DIRS[flowDir[i] - 1];
    const x = (i % W) + dx, y = Math.floor(i / W) + dy;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const j = y * W + x;
    next[i] = j;
    if (isRiver(j)) upstream[j]++;
  }
  // ---- trace paths: start at river heads, stop at sea / lake / pit / confluence
  const visited = new Uint8Array(n);
  const rivers: RiverPath[] = [];
  const starts: number[] = [];
  for (let i = 0; i < n; i++) if (isRiver(i) && upstream[i] === 0) starts.push(i);
  for (let i = 0; i < n; i++) if (isRiver(i) && upstream[i] > 0) starts.push(i); // loops/remaining
  for (const s of starts) {
    if (visited[s]) continue;
    const ids: number[] = [];
    let i = s;
    while (i >= 0 && !visited[i] && isRiver(i)) {
      visited[i] = 1;
      ids.push(i);
      i = next[i];
    }
    const tail = i; // where it ends: sea, lake, already-traced river (confluence), or -1
    if (ids.length === 0) continue;
    const px = ids.map(cx), pz = ids.map(cz), q = ids.map((k) => flow[k]);
    if (tail >= 0) { px.push(cx(tail)); pz.push(cz(tail)); q.push(flow[ids[ids.length - 1]]); }
    if (px.length < 2) continue;
    rivers.push(smoothPath(px, pz, q, tile, seed + rivers.length * 31));
  }
  // ---- lakes: connected components at their engine water level
  const comp = new Int32Array(n).fill(-1);
  const lakes: Lake[] = [];
  for (let i = 0; i < n; i++) {
    if (!isLake[i] || comp[i] >= 0) continue;
    const id = lakes.length;
    const stack = [i];
    comp[i] = id;
    const levels: number[] = [];
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    while (stack.length) {
      const k = stack.pop()!;
      levels.push(elev[k] + water[k] / 1000);
      x0 = Math.min(x0, cx(k)); x1 = Math.max(x1, cx(k)); z0 = Math.min(z0, cz(k)); z1 = Math.max(z1, cz(k));
      const kx = k % W, ky = Math.floor(k / W);
      for (const [dy, dx] of DIRS) {
        const x = kx + dx, y = ky + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const j = y * W + x;
        if (isLake[j] && comp[j] < 0) { comp[j] = id; stack.push(j); }
      }
    }
    levels.sort((a, b) => a - b);
    lakes.push({ level: levels[Math.floor(levels.length / 2)], x0: x0 - tile, z0: z0 - tile, x1: x1 + tile, z1: z1 + tile, tiles: levels.length });
  }
  const lakeMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) lakeMask[i] = isLake[i] ? 255 : 0;
  return { rivers, lakes, lakeMask };
}

function smoothPath(px: number[], pz: number[], q: number[], tile: number, seed: number): RiverPath {
  const out: RiverPath = { x: [], z: [], width: [], discharge: [] };
  const sub = 10;
  const at = (a: number[], k: number) => a[Math.max(0, Math.min(a.length - 1, k))];
  let s = 0;
  let lx = px[0], lz = pz[0];
  for (let k = 0; k < px.length - 1; k++) {
    for (let t = 0; t < sub; t++) {
      const u = t / sub;
      const cr = (a: number[]) => {
        const p0 = at(a, k - 1), p1 = at(a, k), p2 = at(a, k + 1), p3 = at(a, k + 2);
        return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
      };
      let x = cr(px), z = cr(pz);
      const qq = q[k] + (q[k + 1] - q[k]) * u;
      s += Math.hypot(x - lx, z - lz);
      // meanders: deterministic lateral offset, damped at both ends so confluences/mouths stay put
      const tx = at(px, k + 1) - at(px, k), tz = at(pz, k + 1) - at(pz, k);
      const tl = Math.hypot(tx, tz) || 1;
      const ends = Math.min(1, Math.min(k + u, px.length - 1 - (k + u)) / 1.5);
      const off = (vnoise(s / 1400, 0.5, seed) - 0.5) * 2 * 0.22 * tile * ends;
      x += (-tz / tl) * off; z += (tx / tl) * off;
      lx = x; lz = z;
      const Q = qq * (tile * tile) / 1000 / 3600; // engine discharge (mm/h over a tile) → m³/s
      out.x.push(x); out.z.push(z); out.discharge.push(Q); out.width.push(Math.max(3, 4 * Math.sqrt(Q)));
    }
  }
  out.x.push(px[px.length - 1]); out.z.push(pz[pz.length - 1]);
  out.width.push(out.width[out.width.length - 1] ?? 3); out.discharge.push(out.discharge[out.discharge.length - 1] ?? 1);
  return out;
}

function rasterise(rivers: RiverPath[], res: number, mapW: number, mapH: number, lakeMask: Uint8Array, W: number, H: number): Uint8Array {
  const px = (x: number) => (x / mapW + 0.5) * res, pz = (z: number) => (z / mapH + 0.5) * res;
  const mpp = mapW / res; // metres per mask pixel
  // each layer is stroked sharp on its own canvas, then blurred ONCE while compositing
  const layer = (color: string, widthM: (w: number) => number, lakes: boolean) => {
    const c = document.createElement("canvas");
    c.width = c.height = res;
    const g = c.getContext("2d")!;
    g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = color; g.fillStyle = color;
    if (lakes) for (let i = 0; i < W * H; i++) if (lakeMask[i]) g.fillRect(((i % W) / W) * res - 1, (Math.floor(i / W) / H) * res - 1, res / W + 2, res / H + 2);
    for (const r of rivers) {
      for (let k = 0; k < r.x.length - 1; k++) {
        g.lineWidth = Math.max(1.2, widthM(r.width[k]) / mpp);
        g.beginPath(); g.moveTo(px(r.x[k]), pz(r.z[k])); g.lineTo(px(r.x[k + 1]), pz(r.z[k + 1])); g.stroke();
      }
    }
    return c;
  };
  const out = document.createElement("canvas");
  out.width = out.height = res;
  const g = out.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#000"; g.fillRect(0, 0, res, res);
  g.globalCompositeOperation = "lighter";
  // valley floor (G): calms relief so the river runs downhill; lake beds likewise
  g.filter = "blur(3px)"; g.drawImage(layer("rgb(0,255,0)", (w) => 900 + 25 * w, true), 0, 0);
  // channel (R)
  g.filter = "blur(0.6px)"; g.drawImage(layer("rgb(255,0,0)", (w) => w * 2.2, false), 0, 0);
  g.filter = "none";
  return new Uint8Array(g.getImageData(0, 0, res, res).data.buffer.slice(0));
}
