/**
 * Building generation: a footprint becomes rooms, doors, windows and stairs.
 *
 * Rooms come from recursive binary partitioning rather than noise, because the
 * thing that makes an interior believable is not variety — it is that every
 * room is rectangular, load-bearing walls line up between storeys, and *every
 * room can be reached*. A generator that occasionally seals a room off is worse
 * than one that always produces boring houses, so connectivity is asserted in
 * tests rather than hoped for.
 *
 * The doorway graph is built explicitly: partition, then connect each split's
 * two halves with exactly one doorway before recursing. That guarantees a tree
 * over the rooms, so every room is reachable from every other by construction.
 */
import { DIR } from '../core/constants.js';
import { FLAG, FLOOR, WALL } from '../world/TileGrid.js';
import { OBJ, packObject } from '../world/Objects.js';

/** Smallest room, in tiles. Below this an interior stops reading as a room. */
const MIN_ROOM = 3;

/**
 * @typedef {object} Room
 * @property {number} id
 * @property {number} x @property {number} z
 * @property {number} w @property {number} d
 * @property {number} level
 * @property {string} purpose
 */

/**
 * @param {import('../world/TileGrid.js').TileGrid} grid
 * @param {import('../core/Rng.js').Rng} rng
 * @param {{x:number,z:number,w:number,d:number,storeys:number,wall:number,nextRoomId:number}} opts
 * @returns {{ rooms: Room[], nextRoomId: number, entrance: {x:number,z:number} }}
 */
export function buildBuilding(grid, rng, opts) {
  const { x, z, w, d, storeys, wall } = opts;
  let roomId = opts.nextRoomId;
  /** @type {Room[]} */
  const rooms = [];

  // Where the front door goes. Chosen once and reused as the ground-floor
  // entrance so the building always has a way in from the street.
  const entranceX = x + 1 + rng.int(0, Math.max(0, w - 3));
  const entrance = { x: entranceX, z };

  /** @type {{x:number,z:number,dir:number}|null} */
  let stairFoot = null;
  /**
   * Stairwell openings, applied *after* every storey is laid.
   *
   * Carving the hole inline does not survive: the next iteration of this loop
   * floors its entire footprint and paves straight back over it. Deferring is
   * the fix, not reordering the floor pass — the hole is a property of the
   * finished building, not of the storey below it.
   *
   * @type {{x:number,z:number,level:number}[]}
   */
  const stairwells = [];

  for (let level = 0; level < storeys; level++) {
    // Floor and interior flag across the whole footprint.
    for (let iz = z; iz < z + d; iz++) {
      for (let ix = x; ix < x + w; ix++) {
        grid.setFloor(ix, iz, level, level === 0 ? FLOOR.WOOD : FLOOR.CARPET);
        grid.setFlag(ix, iz, level, FLAG.INDOOR, true);
      }
    }

    // Exterior shell.
    shellWalls(grid, x, z, w, d, level, wall);

    // Partition into rooms, connecting as we go.
    const levelRooms = [];
    partition(grid, rng, { x, z, w, d }, level, levelRooms, () => roomId++);
    for (const r of levelRooms) {
      for (let iz = r.z; iz < r.z + r.d; iz++) {
        for (let ix = r.x; ix < r.x + r.w; ix++) grid.setRoom(ix, iz, level, r.id);
      }
    }
    rooms.push(...levelRooms);

    // Windows on the exterior, skipping the entrance tile.
    addWindows(grid, rng, { x, z, w, d }, level, wall, level === 0 ? entrance : null);

    if (level === 0) {
      grid.setWall(entrance.x, entrance.z, 0, DIR.N, WALL.DOORWAY);
      grid.setObject(entrance.x, entrance.z, 0, packObject(OBJ.DOOR, DIR.N));
    }

    // Stairs up to the next storey.
    if (level < storeys - 1) {
      const placed = placeStairs(grid, rng, levelRooms, level);
      if (placed) {
        stairFoot = placed;
        stairwells.push({ x: placed.x, z: placed.z, level: level + 1 });
      }
    }
  }

  for (const hole of stairwells) grid.setFloor(hole.x, hole.z, hole.level, FLOOR.VOID);

  // Roof: a floor laid on the storey above the top one. Modelling it as an
  // ordinary floor rather than a special case means the chunk mesher, the
  // storey cutaway and eventually rooftop access all get it for free.
  if (storeys < grid.levels) {
    for (let iz = z; iz < z + d; iz++) {
      for (let ix = x; ix < x + w; ix++) grid.setFloor(ix, iz, storeys, FLOOR.ROOF);
    }
  }

  return { rooms, nextRoomId: roomId, entrance, stairFoot, storeys };
}

/** Solid walls all the way around a rectangle. */
function shellWalls(grid, x, z, w, d, level, material) {
  for (let ix = x; ix < x + w; ix++) {
    grid.setWall(ix, z, level, DIR.N, material);
    grid.setWall(ix, z + d - 1, level, DIR.S, material);
  }
  for (let iz = z; iz < z + d; iz++) {
    grid.setWall(x, iz, level, DIR.W, material);
    grid.setWall(x + w - 1, iz, level, DIR.E, material);
  }
}

/**
 * Recursively split a rectangle, walling and then door-ing each split.
 *
 * The doorway is punched immediately after the wall goes up, before recursing.
 * That is what makes connectivity structural: the rooms form a tree whose edges
 * are the doorways, so there is exactly one path between any two rooms and none
 * can be orphaned.
 */
function partition(grid, rng, rect, level, out, nextId) {
  const { x, z, w, d } = rect;

  const canSplitX = w >= MIN_ROOM * 2 + 1;
  const canSplitZ = d >= MIN_ROOM * 2 + 1;

  // Stop when too small, or randomly, so houses aren't uniformly subdivided.
  if ((!canSplitX && !canSplitZ) || (w * d < 30 && rng.chance(0.45))) {
    out.push({ id: nextId(), x, z, w, d, level, purpose: 'unset' });
    return;
  }

  // Split the longer axis, to avoid corridors-by-accident.
  const splitX = canSplitX && (!canSplitZ || w >= d);

  if (splitX) {
    const cut = x + MIN_ROOM + rng.int(0, w - MIN_ROOM * 2 - 1);
    for (let iz = z; iz < z + d; iz++) grid.setWall(cut, iz, level, DIR.W, WALL.PLASTER);
    const doorZ = z + rng.int(0, d - 1);
    grid.setWall(cut, doorZ, level, DIR.W, WALL.DOORWAY);

    partition(grid, rng, { x, z, w: cut - x, d }, level, out, nextId);
    partition(grid, rng, { x: cut, z, w: x + w - cut, d }, level, out, nextId);
  } else {
    const cut = z + MIN_ROOM + rng.int(0, d - MIN_ROOM * 2 - 1);
    for (let ix = x; ix < x + w; ix++) grid.setWall(ix, cut, level, DIR.N, WALL.PLASTER);
    const doorX = x + rng.int(0, w - 1);
    grid.setWall(doorX, cut, level, DIR.N, WALL.DOORWAY);

    partition(grid, rng, { x, z, w, d: cut - z }, level, out, nextId);
    partition(grid, rng, { x, z: cut, w, d: z + d - cut }, level, out, nextId);
  }
}

/** Windows along the exterior, spaced out and never on the entrance tile. */
function addWindows(grid, rng, { x, z, w, d }, level, material, entrance) {
  const maybe = (ix, iz, dir) => {
    if (entrance && ix === entrance.x && iz === entrance.z && dir === DIR.N) return;
    if (grid.wallAt(ix, iz, level, dir) !== material) return; // don't overwrite a door
    if (rng.chance(0.45)) grid.setWall(ix, iz, level, dir, WALL.WINDOW);
  };
  // Skip corners: a window in a corner tile reads as a hole in the roofline.
  for (let ix = x + 1; ix < x + w - 1; ix++) {
    maybe(ix, z, DIR.N);
    maybe(ix, z + d - 1, DIR.S);
  }
  for (let iz = z + 1; iz < z + d - 1; iz++) {
    maybe(x, iz, DIR.W);
    maybe(x + w - 1, iz, DIR.E);
  }
}

/**
 * Put a two-tile staircase in the largest room.
 *
 * The tile above the bottom step is later made void — that hole is what makes a
 * staircase read as connecting two storeys rather than as furniture. The tile
 * above the top step stays solid and becomes the landing.
 */
function placeStairs(grid, rng, levelRooms, level) {
  const room = levelRooms.reduce((a, b) => (a.w * a.d >= b.w * b.d ? a : b));
  if (room.w < 2 && room.d < 2) return null;

  // Run the stairs along the room's longer axis, one tile in from the wall.
  const alongX = room.w >= room.d;
  const dir = alongX ? DIR.E : DIR.S;
  const sx = alongX ? room.x : room.x + Math.floor(room.w / 2);
  const sz = alongX ? room.z + Math.floor(room.d / 2) : room.z;

  const dx = alongX ? 1 : 0;
  const dz = alongX ? 0 : 1;

  grid.setObject(sx, sz, level, packObject(OBJ.STAIRS_LOW, dir));
  grid.setObject(sx + dx, sz + dz, level, packObject(OBJ.STAIRS_HIGH, dir));

  // The ceiling above the lower step is opened by the caller, once every
  // storey has been laid — see `stairwells` in buildBuilding.
  return { x: sx, z: sz, dir };
}

export { MIN_ROOM, partition };
