import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CollisionWorld } from '../physics/CollisionWorld';
import {
  createPosterTexture,
  createTextTexture,
  createWorldMaterials,
  type PosterKind,
  type WorldMaterials,
} from './Materials';
import { StaticBatcher, mergeStaticHierarchy } from './GeometryMerge';
import type { RangeTarget } from './Targets';
import type { WeaponId } from '../weapons/WeaponTypes';
import type { VehicleId } from './Vehicles';
import { WEAPON_CONFIGS, WEAPON_ORDER } from '../weapons/WeaponConfigs';
import { randRange } from '../core/MathUtils';

/**
 * Shared scaffolding for playable levels.
 *
 * Every level is assembled the same way: queue static primitives into a
 * `StaticBatcher`, register collision AABBs as you go, then merge the lot into a
 * handful of meshes at the end of `build()`. That is what makes the prop density
 * in these maps affordable — several hundred boxes collapse into a couple of
 * dozen draw calls, and the merged meshes are still correct for ballistics
 * because the surface tag is part of the batch key.
 *
 * Subclasses implement `build()` and are otherwise free to use the helpers here
 * (`box`, `prop`, `sign`, `pedestalRow`, …) without repeating the plumbing.
 */

export type SurfaceTag = 'concrete' | 'metal' | 'dirt' | 'wood';

export type LevelId = 'range' | 'circuit' | 'studio';

export interface BoxOptions {
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

export interface PropOptions {
  surface?: SurfaceTag;
  shootable?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  scale?: number | [number, number, number];
}

export interface WeaponPickup {
  id: WeaponId;
  position: THREE.Vector3;
  /** Pedestal display model, spun for readability. */
  display: THREE.Object3D;
  radius: number;
}

export interface AmmoCrate {
  position: THREE.Vector3;
  radius: number;
}

/** Where a level wants a drivable vehicle parked. */
export interface VehicleSpawn {
  id: VehicleId;
  position: THREE.Vector3;
  yaw: number;
}

/**
 * Everything a lap timer needs. A lap counts only once every checkpoint has
 * been passed, so cutting the circuit or reversing over the line does nothing.
 */
export interface LapCourse {
  /** A point on the start/finish line. */
  linePoint: THREE.Vector3;
  /** Racing direction across the line; crossings are measured along it. */
  lineNormal: THREE.Vector3;
  /** Half-length of the line, across the track. */
  lineHalfWidth: number;
  checkpoints: { position: THREE.Vector3; radius: number }[];
}

/** Something the player can walk up to and use with the interact key. */
export interface LevelInteractable {
  position: THREE.Vector3;
  radius: number;
  /** Evaluated per frame, so a toggle can relabel itself. */
  label: () => string;
  activate: () => void;
}

export interface LevelBuildResult {
  id: LevelId;
  name: string;
  root: THREE.Group;
  targets: RangeTarget[];
  /** Meshes the shooting raycast tests against. */
  collidables: THREE.Object3D[];
  pickups: WeaponPickup[];
  ammoCrates: AmmoCrate[];
  /** Drivable vehicles the level wants placed. Empty on maps without any. */
  vehicles: VehicleSpawn[];
  /** Lap timing geometry, or null on maps with no circuit. */
  lapCourse: LapCourse | null;
  /** Props the interact key can operate. */
  interactables?: LevelInteractable[];
  /**
   * A scene prefiltered into an environment map for image-based lighting.
   * Physical material features — clearcoat, sheen, anisotropy, transmission —
   * are reflection effects and read as flat shading without one.
   */
  environmentScene?: THREE.Scene | null;
  environmentIntensity?: number;
  spawnPoint: THREE.Vector3;
  spawnYaw: number;
  sun: THREE.DirectionalLight;
  /** Null on interior levels, which have no sky dome. */
  sky: Sky | null;
  /** Lights and effects disabled on the lower quality presets. */
  optionalLights: THREE.Light[];
  atmospherics: THREE.Object3D[];
  background: THREE.Color;
  fog: THREE.Fog;
  /** Drives animated scenery (dust motes, lamp flicker, signal lights). */
  update: (dt: number) => void;
  /** Releases level-owned GPU resources when swapping maps. */
  dispose: () => void;
}

export interface LevelDescriptor {
  id: LevelId;
  name: string;
  blurb: string;
}

export const LEVELS: readonly LevelDescriptor[] = [
  { id: 'range', name: 'Shooting Range', blurb: 'Covered firing line, 10 lanes of targets out to 150 m.' },
  { id: 'circuit', name: 'Circuit & Garage', blurb: 'Race track and pit lane, with three drivable vehicles in the garage.' },
  {
    id: 'studio',
    name: 'Model Studio',
    blurb: 'PBR test scene: studio rig, reference charts and six showpieces.',
  },
];

export interface DustFieldOptions {
  count?: number;
  bounds: { x: [number, number]; y: [number, number]; z: [number, number] };
  colour?: [number, number, number];
  opacity?: number;
  size?: number;
  drift?: number;
}

/**
 * Flattens a display prop (a weapon on a loadout plinth) to one mesh per
 * material. These never animate, so paying ~50 draw calls per pedestal for the
 * individual parts would be pure waste.
 */
export function mergeDisplayModel(source: THREE.Object3D, name: string): THREE.Group {
  return mergeStaticHierarchy(source, name);
}

/** Marker in `Sky`'s fragment shader that the radiance clamp is spliced onto. */
const SKY_OUTPUT = 'gl_FragColor = vec4( texColor, 1.0 );';

/**
 * Keeps the sky dome below the bloom threshold.
 *
 * `Sky` writes physical radiance, which lands comfortably above 1.0 across the
 * whole upper half of the screen. Tone mapping handles that fine — but the
 * bloom pass runs *before* it, sees a full-screen over-bright source, and
 * smears a milky veil over the entire frame; on an open map like the circuit it
 * washes out everything past a few metres.
 *
 * A Reinhard curve with an asymptote under 1.0 leaves the dim end of the
 * gradient essentially untouched, rolls off the bright horizon, and guarantees
 * no sky pixel ever reaches the bloom high-pass. Muzzle flashes, tracers and
 * emissive fixtures are unaffected, which is the point.
 */
function compressSkyRadiance(material: THREE.ShaderMaterial): void {
  if (!material.fragmentShader.includes(SKY_OUTPUT)) return; // upstream changed
  material.fragmentShader = material.fragmentShader.replace(
    SKY_OUTPUT,
    'gl_FragColor = vec4( texColor / ( 1.0 + texColor * 1.15 ), 1.0 );',
  );
  material.needsUpdate = true;
}

export abstract class LevelBuilder {
  protected readonly materials: WorldMaterials = createWorldMaterials();
  protected readonly root = new THREE.Group();
  protected readonly batcher = new StaticBatcher();
  protected readonly collidables: THREE.Object3D[] = [];
  protected readonly targets: RangeTarget[] = [];
  protected readonly pickups: WeaponPickup[] = [];
  protected readonly ammoCrates: AmmoCrate[] = [];
  protected readonly vehicleSpawns: VehicleSpawn[] = [];
  protected readonly optionalLights: THREE.Light[] = [];
  protected readonly atmospherics: THREE.Object3D[] = [];
  protected readonly world: CollisionWorld;

  /** Materials and textures created per level, released by `dispose()`. */
  protected readonly owned: { dispose: () => void }[] = [];
  protected readonly signMaterials = new Map<string, THREE.MeshStandardMaterial>();
  protected readonly dustUniforms: { value: number }[] = [];
  protected readonly flickerLamps: { light: THREE.Light; base: number; phase: number }[] = [];
  protected elapsed = 0;

  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);
  private readonly tmpPos = new THREE.Vector3();

  constructor(world: CollisionWorld, name: string) {
    this.world = world;
    this.root.name = name;
  }

  abstract build(): LevelBuildResult;

  // ----------------------------------------------------------------- helpers

  /**
   * Queues a box into the static batch and, unless told otherwise, registers a
   * collision AABB and marks it shootable. This is the single place level
   * geometry gets wired up.
   */
  protected box(
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

  /** Queues an arbitrary transformed geometry into the static batch. */
  protected prop(
    geo: THREE.BufferGeometry,
    material: THREE.Material,
    position: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0],
    opts: PropOptions = {},
  ): void {
    this.tmpEuler.set(rotation[0], rotation[1], rotation[2]);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    const s = opts.scale ?? 1;
    if (Array.isArray(s)) this.tmpScale.set(s[0], s[1], s[2]);
    else this.tmpScale.set(s, s, s);
    this.tmpMatrix.compose(
      this.tmpPos.set(position[0], position[1], position[2]),
      this.tmpQuat,
      this.tmpScale,
    );
    this.tmpScale.set(1, 1, 1);
    this.batcher.add(geo, material, this.tmpMatrix, {
      surface: opts.surface ?? 'metal',
      castShadow: opts.castShadow ?? true,
      receiveShadow: opts.receiveShadow ?? true,
      shootable: opts.shootable ?? true,
    });
  }

  /** Queues an already-positioned mesh hierarchy, baking its world transform. */
  protected propObject(source: THREE.Object3D, opts: PropOptions = {}): void {
    source.updateWorldMatrix(true, true);
    source.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      this.batcher.add(mesh.geometry, material, mesh.matrixWorld, {
        surface: opts.surface ?? (mesh.userData.surface as SurfaceTag | undefined) ?? 'metal',
        castShadow: opts.castShadow ?? mesh.castShadow,
        receiveShadow: opts.receiveShadow ?? mesh.receiveShadow,
        shootable: opts.shootable ?? true,
      });
    });
  }

  /**
   * A flat signboard. Materials are cached by content so repeated signs (the
   * distance markers on both sides of the range) batch into one draw call.
   */
  protected sign(
    text: string,
    subtitle: string | undefined,
    x: number,
    y: number,
    z: number,
    width = 2,
    height = 1,
    rotationY = 0,
    style: {
      background?: string;
      borderColor?: string;
      color?: string;
      /** Pitch about X, applied before the yaw. Use -PI/2 to lay it on the floor. */
      tiltX?: number;
    } = {},
  ): void {
    const background = style.background ?? '#12161b';
    const borderColor = style.borderColor ?? '#f0b400';
    const colour = style.color ?? '#f5f5f0';
    const key = `${text}|${subtitle ?? ''}|${width}|${height}|${background}|${borderColor}|${colour}`;
    let material = this.signMaterials.get(key);
    if (!material) {
      const tex = createTextTexture(text, {
        subtitle,
        background,
        borderColor,
        color: colour,
        width: 512,
        height: Math.round((512 * height) / width),
      });
      material = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.85,
        side: THREE.DoubleSide,
      });
      this.signMaterials.set(key, material);
      this.owned.push(tex, material);
    }

    const geo = new THREE.PlaneGeometry(width, height);
    this.tmpEuler.set(style.tiltX ?? 0, rotationY, 0, 'YXZ');
    this.tmpQuat.setFromEuler(this.tmpEuler);
    this.tmpEuler.order = 'XYZ';
    this.tmpMatrix.compose(this.tmpPos.set(x, y, z), this.tmpQuat, this.tmpScale);
    this.batcher.add(geo, material, this.tmpMatrix, {
      surface: 'metal',
      castShadow: false,
      shootable: true,
    });
    geo.dispose();
  }

  /** A wall poster; each kind gets its own material, so keep the set small. */
  protected poster(
    kind: PosterKind,
    x: number,
    y: number,
    z: number,
    height = 1.1,
    rotationY = 0,
  ): void {
    const tex = createPosterTexture(kind);
    const material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 });
    this.owned.push(tex, material);
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

  /**
   * The loadout row: one lit plinth per weapon, laid out along either axis.
   * `facing` is the yaw the player stands at when reading the labels.
   */
  protected pedestalRow(options: {
    origin: [number, number, number];
    axis?: 'x' | 'z';
    spacing?: number;
    facing?: number;
    label?: string;
    washLights?: boolean;
  }): void {
    const m = this.materials;
    const [ox, oy, oz] = options.origin;
    const axis = options.axis ?? 'x';
    const spacing = options.spacing ?? 3.4;
    const facing = options.facing ?? Math.PI;
    const count = WEAPON_ORDER.length;
    const start = -((count - 1) * spacing) / 2;
    // `facing` is the sign's own yaw, so its front face — and therefore the
    // side the labels are readable from — points along (sin, cos). Offsetting
    // the boards that way puts them between the plinth and the reader.
    const toReader = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing));

    for (let i = 0; i < count; i++) {
      const id = WEAPON_ORDER[i];
      const cfg = WEAPON_CONFIGS[id];
      const offset = start + i * spacing;
      const x = axis === 'x' ? ox + offset : ox;
      const z = axis === 'z' ? oz + offset : oz;

      this.box(1.15, 1.0, 1.15, x, oy + 0.5, z, m.metalDark, { surface: 'metal' });
      this.box(1.28, 0.07, 1.28, x, oy + 1.02, z, m.emissiveCyan, { surface: 'metal', solid: false });
      this.box(1.05, 0.06, 1.05, x, oy + 0.06, z, m.metal, { surface: 'metal', solid: false });

      const display = new THREE.Group();
      display.position.set(x, oy + 1.55, z);
      this.root.add(display);

      this.sign(
        cfg.category,
        `${cfg.slot % 10}`,
        x + toReader.x * 0.7,
        oy + 2.3,
        z + toReader.z * 0.7,
        1.5,
        0.75,
        facing,
      );

      this.pickups.push({ id, position: new THREE.Vector3(x, oy, z), display, radius: 1.7 });
    }

    if (options.label) {
      const span = (count - 1) * spacing + 2;
      this.sign(
        options.label,
        undefined,
        ox + toReader.x * 1.1,
        oy + 3.1,
        oz + toReader.z * 1.1,
        Math.min(span, 10),
        1.2,
        facing,
      );
    }

    if (options.washLights !== false) {
      // Two wash lights cover the whole row instead of one per plinth — ten
      // point lights for ten pedestals is a real cost in a forward renderer.
      for (const side of [-1, 1]) {
        const off = side * spacing * 2.4;
        const wash = new THREE.PointLight(0x8fe4ff, 26, 12, 2);
        wash.position.set(
          axis === 'x' ? ox + off : ox,
          oy + 2.6,
          axis === 'z' ? oz + off : oz,
        );
        this.root.add(wash);
        this.optionalLights.push(wash);
      }
    }
  }

  /** Physical sun + atmospheric sky dome, sharing one direction. */
  protected buildSkyAndSun(options: {
    elevation: number;
    azimuth: number;
    intensity?: number;
    colour?: number;
    turbidity?: number;
    rayleigh?: number;
    shadowRadius?: number;
    shadowTarget?: [number, number, number];
    shadowFar?: number;
  }): { sun: THREE.DirectionalLight; sky: Sky } {
    const sky = new Sky();
    sky.scale.setScalar(45000);
    const uniforms = sky.material.uniforms;
    uniforms.turbidity.value = options.turbidity ?? 5.5;
    uniforms.rayleigh.value = options.rayleigh ?? 1.8;
    uniforms.mieCoefficient.value = 0.004;
    uniforms.mieDirectionalG.value = 0.76;

    compressSkyRadiance(sky.material);

    const phi = THREE.MathUtils.degToRad(90 - options.elevation);
    const theta = THREE.MathUtils.degToRad(options.azimuth);
    const sunPosition = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    uniforms.sunPosition.value.copy(sunPosition);
    this.root.add(sky);

    const radius = options.shadowRadius ?? 75;
    const target = options.shadowTarget ?? [0, 0, -40];
    const sun = new THREE.DirectionalLight(options.colour ?? 0xfff0d8, options.intensity ?? 2.0);
    // Anchor the sun *relative to its target*. A directional light's direction
    // is `position - target`, so placing it at a fixed world offset while the
    // target sits a hundred metres away silently flattens the sun elevation —
    // and a level that expects a 46 degree sun gets lit like a 29 degree one.
    sun.position.copy(sunPosition).multiplyScalar(160).add(new THREE.Vector3(...target));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = options.shadowFar ?? 380;
    sun.shadow.camera.left = -radius;
    sun.shadow.camera.right = radius;
    sun.shadow.camera.top = radius;
    sun.shadow.camera.bottom = -radius;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.035;
    // Keep the shadow frustum centred on the action rather than the whole map.
    sun.target.position.set(target[0], target[1], target[2]);
    this.root.add(sun);
    this.root.add(sun.target);

    return { sun, sky };
  }

  /**
   * Drifting motes, animated entirely on the GPU — one draw call, no per-frame
   * CPU work beyond a single uniform.
   */
  protected buildDustField(options: DustFieldOptions): THREE.Points {
    const count = options.count ?? 520;
    const { x: bx, y: by, z: bz } = options.bounds;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = randRange(bx[0], bx[1]);
      positions[i * 3 + 1] = randRange(by[0], by[1]);
      positions[i * 3 + 2] = randRange(bz[0], bz[1]);
      seeds[i] = Math.random() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    const centre = new THREE.Vector3(
      (bx[0] + bx[1]) / 2,
      (by[0] + by[1]) / 2,
      (bz[0] + bz[1]) / 2,
    );
    const span = Math.max(bx[1] - bx[0], by[1] - by[0], bz[1] - bz[0]);
    geo.boundingSphere = new THREE.Sphere(centre, span);

    const uTime = { value: 0 };
    this.dustUniforms.push(uTime);
    const colour = options.colour ?? [1.0, 0.97, 0.9];
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uSize: { value: options.size ?? 11 },
        uOpacity: { value: options.opacity ?? 0.22 },
        uDrift: { value: options.drift ?? 1.6 },
        uColour: { value: new THREE.Vector3(colour[0], colour[1], colour[2]) },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform float uPixelRatio;
        uniform float uSize;
        uniform float uDrift;
        varying float vFade;
        void main() {
          vec3 p = position;
          // Slow, looping drift so motes never leave their volume.
          p.x += sin(uTime * 0.11 + aSeed) * uDrift;
          p.y += sin(uTime * 0.19 + aSeed * 1.7) * uDrift * 0.31;
          p.z += cos(uTime * 0.09 + aSeed * 0.7) * uDrift;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // Twinkle, and fade out the ones closest to the camera so they read
          // as motes hanging in the air rather than snow on the lens.
          vFade = (0.35 + 0.65 * abs(sin(uTime * 0.9 + aSeed * 3.1)))
                * smoothstep(1.5, 6.0, -mv.z);
          gl_PointSize = (0.8 + 0.5 * sin(aSeed)) * uPixelRatio * (uSize / max(0.1, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform vec3 uColour;
        varying float vFade;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = 1.0 - smoothstep(0.15, 0.5, length(uv));
          if (d <= 0.001) discard;
          gl_FragColor = vec4(uColour, d * vFade * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.owned.push(geo, material);

    const points = new THREE.Points(geo, material);
    points.name = 'dust-motes';
    points.frustumCulled = false;
    points.renderOrder = 5;
    this.root.add(points);
    this.atmospherics.push(points);
    return points;
  }

  /** Merges everything queued so far and registers the shootable results. */
  protected flushBatch(namePrefix: string): void {
    const merged = this.batcher.build(this.root, namePrefix);
    this.collidables.push(...merged);
  }

  /** Base per-frame update: drives dust time and lamp flicker. */
  protected tick(dt: number): void {
    this.elapsed += dt;
    for (const uniform of this.dustUniforms) uniform.value = this.elapsed;
    for (const lamp of this.flickerLamps) {
      // Subtle mains hum flicker; never dips far enough to read as broken.
      const n =
        Math.sin(this.elapsed * 11 + lamp.phase) * 0.5 +
        Math.sin(this.elapsed * 27.3 + lamp.phase * 2.1) * 0.5;
      lamp.light.intensity = lamp.base * (1 + n * 0.035);
    }
  }

  /**
   * Frees the textures and materials this level created. The shared
   * `WorldMaterials` set is cached process-wide and deliberately not touched.
   */
  protected disposeOwned(): void {
    this.root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      // Only merged geometry is safe to free here: `Targets` hands out shared
      // primitives that a rebuilt level would still be pointing at.
      if (mesh.isMesh && mesh.userData.batched === true) mesh.geometry?.dispose();
    });
    for (const item of this.owned) item.dispose();
    this.owned.length = 0;
    this.signMaterials.clear();
  }
}
