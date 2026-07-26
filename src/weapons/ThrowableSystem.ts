import * as THREE from 'three';
import {
  THROWABLE_CONFIGS,
  THROWABLE_ORDER,
  getThrowableModel,
  type ThrowableConfig,
  type ThrowableId,
} from './ThrowableConfigs';
import type { CollisionWorld } from '../physics/CollisionWorld';
import { clamp, randRange } from '../core/MathUtils';

export type ThrowableActivity = 'idle' | 'cooking' | 'throwing';

export interface Projectile {
  config: ThrowableConfig;
  object: THREE.Object3D;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  spin: THREE.Vector3;
  /** Seconds left before detonation. */
  fuse: number;
  active: boolean;
  /** Set once it has come to rest so audio doesn't retrigger. */
  settled: boolean;
}

export interface ThrowableHooks {
  /** Supplies the throw origin and direction. */
  getThrowRay: (origin: THREE.Vector3, direction: THREE.Vector3) => void;
  onPinPulled: (config: ThrowableConfig) => void;
  onThrown: (config: ThrowableConfig, projectile: Projectile) => void;
  onBounce: (projectile: Projectile, surface: string, speed: number) => void;
  onDetonate: (config: ThrowableConfig, position: THREE.Vector3) => void;
  onSelectionChanged: (config: ThrowableConfig) => void;
  onEmpty: () => void;
}

const MAX_PROJECTILES = 16;
const GRAVITY = 18;
/** Speed below which a projectile is considered at rest. */
const REST_SPEED = 0.4;

/**
 * Grenades: inventory, the cook/throw state machine and projectile physics.
 *
 * Projectiles are simple spheres integrated against the static collision world,
 * which is plenty for something that lives for a few seconds. The system owns
 * no rendering beyond the projectile meshes — detonation effects are raised
 * through `onDetonate` so the game can decide what a payload actually does.
 */
export class ThrowableSystem {
  readonly group = new THREE.Group();
  readonly counts = new Map<ThrowableId, number>();

  currentId: ThrowableId = 'frag';
  activity: ThrowableActivity = 'idle';

  /** 0..1 progress of the active windup, or -1 when idle. */
  throwProgress = -1;
  /** Seconds the held grenade has been cooking, or -1. */
  cookTime = -1;

  private readonly world: CollisionWorld;
  private readonly hooks: ThrowableHooks;
  private readonly projectiles: Projectile[] = [];

  private stateTimer = 0;
  private pendingLob = false;
  private recoveryTimer = 0;

  private readonly tmpOrigin = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(world: CollisionWorld, hooks: ThrowableHooks) {
    this.world = world;
    this.hooks = hooks;
    this.group.name = 'throwables';
    for (const id of THROWABLE_ORDER) {
      this.counts.set(id, THROWABLE_CONFIGS[id].startCount);
    }
  }

  // ------------------------------------------------------------------ query

  get config(): ThrowableConfig {
    return THROWABLE_CONFIGS[this.currentId];
  }

  get count(): number {
    return this.counts.get(this.currentId) ?? 0;
  }

  get busy(): boolean {
    return this.activity !== 'idle' || this.recoveryTimer > 0;
  }

  /** Fraction of the fuse burned while cooking, 0..1. */
  get cookFraction(): number {
    if (this.cookTime < 0) return 0;
    return clamp(this.cookTime / this.config.fuse, 0, 1);
  }

  getCount(id: ThrowableId): number {
    return this.counts.get(id) ?? 0;
  }

  give(id: ThrowableId, amount: number): void {
    const cfg = THROWABLE_CONFIGS[id];
    this.counts.set(id, Math.min(cfg.maxCount, this.getCount(id) + amount));
  }

  refill(): void {
    for (const id of THROWABLE_ORDER) {
      this.counts.set(id, THROWABLE_CONFIGS[id].startCount);
    }
  }

  /** Cycles to the next type that still has stock, else just the next type. */
  cycle(direction = 1): void {
    const start = THROWABLE_ORDER.indexOf(this.currentId);
    for (let step = 1; step <= THROWABLE_ORDER.length; step++) {
      const idx =
        (start + direction * step + THROWABLE_ORDER.length * 2) % THROWABLE_ORDER.length;
      const id = THROWABLE_ORDER[idx];
      if (this.getCount(id) > 0 || step === THROWABLE_ORDER.length) {
        this.currentId = id;
        this.hooks.onSelectionChanged(this.config);
        return;
      }
    }
  }

  select(id: ThrowableId): void {
    if (this.currentId === id) return;
    this.currentId = id;
    this.hooks.onSelectionChanged(this.config);
  }

  // ----------------------------------------------------------------- update

  update(
    dt: number,
    input: { throwDown: boolean; lobDown: boolean; cyclePressed: boolean; blocked: boolean },
  ): void {
    if (this.recoveryTimer > 0) this.recoveryTimer -= dt;

    if (!input.blocked) {
      if (input.cyclePressed && this.activity === 'idle') this.cycle(1);
      this.updateHeld(dt, input);
    } else if (this.activity === 'cooking') {
      // Releasing control mid-cook throws it rather than holding a live one.
      this.beginThrow(false);
    }

    this.updateProjectiles(dt);
  }

  private updateHeld(
    dt: number,
    input: { throwDown: boolean; lobDown: boolean },
  ): void {
    const cfg = this.config;

    switch (this.activity) {
      case 'idle': {
        if (this.recoveryTimer > 0) break;
        const wants = input.throwDown || input.lobDown;
        if (!wants) break;
        if (this.count <= 0) {
          this.hooks.onEmpty();
          this.recoveryTimer = 0.3;
          break;
        }
        this.activity = 'cooking';
        this.cookTime = 0;
        this.pendingLob = input.lobDown && !input.throwDown;
        this.hooks.onPinPulled(cfg);
        break;
      }

      case 'cooking': {
        this.cookTime += dt;
        const stillHeld = input.throwDown || input.lobDown;
        // A cooked grenade that runs out of fuse goes off in your hand.
        if (cfg.cookable && this.cookTime >= cfg.fuse) {
          this.detonateInHand();
          break;
        }
        if (!stillHeld) this.beginThrow(this.pendingLob);
        break;
      }

      case 'throwing': {
        this.stateTimer += dt;
        this.throwProgress = clamp(this.stateTimer / cfg.windup, 0, 1);
        if (this.stateTimer >= cfg.windup) {
          this.release();
        }
        break;
      }
    }
  }

  private beginThrow(lob: boolean): void {
    this.pendingLob = lob;
    this.activity = 'throwing';
    this.stateTimer = 0;
    this.throwProgress = 0;
  }

  private release(): void {
    const cfg = this.config;
    const remaining = this.count;
    if (remaining <= 0) {
      this.finishThrow();
      return;
    }
    this.counts.set(this.currentId, remaining - 1);

    this.hooks.getThrowRay(this.tmpOrigin, this.tmpDir);
    this.tmpDir.normalize();

    const projectile = this.acquire(cfg);
    projectile.position.copy(this.tmpOrigin);
    projectile.velocity
      .copy(this.tmpDir)
      .multiplyScalar(this.pendingLob ? cfg.lobSpeed : cfg.throwSpeed)
      .addScaledVector(this.up, (this.pendingLob ? cfg.throwLift * 2.4 : cfg.throwLift) * cfg.throwSpeed);
    projectile.spin.set(randRange(-14, 14), randRange(-10, 10), randRange(-14, 14));
    // A cooked frag keeps whatever fuse is left.
    projectile.fuse = cfg.cookable ? Math.max(0.15, cfg.fuse - Math.max(0, this.cookTime)) : cfg.fuse;
    projectile.object.position.copy(projectile.position);
    projectile.object.visible = true;
    projectile.active = true;
    projectile.settled = false;

    this.hooks.onThrown(cfg, projectile);
    this.finishThrow();
  }

  private finishThrow(): void {
    this.activity = 'idle';
    this.throwProgress = -1;
    this.cookTime = -1;
    this.recoveryTimer = this.config.recovery;
  }

  /** A frag cooked past its fuse detonates where the player is standing. */
  private detonateInHand(): void {
    const cfg = this.config;
    this.counts.set(this.currentId, Math.max(0, this.count - 1));
    this.hooks.getThrowRay(this.tmpOrigin, this.tmpDir);
    this.hooks.onDetonate(cfg, this.tmpOrigin.clone());
    this.finishThrow();
  }

  private acquire(config: ThrowableConfig): Projectile {
    let projectile = this.projectiles.find((p) => !p.active && p.config.id === config.id);
    if (!projectile) {
      if (this.projectiles.length >= MAX_PROJECTILES) {
        // Recycle the oldest live one rather than growing without bound.
        projectile = this.projectiles[0];
        projectile.active = false;
      } else {
        const object = getThrowableModel(config.id);
        object.visible = false;
        this.group.add(object);
        projectile = {
          config,
          object,
          position: new THREE.Vector3(),
          velocity: new THREE.Vector3(),
          spin: new THREE.Vector3(),
          fuse: config.fuse,
          active: false,
          settled: false,
        };
        this.projectiles.push(projectile);
      }
    }
    projectile.config = config;
    return projectile;
  }

  private updateProjectiles(dt: number): void {
    for (const p of this.projectiles) {
      if (!p.active) continue;

      p.velocity.y -= GRAVITY * dt;
      const contact = this.world.moveSphere(
        p.position,
        p.velocity,
        p.config.radius,
        dt,
        p.config.restitution,
        p.config.friction,
      );

      if (contact) {
        if (p.config.impact) {
          this.detonate(p);
          continue;
        }
        if (contact.speed > 1.2) {
          this.hooks.onBounce(p, contact.surface, contact.speed);
          p.spin.multiplyScalar(0.55);
        }
      }

      const speed = p.velocity.length();
      if (speed < REST_SPEED) {
        p.velocity.multiplyScalar(0.82);
        p.spin.multiplyScalar(0.82);
        p.settled = true;
      }

      p.object.position.copy(p.position);
      p.object.rotation.x += p.spin.x * dt;
      p.object.rotation.y += p.spin.y * dt;
      p.object.rotation.z += p.spin.z * dt;

      p.fuse -= dt;
      if (p.fuse <= 0) this.detonate(p);
    }
  }

  private detonate(p: Projectile): void {
    p.active = false;
    p.object.visible = false;
    this.hooks.onDetonate(p.config, p.position.clone());
  }

  /** Clears live projectiles, e.g. when the range is reset. */
  clear(): void {
    for (const p of this.projectiles) {
      p.active = false;
      p.object.visible = false;
    }
    this.activity = 'idle';
    this.throwProgress = -1;
    this.cookTime = -1;
    this.recoveryTimer = 0;
  }

  get liveCount(): number {
    return this.projectiles.reduce((n, p) => n + (p.active ? 1 : 0), 0);
  }
}
