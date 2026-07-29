/**
 * Migration — why a street you cleared does not stay cleared.
 *
 * M5 shipped the horde as a single scatter at worldgen and nothing has moved it
 * since. So the map is a fixed budget of danger that only ever goes down: kill
 * forty zombies on your block and that block is permanently safe, which quietly
 * removes the reason to ever leave or to ever come back. M11's survey called
 * this the largest remaining gap in the horde's behaviour, and it is.
 *
 * ## Two mechanisms, deliberately both local
 *
 * **Spreading.** A wandering zombie prefers the emptier of the neighbouring
 * districts. That is all "migration" needs to be: it is conservative — nothing
 * is spawned and nothing is deleted — and it refills a cleared street from the
 * streets around it over minutes rather than instantly. It also thins out the
 * absurd clumps that a pure random walk produces, because a random walk on a
 * bounded grid piles up in corners.
 *
 * **Drawing.** Loud things pull. A district that has recently heard something
 * becomes attractive, and the pull persists long after the noise itself has
 * faded from the sound field — the dead remember the direction of a gunshot for
 * far longer than the gunshot lasts. This is what makes a base you keep
 * hammering at a place the town slowly walks toward.
 *
 * ## Why a coarse grid
 *
 * Both mechanisms are about *districts*, not tiles. A 4 × 4 block of tiles is
 * about the size of a room or a stretch of pavement, and at that resolution a
 * 104 × 104 town is 26 × 26 = 676 cells — a census over the whole map costs one
 * pass over the horde, and the whole structure is under 3 KB. Doing this per
 * tile would be a hundred times the memory to express exactly the same idea.
 */
import { DIR_VEC } from '../core/constants.js';

/** Tiles per coarse cell on a side. */
export const SCALE = 4;

/** Seconds between censuses. Districts do not change fast. */
const CENSUS_INTERVAL = 2.5;

/**
 * How fast the memory of a noise fades, per second. Far slower than the sound
 * field's own decay: this is what the dead remember, not what they can hear.
 */
const MEMORY_DECAY = 0.06;

/** A district must be at least this loud in memory to draw anyone. */
const MEMORY_FLOOR = 0.35;

/** Loudness below this is not worth remembering — footsteps should not migrate a town. */
const MEMORABLE = 6;

export class Migration {
  /** @param {import('../world/TileGrid.js').TileGrid} grid */
  constructor(grid) {
    this.grid = grid;
    this.width = Math.ceil(grid.width / SCALE);
    this.depth = Math.ceil(grid.depth / SCALE);
    const n = this.width * this.depth;

    /** How many living zombies are standing in each district. */
    this.population = new Uint16Array(n);
    /** How walkable each district is, 0–SCALE², so wastelands do not attract. */
    this.capacity = new Uint16Array(n);
    /** Lingering memory of noise, per district. */
    this.memory = new Float32Array(n);

    this._since = CENSUS_INTERVAL;
    this.stats = { censuses: 0, occupied: 0, remembered: 0 };
    this.measureCapacity();
  }

  index(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.depth) return -1;
    return cz * this.width + cx;
  }

  /** The district containing a tile. */
  cellOf(x, z) {
    return this.index(Math.floor(x / SCALE), Math.floor(z / SCALE));
  }

  /**
   * How much ground floor each district has.
   *
   * Measured once, over storey zero only: migration is about which parts of the
   * *town* are full, and a first floor is a property of a building rather than a
   * district. Districts that are mostly wall or void attract nobody, which is
   * what stops the dead drifting into the middle of a terrace.
   */
  measureCapacity() {
    const { grid } = this;
    this.capacity.fill(0);
    for (let z = 0; z < grid.depth; z++) {
      for (let x = 0; x < grid.width; x++) {
        if (!grid.isWalkable(x, z, 0)) continue;
        const c = this.cellOf(x, z);
        if (c >= 0) this.capacity[c]++;
      }
    }
  }

  /** Remember a noise. Only loud ones; a footstep should not move a town. */
  remember(x, z, loudness) {
    if (loudness < MEMORABLE) return;
    const c = this.cellOf(x, z);
    if (c < 0) return;
    // Saturating rather than accumulating: a district that has been shouted at
    // ten times is not ten times as interesting as one shouted at once.
    this.memory[c] = Math.min(3, this.memory[c] + loudness / 40);
  }

  /**
   * @param {number} dt
   * @param {import('./Horde.js').Horde} horde
   */
  update(dt, horde) {
    const drop = MEMORY_DECAY * dt;
    let remembered = 0;
    for (let i = 0; i < this.memory.length; i++) {
      if (this.memory[i] > 0) {
        this.memory[i] = Math.max(0, this.memory[i] - drop);
        if (this.memory[i] >= MEMORY_FLOOR) remembered++;
      }
    }
    this.stats.remembered = remembered;

    this._since += dt;
    if (this._since < CENSUS_INTERVAL) return false;
    this._since = 0;
    this.census(horde);
    return true;
  }

  /** One pass over the horde. Only the living count — corpses are scenery. */
  census(horde) {
    this.population.fill(0);
    for (let i = 0; i < horde.count; i++) {
      if (horde.state[i] === 4 /* DEAD */) continue;
      const c = this.cellOf(horde.x[i], horde.z[i]);
      if (c >= 0) this.population[c]++;
    }
    let occupied = 0;
    for (let i = 0; i < this.population.length; i++) if (this.population[i]) occupied++;
    this.stats.censuses++;
    this.stats.occupied = occupied;
    return occupied;
  }

  /**
   * How attractive a district is to a wanderer standing next door.
   *
   * Crowding repels and remembered noise draws. Both are per-district, both are
   * bounded, and neither ever reads the player's position — migration goes
   * through the same door every other horde behaviour does.
   */
  appeal(cx, cz) {
    const c = this.index(cx, cz);
    if (c < 0) return -Infinity;
    // Somewhere with no floor is not somewhere to go.
    if (this.capacity[c] < SCALE) return -Infinity;
    const crowding = this.population[c] / this.capacity[c];
    return this.memory[c] * 2 - crowding * 6;
  }

  /**
   * Which way a wanderer at this tile should drift, or -1 to stay put.
   *
   * Returns a compass direction, so the caller can treat it exactly like any
   * other heading. A tie or a lack of anywhere better returns -1 and the caller
   * falls back to wandering at random, which is the correct behaviour for a
   * district in the middle of an empty, quiet town.
   */
  driftDirection(x, z) {
    const cx = Math.floor(x / SCALE);
    const cz = Math.floor(z / SCALE);
    const here = this.appeal(cx, cz);
    if (here === -Infinity) return -1;

    let best = -1;
    let bestAppeal = here;
    for (let d = 0; d < 4; d++) {
      const v = DIR_VEC[d];
      const a = this.appeal(cx + v.dx, cz + v.dz);
      if (a > bestAppeal + 0.05) {
        bestAppeal = a;
        best = d;
      }
    }
    return best;
  }
}

export { MEMORABLE, MEMORY_FLOOR, CENSUS_INTERVAL };
