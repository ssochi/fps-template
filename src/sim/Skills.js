/**
 * Skills.
 *
 * ## You get better at what you do, not at what you chose
 *
 * There is no skill tree and nothing to spend. Swinging a bat raises Blunt;
 * boarding windows raises Carpentry; searching containers raises Scavenging.
 * That is the reference game's model and it is the right one for a survival sim,
 * because it means your character sheet is a *record of how you have been
 * playing* rather than a plan you committed to in a menu on day one.
 *
 * ## The curve exists to make early levels feel like something
 *
 * Each level costs more than the last, and the first two come quickly. A player
 * who picks up an axe should feel the difference within one fight; a player
 * aiming at level 8 should be looking at weeks. Both are served by an
 * exponential curve and neither is served by a linear one.
 *
 * ## Every skill changes a number some other system already reads
 *
 * Same rule the moodles are held to. A skill that only appears on a sheet is
 * cut.
 */
import { events } from '../core/Events.js';

export const SKILL = {
  BLUNT: 'blunt',
  BLADE: 'blade',
  FITNESS: 'fitness',
  SNEAK: 'sneak',
  CARPENTRY: 'carpentry',
  SCAVENGING: 'scavenging',
  FIRSTAID: 'firstAid',
  COOKING: 'cooking',
};

/** What each skill does, so the effect is stated next to the name. */
export const SKILL_INFO = {
  [SKILL.BLUNT]: { name: 'Blunt', effect: 'damage with bats, crowbars and fists' },
  [SKILL.BLADE]: { name: 'Blade', effect: 'damage with knives and axes' },
  [SKILL.FITNESS]: { name: 'Fitness', effect: 'endurance drain and recovery' },
  [SKILL.SNEAK]: { name: 'Sneaking', effect: 'how far your noise carries' },
  [SKILL.CARPENTRY]: { name: 'Carpentry', effect: 'barricade strength and build speed' },
  [SKILL.SCAVENGING]: { name: 'Scavenging', effect: 'how much a container yields' },
  [SKILL.FIRSTAID]: { name: 'First Aid', effect: 'how well dressings work' },
  [SKILL.COOKING]: { name: 'Cooking', effect: 'how much food a cooked meal is worth' },
};

/** Which skill a weapon trains. */
export const WEAPON_SKILL = {
  fists: SKILL.BLUNT,
  bat: SKILL.BLUNT,
  crowbar: SKILL.BLUNT,
  knife: SKILL.BLADE,
  axe: SKILL.BLADE,
};

export const MAX_LEVEL = 10;
/** XP needed to reach level n from n-1. */
const BASE_COST = 30;
const GROWTH = 1.55;

/** Total XP required to reach a level from zero. */
export function xpForLevel(level) {
  let total = 0;
  for (let l = 1; l <= level; l++) total += Math.round(BASE_COST * GROWTH ** (l - 1));
  return total;
}

export class Skills {
  constructor() {
    /** @type {Record<string, number>} */
    this.xp = {};
    for (const id of Object.values(SKILL)) this.xp[id] = 0;
    /**
     * Multiplier on XP gain. An occupation or trait can bias this; nothing
     * does yet, but every rate in the game reads from one place by convention.
     */
    this.rate = 1;
  }

  /** @returns {number} 0–MAX_LEVEL */
  level(id) {
    const xp = this.xp[id] ?? 0;
    let level = 0;
    while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
    return level;
  }

  /** Progress through the current level, 0–1, for a bar. */
  progress(id) {
    const level = this.level(id);
    if (level >= MAX_LEVEL) return 1;
    const from = xpForLevel(level);
    const to = xpForLevel(level + 1);
    return (this.xp[id] - from) / (to - from);
  }

  /**
   * Award experience. Emits `skill:levelled` when a level is crossed, so the
   * HUD can say so without polling.
   * @returns {boolean} whether a level was gained
   */
  award(id, amount) {
    if (!(id in this.xp)) return false;
    const before = this.level(id);
    this.xp[id] += amount * this.rate;
    const after = this.level(id);
    if (after > before) {
      events.emit('skill:levelled', { id, level: after, name: SKILL_INFO[id].name });
      return true;
    }
    return false;
  }

  // --- effects other systems read ---------------------------------------
  // Each returns a plain multiplier so callers do not have to know the curve.

  /** Damage multiplier for a weapon, from the skill it trains. */
  weaponDamage(weaponId) {
    const skill = WEAPON_SKILL[weaponId] ?? SKILL.BLUNT;
    // +8% per level: at level 10 a weapon hits about 1.8x, which is meaningful
    // without making an unskilled survivor unable to fight at all.
    return 1 + this.level(skill) * 0.08;
  }

  /** Endurance cost multiplier — fitness makes swinging cheaper. */
  get exertionCost() {
    return Math.max(0.45, 1 - this.level(SKILL.FITNESS) * 0.055);
  }

  /** How loud you are. Sneaking makes your noise carry less far. */
  get noiseScale() {
    return Math.max(0.35, 1 - this.level(SKILL.SNEAK) * 0.065);
  }

  /** Extra health per plank, from carpentry. */
  get barricadeStrength() {
    return 1 + this.level(SKILL.CARPENTRY) * 0.12;
  }

  /** Build speed multiplier. */
  get buildSpeed() {
    return 1 + this.level(SKILL.CARPENTRY) * 0.09;
  }

  /** Extra draws from a container. */
  get scavengeBonus() {
    return this.level(SKILL.SCAVENGING) * 0.14;
  }

  /** How much better dressings work. */
  get firstAidQuality() {
    return 1 + this.level(SKILL.FIRSTAID) * 0.06;
  }

  /** How much of a cooked meal you actually get. */
  get cookQuality() {
    return 1 + this.level(SKILL.COOKING) * 0.07;
  }

  /** Everything the character sheet shows. */
  summary() {
    return Object.values(SKILL).map((id) => ({
      id,
      name: SKILL_INFO[id].name,
      effect: SKILL_INFO[id].effect,
      level: this.level(id),
      progress: this.progress(id),
    }));
  }

  /** Serialisable state, for saves. */
  toJSON() {
    return { xp: { ...this.xp } };
  }

  static fromJSON(data) {
    const s = new Skills();
    if (data?.xp) Object.assign(s.xp, data.xp);
    return s;
  }
}

/** XP awarded for the things the player does. Tuned so early levels come fast. */
export const XP = {
  hit: 2.2,
  kill: 9,
  /** Per second of running. */
  run: 0.7,
  /** Per second spent sneaking while something can see you. */
  sneak: 1.4,
  plank: 14,
  craft: 6,
  search: 3.5,
  treat: 8,
  cook: 7,
};
