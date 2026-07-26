import * as THREE from 'three';
import {
  createSilhouetteTexture,
  createTargetFaceTexture,
  createWorldMaterials,
} from './Materials';
import { clamp, damp, randRange, Spring } from '../core/MathUtils';
import { mergeChildrenInPlace } from './GeometryMerge';
import type { HitZone } from '../weapons/WeaponSystem';

export type TargetKind = 'paper' | 'silhouette' | 'steel' | 'popper' | 'swinger' | 'gong';

export type TargetEvent = 'down' | 'up';

export interface TargetHitResult {
  score: number;
  zone: HitZone;
  /** Ring number 1-10 for paper targets, 0 otherwise. */
  ring: number;
  knockedDown: boolean;
  /** Distance from the target centre, metres. */
  offset: number;
}

export interface TargetOptions {
  kind: TargetKind;
  position: THREE.Vector3;
  /** Facing rotation about Y, radians. Zero faces the firing line (+Z). */
  rotation?: number;
  scale?: number;
  /** Seconds before a knocked-down target pops back up. -1 keeps it down. */
  resetDelay?: number;
  /** Horizontal travel for swingers, metres. */
  travel?: number;
  /** Movement speed for swingers, m/s. */
  speed?: number;
  /** Damage a knock-down target absorbs before it falls. */
  health?: number;
  label?: string;
}

/**
 * Every target is built facing +Z, which is the direction the firing line looks
 * from. Printed faces therefore sit at a *positive* local z, in front of their
 * backing board, with no extra rotation.
 */
const FACE_OFFSET = 0.024;

/** How far a knocked-down target rotates back, radians. */
const DOWN_ANGLE = 1.42;

let sharedGeometry: {
  plate: THREE.CylinderGeometry;
  post: THREE.BoxGeometry;
  paper: THREE.PlaneGeometry;
} | null = null;

function geometry(): NonNullable<typeof sharedGeometry> {
  if (!sharedGeometry) {
    sharedGeometry = {
      plate: new THREE.CylinderGeometry(0.3, 0.3, 0.02, 24),
      post: new THREE.BoxGeometry(0.07, 1, 0.07),
      paper: new THREE.PlaneGeometry(1, 1),
    };
  }
  return sharedGeometry;
}

/**
 * A single reactive range target.
 *
 * Targets own their geometry, their hit zones and their reaction animation.
 * Meshes are tagged through `userData` so the ballistics raycast can resolve a
 * hit back to the target and the zone it landed in without a second lookup.
 *
 * Knock-down kinds (poppers and silhouettes) absorb damage, fall backwards
 * under gravity when their health runs out, then spring back upright after
 * `resetDelay` with a slight overshoot.
 */
export class RangeTarget {
  readonly root = new THREE.Group();
  readonly kind: TargetKind;
  readonly label: string;
  /** Meshes that should be included in the shooting raycast. */
  readonly hitMeshes: THREE.Mesh[] = [];

  /** Distance from the world origin along -Z, used for the HUD readout. */
  distance = 0;

  down = false;
  hits = 0;
  totalScore = 0;
  health: number;
  readonly maxHealth: number;

  /** Fired when the target falls or pops back up, for audio and logging. */
  onStateChange: ((target: RangeTarget, event: TargetEvent) => void) | null = null;

  private readonly options: TargetOptions;
  private readonly pivot = new THREE.Group();
  /** Static furniture (stands, posts, frames) merged into one mesh at build. */
  private readonly decor = new THREE.Group();
  private readonly swing = new Spring(70, 7);
  /** Underdamped so a resetting target visibly pops upright. */
  private readonly stand = new Spring(58, 8.5);
  private fallAngle = 0;
  private fallVelocity = 0;
  private resetTimer = 0;
  private swingerPhase = 0;
  private flashTimer = 0;
  private readonly flashTargets: THREE.MeshStandardMaterial[] = [];
  private readonly centreWorld = new THREE.Vector3();
  private swingGroup: THREE.Group | null = null;
  private fallGroup: THREE.Group | null = null;

  constructor(options: TargetOptions) {
    this.options = options;
    this.kind = options.kind;
    this.label = options.label ?? options.kind;
    this.root.position.copy(options.position);
    this.root.rotation.y = options.rotation ?? 0;
    const scale = options.scale ?? 1;
    this.root.scale.setScalar(scale);
    this.root.add(this.pivot);
    this.pivot.add(this.decor);
    this.distance = Math.abs(options.position.z);
    this.maxHealth = options.health ?? (options.kind === 'silhouette' ? 100 : 60);
    this.health = this.maxHealth;

    switch (options.kind) {
      case 'paper':
        this.buildPaper();
        break;
      case 'silhouette':
        this.buildSilhouette();
        break;
      case 'steel':
        this.buildSteel();
        break;
      case 'popper':
        this.buildPopper();
        break;
      case 'swinger':
        this.buildSwinger();
        break;
      case 'gong':
        this.buildGong();
        break;
    }

    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });

    // Thirty targets built from a dozen primitives each would otherwise be the
    // single biggest draw-call consumer in the level.
    mergeChildrenInPlace(this.decor, `target-${options.kind}`);
  }

  get isKnockDown(): boolean {
    return this.kind === 'popper' || this.kind === 'silhouette';
  }

  // ------------------------------------------------------------------ build

  private tag(mesh: THREE.Mesh, zone: HitZone, surface: 'metal' | 'wood' | 'steelTarget'): void {
    mesh.userData.rangeTarget = this;
    mesh.userData.zone = zone;
    mesh.userData.surface = surface;
    this.hitMeshes.push(mesh);
  }

  private addStand(parent: THREE.Object3D, height: number, width = 0.45): void {
    const m = createWorldMaterials();
    const g = geometry();
    for (const x of [-width, width]) {
      const leg = new THREE.Mesh(g.post, m.metalDark);
      leg.scale.y = height;
      leg.position.set(x, height / 2, 0);
      parent.add(leg);
    }
    const base = new THREE.Mesh(new THREE.BoxGeometry(width * 2.6, 0.08, 0.5), m.metalDark);
    base.position.y = 0.04;
    parent.add(base);
    // Feet so the stand reads as bolted down rather than floating.
    for (const x of [-width, width]) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.34), m.metal);
      foot.position.set(x, 0.02, 0);
      parent.add(foot);
    }
  }

  private buildPaper(): void {
    const m = createWorldMaterials();
    const g = geometry();
    this.addStand(this.decor, 1.15);

    const board = new THREE.Mesh(new THREE.BoxGeometry(1.12, 1.12, 0.04), m.wood);
    board.position.set(0, 1.65, 0);
    this.pivot.add(board);
    this.tag(board, 'body', 'wood');

    // Printed face sits on the shooter's side of the board.
    const face = new THREE.Mesh(
      g.paper,
      new THREE.MeshStandardMaterial({ map: createTargetFaceTexture(), roughness: 0.95 }),
    );
    face.scale.set(1.04, 1.04, 1);
    face.position.set(0, 1.65, FACE_OFFSET);
    this.pivot.add(face);
    this.tag(face, 'body', 'wood');

    // Timber frame around the paper.
    for (const [w, h, x, y] of [
      [1.22, 0.06, 0, 0.61],
      [1.22, 0.06, 0, -0.61],
      [0.06, 1.28, -0.61, 0],
      [0.06, 1.28, 0.61, 0],
    ] as const) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.06), m.wood);
      bar.position.set(x, 1.65 + y, 0.01);
      this.decor.add(bar);
    }
  }

  private buildSilhouette(): void {
    const m = createWorldMaterials();

    // Bolted base plate the target hinges from.
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.09, 0.6), m.metalDark);
    base.position.y = 0.045;
    this.decor.add(base);
    for (const x of [-0.34, 0.34]) {
      const boltPad = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.03, 10), m.metal);
      boltPad.position.set(x, 0.1, 0.2);
      this.decor.add(boltPad);
    }

    // Everything above the hinge falls backwards when the target is killed.
    const fall = new THREE.Group();
    fall.position.set(0, 0.09, -0.05);
    this.pivot.add(fall);
    this.fallGroup = fall;

    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.78, 0.07), m.metalDark);
    spine.position.y = 0.39;
    fall.add(spine);
    this.tag(spine, 'limb', 'metal');

    const board = new THREE.Mesh(new THREE.BoxGeometry(0.86, 1.56, 0.05), m.wood);
    board.position.set(0, 1.5, 0);
    fall.add(board);
    this.tag(board, 'body', 'wood');

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.86, 1.56),
      new THREE.MeshStandardMaterial({ map: createSilhouetteTexture(), roughness: 0.95 }),
    );
    face.position.set(0, 1.5, FACE_OFFSET);
    fall.add(face);
    this.tag(face, 'body', 'wood');

    // Head zone collider layered just in front of the printed head.
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, 0.32, 0.03),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    head.position.set(0, 1.97, FACE_OFFSET + 0.01);
    fall.add(head);
    this.tag(head, 'head', 'wood');

    // Hit-state lamp so a downed target reads at long range.
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 10, 8),
      new THREE.MeshStandardMaterial({
        color: 0x1a1a1a,
        emissive: 0x22ff55,
        emissiveIntensity: 2,
        roughness: 0.5,
      }),
    );
    lamp.position.set(0, 0.16, 0.28);
    this.pivot.add(lamp);
    this.flashTargets.push(lamp.material as THREE.MeshStandardMaterial);
  }

  private buildSteel(): void {
    const m = createWorldMaterials();
    const g = geometry();

    const hanger = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.06), m.metalDark);
    hanger.position.y = 1.9;
    this.decor.add(hanger);
    for (const x of [-0.5, 0.5]) {
      const leg = new THREE.Mesh(g.post, m.metalDark);
      leg.scale.y = 1.9;
      leg.position.set(x, 0.95, 0);
      this.decor.add(leg);
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.7), m.metalDark);
      brace.position.set(x, 0.06, 0);
      this.decor.add(brace);
    }

    // The plate hangs from the bar and swings on hit.
    const swingGroup = new THREE.Group();
    swingGroup.position.set(0, 1.87, 0);
    this.pivot.add(swingGroup);
    this.swingGroup = swingGroup;

    const chainL = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.28, 6), m.metal);
    chainL.position.set(-0.16, -0.14, 0);
    swingGroup.add(chainL);
    const chainR = chainL.clone();
    chainR.position.x = 0.16;
    swingGroup.add(chainR);

    const plate = new THREE.Mesh(g.plate, m.metal);
    plate.rotation.x = Math.PI / 2;
    plate.position.set(0, -0.6, 0);
    plate.scale.set(1.15, 1, 1.15);
    swingGroup.add(plate);
    this.tag(plate, 'body', 'steelTarget');

    // Painted centre on the shooter's side so hits read at distance.
    const paint = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 20),
      new THREE.MeshStandardMaterial({ color: 0xd94a2a, roughness: 0.85 }),
    );
    paint.position.set(0, -0.6, 0.012);
    swingGroup.add(paint);
    this.flashTargets.push(plate.material as THREE.MeshStandardMaterial);
  }

  private buildPopper(): void {
    const m = createWorldMaterials();

    const base = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.07, 0.45), m.metalDark);
    base.position.y = 0.035;
    this.decor.add(base);

    const fallGroup = new THREE.Group();
    fallGroup.position.set(0, 0.07, -0.04);
    this.pivot.add(fallGroup);
    this.fallGroup = fallGroup;

    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.75, 0.05), m.metal);
    stem.position.y = 0.375;
    fallGroup.add(stem);
    this.tag(stem, 'limb', 'steelTarget');

    const headPlate = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.025, 20), m.metal);
    headPlate.rotation.x = Math.PI / 2;
    headPlate.position.y = 0.94;
    fallGroup.add(headPlate);
    this.tag(headPlate, 'head', 'steelTarget');

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.025, 24), m.metal);
    body.rotation.x = Math.PI / 2;
    body.position.y = 0.5;
    fallGroup.add(body);
    this.tag(body, 'body', 'steelTarget');

    const paint = new THREE.Mesh(
      new THREE.CircleGeometry(0.12, 18),
      new THREE.MeshStandardMaterial({ color: 0xf0a020, roughness: 0.8 }),
    );
    paint.position.set(0, 0.5, 0.015);
    fallGroup.add(paint);

    this.flashTargets.push(body.material as THREE.MeshStandardMaterial);
  }

  private buildSwinger(): void {
    const m = createWorldMaterials();
    const travel = this.options.travel ?? 6;

    const rail = new THREE.Mesh(new THREE.BoxGeometry(travel + 1.4, 0.08, 0.08), m.metalDark);
    rail.position.y = 2.4;
    this.decor.add(rail);
    for (const x of [-(travel / 2 + 0.6), travel / 2 + 0.6]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.4, 0.1), m.metalDark);
      post.position.set(x, 1.2, 0);
      this.decor.add(post);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.08, 0.5), m.metalDark);
      foot.position.set(x, 0.04, 0);
      this.decor.add(foot);
    }

    const carrier = new THREE.Group();
    carrier.position.y = 2.36;
    this.root.add(carrier);
    this.swingGroup = carrier;

    const hook = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), m.metal);
    hook.position.y = -0.25;
    carrier.add(hook);

    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.025, 24), m.metal);
    plate.rotation.x = Math.PI / 2;
    plate.position.y = -0.76;
    carrier.add(plate);
    this.tag(plate, 'body', 'steelTarget');

    const paint = new THREE.Mesh(
      new THREE.CircleGeometry(0.11, 18),
      new THREE.MeshStandardMaterial({ color: 0x33c1e0, roughness: 0.8 }),
    );
    paint.position.set(0, -0.76, 0.015);
    carrier.add(paint);

    this.flashTargets.push(plate.material as THREE.MeshStandardMaterial);
  }

  private buildGong(): void {
    const m = createWorldMaterials();

    for (const x of [-1.3, 1.3]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.4, 0.16), m.metalDark);
      post.position.set(x, 1.7, 0);
      this.decor.add(post);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.8), m.metalDark);
      foot.position.set(x, 0.05, 0);
      this.decor.add(foot);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.16, 0.16), m.metalDark);
    beam.position.y = 3.35;
    this.decor.add(beam);

    const swingGroup = new THREE.Group();
    swingGroup.position.set(0, 3.3, 0);
    this.pivot.add(swingGroup);
    this.swingGroup = swingGroup;

    for (const x of [-0.5, 0.5]) {
      const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 6), m.metal);
      chain.position.set(x, -0.35, 0);
      swingGroup.add(chain);
    }

    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.05, 32), m.metal);
    disc.rotation.x = Math.PI / 2;
    disc.position.y = -1.6;
    swingGroup.add(disc);
    this.tag(disc, 'body', 'steelTarget');

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.42, 32),
      new THREE.MeshStandardMaterial({ color: 0xd94a2a, roughness: 0.85 }),
    );
    ring.position.set(0, -1.6, 0.03);
    swingGroup.add(ring);

    this.flashTargets.push(disc.material as THREE.MeshStandardMaterial);
  }

  // ------------------------------------------------------------------- play

  /** World-space centre used for scoring accuracy. */
  getCentre(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateWorldMatrix(true, false);
    switch (this.kind) {
      case 'paper':
        out.set(0, 1.65, 0);
        break;
      case 'silhouette':
        out.set(0, 1.55, 0);
        break;
      case 'steel':
        out.set(0, 1.27, 0);
        break;
      case 'popper':
        out.set(0, 0.57, 0);
        break;
      case 'swinger':
        out.set(0, 1.6, 0);
        break;
      case 'gong':
        out.set(0, 1.7, 0);
        break;
    }
    return out.applyMatrix4(this.root.matrixWorld);
  }

  /** Registers a hit and returns the score awarded. */
  registerHit(
    point: THREE.Vector3,
    zone: HitZone,
    direction: THREE.Vector3,
    damage = 30,
  ): TargetHitResult {
    this.hits++;
    this.flashTimer = 0.18;

    this.getCentre(this.centreWorld);
    const offset = point.distanceTo(this.centreWorld);

    let score = 0;
    let ring = 0;
    let knockedDown = false;

    switch (this.kind) {
      case 'paper': {
        // 10 rings across a 0.5 m radius face.
        ring = clamp(Math.ceil(10 - (offset / 0.5) * 10), 1, 10);
        score = ring * 10;
        break;
      }
      case 'silhouette':
        ring = zone === 'head' ? 10 : offset < 0.25 ? 8 : 5;
        score = zone === 'head' ? 150 : offset < 0.25 ? 100 : 50;
        knockedDown = this.applyDamage(zone === 'head' ? this.maxHealth : damage);
        if (knockedDown) score += 200;
        break;
      case 'steel':
        score = 100;
        this.swing.kick(direction.z < 0 ? -420 : 420);
        break;
      case 'popper':
        score = zone === 'head' ? 200 : 120;
        knockedDown = this.applyDamage(this.maxHealth);
        break;
      case 'swinger':
        score = 175;
        this.swing.kick(-380);
        break;
      case 'gong':
        score = offset < 0.45 ? 250 : 120;
        this.swing.kick(-260);
        break;
    }

    this.totalScore += score;
    return { score, zone, ring, knockedDown, offset };
  }

  /** @returns true when this hit is what knocked the target down. */
  private applyDamage(amount: number): boolean {
    if (this.down) return false;
    this.health -= amount;
    if (this.health > 0) return false;
    this.knockDown();
    return true;
  }

  private knockDown(): void {
    this.down = true;
    this.health = 0;
    this.resetTimer = this.options.resetDelay ?? (this.kind === 'silhouette' ? 4 : 3.5);
    // A shove to start the fall so it topples rather than easing over.
    this.fallVelocity = 1.6;
    this.onStateChange?.(this, 'down');
  }

  private standUp(): void {
    this.down = false;
    this.health = this.maxHealth;
    this.fallVelocity = 0;
    this.stand.value = this.fallAngle;
    this.stand.velocity = 0;
    this.onStateChange?.(this, 'up');
  }

  update(dt: number): void {
    // Hit flash.
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const k = Math.max(0, this.flashTimer / 0.18);
      for (const mat of this.flashTargets) {
        mat.emissive.setRGB(k * 0.9, k * 0.55, k * 0.15);
        mat.emissiveIntensity = k * 2.2;
      }
    }

    if (this.kind === 'swinger' && this.swingGroup) {
      const travel = this.options.travel ?? 6;
      const speed = this.options.speed ?? 2.2;
      this.swingerPhase += (dt * speed) / Math.max(0.5, travel);
      this.swingGroup.position.x = Math.sin(this.swingerPhase * Math.PI * 2) * (travel / 2);
    }

    if (this.isKnockDown) {
      this.updateKnockDown(dt);
      return;
    }

    if (this.swingGroup) {
      this.swing.target = 0;
      this.swingGroup.rotation.x = this.swing.update(dt) * 0.0022;
    }
  }

  /**
   * Falling is integrated under gravity so the target topples with weight;
   * standing back up uses an underdamped spring so it visibly pops upright.
   */
  private updateKnockDown(dt: number): void {
    if (this.down) {
      this.resetTimer -= dt;
      if (this.fallAngle < DOWN_ANGLE) {
        // Torque grows as the target tips further past vertical.
        this.fallVelocity += (2.5 + Math.sin(this.fallAngle) * 9) * dt;
        this.fallAngle = Math.min(DOWN_ANGLE, this.fallAngle + this.fallVelocity * dt);
        if (this.fallAngle >= DOWN_ANGLE) {
          // Land with a small bounce rather than a hard stop.
          this.fallVelocity = -this.fallVelocity * 0.18;
          this.fallAngle = DOWN_ANGLE + this.fallVelocity * 0.02;
        }
      } else {
        this.fallAngle = damp(this.fallAngle, DOWN_ANGLE, 12, dt);
      }
      if (this.resetTimer <= 0 && (this.options.resetDelay ?? 1) >= 0) this.standUp();
    } else if (this.fallAngle > 0.001 || Math.abs(this.stand.velocity) > 0.001) {
      this.stand.target = 0;
      this.fallAngle = Math.max(-0.06, this.stand.update(dt));
    } else {
      this.fallAngle = 0;
    }

    if (this.fallGroup) this.fallGroup.rotation.x = this.fallAngle;

    // The status lamp goes red while the target is down.
    if (this.kind === 'silhouette' && this.flashTimer <= 0) {
      const mat = this.flashTargets[0];
      if (mat) {
        if (this.down) mat.emissive.setRGB(0.9, 0.08, 0.05);
        else mat.emissive.setRGB(0.1, 0.95, 0.25);
        mat.emissiveIntensity = 2;
      }
    }
  }

  reset(): void {
    this.hits = 0;
    this.totalScore = 0;
    this.down = false;
    this.health = this.maxHealth;
    this.resetTimer = 0;
    this.fallAngle = 0;
    this.fallVelocity = 0;
    this.stand.reset();
    this.swing.reset();
    this.flashTimer = 0;
    for (const mat of this.flashTargets) {
      mat.emissive.setRGB(0, 0, 0);
      mat.emissiveIntensity = 0;
    }
    if (this.swingGroup) this.swingGroup.rotation.set(0, 0, 0);
    if (this.fallGroup) this.fallGroup.rotation.set(0, 0, 0);
  }

  /** Sets a fresh, randomised swing phase so a rack of targets isn't in sync. */
  randomisePhase(): void {
    this.swingerPhase = randRange(0, 1);
  }
}
