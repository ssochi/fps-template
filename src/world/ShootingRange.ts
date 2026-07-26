import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CollisionWorld } from '../physics/CollisionWorld';
import { createTextTexture, createWorldMaterials } from './Materials';
import { RangeTarget, type TargetKind } from './Targets';
import type { WeaponId } from '../weapons/WeaponTypes';
import { WEAPON_CONFIGS, WEAPON_ORDER } from '../weapons/WeaponConfigs';

/**
 * The shooting range level.
 *
 * Downrange is -Z. The player spawns on the covered firing line at the origin
 * looking down the lanes. Everything is built from primitives and registered
 * with the collision world and the shooting raycast list as it is created.
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
  /** Lights that should be disabled on the low quality preset. */
  optionalLights: THREE.Light[];
}

const LANE_CENTRES = [-16, -8, 0, 8, 16];
const LANE_HALF_WIDTH = 4;
const RANGE_LENGTH = 170;
const FIRING_LINE_Z = 0;

export class ShootingRange {
  private readonly materials = createWorldMaterials();
  private readonly root = new THREE.Group();
  private readonly collidables: THREE.Object3D[] = [];
  private readonly targets: RangeTarget[] = [];
  private readonly pickups: WeaponPickup[] = [];
  private readonly optionalLights: THREE.Light[] = [];
  private readonly world: CollisionWorld;

  constructor(world: CollisionWorld) {
    this.world = world;
    this.root.name = 'shooting-range';
  }

  build(): RangeBuildResult {
    this.buildGround();
    this.buildFiringLine();
    this.buildLanes();
    this.buildBerms();
    this.buildDistanceMarkers();
    this.buildTargets();
    this.buildProps();
    this.buildWeaponPedestals();

    const { sun, sky } = this.buildLighting();

    return {
      root: this.root,
      targets: this.targets,
      collidables: this.collidables,
      pickups: this.pickups,
      spawnPoint: new THREE.Vector3(0, 0.05, 4),
      spawnYaw: 0,
      sun,
      sky,
      optionalLights: this.optionalLights,
    };
  }

  // ----------------------------------------------------------------- helpers

  /**
   * Adds a box to the scene, the collision world and the raycast list in one
   * call — the single place level geometry gets registered.
   */
  private box(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
    opts: {
      solid?: boolean;
      surface?: 'concrete' | 'metal' | 'dirt' | 'wood';
      shootable?: boolean;
      castShadow?: boolean;
      receiveShadow?: boolean;
      parent?: THREE.Object3D;
    } = {},
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = opts.castShadow ?? true;
    mesh.receiveShadow = opts.receiveShadow ?? true;
    mesh.userData.surface = opts.surface ?? 'concrete';
    (opts.parent ?? this.root).add(mesh);

    if (opts.solid !== false) {
      this.world.addBox(
        new THREE.Vector3(x, y, z),
        new THREE.Vector3(w, h, d),
        opts.surface ?? 'concrete',
      );
    }
    if (opts.shootable !== false) this.collidables.push(mesh);
    return mesh;
  }

  private sign(
    text: string,
    subtitle: string | undefined,
    x: number,
    y: number,
    z: number,
    width = 2,
    height = 1,
    rotationY = 0,
  ): THREE.Mesh {
    const tex = createTextTexture(text, {
      subtitle,
      background: '#12161b',
      borderColor: '#f0b400',
      color: '#f5f5f0',
      width: 512,
      height: Math.round((512 * height) / width),
    });
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide }),
    );
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotationY;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this.collidables.push(mesh);
    return mesh;
  }

  // ------------------------------------------------------------------ ground

  private buildGround(): void {
    const m = this.materials;

    // Outer terrain.
    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), m.grass);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = -0.02;
    terrain.receiveShadow = true;
    terrain.userData.surface = 'dirt';
    this.root.add(terrain);
    this.collidables.push(terrain);
    this.world.addBox(
      new THREE.Vector3(0, -5.02, 0),
      new THREE.Vector3(700, 10, 700),
      'dirt',
    );

    // Concrete firing line pad.
    const pad = new THREE.Mesh(new THREE.BoxGeometry(52, 0.3, 22), m.floor);
    pad.position.set(0, 0.0, 3);
    pad.receiveShadow = true;
    pad.castShadow = false;
    pad.userData.surface = 'concrete';
    this.root.add(pad);
    this.collidables.push(pad);
    this.world.addBox(new THREE.Vector3(0, 0, 3), new THREE.Vector3(52, 0.3, 22), 'concrete');

    // Downrange gravel strip.
    const gravel = new THREE.Mesh(new THREE.PlaneGeometry(52, RANGE_LENGTH), m.concreteDark);
    gravel.rotation.x = -Math.PI / 2;
    gravel.position.set(0, 0.01, -RANGE_LENGTH / 2 - 8);
    gravel.receiveShadow = true;
    gravel.userData.surface = 'dirt';
    this.root.add(gravel);
    this.collidables.push(gravel);
    this.world.addBox(
      new THREE.Vector3(0, -0.15, -RANGE_LENGTH / 2 - 8),
      new THREE.Vector3(52, 0.3, RANGE_LENGTH),
      'dirt',
    );

    // Yellow firing line stripe.
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(48, 0.35),
      new THREE.MeshStandardMaterial({ color: 0xf0b400, roughness: 0.8 }),
    );
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(0, 0.16, FIRING_LINE_Z - 1.6);
    stripe.receiveShadow = true;
    this.root.add(stripe);
  }

  // ------------------------------------------------------------ firing line

  private buildFiringLine(): void {
    const m = this.materials;
    const roofY = 4.4;

    // Rear wall with a doorway feel.
    this.box(52, 4.6, 0.6, 0, 2.3, 13.5, m.concrete, { surface: 'concrete' });
    // Side walls.
    this.box(0.6, 4.6, 22, -25.7, 2.3, 3, m.concrete, { surface: 'concrete' });
    this.box(0.6, 4.6, 22, 25.7, 2.3, 3, m.concrete, { surface: 'concrete' });

    // Roof over the firing line.
    const roof = this.box(52, 0.4, 18, 0, roofY, 4.5, m.metalDark, { surface: 'metal' });
    roof.receiveShadow = true;

    // Support pillars. These sit on the lane divider lines so no pillar ever
    // stands in a lane's line of fire.
    for (const x of [-20, -12, -4, 4, 12, 20]) {
      this.box(0.5, roofY, 0.5, x, roofY / 2, -3.6, m.metalDark, { surface: 'metal' });
    }

    // Roof trusses (decorative, no collision).
    for (let i = 0; i < 9; i++) {
      const z = -4 + i * 2;
      this.box(50, 0.18, 0.18, 0, roofY - 0.35, z, m.metal, {
        solid: false,
        shootable: false,
        surface: 'metal',
      });
    }

    // Hazard strip along the roof edge.
    const hazard = new THREE.Mesh(new THREE.BoxGeometry(52, 0.5, 0.12), m.hazard);
    hazard.position.set(0, roofY - 0.45, -4.5);
    this.root.add(hazard);

    // Shooting benches on the line.
    for (const x of LANE_CENTRES) {
      this.box(2.6, 0.12, 0.9, x, 1.05, -1.0, m.wood, { surface: 'wood' });
      this.box(0.14, 1.0, 0.14, x - 1.1, 0.5, -1.3, m.metalDark, { surface: 'metal' });
      this.box(0.14, 1.0, 0.14, x + 1.1, 0.5, -1.3, m.metalDark, { surface: 'metal' });
      this.box(0.14, 1.0, 0.14, x - 1.1, 0.5, -0.7, m.metalDark, { surface: 'metal' });
      this.box(0.14, 1.0, 0.14, x + 1.1, 0.5, -0.7, m.metalDark, { surface: 'metal' });
    }

    // Overhead lights under the roof. Emissive strips read as the light
    // source; a handful of point lights do the actual illumination.
    const tubeMaterial = new THREE.MeshStandardMaterial({
      color: 0x2a2e33,
      emissive: 0xdfe9ff,
      emissiveIntensity: 0.85,
      roughness: 0.4,
    });
    // Point-light intensity is in candela and falls off with the square of the
    // distance, so covering a 4.4 m ceiling over a wide bay needs large values.
    for (const x of [-19, -11, -3, 5, 13, 21]) {
      for (const z of [-2, 7]) {
        const housing = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.16, 0.5), m.metalDark);
        housing.position.set(x, roofY - 0.35, z);
        this.root.add(housing);

        const tube = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.08, 0.35), tubeMaterial);
        tube.position.set(x, roofY - 0.45, z);
        this.root.add(tube);

        const light = new THREE.PointLight(0xdce8ff, 46, 32, 2);
        light.position.set(x, roofY - 0.75, z);
        this.root.add(light);
        this.optionalLights.push(light);
      }
    }

    this.sign('FIRING RANGE', 'KEEP MUZZLE DOWNRANGE', 0, 3.4, 13.15, 8, 2, Math.PI);
  }

  // ----------------------------------------------------------------- lanes

  private buildLanes(): void {
    const m = this.materials;

    for (let i = 0; i < LANE_CENTRES.length; i++) {
      const cx = LANE_CENTRES[i];

      // Lane divider walls run a short way downrange.
      for (const side of [-1, 1]) {
        const x = cx + side * (LANE_HALF_WIDTH + 0.15);
        if (i > 0 && side < 0) continue; // shared divider
        this.box(0.3, 1.5, 26, x, 0.75, -13, m.concrete, { surface: 'concrete' });
      }

      // Lane number board hanging from the roof.
      this.sign(`LANE ${i + 1}`, undefined, cx, 3.5, -4.3, 2.4, 0.9, 0);
    }
  }

  // ----------------------------------------------------------------- berms

  private buildBerms(): void {
    const m = this.materials;

    // Impact berm at the far end.
    this.box(60, 14, 6, 0, 7, -RANGE_LENGTH - 6, m.concreteDark, { surface: 'concrete' });
    // Sloped face made of stacked slabs so rounds have something to bite into.
    for (let i = 0; i < 6; i++) {
      this.box(
        60,
        2.4,
        3 - i * 0.35,
        0,
        1.2 + i * 2.3,
        -RANGE_LENGTH - 2.6 - i * 0.7,
        m.concreteDark,
        { surface: 'concrete' },
      );
    }

    // Side berms.
    for (const side of [-1, 1]) {
      this.box(4, 8, RANGE_LENGTH + 20, side * 28, 4, -RANGE_LENGTH / 2 - 4, m.concreteDark, {
        surface: 'concrete',
      });
    }

    this.sign('DANGER — IMPACT AREA', undefined, 0, 9, -RANGE_LENGTH - 2.9, 16, 2.4, 0);
  }

  private buildDistanceMarkers(): void {
    const m = this.materials;
    for (const distance of [10, 25, 50, 75, 100, 150]) {
      for (const side of [-1, 1]) {
        const x = side * 25;
        const z = -distance;
        this.box(0.16, 2.2, 0.16, x, 1.1, z, m.metalDark, {
          surface: 'metal',
          solid: false,
        });
        this.sign(`${distance}m`, undefined, x - side * 0.5, 2.4, z, 1.6, 0.8, side > 0 ? -Math.PI / 2 : Math.PI / 2);
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
      this.addTarget('popper', l1 - 3 + i * 1.5, -8 - (i % 2) * 2, { label: `Plate ${i + 1}` });
    }
    this.addTarget('steel', l1 - 2, -16);
    this.addTarget('steel', l1 + 2, -16);
    this.addTarget('silhouette', l1, -24);

    // --- Lane 2: pistol / SMG progression + the penetration demo ---------
    // The plywood wall built in `buildProps` stands at (l2, -18); the steel
    // plate behind it can only be hit by punching a round through the wood.
    const l2 = LANE_CENTRES[1];
    this.addTarget('silhouette', l2 - 2.6, -12);
    this.addTarget('silhouette', l2 + 2.6, -12);
    this.addTarget('steel', l2, -22, { label: 'Penetration plate' });
    this.addTarget('paper', l2 - 2.8, -32);
    this.addTarget('paper', l2 + 2.8, -32);

    // --- Lane 3: centre precision lane -----------------------------------
    // Paper targets are held off the centre line so there is an unobstructed
    // alley straight through to the 100 m gong.
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
    this.addTarget('silhouette', l5 - 2, -100);
    this.addTarget('silhouette', l5 + 2, -100);
    this.addTarget('gong', l5, -150, { scale: 1.2 });
    this.addTarget('steel', l5 - 3, -125, { scale: 1.1 });
    this.addTarget('steel', l5 + 3, -125, { scale: 1.1 });
  }

  // ------------------------------------------------------------------ props

  private buildProps(): void {
    const m = this.materials;

    // Ammo crates behind the firing line.
    for (let i = 0; i < 4; i++) {
      const x = -22 + i * 1.4;
      this.box(1.2, 0.7, 0.8, x, 0.5, 10.5, m.wood, { surface: 'wood' });
      this.box(1.24, 0.08, 0.84, x, 0.88, 10.5, m.metalDark, {
        surface: 'metal',
        solid: false,
      });
    }
    this.sign('AMMO — WALK UP TO RESUPPLY', undefined, -20, 1.9, 10.0, 5, 1, Math.PI);

    // Sandbag stacks for cover / braced-shooting practice, kept on the flanks
    // so they never obstruct a lane.
    for (const side of [-1, 1]) {
      const baseX = side * 21.5;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3 - row; col++) {
          this.box(
            0.9,
            0.35,
            0.5,
            baseX + (col * 0.95 + row * 0.45) * side,
            0.18 + row * 0.35,
            -2.5,
            m.concreteDark,
            { surface: 'dirt' },
          );
        }
      }
    }

    // Barrels scattered downrange as incidental cover.
    const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.9, 14);
    for (const [x, z] of [
      [-22, -30],
      [-20.5, -31.5],
      [21, -45],
      [22.5, -46],
      [-21, -70],
    ] as const) {
      const barrel = new THREE.Mesh(barrelGeo, m.metal);
      barrel.position.set(x, 0.45, z);
      barrel.castShadow = true;
      barrel.receiveShadow = true;
      barrel.userData.surface = 'metal';
      this.root.add(barrel);
      this.collidables.push(barrel);
      this.world.addBox(new THREE.Vector3(x, 0.45, z), new THREE.Vector3(0.64, 0.9, 0.64), 'metal');
    }

    // Penetration test wall: thin plywood the rifle and sniper can shoot through.
    this.box(4, 2.4, 0.12, -8, 1.2, -18, m.wood, { surface: 'wood' });
    this.sign('PENETRATION TEST', 'RIFLE / SNIPER', -8, 2.9, -18, 3.2, 0.8, 0);
  }

  // -------------------------------------------------------- weapon pedestals

  private buildWeaponPedestals(): void {
    const m = this.materials;
    const startX = -8;

    for (let i = 0; i < WEAPON_ORDER.length; i++) {
      const id = WEAPON_ORDER[i];
      const cfg = WEAPON_CONFIGS[id];
      const x = startX + i * 4;
      const z = 9.5;

      this.box(1.3, 1.0, 1.3, x, 0.5, z, m.metalDark, { surface: 'metal' });
      const top = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 0.08, 1.4),
        new THREE.MeshStandardMaterial({
          color: 0x111418,
          emissive: 0x1a5a6a,
          emissiveIntensity: 0.7,
          roughness: 0.5,
        }),
      );
      top.position.set(x, 1.02, z);
      this.root.add(top);

      const display = new THREE.Group();
      display.position.set(x, 1.55, z);
      this.root.add(display);

      const glow = new THREE.PointLight(0x39d6ff, 3, 3.5, 2);
      glow.position.set(x, 1.5, z);
      this.root.add(glow);
      this.optionalLights.push(glow);

      this.sign(cfg.category, `${i + 1}`, x, 2.35, z - 0.75, 1.5, 0.75, Math.PI);

      this.pickups.push({ id, position: new THREE.Vector3(x, 0, z), display, radius: 1.8 });
    }

    this.sign('LOADOUT — PRESS 1-5 OR WALK UP', undefined, 0, 3.1, 8.5, 9, 1.2, Math.PI);
  }

  // --------------------------------------------------------------- lighting

  private buildLighting(): { sun: THREE.DirectionalLight; sky: Sky } {
    const sky = new Sky();
    sky.scale.setScalar(45000);
    const uniforms = sky.material.uniforms;
    uniforms.turbidity.value = 6;
    uniforms.rayleigh.value = 1.6;
    uniforms.mieCoefficient.value = 0.005;
    uniforms.mieDirectionalG.value = 0.75;

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
    sun.position.copy(sunPosition).multiplyScalar(120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 340;
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.035;
    // Keep the shadow frustum centred on the action rather than the whole map.
    sun.target.position.set(0, 0, -40);
    this.root.add(sun);
    this.root.add(sun.target);

    const hemi = new THREE.HemisphereLight(0xbdd7ff, 0x6a6250, 1.35);
    this.root.add(hemi);

    const ambient = new THREE.AmbientLight(0xdfe6f0, 0.35);
    this.root.add(ambient);

    // Bounce light from the concrete pad so the covered area isn't muddy.
    const bounce = new THREE.DirectionalLight(0xd8c9a8, 0.45);
    bounce.position.set(0, -1, 4);
    this.root.add(bounce);

    return { sun, sky };
  }
}
