/**
 * In-game time.
 *
 * A survival sim needs a clock that is *legible*: the player has to be able to
 * think "it gets dark in two hours, I can reach the next street and back". So
 * the day is a fixed number of real minutes, the mapping is stated in one place,
 * and everything that ages — hunger, infection, food spoilage, healing — reads
 * its rate from here rather than inventing its own scale.
 *
 * Nothing else in the codebase is allowed to hard-code a time scale. The bug
 * that motivated saying so out loud is in `sim/Body.js`: bleeding was being fed
 * the accelerated clock and killed the player in three seconds.
 */

/** Real seconds per in-game day. One hour of play is roughly two in-game days. */
export const REAL_SECONDS_PER_DAY = 1800;

const SECONDS_PER_DAY = 24 * 3600;
/** In-game seconds elapsed per real second. */
export const TIME_SCALE = SECONDS_PER_DAY / REAL_SECONDS_PER_DAY;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Sunrise and sunset, as fractions of a day. */
const DAWN = 6 / 24;
const DUSK = 20 / 24;
/** How long the sky takes to change over, in fractions of a day. */
const TWILIGHT = 1.1 / 24;

export class Clock {
  /**
   * @param {object} [opts]
   * @param {number} [opts.hour] in-game hour to start at
   * @param {number} [opts.day] day since the outbreak
   */
  constructor({ hour = 9, day = 0 } = {}) {
    /** In-game seconds since the outbreak began. */
    this.elapsed = day * SECONDS_PER_DAY + hour * 3600;
    /** Multiplier on top of TIME_SCALE — 0 pauses, higher fast-forwards sleep. */
    this.rate = 1;
  }

  /**
   * @param {number} dt real seconds
   * @returns {number} in-game seconds that passed
   */
  advance(dt) {
    const gameDt = dt * TIME_SCALE * this.rate;
    this.elapsed += gameDt;
    return gameDt;
  }

  /** Whole days since the outbreak. */
  get day() {
    return Math.floor(this.elapsed / SECONDS_PER_DAY);
  }

  /** Fraction through the current day, 0 at midnight. */
  get dayFraction() {
    return (this.elapsed % SECONDS_PER_DAY) / SECONDS_PER_DAY;
  }

  /** Whole in-game seconds into the current day. */
  get secondOfDay() {
    return Math.floor(this.elapsed % SECONDS_PER_DAY);
  }

  get hour() {
    return Math.floor(this.secondOfDay / 3600);
  }

  get minute() {
    // Derived from whole seconds, not from `dayFraction`. Round-tripping
    // through a 0–1 fraction loses enough precision to report 13:46 at 13:47.
    return Math.floor((this.secondOfDay % 3600) / 60);
  }

  /**
   * How much daylight there is, 0–1.
   *
   * A smooth ramp rather than a switch, because the interesting moments in this
   * genre are the ones where the light is going and you are still two streets
   * from home.
   */
  get daylight() {
    const t = this.dayFraction;
    if (t < DAWN - TWILIGHT || t > DUSK + TWILIGHT) return 0;
    if (t < DAWN + TWILIGHT) return smoothstep((t - (DAWN - TWILIGHT)) / (TWILIGHT * 2));
    if (t > DUSK - TWILIGHT) return 1 - smoothstep((t - (DUSK - TWILIGHT)) / (TWILIGHT * 2));
    return 1;
  }

  get isNight() {
    return this.daylight < 0.12;
  }

  /**
   * Sun elevation and azimuth for the renderer, in radians.
   *
   * The elevation is honest — low at dawn and dusk, high at midday — because
   * that is what the player reads the time from. The **azimuth is deliberately
   * not**: it sweeps a limited arc instead of a full circle.
   *
   * A physically correct azimuth spends most of the day behind the camera, and
   * an isometric view only ever shows two facades. With the sun behind them both
   * are in shadow and every building flattens into a silhouette — the exact
   * problem M1 solved by moving the sun off the camera axis, undone by making it
   * accurate. Readability wins: the arc is chosen so one visible facade is lit
   * and the other shaded at every hour of the day.
   */
  sunAngles() {
    const t = this.dayFraction;
    // Noon overhead, midnight directly beneath.
    const elevation = Math.sin((t - 0.25) * Math.PI * 2) * (Math.PI / 2) * 0.78;

    // Dawn → dusk mapped onto a 70° sweep that keeps the light off the camera
    // axis at the default rotation. Rotating the camera can still show you the
    // shaded side, which is correct and is what the rotate key is for.
    const progress = Math.min(1, Math.max(0, (t - DAWN) / (DUSK - DAWN)));
    const azimuth = (95 + progress * 70) * (Math.PI / 180);
    return { elevation, azimuth };
  }

  /** "Day 3 — Tuesday 14:05" */
  format() {
    const h = String(this.hour).padStart(2, '0');
    const m = String(this.minute).padStart(2, '0');
    return `Day ${this.day + 1} · ${DAY_NAMES[(this.day + 2) % 7]} ${h}:${m}`;
  }

  /** Calendar date, counting from an outbreak on 9 July. */
  formatDate() {
    const dayOfYear = 190 + this.day;
    let d = dayOfYear;
    const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let month = 0;
    while (d > lengths[month]) {
      d -= lengths[month];
      month = (month + 1) % 12;
    }
    return `${d} ${MONTH_NAMES[month]}`;
  }
}

function smoothstep(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

export { SECONDS_PER_DAY, DAWN, DUSK };
