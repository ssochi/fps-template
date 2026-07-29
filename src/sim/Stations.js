/**
 * Things you build and then have to keep running.
 *
 * ## The answer to M16
 *
 * M16 turned the water off and the lights out and left the player with "carry
 * more bottles". This is the reply: a **rain barrel** that fills when it rains,
 * a **campfire** that gives warmth, light and the only way to cook, and a
 * **generator** that buys the grid back for as long as the petrol lasts.
 *
 * ## What makes them interesting is that they run down
 *
 * A barricade is a thing you build once. These are three things you have to keep
 * *fed*, and each of them charges a different currency: the barrel costs nothing
 * but patience and the weather, the fire eats planks, the generator eats petrol
 * you have to go and find. That is the whole shape of a base — not a place that
 * is safe, but a set of clocks you keep winding.
 *
 * And every one of them is loud or bright or both, which is the tension: the
 * generator that gives you light at night is the loudest thing in the town, and
 * M13's migration remembers where the noise was for minutes afterwards.
 *
 * ## Sparse state, keyed by cell
 *
 * The *object* lives in the tile grid like any other; only the running state is
 * here, in a Map keyed by cell index. A town has thousands of cells and a
 * handful of stations, so this is a few objects rather than another array over
 * the grid — and it saves as a short list.
 */
import { events } from '../core/Events.js';
import { OBJ, objectId } from '../world/Objects.js';

/** How much a barrel holds, in drinks. */
export const BARREL_CAPACITY = 12;

/**
 * Drinks collected per in-game hour at full downpour.
 *
 * Tuned against thirst: `Moodles` empties a survivor in about fourteen in-game
 * hours and one drink is 0.45 of the bar, so roughly two and a half drinks a
 * day keeps one person alive. A three-hour storm should therefore be most of a
 * day's water — enough to matter, not enough to stop the weather mattering.
 */
const BARREL_FILL_RATE = 1.4;

/** Hydration from a barrel. Rain water, and none the worse for it. */
const BARREL_DRINK = 0.45;

/** In-game seconds a campfire burns per plank. */
export const FIRE_SECONDS_PER_PLANK = 40 * 60;
/** How many planks a fire can hold at once. */
export const FIRE_MAX_FUEL = 6;

/** How far a fire warms and lights, in tiles. */
export const FIRE_RADIUS = 5;

/** In-game seconds a generator runs per unit of petrol. */
export const GENERATOR_SECONDS_PER_FUEL = 3 * 3600;
export const GENERATOR_MAX_FUEL = 8;

/** How loud a running generator is, in tiles of open air. Constantly. */
const GENERATOR_NOISE = 24;
const GENERATOR_NOISE_INTERVAL = 1.4;

/** A lit fire is loud too — a crackle rather than an engine. */
const FIRE_NOISE = 7;
const FIRE_NOISE_INTERVAL = 2.6;

export const STATION = {
  [OBJ.RAIN_BARREL]: 'barrel',
  [OBJ.CAMPFIRE]: 'fire',
  [OBJ.GENERATOR]: 'generator',
};

export class Stations {
  /** @param {import('../world/TileGrid.js').TileGrid} grid */
  constructor(grid) {
    this.grid = grid;
    /** @type {Map<number, object>} cell index → running state */
    this.byCell = new Map();
    this._noiseTimers = new Map();
    this.stats = { barrels: 0, fires: 0, generators: 0, lit: 0, running: 0 };
  }

  /** Register a station that has just been built. */
  add(x, z, level, kind) {
    const i = this.grid.index(x, z, level);
    if (i < 0) return null;
    const state = { kind, x, z, level, index: i };
    if (kind === 'barrel') state.water = 0;
    else if (kind === 'fire') {
      state.fuel = 0;
      state.burn = 0;
      state.lit = false;
    } else if (kind === 'generator') {
      state.fuel = 0;
      state.running = false;
    }
    this.byCell.set(i, state);
    return state;
  }

  at(x, z, level) {
    return this.byCell.get(this.grid.index(x, z, level)) ?? null;
  }

  /** Every station within `radius` tiles on the same storey. */
  near(x, z, level, radius = 1) {
    const found = [];
    for (const state of this.byCell.values()) {
      if (state.level !== level) continue;
      const dx = state.x - x;
      const dz = state.z - z;
      if (dx * dx + dz * dz <= radius * radius) found.push(state);
    }
    return found;
  }

  // --- using them --------------------------------------------------------

  /**
   * Drink from a barrel.
   * @returns {number} hydration, or 0 if it is empty
   */
  drink(state) {
    if (!state || state.kind !== 'barrel' || state.water < 1) return 0;
    state.water -= 1;
    events.emit('station:used', { kind: 'barrel', x: state.x, z: state.z });
    return BARREL_DRINK;
  }

  /**
   * Feed a fire or a generator.
   * @returns {boolean} whether it took the fuel
   */
  refuel(state, amount = 1) {
    if (!state) return false;
    if (state.kind === 'fire') {
      if (state.fuel >= FIRE_MAX_FUEL) return false;
      state.fuel = Math.min(FIRE_MAX_FUEL, state.fuel + amount);
      // A fire with fuel in it lights itself: nobody builds one for decoration.
      if (!state.lit) this.light(state);
      return true;
    }
    if (state.kind === 'generator') {
      if (state.fuel >= GENERATOR_MAX_FUEL) return false;
      state.fuel = Math.min(GENERATOR_MAX_FUEL, state.fuel + amount);
      if (!state.running) state.running = true;
      events.emit('station:started', { kind: 'generator', x: state.x, z: state.z });
      return true;
    }
    return false;
  }

  light(state) {
    if (!state || state.kind !== 'fire' || state.fuel <= 0) return false;
    state.lit = true;
    state.burn = state.burn || FIRE_SECONDS_PER_PLANK;
    events.emit('station:started', { kind: 'fire', x: state.x, z: state.z });
    return true;
  }

  /** Is there a lit fire close enough to cook on? */
  fireNear(x, z, level, radius = 1) {
    return this.near(x, z, level, radius).find((s) => s.kind === 'fire' && s.lit) ?? null;
  }

  /** Is a generator running anywhere? Lighting is global; the fiction is a grid. */
  get powered() {
    for (const state of this.byCell.values()) {
      if (state.kind === 'generator' && state.running) return true;
    }
    return false;
  }

  /** Total warmth at a spot, 0–1, from every lit fire near it. */
  warmthAt(x, z, level) {
    let warmth = 0;
    for (const state of this.byCell.values()) {
      if (state.kind !== 'fire' || !state.lit || state.level !== level) continue;
      const d = Math.hypot(state.x - x, state.z - z);
      if (d > FIRE_RADIUS) continue;
      warmth = Math.max(warmth, 1 - d / FIRE_RADIUS);
    }
    return warmth;
  }

  /** The nearest lit fire, for the renderer's light. */
  nearestFire(x, z, level) {
    let best = null;
    let bestD = Infinity;
    for (const state of this.byCell.values()) {
      if (state.kind !== 'fire' || !state.lit || state.level !== level) continue;
      const d = Math.hypot(state.x - x, state.z - z);
      if (d < bestD) {
        bestD = d;
        best = state;
      }
    }
    return best;
  }

  // --- running them ------------------------------------------------------

  /**
   * @param {number} dt real seconds
   * @param {number} gameDt in-game seconds
   * @param {import('./Weather.js').Weather} weather
   */
  update(dt, gameDt, weather) {
    let barrels = 0;
    let fires = 0;
    let generators = 0;
    let lit = 0;
    let running = 0;

    for (const state of this.byCell.values()) {
      if (state.kind === 'barrel') {
        barrels++;
        if (weather?.rainRate > 0) {
          state.water = Math.min(
            BARREL_CAPACITY,
            state.water + BARREL_FILL_RATE * weather.rainRate * (gameDt / 3600),
          );
        }
      } else if (state.kind === 'fire') {
        fires++;
        if (!state.lit) continue;
        lit++;
        state.burn -= gameDt;
        if (state.burn <= 0) {
          state.fuel -= 1;
          if (state.fuel > 0) {
            state.burn = FIRE_SECONDS_PER_PLANK;
          } else {
            state.fuel = 0;
            state.burn = 0;
            state.lit = false;
            events.emit('station:stopped', { kind: 'fire', x: state.x, z: state.z });
          }
        }
        this._maybeNoise(state, dt, FIRE_NOISE, FIRE_NOISE_INTERVAL);
      } else if (state.kind === 'generator') {
        generators++;
        if (!state.running) continue;
        running++;
        state.fuel -= gameDt / GENERATOR_SECONDS_PER_FUEL;
        if (state.fuel <= 0) {
          state.fuel = 0;
          state.running = false;
          events.emit('station:stopped', { kind: 'generator', x: state.x, z: state.z });
        }
        this._maybeNoise(state, dt, GENERATOR_NOISE, GENERATOR_NOISE_INTERVAL);
      }
    }

    this.stats = { barrels, fires, generators, lit, running };
  }

  /**
   * Stations shout into the same sound field everything else does — so a
   * generator draws the town exactly as a hammer would, and nothing in the
   * horde needs to know generators exist.
   */
  _maybeNoise(state, dt, loudness, interval) {
    const next = (this._noiseTimers.get(state.index) ?? 0) - dt;
    if (next > 0) {
      this._noiseTimers.set(state.index, next);
      return;
    }
    this._noiseTimers.set(state.index, interval);
    events.emit('noise:made', {
      x: state.x, z: state.z, level: state.level, loudness, source: state.kind,
    });
  }

  // --- saving ------------------------------------------------------------

  toJSON() {
    return [...this.byCell.values()].map((s) => ({
      x: s.x, z: s.z, level: s.level, kind: s.kind,
      water: s.water, fuel: s.fuel, burn: s.burn, lit: s.lit, running: s.running,
    }));
  }

  fromJSON(list) {
    this.byCell.clear();
    for (const raw of list ?? []) {
      const state = this.add(raw.x, raw.z, raw.level, raw.kind);
      if (state) Object.assign(state, raw);
    }
  }
}

export { BARREL_FILL_RATE, BARREL_DRINK, GENERATOR_NOISE, FIRE_NOISE };
