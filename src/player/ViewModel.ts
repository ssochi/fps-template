import * as THREE from 'three';
import { buildWeaponModel, type WeaponModel } from '../weapons/WeaponMeshes';
import type { WeaponConfig, WeaponId } from '../weapons/WeaponTypes';
import { clamp, damp, DEG2RAD, lerp, noise1D, Spring, Spring3 } from '../core/MathUtils';
import { createGlowTexture } from '../world/Materials';

/**
 * First-person view model.
 *
 * Rendered into a dedicated scene with its own camera and composited on top of
 * the world with a cleared depth buffer. That is what keeps the weapon from
 * poking through walls when you stand against them, and it lets the gun use a
 * narrower FOV than the world so it doesn't distort at wide settings.
 *
 * All animation is procedural: sway, bob, ADS blending, recoil, reloads and
 * draw/holster are driven by springs and normalised phase timers rather than
 * baked clips, so swapping in new weapon geometry needs no new animation data.
 */

export interface ViewModelFrame {
  /** 0..1 aim-down-sights blend. */
  ads: number;
  /** 0..1 sprint blend for the lowered "run" pose. */
  sprint: number;
  /** Player horizontal speed normalised to sprint speed. */
  moveIntensity: number;
  grounded: boolean;
  /** Mouse delta this frame, radians. */
  lookDeltaYaw: number;
  lookDeltaPitch: number;
  /** 0..1 reload progress, or -1 when not reloading. */
  reloadProgress: number;
  /** Reload style so the animation matches. */
  reloadKind: 'tactical' | 'empty' | 'shell' | null;
  /** 0..1 draw progress, or -1. */
  drawProgress: number;
  /** 0..1 holster progress, or -1. */
  holsterProgress: number;
  /** 0..1 action-cycle progress (bolt/pump), or -1. */
  cycleProgress: number;
  /** 0..1 melee/inspect progress, or -1. */
  inspectProgress: number;
  crouchAmount: number;
  /** Multiplier for sway/bob from settings. */
  bobScale: number;
}

const HIP_POSITION = new THREE.Vector3(0.125, -0.12, -0.3);
const HIP_ROTATION = new THREE.Euler(0.015, 0.06, 0.0);
const SPRINT_ROTATION = new THREE.Euler(0.32, 0.75, -0.3);
/** Metres of clearance kept between the weapon's rear-most point and the eye. */
const STOCK_CLEARANCE = 0.14;
/**
 * ADS blend at which a scoped weapon's model is hidden. Must stay below the
 * point where `HUD` makes the scope overlay fully opaque.
 */
export const SCOPE_HIDE_THRESHOLD = 0.8;

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /** Root that carries sway/bob/recoil; the weapon hangs beneath it. */
  private readonly rig = new THREE.Group();
  private readonly weaponHolder = new THREE.Group();

  private model: WeaponModel | null = null;
  private config: WeaponConfig | null = null;
  private currentId: WeaponId | null = null;
  private readonly modelCache = new Map<WeaponId, WeaponModel>();

  /** Local position of the sight anchor inside the weapon root. */
  private readonly sightLocal = new THREE.Vector3();
  private readonly adsPosition = new THREE.Vector3();
  private readonly modelBounds = new THREE.Box3();
  /** Auto-derived hip-fire depth for the equipped weapon. */
  private hipZ = -0.3;

  private readonly swayPos = new Spring3(90, 15);
  private readonly swayRot = new Spring3(110, 16);
  private readonly recoilPos = new Spring3(200, 20);
  private readonly recoilRot = new Spring3(180, 18);
  private readonly kickRoll = new Spring(150, 16);

  private bobTime = 0;
  private idleTime = 0;
  private breathTime = 0;

  private readonly posOffset = new THREE.Vector3();
  private readonly rotOffset = new THREE.Euler();
  private readonly tmpEuler = new THREE.Euler();
  private readonly sprintPose = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();

  // Muzzle flash lives in the view-model scene so it lines up with the barrel.
  private readonly flashGroup = new THREE.Group();
  private readonly flashPlanes: THREE.Mesh[] = [];
  private readonly flashLight: THREE.PointLight;
  private flashLife = 0;
  private flashMaxLife = 0.05;
  private flashIntensity = 8;

  private readonly arms: THREE.Group;
  private readonly rightArm: THREE.Group;
  private readonly leftArm: THREE.Group;

  /** Base FOV for the weapon; deliberately narrower than the world camera. */
  weaponFov = 62;

  private aimedFovScale = 1;
  private hidden = false;

  constructor(aspect: number) {
    this.scene.name = 'view-model-scene';
    this.camera = new THREE.PerspectiveCamera(this.weaponFov, aspect, 0.004, 12);
    this.camera.rotation.order = 'YXZ';

    this.rig.add(this.weaponHolder);
    this.scene.add(this.rig);

    this.setupLighting();

    // --- muzzle flash ----------------------------------------------------
    const glow = createGlowTexture();
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: glow,
        color: 0xffc46b,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.renderOrder = 20;
      mesh.rotation.z = (i / 3) * Math.PI;
      this.flashGroup.add(mesh);
      this.flashPlanes.push(mesh);
    }
    const coneGeo = new THREE.ConeGeometry(0.5, 1, 8, 1, true);
    coneGeo.rotateX(-Math.PI / 2);
    coneGeo.translate(0, 0, -0.5);
    const cone = new THREE.Mesh(
      coneGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffdca8,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      }),
    );
    cone.renderOrder = 20;
    this.flashGroup.add(cone);
    this.flashPlanes.push(cone);

    this.flashLight = new THREE.PointLight(0xffb15c, 0, 3, 2);
    this.flashGroup.add(this.flashLight);
    this.flashGroup.visible = false;
    this.scene.add(this.flashGroup);

    // --- arms ------------------------------------------------------------
    this.arms = new THREE.Group();
    this.rightArm = ViewModel.buildArm(true);
    this.leftArm = ViewModel.buildArm(false);
    this.arms.add(this.rightArm, this.leftArm);
    this.weaponHolder.add(this.arms);
  }

  private setupLighting(): void {
    // A compact 3-point rig so the weapon reads clearly regardless of where the
    // player is standing in the world.
    const key = new THREE.DirectionalLight(0xfff2dd, 1.7);
    key.position.set(-0.5, 0.9, 0.6);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x9dbdf0, 0.55);
    fill.position.set(0.9, -0.2, 0.4);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(0.2, 0.4, -1);
    this.scene.add(rim);

    this.scene.add(new THREE.AmbientLight(0x8899aa, 0.35));
  }

  /**
   * Procedural gloved hand + forearm.
   *
   * The group's origin is the grip point, so it can be parented straight onto a
   * weapon anchor. The forearm hangs backwards, outwards and down from there,
   * roughly where the player's elbow would be off-screen.
   */
  private static buildArm(right: boolean): THREE.Group {
    const group = new THREE.Group();
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x333a2f, roughness: 0.95 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.78, metalness: 0.05 });
    const sign = right ? 1 : -1;

    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.078, 0.088), glove);
    group.add(hand);

    // Knuckles across the front of the fist.
    for (let i = 0; i < 4; i++) {
      const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.03, 3, 6), glove);
      finger.rotation.x = Math.PI / 2;
      finger.position.set(-0.02 + i * 0.0133, 0.026, -0.03);
      group.add(finger);
    }
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.013, 0.032, 3, 6), glove);
    thumb.rotation.set(0.5, 0, Math.PI / 2 - sign * 0.35);
    thumb.position.set(-sign * 0.03, 0.006, -0.012);
    group.add(thumb);

    // Forearm pivot points back / out / steeply down so the sleeve leaves the
    // bottom of the frame instead of filling the middle of the screen.
    const forearm = new THREE.Group();
    forearm.rotation.set(0.82, sign * 0.42, 0);
    group.add(forearm);

    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.04, 0.03, 12), glove);
    cuff.rotation.x = Math.PI / 2;
    cuff.position.z = 0.05;
    forearm.add(cuff);

    const sleeveMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.15, 4, 12), sleeve);
    sleeveMesh.rotation.x = Math.PI / 2;
    sleeveMesh.position.z = 0.155;
    forearm.add(sleeveMesh);

    group.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
    });
    return group;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Matches the weapon FOV to the world FOV changes while scoping. */
  private updateFov(adsProgress: number): void {
    const target = this.weaponFov * lerp(1, this.aimedFovScale, adsProgress);
    if (Math.abs(this.camera.fov - target) > 0.01) {
      this.camera.fov = target;
      this.camera.updateProjectionMatrix();
    }
  }

  get weaponModel(): WeaponModel | null {
    return this.model;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.rig.visible = !hidden;
  }

  equip(config: WeaponConfig): void {
    if (this.currentId === config.id) {
      this.config = config;
      return;
    }
    if (this.model) this.weaponHolder.remove(this.model.root);

    // Models are built once and cached; swapping weapons is then just a
    // reparent, which keeps switching allocation-free.
    let model = this.modelCache.get(config.id);
    if (!model) {
      model = buildWeaponModel(config.id);
      this.modelCache.set(config.id, model);
    }
    this.model = model;
    this.config = config;
    this.currentId = config.id;

    // Compute the sight anchor's position inside the weapon root while the root
    // is still at identity, then derive the ADS pose that puts it on the screen
    // centre line. This means new weapon art needs no hand-tuned ADS offsets.
    model.root.position.set(0, 0, 0);
    model.root.quaternion.identity();
    model.root.scale.setScalar(1);
    model.root.updateMatrixWorld(true);
    this.sightLocal.setFromMatrixPosition(model.sight.matrixWorld);

    // Rear-most point of the weapon (the stock/grip end nearest the eye).
    this.modelBounds.setFromObject(model.root);
    const rearZ = this.modelBounds.max.z;

    // Push the hip pose far enough forward that the stock never crosses the
    // near plane, and open up the ADS distance for the same reason. Because the
    // sight is placed on the screen-centre axis, moving it further out changes
    // only its apparent size — the aim stays perfectly aligned.
    this.hipZ = Math.min(-0.3, -(rearZ + STOCK_CLEARANCE));
    const adsDistance = Math.max(
      config.viewModel.adsDistance,
      rearZ - this.sightLocal.z + STOCK_CLEARANCE,
    );
    this.adsPosition.set(0, 0, -adsDistance).sub(this.sightLocal);

    model.root.scale.setScalar(config.viewModel.scale);
    this.weaponHolder.add(model.root);

    // Scopes shrink the view-model FOV alongside the world camera so the reticle
    // and the world stay visually locked together.
    this.aimedFovScale = config.scopeFov ? 0.72 : 1;

    this.attachArms(model, config);
    this.resetSprings();
  }

  private attachArms(model: WeaponModel, config: WeaponConfig): void {
    // Reparent so hands travel with the parts they hold (e.g. shotgun pump).
    model.gripAnchor.add(this.rightArm);
    model.foreAnchor.add(this.leftArm);
    this.rightArm.position.set(0, 0, 0.015);
    this.rightArm.rotation.set(config.id === 'pistol' ? -0.22 : -0.12, 0, 0);
    this.leftArm.position.set(0, 0, 0);
    this.leftArm.rotation.set(config.id === 'pistol' ? -0.18 : 0.1, 0, 0);
    this.arms.visible = true;
  }

  // ------------------------------------------------------------------ fire

  /** Applies the visual kick of a shot. */
  onFire(config: WeaponConfig, adsProgress: number): void {
    const scale = lerp(1, 0.55, adsProgress);
    this.recoilPos.kick(
      (Math.random() - 0.5) * config.recoil.kickback * 12 * scale,
      config.recoil.kickback * 9 * scale,
      config.recoil.kickback * 55 * scale,
    );
    this.recoilRot.kick(
      -config.recoil.modelPitch * DEG2RAD * 26 * scale,
      (Math.random() - 0.5) * config.recoil.modelPitch * DEG2RAD * 12 * scale,
      0,
    );
    this.kickRoll.kick((Math.random() - 0.5) * config.recoil.modelPitch * 1.6 * scale);
  }

  showMuzzleFlash(config: WeaponConfig): void {
    if (!this.model || this.hidden) return;

    this.model.muzzle.updateWorldMatrix(true, false);
    this.flashGroup.position.setFromMatrixPosition(this.model.muzzle.matrixWorld);
    this.tmpQuat.setFromRotationMatrix(this.model.muzzle.matrixWorld);
    this.flashGroup.quaternion.copy(this.tmpQuat);
    this.flashGroup.rotateZ(Math.random() * Math.PI * 2);
    this.flashGroup.visible = true;
    this.flashLife = 0.045 + config.flashScale * 0.018;
    this.flashMaxLife = this.flashLife;
    this.flashIntensity = config.flashLightIntensity * 0.12;

    const s = config.flashScale;
    for (let i = 0; i < 3; i++) {
      const size = s * (0.065 + Math.random() * 0.055);
      this.flashPlanes[i].scale.set(size, size, size);
      this.flashPlanes[i].position.set(0, 0, -0.01 - i * 0.008);
      this.flashPlanes[i].rotation.z = Math.random() * Math.PI * 2;
      (this.flashPlanes[i].material as THREE.MeshBasicMaterial).color.setHex(config.flashColor);
    }
    const cone = this.flashPlanes[3];
    cone.scale.set(s * 0.038, s * 0.038, s * (0.07 + Math.random() * 0.055));
    (cone.material as THREE.MeshBasicMaterial).color.setHex(config.flashColor);

    this.flashLight.color.setHex(config.flashColor);
    this.flashLight.intensity = this.flashIntensity;
  }

  /** World-space position of the view-model muzzle, for world FX. */
  getWorldMuzzle(worldCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    if (!this.model) return out.copy(worldCamera.position);
    this.model.muzzle.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(this.model.muzzle.matrixWorld);
    // The view-model scene is camera-local; lift it into world space.
    worldCamera.updateMatrixWorld();
    return out.applyMatrix4(worldCamera.matrixWorld);
  }

  getWorldEjectPort(worldCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    if (!this.model) return out.copy(worldCamera.position);
    this.model.ejectPort.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(this.model.ejectPort.matrixWorld);
    worldCamera.updateMatrixWorld();
    return out.applyMatrix4(worldCamera.matrixWorld);
  }

  // ---------------------------------------------------------------- update

  update(dt: number, frame: ViewModelFrame): void {
    if (!this.model || !this.config) return;
    const config = this.config;

    this.updateFov(frame.ads);
    this.updateFlash(dt);

    this.idleTime += dt;
    this.breathTime += dt * (frame.ads > 0.5 ? 1.6 : 1.0);

    // --- sway from mouse movement ----------------------------------------
    const swayScale = config.viewModel.swayScale * (1 - frame.ads * 0.82);
    this.swayPos.setTarget(
      clamp(-frame.lookDeltaYaw * 2.4, -0.09, 0.09) * swayScale,
      clamp(frame.lookDeltaPitch * 2.0, -0.07, 0.07) * swayScale,
      0,
    );
    this.swayRot.setTarget(
      clamp(frame.lookDeltaPitch * 4.5, -0.35, 0.35) * swayScale,
      clamp(-frame.lookDeltaYaw * 5.0, -0.4, 0.4) * swayScale,
      clamp(frame.lookDeltaYaw * 4.0, -0.3, 0.3) * swayScale,
    );
    const swayP = this.swayPos.update(dt);
    const swayR = this.swayRot.update(dt);

    // --- idle drift + breathing ------------------------------------------
    const idleScale = (1 - frame.ads * 0.7) * (1 - frame.moveIntensity * 0.6);
    const idleX = noise1D(this.idleTime * 0.55, 1) * 0.006 * idleScale;
    const idleY = noise1D(this.idleTime * 0.47, 2) * 0.005 * idleScale;
    const breath = Math.sin(this.breathTime * 1.7) * 0.0035 * (1 - frame.ads * 0.5);

    // --- walk bob ---------------------------------------------------------
    const bobActive = frame.grounded ? frame.moveIntensity : 0;
    this.bobTime += dt * (frame.sprint > 0.5 ? 13 : 9.5) * (0.4 + bobActive);
    const bobAmount = bobActive * frame.bobScale * (1 - frame.ads * 0.9);
    const bobX = Math.sin(this.bobTime) * 0.016 * bobAmount;
    const bobY = (Math.abs(Math.sin(this.bobTime)) - 0.5) * 0.02 * bobAmount;
    const bobRoll = Math.sin(this.bobTime) * 0.045 * bobAmount;

    // --- pose blending ----------------------------------------------------
    // Hip -> ADS.
    this.posOffset.set(
      HIP_POSITION.x + config.viewModel.hipOffset[0],
      HIP_POSITION.y + config.viewModel.hipOffset[1],
      this.hipZ + config.viewModel.hipOffset[2],
    );
    this.posOffset.lerp(this.adsPosition, frame.ads);

    this.tmpEuler.set(
      lerp(HIP_ROTATION.x + config.viewModel.hipRotation[0], 0, frame.ads),
      lerp(HIP_ROTATION.y + config.viewModel.hipRotation[1], 0, frame.ads),
      lerp(HIP_ROTATION.z + config.viewModel.hipRotation[2], 0, frame.ads),
    );

    // Sprint pose (never while aiming).
    const sprintBlend = frame.sprint * (1 - frame.ads);
    if (sprintBlend > 0.001) {
      this.sprintPose.set(0.18, -0.2, this.hipZ + 0.06);
      this.posOffset.lerp(this.sprintPose, sprintBlend);
      this.tmpEuler.set(
        lerp(this.tmpEuler.x, SPRINT_ROTATION.x, sprintBlend),
        lerp(this.tmpEuler.y, SPRINT_ROTATION.y, sprintBlend),
        lerp(this.tmpEuler.z, SPRINT_ROTATION.z, sprintBlend),
      );
    }

    // --- scripted states --------------------------------------------------
    this.applyDraw(frame);
    this.applyHolster(frame);
    this.applyReload(dt, frame, config);
    this.applyCycle(dt, frame, config);
    this.applyInspect(frame);

    // --- assemble ---------------------------------------------------------
    const recoilP = this.recoilPos.update(dt);
    const recoilR = this.recoilRot.update(dt);
    const roll = this.kickRoll.update(dt);

    this.posOffset.x += swayP.x + idleX + bobX + recoilP.x;
    this.posOffset.y += swayP.y + idleY + bobY + breath + recoilP.y - frame.crouchAmount * 0.012;
    this.posOffset.z += recoilP.z;

    this.rotOffset.set(
      this.tmpEuler.x + swayR.x + recoilR.x,
      this.tmpEuler.y + swayR.y + recoilR.y,
      this.tmpEuler.z + swayR.z + bobRoll + roll * DEG2RAD,
    );

    this.weaponHolder.position.copy(this.posOffset);
    this.weaponHolder.rotation.copy(this.rotOffset);

    // Once the scope overlay takes over the screen the weapon itself would
    // only obscure the sight picture, so hide the whole rig behind it.
    const scoped = config.scopeFov !== undefined && frame.ads > SCOPE_HIDE_THRESHOLD;
    this.arms.visible = !scoped;
    this.weaponHolder.visible = !scoped;
    if (this.model.scopeLens) {
      // Dim the ocular when not looking through it.
      const mat = (this.model.scopeLens as THREE.Mesh).material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = lerp(0.4, 1.6, frame.ads);
    }
  }

  private applyDraw(frame: ViewModelFrame): void {
    if (frame.drawProgress < 0) return;
    const t = frame.drawProgress;
    // Ease-out rise from below with a settle overshoot.
    const e = 1 - Math.pow(1 - t, 3);
    const drop = (1 - e) * 0.32;
    this.posOffset.y -= drop;
    this.posOffset.z += (1 - e) * 0.08;
    this.tmpEuler.x += (1 - e) * 0.9;
    this.tmpEuler.y += (1 - e) * 0.5;
    this.tmpEuler.z += Math.sin(t * Math.PI) * 0.08;
  }

  private applyHolster(frame: ViewModelFrame): void {
    if (frame.holsterProgress < 0) return;
    const t = frame.holsterProgress;
    const e = t * t;
    this.posOffset.y -= e * 0.34;
    this.posOffset.z += e * 0.08;
    this.tmpEuler.x += e * 0.95;
    this.tmpEuler.y += e * 0.5;
  }

  private applyInspect(frame: ViewModelFrame): void {
    if (frame.inspectProgress < 0) return;
    const t = frame.inspectProgress;
    const swing = Math.sin(t * Math.PI);
    this.posOffset.x -= swing * 0.06;
    this.posOffset.y += swing * 0.02;
    this.posOffset.z += swing * 0.06;
    this.tmpEuler.y -= swing * 1.1;
    this.tmpEuler.z += swing * 0.55;
    this.tmpEuler.x -= swing * 0.25;
  }

  private applyReload(dt: number, frame: ViewModelFrame, config: WeaponConfig): void {
    const mag = this.model?.magazine;
    if (frame.reloadProgress < 0) {
      if (mag) {
        mag.position.y = damp(mag.position.y, 0, 20, dt);
        mag.visible = true;
      }
      return;
    }
    const t = frame.reloadProgress;

    if (frame.reloadKind === 'shell') {
      // Single shell insert: hand dips to the loading port and back.
      const swing = Math.sin(t * Math.PI);
      this.posOffset.y -= swing * 0.07;
      this.posOffset.x -= swing * 0.02;
      this.tmpEuler.z += swing * 0.45;
      this.tmpEuler.x += swing * 0.18;
      return;
    }

    const empty = frame.reloadKind === 'empty';

    // Overall weapon motion: tilt in, hold, tilt back out.
    const inOut = t < 0.18 ? t / 0.18 : t > 0.82 ? (1 - t) / 0.18 : 1;
    const ease = inOut * inOut * (3 - 2 * inOut);
    this.posOffset.y -= ease * 0.075;
    this.posOffset.x -= ease * 0.03;
    this.posOffset.z += ease * 0.02;
    this.tmpEuler.x += ease * 0.28;
    this.tmpEuler.z += ease * 0.62;
    this.tmpEuler.y += ease * 0.22;

    // Magazine drop / insert.
    if (mag) {
      const dropStart = 0.16;
      const insertStart = empty ? 0.5 : 0.46;
      const insertEnd = empty ? 0.74 : 0.72;
      if (t < dropStart) {
        mag.position.y = 0;
        mag.visible = true;
      } else if (t < insertStart) {
        const k = (t - dropStart) / (insertStart - dropStart);
        mag.position.y = -k * k * 0.5;
        mag.visible = k < 0.85;
      } else if (t < insertEnd) {
        const k = (t - insertStart) / (insertEnd - insertStart);
        mag.visible = true;
        mag.position.y = -(1 - k) * (1 - k) * 0.32;
      } else {
        mag.position.y = 0;
        mag.visible = true;
      }
    }

    // Charging handle pull on an empty reload.
    if (empty && this.model?.charging && config.actionType !== 'pump') {
      const start = 0.8;
      if (t > start) {
        const k = (t - start) / (1 - start);
        const pull = Math.sin(k * Math.PI);
        this.model.charging.position.z = pull * 0.05;
      } else {
        this.model.charging.position.z = 0;
      }
    }
  }

  private applyCycle(dt: number, frame: ViewModelFrame, config: WeaponConfig): void {
    const charging = this.model?.charging;
    const slide = this.model?.slide;

    if (frame.cycleProgress < 0) {
      if (charging && config.actionType !== 'gas') {
        charging.position.z = damp(charging.position.z, 0, 25, dt);
        charging.rotation.z = damp(charging.rotation.z, 0, 25, dt);
      }
      if (slide) slide.position.z = damp(slide.position.z, 0, 40, dt);
      return;
    }

    const t = frame.cycleProgress;
    const stroke = Math.sin(t * Math.PI);

    if (config.actionType === 'pump' && charging) {
      charging.position.z = stroke * 0.11;
      // The whole gun rocks slightly as the pump is worked.
      this.tmpEuler.x += stroke * 0.09;
      this.posOffset.z += stroke * 0.02;
    } else if (config.actionType === 'bolt' && charging) {
      // Lift, pull, push, close.
      const lift = clamp(t / 0.2, 0, 1);
      const pull = clamp((t - 0.2) / 0.35, 0, 1);
      const push = clamp((t - 0.62) / 0.3, 0, 1);
      charging.rotation.z = -lift * 1.1 + push * 1.1;
      charging.position.z = (pull - push) * 0.075;
      this.tmpEuler.z += stroke * 0.14;
      this.posOffset.x -= stroke * 0.012;
    }
  }

  /** Slide/bolt blowback on each shot for gas-operated and pistol actions. */
  cycleAction(): void {
    const slide = this.model?.slide;
    if (slide) slide.position.z = 0.045;
    const charging = this.model?.charging;
    if (charging && this.config?.actionType === 'gas') charging.position.z = 0.03;
  }

  private updateFlash(dt: number): void {
    if (this.flashLife <= 0) return;
    this.flashLife -= dt;
    if (this.flashLife <= 0) {
      this.flashGroup.visible = false;
      this.flashLight.intensity = 0;
      return;
    }
    const t = this.flashLife / this.flashMaxLife;
    for (let i = 0; i < 3; i++) {
      (this.flashPlanes[i].material as THREE.MeshBasicMaterial).opacity = t;
    }
    (this.flashPlanes[3].material as THREE.MeshBasicMaterial).opacity = t * 0.85;
    this.flashLight.intensity = this.flashIntensity * t * t;

    // Gas-operated actions spring back between frames.
    const slide = this.model?.slide;
    if (slide) slide.position.z = damp(slide.position.z, 0, 45, dt);
    const charging = this.model?.charging;
    if (charging && this.config?.actionType === 'gas') {
      charging.position.z = damp(charging.position.z, 0, 45, dt);
    }
  }

  private resetSprings(): void {
    this.swayPos.reset();
    this.swayRot.reset();
    this.recoilPos.reset();
    this.recoilRot.reset();
    this.kickRoll.reset();
  }

}
