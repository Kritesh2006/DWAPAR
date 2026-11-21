// Creatures, shelters and WITNESS's presence in the 3D world.
//
// Positions, species, actions and shelters come from the engine (/api/life) — these ARE simulated
// objects, unlike the rendering-only trees and rocks. Bodies are simple real-scale shapes (a human
// is 1.7 m tall, a deer 1.6 m long); motion between engine updates is interpolated for display only.
// From high above, coloured markers show where life is (a display aid, labelled in the UI).
// WITNESS has no body in the simulation: its "presence" is drawn where it last looked or acted.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { LifeData } from "../api";

const COLORS: Record<string, number> = {
  human: 0xd9b48c, deer: 0x8a5a33, rabbit: 0x9a8a78, bison: 0x3e2a1c, wolf: 0x77736c, tiger: 0xd9782a, insect: 0x2a2a20,
};
export const MARKER_COLORS: Record<string, string> = {
  human: "#f4d58d", deer: "#c98b4a", rabbit: "#d8cbb8", bison: "#9b6b44", wolf: "#b8b8c0", tiger: "#ff8a2a", insect: "#8aa05a",
};

function paint(g: THREE.BufferGeometry, c: number) {
  const geo = g.index ? g.toNonIndexed() : g;
  const col = new THREE.Color(c);
  const n = geo.attributes.position.count, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute("uv");
  return geo;
}

/** A four-legged body facing +x: length L, shoulder height H (metres). */
function quadruped(L: number, H: number, color: number, opts: { tail?: number; neck?: number } = {}) {
  const parts: THREE.BufferGeometry[] = [];
  const legH = H * 0.55, bodyR = H * 0.24;
  const torso = new THREE.SphereGeometry(1, 10, 7); torso.scale(L * 0.42, bodyR, bodyR * 0.85); torso.translate(0, legH + bodyR * 0.6, 0);
  parts.push(paint(torso, color));
  const head = new THREE.SphereGeometry(1, 8, 6); head.scale(H * 0.16, H * 0.13, H * 0.12);
  head.translate(L * 0.5, legH + bodyR + H * (opts.neck ?? 0.15), 0);
  parts.push(paint(head, color));
  const neck = new THREE.CylinderGeometry(H * 0.07, H * 0.1, H * 0.3, 6); neck.rotateZ(-0.7); neck.translate(L * 0.4, legH + bodyR * 1.1 + H * 0.05, 0);
  parts.push(paint(neck, color));
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const leg = new THREE.CylinderGeometry(H * 0.045, H * 0.035, legH + bodyR * 0.4, 5);
    leg.translate(sx * L * 0.3, (legH + bodyR * 0.4) / 2, sz * bodyR * 0.55);
    parts.push(paint(leg, new THREE.Color(color).multiplyScalar(0.7).getHex()));
  }
  if (opts.tail) {
    const tail = new THREE.CylinderGeometry(H * 0.02, H * 0.035, opts.tail, 4); tail.rotateZ(1.1); tail.translate(-L * 0.5 - opts.tail * 0.3, legH + bodyR, 0);
    parts.push(paint(tail, color));
  }
  return mergeGeometries(parts)!;
}

function humanBody() {
  const parts: THREE.BufferGeometry[] = [];
  const skin = 0xc69c76, cloth = 0x6b5a42, dark = 0x3b3226;
  for (const s of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.07, 0.06, 0.85, 6); leg.translate(0, 0.43, s * 0.1); parts.push(paint(leg, dark));
    const arm = new THREE.CylinderGeometry(0.05, 0.045, 0.62, 6); arm.translate(0, 1.12, s * 0.24); parts.push(paint(arm, skin));
  }
  const torso = new THREE.CylinderGeometry(0.17, 0.15, 0.62, 8); torso.translate(0, 1.14, 0); parts.push(paint(torso, cloth));
  const head = new THREE.SphereGeometry(0.12, 10, 8); head.translate(0, 1.58, 0); parts.push(paint(head, skin));
  const hair = new THREE.SphereGeometry(0.125, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2); hair.translate(0, 1.6, 0); parts.push(paint(hair, 0x2a1d14));
  return mergeGeometries(parts)!;
}

function swarm() {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 24; i++) {
    const t = new THREE.TetrahedronGeometry(0.03);
    const a = i * 2.39996, r = 0.3 + (i % 5) * 0.18;
    t.translate(Math.cos(a) * r, 0.6 + ((i * 7) % 11) * 0.09, Math.sin(a) * r);
    parts.push(paint(t, COLORS.insect));
  }
  return mergeGeometries(parts)!;
}

function hut(done: boolean) {
  const parts: THREE.BufferGeometry[] = [];
  if (done) {
    const wall = new THREE.CylinderGeometry(2.4, 2.6, 1.6, 12, 1, true); wall.translate(0, 0.8, 0); parts.push(paint(wall, 0x6f5a3c));
    const roof = new THREE.ConeGeometry(3.2, 2.2, 12); roof.translate(0, 2.7, 0); parts.push(paint(roof, 0x8f7a4a));
  } else {
    for (let i = 0; i < 8; i++) {
      const pole = new THREE.CylinderGeometry(0.06, 0.08, 3.2, 4);
      pole.rotateZ(0.5); pole.translate(-1.2, 1.4, 0); pole.rotateY((i / 8) * Math.PI * 2);
      parts.push(paint(pole, 0x5a4630));
    }
  }
  return mergeGeometries(parts)!;
}

const BODIES: Record<string, () => THREE.BufferGeometry> = {
  human: humanBody,
  deer: () => quadruped(1.6, 1.0, COLORS.deer, { tail: 0.15, neck: 0.3 }),
  rabbit: () => quadruped(0.4, 0.22, COLORS.rabbit, { neck: 0.1 }),
  bison: () => quadruped(2.8, 1.7, COLORS.bison, { tail: 0.4, neck: 0.05 }),
  wolf: () => quadruped(1.2, 0.8, COLORS.wolf, { tail: 0.45, neck: 0.15 }),
  tiger: () => quadruped(2.2, 1.0, COLORS.tiger, { tail: 0.9, neck: 0.08 }),
  insect: swarm,
};

interface Track { x0: number; z0: number; x1: number; z1: number; yaw: number }

export class Creatures {
  readonly group = new THREE.Group();
  private meshes = new Map<string, THREE.InstancedMesh>();
  private huts: THREE.InstancedMesh[] = [];
  private markers: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private tracks = new Map<number, Track>();
  private data: LifeData | null = null;
  private updatedAt = 0;
  private interval = 2000;
  readonly presence = new THREE.Group();
  private presenceTarget: THREE.Vector3 | null = null;
  bodiesWithin = 6000; // metres from the camera
  counts = { bodies: 0, markers: 0 };

  constructor() {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    for (const [k, mk] of Object.entries(BODIES)) {
      const m = new THREE.InstancedMesh(mk(), mat, 64);
      m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true;
      this.meshes.set(k, m); this.group.add(m);
    }
    for (const done of [true, false]) {
      const m = new THREE.InstancedMesh(hut(done), mat, 64);
      m.count = 0; m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true;
      this.huts.push(m); this.group.add(m);
    }
    const dot = document.createElement("canvas");
    dot.width = dot.height = 32;
    const g = dot.getContext("2d")!;
    g.beginPath(); g.arc(16, 16, 12, 0, Math.PI * 2); g.fillStyle = "#ffffff"; g.fill();
    g.lineWidth = 4; g.strokeStyle = "rgba(0,0,0,0.85)"; g.stroke();
    this.markers = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      size: 9, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, map: new THREE.CanvasTexture(dot), alphaTest: 0.1,
    }));
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 6;
    this.group.add(this.markers);

    // WITNESS's presence: a slowly turning luminous form with a column of light beneath it
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.95 }));
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 1), new THREE.MeshBasicMaterial({ color: 0xe0b24f, wireframe: true, transparent: true, opacity: 0.5 }));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.06, 6, 64), new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.8 }));
    ring.rotation.x = Math.PI / 2;
    const beamG = new THREE.CylinderGeometry(0.15, 0.6, 1, 12, 1, true); beamG.translate(0, -0.5, 0);
    const beam = new THREE.Mesh(beamG, new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    beam.name = "beam";
    this.presence.add(core, shell, ring, beam);
    this.presence.visible = false;
    this.presence.renderOrder = 7;
  }

  setLife(d: LifeData | null) {
    const now = performance.now();
    if (this.data && d?.agents) {
      // start interpolating from wherever each creature is drawn now
      const t = Math.min(1, (now - this.updatedAt) / this.interval);
      for (const tr of this.tracks.values()) { tr.x0 += (tr.x1 - tr.x0) * t; tr.z0 += (tr.z1 - tr.z0) * t; }
      this.interval = Math.max(500, Math.min(5000, now - this.updatedAt));
    }
    this.data = d;
    this.updatedAt = now;
    if (!d?.agents) { this.tracks.clear(); return; }
    const seen = new Set<number>();
    for (const row of [...d.agents.animals, ...d.agents.humans]) {
      const [id, , x, y] = row;
      seen.add(id);
      const tr = this.tracks.get(id);
      if (!tr) this.tracks.set(id, { x0: x, z0: y, x1: x, z1: y, yaw: (id * 2.39996) % (Math.PI * 2) });
      else {
        if (Math.hypot(x - tr.x1, y - tr.z1) > 0.5) tr.yaw = Math.atan2(-(y - tr.z1), x - tr.x1);
        tr.x1 = x; tr.z1 = y;
        if (Math.hypot(tr.x1 - tr.x0, tr.z1 - tr.z0) > 20000) { tr.x0 = x; tr.z0 = y; } // teleport, not a walk
      }
    }
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.tracks.delete(id);
  }

  setPresence(p: THREE.Vector3 | null) { this.presenceTarget = p; }

  private ensure(m: THREE.InstancedMesh, n: number, key: string, isHut = false): THREE.InstancedMesh {
    if (n <= m.instanceMatrix.count) return m;
    const cap = Math.ceil(n * 1.5);
    const fresh = new THREE.InstancedMesh(m.geometry, m.material, cap);
    fresh.count = 0; fresh.frustumCulled = false; fresh.castShadow = true; fresh.receiveShadow = true;
    this.group.remove(m); this.group.add(fresh);
    if (isHut) this.huts[this.huts.indexOf(m)] = fresh; else this.meshes.set(key, fresh);
    return fresh;
  }

  /** origin: scene offset of the map's top-left corner; groundY(x, z) in scene coordinates. */
  update(camera: THREE.Camera, origin: { x: number; z: number }, groundY: (x: number, z: number) => number, agl: number, time: number) {
    const d = this.data;
    this.group.visible = !!d?.present;
    const cam = camera.position;
    const t = Math.min(1, (performance.now() - this.updatedAt) / this.interval);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let bodies = 0;
    if (d?.agents) {
      const counts = new Map<string, number>();
      const rows: [number, string][] = [...d.agents.animals.map((a) => [a[0], a[1]] as [number, string]), ...d.agents.humans.map((h) => [h[0], "human"] as [number, string])];
      const per = new Map<string, number>();
      for (const [, k] of rows) per.set(k, (per.get(k) ?? 0) + 1);
      for (const [k, n] of per) this.ensure(this.meshes.get(k)!, n, k);
      const mpos: number[] = [], mcol: number[] = [];
      const c = new THREE.Color();
      for (const [id, k] of rows) {
        const tr = this.tracks.get(id);
        if (!tr) continue;
        const x = origin.x + tr.x0 + (tr.x1 - tr.x0) * t, z = origin.z + tr.z0 + (tr.z1 - tr.z0) * t;
        const y = groundY(x, z);
        if (Math.hypot(x - cam.x, z - cam.z) < this.bodiesWithin && agl < 3000) {
          const mesh = this.meshes.get(k)!;
          const i = counts.get(k) ?? 0;
          counts.set(k, i + 1);
          q.setFromAxisAngle(up, tr.yaw);
          p.set(x, y, z);
          mesh.setMatrixAt(i, m4.compose(p, q, s));
          bodies++;
        }
        if (agl > 400) {
          mpos.push(x, y + Math.max(20, agl * 0.004), z);
          c.set(MARKER_COLORS[k] ?? "#ffffff");
          mcol.push(c.r, c.g, c.b);
        }
      }
      for (const [k, mesh] of this.meshes) { mesh.count = counts.get(k) ?? 0; mesh.instanceMatrix.needsUpdate = true; }
      this.markers.geometry.setAttribute("position", new THREE.Float32BufferAttribute(mpos, 3));
      this.markers.geometry.setAttribute("color", new THREE.Float32BufferAttribute(mcol, 3));
      this.markers.material.opacity = Math.min(1, (agl - 400) / 1500);
      this.markers.visible = mpos.length > 0;
      this.counts.markers = mpos.length / 3;
      // shelters
      const done = d.agents.structures.filter((st) => st[5]), wip = d.agents.structures.filter((st) => !st[5]);
      [done, wip].forEach((list, j) => {
        const mesh = this.ensure(this.huts[j], list.length, "", true);
        let n = 0;
        for (const st of list) {
          const x = origin.x + st[2], z = origin.z + st[3];
          if (Math.hypot(x - cam.x, z - cam.z) > this.bodiesWithin * 1.5) continue;
          q.setFromAxisAngle(up, (st[0] * 1.7) % 6.28);
          const sc = 0.8 + 0.4 * st[4];
          mesh.setMatrixAt(n++, m4.compose(p.set(x, groundY(x, z) - 0.1, z), q, new THREE.Vector3(sc, sc, sc)));
        }
        mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
      });
    }
    this.counts.bodies = bodies;

    // WITNESS's presence: hovers above where it last looked; stays visible at any distance
    const pt = this.presenceTarget;
    this.presence.visible = !!pt;
    if (pt) {
      const ground = groundY(pt.x, pt.z);
      const dist = cam.distanceTo(new THREE.Vector3(pt.x, ground, pt.z));
      const sc = THREE.MathUtils.clamp(dist * 0.012, 6, 4000);
      const hover = sc * 6 + 40;
      this.presence.position.set(pt.x, ground + hover + Math.sin(time * 0.8) * sc * 0.3, pt.z);
      this.presence.scale.setScalar(sc);
      this.presence.rotation.y = time * 0.35;
      const beam = this.presence.getObjectByName("beam")!;
      beam.scale.set(1, hover / sc, 1);
    }
  }
}
