/**
 * Town generation: streets, blocks, lots, buildings.
 *
 * Laid out top-down rather than grown organically. A grid of streets carving
 * blocks, blocks carved into lots, one building per lot — because the point of
 * this town is not to be surprising, it is to be *navigable*. The reference
 * game's world is memorable because you learn its street layout; a maze
 * generated from noise never becomes learnable.
 *
 * Everything derives from one seed, so a save file stores that seed plus what
 * changed rather than a quarter-million tiles.
 */
import { DIR } from '../core/constants.js';
import { FLAG, FLOOR, WALL } from '../world/TileGrid.js';
import { OBJ, packObject } from '../world/Objects.js';
import { Noise, Rng } from '../core/Rng.js';
import { buildBuilding } from './Building.js';
import { furnishBuilding } from './Furnish.js';

/** Road width in tiles, including the pavement either side. */
const ROAD_WIDTH = 4;
const PAVEMENT = 1;
/** Distance between road centrelines. */
const BLOCK_SPAN = 26;
/** Gap between a building and its lot boundary. */
const SETBACK = 1;

/**
 * @param {import('../world/World.js').World} world
 * @param {string|number} seed
 * @returns {{ rooms: import('./Building.js').Room[], buildings: object[], spawn: {x:number,z:number,level:number} }}
 */
export function generateTown(world, seed = 'knox') {
  const grid = world.grid;
  const rng = new Rng(seed);

  layGround(grid, rng);
  const roads = layRoads(grid);
  const lots = carveLots(grid, roads);

  const rngB = rng.fork('buildings');
  let nextRoomId = 1;
  const rooms = [];
  const buildings = [];

  for (const lot of lots) {
    // Not every lot is built on. Empty lots give the street a rhythm and give
    // the player somewhere to run that isn't a dead end.
    if (rngB.chance(0.16)) {
      scatterYard(grid, rngB, lot, true);
      continue;
    }

    const built = placeBuilding(grid, rngB, lot, nextRoomId);
    if (!built) {
      scatterYard(grid, rngB, lot, true);
      continue;
    }
    nextRoomId = built.nextRoomId;
    rooms.push(...built.rooms);
    buildings.push(built);
    furnishBuilding(grid, rngB.fork(`furnish-${built.rect.x}-${built.rect.z}`), built.rooms);
    scatterYard(grid, rngB, lot, false, built.rect);
  }

  decorateStreets(grid, rng.fork('street'), roads);

  // The cutaway needs to know which rooms belong together, so that stepping
  // into one room opens the whole building rather than just that room.
  world.cutaway?.registerBuildings(buildings);

  world.flushDirty(Infinity);

  const spawn = pickSpawn(grid, buildings);
  return { rooms, buildings, spawn, roads };
}

/** Grass and dirt from coherent noise, so ground cover comes in patches. */
function layGround(grid, rng) {
  const soil = new Noise(rng.int(0, 1e9));
  for (let z = 0; z < grid.depth; z++) {
    for (let x = 0; x < grid.width; x++) {
      const n = soil.fbm2(x * 0.07, z * 0.07, { octaves: 3 });
      grid.setFloor(x, z, 0, n > 0.34 ? FLOOR.DIRT : FLOOR.GRASS);
    }
  }
}

/**
 * Roads on a regular grid. Returns the centreline positions so lot carving and
 * street furniture can both refer to the same layout rather than recomputing it.
 */
function layRoads(grid) {
  const vertical = [];
  const horizontal = [];

  for (let x = BLOCK_SPAN / 2; x < grid.width; x += BLOCK_SPAN) vertical.push(Math.floor(x));
  for (let z = BLOCK_SPAN / 2; z < grid.depth; z += BLOCK_SPAN) horizontal.push(Math.floor(z));

  const half = Math.floor(ROAD_WIDTH / 2);
  for (const cx of vertical) {
    for (let z = 0; z < grid.depth; z++) {
      for (let d = -half; d < ROAD_WIDTH - half; d++) paveRoad(grid, cx + d, z);
      paveWalk(grid, cx - half - PAVEMENT, z);
      paveWalk(grid, cx + ROAD_WIDTH - half, z);
    }
  }
  for (const cz of horizontal) {
    for (let x = 0; x < grid.width; x++) {
      for (let d = -half; d < ROAD_WIDTH - half; d++) paveRoad(grid, x, cz + d);
      paveWalk(grid, x, cz - half - PAVEMENT);
      paveWalk(grid, x, cz + ROAD_WIDTH - half);
    }
  }

  return { vertical, horizontal, half };
}

function paveRoad(grid, x, z) {
  if (grid.inBounds(x, z, 0)) grid.setFloor(x, z, 0, FLOOR.ASPHALT);
}
function paveWalk(grid, x, z) {
  if (grid.inBounds(x, z, 0) && grid.getFloor(x, z, 0) !== FLOOR.ASPHALT) {
    grid.setFloor(x, z, 0, FLOOR.PAVEMENT);
  }
}

/**
 * The land between roads, split into lots that each front onto a street.
 *
 * Lots are cut along the block's longer axis so every one keeps a street
 * frontage — a lot buried in the middle of a block would generate a building
 * with no way to reach its front door.
 */
function carveLots(grid, roads) {
  const half = roads.half;
  const xEdges = [0, ...roads.vertical.flatMap((c) => [c - half - PAVEMENT, c + ROAD_WIDTH - half + PAVEMENT]), grid.width];
  const zEdges = [0, ...roads.horizontal.flatMap((c) => [c - half - PAVEMENT, c + ROAD_WIDTH - half + PAVEMENT]), grid.depth];

  const lots = [];
  for (let zi = 0; zi < zEdges.length - 1; zi += 2) {
    for (let xi = 0; xi < xEdges.length - 1; xi += 2) {
      const x0 = Math.max(0, xEdges[xi]);
      const z0 = Math.max(0, zEdges[zi]);
      const x1 = Math.min(grid.width, xEdges[xi + 1]);
      const z1 = Math.min(grid.depth, zEdges[zi + 1]);
      const w = x1 - x0;
      const d = z1 - z0;
      if (w < 8 || d < 8) continue;

      // Split the block into two rows of lots facing opposite streets.
      const alongX = w >= d;
      const count = Math.max(1, Math.floor((alongX ? w : d) / 12));
      for (let i = 0; i < count; i++) {
        const a0 = Math.round((alongX ? w : d) * (i / count));
        const a1 = Math.round((alongX ? w : d) * ((i + 1) / count));
        lots.push(
          alongX
            ? { x: x0 + a0, z: z0, w: a1 - a0, d, facing: DIR.N }
            : { x: x0, z: z0 + a0, w, d: a1 - a0, facing: DIR.W },
        );
      }
    }
  }
  return lots;
}

/** Fit a building inside a lot, set back from its edges. */
function placeBuilding(grid, rng, lot, nextRoomId) {
  const maxW = lot.w - SETBACK * 2;
  const maxD = lot.d - SETBACK * 2 - 2; // leave a yard behind
  if (maxW < 6 || maxD < 6) return null;

  const w = Math.min(maxW, rng.int(6, 12));
  const d = Math.min(maxD, rng.int(6, 10));
  const x = lot.x + SETBACK + rng.int(0, maxW - w);
  const z = lot.z + SETBACK;

  const storeys = rng.chance(0.42) ? 2 : 1;
  const wall = rng.pick([WALL.WOOD, WALL.WOOD, WALL.BRICK, WALL.PLASTER]);

  const result = buildBuilding(grid, rng, { x, z, w, d, storeys, wall, nextRoomId });
  return { ...result, rect: { x, z, w, d, storeys } };
}

/** Trees, bushes and bins on the unbuilt part of a lot. */
function scatterYard(grid, rng, lot, empty, buildingRect) {
  const inBuilding = (x, z) =>
    buildingRect &&
    x >= buildingRect.x - 1 &&
    x < buildingRect.x + buildingRect.w + 1 &&
    z >= buildingRect.z - 1 &&
    z < buildingRect.z + buildingRect.d + 1;

  const density = empty ? 0.1 : 0.055;
  for (let z = lot.z; z < lot.z + lot.d; z++) {
    for (let x = lot.x; x < lot.x + lot.w; x++) {
      if (inBuilding(x, z)) continue;
      const floor = grid.getFloor(x, z, 0);
      if (floor !== FLOOR.GRASS && floor !== FLOOR.DIRT) continue;
      if (grid.getFlags(x, z, 0) & FLAG.INDOOR) continue;
      if (!rng.chance(density)) continue;

      const obj = rng.chance(0.45) ? OBJ.TREE : rng.chance(0.7) ? OBJ.BUSH : OBJ.BIN;
      grid.setObject(x, z, 0, packObject(obj, rng.int(0, 3)));
      if (obj === OBJ.TREE) {
        grid.setFlag(x, z, 0, FLAG.SOLID | FLAG.OPAQUE, true);
      }
    }
  }
}

/** Lampposts on the pavement and the odd abandoned car in the road. */
function decorateStreets(grid, rng, roads) {
  const half = roads.half;

  for (const cx of roads.vertical) {
    for (let z = 4; z < grid.depth; z += 9) {
      const x = cx - half - PAVEMENT;
      if (grid.getFloor(x, z, 0) === FLOOR.PAVEMENT && grid.getFloor(x, z, 0) !== FLOOR.VOID) {
        grid.setObject(x, z, 0, packObject(OBJ.LAMPPOST, DIR.N));
        grid.setFlag(x, z, 0, FLAG.SOLID, true);
      }
    }
    for (let z = 0; z < grid.depth; z++) {
      if (!rng.chance(0.035)) continue;
      const x = cx + rng.int(-half, ROAD_WIDTH - half - 1);
      if (grid.getFloor(x, z, 0) !== FLOOR.ASPHALT) continue;
      grid.setObject(x, z, 0, packObject(OBJ.CAR, rng.chance(0.5) ? DIR.N : DIR.S));
      grid.setFlag(x, z, 0, FLAG.SOLID | FLAG.OPAQUE, true);
    }
  }
  for (const cz of roads.horizontal) {
    for (let x = 7; x < grid.width; x += 9) {
      const z = cz - half - PAVEMENT;
      if (grid.getFloor(x, z, 0) === FLOOR.PAVEMENT) {
        grid.setObject(x, z, 0, packObject(OBJ.LAMPPOST, DIR.N));
        grid.setFlag(x, z, 0, FLAG.SOLID, true);
      }
    }
  }
}

/**
 * Spawn on the street outside a building near the middle of the map.
 *
 * Iterating buildings in generation order puts the player in whichever corner
 * happened to be built first, with half the view off the edge of the world.
 * Sorting by distance to centre costs nothing and always opens on a street.
 */
function pickSpawn(grid, buildings) {
  const midX = grid.width / 2;
  const midZ = grid.depth / 2;
  const byCentre = [...buildings].sort(
    (a, b) =>
      Math.hypot(a.entrance.x - midX, a.entrance.z - midZ) -
      Math.hypot(b.entrance.x - midX, b.entrance.z - midZ),
  );

  for (const b of byCentre) {
    const { x, z } = b.entrance;
    for (let step = 1; step < 6; step++) {
      const sz = z - step;
      if (grid.isWalkable(x, sz, 0) && !(grid.getFlags(x, sz, 0) & FLAG.INDOOR)) {
        return { x, z: sz, level: 0 };
      }
    }
  }
  return { x: Math.floor(midX), z: Math.floor(midZ), level: 0 };
}

export { BLOCK_SPAN, ROAD_WIDTH, carveLots, layRoads };
