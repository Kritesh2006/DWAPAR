// Colour maps. Each returns [r, g, b] for a raw value in the layer's physical unit.

export type RGB = [number, number, number];

export const TERRAIN_CLASSES = [
  "ocean", "lake", "river", "wetland", "desert", "plains", "forest", "hills", "mountains", "snow",
] as const;

export const TERRAIN_COLORS: Record<string, RGB> = {
  ocean: [22, 52, 84],
  lake: [44, 106, 150],
  river: [72, 150, 196],
  wetland: [68, 110, 92],
  desert: [206, 178, 120],
  plains: [148, 160, 92],
  forest: [48, 98, 58],
  hills: [128, 118, 84],
  mountains: [118, 106, 100],
  snow: [226, 232, 238],
};

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function ramp(stops: [number, RGB][], v: number): RGB {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [p0, c0] = stops[i - 1];
      const [p1, c1] = stops[i];
      return lerp(c0, c1, (v - p0) / (p1 - p0));
    }
  }
  return stops[stops.length - 1][1];
}

const OCEAN_DARK: RGB = [10, 22, 36];

export interface LayerStyle {
  label: string;
  unit: string;
  color: (v: number, elev: number) => RGB;
  legend: [string, string];
  gradient: string; // CSS gradient for the legend
  format: (v: number) => string;
}

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const big = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0);

const TEMP: [number, RGB][] = [
  [-25, [40, 30, 110]], [-10, [60, 110, 200]], [0, [170, 210, 235]], [10, [235, 232, 190]],
  [20, [240, 170, 80]], [30, [215, 80, 50]], [42, [120, 20, 40]],
];
const ELEV_LAND: [number, RGB][] = [
  [0, [62, 120, 74]], [300, [120, 150, 82]], [900, [176, 160, 98]], [1800, [150, 110, 80]],
  [2800, [140, 130, 128]], [3800, [235, 235, 240]],
];
const ELEV_SEA: [number, RGB][] = [[-3500, [8, 18, 48]], [-800, [20, 52, 100]], [0, [52, 110, 160]]];
const MOIST: [number, RGB][] = [[0, [120, 80, 40]], [0.25, [190, 160, 90]], [0.5, [120, 170, 120]], [0.8, [40, 140, 160]], [1, [20, 70, 150]]];
const VEG: [number, RGB][] = [[0, [40, 34, 28]], [0.15, [110, 100, 50]], [0.4, [80, 140, 60]], [0.7, [40, 120, 50]], [1, [16, 70, 30]]];
const VIRIDIS: [number, RGB][] = [[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]];
const MAGMA: [number, RGB][] = [[0, [20, 14, 30]], [0.3, [90, 30, 110]], [0.6, [200, 60, 90]], [0.85, [250, 150, 80]], [1, [252, 240, 180]]];
const BLUES: [number, RGB][] = [[0, [24, 26, 30]], [0.3, [40, 80, 120]], [0.65, [60, 150, 210]], [1, [200, 240, 255]]];
const FIRE: [number, RGB][] = [[0, [26, 24, 26]], [0.05, [120, 40, 20]], [0.4, [230, 90, 20]], [1, [255, 230, 120]]];
const RISK: [number, RGB][] = [[0, [24, 40, 34]], [0.25, [140, 140, 50]], [0.6, [220, 110, 30]], [1, [200, 30, 30]]];
const WHITE: [number, RGB][] = [[0, [36, 42, 48]], [50, [140, 170, 200]], [400, [240, 246, 252]]];

const css = (stops: [number, RGB][]) => {
  const lo = stops[0][0], hi = stops[stops.length - 1][0];
  return `linear-gradient(90deg, ${stops.map(([p, c]) => `rgb(${c.join(",")}) ${((p - lo) / (hi - lo)) * 100}%`).join(", ")})`;
};

const logNorm = (v: number, maxLog: number) => (v <= 0 ? 0 : Math.min(1, Math.log10(1 + v) / maxLog));

export const LAYER_STYLES: Record<string, LayerStyle> = {
  terrain: {
    label: "Terrain", unit: "", legend: ["", ""], gradient: "", format: (v) => TERRAIN_CLASSES[v] ?? "?",
    color: (v) => TERRAIN_COLORS[TERRAIN_CLASSES[v]] ?? [255, 0, 255],
  },
  elevation: {
    label: "Elevation", unit: "m", legend: ["−3500 m", "+3800 m"], format: (v) => `${v.toFixed(0)} m`,
    gradient: css([...ELEV_SEA.slice(0, -1), ...ELEV_LAND].map(([p, c]) => [p, c] as [number, RGB])),
    color: (v) => (v < 0 ? ramp(ELEV_SEA, v) : ramp(ELEV_LAND, v)),
  },
  temperature: {
    label: "Temperature", unit: "°C", legend: ["−25 °C", "42 °C"], gradient: css(TEMP), format: (v) => `${f1(v)} °C`,
    color: (v) => ramp(TEMP, v),
  },
  moisture: {
    label: "Soil moisture", unit: "", legend: ["dry", "saturated"], gradient: css(MOIST), format: f2,
    color: (v, e) => (e < 0 ? OCEAN_DARK : ramp(MOIST, v)),
  },
  vegetation: {
    label: "Vegetation", unit: "", legend: ["bare", "closed forest"], gradient: css(VEG), format: f2,
    color: (v, e) => (e < 0 ? OCEAN_DARK : ramp(VEG, v)),
  },
  water: {
    label: "Surface water", unit: "mm", legend: ["0", "≥10 m (log)"], gradient: css(BLUES), format: (v) => `${big(v)} mm`,
    color: (v, e) => (e < 0 ? [14, 34, 70] : ramp(BLUES, logNorm(v, 4))),
  },
  minerals: {
    label: "Mineral deposits", unit: "t", legend: ["none", "rich (log)"], gradient: css(MAGMA), format: (v) => `${big(v)} t`,
    color: (v, e) => (e < 0 ? OCEAN_DARK : ramp(MAGMA, logNorm(v, 6.3))),
  },
  fertility: {
    label: "Soil fertility", unit: "", legend: ["0", "1"], gradient: css(VIRIDIS), format: f2,
    color: (v, e) => (e < 0 ? OCEAN_DARK : ramp(VIRIDIS, v)),
  },
  snow: {
    label: "Snowpack", unit: "mm SWE", legend: ["0", "400 mm"], gradient: css(WHITE), format: (v) => `${f1(v)} mm`,
    color: (v, e) => (e < 0 ? OCEAN_DARK : ramp(WHITE, v)),
  },
  precipitation: {
    label: "Precipitation (seasonal)", unit: "mm/day", legend: ["0", "8 mm/day"], gradient: css(BLUES), format: (v) => `${f2(v)} mm/d`,
    color: (v) => ramp(BLUES, Math.min(1, v / 8)),
  },
  fire_risk: {
    label: "Fire risk", unit: "", legend: ["none", "extreme"], gradient: css(RISK), format: f2,
    color: (v, e) => (e < 0 ? OCEAN_DARK : ramp(RISK, v)),
  },
  fire: {
    label: "Active fire", unit: "", legend: ["none", "intense"], gradient: css(FIRE), format: f2,
    color: (v, e) => (e < 0 ? OCEAN_DARK : ramp(FIRE, v)),
  },
};

export const LAYER_ORDER = [
  "terrain", "elevation", "temperature", "moisture", "vegetation", "water", "minerals", "fertility",
  "precipitation", "snow", "fire_risk", "fire",
];
