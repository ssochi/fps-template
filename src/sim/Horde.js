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
  /** Mid-swing at the player, or getting up after being knocked down. */
  ATTACK: 5,
  STAGGER: 6,
};

const SPEED = {
  [STATE.IDLE]: 0,
  [STATE.WANDER]: 0.45,
  [STATE.INVESTIGATE]: 0.95,
  [STATE.CHASE]: 2.1,
  [STATE.DEAD]: 0,
  [STATE.ATTACK]: 0,
  [STATE.STAGGER]: 0,
};

/** Starting health. Roughly two axe blows, or four with a bat. */
const ZOMBIE_HEALTH = 100;
/** A headshot-equivalent: damage above this to a standing zombie always kills. */
export const OVERKILL = 95;

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

    this.health = new Float32Array(capacity);
    /** Seconds left of a stagger, an attack windup, or getting back up. */
    this.busy = new Float32Array(capacity);
    /** Seconds until this one can swing again. */
    this.cooldown = new Float32Array(capacity);
    /** Simulation time this one died, so the fall clip starts at the right frame. */
    this.deathTime = new Float32Array(capacity);
    /** Knockback velocity, decayed each tick. */
    this.vx = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    /** Which limbs have been taken off, as a bitmask. Purely cosmetic for now. */
    this.dismembered = new Uint8Array(capacity);
    /**
     * Seconds of hit flash remaining.
     *
     * M6 shipped with a landed swing and a missed one looking identical, which
     * made combat feel like nothing was happening. This is the cheapest possible
     * fix: brighten the instance tint for a fifth of a second.
     */
    this.hitFlash = new Float32Array(capacity);

    this.clock = 0;
    this.stats = { alive: 0, dead: 0, chasing: 0, investigating: 0, attacking: 0 };
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
    this.health[i] = ZOMBIE_HEALTH;
    this.busy[i] = 0;
    this.cooldown[i] = 0;
    this.vx[i] = 0;
    this.vz[i] = 0;
    this.dismembered[i] = 0;
    this.hitFlash[i] = 0;
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
    this.clock += dt;
    let chasing = 0;
    let investigating = 0;
    let attacking = 0;
    let dead = 0;

    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === STATE.DEAD) {
        dead++;
        continue;
      }

      const tx = Math.floor(this.x[i]);
      const tz = Math.floor(this.z[i]);

      if (this.cooldown[i] > 0) this.cooldown[i] -= dt;
      if (this.hitFlash[i] > 0) this.hitFlash[i] = Math.max(0, this.hitFlash[i] - dt);

      // Knockback runs regardless of state, so a staggered zombie still slides.
      if (this.vx[i] !== 0 || this.vz[i] !== 0) {
        this._applyKnockback(i, dt);
      }

      // A staggered or mid-swing zombie is committed and cannot steer. That
      // window is the entire reason shoving is worth doing.
      if (this.busy[i] > 0) {
        this.busy[i] -= dt;
        if (this.state[i] === STATE.STAGGER || this.state[i] === STATE.ATTACK) {
          if (this.state[i] === STATE.ATTACK) attacking++;
          continue;
        }
      }

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

    this.stats.alive = this.count - dead;
    this.stats.dead = dead;
    this.stats.chasing = chasing;
    this.stats.investigating = investigating;
    this.stats.attacking = attacking;
  }

  /** Slide a knocked-back zombie, stopping it at walls rather than through them. */
  _applyKnockback(i, dt) {
    const damp = Math.exp(-dt * 7);
    const dx = this.vx[i] * dt;
    const dz = this.vz[i] * dt;
    const tx = Math.floor(this.x[i]);
    const tz = Math.floor(this.z[i]);
    const level = this.level[i];

    const nx = this.x[i] + dx;
    if (Math.floor(nx) === tx || this.grid.canPass(tx, tz, Math.floor(nx), tz, level)) {
      this.x[i] = nx;
    } else {
      this.vx[i] = 0;
    }
    const nz = this.z[i] + dz;
    if (Math.floor(nz) === tz || this.grid.canPass(tx, tz, tx, Math.floor(nz), level)) {
      this.z[i] = nz;
    } else {
      this.vz[i] = 0;
    }

    this.vx[i] *= damp;
    this.vz[i] *= damp;
    if (Math.abs(this.vx[i]) < 0.02) this.vx[i] = 0;
    if (Math.abs(this.vz[i]) < 0.02) this.vz[i] = 0;
  }

  /**
   * Wound a zombie.
   *
   * @returns {{ killed: boolean, dismembered: boolean }}
   */
  damage(i, amount, { knockback = 0, dirX = 0, dirZ = 0, dismemberChance = 0, roll = Math.random } = {}) {
    if (this.state[i] === STATE.DEAD) return { killed: false, dismembered: false };

    this.health[i] -= amount;
    this.hitFlash[i] = 0.2;
    this.vx[i] += dirX * knockback * 7;
    this.vz[i] += dirZ * knockback * 7;

    if (this.health[i] <= 0) {
      this.state[i] = STATE.DEAD;
      this.deathTime[i] = this.clock;
      this.busy[i] = 0;
      const lost = roll() < dismemberChance;
      if (lost) this.dismembered[i] |= 1;
      return { killed: true, dismembered: lost };
    }

    // Surviving a heavy blow still costs them a beat.
    if (amount >= 20 || knockback > 0.5) {
      this.state[i] = STATE.STAGGER;
      this.busy[i] = Math.max(this.busy[i], 0.35 + knockback * 0.25);
    }
    return { killed: false, dismembered: false };
  }

  /** Knock down without wounding — what a shove does. */
  stagger(i, seconds, { dirX = 0, dirZ = 0, knockback = 0 } = {}) {
    if (this.state[i] === STATE.DEAD) return;
    this.state[i] = STATE.STAGGER;
    this.busy[i] = Math.max(this.busy[i], seconds);
    this.vx[i] += dirX * knockback * 7;
    this.vz[i] += dirZ * knockback * 7;
  }

  /** Begin a swing at the player. Combat owns the damage; this owns the pose. */
  beginAttack(i, windup, cooldown) {
    this.state[i] = STATE.ATTACK;
    this.busy[i] = windup;
    this.cooldown[i] = cooldown;
  }

  isDead(i) {
    return this.state[i] === STATE.DEAD;
  }

  /** Can this one act at all right now? */
  isReady(i) {
    return this.state[i] !== STATE.DEAD && this.busy[i] <= 0 && this.cooldown[i] <= 0;
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

    const fall = clipTable.fall;
    const attack = clipTable.attack;

    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const state = this.state[i];

      const o = n * 4;
      transform[o] = this.x[i];
      transform[o + 1] = this.level[i] * STOREY;
      transform[o + 2] = this.z[i];
      transform[o + 3] = this.yaw[i];

      // Corpses hold the last frame of the fall clip forever, so a cleared
      // street stays visibly cleared. A negative rate means "play once and
      // hold" — see CrowdMaterial.
      let active;
      let rate;
      let timeOffset;
      if (state === STATE.DEAD) {
        active = fall;
        rate = -9;
        timeOffset = this.deathTime[i];
      } else if (state === STATE.ATTACK) {
        active = attack;
        rate = -11;
        timeOffset = clock - (0.55 - Math.max(0, this.busy[i]));
      } else if (state === STATE.STAGGER) {
        active = idle;
        rate = 5 * this.pace[i];
        timeOffset = -this.phase[i] * 4;
      } else if (state === STATE.IDLE) {
        active = idle;
        rate = 5 * this.pace[i];
        timeOffset = -this.phase[i] * 4;
      } else {
        active = state === STATE.CHASE ? lunge : shamble;
        // Playback rate scales with the pace multiplier so a faster zombie's
        // feet keep up with it — the ice-skating problem, in instance form.
        rate = (state === STATE.CHASE ? 14 : 7) * this.pace[i];
        timeOffset = -this.phase[i] * 4;
      }

      clip[o] = active.start;
      clip[o + 1] = active.frames;
      clip[o + 2] = timeOffset;
      clip[o + 3] = rate;

      // A hit washes the instance toward red-white for a moment.
      const flash = this.hitFlash[i] > 0 ? this.hitFlash[i] / 0.2 : 0;
      tint[n * 3] = this.tint[i * 3] + flash * 1.5;
      tint[n * 3 + 1] = this.tint[i * 3 + 1] + flash * 0.35;
      tint[n * 3 + 2] = this.tint[i * 3 + 2] + flash * 0.3;
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
