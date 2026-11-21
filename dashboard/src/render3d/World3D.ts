// Drishti 3D — an explorable, true-scale view of the engine's world.
//
// What is SIMULATED (from engine frames, never computed here): elevation per 2 km tile, sea level,
// lakes and their water level, river discharge and flow directions, vegetation biomass, soil
// moisture, temperature, snow, glacier ice, clouds, rain, fire, lava, the sun's position.
//
// What is RENDERING ONLY (deterministic, seeded, never fed back): relief finer than a tile, the
// winding course of a river between tile centres, individual trees / rocks / grass tufts, waves,
// ripples, foam, cloud texture, haze. All of it is chosen from the simulated fields at that spot.
// "Procedural detail" off in the UI removes the relief so the bare simulated surface shows.
//
// Scale: 1 scene unit = 1 metre. y = (height − sea level) × exaggeration (default 1 = true scale).

import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import type { Frame, LifeData } from "../api";
import { HEATMAPS, type HeatStyle } from "../colormaps";
import type { ViewMode } from "../render/Renderer";
import { GLSL_HEIGHT, HeightField, fieldWarp } from "./heightfield";
import { buildHydro, type Hydro } from "./hydro";
import { Terrain, makeSharedUniforms } from "./terrain";
import { Water } from "./water";
import { Scatter, type ScatterEnv } from "./scatter";
import { EYE_HEIGHT, FlightControls } from "./controls";
import { Creatures } from "./creatures";

export interface SunState { elevationDeg: number; azimuthDeg: number; isDay: boolean }
export type Quality = "low" | "medium" | "high";
export type Preset = "orbit" | "region" | "low" | "ground";
export interface RenderStats { fps: number; frameMs: number; calls: number; triangles: number; chunks: number; trees: number; rocks: number; grass: number; altitude: number; quality: Quality; creatures: number }

/** Sun direction for a latitude, day of year and hour — the same geometry the engine uses. */
export function sunVector(latDeg: number, dayOfYear: number, hour: number, daysPerYear: number): THREE.Vector3 {
  const dec = THREE.MathUtils.degToRad(23.44) * Math.sin((2 * Math.PI * dayOfYear) / daysPerYear);
  const h = THREE.MathUtils.degToRad(15 * (hour - 12));
  const phi = THREE.MathUtils.degToRad(latDeg);
  const up = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h);
  const east = -Math.cos(dec) * Math.sin(h);
  const north = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(h);
  return new THREE.Vector3(east, up, -north).normalize(); // scene: +x east, +y up, +z south (map rows)
}

const QUALITY: Record<Quality, { pr: number; shadow: number; lod: number; trees: number; rocks: number; grass: number }> = {
  low: { pr: 1, shadow: 1024, lod: 1.5, trees: 650, rocks: 280, grass: 0 },
  medium: { pr: 1.25, shadow: 2048, lod: 2.0, trees: 1100, rocks: 520, grass: 70 },
  high: { pr: 1.75, shadow: 4096, lod: 2.6, trees: 1700, rocks: 850, grass: 120 },
};

const CLOUD_BASE_M = 2400;
const LEAF_MINWL = 8.8;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function dataTex(data: ArrayBufferView, w: number, h: number, format: THREE.PixelFormat, type: THREE.TextureDataType, linear: boolean) {
  const t = new THREE.DataTexture(data as never, w, h, format, type);
  t.magFilter = t.minFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.25, 5e6);
  private controls: FlightControls;
  private sky = new Sky();
  private envSky = new Sky();
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnvSun = new THREE.Vector3(0, -2, 0);
  private sun = new THREE.DirectionalLight(0xffffff, 3);
  private hemi = new THREE.HemisphereLight(0xbcd2ee, 0x4a4030, 0.5);
  private moon = new THREE.DirectionalLight(0x9db4e0, 0);
  private shared = makeSharedUniforms();
  private terrain = new Terrain(this.shared);
  private water = new Water(this.shared);
  private scatter = new Scatter();
  private creatures = new Creatures();
  private clouds: THREE.Mesh;
  private fire: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private field: HeightField | null = null;
  private hydro: Hydro | null = null;
  private frame: Frame | null = null;
  private seed = 1;
  private w = 0;
  private h = 0;
  private tile = 2000;
  private elevRef: Float32Array | null = null;
  private elevMin = 0;
  private elevMax = 0;
  private texElev: THREE.DataTexture | null = null;
  private texRiver: THREE.DataTexture | null = null;
  private texF: THREE.DataTexture | null = null;
  private texF2: THREE.DataTexture | null = null;
  private texHeat: THREE.DataTexture | null = null;
  private texCloud: THREE.DataTexture | null = null;
  private placed = false;
  private hydroSig = 0;
  private hydroAt = 0;
  private raf = 0;
  private clock = new THREE.Clock();
  private fpsAcc = 0;
  private fpsN = 0;
  private slowFor = 0;
  private lastFrameMs = 0;
  mode: ViewMode = { kind: "living" };
  exaggeration = 1;
  simHoursPerSecond = 0;
  windMean = 0;
  showTrees = true;
  showClouds = true;
  shadows = true;
  showGrid = false;
  detail = true;
  alwaysDay = false;
  quality: Quality = "medium";
  autoQuality = true;
  onQualityChange: ((q: Quality) => void) | null = null;
  fps = 0;
  sunState: SunState = { elevationDeg: 0, azimuthDeg: 0, isDay: true };
  stats: RenderStats = { fps: 0, frameMs: 0, calls: 0, triangles: 0, chunks: 0, trees: 0, rocks: 0, grass: 0, altitude: 0, quality: "medium", creatures: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance", logarithmicDepthBuffer: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.5;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    for (const s of [this.sky, this.envSky]) {
      const u = s.material.uniforms;
      u.turbidity.value = 3.2; u.rayleigh.value = 1.25; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
    }
    this.sky.scale.setScalar(1e5);
    this.sky.material.depthTest = false;
    this.sky.material.depthWrite = false;
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.envSky.scale.setScalar(10);
    this.envScene.add(this.envSky);

    this.scene.add(this.sky, this.sun, this.sun.target, this.hemi, this.moon);
    this.scene.add(this.terrain.group, this.water.group, this.scatter.group, this.creatures.group, this.creatures.presence);
    this.scene.fog = new THREE.FogExp2(0xb4c6d8, 1e-5);
    this.sun.castShadow = true;
    this.moon.castShadow = false;

    // cloud deck: engine cloud cover (where/how much) × procedural texture (what it looks like)
    const cg = new THREE.PlaneGeometry(1, 1, 1, 1); cg.rotateX(-Math.PI / 2);
    const cm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const cu = { uClouds: { value: null as THREE.Texture | null }, uWind: { value: new THREE.Vector2() }, uFade: { value: 1 }, uShade: { value: new THREE.Color() } };
    cm.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, this.shared, cu);
      s.vertexShader = s.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vCW;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvCW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      s.fragmentShader = s.fragmentShader.replace("#include <common>", `#include <common>
          varying vec3 vCW; uniform sampler2D uClouds; uniform vec2 uWind; uniform float uFade; uniform vec3 uShade; uniform float uTime;
          ${GLSL_HEIGHT}`)
        .replace("#include <color_fragment>", `#include <color_fragment>
          {
            vec2 p = vCW.xz - uWind;
            vec2 cuv = mapUV(p);
            vec4 C = texture(uClouds, cuv);
            float n = vnoise(p / 9000.0, uSeed + 201.0) * 0.5 + vnoise(p / 3700.0 + uTime * 0.002, uSeed + 202.0) * 0.28
                    + vnoise(p / 1300.0, uSeed + 203.0) * 0.15 + vnoise(p / 420.0, uSeed + 204.0) * 0.07;
            // covered fraction of the sky ≈ the engine's cloud cover: threshold the noise at that quantile
            float cover = C.r;
            float th = 0.5 + (0.5 - cover) * 0.36;
            float d = smoothstep(th - 0.025, th + 0.09, n);
            float storm = C.g;
            vec3 c = uShade * mix(0.78, 1.0, smoothstep(th, th + 0.15, n));
            c = mix(c, c * vec3(0.45, 0.47, 0.52), storm * 0.8);
            vec3 vdir = normalize(vCW - cameraPosition);
            float graze = smoothstep(0.015, 0.12, abs(vdir.y));     // no hard edge where the deck meets the horizon
            diffuseColor = vec4(c, d * 0.8 * uFade * graze);
          }`);
    };
    cm.customProgramCacheKey = () => "dwapar-clouds-v1";
    this.clouds = new THREE.Mesh(cg, cm);
    this.clouds.userData.u = cu;
    this.clouds.renderOrder = 5;
    this.clouds.frustumCulled = false;
    this.scene.add(this.clouds);

    const sprite = this.glowSprite();
    this.fire = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      size: 600, map: sprite, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, sizeAttenuation: true,
    }));
    this.fire.frustumCulled = false;
    this.scene.add(this.fire);

    this.controls = new FlightControls(this.camera, canvas, {
      groundY: (x, z) => this.groundY(x, z),
      pickNdc: (ndc) => this.pickNdc(ndc),
    });
    canvas.tabIndex = 0;
    this.applyQuality();
    (window as unknown as { __dwapar3d?: World3D }).__dwapar3d = this; // for automated screenshots / debugging
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.terrain.dispose();
    this.scatter.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose?.();
    });
    for (const t of [this.texElev, this.texRiver, this.texF, this.texF2, this.texHeat, this.texCloud]) t?.dispose();
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    const w = window as unknown as { __dwapar3d?: World3D };
    if (w.__dwapar3d === this) delete w.__dwapar3d;
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private glowSprite(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.35, "rgba(255,255,255,0.5)"); grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  // ------------------------------------------------------------------ settings
  setSeed(seed: number) {
    const s = ((seed % 65521) + 65521) % 65521 + 1; // small, exact in a float uniform; same on CPU and GPU
    if (s === this.seed) return;
    this.seed = s;
    this.shared.uSeed.value = s;
    if (this.frame) this.rebuildStatic(true);
  }

  setQuality(q: Quality) { this.quality = q; this.applyQuality(); }

  private applyQuality() {
    const Q = QUALITY[this.quality];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.pr));
    this.sun.shadow.mapSize.set(Q.shadow, Q.shadow);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.terrain.lodFactor = Q.lod;
    this.scatter.q = { trees: Q.trees, rocks: Q.rocks, grass: Q.grass };
    this.scatter.invalidate();
    this.shared.uCanopyNear.value = Q.trees;
    this.stats.quality = this.quality;
  }

  setExaggeration(v: number) {
    this.exaggeration = v;
    this.shared.uExag.value = v;
    this.updateBounds();
    if (this.hydro && this.field) this.water.rebuild(this.hydro, this.field, this.frame!.sea_level, v);
    this.scatter.invalidate();
    this.updateFire();
  }

  setDetail(on: boolean) {
    this.detail = on;
    this.shared.uDetail.value = on ? 1 : 0;
    if (this.field) this.field.detailOn = on;
    if (this.hydro && this.field && this.frame) this.water.rebuild(this.hydro, this.field, this.frame.sea_level, this.exaggeration);
    this.scatter.invalidate();
  }

  setGrid(on: boolean) { this.showGrid = on; this.shared.uGridLines.value = on ? 1 : 0; }

  setMode(m: ViewMode) { this.mode = m; if (this.frame) this.updateHeat(); }

  /** Simulated creatures and shelters from /api/life. */
  setLife(d: LifeData | null) {
    this.creatures.setLife(d);
    // simulated shelters stand in clearings: rendering-only trees must not grow through them
    const ss = (d?.agents?.structures ?? []).map((s) => [s[2] - (this.w * this.tile) / 2, s[3] - (this.h * this.tile) / 2] as [number, number]);
    if (ss.length !== this.shelters.length) { this.shelters = ss; this.scatter.invalidate(); }
  }
  private shelters: [number, number][] = [];

  /** Where WITNESS last looked or acted (tile coordinates), or null. */
  setPresence(tile: { x: number; y: number } | null) {
    if (!tile || !this.w) { this.creatures.setPresence(null); return; }
    this.creatures.setPresence(new THREE.Vector3((tile.x + 0.5 - this.w / 2) * this.tile, 0, (tile.y + 0.5 - this.h / 2) * this.tile));
  }

  /** Fly to a point given in engine metres from the map's top-left corner (e.g. a creature). */
  flyToMetres(x: number, y: number) {
    if (!this.w) return;
    const tx = x - (this.w * this.tile) / 2, tz = y - (this.h * this.tile) / 2;
    const F = new THREE.Vector3(tx, this.groundY(tx, tz), tz);
    const fwd = new THREE.Vector3(-Math.sin(this.controls.yaw), 0, -Math.cos(this.controls.yaw));
    const pos = F.clone().addScaledVector(fwd, -45); pos.y = this.groundY(pos.x, pos.z) + 14;
    const d = F.clone().add(new THREE.Vector3(0, 1, 0)).sub(pos);
    this.controls.flyTo(pos, Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)), 2.2);
  }

  // ------------------------------------------------------------------ data
  setFrame(f: Frame) {
    const sizeChanged = f.width !== this.w || f.height !== this.h || f.tile_size_m !== this.tile;
    if (!f.layers.elevation && this.frame && !sizeChanged) f.layers.elevation = this.frame.layers.elevation;
    if (!f.layers.elevation) return;
    const elevChanged = f.layers.elevation !== this.elevRef || f.sea_level !== this.frame?.sea_level;
    this.frame = f;
    this.shared.uSea.value = f.sea_level;
    if (sizeChanged) {
      this.w = f.width; this.h = f.height; this.tile = f.tile_size_m;
      this.shared.uGrid.value.set(this.w, this.h);
      this.shared.uTile.value = this.tile;
      this.terrain.configure(this.w * this.tile, this.h * this.tile, this.tile);
      this.clouds.scale.set(this.w * this.tile, 1, this.h * this.tile);
      this.placed = false;
    }
    if (elevChanged || sizeChanged) this.rebuildStatic(sizeChanged);
    this.updateFields();
    this.updateHeat();
    this.updateClouds();
    this.updateFire();
    if (!this.placed) { this.placed = true; this.preset("region", false); }
  }

  /** Elevation, rivers and lakes: rebuilt when the engine's elevation (or sea level) changes. */
  private rebuildStatic(force = true) {
    const f = this.frame!;
    const elev = f.layers.elevation as Float32Array;
    this.elevRef = elev;
    // The river network (and the valleys carved for it) is rebuilt only when the set of simulated
    // river tiles or the sea level has really changed, and at most once a minute while the engine
    // runs — elevation refreshes every few simulated days would otherwise make the view stutter.
    const flowNow = f.layers.flow as Float32Array | undefined;
    let sig = Math.round(f.sea_level * 2);
    if (flowNow) for (let i = 0; i < flowNow.length; i++) if (flowNow[i] >= 0.6 && elev[i] >= f.sea_level) sig = (Math.imul(sig, 31) + i) | 0;
    const now = performance.now();
    const hydroDue = force || !this.hydro || (sig !== this.hydroSig && now - this.hydroAt > 60000);
    if (!hydroDue && this.texElev && this.field) {
      (this.texElev.image.data as unknown as Float32Array).set(elev);
      this.texElev.needsUpdate = true;
      this.field.src.elev = elev;
      this.field.src.sea = f.sea_level;
      return;
    }
    this.hydroSig = sig;
    this.hydroAt = now;
    const n = this.w * this.h;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { lo = Math.min(lo, elev[i]); hi = Math.max(hi, elev[i]); }
    this.elevMin = lo; this.elevMax = hi;
    if (!this.texElev || this.texElev.image.width !== this.w || this.texElev.image.height !== this.h) {
      this.texElev?.dispose();
      this.texElev = dataTex(new Float32Array(n), this.w, this.h, THREE.RedFormat, THREE.FloatType, false);
      this.shared.uElev.value = this.texElev;
    }
    (this.texElev.image.data as unknown as Float32Array).set(elev);
    this.texElev.needsUpdate = true;
    const L = f.layers;
    const zeros = new Float32Array(n);
    this.hydro = buildHydro({
      width: this.w, height: this.h, tile: this.tile, sea: f.sea_level, seed: this.seed, elev,
      flow: (L.flow as Float32Array) ?? zeros, flowDir: (L.flow_dir as Uint8Array) ?? new Uint8Array(n),
      water: (L.water as Float32Array) ?? zeros, terrain: L.terrain as Uint8Array | undefined,
    });
    const r = this.hydro.maskRes;
    this.texRiver?.dispose();
    this.texRiver = dataTex(this.hydro.mask, r, r, THREE.RGBAFormat, THREE.UnsignedByteType, true);
    this.shared.uRiver.value = this.texRiver;
    this.field = new HeightField({ width: this.w, height: this.h, tile: this.tile, sea: f.sea_level, seed: this.seed, elev, river: { r, data: this.hydro.mask } });
    this.field.detailOn = this.detail;
    this.water.rebuild(this.hydro, this.field, f.sea_level, this.exaggeration);
    this.updateBounds();
    this.scatter.invalidate();
  }

  private updateBounds() {
    const sea = this.frame?.sea_level ?? 0;
    this.terrain.minY = (this.elevMin - sea - 900) * this.exaggeration;
    this.terrain.maxY = (this.elevMax - sea + 900) * this.exaggeration;
  }

  /** Simulated surface fields → textures (vegetation, moisture, snow, ice, temperature, lakes, deserts, wetlands). */
  private updateFields() {
    const L = this.frame!.layers;
    const n = this.w * this.h;
    if (!this.texF || this.texF.image.width !== this.w || this.texF.image.height !== this.h) {
      this.texF?.dispose(); this.texF2?.dispose();
      this.texF = dataTex(new Uint8Array(n * 4), this.w, this.h, THREE.RGBAFormat, THREE.UnsignedByteType, true);
      this.texF2 = dataTex(new Uint8Array(n * 4), this.w, this.h, THREE.RGBAFormat, THREE.UnsignedByteType, true);
      this.shared.uFields.value = this.texF; this.shared.uFields2.value = this.texF2;
    }
    const a = this.texF.image.data as Uint8Array, b = this.texF2!.image.data as Uint8Array;
    const veg = L.vegetation as Float32Array | undefined, moist = L.moisture as Float32Array | undefined;
    const snow = L.snow as Float32Array | undefined, ice = L.ice as Float32Array | undefined;
    const temp = L.temperature as Float32Array | undefined, ter = L.terrain as Uint8Array | undefined;
    const lake = this.hydro?.lakeMask;
    const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    for (let i = 0; i < n; i++) {
      a[i * 4] = c(veg ? veg[i] : 0.3);
      a[i * 4 + 1] = c(moist ? moist[i] : 0.4);
      a[i * 4 + 2] = c(snow ? Math.min(1, snow[i] / 60) : 0);
      a[i * 4 + 3] = c(ice ? Math.min(1, ice[i] / 800) : 0);
      b[i * 4] = c(temp ? (temp[i] + 30) / 70 : 0.5);
      b[i * 4 + 1] = lake ? lake[i] : 0;
      b[i * 4 + 2] = ter && ter[i] === 4 ? 255 : 0;
      b[i * 4 + 3] = ter && ter[i] === 3 ? 255 : 0;
    }
    this.texF.needsUpdate = true; this.texF2!.needsUpdate = true;
  }

  private updateHeat() {
    const f = this.frame!;
    const m = this.mode;
    let heat: HeatStyle | null = null;
    let src: Float32Array | Uint8Array | undefined;
    if (m.kind === "heatmap") { heat = HEATMAPS[m.layer]; src = f.layers[m.layer]; }
    if (m.kind === "resource") { heat = m.style; src = f.layers[m.layer]; }
    if (!heat || !src) { this.shared.uHeatMix.value = 0; return; }
    const n = this.w * this.h;
    if (!this.texHeat || this.texHeat.image.width !== this.w || this.texHeat.image.height !== this.h) {
      this.texHeat?.dispose();
      this.texHeat = dataTex(new Uint8Array(n * 4), this.w, this.h, THREE.RGBAFormat, THREE.UnsignedByteType, true);
      this.shared.uHeat.value = this.texHeat;
    }
    const d = this.texHeat.image.data as Uint8Array;
    const elev = f.layers.elevation as Float32Array;
    for (let i = 0; i < n; i++) {
      const col = heat.color(src[i], elev[i] - f.sea_level);
      d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = 255;
    }
    this.texHeat.needsUpdate = true;
    this.shared.uHeatMix.value = 0.82;
  }

  private updateClouds() {
    const L = this.frame!.layers;
    const cl = L.clouds as Float32Array | undefined;
    const rain = L.rain as Float32Array | undefined;
    const n = this.w * this.h;
    if (!this.texCloud || this.texCloud.image.width !== this.w || this.texCloud.image.height !== this.h) {
      this.texCloud?.dispose();
      this.texCloud = dataTex(new Uint8Array(n * 4), this.w, this.h, THREE.RGBAFormat, THREE.UnsignedByteType, true);
      (this.clouds.userData.u as { uClouds: THREE.IUniform }).uClouds.value = this.texCloud;
    }
    const d = this.texCloud.image.data as Uint8Array;
    for (let i = 0; i < n; i++) {
      d[i * 4] = Math.round(Math.min(1, cl ? cl[i] : 0) * 255);
      d[i * 4 + 1] = Math.round(Math.min(1, rain ? rain[i] / 2 : 0) * 255);
    }
    this.texCloud.needsUpdate = true;
  }

  private updateFire() {
    const f = this.frame;
    if (!f || !this.field) return;
    const fire = f.layers.fire as Float32Array | undefined;
    const lava = f.layers.lava as Float32Array | undefined;
    const pts: number[] = [], cols: number[] = [];
    for (let i = 0; i < this.w * this.h; i++) {
      const a = fire ? fire[i] : 0, b = lava ? lava[i] : 0;
      if (a <= 0 && b <= 0.02) continue;
      const x = ((i % this.w) + 0.5 - this.w / 2) * this.tile, z = (Math.floor(i / this.w) + 0.5 - this.h / 2) * this.tile;
      pts.push(x, (this.field.height(x, z, 400) - f.sea_level) * this.exaggeration + 60, z);
      if (b > 0.02) cols.push(1.0 * b, 0.32 * b, 0.08 * b); else cols.push(1.0 * a, 0.5 * a, 0.15 * a);
    }
    this.fire.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.fire.geometry.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  }

  // ------------------------------------------------------------------ field sampling (CPU)
  private bil(arr: Float32Array | Uint8Array | undefined, x: number, z: number, def: number): number {
    if (!arr) return def;
    const gx = Math.min(this.w - 1.001, Math.max(0, x / this.tile + this.w / 2 - 0.5));
    const gz = Math.min(this.h - 1.001, Math.max(0, z / this.tile + this.h / 2 - 0.5));
    const ix = Math.floor(gx), iz = Math.floor(gz), fx = gx - ix, fz = gz - iz;
    const i = iz * this.w + ix;
    const a = arr[i], b = arr[Math.min(i + 1, arr.length - 1)], c = arr[Math.min(i + this.w, arr.length - 1)], d = arr[Math.min(i + this.w + 1, arr.length - 1)];
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }

  private desertSrc: Uint8Array | null = null;
  private desertMask: Uint8Array | null = null;

  private bilW(arr: Float32Array | Uint8Array | undefined, x: number, z: number, def: number): number {
    const [wx, wz] = fieldWarp(x, z, this.seed);
    return this.bil(arr, wx, wz, def);
  }


  /** Rendered ground (or sea surface) in scene y at world x, z. */
  groundY(x: number, z: number, minWl = LEAF_MINWL): number {
    if (!this.field || !this.frame) return 0;
    return Math.max(0, (this.field.height(x, z, minWl) - this.frame.sea_level) * this.exaggeration);
  }

  private scatterEnv(): ScatterEnv | null {
    const f = this.frame;
    if (!f || !this.field || this.mode.kind !== "living") return null;
    const L = f.layers;
    const lake = this.hydro?.lakeMask;
    const ter = L.terrain as Uint8Array | undefined;
    if (ter && this.desertSrc !== ter) { this.desertSrc = ter; this.desertMask = ter.map((v) => (v === 4 ? 1 : 0)); }
    const desertMask = ter ? this.desertMask : null;
    return {
      field: this.field, seed: this.seed, sea: f.sea_level, exag: this.exaggeration,
      // field lookups use the same organic warp as the terrain shader, so trees grow where the canopy is painted
      veg: (x, z) => this.bilW(L.vegetation, x, z, 0.3),
      moist: (x, z) => this.bilW(L.moisture, x, z, 0.4),
      temp: (x, z) => this.bilW(L.temperature, x, z, 12),
      cover: (x, z) => Math.min(1, this.bilW(L.snow, x, z, 0) / 60 * 1.7 + this.bilW(L.ice, x, z, 0) / 800 * 2.5),
      lake: (x, z) => (lake ? this.bil(lake, x, z, 0) / 255 : 0),
      desert: (x, z) => (desertMask ? this.bilW(desertMask, x, z, 0) : 0),
      burnt: (x, z) => this.bilW(L.fire, x, z, 0),
      cleared: (x, z) => {
        for (const s of this.shelters) if (Math.abs(s[0] - x) < 28 && Math.abs(s[1] - z) < 28) return true;
        return false;
      },
    };
  }

  // ------------------------------------------------------------------ picking (ray-march the CPU height function)
  private pickNdc(ndc: THREE.Vector2): THREE.Vector3 | null {
    if (!this.field) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    const top = this.terrain.maxY + 10;
    let t = 0;
    if (o.y > top) { if (d.y >= 0) return null; t = (o.y - top) / -d.y; }
    let prevT = t;
    const p = new THREE.Vector3();
    for (let k = 0; k < 600; k++) {
      p.copy(o).addScaledVector(d, t);
      if (t > 4e6 || (p.y > top && d.y > 0)) return null;
      const g = this.groundY(p.x, p.z, Math.max(LEAF_MINWL, t * 0.004));
      const diff = p.y - g;
      if (diff < 0.05) {
        let a = prevT, b = t;
        for (let j = 0; j < 20; j++) {
          const m = (a + b) / 2;
          p.copy(o).addScaledVector(d, m);
          if (p.y - this.groundY(p.x, p.z, Math.max(LEAF_MINWL, m * 0.004)) > 0) a = m; else b = m;
        }
        p.copy(o).addScaledVector(d, b);
        return p.clone();
      }
      prevT = t;
      t += Math.max(diff * 0.45, t * 0.0008, 0.05);
    }
    return null;
  }

  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const r = this.canvas.getBoundingClientRect();
    const hit = this.pickNdc(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1));
    if (!hit) return null;
    const x = Math.floor(hit.x / this.tile + this.w / 2), y = Math.floor(hit.z / this.tile + this.h / 2);
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? { x, y } : null;
  }

  // ------------------------------------------------------------------ camera
  /** Focus: ground under the screen centre, else below the camera, kept inside the map. */
  private focus(): THREE.Vector3 {
    const hit = this.pickNdc(new THREE.Vector2(0, 0));
    const p = hit ?? new THREE.Vector3(this.camera.position.x, 0, this.camera.position.z);
    const hw = (this.w * this.tile) / 2 * 0.95, hh = (this.h * this.tile) / 2 * 0.95;
    p.x = THREE.MathUtils.clamp(p.x, -hw, hw); p.z = THREE.MathUtils.clamp(p.z, -hh, hh);
    p.y = this.groundY(p.x, p.z);
    return p;
  }

  /** Nearest land (above the beach) to a point, searching outward tile by tile. */
  private nearestLand(p: THREE.Vector3): THREE.Vector3 {
    const sea = this.frame!.sea_level;
    const elev = this.frame!.layers.elevation as Float32Array;
    const lake = this.hydro?.lakeMask;
    const veg = this.frame!.layers.vegetation as Float32Array | undefined;
    const tx = Math.floor(p.x / this.tile + this.w / 2), tz = Math.floor(p.z / this.tile + this.h / 2);
    let best = -1, bestScore = -Infinity;
    for (let r = 0; r < Math.max(this.w, this.h) && (best < 0 || r < 4); r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = tx + dx, z = tz + dz;
        if (x < 1 || z < 1 || x >= this.w - 1 || z >= this.h - 1) continue;
        const i = z * this.w + x;
        if (elev[i] - sea < 25 || (lake && lake[i])) continue;
        // a scenic spot: a mix of forest and open ground, with some relief nearby
        const relief = Math.max(Math.abs(elev[i + 1] - elev[i - 1]), Math.abs(elev[i + this.w] - elev[i - this.w]));
        const score = -Math.abs((veg ? veg[i] : 0.4) - 0.38) * 2 + Math.min(relief / 400, 0.5) - r * 0.02;
        if (score > bestScore) { bestScore = score; best = i; }
      }
    }
    if (best < 0) return p.clone();
    const x = ((best % this.w) + 0.5 - this.w / 2) * this.tile, z = (Math.floor(best / this.w) + 0.5 - this.h / 2) * this.tile;
    return new THREE.Vector3(x, this.groundY(x, z), z);
  }

  preset(kind: Preset, animate = true) {
    if (!this.frame) return;
    const span = Math.max(this.w, this.h) * this.tile;
    const go = (pos: THREE.Vector3, look: THREE.Vector3) => {
      const d = look.clone().sub(pos);
      const yaw = Math.atan2(-d.x, -d.z), pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      if (animate) this.controls.flyTo(pos, yaw, pitch, kind === "ground" ? 2.4 : 1.8); else this.controls.set(pos, yaw, pitch);
    };
    const yaw = this.controls.yaw;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    if (kind === "orbit") { go(new THREE.Vector3(0, span * 0.95, span * 0.42), new THREE.Vector3(0, 0, span * 0.02)); return; }
    let F = this.placed && animate ? this.focus() : new THREE.Vector3(0, 0, 0);
    if (kind === "region") {
      const back = Math.min(span * 0.3, 30000);
      const pos = F.clone().addScaledVector(fwd, -back); pos.y = Math.max(F.y, 0) + back * 0.42;
      go(pos, F); return;
    }
    F = this.nearestLand(F);
    if (kind === "low") {
      const pos = F.clone().addScaledVector(fwd, -1500);
      pos.y = Math.max(this.groundY(pos.x, pos.z), F.y) + 380;
      const look = F.clone().addScaledVector(fwd, 1200); look.y = this.groundY(look.x, look.z);
      go(pos, look); return;
    }
    const pos = new THREE.Vector3(F.x, this.groundY(F.x, F.z) + EYE_HEIGHT, F.z);
    const look = pos.clone().addScaledVector(fwd, 100); look.y = pos.y - 3;
    go(pos, look);
  }

  overview() { this.preset("orbit"); }

  /** Region view centred on a tile. */
  flyTo(x: number, y: number) {
    if (!this.w) return;
    const tx = (x + 0.5 - this.w / 2) * this.tile, tz = (y + 0.5 - this.h / 2) * this.tile;
    const F = new THREE.Vector3(tx, this.groundY(tx, tz), tz);
    const fwd = new THREE.Vector3(-Math.sin(this.controls.yaw), 0, -Math.cos(this.controls.yaw));
    const pos = F.clone().addScaledVector(fwd, -7000); pos.y = F.y + 3500;
    const d = F.clone().sub(pos);
    this.controls.flyTo(pos, Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)));
  }

  /** Exact camera placement (used by tests and screenshot tooling). */
  setView(x: number, z: number, aglOrY: number, yawDeg: number, pitchDeg: number, absolute = false) {
    const y = absolute ? aglOrY : this.groundY(x, z) + aglOrY;
    this.controls.set(new THREE.Vector3(x, y, z), THREE.MathUtils.degToRad(yawDeg), THREE.MathUtils.degToRad(pitchDeg));
  }

  screenshot(): Promise<Blob | null> {
    this.render();
    return new Promise((res) => this.canvas.toBlob(res, "image/png"));
  }

  // ------------------------------------------------------------------ loop
  private loop() {
    this.raf = requestAnimationFrame(this.loop);
    const t0 = performance.now();
    const dt = Math.min(0.1, this.clock.getDelta());
    this.shared.uTime.value += dt;
    this.scatter.time.value = this.shared.uTime.value;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 1) {
      this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0;
      this.autoTune();
    }
    this.controls.update(dt);
    this.render();
    this.lastFrameMs = performance.now() - t0;
  }

  private autoTune() {
    if (!this.autoQuality || document.hidden) return;
    this.slowFor = this.fps < 24 ? this.slowFor + 1 : 0;
    if (this.slowFor >= 5 && this.quality !== "low") {
      this.quality = this.quality === "high" ? "medium" : "low";
      this.applyQuality();
      this.slowFor = 0;
      this.onQualityChange?.(this.quality);
    }
  }

  private render() {
    if (this.frame && this.field) {
      this.camera.updateMatrixWorld();
      this.updateSun();
      this.updateAtmosphere();
      this.terrain.update(this.camera);
      this.scatter.update(this.scatterEnv(), this.camera.position, this.controls.agl, this.showTrees);
      this.shared.uCanopyNear.value = this.scatter.treesDrawn ? this.scatter.q.trees : -1;
      this.creatures.update(this.camera, { x: -(this.w * this.tile) / 2, z: -(this.h * this.tile) / 2 },
        (x, z) => this.groundY(x, z), this.controls.agl, this.shared.uTime.value);
      this.fire.visible = this.mode.kind === "living";
      (this.fire.material as THREE.PointsMaterial).opacity = 0.75 + 0.25 * Math.sin(this.shared.uTime.value * 11) * Math.sin(this.shared.uTime.value * 4.7);
    }
    this.sky.position.copy(this.camera.position);
    this.renderer.shadowMap.enabled = this.shadows;
    this.sun.castShadow = this.shadows;
    this.renderer.render(this.scene, this.camera);
    const info = this.renderer.info.render;
    this.stats = {
      fps: this.fps, frameMs: Math.round(this.lastFrameMs * 10) / 10, calls: info.calls, triangles: info.triangles,
      chunks: this.terrain.visibleChunks, trees: this.scatter.counts.trees, rocks: this.scatter.counts.rocks, grass: this.scatter.counts.grass,
      altitude: Math.round(this.controls.agl), quality: this.quality, creatures: this.creatures.counts.bodies,
    };
  }

  private sunDir = new THREE.Vector3(0, 1, 0);

  private updateSun() {
    const f = this.frame!;
    const latMid = (f.lat_top + f.lat_bottom) / 2;
    // Extrapolate time between frames from the simulation speed; above ~12 sim-h/s the day/night
    // cycle would strobe, so the sun is held at the frame's mid-afternoon position for that day.
    const fast = this.simHoursPerSecond > 12;
    const elapsedH = fast ? 0 : ((performance.now() - f.receivedAt) / 1000) * this.simHoursPerSecond;
    let hour = fast ? 15 : (f.calendar.hour + Math.min(elapsedH, 2)) % 24;
    if (this.alwaysDay) hour = 10.5;
    const dir = sunVector(latMid, f.calendar.day_of_year, hour, f.days_per_year);
    this.sunDir.copy(dir);
    const elev = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    this.sunState = { elevationDeg: THREE.MathUtils.radToDeg(elev), azimuthDeg: THREE.MathUtils.radToDeg(Math.atan2(dir.x, -dir.z)), isDay: dir.y > 0 };
    this.sky.material.uniforms.sunPosition.value.copy(dir);
    const day = smooth(-0.1, 0.2, dir.y);
    const golden = 1 - smooth(0.05, 0.4, dir.y);

    // shadow frustum follows the camera's ground focus; its size scales with altitude
    const cam = this.camera.position, agl = Math.max(2, this.controls.agl);
    const r = THREE.MathUtils.clamp(agl * 2.2, 120, 90000);
    const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd); fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) fwd.normalize();
    const c = new THREE.Vector3(cam.x, cam.y - agl, cam.z).addScaledVector(fwd, r * 0.55);
    const L = dir.y > 0.02 ? dir : new THREE.Vector3(dir.x, 0.02, dir.z).normalize();
    this.sun.position.copy(c).addScaledVector(L, r * 4);
    this.sun.target.position.copy(c);
    this.sun.target.updateMatrixWorld();
    const s = this.sun.shadow.camera as THREE.OrthographicCamera;
    s.left = -r; s.right = r; s.top = r; s.bottom = -r; s.near = r * 0.5; s.far = r * 8 + (this.terrain.maxY - this.terrain.minY) * 2;
    s.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = (2 * r) / this.sun.shadow.mapSize.x * 1.2;
    this.terrain.shadowCenter.copy(c);
    this.terrain.shadowRadius = r;

    this.sun.intensity = 3.4 * day;
    this.sun.color.setRGB(1, 0.86 - 0.25 * golden + 0.12 * day, 0.72 - 0.4 * golden + 0.25 * day);
    this.hemi.intensity = 0.15 + 0.55 * day;
    this.hemi.color.setRGB(0.55 + 0.1 * golden, 0.68, 0.9 - 0.2 * golden);
    this.moon.position.set(-dir.x, Math.max(0.4, -dir.y), -dir.z).multiplyScalar(1000).add(c);
    this.moon.target.position.copy(c);
    this.moon.intensity = 0.5 * (1 - day);
    this.renderer.toneMappingExposure = 0.36 + 0.16 * day;

    // reflections / ambient from the same sky (re-baked when the sun has moved)
    if (dir.distanceTo(this.lastEnvSun) > 0.03 || !this.envRT) {
      this.lastEnvSun.copy(dir);
      this.envSky.material.uniforms.sunPosition.value.copy(dir);
      const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
      this.envRT?.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
    this.scene.environmentIntensity = 0.12 + 0.55 * day;
  }

  /** Aerial perspective: denser near the ground, thinning with altitude, tinted by the sky. */
  private updateAtmosphere() {
    const dir = this.sunDir;
    const day = smooth(-0.1, 0.2, dir.y), golden = 1 - smooth(0.05, 0.4, dir.y);
    const fog = this.scene.fog as THREE.FogExp2;
    const alt = Math.max(0, this.camera.position.y);
    fog.density = 1 / (52000 + alt * 2.2);
    fog.color.setRGB(0.012 + 0.5 * day + 0.12 * golden * day, 0.018 + 0.6 * day + 0.02 * golden * day, 0.035 + 0.74 * day - 0.12 * golden * day);
    // clouds: fade when the camera passes through the deck
    const cu = this.clouds.userData.u as { uWind: THREE.IUniform; uFade: THREE.IUniform; uShade: THREE.IUniform };
    const cy = CLOUD_BASE_M * this.exaggeration;
    this.clouds.position.y = cy;
    this.clouds.visible = this.showClouds && this.mode.kind === "living";
    cu.uFade.value = smooth(60, 600, Math.abs(this.camera.position.y - cy));
    const f = this.frame!;
    const simH = Math.min(2, ((performance.now() - f.receivedAt) / 1000) * this.simHoursPerSecond);
    (cu.uWind.value as THREE.Vector2).set(this.windMean * simH * 3600, 0);
    (cu.uShade.value as THREE.Color).setRGB(0.04 + 0.9 * day, 0.045 + 0.88 * day - 0.1 * golden * day, 0.06 + 0.86 * day - 0.25 * golden * day);
  }
}
