/**
 * Room purpose → furniture.
 *
 * Furnishing is where a generated interior stops looking generated. Two rules
 * carry most of the effect:
 *
 *   1. **A room gets a purpose first, furniture second.** Scattering plausible
 *      objects uniformly produces rooms with a bath next to a stove. Assigning
 *      "this is a kitchen" and then placing kitchen things is what makes an
 *      interior legible — and it is also what M8's loot tables key off, since
 *      what is in a container depends entirely on the room it stands in.
 *   2. **Furniture goes against walls.** Real rooms are furnished around their
 *      perimeter; objects marooned mid-room are the tell of naive placement.
 */
import { DIR_VEC, OPPOSITE } from '../core/constants.js';
import { FLOOR, WALL } from '../world/TileGrid.js';
import { OBJ, OBJECT_SPEC, packObject } from '../world/Objects.js';

/**
 * What a room can be, and what goes in it. `weight` biases how often a purpose
 * is picked; `perimeter` items hug walls, `centre` items stand free.
 */
export const PURPOSES = {
  bedroom: {
    weight: 3,
    floor: FLOOR.CARPET,
    perimeter: [
      { obj: OBJ.BED, count: [1, 2] },
      { obj: OBJ.WARDROBE, count: [1, 1] },
      { obj: OBJ.SHELF, count: [0, 1] },
      { obj: OBJ.DESK, count: [0, 1] },
    ],
    centre: [],
  },
  living: {
    weight: 2,
    floor: FLOOR.CARPET,
    perimeter: [
      { obj: OBJ.SOFA, count: [1, 2] },
      { obj: OBJ.TV, count: [1, 1] },
      { obj: OBJ.SHELF, count: [0, 2] },
    ],
    centre: [{ obj: OBJ.TABLE, count: [0, 1] }],
  },
  kitchen: {
    weight: 2,
    floor: FLOOR.TILE,
    perimeter: [
      { obj: OBJ.COUNTER, count: [2, 4] },
      { obj: OBJ.FRIDGE, count: [1, 1] },
      { obj: OBJ.STOVE, count: [1, 1] },
    ],
    centre: [{ obj: OBJ.TABLE, count: [0, 1] }],
  },
  bathroom: {
    weight: 2,
    floor: FLOOR.TILE,
    perimeter: [
      { obj: OBJ.TOILET, count: [1, 1] },
      { obj: OBJ.SINK, count: [1, 1] },
      { obj: OBJ.BATH, count: [0, 1] },
    ],
    centre: [],
  },
  storage: {
    weight: 1,
    floor: FLOOR.CONCRETE,
    perimeter: [
      { obj: OBJ.SHELF, count: [1, 3] },
      { obj: OBJ.CRATE, count: [1, 3] },
    ],
    centre: [{ obj: OBJ.CRATE, count: [0, 2] }],
  },
};

const PURPOSE_NAMES = Object.keys(PURPOSES);

/**
 * Assign purposes across a building's rooms and furnish them.
 *
 * @param {import('../world/TileGrid.js').TileGrid} grid
 * @param {import('../core/Rng.js').Rng} rng
 * @param {import('./Building.js').Room[]} rooms
 */
export function furnishBuilding(grid, rng, rooms) {
  // One kitchen and one bathroom per building, on the ground floor where
  // possible — a house with three kitchens reads as broken, not as varied.
  const ground = rooms.filter((r) => r.level === 0);
  const upper = rooms.filter((r) => r.level > 0);

  const assigned = new Set();
  const claim = (pool, purpose) => {
    const free = pool.filter((r) => !assigned.has(r));
    if (!free.length) return;
    const room = rng.pick(free);
    room.purpose = purpose;
    assigned.add(room);
  };

  claim(ground, 'kitchen');
  claim(ground.length > 1 ? ground : rooms, 'living');
  claim(upper.length ? upper : ground, 'bathroom');

  for (const room of rooms) {
    if (assigned.has(room)) continue;
    room.purpose = weightedPurpose(rng, room.level === 0 ? ['living', 'storage'] : ['bedroom']);
  }

  for (const room of rooms) furnishRoom(grid, rng, room);
}

function weightedPurpose(rng, prefer) {
  // Prefer the caller's shortlist most of the time, but not always — a ground
  // floor bedroom or an upstairs study is exactly the kind of variation that
  // stops every house feeling like the same house.
  if (rng.chance(0.75)) return rng.pick(prefer);
  const total = PURPOSE_NAMES.reduce((s, n) => s + PURPOSES[n].weight, 0);
  let roll = rng.range(0, total);
  for (const name of PURPOSE_NAMES) {
    roll -= PURPOSES[name].weight;
    if (roll <= 0) return name;
  }
  return 'living';
}

/** @param {import('./Building.js').Room} room */
export function furnishRoom(grid, rng, room) {
  const spec = PURPOSES[room.purpose] ?? PURPOSES.living;

  // Re-floor the room to match its purpose.
  for (let z = room.z; z < room.z + room.d; z++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (grid.getFloor(x, z, room.level) !== FLOOR.VOID) {
        grid.setFloor(x, z, room.level, spec.floor);
      }
    }
  }

  const perimeter = rng.shuffle(perimeterSlots(grid, room));
  const interior = rng.shuffle(interiorSlots(grid, room));

  for (const entry of spec.perimeter) {
    const n = rng.int(entry.count[0], entry.count[1]);
    for (let i = 0; i < n; i++) {
      const slot = perimeter.pop();
      if (!slot) break;
      place(grid, room, slot.x, slot.z, entry.obj, slot.facing);
    }
  }
  for (const entry of spec.centre) {
    const n = rng.int(entry.count[0], entry.count[1]);
    for (let i = 0; i < n; i++) {
      const slot = interior.pop();
      if (!slot) break;
      place(grid, room, slot.x, slot.z, entry.obj, rng.int(0, 3));
      // A table without chairs reads as a shelf. Ring it with what fits.
      if (entry.obj === OBJ.TABLE) ringWithChairs(grid, room, slot.x, slot.z, rng);
    }
  }
}

/**
 * Tiles along the room's walls, with the facing that puts the object's back to
 * the wall. A tile in front of a doorway is excluded — furniture that blocks
 * the only way into a room is the single most game-breaking placement bug.
 */
function perimeterSlots(grid, room) {
  const slots = [];
  for (let z = room.z; z < room.z + room.d; z++) {
    for (let x = room.x; x < room.x + room.w; x++) {
      if (!isFree(grid, room, x, z)) continue;
      for (let dir = 0; dir < 4; dir++) {
        const wall = grid.wallAt(x, z, room.level, dir);
        if (wall === WALL.NONE || wall === WALL.DOORWAY) continue;
        slots.push({ x, z, facing: dir });
        break;
      }
    }
  }
  return slots;
}

function interiorSlots(grid, room) {
  const slots = [];
  for (let z = room.z + 1; z < room.z + room.d - 1; z++) {
    for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
      if (isFree(grid, room, x, z)) slots.push({ x, z });
    }
  }
  return slots;
}

/**
 * A tile is available if it is floored, empty, and not the landing strip in
 * front of a doorway.
 */
function isFree(grid, room, x, z) {
  const i = grid.index(x, z, room.level);
  if (i < 0) return false;
  if (grid.floor[i] === FLOOR.VOID) return false;
  if (grid.object[i] !== OBJ.NONE) return false;

  // Keep the tile clear if any of its own edges is a doorway, and also if the
  // tile it would open into is this one — otherwise a wardrobe can seal a room.
  for (let dir = 0; dir < 4; dir++) {
    if (grid.wallAt(x, z, room.level, dir) === WALL.DOORWAY) return false;
    const v = DIR_VEC[dir];
    if (grid.wallAt(x + v.dx, z + v.dz, room.level, OPPOSITE[dir]) === WALL.DOORWAY) return false;
  }
  return true;
}

function place(grid, room, x, z, obj, facing) {
  grid.setObject(x, z, room.level, packObject(obj, facing));
  const spec = OBJECT_SPEC[obj];
  if (spec?.solid) grid.setFlag(x, z, room.level, 1 /* FLAG.SOLID */, true);
}

function ringWithChairs(grid, room, x, z, rng) {
  for (let dir = 0; dir < 4; dir++) {
    if (!rng.chance(0.55)) continue;
    const v = DIR_VEC[dir];
    const cx = x + v.dx;
    const cz = z + v.dz;
    if (!isFree(grid, room, cx, cz)) continue;
    if (cx < room.x || cz < room.z || cx >= room.x + room.w || cz >= room.z + room.d) continue;
    // Chairs face the table, which is the direction we came from.
    place(grid, room, cx, cz, OBJ.CHAIR, OPPOSITE[dir]);
  }
}
