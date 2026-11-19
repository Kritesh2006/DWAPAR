// Colour science for Drishti. Natural terrain colours for the living view, perceptual ramps for
// heatmaps and a gold ramp for resource distributions. Every colour is a pure function of engine data.

export type RGB = [number, number, number];

export const TERRAIN_CLASSES = [
  "ocean", "lake", "river", "wetland", "desert", "plains", "forest", "hills", "mountains", "snow",
] as const;

export const TERRAIN_COLORS: Record<string, RGB> = {
  ocean: [16, 42, 66], lake: [36, 92, 122], river: [70, 140, 170], wetland: [70, 102, 82],
  desert: [201, 176, 128], plains: [142, 150, 92], forest: [44, 82, 48], hills: [130, 116, 86],
  mountains: [122, 112, 104], snow: [232, 236, 240],
};

export const lerp = (a: RGB, b: RGB, t: number): RGB => {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};

export function ramp(stops: [number, RGB][], v: number): RGB {
  if (!(v > stops[0][0])) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [p0, c0] = stops[i - 1];
      const [p1, c1] = stops[i];
      return lerp(c0, c1, (v - p0) / (p1 - p0));
    }
  }
  return stops[stops.length - 1][1];
}

// ---- natural ("living planet") palette ---------------------------------------------------------
export const SEA: [number, RGB][] = [[-3500, [4, 14, 30]], [-1500, [8, 30, 56]], [-300, [14, 58, 88]], [-30, [28, 96, 118]], [0, [52, 128, 138]]];
const BARE_DRY: RGB = [204, 180, 132];
const BARE_WET: RGB = [118, 102, 74];
const GRASS: RGB = [118, 140, 72];
const FOREST: RGB = [34, 70, 38];
const ROCK: RGB = [128, 120, 112];
const SNOW: RGB = [236, 240, 244];
const WATER: RGB = [38, 104, 136];

export interface NaturalInput {
  elev: number; veg: number; moist: number; snow: number; water: number; flow: number; lava: number;
}

export function naturalColor(p: NaturalInput): RGB {
  if (p.elev < 0) return ramp(SEA, p.elev);
  let c = lerp(BARE_DRY, BARE_WET, p.moist * 1.3);
  const v = Math.min(1, p.veg * 1.6);
  c = lerp(c, lerp(GRASS, FOREST, Math.min(1, p.veg * 1.4)), v);
  c = lerp(c, ROCK, Math.max(0, (p.elev - 1600) / 1600) * (1 - v * 0.6));
  if (p.water > 80) c = lerp(c, WATER, Math.min(1, Math.log10(p.water / 80) / 1.3));
  if (p.flow > 0.6) c = lerp(c, [64, 140, 168], Math.min(0.85, 0.35 + Math.log10(p.flow / 0.6) * 0.5));
  if (p.snow > 2) c = lerp(c, SNOW, Math.min(1, p.snow / 60));
  if (p.lava > 0.02) c = lerp(c, [40, 20, 16], Math.min(1, p.lava * 1.5)); // fresh basalt
  return c;
}

// ---- heatmaps ------------------------------------------------------------------------------------
const TEMP: [number, RGB][] = [[-25, [42, 34, 110]], [-10, [62, 112, 196]], [0, [170, 208, 230]], [10, [236, 232, 192]], [20, [240, 172, 82]], [30, [214, 82, 50]], [42, [118, 22, 40]]];
const MOIST: [number, RGB][] = [[0, [120, 80, 40]], [0.25, [190, 160, 90]], [0.5, [120, 170, 120]], [0.8, [40, 140, 160]], [1, [20, 70, 150]]];
const VEG: [number, RGB][] = [[0, [40, 34, 28]], [0.15, [110, 100, 50]], [0.4, [80, 140, 60]], [0.7, [40, 120, 50]], [1, [16, 70, 30]]];
const VIRIDIS: [number, RGB][] = [[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]];
const BLUES: [number, RGB][] = [[0, [20, 22, 26]], [0.3, [36, 76, 116]], [0.65, [60, 150, 210]], [1, [200, 240, 255]]];
const FIRE: [number, RGB][] = [[0, [22, 20, 22]], [0.05, [120, 40, 20]], [0.4, [230, 90, 20]], [1, [255, 230, 120]]];
const RISK: [number, RGB][] = [[0, [22, 36, 30]], [0.25, [140, 140, 50]], [0.6, [220, 110, 30]], [1, [200, 30, 30]]];
const DIVERGE: [number, RGB][] = [[-1, [60, 110, 200]], [0, [30, 30, 30]], [1, [220, 120, 50]]];
export const GOLD: [number, RGB][] = [[0, [14, 12, 8]], [0.25, [70, 52, 18]], [0.55, [166, 124, 40]], [0.8, [224, 186, 92]], [1, [255, 240, 196]]];
const ELEV_LAND: [number, RGB][] = [[0, [62, 120, 74]], [300, [120, 150, 82]], [900, [176, 160, 98]], [1800, [150, 110, 80]], [2800, [140, 130, 128]], [3800, [235, 235, 240]]];

const OCEAN_DARK: RGB = [6, 10, 16];
const logN = (v: number, maxLog: number) => (v <= 0 ? 0 : Math.min(1, Math.log10(1 + v) / maxLog));

export interface HeatStyle {
  label: string;
  group: "Environment" | "Water" | "Geology" | "Hazards" | "Resources";
  legend: [string, string];
  stops: [number, RGB][];
  color: (v: number, elev: number) => RGB;
  format: (v: number) => string;
}

const big = (v: number) =>
  Math.abs(v) >= 1e9 ? `${(v / 1e9).toFixed(2)} B` : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)} M`
    : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)} k` : v.toFixed(v < 10 ? 2 : 0);
export const fmtBig = big;

const land = (f: (v: number) => RGB) => (v: number, e: number): RGB => (e < 0 ? OCEAN_DARK : f(v));

export const HEATMAPS: Record<string, HeatStyle> = {
  temperature: { label: "Air temperature", group: "Environment", legend: ["−25 °C", "42 °C"], stops: TEMP, color: (v) => ramp(TEMP, v), format: (v) => `${v.toFixed(1)} °C` },
  sst: { label: "Ocean temperature", group: "Environment", legend: ["−2 °C", "32 °C"], stops: TEMP, color: (v, e) => (e < 0 ? ramp(TEMP, v) : [18, 18, 18]), format: (v) => `${v.toFixed(1)} °C` },
  precipitation: { label: "Precipitation", group: "Environment", legend: ["0", "8 mm/day"], stops: BLUES, color: (v) => ramp(BLUES, v / 8), format: (v) => `${v.toFixed(2)} mm/d` },
  vegetation: { label: "Vegetation", group: "Environment", legend: ["bare", "closed forest"], stops: VEG, color: land((v) => ramp(VEG, v)), format: (v) => v.toFixed(2) },
  fertility: { label: "Soil fertility", group: "Environment", legend: ["0", "1"], stops: VIRIDIS, color: land((v) => ramp(VIRIDIS, v)), format: (v) => v.toFixed(2) },
  elevation: { label: "Elevation", group: "Geology", legend: ["sea", "4000 m"], stops: ELEV_LAND, color: (v) => (v < 0 ? ramp(SEA, v) : ramp(ELEV_LAND, v)), format: (v) => `${v.toFixed(0)} m` },
  moisture: { label: "Soil moisture", group: "Water", legend: ["dry", "saturated"], stops: MOIST, color: land((v) => ramp(MOIST, v)), format: (v) => v.toFixed(2) },
  water: { label: "Surface water", group: "Water", legend: ["0", "≥10 m"], stops: BLUES, color: (v, e) => (e < 0 ? [12, 30, 62] : ramp(BLUES, logN(v, 4))), format: (v) => `${big(v)} mm` },
  groundwater: { label: "Groundwater", group: "Water", legend: ["0", "3000 mm"], stops: BLUES, color: land((v) => ramp(BLUES, v / 3000)), format: (v) => `${v.toFixed(0)} mm` },
  flow: { label: "River discharge", group: "Water", legend: ["0", "≥1000 mm/h"], stops: BLUES, color: land((v) => ramp(BLUES, logN(v, 3))), format: (v) => `${v.toFixed(2)} mm/h` },
  snow: { label: "Snowpack", group: "Water", legend: ["0", "400 mm"], stops: BLUES, color: land((v) => ramp(BLUES, v / 400)), format: (v) => `${v.toFixed(1)} mm` },
  sediment: { label: "Sediment in transit", group: "Geology", legend: ["0", "≥10⁶ t"], stops: GOLD, color: (v) => ramp(GOLD, logN(v, 6)), format: (v) => `${big(v)} t` },
  uplift: { label: "Tectonic uplift", group: "Geology", legend: ["−1.5 mm/yr", "+4 mm/yr"], stops: DIVERGE, color: (v) => ramp(DIVERGE, v > 0 ? v / 0.004 : v / 0.0015), format: (v) => `${(v * 1000).toFixed(2)} mm/yr` },
  stress: { label: "Fault stress", group: "Geology", legend: ["0", "critical"], stops: RISK, color: (v) => ramp(RISK, v), format: (v) => v.toFixed(2) },
  fire_risk: { label: "Fire risk", group: "Hazards", legend: ["none", "extreme"], stops: RISK, color: land((v) => ramp(RISK, v)), format: (v) => v.toFixed(2) },
  fire: { label: "Active fire", group: "Hazards", legend: ["none", "intense"], stops: FIRE, color: land((v) => ramp(FIRE, v)), format: (v) => v.toFixed(2) },
};

export const RESOURCE_NAMES: Record<string, string> = {
  freshwater: "Freshwater", saltwater: "Saltwater", wood: "Wood", stone: "Stone", sand: "Sand", clay: "Clay",
  iron_ore: "Iron ore", copper_ore: "Copper ore", coal: "Coal", organic_matter: "Organic matter",
};
export const RESOURCE_UNITS: Record<string, string> = {
  freshwater: "m³", saltwater: "m³", wood: "t", stone: "t", sand: "t", clay: "t", iron_ore: "t", copper_ore: "t",
  coal: "t", organic_matter: "t",
};

export function resourceStyle(name: string, max: number): HeatStyle {
  const lm = Math.max(1, Math.log10(1 + max));
  return {
    label: RESOURCE_NAMES[name] ?? name, group: "Resources", legend: ["none", `${big(max)} ${RESOURCE_UNITS[name]}`],
    stops: GOLD, color: (v) => (v <= 0 ? [8, 8, 8] : ramp(GOLD, 0.12 + 0.88 * logN(v, lm))),
    format: (v) => `${big(v)} ${RESOURCE_UNITS[name]}`,
  };
}

export const cssGradient = (stops: [number, RGB][]) => {
  const lo = stops[0][0], hi = stops[stops.length - 1][0];
  return `linear-gradient(90deg, ${stops.map(([p, c]) => `rgb(${c.map(Math.round).join(",")}) ${((p - lo) / (hi - lo)) * 100}%`).join(", ")})`;
};
