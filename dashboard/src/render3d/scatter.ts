// Procedural ground cover near the camera: trees, rocks, grass. RENDERING ONLY.
//
// Nothing here is simulated. The engine knows vegetation *biomass* per 2 km tile; it does not know
// individual trees. Each object below is placed deterministically (hash of world seed + cell), and
// whether it appears, what kind it is and how big it grows is read from the simulated fields at
// that spot: biomass → tree density, temperature → conifer vs broadleaf and treeline, snow/ice and
// lakes/rivers/sea → exclusion, slope and altitude → rocks. The same camera position always shows
// the same trees, and they change only when the simulation's fields change.

import * as THREE from "three";
import { canopyFrac, hash3, vnoise, type HeightField } from "./heightfield";

export interface ScatterEnv {
  field: HeightField;
  seed: number;
  sea: number;
  exag: number;
  /** bilinear samples of simulated fields at world (x, z) */
  veg(x: number, z: number): number;
  moist(x: number, z: number): number;
  temp(x: number, z: number): number;
  cover(x: number, z: number): number;  // snow/ice cover 0..1
  lake(x: number, z: number): number;
  desert(x: number, z: number): number;
  burnt(x: number, z: number): number;
  /** true where people have cleared the ground (around simulated shelters) */
  cleared(x: number, z: number): boolean;
}

export interface ScatterQuality { trees: number; rocks: number; grass: number }

const LEAF_MINWL = 8.8; // matches the finest terrain chunk (4 m spacing × 2.2)
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ geometry
// Trees are built from "leaf cards": many small textured quads (a leaf-cluster / needle-spray
// texture drawn procedurally below) arranged around the crown, with normals pointing out of the
// crown so light wraps around it softly. Bark is coloured by vertex colour only; foliage is tinted
// per instance (species / biomass / dryness / burn).

function prng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; s ^= s >>> 12; return (s >>> 0) / 4294967296; }; }

// atlas: [0,256) broadleaf cluster · [256,512) conifer branch spray · [512,768) whole-conifer silhouette · bark block at (2..12, 2..12)
const ATLAS_W = 768, ATLAS_H = 256;
let atlas: THREE.CanvasTexture | null = null;
function leafAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const c = document.createElement("canvas");
  c.width = ATLAS_W; c.height = ATLAS_H;
  const g = c.getContext("2d")!;
  const r = prng(1234);
  g.fillStyle = "rgb(200,200,200)"; g.fillRect(2, 2, 10, 10);
  const leaf = (x: number, y: number, len: number, wid: number, ang: number, shade: number) => {
    g.save(); g.translate(x, y); g.rotate(ang);
    g.fillStyle = `rgb(${shade},${shade},${shade})`;
    g.beginPath(); g.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = `rgba(0,0,0,0.25)`; g.lineWidth = 0.6; g.beginPath(); g.moveTo(-len / 2, 0); g.lineTo(len / 2, 0); g.stroke();
    g.restore();
  };
  // broadleaf cluster: twigs, then ~420 leaves densest at the centre
  g.strokeStyle = "rgb(70,60,50)"; g.lineWidth = 2;
  for (let k = 0; k < 7; k++) { const a = r() * Math.PI * 2; g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.cos(a) * 100, 128 + Math.sin(a) * 100); g.stroke(); }
  for (let k = 0; k < 420; k++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 112;
    leaf(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 12 + r() * 9, 6 + r() * 4, r() * Math.PI, Math.round(120 + r() * 135 - d * 0.35));
  }
  // conifer branch spray: a twig left→right with drooping needle tufts, tapering to the tip
  const needles = (x0: number, y0: number, x1: number, y1: number, len: number, count: number) => {
    for (let k = 0; k < count; k++) {
      const u = k / count, x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u;
      const L = len * (1 - u * 0.7);
      for (const side of [-1, 1]) {
        const a = side * (0.9 + r() * 0.3) + 0.25;
        const sh = Math.round(110 + r() * 120);
        g.strokeStyle = `rgb(${sh},${sh},${sh})`; g.lineWidth = 1.3;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * L * 0.4, y + Math.sin(a) * L); g.stroke();
      }
    }
  };
  g.strokeStyle = "rgb(60,50,40)"; g.lineWidth = 2.5; g.beginPath(); g.moveTo(262, 128); g.lineTo(506, 140); g.stroke();
  needles(262, 128, 506, 140, 60, 140);
  for (let k = 0; k < 9; k++) { const x = 290 + k * 24, y = 129 + k * 1.3; needles(x, y, x + 34, y + 30 - k, 22, 16); needles(x, y, x + 34, y - 26 + k, 22, 16); }
  // whole conifer silhouette: trunk + layered needle sprays forming a narrow cone
  g.fillStyle = "rgb(70,55,45)"; g.fillRect(637, 150, 6, 106);
  for (let k = 0; k < 26; k++) {
    const y = 250 - k * 9.2, half = (1 - k / 26) * 62 + 3;
    for (const side of [-1, 1]) needles(640, y, 640 + side * half, y + 10 + (1 - k / 26) * 10, 12, Math.max(6, Math.round(half / 2.5)));
  }
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  return atlas;
}

class GeoBuilder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; col: number[] = []; leaf: number[] = []; idx: number[] = [];
  private v(p: THREE.Vector3, n: THREE.Vector3, u: number, w: number, c: [number, number, number], lf: number) {
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.uv.push(u, w); this.col.push(...c); this.leaf.push(lf);
    return this.pos.length / 3 - 1;
  }
  /** textured card centred at c, spanning ±a and ±b; uv rect in atlas pixels; normals from `nfn` */
  card(c: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, rect: [number, number, number, number], nfn: (p: THREE.Vector3) => THREE.Vector3, shade: number) {
    const [x0, y0, x1, y1] = rect;
    const U = (x: number) => x / ATLAS_W, V = (y: number) => 1 - y / ATLAS_H;
    const corners: [number, number, number, number][] = [[-1, -1, x0, y1], [1, -1, x1, y1], [1, 1, x1, y0], [-1, 1, x0, y0]];
    const ids = corners.map(([sa, sb, ux, vy]) => {
      const p = c.clone().addScaledVector(a, sa).addScaledVector(b, sb);
      return this.v(p, nfn(p), U(ux), V(vy), [shade, shade, shade], 1);
    });
    this.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  }
  cylinder(y0: number, y1: number, r0: number, r1: number, sides: number, color: [number, number, number], from = new THREE.Vector3(), dir = new THREE.Vector3(0, 1, 0)) {
    const base = this.pos.length / 3;
    const up = dir.clone().normalize(), side = Math.abs(up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const e1 = new THREE.Vector3().crossVectors(up, side).normalize(), e2 = new THREE.Vector3().crossVectors(up, e1);
    const bu = 7 / ATLAS_W, bv = 1 - 7 / ATLAS_H;
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2, n = e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
      this.v(from.clone().addScaledVector(up, y0).addScaledVector(n, r0), n, bu, bv, color, 0);
      this.v(from.clone().addScaledVector(up, y1).addScaledVector(n, r1), n, bu, bv, color, 0);
    }
    for (let k = 0; k < sides; k++) { const a = base + k * 2; this.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("leaf", new THREE.Float32BufferAttribute(this.leaf, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const BARK: [number, number, number] = [0.20, 0.16, 0.12];
const RECT_BROAD: [number, number, number, number] = [14, 14, 242, 242];
const RECT_BRANCH: [number, number, number, number] = [258, 60, 510, 200];
const RECT_CONE: [number, number, number, number] = [572, 4, 708, 256];

function randUnit(r: () => number) { const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z); return new THREE.Vector3(s * Math.cos(a), z, s * Math.sin(a)); }

/** Unit-height conifer (1 m tall, scaled per instance). */
function conifer(hi: boolean): THREE.BufferGeometry {
  const B = new GeoBuilder(), r = prng(hi ? 77 : 78);
  const nCone = (p: THREE.Vector3) => new THREE.Vector3(p.x, 0.45 + (p.y - 0.5) * 0.2, p.z).normalize();
  if (hi) {
    B.cylinder(0, 0.97, 0.016, 0.004, 6, BARK);
    for (let k = 0; k < 11; k++) {
      const y = 0.16 + k * 0.074, L = 0.25 * Math.pow(1 - (y - 0.16) / 0.86, 0.85) + 0.035;
      const n = 6;
      for (let j = 0; j < n; j++) {
        const ang = (j / n) * Math.PI * 2 + k * 0.7 + r() * 0.4;
        const d = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
        const droop = -0.35 - r() * 0.25;
        const along = new THREE.Vector3(d.x, droop, d.z).normalize().multiplyScalar(L / 2);
        const across = new THREE.Vector3(-d.z, 0, d.x).applyAxisAngle(d, (r() - 0.5) * 0.9).multiplyScalar(L * 0.34);
        const c = new THREE.Vector3(0, y, 0).addScaledVector(along, 1);
        B.card(c, along, across, RECT_BRANCH, nCone, 0.7 + 0.35 * (k / 11));
      }
    }
    for (let j = 0; j < 2; j++) {
      const a = j * Math.PI / 2 + 0.3;
      B.card(new THREE.Vector3(0, 0.56, 0), new THREE.Vector3(Math.cos(a) * 0.17, 0, Math.sin(a) * 0.17), new THREE.Vector3(0, 0.44, 0), RECT_CONE, nCone, 0.8);
    }
  } else {
    for (let j = 0; j < 3; j++) {
      const a = (j * Math.PI) / 3;
      B.card(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(Math.cos(a) * 0.24, 0, Math.sin(a) * 0.24), new THREE.Vector3(0, 0.5, 0), RECT_CONE, nCone, 0.9);
    }
  }
  return B.build();
}

/** Unit-height broadleaf tree: trunk, limbs and a crown of leaf-cluster cards. */
function broadleaf(hi: boolean): THREE.BufferGeometry {
  const B = new GeoBuilder(), r = prng(hi ? 91 : 92);
  const C = new THREE.Vector3(0, 0.64, 0), R = new THREE.Vector3(0.31, 0.27, 0.31);
  const nSph = (p: THREE.Vector3) => p.clone().sub(C).divide(R).normalize();
  B.cylinder(0, 0.5, 0.028, 0.017, hi ? 7 : 4, BARK);
  if (hi) {
    for (let k = 0; k < 4; k++) {
      const a = k * 1.7 + 0.4, dir = new THREE.Vector3(Math.cos(a) * 0.8, 1, Math.sin(a) * 0.8);
      B.cylinder(0, 0.26, 0.012, 0.004, 4, BARK, new THREE.Vector3(0, 0.42, 0), dir);
    }
    for (let k = 0; k < 44; k++) {
      const d = randUnit(r);
      const rad = 0.5 + 0.5 * Math.sqrt(r());
      const c = C.clone().add(d.clone().multiply(R).multiplyScalar(rad));
      const n = d.clone().add(randUnit(r).multiplyScalar(0.6)).normalize();
      const a = new THREE.Vector3().crossVectors(n, Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
      const b = new THREE.Vector3().crossVectors(n, a);
      const s = 0.13 + 0.06 * r();
      B.card(c, a.multiplyScalar(s), b.multiplyScalar(s), RECT_BROAD, nSph, (0.6 + 0.4 * rad) * (0.85 + 0.25 * (c.y - 0.4) / 0.5));
    }
  } else {
    for (let j = 0; j < 3; j++) {
      const a = (j * Math.PI) / 3;
      B.card(C, new THREE.Vector3(Math.cos(a) * 0.33, 0, Math.sin(a) * 0.33), new THREE.Vector3(0, 0.3, 0), RECT_BROAD, nSph, 0.9);
    }
    B.card(C.clone().add(new THREE.Vector3(0, 0.12, 0)), new THREE.Vector3(0.3, 0, 0), new THREE.Vector3(0, 0, 0.3), RECT_BROAD, nSph, 1.0);
  }
  return B.build();
}

function treeMaterial(time: { value: number }) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, map: leafAtlas(), alphaTest: 0.45, side: THREE.DoubleSide });
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = time;
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float leaf; uniform float uTime;")
      .replace("#include <color_vertex>", `
        vColor = vec3(1.0);
        #ifdef USE_COLOR
          vColor *= color;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor *= mix(vec3(1.0), instanceColor.rgb, leaf);   // tint foliage only, never bark
        #endif`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        {
          vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float sway = sin(uTime * 0.9 + ip.x * 0.05 + ip.y * 0.07) + 0.4 * sin(uTime * 2.3 + ip.x * 0.2);
          transformed.xz += vec2(0.012, 0.006) * sway * position.y * position.y + leaf * 0.004 * sin(uTime * 4.0 + position.x * 40.0);
        }`);
    s.fragmentShader = s.fragmentShader
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n normal = normalize(vNormal); // crown normals: do not flip on back faces");
  };
  m.customProgramCacheKey = () => "dwapar-tree-v1";
  return m;
}

function rockGeo(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const flat = 0.45 + 0.4 * hash3(seed, 1, 9);
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
    const n = vnoise(v.x * 2.6 + seed * 7, v.y * 2.6 + v.z * 1.7, seed) * 0.55 + vnoise(v.x * 7 + 3, v.z * 7 + v.y * 5, seed + 1) * 0.2;
    v.multiplyScalar(0.7 + n);
    v.y *= flat;
    // facet: snap toward a few planes for a fractured look
    v.x = Math.round(v.x * 9) / 9 * 0.3 + v.x * 0.7;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function grassTuft(): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], h: number[] = [];
  const blades = 9;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + hash3(b, 2, 5) * 0.7;
    const r = 0.04 + 0.12 * hash3(b, 3, 5);
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const lean = 0.12 + 0.25 * hash3(b, 4, 5);
    const ht = 0.55 + 0.45 * hash3(b, 5, 5);
    const w = 0.022;
    const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    pos.push(ox - px, 0, oz - pz, ox + px, 0, oz + pz, ox + Math.cos(a) * lean, ht, oz + Math.sin(a) * lean);
    const g = 0.75 + 0.5 * hash3(b, 6, 5);
    col.push(0.5 * g, 0.55 * g, 0.3 * g, 0.5 * g, 0.55 * g, 0.3 * g, 0.9 * g, 0.95 * g, 0.55 * g);
    h.push(0, 0, ht);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("bladeH", new THREE.Float32BufferAttribute(h, 1));
  g.computeVertexNormals();
  // grass lit mostly from above, like a dense sward
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < nrm.count; i++) { const v = new THREE.Vector3(nrm.getX(i), nrm.getY(i), nrm.getZ(i)); v.y = Math.abs(v.y) + 1.6; v.normalize(); nrm.setXYZ(i, v.x, v.y, v.z); }
  return g;
}

// ------------------------------------------------------------------ placement
// One cell → packed instances: [x, y, z, scale(h), widthScale, rot, kind, r, g, b]
const STRIDE = 10;

interface Layer {
  cell: number;
  maxPerCell: number;
  cache: Map<string, Float32Array>;
  gen(env: ScatterEnv, cx: number, cz: number, out: number[]): void;
}

function slopeAt(f: HeightField, x: number, z: number, h: number): number {
  const d = 3;
  const hx = f.height(x + d, z, LEAF_MINWL), hz = f.height(x, z + d, LEAF_MINWL);
  return Math.hypot(hx - h, hz - h) / d; // tan(slope)
}

const treeLayer: Layer = {
  cell: 48, maxPerCell: 18, cache: new Map(),
  gen(env, cx, cz, out) {
    const cs = this.cell, x0 = cx * cs, z0 = cz * cs;
    const vegC = env.veg(x0 + cs / 2, z0 + cs / 2);
    if (vegC < 0.04) return;
    const tempC = env.temp(x0 + cs / 2, z0 + cs / 2);
    for (let k = 0; k < this.maxPerCell; k++) {
      const s = env.seed + 1000 + k;
      const x = x0 + hash3(cx, cz, s) * cs, z = z0 + hash3(cx, cz, s + 50) * cs;
      const veg = env.veg(x, z);
      // stand density = the canopy fraction the terrain shader paints from afar, plus lone trees in grassland
      const dens = canopyFrac(veg, x, z, env.seed) * smooth(-8, -3, env.temp(x, z)) + 0.03 * smooth(0.06, 0.2, veg);
      if (hash3(cx, cz, s + 99) > dens) continue;
      const temp = env.temp(x, z);
      if (temp < -7 || env.desert(x, z) > 0.5 || env.cover(x, z) > 0.55 || env.lake(x, z) > 0.25 || env.cleared(x, z)) continue;
      const [ch] = env.field.river(x, z);
      if (ch > 0.15) continue;
      const h = env.field.height(x, z, LEAF_MINWL);
      if (h - env.sea < 2.5) continue;
      if (slopeAt(env.field, x, z, h) > 0.9) continue;
      const conifP = smooth(13, 3, temp) * 0.9 + 0.08;
      const isCon = hash3(cx, cz, s + 7) < conifP;
      const vigor = 0.55 + 0.6 * smooth(0.15, 0.8, veg);
      const height = (isCon ? 11 + 17 * hash3(cx, cz, s + 3) : 8 + 13 * hash3(cx, cz, s + 3)) * vigor * (temp < 0 ? 0.6 : 1);
      const burnt = env.burnt(x, z) > 0;
      const tone = 0.75 + 0.5 * hash3(cx, cz, s + 4);
      let r: number, g: number, b: number;
      if (burnt) { r = 0.05; g = 0.04; b = 0.035; }
      else if (isCon) { r = 0.055 * tone; g = 0.095 * tone; b = 0.06 * tone; }
      else {
        const dry = 1 - smooth(0.2, 0.6, env.moist(x, z));
        r = (0.085 + 0.08 * dry) * tone; g = (0.15 + 0.03 * dry) * tone; b = (0.045 + 0.01 * dry) * tone;
      }
      out.push(x, (h - env.sea) * env.exag - 0.4, z, height, 0.85 + 0.4 * hash3(cx, cz, s + 5), hash3(cx, cz, s + 6) * 6.283, isCon ? 0 : 1, r, g, b);
    }
    void tempC;
  },
};

const rockLayer: Layer = {
  cell: 20, maxPerCell: 6, cache: new Map(),
  gen(env, cx, cz, out) {
    const cs = this.cell, x0 = cx * cs, z0 = cz * cs;
    for (let k = 0; k < this.maxPerCell; k++) {
      const s = env.seed + 2000 + k;
      const x = x0 + hash3(cx, cz, s) * cs, z = z0 + hash3(cx, cz, s + 50) * cs;
      const h = env.field.height(x, z, LEAF_MINWL);
      const above = h - env.sea;
      if (above < 0.3 || env.lake(x, z) > 0.3) continue;
      const sl = slopeAt(env.field, x, z, h);
      const field = vnoise(x / 60, z / 60, env.seed + 41);
      const rocky = smooth(0.45, 1.1, sl) * 0.9 + smooth(1400, 3000, above) * 0.35 + 0.05 * smooth(0.55, 0.85, field)
        + 0.12 * (1 - smooth(1.5, 6, above)) * smooth(0.6, 0.9, field) - env.cover(x, z) * 0.5;
      if (hash3(cx, cz, s + 99) > rocky) continue;
      const big = hash3(cx, cz, s + 3);
      const size = 0.35 + 2.2 * big * big * big + (sl > 0.8 && big > 0.9 ? 3.5 : 0);
      const t = 0.7 + 0.5 * hash3(cx, cz, s + 4), warm = hash3(cx, cz, s + 8) * 0.04;
      out.push(x, above * env.exag - size * 0.28, z, size, 0.8 + 0.5 * hash3(cx, cz, s + 5), hash3(cx, cz, s + 6) * 6.283,
        Math.floor(hash3(cx, cz, s + 7) * 3), (0.25 + warm) * t, 0.235 * t, (0.215 - warm) * t);
    }
  },
};

const grassLayer: Layer = {
  cell: 5, maxPerCell: 7, cache: new Map(),
  gen(env, cx, cz, out) {
    const cs = this.cell, x0 = cx * cs, z0 = cz * cs;
    const vc = env.veg(x0, z0);
    if (vc < 0.05) return;
    for (let k = 0; k < this.maxPerCell; k++) {
      const s = env.seed + 3000 + k;
      const x = x0 + hash3(cx, cz, s) * cs, z = z0 + hash3(cx, cz, s + 50) * cs;
      const veg = env.veg(x, z), moist = env.moist(x, z), temp = env.temp(x, z);
      const patchy = vnoise(x / 9, z / 9, env.seed + 42);
      const dens = smooth(0.05, 0.3, veg) * (1 - 0.55 * smooth(0.45, 0.8, veg)) * (0.3 + 0.7 * patchy) * (1 - env.cover(x, z) * 1.5) * (1 - env.desert(x, z));
      if (hash3(cx, cz, s + 99) > dens || temp < -4) continue;
      const h = env.field.height(x, z, LEAF_MINWL);
      if (h - env.sea < 1.8 || env.lake(x, z) > 0.2) continue;
      const [ch] = env.field.river(x, z);
      if (ch > 0.3) continue;
      const dry = 1 - smooth(0.12, 0.55, moist), cold = smooth(5, -3, temp);
      const t = 0.8 + 0.4 * hash3(cx, cz, s + 4);
      const r = (0.13 + 0.2 * dry + 0.05 * cold) * t, g = (0.2 + 0.07 * dry) * t, b = (0.06 + 0.03 * cold) * t;
      out.push(x, (h - env.sea) * env.exag - 0.05, z, 0.25 + 0.5 * hash3(cx, cz, s + 3) * (0.5 + moist), 0.8 + 0.6 * hash3(cx, cz, s + 5), hash3(cx, cz, s + 6) * 6.283, 0, r, g, b);
    }
  },
};

// ------------------------------------------------------------------ the scatter manager
export class Scatter {
  readonly group = new THREE.Group();
  private conHi: THREE.InstancedMesh; private conLo: THREE.InstancedMesh;
  private brHi: THREE.InstancedMesh; private brLo: THREE.InstancedMesh;
  private rocks: THREE.InstancedMesh[] = [];
  private grass: THREE.InstancedMesh;
  private lastCenter = new THREE.Vector3(1e12, 0, 0);
  private lastGrass = new THREE.Vector3(1e12, 0, 0);
  private dirty = true;
  readonly time = { value: 0 };
  q: ScatterQuality = { trees: 1200, rocks: 600, grass: 90 };
  counts = { trees: 0, rocks: 0, grass: 0 };
  treesDrawn = false;
  private hiDist = 420;

  constructor() {
    const leafMat = treeMaterial(this.time);
    const leafDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafAtlas(), alphaTest: 0.45 });
    const mk = (g: THREE.BufferGeometry, n: number, m: THREE.Material, shadow = true) => {
      const im = new THREE.InstancedMesh(g, m, n);
      im.count = 0; im.frustumCulled = false; im.castShadow = shadow; im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, new THREE.Color(1, 1, 1));
      this.group.add(im);
      return im;
    };
    this.conHi = mk(conifer(true), 30000, leafMat);
    this.conHi.customDepthMaterial = leafDepth;
    this.conLo = mk(conifer(false), 90000, leafMat, false);
    this.brHi = mk(broadleaf(true), 30000, leafMat);
    this.brHi.customDepthMaterial = leafDepth;
    this.brLo = mk(broadleaf(false), 90000, leafMat, false);
    const rockMat = new THREE.MeshStandardMaterial({ roughness: 0.88, metalness: 0, flatShading: false });
    for (let v = 0; v < 3; v++) this.rocks.push(mk(rockGeo(v * 17 + 3), 40000, rockMat));
    const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    grassMat.onBeforeCompile = (s) => {
      s.uniforms.uTime = this.time;
      s.vertexShader = s.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float bladeH; uniform float uTime;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vec3 ip = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
          float sway = (sin(uTime * 1.7 + ip.x * 0.15 + ip.z * 0.11) * 0.6 + sin(uTime * 3.1 + ip.x * 0.4) * 0.25) * bladeH * bladeH;
          transformed.x += sway * 0.18; transformed.z += sway * 0.08;`);
    };
    grassMat.customProgramCacheKey = () => "dwapar-grass-v1";
    this.grass = mk(grassTuft(), 60000, grassMat, false);
  }

  invalidate() { this.dirty = true; for (const l of [treeLayer, rockLayer, grassLayer]) l.cache.clear(); }

  /** Rebuild instances around `focus` (a ground point near the camera) when it moved enough. */
  update(env: ScatterEnv | null, cam: THREE.Vector3, agl: number, enabled: boolean) {
    const show = !!env && enabled;
    this.group.visible = show;
    this.treesDrawn = false;
    if (!show || !env) return;
    // beyond these heights the objects are sub-pixel; the terrain's canopy shading takes over
    const near = agl < this.q.trees * 1.4;
    this.treesDrawn = near;
    for (const m of [this.conHi, this.conLo, this.brHi, this.brLo]) m.visible = near;
    for (const r of this.rocks) r.visible = agl < this.q.rocks * 1.2;
    this.grass.visible = agl < this.q.grass * 1.3 && this.q.grass > 0;
    if (!near) return;
    const moved = Math.hypot(cam.x - this.lastCenter.x, cam.z - this.lastCenter.z);
    const movedG = Math.hypot(cam.x - this.lastGrass.x, cam.z - this.lastGrass.z);
    const treesStale = this.dirty || moved > this.q.trees * 0.12;
    const grassStale = this.dirty || movedG > Math.max(6, this.q.grass * 0.2);
    this.dirty = false;
    if (treesStale) { this.lastCenter.copy(cam); this.buildTrees(env, cam); this.buildRocks(env, cam); }
    if (grassStale) { this.lastGrass.copy(cam); this.buildGrass(env, cam); }
  }

  private collect(l: Layer, env: ScatterEnv, cam: THREE.Vector3, radius: number, fn: (d: Float32Array, i: number, dist: number) => void) {
    const cs = l.cell;
    const c0x = Math.floor((cam.x - radius) / cs), c1x = Math.floor((cam.x + radius) / cs);
    const c0z = Math.floor((cam.z - radius) / cs), c1z = Math.floor((cam.z + radius) / cs);
    const tmp: number[] = [];
    for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      const dx = Math.max(0, Math.abs((cx + 0.5) * cs - cam.x) - cs / 2), dz = Math.max(0, Math.abs((cz + 0.5) * cs - cam.z) - cs / 2);
      if (dx * dx + dz * dz > radius * radius) continue;
      const key = cx + "," + cz;
      let d = l.cache.get(key);
      if (!d) { tmp.length = 0; l.gen(env, cx, cz, tmp); d = Float32Array.from(tmp); l.cache.set(key, d); }
      for (let i = 0; i < d.length; i += STRIDE) {
        const dist = Math.hypot(d[i] - cam.x, d[i + 2] - cam.z);
        if (dist <= radius) fn(d, i, dist);
      }
    }
    if (l.cache.size > 60000) l.cache.clear();
  }

  private m = new THREE.Matrix4(); private qq = new THREE.Quaternion(); private sv = new THREE.Vector3(); private pv = new THREE.Vector3();
  private col = new THREE.Color(); private up = new THREE.Vector3(0, 1, 0);

  private put(im: THREE.InstancedMesh, n: number, d: Float32Array, i: number, sx: number, sy: number) {
    this.pv.set(d[i], d[i + 1], d[i + 2]);
    this.qq.setFromAxisAngle(this.up, d[i + 5]);
    this.sv.set(sx, sy, sx);
    this.m.compose(this.pv, this.qq, this.sv);
    im.setMatrixAt(n, this.m);
    im.setColorAt(n, this.col.setRGB(d[i + 7], d[i + 8], d[i + 9]));
  }

  private finish(im: THREE.InstancedMesh, n: number) {
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  private buildTrees(env: ScatterEnv, cam: THREE.Vector3) {
    let a = 0, b = 0, c = 0, e = 0;
    const cap = { hi: this.conHi.instanceMatrix.count, lo: this.conLo.instanceMatrix.count };
    this.collect(treeLayer, env, cam, this.q.trees, (d, i, dist) => {
      const h = d[i + 3], w = d[i + 4];
      const hi = dist < this.hiDist;
      if (d[i + 6] === 0) {
        if (hi && a < cap.hi) this.put(this.conHi, a++, d, i, h * w * 0.9, h);
        else if (!hi && b < cap.lo) this.put(this.conLo, b++, d, i, h * w * 0.9, h);
      } else {
        if (hi && c < cap.hi) this.put(this.brHi, c++, d, i, h * w, h);
        else if (!hi && e < cap.lo) this.put(this.brLo, e++, d, i, h * w, h);
      }
    });
    this.finish(this.conHi, a); this.finish(this.conLo, b); this.finish(this.brHi, c); this.finish(this.brLo, e);
    this.counts.trees = a + b + c + e;
  }

  private buildRocks(env: ScatterEnv, cam: THREE.Vector3) {
    const n = [0, 0, 0];
    this.collect(rockLayer, env, cam, this.q.rocks, (d, i) => {
      const v = d[i + 6] | 0;
      if (n[v] < 40000) this.put(this.rocks[v], n[v]++, d, i, d[i + 3] * d[i + 4], d[i + 3]);
    });
    this.rocks.forEach((r, v) => this.finish(r, n[v]));
    this.counts.rocks = n[0] + n[1] + n[2];
  }

  private buildGrass(env: ScatterEnv, cam: THREE.Vector3) {
    let n = 0;
    if (this.q.grass > 0) this.collect(grassLayer, env, cam, this.q.grass, (d, i) => {
      if (n < 60000) this.put(this.grass, n++, d, i, d[i + 3] * d[i + 4], d[i + 3]);
    });
    this.finish(this.grass, n);
    this.counts.grass = n;
  }

  dispose() {
    this.group.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material)?.dispose?.(); });
  }
}
