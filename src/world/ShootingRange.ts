import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CollisionWorld } from '../physics/CollisionWorld';
import {
  createLightShaftTexture,
  createPosterTexture,
  createTextTexture,
  createWorldMaterials,
  type PosterKind,
} from './Materials';
import { StaticBatcher, mergeStaticHierarchy } from './GeometryMerge';
import { RangeTarget, type TargetKind } from './Targets';
import type { WeaponId } from '../weapons/WeaponTypes';
import { WEAPON_CONFIGS, WEAPON_ORDER } from '../weapons/WeaponConfigs';
import { randRange } from '../core/MathUtils';

/**
 * The shooting range level.
 *
 * Downrange is -Z; the player spawns on the covered firing line at the origin
 * looking down the lanes. Static geometry is queued into a `StaticBatcher` and
 * merged per material at the end of `build()`, which is what makes the prop
 * density here affordable — several hundred primitives collapse into a couple
 * of dozen draw calls.
 */

export interface WeaponPickup {
  id: WeaponId;
  position: THREE.Vector3;
  /** Pedestal display model, spun for readability. */
  display: THREE.Object3D;
  radius: number;
}

export interface RangeBuildResult {
  root: THREE.Group;
  targets: RangeTarget[];
  /** Meshes the shooting raycast tests against. */
  collidables: THREE.Object3D[];
  pickups: WeaponPickup[];
  spawnPoint: THREE.Vector3;
  spawnYaw: number;
  sun: THREE.DirectionalLight;
  sky: Sky;
  /** Lights and effects disabled on the lower quality presets. */
  optionalLights: THREE.Light[];
  atmospherics: THREE.Object3D[];
  /** Drives animated scenery (dust motes, lamp flicker). */
  update: (dt: number) => void;
}

const LANE_CENTRES = [-16, -8, 0, 8, 16];
const LANE_HALF_WIDTH = 4;
const RANGE_LENGTH = 170;
const ROOF_Y = 4.6;
const PAD_TOP = 0.15;

type SurfaceTag = 'concrete' | 'metal' | 'dirt' | 'wood';

interface BoxOptions {
  /** Register an AABB with the collision world. */
  solid?: boolean;
  surface?: SurfaceTag;
  /** Include in the shooting raycast. */
  shootable?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Rotation about Y, radians. Collision still uses the axis-aligned bounds. */
  rotationY?: number;
}

export class ShootingRange {
  private readonly materials = createWorldMaterials();
  private readonly root = new THREE.Group();
  private readonly batcher = new StaticBatcher();
  private readonly collidables: THREE.Object3D[] = [];
  private readonly targets: RangeTarget[] = [];
  private readonly pickups: WeaponPickup[] = [];
  private readonly optionalLights: THREE.Light[] = [];
  private readonly atmospherics: THREE.Object3D[] = [];
  private readonly world: CollisionWorld;

  private readonly signMaterials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);
  private readonly tmpPos = new THREE.Vector3();

  private dustUniform: { value: number } | null = null;
  private readonly flickerLamps: { light: THREE.Light; base: number; phase: number }[] = [];
  private elapsed = 0;

  constructor(world: CollisionWorld) {
    this.world = world;
    this.root.name = 'shooting-range';
  }

  build(): RangeBuildResult {
    this.buildGround();
    this.buildSurroundings();
    this.buildFiringLine();
    this.buildCeiling();
    this.buildLanes();
    this.buildBerms();
    this.buildDistanceMarkers();
    this.buildTargets();
    this.buildFiringLineProps();
    this.buildDownrangeProps();
    this.buildWeaponPedestals();

    const { sun, sky } = this.buildLighting();
    this.buildAtmospherics();

    // Merge everything queued so far into a handful of meshes.
    const merged = this.batcher.build(this.root, 'range');
    this.collidables.push(...merged);

    return {
      root: this.root,
      targets: this.targets,
      collidables: this.collidables,
      pickups: this.pickups,
      spawnPoint: new THREE.Vector3(0, PAD_TOP + 0.02, 4),
      spawnYaw: 0,
      sun,
      sky,
      optionalLights: this.optionalLights,
      atmospherics: this.atmospherics,
      update: (dt: number) => this.update(dt),
    };
  }

  private update(dt: number): void {
    this.elapsed += dt;
    if (this.dustUniform) this.dustUniform.value = this.elapsed;
    for (const lamp of this.flickerLamps) {
      // Subtle mains hum flicker; never dips far enough to read as broken.
      const n =
        Math.sin(this.elapsed * 11 + lamp.phase) * 0.5 +
        Math.sin(this.elapsed * 27.3 + lamp.phase * 2.1) * 0.5;
      lamp.light.intensity = lamp.base * (1 + n * 0.035);
    }
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Queues a box into the static batch and, unless told otherwise, registers a
   * collision AABB and marks it shootable. This is the single place level
   * geometry gets wired up.
   */
  private box(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
    opts: BoxOptions = {},
  ): void {
    const geo = new THREE.BoxGeometry(w, h, d);
    this.tmpEuler.set(0, opts.rotationY ?? 0, 0);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    this.tmpMatrix.compose(this.tmpPos.set(x, y, z), this.tmpQuat, this.tmpScale);

    this.batcher.add(geo, material, this.tmpMatrix, {
      surface: opts.surface ?? 'concrete',
      castShadow: opts.castShadow ?? true,
      receiveShadow: opts.receiveShadow ?? true,
      shootable: opts.shootable ?? true,
    });
    geo.dispose();

    if (opts.solid !== false) {
      // Rotated props still collide as their axis-aligned footprint, which is
      // fine for the low, walk-around scenery this is used for.
      const rot = Math.abs(opts.rotationY ?? 0);
      const cos = Math.abs(Math.cos(rot));
      const sin = Math.abs(Math.sin(rot));
      this.world.addBox(
        new THREE.Vector3(x, y, z),
        new THREE.Vector3(w * cos + d * sin, h, d * cos + w * sin),
        opts.surface ?? 'concrete',
      );
    }
  }

  /** Queues an arbitrary transformed mesh into the static batch. */
  private prop(
    geo: THREE.BufferGeometry,
    material: THREE.Material,
    position: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
    opts: { surface?: SurfaceTag; shootable?: boolean; castShadow?: boolean; scale?: number } = {},
  ): void {
    this.tmpEuler.set(rotation[0], rotation[1], rotation[2]);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    const s = opts.scale ?? 1;
    this.tmpMatrix.compose(
      this.tmpPos.set(position[0], position[1], position[2]),
      this.tmpQuat,
      this.tmpScale.set(s, s, s),
    );
    this.tmpScale.set(1, 1, 1);
    this.batcher.add(geo, material, this.tmpMatrix, {
      surface: opts.surface ?? 'metal',
      castShadow: opts.castShadow ?? true,
      shootable: opts.shootable ?? true,
    });
  }

  /**
   * A flat signboard. Materials are cached by content so repeated signs (the
   * distance markers on both sides of the range) batch into one draw call.
   */
  private sign(
    text: string,
    subtitle: string | undefined,
    x: number,
    y: number,
    z: number,
    width = 2,
    height = 1,
    rotationY = 0,
  ): void {
    const key = `${text}|${subtitle ?? ''}|${width}|${height}`;
    let material = this.signMaterials.get(key);
    if (!material) {
      const tex = createTextTexture(text, {
        subtitle,
        background: '#12161b',
        borderColor: '#f0b400',
        color: '#f5f5f0',
        width: 512,
        height: Math.round((512 * height) / width),
      });
      material = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.85,
        side: THREE.DoubleSide,
      });
      this.signMaterials.set(key, material);
    }

    const geo = new THREE.PlaneGeometry(width, height);
    this.tmpEuler.set(0, rotationY, 0);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    this.tmpMatrix.compose(this.tmpPos.set(x, y, z), this.tmpQuat, this.tmpScale);
    this.batcher.add(geo, material, this.tmpMatrix, {
      surface: 'metal',
      castShadow: false,
      shootable: true,
    });
    geo.dispose();
  }

  /** A wall poster; each kind gets its own material, so keep the set small. */
  private poster(kind: PosterKind, x: number, y: number, z: number, height = 1.1, rotationY = 0): void {
    const material = new THREE.MeshStandardMaterial({
      map: createPosterTexture(kind),
      roughness: 0.95,
    });
    const geo = new THREE.PlaneGeometry(height * 0.75, height);
    this.tmpEuler.set(0, rotationY, 0);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    this.tmpMatrix.compose(this.tmpPos.set(x, y, z), this.tmpQuat, this.tmpScale);
    this.batcher.add(geo, material, this.tmpMatrix, {
      surface: 'concrete',
      castShadow: false,
      shootable: true,
    });
    geo.dispose();
  }

  // ------------------------------------------------------------------ ground

  private buildGround(): void {
    const m = this.materials;

    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), m.grass);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = -0.02;
    terrain.receiveShadow = true;
    terrain.userData.surface = 'dirt';
    this.root.add(terrain);
    this.collidables.push(terrain);
    this.world.addBox(new THREE.Vector3(0, -5.02, 0), new THREE.Vector3(900, 10, 900), 'dirt');

    // Concrete firing line pad.
    this.box(54, 0.3, 24, 0, 0, 3, m.floor, { surface: 'concrete', castShadow: false });

    // Downrange gravel strip.
    const gravel = new THREE.Mesh(new THREE.PlaneGeometry(54, RANGE_LENGTH), m.concreteDark);
    gravel.rotation.x = -Math.PI / 2;
    gravel.position.set(0, 0.012, -RANGE_LENGTH / 2 - 8);
    gravel.receiveShadow = true;
    gravel.userData.surface = 'dirt';
    this.root.add(gravel);
    this.collidables.push(gravel);
    this.world.addBox(
      new THREE.Vector3(0, -0.15, -RANGE_LENGTH / 2 - 8),
      new THREE.Vector3(54, 0.3, RANGE_LENGTH),
      'dirt',
    );

    // Painted markings on the pad.
    const paint = new THREE.MeshStandardMaterial({ color: 0xd8b21c, roughness: 0.8 });
    this.prop(new THREE.PlaneGeometry(50, 0.35), paint, [0, PAD_TOP + 0.006, -1.6], [-Math.PI / 2, 0, 0], {
      surface: 'concrete',
      shootable: false,
      castShadow: false,
    });
    // Lane boxes painted on the floor.
    for (const cx of LANE_CENTRES) {
      for (const [dx, w, d] of [
        [0, 0.12, 3.2],
        [0, 3.2, 0.12],
      ] as const) {
        this.prop(
          new THREE.PlaneGeometry(w, d),
          paint,
          [cx + dx, PAD_TOP + 0.006, 0.6],
          [-Math.PI / 2, 0, 0],
          { surface: 'concrete', shootable: false, castShadow: false },
        );
      }
    }
  }

  /** Distant terrain, treeline and perimeter fence — depth cues past the berm. */
  private buildSurroundings(): void {
    const m = this.materials;

    // Low-poly ridge line well beyond the impact area.
    const ridge = new THREE.MeshStandardMaterial({ color: 0x5a6752, roughness: 1 });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const dist = 360 + Math.sin(i * 2.7) * 60;
      const height = 26 + Math.sin(i * 1.7) * 16;
      this.prop(
        new THREE.ConeGeometry(60 + Math.sin(i * 3.1) * 26, height, 5, 1),
        ridge,
        [Math.sin(a) * dist, height / 2 - 6, Math.cos(a) * dist],
        [0, a, 0],
        { surface: 'dirt', shootable: false, castShadow: false },
      );
    }

    // Treeline outside the fence.
    const trunk = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 });
    const foliage = new THREE.MeshStandardMaterial({ color: 0x3d5c33, roughness: 1 });
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + 0.2;
      const dist = 120 + ((i * 37) % 60);
      const x = Math.sin(a) * dist;
      const z = Math.cos(a) * dist - 60;
      // Keep the lanes clear of scenery.
      if (Math.abs(x) < 44 && z > -RANGE_LENGTH - 30) continue;
      const h = 6 + ((i * 13) % 5);
      this.prop(new THREE.CylinderGeometry(0.3, 0.45, h, 6), trunk, [x, h / 2, z], [0, 0, 0], {
        surface: 'wood',
        shootable: false,
      });
      this.prop(new THREE.ConeGeometry(2.4, h * 1.1, 7), foliage, [x, h * 1.1, z], [0, a, 0], {
        surface: 'dirt',
        shootable: false,
      });
    }

    // Perimeter chain-link fence with a top rail.
    const fenceHalf = 46;
    const fenceFar = -RANGE_LENGTH - 26;
    const fenceNear = 34;
    const segments: [number, number, number, number][] = [
      [-fenceHalf, fenceNear, fenceHalf, fenceNear],
      [-fenceHalf, fenceFar, -fenceHalf, fenceNear],
      [fenceHalf, fenceFar, fenceHalf, fenceNear],
    ];
    for (const [x1, z1, x2, z2] of segments) {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const angle = Math.atan2(x2 - x1, z2 - z1);
      const cx = (x1 + x2) / 2;
      const cz = (z1 + z2) / 2;

      const panel = new THREE.PlaneGeometry(len, 3.2);
      const tex = (m.chainLink.map as THREE.Texture).clone();
      tex.repeat.set(len / 3, 1.4);
      tex.needsUpdate = true;
      const panelMat = m.chainLink.clone();
      panelMat.map = tex;
      this.prop(panel, panelMat, [cx, 1.7, cz], [0, angle + Math.PI / 2, 0], {
        surface: 'metal',
        shootable: false,
        castShadow: false,
      });

      const posts = Math.max(2, Math.round(len / 6));
      for (let i = 0; i <= posts; i++) {
        const t = i / posts;
        this.prop(
          new THREE.CylinderGeometry(0.06, 0.06, 3.4, 6),
          m.metal,
          [x1 + (x2 - x1) * t, 1.7, z1 + (z2 - z1) * t],
          [0, 0, 0],
          { surface: 'metal', shootable: false },
        );
      }
      this.prop(
        new THREE.CylinderGeometry(0.05, 0.05, len, 6),
        m.metal,
        [cx, 3.3, cz],
        [Math.PI / 2, 0, angle],
        { surface: 'metal', shootable: false },
      );
    }
  }

  // ------------------------------------------------------------ firing line

  private buildFiringLine(): void {
    const m = this.materials;

    // Rear wall, broken up with pilasters and a service door.
    this.box(54, 5.0, 0.6, 0, 2.5, 13.8, m.concrete, { surface: 'concrete' });
    for (const x of [-22, -11, 11, 22]) {
      this.box(1.2, 5.0, 0.35, x, 2.5, 13.4, m.concreteDark, { surface: 'concrete', solid: false });
    }
    this.box(1.4, 2.4, 0.12, 6, 1.2, 13.45, m.metalDark, { surface: 'metal', solid: false });
    this.prop(new THREE.SphereGeometry(0.05, 8, 6), m.metal, [6.55, 1.15, 13.36], [0, 0, 0], {
      surface: 'metal',
      shootable: false,
    });

    // Side walls.
    this.box(0.6, 5.0, 24, -26.7, 2.5, 3, m.concrete, { surface: 'concrete' });
    this.box(0.6, 5.0, 24, 26.7, 2.5, 3, m.concrete, { surface: 'concrete' });

    // Kerb along the front lip of the covered area.
    this.box(54, 0.25, 0.4, 0, PAD_TOP + 0.12, -8.6, m.concreteDark, { surface: 'concrete' });

    // Support pillars, on the lane divider lines so none blocks a lane.
    for (const x of [-20, -12, -4, 4, 12, 20]) {
      this.box(0.55, ROOF_Y, 0.55, x, ROOF_Y / 2, -8.2, m.metalDark, { surface: 'metal' });
      // Hazard tape wrap at knee height.
      this.box(0.6, 0.5, 0.6, x, 0.75, -8.2, m.hazard, { surface: 'metal', solid: false });
    }

    // Range office booth in the back-left corner.
    this.box(6, 3.2, 4, -21, 1.6, 10.5, m.concreteDark, { surface: 'concrete' });
    this.prop(new THREE.BoxGeometry(4.4, 1.5, 0.08), m.glass, [-21, 2.05, 8.45], [0, 0, 0], {
      surface: 'metal',
      shootable: false,
      castShadow: false,
    });
    this.box(4.6, 0.12, 0.5, -21, 1.25, 8.4, m.wood, { surface: 'wood', solid: false });
    this.sign('RANGE CONTROL', undefined, -21, 3.45, 8.4, 4, 0.8, Math.PI);

    // Posters on the rear wall.
    this.poster('safety', -14, 2.2, 13.45, 1.5, Math.PI);
    this.poster('zones', -6, 2.2, 13.45, 1.5, Math.PI);
    this.poster('rules', 14, 2.2, 13.45, 1.5, Math.PI);
    this.poster('hazard', 20, 2.2, 13.45, 1.5, Math.PI);

    this.sign('FIRING RANGE', 'KEEP MUZZLE DOWNRANGE', 0, 3.9, 13.45, 9, 2.2, Math.PI);
  }

  private buildCeiling(): void {
    const m = this.materials;

    // Roof deck.
    this.box(54, 0.4, 23, 0, ROOF_Y, 2.4, m.metalDark, { surface: 'metal' });

    // Corrugated underside — a run of shallow ribs.
    for (let i = 0; i < 26; i++) {
      this.box(53, 0.12, 0.35, 0, ROOF_Y - 0.26, -8.6 + i * 0.85, m.metal, {
        surface: 'metal',
        solid: false,
        shootable: false,
      });
    }

    // I-beam trusses running across the bay.
    for (let i = 0; i < 7; i++) {
      const z = -7.5 + i * 3.2;
      this.box(53, 0.14, 0.5, 0, ROOF_Y - 0.55, z, m.metal, { surface: 'metal', solid: false });
      this.box(53, 0.5, 0.14, 0, ROOF_Y - 0.85, z, m.metal, { surface: 'metal', solid: false });
      this.box(53, 0.14, 0.5, 0, ROOF_Y - 1.15, z, m.metal, { surface: 'metal', solid: false });
      // Diagonal web members.
      for (let k = 0; k < 12; k++) {
        this.box(0.09, 0.62, 0.09, -24 + k * 4.4, ROOF_Y - 0.85, z, m.metal, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
      }
    }

    // Cable tray and conduit runs along the ceiling.
    this.box(0.5, 0.1, 22, -9, ROOF_Y - 1.35, 2.4, m.metal, { surface: 'metal', solid: false });
    this.box(0.5, 0.1, 22, 9, ROOF_Y - 1.35, 2.4, m.metal, { surface: 'metal', solid: false });
    for (let i = 0; i < 24; i++) {
      const z = -8 + i * 0.9;
      this.box(0.46, 0.05, 0.05, -9, ROOF_Y - 1.29, z, m.metalDark, {
        surface: 'metal',
        solid: false,
        shootable: false,
      });
      this.box(0.46, 0.05, 0.05, 9, ROOF_Y - 1.29, z, m.metalDark, {
        surface: 'metal',
        solid: false,
        shootable: false,
      });
    }
    for (const x of [-9.35, 9.35]) {
      this.prop(new THREE.CylinderGeometry(0.05, 0.05, 22, 8), m.metalDark, [x, ROOF_Y - 1.5, 2.4], [Math.PI / 2, 0, 0], {
        surface: 'metal',
        shootable: false,
      });
    }

    // Hazard strip along the open roof edge.
    this.box(54, 0.55, 0.14, 0, ROOF_Y - 0.5, -8.85, m.hazard, { surface: 'metal', solid: false });
  }

  // ----------------------------------------------------------------- lanes

  private buildLanes(): void {
    const m = this.materials;

    for (let i = 0; i < LANE_CENTRES.length; i++) {
      const cx = LANE_CENTRES[i];

      // Shared divider walls, capped with a steel rail.
      const x = cx - (LANE_HALF_WIDTH + 0.15);
      this.box(0.3, 1.5, 28, x, 0.9, -14, m.concrete, { surface: 'concrete' });
      this.box(0.42, 0.1, 28, x, 1.68, -14, m.metalDark, { surface: 'metal', solid: false });
      if (i === LANE_CENTRES.length - 1) {
        const xr = cx + LANE_HALF_WIDTH + 0.15;
        this.box(0.3, 1.5, 28, xr, 0.9, -14, m.concrete, { surface: 'concrete' });
        this.box(0.42, 0.1, 28, xr, 1.68, -14, m.metalDark, { surface: 'metal', solid: false });
      }

      // Lane number board hanging from the roof, facing the shooter.
      this.sign(`LANE ${i + 1}`, undefined, cx, 3.6, -8.4, 2.6, 1.0, 0);
      this.prop(new THREE.CylinderGeometry(0.02, 0.02, 0.55, 6), m.metal, [cx - 1, 4.0, -8.4], [0, 0, 0], {
        surface: 'metal',
        shootable: false,
      });
      this.prop(new THREE.CylinderGeometry(0.02, 0.02, 0.55, 6), m.metal, [cx + 1, 4.0, -8.4], [0, 0, 0], {
        surface: 'metal',
        shootable: false,
      });

      // Target control pole at the lane mouth.
      this.box(0.16, 1.6, 0.16, cx + 3.4, 0.8, -11, m.metalDark, { surface: 'metal' });
      this.box(0.34, 0.44, 0.2, cx + 3.4, 1.72, -11, m.paintedYellow, { surface: 'metal', solid: false });
      this.prop(new THREE.SphereGeometry(0.05, 8, 6), m.emissiveCyan, [cx + 3.4, 1.86, -11.11], [0, 0, 0], {
        surface: 'metal',
        shootable: false,
      });
    }
  }

  // ----------------------------------------------------------------- berms

  private buildBerms(): void {
    const m = this.materials;

    // Impact berm at the far end, with a stepped earth face.
    this.box(64, 15, 6, 0, 7.5, -RANGE_LENGTH - 6, m.concreteDark, { surface: 'concrete' });
    for (let i = 0; i < 7; i++) {
      this.box(
        64,
        2.4,
        3.2 - i * 0.35,
        0,
        1.2 + i * 2.2,
        -RANGE_LENGTH - 2.4 - i * 0.75,
        m.dirtBerm,
        { surface: 'dirt' },
      );
    }
    // Rubber matting strip at the base to catch spall.
    this.box(64, 0.6, 1.6, 0, 0.3, -RANGE_LENGTH - 0.6, m.rubber, { surface: 'dirt' });

    // Side berms.
    for (const side of [-1, 1]) {
      this.box(5, 9, RANGE_LENGTH + 24, side * 29, 4.5, -RANGE_LENGTH / 2 - 4, m.dirtBerm, {
        surface: 'dirt',
      });
      this.box(3, 2, RANGE_LENGTH + 24, side * 27, 1, -RANGE_LENGTH / 2 - 4, m.concreteDark, {
        surface: 'concrete',
        solid: false,
      });
    }

    this.sign('DANGER — IMPACT AREA', undefined, 0, 10, -RANGE_LENGTH - 2.6, 18, 2.6, 0);
  }

  private buildDistanceMarkers(): void {
    const m = this.materials;
    for (const distance of [10, 25, 50, 75, 100, 150]) {
      for (const side of [-1, 1]) {
        const x = side * 25.4;
        const z = -distance;
        this.box(0.18, 2.4, 0.18, x, 1.2, z, m.metalDark, { surface: 'metal', solid: false });
        this.box(0.3, 0.08, 0.3, x, 0.04, z, m.metal, { surface: 'metal', solid: false });
        this.sign(
          `${distance}m`,
          undefined,
          x - side * 0.55,
          2.6,
          z,
          1.7,
          0.85,
          side > 0 ? -Math.PI / 2 : Math.PI / 2,
        );
      }
    }
  }

  // ---------------------------------------------------------------- targets

  private addTarget(
    kind: TargetKind,
    x: number,
    z: number,
    opts: { scale?: number; rotation?: number; travel?: number; speed?: number; label?: string } = {},
  ): RangeTarget {
    const target = new RangeTarget({
      kind,
      position: new THREE.Vector3(x, 0, z),
      rotation: opts.rotation ?? 0,
      scale: opts.scale,
      travel: opts.travel,
      speed: opts.speed,
      label: opts.label,
    });
    target.randomisePhase();
    this.root.add(target.root);
    this.targets.push(target);
    for (const mesh of target.hitMeshes) this.collidables.push(mesh);
    return target;
  }

  private buildTargets(): void {
    // --- Lane 1: close-quarters steel (shotgun / SMG) ---------------------
    const l1 = LANE_CENTRES[0];
    for (let i = 0; i < 5; i++) {
      this.addTarget('popper', l1 - 3 + i * 1.5, -9 - (i % 2) * 2.2, { label: `Plate ${i + 1}` });
    }
    this.addTarget('steel', l1 - 2, -17);
    this.addTarget('steel', l1 + 2, -17);
    this.addTarget('silhouette', l1 - 1.6, -25, { label: 'CQB target A' });
    this.addTarget('silhouette', l1 + 1.6, -25, { label: 'CQB target B' });

    // --- Lane 2: pistol / SMG progression + the penetration demo ---------
    // The plywood wall built in `buildDownrangeProps` stands at (l2, -18); the
    // steel plate behind it can only be hit by punching through the wood.
    const l2 = LANE_CENTRES[1];
    this.addTarget('silhouette', l2 - 2.6, -12, { label: 'Silhouette L' });
    this.addTarget('silhouette', l2 + 2.6, -12, { label: 'Silhouette R' });
    this.addTarget('steel', l2, -22, { label: 'Penetration plate' });
    this.addTarget('paper', l2 - 2.8, -32);
    this.addTarget('paper', l2 + 2.8, -32);

    // --- Lane 3: centre precision lane -----------------------------------
    // Paper is held off the centre line so there is an unobstructed alley
    // straight through to the 100 m gong.
    const l3 = LANE_CENTRES[2];
    this.addTarget('paper', l3 - 3, -10);
    this.addTarget('paper', l3 + 3, -10);
    this.addTarget('paper', l3 - 3, -25);
    this.addTarget('paper', l3 + 3, -25);
    this.addTarget('paper', l3 - 3, -50);
    this.addTarget('gong', l3, -100, { scale: 0.8 });

    // --- Lane 4: movers ---------------------------------------------------
    const l4 = LANE_CENTRES[3];
    this.addTarget('swinger', l4, -20, { travel: 6, speed: 2.4 });
    this.addTarget('swinger', l4, -40, { travel: 7, speed: 3.4 });
    this.addTarget('steel', l4 - 2.5, -60);
    this.addTarget('steel', l4 + 2.5, -60);

    // --- Lane 5: long range ----------------------------------------------
    const l5 = LANE_CENTRES[4];
    this.addTarget('paper', l5, -75);
    this.addTarget('silhouette', l5 - 2.2, -100, { label: 'Long silhouette L' });
    this.addTarget('silhouette', l5 + 2.2, -100, { label: 'Long silhouette R' });
    this.addTarget('steel', l5 - 3, -125, { scale: 1.1 });
    this.addTarget('steel', l5 + 3, -125, { scale: 1.1 });
    this.addTarget('gong', l5, -150, { scale: 1.2 });
  }

  // ------------------------------------------------------- firing line props

  private buildFiringLineProps(): void {
    const m = this.materials;

    for (const x of LANE_CENTRES) {
      // Shooting bench with a trestle frame.
      this.box(2.8, 0.12, 1.0, x, 1.06, -6.2, m.wood, { surface: 'wood' });
      this.box(2.6, 0.1, 0.14, x, 0.94, -6.2, m.metalDark, { surface: 'metal', solid: false });
      for (const [lx, lz] of [
        [-1.2, -0.4],
        [1.2, -0.4],
        [-1.2, 0.4],
        [1.2, 0.4],
      ] as const) {
        this.box(0.12, 0.94, 0.12, x + lx, 0.62, -6.2 + lz, m.metalDark, { surface: 'metal' });
      }

      // Rubber mat in front of the bench.
      this.box(2.4, 0.03, 1.6, x, PAD_TOP + 0.02, -7.4, m.rubber, {
        surface: 'concrete',
        solid: false,
        castShadow: false,
      });

      // Brass bucket beside each bench.
      this.prop(new THREE.CylinderGeometry(0.22, 0.19, 0.44, 14, 1, true), m.metal, [x + 1.7, 0.22, -6.2], [0, 0, 0], {
        surface: 'metal',
      });
      this.prop(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 14), m.metal, [x + 1.7, 0.02, -6.2], [0, 0, 0], {
        surface: 'metal',
        shootable: false,
      });

      // Kit laid out on the bench: ammo tray, ear defenders, magazines.
      this.box(0.5, 0.1, 0.34, x - 0.9, 1.17, -6.1, m.paintedGreen, { surface: 'metal', solid: false });
      for (let k = 0; k < 3; k++) {
        this.box(0.07, 0.2, 0.03, x - 0.4 + k * 0.11, 1.22, -6.0, m.gunPolymer, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
      }
      this.prop(new THREE.TorusGeometry(0.11, 0.035, 8, 16), m.plastic, [x + 0.7, 1.2, -6.1], [Math.PI / 2, 0, 0], {
        surface: 'metal',
        shootable: false,
      });
      this.prop(new THREE.BoxGeometry(0.09, 0.13, 0.07), m.plastic, [x + 0.6, 1.2, -6.1], [0, 0, 0], {
        surface: 'metal',
        shootable: false,
      });
      this.prop(new THREE.BoxGeometry(0.09, 0.13, 0.07), m.plastic, [x + 0.8, 1.2, -6.1], [0, 0, 0], {
        surface: 'metal',
        shootable: false,
      });
    }

    // Spotting scope on a tripod at the centre lane.
    this.box(0.1, 1.15, 0.1, 2.6, 0.58, -6.6, m.metalDark, { surface: 'metal' });
    this.prop(new THREE.CylinderGeometry(0.09, 0.07, 0.42, 14), m.gunPolymer, [2.6, 1.22, -6.7], [Math.PI / 2 - 0.25, 0, 0], {
      surface: 'metal',
    });
    this.prop(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 12), m.gunMetal, [2.6, 1.16, -6.45], [Math.PI / 2 - 0.25, 0, 0], {
      surface: 'metal',
      shootable: false,
    });

    // Ammunition crates behind the firing line.
    for (let i = 0; i < 5; i++) {
      const x = -24 + i * 1.5;
      const z = 10.5 + (i % 2) * 0.4;
      this.box(1.3, 0.72, 0.85, x, 0.51, z, m.wood, { surface: 'wood' });
      this.box(1.34, 0.08, 0.89, x, 0.9, z, m.metalDark, { surface: 'metal', solid: false });
      this.box(0.5, 0.12, 0.06, x, 0.62, z - 0.44, m.paintedYellow, {
        surface: 'wood',
        solid: false,
        shootable: false,
      });
    }
    // A stack of green ammo cans on top.
    for (let i = 0; i < 3; i++) {
      this.box(0.62, 0.3, 0.36, -19.5, 0.15 + i * 0.31, 10.4, m.paintedGreen, { surface: 'metal' });
    }
    this.sign('AMMO — PRESS E TO RESUPPLY', undefined, -21.5, 1.9, 9.95, 5.4, 1.1, Math.PI);

    // Wall kit: extinguisher, first-aid box, tool board.
    this.prop(new THREE.CylinderGeometry(0.11, 0.11, 0.55, 14), m.paintedRed, [-2, 0.85, 13.3], [0, 0, 0], {
      surface: 'metal',
    });
    this.prop(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 10), m.metalDark, [-2, 1.19, 13.3], [0, 0, 0], {
      surface: 'metal',
      shootable: false,
    });
    this.box(0.5, 0.4, 0.16, 1, 1.6, 13.4, m.paintedRed, { surface: 'metal', solid: false });
    this.box(0.34, 0.06, 0.17, 1, 1.6, 13.34, m.floor, { surface: 'metal', solid: false, shootable: false });
    this.box(0.06, 0.24, 0.17, 1, 1.6, 13.34, m.floor, { surface: 'metal', solid: false, shootable: false });

    // Rolling tool cart.
    this.box(1.1, 0.9, 0.6, 9.5, 0.6, 11.5, m.paintedBlue, { surface: 'metal' });
    for (const [dx, dz] of [
      [-0.45, -0.22],
      [0.45, -0.22],
      [-0.45, 0.22],
      [0.45, 0.22],
    ] as const) {
      this.prop(new THREE.CylinderGeometry(0.08, 0.08, 0.05, 10), m.rubber, [9.5 + dx, 0.08, 11.5 + dz], [0, 0, Math.PI / 2], {
        surface: 'metal',
        shootable: false,
      });
    }
    for (let i = 0; i < 3; i++) {
      this.box(1.02, 0.03, 0.06, 9.5, 0.3 + i * 0.25, 11.19, m.metal, {
        surface: 'metal',
        solid: false,
        shootable: false,
      });
    }

    // Water cooler and a bin.
    this.prop(new THREE.CylinderGeometry(0.22, 0.22, 0.95, 14), m.plastic, [13, 0.62, 12.6], [0, 0, 0], {
      surface: 'metal',
    });
    this.prop(new THREE.CylinderGeometry(0.19, 0.16, 0.45, 14), m.glass, [13, 1.32, 12.6], [0, 0, 0], {
      surface: 'metal',
      shootable: false,
    });
    this.prop(new THREE.CylinderGeometry(0.28, 0.24, 0.72, 12, 1, true), m.plastic, [15, 0.36, 12.6], [0, 0, 0], {
      surface: 'metal',
    });

    // Folding chairs.
    for (let i = 0; i < 4; i++) {
      const x = 17 + i * 0.9;
      this.box(0.44, 0.05, 0.44, x, 0.47, 11.6, m.plastic, { surface: 'metal', solid: false });
      this.box(0.44, 0.5, 0.05, x, 0.72, 11.82, m.plastic, { surface: 'metal', solid: false });
      for (const [dx, dz] of [
        [-0.18, -0.18],
        [0.18, -0.18],
        [-0.18, 0.18],
        [0.18, 0.18],
      ] as const) {
        this.box(0.03, 0.45, 0.03, x + dx, 0.23, 11.6 + dz, m.metalDark, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
      }
    }

    // Sandbag stacks on the flanks for braced-shooting practice.
    for (const side of [-1, 1]) {
      const baseX = side * 22;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3 - row; col++) {
          this.box(
            0.9,
            0.34,
            0.5,
            baseX + (col * 0.95 + row * 0.45) * side,
            PAD_TOP + 0.17 + row * 0.34,
            -6.5,
            m.sandbag,
            { surface: 'dirt' },
          );
        }
      }
    }
  }

  // ------------------------------------------------------- downrange props

  private buildDownrangeProps(): void {
    const m = this.materials;

    // Penetration test wall: thin plywood the rifle and sniper shoot through.
    this.box(4, 2.5, 0.12, -8, 1.25, -18, m.wood, { surface: 'wood' });
    this.box(0.14, 2.6, 0.14, -10, 1.3, -18, m.metalDark, { surface: 'metal' });
    this.box(0.14, 2.6, 0.14, -6, 1.3, -18, m.metalDark, { surface: 'metal' });
    this.sign('PENETRATION TEST', 'RIFLE / SNIPER', -8, 3.0, -18, 3.4, 0.85, 0);

    // Jersey barriers along the flanks.
    for (let i = 0; i < 8; i++) {
      const z = -24 - i * 14;
      for (const side of [-1, 1]) {
        const x = side * 23.5;
        this.box(0.8, 0.5, 3.2, x, 0.25, z, m.concrete, { surface: 'concrete' });
        this.box(0.45, 0.5, 3.2, x, 0.75, z, m.concrete, { surface: 'concrete' });
        this.box(0.9, 0.1, 3.24, x, 1.05, z, m.hazard, { surface: 'concrete', solid: false });
      }
    }

    // Tyre stacks.
    for (const [bx, bz, count] of [
      [-22, -34, 4],
      [22.5, -48, 3],
      [-21.5, -76, 5],
      [22, -96, 4],
    ] as const) {
      for (let i = 0; i < count; i++) {
        this.prop(
          new THREE.TorusGeometry(0.42, 0.16, 8, 18),
          m.rubber,
          [bx, 0.16 + i * 0.24, bz],
          [Math.PI / 2, randRange(0, 1), 0],
          { surface: 'dirt' },
        );
      }
      this.world.addBox(new THREE.Vector3(bx, 0.4, bz), new THREE.Vector3(1.2, 0.9, 1.2), 'dirt');
    }

    // Wooden pallets and crates scattered as incidental cover.
    for (const [px, pz, rot] of [
      [-21, -46, 0.3],
      [21.5, -62, -0.4],
      [-22.5, -108, 0.8],
    ] as const) {
      for (let i = 0; i < 2; i++) {
        this.box(1.2, 0.14, 0.9, px, 0.07 + i * 0.16, pz, m.wood, {
          surface: 'wood',
          rotationY: rot,
        });
      }
      this.box(0.9, 0.8, 0.7, px, 0.55, pz, m.wood, { surface: 'wood', rotationY: rot });
    }

    // Steel drums.
    const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.92, 16);
    for (const [x, z, mat] of [
      [-22, -30, m.paintedRed],
      [-20.5, -31.5, m.metal],
      [21, -45, m.paintedYellow],
      [22.5, -46, m.metal],
      [-21, -70, m.paintedBlue],
      [21.8, -132, m.metal],
    ] as const) {
      this.prop(barrelGeo, mat as THREE.Material, [x, 0.46, z], [0, randRange(0, 3), 0], {
        surface: 'metal',
      });
      this.prop(new THREE.TorusGeometry(0.32, 0.03, 6, 16), m.metalDark, [x, 0.66, z], [Math.PI / 2, 0, 0], {
        surface: 'metal',
        shootable: false,
      });
      this.world.addBox(new THREE.Vector3(x, 0.46, z), new THREE.Vector3(0.64, 0.92, 0.64), 'metal');
    }

    // Traffic cones marking the no-go line.
    for (let i = 0; i < 10; i++) {
      const x = -24 + i * 5.3;
      this.prop(new THREE.ConeGeometry(0.22, 0.6, 10), m.paintedRed, [x, 0.3, -10.5], [0, 0, 0], {
        surface: 'dirt',
        shootable: false,
      });
      this.prop(new THREE.BoxGeometry(0.44, 0.04, 0.44), m.plastic, [x, 0.02, -10.5], [0, 0, 0], {
        surface: 'dirt',
        shootable: false,
        castShadow: false,
      });
    }

    // Derelict vehicle hulk as a long-range landmark.
    const hulkX = -21;
    const hulkZ = -118;
    this.box(4.4, 0.9, 1.9, hulkX, 0.55, hulkZ, m.metalDark, { surface: 'metal', rotationY: 0.35 });
    this.box(2.3, 0.8, 1.7, hulkX - 0.3, 1.35, hulkZ, m.metalDark, { surface: 'metal', rotationY: 0.35 });
    for (const [dx, dz] of [
      [-1.5, -0.85],
      [1.5, -0.85],
      [-1.5, 0.85],
      [1.5, 0.85],
    ] as const) {
      this.prop(
        new THREE.TorusGeometry(0.35, 0.14, 8, 14),
        m.rubber,
        [hulkX + dx * Math.cos(0.35) - dz * Math.sin(0.35), 0.35, hulkZ + dx * Math.sin(0.35) + dz * Math.cos(0.35)],
        [0, 0.35, Math.PI / 2],
        { surface: 'metal', shootable: false },
      );
    }
  }

  // -------------------------------------------------------- weapon pedestals

  private buildWeaponPedestals(): void {
    const m = this.materials;
    const count = WEAPON_ORDER.length;
    const spacing = 3.4;
    const startX = -((count - 1) * spacing) / 2;

    for (let i = 0; i < count; i++) {
      const id = WEAPON_ORDER[i];
      const cfg = WEAPON_CONFIGS[id];
      const x = startX + i * spacing;
      const z = 9.5;

      this.box(1.15, 1.0, 1.15, x, 0.5, z, m.metalDark, { surface: 'metal' });
      this.box(1.28, 0.07, 1.28, x, 1.02, z, m.emissiveCyan, { surface: 'metal', solid: false });
      this.box(1.05, 0.06, 1.05, x, 0.06, z, m.metal, { surface: 'metal', solid: false });

      const display = new THREE.Group();
      display.position.set(x, 1.55, z);
      this.root.add(display);

      this.sign(cfg.category, `${cfg.slot % 10}`, x, 2.3, z - 0.7, 1.5, 0.75, Math.PI);

      this.pickups.push({ id, position: new THREE.Vector3(x, 0, z), display, radius: 1.7 });
    }

    this.sign('LOADOUT — PRESS 1-0 OR WALK UP', undefined, 0, 3.1, 8.4, 10, 1.2, Math.PI);

    // Two wash lights cover the whole row instead of one per pedestal — ten
    // point lights for ten plinths is a real cost in a forward renderer.
    for (const x of [-8, 8]) {
      const wash = new THREE.PointLight(0x8fe4ff, 26, 12, 2);
      wash.position.set(x, 2.6, 9.5);
      this.root.add(wash);
      this.optionalLights.push(wash);
    }
  }

  // --------------------------------------------------------------- lighting

  private buildLighting(): { sun: THREE.DirectionalLight; sky: Sky } {
    const m = this.materials;

    const sky = new Sky();
    sky.scale.setScalar(45000);
    const uniforms = sky.material.uniforms;
    uniforms.turbidity.value = 5.5;
    uniforms.rayleigh.value = 1.8;
    uniforms.mieCoefficient.value = 0.004;
    uniforms.mieDirectionalG.value = 0.76;

    // Mid-afternoon sun placed *behind* the firing line so the shooter is never
    // staring into it and downrange targets stay well lit.
    const elevation = 34;
    const azimuth = 35;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    const sunPosition = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    uniforms.sunPosition.value.copy(sunPosition);
    this.root.add(sky);

    const sun = new THREE.DirectionalLight(0xfff0d8, 2.0);
    sun.position.copy(sunPosition).multiplyScalar(140);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 380;
    sun.shadow.camera.left = -75;
    sun.shadow.camera.right = 75;
    sun.shadow.camera.top = 65;
    sun.shadow.camera.bottom = -65;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.035;
    // Keep the shadow frustum centred on the action rather than the whole map.
    sun.target.position.set(0, 0, -40);
    this.root.add(sun);
    this.root.add(sun.target);

    const hemi = new THREE.HemisphereLight(0xbdd7ff, 0x6a6250, 1.35);
    this.root.add(hemi);
    this.root.add(new THREE.AmbientLight(0xdfe6f0, 0.35));

    // Bounce light off the concrete pad so the covered bay is not a black hole.
    const bounce = new THREE.DirectionalLight(0xd8c9a8, 0.45);
    bounce.position.set(0, -1, 4);
    this.root.add(bounce);

    // Overhead strip lights. The emissive strips read as the source; the point
    // lights do the illumination. Intensity is in candela and falls off with
    // the square of the distance, hence the large values for a 4.6 m ceiling.
    for (const x of [-19, -11, -3, 5, 13, 21]) {
      for (const z of [-6, 3, 11]) {
        this.box(1.5, 0.16, 0.55, x, ROOF_Y - 1.55, z, m.metalDark, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
        this.box(1.3, 0.09, 0.38, x, ROOF_Y - 1.66, z, m.lampLens, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
        // Hanger rods.
        this.box(0.04, 0.35, 0.04, x - 0.55, ROOF_Y - 1.35, z, m.metal, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
        this.box(0.04, 0.35, 0.04, x + 0.55, ROOF_Y - 1.35, z, m.metal, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
      }

    }

    // Illumination comes from a handful of strong lamps rather than one per
    // fixture; the emissive strips above carry the look of the rest.
    for (const x of [-15, -5, 5, 15]) {
      const main = new THREE.PointLight(0xdce8ff, 110, 42, 2);
      main.position.set(x, ROOF_Y - 1.95, 3);
      this.root.add(main);
      this.flickerLamps.push({ light: main, base: 110, phase: x });

      const extra = new THREE.PointLight(0xdce8ff, 70, 34, 2);
      extra.position.set(x, ROOF_Y - 1.95, -6);
      this.root.add(extra);
      this.optionalLights.push(extra);
    }

    // Warm accent uplights on the rear wall.
    for (const x of [-24, 24]) {
      const accent = new THREE.PointLight(0xffb367, 22, 14, 2);
      accent.position.set(x, 1.4, 12.6);
      this.root.add(accent);
      this.optionalLights.push(accent);
    }

    return { sun, sky };
  }

  /** Light shafts and drifting dust — cheap, and they sell the space. */
  private buildAtmospherics(): void {
    const shaftMat = new THREE.MeshBasicMaterial({
      map: createLightShaftTexture(),
      color: 0xcfe2ff,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const shaftGeo = new THREE.ConeGeometry(1.5, 3.4, 12, 1, true);
    // Cone apex is at +Y; flip it so the wide end lands on the floor.
    shaftGeo.rotateX(Math.PI);

    const shafts = new THREE.Group();
    shafts.name = 'light-shafts';
    for (const x of [-19, -11, -3, 5, 13, 21]) {
      for (const z of [-6, 3, 11]) {
        const shaft = new THREE.Mesh(shaftGeo, shaftMat);
        shaft.position.set(x, ROOF_Y - 3.5, z);
        shaft.renderOrder = 4;
        shafts.add(shaft);
      }
    }
    this.root.add(shafts);
    this.atmospherics.push(shafts);

    // Dust motes animated entirely on the GPU.
    const count = 520;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = randRange(-26, 26);
      positions[i * 3 + 1] = randRange(0.3, 4.3);
      positions[i * 3 + 2] = randRange(-10, 14);
      seeds[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 2), 40);

    const uTime = { value: 0 };
    this.dustUniform = uTime;
    const dustMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vFade;
        void main() {
          vec3 p = position;
          // Slow, looping drift so motes never leave the bay.
          p.x += sin(uTime * 0.11 + aSeed) * 1.6;
          p.y += sin(uTime * 0.19 + aSeed * 1.7) * 0.5;
          p.z += cos(uTime * 0.09 + aSeed * 0.7) * 1.6;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // Twinkle, and fade out the ones closest to the camera so they read
          // as motes hanging in the air rather than snow on the lens.
          vFade = (0.35 + 0.65 * abs(sin(uTime * 0.9 + aSeed * 3.1)))
                * smoothstep(1.5, 6.0, -mv.z);
          gl_PointSize = (0.8 + 0.5 * sin(aSeed)) * uPixelRatio * (11.0 / max(0.1, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vFade;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = 1.0 - smoothstep(0.15, 0.5, length(uv));
          if (d <= 0.001) discard;
          gl_FragColor = vec4(vec3(1.0, 0.97, 0.9), d * vFade * 0.22);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const dust = new THREE.Points(geo, dustMat);
    dust.name = 'dust-motes';
    dust.frustumCulled = false;
    dust.renderOrder = 5;
    this.root.add(dust);
    this.atmospherics.push(dust);
  }

  /** Exposed so `Game` can merge pedestal display weapons after building them. */
  static mergeDisplay(source: THREE.Object3D, name: string): THREE.Group {
    return mergeStaticHierarchy(source, name);
  }
}
