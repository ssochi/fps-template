/**
 * The tile grid — the single authoritative structure this whole game queries.
 *
 * Rendering, pathfinding, line-of-sight, wall cutaway, loot placement and
 * player construction are all reads or writes against this. Getting its shape
 * right is the point of M1; everything downstream inherits its choices.
 *
 * ## Storage
 *
 * Parallel typed arrays, not objects. A town of 256 × 256 × 3 is ~200k cells;
 * as JS objects that is 200k allocations and constant GC pressure during a
 * horde update. As typed arrays it is a handful of contiguous buffers.
 *
 * ## Walls live on edges, not in cells
 *
 * Each cell stores only its **north** and **west** wall. A wall between two
 * tiles belongs to exactly one of them, so it cannot be half-destroyed, cannot
 * be drawn twice, and cannot disagree with itself about whether it is solid.
 * The alternative — four walls per cell — means every wall exists twice and
 * every write has to keep both copies in sync, which is a bug factory.
 *
 * To ask about the wall on a cell's *south* edge, ask its southern neighbour
 * about its north edge. `wallAt()` does this for you.
 */
import { CHUNK, DIR, DIR_VEC } from '../core/constants.js';

/** Cell flags, bitwise. */
export const FLAG = {
  /** Blocks movement even with no wall — a filled cell, e.g. bedrock or a pillar. */
  SOLID: 1 << 0,
  /** Blocks line of sight. */
  OPAQUE: 1 << 1,
  /** Counts as inside a building — drives cutaway, temperature and rain. */
  INDOOR: 1 << 2,
  /** Has been generated. Ungenerated cells read as void. */
  GENERATED: 1 << 3,
};

/**
 * Wall material ids. 0 always means "no wall"; that invariant is relied on by
 * every consumer, so new materials are appended, never inserted.
 */
export const WALL = {
  NONE: 0,
  WOOD: 1,
  PLASTER: 2,
  BRICK: 3,
  CONCRETE: 4,
  /** A wall with a doorway cut in it — blocks sight only when the door is shut. */
  DOORWAY: 5,
  /** A wall with a window — see-through, blocks movement. */
  WINDOW: 6,
  /** Waist-high: blocks movement (climbable), never blocks sight. */
  FENCE: 7,
};

/** Wall materials that do not block line of sight. */
const TRANSPARENT_WALLS = new Set([WALL.NONE, WALL.WINDOW, WALL.FENCE]);
/** Wall materials you can climb over rather than walk through. */
const CLIMBABLE_WALLS = new Set([WALL.FENCE, WALL.WINDOW]);

/** Floor material ids. 0 means void — no floor, you fall or cannot stand. */
export const FLOOR = {
  VOID: 0,
  GRASS: 1,
  DIRT: 2,
  ASPHALT: 3,
  PAVEMENT: 4,
  WOOD: 5,
  CARPET: 6,
  TILE: 7,
  CONCRETE: 8,
  ROOF: 9,
};

export class TileGrid {
  /**
   * @param {number} width  tiles along X
   * @param {number} depth  tiles along Z
   * @param {number} levels storeys
   */
  constructor(width, depth, levels = 1) {
    this.width = width;
    this.depth = depth;
    this.levels = levels;

    const n = width * depth * levels;
    this.size = n;

    this.floor = new Uint8Array(n);
    /** North wall of each cell (the edge at lower Z). */
    this.wallN = new Uint8Array(n);
    /** West wall of each cell (the edge at lower X). */
    this.wallW = new Uint8Array(n);
    /** Furniture / door / stairs id, 0 for empty. */
    this.object = new Uint16Array(n);
    /** Room id, 0 for outdoors. */
    this.room = new Uint16Array(n);
    this.flags = new Uint8Array(n);

    this.chunksX = Math.ceil(width / CHUNK);
    this.chunksZ = Math.ceil(depth / CHUNK);
    /** Chunks needing a mesh rebuild, as packed chunk keys. */
    this.dirtyChunks = new Set();
  }

  /** @returns {boolean} whether the coordinate is inside the grid. */
  inBounds(x, z, level = 0) {
    return x >= 0 && z >= 0 && level >= 0 && x < this.width && z < this.depth && level < this.levels;
  }

  /**
   * Flat array index for a cell. Callers on a hot path should compute this once
   * and index the typed arrays directly rather than going through accessors.
   * @returns {number} index, or -1 if out of bounds
   */
  index(x, z, level = 0) {
    if (!this.inBounds(x, z, level)) return -1;
    return (level * this.depth + z) * this.width + x;
  }

  /** Unchecked index — only for callers that have already bounds-checked. */
  idx(x, z, level) {
    return (level * this.depth + z) * this.width + x;
  }

  // --- reads ------------------------------------------------------------

  getFloor(x, z, level = 0) {
    const i = this.index(x, z, level);
    return i < 0 ? FLOOR.VOID : this.floor[i];
  }

  getRoom(x, z, level = 0) {
    const i = this.index(x, z, level);
    return i < 0 ? 0 : this.room[i];
  }

  getFlags(x, z, level = 0) {
    const i = this.index(x, z, level);
    return i < 0 ? 0 : this.flags[i];
  }

  hasFlag(x, z, level, flag) {
    return (this.getFlags(x, z, level) & flag) !== 0;
  }

  /**
   * The wall on a given side of a cell, resolving the north/west storage rule.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} level
   * @param {number} dir one of DIR
   * @returns {number} wall material id, 0 for none
   */
  wallAt(x, z, level, dir) {
    switch (dir) {
      case DIR.N: {
        const i = this.index(x, z, level);
        return i < 0 ? WALL.NONE : this.wallN[i];
      }
      case DIR.W: {
        const i = this.index(x, z, level);
        return i < 0 ? WALL.NONE : this.wallW[i];
      }
      case DIR.S: {
        // The south edge of (x,z) is the north edge of (x, z+1).
        const i = this.index(x, z + 1, level);
        return i < 0 ? WALL.NONE : this.wallN[i];
      }
      case DIR.E: {
        // The east edge of (x,z) is the west edge of (x+1, z).
        const i = this.index(x + 1, z, level);
        return i < 0 ? WALL.NONE : this.wallW[i];
      }
      default:
        return WALL.NONE;
    }
  }

  /** The wall between two orthogonally adjacent cells. */
  wallBetween(x1, z1, x2, z2, level) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    if (dx === 0 && dz === -1) return this.wallAt(x1, z1, level, DIR.N);
    if (dx === 0 && dz === 1) return this.wallAt(x1, z1, level, DIR.S);
    if (dx === 1 && dz === 0) return this.wallAt(x1, z1, level, DIR.E);
    if (dx === -1 && dz === 0) return this.wallAt(x1, z1, level, DIR.W);
    throw new Error(`wallBetween expects orthogonally adjacent cells, got (${dx}, ${dz})`);
  }

  /**
   * Can something walk from one cell to an orthogonally adjacent one?
   * Climbable walls (fences, open windows) return false here — vaulting is a
   * deliberate action, not ordinary movement, and callers ask separately.
   */
  canWalk(x1, z1, x2, z2, level) {
    if (!this.inBounds(x2, z2, level)) return false;
    const to = this.idx(x2, z2, level);
    if (this.floor[to] === FLOOR.VOID) return false;
    if (this.flags[to] & FLAG.SOLID) return false;

    const wall = this.wallBetween(x1, z1, x2, z2, level);
    // A doorway is passable; whether the *door* in it is shut is the object
    // layer's business, checked by the caller that cares.
    return wall === WALL.NONE || wall === WALL.DOORWAY;
  }

  /** Can something climb from one cell to an adjacent one (fence, window)? */
  canClimb(x1, z1, x2, z2, level) {
    if (!this.inBounds(x2, z2, level)) return false;
    const to = this.idx(x2, z2, level);
    if (this.floor[to] === FLOOR.VOID || this.flags[to] & FLAG.SOLID) return false;
    return CLIMBABLE_WALLS.has(this.wallBetween(x1, z1, x2, z2, level));
  }

  /** Does the edge between two adjacent cells block line of sight? */
  blocksSight(x1, z1, x2, z2, level) {
    if (!this.inBounds(x2, z2, level)) return true;
    if (this.flags[this.idx(x2, z2, level)] & FLAG.OPAQUE) return true;
    return !TRANSPARENT_WALLS.has(this.wallBetween(x1, z1, x2, z2, level));
  }

  /** Is this cell somewhere an entity could stand? */
  isWalkable(x, z, level = 0) {
    const i = this.index(x, z, level);
    if (i < 0) return false;
    return this.floor[i] !== FLOOR.VOID && (this.flags[i] & FLAG.SOLID) === 0;
  }

  // --- writes -----------------------------------------------------------
  // Every write marks the affected chunk(s) dirty. A wall on a chunk boundary
  // is visible from the neighbouring chunk's mesh too, so both are marked.

  setFloor(x, z, level, material) {
    const i = this.index(x, z, level);
    if (i < 0) return;
    this.floor[i] = material;
    this.flags[i] |= FLAG.GENERATED;
    this.markDirty(x, z, level);
  }

  setRoom(x, z, level, room) {
    const i = this.index(x, z, level);
    if (i < 0) return;
    this.room[i] = room;
  }

  setObject(x, z, level, object) {
    const i = this.index(x, z, level);
    if (i < 0) return;
    this.object[i] = object;
    this.markDirty(x, z, level);
  }

  setFlag(x, z, level, flag, on = true) {
    const i = this.index(x, z, level);
    if (i < 0) return;
    if (on) this.flags[i] |= flag;
    else this.flags[i] &= ~flag;
  }

  /**
   * Place a wall on a given side of a cell, resolving to the owning cell.
   * @param {number} dir one of DIR
   */
  setWall(x, z, level, dir, material) {
    let ox = x;
    let oz = z;
    let side = dir;
    if (dir === DIR.S) {
      oz = z + 1;
      side = DIR.N;
    } else if (dir === DIR.E) {
      ox = x + 1;
      side = DIR.W;
    }
    const i = this.index(ox, oz, level);
    if (i < 0) return;
    if (side === DIR.N) this.wallN[i] = material;
    else this.wallW[i] = material;

    // Both sides of the edge need remeshing when they fall in different chunks.
    this.markDirty(ox, oz, level);
    this.markDirty(x, z, level);
    const v = DIR_VEC[dir];
    this.markDirty(x + v.dx, z + v.dz, level);
  }

  // --- chunk bookkeeping ------------------------------------------------

  /** Packed key for a chunk, used by the dirty set and the mesh registry. */
  chunkKey(cx, cz, level) {
    return (level * this.chunksZ + cz) * this.chunksX + cx;
  }

  /** Chunk key for a tile coordinate, or -1 if out of bounds. */
  chunkKeyForTile(x, z, level) {
    if (!this.inBounds(x, z, level)) return -1;
    return this.chunkKey(Math.floor(x / CHUNK), Math.floor(z / CHUNK), level);
  }

  markDirty(x, z, level) {
    const key = this.chunkKeyForTile(x, z, level);
    if (key >= 0) this.dirtyChunks.add(key);
  }

  markAllDirty() {
    for (let level = 0; level < this.levels; level++) {
      for (let cz = 0; cz < this.chunksZ; cz++) {
        for (let cx = 0; cx < this.chunksX; cx++) {
          this.dirtyChunks.add(this.chunkKey(cx, cz, level));
        }
      }
    }
  }

  /** Decode a packed chunk key back to coordinates. */
  decodeChunkKey(key) {
    const cx = key % this.chunksX;
    const rest = (key - cx) / this.chunksX;
    const cz = rest % this.chunksZ;
    const level = (rest - cz) / this.chunksZ;
    return { cx, cz, level };
  }

  /** Take and clear the dirty set. */
  takeDirty() {
    const keys = [...this.dirtyChunks];
    this.dirtyChunks.clear();
    return keys;
  }
}
