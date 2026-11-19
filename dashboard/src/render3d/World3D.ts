// Drishti 3D — an explorable view of the engine's world, built only from engine frames.
//
// Scale: 1 scene unit = 1 km horizontally; heights are (elevation − sea level) × exaggeration.
// The scene never computes simulation state. Everything placed here (terrain shape, colours,
// snow, ice, lakes, river paths, forests, clouds, fire, lava, sun position) is derived from the
// latest frame; animation between frames only extrapolates engine winds / flow directions / time.
// Forest instances are *representational*: each instance stands for a grove sized for visibility,
// its density, type and colour come from biomass and temperature.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Sky } from "three/addons/objects/Sky.js";
import type { Frame } from "../api";
import { HEATMAPS, naturalColor, type HeatStyle } from "../colormaps";
import type { ViewMode } from "../render/Renderer";

const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
const MAX_TREES = 48000;
const RIVER_PARTICLES = 2600;

const GLSL_NOISE = /* glsl */ `
float hash3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash3(i+vec3(0,0,0)),hash3(i+vec3(1,0,0)),f.x), mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x), mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y), f.z); }
float fbm3(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

export interface SunState { elevationDeg: number; azimuthDeg: number; isDay: boolean }

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

function hash(i: number, k: number): number {
  let x = (i * 374761393 + k * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.1, 6000);
  private controls: OrbitControls;
  private sky = new Sky();
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private hemi = new THREE.HemisphereLight(0xbfd6ff, 0x3a3020, 0.6);
  private terrain: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private ocean: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
  private lakes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private conifers: THREE.InstancedMesh;
  private broadleaf: THREE.InstancedMesh;
  private clouds: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>[] = [];
  private cloudTex: THREE.CanvasTexture | null = null;
  private fire: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private rivers: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private depthTex: THREE.DataTexture | null = null;
  private frame: Frame | null = null;
  private heights = new Float32Array(0);
  private w = 0;
  private h = 0;
  private raf = 0;
  private clock = new THREE.Clock();
  private keys = new Set<string>();
  private px = new Float32Array(RIVER_PARTICLES);
  private py = new Float32Array(RIVER_PARTICLES);
  private pa = new Float32Array(RIVER_PARTICLES);
  private riverCells = new Int32Array(0);
  private lastTreeBuild = -1e9;
  private lastTreeTick = -1;
  private uniforms = { uTime: { value: 0 } };
  private raycaster = new THREE.Raycaster();
  mode: ViewMode = { kind: "living" };
  exaggeration = 8;
  simHoursPerSecond = 0;
  windMean = 0;
  showTrees = true;
  showClouds = true;
  shadows = true;
  fps = 0;
  sunState: SunState = { elevationDeg: 0, azimuthDeg: 0, isDay: true };
  private fpsAcc = 0;
  private fpsN = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.55;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.sky.scale.setScalar(4500);
    const su = this.sky.material.uniforms;
    su.turbidity.value = 5; su.rayleigh.value = 1.4; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.82;
    this.scene.add(this.sky, this.sun, this.sun.target, this.hemi);
    this.scene.fog = new THREE.FogExp2(0xaec6dc, 0.0016);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
    this.controls.minDistance = 4;
    this.controls.maxDistance = 900;
    this.controls.screenSpacePanning = false;
    this.controls.zoomSpeed = 0.9;

    const coneG = new THREE.ConeGeometry(0.42, 1.25, 6); coneG.translate(0, 0.62, 0);
    const blG = new THREE.IcosahedronGeometry(0.52, 0); blG.translate(0, 0.55, 0);
    const treeMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, flatShading: true });
    this.conifers = new THREE.InstancedMesh(coneG, treeMat, MAX_TREES);
    this.broadleaf = new THREE.InstancedMesh(blG, treeMat.clone(), MAX_TREES);
    for (const m of [this.conifers, this.broadleaf]) {
      m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.scene.add(m);
    }

    const sprite = this.glowSprite();
    this.fire = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      size: 3.2, map: sprite, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
    }));
    this.rivers = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      size: 0.55, map: sprite, color: 0x9fe4ff, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.rivers.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RIVER_PARTICLES * 3), 3));
    this.rivers.frustumCulled = false;
    this.fire.frustumCulled = false;
    this.scene.add(this.fire, this.rivers);

    canvas.tabIndex = 0;
    canvas.addEventListener("keydown", this.onKey);
    canvas.addEventListener("keyup", this.onKey);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("keydown", this.onKey);
    this.canvas.removeEventListener("keyup", this.onKey);
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose?.();
    });
    this.renderer.dispose();
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.type === "keydown") this.keys.add(e.key.toLowerCase()); else this.keys.delete(e.key.toLowerCase());
  };

  private glowSprite(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.35, "rgba(255,255,255,0.55)"); grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  // ------------------------------------------------------------------ geometry
  private km(): number { return (this.frame?.tile_size_m ?? 2000) / 1000; }
  private toWorldX(x: number) { return (x - this.w / 2 + 0.5) * this.km(); }
  private toWorldZ(y: number) { return (y - this.h / 2 + 0.5) * this.km(); }
  private heightOf(elevM: number, sea: number) { return ((elevM - sea) / 1000) * this.exaggeration; }

  private build(w: number, h: number) {
    this.w = w; this.h = h;
    for (const m of [this.terrain, this.ocean, this.lakes, ...this.clouds]) {
      if (m) { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    }
    this.clouds = [];
    const n = w * h;
    const idx: number[] = [];
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const a = y * w + x, b = a + 1, c = a + w, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const mk = () => {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { pos[i * 3] = this.toWorldX(i % w); pos[i * 3 + 2] = this.toWorldZ(Math.floor(i / w)); }
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setIndex(idx);
      return g;
    };
    // Terrain with procedural surface detail, slope rock and engine snow/ice cover.
    const tg = mk();
    tg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    tg.setAttribute("aSnow", new THREE.BufferAttribute(new Float32Array(n), 1));
    const tm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0.0 });
    tm.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aSnow; varying float vSnow; varying vec3 vWPos; varying vec3 vWNorm;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvSnow = aSnow; vWPos = (modelMatrix * vec4(transformed,1.0)).xyz; vWNorm = normalize(mat3(modelMatrix) * objectNormal);");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying float vSnow; varying vec3 vWPos; varying vec3 vWNorm;\n" + GLSL_NOISE)
        .replace("#include <color_fragment>", `#include <color_fragment>
          float slope = 1.0 - clamp(vWNorm.y, 0.0, 1.0);
          float d1 = fbm3(vWPos * 1.7);
          float d2 = fbm3(vWPos * 9.0);
          vec3 base = diffuseColor.rgb * (0.82 + 0.36 * d1) * (0.9 + 0.2 * d2);
          vec3 rock = vec3(0.30, 0.28, 0.26) * (0.75 + 0.5 * d2);
          base = mix(base, rock, smoothstep(0.32, 0.62, slope) * (1.0 - vSnow));
          float beach = smoothstep(0.35, 0.0, vWPos.y) * smoothstep(-0.05, 0.05, vWPos.y);
          base = mix(base, vec3(0.74, 0.66, 0.50), beach * 0.65);
          vec3 snow = vec3(0.93, 0.95, 0.98) * (0.92 + 0.08 * d2);
          base = mix(base, snow, clamp(vSnow * (1.15 - slope * 0.8), 0.0, 1.0));
          diffuseColor.rgb = base;`);
    };
    this.terrain = new THREE.Mesh(tg, tm);
    this.terrain.receiveShadow = true;
    this.terrain.castShadow = true;
    this.scene.add(this.terrain);

    // Ocean at the engine's sea level.
    const size = Math.max(w, h) * this.km();
    this.depthTex = new THREE.DataTexture(new Uint8Array(w * h * 4), w, h, THREE.RGBAFormat);
    this.depthTex.magFilter = THREE.LinearFilter;
    this.depthTex.minFilter = THREE.LinearFilter;
    this.depthTex.flipY = false;
    const og = new THREE.PlaneGeometry(size * 6, size * 6, 1, 1);
    og.rotateX(-Math.PI / 2);
    const om = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uTime: this.uniforms.uTime, uDepth: { value: this.depthTex }, uMap: { value: new THREE.Vector2(w * this.km(), h * this.km()) },
        uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
        uSky: { value: new THREE.Color(0.55, 0.7, 0.85) }, uFog: { value: new THREE.Color(0.68, 0.78, 0.86) }, uFogDensity: { value: 0.0016 },
        uLight: { value: 1.0 },
      },
      vertexShader: /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform sampler2D uDepth; uniform vec2 uMap; uniform vec3 uSun; uniform vec3 uSunColor;
        uniform vec3 uSky; uniform vec3 uFog; uniform float uFogDensity; uniform float uLight; varying vec3 vW;
        ${GLSL_NOISE}
        void main(){
          vec2 uv = (vW.xz + 0.5 * uMap) / uMap;
          bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
          float dn = inside ? texture2D(uDepth, uv).r : 1.0;
          float depth = dn * dn * 4000.0;                     // metres below sea level (sqrt-encoded)
          vec2 p = vW.xz;
          float t = uTime;
          vec3 n = normalize(vec3(
            0.10 * sin(p.x * 1.9 + t * 1.3) + 0.07 * sin(p.x * 0.7 - p.y * 1.1 + t * 0.8) + 0.18 * (fbm3(vec3(p * 0.9, t * 0.25)) - 0.5),
            1.0,
            0.10 * cos(p.y * 1.6 - t * 1.1) + 0.07 * cos(p.y * 0.9 + p.x * 0.6 + t * 0.6) + 0.18 * (fbm3(vec3(p * 0.9 + 7.0, t * 0.25)) - 0.5)));
          vec3 v = normalize(cameraPosition - vW);
          float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
          vec3 shallow = vec3(0.10, 0.42, 0.46), mid = vec3(0.04, 0.20, 0.33), deep = vec3(0.01, 0.06, 0.14);
          vec3 col = mix(shallow, mid, smoothstep(2.0, 60.0, depth));
          col = mix(col, deep, smoothstep(60.0, 1500.0, depth)) * uLight;
          col = mix(col, uSky, fres * 0.65);
          float spec = pow(max(dot(reflect(-uSun, n), v), 0.0), 220.0) * step(0.0, uSun.y);
          col += uSunColor * spec * 2.2;
          float foam = smoothstep(6.0, 0.0, depth) * smoothstep(0.45, 0.75, fbm3(vec3(p * 3.0, t * 0.6)));
          col = mix(col, vec3(0.92) * uLight, foam * 0.75);
          float dist = length(cameraPosition - vW);
          float fog = 1.0 - exp(-pow(uFogDensity * dist, 2.0));
          col = mix(col, uFog, fog);
          gl_FragColor = vec4(col, mix(0.9, 0.97, smoothstep(5.0, 80.0, depth)));
          #include <colorspace_fragment>
        }`,
    });
    this.ocean = new THREE.Mesh(og, om);
    this.ocean.renderOrder = 1;
    this.scene.add(this.ocean);

    // Lakes and wide rivers: water surfaces at the engine's standing-water height.
    const lg = mk();
    lg.setAttribute("aWater", new THREE.BufferAttribute(new Float32Array(n), 1));
    const lm = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: { uTime: this.uniforms.uTime, uSun: om.uniforms.uSun, uSky: om.uniforms.uSky, uLight: om.uniforms.uLight,
        uFog: om.uniforms.uFog, uFogDensity: om.uniforms.uFogDensity },
      vertexShader: /* glsl */ `attribute float aWater; varying float vWater; varying vec3 vW;
        void main(){ vWater = aWater; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `uniform float uTime; uniform vec3 uSun; uniform vec3 uSky; uniform float uLight; uniform vec3 uFog; uniform float uFogDensity;
        varying float vWater; varying vec3 vW; ${GLSL_NOISE}
        void main(){
          if (vWater < 0.5) discard;
          vec3 n = normalize(vec3(0.12 * (fbm3(vec3(vW.xz * 2.5, uTime * 0.4)) - 0.5), 1.0, 0.12 * (fbm3(vec3(vW.xz * 2.5 + 3.0, uTime * 0.4)) - 0.5)));
          vec3 v = normalize(cameraPosition - vW);
          float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
          vec3 col = mix(vec3(0.07, 0.25, 0.32) * uLight, uSky, fres * 0.6);
          col += pow(max(dot(reflect(-uSun, n), v), 0.0), 160.0) * 1.6 * step(0.0, uSun.y);
          float fog = 1.0 - exp(-pow(uFogDensity * length(cameraPosition - vW), 2.0));
          gl_FragColor = vec4(mix(col, uFog, fog), 0.88);
          #include <colorspace_fragment>
        }`,
    });
    this.lakes = new THREE.Mesh(lg, lm);
    this.lakes.renderOrder = 2;
    this.scene.add(this.lakes);

    // Two cloud decks from the engine's humidity-derived cloud field.
    const cc = document.createElement("canvas");
    cc.width = w; cc.height = h;
    this.cloudTex = new THREE.CanvasTexture(cc);
    this.cloudTex.wrapS = this.cloudTex.wrapT = THREE.RepeatWrapping;
    this.cloudTex.magFilter = THREE.LinearFilter;
    for (const [alt, op] of [[2.6, 0.75], [3.4, 0.45]] as [number, number][]) {
      const cg = new THREE.PlaneGeometry(w * this.km(), h * this.km());
      cg.rotateX(-Math.PI / 2);
      const cm = new THREE.MeshLambertMaterial({ map: this.cloudTex, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide });
      const cl = new THREE.Mesh(cg, cm);
      cl.userData.altKm = alt;
      cl.renderOrder = 3;
      this.clouds.push(cl);
      this.scene.add(cl);
    }

    const span = Math.max(w, h) * this.km();
    this.camera.position.set(0, span * 0.55, span * 0.75);
    this.controls.target.set(0, 0, 0);
    const s = this.sun.shadow.camera as THREE.OrthographicCamera;
    s.left = -span * 0.6; s.right = span * 0.6; s.top = span * 0.6; s.bottom = -span * 0.6; s.near = 1; s.far = span * 4;
    s.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ data
  setFrame(f: Frame) {
    const sizeChanged = !this.frame || f.width !== this.w || f.height !== this.h;
    if (!f.layers.elevation && this.frame && !sizeChanged) f.layers.elevation = this.frame.layers.elevation;
    const elevChanged = f.layers.elevation !== this.frame?.layers.elevation || f.sea_level !== this.frame?.sea_level;
    this.frame = f;
    if (sizeChanged) this.build(f.width, f.height);
    if (elevChanged || sizeChanged) this.updateHeights();
    this.updateSurface();
    this.updateLakes();
    this.updateClouds();
    this.updateFire();
    this.indexRivers();
    const now = performance.now();
    if (sizeChanged || (now - this.lastTreeBuild > 4000 && f.tick !== this.lastTreeTick)) {
      this.updateTrees();
      this.lastTreeBuild = now;
      this.lastTreeTick = f.tick;
    }
  }

  setExaggeration(v: number) {
    this.exaggeration = v;
    if (this.frame) { this.updateHeights(); this.updateLakes(); this.updateFire(); this.updateTrees(); }
  }

  setMode(m: ViewMode) { this.mode = m; if (this.frame) this.updateSurface(); }

  private updateHeights() {
    const f = this.frame!;
    const elev = f.layers.elevation as Float32Array;
    if (!elev || !this.terrain) return;
    const n = this.w * this.h;
    this.heights = new Float32Array(n);
    const pos = this.terrain.geometry.attributes.position as THREE.BufferAttribute;
    const depth = this.depthTex!.image.data as Uint8Array;
    for (let i = 0; i < n; i++) {
      const y = this.heightOf(elev[i], f.sea_level);
      this.heights[i] = y;
      pos.setY(i, y);
      const d = Math.max(0, f.sea_level - elev[i]);
      depth[i * 4] = Math.round(Math.sqrt(Math.min(1, d / 4000)) * 255);
      depth[i * 4 + 3] = 255;
    }
    pos.needsUpdate = true;
    this.terrain.geometry.computeVertexNormals();
    this.terrain.geometry.computeBoundingSphere();
    this.depthTex!.needsUpdate = true;
  }

  private updateSurface() {
    const f = this.frame!;
    if (!this.terrain || !f.layers.elevation) return;
    const L = f.layers;
    const elev = L.elevation as Float32Array;
    const n = this.w * this.h;
    const col = this.terrain.geometry.attributes.color as THREE.BufferAttribute;
    const snowA = this.terrain.geometry.attributes.aSnow as THREE.BufferAttribute;
    const m = this.mode;
    let heat: HeatStyle | null = null;
    let src: Float32Array | Uint8Array | undefined;
    if (m.kind === "heatmap") { heat = HEATMAPS[m.layer]; src = L[m.layer]; }
    if (m.kind === "resource") { heat = m.style; src = L[m.layer]; }
    for (let i = 0; i < n; i++) {
      const e = elev[i] - f.sea_level;
      const c = heat && src ? heat.color(src[i], e) : naturalColor({
        elev: e, veg: (L.vegetation as Float32Array)?.[i] ?? 0, moist: (L.moisture as Float32Array)?.[i] ?? 0.3,
        snow: 0, water: 0, flow: 0, lava: (L.lava as Float32Array)?.[i] ?? 0,
      });
      // Linear-space vertex colours (three applies sRGB output conversion).
      col.setXYZ(i, Math.pow(c[0] / 255, 2.2), Math.pow(c[1] / 255, 2.2), Math.pow(c[2] / 255, 2.2));
      const snow = (L.snow as Float32Array)?.[i] ?? 0, ice = (L.ice as Float32Array)?.[i] ?? 0;
      snowA.setX(i, heat ? 0 : Math.min(1, snow / 60 + ice / 800));
    }
    col.needsUpdate = true;
    snowA.needsUpdate = true;
  }

  private updateLakes() {
    const f = this.frame!;
    if (!this.lakes || !f.layers.elevation) return;
    const elev = f.layers.elevation as Float32Array;
    const water = f.layers.water as Float32Array | undefined;
    const flow = f.layers.flow as Float32Array | undefined;
    const pos = this.lakes.geometry.attributes.position as THREE.BufferAttribute;
    const wa = this.lakes.geometry.attributes.aWater as THREE.BufferAttribute;
    for (let i = 0; i < this.w * this.h; i++) {
      const land = elev[i] >= f.sea_level;
      const sw = water ? water[i] : 0;
      const isWater = land && (sw > 250 || (flow ? flow[i] > 3.0 : false));
      pos.setY(i, this.heightOf(elev[i] + Math.max(sw, 400) / 1000, f.sea_level) + 0.02);
      wa.setX(i, isWater ? 1 : 0);
    }
    pos.needsUpdate = true;
    wa.needsUpdate = true;
  }

  private updateClouds() {
    const f = this.frame!;
    const cl = f.layers.clouds as Float32Array | undefined;
    if (!cl || !this.cloudTex) return;
    const c = this.cloudTex.image as HTMLCanvasElement;
    const g = c.getContext("2d")!;
    const img = g.createImageData(this.w, this.h);
    const rain = f.layers.rain as Float32Array | undefined;
    for (let i = 0; i < this.w * this.h; i++) {
      const storm = rain ? Math.min(1, rain[i] / 2) : 0;
      const v = 245 - storm * 120;
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v + 5;
      img.data[i * 4 + 3] = Math.min(235, cl[i] * cl[i] * 230 + storm * 30);
    }
    g.putImageData(img, 0, 0);
    this.cloudTex.needsUpdate = true;
    this.cloudTex.offset.set(0, 0);
  }

  private updateFire() {
    const f = this.frame!;
    const fire = f.layers.fire as Float32Array | undefined;
    const lava = f.layers.lava as Float32Array | undefined;
    const pts: number[] = [];
    const cols: number[] = [];
    for (let i = 0; i < this.w * this.h; i++) {
      const a = fire ? fire[i] : 0, b = lava ? lava[i] : 0;
      if (a <= 0 && b <= 0.02) continue;
      pts.push(this.toWorldX(i % this.w), (this.heights[i] ?? 0) + 0.6, this.toWorldZ(Math.floor(i / this.w)));
      if (b > 0.02) cols.push(1.0 * b, 0.32 * b, 0.08 * b); else cols.push(1.0 * a, 0.55 * a, 0.18 * a);
    }
    this.fire.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.fire.geometry.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  }

  private indexRivers() {
    const f = this.frame!;
    const flow = f.layers.flow as Float32Array | undefined;
    if (!flow) return;
    const out: number[] = [];
    for (let i = 0; i < flow.length; i++) if (flow[i] > 0.6) out.push(i);
    this.riverCells = Int32Array.from(out);
    this.px.fill(-1);
  }

  private updateTrees() {
    const f = this.frame!;
    const veg = f.layers.vegetation as Float32Array | undefined;
    const temp = f.layers.temperature as Float32Array | undefined;
    const fire = f.layers.fire as Float32Array | undefined;
    const elev = f.layers.elevation as Float32Array | undefined;
    if (!veg || !elev || !this.showTrees) { this.conifers.count = 0; this.broadleaf.count = 0; return; }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    let nc = 0, nb = 0;
    const km = this.km();
    for (let i = 0; i < this.w * this.h && nc < MAX_TREES && nb < MAX_TREES; i++) {
      const d = veg[i];
      if (d < 0.12 || elev[i] < f.sea_level) continue;
      const count = Math.min(4, Math.floor(d * 5));
      const cold = temp ? temp[i] < 9 : false;
      const burnt = fire ? fire[i] > 0 : false;
      for (let k = 0; k < count; k++) {
        const jx = hash(i, k * 3 + 1) - 0.5, jz = hash(i, k * 3 + 2) - 0.5;
        const x = (i % this.w) + 0.5 + jx * 0.9, z = Math.floor(i / this.w) + 0.5 + jz * 0.9;
        const hx = Math.min(this.w - 1, Math.max(0, Math.round(x - 0.5))), hz = Math.min(this.h - 1, Math.max(0, Math.round(z - 0.5)));
        p.set((x - this.w / 2) * km, this.heights[hz * this.w + hx], (z - this.h / 2) * km);
        const sc = (0.55 + 0.6 * d) * (0.75 + 0.5 * hash(i, k * 3 + 3)) * km * 0.55;
        s.set(sc, sc * (cold ? 1.35 : 1.0), sc);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash(i, k + 9) * Math.PI * 2);
        m.compose(p, q, s);
        const conifer = cold || hash(i, k + 17) < 0.25;
        if (burnt) col.setRGB(0.10, 0.06, 0.04);
        else if (conifer) col.setRGB(0.05 + 0.04 * d, 0.16 + 0.06 * d, 0.07);
        else col.setRGB(0.12 + 0.05 * hash(i, k), 0.26 + 0.12 * d, 0.08);
        if (conifer) { this.conifers.setMatrixAt(nc, m); this.conifers.setColorAt(nc, col); nc++; }
        else { this.broadleaf.setMatrixAt(nb, m); this.broadleaf.setColorAt(nb, col); nb++; }
      }
    }
    this.conifers.count = nc; this.broadleaf.count = nb;
    for (const t of [this.conifers, this.broadleaf]) {
      t.instanceMatrix.needsUpdate = true;
      if (t.instanceColor) t.instanceColor.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ camera
  overview() {
    const span = Math.max(this.w, this.h) * this.km();
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, span * 0.55, span * 0.75);
  }

  flyTo(x: number, y: number) {
    if (!this.w) return;
    const tx = this.toWorldX(x), tz = this.toWorldZ(y), ty = this.heights[y * this.w + x] ?? 0;
    const off = this.camera.position.clone().sub(this.controls.target).setLength(28);
    off.y = Math.max(off.y, 10);
    this.controls.target.set(tx, ty, tz);
    this.camera.position.set(tx + off.x, ty + off.y, tz + off.z);
  }

  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!this.terrain) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    if (!hit) return null;
    const x = Math.floor(hit.point.x / this.km() + this.w / 2), y = Math.floor(hit.point.z / this.km() + this.h / 2);
    return x >= 0 && y >= 0 && x < this.w && y < this.h ? { x, y } : null;
  }

  screenshot(): Promise<Blob | null> {
    this.renderer.render(this.scene, this.camera);
    return new Promise((res) => this.canvas.toBlob(res, "image/png"));
  }

  // ------------------------------------------------------------------ loop
  private loop() {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, this.clock.getDelta());
    this.uniforms.uTime.value += dt;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 1) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }
    this.keyboard(dt);
    this.controls.update();
    if (this.frame) {
      this.updateSun();
      this.animateRivers(dt);
      this.animateClouds();
      const fm = this.fire.material;
      fm.opacity = 0.75 + 0.25 * Math.sin(this.uniforms.uTime.value * 11) * Math.sin(this.uniforms.uTime.value * 4.7);
      this.renderer.shadowMap.enabled = this.shadows;
      for (const c of this.clouds) c.visible = this.showClouds;
    }
    this.renderer.render(this.scene, this.camera);
  }

  private keyboard(dt: number) {
    if (!this.keys.size) return;
    const speed = this.camera.position.distanceTo(this.controls.target) * 0.9 * dt;
    const fwd = new THREE.Vector3().subVectors(this.controls.target, this.camera.position); fwd.y = 0; fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const mv = new THREE.Vector3();
    if (this.keys.has("w") || this.keys.has("arrowup")) mv.add(fwd);
    if (this.keys.has("s") || this.keys.has("arrowdown")) mv.sub(fwd);
    if (this.keys.has("d") || this.keys.has("arrowright")) mv.add(right);
    if (this.keys.has("a") || this.keys.has("arrowleft")) mv.sub(right);
    if (mv.lengthSq() > 0) { mv.normalize().multiplyScalar(speed); this.camera.position.add(mv); this.controls.target.add(mv); }
    if (this.keys.has("q") || this.keys.has("e")) {
      const ang = (this.keys.has("q") ? 1 : -1) * dt * 0.9;
      const off = this.camera.position.clone().sub(this.controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
      this.camera.position.copy(this.controls.target).add(off);
    }
  }

  private updateSun() {
    const f = this.frame!;
    const latMid = (f.lat_top + f.lat_bottom) / 2;
    // Extrapolate time between frames from the simulation speed; above ~12 sim-h/s the day/night
    // cycle would strobe, so the sun is held at the frame's mid-afternoon position for that day.
    const fast = this.simHoursPerSecond > 12;
    const elapsedH = fast ? 0 : ((performance.now() - f.receivedAt) / 1000) * this.simHoursPerSecond;
    const hour = fast ? 15 : (f.calendar.hour + Math.min(elapsedH, 2)) % 24;
    const dir = sunVector(latMid, f.calendar.day_of_year, hour, f.days_per_year);
    const elev = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    this.sunState = { elevationDeg: THREE.MathUtils.radToDeg(elev), azimuthDeg: THREE.MathUtils.radToDeg(Math.atan2(dir.x, -dir.z)), isDay: dir.y > 0 };
    this.sky.material.uniforms.sunPosition.value.copy(dir);
    const span = Math.max(this.w, this.h) * this.km();
    const day = THREE.MathUtils.smoothstep(dir.y, -0.08, 0.18);
    this.sun.position.copy(dir.clone().multiplyScalar(span * 1.5));
    this.sun.target.position.set(0, 0, 0);
    this.sun.intensity = 2.6 * day;
    this.sun.color.setRGB(1, 0.78 + 0.2 * day, 0.6 + 0.35 * day);
    this.hemi.intensity = 0.12 + 0.55 * day;
    this.renderer.toneMappingExposure = 0.22 + 0.36 * day;
    const fog = new THREE.Color().setRGB(0.02 + 0.66 * day, 0.03 + 0.75 * day, 0.06 + 0.8 * day);
    (this.scene.fog as THREE.FogExp2).color.copy(fog);
    const om = this.ocean?.material.uniforms;
    if (om) {
      om.uSun.value.copy(dir);
      om.uSky.value.setRGB(0.05 + 0.5 * day, 0.08 + 0.62 * day, 0.15 + 0.7 * day);
      om.uFog.value.copy(fog);
      om.uLight.value = 0.18 + 0.82 * day;
    }
  }

  private animateClouds() {
    const f = this.frame!;
    if (!this.cloudTex) return;
    const simH = Math.min(2, ((performance.now() - f.receivedAt) / 1000) * this.simHoursPerSecond);
    this.cloudTex.offset.x = -(this.windMean * simH) / this.w;
    // Fade cloud decks out as the camera approaches them, so a flat deck never slices the view.
    const camY = this.camera.position.y;
    for (const c of this.clouds) {
      c.position.y = (c.userData.altKm as number) * this.exaggeration * 0.9;
      const gap = Math.abs(camY - c.position.y);
      const dist = this.camera.position.distanceTo(this.controls.target);
      const base = c.userData.baseOpacity ?? (c.userData.baseOpacity = c.material.opacity);
      c.material.opacity = base * THREE.MathUtils.smoothstep(gap, 4, 30) * THREE.MathUtils.smoothstep(dist, 25, 90);
    }
  }

  private animateRivers(dt: number) {
    const f = this.frame!;
    const dir = f.layers.flow_dir as Uint8Array | undefined;
    const flow = f.layers.flow as Float32Array | undefined;
    const pos = this.rivers.geometry.attributes.position as THREE.BufferAttribute;
    if (!dir || !flow || !this.riverCells.length) { this.rivers.visible = false; return; }
    this.rivers.visible = true;
    const n = Math.min(RIVER_PARTICLES, this.riverCells.length * 4);
    for (let k = 0; k < RIVER_PARTICLES; k++) {
      if (k >= n) { pos.setXYZ(k, 0, -999, 0); continue; }
      if (this.px[k] < 0 || this.pa[k] > 1) {
        const c = this.riverCells[Math.floor(Math.random() * this.riverCells.length)];
        this.px[k] = (c % this.w) + Math.random(); this.py[k] = Math.floor(c / this.w) + Math.random(); this.pa[k] = 0;
      }
      const cx = Math.floor(this.px[k]), cy = Math.floor(this.py[k]);
      if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) { this.px[k] = -1; continue; }
      const i = cy * this.w + cx;
      const d = dir[i];
      if (d === 0 || flow[i] < 0.3 || this.heights[i] < 0) { this.px[k] = -1; continue; }
      const [dy, dx] = DIRS[d - 1];
      const nrm = Math.hypot(dx, dy);
      const sp = 0.5 + Math.log10(1 + flow[i] * 4) * 0.7; // visual speed; direction = engine flow
      this.px[k] += (dx / nrm) * sp * dt; this.py[k] += (dy / nrm) * sp * dt; this.pa[k] += dt * 0.3;
      pos.setXYZ(k, (this.px[k] - this.w / 2) * this.km(), this.heights[i] + 0.12, (this.py[k] - this.h / 2) * this.km());
    }
    pos.needsUpdate = true;
  }
}
