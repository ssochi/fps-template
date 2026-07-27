import * as THREE from 'three';

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Ease that starts fast and settles — good for a foot landing. */
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

/**
 * Frame-rate independent approach.
 *
 * `a += (b - a) * rate * dt` is the version everyone writes and it changes
 * behaviour with frame rate — at 30 fps it overshoots, and above rate*dt = 1 it
 * oscillates. The exponential form is the same curve sampled correctly.
 */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  target + (current - target) * Math.exp(-rate * dt);

export function dampVec(
  current: THREE.Vector3,
  target: THREE.Vector3,
  rate: number,
  dt: number,
): void {
  const k = Math.exp(-rate * dt);
  current.x = target.x + (current.x - target.x) * k;
  current.y = target.y + (current.y - target.y) * k;
  current.z = target.z + (current.z - target.z) * k;
}

/** Shortest signed difference between two angles, in (-pi, pi]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-rate * dt));
}

/**
 * A critically damped spring, for anything that should overshoot and settle
 * rather than merely approach: ear flop, belly wobble, antenna sway.
 *
 * Critically damped is the useful default — it is the fastest response with no
 * oscillation — and `bounce` below 1 under-damps it deliberately when you do
 * want the wobble.
 */
export class Spring {
  value = 0;
  velocity = 0;

  constructor(
    public stiffness = 90,
    public bounce = 1,
  ) {}

  step(target: number, dt: number): number {
    // Sub-step so a stiff spring stays stable through a long frame.
    const steps = Math.min(6, Math.max(1, Math.ceil(dt * 120)));
    const h = dt / steps;
    const damping = 2 * Math.sqrt(this.stiffness) * this.bounce;
    for (let i = 0; i < steps; i++) {
      const accel = (target - this.value) * this.stiffness - this.velocity * damping;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  reset(value = 0): void {
    this.value = value;
    this.velocity = 0;
  }
}

/** The same spring in three dimensions, for trailing a point. */
export class SpringVec {
  readonly value = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  private readonly accel = new THREE.Vector3();

  constructor(
    public stiffness = 90,
    public bounce = 1,
  ) {}

  step(target: THREE.Vector3, dt: number): THREE.Vector3 {
    const steps = Math.min(6, Math.max(1, Math.ceil(dt * 120)));
    const h = dt / steps;
    const damping = 2 * Math.sqrt(this.stiffness) * this.bounce;
    for (let i = 0; i < steps; i++) {
      this.accel.copy(target).sub(this.value).multiplyScalar(this.stiffness);
      this.accel.addScaledVector(this.velocity, -damping);
      this.velocity.addScaledVector(this.accel, h);
      this.value.addScaledVector(this.velocity, h);
    }
    return this.value;
  }

  reset(at: THREE.Vector3): void {
    this.value.copy(at);
    this.velocity.set(0, 0, 0);
  }
}

/** Value noise in one dimension — smooth wander without a texture. */
export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number): number => {
    let t = Math.imul(n ^ seed, 0x27d4eb2d);
    t = (t ^ (t >>> 15)) >>> 0;
    return t / 4294967296;
  };
  return lerp(h(i), h(i + 1), smoothstep(f)) * 2 - 1;
}
