/**
 * Grid-collided movement.
 *
 * The real player controller is M3's job; this is the movement *primitive* both
 * it and the horde will use, and it lives here because it is really a query
 * against the tile grid rather than a character behaviour.
 *
 * Movement is resolved one axis at a time. That is what produces the sliding
 * along walls players expect, and it means a diagonal into a corner stops
 * cleanly instead of squeezing through the gap between two wall planes — the
 * classic failure mode of testing the destination point alone.
 */
import { worldToTile } from '../core/constants.js';

const _from = { x: 0, z: 0 };

/**
 * Move an entity by a world-space delta, blocked by walls and unwalkable tiles.
 *
 * @param {import('../world/TileGrid.js').TileGrid} grid
 * @param {import('./Entity.js').Entity} entity
 * @param {number} dx
 * @param {number} dz
 * @param {boolean} [respectDoors] when true a shut door blocks, and the door's
 *   tile is reported so the caller can decide to open it. Pathfinding passes
 *   false: a shut door is still a route.
 * @returns {{ hitX: boolean, hitZ: boolean, blockedDoor: {x:number,z:number}|null }}
 */
export function moveOnGrid(grid, entity, dx, dz, respectDoors = false) {
  const pos = entity.position;
  const level = entity.level;
  const r = entity.radius;
  let hitX = false;
  let hitZ = false;
  let blockedDoor = null;

  const passable = (x1, z1, x2, z2) =>
    respectDoors ? grid.canPass(x1, z1, x2, z2, level) : grid.canWalk(x1, z1, x2, z2, level);

  if (dx !== 0) {
    worldToTile(pos.x, pos.z, _from);
    // Probe from the leading edge of the entity, not its centre, so it stops a
    // radius short of the wall instead of half-inside it.
    const probe = pos.x + dx + Math.sign(dx) * r;
    const targetX = Math.floor(probe);
    if (targetX === _from.x || passable(_from.x, _from.z, targetX, _from.z)) {
      pos.x += dx;
    } else {
      // Park exactly against the wall rather than leaving a variable gap.
      pos.x = dx > 0 ? targetX - r - 1e-4 : targetX + 1 + r + 1e-4;
      hitX = true;
      if (respectDoors && !blockedDoor) {
        blockedDoor = grid.doorTile(_from.x, _from.z, targetX, _from.z, level);
      }
    }
  }

  if (dz !== 0) {
    worldToTile(pos.x, pos.z, _from);
    const probe = pos.z + dz + Math.sign(dz) * r;
    const targetZ = Math.floor(probe);
    if (targetZ === _from.z || passable(_from.x, _from.z, _from.x, targetZ)) {
      pos.z += dz;
    } else {
      pos.z = dz > 0 ? targetZ - r - 1e-4 : targetZ + 1 + r + 1e-4;
      hitZ = true;
      if (respectDoors && !blockedDoor) {
        blockedDoor = grid.doorTile(_from.x, _from.z, _from.x, targetZ, level);
      }
    }
  }

  return { hitX, hitZ, blockedDoor };
}
