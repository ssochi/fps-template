/**
 * Units and conventions, in one place.
 *
 * Y is up. One tile is 1 m × 1 m. One storey is 2.6 m. All speeds are m/s and
 * all angles radians. Two previous projects in this repository shipped bugs
 * caused by two subsystems disagreeing about orientation, so the direction
 * table below is the only definition of what "north" means.
 */

/** Metres per tile edge. */
export const TILE = 1;

/** Metres per storey. */
export const STOREY = 2.6;

/** Tiles per chunk edge. A chunk is CHUNK × CHUNK tiles on a single storey. */
export const CHUNK = 16;

/**
 * Compass directions. North is −Z, matching three.js's −Z forward convention.
 * Index order is used directly as an array index, so it must not be reordered.
 */
export const DIR = { N: 0, E: 1, S: 2, W: 3 };

/** @type {ReadonlyArray<{ dx: number, dz: number, name: string }>} */
export const DIR_VEC = [
  { dx: 0, dz: -1, name: 'N' },
  { dx: 1, dz: 0, name: 'E' },
  { dx: 0, dz: 1, name: 'S' },
  { dx: -1, dz: 0, name: 'W' },
];

/** The direction facing back the way you came. */
export const OPPOSITE = [DIR.S, DIR.W, DIR.N, DIR.E];

/** Tile coordinate → world position of that tile's *centre*. */
export function tileToWorld(x, z, level = 0, out = { x: 0, y: 0, z: 0 }) {
  out.x = (x + 0.5) * TILE;
  out.y = level * STOREY;
  out.z = (z + 0.5) * TILE;
  return out;
}

/** World position → the tile containing it. */
export function worldToTile(wx, wz, out = { x: 0, z: 0 }) {
  out.x = Math.floor(wx / TILE);
  out.z = Math.floor(wz / TILE);
  return out;
}

/** World Y → storey index. */
export function worldToLevel(wy) {
  return Math.floor(wy / STOREY + 0.001);
}
