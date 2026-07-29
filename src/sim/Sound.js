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
 *
 * ## M13 made it three-dimensional
 *
 * It used to be one storey, and noise made upstairs was inaudible below. That
 * is a strange world to be in: hammering planks over a first-floor window is one
 * of the loudest things in the game and the street could not hear it. Sound now
 * crosses a floor — heavily attenuated, because a floor is a thick wall you are
 * standing on — and travels freely up a stairwell.
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
/** Through a floor. Dear, but not silent: you can hear the room above you. */
const FALLOFF_FLOOR = 7;
/** Up or down an open stairwell. Cheap, because it is a hole. */
const FALLOFF_STAIRS = 2;

/** Below this a noise is inaudible and stops spreading. */
const AUDIBLE = 0.5;

export class SoundField {
  /** @param {import('../world/TileGrid.js').TileGrid} grid */
  constructor(grid) {
    this.grid = grid;

    /** Current loudness per cell, over every storey. */
    this.field = new Float32Array(grid.size);

    /**
     * The cells that are currently making any noise at all.
     *
     * The decay pass used to walk the whole field every tick. That is O(cells)
     * per step, and once the flow field stopped being O(cells) this became the
     * most map-size-sensitive thing left in the horde: 0.05 ms on a 104² town
     * and 0.52 ms on a 420² one, to fade a few hundred cells. A town is silent
     * almost everywhere almost always, so the list is short and the pass is now
     * proportional to how much noise there is rather than to how big the map is.
     */
    this._loud = [];
    this._listed = new Uint8Array(grid.size);

    /** How fast a noise fades, in loudness units per second. */
    this.decay = 3.5;
    this._queue = [];
    this.stats = { emissions: 0, spread: 0, loud: 0 };
  }

  get plane() {
    return this.grid.width * this.grid.depth;
  }

  /**
   * Add a noise. Loudness is in tiles-of-open-air: a loudness of 20 is audible
   * 20 tiles away across open ground, and far less through a building.
   *
   * @param {number} x @param {number} z @param {number} level @param {number} loudness
   */
  emit(x, z, level, loudness) {
    const grid = this.grid;
    if (!grid.inBounds(x, z, level) || loudness < AUDIBLE) return 0;

    const { width, depth, levels } = grid;
    const plane = width * depth;
    const field = this.field;

    // Bucketed flood fill by remaining loudness, loudest first — the first time
    // a cell is reached is with the most loudness it will ever get from this
    // source, so it never needs revisiting.
    const queue = this._queue;
    queue.length = 0;
    queue.push(level * plane + z * width + x, loudness);

    let spread = 0;
    for (let head = 0; head < queue.length; head += 2) {
      const index = queue[head];
      const heard = queue[head + 1];
      if (heard <= field[index]) continue;

      if (field[index] === 0 && this._listed[index] === 0) {
        this._listed[index] = 1;
        this._loud.push(index);
      }
      field[index] = heard;
      spread++;

      const cl = (index / plane) | 0;
      const within = index - cl * plane;
      const cz = (within / width) | 0;
      const cx = within - cz * width;

      for (let d = 0; d < 4; d++) {
        const v = DIR_VEC[d];
        const nx = cx + v.dx;
        const nz = cz + v.dz;
        if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;

        const next = heard - this._attenuation(cx, cz, nx, nz, cl);
        if (next < AUDIBLE) continue;
        const ni = index + v.dz * width + v.dx;
        if (next <= field[ni]) continue;
        queue.push(ni, next);
      }

      // Through the floor and the ceiling. A stairwell is a hole, so it carries
      // sound far better than a slab does — which is why a shut stairwell door
      // is worth having.
      for (const step of [1, -1]) {
        const nl = cl + step;
        if (nl < 0 || nl >= levels) continue;
        const open =
          step === 1
            ? grid.climbFrom(cx, cz, cl) === nl
            : grid.descendFrom(cx, cz, cl) === nl;
        const next = heard - (open ? FALLOFF_STAIRS : FALLOFF_FLOOR);
        if (next < AUDIBLE) continue;
        const ni = index + step * plane;
        if (next <= field[ni]) continue;
        queue.push(ni, next);
      }
    }

    this.stats.emissions++;
    this.stats.spread = spread;
    return spread;
  }

  _attenuation(fx, fz, tx, tz, level) {
    const wall = this.grid.wallBetween(fx, fz, tx, tz, level);
    if (wall === WALL.NONE) return FALLOFF_OPEN;
    if (wall === WALL.DOORWAY) {
      return this.grid.isDoorOpen(fx, fz, tx, tz, level)
        ? FALLOFF_OPEN
        : FALLOFF_OPEN + FALLOFF_DOOR;
    }
    if (wall === WALL.WINDOW) return FALLOFF_OPEN + FALLOFF_WINDOW;
    if (wall === WALL.FENCE) return FALLOFF_OPEN;
    return FALLOFF_OPEN + FALLOFF_WALL;
  }

  /**
   * Fade every noise. Call once per simulation step.
   *
   * Walks only the cells that are actually audible, compacting the list in
   * place as they fall silent — so a quiet town costs nothing and a loud one
   * costs in proportion to how loud it is.
   */
  update(dt) {
    const drop = this.decay * dt;
    const { field, _loud, _listed } = this;
    let write = 0;
    for (let k = 0; k < _loud.length; k++) {
      const i = _loud[k];
      const next = field[i] - drop;
      if (next <= 0) {
        field[i] = 0;
        _listed[i] = 0;
        continue;
      }
      field[i] = next;
      _loud[write++] = i;
    }
    _loud.length = write;
    this.stats.loud = write;
  }

  /** @returns {number} loudness at a cell */
  at(x, z, level = 0) {
    const grid = this.grid;
    if (x < 0 || z < 0 || x >= grid.width || z >= grid.depth) return 0;
    if (level < 0 || level >= grid.levels) return 0;
    return this.field[level * grid.width * grid.depth + z * grid.width + x];
  }

  /**
   * The neighbouring direction with the most noise, or -1 if it is quiet.
   * This is the whole of a zombie's hearing: walk uphill.
   *
   * Vertical steps are offered too, but only where the grid says a body could
   * actually take them — otherwise the dead would queue under a ceiling.
   */
  loudestDirection(x, z, level = 0, threshold = AUDIBLE) {
    let best = -1;
    let bestLevel = this.at(x, z, level);
    if (bestLevel < threshold) return -1;

    for (let d = 0; d < 4; d++) {
      const v = DIR_VEC[d];
      const heard = this.at(x + v.dx, z + v.dz, level);
      if (heard > bestLevel) {
        bestLevel = heard;
        best = d;
      }
    }

    const up = this.grid.climbFrom(x, z, level);
    if (up >= 0 && this.at(x, z, up) > bestLevel) {
      bestLevel = this.at(x, z, up);
      best = 4; // UP
    }
    const down = this.grid.descendFrom(x, z, level);
    if (down >= 0 && this.at(x, z, down) > bestLevel) {
      bestLevel = this.at(x, z, down);
      best = 5; // DOWN
    }
    return best;
  }

  clear() {
    this.field.fill(0);
    this._listed.fill(0);
    this._loud.length = 0;
  }
}

export { AUDIBLE, FALLOFF_WALL, FALLOFF_FLOOR };
