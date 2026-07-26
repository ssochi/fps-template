import * as THREE from 'three';
import {
  createSilhouetteTexture,
  createTargetFaceTexture,
  createWorldMaterials,
} from './Materials';
import { clamp, damp, randRange, Spring } from '../core/MathUtils';
import type { HitZone } from '../weapons/WeaponSystem';

export type TargetKind = 'paper' | 'silhouette' | 'steel' | 'popper' | 'swinger' | 'gong';

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
  /** Facing rotation about Y, radians. */
  rotation?: number;
  scale?: number;
  /** Seconds before a knocked-down target pops back up. -1 disables. */
  resetDelay?: number;
  /** Horizontal travel for swingers, metres. */
  travel?: number;
  /** Movement speed for swingers, m/s. */
  speed?: number;
  label?: string;
}

let sharedGeometry: {
  plate: THREE.CylinderGeometry;
  post: THREE.BoxGeometry;
  frame: THREE.BoxGeometry;
  paper: THREE.PlaneGeometry;
} | null = null;

function geometry(): NonNullable<typeof sharedGeometry> {
  if (!sharedGeometry) {
    sharedGeometry = {
      plate: new THREE.CylinderGeometry(0.3, 0.3, 0.02, 24),
      post: new THREE.BoxGeometry(0.07, 1, 0.07),
      frame: new THREE.BoxGeometry(0.05, 0.05, 0.05),
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

  private readonly options: TargetOptions;
  private readonly basePosition = new THREE.Vector3();
  private readonly pivot = new THREE.Group();
  private readonly swing = new Spring(70, 7);
  private resetTimer = 0;
  private swingerPhase = 0;
  private flashTimer = 0;
  private readonly flashTargets: THREE.MeshStandardMaterial[] = [];
  private readonly centreWorld = new THREE.Vector3();

  constructor(options: TargetOptions) {
    this.options = options;
    this.kind = options.kind;
    this.label = options.label ?? options.kind;
    this.basePosition.copy(options.position);
    this.root.position.copy(options.position);
    this.root.rotation.y = options.rotation ?? 0;
    const scale = options.scale ?? 1;
    this.root.scale.setScalar(scale);
    this.root.add(this.pivot);
    this.distance = Math.abs(options.position.z);

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
  }

  // ------------------------------------------------------------------ build

  private tag(mesh: THREE.Mesh, zone: HitZone, surface: 'metal' | 'wood' | 'steelTarget'): void {
    mesh.userData.rangeTarget = this;
    mesh.userData.zone = zone;
    mesh.userData.surface = surface;
    this.hitMeshes.push(mesh);
  }

  private addStand(height: number): void {
    const m = createWorldMaterials();
    const g = geometry();
    for (const x of [-0.45, 0.45]) {
      const leg = new THREE.Mesh(g.post, m.metalDark);
      leg.scale.y = height;
      leg.position.set(x, height / 2, 0);
      this.pivot.add(leg);
    }
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.5), m.metalDark);
    base.position.y = 0.04;
    this.pivot.add(base);
  }

  private buildPaper(): void {
    const m = createWorldMaterials();
    const g = geometry();
    this.addStand(1.15);

    const board = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 0.04), m.wood);
    board.position.set(0, 1.65, 0);
    this.pivot.add(board);
    this.tag(board, 'body', 'wood');

    const face = new THREE.Mesh(
      g.paper,
      new THREE.MeshStandardMaterial({ map: createTargetFaceTexture(), roughness: 0.95 }),
    );
    face.scale.set(1.02, 1.02, 1);
    face.position.set(0, 1.65, -0.022);
    face.rotation.y = Math.PI;
    this.pivot.add(face);
    this.tag(face, 'body', 'wood');
  }

  private buildSilhouette(): void {
    const m = createWorldMaterials();
    this.addStand(0.75);

    const board = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.55, 0.05), m.wood);
    board.position.set(0, 1.55, 0);
    this.pivot.add(board);
    this.tag(board, 'body', 'wood');

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.85, 1.55),
      new THREE.MeshStandardMaterial({ map: createSilhouetteTexture(), roughness: 0.95 }),
    );
    face.position.set(0, 1.55, -0.028);
    face.rotation.y = Math.PI;
    this.pivot.add(face);
    this.tag(face, 'body', 'wood');

    // Invisible head-zone collider layered in front of the face.
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.24, 0.3, 0.02),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    head.position.set(0, 2.02, -0.04);
    this.pivot.add(head);
    this.tag(head, 'head', 'wood');
  }

  private buildSteel(): void {
    const m = createWorldMaterials();
    const g = geometry();

    const hanger = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.06), m.metalDark);
    hanger.position.y = 1.9;
    this.pivot.add(hanger);
    for (const x of [-0.5, 0.5]) {
      const leg = new THREE.Mesh(g.post, m.metalDark);
      leg.scale.y = 1.9;
      leg.position.set(x, 0.95, 0);
      this.pivot.add(leg);
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

    // Painted centre so hits read at distance.
    const paint = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 20),
      new THREE.MeshStandardMaterial({ color: 0xd94a2a, roughness: 0.85 }),
    );
    paint.position.set(0, -0.6, -0.012);
    paint.rotation.y = Math.PI;
    swingGroup.add(paint);
    this.flashTargets.push(plate.material as THREE.MeshStandardMaterial);
  }

  private swingGroup: THREE.Group | null = null;

  private buildPopper(): void {
    const m = createWorldMaterials();

    const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.4), m.metalDark);
    base.position.y = 0.03;
    this.pivot.add(base);

    const fallGroup = new THREE.Group();
    fallGroup.position.set(0, 0.06, 0);
    this.pivot.add(fallGroup);
    this.swingGroup = fallGroup;

    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.75, 0.05), m.metal);
    stem.position.y = 0.375;
    fallGroup.add(stem);
    this.tag(stem, 'limb', 'steelTarget');

    const headPlate = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.02, 20), m.metal);
    headPlate.rotation.x = Math.PI / 2;
    headPlate.position.y = 0.94;
    fallGroup.add(headPlate);
    this.tag(headPlate, 'head', 'steelTarget');

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.02, 24), m.metal);
    body.rotation.x = Math.PI / 2;
    body.position.y = 0.5;
    fallGroup.add(body);
    this.tag(body, 'body', 'steelTarget');

    const paint = new THREE.Mesh(
      new THREE.CircleGeometry(0.12, 18),
      new THREE.MeshStandardMaterial({ color: 0xf0a020, roughness: 0.8 }),
    );
    paint.position.set(0, 0.5, -0.013);
    paint.rotation.y = Math.PI;
    fallGroup.add(paint);

    this.flashTargets.push(body.material as THREE.MeshStandardMaterial);
  }

  private buildSwinger(): void {
    const m = createWorldMaterials();
    const travel = this.options.travel ?? 6;

    const rail = new THREE.Mesh(new THREE.BoxGeometry(travel + 1.4, 0.08, 0.08), m.metalDark);
    rail.position.y = 2.4;
    this.root.add(rail);
    for (const x of [-(travel / 2 + 0.6), travel / 2 + 0.6]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.4, 0.1), m.metalDark);
      post.position.set(x, 1.2, 0);
      this.root.add(post);
    }

    const carrier = new THREE.Group();
    carrier.position.y = 2.36;
    this.root.add(carrier);
    this.swingGroup = carrier;

    const hook = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), m.metal);
    hook.position.y = -0.25;
    carrier.add(hook);

    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.02, 24), m.metal);
    plate.rotation.x = Math.PI / 2;
    plate.position.y = -0.76;
    carrier.add(plate);
    this.tag(plate, 'body', 'steelTarget');

    const paint = new THREE.Mesh(
      new THREE.CircleGeometry(0.11, 18),
      new THREE.MeshStandardMaterial({ color: 0x33c1e0, roughness: 0.8 }),
    );
    paint.position.set(0, -0.76, -0.013);
    paint.rotation.y = Math.PI;
    carrier.add(paint);

    this.flashTargets.push(plate.material as THREE.MeshStandardMaterial);
  }

  private buildGong(): void {
    const m = createWorldMaterials();

    for (const x of [-1.3, 1.3]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.4, 0.16), m.metalDark);
      post.position.set(x, 1.7, 0);
      this.pivot.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.16, 0.16), m.metalDark);
    beam.position.y = 3.35;
    this.pivot.add(beam);

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
      new THREE.MeshStandardMaterial({ color: 0xd94a2a, roughness: 0.85, side: THREE.DoubleSide }),
    );
    ring.position.set(0, -1.6, -0.03);
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
        out.set(0, 0.56, 0);
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
  registerHit(point: THREE.Vector3, zone: HitZone, direction: THREE.Vector3): TargetHitResult {
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
        break;
      case 'steel':
        score = 100;
        this.swing.kick(direction.z < 0 ? -420 : 420);
        break;
      case 'popper':
        score = zone === 'head' ? 200 : 120;
        if (!this.down) {
          this.down = true;
          knockedDown = true;
          this.resetTimer = this.options.resetDelay ?? 3.5;
        }
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

    if (this.kind === 'popper') {
      if (this.down) {
        this.resetTimer -= dt;
        if (this.swingGroup) {
          this.swingGroup.rotation.x = damp(this.swingGroup.rotation.x, 1.35, 12, dt);
        }
        if (this.resetTimer <= 0 && (this.options.resetDelay ?? 3.5) > 0) {
          this.down = false;
        }
      } else if (this.swingGroup) {
        this.swingGroup.rotation.x = damp(this.swingGroup.rotation.x, 0, 8, dt);
      }
      return;
    }

    if (this.swingGroup) {
      this.swing.target = 0;
      const angle = this.swing.update(dt) * 0.0022;
      this.swingGroup.rotation.x = angle;
    }
  }

  reset(): void {
    this.hits = 0;
    this.totalScore = 0;
    this.down = false;
    this.resetTimer = 0;
    this.swing.reset();
    this.flashTimer = 0;
    for (const mat of this.flashTargets) {
      mat.emissive.setRGB(0, 0, 0);
      mat.emissiveIntensity = 0;
    }
    if (this.swingGroup) this.swingGroup.rotation.set(0, 0, 0);
  }

  /** Sets a fresh, randomised swing phase so a rack of targets isn't in sync. */
  randomisePhase(): void {
    this.swingerPhase = randRange(0, 1);
  }
}
