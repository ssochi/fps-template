import * as THREE from 'three';
import type { FireMode, WeaponConfig, WeaponId } from './WeaponTypes';
import { WEAPON_CONFIGS, WEAPON_ORDER } from './WeaponConfigs';
import { clamp, DEG2RAD, randGaussian, randRange } from '../core/MathUtils';
import type { ImpactMaterial } from '../audio/AudioEngine';

export type WeaponActivity =
  | 'idle'
  | 'cycling'
  | 'reloading'
  | 'drawing'
  | 'holstering'
  | 'inspecting';

export type HitZone = 'head' | 'body' | 'limb';

export interface HitInfo {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  object: THREE.Object3D;
  surface: ImpactMaterial;
  damage: number;
  zone: HitZone;
  /** How many surfaces the round had already passed through. */
  penetrationDepth: number;
  /** True when the hit registered on a damageable target. */
  isTarget: boolean;
  /** False for thick geometry that stops rounds regardless of weapon power. */
  penetrable: boolean;
}

export interface ShotInfo {
  config: WeaponConfig;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  /** End point of the round — the impact or the max-range point. */
  endPoint: THREE.Vector3;
  hit: HitInfo | null;
  pelletIndex: number;
}

export interface WeaponHooks {
  /** Supplies the ray the next shot should follow. */
  getFireRay: (origin: THREE.Vector3, direction: THREE.Vector3) => void;
  /** Performs the world raycast. Returns null when nothing was hit. */
  raycast: (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    ignore: THREE.Object3D[],
  ) => HitInfo | null;

  onShotFired: (shots: ShotInfo[], config: WeaponConfig) => void;
  onHit: (hit: HitInfo, config: WeaponConfig) => void;
  onDryFire: (config: WeaponConfig) => void;
  onReloadStart: (config: WeaponConfig, kind: 'tactical' | 'empty' | 'shell') => void;
  onReloadStep: (config: WeaponConfig, step: 'magOut' | 'magIn' | 'chamber' | 'shellInsert') => void;
  onReloadEnd: (config: WeaponConfig) => void;
  onCycle: (config: WeaponConfig) => void;
  onEquip: (config: WeaponConfig) => void;
  onAdsChange: (config: WeaponConfig, aiming: boolean) => void;
  onFireModeChange: (config: WeaponConfig, mode: FireMode) => void;
  onAmmoChanged: () => void;
}

export interface WeaponRuntimeState {
  ammo: number;
  reserve: number;
  fireModeIndex: number;
  /** Index into the recoil pattern; resets when the trigger is released. */
  shotIndex: number;
}

export interface WeaponInput {
  triggerDown: boolean;
  aimDown: boolean;
  reloadPressed: boolean;
  fireModePressed: boolean;
  inspectPressed: boolean;
  /** Requested weapon slot, or null. */
  switchTo: WeaponId | null;
  /** Blocks firing/aiming (sprinting, dead, menus). */
  blocked: boolean;
  sprinting: boolean;
  /** Movement speed 0..1 and airborne flag feed the spread model. */
  moveIntensity: number;
  airborne: boolean;
  crouched: boolean;
}

const MAX_RANGE = 500;

/**
 * Owns the loadout, the firing state machine and all ballistics.
 *
 * Everything that touches gameplay numbers reads from `WeaponConfig`, so
 * rebalancing never requires touching this file.
 */
export class WeaponSystem {
  readonly states = new Map<WeaponId, WeaponRuntimeState>();

  currentId: WeaponId;
  activity: WeaponActivity = 'idle';

  /** 0..1 aim-down-sights blend. */
  adsProgress = 0;
  aiming = false;

  /** Accumulated bloom in degrees. */
  bloom = 0;

  /** Normalised progress of the active scripted animation, or -1. */
  reloadProgress = -1;
  reloadKind: 'tactical' | 'empty' | 'shell' | null = null;
  drawProgress = -1;
  holsterProgress = -1;
  cycleProgress = -1;
  inspectProgress = -1;

  private readonly hooks: WeaponHooks;

  private fireCooldown = 0;
  private burstRemaining = 0;
  private burstTimer = 0;
  private triggerWasDown = false;
  private pendingSwitch: WeaponId | null = null;
  private stateTimer = 0;
  private stateDuration = 0;
  private reloadStepFlags = 0;
  private shellsToLoad = 0;
  private reloadCancelRequested = false;
  private lastAiming = false;

  private readonly tmpOrigin = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly spreadDir = new THREE.Vector3();
  private readonly rayEnd = new THREE.Vector3();
  private readonly basisRight = new THREE.Vector3();
  private readonly basisUp = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly ignoreList: THREE.Object3D[] = [];
  private readonly shotBuffer: ShotInfo[] = [];

  constructor(hooks: WeaponHooks, startWeapon: WeaponId = 'rifle') {
    this.hooks = hooks;
    for (const id of WEAPON_ORDER) {
      const cfg = WEAPON_CONFIGS[id];
      this.states.set(id, {
        ammo: cfg.magSize,
        reserve: cfg.reserveAmmo,
        fireModeIndex: 0,
        shotIndex: 0,
      });
    }
    this.currentId = startWeapon;
    this.beginDraw();
  }

  // ------------------------------------------------------------------ query

  get config(): WeaponConfig {
    return WEAPON_CONFIGS[this.currentId];
  }

  get state(): WeaponRuntimeState {
    return this.states.get(this.currentId)!;
  }

  get fireMode(): FireMode {
    const cfg = this.config;
    return cfg.fireModes[this.state.fireModeIndex % cfg.fireModes.length];
  }

  get isReloading(): boolean {
    return this.activity === 'reloading';
  }

  get isBusy(): boolean {
    return this.activity !== 'idle';
  }

  /** Current cone half-angle in degrees, including bloom and movement. */
  get currentSpread(): number {
    return this.computeSpread(this.lastMoveIntensity, this.lastAirborne, this.lastCrouched);
  }

  private lastMoveIntensity = 0;
  private lastAirborne = false;
  private lastCrouched = false;

  /** FOV the world camera should use while fully aimed. */
  getAdsFov(baseFov: number): number {
    const cfg = this.config;
    return cfg.scopeFov ?? baseFov * cfg.adsFovScale;
  }

  /** Movement multiplier from the equipped weapon and aim state. */
  get moveSpeedScale(): number {
    const cfg = this.config;
    return cfg.weightMoveScale * (1 - (1 - cfg.adsMoveScale) * this.adsProgress);
  }

  getAmmoDisplay(): { ammo: number; reserve: number; magSize: number } {
    const s = this.state;
    return { ammo: s.ammo, reserve: s.reserve, magSize: this.config.magSize };
  }

  giveAmmo(id: WeaponId, rounds: number): void {
    const cfg = WEAPON_CONFIGS[id];
    const s = this.states.get(id)!;
    s.reserve = Math.min(cfg.maxReserveAmmo, s.reserve + rounds);
    this.hooks.onAmmoChanged();
  }

  refillAll(): void {
    for (const id of WEAPON_ORDER) {
      const cfg = WEAPON_CONFIGS[id];
      const s = this.states.get(id)!;
      s.ammo = cfg.magSize;
      s.reserve = cfg.reserveAmmo;
    }
    this.hooks.onAmmoChanged();
  }

  // ----------------------------------------------------------------- update

  update(dt: number, input: WeaponInput): void {
    this.lastMoveIntensity = input.moveIntensity;
    this.lastAirborne = input.airborne;
    this.lastCrouched = input.crouched;

    this.updateAds(dt, input);
    this.updateBloom(dt);
    this.updateActivity(dt);

    if (this.fireCooldown > 0) this.fireCooldown -= dt;

    if (!input.blocked) {
      this.handleSwitching(input);
      this.handleFireMode(input);
      this.handleReload(input);
      this.handleInspect(input);
      this.handleTrigger(dt, input);
    } else {
      this.triggerWasDown = false;
      this.burstRemaining = 0;
    }
  }

  private updateAds(dt: number, input: WeaponInput): void {
    const cfg = this.config;
    const canAim =
      !input.blocked &&
      input.aimDown &&
      this.activity !== 'drawing' &&
      this.activity !== 'holstering' &&
      this.activity !== 'inspecting' &&
      !(input.sprinting && input.moveIntensity > 0.75);

    this.aiming = canAim;
    if (this.aiming !== this.lastAiming) {
      this.lastAiming = this.aiming;
      this.hooks.onAdsChange(cfg, this.aiming);
    }

    const rate = 1 / Math.max(0.02, cfg.adsTime);
    const target = this.aiming ? 1 : 0;
    const delta = rate * dt;
    this.adsProgress = clamp(
      this.adsProgress + Math.sign(target - this.adsProgress) * delta,
      0,
      1,
    );
    if (Math.abs(target - this.adsProgress) < delta) this.adsProgress = target;
  }

  private updateBloom(dt: number): void {
    const cfg = this.config;
    this.bloom = Math.max(0, this.bloom - cfg.spread.recovery * dt);
  }

  private updateActivity(dt: number): void {
    if (this.activity === 'idle') return;

    this.stateTimer += dt;
    const t = this.stateDuration > 0 ? clamp(this.stateTimer / this.stateDuration, 0, 1) : 1;

    switch (this.activity) {
      case 'drawing':
        this.drawProgress = t;
        if (t >= 1) {
          this.drawProgress = -1;
          this.activity = 'idle';
        }
        break;

      case 'holstering':
        this.holsterProgress = t;
        if (t >= 1) {
          this.holsterProgress = -1;
          this.completeSwitch();
        }
        break;

      case 'cycling':
        this.cycleProgress = t;
        if (t >= 1) {
          this.cycleProgress = -1;
          this.activity = 'idle';
        }
        break;

      case 'inspecting':
        this.inspectProgress = t;
        if (t >= 1) {
          this.inspectProgress = -1;
          this.activity = 'idle';
        }
        break;

      case 'reloading':
        this.updateReloadState(t);
        break;
    }
  }

  private updateReloadState(t: number): void {
    const cfg = this.config;
    this.reloadProgress = t;

    if (cfg.shellReload) {
      if (t >= 1) {
        this.loadOneShell();
        const s = this.state;
        const full = s.ammo >= cfg.magSize;
        if (this.reloadCancelRequested || full || s.reserve <= 0 || this.shellsToLoad <= 0) {
          this.finishShellReload();
        } else {
          // Chain into the next shell.
          this.stateTimer = 0;
          this.stateDuration = cfg.shellReloadTime;
          this.hooks.onReloadStep(cfg, 'shellInsert');
        }
      }
      return;
    }

    // Fire the mechanical audio cues at the right points in the animation.
    if (t > 0.2 && (this.reloadStepFlags & 1) === 0) {
      this.reloadStepFlags |= 1;
      this.hooks.onReloadStep(cfg, 'magOut');
    }
    if (t > 0.62 && (this.reloadStepFlags & 2) === 0) {
      this.reloadStepFlags |= 2;
      this.hooks.onReloadStep(cfg, 'magIn');
    }
    if (this.reloadKind === 'empty' && t > 0.86 && (this.reloadStepFlags & 4) === 0) {
      this.reloadStepFlags |= 4;
      this.hooks.onReloadStep(cfg, 'chamber');
    }

    if (t >= 1) this.completeMagReload();
  }

  // -------------------------------------------------------------- switching

  private handleSwitching(input: WeaponInput): void {
    if (!input.switchTo || input.switchTo === this.currentId) return;
    if (this.activity === 'holstering' || this.activity === 'drawing') return;
    this.switchTo(input.switchTo);
  }

  switchTo(id: WeaponId): void {
    if (id === this.currentId || !WEAPON_CONFIGS[id]) return;
    this.pendingSwitch = id;
    this.cancelReload();
    this.activity = 'holstering';
    this.stateTimer = 0;
    this.stateDuration = this.config.holsterTime;
    this.holsterProgress = 0;
    this.burstRemaining = 0;
  }

  /** Cycles to the next / previous weapon in the loadout. */
  cycle(direction: number): void {
    const idx = WEAPON_ORDER.indexOf(this.currentId);
    const next = WEAPON_ORDER[(idx + direction + WEAPON_ORDER.length) % WEAPON_ORDER.length];
    this.switchTo(next);
  }

  private completeSwitch(): void {
    if (this.pendingSwitch) {
      this.currentId = this.pendingSwitch;
      this.pendingSwitch = null;
    }
    this.beginDraw();
  }

  private beginDraw(): void {
    this.activity = 'drawing';
    this.stateTimer = 0;
    this.stateDuration = this.config.drawTime;
    this.drawProgress = 0;
    this.bloom = 0;
    this.state.shotIndex = 0;
    this.hooks.onEquip(this.config);
  }

  // --------------------------------------------------------------- fire mode

  private handleFireMode(input: WeaponInput): void {
    if (!input.fireModePressed) return;
    const cfg = this.config;
    if (cfg.fireModes.length < 2) return;
    const s = this.state;
    s.fireModeIndex = (s.fireModeIndex + 1) % cfg.fireModes.length;
    this.hooks.onFireModeChange(cfg, this.fireMode);
  }

  private handleInspect(input: WeaponInput): void {
    if (!input.inspectPressed || this.activity !== 'idle') return;
    this.activity = 'inspecting';
    this.stateTimer = 0;
    this.stateDuration = 1.4;
    this.inspectProgress = 0;
  }

  // ----------------------------------------------------------------- reload

  private handleReload(input: WeaponInput): void {
    if (!input.reloadPressed) return;
    this.startReload();
  }

  startReload(): boolean {
    const cfg = this.config;
    const s = this.state;
    if (this.activity === 'reloading' || this.activity === 'drawing' || this.activity === 'holstering') {
      return false;
    }
    if (s.reserve <= 0 || s.ammo >= cfg.magSize) return false;

    this.reloadCancelRequested = false;
    this.reloadStepFlags = 0;
    this.activity = 'reloading';
    this.stateTimer = 0;

    if (cfg.shellReload) {
      this.shellsToLoad = Math.min(cfg.magSize - s.ammo, s.reserve);
      this.reloadKind = 'shell';
      this.stateDuration = cfg.shellReloadTime;
      this.hooks.onReloadStart(cfg, 'shell');
      this.hooks.onReloadStep(cfg, 'shellInsert');
    } else {
      this.reloadKind = s.ammo <= 0 ? 'empty' : 'tactical';
      this.stateDuration = s.ammo <= 0 ? cfg.reloadEmptyTime : cfg.reloadTime;
      this.hooks.onReloadStart(cfg, this.reloadKind);
    }
    this.reloadProgress = 0;
    return true;
  }

  private completeMagReload(): void {
    const cfg = this.config;
    const s = this.state;
    const needed = cfg.magSize - s.ammo;
    const taken = Math.min(needed, s.reserve);
    s.ammo += taken;
    s.reserve -= taken;
    s.shotIndex = 0;
    this.reloadProgress = -1;
    this.reloadKind = null;
    this.activity = 'idle';
    this.hooks.onReloadEnd(cfg);
    this.hooks.onAmmoChanged();
  }

  private loadOneShell(): void {
    const s = this.state;
    const cfg = this.config;
    if (s.reserve <= 0 || s.ammo >= cfg.magSize) return;
    s.ammo++;
    s.reserve--;
    this.shellsToLoad--;
    this.hooks.onAmmoChanged();
  }

  private finishShellReload(): void {
    this.reloadProgress = -1;
    this.reloadKind = null;
    this.activity = 'idle';
    this.state.shotIndex = 0;
    this.hooks.onReloadEnd(this.config);
  }

  /** Shotgun reloads can be interrupted to fire the shells already loaded. */
  private cancelReload(): void {
    if (this.activity !== 'reloading') return;
    if (this.config.shellReload) {
      this.reloadCancelRequested = true;
      this.finishShellReload();
    } else {
      this.reloadProgress = -1;
      this.reloadKind = null;
      this.activity = 'idle';
    }
  }

  // ------------------------------------------------------------------- fire

  private handleTrigger(dt: number, input: WeaponInput): void {
    const cfg = this.config;
    const mode = this.fireMode;

    // Burst continuation runs even after the trigger is released.
    if (this.burstRemaining > 0) {
      this.burstTimer -= dt;
      if (this.burstTimer <= 0) {
        if (this.tryFire()) {
          this.burstRemaining--;
          this.burstTimer = cfg.burstDelay;
        } else {
          this.burstRemaining = 0;
        }
      }
      this.triggerWasDown = input.triggerDown;
      return;
    }

    if (!input.triggerDown) {
      // Releasing the trigger resets the recoil pattern.
      if (this.triggerWasDown) this.state.shotIndex = 0;
      this.triggerWasDown = false;
      return;
    }

    const freshPull = !this.triggerWasDown;
    this.triggerWasDown = true;

    if (input.sprinting && input.moveIntensity > 0.85 && this.adsProgress < 0.2) return;

    // Firing interrupts a shell-by-shell reload.
    if (this.activity === 'reloading' && cfg.shellReload && this.state.ammo > 0 && freshPull) {
      this.cancelReload();
    }

    switch (mode) {
      case 'semi':
        if (freshPull) this.tryFire();
        break;
      case 'auto':
        this.tryFire();
        break;
      case 'burst':
        if (freshPull && this.tryFire()) {
          this.burstRemaining = cfg.burstCount - 1;
          this.burstTimer = cfg.burstDelay;
        }
        break;
    }
  }

  private tryFire(): boolean {
    const cfg = this.config;
    const s = this.state;

    if (this.fireCooldown > 0) return false;
    if (this.activity === 'drawing' || this.activity === 'holstering' || this.activity === 'cycling') {
      return false;
    }
    if (this.activity === 'reloading') {
      if (!cfg.shellReload) return false;
      this.cancelReload();
    }
    if (this.activity === 'inspecting') {
      this.inspectProgress = -1;
      this.activity = 'idle';
    }

    if (s.ammo <= 0) {
      this.fireCooldown = 0.28;
      this.hooks.onDryFire(cfg);
      return false;
    }

    s.ammo--;
    this.fireCooldown = 60 / cfg.rpm;
    this.hooks.onAmmoChanged();

    this.emitShots(cfg);

    // Bloom + recoil pattern advance.
    this.bloom = Math.min(cfg.spread.max, this.bloom + cfg.spread.perShot);
    s.shotIndex++;

    // Manually cycled actions lock the weapon out until the stroke completes.
    if (cfg.cycleTime > 0 && s.ammo > 0) {
      this.activity = 'cycling';
      this.stateTimer = 0;
      this.stateDuration = cfg.cycleTime;
      this.cycleProgress = 0;
      this.hooks.onCycle(cfg);
    } else if (cfg.cycleTime > 0 && s.ammo <= 0) {
      // Empty: still work the action so the animation doesn't pop.
      this.activity = 'cycling';
      this.stateTimer = 0;
      this.stateDuration = cfg.cycleTime;
      this.cycleProgress = 0;
      this.hooks.onCycle(cfg);
    }

    return true;
  }

  private emitShots(cfg: WeaponConfig): void {
    this.hooks.getFireRay(this.tmpOrigin, this.tmpDir);
    this.tmpDir.normalize();

    // Build a basis around the aim direction for cone sampling.
    this.basisRight.crossVectors(this.tmpDir, this.worldUp);
    if (this.basisRight.lengthSq() < 1e-6) this.basisRight.set(1, 0, 0);
    this.basisRight.normalize();
    this.basisUp.crossVectors(this.basisRight, this.tmpDir).normalize();

    const spreadDeg = this.computeSpread(this.lastMoveIntensity, this.lastAirborne, this.lastCrouched);

    this.shotBuffer.length = 0;
    for (let p = 0; p < cfg.pellets; p++) {
      const cone = spreadDeg + (cfg.pellets > 1 ? cfg.pelletSpread : 0);
      this.applySpread(cone, p, cfg.pellets);
      const shot = this.traceShot(cfg, this.tmpOrigin, this.spreadDir, p);
      this.shotBuffer.push(...shot);
    }

    this.hooks.onShotFired(this.shotBuffer, cfg);
  }

  /** Samples a direction inside the spread cone. */
  private applySpread(coneDeg: number, index: number, total: number): void {
    this.spreadDir.copy(this.tmpDir);
    if (coneDeg <= 0.0001) return;

    let angle: number;
    let radius: number;
    if (total > 1) {
      // Buckshot: a ring plus jitter reads more like a real pattern than pure
      // random sampling, which tends to clump.
      const ringPos = (index / total) * Math.PI * 2 + randRange(-0.4, 0.4);
      angle = ringPos;
      radius = (index === 0 ? 0.15 : randRange(0.45, 1)) * coneDeg * DEG2RAD;
    } else {
      angle = Math.random() * Math.PI * 2;
      // Gaussian keeps most rounds near the centre of the cone.
      radius = Math.min(1.6, Math.abs(randGaussian()) * 0.45) * coneDeg * DEG2RAD;
    }

    this.spreadDir
      .addScaledVector(this.basisRight, Math.cos(angle) * radius)
      .addScaledVector(this.basisUp, Math.sin(angle) * radius)
      .normalize();
  }

  /** Casts one round, walking through penetrable surfaces. */
  private traceShot(
    cfg: WeaponConfig,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    pelletIndex: number,
  ): ShotInfo[] {
    const results: ShotInfo[] = [];
    this.ignoreList.length = 0;

    const rayOrigin = origin.clone();
    const rayDir = direction.clone();
    let travelled = 0;
    let damageScale = 1;

    for (let depth = 0; depth <= cfg.penetration; depth++) {
      const remaining = MAX_RANGE - travelled;
      if (remaining <= 0) break;

      const hit = this.hooks.raycast(rayOrigin, rayDir, remaining, this.ignoreList);

      if (!hit) {
        this.rayEnd.copy(rayOrigin).addScaledVector(rayDir, remaining);
        results.push({
          config: cfg,
          origin: origin.clone(),
          direction: rayDir.clone(),
          endPoint: this.rayEnd.clone(),
          hit: null,
          pelletIndex,
        });
        break;
      }

      const totalDistance = travelled + hit.distance;
      hit.damage = this.computeDamage(cfg, totalDistance, hit.zone) * damageScale;
      hit.penetrationDepth = depth;

      results.push({
        config: cfg,
        origin: origin.clone(),
        direction: rayDir.clone(),
        endPoint: hit.point.clone(),
        hit,
        pelletIndex,
      });

      this.hooks.onHit(hit, cfg);

      // Continue through the surface if the round has penetration left.
      if (depth >= cfg.penetration || !hit.penetrable) break;
      damageScale *= cfg.penetrationDamageScale;
      if (damageScale < 0.05) break;

      travelled = totalDistance + 0.08;
      rayOrigin.copy(hit.point).addScaledVector(rayDir, 0.08);
      this.ignoreList.push(hit.object);
    }

    return results;
  }

  private computeDamage(cfg: WeaponConfig, distance: number, zone: HitZone): number {
    let scale = 1;
    if (distance > cfg.falloffStart) {
      const t = clamp(
        (distance - cfg.falloffStart) / Math.max(0.001, cfg.falloffEnd - cfg.falloffStart),
        0,
        1,
      );
      scale = 1 + (cfg.minDamageScale - 1) * t;
    }
    const zoneMul =
      zone === 'head' ? cfg.headshotMultiplier : zone === 'limb' ? cfg.limbMultiplier : 1;
    return cfg.damage * scale * zoneMul;
  }

  private computeSpread(moveIntensity: number, airborne: boolean, crouched: boolean): number {
    const cfg = this.config;
    const s = cfg.spread;
    let spread = s.hip + (s.ads - s.hip) * this.adsProgress;
    spread += s.moving * moveIntensity * (1 - this.adsProgress * 0.5);
    if (airborne) spread += s.jumping;
    if (crouched) spread *= s.crouchScale;
    spread += this.bloom * (1 - this.adsProgress * 0.35);
    return Math.max(0, spread);
  }

  /** Recoil to apply to the camera for the shot just fired. */
  getRecoilImpulse(): { pitch: number; yaw: number; permanentPitch: number; permanentYaw: number } {
    const cfg = this.config;
    const r = cfg.recoil;
    const shot = Math.max(0, this.state.shotIndex - 1);

    let vertical: number;
    let horizontal: number;

    if (r.pattern && shot < r.pattern.length) {
      const [h, v] = r.pattern[shot];
      vertical = v * r.vertical;
      horizontal = h * r.horizontal * 2.2;
    } else {
      // Past the scripted pattern the recoil goes random but keeps climbing.
      const ramp = 1 + Math.min(0.55, shot * 0.03);
      vertical = r.vertical * ramp;
      horizontal = r.horizontal * (Math.random() < 0.5 ? -1 : 1) * ramp;
    }

    const jitter = 1 + randGaussian() * r.randomness * 0.35;
    vertical *= jitter;
    horizontal *= 1 + randGaussian() * r.randomness * 0.5;

    // Aiming tightens recoil noticeably.
    const adsScale = 1 - this.adsProgress * 0.3;
    vertical *= adsScale;
    horizontal *= adsScale;

    return {
      pitch: vertical * (1 - r.permanence),
      yaw: horizontal * (1 - r.permanence),
      permanentPitch: vertical * r.permanence,
      permanentYaw: horizontal * r.permanence,
    };
  }
}
