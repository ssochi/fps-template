/**
 * Line of sight over the tile grid.
 *
 * ## Why ray casting rather than recursive shadowcasting
 *
 * Recursive shadowcasting is the standard fast answer, and it is faster — but it
 * assumes opacity lives *in cells*. In this grid opacity lives on *edges*: a
 * wall is a property of the boundary between two tiles, not of either tile. Every
 * shadowcasting variant would need reworking to slope-test against edges, and
 * the failure mode of getting that subtly wrong is sight leaking diagonally
 * through wall corners — which reads as a bug in the horde's stealth rather than
 * in the renderer.
 *
 * So: cast a line to every tile in radius, walking edge by edge through
 * `blocksSight`, which is already the tested authority on what blocks vision.
 * At radius 18 that is ~1000 targets of up to 18 steps — around 18k edge tests.
 * Far too much per frame, and completely free at the rate it is actually needed:
 * visibility only changes when the player changes *tile*, a few times a second.
 */
import { DIR_VEC } from '../core/constants.js';

/** Visibility states, in increasing order of knowledge. */
export const VIS = {
  /** Never seen. Drawn as near-black. */
  UNSEEN: 0,
  /** Seen before, not now. Drawn dim and desaturated — you remember the walls. */
  REMEMBERED: 1,
  /** In view right now. */
  VISIBLE: 2,
};

/**
 * Walk the grid line from one tile to another, testing every edge crossed.
 *
 * A voxel-traversal DDA (Amanatides & Woo, in 2D): march the ray from tile
 * centre to tile centre, always stepping whichever axis has the nearer gridline.
 * Because it only ever takes one orthogonal step at a time, every edge between
 * origin and target is tested — a Bresenham line takes diagonal steps that skip
 * the corner edges, which is precisely how sight leaks through the join between
 * two perpendicular walls.
 *
 * @returns {boolean} whether the target is visible from the origin
 */
export function hasLineOfSight(grid, ox, oz, tx, tz, level) {
  if (ox === tx && oz === tz) return true;

  const stepX = Math.sign(tx - ox);
  const stepZ = Math.sign(tz - oz);
  const adx = Math.abs(tx - ox);
  const adz = Math.abs(tz - oz);

  // Parametric distance to the next gridline on each axis, in units of the full
  // run. Starting at a tile centre, the first boundary is half a tile away.
  let tMaxX = adx === 0 ? Infinity : 0.5 / adx;
  let tMaxZ = adz === 0 ? Infinity : 0.5 / adz;
  const tDeltaX = adx === 0 ? Infinity : 1 / adx;
  const tDeltaZ = adz === 0 ? Infinity : 1 / adz;

  let x = ox;
  let z = oz;

  while (x !== tx || z !== tz) {
    // Never overshoot an axis that has already arrived.
    const stepTheX = x !== tx && (z === tz || tMaxX < tMaxZ);
    if (stepTheX) {
      if (grid.blocksSight(x, z, x + stepX, z, level)) return false;
      x += stepX;
      tMaxX += tDeltaX;
    } else {
      if (grid.blocksSight(x, z, x, z + stepZ, level)) return false;
      z += stepZ;
      tMaxZ += tDeltaZ;
    }
  }
  return true;
}

/**
 * Recompute which tiles the observer can see.
 *
 * @param {import('../world/TileGrid.js').TileGrid} grid
 * @param {number} ox @param {number} oz @param {number} level
 * @param {number} radius in tiles
 * @param {(x: number, z: number) => void} mark called for each visible tile
 * @returns {number} how many tiles were marked
 */
export function computeVisible(grid, ox, oz, level, radius, mark) {
  const r2 = radius * radius;
  let count = 0;

  const x0 = Math.max(0, ox - radius);
  const x1 = Math.min(grid.width - 1, ox + radius);
  const z0 = Math.max(0, oz - radius);
  const z1 = Math.min(grid.depth - 1, oz + radius);

  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const ddx = x - ox;
      const ddz = z - oz;
      if (ddx * ddx + ddz * ddz > r2) continue;
      if (!hasLineOfSight(grid, ox, oz, x, z, level)) continue;
      mark(x, z);
      count++;
    }
  }
  return count;
}

/**
 * Tiles adjacent to a visible tile through a *wall* are marked too.
 *
 * Without this the far face of a wall you are standing against is never
 * "visible", so a room you are inside is outlined by a one-tile band of
 * blackness where its own walls are. Seeing the surface of a wall you can touch
 * is not the same as seeing through it.
 *
 * Takes the visible tiles as a flat `[x, z, x, z, …]` list rather than scanning
 * the grid. Scanning was measurably the dominant cost of a visibility update —
 * a hundred-thousand-cell sweep to service a two-thousand-cell result.
 *
 * @param {number[]} visible flat x,z pairs known to be visible
 * @param {(x: number, z: number) => boolean} isVisible
 */
export function markWallSkirt(grid, level, visible, isVisible, mark) {
  const pending = [];
  for (let i = 0; i < visible.length; i += 2) {
    const x = visible[i];
    const z = visible[i + 1];
    for (const v of DIR_VEC) {
      const nx = x + v.dx;
      const nz = z + v.dz;
      if (!grid.inBounds(nx, nz, level)) continue;
      if (isVisible(nx, nz)) continue;
      if (grid.blocksSight(x, z, nx, nz, level)) pending.push(nx, nz);
    }
  }
  for (let i = 0; i < pending.length; i += 2) mark(pending[i], pending[i + 1]);
  return pending.length / 2;
}
