import * as THREE from 'three';
import { buildWeaponModel, type WeaponModel } from '../weapons/WeaponMeshes';
import type { WeaponConfig, WeaponId } from '../weapons/WeaponTypes';
import { clamp, damp, dampAngle, DEG2RAD, lerp, Spring } from '../core/MathUtils';

/**
 * Third-person character.
 *
 * A primitive-built humanoid animated entirely in code: a phase-driven walk /
 * run cycle for the legs, an upper body that twists toward the aim direction
 * independently of the hips, and two-bone IK arms that keep both hands welded
 * to the weapon's grip and fore-end anchors no matter which gun is equipped.
 */

export interface CharacterFrame {
  position: THREE.Vector3;
  aimYaw: number;
  aimPitch: number;
  /** Horizontal velocity in world space. */
  velocity: THREE.Vector3;
  speed: number;
  moveIntensity: number;
  grounded: boolean;
  sprinting: boolean;
  crouchAmount: number;
  sliding: boolean;
  /** 0..1 aim blend. */
  ads: number;
  alive: boolean;
  /** 0..1 reload progress, or -1. */
  reloadProgress: number;
  /** 0..1 action-cycle progress, or -1. */
  cycleProgress: number;
}

const UPPER_ARM = 0.3;
const LOWER_ARM = 0.29;
const DOWN = new THREE.Vector3(0, -1, 0);

function makeMaterials(): {
  skin: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  clothDark: THREE.MeshStandardMaterial;
  vest: THREE.MeshStandardMaterial;
  glove: THREE.MeshStandardMaterial;
  helmet: THREE.MeshStandardMaterial;
  visor: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  rubberBoot: THREE.MeshStandardMaterial;
} {
  return {
    skin: new THREE.MeshStandardMaterial({ color: 0xb98763, roughness: 0.85 }),
    cloth: new THREE.MeshStandardMaterial({ color: 0x4a5140, roughness: 0.92 }),
    clothDark: new THREE.MeshStandardMaterial({ color: 0x343a30, roughness: 0.94 }),
    vest: new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: 0.78, metalness: 0.08 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.75 }),
    helmet: new THREE.MeshStandardMaterial({ color: 0x3b4038, roughness: 0.6, metalness: 0.15 }),
    visor: new THREE.MeshStandardMaterial({
      color: 0x11161c,
      roughness: 0.15,
      metalness: 0.7,
      emissive: 0x0a2028,
      emissiveIntensity: 0.5,
    }),
    accent: new THREE.MeshStandardMaterial({ color: 0x8a6b3a, roughness: 0.8 }),
    rubberBoot: new THREE.MeshStandardMaterial({ color: 0x191b1e, roughness: 0.95 }),
  };
}

function limb(
  parent: THREE.Object3D,
  mat: THREE.Material,
  radius: number,
  length: number,
  taper = 1,
): THREE.Mesh {
  // Limb meshes hang from the joint down the -Y axis.
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 4, 10);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -length / 2;
  mesh.scale.set(1, 1, taper);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export class CharacterModel {
  readonly root = new THREE.Group();

  private readonly hips = new THREE.Group();
  private readonly spine = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();

  private readonly shoulderR = new THREE.Group();
  private readonly upperArmR = new THREE.Group();
  private readonly lowerArmR = new THREE.Group();
  private readonly handR = new THREE.Group();

  private readonly shoulderL = new THREE.Group();
  private readonly upperArmL = new THREE.Group();
  private readonly lowerArmL = new THREE.Group();
  private readonly handL = new THREE.Group();

  private readonly thighR = new THREE.Group();
  private readonly shinR = new THREE.Group();
  private readonly footR = new THREE.Group();
  private readonly thighL = new THREE.Group();
  private readonly shinL = new THREE.Group();
  private readonly footL = new THREE.Group();

  private readonly weaponMount = new THREE.Group();

  /** Parts hidden while in first person (legs stay visible). */
  private readonly upperBodyParts: THREE.Object3D[] = [];

  private model: WeaponModel | null = null;
  private currentWeapon: WeaponId | null = null;
  private readonly modelCache = new Map<WeaponId, WeaponModel>();

  private bodyYaw = 0;
  private walkPhase = 0;
  private readonly recoilSpring = new Spring(160, 16);
  private leanSpring = new Spring(60, 12);
  private aimPitchSmooth = 0;
  private turnBlend = 0;
  private fireBlend = 0;
  private deathTimer = 0;

  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpQuat2 = new THREE.Quaternion();
  private readonly poleR = new THREE.Vector3();
  private readonly poleL = new THREE.Vector3();

  showUpperBody = true;

  constructor() {
    this.root.name = 'character';
    this.build();
  }

  private build(): void {
    const m = makeMaterials();

    // --- torso chain ------------------------------------------------------
    this.hips.position.y = 0.98;
    this.root.add(this.hips);

    const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.1, 4, 12), m.cloth);
    pelvis.scale.set(1.15, 1, 0.8);
    pelvis.castShadow = true;
    this.hips.add(pelvis);

    this.spine.position.y = 0.1;
    this.hips.add(this.spine);

    this.chest.position.y = 0.18;
    this.spine.add(this.chest);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.24, 4, 12), m.cloth);
    torso.position.y = 0.06;
    torso.scale.set(1.25, 1, 0.78);
    torso.castShadow = true;
    torso.receiveShadow = true;
    this.chest.add(torso);

    // Plate carrier.
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.34, 0.26), m.vest);
    vest.position.set(0, 0.06, 0);
    vest.castShadow = true;
    this.chest.add(vest);
    for (let i = 0; i < 3; i++) {
      const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.06), m.clothDark);
      pouch.position.set(-0.1 + i * 0.1, -0.05, -0.15);
      pouch.castShadow = true;
      this.chest.add(pouch);
    }
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.28), m.accent);
    strap.position.set(0, 0.2, 0);
    this.chest.add(strap);

    // Radio on the left chest strap, with a stubby antenna.
    const radio = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.05), m.clothDark);
    radio.position.set(-0.16, 0.14, -0.14);
    radio.castShadow = true;
    this.chest.add(radio);
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.22, 6), m.clothDark);
    antenna.position.set(-0.16, 0.3, -0.13);
    antenna.rotation.z = 0.18;
    this.chest.add(antenna);

    // Admin pouch and a sheathed knife on the plate carrier.
    const admin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.11, 0.05), m.clothDark);
    admin.position.set(0.11, 0.14, -0.15);
    admin.castShadow = true;
    this.chest.add(admin);
    const knife = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.17, 0.03), m.vest);
    knife.position.set(-0.19, -0.02, -0.1);
    knife.rotation.z = 0.25;
    this.chest.add(knife);

    // Shoulder patch.
    const patch = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.01), m.accent);
    patch.position.set(0.19, 0.17, -0.09);
    this.chest.add(patch);

    // --- head -------------------------------------------------------------
    this.neck.position.y = 0.24;
    this.chest.add(this.neck);
    const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.07, 10), m.skin);
    neckMesh.position.y = 0.03;
    this.neck.add(neckMesh);

    this.head.position.y = 0.08;
    this.neck.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.105, 16, 14), m.skin);
    skull.scale.set(0.92, 1.05, 1);
    skull.position.y = 0.08;
    skull.castShadow = true;
    this.head.add(skull);

    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.122, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), m.helmet);
    helmet.position.y = 0.085;
    helmet.castShadow = true;
    this.head.add(helmet);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.02), m.visor);
    visor.position.set(0, 0.085, -0.1);
    this.head.add(visor);

    // Helmet rails, NVG shroud and an IR strobe.
    for (const sign of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.14), m.clothDark);
      rail.position.set(sign * 0.115, 0.095, 0);
      this.head.add(rail);
    }
    const shroud = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.04), m.clothDark);
    shroud.position.set(0, 0.13, -0.095);
    this.head.add(shroud);
    const strobe = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.02, 0.03),
      new THREE.MeshStandardMaterial({
        color: 0x141414,
        emissive: 0x1e6b2a,
        emissiveIntensity: 1.6,
        roughness: 0.5,
      }),
    );
    strobe.position.set(0, 0.135, 0.085);
    this.head.add(strobe);

    // --- arms -------------------------------------------------------------
    this.shoulderR.position.set(0.21, 0.19, 0);
    this.chest.add(this.shoulderR);
    this.shoulderR.add(this.upperArmR);
    limb(this.upperArmR, m.cloth, 0.058, UPPER_ARM);
    this.upperArmR.add(this.lowerArmR);
    this.lowerArmR.position.y = -UPPER_ARM;
    limb(this.lowerArmR, m.cloth, 0.05, LOWER_ARM);
    this.lowerArmR.add(this.handR);
    this.handR.position.y = -LOWER_ARM;
    const fistR = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.08), m.glove);
    fistR.position.y = -0.03;
    fistR.castShadow = true;
    this.handR.add(fistR);

    this.shoulderL.position.set(-0.21, 0.19, 0);
    this.chest.add(this.shoulderL);
    this.shoulderL.add(this.upperArmL);
    limb(this.upperArmL, m.cloth, 0.058, UPPER_ARM);
    this.upperArmL.add(this.lowerArmL);
    this.lowerArmL.position.y = -UPPER_ARM;
    limb(this.lowerArmL, m.cloth, 0.05, LOWER_ARM);
    this.lowerArmL.add(this.handL);
    this.handL.position.y = -LOWER_ARM;
    const fistL = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.08), m.glove);
    fistL.position.y = -0.03;
    fistL.castShadow = true;
    this.handL.add(fistL);

    // Shoulder pads sit on the chest so they don't rotate with the IK arms.
    for (const sign of [-1, 1]) {
      const pad = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10), m.vest);
      pad.position.set(sign * 0.21, 0.185, 0);
      pad.scale.set(1, 0.85, 1);
      pad.castShadow = true;
      this.chest.add(pad);
    }

    // --- belt kit ---------------------------------------------------------
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.07, 14), m.clothDark);
    belt.scale.set(1.1, 1, 0.85);
    belt.position.y = 0.02;
    belt.castShadow = true;
    this.hips.add(belt);
    for (let i = 0; i < 4; i++) {
      const a = -0.9 + i * 0.6;
      const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.06), m.clothDark);
      pouch.position.set(Math.sin(a) * 0.2, -0.02, Math.cos(a) * 0.17);
      pouch.rotation.y = a;
      pouch.castShadow = true;
      this.hips.add(pouch);
    }
    // Drop-leg holster on the right thigh.
    const holster = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.07), m.vest);
    holster.position.set(0.15, -0.24, 0.02);
    holster.castShadow = true;
    this.hips.add(holster);
    const holsterStrap = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.18, 0.03), m.accent);
    holsterStrap.position.set(0.15, -0.12, 0.02);
    this.hips.add(holsterStrap);

    // --- legs -------------------------------------------------------------
    const legLen = 0.46;
    const shinLen = 0.45;
    for (const [thigh, shin, foot, sign] of [
      [this.thighR, this.shinR, this.footR, 1],
      [this.thighL, this.shinL, this.footL, -1],
    ] as const) {
      thigh.position.set(sign * 0.11, -0.06, 0);
      this.hips.add(thigh);
      limb(thigh, m.cloth, 0.078, legLen);
      thigh.add(shin);
      shin.position.y = -legLen;
      limb(shin, m.clothDark, 0.062, shinLen);
      // Knee pad on the shin joint.
      const knee = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), m.vest);
      knee.scale.set(1, 0.85, 0.8);
      knee.position.set(0, 0.01, -0.02);
      knee.castShadow = true;
      shin.add(knee);

      shin.add(foot);
      foot.position.y = -shinLen;
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.09, 0.24), m.clothDark);
      boot.position.set(0, -0.04, -0.04);
      boot.castShadow = true;
      foot.add(boot);
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.03, 0.28), m.rubberBoot);
      sole.position.set(0, -0.09, -0.05);
      sole.castShadow = true;
      foot.add(sole);
      const toe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.07), m.clothDark);
      toe.position.set(0, -0.05, -0.15);
      foot.add(toe);
    }

    // --- weapon mount -----------------------------------------------------
    this.weaponMount.position.set(0.12, 0.02, -0.2);
    this.chest.add(this.weaponMount);

    this.upperBodyParts.push(this.spine);
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
  }

  // ----------------------------------------------------------------- weapon

  equip(config: WeaponConfig): void {
    if (this.currentWeapon === config.id) return;
    if (this.model) this.weaponMount.remove(this.model.root);

    let model = this.modelCache.get(config.id);
    if (!model) {
      model = buildWeaponModel(config.id);
      this.modelCache.set(config.id, model);
    }
    this.model = model;
    this.currentWeapon = config.id;
    model.root.position.set(0, 0, 0);
    model.root.rotation.set(0, 0, 0);
    this.weaponMount.add(model.root);
  }

  get weaponModel(): WeaponModel | null {
    return this.model;
  }

  getWorldMuzzle(out: THREE.Vector3): THREE.Vector3 {
    if (!this.model) return out.copy(this.root.position).setY(this.root.position.y + 1.5);
    this.model.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.model.muzzle.matrixWorld);
  }

  getWorldEjectPort(out: THREE.Vector3): THREE.Vector3 {
    if (!this.model) return this.getWorldMuzzle(out);
    this.model.ejectPort.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.model.ejectPort.matrixWorld);
  }

  onFire(config: WeaponConfig): void {
    this.recoilSpring.kick(config.recoil.modelPitch * 1.4);
    // Snap the weapon up out of low-ready; decays back over ~1.2 s.
    this.fireBlend = 1;
  }

  /** Hides the torso, head, arms and weapon while in first person. */
  setFirstPerson(firstPerson: boolean, keepLegs: boolean): void {
    this.showUpperBody = !firstPerson;
    for (const part of this.upperBodyParts) part.visible = !firstPerson;
    this.root.visible = !firstPerson || keepLegs;
  }

  // ----------------------------------------------------------------- update

  update(dt: number, frame: CharacterFrame): void {
    this.root.position.copy(frame.position);

    if (!frame.alive) {
      this.updateDeath(dt);
      return;
    }
    this.deathTimer = 0;

    // --- body yaw ---------------------------------------------------------
    // Hips follow the movement direction; when standing still or aiming they
    // catch up to the aim direction instead.
    let targetBodyYaw = frame.aimYaw;
    const moving = frame.speed > 0.6;
    if (moving && frame.ads < 0.4) {
      const moveYaw = Math.atan2(-frame.velocity.x, -frame.velocity.z);
      // Blend toward the strafe direction but never fully turn the back to the aim.
      let diff = moveYaw - frame.aimYaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      targetBodyYaw = frame.aimYaw + clamp(diff, -1.05, 1.05) * 0.75;
    }
    this.bodyYaw = dampAngle(this.bodyYaw, targetBodyYaw, moving ? 12 : 6, dt);
    this.root.rotation.y = this.bodyYaw;

    // Upper body twists to make up the difference.
    let twist = frame.aimYaw - this.bodyYaw;
    while (twist > Math.PI) twist -= Math.PI * 2;
    while (twist < -Math.PI) twist += Math.PI * 2;
    twist = clamp(twist, -1.4, 1.4);
    this.turnBlend = damp(this.turnBlend, twist, 16, dt);
    this.spine.rotation.y = this.turnBlend * 0.45;
    this.chest.rotation.y = this.turnBlend * 0.55;

    // --- pitch ------------------------------------------------------------
    this.aimPitchSmooth = damp(this.aimPitchSmooth, frame.aimPitch, 18, dt);
    const recoilKick = this.recoilSpring.update(dt) * DEG2RAD;
    this.chest.rotation.x = -this.aimPitchSmooth * 0.35 - recoilKick * 0.35;
    this.head.rotation.x = -this.aimPitchSmooth * 0.45;
    this.neck.rotation.x = -this.aimPitchSmooth * 0.2;

    // --- stance -----------------------------------------------------------
    const crouch = frame.crouchAmount;
    const slide = frame.sliding ? 1 : 0;
    this.hips.position.y = lerp(0.98, 0.62, crouch) - slide * 0.12;
    this.leanSpring.target = frame.sliding ? 22 : moving ? frame.moveIntensity * 7 : 0;
    const lean = this.leanSpring.update(dt) * DEG2RAD;
    this.spine.rotation.x = lean + crouch * 0.25;
    this.hips.rotation.x = slide * 0.35;

    // --- legs -------------------------------------------------------------
    this.updateLegs(dt, frame, crouch);

    // --- arms -------------------------------------------------------------
    this.updateWeaponPose(dt, frame, recoilKick);
    this.updateArmIK();
  }

  private updateLegs(dt: number, frame: CharacterFrame, crouch: number): void {
    const strideLength = frame.sprinting ? 2.0 : 1.55;
    const cycleSpeed = frame.speed / Math.max(0.4, strideLength);
    this.walkPhase += cycleSpeed * dt * Math.PI * 2;
    if (this.walkPhase > Math.PI * 2) this.walkPhase -= Math.PI * 2;

    const blend = clamp(frame.speed / 4.5, 0, 1);
    const amp = lerp(0.06, frame.sprinting ? 1.0 : 0.72, blend) * (1 - crouch * 0.45);

    if (!frame.grounded) {
      // Airborne tuck: front leg forward, back leg trailing.
      this.thighR.rotation.x = damp(this.thighR.rotation.x, -0.75, 10, dt);
      this.shinR.rotation.x = damp(this.shinR.rotation.x, 0.95, 10, dt);
      this.thighL.rotation.x = damp(this.thighL.rotation.x, 0.3, 10, dt);
      this.shinL.rotation.x = damp(this.shinL.rotation.x, 1.25, 10, dt);
      this.footR.rotation.x = damp(this.footR.rotation.x, -0.2, 10, dt);
      this.footL.rotation.x = damp(this.footL.rotation.x, -0.35, 10, dt);
      return;
    }

    if (frame.sliding) {
      this.thighR.rotation.x = damp(this.thighR.rotation.x, -1.15, 14, dt);
      this.shinR.rotation.x = damp(this.shinR.rotation.x, 1.5, 14, dt);
      this.thighL.rotation.x = damp(this.thighL.rotation.x, 0.35, 14, dt);
      this.shinL.rotation.x = damp(this.shinL.rotation.x, 1.9, 14, dt);
      return;
    }

    // Walk / run cycle. The knee only ever bends backwards.
    const phaseR = this.walkPhase;
    const phaseL = this.walkPhase + Math.PI;

    const thighSwingR = Math.sin(phaseR) * amp;
    const thighSwingL = Math.sin(phaseL) * amp;
    const kneeR = Math.max(0, -Math.sin(phaseR + 0.7)) * amp * 1.5;
    const kneeL = Math.max(0, -Math.sin(phaseL + 0.7)) * amp * 1.5;

    // Idle crouch/stand baseline bend.
    const baseThigh = crouch * 0.95;
    const baseKnee = crouch * 1.7;

    this.thighR.rotation.x = damp(this.thighR.rotation.x, -thighSwingR - baseThigh, 22, dt);
    this.thighL.rotation.x = damp(this.thighL.rotation.x, -thighSwingL - baseThigh, 22, dt);
    this.shinR.rotation.x = damp(this.shinR.rotation.x, kneeR + baseKnee, 22, dt);
    this.shinL.rotation.x = damp(this.shinL.rotation.x, kneeL + baseKnee, 22, dt);
    this.footR.rotation.x = damp(this.footR.rotation.x, -kneeR * 0.5 + crouch * 0.6, 18, dt);
    this.footL.rotation.x = damp(this.footL.rotation.x, -kneeL * 0.5 + crouch * 0.6, 18, dt);

    // Slight lateral sway and vertical bounce.
    const bounce = Math.abs(Math.sin(this.walkPhase)) * 0.035 * blend;
    this.hips.position.y += bounce;
    this.hips.rotation.z = Math.sin(this.walkPhase) * 0.05 * blend;
  }

  private updateWeaponPose(dt: number, frame: CharacterFrame, recoilKick: number): void {
    // Hip firing still raises the weapon, so recent shots count toward the
    // "shouldered" blend alongside actually aiming.
    this.fireBlend = Math.max(0, this.fireBlend - dt * 0.85);
    const shouldered = Math.max(frame.ads, this.fireBlend);

    // Low-ready when idle, shouldered when aiming. Kept close enough to the
    // chest that the support arm can actually reach the weapon's fore-end.
    const readyPos = this.tmpA.set(0.12, -0.03, -0.1);
    const aimPos = this.tmpB.set(0.05, 0.07, -0.12);
    const target = readyPos.lerp(aimPos, shouldered);

    // Sprinting drops the weapon across the body.
    if (frame.sprinting && shouldered < 0.2) {
      target.lerp(this.tmpC.set(0.14, -0.13, -0.06), Math.min(1, frame.moveIntensity));
    }

    this.weaponMount.position.lerp(target, 1 - Math.exp(-14 * dt));

    const pitch = this.aimPitchSmooth + recoilKick * 0.7;
    const readyPitch = lerp(-0.22, 0, shouldered);
    const readyYaw = lerp(-0.12, 0, shouldered);
    const sprintYaw =
      frame.sprinting && shouldered < 0.2 ? 0.5 * frame.moveIntensity : readyYaw;
    this.weaponMount.rotation.x = damp(
      this.weaponMount.rotation.x,
      pitch + readyPitch + (this.chest.rotation.x * -1 + this.spine.rotation.x * -1),
      16,
      dt,
    );
    this.weaponMount.rotation.y = damp(this.weaponMount.rotation.y, sprintYaw, 12, dt);
    this.weaponMount.rotation.z = damp(
      this.weaponMount.rotation.z,
      frame.sprinting && shouldered < 0.2 ? -0.45 * frame.moveIntensity : 0,
      12,
      dt,
    );

    // Reload / cycle: dip the weapon and pull the magazine.
    if (frame.reloadProgress >= 0) {
      const t = frame.reloadProgress;
      const swing = Math.sin(t * Math.PI);
      this.weaponMount.position.y -= swing * 0.1;
      this.weaponMount.rotation.z += swing * 0.5;
      if (this.model?.magazine) {
        const drop = clamp((t - 0.2) / 0.3, 0, 1) - clamp((t - 0.55) / 0.25, 0, 1);
        this.model.magazine.position.y = -drop * 0.25;
      }
    } else if (this.model?.magazine) {
      this.model.magazine.position.y = damp(this.model.magazine.position.y, 0, 20, dt);
    }

    if (frame.cycleProgress >= 0 && this.model?.charging) {
      const stroke = Math.sin(frame.cycleProgress * Math.PI);
      this.model.charging.position.z = stroke * 0.09;
    } else if (this.model?.charging) {
      this.model.charging.position.z = damp(this.model.charging.position.z, 0, 25, dt);
    }
  }

  /** Places both hands on the weapon using a two-bone analytic solve. */
  private updateArmIK(): void {
    if (!this.model) return;

    this.chest.updateWorldMatrix(true, true);

    // Elbow poles: down/back/outward in chest space.
    this.poleR.set(0.7, -1, 0.55).applyQuaternion(this.chest.getWorldQuaternion(this.tmpQuat));
    this.poleL.set(-0.6, -1, 0.4).applyQuaternion(this.tmpQuat);

    this.model.gripAnchor.updateWorldMatrix(true, false);
    this.model.foreAnchor.updateWorldMatrix(true, false);

    this.solveArm(
      this.shoulderR,
      this.upperArmR,
      this.lowerArmR,
      this.tmpA.setFromMatrixPosition(this.model.gripAnchor.matrixWorld),
      this.poleR,
    );
    this.solveArm(
      this.shoulderL,
      this.upperArmL,
      this.lowerArmL,
      this.tmpB.setFromMatrixPosition(this.model.foreAnchor.matrixWorld),
      this.poleL,
    );
  }

  private readonly ikDir = new THREE.Vector3();
  private readonly ikPerp = new THREE.Vector3();
  private readonly ikElbow = new THREE.Vector3();
  private readonly ikShoulder = new THREE.Vector3();

  private solveArm(
    shoulder: THREE.Object3D,
    upper: THREE.Object3D,
    lower: THREE.Object3D,
    target: THREE.Vector3,
    pole: THREE.Vector3,
  ): void {
    shoulder.updateWorldMatrix(true, false);
    this.ikShoulder.setFromMatrixPosition(shoulder.matrixWorld);

    this.ikDir.copy(target).sub(this.ikShoulder);
    const reach = UPPER_ARM + LOWER_ARM;
    let d = this.ikDir.length();
    if (d < 1e-4) return;
    this.ikDir.divideScalar(d);
    // Keep the solve inside the reachable annulus so acos stays defined.
    d = clamp(d, Math.abs(UPPER_ARM - LOWER_ARM) + 0.02, reach - 0.01);

    const cosShoulder = clamp(
      (UPPER_ARM * UPPER_ARM + d * d - LOWER_ARM * LOWER_ARM) / (2 * UPPER_ARM * d),
      -1,
      1,
    );
    const alpha = Math.acos(cosShoulder);

    // Component of the pole perpendicular to the shoulder->target axis defines
    // the plane the elbow bends in.
    this.ikPerp.copy(pole).addScaledVector(this.ikDir, -pole.dot(this.ikDir));
    if (this.ikPerp.lengthSq() < 1e-6) this.ikPerp.set(0, -1, 0);
    this.ikPerp.normalize();

    this.ikElbow
      .copy(this.ikShoulder)
      .addScaledVector(this.ikDir, Math.cos(alpha) * UPPER_ARM)
      .addScaledVector(this.ikPerp, Math.sin(alpha) * UPPER_ARM);

    // Upper arm: point its -Y axis at the elbow.
    this.tmpQuat2.setFromUnitVectors(DOWN, this.ikElbow.clone().sub(this.ikShoulder).normalize());
    shoulder.getWorldQuaternion(this.tmpQuat).invert();
    upper.quaternion.copy(this.tmpQuat).multiply(this.tmpQuat2);
    // The lower-arm solve reads the upper arm's world transform, so refresh it.
    upper.updateMatrixWorld(true);

    // Lower arm: point its -Y axis at the hand target.
    this.tmpQuat2.setFromUnitVectors(DOWN, target.clone().sub(this.ikElbow).normalize());
    upper.getWorldQuaternion(this.tmpQuat).invert();
    lower.quaternion.copy(this.tmpQuat).multiply(this.tmpQuat2);
  }

  private updateDeath(dt: number): void {
    this.deathTimer = Math.min(1, this.deathTimer + dt * 1.6);
    const t = this.deathTimer;
    this.root.rotation.x = damp(this.root.rotation.x, -Math.PI / 2 + 0.15, 6, dt);
    this.hips.position.y = damp(this.hips.position.y, 0.2, 6, dt);
    this.spine.rotation.x = damp(this.spine.rotation.x, 0.4, 5, dt);
    this.thighR.rotation.x = damp(this.thighR.rotation.x, 0.4, 5, dt);
    this.thighL.rotation.x = damp(this.thighL.rotation.x, 0.2, 5, dt);
    this.shinR.rotation.x = damp(this.shinR.rotation.x, 0.8, 5, dt);
    this.shinL.rotation.x = damp(this.shinL.rotation.x, 1.1, 5, dt);
    this.upperArmR.rotation.set(0.4 * t, 0, 0.6 * t);
    this.upperArmL.rotation.set(0.3 * t, 0, -0.7 * t);
    this.lowerArmR.rotation.x = 0.4 * t;
    this.lowerArmL.rotation.x = 0.5 * t;
  }

  reset(): void {
    this.deathTimer = 0;
    this.fireBlend = 0;
    this.root.rotation.set(0, 0, 0);
    this.hips.position.y = 0.98;
    this.recoilSpring.reset();
    this.leanSpring.reset();
  }
}
