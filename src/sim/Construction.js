/**
 * Building and breaking.
 *
 * ## Fortifying is loud
 *
 * The central tension of base building in this genre is that the act of making
 * a place safe is the act of telling the street exactly where you are. Every
 * construction job emits noise through the same `noise:made` event a gunshot
 * would, so hammering planks over a window genuinely draws the crowd you are
 * hammering them against. Nothing special-cases it.
 *
 * ## Barricades are destructible, so they are a delay and not a wall
 *
 * M6 left barricading absolute — the dead simply could not get through. That
 * makes a base an off switch rather than a decision. Here a chasing zombie
 * blocked by planks attacks them, and enough zombies for long enough get in.
 * A barricade buys time, and time is the only thing worth buying.
 */
import { DIR_VEC } from '../core/constants.js';
import { WALL } from '../world/TileGrid.js';
import { BARRICADE, OUTPUT, canCraft, consumeMaterials, produce } from '../items/Recipes.js';
import { events } from '../core/Events.js';
import { worldToTile } from '../core/constants.js';

/** Damage a zombie does to planks per swing. */
const ZOMBIE_PLANK_DAMAGE = 9;
/** Seconds between a blocked zombie's attempts on a barricade. */
const POUND_INTERVAL = 1.1;
/** Loudness of a zombie hammering on a barricade — it attracts others. */
const POUND_NOISE = 11;

export class Construction {
  /**
   * @param {import('../world/TileGrid.js').TileGrid} grid
   * @param {import('../entity/Player.js').Player} player
   */
  constructor(grid, player) {
    this.grid = grid;
    this.player = player;
    /** The job in progress, if any. */
    this.job = null;
    this.stats = { crafted: 0, barricades: 0, broken: 0 };
  }

  /**
   * Which wall edge the player is facing, for barricading.
   * @returns {{ x: number, z: number, dir: number } | null}
   */
  facingEdge() {
    const p = this.player;
    const t = worldToTile(p.position.x, p.position.z);
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const dir = Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 1 : 3) : fz > 0 ? 2 : 0;

    const wall = this.grid.wallAt(t.x, t.z, p.level, dir);
    // Only openings can be barricaded. Nailing planks to a solid brick wall is
    // not a thing, and offering it would be a trap for the player's materials.
    if (wall !== WALL.DOORWAY && wall !== WALL.WINDOW) return null;
    return { x: t.x, z: t.z, dir };
  }

  /**
   * Begin a recipe. Returns why it failed, or null on success.
   * @param {import('../items/Recipes.js').Recipe} recipe
   * @returns {string | null}
   */
  begin(recipe) {
    if (this.job) return 'busy';

    const check = canCraft(recipe, this.player.inventory, this.player.weapon.def);
    if (!check.ok) return `need ${check.missing.join(', ')}`;

    let edge = null;
    if (recipe.output === OUTPUT.BARRICADE) {
      edge = this.facingEdge();
      if (!edge) return 'face a window or doorway';
      const existing = this.grid.barricadeAt(edge.x, edge.z, this.player.level, edge.dir);
      if (existing && existing.planks >= BARRICADE.maxPlanks) return 'already barricaded';
    }

    this.job = { recipe, edge, remaining: recipe.seconds ?? 2, noiseTimer: 0 };
    return null;
  }

  cancel() {
    this.job = null;
  }

  /** @param {number} dt real seconds */
  update(dt) {
    const job = this.job;
    if (!job) return;

    // Working stops you moving, exactly like a swing does — you cannot nail a
    // plank up while running away, and that is the decision.
    this.player.busy = Math.max(this.player.busy, 0.1);

    job.noiseTimer -= dt;
    if (job.noiseTimer <= 0) {
      job.noiseTimer = 0.6;
      const t = worldToTile(this.player.position.x, this.player.position.z);
      events.emit('noise:made', {
        x: t.x,
        z: t.z,
        level: this.player.level,
        loudness: job.recipe.noise ?? 4,
        source: 'crafting',
      });
    }

    job.remaining -= dt;
    if (job.remaining > 0) return;

    this._finish(job);
    this.job = null;
  }

  _finish(job) {
    const { recipe, edge } = job;
    // Re-check: the player may have used the materials mid-job.
    if (!canCraft(recipe, this.player.inventory, this.player.weapon.def).ok) return;
    consumeMaterials(recipe, this.player.inventory);

    if (recipe.output === OUTPUT.BARRICADE && edge) {
      this.grid.addPlank(
        edge.x, edge.z, this.player.level, edge.dir,
        BARRICADE.hpPerPlank, BARRICADE.maxPlanks,
      );
      this.stats.barricades++;
      events.emit('built:barricade', edge);
      return;
    }

    const item = produce(recipe);
    if (item) {
      this.player.inventory.add(item);
      this.stats.crafted++;
      events.emit('crafted', { id: item.id, count: item.count });
    }
  }

  get progress() {
    if (!this.job) return 0;
    const total = this.job.recipe.seconds ?? 2;
    return 1 - this.job.remaining / total;
  }
}

/**
 * Let blocked zombies work on whatever is in their way.
 *
 * Kept separate from `Horde` because it is about the *world* changing, not about
 * the dead deciding anything — and because it is the piece that turns a
 * barricade from a wall into a delay.
 */
export class Siege {
  /**
   * @param {import('../world/TileGrid.js').TileGrid} grid
   * @param {import('./Horde.js').Horde} horde
   */
  constructor(grid, horde) {
    this.grid = grid;
    this.horde = horde;
    this._cooldown = new Float32Array(horde.capacity);
    this.stats = { hits: 0, breaches: 0 };
  }

  /**
   * @param {number} dt
   * @param {import('./FlowField.js').FlowField} flow the field they are following
   */
  update(dt, flow) {
    const horde = this.horde;
    for (let i = 0; i < horde.count; i++) {
      if (this._cooldown[i] > 0) this._cooldown[i] -= dt;
      // Only the ones actually coming for you bother; a wanderer that bumps a
      // barricade should drift off, not demolish the neighbourhood.
      if (horde.state[i] !== 3 /* CHASE */) continue;
      if (this._cooldown[i] > 0) continue;

      const x = Math.floor(horde.x[i]);
      const z = Math.floor(horde.z[i]);
      const dir = flow.directionAt(x, z);
      if (dir < 0) continue;

      const v = DIR_VEC[dir];
      const nx = x + v.dx;
      const nz = z + v.dz;
      const level = horde.level[i];

      if (this.grid.isBarricaded(x, z, nx, nz, level)) {
        this._pound(i, x, z, nx, nz, level);
        continue;
      }
      // A shut door is the other thing that stops them; they hammer that too.
      if (
        this.grid.wallBetween(x, z, nx, nz, level) === WALL.DOORWAY &&
        !this.grid.isDoorOpen(x, z, nx, nz, level)
      ) {
        this._forceDoor(i, x, z, nx, nz, level);
      }
    }
  }

  _pound(i, x, z, nx, nz, level) {
    this._cooldown[i] = POUND_INTERVAL;
    this.horde.yaw[i] = Math.atan2(-(nx - x), -(nz - z));
    const broke = this.grid.damageBarricade(x, z, nx, nz, level, ZOMBIE_PLANK_DAMAGE);
    this.stats.hits++;
    if (broke) this.stats.breaches++;

    // The noise of them getting in is what brings the rest.
    events.emit('noise:made', { x, z, level, loudness: POUND_NOISE, source: 'siege' });
  }

  _forceDoor(i, x, z, nx, nz, level) {
    this._cooldown[i] = POUND_INTERVAL * 1.6;
    this.horde.yaw[i] = Math.atan2(-(nx - x), -(nz - z));
    // They do not pick locks; they lean on it until it opens.
    const tile = this.grid.doorTile(x, z, nx, nz, level);
    if (tile) this.grid.setDoorOpen(tile.x, tile.z, level, true);
    events.emit('noise:made', { x, z, level, loudness: POUND_NOISE * 0.7, source: 'siege' });
  }
}

export { ZOMBIE_PLANK_DAMAGE, POUND_INTERVAL };
