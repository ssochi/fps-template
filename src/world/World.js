/**
 * Owns the tile grid and the scene objects that visualise it.
 *
 * The grid is the truth; meshes are a cache of it. Anything that changes the
 * world writes to the grid and marks chunks dirty, and the world rebuilds those
 * meshes — never the other way round. That one-way flow is what keeps
 * construction, destruction and worldgen from each needing their own renderer.
 */
import { Group, Mesh } from 'three';
import { TileGrid } from './TileGrid.js';
import { meshChunk } from './Mesher.js';
import { CHUNK } from '../core/constants.js';
import { FogOfWar } from '../render/FogOfWar.js';
import { Cutaway } from '../render/Cutaway.js';
import {
  createWorldDepthMaterial,
  createWorldMaterial,
  createWorldUniforms,
} from '../render/WorldMaterial.js';

export class World {
  /**
   * @param {import('three').Scene} scene
   * @param {number} width
   * @param {number} depth
   * @param {number} levels
   */
  constructor(scene, width, depth, levels = 1, { maxRooms = 1024, sightRadius = 17 } = {}) {
    this.grid = new TileGrid(width, depth, levels);
    this.scene = scene;

    this.group = new Group();
    this.group.name = 'world';
    scene.add(this.group);

    // How far the observer sees is a property of the observer, so M12's
    // Eagle-eyed and Short-sighted traits reach the fog through here.
    this.fog = new FogOfWar(this.grid, { radius: Math.round(sightRadius) });
    this.cutaway = new Cutaway(this, maxRooms);

    // One set of uniform objects shared by the beauty and depth materials, so
    // a cut wall and its shadow can never disagree about being cut.
    this.uniforms = createWorldUniforms({
      visibilityTexture: this.fog.texture,
      visWidth: this.fog.width,
      visHeight: this.fog.height,
      gridDepth: this.grid.depth,
      roomCutTexture: this.cutaway.texture,
      roomCount: this.cutaway.roomCount,
    });

    this.material = createWorldMaterial(this.uniforms);
    this.depthMaterial = createWorldDepthMaterial(this.uniforms);

    /** @type {Map<number, Mesh>} chunk key → mesh */
    this.meshes = new Map();

    this.stats = { chunks: 0, triangles: 0, rebuilds: 0, visible: 0 };
  }

  /**
   * Drive the per-frame view state: which building is cut open, which wall
   * facings the camera is looking through, and what the player can see.
   *
   * @param {number} dt
   * @param {{x:number,z:number,level:number}} observer tile coordinates
   * @param {import('../render/IsoCamera.js').IsoCamera} isoCamera
   */
  updateView(dt, observer, isoCamera) {
    const roomId = this.grid.getRoom(observer.x, observer.z, observer.level);
    this.cutaway.update(dt, roomId);
    this.cutaway.facingMask(isoCamera, this.uniforms.uFacingHidden.value);
    this.uniforms.uPlayerLevel.value = observer.level;
    this.fog.update(observer.x, observer.z, observer.level);
    this.stats.visible = this.fog.stats.visible;
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
    // Shadows are cast through the same cutaway logic, or a removed roof would
    // still lay its shadow across the room it was hiding.
    mesh.customDepthMaterial = this.depthMaterial;
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
    this.depthMaterial.dispose();
    this.fog.dispose();
    this.cutaway.dispose();
    this.scene.remove(this.group);
  }
}
