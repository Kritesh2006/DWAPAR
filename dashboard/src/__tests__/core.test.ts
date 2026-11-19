import { describe, expect, it } from "vitest";
import { decode } from "../api";
import { HEATMAPS, naturalColor, ramp, resourceStyle } from "../colormaps";
import { sunVector } from "../render3d/World3D";

describe("layer decoding", () => {
  it("decodes base64 float32 rasters exactly", () => {
    const src = new Float32Array([1.5, -2.25, 3e6, 0]);
    const b64 = Buffer.from(new Uint8Array(src.buffer)).toString("base64");
    expect(Array.from(decode(b64, "float32"))).toEqual(Array.from(src));
  });
  it("decodes uint8 rasters", () => {
    expect(Array.from(decode(Buffer.from([0, 7, 255]).toString("base64"), "uint8"))).toEqual([0, 7, 255]);
  });
});

describe("colour science", () => {
  it("ramps interpolate and clamp", () => {
    const stops: [number, [number, number, number]][] = [[0, [0, 0, 0]], [10, [100, 200, 50]]];
    expect(ramp(stops, 5)).toEqual([50, 100, 25]);
    expect(ramp(stops, -3)).toEqual([0, 0, 0]);
    expect(ramp(stops, 99)).toEqual([100, 200, 50]);
  });
  it("classifies ocean relative to the dynamic sea level", () => {
    const land = naturalColor({ elev: 5, veg: 0.5, moist: 0.3, snow: 0, water: 0, flow: 0, lava: 0, sea: 0 });
    const flooded = naturalColor({ elev: 5, veg: 0.5, moist: 0.3, snow: 0, water: 0, flow: 0, lava: 0, sea: 10 });
    expect(land).not.toEqual(flooded);
    expect(flooded[2]).toBeGreaterThan(flooded[0]); // sea is blue
  });
  it("snow and ice whiten terrain", () => {
    const bare = naturalColor({ elev: 800, veg: 0, moist: 0.3, snow: 0, water: 0, flow: 0, lava: 0 });
    const iced = naturalColor({ elev: 800, veg: 0, moist: 0.3, snow: 0, water: 0, flow: 0, lava: 0, ice: 3000 });
    expect(iced[0] + iced[1] + iced[2]).toBeGreaterThan(bare[0] + bare[1] + bare[2]);
  });
  it("every heatmap and resource map yields valid colours", () => {
    for (const s of [...Object.values(HEATMAPS), resourceStyle("iron_ore", 1e6)]) {
      for (const v of [0, 0.5, 1, 1e3, -5]) for (const e of [-100, 100]) {
        const c = s.color(v, e);
        expect(c.every((x) => Number.isFinite(x) && x >= 0 && x <= 255)).toBe(true);
      }
    }
  });
});

describe("3D sun geometry (matches engine solar formulas)", () => {
  it("is high at noon and below the horizon at midnight", () => {
    const noon = sunVector(30, 90, 12, 360), midnight = sunVector(30, 90, 0, 360);
    expect(noon.y).toBeGreaterThan(0.9);
    expect(midnight.y).toBeLessThan(0);
  });
  it("rises in the east and sets in the west", () => {
    expect(sunVector(30, 0, 8, 360).x).toBeGreaterThan(0);
    expect(sunVector(30, 0, 16, 360).x).toBeLessThan(0);
  });
  it("is lower in northern winter than summer", () => {
    expect(sunVector(45, 270, 12, 360).y).toBeLessThan(sunVector(45, 90, 12, 360).y);
  });
});
