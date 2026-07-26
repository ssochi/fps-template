import * as THREE from 'three';
import { CollisionWorld } from '../physics/CollisionWorld';
import { clamp, damp, DEG2RAD } from '../core/MathUtils';

export type Stance = 'stand' | 'crouch' | 'slide';

export interface PlayerConfig {
  standHeight: number;
  crouchHeight: number;
  radius: number;
  eyeOffset: number;

  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  backpedalScale: number;
  strafeScale: number;

  groundAccel: number;
  airAccel: number;
  friction: number;
  airFriction: number;

  gravity: number;
  jumpHeight: number;
  coyoteTime: number;
  jumpBuffer: number;
  stepHeight: number;

  slideSpeed: number;
  slideDuration: number;
  slideFriction: number;
  slideCooldown: number;

  maxStamina: number;
  staminaDrain: number;
  staminaRegen: number;
  staminaRegenDelay: number;
  /** Sprint is blocked until stamina climbs back above this. */
  staminaSprintThreshold: number;

  maxHealth: number;
  /** Fall speed (m/s) above which landing hurts. */
  fallDamageSpeed: number;
  fallDamageScale: number;

  lookPitchLimit: number;
}

export const DEFAULT_PLAYER_CONFIG: PlayerConfig = {
  standHeight: 1.8,
  crouchHeight: 1.15,
  radius: 0.32,
  eyeOffset: -0.14,

  walkSpeed: 4.3,
  sprintSpeed: 7.0,
  crouchSpeed: 2.1,
  backpedalScale: 0.78,
  strafeScale: 0.9,

  groundAccel: 70,
  airAccel: 22,
  friction: 11,
  airFriction: 0.12,

  gravity: 21,
  jumpHeight: 1.05,
  coyoteTime: 0.12,
  jumpBuffer: 0.16,
  stepHeight: 0.42,

  slideSpeed: 9.2,
  slideDuration: 0.85,
  slideFriction: 2.6,
  slideCooldown: 0.65,

  maxStamina: 100,
  staminaDrain: 22,
  staminaRegen: 16,
  staminaRegenDelay: 0.8,
  staminaSprintThreshold: 15,

  maxHealth: 100,
  fallDamageSpeed: 13,
  fallDamageScale: 7,

  lookPitchLimit: 89,
};

export interface PlayerInputState {
  forward: number;
  right: number;
  jump: boolean;
  jumpPressed: boolean;
  sprint: boolean;
  crouch: boolean;
  crouchPressed: boolean;
  /** Set while aiming — blocks sprint and slows movement. */
  aiming: boolean;
  /** Extra speed multiplier from the equipped weapon. */
  speedScale: number;
}

export interface PlayerEvents {
  onFootstep?: (surface: 'concrete' | 'metal' | 'dirt', running: boolean) => void;
  onJump?: () => void;
  onLand?: (hard: boolean, fallSpeed: number) => void;
  onSlideStart?: () => void;
  onDamage?: (amount: number, source: 'fall' | 'hit') => void;
  onDeath?: () => void;
}

const FORWARD = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const WISH = new THREE.Vector3();
const DISPLACE = new THREE.Vector3();

/**
 * Kinematic FPS character controller.
 *
 * Uses a Quake-style acceleration model (separate ground/air accel with a
 * friction pass) which gives the crisp, responsive feel players expect from
 * shooters, plus quality-of-life features: coyote time, jump buffering,
 * step-up, crouch/slide and stamina-gated sprinting.
 */
export class Player {
  readonly config: PlayerConfig;
  readonly position = new THREE.Vector3(0, 0, 0);
  readonly velocity = new THREE.Vector3();

  yaw = 0;
  pitch = 0;

  grounded = false;
  wasGrounded = false;
  stance: Stance = 'stand';
  sprinting = false;
  height: number;

  /** Wired from settings so crouch can be hold-to-crouch or a toggle. */
  toggleCrouchEnabled = false;

  health: number;
  stamina: number;
  alive = true;

  groundSurface: 'concrete' | 'metal' | 'dirt' | 'wood' = 'concrete';

  /** Horizontal speed in m/s — handy for HUD and animation blending. */
  planarSpeed = 0;
  /** 0..1, how fast the player is moving relative to sprint speed. */
  moveIntensity = 0;

  private readonly world: CollisionWorld;
  private readonly events: PlayerEvents;

  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private slideTimer = 0;
  private slideCooldownTimer = 0;
  private staminaDelayTimer = 0;
  private stepDistance = 0;
  private lastFallSpeed = 0;
  private crouchToggleState = false;
  private landRecoveryTimer = 0;

  constructor(world: CollisionWorld, events: PlayerEvents = {}, config = DEFAULT_PLAYER_CONFIG) {
    this.world = world;
    this.events = events;
    this.config = config;
    this.height = config.standHeight;
    this.health = config.maxHealth;
    this.stamina = config.maxStamina;
  }

  // ------------------------------------------------------------------ state

  get eyeHeight(): number {
    return this.height + this.config.eyeOffset;
  }

  get eyePosition(): THREE.Vector3 {
    return new THREE.Vector3(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  get isSliding(): boolean {
    return this.stance === 'slide';
  }

  get isCrouching(): boolean {
    return this.stance === 'crouch' || this.stance === 'slide';
  }

  /** 0..1 blend used to lower the camera and third-person model. */
  get crouchAmount(): number {
    const { standHeight, crouchHeight } = this.config;
    return clamp((standHeight - this.height) / (standHeight - crouchHeight), 0, 1);
  }

  teleport(position: THREE.Vector3, yaw = this.yaw): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = false;
    this.stance = 'stand';
    this.height = this.config.standHeight;
  }

  addLook(deltaYaw: number, deltaPitch: number): void {
    this.yaw -= deltaYaw;
    this.pitch = clamp(
      this.pitch - deltaPitch,
      -this.config.lookPitchLimit * DEG2RAD,
      this.config.lookPitchLimit * DEG2RAD,
    );
    // Keep yaw bounded so long sessions don't drift into float imprecision.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** Adds recoil directly to the aim angles (used for the permanent share). */
  addAimPunch(yawDeg: number, pitchDeg: number): void {
    this.yaw += yawDeg * DEG2RAD;
    this.pitch = clamp(
      this.pitch + pitchDeg * DEG2RAD,
      -this.config.lookPitchLimit * DEG2RAD,
      this.config.lookPitchLimit * DEG2RAD,
    );
  }

  getForward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
  }

  damage(amount: number, source: 'fall' | 'hit' = 'hit'): void {
    if (!this.alive || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this.events.onDamage?.(amount, source);
    if (this.health <= 0) {
      this.alive = false;
      this.events.onDeath?.();
    }
  }

  heal(amount: number): void {
    this.health = Math.min(this.config.maxHealth, this.health + amount);
    if (this.health > 0) this.alive = true;
  }

  respawn(position: THREE.Vector3, yaw = 0): void {
    this.health = this.config.maxHealth;
    this.stamina = this.config.maxStamina;
    this.alive = true;
    this.teleport(position, yaw);
  }

  // ----------------------------------------------------------------- update

  update(dt: number, input: PlayerInputState): void {
    const c = this.config;
    this.wasGrounded = this.grounded;

    if (!this.alive) {
      // Dead players still fall, but take no input.
      this.velocity.x = damp(this.velocity.x, 0, 6, dt);
      this.velocity.z = damp(this.velocity.z, 0, 6, dt);
      this.velocity.y -= c.gravity * dt;
      DISPLACE.copy(this.velocity).multiplyScalar(dt);
      const res = this.world.move(this.position, DISPLACE, c.radius, this.height, c.stepHeight);
      this.grounded = res.grounded;
      if (res.grounded) this.velocity.y = 0;
      return;
    }

    this.updateTimers(dt);

    // ---- desired direction in world space -------------------------------
    FORWARD.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    RIGHT.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const fwdScale = input.forward < 0 ? c.backpedalScale : 1;
    WISH.set(0, 0, 0)
      .addScaledVector(FORWARD, input.forward * fwdScale)
      .addScaledVector(RIGHT, input.right * c.strafeScale);

    const hasInput = WISH.lengthSq() > 1e-6;
    if (hasInput) WISH.normalize();

    // ---- sprint gating ---------------------------------------------------
    const wantsSprint =
      input.sprint &&
      input.forward > 0.1 &&
      !input.aiming &&
      this.stance !== 'crouch' &&
      this.stamina > c.staminaSprintThreshold;
    this.sprinting = wantsSprint && this.grounded && hasInput;
    this.updateStamina(dt);

    // Stance depends on the sprint decision above (sliding needs a sprint).
    this.updateStance(dt, input);
    if (this.stance === 'crouch' || this.stance === 'slide') this.sprinting = false;

    // ---- target speed ----------------------------------------------------
    let wishSpeed: number;
    if (this.stance === 'slide') {
      wishSpeed = 0; // slides coast; no acceleration input.
    } else if (this.stance === 'crouch') {
      wishSpeed = c.crouchSpeed;
    } else if (this.sprinting) {
      wishSpeed = c.sprintSpeed;
    } else {
      wishSpeed = c.walkSpeed;
    }
    wishSpeed *= input.speedScale;
    if (this.landRecoveryTimer > 0) wishSpeed *= 0.72;

    // ---- horizontal movement --------------------------------------------
    if (this.grounded) {
      this.applyFriction(dt, this.stance === 'slide' ? c.slideFriction : c.friction, wishSpeed);
      if (hasInput && wishSpeed > 0) {
        this.accelerate(WISH, wishSpeed, c.groundAccel, dt);
      }
    } else {
      if (hasInput) {
        // Air control: limited acceleration, capped at the walk speed so
        // bunny-hop chaining stays bounded.
        this.accelerate(WISH, Math.min(wishSpeed, c.walkSpeed), c.airAccel, dt);
      }
      this.velocity.x *= Math.pow(1 - c.airFriction, dt);
      this.velocity.z *= Math.pow(1 - c.airFriction, dt);
    }

    // ---- jump ------------------------------------------------------------
    if (input.jumpPressed) this.jumpBufferTimer = c.jumpBuffer;
    const canJump = this.grounded || this.coyoteTimer > 0;
    if (this.jumpBufferTimer > 0 && canJump && this.canStandUp()) {
      this.velocity.y = Math.sqrt(2 * c.gravity * c.jumpHeight);
      this.grounded = false;
      this.coyoteTimer = 0;
      this.jumpBufferTimer = 0;
      if (this.stance === 'slide') this.endSlide();
      this.events.onJump?.();
    }

    // ---- gravity + integrate --------------------------------------------
    this.velocity.y -= c.gravity * dt;
    // Terminal velocity keeps the collision solver well-conditioned.
    this.velocity.y = Math.max(this.velocity.y, -60);
    this.lastFallSpeed = Math.max(this.lastFallSpeed, -this.velocity.y);

    DISPLACE.copy(this.velocity).multiplyScalar(dt);
    const result = this.world.move(this.position, DISPLACE, c.radius, this.height, c.stepHeight);

    this.grounded = result.grounded;
    this.groundSurface = result.groundSurface;
    if (result.grounded && this.velocity.y < 0) this.velocity.y = 0;
    if (result.hitCeiling && this.velocity.y > 0) this.velocity.y = 0;

    // ---- landing ---------------------------------------------------------
    if (this.grounded && !this.wasGrounded) {
      const fall = this.lastFallSpeed;
      const hard = fall > 7;
      this.events.onLand?.(hard, fall);
      if (fall > c.fallDamageSpeed) {
        this.damage((fall - c.fallDamageSpeed) * c.fallDamageScale, 'fall');
        this.landRecoveryTimer = 0.4;
      }
      this.lastFallSpeed = 0;
    }
    if (this.grounded) this.lastFallSpeed = 0;

    // ---- bookkeeping -----------------------------------------------------
    this.planarSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.moveIntensity = clamp(this.planarSpeed / c.sprintSpeed, 0, 1);
    this.updateFootsteps(dt);
  }

  private updateTimers(dt: number): void {
    if (this.coyoteTimer > 0) this.coyoteTimer -= dt;
    if (this.jumpBufferTimer > 0) this.jumpBufferTimer -= dt;
    if (this.slideCooldownTimer > 0) this.slideCooldownTimer -= dt;
    if (this.staminaDelayTimer > 0) this.staminaDelayTimer -= dt;
    if (this.landRecoveryTimer > 0) this.landRecoveryTimer -= dt;
    if (this.grounded) this.coyoteTimer = this.config.coyoteTime;
  }

  private updateStamina(dt: number): void {
    const c = this.config;
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - c.staminaDrain * dt);
      this.staminaDelayTimer = c.staminaRegenDelay;
    } else if (this.staminaDelayTimer <= 0) {
      this.stamina = Math.min(c.maxStamina, this.stamina + c.staminaRegen * dt);
    }
  }

  private updateStance(dt: number, input: PlayerInputState): void {
    const c = this.config;

    // Slide entry: crouch while sprinting fast on the ground.
    if (
      input.crouchPressed &&
      this.grounded &&
      this.sprinting &&
      this.planarSpeed > c.walkSpeed * 0.9 &&
      this.slideCooldownTimer <= 0 &&
      this.stance !== 'slide'
    ) {
      this.startSlide();
    }

    if (this.stance === 'slide') {
      this.slideTimer -= dt;
      const tooSlow = this.planarSpeed < c.crouchSpeed * 1.1;
      if (this.slideTimer <= 0 || tooSlow || !this.grounded) {
        this.endSlide();
        // Hold crouch to stay down after the slide finishes.
        if (input.crouch && this.grounded) this.stance = 'crouch';
      }
    } else {
      const wantCrouch = this.resolveCrouchIntent(input);
      if (wantCrouch) {
        this.stance = 'crouch';
      } else if (this.canStandUp()) {
        this.stance = 'stand';
      }
    }

    // Smoothly interpolate the collider height so the camera doesn't snap.
    const targetHeight =
      this.stance === 'stand'
        ? c.standHeight
        : this.stance === 'slide'
          ? c.crouchHeight * 0.86
          : c.crouchHeight;
    this.height = damp(this.height, targetHeight, 14, dt);
  }

  private resolveCrouchIntent(input: PlayerInputState): boolean {
    if (this.toggleCrouchEnabled) {
      if (input.crouchPressed) this.crouchToggleState = !this.crouchToggleState;
      return this.crouchToggleState;
    }
    this.crouchToggleState = false;
    return input.crouch;
  }

  private startSlide(): void {
    this.stance = 'slide';
    this.slideTimer = this.config.slideDuration;
    const speed = Math.max(this.planarSpeed, this.config.slideSpeed);
    const len = Math.hypot(this.velocity.x, this.velocity.z);
    if (len > 0.01) {
      this.velocity.x = (this.velocity.x / len) * speed;
      this.velocity.z = (this.velocity.z / len) * speed;
    }
    this.events.onSlideStart?.();
  }

  private endSlide(): void {
    if (this.stance !== 'slide') return;
    this.stance = this.canStandUp() ? 'stand' : 'crouch';
    this.slideCooldownTimer = this.config.slideCooldown;
  }

  /** False when there is geometry directly overhead. */
  private canStandUp(): boolean {
    if (this.height >= this.config.standHeight - 0.01) return true;
    return !this.world.overlaps(this.position, this.config.radius, this.config.standHeight);
  }

  private applyFriction(dt: number, friction: number, wishSpeed: number): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed < 0.001) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }
    // A control floor keeps low-speed stops crisp instead of mushy.
    const control = Math.max(speed, Math.max(wishSpeed * 0.25, 1.2));
    const drop = control * friction * dt;
    const newSpeed = Math.max(0, speed - drop) / speed;
    this.velocity.x *= newSpeed;
    this.velocity.z *= newSpeed;
  }

  private accelerate(wishDir: THREE.Vector3, wishSpeed: number, accel: number, dt: number): void {
    const currentSpeed = this.velocity.x * wishDir.x + this.velocity.z * wishDir.z;
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(accel * dt * wishSpeed, addSpeed);
    this.velocity.x += wishDir.x * accelSpeed;
    this.velocity.z += wishDir.z * accelSpeed;
  }

  private updateFootsteps(dt: number): void {
    if (!this.grounded || this.stance === 'slide') {
      this.stepDistance = 0;
      return;
    }
    this.stepDistance += this.planarSpeed * dt;
    // Longer strides when sprinting, shorter when crouched.
    const stride = this.sprinting ? 2.35 : this.stance === 'crouch' ? 1.35 : 1.85;
    if (this.stepDistance >= stride && this.planarSpeed > 0.7) {
      this.stepDistance = 0;
      const surface = this.groundSurface === 'wood' ? 'dirt' : this.groundSurface;
      this.events.onFootstep?.(surface, this.sprinting);
    }
  }
}
