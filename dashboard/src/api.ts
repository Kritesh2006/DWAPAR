// Typed client for the Drishti API. Every value shown in the dashboard comes from here —
// the UI never invents or interpolates simulation data.

export interface CalendarInfo {
  tick: number;
  hour: number;
  day_of_year: number;
  day_total: number;
  season: string;
  year: number;
  label: string;
}

export interface Status {
  world_id: number;
  seed: number;
  width: number;
  height: number;
  ticks_per_day: number;
  days_per_year: number;
  calendar: CalendarInfo;
  running: boolean;
  speed_hours_per_second: number;
  measured_ticks_per_second: number;
  last_step_ms: number;
  burning_tiles: number;
  error: string | null;
  recovered_from_checkpoint: boolean;
}

export interface Layer {
  name: string;
  width: number;
  height: number;
  tick: number;
  unit: string;
  min: number;
  max: number;
  values: Float32Array | Uint8Array;
}

export interface Stats {
  tick: number;
  day: number;
  temp_land_mean: number;
  temp_ocean_mean: number;
  temp_min: number;
  temp_max: number;
  soil_moisture_mean: number;
  fertility_mean: number;
  vegetation_mean: number;
  burning_tiles: number;
  fire_ignitions_total: number;
  snow_tiles: number;
  precip_mean_mm_day: number;
  water_mm: Record<string, number>;
  terrain: Record<string, number>;
  resources: Record<string, number>;
}

export interface WorldEvent {
  tick: number;
  kind: string;
  x: number | null;
  y: number | null;
  message: string;
}

export interface Checkpoint {
  id: number;
  world_id: number;
  tick: number;
  label: string;
  created_at: number;
  size_bytes: number;
}

export type Tile = Record<string, unknown> & {
  x: number;
  y: number;
  terrain: string;
  resources: Record<string, number>;
  resource_units: Record<string, string>;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) {
    let detail = r.statusText;
    try {
      detail = (await r.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(`${r.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return r.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  json<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function decode(b64: string, dtype: string): Float32Array | Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dtype === "uint8" ? bytes : new Float32Array(bytes.buffer);
}

export const api = {
  status: () => json<Status>("/api/status"),
  stats: () => json<Stats>("/api/stats"),
  history: () => json<Stats[]>("/api/stats/history?limit=1500"),
  events: () => json<WorldEvent[]>("/api/events?limit=300"),
  tile: (x: number, y: number) => json<Tile>(`/api/tile/${x}/${y}`),
  checkpoints: () => json<{ checkpoints: Checkpoint[] }>("/api/checkpoints"),
  control: (action: "start" | "pause" | "resume" | "step", ticks = 1) =>
    post<Status>("/api/control", { action, ticks }),
  speed: (hours_per_second: number) => post<Status>("/api/speed", { hours_per_second }),
  save: () => post<{ checkpoint_id: number; tick: number }>("/api/save"),
  load: (checkpoint_id: number) => post<Status>("/api/load", { checkpoint_id }),
  newWorld: (seed: number, width: number, height: number) =>
    post<Status>("/api/new", { seed, width, height }),
  async layer(name: string): Promise<Layer> {
    const r = await json<{
      name: string; width: number; height: number; tick: number; unit: string;
      min: number; max: number; dtype: string; data: string;
    }>(`/api/layer/${name}`);
    return { ...r, values: decode(r.data, r.dtype) };
  },
};

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}
