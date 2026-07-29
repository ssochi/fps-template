/**
 * Moodles — the survival simulation.
 *
 * ## The rule these are built to
 *
 * **Every moodle must change a decision, not just display a number.** The
 * blueprint says to cut any that doesn't, and that rule did real work here: an
 * earlier draft had boredom and unhappiness as separate tracks with no
 * mechanical difference between them, and they collapsed into one.
 *
 * So each entry below states its effect, and the effects are read by systems
 * that already exist:
 *
 * | Moodle      | What it changes |
 * | ----------- | --------------- |
 * | hunger      | endurance recovery, then health |
 * | thirst      | endurance recovery, faster than hunger |
 * | fatigue     | maximum endurance; forces sleep at the extreme |
 * | pain        | mobility and dexterity |
 * | panic       | dexterity; rises with the dead in sight |
 * | temperature | cold costs dexterity and burns food; heat costs water |
 * | sickness    | healing rate; the visible face of infection |
 *
 * ## Tiers, not percentages
 *
 * Each moodle reports a tier from 0 to 4 rather than a raw fraction, because
 * that is the resolution the player can act on. "Peckish" and "Hungry" are
 * different decisions; 41% and 43% are not.
 */
import { events } from '../core/Events.js';
import { PART } from './Body.js';
import { MOD, Profile } from './Traits.js';

/** Tier names, indexed 1–4; tier 0 is "fine" and is not displayed. */
export const TIERS = {
  hunger: ['', 'Peckish', 'Hungry', 'Very Hungry', 'Starving'],
  thirst: ['', 'Thirsty', 'Parched', 'Dehydrated', 'Dying of Thirst'],
  fatigue: ['', 'Drowsy', 'Tired', 'Very Tired', 'Exhausted'],
  pain: ['', 'Slight Pain', 'Pain', 'Bad Pain', 'Agony'],
  panic: ['', 'Uneasy', 'Nervous', 'Panicked', 'Terrified'],
  cold: ['', 'Chilly', 'Cold', 'Very Cold', 'Freezing'],
  hot: ['', 'Warm', 'Hot', 'Very Hot', 'Overheating'],
  sickness: ['', 'Queasy', 'Nauseous', 'Sick', 'Fevered'],
};

/** Fractions at which each tier begins. */
const TIER_STEPS = [0.22, 0.45, 0.7, 0.9];

/**
 * In-game seconds to go from full to empty doing nothing.
 * A day is 86,400, so hunger takes about a day and a half and thirst about
 * fourteen hours — thirst is the one that makes you leave the house.
 */
const RATES = {
  hunger: 1 / (36 * 3600),
  thirst: 1 / (14 * 3600),
  fatigue: 1 / (17 * 3600),
};

/** Sleeping recovers fatigue this many times faster than staying awake costs it. */
const SLEEP_RECOVERY = 3.2;

/** Comfortable body temperature band, in arbitrary units where 0.5 is ideal. */
const COMFORT = { low: 0.42, high: 0.58 };

export class Moodles {
  /**
   * @param {import('./Body.js').Body} body
   * @param {import('./Traits.js').Profile} [profile] scales the four rates.
   *   Defaults to the body's own profile, so the usual case needs no argument.
   */
  constructor(body, profile) {
    this.body = body;
    this.profile = profile ?? body?.profile ?? Profile.default();

    /** 0 = full, 1 = starving. */
    this.hunger = 0;
    this.thirst = 0;
    this.fatigue = 0;
    /** 0.5 is comfortable; below is cold, above is hot. */
    this.temperature = 0.5;
    /** 0–1, driven by what you can see and how hurt you are. */
    this.panic = 0;
    this.sickness = 0;

    this.asleep = false;
    /** Set when fatigue forces the issue. */
    this.collapsed = false;

    this._lastTiers = {};
  }

  // --- effects other systems read ---------------------------------------

  /** Multiplier on endurance recovery, 0–1. */
  get enduranceRecovery() {
    const fed = 1 - this.hunger * 0.55;
    const watered = 1 - this.thirst * 0.7;
    return Math.max(0.1, fed * watered);
  }

  /** Ceiling on endurance, 0–1. A tired survivor cannot sprint far. */
  get enduranceCeiling() {
    return Math.max(0.25, 1 - this.fatigue * 0.65);
  }

  /** Multiplier on movement speed. */
  get mobility() {
    const painCost = 1 - Math.min(0.35, this.body.pain / 100 * 0.35);
    const coldCost = this.temperature < COMFORT.low ? 1 - (COMFORT.low - this.temperature) * 0.6 : 1;
    return Math.max(0.4, painCost * coldCost);
  }

  /** Multiplier on swing damage and reach. */
  get dexterity() {
    const painCost = 1 - Math.min(0.3, (this.body.pain / 100) * 0.3);
    const panicCost = 1 - this.panic * 0.28;
    const coldCost = this.temperature < COMFORT.low ? 1 - (COMFORT.low - this.temperature) * 0.8 : 1;
    return Math.max(0.35, painCost * panicCost * coldCost);
  }

  /** Multiplier on natural healing. Being ill or starving stops you mending. */
  get healingRate() {
    return Math.max(0, (1 - this.sickness) * (1 - this.hunger * 0.8));
  }

  // --- simulation --------------------------------------------------------

  /**
   * The base rate for a track, scaled by whoever this survivor is. One accessor
   * rather than three multiplications inline, so a trait cannot be applied in
   * one branch and forgotten in another.
   * @param {'hunger'|'thirst'|'fatigue'} id
   */
  rate(id) {
    const MODS = { hunger: MOD.HUNGER_RATE, thirst: MOD.THIRST_RATE, fatigue: MOD.FATIGUE_RATE };
    return RATES[id] * this.profile.mod(MODS[id]);
  }

  /**
   * Two clocks, for the same reason `Body` has two.
   *
   * Hunger, thirst, fatigue and temperature are measured in hours and belong on
   * the in-game clock. **Panic does not** — it is a reaction happening in the
   * room with you, and writing its decay in in-game seconds made it settle in
   * under two real seconds, which turned it from an emotion into a proximity
   * readout. Same mistake as feeding bleeding the accelerated clock in M6;
   * writing that one down was evidently not enough to stop me repeating it.
   *
   * @param {number} dt real seconds
   * @param {number} gameDt in-game seconds
   * @param {object} context
   * @param {boolean} context.indoors
   * @param {number} context.daylight 0–1
   * @param {number} context.exertion 0 = still, 1 = sprinting
   * @param {number} context.threats zombies currently visible and close
   */
  update(dt, gameDt, {
    indoors = false, daylight = 1, exertion = 0, threats = 0, chill = 0, warmth = 0,
  } = {}) {
    if (!this.body.alive) return;

    // Exertion burns food and water faster; this is why a long fight is
    // expensive in more than stamina.
    const effort = 1 + exertion * 1.4;
    this.hunger = clamp01(this.hunger + this.rate('hunger') * gameDt * effort);
    this.thirst = clamp01(this.thirst + this.rate('thirst') * gameDt * effort);

    if (this.asleep) {
      // Recovery is not scaled by Restless: tiring faster is the trait, needing
      // a longer night as well would be the same penalty charged twice.
      this.fatigue = clamp01(this.fatigue - RATES.fatigue * gameDt * SLEEP_RECOVERY);
      if (this.fatigue <= 0.02) this.wake('rested');
    } else {
      this.fatigue = clamp01(this.fatigue + this.rate('fatigue') * gameDt);
      // Past exhaustion the choice is taken away from you.
      if (this.fatigue >= 0.995 && !this.collapsed) {
        this.collapsed = true;
        this.sleep();
        events.emit('player:collapsed', {});
      }
    }

    this._updateTemperature(gameDt, indoors, daylight, chill, warmth);
    this._updatePanic(dt, threats, daylight);

    // Sickness is the visible face of infection, plus a contribution from being
    // badly hurt. It is what tells the player something is wrong before the
    // infection itself is confirmed.
    const fromInfection = this.body.infected ? Math.min(1, this.body.infection * 2.2) : 0;
    const fromWounds = Math.max(0, 1 - this.body.condition) * 0.5;
    this.sickness = clamp01(Math.max(fromInfection, fromWounds));

    this._applyStarvation(dt);
    this._announceTiers();
  }

  _updateTemperature(gameDt, indoors, daylight, chill = 0, warmth = 0) {
    // Ambient runs from cold at night to warm at midday; indoors is buffered,
    // rain takes a bite out of it, and a fire puts it back.
    const outdoor = 0.3 + daylight * 0.34 - (indoors ? chill * 0.3 : chill);
    let ambient = indoors ? 0.5 + (outdoor - 0.5) * 0.35 : outdoor;
    // A fire is the strongest thing in this equation on purpose: sitting next
    // to one has to be the answer to being cold, or being cold has no answer.
    ambient += warmth * 0.3;
    // The body equalises toward ambient over roughly half an hour.
    const k = 1 - Math.exp(-gameDt / 1800);
    this.temperature += (ambient - this.temperature) * k;

    // Being cold makes you burn food; being hot makes you drink.
    if (this.temperature < COMFORT.low) {
      this.hunger = clamp01(this.hunger + this.rate('hunger') * gameDt * 0.6);
    } else if (this.temperature > COMFORT.high) {
      this.thirst = clamp01(this.thirst + this.rate('thirst') * gameDt * 0.5);
    }
  }

  _updatePanic(dt, threats, daylight) {
    // Panic rises with what you can see and falls when nothing is near. Darkness
    // makes it worse, which is what makes a torch worth the noise and the light.
    const darkness = 1 - daylight;
    const pressure = Math.min(1, threats / 6) * (0.6 + darkness * 0.5);
    // Nerve changes both where fear settles and how fast it gets there. Brave
    // is not "panics slower" — it is "is less frightened by the same room".
    const nerve = this.profile.mod(MOD.PANIC_RATE);
    const target = Math.min(1, (pressure + this.body.pain / 260) * nerve);
    // Panic spikes over a couple of seconds and takes most of a minute to
    // settle, in *real* time — it should outlast the thing that caused it.
    const rate = target > this.panic ? (dt / 2.5) * nerve : dt / 40 / nerve;
    this.panic += Math.sign(target - this.panic) * Math.min(Math.abs(target - this.panic), rate);
    this.panic = clamp01(this.panic);
  }

  /**
   * At the extremes, hunger and thirst stop being an inconvenience.
   * Per *real* second: the damage is something you watch happen.
   */
  _applyStarvation(dt) {
    if (this.hunger >= 0.98) {
      this.body.health[PART.TORSO] = Math.max(0, this.body.health[PART.TORSO] - 0.9 * dt);
    }
    if (this.thirst >= 0.98) {
      this.body.health[PART.TORSO] = Math.max(0, this.body.health[PART.TORSO] - 1.6 * dt);
    }
    if (this.body.health[PART.TORSO] <= 0) {
      this.body._die(this.thirst >= 0.98 ? 'dehydration' : 'starvation');
    }
  }

  sleep() {
    if (this.asleep) return;
    this.asleep = true;
    events.emit('player:slept', {});
  }

  wake(reason = 'woken') {
    if (!this.asleep) return;
    this.asleep = false;
    this.collapsed = false;
    events.emit('player:woke', { reason });
  }

  eat(amount) {
    this.hunger = clamp01(this.hunger - amount);
  }

  drink(amount) {
    this.thirst = clamp01(this.thirst - amount);
  }

  // --- presentation ------------------------------------------------------

  /** @returns {number} 0–4 */
  static tierOf(value) {
    let tier = 0;
    for (const step of TIER_STEPS) if (value >= step) tier++;
    return tier;
  }

  /**
   * Everything currently worth showing, worst first.
   * @returns {Array<{ id: string, label: string, tier: number, value: number }>}
   */
  active() {
    const out = [];
    const add = (id, value) => {
      const tier = Moodles.tierOf(value);
      if (tier > 0) out.push({ id, label: TIERS[id][tier], tier, value });
    };

    add('hunger', this.hunger);
    add('thirst', this.thirst);
    add('fatigue', this.fatigue);
    add('pain', this.body.pain / 100);
    add('panic', this.panic);
    add('sickness', this.sickness);

    // Cold and heat are one axis but two moodles, because they are opposite
    // problems with opposite answers.
    if (this.temperature < COMFORT.low) add('cold', (COMFORT.low - this.temperature) / COMFORT.low);
    else if (this.temperature > COMFORT.high) {
      add('hot', (this.temperature - COMFORT.high) / (1 - COMFORT.high));
    }

    out.sort((a, b) => b.tier - a.tier || b.value - a.value);
    return out;
  }

  /** Emit an event when a moodle crosses a tier, so the HUD can react. */
  _announceTiers() {
    for (const m of this.active()) {
      if (this._lastTiers[m.id] !== m.tier) {
        this._lastTiers[m.id] = m.tier;
        events.emit('moodle:changed', m);
      }
    }
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export { RATES, COMFORT, TIER_STEPS };
