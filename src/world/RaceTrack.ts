import * as THREE from 'three';
import type { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CollisionWorld } from '../physics/CollisionWorld';
import { LevelBuilder, type LapCourse, type LevelBuildResult } from './LevelBuilder';
import { RangeTarget, type TargetKind } from './Targets';
import { VEHICLES } from './Vehicles';
import type { VehicleId } from './Vehicles';
import { randRange } from '../core/MathUtils';

/**
 * The circuit level: a closed race track, a pit lane, and a garage holding a
 * hypercar, a 4x4 and a main battle tank.
 *
 * The track surface, kerbs, run-off and barriers are all generated from one
 * closed spline. Sampling it once and offsetting the samples sideways gives
 * every ribbon the map needs — asphalt, edge lines, gravel trap, armco, catch
 * fence — so the layout is defined in exactly one place (`CIRCUIT`) and the
 * rest follows.
 *
 * Two things the spline is deliberately *not* allowed to drive:
 *
 * - The pit straight has no armco. `PIT_MASK_Z` cuts the barrier where the pit
 *   complex is, and the pit wall stands in for it. Without that the generated
 *   barrier would run straight through the pit lane.
 * - Collision. The world is AABB-only, so a long diagonal barrier segment would
 *   collide as a hugely inflated box. `barrierColliders()` therefore walks the
 *   polyline and emits one collider per run of near-constant heading: long
 *   exact boxes down the straights, short ones through the corners.
 */

/** Circuit centreline control points, (x, z), running anticlockwise. */
const CIRCUIT: [number, number][] = [
  [-88, -70],
  [0, -70],
  [62, -70],
  [96, -62],
  [112, -40],
  [104, -14],
  [76, 2],
  [44, 6],
  [20, 20],
  [2, 46],
  [-24, 52],
  [-46, 40],
  [-40, 16],
  [-62, 2],
  [-92, 4],
  [-112, -18],
  [-108, -46],
  [-96, -64],
];

const TRACK_HALF = 6.5;
const RUNOFF_HALF = 10.5;
const BARRIER_OFFSET = RUNOFF_HALF + 1.5;
const SAMPLES = 320;

/** Everything south of this belongs to the pit complex, not the circuit. */
const PIT_MASK_Z = -80;

/** Pit lane and garage, all parallel to the main straight at z = -70. */
const PIT_WALL_Z = -85;
const PIT_LANE_Z = -91;
const GARAGE_FRONT_Z = -96.5;
const GARAGE_BACK_Z = -113.5;
const GARAGE_X0 = -60;
const GARAGE_X1 = 20;
const GARAGE_H = 7;
const FLOOR_Y = 0.16;

/**
 * Gaps in the pit wall, as x ranges. Without these the pit lane is a sealed
 * corridor and a car can never reach the circuit.
 */
const PIT_ENTRY = [GARAGE_X0 - 10, GARAGE_X0 - 2] as const;
const PIT_EXIT = [GARAGE_X1 + 8, GARAGE_X1 + 16] as const;

/** Firing point and target line of the service-road gunnery range. */
const RANGE_X = 78;
const RANGE_FIRING_Z = -97;

const BAYS: { id: VehicleId; x: number; halfWidth: number }[] = [
  { id: 'supercar', x: -46, halfWidth: 10 },
  { id: 'jeep', x: -20, halfWidth: 10 },
  { id: 'tank', x: 6, halfWidth: 10 },
];

interface Sample {
  position: THREE.Vector3;
  /** Unit tangent along the racing direction. */
  tangent: THREE.Vector3;
  /** Unit normal, to the right of the racing direction. */
  normal: THREE.Vector3;
  /** Signed curvature; large magnitude means a corner. */
  curvature: number;
  yaw: number;
}

export class RaceTrack extends LevelBuilder {
  private readonly samples: Sample[] = [];
  private readonly signalLights: THREE.MeshStandardMaterial[] = [];
  private startSequence = 0;

  constructor(world: CollisionWorld) {
    super(world, 'race-track');
  }

  build(): LevelBuildResult {
    this.sampleCircuit();

    this.buildGround();
    this.buildTrackSurface();
    this.buildKerbs();
    this.buildBarriers();
    this.buildTrackside();
    this.buildStartLine();
    this.buildPitLane();
    this.buildGarage();
    this.buildVehicles();
    this.buildGrandstand();
    this.buildPaddock();
    this.buildSurroundings();
    this.buildGunneryRange();
    this.pedestalRow({
      origin: [-20, FLOOR_Y, GARAGE_BACK_Z + 2.4],
      facing: 0,
      spacing: 3.2,
      label: 'PIT CREW LOADOUT — PRESS 1-0 OR WALK UP',
    });

    const { sun, sky } = this.buildLighting();
    this.buildAtmospherics();

    this.flushBatch('circuit');

    return {
      id: 'circuit',
      name: 'Circuit & Garage',
      root: this.root,
      targets: this.targets,
      collidables: this.collidables,
      pickups: this.pickups,
      ammoCrates: this.ammoCrates,
      vehicles: this.vehicleSpawns,
      lapCourse: this.buildLapCourse(),
      // On the pit lane, facing the open garage doors and the three cars.
      spawnPoint: new THREE.Vector3(-20, 0.06, PIT_LANE_Z + 1),
      spawnYaw: 0,
      sun,
      sky,
      optionalLights: this.optionalLights,
      atmospherics: this.atmospherics,
      background: new THREE.Color(0x9dc0e0),
      fog: new THREE.Fog(0xb6cee4, 210, 1100),
      update: (dt: number) => this.update(dt),
      dispose: () => this.disposeOwned(),
    };
  }

  /**
   * Start/finish is on the main straight at x = 0, crossed in the +X racing
   * direction. Three checkpoints spread around the lap stop the line being
   * gamed by driving back and forth over it.
   */
  private buildLapCourse(): LapCourse {
    const checkpoints = [0.25, 0.5, 0.75].map((f) => {
      const s = this.samples[Math.round(f * this.samples.length) % this.samples.length];
      return { position: s.position.clone(), radius: 24 };
    });
    return {
      linePoint: new THREE.Vector3(0, 0, -70),
      lineNormal: new THREE.Vector3(1, 0, 0),
      lineHalfWidth: TRACK_HALF + 1.5,
      checkpoints,
    };
  }

  private update(dt: number): void {
    this.tick(dt);
    // Start-light sequence: five reds fill in over four seconds, hold, then
    // all out for a beat before it loops.
    this.startSequence = (this.startSequence + dt) % 9;
    for (let i = 0; i < this.signalLights.length; i++) {
      const lit = this.startSequence > (i + 1) * 0.8 && this.startSequence < 6;
      this.signalLights[i].emissiveIntensity = lit ? 3.2 : 0.05;
    }
  }

  // ------------------------------------------------------------------ spline

  private sampleCircuit(): void {
    const curve = new THREE.CatmullRomCurve3(
      CIRCUIT.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      'centripetal',
      0.5,
    );
    // `getSpacedPoints(n)` returns n+1 points, the last repeating the first.
    const points = curve.getSpacedPoints(SAMPLES);
    points.length = SAMPLES;

    for (let i = 0; i < SAMPLES; i++) {
      const prev = points[(i - 1 + SAMPLES) % SAMPLES];
      const next = points[(i + 1) % SAMPLES];
      const tangent = next.clone().sub(prev).setY(0).normalize();
      const normal = new THREE.Vector3(tangent.z, 0, -tangent.x);

      const inTangent = points[i].clone().sub(prev).setY(0).normalize();
      const outTangent = next.clone().sub(points[i]).setY(0).normalize();
      const cross = inTangent.x * outTangent.z - inTangent.z * outTangent.x;
      const step = points[i].distanceTo(next) || 1;

      this.samples.push({
        position: points[i].clone(),
        tangent,
        normal,
        curvature: cross / step,
        yaw: Math.atan2(tangent.x, tangent.z),
      });
    }
  }

  /** Offsets every sample sideways by `distance`. */
  private offset(distance: number): THREE.Vector3[] {
    return this.samples.map((s) => s.position.clone().addScaledVector(s.normal, distance));
  }

  /**
   * A horizontal strip between two closed polylines. One geometry per ribbon
   * keeps the whole 700 m circuit down to a handful of draw calls.
   */
  private surfaceRibbon(
    inner: THREE.Vector3[],
    outer: THREE.Vector3[],
    y: number,
    uvScale = 0.08,
  ): THREE.BufferGeometry {
    const positions: number[] = [];
    const uvs: number[] = [];
    let run = 0;

    for (let i = 0; i < inner.length; i++) {
      const j = (i + 1) % inner.length;
      const a = inner[i];
      const b = outer[i];
      const c = outer[j];
      const d = inner[j];
      const step = a.distanceTo(d);
      const v0 = run * uvScale;
      const v1 = (run + step) * uvScale;
      run += step;

      // Wound counter-clockwise seen from above: `outer` is to the *right* of
      // the racing direction, so the naive inner->outer->next order faces the
      // quad downwards and back-face culling hides the whole road.
      for (const [p, u, v] of [
        [a, 0, v0],
        [c, 1, v1],
        [b, 1, v0],
        [a, 0, v0],
        [d, 0, v1],
        [c, 1, v1],
      ] as [THREE.Vector3, number, number][]) {
        positions.push(p.x, y, p.z);
        uvs.push(u, v);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    return geo;
  }

  /** A vertical band following an open polyline — armco rails, catch fence. */
  private wallRibbon(path: THREE.Vector3[], y0: number, y1: number, uvScale = 0.25): THREE.BufferGeometry {
    const positions: number[] = [];
    const uvs: number[] = [];
    let run = 0;

    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const step = a.distanceTo(b);
      const u0 = run * uvScale;
      const u1 = (run + step) * uvScale;
      run += step;

      // Both windings, so the band is visible from either side without paying
      // for a double-sided material.
      for (const [p, y, u] of [
        [a, y0, u0],
        [b, y0, u1],
        [b, y1, u1],
        [a, y0, u0],
        [b, y1, u1],
        [a, y1, u0],
        [a, y0, u0],
        [a, y1, u0],
        [b, y1, u1],
        [a, y0, u0],
        [b, y1, u1],
        [b, y0, u1],
      ] as [THREE.Vector3, number, number][]) {
        positions.push(p.x, y, p.z);
        uvs.push(u, y === y0 ? 0 : 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.computeVertexNormals();
    return geo;
  }

  /** Contiguous runs of samples whose barrier point clears the pit complex. */
  private barrierRuns(path: THREE.Vector3[]): number[][] {
    const allowed = path.map((p) => p.z > PIT_MASK_Z);
    if (allowed.every(Boolean)) return [[...path.keys(), 0]];

    const runs: number[][] = [];
    let current: number[] | null = null;
    // Start from the first blocked sample so runs never wrap the seam.
    const first = allowed.indexOf(false);
    for (let k = 0; k < path.length; k++) {
      const i = (first + k) % path.length;
      if (allowed[i]) {
        if (!current) {
          current = [];
          runs.push(current);
        }
        current.push(i);
      } else {
        current = null;
      }
    }
    return runs.filter((r) => r.length > 1);
  }

  // ------------------------------------------------------------------ ground

  private buildGround(): void {
    const m = this.materials;

    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), m.grass);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = -0.02;
    terrain.receiveShadow = true;
    terrain.userData.surface = 'dirt';
    this.root.add(terrain);
    this.collidables.push(terrain);
    this.world.addBox(new THREE.Vector3(0, -5.02, 0), new THREE.Vector3(1400, 10, 1400), 'dirt');
  }

  private buildTrackSurface(): void {
    const m = this.materials;

    // Gravel run-off first, then the asphalt on top of it.
    this.prop(
      this.surfaceRibbon(this.offset(-RUNOFF_HALF), this.offset(RUNOFF_HALF), 0.012, 0.06),
      m.gravel,
      [0, 0, 0],
      [0, 0, 0],
      { surface: 'dirt', castShadow: false },
    );
    this.prop(
      this.surfaceRibbon(this.offset(-TRACK_HALF), this.offset(TRACK_HALF), 0.03, 0.08),
      m.asphalt,
      [0, 0, 0],
      [0, 0, 0],
      { surface: 'concrete', castShadow: false },
    );

    // White edge lines, just inboard of the asphalt edge.
    for (const side of [-1, 1]) {
      this.prop(
        this.surfaceRibbon(this.offset(side * (TRACK_HALF - 0.28)), this.offset(side * TRACK_HALF), 0.035, 0.2),
        m.whitePaint,
        [0, 0, 0],
        [0, 0, 0],
        { surface: 'concrete', castShadow: false, shootable: false },
      );
    }
  }

  /** Red/white kerbing, laid only where the circuit is actually turning. */
  private buildKerbs(): void {
    const m = this.materials;
    const geo = new THREE.BoxGeometry(1.7, 0.09, 1.5);

    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      if (Math.abs(s.curvature) < 0.012) continue;
      // Kerb the inside of the corner always, the outside only in the tighter
      // ones — which is where a car would actually run wide.
      const sides = Math.abs(s.curvature) > 0.03 ? [-1, 1] : [s.curvature > 0 ? -1 : 1];
      for (const side of sides) {
        const p = s.position.clone().addScaledVector(s.normal, side * (TRACK_HALF + 0.85));
        this.prop(geo, i % 2 === 0 ? m.paintedRed : m.whitePaint, [p.x, 0.045, p.z], [0, s.yaw, 0], {
          surface: 'concrete',
          castShadow: false,
          shootable: false,
        });
      }
    }
  }

  // ---------------------------------------------------------------- barriers

  private buildBarriers(): void {
    const m = this.materials;

    for (const side of [-1, 1]) {
      const path = this.offset(side * BARRIER_OFFSET);
      const runs = this.barrierRuns(path);

      for (const run of runs) {
        const points = run.map((i) => path[i]);
        // Two armco rails on posts, and a catch fence above the outer line.
        for (const [y0, y1] of [
          [0.55, 0.95],
          [1.05, 1.45],
        ]) {
          this.prop(this.wallRibbon(points, y0, y1), m.chrome, [0, 0, 0], [0, 0, 0], {
            surface: 'metal',
            castShadow: false,
          });
        }
        if (side > 0) {
          this.prop(this.wallRibbon(points, 1.5, 4.2), m.chainLink, [0, 0, 0], [0, 0, 0], {
            surface: 'metal',
            castShadow: false,
            shootable: false,
          });
        }

        for (let k = 0; k < run.length; k += 4) {
          const i = run[k];
          this.box(0.12, 1.5, 0.12, path[i].x, 0.75, path[i].z, m.metalDark, {
            surface: 'metal',
            solid: false,
            shootable: false,
            rotationY: this.samples[i].yaw,
          });
          if (side > 0 && k % 16 === 0) {
            this.box(0.1, 2.8, 0.1, path[i].x, 2.85, path[i].z, m.metalDark, {
              surface: 'metal',
              solid: false,
              shootable: false,
            });
          }
        }

        this.barrierColliders(run.map((i) => ({ point: path[i], yaw: this.samples[i].yaw })));
      }
    }

    this.buildTyreWalls();
  }

  /**
   * Emits one collider per run of near-constant heading. An AABB cannot
   * represent a diagonal wall, so a corner gets several short boxes while a
   * straight gets a single exact one.
   */
  private barrierColliders(run: { point: THREE.Vector3; yaw: number }[]): void {
    const MAX_TURN = 0.16; // heading change tolerated inside one collider
    let start = 0;

    const emit = (from: number, to: number): void => {
      const a = run[from].point;
      const b = run[to].point;
      const length = a.distanceTo(b);
      if (length < 0.5) return;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const cos = Math.abs(Math.cos(yaw));
      const sin = Math.abs(Math.sin(yaw));
      this.world.addBox(
        new THREE.Vector3(mid.x, 0.8, mid.z),
        new THREE.Vector3(0.4 * cos + length * sin, 1.6, length * cos + 0.4 * sin),
        'metal',
      );
    };

    for (let i = 1; i < run.length; i++) {
      let delta = Math.abs(run[i].yaw - run[start].yaw) % (Math.PI * 2);
      if (delta > Math.PI) delta = Math.PI * 2 - delta;
      if (delta > MAX_TURN || i - start > 24) {
        emit(start, i);
        start = i;
      }
    }
    emit(start, run.length - 1);
  }

  /** Stacked tyre walls on the outside of the fastest corners. */
  private buildTyreWalls(): void {
    const m = this.materials;
    const tyre = new THREE.TorusGeometry(0.42, 0.17, 6, 14);

    for (let i = 0; i < this.samples.length; i += 3) {
      const s = this.samples[i];
      if (Math.abs(s.curvature) < 0.028) continue;
      const side = s.curvature > 0 ? 1 : -1;
      const base = s.position.clone().addScaledVector(s.normal, side * (RUNOFF_HALF + 0.7));
      if (base.z < PIT_MASK_Z) continue;
      for (let layer = 0; layer < 3; layer++) {
        this.prop(tyre, m.rubber, [base.x, 0.2 + layer * 0.36, base.z], [Math.PI / 2, s.yaw, 0], {
          surface: 'dirt',
          castShadow: layer === 2,
          shootable: false,
        });
      }
      // A conveyor-belt strap over the stack, as used on real circuits.
      this.box(1.1, 0.06, 0.5, base.x, 1.28, base.z, m.metalDark, {
        surface: 'metal',
        solid: false,
        shootable: false,
        rotationY: s.yaw,
      });
    }
  }

  /** Sponsor hoardings, braking boards and marshal posts around the lap. */
  private buildTrackside(): void {
    const m = this.materials;
    const sponsors = ['APEX FUELS', 'VERTEX TYRES', 'HELIOS', 'NORTHWIND', 'CARBON9'];

    for (let i = 0; i < this.samples.length; i += 10) {
      const s = this.samples[i];
      const p = s.position.clone().addScaledVector(s.normal, BARRIER_OFFSET + 0.1);
      if (p.z < PIT_MASK_Z) continue;
      // Face the boards back across the track, at right angles to the racing
      // line, so they read from a car rather than edge-on.
      this.sign(sponsors[(i / 10) % sponsors.length], undefined, p.x, 1.0, p.z, 5.2, 1.0, s.yaw + Math.PI / 2, {
        background: '#0e2f4a',
        borderColor: '#7fd4ff',
      });
    }

    for (const index of [40, 110, 180, 250]) {
      const s = this.samples[index % this.samples.length];
      const p = s.position.clone().addScaledVector(s.normal, BARRIER_OFFSET + 4);
      if (p.z < PIT_MASK_Z) continue;
      this.box(3.2, 0.2, 2.6, p.x, 0.4, p.z, m.concrete, { surface: 'concrete', rotationY: s.yaw });
      this.box(3.2, 0.12, 2.6, p.x, 3.0, p.z, m.metalDark, {
        surface: 'metal',
        solid: false,
        rotationY: s.yaw,
      });
      for (const cx of [-1.4, 1.4]) {
        for (const cz of [-1.1, 1.1]) {
          const off = new THREE.Vector3(cx, 0, cz).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw);
          this.box(0.14, 2.5, 0.14, p.x + off.x, 1.75, p.z + off.z, m.metalDark, { surface: 'metal' });
        }
      }
      // Flag rack and an extinguisher.
      this.box(0.1, 1.1, 0.1, p.x + 1.7, 1.05, p.z, m.metal, { surface: 'metal', solid: false });
      this.prop(new THREE.PlaneGeometry(0.7, 0.5), m.paintedYellow, [p.x + 2.05, 1.4, p.z], [0, s.yaw, 0], {
        surface: 'metal',
        castShadow: false,
      });
      this.prop(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 12), m.paintedRed, [p.x - 1.6, 0.8, p.z], [0, 0, 0], {
        surface: 'metal',
      });
      this.sign(`POST ${index / 10}`, undefined, p.x, 3.5, p.z, 2.4, 0.7, s.yaw + Math.PI / 2);
    }

    // Braking boards on the approach to the two heaviest corners.
    for (const anchor of [96, 236]) {
      for (let d = 0; d < 3; d++) {
        const s = this.samples[(anchor - d * 6 + this.samples.length) % this.samples.length];
        const p = s.position.clone().addScaledVector(s.normal, TRACK_HALF + 3.5);
        if (p.z < PIT_MASK_Z) continue;
        this.box(0.12, 1.4, 0.12, p.x, 0.7, p.z, m.metalDark, { surface: 'metal', solid: false });
        this.sign(`${(d + 1) * 50}`, undefined, p.x, 1.7, p.z, 1.2, 1.2, s.yaw + Math.PI / 2, {
          background: '#f2f2ee',
          borderColor: '#12161b',
          color: '#12161b',
        });
      }
    }
  }

  // -------------------------------------------------------------- start line

  private buildStartLine(): void {
    const m = this.materials;
    // The main straight runs along X at z = -70, so the start line, the grid
    // and the gantry all span Z.
    const EDGE_A = -70 - TRACK_HALF;
    const EDGE_B = -70 + TRACK_HALF;

    for (let i = 0; i < 26; i++) {
      const z = EDGE_A + i * 0.5;
      for (let row = 0; row < 2; row++) {
        this.prop(
          new THREE.PlaneGeometry(0.5, 0.5),
          (i + row) % 2 === 0 ? m.concreteDark : m.whitePaint,
          [0.25 + row * 0.5, 0.04, z + 0.25],
          [-Math.PI / 2, 0, 0],
          { surface: 'concrete', castShadow: false, shootable: false },
        );
      }
    }

    // Painted grid boxes staggered down the straight.
    for (let i = 0; i < 8; i++) {
      const x = -9 - i * 8;
      const z = -70 + (i % 2 === 0 ? -3.2 : 3.2);
      for (const [w, d, ox, oz] of [
        [4.6, 0.16, 0, -1.35],
        [4.6, 0.16, 0, 1.35],
        [0.16, 2.7, -2.3, 0],
      ] as [number, number, number, number][]) {
        this.prop(new THREE.PlaneGeometry(w, d), m.whitePaint, [x + ox, 0.038, z + oz], [-Math.PI / 2, 0, 0], {
          surface: 'concrete',
          castShadow: false,
          shootable: false,
        });
      }
      this.sign(`${i + 1}`, undefined, x + 1.4, 0.042, z, 1.6, 1.6, 0, {
        background: '#1a1d22',
        borderColor: '#f2f2ee',
        tiltX: -Math.PI / 2,
      });
    }

    // Start gantry: a tower each side of the track, a beam across it, and five
    // signal lights facing the oncoming cars (which arrive from -X).
    for (const z of [EDGE_A - 2.5, EDGE_B + 2.5]) {
      this.box(1.2, 8.4, 1.2, 0, 4.2, z, m.metalDark, { surface: 'metal' });
      for (let i = 0; i < 4; i++) {
        this.box(1.3, 0.14, 1.3, 0, 1.4 + i * 2.1, z, m.metal, { surface: 'metal', solid: false });
      }
    }
    const span = EDGE_B - EDGE_A + 5;
    this.box(1.4, 0.9, span, 0, 8.7, -70, m.metalDark, { surface: 'metal', solid: false });
    this.box(1.8, 0.3, span, 0, 8.1, -70, m.metal, { surface: 'metal', solid: false });
    this.sign('MERIDIAN CIRCUIT', undefined, -0.75, 9.6, -70, 14, 1.8, -Math.PI / 2, {
      background: '#0e2f4a',
      borderColor: '#7fd4ff',
    });

    for (let i = 0; i < 5; i++) {
      const z = -75 + i * 2.5;
      this.box(0.4, 1.5, 1.5, -0.6, 7.4, z, m.metalDark, { surface: 'metal', solid: false });
      // Each light gets its own material so the sequence can drive them.
      const lamp = new THREE.MeshStandardMaterial({
        color: 0x1a0002,
        emissive: 0xff1418,
        emissiveIntensity: 0.05,
        roughness: 0.4,
      });
      this.owned.push(lamp);
      this.signalLights.push(lamp);
      for (const y of [7.7, 7.1]) {
        this.prop(new THREE.CircleGeometry(0.3, 16), lamp, [-0.85, y, z], [0, -Math.PI / 2, 0], {
          surface: 'metal',
          castShadow: false,
          shootable: false,
        });
      }
    }
  }

  // ---------------------------------------------------------------- pit lane

  private buildPitLane(): void {
    const m = this.materials;
    const x0 = GARAGE_X0 - 12;
    const x1 = GARAGE_X1 + 22;
    const width = x1 - x0;
    const cx = (x0 + x1) / 2;

    // Pit apron: one slab from the wall back to the garage doors.
    this.box(width, 0.06, PIT_WALL_Z - GARAGE_FRONT_Z, cx, 0.02, (PIT_WALL_Z + GARAGE_FRONT_Z) / 2, m.asphalt, {
      surface: 'concrete',
      solid: false,
      castShadow: false,
    });
    // Fast-lane / working-lane divider.
    this.prop(
      new THREE.PlaneGeometry(width, 0.2),
      m.whitePaint,
      [cx, 0.05, PIT_LANE_Z - 1.6],
      [-Math.PI / 2, 0, 0],
      { surface: 'concrete', castShadow: false, shootable: false },
    );

    // Pit wall with a chequered cap. This is the barrier along the pit
    // straight — `PIT_MASK_Z` cuts the generated armco so they never overlap.
    // It is built in segments so the entry and exit stay open to the track.
    const wallSpans: [number, number][] = [
      [x0, PIT_ENTRY[0]],
      [PIT_ENTRY[1], PIT_EXIT[0]],
      [PIT_EXIT[1], x1],
    ];
    for (const [a, b] of wallSpans) {
      if (b - a < 0.5) continue;
      this.box(b - a, 1.1, 0.4, (a + b) / 2, 0.55, PIT_WALL_Z, m.concrete, { surface: 'concrete' });
      for (let i = 0; i < Math.round((b - a) / 1.2); i++) {
        this.box(
          1.2,
          0.12,
          0.5,
          a + 0.6 + i * 1.2,
          1.16,
          PIT_WALL_Z,
          i % 2 === 0 ? m.concreteDark : m.whitePaint,
          { surface: 'concrete', solid: false, shootable: false },
        );
      }
    }

    // Slip roads joining the pit lane to the circuit through those gaps.
    for (const [span, label] of [
      [PIT_ENTRY, 'PIT ENTRY'],
      [PIT_EXIT, 'PIT EXIT'],
    ] as [readonly [number, number], string][]) {
      const mid = (span[0] + span[1]) / 2;
      const gap = span[1] - span[0];
      const trackEdge = -70 - TRACK_HALF;
      const depth = Math.abs(trackEdge - PIT_WALL_Z) + 3;
      const centreZ = (PIT_WALL_Z + trackEdge) / 2;
      this.box(gap, 0.06, depth, mid, 0.03, centreZ, m.asphalt, {
        surface: 'concrete',
        solid: false,
        castShadow: false,
      });
      for (const side of [-1, 1]) {
        this.prop(
          new THREE.PlaneGeometry(0.18, depth),
          m.whitePaint,
          [mid + (side * gap) / 2, 0.07, centreZ],
          [-Math.PI / 2, 0, 0],
          { surface: 'concrete', castShadow: false, shootable: false },
        );
      }
      // Beside the opening, not across it — a tank is 3 m tall.
      this.sign(label, undefined, span[1] + 3, 2.2, PIT_WALL_Z - 0.35, 5.0, 1.0, Math.PI, {
        background: '#12161b',
        borderColor: '#7fd4ff',
      });
    }
    // Timing stands behind the wall, one per garage.
    for (const bay of BAYS) {
      this.box(4.4, 0.12, 2.2, bay.x, 2.3, PIT_WALL_Z - 1.6, m.metalDark, { surface: 'metal', solid: false });
      for (const dx of [-2, 2]) {
        this.box(0.16, 2.3, 0.16, bay.x + dx, 1.15, PIT_WALL_Z - 1.6, m.metalDark, {
          surface: 'metal',
          // Thin posts directly ahead of a garage door; leave them shootable
          // scenery rather than something a car snags on.
          solid: false,
        });
      }
      this.box(4.4, 1.0, 0.12, bay.x, 2.9, PIT_WALL_Z - 2.6, m.metalDark, { surface: 'metal', solid: false });
      this.sign('TIMING', undefined, bay.x, 2.9, PIT_WALL_Z - 2.67, 4.2, 0.9, Math.PI);
    }

    // Pit box markings and equipment in front of each garage.
    for (let i = 0; i < BAYS.length; i++) {
      const bay = BAYS[i];
      for (const [w, d, ox, oz] of [
        [0.18, 7, -3.7, 0],
        [0.18, 7, 3.7, 0],
        [7.4, 0.18, 0, 3.5],
      ] as [number, number, number, number][]) {
        this.prop(new THREE.PlaneGeometry(w, d), m.whitePaint, [bay.x + ox, 0.052, PIT_LANE_Z + oz], [-Math.PI / 2, 0, 0], {
          surface: 'concrete',
          castShadow: false,
          shootable: false,
        });
      }
      this.sign(`BOX ${i + 1}`, undefined, bay.x, 0.055, PIT_LANE_Z + 2.4, 2.6, 1.3, 0, {
        tiltX: -Math.PI / 2,
      });

      // Tyre sets stacked ready, a fuel rig and a wheel-gun trolley — pushed
      // out to the edges of the box so the lane straight ahead of the garage
      // door stays clear enough to drive a tank through.
      for (let stack = 0; stack < 3; stack++) {
        const sx = bay.x - 8.6 + stack * 1.1;
        for (let layer = 0; layer < 4; layer++) {
          this.prop(
            new THREE.TorusGeometry(0.36, 0.15, 6, 14),
            m.rubber,
            [sx, 0.16 + layer * 0.31, PIT_LANE_Z - 2.6],
            [Math.PI / 2, 0, 0],
            { surface: 'dirt', castShadow: layer === 3, shootable: false },
          );
        }
      }
      this.box(0.9, 1.7, 0.9, bay.x + 8.4, 0.85, PIT_LANE_Z - 2.4, m.metalDark, { surface: 'metal' });
      this.prop(
        new THREE.CylinderGeometry(0.06, 0.06, 1.4, 8),
        m.plastic,
        [bay.x + 8.4, 2.2, PIT_LANE_Z - 2.4],
        [0.3, 0, 0],
        { surface: 'metal', shootable: false },
      );
      this.box(1.3, 0.7, 0.6, bay.x + 6.6, 0.35, PIT_LANE_Z - 2.6, m.paintedRed, { surface: 'metal' });
      for (const gx of [-0.35, 0.35]) {
        this.prop(
          new THREE.CylinderGeometry(0.09, 0.09, 0.5, 10),
          m.gunMetal,
          [bay.x + 6.6 + gx, 0.9, PIT_LANE_Z - 2.6],
          [0.2, 0, 0],
          { surface: 'metal', shootable: false },
        );
      }
    }

    // Lane signage, facing the cars in the lane.
    this.sign('PIT LANE — 60 KM/H', undefined, x0 + 10, 2.2, PIT_WALL_Z - 0.25, 8, 1.1, Math.PI, {
      background: '#12161b',
      borderColor: '#f0b400',
    });
    for (const x of [x0 + 3, x1 - 3]) {
      this.box(0.5, 3.2, 0.5, x, 1.6, PIT_WALL_Z - 1, m.metalDark, { surface: 'metal' });
      this.box(0.7, 0.9, 0.4, x, 3.5, PIT_WALL_Z - 1, m.metalDark, { surface: 'metal', solid: false });
      this.prop(new THREE.CircleGeometry(0.22, 14), m.emissiveOrange, [x, 3.5, PIT_WALL_Z - 1.23], [0, Math.PI, 0], {
        surface: 'metal',
        castShadow: false,
        shootable: false,
      });
    }
  }

  // ------------------------------------------------------------------ garage

  private buildGarage(): void {
    const m = this.materials;
    const width = GARAGE_X1 - GARAGE_X0;
    const depth = GARAGE_FRONT_Z - GARAGE_BACK_Z;
    const cx = (GARAGE_X0 + GARAGE_X1) / 2;
    const cz = (GARAGE_FRONT_Z + GARAGE_BACK_Z) / 2;

    // Slab, back wall, side walls, roof.
    this.box(width + 3, FLOOR_Y, depth + 2, cx, FLOOR_Y / 2, cz - 0.5, m.floor, {
      surface: 'concrete',
      castShadow: false,
    });
    this.box(width + 3, GARAGE_H, 0.6, cx, GARAGE_H / 2, GARAGE_BACK_Z, m.concrete, { surface: 'concrete' });
    for (const x of [GARAGE_X0 - 1.2, GARAGE_X1 + 1.2]) {
      this.box(0.6, GARAGE_H, depth + 1, x, GARAGE_H / 2, cz, m.concrete, { surface: 'concrete' });
    }
    this.box(width + 6, 0.5, depth + 6, cx, GARAGE_H + 0.25, cz + 1.5, m.concreteDark, {
      surface: 'concrete',
      solid: false,
    });
    this.box(width + 6, 0.7, 0.4, cx, GARAGE_H + 0.75, GARAGE_FRONT_Z + 4.5, m.metalDark, {
      surface: 'metal',
      solid: false,
    });
    this.sign('PIT GARAGE 1 — 3', undefined, cx, GARAGE_H + 0.8, GARAGE_FRONT_Z + 4.72, 16, 1.4, 0, {
      background: '#0e2f4a',
      borderColor: '#7fd4ff',
    });

    // Piers between the bays, and a rolled-up shutter over each opening.
    const edges = [GARAGE_X0];
    for (const bay of BAYS) edges.push(bay.x - bay.halfWidth, bay.x + bay.halfWidth);
    edges.push(GARAGE_X1);
    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i];
      const b = edges[i + 1];
      if (b - a > 0.2) {
        this.box(b - a, GARAGE_H, 0.6, (a + b) / 2, GARAGE_H / 2, GARAGE_FRONT_Z, m.concrete, {
          surface: 'concrete',
        });
      }
    }
    for (const bay of BAYS) {
      this.box(bay.halfWidth * 2, 1.4, 0.6, bay.x, GARAGE_H - 0.7, GARAGE_FRONT_Z, m.concrete, {
        surface: 'concrete',
      });
      this.prop(
        new THREE.CylinderGeometry(0.5, 0.5, bay.halfWidth * 2 - 0.4, 14),
        m.metal,
        [bay.x, GARAGE_H - 1.7, GARAGE_FRONT_Z + 0.2],
        [0, 0, Math.PI / 2],
        { surface: 'metal', shootable: false },
      );
      for (const dx of [-1, 1]) {
        this.box(
          0.5,
          GARAGE_H - 1.4,
          0.5,
          bay.x + dx * (bay.halfWidth - 0.25),
          (GARAGE_H - 1.4) / 2,
          GARAGE_FRONT_Z,
          m.metalDark,
          { surface: 'metal' },
        );
      }
    }

    this.buildGarageInterior();
  }

  private buildGarageInterior(): void {
    const m = this.materials;
    const backZ = GARAGE_BACK_Z + 0.5;
    const midZ = (GARAGE_FRONT_Z + GARAGE_BACK_Z) / 2;

    for (let i = 0; i < BAYS.length; i++) {
      const bay = BAYS[i];
      const vehicle = VEHICLES[i];

      // Painted bay outline and a nameplate on the back wall.
      for (const oz of [6.5, -6.5]) {
        this.prop(
          new THREE.PlaneGeometry(bay.halfWidth * 2 - 2, 0.14),
          m.paintedYellow,
          [bay.x, FLOOR_Y + 0.01, midZ + oz],
          [-Math.PI / 2, 0, 0],
          { surface: 'concrete', castShadow: false, shootable: false },
        );
      }
      this.sign(vehicle.name, vehicle.subtitle, bay.x, 4.6, backZ - 0.2, 7.5, 1.6, 0, {
        background: '#12161b',
        borderColor: '#f0b400',
      });

      // Workbench along the back wall with a tool chest and a pegboard.
      this.box(7.0, 0.12, 1.0, bay.x + 5.5, FLOOR_Y + 0.95, backZ + 0.5, m.metal, { surface: 'metal' });
      this.box(7.0, 0.85, 0.9, bay.x + 5.5, FLOOR_Y + 0.45, backZ + 0.55, m.metalDark, { surface: 'metal' });
      for (let d = 0; d < 4; d++) {
        this.box(1.5, 0.16, 0.06, bay.x + 3.0 + d * 1.7, FLOOR_Y + 0.6, backZ + 0.1, m.chrome, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
      }
      this.box(1.4, 1.5, 0.8, bay.x + 8.6, FLOOR_Y + 0.75, backZ + 0.6, m.paintedRed, { surface: 'metal' });
      for (let d = 0; d < 5; d++) {
        this.box(1.3, 0.06, 0.06, bay.x + 8.6, FLOOR_Y + 0.35 + d * 0.26, backZ + 0.2, m.chrome, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
      }
      this.prop(new THREE.PlaneGeometry(4.5, 2.0), m.metalDark, [bay.x + 5.5, FLOOR_Y + 2.4, backZ - 0.02], [0, 0, 0], {
        surface: 'metal',
        castShadow: false,
      });
      for (let t = 0; t < 9; t++) {
        this.box(0.08, randRange(0.3, 0.6), 0.05, bay.x + 3.6 + t * 0.45, FLOOR_Y + 2.6, backZ + 0.03, m.chrome, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
      }

      // Tyre rack on the other side of the bay.
      for (let shelf = 0; shelf < 3; shelf++) {
        this.box(4.2, 0.1, 0.9, bay.x - 6.8, FLOOR_Y + 0.5 + shelf * 0.95, backZ + 0.5, m.metalDark, {
          surface: 'metal',
          solid: shelf === 0,
        });
        for (let t = 0; t < 4; t++) {
          this.prop(
            new THREE.TorusGeometry(0.36, 0.15, 6, 14),
            m.rubber,
            [bay.x - 8.4 + t * 1.05, FLOOR_Y + 0.93 + shelf * 0.95, backZ + 0.5],
            [0, 0, Math.PI / 2],
            { surface: 'dirt', castShadow: false, shootable: false },
          );
        }
      }
      for (const dx of [-2.05, 2.05]) {
        this.box(0.12, 3.0, 0.12, bay.x - 6.8 + dx, FLOOR_Y + 1.5, backZ + 0.5, m.metalDark, { surface: 'metal' });
      }

      // Floor kit: trolley jack, axle stands, drums, hose reel.
      this.box(1.5, 0.22, 0.5, bay.x - 4.2, FLOOR_Y + 0.11, midZ + 4, m.paintedRed, { surface: 'metal' });
      for (const sx of [-1, 1]) {
        this.prop(
          new THREE.CylinderGeometry(0.12, 0.26, 0.55, 8),
          m.metalDark,
          [bay.x + sx * 3.4, FLOOR_Y + 0.27, midZ + 4.6],
          [0, 0, 0],
          { surface: 'metal' },
        );
      }
      for (let d = 0; d < 2; d++) {
        this.prop(
          new THREE.CylinderGeometry(0.32, 0.32, 0.9, 14),
          d === 0 ? m.paintedBlue : m.paintedGreen,
          [bay.x + 7.6 + d * 0.75, FLOOR_Y + 0.45, midZ + 4.4],
          [0, 0, 0],
          { surface: 'metal' },
        );
      }
      this.prop(
        new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14),
        m.metalDark,
        [bay.x - 8.8, FLOOR_Y + 2.9, backZ + 0.6],
        [0, 0, Math.PI / 2],
        { surface: 'metal', shootable: false },
      );

      // Two overhead service lights per bay — the emissive panels read as the
      // source, the point lights do the work. The garage faces away from the
      // sun, so without these the bays are caves.
      for (const [z, optional] of [
        [midZ + 3.5, false],
        [midZ - 4.5, true],
      ] as [number, boolean][]) {
        this.box(bay.halfWidth * 2 - 3, 0.16, 0.8, bay.x, GARAGE_H - 1.1, z, m.metalDark, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
        this.box(bay.halfWidth * 2 - 3.4, 0.1, 0.62, bay.x, GARAGE_H - 1.22, z, m.lampLens, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
        const lamp = new THREE.PointLight(0xe4edff, 240, 42, 2);
        lamp.position.set(bay.x, GARAGE_H - 1.6, z);
        this.root.add(lamp);
        if (optional) this.optionalLights.push(lamp);
        else this.flickerLamps.push({ light: lamp, base: 240, phase: bay.x });
      }
    }

    // Ammunition point just inside the door of bay 1.
    for (let i = 0; i < 4; i++) {
      this.box(1.2, 0.68, 0.8, GARAGE_X0 + 3.2, FLOOR_Y + 0.35, GARAGE_FRONT_Z - 3 - i * 0.9, m.wood, {
        surface: 'wood',
      });
      this.box(1.24, 0.08, 0.84, GARAGE_X0 + 3.2, FLOOR_Y + 0.72, GARAGE_FRONT_Z - 3 - i * 0.9, m.metalDark, {
        surface: 'metal',
        solid: false,
      });
    }
    this.sign('AMMO — PRESS E TO RESUPPLY', undefined, GARAGE_X0 + 3.2, FLOOR_Y + 1.8, GARAGE_FRONT_Z - 1.9, 5.0, 1.0, 0);
    this.ammoCrates.push({
      position: new THREE.Vector3(GARAGE_X0 + 3.2, FLOOR_Y, GARAGE_FRONT_Z - 4.3),
      radius: 3.5,
    });

    this.poster('safety', GARAGE_X1 - 1.6, 2.6, GARAGE_BACK_Z + 0.32, 1.4, 0);
    this.poster('rules', GARAGE_X1 - 3.4, 2.6, GARAGE_BACK_Z + 0.32, 1.4, 0);
  }

  /**
   * Vehicles are drivable, so the level only says *where* they go. Building and
   * owning them belongs to `VehicleSystem` — baking them into the static batch
   * here would be exactly wrong.
   */
  private buildVehicles(): void {
    const z = (GARAGE_FRONT_Z + GARAGE_BACK_Z) / 2 + 1;
    for (let i = 0; i < BAYS.length; i++) {
      // Parked nose-out toward the pit lane, angled a few degrees so the row
      // does not read as a parade line.
      this.vehicleSpawns.push({
        id: BAYS[i].id,
        position: new THREE.Vector3(BAYS[i].x, FLOOR_Y, z),
        yaw: (i - 1) * 0.06,
      });
    }
  }

  // -------------------------------------------------------------- spectating

  private buildGrandstand(): void {
    const m = this.materials;
    const cx = 30;
    const frontZ = -50; // just inside the infield barrier, rows recede in +Z
    const width = 60;
    const rows = 12;

    this.box(width, 0.4, 3, cx, 0.2, frontZ - 1.5, m.concrete, { surface: 'concrete' });
    for (let r = 0; r < rows; r++) {
      const y = 0.4 + r * 0.45;
      const z = frontZ + r * 0.85;
      this.box(width, 0.45, 0.85, cx, y - 0.22, z, m.concreteDark, { surface: 'concrete' });
      for (let s = 0; s < 20; s++) {
        const sx = cx - width / 2 + 1.5 + s * 3;
        const colour = Math.floor(s / 5) % 2 === 0 ? m.paintedBlue : m.paintedYellow;
        this.box(2.4, 0.42, 0.12, sx, y + 0.2, z + 0.32, colour, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
      }
    }

    const backZ = frontZ + rows * 0.85;
    for (let i = 0; i < 7; i++) {
      const x = cx - width / 2 + 2 + i * ((width - 4) / 6);
      this.box(0.6, 9, 0.6, x, 4.5, backZ + 1.5, m.metalDark, { surface: 'metal' });
    }
    this.box(width + 4, 0.4, 14, cx, 9.2, backZ - 5, m.metalDark, { surface: 'metal', solid: false });
    this.sign('GRANDSTAND A', undefined, cx, 10.0, backZ - 11.9, 18, 1.6, Math.PI, {
      background: '#12161b',
      borderColor: '#f0b400',
    });
  }

  /** Paddock, timing tower and floodlights — all behind the pit wall. */
  private buildPaddock(): void {
    const m = this.materials;

    const tx = GARAGE_X1 + 26;
    const tz = GARAGE_FRONT_Z - 3;
    this.box(7, 22, 7, tx, 11, tz, m.concrete, { surface: 'concrete' });
    for (let f = 1; f < 6; f++) {
      this.box(7.6, 0.3, 7.6, tx, f * 3.6, tz, m.metalDark, { surface: 'metal', solid: false });
      this.prop(new THREE.PlaneGeometry(6.4, 2.4), m.glass, [tx, f * 3.6 + 1.8, tz + 3.55], [0, 0, 0], {
        surface: 'metal',
        castShadow: false,
      });
    }
    this.box(8, 3, 0.4, tx, 19, tz + 3.6, m.metalDark, { surface: 'metal', solid: false });
    this.sign('MERIDIAN', 'LAP 41 / 58', tx, 19, tz + 3.82, 7.4, 2.8, 0, {
      background: '#0b0e12',
      borderColor: '#7fd4ff',
      color: '#7fd4ff',
    });
    this.box(0.3, 8, 0.3, tx, 26, tz, m.metalDark, { surface: 'metal', solid: false });

    // Transporters lined up behind the garage.
    for (let i = 0; i < 5; i++) {
      const x = GARAGE_X0 + 4 + i * 17;
      const z = GARAGE_BACK_Z - 12;
      this.box(2.6, 3.2, 12, x, 1.6, z, m.metal, { surface: 'metal' });
      this.box(2.6, 1.4, 3.4, x, 2.9, z + 7.4, m.paintedBlue, { surface: 'metal' });
      this.box(2.7, 1.2, 2.4, x, 0.6, z + 7.6, m.metalDark, { surface: 'metal' });
      for (const dz of [-3.2, 3.4]) {
        for (const dx of [-1.1, 1.1]) {
          this.prop(
            new THREE.CylinderGeometry(0.55, 0.55, 0.36, 14),
            m.rubber,
            [x + dx, 0.55, z + dz],
            [0, 0, Math.PI / 2],
            { surface: 'dirt', shootable: false },
          );
        }
      }
    }
    // Freight containers stacked behind them.
    for (let i = 0; i < 8; i++) {
      const x = GARAGE_X0 - 8 + i * 4.2;
      const z = GARAGE_BACK_Z - 24 - (i % 2) * 3;
      this.box(4, 2.6, 2.4, x, 1.3, z, i % 3 === 0 ? m.paintedGreen : m.paintedRed, { surface: 'metal' });
      for (let r = 0; r < 6; r++) {
        this.box(0.1, 2.5, 0.1, x - 1.9 + r * 0.76, 1.3, z + 1.22, m.metalDark, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
      }
    }

    // Floodlight masts around the pit complex, clear of the racing surface.
    for (const [x, z] of [
      [GARAGE_X0 - 16, PIT_WALL_Z - 2],
      [GARAGE_X1 + 16, PIT_WALL_Z - 2],
      [GARAGE_X0 - 16, GARAGE_BACK_Z - 6],
      [GARAGE_X1 + 16, GARAGE_BACK_Z - 6],
    ] as [number, number][]) {
      this.box(1.0, 18, 1.0, x, 9, z, m.metalDark, { surface: 'metal' });
      this.box(4.4, 0.4, 1.6, x, 18.4, z, m.metalDark, { surface: 'metal', solid: false });
      for (let i = 0; i < 4; i++) {
        this.box(0.9, 0.7, 0.5, x - 1.6 + i * 1.05, 18.9, z, m.lampLens, {
          surface: 'metal',
          solid: false,
          shootable: false,
        });
      }
      const flood = new THREE.PointLight(0xdfeaff, 300, 90, 2);
      flood.position.set(x, 18, z);
      this.root.add(flood);
      this.optionalLights.push(flood);
    }
  }

  private buildSurroundings(): void {
    const m = this.materials;

    const trunk = new THREE.CylinderGeometry(0.28, 0.42, 3.4, 6);
    const canopy = new THREE.ConeGeometry(2.6, 6.5, 7);
    for (let i = 0; i < 150; i++) {
      const a = (i / 150) * Math.PI * 2;
      const r = randRange(190, 300);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 0.85 - 40;
      // Keep the gunnery corridor clear — a tree at 120 m would hide a gong.
      if (x > 30 && x < 130 && z < -85) continue;
      const s = randRange(0.8, 1.5);
      this.prop(trunk, m.wood, [x, 1.7 * s, z], [0, 0, 0], { surface: 'wood', scale: s, shootable: false });
      this.prop(canopy, m.paintedGreen, [x, 6.6 * s, z], [0, randRange(0, 3), 0], {
        surface: 'wood',
        scale: s,
        shootable: false,
      });
    }

    const hill = new THREE.ConeGeometry(90, 42, 9);
    for (let i = 0; i < 7; i++) {
      const a = -0.5 + (i / 7) * Math.PI * 2;
      this.prop(hill, m.dirtBerm, [Math.cos(a) * 460, 10, Math.sin(a) * 460 - 40], [0, randRange(0, 3), 0], {
        surface: 'dirt',
        scale: [randRange(0.8, 1.5), randRange(0.6, 1.2), randRange(0.8, 1.5)],
        castShadow: false,
        shootable: false,
      });
    }
  }

  // ----------------------------------------------------------------- targets

  /**
   * A gunnery range on the service road east of the pit complex, well clear of
   * the circuit. Laid out downrange along -Z so it follows the same convention
   * as the shooting range: targets are modelled facing +Z, which is where the
   * firing point is.
   */
  private buildGunneryRange(): void {
    const m = this.materials;

    const add = (
      kind: TargetKind,
      x: number,
      z: number,
      extra: { travel?: number; speed?: number; resetDelay?: number; label?: string } = {},
    ): void => {
      const target = new RangeTarget({ kind, position: new THREE.Vector3(x, 0, z), ...extra });
      target.distance = Math.abs(z - RANGE_FIRING_Z);
      target.randomisePhase();
      this.root.add(target.root);
      this.targets.push(target);
      this.collidables.push(...target.hitMeshes);
    };

    // Firing point: a concrete apron with a shooting bench and a berm behind.
    this.box(44, 0.12, 14, RANGE_X, 0.06, RANGE_FIRING_Z + 4, m.floor, {
      surface: 'concrete',
      solid: false,
      castShadow: false,
    });
    this.box(44, 1.4, 1.2, RANGE_X, 0.7, RANGE_FIRING_Z + 10.6, m.concreteDark, { surface: 'concrete' });
    for (let i = 0; i < 5; i++) {
      const x = RANGE_X - 16 + i * 8;
      this.box(2.4, 0.1, 0.9, x, 1.05, RANGE_FIRING_Z, m.wood, { surface: 'wood' });
      for (const dx of [-1, 1]) {
        this.box(0.12, 1.0, 0.12, x + dx, 0.5, RANGE_FIRING_Z, m.metalDark, { surface: 'metal', solid: false });
      }
      // Lane boards hang well above head height: anything between the bench and
      // the targets would sit squarely in the line of fire.
      this.box(0.1, 1.6, 0.1, x - 1.2, 1.9, RANGE_FIRING_Z + 0.4, m.metalDark, {
        surface: 'metal',
        solid: false,
        shootable: false,
      });
      this.sign(`LANE ${i + 1}`, undefined, x, 2.8, RANGE_FIRING_Z + 0.4, 2.0, 0.6, Math.PI);
    }
    this.sign('SERVICE ROAD GUNNERY RANGE', undefined, RANGE_X, 2.8, RANGE_FIRING_Z + 9.9, 12, 1.2, Math.PI, {
      background: '#12161b',
      borderColor: '#f0b400',
    });

    // Close line at 15 m, mixed line at 25 m, reactive line at 40 m.
    const kinds: TargetKind[] = ['silhouette', 'paper', 'steel'];
    for (let i = 0; i < 5; i++) {
      add(kinds[i % 3], RANGE_X - 16 + i * 8, RANGE_FIRING_Z - 15, { resetDelay: i % 3 === 0 ? 4 : 2.5 });
    }
    for (let i = 0; i < 5; i++) {
      add(kinds[(i + 1) % 3], RANGE_X - 16 + i * 8, RANGE_FIRING_Z - 25, { resetDelay: 3 });
    }
    for (let i = 0; i < 4; i++) {
      add('popper', RANGE_X - 12 + i * 8, RANGE_FIRING_Z - 40, { resetDelay: 3.5 });
    }

    // Swingers at 55 m and long gongs out to 130 m.
    for (let i = 0; i < 2; i++) {
      add('swinger', RANGE_X - 10 + i * 20, RANGE_FIRING_Z - 55, { travel: 14, speed: 2.4 + i * 0.5 });
    }
    for (let i = 0; i < 4; i++) {
      add('gong', RANGE_X - 15 + i * 10, RANGE_FIRING_Z - 75 - i * 18);
    }

    // Distance markers and a stop butt behind the far targets.
    for (const d of [15, 25, 40, 55, 100]) {
      this.box(0.1, 1.0, 0.1, RANGE_X - 22, 0.5, RANGE_FIRING_Z - d, m.metalDark, {
        surface: 'metal',
        solid: false,
      });
      this.sign(`${d}m`, undefined, RANGE_X - 22, 1.3, RANGE_FIRING_Z - d, 1.4, 0.7, Math.PI / 2);
    }
    this.prop(
      new THREE.BoxGeometry(60, 7, 12),
      m.dirtBerm,
      [RANGE_X, 2.5, RANGE_FIRING_Z - 150],
      [0.22, 0, 0],
      { surface: 'dirt' },
    );
    this.world.addBox(
      new THREE.Vector3(RANGE_X, 2.5, RANGE_FIRING_Z - 150),
      new THREE.Vector3(60, 7, 12),
      'dirt',
    );
  }

  // ---------------------------------------------------------------- lighting

  private buildLighting(): { sun: THREE.DirectionalLight; sky: Sky } {
    // Afternoon sun out over the infield, on the +Z side. The garage opens
    // north onto the pit lane, so this is what puts light on its facade and on
    // the cars parked inside — and it sits behind a player looking into the
    // bays rather than in their eyes.
    const { sun, sky } = this.buildSkyAndSun({
      elevation: 46,
      azimuth: 22,
      // An open circuit is lit almost entirely by the sky, with none of the
      // strong overhead lamps that carry the covered range, so the daylight
      // rig here is several times hotter than the one in `ShootingRange`.
      intensity: 4.6,
      turbidity: 4.2,
      rayleigh: 1.5,
      shadowRadius: 130,
      shadowFar: 560,
      shadowTarget: [-10, 0, -88],
    });

    this.root.add(new THREE.HemisphereLight(0xc4dbff, 0x7d7a60, 2.6));
    this.root.add(new THREE.AmbientLight(0xe2e9f2, 0.55));

    // Fill bounced off the pit apron, aimed into the garage so the shaded
    // depth of the bays keeps some shape instead of crushing to black.
    const bounce = new THREE.DirectionalLight(0xd8cbae, 0.9);
    bounce.position.set(0, 2, 40);
    bounce.target.position.set(0, 1, -110);
    this.root.add(bounce);
    this.root.add(bounce.target);

    return { sun, sky };
  }

  private buildAtmospherics(): void {
    // Motes hanging in the garage lights, plus a wider, sparser haze over the
    // pit lane so the outdoor space is not sterile.
    this.buildDustField({
      count: 420,
      bounds: { x: [GARAGE_X0, GARAGE_X1], y: [0.3, 5.0], z: [GARAGE_BACK_Z, GARAGE_FRONT_Z] },
      drift: 1.2,
    });
    this.buildDustField({
      count: 260,
      bounds: { x: [-80, 60], y: [0.5, 6.0], z: [PIT_WALL_Z - 12, PIT_WALL_Z + 4] },
      colour: [0.95, 0.94, 0.88],
      opacity: 0.12,
      size: 9,
      drift: 3.0,
    });
  }
}
