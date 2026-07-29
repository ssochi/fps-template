/**
 * Body-part health, bleeding and infection.
 *
 * A single hit-point bar is the wrong model for this genre. What makes an injury
 * interesting is not that it costs health, it is that it costs a *specific
 * capability* and takes real time to heal: a wounded leg slows you down, a
 * wounded arm makes you swing worse, and either might be bleeding while you try
 * to do something about it. Damage has to be located to do that.
 *
 * Infection is deliberately not a debuff. It is a countdown you cannot stop,
 * whose only interaction with the rest of the game is that you now know roughly
 * how long you have. That is the reference game's cruellest and best idea: the
 * run does not end when you are bitten, it ends when you decide what to do with
 * the time you have left.
 */
import { events } from '../core/Events.js';

export const PART = {
  HEAD: 0,
  TORSO: 1,
  ARM_L: 2,
  ARM_R: 3,
  LEG_L: 4,
  LEG_R: 5,
};

export const PART_NAMES = ['head', 'torso', 'left arm', 'right arm', 'left leg', 'right leg'];

/**
 * How much a part contributes to staying alive, and how likely it is to be hit.
 * The torso is the biggest target and the head the deadliest, which is the usual
 * and correct tension.
 */
const PART_INFO = [
  { lethal: 1.0, hitWeight: 0.1, bleedScale: 1.4 },
  { lethal: 1.0, hitWeight: 0.4, bleedScale: 1.2 },
  { lethal: 0.0, hitWeight: 0.14, bleedScale: 0.8 },
  { lethal: 0.0, hitWeight: 0.14, bleedScale: 0.8 },
  { lethal: 0.0, hitWeight: 0.11, bleedScale: 0.9 },
  { lethal: 0.0, hitWeight: 0.11, bleedScale: 0.9 },
];

/** Chance a wound transmits infection, by how it was inflicted. */
export const INFECTION_CHANCE = {
  bite: 0.9,
  scratch: 0.22,
  /** Anything not from the dead cannot infect, whatever it does to you. */
  blunt: 0,
};

/** In-game seconds from infection to death. Roughly two to three days. */
const ZOMBIFICATION_TIME = 60 * 60 * 52;

/** Health lost per second per unit of bleed rate. */
const BLEED_DAMAGE = 0.55;
/** Untended wounds clot slowly on their own. */
const NATURAL_CLOT = 0.012;
/** Health regained per second on an undamaged, unbleeding part. */
const NATURAL_HEAL = 0.09;

export class Body {
  constructor() {
    /** 0–100 per part. */
    this.health = new Float32Array(6).fill(100);
    /** Bleed rate per part; nonzero means losing health continuously. */
    this.bleed = new Float32Array(6);
    /** Fractured parts are not merely damaged, they stop working. */
    this.fractured = new Uint8Array(6);
    /** Accumulated pain, which the moodle system in M7 will read. */
    this.pain = 0;

    this.alive = true;
    /** 0 = clean, >0 = counting down to zombification. */
    this.infection = 0;
    this.infected = false;
    this.causeOfDeath = null;
  }

  /** Overall condition, 0–1, for a single HUD bar. */
  get condition() {
    let total = 0;
    for (let i = 0; i < 6; i++) total += this.health[i];
    return total / 600;
  }

  /** Weighted toward the parts that kill you. */
  get vitality() {
    return Math.min(this.health[PART.HEAD], this.health[PART.TORSO]) / 100;
  }

  /**
   * Movement penalty from leg damage, 0–1 (1 = unimpeded).
   * A limp is the injury the player feels most, because it changes whether
   * running away is still an option.
   */
  get mobility() {
    const legs = (this.health[PART.LEG_L] + this.health[PART.LEG_R]) / 200;
    const broken = this.fractured[PART.LEG_L] || this.fractured[PART.LEG_R] ? 0.45 : 1;
    return Math.max(0.28, legs * broken);
  }

  /** Swing penalty from arm damage, 0–1. */
  get dexterity() {
    const arms = (this.health[PART.ARM_L] + this.health[PART.ARM_R]) / 200;
    const broken = this.fractured[PART.ARM_L] || this.fractured[PART.ARM_R] ? 0.5 : 1;
    return Math.max(0.35, arms * broken);
  }

  /**
   * Apply a wound.
   *
   * @param {object} wound
   * @param {number} wound.amount health lost
   * @param {number} [wound.part] which part; picked by hit weight if omitted
   * @param {'bite'|'scratch'|'blunt'} [wound.kind]
   * @param {number} [wound.bleed] added bleed rate
   * @param {() => number} [wound.roll] injectable RNG, so tests are deterministic
   * @returns {{ part: number, infected: boolean, fractured: boolean }}
   */
  hurt({ amount, part, kind = 'blunt', bleed = 0, roll = Math.random }) {
    if (!this.alive) return { part: part ?? PART.TORSO, infected: false, fractured: false };

    const target = part ?? pickPart(roll);
    const info = PART_INFO[target];

    this.health[target] = Math.max(0, this.health[target] - amount);
    this.bleed[target] += bleed * info.bleedScale;
    this.pain = Math.min(100, this.pain + amount * 0.75);

    // A heavy blow to a limb breaks it rather than merely hurting it.
    let fractured = false;
    if (!this.fractured[target] && amount >= 28 && target >= PART.ARM_L) {
      this.fractured[target] = 1;
      fractured = true;
    }

    let infected = false;
    const chance = INFECTION_CHANCE[kind] ?? 0;
    if (!this.infected && chance > 0 && roll() < chance) {
      this.infected = true;
      this.infection = 1e-6; // nonzero so the countdown starts
      infected = true;
      events.emit('body:infected', { part: target, kind });
    }

    events.emit('body:hurt', { part: target, amount, kind, fractured });
    this._checkDeath(kind === 'bite' || kind === 'scratch' ? 'wounds' : 'injuries');
    return { part: target, infected, fractured };
  }

  /**
   * Two clocks, deliberately.
   *
   * Bleeding, clotting, pain and healing run on **real** seconds: they are
   * things you are reacting to right now, and their constants only make sense
   * at the rate you experience them. Infection runs on the accelerated in-game
   * clock, because it is measured in days and a real-time countdown would be
   * unplayable.
   *
   * Running both on the game clock is a bug I shipped and caught in a
   * screenshot: at 60× the player bled out from a single bite in about three
   * seconds.
   *
   * @param {number} dt real seconds
   * @param {number} gameDt in-game seconds
   */
  update(dt, gameDt = dt) {
    if (!this.alive) return;

    for (let i = 0; i < 6; i++) {
      if (this.bleed[i] > 0) {
        this.health[i] = Math.max(0, this.health[i] - this.bleed[i] * BLEED_DAMAGE * dt);
        this.bleed[i] = Math.max(0, this.bleed[i] - NATURAL_CLOT * dt);
      } else if (this.health[i] < 100) {
        this.health[i] = Math.min(100, this.health[i] + NATURAL_HEAL * dt);
      }
    }

    this.pain = Math.max(0, this.pain - 1.6 * dt);

    if (this.infected) {
      this.infection = Math.min(1, this.infection + gameDt / ZOMBIFICATION_TIME);
      if (this.infection >= 1) {
        this._die('infection');
        return;
      }
    }

    this._checkDeath('blood loss');
  }

  /** Stop a bleed — bandaging, in M9's terms. */
  bandage(part) {
    this.bleed[part] = 0;
  }

  _checkDeath(cause) {
    if (!this.alive) return;
    for (let i = 0; i < 6; i++) {
      if (PART_INFO[i].lethal > 0 && this.health[i] <= 0) {
        this._die(cause);
        return;
      }
    }
  }

  _die(cause) {
    if (!this.alive) return;
    this.alive = false;
    this.causeOfDeath = cause;
    events.emit('player:died', { cause, infection: this.infection });
  }

  /** A short human-readable summary, for the HUD and the death report. */
  describe() {
    const hurt = [];
    for (let i = 0; i < 6; i++) {
      if (this.health[i] >= 99.5 && !this.bleed[i]) continue;
      const bits = [`${PART_NAMES[i]} ${Math.round(this.health[i])}%`];
      if (this.bleed[i] > 0.05) bits.push('bleeding');
      if (this.fractured[i]) bits.push('fractured');
      hurt.push(bits.join(' '));
    }
    return hurt;
  }
}

/** Weighted random part, so the torso takes most hits and the head few. */
function pickPart(roll) {
  let total = 0;
  for (const p of PART_INFO) total += p.hitWeight;
  let r = roll() * total;
  for (let i = 0; i < PART_INFO.length; i++) {
    r -= PART_INFO[i].hitWeight;
    if (r <= 0) return i;
  }
  return PART.TORSO;
}

export { ZOMBIFICATION_TIME, pickPart, PART_INFO };
