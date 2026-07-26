import * as THREE from 'three';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp(invLerp(edge0, edge1, x), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is the decay rate: higher == snappier.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function dampVec3(
  current: THREE.Vector3,
  target: THREE.Vector3,
  lambda: number,
  dt: number,
): THREE.Vector3 {
  const t = 1 - Math.exp(-lambda * dt);
  current.x = lerp(current.x, target.x, t);
  current.y = lerp(current.y, target.y, t);
  current.z = lerp(current.z, target.z, t);
  return current;
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function randInt(min: number, max: number): number {
  return Math.floor(randRange(min, max + 1));
}

/** Box-Muller gaussian, mean 0 / stddev 1. */
export function randGaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Shortest signed angular difference between two angles (radians). */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

/**
 * Critically-damped-ish spring, useful for recoil / weapon sway.
 * Integrates with a semi-implicit Euler step and is stable at 60-240 Hz.
 */
export class Spring {
  value = 0;
  velocity = 0;
  target = 0;
  stiffness: number;
  damping: number;

  constructor(stiffness = 120, damping = 18) {
    this.stiffness = stiffness;
    this.damping = damping;
  }

  update(dt: number): number {
    // Sub-step for stability at low frame rates.
    const steps = Math.min(4, Math.max(1, Math.ceil(dt / (1 / 120))));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const accel = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  kick(amount: number): void {
    this.velocity += amount;
  }

  reset(value = 0): void {
    this.value = value;
    this.velocity = 0;
    this.target = value;
  }
}

/** Three independent springs bundled as a vector. */
export class Spring3 {
  readonly x: Spring;
  readonly y: Spring;
  readonly z: Spring;
  readonly value = new THREE.Vector3();

  constructor(stiffness = 120, damping = 18) {
    this.x = new Spring(stiffness, damping);
    this.y = new Spring(stiffness, damping);
    this.z = new Spring(stiffness, damping);
  }

  set stiffness(v: number) {
    this.x.stiffness = v;
    this.y.stiffness = v;
    this.z.stiffness = v;
  }

  set damping(v: number) {
    this.x.damping = v;
    this.y.damping = v;
    this.z.damping = v;
  }

  update(dt: number): THREE.Vector3 {
    this.value.set(this.x.update(dt), this.y.update(dt), this.z.update(dt));
    return this.value;
  }

  kick(x: number, y: number, z: number): void {
    this.x.kick(x);
    this.y.kick(y);
    this.z.kick(z);
  }

  setTarget(x: number, y: number, z: number): void {
    this.x.target = x;
    this.y.target = y;
    this.z.target = z;
  }

  reset(): void {
    this.x.reset();
    this.y.reset();
    this.z.reset();
    this.value.set(0, 0, 0);
  }
}

/** Deterministic-ish noise used for weapon sway; cheap sum of sines. */
export function noise1D(t: number, seed = 0): number {
  return (
    Math.sin(t * 1.13 + seed * 7.3) * 0.5 +
    Math.sin(t * 2.31 + seed * 3.1) * 0.3 +
    Math.sin(t * 4.77 + seed * 11.7) * 0.2
  );
}
