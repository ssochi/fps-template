/**
 * Owns the tile grid and the scene objects that visualise it.
 *
 * The grid is the truth; meshes are a cache of it. Anything that changes the
 * world writes to the grid and marks chunks dirty, and the world rebuilds those
 * meshes — never the other way round. That one-way flow is what keeps
 * construction, destruction and worldgen from each needing their own renderer.
 */
import { FrontSide, Group, Mesh, MeshLambertMaterial } from 'three';
import { TileGrid } from './TileGrid.js';
import { meshChunk } from './Mesher.js';
import { CHUNK } from '../core/constants.js';

/**
 * One material for the entire world. Every surface colour lives in vertex
 * colours, so mixing grass, asphalt, plaster and brick in one chunk still costs
 * exactly one draw call.
 */
function createWorldMaterial() {
  const material = new MeshLambertMaterial({
    vertexColors: true,
    // Walls are zero-thickness planes emitted as two opposing one-sided quads,
    // so back-face culling stays correct and halves the fragment work.
    side: FrontSide,
  });
  // three.js defaults `shadowSide` to the *opposite* of `side`, which assumes
  // closed solids. Our walls are coplanar pairs of one-sided quads: rendering
  // their back faces into the shadow map makes each wall shadow itself, which
  // shows up as hard black wedges across facades. Casting from the same faces
  // we shade from removes the fight entirely.
  material.shadowSide = FrontSide;
  return material;
}

export class World {
  /**
   * @param {import('three').Scene} scene
   * @param {number} width
   * @param {number} depth
   * @param {number} levels
   */
  constructor(scene, width, depth, levels = 1) {
    this.grid = new TileGrid(width, depth, levels);
    this.scene = scene;

    this.group = new Group();
    this.group.name = 'world';
    scene.add(this.group);

    this.material = createWorldMaterial();

    /** @type {Map<number, Mesh>} chunk key → mesh */
    this.meshes = new Map();

    this.stats = { chunks: 0, triangles: 0, rebuilds: 0, visible: 0 };

    /**
     * Highest storey currently drawn. Everything above it is hidden so the
     * player can see the room they are standing in instead of its ceiling.
     *
     * This is the crude version — whole storeys, all at once. M4 refines it to
     * per-room, which is what makes it feel like seeing into a house rather
     * than taking the lid off the town.
     */
    this.levelCutoff = Infinity;
  }

  /** @param {number} level highest storey to draw; Infinity draws everything */
  setLevelCutoff(level) {
    if (level === this.levelCutoff) return;
    this.levelCutoff = level;
    this._applyCutoff();
  }

  _applyCutoff() {
    let visible = 0;
    for (const mesh of this.meshes.values()) {
      const shown = mesh.userData.chunk.level <= this.levelCutoff;
      mesh.visible = shown;
      if (shown) visible++;
    }
    this.stats.visible = visible;
  }

  /**
   * Rebuild dirty chunk meshes.
   *
   * @param {number} [budget] max chunks to rebuild this call. Worldgen passes
   *   Infinity; the running game passes a small number so a collapsing building
   *   never costs a frame.
   */
  flushDirty(budget = Infinity) {
    const keys = this.grid.takeDirty();
    if (keys.length === 0) return 0;

    let done = 0;
    for (const key of keys) {
      if (done >= budget) {
        // Put the remainder back for the next call rather than dropping them.
        this.grid.dirtyChunks.add(key);
        continue;
      }
      this.rebuildChunk(key);
      done++;
    }
    this.stats.rebuilds += done;
    this._applyCutoff();
    this.recount();
    return done;
  }

  rebuildChunk(key) {
    const { cx, cz, level } = this.grid.decodeChunkKey(key);

    const existing = this.meshes.get(key);
    if (existing) {
      existing.geometry.dispose();
      this.group.remove(existing);
      this.meshes.delete(key);
    }

    const built = meshChunk(this.grid, cx, cz, level);
    if (!built) return; // empty chunk: no mesh at all, not an empty one

    const mesh = new Mesh(built.geometry, this.material);
    mesh.name = `chunk:${cx},${cz}@${level}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.chunk = { cx, cz, level };
    // Chunk geometry is in world space already, so the mesh sits at the origin.
    this.meshes.set(key, mesh);
    this.group.add(mesh);
  }

  recount() {
    let tris = 0;
    for (const mesh of this.meshes.values()) {
      tris += mesh.geometry.getAttribute('position').count / 3;
    }
    this.stats.chunks = this.meshes.size;
    this.stats.triangles = tris;
  }

  /** Chunk-space bounds of the loaded world, for debugging and camera limits. */
  get bounds() {
    return {
      minX: 0,
      minZ: 0,
      maxX: this.grid.width,
      maxZ: this.grid.depth,
      chunkSize: CHUNK,
    };
  }

  dispose() {
    for (const mesh of this.meshes.values()) mesh.geometry.dispose();
    this.meshes.clear();
    this.material.dispose();
    this.scene.remove(this.group);
  }
}
