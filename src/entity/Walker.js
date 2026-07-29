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
import { Vector3 } from 'three';
import { worldToTile } from '../core/constants.js';

const _from = { x: 0, z: 0 };

/**
 * Move an entity by a world-space delta, blocked by walls and unwalkable tiles.
 *
 * @param {import('../world/TileGrid.js').TileGrid} grid
 * @param {import('./Entity.js').Entity} entity
 * @param {number} dx
 * @param {number} dz
 * @returns {{ hitX: boolean, hitZ: boolean }} which axes were blocked, so
 *   callers can play a bump, stop a sprint, or make noise
 */
export function moveOnGrid(grid, entity, dx, dz) {
  const pos = entity.position;
  const level = entity.level;
  const r = entity.radius;
  let hitX = false;
  let hitZ = false;

  if (dx !== 0) {
    worldToTile(pos.x, pos.z, _from);
    // Probe from the leading edge of the entity, not its centre, so it stops a
    // radius short of the wall instead of half-inside it.
    const probe = pos.x + dx + Math.sign(dx) * r;
    const targetX = Math.floor(probe);
    if (targetX === _from.x || grid.canWalk(_from.x, _from.z, targetX, _from.z, level)) {
      pos.x += dx;
    } else {
      // Park exactly against the wall rather than leaving a variable gap.
      pos.x = dx > 0 ? targetX - r - 1e-4 : targetX + 1 + r + 1e-4;
      hitX = true;
    }
  }

  if (dz !== 0) {
    worldToTile(pos.x, pos.z, _from);
    const probe = pos.z + dz + Math.sign(dz) * r;
    const targetZ = Math.floor(probe);
    if (targetZ === _from.z || grid.canWalk(_from.x, _from.z, _from.x, targetZ, level)) {
      pos.z += dz;
    } else {
      pos.z = dz > 0 ? targetZ - r - 1e-4 : targetZ + 1 + r + 1e-4;
      hitZ = true;
    }
  }

  return { hitX, hitZ };
}

/**
 * A stand-in mover for M1: screen-relative input, grid collision, no animation.
 * M3 replaces this with a real controller (stamina, sneak, encumbrance).
 */
export class Walker {
  /** @param {import('./Entity.js').Entity} entity */
  constructor(entity) {
    this.entity = entity;
    /** Metres per second. */
    this.walkSpeed = 2.6;
    this.runSpeed = 5.2;
    this.sneakSpeed = 1.3;
    this._delta = new Vector3();
  }

  /**
   * @param {import('../world/TileGrid.js').TileGrid} grid
   * @param {Vector3} moveDir world-space unit direction (or zero)
   * @param {number} speed metres per second
   * @param {number} dt
   */
  step(grid, moveDir, speed, dt) {
    const e = this.entity;
    if (moveDir.lengthSq() > 1e-8) {
      this._delta.copy(moveDir).multiplyScalar(speed * dt);
      const hit = moveOnGrid(grid, e, this._delta.x, this._delta.z);
      e.velocity.copy(moveDir).multiplyScalar(speed);
      e.faceVelocity();
      e.stepTurn(dt);
      return hit;
    }
    e.velocity.set(0, 0, 0);
    e.stepTurn(dt);
    return { hitX: false, hitZ: false };
  }
}
