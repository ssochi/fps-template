/**
 * The metagame — the world acting on its own schedule.
 *
 * Everything the player has faced so far is a *reaction* to something they did:
 * they made a noise, so the dead came; they got hurt, so they bled. Nothing in
 * the game has ever happened because time passed. That is the whole reason day
 * twenty feels like day three, and it is what this file is for.
 *
 * Three kinds of thing happen here, and they are deliberately different in
 * character:
 *
 *   - **The shutoff.** Water and then power fail, on a schedule fixed by the
 *     seed and announced in advance. Nothing new is introduced: the taps that
 *     were always there stop working, and the night that was always survivable
 *     stops being. It is a *degradation of what exists*, which is the cheapest
 *     possible way to make a world get harder, and the reason M8's water bottles
 *     and M9's torch suddenly matter.
 *
 *   - **Ambient events.** Distant gunshots, screams, car alarms. Each is a
 *     scheduled emission into M5's sound field, which means the horde reacts to
 *     them exactly as it reacts to the player, with no special case anywhere.
 *     They thin out as the days pass, because the people making them are dying.
 *
 *   - **The helicopter.** One set piece, once per run. It looks for survivors,
 *     finds one, and follows them for several minutes while making more noise
 *     than anything else in the game.
 *
 * ## The helicopter is the one thing allowed to know where you are
 *
 * The pillar is that *the horde* never reads the player's position, and that is
 * untouched: the dead follow the helicopter's noise, not the player. But the
 * helicopter is not a zombie, it is a machine with people in it looking for
 * survivors — knowing where you are is its entire function. It also cannot see
 * through a roof, so going indoors makes it lose you.
 *
 * That is what makes the counterplay interesting rather than obvious. Hiding
 * indoors does not save you, because it keeps circling the last place it saw
 * you, and that is where the town is now walking. What saves you is *leaving*.
 */
import { events } from '../core/Events.js';
import { Rng } from '../core/Rng.js';
import { OBJ, objectId } from '../world/Objects.js';
import { t } from '../ui/i18n.js';

/**
 * When the utilities fail, in in-game days.
 *
 * The reference game puts these around day thirty. Thirty of our days is
 * fifteen real hours, which is not a deadline anybody will ever meet — a day
 * here is thirty real minutes. These are scaled to land inside a session that
 * a player might actually finish, which preserves the thing the schedule is
 * *for*: a stated deadline you can see coming and prepare for.
 */
const WATER_DAYS = { from: 3, to: 4 };
const POWER_DAYS = { from: 5, to: 7 };

/** The helicopter comes once, on one of these days, during daylight hours. */
const HELI_DAYS = { from: 2, to: 3 };
const HELI_HOURS = { from: 10, to: 16 };

/**
 * How long it hunts before giving up and leaving, in **real** seconds.
 *
 * The two-clock rule from `core/Clock.js`: things you react to are measured in
 * real seconds, things measured in days run on the in-game clock. A helicopter
 * overhead is a crisis you live through, not a season.
 *
 * Written as in-game seconds first, and the screenshot caught it: eight in-game
 * minutes is ten real seconds, so the machine turned round and left before it
 * had finished crossing the town. That is the third time this project has put a
 * rate on the wrong clock — M6's bleeding, M7's panic, and now this — and all
 * three looked like the feature being broken rather than like a unit error.
 */
const HELI_DURATION = 200;

/** Metres per second, over the ground. */
const HELI_SPEED = 6.5;
/** How high it flies. Low enough to stay on screen under an ortho camera. */
export const HELI_ALTITUDE = 19;

/** Its noise, in tiles of open air. Louder than anything else in the game. */
const HELI_LOUDNESS = 46;
/** …emitted this often, in real seconds. */
const HELI_NOISE_INTERVAL = 1.1;

/** How far it can spot someone standing in the open. */
const HELI_SIGHT = 26;

/** A car alarm, once triggered. */
const ALARM_LOUDNESS = 26;
const ALARM_DURATION = 34;
const ALARM_INTERVAL = 2.2;

export const UTILITY = { WATER: 'water', POWER: 'power' };

/**
 * Water and power, and the days they die.
 *
 * Both are derived from the world seed, so the same town always fails on the
 * same days and a save need only store whether it has happened yet.
 */
export class Utilities {
  constructor(seed = 'knox') {
    const rng = new Rng(`${seed}:utilities`);
    this.waterDay = rng.int(WATER_DAYS.from, WATER_DAYS.to);
    this.powerDay = rng.int(POWER_DAYS.from, POWER_DAYS.to);
    this.water = true;
    this.power = true;
    /** Cisterns that have been drunk dry, by cell index. */
    this.drained = new Set();
  }

  /**
   * Drink from a plumbing fixture.
   *
   * The shutoff is only an event if the player can *feel* it, so the fixtures
   * that have been standing in every bathroom since M2 are now a water source —
   * free and unlimited while the mains are on, and worthless the moment they
   * are not.
   *
   * With one exception, which is the best part: **a cistern holds what it holds.**
   * A toilet keeps a couple of drinks after the taps die, once, and then it does
   * not. So the morning the water goes off is not the end of water, it is the
   * beginning of going through the neighbours' bathrooms one at a time — which
   * is a far better afternoon than an empty tap.
   *
   * @returns {number} hydration, 0–1. Zero means nothing came out.
   */
  drink(grid, x, z, level) {
    const i = grid.index(x, z, level);
    if (i < 0) return 0;
    const id = objectId(grid.object[i]);
    if (id !== OBJ.SINK && id !== OBJ.BATH && id !== OBJ.TOILET) return 0;

    if (this.water) return id === OBJ.TOILET ? 0.3 : 0.45;
    if (id !== OBJ.TOILET) return 0;
    if (this.drained.has(i)) return 0;
    this.drained.add(i);
    return 0.35;
  }

  /** Is there anything to drink here? For the interaction prompt and the tests. */
  hasWaterAt(grid, x, z, level) {
    const i = grid.index(x, z, level);
    if (i < 0) return false;
    const id = objectId(grid.object[i]);
    if (id !== OBJ.SINK && id !== OBJ.BATH && id !== OBJ.TOILET) return false;
    if (this.water) return true;
    return id === OBJ.TOILET && !this.drained.has(i);
  }

  /** @param {import('../core/Clock.js').Clock} clock */
  update(clock) {
    const day = clock.day;
    if (this.water && day >= this.waterDay) {
      this.water = false;
      events.emit('utility:failed', { id: UTILITY.WATER, day });
    }
    if (this.power && day >= this.powerDay) {
      this.power = false;
      events.emit('utility:failed', { id: UTILITY.POWER, day });
    }
  }

  /**
   * The warning, if one is due. Returned rather than emitted so the caller can
   * decide how often to say it — this is a broadcast, not an event.
   * @returns {{ id: string, days: number } | null}
   */
  warning(clock) {
    if (this.water && clock.day >= this.waterDay - 1) {
      return { id: UTILITY.WATER, days: this.waterDay - clock.day };
    }
    if (this.power && clock.day >= this.powerDay - 1) {
      return { id: UTILITY.POWER, days: this.powerDay - clock.day };
    }
    return null;
  }

  toJSON() {
    return { water: this.water, power: this.power };
  }
}

export const HELI = { WAITING: 0, INBOUND: 1, HUNTING: 2, LEAVING: 3, GONE: 4 };

/**
 * The helicopter.
 *
 * Position is in world metres, not tiles, because it does not walk on the grid —
 * it is the only thing in the game that ignores walls entirely, which is also
 * why it can drag a crowd across a fence.
 */
export class Helicopter {
  constructor(grid) {
    this.grid = grid;
    this.state = HELI.WAITING;
    this.x = 0;
    this.z = 0;
    /** Where it is heading: the last place it believes a survivor to be. */
    this.targetX = 0;
    this.targetZ = 0;
    /** Rotor angle, for the mesh. */
    this.spin = 0;
    /** In-game seconds left of the hunt. */
    this.remaining = 0;
    this._noiseIn = 0;
    /** Whether it has eyes on someone right now. */
    this.sighted = false;
  }

  get active() {
    return this.state === HELI.INBOUND || this.state === HELI.HUNTING || this.state === HELI.LEAVING;
  }

  /** Come in from the nearest edge of the map, heading for where they were seen. */
  launch(towardX, towardZ) {
    const { width, depth } = this.grid;
    // Enter from whichever edge is furthest, so it crosses the town and is
    // heard coming rather than simply appearing overhead.
    const fromWest = towardX > width / 2;
    this.x = fromWest ? -12 : width + 12;
    this.z = Math.max(0, Math.min(depth, towardZ));
    this.targetX = towardX;
    this.targetZ = towardZ;
    this.state = HELI.INBOUND;
    this.remaining = HELI_DURATION;
    this._noiseIn = 0;
    events.emit('meta:helicopter', { phase: 'inbound' });
    events.emit('meta:broadcast', {
      key: 'heli-inbound',
      text: t('meta.heli.inbound', 'A helicopter, somewhere over the town.'),
      tone: 'warning',
    });
  }

  /**
   * @param {number} dt real seconds
   * @param {number} _gameDt in-game seconds; unused — see HELI_DURATION
   * @param {{ x: number, z: number, level: number, indoors: boolean }} observer
   */
  update(dt, _gameDt, observer) {
    if (!this.active) return;
    this.spin += dt * 22;

    // --- looking --------------------------------------------------------
    // It cannot see through a roof. Indoors you are invisible to it, which is
    // the mechanic: it keeps circling where it *last* saw you, and that is
    // where the town is now walking.
    this.sighted = false;
    if (this.state !== HELI.LEAVING && !observer.indoors && observer.level === 0) {
      const dx = observer.x - this.x;
      const dz = observer.z - this.z;
      if (dx * dx + dz * dz <= HELI_SIGHT * HELI_SIGHT) {
        this.sighted = true;
        this.targetX = observer.x;
        this.targetZ = observer.z;
        if (this.state === HELI.INBOUND) {
          this.state = HELI.HUNTING;
          events.emit('meta:helicopter', { phase: 'spotted' });
          events.emit('meta:broadcast', {
            key: 'heli-spotted',
            text: t('meta.heli.spotted', 'The helicopter has seen you.'),
            tone: 'bad',
          });
        }
      }
    }

    // --- flying ---------------------------------------------------------
    if (this.state === HELI.LEAVING) {
      this.x += HELI_SPEED * 1.6 * dt * Math.sign(this.x - this.grid.width / 2 || 1);
      if (this.x < -30 || this.x > this.grid.width + 30) {
        this.state = HELI.GONE;
        events.emit('meta:helicopter', { phase: 'gone' });
      }
    } else {
      const dx = this.targetX - this.x;
      const dz = this.targetZ - this.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.4) {
        const step = Math.min(HELI_SPEED * dt, dist);
        this.x += (dx / dist) * step;
        this.z += (dz / dist) * step;
      }

      this.remaining -= dt;
      if (this.remaining <= 0) {
        this.state = HELI.LEAVING;
        events.emit('meta:helicopter', { phase: 'leaving' });
        events.emit('meta:broadcast', {
          key: 'heli-leaving',
          text: t('meta.heli.leaving', 'The helicopter is moving off.'),
          tone: 'normal',
        });
      }
    }

    // --- being heard ----------------------------------------------------
    this._noiseIn -= dt;
    if (this._noiseIn <= 0) {
      this._noiseIn = HELI_NOISE_INTERVAL;
      // Clamped to the map rather than skipped while it is still off the edge.
      // The sound field only covers the town, and a helicopter you cannot hear
      // until it is overhead gives you nothing to react to — the whole point of
      // it entering from a distant edge is that the noise arrives first, and
      // drags the crowd across the town on its way in.
      const tx = Math.max(0, Math.min(this.grid.width - 1, Math.floor(this.x)));
      const tz = Math.max(0, Math.min(this.grid.depth - 1, Math.floor(this.z)));
      // Ground level, because that is where the crowd it is pulling stands.
      events.emit('noise:made', {
        x: tx, z: tz, level: 0, loudness: HELI_LOUDNESS, source: 'helicopter',
      });
    }
  }
}

/**
 * The scheduler. Owns the utilities, the helicopter and the ambient events, and
 * is the only thing that reads the calendar.
 */
export class MetaEvents {
  /**
   * @param {import('../world/TileGrid.js').TileGrid} grid
   * @param {{ seed?: string }} [opts]
   */
  constructor(grid, { seed = 'knox' } = {}) {
    this.grid = grid;
    this.rng = new Rng(`${seed}:meta`);
    this.utilities = new Utilities(seed);
    this.helicopter = new Helicopter(grid);

    const hrng = new Rng(`${seed}:heli`);
    this.heliDay = hrng.int(HELI_DAYS.from, HELI_DAYS.to);
    this.heliHour = hrng.int(HELI_HOURS.from, HELI_HOURS.to);
    this.heliFired = false;

    /** In-game seconds until the next distant gunshot or scream. */
    this._nextAmbient = this._ambientGap(0);
    /** An active car alarm: { x, z, remaining, in }. */
    this.alarm = null;

    /** What the last broadcast said, so the HUD can show it without polling. */
    this.announced = new Set();

    this.stats = { ambient: 0, alarms: 0 };
  }

  /**
   * Time between ambient events, in in-game seconds.
   *
   * They thin out as the days pass, because the people making them are dying.
   * That is a whole piece of storytelling for one multiplication: a town that
   * is noisy on day one and silent by day ten has told you what happened to
   * everyone without a line of dialogue.
   */
  _ambientGap(day) {
    const base = 40 * 60; // forty in-game minutes on day zero
    const thinning = 1 + day * 0.55;
    return base * thinning * this.rng.range(0.6, 1.5);
  }

  /**
   * @param {number} dt real seconds
   * @param {number} gameDt in-game seconds
   * @param {import('../core/Clock.js').Clock} clock
   * @param {{ x: number, z: number, level: number, indoors: boolean }} observer
   */
  update(dt, gameDt, clock, observer) {
    this.utilities.update(clock);
    this._announce(clock);

    // --- the helicopter -------------------------------------------------
    if (!this.heliFired && clock.day >= this.heliDay && clock.hour >= this.heliHour) {
      this.heliFired = true;
      this.helicopter.launch(observer.x, observer.z);
    }
    this.helicopter.update(dt, gameDt, observer);

    // --- ambient --------------------------------------------------------
    this._nextAmbient -= gameDt;
    if (this._nextAmbient <= 0) {
      this._nextAmbient = this._ambientGap(clock.day);
      this._fireAmbient(clock);
    }

    this._updateAlarm(dt);
  }

  /** A gunshot, a scream, or a car alarm, somewhere else in the town. */
  _fireAmbient(clock) {
    const spot = this._somewhereWalkable();
    if (!spot) return;

    // Gunshots dominate early and gutter out; screams and alarms are what is
    // left once the people with guns have used them.
    const roll = this.rng.next();
    if (roll < 0.45) {
      this.stats.ambient++;
      events.emit('noise:made', {
        x: spot.x, z: spot.z, level: 0, loudness: 38, source: 'gunshot',
      });
      events.emit('meta:distant', { kind: 'gunshot', x: spot.x, z: spot.z, day: clock.day });
    } else if (roll < 0.75) {
      this.stats.ambient++;
      events.emit('noise:made', {
        x: spot.x, z: spot.z, level: 0, loudness: 22, source: 'scream',
      });
      events.emit('meta:distant', { kind: 'scream', x: spot.x, z: spot.z, day: clock.day });
    } else {
      this.triggerAlarm(spot.x, spot.z);
    }
  }

  /** Start a car alarm. Public, so a future milestone can set one off by hitting a car. */
  triggerAlarm(x, z) {
    this.alarm = { x, z, remaining: ALARM_DURATION, in: 0 };
    this.stats.alarms++;
    events.emit('meta:distant', { kind: 'alarm', x, z });
  }

  _updateAlarm(dt) {
    const alarm = this.alarm;
    if (!alarm) return;
    alarm.remaining -= dt;
    alarm.in -= dt;
    if (alarm.in <= 0) {
      alarm.in = ALARM_INTERVAL;
      events.emit('noise:made', {
        x: alarm.x, z: alarm.z, level: 0, loudness: ALARM_LOUDNESS, source: 'alarm',
      });
    }
    if (alarm.remaining <= 0) this.alarm = null;
  }

  /** A random walkable ground tile, for something to happen at. */
  _somewhereWalkable() {
    const grid = this.grid;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = this.rng.int(0, grid.width - 1);
      const z = this.rng.int(0, grid.depth - 1);
      if (grid.isWalkable(x, z, 0)) return { x, z };
    }
    return null;
  }

  /**
   * The emergency broadcast.
   *
   * Said once each, which is what `announced` is for — a warning repeated every
   * frame is wallpaper, and the point of a deadline is that you hear it, note
   * it, and then have to remember it yourself.
   */
  _announce(clock) {
    const say = (key, i18nKey, english, tone = 'warning') => {
      if (this.announced.has(key)) return;
      this.announced.add(key);
      events.emit('meta:broadcast', { key, text: t(i18nKey, english), tone, day: clock.day });
    };

    const warning = this.utilities.warning(clock);
    if (warning && warning.days <= 1) {
      if (warning.id === UTILITY.WATER) {
        say('water-warning', 'meta.water.warning',
          'Automated broadcast: water supply failing within the day.');
      } else {
        say('power-warning', 'meta.power.warning',
          'Automated broadcast: power grid failing within the day.');
      }
    }
    if (!this.utilities.water) say('water-off', 'meta.water.off', 'The taps have run dry.', 'bad');
    if (!this.utilities.power) say('power-off', 'meta.power.off', 'The power has gone out.', 'bad');

    if (!this.heliFired && clock.day >= this.heliDay) {
      say('heli-warning', 'meta.heli.warning', 'Automated broadcast: air activity detected.');
    }
  }

  toJSON() {
    return {
      utilities: this.utilities.toJSON(),
      heliFired: this.heliFired,
      announced: [...this.announced],
    };
  }

  fromJSON(data) {
    if (!data) return;
    this.utilities.water = data.utilities?.water ?? true;
    this.utilities.power = data.utilities?.power ?? true;
    this.heliFired = !!data.heliFired;
    this.announced = new Set(data.announced ?? []);
    // A helicopter caught mid-flight by a save is simply gone; reconstructing
    // one halfway through a hunt would be a lot of state for a set piece that
    // lasts eight minutes.
    if (this.heliFired) this.helicopter.state = HELI.GONE;
  }
}

export {
  WATER_DAYS, POWER_DAYS, HELI_DAYS, HELI_DURATION, HELI_SIGHT, HELI_LOUDNESS,
  ALARM_DURATION,
};
