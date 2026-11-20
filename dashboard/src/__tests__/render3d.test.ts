// The 3D view's rendering-only detail must stay consistent with the simulation it decorates.
import { describe, expect, it } from "vitest";
import { DETAIL_WAVELENGTHS, EDGE_FALL, GLSL_HEIGHT, HeightField, canopyFrac, detailHeight, fieldWarp, vnoise } from "../render3d/heightfield";
import { hydrography } from "../render3d/hydro";

function world(w = 12, h = 10, tile = 2000) {
  const elev = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) elev[y * w + x] = (x - 3) * 120 + Math.sin(y) * 80;
  return { w, h, tile, elev };
}

describe("procedural height detail", () => {
  it("is deterministic and bounded", () => {
    for (let k = 0; k < 200; k++) {
      const x = k * 37.3 - 3000, z = k * 91.7 + 11;
      const a = vnoise(x / 50, z / 50, 7), b = vnoise(x / 50, z / 50, 7);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
    expect(detailHeight(1234.5, -987.25, 500, 0, 42)).toBe(detailHeight(1234.5, -987.25, 500, 0, 42));
    expect(detailHeight(1234.5, -987.25, 500, 0, 42)).not.toBe(detailHeight(1234.5, -987.25, 500, 0, 43));
  });

  it("vanishes at the coastline, so shorelines stay where the simulation puts them", () => {
    for (let k = 0; k < 50; k++) expect(detailHeight(k * 313, k * 177, 0, 0, 5)).toBe(0);
  });

  it("is roughly zero-mean, so it does not shift the simulated surface", () => {
    let sum = 0, abs = 0;
    const n = 4000;
    for (let k = 0; k < n; k++) {
      const d = detailHeight((k % 63) * 517.3, Math.floor(k / 63) * 491.1, 1500, 0, 9);
      sum += d; abs += Math.abs(d);
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.25 * (abs / n));
  });

  it("is calmed along simulated river valleys", () => {
    let open = 0, valley = 0;
    for (let k = 0; k < 500; k++) {
      open += Math.abs(detailHeight(k * 211, k * 97, 900, 0, 3));
      valley += Math.abs(detailHeight(k * 211, k * 97, 900, 1, 3));
    }
    expect(valley).toBeLessThan(open * 0.1);
  });

  it("is rougher in mountains than on plains", () => {
    let plain = 0, mtn = 0;
    for (let k = 0; k < 500; k++) {
      plain += Math.abs(detailHeight(k * 211, k * 97, 60, 0, 3));
      mtn += Math.abs(detailHeight(k * 211, k * 97, 2600, 0, 3));
    }
    expect(mtn).toBeGreaterThan(plain * 5);
  });

  it("GPU shader uses the same octaves and constants as the CPU", () => {
    const wl = GLSL_HEIGHT.match(/WL\[12\] = float\[12\]\(([^)]*)\)/)![1].split(",").map((s) => Number(s.trim()));
    expect(wl).toEqual(DETAIL_WAVELENGTHS);
    for (const c of ["0.95 * valley", "smoothstep(2.0, 40.0, above)", "smoothstep(800.0, 2200.0, above)", "7.0 * rv.r", "4.0 * rv.g", "14000.0", "- 0.122", "2200.0", "uSeed + 40.0"]) {
      expect(GLSL_HEIGHT).toContain(c);
    }
    expect(EDGE_FALL).toBe(14000);
  });
});

describe("macro surface = the simulation", () => {
  it("passes exactly through every simulated tile centre", () => {
    const { w, h, tile, elev } = world();
    const f = new HeightField({ width: w, height: h, tile, sea: 0, seed: 1, elev });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const wx = (x + 0.5 - w / 2) * tile, wz = (y + 0.5 - h / 2) * tile;
      expect(f.macro(wx, wz)).toBeCloseTo(elev[y * w + x], 6);
    }
  });

  it("with procedural detail off, the rendered height is the simulated surface", () => {
    const { w, h, tile, elev } = world();
    const f = new HeightField({ width: w, height: h, tile, sea: 0, seed: 1, elev });
    f.detailOn = false;
    const wx = (5 + 0.5 - w / 2) * tile, wz = (4 + 0.5 - h / 2) * tile;
    expect(f.height(wx, wz)).toBeCloseTo(elev[4 * w + 5], 6);
  });

  it("falls into deep sea beyond the map edge instead of ending in a wall", () => {
    const { w, h, tile, elev } = world();
    const f = new HeightField({ width: w, height: h, tile, sea: 10, seed: 1, elev });
    expect(f.macro((w / 2) * tile + EDGE_FALL + 10, 0)).toBeCloseTo(10 - 1500, 3);
  });
});

describe("field warp and canopy", () => {
  it("moves field lookups by less than one simulation tile", () => {
    for (let k = 0; k < 300; k++) {
      const x = k * 733 - 90000, z = k * 419 - 50000;
      const [a, b] = fieldWarp(x, z, 77);
      expect(Math.hypot(a - x, b - z)).toBeLessThan(2000);
    }
  });

  it("has no canopy without simulated biomass, and more with more", () => {
    for (let k = 0; k < 100; k++) expect(canopyFrac(0.1, k * 97, k * 13, 4)).toBe(0);
    let lo = 0, hi = 0;
    for (let k = 0; k < 300; k++) { lo += canopyFrac(0.35, k * 97, k * 13, 4); hi += canopyFrac(0.7, k * 97, k * 13, 4); }
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("hydrography from simulated water", () => {
  // a 6×4 strip of land sloping east into the sea at column 5, with one river along row 1
  const W = 6, H = 4, n = W * H;
  const elev = new Float32Array(n), flow = new Float32Array(n), dir = new Uint8Array(n), water = new Float32Array(n);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) elev[y * W + x] = x === 5 ? -50 : 100 - x * 10;
  for (let x = 0; x < 5; x++) { flow[W + x] = 1 + x; dir[W + x] = 4; } // E = NEIGHBOURS index 3 → code 4
  water[3 * W + 1] = 5000; // one lake tile

  it("traces rivers along engine flow directions into the sea, with width from discharge", () => {
    const hy = hydrography({ width: W, height: H, tile: 2000, sea: 0, seed: 1, elev, flow, flowDir: dir, water });
    expect(hy.rivers.length).toBe(1);
    const r = hy.rivers[0];
    expect(r.x[0]).toBeLessThan(r.x[r.x.length - 1]); // flows east
    expect(r.width[r.width.length - 2]).toBeGreaterThan(r.width[0]); // widens downstream
    for (let k = 0; k < r.z.length; k++) expect(Math.abs(r.z[k] - (1.5 - H / 2) * 2000)).toBeLessThan(2000 * 0.6); // stays near its tiles
  });

  it("puts lakes at the engine's water level", () => {
    const hy = hydrography({ width: W, height: H, tile: 2000, sea: 0, seed: 1, elev, flow, flowDir: dir, water });
    expect(hy.lakes.length).toBe(1);
    expect(hy.lakes[0].level).toBeCloseTo(elev[3 * W + 1] + 5, 6);
    expect(hy.lakeMask[3 * W + 1]).toBe(255);
  });
});
