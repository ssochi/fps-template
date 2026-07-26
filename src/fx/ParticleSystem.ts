import * as THREE from 'three';

/**
 * GPU-drawn, CPU-simulated point particles.
 *
 * A single draw call covers every particle in the system. Emitters grab a slot
 * from a free list, so there are no per-frame allocations once the pool is warm.
 */

export interface ParticleSpawnOptions {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  color: THREE.Color;
  size: number;
  /** Size multiplier reached at the end of the particle's life. */
  endScale?: number;
  life: number;
  /** Metres per second squared applied on Y. Negative falls. */
  gravity?: number;
  /** Velocity retained per second, 0..1. */
  drag?: number;
  /** Alpha at spawn. */
  alpha?: number;
  /** Rotation of the sprite in radians. */
  rotation?: number;
  /** Radians per second the sprite spins. */
  spin?: number;
  /** Colour blended into over the particle's life. */
  endColor?: THREE.Color;
  /** Bounce off the y = groundY plane instead of passing through. */
  collideGround?: boolean;
  groundY?: number;
  restitution?: number;
}

const VERTEX_SHADER = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  attribute float aRotation;

  varying float vAlpha;
  varying vec3 vColor;
  varying float vRotation;

  uniform float uPixelRatio;

  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vRotation = aRotation;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio * (300.0 / max(0.001, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;

  varying float vAlpha;
  varying vec3 vColor;
  varying float vRotation;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float s = sin(vRotation);
    float c = cos(vRotation);
    uv = vec2(uv.x * c - uv.y * s, uv.x * s + uv.y * c) + 0.5;
    vec4 tex = texture2D(uMap, uv);
    if (tex.a * vAlpha < 0.004) discard;
    gl_FragColor = vec4(vColor * tex.rgb, tex.a * vAlpha);
  }
`;

export class ParticleSystem {
  readonly points: THREE.Points;
  readonly capacity: number;

  private readonly positions: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly colors: Float32Array;
  private readonly rotations: Float32Array;

  private readonly velocity: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly startSize: Float32Array;
  private readonly endScale: Float32Array;
  private readonly startAlpha: Float32Array;
  private readonly spin: Float32Array;
  private readonly startColor: Float32Array;
  private readonly endColor: Float32Array;
  private readonly flags: Uint8Array;
  private readonly groundY: Float32Array;
  private readonly restitution: Float32Array;

  private readonly free: number[] = [];
  private readonly material: THREE.ShaderMaterial;
  private activeCount = 0;

  private static readonly FLAG_ACTIVE = 1;
  private static readonly FLAG_GROUND = 2;

  constructor(capacity: number, map: THREE.Texture, blending: THREE.Blending = THREE.AdditiveBlending) {
    this.capacity = capacity;

    this.positions = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.colors = new Float32Array(capacity * 3);
    this.rotations = new Float32Array(capacity);

    this.velocity = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.startSize = new Float32Array(capacity);
    this.endScale = new Float32Array(capacity);
    this.startAlpha = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.startColor = new Float32Array(capacity * 3);
    this.endColor = new Float32Array(capacity * 3);
    this.flags = new Uint8Array(capacity);
    this.groundY = new Float32Array(capacity);
    this.restitution = new Float32Array(capacity);

    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('aRotation', new THREE.BufferAttribute(this.rotations, 1));
    geo.setDrawRange(0, capacity);
    // Particles are scattered all over the level; skip frustum culling rather
    // than recomputing a bounding sphere every frame.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = blending === THREE.AdditiveBlending ? 10 : 9;
  }

  get active(): number {
    return this.activeCount;
  }

  setPixelRatio(ratio: number): void {
    this.material.uniforms.uPixelRatio.value = ratio;
  }

  spawn(opts: ParticleSpawnOptions): void {
    const i = this.free.pop();
    if (i === undefined) return;

    const i3 = i * 3;
    this.positions[i3] = opts.position.x;
    this.positions[i3 + 1] = opts.position.y;
    this.positions[i3 + 2] = opts.position.z;
    this.velocity[i3] = opts.velocity.x;
    this.velocity[i3 + 1] = opts.velocity.y;
    this.velocity[i3 + 2] = opts.velocity.z;

    this.startColor[i3] = opts.color.r;
    this.startColor[i3 + 1] = opts.color.g;
    this.startColor[i3 + 2] = opts.color.b;
    const end = opts.endColor ?? opts.color;
    this.endColor[i3] = end.r;
    this.endColor[i3 + 1] = end.g;
    this.endColor[i3 + 2] = end.b;

    this.colors[i3] = opts.color.r;
    this.colors[i3 + 1] = opts.color.g;
    this.colors[i3 + 2] = opts.color.b;

    this.life[i] = opts.life;
    this.maxLife[i] = opts.life;
    this.gravity[i] = opts.gravity ?? 0;
    this.drag[i] = opts.drag ?? 1;
    this.startSize[i] = opts.size;
    this.endScale[i] = opts.endScale ?? 1;
    this.startAlpha[i] = opts.alpha ?? 1;
    this.spin[i] = opts.spin ?? 0;
    this.rotations[i] = opts.rotation ?? Math.random() * Math.PI * 2;
    this.sizes[i] = opts.size;
    this.alphas[i] = opts.alpha ?? 1;
    this.groundY[i] = opts.groundY ?? 0;
    this.restitution[i] = opts.restitution ?? 0.3;

    this.flags[i] =
      ParticleSystem.FLAG_ACTIVE | (opts.collideGround ? ParticleSystem.FLAG_GROUND : 0);
    this.activeCount++;
  }

  update(dt: number): void {
    if (this.activeCount === 0) return;

    for (let i = 0; i < this.capacity; i++) {
      if ((this.flags[i] & ParticleSystem.FLAG_ACTIVE) === 0) continue;

      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.flags[i] = 0;
        this.alphas[i] = 0;
        this.sizes[i] = 0;
        this.free.push(i);
        this.activeCount--;
        continue;
      }

      const i3 = i * 3;
      const damping = Math.pow(this.drag[i], dt);
      this.velocity[i3] *= damping;
      this.velocity[i3 + 1] = this.velocity[i3 + 1] * damping + this.gravity[i] * dt;
      this.velocity[i3 + 2] *= damping;

      this.positions[i3] += this.velocity[i3] * dt;
      this.positions[i3 + 1] += this.velocity[i3 + 1] * dt;
      this.positions[i3 + 2] += this.velocity[i3 + 2] * dt;

      if ((this.flags[i] & ParticleSystem.FLAG_GROUND) !== 0) {
        const gy = this.groundY[i];
        if (this.positions[i3 + 1] < gy) {
          this.positions[i3 + 1] = gy;
          this.velocity[i3 + 1] = Math.abs(this.velocity[i3 + 1]) * this.restitution[i];
          this.velocity[i3] *= 0.6;
          this.velocity[i3 + 2] *= 0.6;
        }
      }

      const t = 1 - this.life[i] / this.maxLife[i];
      this.sizes[i] = this.startSize[i] * (1 + (this.endScale[i] - 1) * t);
      // Ease-out fade reads better than a linear ramp.
      this.alphas[i] = this.startAlpha[i] * (1 - t) * (1 - t * 0.35);
      this.rotations[i] += this.spin[i] * dt;

      this.colors[i3] = this.startColor[i3] + (this.endColor[i3] - this.startColor[i3]) * t;
      this.colors[i3 + 1] =
        this.startColor[i3 + 1] + (this.endColor[i3 + 1] - this.startColor[i3 + 1]) * t;
      this.colors[i3 + 2] =
        this.startColor[i3 + 2] + (this.endColor[i3 + 2] - this.startColor[i3 + 2]) * t;
    }

    const geo = this.points.geometry;
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('aRotation') as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) {
      if ((this.flags[i] & ParticleSystem.FLAG_ACTIVE) !== 0) {
        this.flags[i] = 0;
        this.free.push(i);
      }
      this.alphas[i] = 0;
      this.sizes[i] = 0;
    }
    this.activeCount = 0;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
