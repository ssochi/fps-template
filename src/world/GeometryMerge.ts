import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Static geometry batching.
 *
 * The range is built from hundreds of small primitives. Left as individual
 * meshes that is hundreds of draw calls, which caps how much scenery detail the
 * level can afford. Nothing in the static set moves, so it can all be baked
 * into a handful of merged meshes — one per material — which is what makes the
 * prop density in `ShootingRange` practical.
 *
 * Ballistics still work against the merged meshes: the surface tag is part of
 * the batch key, so a merged mesh has a single, correct `userData.surface`.
 * Front-face-only raycasting means a round that enters a solid box does not
 * register a second hit on the way out, so penetration is unaffected.
 */

interface BatchEntry {
  material: THREE.Material;
  surface: string;
  castShadow: boolean;
  receiveShadow: boolean;
  shootable: boolean;
  geometries: THREE.BufferGeometry[];
}

/** Attributes every batched geometry is normalised to before merging. */
const REQUIRED_ATTRIBUTES = ['position', 'normal', 'uv'] as const;

function normalise(geometry: THREE.BufferGeometry): THREE.BufferGeometry | null {
  // `mergeGeometries` refuses to mix indexed and non-indexed sources, and the
  // level mixes both (RoundedBoxGeometry is non-indexed, the primitives are
  // indexed). Expanding everything to non-indexed is the reliable common
  // ground; the extra vertices are immaterial for static level geometry.
  const geo = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const name of REQUIRED_ATTRIBUTES) {
    if (!geo.getAttribute(name)) {
      // Without a matching attribute set `mergeGeometries` bails out; a
      // geometry that cannot be normalised is better left un-batched.
      if (name === 'uv') {
        const count = geo.getAttribute('position')?.count ?? 0;
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
      } else {
        geo.dispose();
        return null;
      }
    }
  }
  // Drop everything else so heterogeneous sources still merge cleanly.
  for (const name of Object.keys(geo.attributes)) {
    if (!(REQUIRED_ATTRIBUTES as readonly string[]).includes(name)) geo.deleteAttribute(name);
  }
  geo.morphAttributes = {};
  geo.clearGroups();
  return geo;
}

export interface BatchOptions {
  surface?: string;
  castShadow?: boolean;
  receiveShadow?: boolean;
  shootable?: boolean;
}

export class StaticBatcher {
  private readonly batches = new Map<string, BatchEntry>();

  /** Queues a geometry, pre-transformed by `matrix`, for merging. */
  add(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    matrix: THREE.Matrix4,
    options: BatchOptions = {},
  ): void {
    const normalised = normalise(geometry);
    if (!normalised) return;
    normalised.applyMatrix4(matrix);

    const surface = options.surface ?? 'concrete';
    const castShadow = options.castShadow ?? true;
    const receiveShadow = options.receiveShadow ?? true;
    const shootable = options.shootable ?? true;
    const key = `${material.uuid}|${surface}|${castShadow ? 1 : 0}|${receiveShadow ? 1 : 0}|${shootable ? 1 : 0}`;

    let entry = this.batches.get(key);
    if (!entry) {
      entry = { material, surface, castShadow, receiveShadow, shootable, geometries: [] };
      this.batches.set(key, entry);
    }
    entry.geometries.push(normalised);
  }

  /** Queues a mesh using its current world transform. */
  addMesh(mesh: THREE.Mesh, options: BatchOptions = {}): void {
    mesh.updateWorldMatrix(true, false);
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    this.add(mesh.geometry, material, mesh.matrixWorld, {
      surface: options.surface ?? (mesh.userData.surface as string | undefined),
      castShadow: options.castShadow ?? mesh.castShadow,
      receiveShadow: options.receiveShadow ?? mesh.receiveShadow,
      shootable: options.shootable,
    });
  }

  get pendingBatches(): number {
    return this.batches.size;
  }

  /**
   * Merges everything queued so far and adds the results to `parent`.
   *
   * @returns the merged meshes, so callers can register the shootable ones.
   */
  build(parent: THREE.Object3D, namePrefix = 'batch'): THREE.Mesh[] {
    const result: THREE.Mesh[] = [];

    for (const [key, entry] of this.batches) {
      const merged =
        entry.geometries.length === 1
          ? entry.geometries[0]
          : mergeGeometries(entry.geometries, false);
      if (!merged) continue;
      if (entry.geometries.length > 1) {
        for (const g of entry.geometries) g.dispose();
      }
      merged.computeBoundingSphere();

      const mesh = new THREE.Mesh(merged, entry.material);
      mesh.name = `${namePrefix}-${key.slice(0, 8)}`;
      mesh.castShadow = entry.castShadow;
      mesh.receiveShadow = entry.receiveShadow;
      mesh.userData.surface = entry.surface;
      mesh.userData.batched = true;
      parent.add(mesh);
      if (entry.shootable) result.push(mesh);
    }

    this.batches.clear();
    return result;
  }
}

/**
 * Merges a group's contents in place, keeping the group's own transform.
 * Used for the static furniture of range targets, which never animates even
 * though the target as a whole does.
 */
export function mergeChildrenInPlace(group: THREE.Group, name = 'decor'): void {
  if (group.children.length < 2) return;
  const merged = mergeStaticHierarchy(group, name);
  group.clear();
  for (const child of [...merged.children]) group.add(child);
}

/**
 * Flattens an object hierarchy into one mesh per material, baking each mesh's
 * transform. Used for display props such as the weapons on the loadout
 * pedestals, which never animate but are built from dozens of primitives.
 */
export function mergeStaticHierarchy(source: THREE.Object3D, name = 'merged'): THREE.Group {
  source.updateWorldMatrix(true, true);
  const inverseRoot = source.matrixWorld.clone().invert();
  const batcher = new StaticBatcher();
  const localMatrix = new THREE.Matrix4();

  source.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    localMatrix.multiplyMatrices(inverseRoot, mesh.matrixWorld);
    batcher.add(mesh.geometry, material, localMatrix, {
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      shootable: false,
    });
  });

  const group = new THREE.Group();
  group.name = name;
  batcher.build(group, name);
  return group;
}
