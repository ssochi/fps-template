import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { CollisionWorld } from '../physics/CollisionWorld';
import { LevelBuilder, type LevelBuildResult } from './LevelBuilder';
import {
  buildDecanterSet,
  buildFridge,
  buildPlant,
  buildShowcar,
  buildSofa,
  buildTypewriter,
  TYPEBAR_REST,
  TYPEBAR_STRUCK,
  type Showpiece,
  type TypingLinkage,
} from './Showpieces';
import {
  brushedMetalSurface,
  carbonSurface,
  fabricSurface,
  studioFloorSurface,
  surfaceMaterial,
  terracottaSurface,
  walnutSurface,
  wornEnamelSurface,
  type Surface,
} from './PbrSurface';
import { damp } from '../core/MathUtils';

/**
 * A model test scene — the lighting rig and reference set you would build to
 * judge an asset before signing it off.
 *
 * Three things make it different from the gameplay levels:
 *
 * 1. **Image-based lighting.** `PMREMGenerator.fromScene(RoomEnvironment())`
 *    prefilters a studio interior into a radiance map, which is what actually
 *    lights the metals here. Clearcoat, sheen, anisotropy and transmission are
 *    all reflection effects — without an environment they have nothing to
 *    reflect and collapse to flat shading, however good the maps are.
 * 2. **Area lights.** Three `RectAreaLight` softboxes stand in for a real key /
 *    fill / rim rig. They only light Standard and Physical materials and cast
 *    no shadows, so a dim spotlight rides along to put the contact shadows back.
 * 3. **Reference charts.** Roughness and metalness sweeps, a material sample
 *    row, a greyscale step wedge and a colour checker, so anything that looks
 *    wrong can be compared against a known-good neighbour instead of guessed at.
 */

const ROOM = { width: 34, depth: 30, height: 9 };
const PLINTH_Y = 0.35;
/** How far the carriage steps per character, and how many fit on a line. */
const TYPE_ADVANCE = 0.0125;
const TYPE_COLUMNS = 22;

interface Turntable {
  node: THREE.Group;
  speed: number;
}

export class StudioLevel extends LevelBuilder {
  private readonly showpieces: Showpiece[] = [];
  private readonly turntables: Turntable[] = [];
  private readonly ownedSurfaces: Surface[] = [];
  private readonly fridgeHinges: { node: THREE.Group; open: number; axis: 'y' | 'z' }[] = [];
  private readonly fridgeLights: THREE.Light[] = [];
  private fridgeOpen = false;
  private fridgeBlend = 0;
  private typing: TypingLinkage | null = null;
  /** Progress through one keystroke, 0..1; -1 when idle. */
  private strike = -1;
  private strikeKey = 0;
  private carriageStep = 0;
  private environmentScene: THREE.Scene | null = null;
  /** Flat matte paint for everything off-camera: walls, ceiling, light stands. */
  private matte!: THREE.MeshStandardMaterial;

  constructor(world: CollisionWorld) {
    super(world, 'studio');
  }

  build(): LevelBuildResult {
    // `RectAreaLight` needs its BRDF lookup tables uploaded once per process.
    RectAreaLightUniformsLib.init();

    this.buildShell();
    this.buildShowpieces();
    this.buildReferenceWall();
    this.buildMapInspector();
    this.buildAtmospherics();
    this.pedestalRow({
      origin: [0, 0, ROOM.depth / 2 - 3],
      facing: Math.PI,
      spacing: 3.0,
      label: 'LOADOUT',
      washLights: false,
    });

    const { sun } = this.buildLighting();
    this.environmentScene = new RoomEnvironment();

    this.flushBatch('studio');

    return {
      id: 'studio',
      name: 'Model Studio',
      root: this.root,
      targets: this.targets,
      collidables: this.collidables,
      pickups: this.pickups,
      ammoCrates: this.ammoCrates,
      vehicles: [],
      lapCourse: null,
      interactables: [
        {
          position: new THREE.Vector3(4.6, 0, -1.2),
          radius: 2.6,
          label: () => (this.fridgeOpen ? 'Close the fridge' : 'Open the fridge'),
          activate: () => this.toggleFridge(),
        },
        {
          position: new THREE.Vector3(0.4, 0, 3.6),
          radius: 2.2,
          label: () => 'Strike a key',
          activate: () => this.strikeKey_(),
        },
      ],
      environmentScene: this.environmentScene,
      // The IBL is a second key light, not just a reflection source: at full
      // strength a white-lined fridge interior renders past the bloom
      // threshold with every lamp in the room switched off. Measured — this is
      // the level that still drives clearcoat and sheen without clipping.
      environmentIntensity: 0.7,
      spawnPoint: new THREE.Vector3(0, 0.02, ROOM.depth / 2 - 6),
      spawnYaw: 0,
      sun,
      // Fully enclosed studio — no sky dome, the cyclorama is the horizon.
      sky: null,
      optionalLights: this.optionalLights,
      atmospherics: this.atmospherics,
      background: new THREE.Color(0x121417),
      // A studio is a room: fog would only fight the backdrop.
      fog: new THREE.Fog(0x121417, 200, 600),
      update: (dt: number) => this.update(dt),
      dispose: () => {
        for (const piece of this.showpieces) piece.dispose();
        for (const surface of this.ownedSurfaces) surface.dispose();
        this.disposeOwned();
      },
    };
  }

  private update(dt: number): void {
    this.tick(dt);
    for (const table of this.turntables) table.node.rotation.y += dt * table.speed;

    // Doors ease open rather than snapping, and the lamp follows the blend.
    this.fridgeBlend = damp(this.fridgeBlend, this.fridgeOpen ? 1 : 0, 6, dt);
    for (const hinge of this.fridgeHinges) {
      if (hinge.axis === 'y') {
        hinge.node.rotation.y = hinge.open * this.fridgeBlend * 1.9;
      } else {
        hinge.node.position.z = hinge.node.userData.restZ + hinge.open * this.fridgeBlend * 0.42;
      }
    }
    // A fridge bulb is a couple of candela, not a floodlight. Overdriving it
    // clips the white liner and blooms the entire frame.
    for (const light of this.fridgeLights) light.intensity = this.fridgeBlend * 0.5;

    this.updateTyping(dt);
  }

  /**
   * One keystroke, driven as a single 0..1 phase.
   *
   * A typewriter is a linkage, not a set of independent animations: the key
   * goes down, the typebar it is connected to swings up to the platen, and only
   * when the slug lands does the carriage step left. Driving the three from one
   * phase with different curves is what keeps them connected — animate them
   * separately and the escapement fires before the bar arrives.
   */
  private updateTyping(dt: number): void {
    const rig = this.typing;
    if (!rig) return;

    if (this.strike >= 0) {
      this.strike += dt * 5.5;
      if (this.strike >= 1) {
        this.strike = -1;
        this.carriageStep = Math.min(this.carriageStep + 1, TYPE_COLUMNS);
      }
    }

    const p = this.strike;
    // Down fast, back up slower: the key is thrown, not eased.
    const press = p < 0 ? 0 : p < 0.35 ? p / 0.35 : Math.max(0, 1 - (p - 0.35) / 0.65);
    const key = rig.keys[this.strikeKey];
    key.node.position.y = key.rest - press * 0.009;

    // The bar leads the key slightly and overshoots into the platen.
    const swing = p < 0 ? 0 : p < 0.42 ? p / 0.42 : Math.max(0, 1 - (p - 0.42) / 0.58);
    const bar = rig.typebars[this.strikeKey % rig.typebars.length];
    bar.rotation.x = TYPEBAR_REST + swing * (TYPEBAR_STRUCK - TYPEBAR_REST);

    // The carriage eases to its new column rather than jumping.
    const target = rig.carriageRest - this.carriageStep * TYPE_ADVANCE;
    rig.carriage.position.x = damp(rig.carriage.position.x, target, 9, dt);
  }

  private strikeKey_(): void {
    const rig = this.typing;
    if (!rig || this.strike >= 0) return;
    if (this.carriageStep >= TYPE_COLUMNS) {
      // End of the line: the carriage returns instead of typing.
      this.carriageStep = 0;
      return;
    }
    // Skip the space bar, which is the last entry and has no typebar.
    this.strikeKey = Math.floor(Math.random() * (rig.keys.length - 1));
    this.strike = 0;
  }

  private toggleFridge(): void {
    this.fridgeOpen = !this.fridgeOpen;
  }

  // ------------------------------------------------------------------- shell

  private buildShell(): void {
    const floorSurface = studioFloorSurface(12);
    this.ownedSurfaces.push(floorSurface);
    const floorMat = surfaceMaterial(floorSurface, {});
    this.owned.push(floorMat);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.width, ROOM.depth), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.userData.surface = 'concrete';
    this.root.add(floor);
    this.collidables.push(floor);
    this.world.addBox(
      new THREE.Vector3(0, -5, 0),
      new THREE.Vector3(ROOM.width, 10, ROOM.depth),
      'concrete',
    );

    // Cyclorama: the coved backdrop that removes the wall/floor seam. Built as
    // a lathe so the cove is a real curve, not a chamfer.
    const cyc: number[] = [];
    const R = 3.2;
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * (Math.PI / 2);
      cyc.push(-ROOM.depth / 2 + R - Math.cos(a) * R, Math.sin(a) * R);
    }
    const shape: number[] = [...cyc, -ROOM.depth / 2 + R, ROOM.height];
    const positions: number[] = [];
    const uvs: number[] = [];
    const halfW = ROOM.width / 2;
    for (let i = 0; i < shape.length / 2 - 1; i++) {
      const z0 = shape[i * 2];
      const y0 = shape[i * 2 + 1];
      const z1 = shape[i * 2 + 2];
      const y1 = shape[i * 2 + 3];
      // Facing +Z, into the room.
      for (const [x, y, z] of [
        [-halfW, y0, z0],
        [halfW, y0, z0],
        [halfW, y1, z1],
        [-halfW, y0, z0],
        [halfW, y1, z1],
        [-halfW, y1, z1],
      ] as [number, number, number][]) {
        positions.push(x, y, z);
        uvs.push((x + halfW) / ROOM.width, y / ROOM.height);
      }
    }
    const cycGeo = new THREE.BufferGeometry();
    cycGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    cycGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    cycGeo.computeVertexNormals();
    // A cyclorama is painted white, but it must not render white: it is the
    // largest surface in frame, and post-processing runs before tone mapping,
    // so any diffuse surface whose radiance passes the 1.0 bloom threshold
    // smears a veil over the entire image. Measured: with the rig below, this
    // albedo puts the cyc at roughly 0.6 and nothing diffuse clips.
    const cycMat = new THREE.MeshPhysicalMaterial({ color: 0x9aa0a6, roughness: 0.94, metalness: 0 });
    this.owned.push(cycGeo, cycMat);
    const cyclorama = new THREE.Mesh(cycGeo, cycMat);
    cyclorama.receiveShadow = true;
    cyclorama.userData.surface = 'concrete';
    this.root.add(cyclorama);
    this.collidables.push(cyclorama);
    this.world.addBox(
      new THREE.Vector3(0, ROOM.height / 2, -ROOM.depth / 2 + 0.4),
      new THREE.Vector3(ROOM.width, ROOM.height, 0.8),
      'concrete',
    );

    // Side walls, rear wall and ceiling, all in flat matte paint.
    //
    // The shared concrete is tiled for outdoor use; on a 30 m wall seen at a
    // grazing angle its detail lands well under a texel and reads as crawling
    // static. A studio paints everything off-camera matte black anyway, so it
    // never bounces uncontrolled light back onto the subject.
    const shellMat = new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.95, metalness: 0 });
    this.owned.push(shellMat);
    this.matte = shellMat;
    const slab = (w: number, h: number, d: number, x: number, y: number, z: number): void => {
      const node = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), shellMat);
      node.position.set(x, y, z);
      node.userData.surface = 'concrete';
      node.receiveShadow = true;
      this.root.add(node);
      this.collidables.push(node);
    };
    for (const s of [-1, 1]) {
      slab(0.5, ROOM.height, ROOM.depth, s * (ROOM.width / 2), ROOM.height / 2, 0);
      this.world.addBox(
        new THREE.Vector3(s * (ROOM.width / 2), ROOM.height / 2, 0),
        new THREE.Vector3(0.5, ROOM.height, ROOM.depth),
        'concrete',
      );
    }
    slab(ROOM.width, ROOM.height, 0.5, 0, ROOM.height / 2, ROOM.depth / 2);
    this.world.addBox(
      new THREE.Vector3(0, ROOM.height / 2, ROOM.depth / 2),
      new THREE.Vector3(ROOM.width, ROOM.height, 0.5),
      'concrete',
    );
    slab(ROOM.width, 0.4, ROOM.depth, 0, ROOM.height + 0.2, 0);
    for (let i = -3; i <= 3; i++) {
      this.box(0.16, 0.3, ROOM.depth - 1, i * 4, ROOM.height - 0.2, 0, shellMat, {
        surface: 'metal',
        solid: false,
        shootable: false,
      });
    }
  }

  // -------------------------------------------------------------- showpieces

  private buildShowpieces(): void {
    // Two arcs. The large pieces stand at ankle height on wide plinths; the
    // small ones are on tall pedestals nearer the door, because a typewriter
    // at 0.35 m is a thing you look down on rather than at.
    const specs: {
      build: () => Showpiece;
      x: number;
      z: number;
      height: number;
      label: string;
      sub: string;
      /** The glowing rim. Off for anything that refracts what is around it. */
      ring?: boolean;
    }[] = [
      { build: buildShowcar, x: -8.5, z: -2, height: PLINTH_Y, label: 'MERIDIAN GT-9', sub: 'CLEARCOAT · CARBON · GLASS' },
      { build: buildSofa, x: -1, z: -1.5, height: PLINTH_Y, label: 'HALDEN 3-SEAT', sub: 'SHEEN FABRIC · WALNUT' },
      { build: buildFridge, x: 4.6, z: -1.2, height: PLINTH_Y, label: 'COLDLINE CF-90', sub: 'ANISOTROPIC STEEL · OPENS' },
      { build: buildPlant, x: -5.4, z: 3.6, height: PLINTH_Y, label: 'MONSTERA', sub: 'ALPHA CUTOUT · TRANSLUCENCY' },
      { build: buildTypewriter, x: 0.4, z: 3.6, height: 0.86, label: 'HALDEN No.5', sub: 'WORN ENAMEL · TYPES' },
      // No rim light under the crystal. Measured: with the ring lit, the pour
      // sampled (111,183,111) — a refractive object picks up whatever is
      // behind it, and saturated cyan behind amber absorption is green. That
      // is the renderer being right and the set dressing being wrong; a real
      // studio does not put a coloured practical under glassware either.
      { build: buildDecanterSet, x: 5.6, z: 3.6, height: 0.9, label: 'CUT CRYSTAL', sub: 'TRANSMISSION · DISPERSION', ring: false },
    ];

    for (const spec of specs) {
      const piece = spec.build();
      this.showpieces.push(piece);

      const plinthY = spec.height;
      const radius = Math.max(piece.size.x, piece.size.z) * 0.62 + (plinthY > PLINTH_Y ? 0.14 : 0.5);
      // Plinth.
      this.prop(
        new THREE.CylinderGeometry(radius, radius * 1.02, plinthY, 48),
        this.materials.concreteDark,
        [spec.x, plinthY / 2, spec.z],
        [0, 0, 0],
        { surface: 'concrete' },
      );
      this.world.addBox(
        new THREE.Vector3(spec.x, plinthY / 2, spec.z),
        new THREE.Vector3(radius * 2, plinthY, radius * 2),
        'concrete',
      );
      if (spec.ring !== false) {
        this.prop(
          new THREE.TorusGeometry(radius, 0.02, 8, 60),
          this.materials.emissiveCyan,
          [spec.x, plinthY + 0.01, spec.z],
          [Math.PI / 2, 0, 0],
          { surface: 'metal', castShadow: false, shootable: false },
        );
      }

      // The fridge stays still so its doors can be walked into; the other two
      // turn, which is how you actually inspect a silhouette.
      const table = new THREE.Group();
      table.position.set(spec.x, plinthY, spec.z);
      piece.root.castShadow = true;
      piece.root.traverse((child) => {
        const asMesh = child as THREE.Mesh;
        if (asMesh.isMesh) {
          asMesh.castShadow = true;
          asMesh.receiveShadow = true;
        }
      });
      table.add(piece.root);
      this.root.add(table);
      this.collidables.push(table);

      if (piece.typing) {
        // The typewriter has to hold still and face the visitor: you stand at
        // it to use it, and a turntable would swing the keys out of reach.
        this.typing = piece.typing;
        this.world.addBox(
          new THREE.Vector3(spec.x, plinthY + piece.size.y / 2, spec.z),
          new THREE.Vector3(piece.size.x, piece.size.y, piece.size.z),
          'metal',
        );
      } else if (piece.hinges.length === 0) {
        this.turntables.push({ node: table, speed: 0.16 });
        // A turning exhibit cannot have a tight axis-aligned collider, so it
        // gets the plinth's own footprint: square, rotation-invariant, and
        // hidden under the visible disc. Without it the player just steps up
        // the plinth and walks straight through the model.
        this.world.addBox(
          new THREE.Vector3(spec.x, plinthY + piece.size.y / 2, spec.z),
          new THREE.Vector3(radius * 2, piece.size.y, radius * 2),
          'metal',
        );
      } else {
        for (const hinge of piece.hinges) {
          hinge.node.userData.restZ = hinge.node.position.z;
          this.fridgeHinges.push(hinge);
        }
        this.fridgeLights.push(...piece.lights);
        // The fridge is built front-to-+Z and the walkway is on +Z, so it is
        // already facing the right way — turning it round shows the visitor
        // its back panel and swings both doors away from them.
        // The fridge holds still, so its collider can hug the carcass — you
        // want to stand right in the door mouth, not be held off by a plinth-
        // sized box. The doors themselves sweep through you; that is fine.
        this.world.addBox(
          new THREE.Vector3(spec.x, plinthY + piece.size.y / 2, spec.z),
          new THREE.Vector3(piece.size.x, piece.size.y, piece.size.z),
          'metal',
        );
      }

      this.sign(spec.label, spec.sub, spec.x, 0.22, spec.z + radius + 0.55, 2.2, 0.76, 0, {
        background: '#0b0e12',
        borderColor: '#35d6ff',
        color: '#dfe7ee',
        tiltX: -Math.PI / 2,
      });
    }
  }

  // ---------------------------------------------------------- reference wall

  /**
   * The charts a lighting artist checks a material against: two sphere sweeps
   * isolating roughness at each end of the metalness range, a row of the actual
   * shading models in use, and a step wedge plus colour checker for exposure.
   */
  private buildReferenceWall(): void {
    const z = -ROOM.depth / 2 + 4.2;
    const sphere = new THREE.SphereGeometry(0.3, 32, 24);
    this.owned.push(sphere);

    // Row pitch is set by the parts, not by eye: a 0.6 m ball plus a 0.44 m
    // caption needs 1.04 m of clear space, or the caption lands across the
    // bellies of the row above it.
    for (const [row, metalness] of [
      [2.9, 0],
      [1.75, 1],
    ] as [number, number][]) {
      for (let i = 0; i < 9; i++) {
        const roughness = i / 8;
        const mat = new THREE.MeshPhysicalMaterial({
          color: metalness > 0.5 ? 0xd8dce0 : 0xb03a34,
          metalness,
          roughness: Math.max(0.03, roughness),
        });
        this.owned.push(mat);
        const ball = new THREE.Mesh(sphere, mat);
        ball.position.set(-8 + i * 0.8, row, z);
        ball.castShadow = true;
        this.root.add(ball);
        this.collidables.push(ball);
      }
      this.sign(
        metalness > 0.5 ? 'METAL · ROUGHNESS 0 → 1' : 'DIELECTRIC · ROUGHNESS 0 → 1',
        undefined,
        -4.8,
        row + 0.55,
        z,
        5.2,
        0.44,
        0,
        { background: '#0b0e12', borderColor: '#35d6ff', color: '#dfe7ee' },
      );
    }

    // Shading-model row: each ball is one feature of MeshPhysicalMaterial.
    const samples: [string, THREE.MeshPhysicalMaterialParameters][] = [
      ['CLEARCOAT', { color: 0x8c1420, metalness: 0.9, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.03 }],
      ['SHEEN', { color: 0x2f4a5a, roughness: 0.9, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xa8d0e4) }],
      ['ANISOTROPY', { color: 0xc0c6cc, metalness: 1, roughness: 0.35, anisotropy: 1, anisotropyRotation: Math.PI / 2 }],
      ['IRIDESCENCE', { color: 0x101418, metalness: 1, roughness: 0.1, iridescence: 1, iridescenceIOR: 1.8 }],
      ['TRANSMISSION', { color: 0xdff2f5, roughness: 0.02, transmission: 1, thickness: 0.5, ior: 1.5, transparent: true }],
      ['SPECULAR TINT', { color: 0x101010, roughness: 0.2, specularIntensity: 1, specularColor: new THREE.Color(0xffb070) }],
      // Absorption through the volume, not a tinted surface: the same material
      // is pale at the rim and deep in the middle because the light has
      // further to travel. `dispersion` splits it on the way out.
      ['ABSORPTION', {
        color: 0xffffff,
        roughness: 0.02,
        transmission: 1,
        thickness: 0.6,
        ior: 1.5,
        attenuationColor: new THREE.Color(0xd06a12),
        attenuationDistance: 0.3,
        dispersion: 1.4,
      }],
    ];
    for (let i = 0; i < samples.length; i++) {
      const [label, params] = samples[i];
      const mat = new THREE.MeshPhysicalMaterial(params);
      this.owned.push(mat);
      const ball = new THREE.Mesh(sphere, mat);
      ball.position.set(1.2 + i * 0.86, 2.1, z);
      ball.castShadow = true;
      this.root.add(ball);
      this.collidables.push(ball);
      this.sign(label, undefined, 1.2 + i * 0.86, 1.55, z, 0.82, 0.24, 0, {
        background: '#0b0e12',
        borderColor: '#2a3a44',
        color: '#9fb4c2',
      });
    }
    this.sign('SHADING MODELS', undefined, 3.35, 2.66, z, 4.6, 0.42, 0, {
      background: '#0b0e12',
      borderColor: '#35d6ff',
      color: '#dfe7ee',
    });

    // Step wedge and colour checker: exposure and white balance references.
    for (let i = 0; i < 11; i++) {
      const v = i / 10;
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(v) });
      this.owned.push(mat);
      const patch = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), mat);
      patch.position.set(-8 + i * 0.36, 0.95, z + 0.02);
      this.root.add(patch);
    }
    const checker = [
      0xd94f3d, 0xe0a03a, 0xe4d64a, 0x5aa845, 0x3f7fc4, 0x7a4fa8, 0xd8d8d8, 0x2b2b2b,
    ];
    for (let i = 0; i < checker.length; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: checker[i] });
      this.owned.push(mat);
      const patch = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), mat);
      patch.position.set(-3.4 + i * 0.36, 0.95, z + 0.02);
      this.root.add(patch);
    }
    this.sign('EXPOSURE / WHITE BALANCE', undefined, -5.6, 0.6, z, 4.4, 0.36, 0, {
      background: '#0b0e12',
      borderColor: '#2a3a44',
      color: '#9fb4c2',
    });

    // A 1.8 m scale figure: proportions are judged against a person, not a grid.
    const human = new THREE.MeshPhysicalMaterial({ color: 0x39424a, roughness: 0.8 });
    this.owned.push(human);
    this.prop(new THREE.CapsuleGeometry(0.22, 1.0, 6, 14), human, [8.4, 0.94, z + 0.4], [0, 0, 0], {
      surface: 'concrete',
      shootable: false,
    });
    this.prop(new THREE.SphereGeometry(0.16, 16, 12), human, [8.4, 1.66, z + 0.4], [0, 0, 0], {
      surface: 'concrete',
      shootable: false,
    });
    this.sign('1.8 M', undefined, 8.4, 0.2, z + 0.9, 0.9, 0.3, 0, {
      background: '#0b0e12',
      borderColor: '#2a3a44',
      color: '#9fb4c2',
      tiltX: -Math.PI / 2,
    });
  }

  /**
   * The map inspector: for each surface, its albedo, normal and packed ORM
   * shown unlit and side by side, next to a sphere wearing the full set. This
   * is the panel you actually diagnose a broken texture on.
   */
  private buildMapInspector(): void {
    const wallX = ROOM.width / 2 - 0.3;
    const sets: { name: string; surface: Surface }[] = [
      // Repeats are set for the 0.34 m sample sphere, not for the preview
      // quads — those clone the texture at repeat 1 so exactly one tile shows.
      // A weave tiled twice across a sphere gives 6 cm cells and the sample
      // reads as a mirrorball rather than as carbon.
      { name: 'CARBON FIBRE', surface: carbonSurface(6) },
      { name: 'BRUSHED STEEL', surface: brushedMetalSurface(4) },
      { name: 'UPHOLSTERY', surface: fabricSurface('#4e6b7a', 6) },
      { name: 'WALNUT', surface: walnutSurface(4) },
      // The layered one. Its ORM is the interesting panel: the chips are not a
      // pattern in the albedo, they are holes where the G and B channels jump
      // from rough dielectric to smooth metal.
      { name: 'WORN ENAMEL', surface: wornEnamelSurface(3) },
      { name: 'TERRACOTTA', surface: terracottaSurface(3) },
    ];
    this.ownedSurfaces.push(...sets.map((s) => s.surface));

    const quad = new THREE.PlaneGeometry(0.62, 0.62);
    this.owned.push(quad);
    const ball = new THREE.SphereGeometry(0.34, 28, 20);
    this.owned.push(ball);

    for (let i = 0; i < sets.length; i++) {
      const { name, surface } = sets[i];
      const z = -6 + i * 3.1;

      // The three maps, unlit so what you see is the texel data itself.
      const maps: [string, THREE.Texture][] = [
        ['ALBEDO', surface.map],
        ['NORMAL', surface.normalMap],
        ['ORM', surface.ormMap],
      ];
      for (let k = 0; k < maps.length; k++) {
        const [label, texture] = maps[k];
        // A shared texture would otherwise carry the model's repeat; clone so
        // the inspector always shows exactly one tile.
        const preview = texture.clone();
        preview.repeat.set(1, 1);
        // Every preview is tagged sRGB, including the two that are not colour.
        // An inspector's job is to show the bytes: the shader decodes sRGB and
        // the output pass re-encodes it, so the texel survives the round trip.
        // Tagging the data maps linear instead skips only the decode, and the
        // re-encode then washes a 0.32 roughness out to a 0.6 grey — the panel
        // would lie about the very values you opened it to check.
        preview.colorSpace = THREE.SRGBColorSpace;
        preview.needsUpdate = true;
        const mat = new THREE.MeshBasicMaterial({ map: preview });
        this.owned.push(preview, mat);
        const panel = new THREE.Mesh(quad, mat);
        panel.position.set(wallX - 0.02, 2.3, z - 0.72 + k * 0.72);
        panel.rotation.y = -Math.PI / 2;
        this.root.add(panel);
        this.sign(label, undefined, wallX - 0.04, 1.88, z - 0.72 + k * 0.72, 0.6, 0.2, -Math.PI / 2, {
          background: '#0b0e12',
          borderColor: '#2a3a44',
          color: '#9fb4c2',
        });
      }

      const mat = surfaceMaterial(surface, { clearcoat: i === 0 ? 0.8 : 0 });
      this.owned.push(mat);
      const sample = new THREE.Mesh(ball, mat);
      sample.position.set(wallX - 0.9, 3.35, z);
      sample.castShadow = true;
      this.root.add(sample);
      this.collidables.push(sample);

      this.sign(name, undefined, wallX - 0.04, 2.95, z, 2.1, 0.34, -Math.PI / 2, {
        background: '#0b0e12',
        borderColor: '#35d6ff',
        color: '#dfe7ee',
      });
    }

    this.sign('TEXTURE SET INSPECTOR — ALBEDO / NORMAL / ORM', undefined, wallX - 0.04, 4.2, -1.4, 8, 0.5, -Math.PI / 2, {
      background: '#0b0e12',
      borderColor: '#35d6ff',
      color: '#dfe7ee',
    });
  }

  // ---------------------------------------------------------------- lighting

  private buildLighting(): { sun: THREE.DirectionalLight } {
    const m = this.materials;

    // Ambient stays low: the environment map is doing the ambient work, and
    // doubling up flattens everything the rig is there to reveal.
    this.root.add(new THREE.AmbientLight(0xdfe7ee, 0.12));

    // Key / fill / rim, as softboxes. RectAreaLight casts no shadow, so a
    // low-intensity spot follows the key to put contact shadows back.
    //
    // Intensities are set by exposure, not by taste: the room is mostly large
    // pale surfaces, and bloom's high-pass sits at 1.0 pre-tone-mapping, so a
    // hotter rig does not look brighter — it dumps a milky veil over the whole
    // frame. These land the cyclorama near 0.6 with nothing diffuse clipping.
    const boxes: [number, number, number, number, number, number, number][] = [
      // x, y, z, width, height, intensity, colour
      [-6, 5.4, 5.5, 6, 4, 5.4, 0xfff3e4],
      [7.5, 4.2, 5.0, 5, 3.4, 2.5, 0xdfe9ff],
      [0, 5.6, -9.5, 9, 3, 3.3, 0xbfd6ff],
    ];
    for (const [x, y, z, w, h, intensity, colour] of boxes) {
      const light = new THREE.RectAreaLight(colour, intensity, w, h);
      light.position.set(x, y, z);
      light.lookAt(0, 1.4, -1.5);
      this.root.add(light);

      // The visible softbox: an emissive panel in a dark frame on a stand.
      //
      // `Object3D.lookAt` aims local -Z at the target for lights and cameras
      // but local +Z for everything else, and a RectAreaLight emits along that
      // same -Z. Copying the light's quaternion onto a plane therefore points
      // the lit face away from the subject and buries it behind its own frame,
      // so the panel needs a half turn and the frame goes the other way.
      const panel = new THREE.MeshBasicMaterial({ color: colour });
      this.owned.push(panel);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), panel);
      face.position.copy(light.position);
      face.quaternion.copy(light.quaternion);
      face.rotateY(Math.PI);
      this.root.add(face);

      const frame = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.24, h + 0.24, 0.16),
        this.matte,
      );
      frame.position.copy(light.position);
      frame.quaternion.copy(light.quaternion);
      frame.translateZ(0.12);
      frame.userData.surface = 'metal';
      this.root.add(frame);
      this.collidables.push(frame);

      if (z > 0) {
        this.box(0.14, y - h / 2, 0.14, x, (y - h / 2) / 2, z + 0.2, this.matte, { surface: 'metal' });
        this.box(0.9, 0.06, 0.9, x, 0.03, z + 0.2, this.matte, { surface: 'metal', solid: false });
      }
    }

    // Shadow-caster only: it contributes almost no light, it just grounds the
    // props. Without it, area-lit objects float.
    const sun = new THREE.DirectionalLight(0xfff3e4, 0.7);
    sun.position.set(-7, 11, 8);
    sun.target.position.set(-2, 0.6, -1.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 46;
    sun.shadow.camera.left = -14;
    sun.shadow.camera.right = 14;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -12;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.root.add(sun);
    this.root.add(sun.target);

    // Practical spots over each plinth, on the higher presets.
    for (const x of [-8.5, -1, 4.6]) {
      const spot = new THREE.SpotLight(0xfff6ec, 17, 16, 0.55, 0.6, 2);
      spot.position.set(x, ROOM.height - 0.8, 1.4);
      spot.target.position.set(x, 0.8, -1.5);
      this.root.add(spot);
      this.root.add(spot.target);
      this.optionalLights.push(spot);

      this.box(0.3, 0.5, 0.3, x, ROOM.height - 0.55, 1.4, this.matte, {
        surface: 'metal',
        solid: false,
        shootable: false,
      });
      this.box(0.24, 0.06, 0.24, x, ROOM.height - 0.82, 1.4, m.lampLens, {
        surface: 'metal',
        solid: false,
        shootable: false,
      });
    }

    return { sun };
  }

  private buildAtmospherics(): void {
    this.buildDustField({
      count: 300,
      bounds: { x: [-12, 12], y: [0.4, 6], z: [-11, 10] },
      opacity: 0.1,
      size: 9,
      drift: 1.1,
    });
  }
}
