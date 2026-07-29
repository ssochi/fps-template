/**
 * Weather.
 *
 * ## Why a survival game needs rain and not much else
 *
 * Rain is the only weather that earns its place here, because it is the only one
 * that changes a decision. It fills the barrel you built, it makes you cold, and
 * — the part that makes it interesting rather than atmospheric — **it covers the
 * noise you make**. A downpour is the safest hour of the day to hammer planks
 * over a window, and the worst hour to be outdoors in without a coat. Snow, wind
 * and fog would each be a rendering job and none of them would change what you
 * do next.
 *
 * ## Three existing numbers
 *
 * Held to the same rule as the moodles and the traits: weather may only change
 * something a system already reads.
 *
 *   - `Utilities` / rain barrels — how fast they fill.
 *   - `Moodles.temperature` — the ambient it equalises toward.
 *   - Every `noise:made` loudness — attenuated at the source.
 *
 * ## The schedule comes from the seed
 *
 * A day's weather is a function of `(seed, day)`, so the same town has the same
 * summer and a save stores nothing at all. Fronts last hours rather than minutes,
 * because the whole point of the mechanic is that you can look outside and
 * *plan*.
 */
import { events } from '../core/Events.js';
import { Rng } from '../core/Rng.js';

export const SKY = { CLEAR: 0, OVERCAST: 1, RAIN: 2, STORM: 3 };

/** How much of the day each kind of sky takes up, roughly. */
const WEIGHTS = [
  { sky: SKY.CLEAR, weight: 0.42 },
  { sky: SKY.OVERCAST, weight: 0.3 },
  { sky: SKY.RAIN, weight: 0.21 },
  { sky: SKY.STORM, weight: 0.07 },
];

/** In-game seconds per weather front. Three hours, so a day has eight. */
const FRONT = 3 * 3600;

/** How hard it is coming down, 0–1, per sky. */
const INTENSITY = { [SKY.CLEAR]: 0, [SKY.OVERCAST]: 0, [SKY.RAIN]: 0.55, [SKY.STORM]: 1 };

/**
 * How much of your noise the rain swallows, at full intensity.
 *
 * Deliberately large. If a storm only shaved a tenth off your loudness it would
 * be a number nobody could feel, and the mechanic is supposed to be a *window*:
 * this is the hour to do the loud thing.
 */
const NOISE_MASK = 0.55;

/** How much colder a storm makes the outdoors, in the units `Moodles` uses. */
const CHILL = 0.13;

export class Weather {
  constructor(seed = 'knox') {
    this.seed = `${seed}:weather`;
    /** Current front. */
    this.sky = SKY.CLEAR;
    /** 0–1, eased so a front arrives rather than appearing. */
    this.intensity = 0;
    this._target = 0;
    this._front = -1;
    this.stats = { fronts: 0 };
  }

  /** Which sky a given front index has. Pure, so nothing needs saving. */
  skyAt(frontIndex) {
    const rng = new Rng(`${this.seed}:${frontIndex}`);
    let roll = rng.next();
    for (const entry of WEIGHTS) {
      if (roll < entry.weight) return entry.sky;
      roll -= entry.weight;
    }
    return SKY.CLEAR;
  }

  /**
   * @param {number} dt real seconds
   * @param {import('../core/Clock.js').Clock} clock
   */
  update(dt, clock) {
    const front = Math.floor(clock.elapsed / FRONT);
    if (front !== this._front) {
      this._front = front;
      const sky = this.skyAt(front);
      if (sky !== this.sky) {
        this.sky = sky;
        this.stats.fronts++;
        events.emit('weather:changed', { sky, raining: this.raining });
      }
      this._target = INTENSITY[sky] ?? 0;
    }

    // Eased over about half a minute of real time, so the sky closes in.
    const k = 1 - Math.exp(-dt / 25);
    this.intensity += (this._target - this.intensity) * k;
    if (Math.abs(this._target - this.intensity) < 1e-4) this.intensity = this._target;
  }

  get raining() {
    return this.sky === SKY.RAIN || this.sky === SKY.STORM;
  }

  /**
   * Multiplier on any noise made outdoors. Applied at the source, so a zombie's
   * hearing, the migration memory and the audio all get the quiet hour for free.
   */
  get noiseScale() {
    return 1 - NOISE_MASK * this.intensity;
  }

  /** How much colder it is outdoors than the daylight alone would suggest. */
  get chill() {
    return CHILL * this.intensity;
  }

  /** Litres per in-game hour into an open container. */
  get rainRate() {
    return this.intensity;
  }

  /** How much light the cloud takes out of the sky, 0–1. */
  get gloom() {
    if (this.sky === SKY.OVERCAST) return 0.22;
    return this.intensity * 0.45;
  }

  toJSON() {
    // Nothing: the schedule is a function of the seed and the clock.
    return null;
  }
}

export { FRONT, NOISE_MASK, CHILL, INTENSITY };
