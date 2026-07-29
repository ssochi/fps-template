/**
 * M1 verification world — hand-authored, not generated.
 *
 * Procedural town generation is M2's job. This block exists so the tile grid,
 * the mesher and the camera can be judged against a layout whose correct
 * appearance is known in advance. It deliberately includes every case the
 * mesher has to get right:
 *
 *   - a road and pavement    → large flat runs, floor colour variety
 *   - a two-storey house     → storey stacking, upper floors over lower rooms
 *   - internal partitions    → walls that meet at corners (AO, no double-draw)
 *   - doorways and windows   → wall rectangles with openings cut out
 *   - a garden fence         → half-height walls
 *   - a chunk boundary       → the house straddles one, catching seam bugs
 */
import { DIR, STOREY } from '../core/constants.js';
import { FLAG, FLOOR, WALL } from '../world/TileGrid.js';
import { Noise, Rng } from '../core/Rng.js';

/**
 * @param {import('../world/World.js').World} world
 * @returns {{ spawn: { x: number, z: number, level: number } }}
 */
export function buildTestBlock(world) {
  const grid = world.grid;
  const rng = new Rng('m1-testblock');

  // --- ground -----------------------------------------------------------
  // Coherent noise, not per-tile coin flips. Independent randomness at tile
  // resolution reads as confetti; ground wants patches, which is what fbm gives.
  const soil = new Noise(rng.int(0, 1e9));
  for (let z = 0; z < grid.depth; z++) {
    for (let x = 0; x < grid.width; x++) {
      const n = soil.fbm2(x * 0.09, z * 0.09, { octaves: 3 });
      grid.setFloor(x, z, 0, n > 0.38 ? FLOOR.DIRT : FLOOR.GRASS);
    }
  }

  // --- road running east–west, with pavement either side ----------------
  const roadZ = 6;
  for (let x = 0; x < grid.width; x++) {
    for (let z = roadZ; z < roadZ + 4; z++) grid.setFloor(x, z, 0, FLOOR.ASPHALT);
    grid.setFloor(x, roadZ - 1, 0, FLOOR.PAVEMENT);
    grid.setFloor(x, roadZ + 4, 0, FLOOR.PAVEMENT);
  }

  // --- the house --------------------------------------------------------
  // Deliberately straddles the x=16 chunk boundary.
  const house = { x: 12, z: 14, w: 11, d: 8 };
  buildHouse(grid, house);

  // --- a fenced garden behind the house ---------------------------------
  const yard = { x: 12, z: 22, w: 11, d: 5 };
  fenceRect(grid, yard, 0, { gapAt: { x: yard.x + 5, side: DIR.N } });
  for (let z = yard.z; z < yard.z + yard.d; z++) {
    for (let x = yard.x; x < yard.x + yard.w; x++) grid.setFloor(x, z, 0, FLOOR.DIRT);
  }

  // --- a second, smaller building across the road -----------------------
  buildHouse(grid, { x: 26, z: 1, w: 8, d: 4, storeys: 1, wall: WALL.BRICK });

  world.flushDirty(Infinity);

  return { spawn: { x: house.x + 5, z: house.z + 4, level: 0 } };
}

/**
 * @param {import('../world/TileGrid.js').TileGrid} grid
 * @param {{x:number,z:number,w:number,d:number,storeys?:number,wall?:number}} rect
 */
function buildHouse(grid, rect) {
  const { x, z, w, d } = rect;
  const storeys = rect.storeys ?? 2;
  const exterior = rect.wall ?? WALL.WOOD;

  for (let level = 0; level < storeys; level++) {
    // Floor for every tile of the footprint. The upper storey's floor is also
    // the lower storey's ceiling — one surface, stored once.
    for (let iz = z; iz < z + d; iz++) {
      for (let ix = x; ix < x + w; ix++) {
        grid.setFloor(ix, iz, level, level === 0 ? FLOOR.WOOD : FLOOR.CARPET);
        grid.setFlag(ix, iz, level, FLAG.INDOOR, true);
        grid.setRoom(ix, iz, level, 1 + level);
      }
    }

    // Exterior walls around the footprint.
    rectWalls(grid, x, z, w, d, level, exterior);

    if (level === 0) {
      // Front door on the north face, facing the road.
      grid.setWall(x + 3, z, level, DIR.N, WALL.DOORWAY);
      // Windows either side of it.
      grid.setWall(x + 1, z, level, DIR.N, WALL.WINDOW);
      grid.setWall(x + 6, z, level, DIR.N, WALL.WINDOW);
      grid.setWall(x + 8, z, level, DIR.N, WALL.WINDOW);
      // Back door into the garden.
      grid.setWall(x + 5, z + d - 1, level, DIR.S, WALL.DOORWAY);

      // Internal partition splitting the ground floor into two rooms, with a
      // doorway through it. Two walls meeting at a corner is the case that
      // exposes double-drawn geometry and missing corner AO.
      for (let iz = z; iz < z + d; iz++) {
        grid.setWall(x + 6, iz, level, DIR.W, WALL.PLASTER);
      }
      grid.setWall(x + 6, z + 5, level, DIR.W, WALL.DOORWAY);
      for (let ix = x; ix < x + 6; ix++) {
        grid.setWall(ix, z + 4, level, DIR.N, WALL.PLASTER);
      }
      grid.setWall(x + 2, z + 4, level, DIR.N, WALL.DOORWAY);
    } else {
      // Upstairs: windows all round, one partition.
      grid.setWall(x + 2, z, level, DIR.N, WALL.WINDOW);
      grid.setWall(x + 7, z, level, DIR.N, WALL.WINDOW);
      grid.setWall(x + 4, z + d - 1, level, DIR.S, WALL.WINDOW);
      grid.setWall(x, z + 2, level, DIR.W, WALL.WINDOW);
      grid.setWall(x + w - 1, z + 5, level, DIR.E, WALL.WINDOW);
      for (let iz = z; iz < z + d; iz++) {
        grid.setWall(x + 5, iz, level, DIR.W, WALL.PLASTER);
      }
      grid.setWall(x + 5, z + 6, level, DIR.W, WALL.DOORWAY);
    }
  }
}

/** Walls around the outside of a rectangle, on one storey. */
function rectWalls(grid, x, z, w, d, level, material) {
  for (let ix = x; ix < x + w; ix++) {
    grid.setWall(ix, z, level, DIR.N, material);
    grid.setWall(ix, z + d - 1, level, DIR.S, material);
  }
  for (let iz = z; iz < z + d; iz++) {
    grid.setWall(x, iz, level, DIR.W, material);
    grid.setWall(x + w - 1, iz, level, DIR.E, material);
  }
}

/** A fence around a rectangle, optionally with one tile left open as a gate. */
function fenceRect(grid, { x, z, w, d }, level, { gapAt } = {}) {
  const skip = (ix, iz, side) => gapAt && gapAt.x === ix && gapAt.side === side && iz === z;
  for (let ix = x; ix < x + w; ix++) {
    if (!skip(ix, z, DIR.N)) grid.setWall(ix, z, level, DIR.N, WALL.FENCE);
    grid.setWall(ix, z + d - 1, level, DIR.S, WALL.FENCE);
  }
  for (let iz = z; iz < z + d; iz++) {
    grid.setWall(x, iz, level, DIR.W, WALL.FENCE);
    grid.setWall(x + w - 1, iz, level, DIR.E, WALL.FENCE);
  }
}

export { STOREY };
