/**
 * The horde.
 *
 * ## Structure of arrays
 *
 * Hundreds of zombies are typed arrays, not hundreds of objects. At this count
 * the cost that bites is not the arithmetic, it is allocation and cache misses —
 * an object per zombie means a pointer chase per field per tick and a GC pause
 * whenever a wave dies. Arrays also mean the render buffers can be filled by a
 * straight copy rather than by walking a list.
 *
 * ## They never look at the player
 *
 * A zombie's only inputs are the sound field and line of sight. Nothing in this
 * file reads the player's position to decide behaviour — only to *test* whether
 * it is visible. That constraint is what makes hiding, sneaking and noise
 * discipline work at all; the moment anything short-circuits it, stealth stops
 * being real and becomes a number the AI politely ignores.
 *
 * ## States
 *
 * idle → wander → investigate → chase, and back down again as attention decays.
 * Attention is a float that only chase refills, so a zombie that loses you keeps
 * coming for a while and then gives up — which is what makes breaking line of
 * sight a tactic rather than an off switch.
 */
import { DIR_VEC, STOREY, tileToWorld } from '../core/constants.js';
import { hasLineOfSight } from './Sight.js';
import { Rng } from '../core/Rng.js';

export const STATE = {
  IDLE: 0,
  WANDER: 1,
  INVESTIGATE: 2,
  CHASE: 3,
  DEAD: 4,
};

const SPEED = {
  [STATE.IDLE]: 0,
  [STATE.WANDER]: 0.45,
  [STATE.INVESTIGATE]: 0.95,
  [STATE.CHASE]: 2.1,
  [STATE.DEAD]: 0,
};

/** How far a zombie can see, in tiles, and how wide its cone is. */
const SIGHT_RANGE = 13;
const SIGHT_COS = Math.cos(Math.PI * 0.42); // ~150° total, they are not subtle

/** Attention decays this fast; chase refills it to 1. */
const ATTENTION_DECAY = 0.14;
/** Above this they chase, below it they investigate, at zero they lose interest. */
const CHASE_THRESHOLD = 0.55;

export class Horde {
  /**
   * @param {import('../world/TileGrid.js').TileGrid} grid
   * @param {import('./FlowField.js').FlowField} flow
   * @param {import('./Sound.js').SoundField} sound
   * @param {{ capacity?: number, seed?: string }} [opts]
   */
  constructor(grid, flow, sound, { capacity = 512, seed = 'horde' } = {}) {
    this.grid = grid;
    this.flow = flow;
    this.sound = sound;
    this.capacity = capacity;
    this.rng = new Rng(seed);

    this.count = 0;
    this.x = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.level = new Uint8Array(capacity);
    this.yaw = new Float32Array(capacity);
    this.state = new Uint8Array(capacity);
    this.attention = new Float32Array(capacity);
    /** Per-zombie speed multiplier, so a crowd does not move as one block. */
    this.pace = new Float32Array(capacity);
    /** Animation phase offset, for the same reason. */
    this.phase = new Float32Array(capacity);
    /** Tint index, for visual variety. */
    this.tint = new Float32Array(capacity * 3);
    /** Wander heading, held for a while so they do not jitter on the spot. */
    this._wanderDir = new Int8Array(capacity);
    this._wanderTimer = new Float32Array(capacity);

    this.stats = { alive: 0, chasing: 0, investigating: 0 };
  }

  /** @returns {number} the new zombie's index, or -1 if full */
  spawn(x, z, level = 0) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.x[i] = x + 0.5;
    this.z[i] = z + 0.5;
    this.level[i] = level;
    this.yaw[i] = this.rng.range(0, Math.PI * 2);
    this.state[i] = STATE.IDLE;
    this.attention[i] = 0;
    this.pace[i] = this.rng.range(0.78, 1.24);
    this.phase[i] = this.rng.next();
    this._wanderDir[i] = this.rng.int(0, 3);
    this._wanderTimer[i] = this.rng.range(0, 4);

    // Muted, slightly varied — the dead should read as a mass, not as a set of
    // individuals, so the spread is deliberately narrow.
    const v = this.rng.range(0.72, 1.06);
    this.tint[i * 3] = v * this.rng.range(0.92, 1.04);
    this.tint[i * 3 + 1] = v * this.rng.range(0.94, 1.02);
    this.tint[i * 3 + 2] = v * this.rng.range(0.86, 0.98);
    return i;
  }

  /**
   * Scatter zombies over walkable outdoor and indoor tiles.
   * @param {number} n
   * @param {(x: number, z: number, level: number) => boolean} [accept]
   */
  populate(n, accept) {
    const grid = this.grid;
    let placed = 0;
    let attempts = 0;
    while (placed < n && attempts < n * 60) {
      attempts++;
      const x = this.rng.int(0, grid.width - 1);
      const z = this.rng.int(0, grid.depth - 1);
      if (!grid.isWalkable(x, z, 0)) continue;
      if (accept && !accept(x, z, 0)) continue;
      if (this.spawn(x, z, 0) >= 0) placed++;
    }
    return placed;
  }

  /**
   * @param {number} dt
   * @param {{x: number, z: number, level: number}} target the player's tile —
   *   used *only* for the line-of-sight test, never as a heading
   */
  update(dt, target) {
    const grid = this.grid;
    let chasing = 0;
    let investigating = 0;

    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === STATE.DEAD) continue;

      const tx = Math.floor(this.x[i]);
      const tz = Math.floor(this.z[i]);

      // --- perception -------------------------------------------------
      let sees = false;
      if (this.level[i] === target.level) {
        const dx = target.x - tx;
        const dz = target.z - tz;
        const d2 = dx * dx + dz * dz;
        if (d2 <= SIGHT_RANGE * SIGHT_RANGE) {
          const d = Math.sqrt(d2) || 1;
          // Facing test first: it is a dot product, and it rejects most
          // candidates before the far more expensive ray walk.
          const fx = -Math.sin(this.yaw[i]);
          const fz = -Math.cos(this.yaw[i]);
          if ((dx / d) * fx + (dz / d) * fz >= SIGHT_COS) {
            sees = hasLineOfSight(grid, tx, tz, target.x, target.z, this.level[i]);
          }
        }
      }

      if (sees) {
        this.attention[i] = 1;
      } else {
        this.attention[i] = Math.max(0, this.attention[i] - ATTENTION_DECAY * dt);
      }

      const heard = this.sound.at(tx, tz);

      // --- state ------------------------------------------------------
      let state;
      if (this.attention[i] >= CHASE_THRESHOLD) state = STATE.CHASE;
      else if (this.attention[i] > 0 || heard > 1) state = STATE.INVESTIGATE;
      else state = STATE.WANDER;
      this.state[i] = state;

      if (state === STATE.CHASE) chasing++;
      else if (state === STATE.INVESTIGATE) investigating++;

      // --- movement ---------------------------------------------------
      let dir = -1;
      if (state === STATE.CHASE) {
        // The flow field is built from the player, so following it *is*
        // pursuit — without this file ever reading a heading from the player.
        dir = this.flow.directionAt(tx, tz);
        if (dir < 0) dir = this.sound.loudestDirection(tx, tz);
      } else if (state === STATE.INVESTIGATE) {
        dir = this.sound.loudestDirection(tx, tz);
        if (dir < 0) dir = this.flow.directionAt(tx, tz);
      } else {
        this._wanderTimer[i] -= dt;
        if (this._wanderTimer[i] <= 0) {
          this._wanderTimer[i] = this.rng.range(2.5, 7);
          this._wanderDir[i] = this.rng.int(0, 3);
        }
        dir = this._wanderDir[i];
      }

      if (dir < 0) continue;
      this._step(i, dir, SPEED[state] * this.pace[i], dt);
    }

    this.stats.alive = this.count;
    this.stats.chasing = chasing;
    this.stats.investigating = investigating;
  }

  /** Move toward the centre of the neighbouring tile in `dir`. */
  _step(i, dir, speed, dt) {
    const v = DIR_VEC[dir];
    const tx = Math.floor(this.x[i]);
    const tz = Math.floor(this.z[i]);
    const nx = tx + v.dx;
    const nz = tz + v.dz;
    const level = this.level[i];

    if (!this.grid.canPass(tx, tz, nx, nz, level)) {
      // Blocked: turn to face the obstacle anyway, so a crowd piling against a
      // door looks like it is trying rather than milling about.
      this.yaw[i] = Math.atan2(-v.dx, -v.dz);
      if (this.state[i] === STATE.WANDER) this._wanderTimer[i] = 0;
      return;
    }

    const goalX = nx + 0.5;
    const goalZ = nz + 0.5;
    const dx = goalX - this.x[i];
    const dz = goalZ - this.z[i];
    const dist = Math.hypot(dx, dz) || 1;
    const step = Math.min(speed * dt, dist);

    this.x[i] += (dx / dist) * step;
    this.z[i] += (dz / dist) * step;
    this.yaw[i] = Math.atan2(-dx, -dz);
  }

  /** Fill the render instance buffers. Returns how many instances to draw. */
  writeInstances(attrs, clipTable, clock) {
    const transform = attrs.aTransform.array;
    const clip = attrs.aClip.array;
    const tint = attrs.aTint.array;

    const shamble = clipTable.shamble;
    const lunge = clipTable.lunge;
    const idle = clipTable.idle;

    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const state = this.state[i];
      if (state === STATE.DEAD) continue;

      const o = n * 4;
      transform[o] = this.x[i];
      transform[o + 1] = this.level[i] * STOREY;
      transform[o + 2] = this.z[i];
      transform[o + 3] = this.yaw[i];

      const c = state === STATE.CHASE ? lunge : state === STATE.WANDER ? shamble : shamble;
      const active = state === STATE.IDLE ? idle : c;
      clip[o] = active.start;
      clip[o + 1] = active.frames;
      clip[o + 2] = this.phase[i];
      // Playback rate scales with the pace multiplier so a faster zombie's feet
      // keep up with it — the ice-skating problem, in instance form.
      clip[o + 3] = (state === STATE.CHASE ? 14 : 7) * this.pace[i];

      tint[n * 3] = this.tint[i * 3];
      tint[n * 3 + 1] = this.tint[i * 3 + 1];
      tint[n * 3 + 2] = this.tint[i * 3 + 2];
      n++;
    }

    attrs.aTransform.needsUpdate = true;
    attrs.aClip.needsUpdate = true;
    attrs.aTint.needsUpdate = true;
    return n;
  }

  /** World position of a zombie, for spatial queries. */
  positionOf(i, out = { x: 0, y: 0, z: 0 }) {
    return tileToWorld(Math.floor(this.x[i]), Math.floor(this.z[i]), this.level[i], out);
  }
}

export { SIGHT_RANGE, CHASE_THRESHOLD, SPEED };
