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
  world_age_years: number;
  engine_version: string;
  sea_level_m: number;
  laws_version: string | null;
}

export interface Frame {
  tick: number;
  width: number;
  height: number;
  calendar: CalendarInfo;
  sea_level: number;
  tile_size_m: number;
  lat_top: number;
  lat_bottom: number;
  days_per_year: number;
  layers: Record<string, Float32Array | Uint8Array>;
  ranges: Record<string, [number, number]>;
  receivedAt: number;
}

export interface Dynamics {
  wind_u_rows: number[];
  wind_v_rows: number[];
}

export interface WorldInfo {
  id: number;
  seed: number;
  created_at: number;
  latest_tick: number | null;
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
  sst_mean: number;
  groundwater_mean_mm: number;
  sediment_in_transit_t: number;
  lava_tiles: number;
  earthquakes_total: number;
  eruptions_total: number;
  budgets: Record<string, unknown>;
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

export function decode(b64: string, dtype: string): Float32Array | Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dtype === "uint8" ? bytes : new Float32Array(bytes.buffer);
}

export interface WitnessMessage { id?: number; tick: number; speaker: "witness" | "creator"; text: string; data?: Record<string, unknown> }
export interface WitnessGoal { id: number; kind: string; text: string; status: string; stage: number; created_tick: number; notes: string[] }
export interface WitnessState {
  name: string; awakened_tick: number; introduced: boolean; autonomy: boolean; acting_now: boolean;
  engine_running: boolean | null; immortal: boolean; cycles: number;
  directives: { protect_environment: boolean; intervention: "none" | "gentle" | "active"; may_create_life: boolean; may_create_humans: boolean };
  goals: WitnessGoal[];
  pending_verifications: { seq: number; kind: string; tick: number; check_tick: number; reason: string }[];
  action_values: Record<string, { n: number; mean: number }>;
  attention: { x: number; y: number; tick: number } | null;
}
export interface WitnessMemory { id: number; tick: number; kind: string; text: string; importance: number }
export interface DivineCommand {
  seq: number | null; tick: number; issuer: string; kind: string; params: Record<string, unknown>;
  reason: string; status: string; result: Record<string, unknown>; text: string;
}
export interface LifeSummary {
  life_version: string; animals: Record<string, number>; animals_total: number; humans: number; humans_adult: number;
  families: number; shelters: number; shelters_in_progress: number; mean_skills: Record<string, number>;
  births: Record<string, number>; deaths: Record<string, Record<string, number>>; attacks_on_humans: number;
  humans_killed: number; births_capped: number; max_animals: number;
  ledger: Record<string, number>; insects_note: string;
}
/** [id, species, x m, y m, action] */
export type AnimalRow = [number, string, number, number, string];
/** [id, name, x m, y m, action, age y] */
export type HumanRow = [number, string, number, number, string, number];
/** [id, kind, x m, y m, quality, done] */
export type StructureRow = [number, string, number, number, number, boolean];
export interface LifeData {
  present: boolean; summary: LifeSummary | null; tile_size_m: number; tick?: number;
  agents: { animals: AnimalRow[]; humans: HumanRow[]; structures: StructureRow[] } | null;
}

export const api = {
  witness: () => json<WitnessState>("/api/witness"),
  witnessIntroduce: () => post<{ messages: WitnessMessage[] }>("/api/witness/introduce"),
  witnessMessages: (after = 0) => json<{ messages: WitnessMessage[] }>(`/api/witness/messages?after=${after}`),
  witnessSay: (text: string) => post<{ messages: WitnessMessage[]; witness: WitnessState }>("/api/witness/message", { text }),
  witnessAutonomy: (enabled: boolean) => post<{ messages: WitnessMessage[]; witness: WitnessState }>("/api/witness/autonomy", { enabled }),
  witnessMemories: () => json<{ memories: WitnessMemory[] }>("/api/witness/memories?limit=300"),
  commands: () => json<{ commands: DivineCommand[]; queued: DivineCommand[] }>("/api/commands?limit=300"),
  life: () => json<LifeData>("/api/life"),
  creature: (id: number) => json<Record<string, unknown>>(`/api/life/${id}`),
  status: () => json<Status>("/api/status"),
  stats: () => json<Stats>("/api/stats"),
  history: () => json<Stats[]>("/api/stats/history?limit=1500"),
  events: () => json<WorldEvent[]>("/api/events?limit=600"),
  tile: (x: number, y: number) => json<Tile>(`/api/tile/${x}/${y}`),
  checkpoints: () => json<{ worlds: WorldInfo[]; checkpoints: Checkpoint[] }>("/api/checkpoints"),
  budgets: () => json<{ closure_errors: Record<string, number>; budgets: Record<string, unknown> }>("/api/budgets"),
  dynamics: () => json<Dynamics>("/api/dynamics"),
  loadWorld: (world_id: number) => post<Status>("/api/load_world", { world_id }),
  async frame(names: string[]): Promise<Frame> {
    const r = await json<{
      tick: number; width: number; height: number; calendar: CalendarInfo; sea_level: number; tile_size_m: number;
      lat_top: number; lat_bottom: number; days_per_year: number;
      layers: Record<string, { dtype: string; data: string; min: number; max: number }>;
    }>(`/api/frame?layers=${names.join(",")}`);
    const layers: Frame["layers"] = {};
    const ranges: Frame["ranges"] = {};
    for (const [k, v] of Object.entries(r.layers)) {
      layers[k] = decode(v.data, v.dtype);
      ranges[k] = [v.min, v.max];
    }
    return { tick: r.tick, width: r.width, height: r.height, calendar: r.calendar, sea_level: r.sea_level,
      tile_size_m: r.tile_size_m, lat_top: r.lat_top, lat_bottom: r.lat_bottom, days_per_year: r.days_per_year,
      layers, ranges, receivedAt: performance.now() };
  },
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
