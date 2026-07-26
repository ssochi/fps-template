import * as THREE from 'three';
import { CollisionWorld, type Collider } from '../physics/CollisionWorld';
import { buildVehicle, type VehicleId, type VehicleParts } from '../world/Vehicles';
import { mergeStaticHierarchy } from '../world/GeometryMerge';
import type { VehicleSpawn } from '../world/LevelBuilder';
import {
  GUN_MAX_PITCH,
  GUN_MIN_PITCH,
  TURRET_ELEVATION_RATE,
  TURRET_TRAVERSE_RATE,
  VEHICLE_CONFIGS,
  type VehicleConfig,
} from './VehicleConfigs';
import { clamp, damp } from '../core/MathUtils';

/**
 * Drivable vehicles.
 *
 * Each instance keeps a single forward speed scalar and a yaw; there is no
 * rigid-body solver. Wheeled vehicles turn with a bicycle model (yaw rate =
 * speed · tan(steer) / wheelbase), tracked ones skid-steer and can pivot on the
 * spot. Both are moved through the shared AABB collision world by `moveBox`,
 * with a step height generous enough to drive over kerbs and the garage
 * threshold.
 *
 * A parked vehicle owns a collider so the player bumps into it; the one being
 * driven has its collider emptied, because it must not collide with itself.
 */

/**
 * Models are built nose-`+Z`, but heading yaw follows the *player's* look
 * convention, where yaw 0 faces `-Z` (see `CameraController.getAimDirection`).
 * The two are therefore always half a turn apart.
 *
 * Sharing the player's convention is what lets a turret be driven straight from
 * `aimYaw` with no offset — the earlier mismatch pointed every turret, torso and
 * chase camera exactly backwards. `MODEL_YAW_OFFSET` is applied in the one place
 * that writes a model transform, and nowhere else.
 */
const MODEL_YAW_OFFSET = Math.PI;

/** World-space forward for a heading yaw. */
function forwardFromYaw(yaw: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

const GRAVITY = 22;
const SHELL_GRAVITY = 9.81;
const SHELL_LIFE = 8;
const MAX_SHELLS = 8;

export interface VehicleInput {
  /** -1 (reverse / brake) .. 1 (throttle). */
  throttle: number;
  /** -1 (right) .. 1 (left). */
  steer: number;
  handbrake: boolean;
  /** Held, for automatic weapons. */
  fireHeld: boolean;
  /** Edge-triggered secondary — the mech's missile barrage. */
  secondaryPressed: boolean;
  /** Where the player is looking; drives the tank turret. */
  aimYaw: number;
  aimPitch: number;
  firePressed: boolean;
}

export interface VehicleHooks {
  /** One hitscan burst from a mech arm cannon. */
  onMechCannon: (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    config: VehicleConfig,
  ) => void;
  /** A missile salvo left the shoulder pods. */
  onBarrage: (position: THREE.Vector3, config: VehicleConfig) => void;
  /** A foot hit the ground. `hard` is the stride speed, 0..1. */
  onFootfall: (position: THREE.Vector3, hard: number) => void;
  /** A shell reached the end of its flight. */
  onShellImpact: (
    position: THREE.Vector3,
    payload: { damage: number; blastRadius: number },
  ) => void;
  onCannonFire: (position: THREE.Vector3, config: VehicleConfig) => void;
  /** Hit something at speed; `impact` is the speed lost, m/s. */
  onCollide: (instance: VehicleInstance, impact: number) => void;
  /** Meshes shells are traced against. */
  getCollidables: () => THREE.Object3D[];
}

export interface VehicleInstance {
  id: VehicleId;
  config: VehicleConfig;
  root: THREE.Group;
  parts: VehicleParts;
  /** Ground-contact origin, matching the model's own origin. */
  position: THREE.Vector3;
  yaw: number;
  /** Signed forward speed, m/s. */
  speed: number;
  /** Current steering angle, radians. */
  steer: number;
  verticalVelocity: number;
  grounded: boolean;
  /** World-space turret heading and gun elevation (tank only). */
  turretYaw: number;
  gunPitch: number;
  reload: number;
  occupied: boolean;
  /** Cosmetic body lean. */
  bodyPitch: number;
  bodyRoll: number;
  /** Distance walked, drives the stride phase. */
  stride: number;
  /** Body dip from the walk cycle, metres. Applied by `applyTransform`. */
  bobOffset: number;
  /** Which barrel fires next; the four cycle so recoil reads as alternating. */
  nextBarrel: number;
  cannonCooldown: number;
  barrageCooldown: number;
  /** Per-leg record of which half of the stride it was in last frame. */
  legPlanted: boolean[];
  collider: Collider;
  driverEye: THREE.Vector3;
  cameraPivot: THREE.Vector3;
  exitOffset: THREE.Vector3;
  interactRadius: number;
}

interface Shell {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  mesh: THREE.Mesh;
  config: VehicleConfig;
  /** What it does on impact — the tank shell and a Javelin differ. */
  payload: { damage: number; blastRadius: number };
}

export class VehicleSystem {
  readonly group = new THREE.Group();
  readonly instances: VehicleInstance[] = [];

  /** The vehicle the player is currently driving, if any. */
  driving: VehicleInstance | null = null;

  private readonly world: CollisionWorld;
  private readonly hooks: VehicleHooks;
  private readonly shells: Shell[] = [];
  private readonly shellGeometry: THREE.SphereGeometry;
  private readonly shellMaterial: THREE.MeshStandardMaterial;

  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly raycaster = new THREE.Raycaster();

  constructor(world: CollisionWorld, hooks: VehicleHooks) {
    this.world = world;
    this.hooks = hooks;
    this.group.name = 'vehicles';
    this.shellGeometry = new THREE.SphereGeometry(0.12, 10, 8);
    this.shellMaterial = new THREE.MeshStandardMaterial({
      color: 0x30261a,
      emissive: 0xff8a2a,
      emissiveIntensity: 1.4,
      roughness: 0.5,
    });
  }

  // ------------------------------------------------------------------ setup

  spawnAll(spawns: readonly VehicleSpawn[]): void {
    for (const spawn of spawns) this.spawn(spawn);
  }

  private spawn(spawn: VehicleSpawn): void {
    const built = buildVehicle(spawn.id);
    const config = VEHICLE_CONFIGS[spawn.id];

    // The hull never deforms, so flatten it to one mesh per material. The
    // wheels and turret stay as they are — they have to keep moving.
    const flatBody = mergeStaticHierarchy(built.parts.body, `${spawn.id}-body`);
    built.root.remove(built.parts.body);
    built.root.add(flatBody);
    built.parts.body = flatBody;
    for (const wheel of built.parts.wheels) {
      const merged = mergeStaticHierarchy(wheel.spinner, `${spawn.id}-wheel`);
      wheel.spinner.clear();
      wheel.spinner.add(merged);
    }

    // A mech is nothing but joints, so flatten each one's own plates rather
    // than the hull as a whole — merging the lot would weld the legs shut.
    if (built.parts.mech) this.flattenArticulated(built.root, `${spawn.id}-part`);

    built.root.rotation.order = 'YXZ';
    built.root.position.copy(spawn.position);
    built.root.rotation.y = spawn.yaw + MODEL_YAW_OFFSET;
    this.group.add(built.root);

    const instance: VehicleInstance = {
      id: spawn.id,
      config,
      root: built.root,
      parts: built.parts,
      position: spawn.position.clone(),
      yaw: spawn.yaw,
      speed: 0,
      steer: 0,
      verticalVelocity: 0,
      grounded: true,
      // Resting traverse, so a parked tank is not a mirror-symmetric slab.
      turretYaw: spawn.yaw - 0.22,
      gunPitch: 0,
      reload: 0,
      occupied: false,
      bodyPitch: 0,
      bodyRoll: 0,
      stride: 0,
      bobOffset: 0,
      nextBarrel: 0,
      cannonCooldown: 0,
      barrageCooldown: 0,
      legPlanted: (built.parts.mech?.legs ?? []).map(() => true),
      collider: this.world.addBox(new THREE.Vector3(), new THREE.Vector3(1, 1, 1), 'metal'),
      driverEye: built.driverEye,
      cameraPivot: built.cameraPivot,
      exitOffset: built.exitOffset,
      interactRadius: Math.max(built.size.x, built.size.z) * 0.6 + 1.4,
    };
    this.instances.push(instance);
    this.syncCollider(instance);
    this.applyTransform(instance);
  }

  /**
   * Merges each group's *direct* mesh children in place, leaving nested groups
   * — the joints — untouched. A whole-hierarchy merge would collapse the
   * articulation along with the geometry.
   */
  private flattenArticulated(root: THREE.Object3D, name: string): void {
    const groups: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) groups.push(o);
    });
    for (const group of groups) {
      const meshes = group.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
      if (meshes.length < 2) continue;
      const holder = new THREE.Group();
      for (const mesh of [...meshes]) holder.add(mesh);
      // `holder` sits at identity, so the merged geometry lands back in the
      // joint's own local space.
      const merged = mergeStaticHierarchy(holder, name);
      group.add(merged);
    }
  }

  /** Tears everything down; used when swapping levels. */
  clear(): void {
    for (const instance of this.instances) {
      this.world.removeCollider(instance.collider);
      instance.root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry?.dispose();
      });
    }
    this.instances.length = 0;
    this.driving = null;
    for (const shell of this.shells) this.group.remove(shell.mesh);
    this.shells.length = 0;
    this.group.clear();
  }

  // ------------------------------------------------------------- enter/exit

  /** The nearest vehicle the player could get into, or null. */
  nearest(position: THREE.Vector3): VehicleInstance | null {
    let best: VehicleInstance | null = null;
    let bestDist = Infinity;
    for (const instance of this.instances) {
      const d = position.distanceTo(instance.position);
      if (d < instance.interactRadius && d < bestDist) {
        best = instance;
        bestDist = d;
      }
    }
    return best;
  }

  enter(instance: VehicleInstance): void {
    this.driving = instance;
    instance.occupied = true;
    // A vehicle must not collide with its own registered box.
    instance.collider.box.makeEmpty();
  }

  /** @returns the world position the player should be placed at. */
  exit(): THREE.Vector3 | null {
    const instance = this.driving;
    if (!instance) return null;
    instance.occupied = false;
    instance.speed = 0;
    this.syncCollider(instance);
    this.driving = null;

    // `exitOffset` is a model-space offset, so it turns with the model.
    const offset = instance.exitOffset
      .clone()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), instance.yaw + MODEL_YAW_OFFSET);
    const spot = instance.position.clone().add(offset);
    spot.y += 0.2;
    return spot;
  }

  // ----------------------------------------------------------------- update

  update(dt: number, input: VehicleInput | null): void {
    const active = this.driving;
    if (active && input) {
      this.drive(active, dt, input);
      this.spinWheels(active, dt);
    }
    for (const instance of this.instances) this.applyTransform(instance);
    this.updateShells(dt);
  }

  private drive(v: VehicleInstance, dt: number, input: VehicleInput): void {
    const c = v.config;

    // --- longitudinal ------------------------------------------------------
    const throttle = clamp(input.throttle, -1, 1);
    if (throttle > 0.01) {
      v.speed += c.accel * throttle * dt;
    } else if (throttle < -0.01) {
      // S brakes while rolling forward, then becomes reverse.
      if (v.speed > 0.3) v.speed -= c.brake * dt;
      else v.speed -= c.accel * 0.7 * dt;
    } else {
      const roll = Math.min(Math.abs(v.speed), c.rollingResistance * dt);
      v.speed -= Math.sign(v.speed) * roll;
    }
    if (input.handbrake) {
      const stop = Math.min(Math.abs(v.speed), c.brake * 0.9 * dt);
      v.speed -= Math.sign(v.speed) * stop;
    }
    v.speed -= v.speed * c.drag * dt;
    v.speed = clamp(v.speed, -c.maxReverse, c.maxSpeed);

    // --- steering ----------------------------------------------------------
    let yawRate: number;
    if (c.tracked) {
      // Skid steer: full authority at a standstill, so it can pivot in place.
      v.steer = damp(v.steer, input.steer, 8, dt);
      const mobility = 0.45 + 0.55 * Math.min(1, Math.abs(v.speed) / (c.maxSpeed * 0.5));
      yawRate = v.steer * c.turnRate * mobility;
    } else {
      const target = input.steer * c.maxSteer;
      const rate = c.steerRate * (Math.abs(target) > Math.abs(v.steer) ? 1 : 1.8);
      v.steer = damp(v.steer, target, rate, dt);
      // Authority falls off with speed, otherwise it darts at 250 km/h.
      const effective = v.steer / (1 + Math.abs(v.speed) * c.steerFalloff);
      const slip = input.handbrake ? 1 - c.handbrakeSlip : 1;
      yawRate = (v.speed / c.wheelbase) * Math.tan(effective) * slip;
    }
    v.yaw += yawRate * dt;

    // --- integrate ---------------------------------------------------------
    const forward = forwardFromYaw(v.yaw, this.tmpVec);
    v.verticalVelocity -= GRAVITY * dt;

    const centre = this.tmpVec2.copy(v.position);
    centre.y += c.centreY;
    const displacement = new THREE.Vector3(
      forward.x * v.speed * dt,
      v.verticalVelocity * dt,
      forward.z * v.speed * dt,
    );

    const half = this.rotatedHalf(c, v.yaw);
    const before = v.speed;

    // Sub-step the move. At 280 km/h a single 1/120 s frame covers 0.65 m,
    // which is further than a barrier is thick: the vehicle would tunnel
    // straight through it and then be resolved onto its roof by gravity.
    const reach = Math.hypot(displacement.x, displacement.z);
    const subSteps = Math.min(8, Math.max(1, Math.ceil(reach / 0.28)));
    const sub = displacement.divideScalar(subSteps);
    const result = { grounded: false, hitWall: false, groundSurface: 'dirt' as const };
    for (let i = 0; i < subSteps; i++) {
      // Step height is deliberately small: enough to ride a kerb (90 mm) and
      // the garage threshold (160 mm), nowhere near enough to climb a barrier.
      const step = this.world.moveBox(centre, sub, half, 0.22, v.collider);
      if (step.grounded) result.grounded = true;
      if (step.hitWall) {
        result.hitWall = true;
        break;
      }
    }

    if (result.grounded) {
      v.verticalVelocity = 0;
      v.grounded = true;
    } else {
      v.grounded = false;
    }
    if (result.hitWall) {
      // Scrub most of the speed off rather than stopping dead — a glancing
      // hit on the armco should cost you time, not end the lap.
      v.speed *= 0.35;
      const impact = Math.abs(before - v.speed);
      if (impact > 3) this.hooks.onCollide(v, impact);
    }

    v.position.set(centre.x, centre.y - c.centreY, centre.z);

    // --- turret / torso ----------------------------------------------------
    if (v.parts.turret) {
      v.turretYaw = approachAngle(v.turretYaw, input.aimYaw, TURRET_TRAVERSE_RATE * dt);
      const wanted = clamp(input.aimPitch, GUN_MIN_PITCH, GUN_MAX_PITCH);
      v.gunPitch += clamp(wanted - v.gunPitch, -TURRET_ELEVATION_RATE * dt, TURRET_ELEVATION_RATE * dt);
    }
    if (c.mech) {
      // The torso leads the aim but is limited relative to the chassis, so the
      // legs have to come round for anything behind the mech.
      const limited = clampAngleAround(input.aimYaw, v.yaw, c.mech.torsoTwist);
      v.turretYaw = approachAngle(v.turretYaw, limited, c.mech.twistRate * dt);
      const wanted = clamp(input.aimPitch, -0.45, 0.7);
      v.gunPitch += clamp(wanted - v.gunPitch, -c.mech.elevateRate * dt, c.mech.elevateRate * dt);
      this.updateStride(v, dt);
    }

    v.reload = Math.max(0, v.reload - dt);
    v.cannonCooldown = Math.max(0, v.cannonCooldown - dt);
    v.barrageCooldown = Math.max(0, v.barrageCooldown - dt);

    if (c.cannon && v.parts.muzzle) {
      if (input.firePressed && v.reload <= 0) this.fireCannon(v);
    } else if (c.mech) {
      if (input.fireHeld && v.cannonCooldown <= 0) this.fireMechCannon(v);
      if (input.secondaryPressed && v.barrageCooldown <= 0) this.fireBarrage(v);
    }

    // --- cosmetic body lean -------------------------------------------------
    const accelSignal = (v.speed - before) / Math.max(dt, 1e-4);
    v.bodyPitch = damp(v.bodyPitch, clamp(-accelSignal * c.bodyPitchGain, -0.09, 0.09), 6, dt);
    v.bodyRoll = damp(v.bodyRoll, clamp(-yawRate * v.speed * c.bodyRollGain, -0.16, 0.16), 6, dt);
  }

  /** AABB half extents covering the vehicle's rotated footprint. */
  private rotatedHalf(config: VehicleConfig, yaw: number): THREE.Vector3 {
    const cos = Math.abs(Math.cos(yaw));
    const sin = Math.abs(Math.sin(yaw));
    return new THREE.Vector3(
      config.half.x * cos + config.half.z * sin,
      config.half.y,
      config.half.z * cos + config.half.x * sin,
    );
  }

  private syncCollider(v: VehicleInstance): void {
    const half = this.rotatedHalf(v.config, v.yaw);
    const cy = v.position.y + v.config.centreY;
    v.collider.box.min.set(v.position.x - half.x, cy - half.y, v.position.z - half.z);
    v.collider.box.max.set(v.position.x + half.x, cy + half.y, v.position.z + half.z);
  }

  private applyTransform(v: VehicleInstance): void {
    v.root.position.copy(v.position);
    v.root.position.y += v.bobOffset;
    v.root.rotation.set(v.bodyPitch, v.yaw + MODEL_YAW_OFFSET, v.bodyRoll);

    if (!v.occupied) this.syncCollider(v);

    for (const wheel of v.parts.wheels) {
      if (wheel.steered) wheel.pivot.rotation.y = v.steer;
    }

    if (v.parts.turret) v.parts.turret.rotation.y = v.turretYaw - v.yaw;
    if (v.parts.barrel) v.parts.barrel.rotation.x = -v.gunPitch;

    const mech = v.parts.mech;
    if (mech) {
      mech.torso.rotation.y = v.turretYaw - v.yaw;
      mech.arms.rotation.x = -v.gunPitch;
    }
  }

  /** Rolls the wheels at their contact speed. Needs the timestep, so it is
   * kept out of `applyTransform`, which only writes poses. */
  private spinWheels(v: VehicleInstance, dt: number): void {
    for (const wheel of v.parts.wheels) {
      wheel.spinner.rotation.x += (v.speed / wheel.radius) * dt;
    }
  }

  // ------------------------------------------------------------ locomotion

  /**
   * The walk cycle.
   *
   * Phase is driven by distance travelled rather than by time, so the legs
   * always match the ground however the speed changes — no foot skating. Each
   * leg swings through the first half of its cycle and pushes through the
   * second; the ankle subtracts its parents' angles so the sole stays flat, and
   * the body dips once per footfall.
   *
   * When the mech is standing still the phase is held and the legs settle into
   * a braced neutral stance instead of freezing mid-step.
   */
  private updateStride(v: VehicleInstance, dt: number): void {
    const mech = v.parts.mech;
    const spec = v.config.mech;
    if (!mech || !spec) return;

    v.stride += Math.abs(v.speed) * dt;
    const moving = clamp(Math.abs(v.speed) / 1.2, 0, 1);
    const cycle = v.stride / spec.strideLength;

    let bob = 0;
    for (let i = 0; i < mech.legs.length; i++) {
      const leg = mech.legs[i];
      const p = (cycle + leg.phase) % 1;
      const a = p * Math.PI * 2;

      // Hip forward at quarter phase, back at three-quarters.
      const hipAngle = Math.sin(a) * spec.hipSwing * moving;
      // Knee folds through the swing half only.
      const kneeAngle = 0.16 + Math.max(0, Math.sin(a)) * spec.kneeBend * moving;
      leg.hip.rotation.x = hipAngle;
      leg.knee.rotation.x = kneeAngle;
      // Keep the sole level with the ground whatever the leg is doing.
      leg.ankle.rotation.x = -(hipAngle + kneeAngle) + 0.16;

      bob += Math.max(0, -Math.cos(a));

      // A foot plants as its swing half ends.
      const planted = p >= 0.5;
      if (planted && !v.legPlanted[i] && moving > 0.05) {
        // Offset to roughly where that foot is: forward, and out to its side.
        forwardFromYaw(v.yaw + (i === 0 ? 0.35 : -0.35), this.tmpVec)
          .multiplyScalar(1.5)
          .add(v.position);
        this.hooks.onFootfall(this.tmpVec.clone(), moving);
      }
      v.legPlanted[i] = planted;
    }

    // Two legs, so the body dips twice per stride. Stored rather than written
    // straight to the transform, which `applyTransform` would overwrite.
    v.bobOffset = -(bob / mech.legs.length) * spec.bob * moving;
  }

  // ---------------------------------------------------------------- gunnery

  /** One round from the next arm barrel in the rotation. */
  private fireMechCannon(v: VehicleInstance): void {
    const mech = v.parts.mech;
    const spec = v.config.mech;
    if (!mech || !spec || mech.muzzles.length === 0) return;

    const muzzle = mech.muzzles[v.nextBarrel % mech.muzzles.length];
    v.nextBarrel++;
    muzzle.updateWorldMatrix(true, false);
    const origin = muzzle.getWorldPosition(new THREE.Vector3());
    const direction = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(muzzle.getWorldQuaternion(this.tmpQuat))
      .normalize();

    // Spread is applied by the hook, which converges the barrels on the aim
    // point first — a barrel-axis cone would be spread about the wrong line.
    v.cannonCooldown = 60 / spec.cannon.rpm;
    this.hooks.onMechCannon(origin, direction, v.config);
  }

  /** A full salvo out of both shoulder pods. */
  private fireBarrage(v: VehicleInstance): void {
    const mech = v.parts.mech;
    const spec = v.config.mech;
    if (!mech || !spec || mech.podMuzzles.length === 0) return;

    for (let i = 0; i < spec.barrage.count; i++) {
      const pod = mech.podMuzzles[i % mech.podMuzzles.length];
      pod.updateWorldMatrix(true, false);
      const origin = pod.getWorldPosition(new THREE.Vector3());
      const direction = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(pod.getWorldQuaternion(this.tmpQuat))
        .normalize();
      direction.x += (Math.random() - 0.5) * spec.barrage.spread * 2;
      direction.y += (Math.random() - 0.5) * spec.barrage.spread + 0.06;
      direction.normalize();
      this.spawnProjectile(origin, direction.multiplyScalar(spec.barrage.speed), v.config, {
        damage: spec.barrage.damage,
        blastRadius: spec.barrage.blastRadius,
      });
    }
    v.barrageCooldown = spec.barrage.cooldown;
    mech.podMuzzles[0].updateWorldMatrix(true, false);
    this.hooks.onBarrage(mech.podMuzzles[0].getWorldPosition(new THREE.Vector3()), v.config);
  }


  private fireCannon(v: VehicleInstance): void {
    const cannon = v.config.cannon;
    const muzzle = v.parts.muzzle;
    if (!cannon || !muzzle) return;

    muzzle.updateWorldMatrix(true, false);
    const origin = muzzle.getWorldPosition(new THREE.Vector3());
    const direction = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(muzzle.getWorldQuaternion(this.tmpQuat))
      .normalize();

    this.spawnProjectile(origin, direction.clone().multiplyScalar(cannon.speed), v.config, {
      damage: cannon.damage,
      blastRadius: cannon.blastRadius,
    });

    v.reload = cannon.reload;
    // Recoil shoves the hull back along the barrel.
    v.speed -= cannon.recoil * Math.max(0, direction.dot(forwardFromYaw(v.yaw, this.tmpVec2)));
    this.hooks.onCannonFire(origin, v.config);
  }

  /** Adds a ballistic round to the shared projectile pool. */
  private spawnProjectile(
    origin: THREE.Vector3,
    velocity: THREE.Vector3,
    config: VehicleConfig,
    payload: { damage: number; blastRadius: number },
  ): void {
    if (this.shells.length >= MAX_SHELLS) {
      const oldest = this.shells.shift();
      if (oldest) this.group.remove(oldest.mesh);
    }
    const mesh = new THREE.Mesh(this.shellGeometry, this.shellMaterial);
    mesh.position.copy(origin);
    this.group.add(mesh);
    this.shells.push({
      position: origin.clone(),
      velocity: velocity.clone(),
      life: SHELL_LIFE,
      mesh,
      config,
      payload,
    });
  }

  private updateShells(dt: number): void {
    const collidables = this.hooks.getCollidables();

    for (let i = this.shells.length - 1; i >= 0; i--) {
      const shell = this.shells[i];
      shell.velocity.y -= SHELL_GRAVITY * dt;

      const step = this.tmpVec.copy(shell.velocity).multiplyScalar(dt);
      const distance = step.length();
      let impact: THREE.Vector3 | null = null;

      if (distance > 1e-4 && collidables.length > 0) {
        this.raycaster.set(shell.position, this.tmpVec2.copy(step).divideScalar(distance));
        this.raycaster.near = 0;
        this.raycaster.far = distance;
        const hit = this.raycaster.intersectObjects(collidables, false)[0];
        if (hit) impact = hit.point.clone();
      }

      shell.position.add(step);
      shell.mesh.position.copy(shell.position);
      shell.life -= dt;

      if (!impact && shell.position.y < 0) {
        impact = shell.position.clone();
        impact.y = 0;
      }
      if (impact || shell.life <= 0) {
        this.hooks.onShellImpact(impact ?? shell.position.clone(), shell.payload);
        this.group.remove(shell.mesh);
        this.shells.splice(i, 1);
      }
    }
  }

  get shellCount(): number {
    return this.shells.length;
  }

  dispose(): void {
    this.clear();
    this.shellGeometry.dispose();
    this.shellMaterial.dispose();
  }
}

/** Wraps `angle` into `centre ± limit`, the short way round. */
function clampAngleAround(angle: number, centre: number, limit: number): number {
  let delta = (angle - centre) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return centre + clamp(delta, -limit, limit);
}

/** Moves `current` toward `target` by at most `maxStep`, the short way round. */
function approachAngle(current: number, target: number, maxStep: number): number {
  let delta = (target - current) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return current + clamp(delta, -maxStep, maxStep);
}
