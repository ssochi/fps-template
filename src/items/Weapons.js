/**
 * Melee weapons.
 *
 * The interesting axis in this genre is not damage, it is **whether a weapon
 * lets you fight a crowd or only a straggler**. A long, wide, fast weapon that
 * hits several targets is how you survive being surrounded; a heavy one that
 * kills in a single blow is how you deal with one zombie quietly. Every stat
 * below exists to make that a real trade rather than a strictly-better ladder:
 *
 *   - `arc` and `targets` decide whether you can hold a doorway.
 *   - `stamina` decides how long you can keep it up — the real limit on melee.
 *   - `durability` decides whether you can afford to use it on trash.
 *   - `noise` decides how many more arrive because you used it.
 *
 * The full item database is M8's job; this is the subset combat needs.
 */

/**
 * @typedef {object} Weapon
 * @property {string} id
 * @property {string} name
 * @property {number} damage       health removed from a zombie per hit
 * @property {number} range        metres from the player's centre
 * @property {number} arc          half-angle in radians
 * @property {number} targets      how many zombies one swing can hit
 * @property {number} swingTime    seconds the swing locks you in place
 * @property {number} stamina      endurance cost per swing, 0–1
 * @property {number} knockback    metres the target is pushed
 * @property {number} durability   swings before it breaks; Infinity for fists
 * @property {number} breakChance  chance per hit of losing a point of condition
 * @property {number} noise        loudness emitted per swing
 * @property {number} dismember    chance a killing blow takes a limb off
 */

/** @type {Record<string, Weapon>} */
export const WEAPONS = {
  fists: {
    id: 'fists',
    name: 'bare hands',
    damage: 8,
    range: 0.95,
    arc: 0.5,
    targets: 1,
    swingTime: 0.42,
    stamina: 0.035,
    knockback: 0.25,
    durability: Infinity,
    breakChance: 0,
    noise: 2,
    dismember: 0,
  },
  knife: {
    id: 'knife',
    name: 'kitchen knife',
    damage: 34,
    range: 1.0,
    arc: 0.42,
    targets: 1,
    swingTime: 0.34,
    stamina: 0.03,
    knockback: 0.1,
    // Fast and lethal, but it is a kitchen knife: it will not survive a crowd.
    durability: 22,
    breakChance: 0.55,
    noise: 3,
    dismember: 0.05,
  },
  bat: {
    id: 'bat',
    name: 'baseball bat',
    damage: 26,
    range: 1.55,
    arc: 0.95,
    targets: 3,
    swingTime: 0.62,
    stamina: 0.075,
    knockback: 0.9,
    durability: 180,
    breakChance: 0.14,
    noise: 7,
    dismember: 0.04,
  },
  axe: {
    id: 'axe',
    name: 'fire axe',
    damage: 62,
    range: 1.45,
    arc: 0.7,
    targets: 2,
    swingTime: 0.85,
    stamina: 0.115,
    knockback: 0.7,
    durability: 260,
    breakChance: 0.1,
    noise: 9,
    dismember: 0.35,
  },
  crowbar: {
    id: 'crowbar',
    name: 'crowbar',
    damage: 30,
    range: 1.35,
    arc: 0.75,
    targets: 2,
    swingTime: 0.58,
    stamina: 0.07,
    knockback: 0.7,
    // The reference game's quiet favourite: mediocre at everything, and it
    // essentially never breaks, which over a long run beats being good.
    durability: 900,
    breakChance: 0.03,
    noise: 6,
    dismember: 0.08,
  },
};

/** A shove is not a weapon — no damage, cheap, and it buys you a step back. */
export const SHOVE = {
  range: 1.25,
  arc: 1.0,
  targets: 4,
  swingTime: 0.3,
  stamina: 0.045,
  knockback: 1.6,
  /** Chance per target of knocking it down instead of merely back. */
  knockdown: 0.3,
  noise: 3,
};

/** A weapon instance the player carries, tracking its own wear. */
export class WeaponInstance {
  /** @param {string} id */
  constructor(id) {
    this.def = WEAPONS[id] ?? WEAPONS.fists;
    this.condition = this.def.durability;
  }

  get broken() {
    return this.condition <= 0;
  }

  /** @returns {number} 0–1, for the HUD */
  get conditionFraction() {
    return Number.isFinite(this.def.durability) ? this.condition / this.def.durability : 1;
  }

  /**
   * Wear the weapon by one hit.
   * @param {() => number} roll
   * @returns {boolean} whether it broke on this hit
   */
  wear(roll = Math.random) {
    if (!Number.isFinite(this.def.durability)) return false;
    if (roll() < this.def.breakChance) this.condition -= 1;
    return this.broken;
  }

  /** Damage now, accounting for wear — a blunted weapon hits softer. */
  effectiveDamage() {
    if (this.broken) return WEAPONS.fists.damage;
    // Only the last quarter of a weapon's life degrades its damage, so the stat
    // stays legible until the point where the player should be looking for a
    // replacement anyway.
    const f = this.conditionFraction;
    const falloff = f >= 0.25 ? 1 : 0.6 + f * 1.6;
    return this.def.damage * falloff;
  }
}
