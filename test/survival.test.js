import { describe, expect, it } from 'vitest';
import { Clock, SECONDS_PER_DAY, TIME_SCALE, REAL_SECONDS_PER_DAY } from '../src/core/Clock.js';
import { Moodles, TIERS, TIER_STEPS } from '../src/sim/Moodles.js';
import { Body, PART } from '../src/sim/Body.js';

const always = (v) => () => v;

/** Run the sim for `realSeconds` of wall-clock at 30 Hz. */
function live(clock, moodles, realSeconds, context = {}) {
  const dt = 1 / 30;
  for (let t = 0; t < realSeconds; t += dt) {
    const gameDt = clock.advance(dt);
    moodles.body.update(dt, gameDt);
    moodles.update(dt, gameDt, context);
  }
}

describe('clock', () => {
  it('runs a full in-game day in the stated number of real seconds', () => {
    const c = new Clock({ hour: 0 });
    for (let t = 0; t < REAL_SECONDS_PER_DAY; t += 1 / 30) c.advance(1 / 30);
    expect(c.day).toBe(1);
  });

  it('derives its scale rather than hard-coding it', () => {
    expect(TIME_SCALE).toBeCloseTo(SECONDS_PER_DAY / REAL_SECONDS_PER_DAY, 6);
  });

  it('reports hours and minutes that match the elapsed time', () => {
    const c = new Clock({ hour: 0 });
    c.elapsed = 13 * 3600 + 47 * 60;
    expect(c.hour).toBe(13);
    expect(c.minute).toBe(47);
    expect(c.format()).toContain('13:47');
  });

  it('is dark at night and bright at midday', () => {
    const c = new Clock({ hour: 0 });
    c.elapsed = 3 * 3600;
    expect(c.daylight).toBe(0);
    expect(c.isNight).toBe(true);

    c.elapsed = 13 * 3600;
    expect(c.daylight).toBe(1);
    expect(c.isNight).toBe(false);
  });

  it('ramps through dawn rather than switching', () => {
    const c = new Clock({ hour: 0 });
    const sample = (h) => {
      c.elapsed = h * 3600;
      return c.daylight;
    };
    const before = sample(5);
    const during = sample(6);
    const after = sample(8);
    expect(before).toBeLessThan(during);
    expect(during).toBeLessThan(after);
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThan(1);
  });

  it('keeps the sun off the camera axis all day', () => {
    // The regression this pins: a physically correct azimuth spends most of the
    // day behind the camera, and with both visible facades shaded every building
    // flattens to a silhouette.
    const c = new Clock({ hour: 0 });
    for (let h = 6; h <= 20; h++) {
      c.elapsed = h * 3600;
      const { azimuth } = c.sunAngles();
      const dirX = Math.sin(azimuth);
      const dirZ = Math.cos(azimuth);
      // At the default rotation the camera sits toward +X/+Z. The sun must light
      // exactly one of those two facades: positive X, negative Z.
      expect(dirX, `hour ${h}`).toBeGreaterThan(0);
      expect(dirZ, `hour ${h}`).toBeLessThan(0);
    }
  });

  it('raises the sun toward midday and drops it toward dusk', () => {
    const c = new Clock({ hour: 0 });
    const at = (h) => {
      c.elapsed = h * 3600;
      return c.sunAngles().elevation;
    };
    expect(at(12)).toBeGreaterThan(at(8));
    expect(at(12)).toBeGreaterThan(at(18));
  });
});

describe('moodles', () => {
  const make = () => {
    const body = new Body();
    return { body, moodles: new Moodles(body), clock: new Clock({ hour: 9 }) };
  };

  it('starts with nothing worth showing', () => {
    const { moodles } = make();
    expect(moodles.active()).toEqual([]);
  });

  it('gets hungry and thirsty over time, thirst first', () => {
    const { moodles, clock } = make();
    live(clock, moodles, 240);
    expect(moodles.hunger).toBeGreaterThan(0);
    expect(moodles.thirst).toBeGreaterThan(moodles.hunger);
  });

  it('burns food and water faster when you exert yourself', () => {
    const still = make();
    live(still.clock, still.moodles, 120, { exertion: 0 });

    const running = make();
    live(running.clock, running.moodles, 120, { exertion: 1 });

    expect(running.moodles.hunger).toBeGreaterThan(still.moodles.hunger);
    expect(running.moodles.thirst).toBeGreaterThan(still.moodles.thirst);
  });

  it('reports tiers rather than raw percentages', () => {
    expect(Moodles.tierOf(0)).toBe(0);
    expect(Moodles.tierOf(TIER_STEPS[0])).toBe(1);
    expect(Moodles.tierOf(TIER_STEPS[3])).toBe(4);
    expect(TIERS.hunger[4]).toBe('Starving');
  });

  it('sorts what it shows worst-first', () => {
    const { moodles } = make();
    moodles.hunger = 0.3;
    moodles.thirst = 0.95;
    const [first] = moodles.active();
    expect(first.id).toBe('thirst');
    expect(first.tier).toBe(4);
  });

  // --- every moodle must change a decision -----------------------------

  it('hunger and thirst slow how fast you get your breath back', () => {
    const { moodles } = make();
    const before = moodles.enduranceRecovery;
    moodles.hunger = 0.8;
    moodles.thirst = 0.8;
    expect(moodles.enduranceRecovery).toBeLessThan(before);
  });

  it('fatigue lowers the endurance you can hold at all', () => {
    const { moodles } = make();
    expect(moodles.enduranceCeiling).toBe(1);
    moodles.fatigue = 0.9;
    expect(moodles.enduranceCeiling).toBeLessThan(0.5);
  });

  it('pain slows you and weakens your swing', () => {
    const { body, moodles } = make();
    const mob = moodles.mobility;
    const dex = moodles.dexterity;
    body.pain = 90;
    expect(moodles.mobility).toBeLessThan(mob);
    expect(moodles.dexterity).toBeLessThan(dex);
  });

  it('panic weakens your swing but not your legs', () => {
    const { moodles } = make();
    const mob = moodles.mobility;
    const dex = moodles.dexterity;
    moodles.panic = 1;
    expect(moodles.dexterity).toBeLessThan(dex);
    expect(moodles.mobility).toBeCloseTo(mob, 5);
  });

  it('cold costs dexterity; heat does not', () => {
    const { moodles } = make();
    const dex = moodles.dexterity;
    moodles.temperature = 0.1;
    expect(moodles.dexterity).toBeLessThan(dex);
    moodles.temperature = 0.9;
    expect(moodles.dexterity).toBeCloseTo(dex, 5);
  });

  it('sickness and starvation stop you healing', () => {
    const { moodles } = make();
    expect(moodles.healingRate).toBe(1);
    moodles.sickness = 0.7;
    expect(moodles.healingRate).toBeLessThan(0.35);
    moodles.sickness = 0;
    moodles.hunger = 1;
    expect(moodles.healingRate).toBeLessThan(0.3);
  });

  // --- behaviour --------------------------------------------------------

  it('spikes fast with the dead in sight', () => {
    const { moodles, clock } = make();
    live(clock, moodles, 3, { threats: 6 });
    expect(moodles.panic).toBeGreaterThan(0.3);
  });

  it('outlasts the threat rather than tracking it', () => {
    const { moodles, clock } = make();
    live(clock, moodles, 20, { threats: 6 });
    const peak = moodles.panic;

    // Seconds after the threat is gone it must still be most of the way up —
    // panic that follows proximity instantly is a readout, not an emotion.
    live(clock, moodles, 3, { threats: 0 });
    expect(moodles.panic).toBeGreaterThan(peak * 0.6);

    // …but it does settle eventually.
    live(clock, moodles, 60, { threats: 0 });
    expect(moodles.panic).toBe(0);
  });

  it('is more frightening in the dark', () => {
    const day = make();
    live(day.clock, day.moodles, 20, { threats: 4, daylight: 1 });
    const night = make();
    live(night.clock, night.moodles, 20, { threats: 4, daylight: 0 });
    expect(night.moodles.panic).toBeGreaterThan(day.moodles.panic);
  });

  it('gets cold at night outdoors and less so inside', () => {
    const outside = make();
    outside.clock.elapsed = 2 * 3600;
    live(outside.clock, outside.moodles, 200, { indoors: false, daylight: 0 });

    const inside = make();
    inside.clock.elapsed = 2 * 3600;
    live(inside.clock, inside.moodles, 200, { indoors: true, daylight: 0 });

    expect(outside.moodles.temperature).toBeLessThan(inside.moodles.temperature);
  });

  it('recovers fatigue by sleeping and collapses if you never do', () => {
    const { moodles, clock } = make();
    moodles.fatigue = 0.7;
    moodles.sleep();
    live(clock, moodles, 120, {});
    expect(moodles.fatigue).toBeLessThan(0.7);

    const tired = make();
    tired.moodles.fatigue = 0.99;
    live(tired.clock, tired.moodles, 60, {});
    expect(tired.moodles.asleep).toBe(true);
    expect(tired.moodles.collapsed).toBe(true);
  });

  it('wakes on its own once rested', () => {
    const { moodles, clock } = make();
    moodles.fatigue = 0.05;
    moodles.sleep();
    live(clock, moodles, 120, {});
    expect(moodles.asleep).toBe(false);
  });

  it('eating and drinking help', () => {
    const { moodles } = make();
    moodles.hunger = 0.8;
    moodles.thirst = 0.8;
    moodles.eat(0.5);
    moodles.drink(0.6);
    expect(moodles.hunger).toBeCloseTo(0.3, 5);
    expect(moodles.thirst).toBeCloseTo(0.2, 5);
  });

  it('kills you if you never eat or drink, and names the cause', () => {
    const { body, moodles, clock } = make();
    moodles.thirst = 1;
    live(clock, moodles, 600, {});
    expect(body.alive).toBe(false);
    expect(body.causeOfDeath).toBe('dehydration');
  });

  it('shows sickness as infection advances, before it is fatal', () => {
    const { body, moodles, clock } = make();
    body.hurt({ amount: 1, kind: 'bite', roll: always(0) });
    expect(moodles.sickness).toBe(0);
    live(clock, moodles, 400, {});
    expect(moodles.sickness).toBeGreaterThan(0);
    expect(body.alive).toBe(true);
  });

  it('does nothing once the player is dead', () => {
    const { body, moodles, clock } = make();
    body.hurt({ amount: 200, part: PART.TORSO, roll: always(0.99) });
    const hunger = moodles.hunger;
    live(clock, moodles, 120, {});
    expect(moodles.hunger).toBe(hunger);
  });
});
