// Multiresolution height function shared by CPU (TypeScript) and GPU (GLSL).
//
//   H(x, z) = macro(x, z)              ← the SIMULATION: bicubic interpolation of the engine's 2 km tiles
//           − riverCarve(x, z)         ← rendering: channels along SIMULATED rivers (position/width from engine flow)
//           + detail(x, z)             ← rendering: deterministic procedural relief, seeded by the world seed
//
// The detail term is *rendering only*. It is zero-mean, its roughness is chosen from the simulated
// context (height above sea, mountains vs plains), it vanishes at coastlines so shorelines stay where
// the simulation puts them, and it is calmed along simulated river valleys. Nothing here feeds back
// into the engine. Both implementations below follow the same formulas so camera collision, object
// placement and picking (CPU) agree with what is drawn (GPU) to within float rounding.

export const DETAIL_WAVELENGTHS = [3200, 1600, 800, 400, 200, 100, 50, 25, 12.5, 6.25, 3.125, 1.5625];
export const EDGE_FALL = 14000; // metres over which land beyond the map edge sinks to −1500 m
const RIDGE_BIAS = 0.122; // E[1 − |2n − 1|] − 0.5 for this value noise, measured over 1.3 M samples
const OFFSET = 1048576; // keeps integer lattice coordinates positive (exact in float32)

// ------------------------------------------------------------------ TypeScript implementation
export function hash3(x: number, y: number, seed: number): number {
  let h = (Math.imul(x >>> 0, 0x8da6b343) ^ Math.imul(y >>> 0, 0xd8163841) ^ Math.imul(seed >>> 0, 0xcb1ab31f)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export function vnoise(px: number, py: number, seed: number): number {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = fade(px - ix), fy = fade(py - iy);
  const x = ix + OFFSET, y = iy + OFFSET;
  const a = hash3(x, y, seed), b = hash3(x + 1, y, seed), c = hash3(x, y + 1, seed), d = hash3(x + 1, y + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Procedural relief (m). `above` = macro height above sea level (m); `valley` ∈ [0,1] calms relief near rivers. */
export function detailHeight(wx: number, wz: number, above: number, valley: number, seed: number, minWl = 0): number {
  const land = smoothstep(2, 40, above);
  const hills = smoothstep(150, 800, above);
  const mtn = smoothstep(800, 2200, above);
  const under = smoothstep(-5, -150, above);
  const calm = 1 - 0.95 * valley;
  const big = (18 + 110 * hills + 380 * mtn) * land * calm + 25 * under;
  let h = 0;
  for (let k = 0; k < DETAIL_WAVELENGTHS.length; k++) {
    const wl = DETAIL_WAVELENGTHS[k];
    if (wl < minWl) break;
    const n = vnoise(wx / wl, wz / wl, seed + k * 7919);
    const ridged = 1 - Math.abs(2 * n - 1) - RIDGE_BIAS; // recentred: mean of ridged value noise is 0.622
    const v = k < 4 ? (n * (1 - mtn) + ridged * mtn) : n;
    let amp = big * Math.pow(0.5, k);
    if (wl < 30) amp += (0.12 + 0.5 * hills + 1.2 * mtn) * land * Math.pow(0.62, k - 7); // ground roughness
    h += (v - 0.5) * 2 * amp;
  }
  return h;
}

/** Organic warp for looking up the 2 km simulation FIELDS (vegetation, moisture, temperature…) so
 *  boundaries between tiles render as natural shapes rather than squares. Shifts ≤ ~1.4 km
 *  (under one tile). Not applied to elevation, lakes, rivers, the grid overlay or heatmaps. */
export function fieldWarp(wx: number, wz: number, seed: number): [number, number] {
  const ax = vnoise(wx / 2600, wz / 2600, seed + 60) - 0.5, az = vnoise(wx / 2600, wz / 2600, seed + 61) - 0.5;
  const bx = vnoise(wx / 700, wz / 700, seed + 62) - 0.5, bz = vnoise(wx / 700, wz / 700, seed + 63) - 0.5;
  return [wx + ax * 2200 + bx * 600, wz + az * 2200 + bz * 600];
}

/** Fraction of ground under tree canopy, from simulated biomass and deterministic clearings.
 *  Used identically by the terrain shader (distant canopy) and by tree placement (near trees). */
export function canopyFrac(veg: number, wx: number, wz: number, seed: number): number {
  const clearing = 0.6 * vnoise(wx / 230, wz / 230, seed + 40) + 0.4 * vnoise(wx / 1500, wz / 1500, seed + 43);
  return smoothstep(0.18, 0.7, veg) * (0.3 + 0.7 * smoothstep(0.3, 0.62, clearing));
}

export interface FieldSource {
  width: number; height: number; tile: number; sea: number; seed: number;
  elev: Float32Array;
  /** river channel (R) and valley (G) masks, resolution r×r over the map */
  river?: { r: number; data: Uint8Array };
}

export class HeightField {
  constructor(public src: FieldSource) {}
  detailOn = true;

  private e(ix: number, iy: number): number {
    const { width: w, height: h, elev } = this.src;
    ix = ix < 0 ? 0 : ix >= w ? w - 1 : ix;
    iy = iy < 0 ? 0 : iy >= h ? h - 1 : iy;
    return elev[iy * w + ix];
  }

  /** Bicubic (Catmull-Rom) interpolation of the simulated elevation; world metres, map centred on 0. */
  macro(wx: number, wz: number): number {
    const { width: w, height: h, tile } = this.src;
    const gx = (wx + 0.5 * w * tile) / tile - 0.5, gz = (wz + 0.5 * h * tile) / tile - 0.5;
    const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz;
    const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
      p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
    const row = (y: number) => cr(this.e(ix - 1, y), this.e(ix, y), this.e(ix + 1, y), this.e(ix + 2, y), fx);
    const m = cr(row(iz - 1), row(iz), row(iz + 1), row(iz + 2), fz);
    // beyond the simulated map the ground falls away into deep sea (rendering only, so the world has no walls)
    const out = Math.max(Math.abs(wx) - 0.5 * w * tile, Math.abs(wz) - 0.5 * h * tile);
    return out > 0 ? m - smoothstep(0, EDGE_FALL, out) * (m - (this.src.sea - 1500)) : m;
  }

  /** River channel / valley masks (0..1), bilinear. */
  river(wx: number, wz: number): [number, number] {
    const rv = this.src.river;
    if (!rv) return [0, 0];
    const { width: w, height: h, tile } = this.src;
    const u = (wx / (w * tile) + 0.5) * rv.r - 0.5, v = (wz / (h * tile) + 0.5) * rv.r - 0.5;
    const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
    const g = (x: number, y: number, c: number) => {
      x = Math.min(rv.r - 1, Math.max(0, x)); y = Math.min(rv.r - 1, Math.max(0, y));
      return rv.data[(y * rv.r + x) * 4 + c] / 255;
    };
    const bl = (c: number) => (g(x0, y0, c) * (1 - fx) + g(x0 + 1, y0, c) * fx) * (1 - fy) + (g(x0, y0 + 1, c) * (1 - fx) + g(x0 + 1, y0 + 1, c) * fx) * fy;
    return [bl(0), bl(1)];
  }

  /** Full rendered height (m above datum, NOT exaggerated). */
  height(wx: number, wz: number, minWl = 0): number {
    const m = this.macro(wx, wz);
    const above = m - this.src.sea;
    const [ch, valley] = this.river(wx, wz);
    const land = smoothstep(2, 40, above);
    const carve = 7 * ch * smoothstep(0.5, 6, above);
    const d = this.detailOn ? detailHeight(wx, wz, above, valley, this.src.seed, minWl) : 0;
    return m - carve - 4 * valley * land + d;
  }
}

// ------------------------------------------------------------------ GLSL implementation (same formulas)
export const GLSL_HEIGHT = /* glsl */ `
uniform sampler2D uElev;     // R32F simulation elevation (m), NEAREST
uniform sampler2D uRiver;    // RGBA8: R channel mask, G valley mask (linear)
uniform vec2 uGrid;          // tiles (W, H)
uniform float uTile;         // metres per tile
uniform float uSea;          // engine sea level (m)
uniform float uSeed;
uniform float uDetail;       // 1 = procedural detail on, 0 = simulated surface only

uint hashU(uvec3 v) {
  uint h = (v.x * 0x8da6b343u) ^ (v.y * 0xd8163841u) ^ (v.z * 0xcb1ab31fu);
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
  return h;
}
float hash3f(float x, float y, float s) { return float(hashU(uvec3(uint(x), uint(y), uint(s)))) / 4294967296.0; }
float fadeQ(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float vnoise(vec2 p, float seed) {
  vec2 i = floor(p); vec2 f = p - i;
  float fx = fadeQ(f.x), fy = fadeQ(f.y);
  float x = i.x + 1048576.0, y = i.y + 1048576.0;
  float a = hash3f(x, y, seed), b = hash3f(x + 1.0, y, seed), c = hash3f(x, y + 1.0, seed), d = hash3f(x + 1.0, y + 1.0, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
vec2 fieldWarp(vec2 w) {
  vec2 a = vec2(vnoise(w / 2600.0, uSeed + 60.0), vnoise(w / 2600.0, uSeed + 61.0)) - 0.5;
  vec2 b = vec2(vnoise(w / 700.0, uSeed + 62.0), vnoise(w / 700.0, uSeed + 63.0)) - 0.5;
  return w + a * 2200.0 + b * 600.0;
}
float canopyFrac(float veg, vec2 w) {
  float clearing = 0.6 * vnoise(w / 230.0, uSeed + 40.0) + 0.4 * vnoise(w / 1500.0, uSeed + 43.0);
  return smoothstep(0.18, 0.7, veg) * (0.3 + 0.7 * smoothstep(0.3, 0.62, clearing));
}
const float WL[12] = float[12](3200.0, 1600.0, 800.0, 400.0, 200.0, 100.0, 50.0, 25.0, 12.5, 6.25, 3.125, 1.5625);
float detailHeight(vec2 w, float above, float valley, float minWl) {
  float land = smoothstep(2.0, 40.0, above);
  float hills = smoothstep(150.0, 800.0, above);
  float mtn = smoothstep(800.0, 2200.0, above);
  float under = smoothstep(-5.0, -150.0, above);
  float calm = 1.0 - 0.95 * valley;
  float big = (18.0 + 110.0 * hills + 380.0 * mtn) * land * calm + 25.0 * under;
  float h = 0.0;
  for (int k = 0; k < 12; k++) {
    float wl = WL[k];
    if (wl < minWl) break;
    float n = vnoise(w / wl, uSeed + float(k) * 7919.0);
    float ridged = 1.0 - abs(2.0 * n - 1.0) - 0.122;
    float v = k < 4 ? (n * (1.0 - mtn) + ridged * mtn) : n;
    float amp = big * pow(0.5, float(k));
    if (wl < 30.0) amp += (0.12 + 0.5 * hills + 1.2 * mtn) * land * pow(0.62, float(k - 7));
    h += (v - 0.5) * 2.0 * amp;
  }
  return h;
}
float elevAt(ivec2 t) { t = clamp(t, ivec2(0), ivec2(uGrid) - 1); return texelFetch(uElev, t, 0).r; }
float crom(float p0, float p1, float p2, float p3, float t) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + t * (3.0 * (p1 - p2) + p3 - p0)));
}
float macroH(vec2 w) {
  vec2 g = (w + 0.5 * uGrid * uTile) / uTile - 0.5;
  vec2 i = floor(g); vec2 f = g - i; ivec2 b = ivec2(i);
  float r0 = crom(elevAt(b + ivec2(-1,-1)), elevAt(b + ivec2(0,-1)), elevAt(b + ivec2(1,-1)), elevAt(b + ivec2(2,-1)), f.x);
  float r1 = crom(elevAt(b + ivec2(-1, 0)), elevAt(b + ivec2(0, 0)), elevAt(b + ivec2(1, 0)), elevAt(b + ivec2(2, 0)), f.x);
  float r2 = crom(elevAt(b + ivec2(-1, 1)), elevAt(b + ivec2(0, 1)), elevAt(b + ivec2(1, 1)), elevAt(b + ivec2(2, 1)), f.x);
  float r3 = crom(elevAt(b + ivec2(-1, 2)), elevAt(b + ivec2(0, 2)), elevAt(b + ivec2(1, 2)), elevAt(b + ivec2(2, 2)), f.x);
  float m = crom(r0, r1, r2, r3, f.y);
  vec2 o = abs(w) - 0.5 * uGrid * uTile;
  float outside = max(o.x, o.y);
  return outside > 0.0 ? m - smoothstep(0.0, 14000.0, outside) * (m - (uSea - 1500.0)) : m;
}
vec2 mapUV(vec2 w) { return w / (uGrid * uTile) + 0.5; }
float heightAt(vec2 w, float minWl, out float above) {
  float m = macroH(w);
  above = m - uSea;
  vec4 rv = texture(uRiver, mapUV(w));
  float land = smoothstep(2.0, 40.0, above);
  float carve = 7.0 * rv.r * smoothstep(0.5, 6.0, above);
  float d = uDetail > 0.5 ? detailHeight(w, above, rv.g, minWl) : 0.0;
  return m - carve - 4.0 * rv.g * land + d;
}
`;
