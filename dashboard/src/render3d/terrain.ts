// Quadtree level-of-detail terrain. One shared unit grid (with skirts) is placed and scaled per chunk;
// the vertex shader evaluates the shared height function in world space, so chunks of any size
// line up. Finer chunks near the camera include finer (rendering-only) detail octaves.

import * as THREE from "three";
import { EDGE_FALL, GLSL_HEIGHT } from "./heightfield";

export const GRID_N = 32;          // segments per chunk side
export const LEAF_SIZE = 128;      // metres: finest chunk → 4 m vertex spacing

export interface SharedUniforms { [k: string]: THREE.IUniform }

export function makeSharedUniforms(): SharedUniforms {
  return {
    uElev: { value: null }, uRiver: { value: null }, uFields: { value: null }, uFields2: { value: null },
    uHeat: { value: null }, uHeatMix: { value: 0 }, uGrid: { value: new THREE.Vector2(1, 1) }, uTile: { value: 2000 },
    uSea: { value: 0 }, uSeed: { value: 1 }, uDetail: { value: 1 }, uExag: { value: 1 }, uGridLines: { value: 0 },
    uTime: { value: 0 }, uCanopyNear: { value: 900 }, uDepth: { value: null },
  };
}

function gridGeometry(): THREE.BufferGeometry {
  const n = GRID_N;
  const pos: number[] = [], skirt: number[] = [], idx: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) { pos.push(x / n - 0.5, 0, y / n - 0.5); skirt.push(0); }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // skirt: duplicate border ring, pushed down in the shader, hides cracks between LOD levels
  const ring: number[] = [];
  for (let x = 0; x <= n; x++) ring.push(x);
  for (let y = 1; y <= n; y++) ring.push(y * (n + 1) + n);
  for (let x = n - 1; x >= 0; x--) ring.push(n * (n + 1) + x);
  for (let y = n - 1; y >= 1; y--) ring.push(y * (n + 1));
  ring.push(0);
  const base = pos.length / 3;
  for (const r of ring) { pos.push(pos[r * 3], 0, pos[r * 3 + 2]); skirt.push(1); }
  for (let k = 0; k < ring.length - 1; k++) {
    const a = ring[k], b = ring[k + 1], a2 = base + k, b2 = base + k + 1;
    idx.push(a, a2, b, b, a2, b2, a, b, a2, b, b2, a2); // both windings: visible from any side
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("skirt", new THREE.Float32BufferAttribute(skirt, 1));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

const VERT_HEAD = /* glsl */ `
attribute float skirt;
uniform float uMinWl; uniform float uSpacing; uniform float uSkirt; uniform float uExag;
varying vec3 vWorld; varying vec3 vWorldN; varying float vAbove; varying float vH;
${GLSL_HEIGHT}
`;

const VERT_BODY = /* glsl */ `
vec3 transformed = vec3(position);
vec2 wxz = (modelMatrix * vec4(position, 1.0)).xz;
float aboveSea; float dummyA;
float hC = heightAt(wxz, uMinWl, aboveSea);
float hX = heightAt(wxz + vec2(uSpacing, 0.0), uMinWl, dummyA);
float hZ = heightAt(wxz + vec2(0.0, uSpacing), uMinWl, dummyA);
vWorldN = normalize(vec3(-(hX - hC) * uExag, uSpacing, -(hZ - hC) * uExag));
float yW = (hC - uSea) * uExag - skirt * uSkirt;
transformed.y = yW;
vWorld = vec3(wxz.x, yW, wxz.y);
vAbove = aboveSea;
vH = hC;
`;

const FRAG_HEAD = /* glsl */ `
uniform sampler2D uFields; uniform sampler2D uFields2; uniform sampler2D uHeat; uniform float uHeatMix;
uniform float uGridLines; uniform float uExag; uniform float uCanopyNear;
varying vec3 vWorld; varying vec3 vWorldN; varying float vAbove; varying float vH;
float terrRough; float bumpH;
${GLSL_HEIGHT}
vec3 bumpPerturb(vec3 n, vec3 pos, float h) {
  vec3 dpdx = dFdx(pos), dpdy = dFdy(pos);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpdy, n), r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * n - g);
}
`;

// Natural surface classes blended by slope, altitude and simulated fields (vegetation, moisture,
// snow, ice, temperature, deserts, wetlands, rivers). Colours are linear-space albedos.
const FRAG_COLOR = /* glsl */ `
{
vec2 w = vWorld.xz;
float dist = length(cameraPosition - vWorld);
vec2 fw = fieldWarp(w);                    // organic boundaries between 2 km field tiles
vec4 F = texture(uFields, mapUV(fw));
vec4 F2 = texture(uFields2, mapUV(fw));
vec2 tuv = mapUV(w);
vec4 RV = texture(uRiver, tuv);
float veg = F.r, moist = F.g, snowF = F.b, iceF = F.a;
float tempC = F2.r * 70.0 - 30.0, desert = F2.b, wetl = F2.a;
float hs = vH - uSea;                      // rendered height above sea (m)
float relief = hs - vAbove;                // procedural relief relative to the simulated surface
float slope = 1.0 - clamp(normalize(vec3(vWorldN.x / uExag, vWorldN.y, vWorldN.z / uExag)).y, 0.0, 1.0); // true slope
float fineFade = 1.0 - smoothstep(150.0, 900.0, dist);
float microFade = 1.0 - smoothstep(8.0, 70.0, dist);
float n1 = vnoise(w / 1700.0, uSeed + 101.0), n2 = vnoise(w / 260.0, uSeed + 102.0), n3 = vnoise(w / 47.0, uSeed + 103.0);
float n4 = mix(0.5, vnoise(w / 7.3, uSeed + 104.0), fineFade);
float n7 = mix(0.5, vnoise(w / 2.9, uSeed + 107.0), 1.0 - smoothstep(60.0, 300.0, dist));
float n5 = mix(0.5, vnoise(w / 1.17, uSeed + 105.0), microFade);
float n6 = mix(0.5, vnoise(w / 0.31, uSeed + 108.0), 1.0 - smoothstep(3.0, 22.0, dist));
float grit = (n7 - 0.5) * 0.45 + (n5 - 0.5) * 0.4 + (n6 - 0.5) * 0.35;     // zero-mean close-range albedo variation
float patchN = n1 * 0.5 + n2 * 0.32 + n3 * 0.18;

// open ground: meadow grasses (moisture, temperature), dry grass, bare soil
vec3 cLush = vec3(0.060, 0.105, 0.030), cDry = vec3(0.24, 0.20, 0.09), cTundra = vec3(0.15, 0.135, 0.085);
vec3 grass = mix(cDry, cLush, smoothstep(0.12, 0.55, moist + (n2 - 0.5) * 0.2 + (n4 - 0.5) * 0.12));
grass = mix(grass, cTundra, smoothstep(4.0, -3.0, tempC));
grass *= 1.0 + grit * 0.9;
vec3 soil = mix(vec3(0.17, 0.12, 0.075), vec3(0.10, 0.075, 0.05), moist) * (1.0 + grit * 1.2);
float bare = smoothstep(0.62, 0.8, n4 * 0.6 + n5 * 0.4) * 0.5 + (1.0 - smoothstep(0.02, 0.2, veg));
vec3 col = mix(grass, soil, clamp(bare, 0.0, 1.0));
col *= 0.85 + 0.3 * patchN;
float rough = 0.93;

// desert: sand seas and bare gravel plains (simulated desert tiles, or very dry ground)
float wDesert = clamp(desert + (1.0 - smoothstep(0.06, 0.18, moist)) * (1.0 - smoothstep(0.03, 0.12, veg)), 0.0, 1.0);
vec3 cDesert = mix(vec3(0.28, 0.19, 0.105), vec3(0.38, 0.28, 0.16), n2) * (0.9 + 0.2 * n3) * (1.0 + grit * 0.6);
col = mix(col, cDesert, wDesert);

// forest: canopy fraction shared with tree placement. Far: canopy seen from above. Near (where the
// 3D trees are drawn): forest floor of leaf litter and moss under them.
float cf = canopyFrac(veg, w) * (1.0 - wDesert) * smoothstep(-8.0, -3.0, tempC);
float crowns = smoothstep(0.30, 0.72, vnoise(w / 8.5, uSeed + 106.0)) * fineFade + (1.0 - fineFade) * 0.55;
vec3 canopy = mix(vec3(0.014, 0.030, 0.012), vec3(0.040, 0.075, 0.026), crowns);
canopy = mix(canopy, vec3(0.016, 0.034, 0.026), smoothstep(10.0, 0.0, tempC)) * (0.85 + 0.3 * n2);
float canopyVis = uCanopyNear < 0.0 ? 1.0 : smoothstep(uCanopyNear * 0.8, uCanopyNear * 1.02, dist);
vec3 litter = mix(vec3(0.085, 0.060, 0.035), vec3(0.045, 0.060, 0.025), smoothstep(0.45, 0.7, n4 * 0.7 + n3 * 0.3)) * (1.0 + grit * 1.1);
col = mix(col, mix(litter, canopy, canopyVis), cf);
rough = mix(rough, 0.96, cf);

// wetlands and river banks: dark saturated ground
float wWet = clamp(wetl * smoothstep(0.55, 0.95, moist) + RV.r * 0.85, 0.0, 1.0);
col = mix(col, vec3(0.06, 0.06, 0.035) * (0.8 + 0.4 * n3) * (1.0 + grit * 0.5), wWet * 0.75);
rough = mix(rough, 0.55, wWet * 0.6);

// beaches: low, gentle ground next to the sea; wet sand at the waterline
float wBeach = (1.0 - smoothstep(0.8, 3.5, hs + (n3 - 0.5) * 2.0)) * (1.0 - smoothstep(0.06, 0.22, slope)) * step(-40.0, hs)
             * (1.0 - smoothstep(4.0, 12.0, vAbove));   // only where the simulated ground itself meets the sea
vec3 sand = mix(vec3(0.42, 0.36, 0.25), vec3(0.52, 0.45, 0.32), n3) * (1.0 + grit * 0.5);
sand = mix(vec3(0.27, 0.23, 0.155), sand, smoothstep(0.0, 1.6, hs));
col = mix(col, sand, wBeach);
rough = mix(rough, mix(0.45, 0.9, smoothstep(0.0, 1.6, hs)), wBeach);

// rock: steep ground and high bare summits, with strata and lichen tones
float wRock = smoothstep(0.42, 0.66, slope + (n3 - 0.5) * 0.16) + smoothstep(2700.0, 3600.0, hs + (n2 - 0.5) * 500.0) * 0.8;
wRock = clamp(wRock, 0.0, 1.0);
float strata = 0.5 + (0.5 * sin(vH * 0.35 + n3 * 6.0)) * (1.0 - smoothstep(120.0, 700.0, dist)); // fades before it can alias
vec3 rock = mix(vec3(0.15, 0.14, 0.125), vec3(0.30, 0.28, 0.25), n4 * 0.6 + strata * 0.4) * (0.85 + 0.3 * n2) * (1.0 + grit * 1.3);
rock = mix(rock, vec3(0.18, 0.17, 0.10), 0.25 * smoothstep(0.6, 0.9, n3) * (1.0 - smoothstep(2500.0, 3500.0, hs)));
col = mix(col, rock, wRock);
rough = mix(rough, 0.82, wRock);

// snow and glacier ice from the simulation, settling on ridges and gentle slopes
float snowCover = clamp(snowF * 1.7 + iceF * 2.5, 0.0, 1.0) * (0.75 + 0.5 * smoothstep(-60.0, 60.0, relief));
float wSnow = clamp(snowCover * (1.0 - smoothstep(0.55, 0.85, slope)) + (n5 - 0.5) * 0.3 * snowCover, 0.0, 1.0);
vec3 snow = mix(vec3(0.72, 0.77, 0.84), vec3(0.88, 0.91, 0.95), n4) * (1.0 + grit * 0.15);
snow = mix(snow, vec3(0.50, 0.65, 0.78), clamp(iceF * 1.2, 0.0, 0.5));
col = mix(col, snow, wSnow);
rough = mix(rough, 0.5, wSnow);

// sea floor (seen through shallow water)
if (hs < 0.0) { col = mix(sand * 0.8, vec3(0.05, 0.06, 0.05), smoothstep(0.0, -60.0, hs)); rough = 0.8; }

// micro relief for close range (rendering only)
bumpH = (wRock * (n4 * 0.9 + n5 * 0.25 + n6 * 0.06) + (1.0 - wRock) * (n5 * 0.07 + n4 * 0.12 + n6 * 0.025) * (1.0 - wSnow)) * uExag;

// optional overlays: simulation grid (2 km tiles) and scientific heatmaps
if (uHeatMix > 0.0) { vec3 hc = texture(uHeat, tuv).rgb; col = mix(col, hc * hc, uHeatMix); }
if (uGridLines > 0.5) {
  vec2 gtile = (w + 0.5 * uGrid * uTile) / uTile;
  vec2 fwd = fwidth(gtile);
  vec2 d = abs(fract(gtile) - 0.5);
  float line = 1.0 - smoothstep(0.0, 1.5, min((0.5 - d.x) / max(fwd.x, 1e-4), (0.5 - d.y) / max(fwd.y, 1e-4)));
  col = mix(col, vec3(0.9, 0.62, 0.15), line * 0.85);
}
diffuseColor.rgb = col;
terrRough = rough;
}
`;

export function makeTerrainMaterial(shared: SharedUniforms, level: { minWl: number; spacing: number; skirt: number }) {
  const local = { uMinWl: { value: level.minWl }, uSpacing: { value: level.spacing }, uSkirt: { value: level.skirt } };
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, shared, local);
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\n" + VERT_HEAD)
      .replace("#include <begin_vertex>", VERT_BODY);
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\n" + FRAG_HEAD)
      .replace("#include <color_fragment>", "#include <color_fragment>\n" + FRAG_COLOR)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = terrRough;")
      .replace("#include <normal_fragment_begin>", `#include <normal_fragment_begin>
        normal = normalize((viewMatrix * vec4(vWorldN.x, vWorldN.y, vWorldN.z, 0.0)).xyz);
        normal = bumpPerturb(normal, -vViewPosition, bumpH);`);
  };
  m.customProgramCacheKey = () => "dwapar-terrain-v1";
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, shared, local);
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\n" + VERT_HEAD.replace("varying vec3 vWorld; varying vec3 vWorldN; varying float vAbove; varying float vH;", ""))
      .replace("#include <begin_vertex>", `vec3 transformed = vec3(position);
        vec2 wxz = (modelMatrix * vec4(position, 1.0)).xz; float ab;
        transformed.y = (heightAt(wxz, max(uMinWl, 25.0), ab) - uSea) * uExag - skirt * uSkirt;`);
  };
  depth.customProgramCacheKey = () => "dwapar-terrain-depth-v1";
  return { material: m, depth, local };
}

interface Node { x: number; z: number; size: number; level: number }

export class Terrain {
  readonly group = new THREE.Group();
  private geo = gridGeometry();
  private levels: { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial; local: Record<string, THREE.IUniform> }[] = [];
  private pool: THREE.Mesh[] = [];
  private rootSize = LEAF_SIZE;
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  lodFactor = 1.7;
  visibleChunks = 0;
  minY = -4000;
  maxY = 5000;
  private halfW = 1e9;
  private halfH = 1e9;

  constructor(private shared: SharedUniforms) {}

  configure(mapW: number, mapH: number, tile: number) {
    let s = LEAF_SIZE;
    while (s < Math.max(mapW, mapH) + 2.4 * EDGE_FALL) s *= 2;
    this.rootSize = s;
    this.halfW = mapW / 2 + EDGE_FALL * 1.2; this.halfH = mapH / 2 + EDGE_FALL * 1.2;
    const nLevels = Math.round(Math.log2(s / LEAF_SIZE)) + 1;
    for (const l of this.levels) { l.material.dispose(); l.depth.dispose(); }
    this.levels = [];
    for (let i = 0; i < nLevels; i++) {
      const size = s / 2 ** i;
      const spacing = size / GRID_N;
      // octaves smaller than ~2 vertex spacings cannot be represented at this level
      this.levels.push(makeTerrainMaterial(this.shared, { minWl: spacing * 2.2, spacing, skirt: Math.max(15, size * 0.04) }));
    }
    void tile;
  }

  /** Select chunks for this camera; returns number drawn. */
  shadowCenter = new THREE.Vector3();
  shadowRadius = 1000;

  update(camera: THREE.PerspectiveCamera) {
    const shadowCenter = this.shadowCenter, shadowRadius = this.shadowRadius;
    if (!this.levels.length) return;
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const tileSize = this.shared.uTile.value as number;
    const nodes: Node[] = [];
    const box = new THREE.Box3();
    const cam = camera.position;
    const visit = (n: Node) => {
      box.min.set(n.x - n.size / 2, this.minY, n.z - n.size / 2);
      box.max.set(n.x + n.size / 2, this.maxY, n.z + n.size / 2);
      if (!this.frustum.intersectsBox(box)) return;
      if (Math.abs(n.x) - n.size / 2 >= this.halfW || Math.abs(n.z) - n.size / 2 >= this.halfH) return;
      const dx = Math.max(0, Math.abs(cam.x - n.x) - n.size / 2);
      const dz = Math.max(0, Math.abs(cam.z - n.z) - n.size / 2);
      const dy = Math.max(0, cam.y - this.maxY, this.minY - cam.y);
      const d = Math.hypot(dx, dy, dz);
      const forced = n.size / GRID_N > tileSize * 0.55; // never coarser than half a simulation tile
      if (n.size > LEAF_SIZE && (forced || d < n.size * this.lodFactor)) {
        const h = n.size / 4;
        for (const [ox, oz] of [[-h, -h], [h, -h], [-h, h], [h, h]]) visit({ x: n.x + ox, z: n.z + oz, size: n.size / 2, level: n.level + 1 });
      } else nodes.push(n);
    };
    visit({ x: 0, z: 0, size: this.rootSize, level: 0 });
    while (this.pool.length < nodes.length) {
      const m = new THREE.Mesh(this.geo, this.levels[0].material);
      m.frustumCulled = false; m.receiveShadow = true; m.matrixAutoUpdate = true;
      this.pool.push(m); this.group.add(m);
    }
    nodes.forEach((n, i) => {
      const m = this.pool[i];
      const L = this.levels[Math.min(n.level, this.levels.length - 1)];
      m.visible = true;
      m.material = L.material;
      m.customDepthMaterial = L.depth;
      m.position.set(n.x, 0, n.z);
      m.scale.set(n.size, 1, n.size);
      const near = Math.hypot(n.x - shadowCenter.x, n.z - shadowCenter.z) < shadowRadius + n.size;
      m.castShadow = near && n.size <= shadowRadius * 2;
    });
    for (let i = nodes.length; i < this.pool.length; i++) this.pool[i].visible = false;
    this.visibleChunks = nodes.length;
  }

  dispose() {
    this.geo.dispose();
    for (const l of this.levels) { l.material.dispose(); l.depth.dispose(); }
  }
}
