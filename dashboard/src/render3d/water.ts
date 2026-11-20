// Ocean, lakes and rivers. Water surfaces sit exactly at SIMULATED levels (engine sea level, engine
// lake water level, river courses traced from engine discharge). Waves, ripples and foam are
// rendering-only.

import * as THREE from "three";
import { GLSL_HEIGHT, type HeightField } from "./heightfield";
import type { Hydro } from "./hydro";
import type { SharedUniforms } from "./terrain";

type Kind = "ocean" | "lake" | "river";

const WAVES = /* glsl */ `
vec3 waveNormal(vec2 p, float dist, float t, float calm) {
  vec2 g = vec2(0.0);
  const int N = 7;
  float L[7] = float[7](96.0, 47.0, 23.0, 11.5, 5.3, 2.1, 0.9);
  float ang[7] = float[7](0.35, -0.42, 0.9, -1.1, 0.15, 1.6, -0.7);
  for (int i = 0; i < N; i++) {
    float k = 6.2831853 / L[i];
    vec2 d = vec2(cos(ang[i]), sin(ang[i]));
    float A = 0.07 / k * calm;                                   // steepness ~0.07
    float fade = 1.0 - smoothstep(L[i] * 25.0, L[i] * 160.0, dist); // no aliasing far away
    g += d * (A * k) * cos(dot(d, p) * k - sqrt(9.81 * k) * t) * fade;
  }
  return normalize(vec3(-g.x, 1.0, -g.y));
}
`;

export function makeWaterMaterial(shared: SharedUniforms, kind: Kind) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0.0, transparent: true, depthWrite: kind !== "lake" });
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, shared);
    const riverAttr = kind === "river" ? "attribute float aSide; attribute vec2 aPerp; attribute float aHalfW; attribute float aDist; attribute float aSpeed; varying float vDist; varying float vSpeed; varying vec2 vFlow;" : "";
    s.vertexShader = s.vertexShader
      .replace("#include <common>", `#include <common>
        uniform float uExag; varying vec3 vWW; ${riverAttr}`)
      .replace("#include <begin_vertex>", kind === "river" ? `
        vec3 transformed = vec3(position);
        float dCam = length(cameraPosition - position);
        float hw = max(aHalfW, dCam * 0.0011);   // never thinner than ~1.5 px, like rivers in satellite imagery
        transformed += vec3(aPerp.x, 0.0, aPerp.y) * aSide * hw;
        // distant terrain is drawn too coarsely to show the carved channel: lift the water a little
        // with distance (≈1 m per km, ≤14 m) so rivers stay continuous when seen from afar
        transformed.y += min(14.0, dCam * 0.0013);
        vDist = aDist; vSpeed = aSpeed; vFlow = vec2(aPerp.y, -aPerp.x);
      ` : "#include <begin_vertex>")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n vWW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uExag; uniform float uTime; uniform sampler2D uFields2; varying vec3 vWW;
        ${kind === "river" ? "varying float vDist; varying float vSpeed; varying vec2 vFlow;" : ""}
        ${GLSL_HEIGHT}
        ${WAVES}
        float waterRough; vec3 waterN;
        float macroBil(vec2 w) {
          vec2 g = (w + 0.5 * uGrid * uTile) / uTile - 0.5; vec2 i = floor(g); vec2 f = g - i; ivec2 b = ivec2(i);
          return mix(mix(elevAt(b), elevAt(b + ivec2(1, 0)), f.x), mix(elevAt(b + ivec2(0, 1)), elevAt(b + ivec2(1, 1)), f.x), f.y);
        }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        {
        vec2 w = vWW.xz;
        float dist = length(cameraPosition - vWW);
        float level = vWW.y / uExag + uSea;
        ${kind === "lake" ? "if (texture(uFields2, mapUV(w)).g < 0.3) discard;" : ""}
        float floorH = dist < 40000.0 ? macroH(w) : macroBil(w);
        float depth = ${kind === "river" ? "1.6" : "max(level - floorH, 0.0)"};
        vec2 muv = mapUV(w);
        if (muv.x < 0.0 || muv.y < 0.0 || muv.x > 1.0 || muv.y > 1.0) depth = 2500.0; // open ocean beyond the simulated map
        vec3 shallow = ${kind === "ocean" ? "vec3(0.02, 0.17, 0.16)" : kind === "lake" ? "vec3(0.03, 0.09, 0.06)" : "vec3(0.04, 0.10, 0.08)"};
        vec3 deep = ${kind === "ocean" ? "vec3(0.002, 0.016, 0.038)" : "vec3(0.006, 0.022, 0.022)"};
        vec3 col = mix(shallow, deep, smoothstep(0.5, ${kind === "ocean" ? "55.0" : "18.0"}, depth));
        float alpha = mix(0.2, 0.97, smoothstep(0.2, 10.0, depth));
        ${kind === "river" ? `
        vec2 fp = vec2(dot(w, vFlow), dot(w, vec2(-vFlow.y, vFlow.x)));
        float r1 = vnoise(vec2(fp.x * 0.35 - uTime * vSpeed, fp.y * 0.6), uSeed + 7.0);
        float r2 = vnoise(vec2(fp.x * 1.3 - uTime * vSpeed * 1.4, fp.y * 1.8), uSeed + 8.0);
        waterN = normalize(vec3((r1 - 0.5) * 0.35 + (r2 - 0.5) * 0.2, 1.0, (r2 - 0.5) * 0.3));
        alpha = 0.9;` : `
        waterN = waveNormal(w, dist, uTime, ${kind === "lake" ? "0.35" : "1.0"});`}
        float foam = 0.0;
        ${kind === "ocean" ? `
        foam = (1.0 - smoothstep(0.0, 2.2, depth)) * smoothstep(0.45, 0.8, vnoise(w * 0.35 + vec2(uTime * 0.6, 0.0), uSeed + 5.0) * 0.7 + 0.3 * sin(depth * 4.0 - uTime * 1.7));
        foam *= 1.0 - smoothstep(300.0, 3000.0, dist);` : ""}
        col = mix(col, vec3(0.85, 0.88, 0.9), foam);
        alpha = max(alpha, foam);
        waterRough = ${kind === "river" ? "mix(0.12, 0.35, smoothstep(200.0, 8000.0, dist))" : "mix(0.03, 0.22, smoothstep(300.0, 60000.0, dist))"} + foam * 0.7;
        diffuseColor = vec4(col, alpha);
        }`)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = waterRough;")
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n normal = normalize((viewMatrix * vec4(waterN, 0.0)).xyz);");
  };
  m.customProgramCacheKey = () => `dwapar-water-${kind}-v1`;
  return m;
}

export class Water {
  readonly group = new THREE.Group();
  readonly ocean: THREE.Mesh;
  private lakeMat: THREE.MeshStandardMaterial;
  private riverMat: THREE.MeshStandardMaterial;
  private lakes: THREE.Mesh[] = [];
  private river: THREE.Mesh | null = null;

  constructor(shared: SharedUniforms) {
    const g = new THREE.PlaneGeometry(4e6, 4e6, 1, 1);
    g.rotateX(-Math.PI / 2);
    this.ocean = new THREE.Mesh(g, makeWaterMaterial(shared, "ocean"));
    this.ocean.receiveShadow = true;
    this.ocean.renderOrder = 1;
    this.lakeMat = makeWaterMaterial(shared, "lake");
    this.riverMat = makeWaterMaterial(shared, "river");
    this.group.add(this.ocean);
  }

  rebuild(hydro: Hydro, field: HeightField, sea: number, exag: number) {
    for (const l of this.lakes) { this.group.remove(l); l.geometry.dispose(); }
    this.lakes = [];
    for (const lk of hydro.lakes) {
      const g = new THREE.PlaneGeometry(lk.x1 - lk.x0, lk.z1 - lk.z0, 1, 1);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, this.lakeMat);
      m.position.set((lk.x0 + lk.x1) / 2, (lk.level - sea) * exag + 0.05, (lk.z0 + lk.z1) / 2);
      m.renderOrder = 2;
      m.receiveShadow = true;
      this.lakes.push(m);
      this.group.add(m);
    }
    if (this.river) { this.group.remove(this.river); this.river.geometry.dispose(); }
    this.river = this.riverMesh(hydro, field, sea, exag);
    if (this.river) this.group.add(this.river);
  }

  private riverMesh(hydro: Hydro, field: HeightField, sea: number, exag: number): THREE.Mesh | null {
    const pos: number[] = [], side: number[] = [], perp: number[] = [], hw: number[] = [], dist: number[] = [], speed: number[] = [];
    const idx: number[] = [];
    for (const r of hydro.rivers) {
      const n = r.x.length;
      if (n < 2) continue;
      const base = pos.length / 3;
      let level = Infinity, s = 0;
      for (let k = 0; k < n; k++) {
        const kp = Math.max(0, k - 1), kn = Math.min(n - 1, k + 1);
        let tx = r.x[kn] - r.x[kp], tz = r.z[kn] - r.z[kp];
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        if (k > 0) s += Math.hypot(r.x[k] - r.x[k - 1], r.z[k] - r.z[k - 1]);
        // water surface: 2 m above the carved bed, never flowing uphill
        const bed = field.height(r.x[k], r.z[k]);
        level = Math.min(level, Math.max(bed + 2.0, sea + 0.3));
        const y = (level - sea) * exag + 0.15;
        for (const sd of [-1, 1]) {
          pos.push(r.x[k], y, r.z[k]); side.push(sd); perp.push(-tz, tx); hw.push(r.width[k] / 2);
          dist.push(s); speed.push(Math.min(1.6, 0.25 + 0.12 * Math.sqrt(r.discharge[k])));
        }
        if (k < n - 1) { const a = base + k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      }
    }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aSide", new THREE.Float32BufferAttribute(side, 1));
    g.setAttribute("aPerp", new THREE.Float32BufferAttribute(perp, 2));
    g.setAttribute("aHalfW", new THREE.Float32BufferAttribute(hw, 1));
    g.setAttribute("aDist", new THREE.Float32BufferAttribute(dist, 1));
    g.setAttribute("aSpeed", new THREE.Float32BufferAttribute(speed, 1));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, this.riverMat);
    m.frustumCulled = false;
    m.renderOrder = 3;
    return m;
  }
}
