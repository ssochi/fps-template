/**
 * The player controller.
 *
 * Three things here are genre-specific rather than generic character-controller
 * work, and they are the reason this file exists at all:
 *
 *   1. **Facing is decoupled from movement.** In this genre you back away from
 *      things while still looking at them. The body turns toward the cursor,
 *      not toward the direction of travel, and moving backwards is slower —
 *      which is what makes retreating a real decision rather than a free action.
 *   2. **Exertion is a resource with a hangover.** Sprinting drains endurance;
 *      running it to zero doesn't just stop you, it leaves you winded, and
 *      recovery is slower than the drain. That asymmetry is what turns "should
 *      I run?" into a question.
 *   3. **Doors, stairs and windows are all obstacles you resolve deliberately.**
 *      Walking into a shut door opens it (and costs a moment); climbing through
 *      a window or over a fence is a timed vault you commit to.
 */
import { Vector3 } from 'three';
import { Entity } from './Entity.js';
import { Character, GAITS } from './Character.js';
import { moveOnGrid } from './Walker.js';
import { DIR_VEC, STOREY, worldToTile } from '../core/constants.js';
import { OBJ, objectId } from '../world/Objects.js';
import { events } from '../core/Events.js';
import { Body } from '../sim/Body.js';
import { WeaponInstance } from '../items/Weapons.js';
import { Inventory } from '../items/Container.js';
import { Item } from '../items/ItemDb.js';
import { MOD, Profile } from '../sim/Traits.js';

/**
 * Reverse map from a weapon definition back to the item that carries it, so an
 * unequipped weapon goes back in the bag rather than being destroyed.
 */
const ITEM_FOR_WEAPON = { knife: 'knife', bat: 'bat', axe: 'axe', crowbar: 'crowbar' };

const SPEED = {
  sneak: 1.15,
  walk: 2.6,
  run: 5.0,
};

/** Moving away from where you are facing is slower than moving toward it. */
const BACKPEDAL_FACTOR = 0.55;

const ENDURANCE = {
  /** Units per second while sprinting. Full bar is 1. */
  runDrain: 0.14,
  sneakDrain: 0.02,
  /** Recovery is deliberately slower than the drain. */
  recover: 0.075,
  /** Below this, you are winded: capped at a walk until you recover past it. */
  windedBelow: 0.02,
  windedUntil: 0.3,
};

/** How long a vault through a window or over a fence takes. */
const VAULT_TIME = 0.55;
const DOOR_TIME = 0.3;

/**
 * How long after using a staircase before it will move you again.
 *
 * The two storeys join at one tile column, so without this you would climb and
 * fall in alternate ticks. Long enough to step off the landing at a walk.
 */
const STAIR_COOLDOWN = 0.8;

export class Player extends Entity {
  /**
   * @param {import('../world/TileGrid.js').TileGrid} grid
   * @param {{ colors?: object, profile?: Profile }} [opts]
   */
  constructor(grid, { colors, profile } = {}) {
    super('player');
    this.grid = grid;
    this.radius = 0.26;

    /**
     * Who this survivor chose to be. Defaults to an unmodified one so every
     * call site can multiply unconditionally — see `sim/Traits.js`.
     */
    this.profile = profile ?? Profile.default();

    this.character = new Character(colors);
    this.object.add(this.character.root);

    /** Body-part health, bleeding and infection. */
    this.body = new Body(this.profile);
    /** What is in your hands. */
    this.weapon = new WeaponInstance('crowbar');
    /** What you are carrying. Weight, not slots — see items/Container.js. */
    this.inventory = new Inventory(10 * this.profile.mod(MOD.CARRY_CAPACITY));
    /** Set by main once Moodles exists; injuries and moodles both slow you. */
    this.moodles = null;
    /** Whether the torch in the bag is lit. */
    this.torchOn = false;

    /** 0–1. Depletes when sprinting, recovers slowly. */
    this.endurance = 1;
    /** True while recovering from a full drain — capped at a walk. */
    this.winded = false;

    /** Where the cursor is, in world space. The body turns toward it. */
    this.aimTarget = new Vector3();
    this.hasAim = false;

    /** Counts down after a storey change, so the staircase is not a lift shaft. */
    this._stairCooldown = 0;

    /** Set while a vault or a door is in progress; blocks other input. */
    this.busy = 0;
    this.busyKind = null;

    /** Speed actually achieved last step, for the animator. */
    this.currentSpeed = 0;
    this.gait = 'idle';

    this._delta = new Vector3();
    this._tile = { x: 0, z: 0 };
    this.turnRate = Math.PI * 6; // the player turns fast; the horde does not
  }

  /**
   * @param {object} intent
   * @param {Vector3} intent.move world-space direction, zero-length when idle
   * @param {boolean} intent.run
   * @param {boolean} intent.sneak
   * @param {boolean} intent.interact edge-triggered
   * @param {number} dt
   */
  update(intent, dt) {
    if (this.busy > 0) {
      this.busy -= dt;
      if (this.busy <= 0) this._finishBusy();
      this.currentSpeed = 0;
      this.gait = this.busyKind === 'vault' ? 'walk' : 'idle';
      this._animate(dt);
      return;
    }

    this._face(intent, dt);
    this._move(intent, dt);
    if (intent.interact) this._interact();
    this._animate(dt);
  }

  // --- facing -----------------------------------------------------------

  _face(intent, dt) {
    if (this.hasAim) {
      this.faceTo(this.aimTarget);
    } else if (intent.move.lengthSq() > 1e-6) {
      // Falling back to movement facing keeps the character sane before the
      // pointer has ever moved.
      this.velocity.copy(intent.move);
      this.faceVelocity();
    }
    this.stepTurn(dt);
  }

  // --- movement ---------------------------------------------------------

  _move(intent, dt) {
    const moving = intent.move.lengthSq() > 1e-6;
    if (!moving) {
      this.currentSpeed = 0;
      this.gait = 'idle';
      this._drainEndurance(dt, 'idle');
      return;
    }

    let mode = intent.sneak ? 'sneak' : intent.run ? 'run' : 'walk';
    if (mode === 'run' && (this.winded || this.endurance <= 0)) mode = 'walk';

    // Three separate things slow you down, and they multiply: a wounded leg,
    // the moodles (pain and cold), and how much you decided to carry. All three
    // are consequences of choices the player made, which is the point.
    let speed = SPEED[mode] * this.body.mobility * this.inventory.mobility;
    if (this.moodles) speed *= this.moodles.mobility;
    speed *= this.profile.mod(MOD.WALK_SPEED);

    // Backpedalling: scale by how much the move direction opposes the facing.
    const forward = this.forward(this._delta);
    const alignment = forward.dot(intent.move); // -1 backwards, 1 forwards
    if (alignment < 0) {
      speed *= BACKPEDAL_FACTOR + (1 - BACKPEDAL_FACTOR) * (1 + alignment);
    }

    this._delta.copy(intent.move).multiplyScalar(speed * dt);
    const hit = moveOnGrid(this.grid, this, this._delta.x, this._delta.z, true);

    // Blocked by a shut door? Open it rather than making the player press a key
    // to get through their own front door.
    if (hit.blockedDoor) {
      this._beginDoor(hit.blockedDoor);
      return;
    }

    // Actual speed, which may be less than intended if we scraped a wall.
    this.currentSpeed = hit.hitX && hit.hitZ ? 0 : speed;
    this.gait = this.currentSpeed > 0 ? mode : 'idle';
    this._drainEndurance(dt, this.gait);

    this._checkStairs(dt);
  }

  _drainEndurance(dt, gait) {
    const drain = this.profile.mod(MOD.ENDURANCE_DRAIN);
    let recover = ENDURANCE.recover * this.profile.mod(MOD.ENDURANCE_RECOVERY);
    // Being underfed or dehydrated slows recovery but never the drain — going
    // hungry should not make sprinting cheaper.
    if (this.moodles) recover *= this.moodles.enduranceRecovery;

    if (gait === 'run') this.endurance -= ENDURANCE.runDrain * drain * dt;
    else if (gait === 'sneak') this.endurance -= ENDURANCE.sneakDrain * drain * dt;
    else this.endurance += recover * dt;

    this.endurance = Math.max(0, Math.min(1, this.endurance));

    // Hysteresis: you become winded at empty and stay winded well past it, so
    // the state cannot flicker on and off at the threshold.
    if (this.endurance <= ENDURANCE.windedBelow) this.winded = true;
    else if (this.endurance >= ENDURANCE.windedUntil) this.winded = false;
  }

  // --- storeys ----------------------------------------------------------

  /**
   * Stairs move you a storey when you walk onto the join between two.
   *
   * Both directions go through `TileGrid.climbFrom`/`descendFrom`, which is the
   * same rule the flow field and the sound field use. Before M13 this file had
   * its own: ascent used the top step, descent used the opened ceiling above the
   * *bottom* step — a cell with no floor, which `canWalk` correctly refuses to
   * enter. So going upstairs was a one-way trip, and the test that covered it
   * put the player on the void tile by hand and said so in a comment.
   *
   * The join is one tile column, so a naive check would flip you up and down
   * again every tick. The cooldown is what makes it a staircase rather than a
   * lift shaft: having just used it, you get to stand on it.
   */
  _checkStairs(dt) {
    if (this._stairCooldown > 0) {
      this._stairCooldown -= dt;
      return;
    }
    worldToTile(this.position.x, this.position.z, this._tile);
    const { x, z } = this._tile;

    // Down first. Standing on a landing you are also standing on the top of the
    // flight below, and going down is the direction that was broken.
    let to = this.grid.descendFrom(x, z, this.level);
    if (to < 0) to = this.grid.climbFrom(x, z, this.level);
    if (to < 0 || to === this.level) return;

    this.level = to;
    this._stairCooldown = STAIR_COOLDOWN;
    this.syncLevelHeight();
    events.emit('player:levelChanged', { level: this.level });
  }

  // --- interaction ------------------------------------------------------

  /** E: open/shut the nearest door, or vault the obstacle you are facing. */
  _interact() {
    worldToTile(this.position.x, this.position.z, this._tile);
    const { x, z } = this._tile;

    // Nearest door on any of this tile's four edges, or the tile itself.
    for (let dir = 0; dir < 4; dir++) {
      const v = DIR_VEC[dir];
      const tile = this.grid.doorTile(x, z, x + v.dx, z + v.dz, this.level);
      if (!tile) continue;
      const open = this.grid.isDoorOpen(x, z, x + v.dx, z + v.dz, this.level);
      this._beginDoor({ ...tile, open: !open });
      return;
    }

    // Otherwise try to vault whatever is directly ahead.
    const f = this.forward(this._delta);
    const dir = Math.abs(f.x) > Math.abs(f.z) ? (f.x > 0 ? 1 : 3) : f.z > 0 ? 2 : 0;
    const v = DIR_VEC[dir];
    if (this.grid.canClimb(x, z, x + v.dx, z + v.dz, this.level)) {
      this._beginVault(x + v.dx, z + v.dz);
    }
  }

  _beginDoor({ x, z, open }) {
    this.busy = DOOR_TIME;
    this.busyKind = 'door';
    this._pending = { type: 'door', x, z, open: open ?? true };
  }

  _beginVault(tx, tz) {
    this.busy = VAULT_TIME;
    this.busyKind = 'vault';
    this._pending = { type: 'vault', x: tx, z: tz };
  }

  _finishBusy() {
    this.busy = 0;
    this.busyKind = null;
    const p = this._pending;
    this._pending = null;
    if (!p) return;

    if (p.type === 'door') {
      if (this.grid.setDoorOpen(p.x, p.z, this.level, p.open)) {
        // Doors are loud. M5's horde listens for this.
        events.emit('noise:made', {
          x: p.x, z: p.z, level: this.level,
          loudness: (p.open ? 6 : 4) * this.noiseScale, source: 'door',
        });
      }
    } else if (p.type === 'vault') {
      this.position.set(p.x + 0.5, this.level * STOREY, p.z + 0.5);
      this.endurance = Math.max(0, this.endurance - 0.05);
      events.emit('noise:made', {
        x: p.x, z: p.z, level: this.level, loudness: 5 * this.noiseScale, source: 'vault',
      });
    }
  }

  // --- presentation -----------------------------------------------------

  _animate(dt) {
    this.character.update(dt, this.currentSpeed, this.gait);
    this.character.look(0);
  }

  /**
   * Eat or drink something.
   * @param {import('../items/ItemDb.js').Item} item
   * @returns {boolean} whether it was consumed
   */
  consume(item) {
    if (!this.moodles || item.spoiled) return false;
    if (item.nutrition <= 0 && item.hydration <= 0) return false;

    this.moodles.eat(item.nutrition);
    this.moodles.drink(item.hydration);
    this.inventory.remove(item, 1);
    events.emit('player:ate', { id: item.id, nutrition: item.nutrition });
    return true;
  }

  /**
   * Swap what is in your hands for something in your bag.
   * The old weapon goes back into the bag rather than vanishing — losing an axe
   * because you picked up a knife would be a bad surprise.
   */
  equip(item) {
    if (!item.def.weaponId) return false;
    const previous = this.weapon;
    this.weapon = new WeaponInstance(item.def.weaponId);
    this.inventory.remove(item, 1);
    if (previous && previous.def.id !== 'fists') {
      const back = ITEM_FOR_WEAPON[previous.def.id];
      if (back) this.inventory.add(new Item(back));
    }
    events.emit('player:equipped', { id: item.def.weaponId });
    return true;
  }

  /** Apply a bandage or first aid kit to whatever is worst. */
  useMedical(item) {
    const def = item.def;

    // Painkillers do not mend anything; they take the pain away for a while,
    // which is a real decision because pain is what is slowing your legs and
    // spoiling your swing.
    if (item.id === 'painkillers') {
      this.body.pain = Math.max(0, this.body.pain - 45);
      this.inventory.remove(item, 1);
      events.emit('player:treated', { part: -1, id: item.id });
      return true;
    }

    if (!def.stopsBleeding && !def.heal) return false;

    // Treat the part that is actually in trouble, not a menu selection: the
    // player already knows which limb hurts, and making them say so is friction.
    let worst = 0;
    let worstScore = -Infinity;
    for (let i = 0; i < 6; i++) {
      const score = this.body.bleed[i] * 100 + (100 - this.body.health[i]);
      if (score > worstScore) {
        worstScore = score;
        worst = i;
      }
    }
    // A fraction, not a subtraction: a dressing works the same way on a
    // scratch and on a deep wound. Only a full kit stops a bleed outright.
    if (def.stopsBleeding) this.body.bleed[worst] *= 1 - def.stopsBleeding;
    if (def.heal) this.body.health[worst] = Math.min(100, this.body.health[worst] + def.heal);
    this.inventory.remove(item, 1);
    events.emit('player:treated', { part: worst, id: item.id });
    return true;
  }

  /** Is there a torch in the bag to light? */
  get hasTorch() {
    return this.inventory.countOf('torch') > 0;
  }

  toggleTorch() {
    if (!this.hasTorch) {
      this.torchOn = false;
      return false;
    }
    this.torchOn = !this.torchOn;
    // Light is not free: it is the loudest thing you can do without a hammer,
    // in the sense that it is the most visible.
    events.emit('torch:toggled', { on: this.torchOn });
    return this.torchOn;
  }

  /**
   * How loud everything this survivor does is.
   *
   * One getter, applied at every point where *the player* emits noise — doors,
   * vaults, swings, hammering. It is the only place traits and the Sneaking
   * skill meet, and it exists because before M12 `Skills.noiseScale` was
   * computed and read by nobody: sneaking levelled up and changed nothing.
   *
   * Zombie and siege noise deliberately does not pass through here.
   */
  get noiseScale() {
    return this.profile.mod(MOD.NOISE) * (this.skills?.noiseScale ?? 1);
  }

  /** Metres per second the player would move right now, for the HUD. */
  get topSpeed() {
    if (this.winded) return SPEED.walk;
    return SPEED.run;
  }
}

export { SPEED, ENDURANCE, GAITS };
