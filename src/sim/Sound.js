/**
 * Sound propagation.
 *
 * The dead hunt by ear far more than by eye, so this is the field that actually
 * governs the game's tension. Noise spreads outward from its source, attenuating
 * with distance and much faster through walls, and decays over time. A zombie
 * with nothing in sight walks up the loudest gradient it can hear.
 *
 * That is what makes noise discipline a real mechanic: a smashed window pulls
 * the street toward you, and a door you closed quietly does not. It also means
 * the horde never consults the player's position directly — the *only* channels
 * are this field and line of sight, which is precisely why hiding works.
 */
import { DIR_VEC } from '../core/constants.js';
import { WALL } from '../world/TileGrid.js';

/** Loudness lost per tile of open air. */
const FALLOFF_OPEN = 1;
/** Extra loudness lost passing through a solid wall. */
const FALLOFF_WALL = 9;
/** Through a doorway with the door shut, or a window. */
const FALLOFF_DOOR = 4;
const FALLOFF_WINDOW = 2;

/** Below this a noise is inaudible and stops spreading. */
const AUDIBLE = 0.5;

export class SoundField {
  /** @param {import('../world/TileGrid.js').TileGrid} grid */
  constructor(grid, level = 0) {
    this.grid = grid;
    this.level = level;
    const n = grid.width * grid.depth;

    /** Current loudness per tile. */
    this.field = new Float32Array(n);
    /** Loudest source heard at each tile, for debugging and for HUD overlays. */
    this.age = new Float32Array(n);

    /** How fast a noise fades, in loudness units per second. */
    this.decay = 3.5;
    this._queue = [];
    this.stats = { emissions: 0, spread: 0 };
  }

  /**
   * Add a noise. Loudness is in tiles-of-open-air: a loudness of 20 is audible
   * 20 tiles away across open ground, and far less through a building.
   *
   * @param {number} x @param {number} z @param {number} loudness
   */
  emit(x, z, loudness) {
    const grid = this.grid;
    const level = this.level;
    if (!grid.inBounds(x, z, level) || loudness < AUDIBLE) return 0;

    const { width, depth } = grid;
    const field = this.field;

    // Bucketed flood fill by remaining loudness, loudest first — the first time
    // a tile is reached is with the most loudness it will ever get from this
    // source, so it never needs revisiting.
    const queue = this._queue;
    queue.length = 0;
    queue.push(z * width + x, loudness);

    let spread = 0;
    for (let head = 0; head < queue.length; head += 2) {
      const index = queue[head];
      const level0 = queue[head + 1];
      if (level0 <= field[index]) continue;

      field[index] = level0;
      spread++;

      const cz = (index / width) | 0;
      const cx = index - cz * width;

      for (let d = 0; d < 4; d++) {
        const v = DIR_VEC[d];
        const nx = cx + v.dx;
        const nz = cz + v.dz;
        if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;

        const next = level0 - this._attenuation(cx, cz, nx, nz);
        if (next < AUDIBLE) continue;
        const ni = nz * width + nx;
        if (next <= field[ni]) continue;
        queue.push(ni, next);
      }
    }

    this.stats.emissions++;
    this.stats.spread = spread;
    return spread;
  }

  _attenuation(fx, fz, tx, tz) {
    const wall = this.grid.wallBetween(fx, fz, tx, tz, this.level);
    if (wall === WALL.NONE) return FALLOFF_OPEN;
    if (wall === WALL.DOORWAY) {
      return this.grid.isDoorOpen(fx, fz, tx, tz, this.level)
        ? FALLOFF_OPEN
        : FALLOFF_OPEN + FALLOFF_DOOR;
    }
    if (wall === WALL.WINDOW) return FALLOFF_OPEN + FALLOFF_WINDOW;
    if (wall === WALL.FENCE) return FALLOFF_OPEN;
    return FALLOFF_OPEN + FALLOFF_WALL;
  }

  /** Fade every noise. Call once per simulation step. */
  update(dt) {
    const drop = this.decay * dt;
    const field = this.field;
    for (let i = 0; i < field.length; i++) {
      if (field[i] > 0) field[i] = Math.max(0, field[i] - drop);
    }
  }

  /** @returns {number} loudness at a tile */
  at(x, z) {
    if (x < 0 || z < 0 || x >= this.grid.width || z >= this.grid.depth) return 0;
    return this.field[z * this.grid.width + x];
  }

  /**
   * The neighbouring direction with the most noise, or -1 if it is quiet.
   * This is the whole of a zombie's hearing: walk uphill.
   */
  loudestDirection(x, z, threshold = AUDIBLE) {
    let best = -1;
    let bestLevel = this.at(x, z);
    if (bestLevel < threshold) return -1;

    for (let d = 0; d < 4; d++) {
      const v = DIR_VEC[d];
      const level = this.at(x + v.dx, z + v.dz);
      if (level > bestLevel) {
        bestLevel = level;
        best = d;
      }
    }
    return best;
  }

  clear() {
    this.field.fill(0);
  }
}

export { AUDIBLE, FALLOFF_WALL };
