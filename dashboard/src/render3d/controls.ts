// Free-flight camera for exploring the world from orbit down to standing on the ground.
//
//   left-drag   orbit around the point under the cursor (high up) / look around (near the ground)
//   right-drag  pan (grab the ground)            wheel  fly toward / away from the cursor
//   W A S D     fly / walk                       R F    up / down     Q E  turn     Shift  faster
//
// Speed scales with height above ground, so one gesture works at every scale. The camera can never
// go below the rendered surface (eye height 1.7 m when walking).

import * as THREE from "three";

export const EYE_HEIGHT = 1.7;

export interface FlightHost {
  /** rendered ground height in scene units (y) at world x, z */
  groundY(x: number, z: number): number;
  /** ground point under a normalised device coordinate, or null */
  pickNdc(ndc: THREE.Vector2): THREE.Vector3 | null;
}

interface Anim { start: number; dur: number; p0: THREE.Vector3; p1: THREE.Vector3; q0: THREE.Quaternion; q1: THREE.Quaternion }

export class FlightControls {
  yaw = 0;
  pitch = -0.6;
  agl = 1000;
  private keys = new Set<string>();
  private vel = new THREE.Vector3();
  private drag: { mode: "orbit" | "look" | "pan"; x: number; y: number; pivot: THREE.Vector3 | null; panPlaneY: number } | null = null;
  private dolly = new THREE.Vector3();
  private anim: Anim | null = null;
  enabled = true;

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement, private host: FlightHost) {
    camera.rotation.order = "YXZ";
    dom.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
    dom.addEventListener("contextmenu", this.onCtx);
    dom.addEventListener("keydown", this.onKey);
    dom.addEventListener("keyup", this.onKey);
    dom.addEventListener("blur", this.onBlur);
  }

  dispose() {
    this.dom.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.dom.removeEventListener("wheel", this.onWheel);
    this.dom.removeEventListener("contextmenu", this.onCtx);
    this.dom.removeEventListener("keydown", this.onKey);
    this.dom.removeEventListener("keyup", this.onKey);
    this.dom.removeEventListener("blur", this.onBlur);
  }

  /** Place the camera immediately. */
  set(pos: THREE.Vector3, yaw: number, pitch: number) {
    this.anim = null;
    this.camera.position.copy(pos);
    this.yaw = yaw; this.pitch = pitch;
    this.vel.set(0, 0, 0); this.dolly.set(0, 0, 0);
    this.agl = pos.y - this.host.groundY(pos.x, pos.z); // a teleport is not a walk: no ground snapping
    this.apply();
  }

  /** Smoothly fly to a position and orientation. */
  flyTo(pos: THREE.Vector3, yaw: number, pitch: number, dur = 1.6) {
    const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
    this.anim = { start: performance.now(), dur, p0: this.camera.position.clone(), p1: pos.clone(), q0: this.camera.quaternion.clone(), q1 };
    this.vel.set(0, 0, 0); this.dolly.set(0, 0, 0);
  }

  lookAt(target: THREE.Vector3): { yaw: number; pitch: number } {
    const d = target.clone().sub(this.camera.position);
    return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
  }

  private ndc(e: { clientX: number; clientY: number }) {
    const r = this.dom.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private onCtx = (e: Event) => e.preventDefault();
  private onBlur = () => this.keys.clear();
  private onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (e.type === "keydown") this.keys.add(k); else this.keys.delete(k);
    if (e.key === "Shift") { if (e.type === "keydown") this.keys.add("shift"); else this.keys.delete("shift"); }
  };

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.dom.focus({ preventScroll: true });
    this.anim = null;
    const pivot = this.host.pickNdc(this.ndc(e));
    const mode = e.button === 2 || (e.button === 0 && e.shiftKey) ? "pan" : this.agl < 60 || !pivot ? "look" : "orbit";
    this.drag = { mode, x: e.clientX, y: e.clientY, pivot, panPlaneY: pivot ? pivot.y : this.camera.position.y - this.agl };
  };

  private onUp = () => { this.drag = null; };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY;
    const cam = this.camera;
    if (d.mode === "look") {
      this.yaw -= dx * 0.0032; this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0032, -1.55, 1.4);
    } else if (d.mode === "orbit" && d.pivot) {
      const dYaw = -dx * 0.004;
      let dPitch = -dy * 0.004;
      const np = THREE.MathUtils.clamp(this.pitch + dPitch, -1.55, 0.25);
      dPitch = np - this.pitch;
      const off = cam.position.clone().sub(d.pivot);
      off.applyAxisAngle(new THREE.Vector3(0, 1, 0), dYaw);
      const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw + dYaw);
      off.applyAxisAngle(right, dPitch);
      const p = d.pivot.clone().add(off);
      if (p.y > this.host.groundY(p.x, p.z) + EYE_HEIGHT) {
        cam.position.copy(p);
        this.yaw += dYaw; this.pitch = np;
      }
    } else if (d.mode === "pan") {
      // move so the grabbed ground stays under the cursor (approximately, on a horizontal plane)
      const ray = new THREE.Raycaster();
      const r = this.dom.getBoundingClientRect();
      const a = this.ndc({ clientX: e.clientX - dx, clientY: e.clientY - dy }), b = this.ndc(e);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -d.panPlaneY);
      const pa = new THREE.Vector3(), pb = new THREE.Vector3();
      ray.setFromCamera(a, cam); const ha = ray.ray.intersectPlane(plane, pa);
      ray.setFromCamera(b, cam); const hb = ray.ray.intersectPlane(plane, pb);
      if (ha && hb && pa.distanceTo(cam.position) < 4e6) {
        const mv = pa.sub(pb); mv.y = 0;
        const lim = Math.max(50, this.agl) * 0.25; // never jump far on near-horizon drags
        if (mv.length() > lim) mv.setLength(lim);
        cam.position.add(mv);
      } else {
        const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        const rt = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        const s = Math.max(20, this.agl) * 2 / r.height;
        cam.position.addScaledVector(rt, -dx * s).addScaledVector(fwd, dy * s);
      }
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    this.anim = null;
    const steps = THREE.MathUtils.clamp(e.deltaY / (e.deltaMode === 1 ? 3 : 100), -3, 3);
    const hit = this.host.pickNdc(this.ndc(e));
    const cam = this.camera.position;
    let dir: THREE.Vector3, dist: number;
    if (hit) { dir = hit.clone().sub(cam); dist = dir.length(); dir.normalize(); }
    else { dir = new THREE.Vector3(); this.camera.getWorldDirection(dir); dist = Math.max(this.agl, 10) * 2; }
    const f = steps < 0 ? 1 - Math.pow(0.8, -steps) : -(Math.pow(1.25, steps) - 1);
    const move = dist * f;
    // never fly into the ground: keep at least eye height + a little margin in front of the hit
    const maxIn = Math.max(0, dist - EYE_HEIGHT * 2);
    this.dolly.addScaledVector(dir, Math.min(move, maxIn));
  };

  update(dt: number) {
    const cam = this.camera;
    const flying = !!this.anim; // a flight in progress at the start of this frame (it may finish within it)
    if (this.anim) {
      const a = this.anim;
      // wall-clock time, so a flight takes the same time on a slow machine (just with fewer frames)
      const u = Math.min(1, (performance.now() - a.start) / 1000 / a.dur), s = u * u * (3 - 2 * u);
      cam.position.lerpVectors(a.p0, a.p1, s);
      // altitude follows a smooth arc on a log scale, so long flights rise and fall naturally
      const y0 = Math.log(Math.max(1, a.p0.y + 6000)), y1 = Math.log(Math.max(1, a.p1.y + 6000));
      const hop = Math.log(1 + a.p0.distanceTo(a.p1) / 4000) * 0.35 * Math.sin(Math.PI * s);
      cam.position.y = Math.exp(y0 + (y1 - y0) * s + hop) - 6000;
      cam.quaternion.slerpQuaternions(a.q0, a.q1, s);
      if (u >= 1) {
        const e = new THREE.Euler().setFromQuaternion(a.q1, "YXZ");
        this.yaw = e.y; this.pitch = e.x;
        this.anim = null;
      }
    } else {
      // keyboard flight
      const k = this.keys;
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const want = new THREE.Vector3();
      if (k.has("w") || k.has("arrowup")) want.add(fwd);
      if (k.has("s") || k.has("arrowdown")) want.sub(fwd);
      if (k.has("d") || k.has("arrowright")) want.add(right);
      if (k.has("a") || k.has("arrowleft")) want.sub(right);
      if (k.has("r") || k.has("pageup")) want.y += 1;
      if (k.has("f") || k.has("pagedown")) want.y -= 1;
      if (k.has("q")) this.yaw += dt * 1.1;
      if (k.has("e")) this.yaw -= dt * 1.1;
      const speed = Math.max(4, this.agl * 1.1) * (k.has("shift") ? 5 : 1);
      want.multiplyScalar(speed);
      this.vel.lerp(want, 1 - Math.exp(-dt * 7));
      cam.position.addScaledVector(this.vel, dt);
      // wheel dolly, eased
      const take = 1 - Math.exp(-dt * 9);
      cam.position.addScaledVector(this.dolly, take);
      this.dolly.multiplyScalar(1 - take);
      if (this.dolly.lengthSq() < 1e-4) this.dolly.set(0, 0, 0);
      this.apply();
    }
    // collision with the rendered ground, and a ceiling. When walking (on the ground and not
    // climbing with R), follow the terrain up and down hills.
    const g = this.host.groundY(cam.position.x, cam.position.z);
    const walking = !flying && this.agl < EYE_HEIGHT + 1.2 && !this.keys.has("r") && !this.keys.has("pageup") && this.dolly.y >= -1e-3 && this.dolly.y <= 1e-3;
    if (walking || cam.position.y < g + EYE_HEIGHT) cam.position.y = g + EYE_HEIGHT;
    if (cam.position.y > 3e6) cam.position.y = 3e6;
    this.agl = cam.position.y - g;
  }

  private apply() {
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }
}
