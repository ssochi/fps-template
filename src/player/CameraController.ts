import * as THREE from 'three';
import { Player } from './Player';
import { clamp, damp, DEG2RAD, lerp, noise1D, Spring } from '../core/MathUtils';

export type CameraMode = 'first' | 'third';

export interface CameraFrameInput {
  /** 0..1 aim-down-sights blend from the weapon system. */
  adsProgress: number;
  /** Target FOV while fully aimed. */
  adsFov: number;
  /** Multiplier applied to view bob (0 disables). */
  bobScale: number;
  /** Set while the weapon is being fired so bob freezes briefly. */
  firing: boolean;
}

const THIRD_PERSON_DISTANCE = 3.1;
const THIRD_PERSON_ADS_DISTANCE = 1.9;
const SHOULDER_OFFSET = 0.62;
const ADS_SHOULDER_OFFSET = 0.42;

/**
 * Drives the render camera in both first and third person.
 *
 * Aim angles (`aimYaw` / `aimPitch`) are authoritative for shooting: recoil is
 * folded into them so bullets always follow what the player sees, while purely
 * cosmetic motion (bob, shake, lean) is applied afterwards and never affects
 * where rounds land.
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'first';

  /** Recoil that recovers back to zero — affects aim. */
  readonly recoilPitch = new Spring(190, 20);
  readonly recoilYaw = new Spring(190, 20);

  /** Final aim angles including recoil, in radians. */
  aimYaw = 0;
  aimPitch = 0;

  baseFov = 85;
  /** Extra FOV added while sprinting. */
  sprintFovBoost = 7;

  private trauma = 0;
  private shakeTime = 0;
  private bobTime = 0;
  private bobBlend = 0;
  private readonly landDip = new Spring(120, 15);
  private readonly stepLean = new Spring(90, 12);
  private currentFov = 85;
  private lean = 0;
  private thirdPersonBlend = 0;

  private readonly desired = new THREE.Vector3();
  private readonly orbit = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly raycaster = new THREE.Raycaster();

  /** Meshes the third-person boom collides against. */
  collidables: THREE.Object3D[] = [];

  constructor(aspect: number, fov = 85) {
    this.camera = new THREE.PerspectiveCamera(fov, aspect, 0.02, 2000);
    this.camera.rotation.order = 'YXZ';
    this.baseFov = fov;
    this.currentFov = fov;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setBaseFov(fov: number): void {
    this.baseFov = fov;
  }

  toggleMode(): CameraMode {
    this.mode = this.mode === 'first' ? 'third' : 'first';
    return this.mode;
  }

  /** Adds camera-space recoil, in degrees. */
  addRecoil(pitchDeg: number, yawDeg: number): void {
    this.recoilPitch.kick(pitchDeg * DEG2RAD * 60);
    this.recoilYaw.kick(yawDeg * DEG2RAD * 60);
  }

  /** Sets how fast recoil returns to centre. */
  setRecoilRecovery(rate: number): void {
    // A stiffer spring with matched damping reads as a faster settle.
    const stiffness = 90 + rate * 22;
    this.recoilPitch.stiffness = stiffness;
    this.recoilYaw.stiffness = stiffness;
    const damping = 2 * Math.sqrt(stiffness) * 0.92;
    this.recoilPitch.damping = damping;
    this.recoilYaw.damping = damping;
  }

  /** 0..1-ish screen shake impulse. */
  addTrauma(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  onLand(fallSpeed: number): void {
    this.landDip.kick(-clamp(fallSpeed * 0.9, 1, 16));
  }

  update(dt: number, player: Player, frame: CameraFrameInput): void {
    // --- aim angles (authoritative for shooting) --------------------------
    this.recoilPitch.target = 0;
    this.recoilYaw.target = 0;
    const rPitch = this.recoilPitch.update(dt);
    const rYaw = this.recoilYaw.update(dt);

    this.aimYaw = player.yaw + rYaw;
    this.aimPitch = clamp(player.pitch + rPitch, -89 * DEG2RAD, 89 * DEG2RAD);

    // --- cosmetic motion --------------------------------------------------
    const adsDamp = 1 - frame.adsProgress * 0.85;

    // View bob.
    const targetBob = player.grounded && !player.isSliding ? player.moveIntensity : 0;
    this.bobBlend = damp(this.bobBlend, targetBob, 8, dt);
    const bobSpeed = player.sprinting ? 13.5 : 9.5;
    if (player.grounded) this.bobTime += dt * bobSpeed * (0.4 + this.bobBlend);
    const bobAmp = this.bobBlend * frame.bobScale * adsDamp * (frame.firing ? 0.4 : 1);
    const bobY = Math.sin(this.bobTime * 2) * 0.022 * bobAmp;
    const bobX = Math.sin(this.bobTime) * 0.026 * bobAmp;
    const bobRoll = Math.sin(this.bobTime) * 0.9 * DEG2RAD * bobAmp;

    // Strafe roll — subtle tilt into the direction of travel.
    const strafeDot =
      this.tmpDir.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw)).dot(
        this.tmp.set(player.velocity.x, 0, player.velocity.z).normalize(),
      ) || 0;
    const strafeRoll = -strafeDot * player.moveIntensity * 1.6 * DEG2RAD * adsDamp;

    // Slide lean.
    this.stepLean.target = player.isSliding ? 6 : 0;
    this.lean = this.stepLean.update(dt) * DEG2RAD;

    // Landing dip.
    this.landDip.target = 0;
    const dip = this.landDip.update(dt) * 0.012;

    // Trauma shake — noise-driven so it never repeats visibly.
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.shakeTime += dt * 26;
    const shake = this.trauma * this.trauma;
    const shakePitch = noise1D(this.shakeTime, 1) * shake * 1.6 * DEG2RAD;
    const shakeYaw = noise1D(this.shakeTime, 2) * shake * 1.6 * DEG2RAD;
    const shakeRoll = noise1D(this.shakeTime, 3) * shake * 2.4 * DEG2RAD;

    // --- field of view ----------------------------------------------------
    const sprintBoost = player.sprinting ? this.sprintFovBoost * player.moveIntensity : 0;
    const targetFov = lerp(this.baseFov + sprintBoost, frame.adsFov, frame.adsProgress);
    // Snappier when zooming in than out so ADS feels responsive.
    this.currentFov = damp(this.currentFov, targetFov, frame.adsProgress > 0.5 ? 16 : 12, dt);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    // --- placement --------------------------------------------------------
    player.getEyePosition(this.orbit);
    this.orbit.y += dip + bobY;

    const wantThird = this.mode === 'third' ? 1 : 0;
    this.thirdPersonBlend = damp(this.thirdPersonBlend, wantThird, 12, dt);

    this.euler.set(this.aimPitch + shakePitch, this.aimYaw + shakeYaw, 0);

    if (this.thirdPersonBlend < 0.001) {
      // Pure first person.
      this.camera.position.copy(this.orbit);
      this.camera.position.x += bobX * 0.5;
      this.euler.z = bobRoll + strafeRoll + shakeRoll + this.lean;
      this.camera.quaternion.setFromEuler(this.euler);
      return;
    }

    // Third person: an over-the-shoulder boom that pulls in on obstruction.
    const dist = lerp(THIRD_PERSON_DISTANCE, THIRD_PERSON_ADS_DISTANCE, frame.adsProgress);
    const shoulder = lerp(SHOULDER_OFFSET, ADS_SHOULDER_OFFSET, frame.adsProgress);

    this.camera.quaternion.setFromEuler(this.euler);
    const right = this.tmp.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const back = this.tmpDir.set(0, 0, 1).applyQuaternion(this.camera.quaternion);

    this.desired
      .copy(this.orbit)
      .addScaledVector(right, shoulder)
      .addScaledVector(back, dist)
      .addScaledVector(new THREE.Vector3(0, 1, 0), 0.12);

    const clamped = this.resolveBoomCollision(this.orbit, this.desired);

    // Blend between the eye position and the boom position while switching.
    this.camera.position.lerpVectors(this.orbit, clamped, this.thirdPersonBlend);
    this.euler.z = (bobRoll + strafeRoll + this.lean) * (1 - this.thirdPersonBlend) + shakeRoll;
    this.camera.quaternion.setFromEuler(this.euler);
  }

  /** Pulls the boom in so the camera never ends up inside geometry. */
  private resolveBoomCollision(origin: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    if (this.collidables.length === 0) return target;

    const dir = target.clone().sub(origin);
    const dist = dir.length();
    if (dist < 0.001) return target;
    dir.divideScalar(dist);

    this.raycaster.set(origin, dir);
    this.raycaster.far = dist + 0.2;
    this.raycaster.near = 0;
    const hits = this.raycaster.intersectObjects(this.collidables, true);
    for (const hit of hits) {
      if (hit.distance < 0.05) continue;
      // Keep a small buffer so the near plane doesn't clip into the wall.
      const safe = Math.max(0.25, hit.distance - 0.22);
      return origin.clone().addScaledVector(dir, safe);
    }
    return target;
  }

  /** World-space aim direction (recoil included, shake excluded). */
  getAimDirection(out: THREE.Vector3): THREE.Vector3 {
    return out.set(
      -Math.sin(this.aimYaw) * Math.cos(this.aimPitch),
      Math.sin(this.aimPitch),
      -Math.cos(this.aimYaw) * Math.cos(this.aimPitch),
    );
  }

  reset(): void {
    this.recoilPitch.reset();
    this.recoilYaw.reset();
    this.landDip.reset();
    this.stepLean.reset();
    this.trauma = 0;
    this.bobBlend = 0;
  }
}
