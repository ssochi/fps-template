/**
 * Character creation — occupations and traits.
 *
 * ## The rule this is built to
 *
 * **Every trait must multiply a number some system already reads.** This is the
 * same rule the moodles were held to in M7 and the skills in M10, and it is the
 * reason this file is a table rather than a framework: a trait cannot express
 * anything the simulation does not already simulate. "Lucky" is not a trait here
 * because nothing in the game rolls against luck; "Light-footed" is, because M5's
 * sound field has a loudness input and this scales it.
 *
 * Concretely: {@link MOD} is a closed list of sixteen multipliers, every one of
 * which is consumed by an existing system. Adding a seventeenth means changing
 * that system first. The test suite asserts each one moves an observable number.
 *
 * ## Traits are a budget, not a menu
 *
 * You get a small number of points and negative traits are how you afford the
 * positive ones. That makes creation a set of *trades* rather than a wish list —
 * you do not pick Strong, you decide what you are willing to be bad at in order
 * to be strong. An occupation seeds starting skills and costs you the points you
 * would otherwise have had, which is why Unemployed is a real choice rather than
 * a null one.
 *
 * ## One trait per axis
 *
 * Traits declare an `axis`, and you may hold only one from each. That is what
 * stops "Athletic + Out of shape" being a free eleven points, without needing a
 * hand-maintained table of conflicting pairs.
 */
import { xpForLevel } from './Skills.js';

/**
 * The closed list of things a trait may change. Each names the system that
 * reads it, because a modifier nobody reads is the failure mode this list
 * exists to prevent.
 */
export const MOD = {
  /** `entity/Player.js` — metres per second at every gait. */
  WALK_SPEED: 'walkSpeed',
  /** `entity/Player.js` — endurance spent while running and sneaking. */
  ENDURANCE_DRAIN: 'enduranceDrain',
  /** `entity/Player.js` — endurance regained while walking and standing. */
  ENDURANCE_RECOVERY: 'enduranceRecovery',
  /** `items/Container.js` — kilograms before you start moving like it. */
  CARRY_CAPACITY: 'carryCapacity',
  /** `sim/Combat.js` — damage per landed swing. */
  MELEE_DAMAGE: 'meleeDamage',
  /** `sim/Sound.js`, via every `noise:made` emission — how far you carry. */
  NOISE: 'noise',
  /** `render/FogOfWar.js` — how far you can see. */
  SIGHT_RANGE: 'sightRange',
  /** `sim/Body.js` — bleed rate added by a wound. */
  BLEED_RATE: 'bleedRate',
  /** `sim/Body.js` — chance a bite or scratch takes hold. */
  INFECTION_RISK: 'infectionRisk',
  /** `sim/Body.js` — pain accumulated per point of damage. */
  PAIN_RATE: 'painRate',
  /** `sim/Body.js` — natural healing on an untended part. */
  HEAL_RATE: 'healRate',
  /** `sim/Moodles.js` */
  HUNGER_RATE: 'hungerRate',
  /** `sim/Moodles.js` */
  THIRST_RATE: 'thirstRate',
  /** `sim/Moodles.js` */
  FATIGUE_RATE: 'fatigueRate',
  /** `sim/Moodles.js` — how fast fear rises and how slowly it settles. */
  PANIC_RATE: 'panicRate',
  /** `sim/Skills.js` — the `rate` hook that has been unused since M10. */
  XP_RATE: 'xpRate',
};

/** Points you start with before an occupation adjusts it. */
export const BASE_POINTS = 6;

/**
 * The traits. `cost` is points spent; negative traits have a negative cost and
 * are how you pay for the rest. `axis` groups mutually exclusive choices.
 */
export const TRAITS = [
  // --- positive ---------------------------------------------------------
  { id: 'athletic', name: 'Athletic', axis: 'fitness', cost: 6,
    desc: 'Faster on your feet, and cheaper to run',
    mods: { walkSpeed: 1.12, enduranceDrain: 0.72 }, skills: { fitness: 1 } },
  { id: 'strong', name: 'Strong', axis: 'strength', cost: 6,
    desc: 'Hits harder',
    mods: { meleeDamage: 1.28 } },
  { id: 'packMule', name: 'Pack Mule', axis: 'carry', cost: 4,
    desc: 'Carries a third again before it slows you',
    mods: { carryCapacity: 1.32 } },
  { id: 'lightFooted', name: 'Light-footed', axis: 'noise', cost: 5,
    desc: 'Your noise carries far less',
    mods: { noise: 0.6 } },
  { id: 'eagleEyed', name: 'Eagle-eyed', axis: 'sight', cost: 4,
    desc: 'Sees further',
    mods: { sightRange: 1.28 } },
  { id: 'fastHealer', name: 'Fast Healer', axis: 'healing', cost: 5,
    desc: 'Mends quicker and clots sooner',
    mods: { healRate: 1.9, bleedRate: 0.72 } },
  { id: 'resilient', name: 'Resilient', axis: 'immunity', cost: 9,
    desc: 'A bite is not always the end',
    mods: { infectionRisk: 0.5 } },
  { id: 'ironGut', name: 'Iron Gut', axis: 'appetite', cost: 3,
    desc: 'Eats less often',
    mods: { hungerRate: 0.7 } },
  { id: 'camel', name: 'Camel', axis: 'thirst', cost: 3,
    desc: 'Drinks less often',
    mods: { thirstRate: 0.72 } },
  { id: 'brave', name: 'Brave', axis: 'nerve', cost: 4,
    desc: 'Keeps their hands steady with the dead in the room',
    mods: { panicRate: 0.55 } },
  { id: 'painTolerant', name: 'High Pain Threshold', axis: 'pain', cost: 4,
    desc: 'Injuries hurt less, so they cost you less',
    mods: { painRate: 0.6 } },
  { id: 'wakeful', name: 'Wakeful', axis: 'rest', cost: 4,
    desc: 'Tires slowly',
    mods: { fatigueRate: 0.72 } },
  { id: 'fastLearner', name: 'Fast Learner', axis: 'learning', cost: 6,
    desc: 'Everything you do teaches you more',
    mods: { xpRate: 1.3 } },

  // --- negative ---------------------------------------------------------
  { id: 'outOfShape', name: 'Out of Shape', axis: 'fitness', cost: -6,
    desc: 'Slower, and running costs far more',
    mods: { walkSpeed: 0.9, enduranceDrain: 1.5, enduranceRecovery: 0.8 } },
  { id: 'feeble', name: 'Feeble', axis: 'strength', cost: -6,
    desc: 'Hits like it is an apology',
    mods: { meleeDamage: 0.74 } },
  { id: 'weakShoulders', name: 'Weak Shoulders', axis: 'carry', cost: -4,
    desc: 'Loaded down far sooner',
    mods: { carryCapacity: 0.74 } },
  { id: 'clumsy', name: 'Clumsy', axis: 'noise', cost: -5,
    desc: 'Everything you do is heard further away',
    mods: { noise: 1.55 } },
  { id: 'shortSighted', name: 'Short-sighted', axis: 'sight', cost: -4,
    desc: 'You will meet them closer than you would like',
    mods: { sightRange: 0.7 } },
  { id: 'slowHealer', name: 'Slow Healer', axis: 'healing', cost: -4,
    desc: 'Wounds linger and bleed longer',
    mods: { healRate: 0.5, bleedRate: 1.4 } },
  { id: 'thinSkinned', name: 'Thin-skinned', axis: 'immunity', cost: -6,
    desc: 'A scratch is very nearly a bite',
    mods: { infectionRisk: 1.5 } },
  { id: 'heartyAppetite', name: 'Hearty Appetite', axis: 'appetite', cost: -4,
    desc: 'Hungry again far too soon',
    mods: { hungerRate: 1.5 } },
  { id: 'parched', name: 'Always Thirsty', axis: 'thirst', cost: -3,
    desc: 'Water runs out faster than anything else',
    mods: { thirstRate: 1.45 } },
  { id: 'cowardly', name: 'Cowardly', axis: 'nerve', cost: -4,
    desc: 'Panics early and settles late',
    mods: { panicRate: 1.65 } },
  { id: 'sensitive', name: 'Sensitive to Pain', axis: 'pain', cost: -4,
    desc: 'Every injury costs you more than it should',
    mods: { painRate: 1.55 } },
  { id: 'restless', name: 'Restless', axis: 'rest', cost: -4,
    desc: 'Tires quickly',
    mods: { fatigueRate: 1.4 } },
  { id: 'slowLearner', name: 'Slow Learner', axis: 'learning', cost: -6,
    desc: 'Experience is wasted on you',
    mods: { xpRate: 0.72 } },
];

/** Indexed for lookup. */
export const TRAIT_BY_ID = new Map(TRAITS.map((t) => [t.id, t]));

/**
 * Occupations. `points` adjusts the budget — Unemployed is the only one that
 * adds, which is what makes "no training at all" a live choice rather than a
 * penalty box.
 */
export const OCCUPATIONS = [
  { id: 'unemployed', name: 'Unemployed', points: 8, skills: {},
    desc: 'No training and nothing to fall back on — but eight more points to spend' },
  { id: 'carpenter', name: 'Carpenter', points: 0, skills: { carpentry: 3 },
    desc: 'Boards a window fast, and it holds' },
  { id: 'police', name: 'Police Officer', points: 0, skills: { blunt: 3, fitness: 1 },
    desc: 'Trained to swing something heavy at something coming toward you' },
  { id: 'burglar', name: 'Burglar', points: 0, skills: { sneak: 4 },
    desc: 'Has spent a career not being heard' },
  { id: 'nurse', name: 'Nurse', points: 0, skills: { firstAid: 4 },
    desc: 'Knows what to do about the bleeding' },
  { id: 'lumberjack', name: 'Lumberjack', points: 0, skills: { blade: 3, fitness: 1 },
    desc: 'An axe is a tool, and they have used one all their life' },
  { id: 'trainer', name: 'Fitness Instructor', points: 0, skills: { fitness: 4 },
    desc: 'Can still be running when everyone else has stopped' },
  { id: 'security', name: 'Security Guard', points: 1, skills: { sneak: 2, fitness: 2 },
    desc: 'Night shifts, quiet corridors, and a torch' },
  { id: 'scavenger', name: 'Waste Picker', points: 0, skills: { scavenging: 4 },
    desc: 'Finds the thing at the back of the cupboard' },
];

export const OCCUPATION_BY_ID = new Map(OCCUPATIONS.map((o) => [o.id, o]));

/**
 * A finished character: who you chose to be, expressed as a bag of multipliers
 * the rest of the game reads.
 *
 * Systems never ask "does this character have Athletic?" — they ask
 * `profile.mod(MOD.WALK_SPEED)` and get 1 when the answer is no. That is what
 * keeps every trait's cost to exactly one multiplication at one call site.
 */
export class Profile {
  constructor({ name = 'Survivor', occupation = 'unemployed', traits = [] } = {}) {
    this.name = name;
    this.occupation = occupation;
    /** @type {string[]} */
    this.traits = traits.filter((id) => TRAIT_BY_ID.has(id));
    this._mods = null;
  }

  /** The occupation record, falling back to Unemployed for unknown ids. */
  get job() {
    return OCCUPATION_BY_ID.get(this.occupation) ?? OCCUPATIONS[0];
  }

  /** @returns {Array<typeof TRAITS[number]>} */
  get chosen() {
    return this.traits.map((id) => TRAIT_BY_ID.get(id)).filter(Boolean);
  }

  /** Points available, after the occupation. */
  get budget() {
    return BASE_POINTS + this.job.points;
  }

  /** Points spent. Negative traits refund, so this can be below zero. */
  get spent() {
    let total = 0;
    for (const t of this.chosen) total += t.cost;
    return total;
  }

  get remaining() {
    return this.budget - this.spent;
  }

  /** A build is legal when it is inside budget and holds one trait per axis. */
  get valid() {
    if (this.remaining < 0) return false;
    const axes = new Set();
    for (const t of this.chosen) {
      if (axes.has(t.axis)) return false;
      axes.add(t.axis);
    }
    return true;
  }

  /** Why `add` refused, or null if it would be accepted. */
  refuses(id) {
    const trait = TRAIT_BY_ID.get(id);
    if (!trait) return 'no such trait';
    if (this.traits.includes(id)) return 'already taken';
    for (const t of this.chosen) {
      if (t.axis === trait.axis) return `conflicts with ${t.name}`;
    }
    if (trait.cost > this.remaining) return 'not enough points';
    return null;
  }

  add(id) {
    if (this.refuses(id)) return false;
    this.traits.push(id);
    this._mods = null;
    return true;
  }

  remove(id) {
    const at = this.traits.indexOf(id);
    if (at < 0) return false;
    this.traits.splice(at, 1);
    this._mods = null;
    return true;
  }

  toggle(id) {
    return this.traits.includes(id) ? this.remove(id) : this.add(id);
  }

  /** Every modifier, multiplied together. Cached until the traits change. */
  get mods() {
    if (this._mods) return this._mods;
    const out = {};
    for (const key of Object.values(MOD)) out[key] = 1;
    for (const t of this.chosen) {
      for (const [key, value] of Object.entries(t.mods ?? {})) {
        out[key] = (out[key] ?? 1) * value;
      }
    }
    this._mods = out;
    return out;
  }

  /**
   * The multiplier for one modifier. Always defined and always 1 by default, so
   * a call site never needs a null check.
   * @param {string} key one of {@link MOD}
   */
  mod(key) {
    return this.mods[key] ?? 1;
  }

  /**
   * Starting skill *levels*, from the occupation plus any trait that grants one.
   * @returns {Record<string, number>}
   */
  startingSkills() {
    const out = { ...this.job.skills };
    for (const t of this.chosen) {
      for (const [id, level] of Object.entries(t.skills ?? {})) {
        out[id] = (out[id] ?? 0) + level;
      }
    }
    return out;
  }

  /**
   * Seed a `Skills` instance from this profile. Levels become the XP total that
   * reaches them, so a starting level and an earned one are indistinguishable
   * afterwards — there is one representation of "how good are you at this".
   * @param {import('./Skills.js').Skills} skills
   */
  applyTo(skills) {
    for (const [id, level] of Object.entries(this.startingSkills())) {
      if (id in skills.xp) skills.xp[id] = xpForLevel(level);
    }
    skills.rate = this.mod(MOD.XP_RATE);
    return skills;
  }

  /**
   * One line per choice, for the character sheet and the death report.
   *
   * Each entry carries its own translation `key` alongside the English `name`,
   * so a caller localises with `t(entry.key, entry.name)` and never has to know
   * whether it is holding an occupation or a trait.
   */
  describe() {
    return [
      {
        id: this.job.id,
        key: `job.${this.job.id}`,
        name: this.job.name,
        desc: this.job.desc,
        kind: 'occupation',
      },
      ...this.chosen.map((t) => ({
        id: t.id,
        key: `trait.${t.id}`,
        name: t.name,
        desc: t.desc,
        kind: t.cost >= 0 ? 'positive' : 'negative',
      })),
    ];
  }

  toJSON() {
    return { name: this.name, occupation: this.occupation, traits: [...this.traits] };
  }

  static fromJSON(data) {
    return new Profile(data ?? {});
  }

  /** The profile used when nothing chose one — a plain, unmodified survivor. */
  static default() {
    return new Profile({ name: 'Survivor', occupation: 'unemployed', traits: [] });
  }
}
