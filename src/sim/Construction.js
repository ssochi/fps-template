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
import { Vector3 } from 'three';
import { DIR, DIR_VEC, worldToTile } from '../core/constants.js';
import { WALL } from '../world/TileGrid.js';
import { OBJ, OBJECT_SPEC, objectId, packObject } from '../world/Objects.js';
import { Item } from '../items/ItemDb.js';
import { BARRICADE, OUTPUT, canCraft, consumeMaterials, produce } from '../items/Recipes.js';
import { events } from '../core/Events.js';
import { STATION } from './Stations.js';
import { t } from '../ui/i18n.js';

const _forward = new Vector3();

/** Planks handed back for taking a piece of furniture apart. */
const RECOVERED_PLANKS = 2;

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
  constructor(grid, player, stations = null) {
    this.grid = grid;
    this.player = player;
    /** Set by the caller. Cooking and refuelling both need to know what is built. */
    this.stations = stations;
    /** The job in progress, if any. */
    this.job = null;
    /** Set by the caller, so a crate you build starts empty. */
    this.loot = null;
    this.stats = { crafted: 0, barricades: 0, broken: 0, placed: 0, dismantled: 0, repaired: 0 };
  }

  /**
   * Which wall edge the player is facing, for barricading.
   * @returns {{ x: number, z: number, dir: number } | null}
   */
  facingEdge(openEdge = false) {
    const p = this.player;
    const t = worldToTile(p.position.x, p.position.z);
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const dir = Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 1 : 3) : fz > 0 ? 2 : 0;

    const wall = this.grid.wallAt(t.x, t.z, p.level, dir);
    if (openEdge) {
      // Building a wall where there is none. The tile beyond has to exist and
      // be somewhere you could otherwise have walked, or this is a wall across
      // the void.
      if (wall !== WALL.NONE) return null;
      const v = DIR_VEC[dir];
      if (!this.grid.isWalkable(t.x + v.dx, t.z + v.dz, p.level)) return null;
      return { x: t.x, z: t.z, dir };
    }
    // Only openings can be barricaded. Nailing planks to a solid brick wall is
    // not a thing, and offering it would be a trap for the player's materials.
    if (wall !== WALL.DOORWAY && wall !== WALL.WINDOW) return null;
    return { x: t.x, z: t.z, dir };
  }

  /**
   * What "take it down" would take down.
   *
   * Barricades and plank walls first, because they are on the edge you are
   * facing and they are the thing you most often want gone; then an object you
   * put there. Worldgen's own furniture is fair game too — a wardrobe is four
   * planks if you are willing to spend six seconds and make a lot of noise.
   *
   * @returns {{ kind: 'barricade'|'object', x: number, z: number, dir?: number } | null}
   */
  dismantleTarget() {
    const p = this.player;
    const t = p.tile();
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const dir = Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 1 : 3) : fz > 0 ? 2 : 0;

    const barricade = this.grid.barricadeAt(t.x, t.z, p.level, dir);
    if (barricade && barricade.planks > 0) {
      return { kind: 'barricade', x: t.x, z: t.z, dir };
    }

    const v = DIR_VEC[dir];
    for (const [x, z] of [[t.x + v.dx, t.z + v.dz], [t.x, t.z]]) {
      const i = this.grid.index(x, z, p.level);
      if (i < 0 || this.grid.object[i] === 0) continue;
      const id = objectId(this.grid.object[i]);
      // Doors and staircases are structure, not furniture. Letting a survivor
      // dismantle the stairs they are standing on is a way to lose a run to a
      // mis-click.
      if (id === OBJ.DOOR || id === OBJ.STAIRS_LOW || id === OBJ.STAIRS_HIGH) continue;
      return { kind: 'object', x, z, objectId: id };
    }
    return null;
  }

  /** A damaged barricade on the edge you are facing, or null. */
  repairTarget() {
    const p = this.player;
    const t = p.tile();
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const dir = Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 1 : 3) : fz > 0 ? 2 : 0;
    const b = this.grid.barricadeAt(t.x, t.z, p.level, dir);
    if (!b || b.planks <= 0) return null;
    if (b.hp >= b.planks * BARRICADE.hpPerPlank) return null;
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

    // A cooking recipe needs somewhere to cook. Checked here rather than in
    // `Recipes` because a recipe is a table row and knows nothing about where
    // anybody is standing.
    if (recipe.needsFire && !this._fireNear()) return t('craft.needFire', 'need a lit fire nearby');
    if (recipe.needsWater && !this._waterNear()) return t('craft.needWater', 'need water nearby');

    let edge = null;
    let spot = null;
    let target = null;
    if (recipe.output === OUTPUT.BARRICADE) {
      edge = this.facingEdge(recipe.openEdge);
      if (!edge) {
        return recipe.openEdge
          ? t('craft.faceGap', 'face an open gap between two floors')
          : t('craft.faceOpening', 'face a window or doorway');
      }
      const existing = this.grid.barricadeAt(edge.x, edge.z, this.player.level, edge.dir);
      if (existing && existing.planks >= BARRICADE.maxPlanks) return 'already barricaded';
    } else if (recipe.output === OUTPUT.PLACE) {
      spot = this.placementSpot();
      if (!spot) return t('craft.noRoom', 'no room in front of you');
    } else if (recipe.output === OUTPUT.DISMANTLE) {
      target = this.dismantleTarget();
      if (!target) return t('craft.faceSomething', 'face something you can take down');
    } else if (recipe.output === OUTPUT.REPAIR) {
      target = this.repairTarget();
      if (!target) return t('craft.nothingBroken', 'nothing here needs repairing');
    }

    this.job = { recipe, edge, spot, target, remaining: recipe.seconds ?? 2, noiseTimer: 0 };
    return null;
  }

  /**
   * Where a placed object would go: the tile ahead, or the one underfoot.
   *
   * Ahead first, because putting a barrel down *on yourself* and then being
   * unable to move is a way to lose a run to the interface. Underfoot is the
   * fallback for a corner you have backed into.
   */
  placementSpot() {
    const p = this.player;
    const t2 = p.tile();
    const f = p.forward(_forward);
    const dir = Math.abs(f.x) > Math.abs(f.z) ? (f.x > 0 ? 1 : 3) : f.z > 0 ? 2 : 0;
    const v = DIR_VEC[dir];

    for (const [x, z] of [[t2.x + v.dx, t2.z + v.dz], [t2.x, t2.z]]) {
      if (!this.grid.isWalkable(x, z, p.level)) continue;
      const i = this.grid.index(x, z, p.level);
      if (this.grid.object[i] !== 0) continue;
      return { x, z, level: p.level };
    }
    return null;
  }

  _fireNear() {
    if (!this.stations) return false;
    const t2 = this.player.tile();
    return !!this.stations.fireNear(t2.x, t2.z, this.player.level, 1.6);
  }

  _waterNear() {
    if (!this.stations) return false;
    const t2 = this.player.tile();
    return this.stations
      .near(t2.x, t2.z, this.player.level, 1.6)
      .some((s) => s.kind === 'barrel' && s.water >= 1);
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
        loudness: (job.recipe.noise ?? 4) * this.player.noiseScale,
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

    if (recipe.output === OUTPUT.REPAIR && job.target) {
      const { x, z, dir } = job.target;
      this.grid.repairBarricade(x, z, this.player.level, dir, BARRICADE.hpPerPlank);
      this.stats.repaired++;
      events.emit('built:barricade', job.target);
      return;
    }

    if (recipe.output === OUTPUT.DISMANTLE && job.target) {
      this._dismantle(job.target);
      return;
    }

    if (recipe.output === OUTPUT.PLACE && job.spot) {
      const { x, z, level } = job.spot;
      this.grid.setObject(x, z, level, packObject(recipe.objectId, DIR.N));
      const kind = STATION[recipe.objectId];
      if (kind) this.stations?.add(x, z, level, kind);
      // A crate you built is empty. Loot is a function of (seed, cell), which
      // is right for a cupboard that predates the outbreak and wrong for one
      // you nailed together thirty seconds ago.
      if (OBJECT_SPEC[recipe.objectId]?.container) this.loot?.markPlaced(x, z, level);
      this.stats.placed++;
      events.emit('built:object', { x, z, level, objectId: recipe.objectId, kind });
      return;
    }

    if (recipe.output === OUTPUT.BARRICADE && edge) {
      for (let n = 0; n < (recipe.planks ?? 1); n++) {
        this.grid.addPlank(
          edge.x, edge.z, this.player.level, edge.dir,
          BARRICADE.hpPerPlank, BARRICADE.maxPlanks,
        );
      }
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

  /** Pull something down and hand back most of the wood. */
  _dismantle(target) {
    const level = this.player.level;
    if (target.kind === 'barricade') {
      const got = this.grid.removePlank(target.x, target.z, level, target.dir, BARRICADE.hpPerPlank);
      if (got > 0) this.player.inventory.add(new Item('plank', got));
    } else {
      const i = this.grid.index(target.x, target.z, level);
      this.grid.setObject(target.x, target.z, level, 0);
      this.stations?.byCell.delete(i);
      // Most of it back, not all: taking something apart with a hammer costs
      // you a plank, which is what stops build-and-dismantle being a way to
      // turn time into materials.
      this.player.inventory.add(new Item('plank', RECOVERED_PLANKS));
    }
    this.stats.dismantled++;
    events.emit('dismantled', target);
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
