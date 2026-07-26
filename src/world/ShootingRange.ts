import * as THREE from 'three';
import type { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CollisionWorld } from '../physics/CollisionWorld';
import { createLightShaftTexture } from './Materials';
import { LevelBuilder, type LevelBuildResult } from './LevelBuilder';
import { RangeTarget, type TargetKind } from './Targets';
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

/** @deprecated Retained for callers written before the level abstraction. */
export type RangeBuildResult = LevelBuildResult;

const LANE_CENTRES = [-16, -8, 0, 8, 16];
const LANE_HALF_WIDTH = 4;
const RANGE_LENGTH = 170;
const ROOF_Y = 4.6;
const PAD_TOP = 0.15;

export class ShootingRange extends LevelBuilder {
  constructor(world: CollisionWorld) {
    super(world, 'shooting-range');
  }

  build(): LevelBuildResult {
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
    this.pedestalRow({
      origin: [0, 0, 9.5],
      facing: Math.PI,
      label: 'LOADOUT — PRESS 1-0 OR WALK UP',
    });

    this.buildMechPad();

    const { sun, sky } = this.buildLighting();
    this.buildAtmospherics();

    // Merge everything queued so far into a handful of meshes.
    this.flushBatch('range');

    return {
      id: 'range',
      name: 'Shooting Range',
      root: this.root,
      targets: this.targets,
      collidables: this.collidables,
      pickups: this.pickups,
      ammoCrates: this.ammoCrates,
      vehicles: this.vehicleSpawns,
      lapCourse: null,
      spawnPoint: new THREE.Vector3(0, PAD_TOP + 0.02, 4),
      spawnYaw: 0,
      sun,
      sky,
      optionalLights: this.optionalLights,
      atmospherics: this.atmospherics,
      background: new THREE.Color(0x8fb4d8),
      fog: new THREE.Fog(0xa9c4dd, 130, 760),
      update: (dt: number) => this.tick(dt),
      dispose: () => this.disposeOwned(),
    };
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
    this.ammoCrates.push({ position: new THREE.Vector3(-20, 0, 10.5), radius: 3.5 });

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

  /**
   * A hardstand east of the covered bay for the Thor. It has to be outside the
   * roof — the mech is nearly twice the height of the firing line.
   */
  private buildMechPad(): void {
    const m = this.materials;
    const x = 36;
    const z = 4;
    this.box(16, 0.14, 18, x, 0.07, z, m.concreteDark, {
      surface: 'concrete',
      solid: false,
      castShadow: false,
    });
    for (const side of [-1, 1]) {
      this.prop(
        new THREE.PlaneGeometry(0.35, 17),
        m.paintedYellow,
        [x + side * 7, 0.15, z],
        [-Math.PI / 2, 0, 0],
        { surface: 'concrete', castShadow: false, shootable: false },
      );
      this.box(0.5, 3.6, 0.5, x + side * 8.5, 1.8, z + 8, m.metalDark, { surface: 'metal' });
      this.box(0.8, 0.5, 0.6, x + side * 8.5, 3.8, z + 8, m.emissiveOrange, {
        surface: 'metal',
        solid: false,
        shootable: false,
      });
    }
    this.sign('MECH HARDSTAND', undefined, x, 0.16, z + 6, 8, 2, 0, {
      background: '#12161b',
      borderColor: '#f0b400',
      tiltX: -Math.PI / 2,
    });
    // Heading yaw 0 already faces -Z, which is downrange.
    this.vehicleSpawns.push({ id: 'thor', position: new THREE.Vector3(x, 0.14, z), yaw: 0 });
  }

  // --------------------------------------------------------------- lighting

  private buildLighting(): { sun: THREE.DirectionalLight; sky: Sky } {
    const m = this.materials;

    // Mid-afternoon sun placed *behind* the firing line so the shooter is never
    // staring into it and downrange targets stay well lit.
    const { sun, sky } = this.buildSkyAndSun({
      elevation: 34,
      azimuth: 35,
      intensity: 2.0,
      shadowRadius: 75,
      shadowTarget: [0, 0, -40],
    });

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
    this.owned.push(shaftMat, shaftGeo);

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
    this.buildDustField({
      count: 520,
      bounds: { x: [-26, 26], y: [0.3, 4.3], z: [-10, 14] },
    });
  }
}
