/**
 * M16 — the metagame.
 *
 * The claim under test: **a scheduled event is a scheduled emission into the
 * sound field**, so the horde reacts to a helicopter exactly as it reacts to a
 * hammer, with no special case anywhere. Most of these cases are about the
 * schedule being derived from the seed, said out loud once, and reaching M5's
 * existing plumbing rather than a new channel.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TileGrid, FLOOR } from '../src/world/TileGrid.js';
import { OBJ, packObject } from '../src/world/Objects.js';
import { Clock } from '../src/core/Clock.js';
import { events } from '../src/core/Events.js';
import {
  HELI, HELI_DAYS, MetaEvents, POWER_DAYS, UTILITY, Utilities, WATER_DAYS,
} from '../src/sim/Meta.js';
import { DIR } from '../src/core/constants.js';

function town(w = 40, d = 40) {
  const g = new TileGrid(w, d, 1);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, 0, FLOOR.CONCRETE);
  return g;
}

/** Collect every event of a kind emitted while `fn` runs. */
function capture(name, fn) {
  const seen = [];
  const off = events.on(name, (e) => seen.push(e));
  try {
    fn();
  } finally {
    off();
  }
  return seen;
}

const outdoors = (x = 5, z = 5) => ({ x, z, level: 0, indoors: false });

describe('the shutoff clock', () => {
  it('derives the same days from the same seed, and different ones otherwise', () => {
    const a = new Utilities('knox-county');
    const b = new Utilities('knox-county');
    expect(a.waterDay).toBe(b.waterDay);
    expect(a.powerDay).toBe(b.powerDay);

    const seeds = new Set();
    for (let i = 0; i < 40; i++) seeds.add(new Utilities(`seed-${i}`).waterDay);
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('schedules water before power, and both inside their windows', () => {
    for (let i = 0; i < 60; i++) {
      const u = new Utilities(`s${i}`);
      expect(u.waterDay).toBeGreaterThanOrEqual(WATER_DAYS.from);
      expect(u.waterDay).toBeLessThanOrEqual(WATER_DAYS.to);
      expect(u.powerDay).toBeGreaterThanOrEqual(POWER_DAYS.from);
      expect(u.powerDay).toBeLessThanOrEqual(POWER_DAYS.to);
      expect(u.powerDay).toBeGreaterThan(u.waterDay);
    }
  });

  it('fails exactly once each, and says so', () => {
    const u = new Utilities('knox');
    const clock = new Clock({ day: u.waterDay, hour: 0 });
    const failures = capture('utility:failed', () => {
      for (let i = 0; i < 5; i++) u.update(clock);
    });
    expect(failures.length).toBe(1);
    expect(failures[0].id).toBe(UTILITY.WATER);
    expect(u.water).toBe(false);
    expect(u.power).toBe(true);
  });

  it('warns a day out, and not before', () => {
    const u = new Utilities('knox');
    expect(u.warning(new Clock({ day: 0 }))).toBe(null);
    const w = u.warning(new Clock({ day: u.waterDay - 1 }));
    expect(w?.id).toBe(UTILITY.WATER);
    expect(w.days).toBe(1);
  });
});

describe('taps', () => {
  function bathroom() {
    const g = town(10, 10);
    g.setObject(3, 3, 0, packObject(OBJ.SINK, DIR.N));
    g.setObject(4, 3, 0, packObject(OBJ.TOILET, DIR.N));
    g.setObject(5, 3, 0, packObject(OBJ.TABLE, DIR.N));
    return g;
  }

  it('gives water from a fixture while the mains are on', () => {
    const g = bathroom();
    const u = new Utilities('knox');
    expect(u.drink(g, 3, 3, 0)).toBeGreaterThan(0);
    expect(u.hasWaterAt(g, 3, 3, 0)).toBe(true);
  });

  it('gives nothing from a table, ever', () => {
    const g = bathroom();
    const u = new Utilities('knox');
    expect(u.drink(g, 5, 3, 0)).toBe(0);
    expect(u.drink(g, 1, 1, 0)).toBe(0);
  });

  it('runs a sink dry the moment the mains fail', () => {
    const g = bathroom();
    const u = new Utilities('knox');
    u.water = false;
    expect(u.drink(g, 3, 3, 0)).toBe(0);
    expect(u.hasWaterAt(g, 3, 3, 0)).toBe(false);
  });

  it('leaves a cistern holding exactly one drink after the shutoff', () => {
    // The best part of the whole schedule: the morning the water goes off is
    // not the end of water, it is the beginning of going through the
    // neighbours' bathrooms one at a time.
    const g = bathroom();
    const u = new Utilities('knox');
    u.water = false;
    expect(u.drink(g, 4, 3, 0)).toBeGreaterThan(0);
    expect(u.drink(g, 4, 3, 0)).toBe(0);
    expect(u.hasWaterAt(g, 4, 3, 0)).toBe(false);
  });

  it('drains each cistern separately', () => {
    const g = bathroom();
    g.setObject(6, 3, 0, packObject(OBJ.TOILET, DIR.N));
    const u = new Utilities('knox');
    u.water = false;
    expect(u.drink(g, 4, 3, 0)).toBeGreaterThan(0);
    expect(u.drink(g, 6, 3, 0)).toBeGreaterThan(0);
  });
});

describe('the helicopter', () => {
  function ready() {
    const g = town(60, 60);
    const meta = new MetaEvents(g, { seed: 'heli-test' });
    const clock = new Clock({ day: meta.heliDay, hour: meta.heliHour });
    return { g, meta, clock };
  }

  it('comes once, on its scheduled day', () => {
    const { meta, clock } = ready();
    expect(meta.heliDay).toBeGreaterThanOrEqual(HELI_DAYS.from);
    expect(meta.heliDay).toBeLessThanOrEqual(HELI_DAYS.to);

    const early = new MetaEvents(town(60, 60), { seed: 'heli-test' });
    early.update(1 / 30, 1, new Clock({ day: 0, hour: 12 }), outdoors(30, 30));
    expect(early.helicopter.active).toBe(false);

    meta.update(1 / 30, 1, clock, outdoors(30, 30));
    expect(meta.helicopter.active).toBe(true);
    expect(meta.heliFired).toBe(true);
  });

  it('enters from off the map rather than appearing overhead', () => {
    const { g, meta, clock } = ready();
    meta.update(1 / 30, 1, clock, outdoors(30, 30));
    const h = meta.helicopter;
    expect(h.x < 0 || h.x > g.width).toBe(true);
  });

  it('is the only thing allowed to know where you are — and not through a roof', () => {
    const { meta, clock } = ready();
    meta.update(1 / 30, 1, clock, outdoors(30, 30));
    const h = meta.helicopter;
    h.x = 30;
    h.z = 30;

    // Indoors: invisible to it, and it keeps heading where it last looked.
    h.update(1 / 30, 1, { x: 30, z: 30, level: 0, indoors: true });
    expect(h.sighted).toBe(false);
    expect(h.state).toBe(HELI.INBOUND);

    // Step outside and it has you.
    h.update(1 / 30, 1, outdoors(30, 30));
    expect(h.sighted).toBe(true);
    expect(h.state).toBe(HELI.HUNTING);
  });

  it('drags the horde by making a noise, not by reporting a position', () => {
    const { meta, clock } = ready();
    const noises = capture('noise:made', () => {
      meta.update(1 / 30, 1, clock, outdoors(30, 30));
      for (let i = 0; i < 60; i++) meta.helicopter.update(1 / 30, 1, outdoors(30, 30));
    });
    const rotor = noises.filter((n) => n.source === 'helicopter');
    expect(rotor.length).toBeGreaterThan(0);
    // Loud enough to matter: louder than a door, a swing or a hammer.
    expect(rotor[0].loudness).toBeGreaterThan(30);
    // …and emitted at ground level, which is where the crowd it pulls stands.
    expect(rotor[0].level).toBe(0);
  });

  it('hunts on the real clock, long enough to actually arrive', () => {
    // The bug the screenshot caught: written in in-game seconds, the eight
    // minute hunt lasted ten real ones and the machine turned round before it
    // had crossed the town.
    const { g, meta, clock } = ready();
    meta.update(1 / 30, 1, clock, outdoors(30, 30));
    const h = meta.helicopter;
    const enteredFrom = h.x;

    // Half a minute of real time: nowhere near giving up, and well onto the map.
    for (let i = 0; i < 30 * 30; i++) h.update(1 / 30, 1.6, outdoors(30, 30));
    expect(h.state).toBe(HELI.HUNTING);
    expect(Math.abs(h.x - enteredFrom)).toBeGreaterThan(20);
    expect(h.x).toBeGreaterThan(0);
    expect(h.x).toBeLessThan(g.width);
  });

  it('gives up and leaves', () => {
    const { meta, clock } = ready();
    meta.update(1 / 30, 1, clock, outdoors(30, 30));
    const h = meta.helicopter;
    for (let i = 0; i < 30 * 220; i++) h.update(1 / 30, 1.6, outdoors(30, 30));
    expect([HELI.LEAVING, HELI.GONE]).toContain(h.state);
    for (let i = 0; i < 30 * 60; i++) h.update(1 / 30, 1.6, outdoors(30, 30));
    expect(h.state).toBe(HELI.GONE);
    expect(h.active).toBe(false);
  });
});

describe('ambient events', () => {
  it('thin out as the days pass, because the people making them are dying', () => {
    const meta = new MetaEvents(town(), { seed: 'ambient' });
    const early = [];
    const late = [];
    for (let i = 0; i < 200; i++) early.push(meta._ambientGap(0));
    for (let i = 0; i < 200; i++) late.push(meta._ambientGap(10));
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(late)).toBeGreaterThan(mean(early) * 3);
  });

  it('emit into the same sound field everything else does', () => {
    const meta = new MetaEvents(town(), { seed: 'ambient' });
    const clock = new Clock({ day: 0, hour: 12 });
    const noises = capture('noise:made', () => {
      for (let i = 0; i < 40; i++) meta._fireAmbient(clock);
    });
    expect(noises.length).toBeGreaterThan(0);
    const sources = new Set(noises.map((n) => n.source));
    // Over forty rolls all three kinds should have come up.
    expect(sources.size).toBeGreaterThan(1);
    for (const n of noises) {
      expect(n.loudness).toBeGreaterThan(10);
      expect(n.level).toBe(0);
    }
  });

  it('keeps a car alarm going for a while, then stops', () => {
    const meta = new MetaEvents(town(), { seed: 'alarm' });
    meta.triggerAlarm(10, 10);
    const noises = capture('noise:made', () => {
      for (let i = 0; i < 30 * 40; i++) meta._updateAlarm(1 / 30);
    });
    expect(noises.length).toBeGreaterThan(4);
    expect(meta.alarm).toBe(null);
  });
});

describe('broadcasts', () => {
  it('says each thing once and only once', () => {
    const meta = new MetaEvents(town(), { seed: 'say' });
    const clock = new Clock({ day: meta.utilities.waterDay, hour: 8 });
    const said = capture('meta:broadcast', () => {
      for (let i = 0; i < 50; i++) meta.update(1 / 30, 1, clock, outdoors());
    });
    const keys = said.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('water-off');
  });

  it('has text rather than a lookup key in it', () => {
    const meta = new MetaEvents(town(), { seed: 'say' });
    const clock = new Clock({ day: meta.utilities.powerDay, hour: 8 });
    const said = capture('meta:broadcast', () => {
      meta.update(1 / 30, 1, clock, outdoors());
    });
    for (const s of said) {
      expect(s.text.length).toBeGreaterThan(4);
      expect(s.text).not.toContain('meta.');
    }
  });
});

describe('saving the metagame', () => {
  it('stores what has happened, not the schedule', () => {
    const meta = new MetaEvents(town(), { seed: 'save' });
    meta.utilities.water = false;
    meta.heliFired = true;
    const json = meta.toJSON();
    expect(json.utilities.water).toBe(false);
    expect(json.heliFired).toBe(true);
    expect(JSON.stringify(json).length).toBeLessThan(400);

    const restored = new MetaEvents(town(), { seed: 'save' });
    restored.fromJSON(json);
    expect(restored.utilities.water).toBe(false);
    expect(restored.heliFired).toBe(true);
    // The schedule comes back from the seed, not from the file.
    expect(restored.utilities.waterDay).toBe(meta.utilities.waterDay);
    // A helicopter caught mid-flight by a save is simply gone.
    expect(restored.helicopter.active).toBe(false);
  });

  it('survives a missing or empty payload', () => {
    const meta = new MetaEvents(town(), { seed: 'save' });
    expect(() => meta.fromJSON(null)).not.toThrow();
    expect(meta.utilities.water).toBe(true);
  });
});
