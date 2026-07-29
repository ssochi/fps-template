/**
 * Worldgen correctness.
 *
 * The failure that actually ruins a generated town is not ugliness — it is a
 * room you cannot enter, or a house you cannot get into. Those are invisible in
 * a screenshot and only surface when a player walks up to a door that leads
 * nowhere, so they are asserted by flood fill over many seeds rather than
 * checked by eye on one.
 */
import { describe, expect, it } from 'vitest';
import { TileGrid, FLOOR, FLAG, WALL } from '../src/world/TileGrid.js';
import { Rng } from '../src/core/Rng.js';
import { buildBuilding } from '../src/worldgen/Building.js';
import { furnishBuilding } from '../src/worldgen/Furnish.js';
import { generateTown } from '../src/worldgen/Town.js';
import { OBJ, objectId } from '../src/world/Objects.js';
import { DIR_VEC } from '../src/core/constants.js';

/** A World stand-in: worldgen only ever touches `grid` and `flushDirty`. */
function fakeWorld(w, d, l) {
  const grid = new TileGrid(w, d, l);
  return { grid, flushDirty: () => grid.takeDirty().length };
}

/**
 * Flood fill from a tile, walking through anything `canWalk` allows.
 * @returns {Set<number>} visited indices
 */
function flood(grid, startX, startZ, level) {
  const seen = new Set();
  const queue = [[startX, startZ]];
  seen.add(grid.idx(startX, startZ, level));
  while (queue.length) {
    const [x, z] = queue.pop();
    for (const v of DIR_VEC) {
      const nx = x + v.dx;
      const nz = z + v.dz;
      if (!grid.inBounds(nx, nz, level)) continue;
      const i = grid.idx(nx, nz, level);
      if (seen.has(i)) continue;
      if (!grid.canWalk(x, z, nx, nz, level)) continue;
      seen.add(i);
      queue.push([nx, nz]);
    }
  }
  return seen;
}

describe('building partitioning', () => {
  it('reaches every room from the front door, across many seeds', () => {
    for (let s = 0; s < 40; s++) {
      const grid = new TileGrid(24, 24, 1);
      const rng = new Rng(`house-${s}`);
      const w = rng.int(7, 14);
      const d = rng.int(7, 14);
      const { rooms, entrance } = buildBuilding(grid, rng, {
        x: 2, z: 2, w, d, storeys: 1, wall: WALL.WOOD, nextRoomId: 1,
      });

      const reached = flood(grid, entrance.x, entrance.z, 0);
      const unreachable = rooms.filter((r) => {
        for (let z = r.z; z < r.z + r.d; z++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            if (reached.has(grid.idx(x, z, 0))) return false;
          }
        }
        return true;
      });
      expect(unreachable, `seed house-${s} sealed ${unreachable.length} room(s)`).toHaveLength(0);
    }
  });

  it('rooms tile the footprint exactly, with no gaps or overlaps', () => {
    for (let s = 0; s < 20; s++) {
      const grid = new TileGrid(24, 24, 1);
      const rng = new Rng(`tile-${s}`);
      const w = rng.int(7, 14);
      const d = rng.int(7, 14);
      const { rooms } = buildBuilding(grid, rng, {
        x: 3, z: 3, w, d, storeys: 1, wall: WALL.WOOD, nextRoomId: 1,
      });

      const covered = new Map();
      for (const r of rooms) {
        for (let z = r.z; z < r.z + r.d; z++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            const k = `${x},${z}`;
            covered.set(k, (covered.get(k) ?? 0) + 1);
          }
        }
      }
      expect(covered.size).toBe(w * d);
      for (const [k, n] of covered) expect(n, `tile ${k} covered ${n}x`).toBe(1);
    }
  });

  it('gives every room a unique id', () => {
    const grid = new TileGrid(24, 24, 1);
    const { rooms } = buildBuilding(grid, new Rng('ids'), {
      x: 2, z: 2, w: 12, d: 12, storeys: 2, wall: WALL.WOOD, nextRoomId: 1,
    });
    expect(new Set(rooms.map((r) => r.id)).size).toBe(rooms.length);
  });

  it('puts stairs in and opens the floor above them', () => {
    const grid = new TileGrid(24, 24, 2);
    const { stairFoot } = buildBuilding(grid, new Rng('stairs'), {
      x: 2, z: 2, w: 12, d: 10, storeys: 2, wall: WALL.WOOD, nextRoomId: 1,
    });
    expect(stairFoot).not.toBe(null);
    const packed = grid.object[grid.idx(stairFoot.x, stairFoot.z, 0)];
    expect(objectId(packed)).toBe(OBJ.STAIRS_LOW);
    // The tile above the bottom step must be open, or the flight is boxed in.
    expect(grid.getFloor(stairFoot.x, stairFoot.z, 1)).toBe(FLOOR.VOID);
  });

  it('is deterministic for a given seed', () => {
    const build = () => {
      const grid = new TileGrid(24, 24, 2);
      buildBuilding(grid, new Rng('same-seed'), {
        x: 2, z: 2, w: 11, d: 9, storeys: 2, wall: WALL.WOOD, nextRoomId: 1,
      });
      return grid;
    };
    const a = build();
    const b = build();
    expect(Array.from(a.wallN)).toEqual(Array.from(b.wallN));
    expect(Array.from(a.object)).toEqual(Array.from(b.object));
  });
});

describe('furnishing', () => {
  it('never blocks a doorway', () => {
    for (let s = 0; s < 25; s++) {
      const grid = new TileGrid(24, 24, 1);
      const rng = new Rng(`furn-${s}`);
      const { rooms, entrance } = buildBuilding(grid, rng, {
        x: 2, z: 2, w: rng.int(8, 14), d: rng.int(8, 14), storeys: 1, wall: WALL.WOOD, nextRoomId: 1,
      });
      furnishBuilding(grid, rng.fork('f'), rooms);

      // Every doorway tile, and the tile it opens into, must be clear of
      // furniture. A door object in its own doorway is the one exception —
      // that is what a door is.
      const clearOfFurniture = (x, z, where) => {
        const id = objectId(grid.object[grid.idx(x, z, 0)]);
        expect([OBJ.NONE, OBJ.DOOR], `${where} at ${x},${z} blocked`).toContain(id);
      };
      for (let z = 0; z < 24; z++) {
        for (let x = 0; x < 24; x++) {
          for (let dir = 0; dir < 4; dir++) {
            if (grid.wallAt(x, z, 0, dir) !== WALL.DOORWAY) continue;
            clearOfFurniture(x, z, 'doorway');
            const v = DIR_VEC[dir];
            if (grid.inBounds(x + v.dx, z + v.dz, 0)) {
              clearOfFurniture(x + v.dx, z + v.dz, 'doorway approach');
            }
          }
        }
      }

      // And every room must still be reachable once furnished.
      const reached = flood(grid, entrance.x, entrance.z, 0);
      for (const r of rooms) {
        let any = false;
        for (let z = r.z; z < r.z + r.d && !any; z++) {
          for (let x = r.x; x < r.x + r.w && !any; x++) {
            if (reached.has(grid.idx(x, z, 0))) any = true;
          }
        }
        expect(any, `seed furn-${s}: room ${r.id} (${r.purpose}) unreachable after furnishing`).toBe(true);
      }
    }
  });

  it('gives every room a purpose', () => {
    const grid = new TileGrid(24, 24, 2);
    const rng = new Rng('purpose');
    const { rooms } = buildBuilding(grid, rng, {
      x: 2, z: 2, w: 12, d: 10, storeys: 2, wall: WALL.WOOD, nextRoomId: 1,
    });
    furnishBuilding(grid, rng.fork('f'), rooms);
    for (const r of rooms) expect(r.purpose).not.toBe('unset');
  });
});

describe('town', () => {
  it('generates a walkable street network reaching every building entrance', () => {
    const world = fakeWorld(104, 104, 3);
    const { buildings, spawn } = generateTown(world, 'test-town');
    expect(buildings.length).toBeGreaterThan(6);

    const reached = flood(world.grid, spawn.x, spawn.z, 0);
    const stranded = buildings.filter((b) => !reached.has(world.grid.idx(b.entrance.x, b.entrance.z, 0)));
    expect(stranded.map((b) => b.entrance), 'entrances unreachable from spawn').toEqual([]);
  });

  it('spawns the player outdoors', () => {
    const world = fakeWorld(104, 104, 3);
    const { spawn } = generateTown(world, 'spawn-town');
    expect(world.grid.isWalkable(spawn.x, spawn.z, 0)).toBe(true);
    expect(world.grid.hasFlag(spawn.x, spawn.z, 0, FLAG.INDOOR)).toBe(false);
  });

  it('is deterministic for a given seed', () => {
    const a = fakeWorld(72, 72, 3);
    const b = fakeWorld(72, 72, 3);
    generateTown(a, 'repeat');
    generateTown(b, 'repeat');
    expect(Array.from(a.grid.floor)).toEqual(Array.from(b.grid.floor));
    expect(Array.from(a.grid.object)).toEqual(Array.from(b.grid.object));
  });

  it('produces different towns for different seeds', () => {
    const a = fakeWorld(72, 72, 3);
    const b = fakeWorld(72, 72, 3);
    generateTown(a, 'alpha');
    generateTown(b, 'beta');
    expect(Array.from(a.grid.object)).not.toEqual(Array.from(b.grid.object));
  });

  it('never puts a building on the road', () => {
    const world = fakeWorld(104, 104, 3);
    const { buildings } = generateTown(world, 'roads');
    for (const b of buildings) {
      for (let z = b.rect.z; z < b.rect.z + b.rect.d; z++) {
        for (let x = b.rect.x; x < b.rect.x + b.rect.w; x++) {
          expect(world.grid.getFloor(x, z, 0), `building tile ${x},${z} on asphalt`).not.toBe(FLOOR.ASPHALT);
        }
      }
    }
  });
});
