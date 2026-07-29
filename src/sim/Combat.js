/**
 * Combat resolution — both directions.
 *
 * This system owns damage, so it is also the one that decides when a zombie is
 * close enough to bite. That keeps `Horde` free of any knowledge of the player
 * beyond a line-of-sight test: the dead pursue a gradient and Combat notices
 * when one of them has arrived.
 *
 * ## The shape of a fight
 *
 * A swing locks you in place for its duration and costs endurance. That is the
 * whole balance: every weapon is strong enough to kill, and the question is
 * whether you can afford the seconds and the stamina while the rest of the crowd
 * closes. Fighting three is a decision; fighting eight is a mistake you are
 * already committed to.
 *
 * Shoving deals no damage at all and exists because "I need one more second" is
 * a real thing to want and should have an answer that is not violence.
 */
import { SHOVE } from '../items/Weapons.js';
import { STATE } from './Horde.js';
import { events } from '../core/Events.js';
import { worldToTile } from '../core/constants.js';

/** How close a zombie must be to land a bite. */
const REACH = 0.95;
/** Seconds of windup before a zombie's swing connects. */
const ZOMBIE_WINDUP = 0.45;
/** Seconds before the same zombie can try again. */
const ZOMBIE_COOLDOWN = 1.4;
/** Damage from a successful attack. */
const ZOMBIE_DAMAGE = { bite: 14, scratch: 7 };
/** Chance an attack is a bite rather than a scratch. */
const BITE_CHANCE = 0.35;

export class Combat {
  /**
   * @param {import('./Horde.js').Horde} horde
   * @param {import('../entity/Player.js').Player} player
   * @param {() => number} [roll] injectable RNG, so fights are testable
   */
  constructor(horde, player, roll = Math.random) {
    this.horde = horde;
    this.player = player;
    this.roll = roll;
    /** Zombies whose windup is resolving, as [index, secondsLeft] pairs. */
    this._pending = [];
    this.stats = { swings: 0, hits: 0, kills: 0, bitten: 0, scratched: 0 };
  }

  /**
   * Resolve a player swing.
   *
   * @param {'attack'|'shove'} kind
   * @returns {{ hits: number, kills: number, blocked: boolean }}
   */
  swing(kind) {
    const player = this.player;
    if (!player.body.alive) return { hits: 0, kills: 0, blocked: true };

    const spec = kind === 'shove' ? SHOVE : player.weapon.def;
    // Endurance is the real limit on melee. Below the cost you simply cannot
    // swing, which is what turns a long fight into a losing one.
    if (player.endurance < spec.stamina) return { hits: 0, kills: 0, blocked: true };

    player.endurance = Math.max(0, player.endurance - spec.stamina);
    player.busy = spec.swingTime;
    player.busyKind = kind;
    this.stats.swings++;

    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    // Injured arms swing shorter and softer; this is where a wound is felt.
    const dexterity = player.body.dexterity;
    const range = spec.range * (0.75 + 0.25 * dexterity);
    const cosArc = Math.cos(spec.arc);

    const targets = this._targetsInArc(fx, fz, range, cosArc, spec.targets);

    let hits = 0;
    let kills = 0;
    for (const { index, dx, dz, dist } of targets) {
      const nx = dx / (dist || 1);
      const nz = dz / (dist || 1);

      if (kind === 'shove') {
        const down = this.roll() < SHOVE.knockdown;
        this.horde.stagger(index, down ? 1.6 : 0.5, {
          dirX: nx,
          dirZ: nz,
          knockback: SHOVE.knockback,
        });
      } else {
        const damage = player.weapon.effectiveDamage() * (0.7 + 0.3 * dexterity);
        const result = this.horde.damage(index, damage, {
          knockback: spec.knockback,
          dirX: nx,
          dirZ: nz,
          dismemberChance: spec.dismember,
          roll: this.roll,
        });
        if (result.killed) kills++;
        if (player.weapon.wear(this.roll)) {
          events.emit('weapon:broke', { id: player.weapon.def.id });
        }
      }
      hits++;
    }

    this.stats.hits += hits;
    this.stats.kills += kills;

    const tile = worldToTile(player.position.x, player.position.z);
    events.emit('noise:made', {
      x: tile.x,
      z: tile.z,
      level: player.level,
      loudness: spec.noise,
      source: kind,
    });

    return { hits, kills, blocked: false };
  }

  /** Zombies within reach and inside the swing arc, nearest first. */
  _targetsInArc(fx, fz, range, cosArc, maxTargets) {
    const horde = this.horde;
    const px = this.player.position.x;
    const pz = this.player.position.z;
    const level = this.player.level;
    const found = [];

    for (let i = 0; i < horde.count; i++) {
      if (horde.state[i] === STATE.DEAD) continue;
      if (horde.level[i] !== level) continue;

      const dx = horde.x[i] - px;
      const dz = horde.z[i] - pz;
      const dist = Math.hypot(dx, dz);
      if (dist > range) continue;
      // A zombie standing on top of you is always in the arc; otherwise it has
      // to be in front. Without the exception, being grabbed makes you unable
      // to hit the thing grabbing you.
      if (dist > 0.35 && (dx / dist) * fx + (dz / dist) * fz < cosArc) continue;

      found.push({ index: i, dx, dz, dist });
    }

    found.sort((a, b) => a.dist - b.dist);
    return found.slice(0, maxTargets);
  }

  /**
   * Let the dead take their turn: start swings for anyone in reach, and land
   * the ones whose windup has elapsed.
   *
   * @param {number} dt
   */
  update(dt) {
    const player = this.player;
    if (!player.body.alive) return;

    // Resolve windups that have completed.
    for (let p = this._pending.length - 1; p >= 0; p--) {
      const entry = this._pending[p];
      entry.time -= dt;
      if (entry.time > 0) continue;
      this._pending.splice(p, 1);
      this._land(entry.index);
    }

    const horde = this.horde;
    const px = player.position.x;
    const pz = player.position.z;

    for (let i = 0; i < horde.count; i++) {
      if (!horde.isReady(i)) continue;
      if (horde.level[i] !== player.level) continue;
      if (horde.state[i] !== STATE.CHASE) continue;

      const dx = px - horde.x[i];
      const dz = pz - horde.z[i];
      if (dx * dx + dz * dz > REACH * REACH) continue;

      horde.yaw[i] = Math.atan2(-dx, -dz);
      horde.beginAttack(i, ZOMBIE_WINDUP, ZOMBIE_COOLDOWN);
      this._pending.push({ index: i, time: ZOMBIE_WINDUP });
    }
  }

  /**
   * A zombie's windup completed. It only connects if the player is still in
   * reach — the windup is the window in which backing away or shoving works.
   */
  _land(index) {
    const player = this.player;
    const horde = this.horde;
    if (!player.body.alive || horde.isDead(index)) return;

    const dx = player.position.x - horde.x[index];
    const dz = player.position.z - horde.z[index];
    if (dx * dx + dz * dz > REACH * REACH * 1.6) return; // they got away

    const bite = this.roll() < BITE_CHANCE;
    const kind = bite ? 'bite' : 'scratch';
    const result = player.body.hurt({
      amount: ZOMBIE_DAMAGE[kind],
      kind,
      bleed: bite ? 0.9 : 0.35,
      roll: this.roll,
    });

    if (bite) this.stats.bitten++;
    else this.stats.scratched++;

    events.emit('player:wounded', { kind, part: result.part, infected: result.infected });
  }
}

export { REACH, ZOMBIE_WINDUP, ZOMBIE_COOLDOWN, ZOMBIE_DAMAGE, BITE_CHANCE };
