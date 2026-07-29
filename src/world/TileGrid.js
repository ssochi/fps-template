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
import { OBJ, objectId } from './Objects.js';

/**
 * Per-cell object state, bitwise. Separate from `flags` because flags describe
 * the *terrain* and are written by worldgen, while state describes the object
 * standing on it and is written during play — a door swings, a window breaks, a
 * container gets emptied. Keeping them apart means a save file can store the
 * state array as a delta without also re-storing the town.
 */
export const STATE = {
  /** A door in a doorway is standing open. */
  DOOR_OPEN: 1 << 0,
  /** The window in this wall has been smashed — passable, and noisy to make. */
  WINDOW_BROKEN: 1 << 1,
  /** A container here has already been looted. */
  SEARCHED: 1 << 2,
};

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
    /** Runtime state of the object in each cell — see STATE. */
    this.state = new Uint8Array(n);

    /**
     * Barricades, stored on the same north/west edges as the walls they cover.
     *
     * `planks` is how many are nailed across the opening — it sets the maximum
     * health and is what the mesher draws. `hp` is what is left of them. Keeping
     * them separate means a half-broken barricade still *looks* like four planks
     * with two smashed, rather than silently becoming a smaller barricade.
     */
    this.barricadeN = new Uint8Array(n);
    this.barricadeW = new Uint8Array(n);
    this.barricadeHpN = new Uint8Array(n);
    this.barricadeHpW = new Uint8Array(n);

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
    if (this.isBarricaded(x1, z1, x2, z2, level)) return false;
    const to = this.idx(x2, z2, level);
    if (this.floor[to] === FLOOR.VOID || this.flags[to] & FLAG.SOLID) return false;
    return CLIMBABLE_WALLS.has(this.wallBetween(x1, z1, x2, z2, level));
  }

  // --- vertical links ---------------------------------------------------
  //
  // A staircase is two tiles on one storey — a bottom step and a top step —
  // with the ceiling above the *bottom* step opened out and the cell above the
  // *top* step left solid as a landing. So the join between the storeys is the
  // single tile column above the top step: standing on the top step you climb,
  // standing on the landing you descend. One column, both directions, one rule.
  //
  // Before M13 there were two rules and they disagreed. Ascent used the top
  // step; descent used the opened ceiling above the bottom step — a cell that
  // `canWalk` correctly refuses to enter, because it has no floor. Going
  // upstairs was a one-way trip, and the test that covered it placed the player
  // on the void tile by hand and said so in a comment. Pathing, sound and the
  // player all read the two methods below now, so there is one answer.

  /** @returns {number} the level a climb from here reaches, or -1 */
  climbFrom(x, z, level) {
    const i = this.index(x, z, level);
    if (i < 0 || level + 1 >= this.levels) return -1;
    if (objectId(this.object[i]) !== OBJ.STAIRS_HIGH) return -1;
    return this.isWalkable(x, z, level + 1) ? level + 1 : -1;
  }

  /** @returns {number} the level a descent from here reaches, or -1 */
  descendFrom(x, z, level) {
    if (level <= 0) return -1;
    const below = this.index(x, z, level - 1);
    if (below < 0) return -1;
    if (objectId(this.object[below]) !== OBJ.STAIRS_HIGH) return -1;
    // You must be standing somewhere, and arriving somewhere.
    return this.isWalkable(x, z, level) && this.isWalkable(x, z, level - 1) ? level - 1 : -1;
  }

  /** Does the edge between two adjacent cells block line of sight? */
  blocksSight(x1, z1, x2, z2, level) {
    if (!this.inBounds(x2, z2, level)) return true;
    if (this.flags[this.idx(x2, z2, level)] & FLAG.OPAQUE) return true;
    // Planks block sight as well as movement — that is half of why you put
    // them up, and it works both ways: you cannot see out either.
    if (this.isBarricaded(x1, z1, x2, z2, level)) return true;
    const wall = this.wallBetween(x1, z1, x2, z2, level);
    // An open door is a hole you can see through; a shut one is a wall.
    if (wall === WALL.DOORWAY) return !this.isDoorOpen(x1, z1, x2, z2, level);
    return !TRANSPARENT_WALLS.has(wall);
  }

  // --- doors ------------------------------------------------------------
  // A door object lives on one of the two tiles either side of its doorway.
  // Rather than make callers work out which, these helpers check both.

  /** The tile holding the door object for the doorway between two cells. */
  doorTile(x1, z1, x2, z2, level) {
    if (this.wallBetween(x1, z1, x2, z2, level) !== WALL.DOORWAY) return null;
    if (this.object[this.idx(x1, z1, level)] !== 0) return { x: x1, z: z1 };
    if (this.inBounds(x2, z2, level) && this.object[this.idx(x2, z2, level)] !== 0) {
      return { x: x2, z: z2 };
    }
    return null;
  }

  /** True when the doorway has no door in it, or its door stands open. */
  isDoorOpen(x1, z1, x2, z2, level) {
    const tile = this.doorTile(x1, z1, x2, z2, level);
    if (!tile) return true; // an empty doorway is always passable
    return (this.state[this.idx(tile.x, tile.z, level)] & STATE.DOOR_OPEN) !== 0;
  }

  /** @returns {boolean} whether anything actually changed */
  setDoorOpen(x, z, level, open) {
    const i = this.index(x, z, level);
    if (i < 0) return false;
    const was = (this.state[i] & STATE.DOOR_OPEN) !== 0;
    if (was === open) return false;
    if (open) this.state[i] |= STATE.DOOR_OPEN;
    else this.state[i] &= ~STATE.DOOR_OPEN;
    this.markDirty(x, z, level);
    return true;
  }

  // --- barricades -------------------------------------------------------

  /**
   * Planks across a given side of a cell, resolving the north/west storage rule
   * exactly as `wallAt` does.
   * @returns {{ planks: number, hp: number, index: number, side: 'N'|'W' } | null}
   */
  barricadeAt(x, z, level, dir) {
    let ox = x;
    let oz = z;
    let side;
    if (dir === DIR.N) side = 'N';
    else if (dir === DIR.W) side = 'W';
    else if (dir === DIR.S) {
      oz = z + 1;
      side = 'N';
    } else {
      ox = x + 1;
      side = 'W';
    }
    const i = this.index(ox, oz, level);
    if (i < 0) return null;
    const planks = side === 'N' ? this.barricadeN[i] : this.barricadeW[i];
    const hp = side === 'N' ? this.barricadeHpN[i] : this.barricadeHpW[i];
    return { planks, hp, index: i, side };
  }

  /** Barricade on the edge between two adjacent cells, or null. */
  barricadeBetween(x1, z1, x2, z2, level) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    if (dx === 0 && dz === -1) return this.barricadeAt(x1, z1, level, DIR.N);
    if (dx === 0 && dz === 1) return this.barricadeAt(x1, z1, level, DIR.S);
    if (dx === 1 && dz === 0) return this.barricadeAt(x1, z1, level, DIR.E);
    if (dx === -1 && dz === 0) return this.barricadeAt(x1, z1, level, DIR.W);
    return null;
  }

  /** True when planks are still holding on this edge. */
  isBarricaded(x1, z1, x2, z2, level) {
    const b = this.barricadeBetween(x1, z1, x2, z2, level);
    return !!b && b.hp > 0;
  }

  /**
   * Nail a plank across an edge.
   * @returns {boolean} whether it went on
   */
  addPlank(x, z, level, dir, hpPerPlank, maxPlanks) {
    const b = this.barricadeAt(x, z, level, dir);
    if (!b || b.planks >= maxPlanks) return false;
    const arr = b.side === 'N' ? this.barricadeN : this.barricadeW;
    const hpArr = b.side === 'N' ? this.barricadeHpN : this.barricadeHpW;
    arr[b.index] = b.planks + 1;
    hpArr[b.index] = Math.min(255, b.hp + hpPerPlank);
    this._dirtyEdge(x, z, level, dir);
    return true;
  }

  /**
   * Damage a barricade.
   * @returns {boolean} whether it broke open on this hit
   */
  damageBarricade(x1, z1, x2, z2, level, amount) {
    const b = this.barricadeBetween(x1, z1, x2, z2, level);
    if (!b || b.hp <= 0) return false;
    const hpArr = b.side === 'N' ? this.barricadeHpN : this.barricadeHpW;
    const arr = b.side === 'N' ? this.barricadeN : this.barricadeW;
    const left = Math.max(0, b.hp - amount);
    hpArr[b.index] = left;
    if (left === 0) arr[b.index] = 0;
    this.markDirty(x1, z1, level);
    this.markDirty(x2, z2, level);
    return left === 0;
  }

  /** Mark both cells either side of an edge dirty. */
  _dirtyEdge(x, z, level, dir) {
    this.markDirty(x, z, level);
    const v = DIR_VEC[dir];
    this.markDirty(x + v.dx, z + v.dz, level);
  }

  /**
   * Can something *actually* move between two cells right now?
   *
   * `canWalk` answers the geometric question and is what pathfinding and
   * connectivity checks want — a shut door is still a route, it just needs
   * opening. `canPass` additionally respects door state and is what movement
   * wants. Conflating the two would either make the horde refuse to path
   * through doors or let the player walk through closed ones.
   */
  canPass(x1, z1, x2, z2, level) {
    if (!this.canWalk(x1, z1, x2, z2, level)) return false;
    // Planks stop you whatever is behind them.
    if (this.isBarricaded(x1, z1, x2, z2, level)) return false;
    if (this.wallBetween(x1, z1, x2, z2, level) !== WALL.DOORWAY) return true;
    return this.isDoorOpen(x1, z1, x2, z2, level);
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
