/**
 * M18 — water, fire and food.
 *
 * M16 turned the water off and the lights out and left the player with "carry
 * more bottles". These are the tests for the reply: things you build that then
 * have to be kept running, and weather that decides how easy that is.
 */
import { describe, expect, it } from 'vitest';
import { TileGrid, FLOOR } from '../src/world/TileGrid.js';
import { OBJ, objectId, packObject } from '../src/world/Objects.js';
import { Clock } from '../src/core/Clock.js';
import { events } from '../src/core/Events.js';
import { Weather, SKY, INTENSITY, FRONT } from '../src/sim/Weather.js';
import {
  BARREL_CAPACITY, FIRE_MAX_FUEL, FIRE_SECONDS_PER_PLANK, GENERATOR_MAX_FUEL, Stations,
} from '../src/sim/Stations.js';
import { Player } from '../src/entity/Player.js';
import { Moodles } from '../src/sim/Moodles.js';
import { Construction } from '../src/sim/Construction.js';
import { RECIPE_BY_ID, OUTPUT } from '../src/items/Recipes.js';
import { Item } from '../src/items/ItemDb.js';
import { DIR } from '../src/core/constants.js';

function ground(w = 16, d = 16) {
  const g = new TileGrid(w, d, 1);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, 0, FLOOR.CONCRETE);
  return g;
}

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

/** A weather stub at a fixed intensity, so station tests do not roll dice. */
const downpour = (intensity = 1) => ({ rainRate: intensity });

describe('weather', () => {
  it('gives the same town the same summer', () => {
    const a = new Weather('knox');
    const b = new Weather('knox');
    for (let f = 0; f < 60; f++) expect(a.skyAt(f)).toBe(b.skyAt(f));

    const other = new Weather('elsewhere');
    let differences = 0;
    for (let f = 0; f < 60; f++) if (a.skyAt(f) !== other.skyAt(f)) differences++;
    expect(differences).toBeGreaterThan(5);
  });

  it('rains a minority of the time', () => {
    const w = new Weather('knox');
    let wet = 0;
    for (let f = 0; f < 400; f++) {
      const sky = w.skyAt(f);
      if (sky === SKY.RAIN || sky === SKY.STORM) wet++;
    }
    expect(wet / 400).toBeGreaterThan(0.15);
    expect(wet / 400).toBeLessThan(0.45);
  });

  it('arrives rather than appearing', () => {
    const w = new Weather('knox');
    // Find a front that rains, and start the clock just before it.
    let front = 0;
    while (INTENSITY[w.skyAt(front)] === 0 && front < 200) front++;
    const clock = new Clock({ hour: 0 });
    clock.elapsed = front * FRONT;

    w.update(1 / 30, clock);
    const first = w.intensity;
    // Twenty seconds in, it is on its way and nowhere near arrived.
    for (let i = 0; i < 30 * 20; i++) w.update(1 / 30, clock);
    const partway = w.intensity;
    expect(partway).toBeGreaterThan(first);
    expect(partway).toBeLessThan(INTENSITY[w.sky]);

    // Two minutes in, it is fully here.
    for (let i = 0; i < 30 * 100; i++) w.update(1 / 30, clock);
    expect(w.intensity).toBeCloseTo(INTENSITY[w.sky], 2);
  });

  it('swallows the noise you make, and only while it rains', () => {
    const w = new Weather('knox');
    expect(w.noiseScale).toBe(1);
    w.sky = SKY.STORM;
    w.intensity = 1;
    expect(w.noiseScale).toBeLessThan(0.5);
    expect(w.noiseScale).toBeGreaterThan(0);
  });

  it('reaches the player, so hammering in a storm is genuinely quieter', () => {
    const g = ground();
    const p = new Player(g);
    const loud = p.noiseScale;
    p.weather = { noiseScale: 0.45 };
    expect(p.noiseScale).toBeCloseTo(loud * 0.45, 6);
  });

  it('makes the outdoors colder', () => {
    const w = new Weather('knox');
    expect(w.chill).toBe(0);
    w.intensity = 1;
    expect(w.chill).toBeGreaterThan(0);
  });

  it('stores nothing, because the schedule is the seed and the clock', () => {
    expect(new Weather('knox').toJSON()).toBe(null);
  });
});

describe('rain barrels', () => {
  it('fills when it rains and not otherwise', () => {
    const g = ground();
    const s = new Stations(g);
    const barrel = s.add(4, 4, 0, 'barrel');

    s.update(1, 3600, downpour(0));
    expect(barrel.water).toBe(0);

    s.update(1, 3600, downpour(1));
    expect(barrel.water).toBeGreaterThan(0);
  });

  it('holds only so much', () => {
    const g = ground();
    const s = new Stations(g);
    const barrel = s.add(4, 4, 0, 'barrel');
    for (let h = 0; h < 200; h++) s.update(1, 3600, downpour(1));
    expect(barrel.water).toBe(BARREL_CAPACITY);
  });

  it('gives water a drink at a time, and then nothing', () => {
    const g = ground();
    const s = new Stations(g);
    const barrel = s.add(4, 4, 0, 'barrel');
    barrel.water = 2;
    expect(s.drink(barrel)).toBeGreaterThan(0);
    expect(s.drink(barrel)).toBeGreaterThan(0);
    expect(s.drink(barrel)).toBe(0);
  });

  it('is the answer to the shutoff: a survivor can drink with the mains off', () => {
    const g = ground();
    const s = new Stations(g);
    const p = new Player(g);
    p.moodles = new Moodles(p.body);
    p.stations = s;
    p.moodles.thirst = 0.8;

    const barrel = s.add(5, 4, 0, 'barrel');
    barrel.water = 4;
    p.position.set(4.5, 0, 4.5);
    expect(p._useStation(4, 4)).toBe(true);
    expect(p.moodles.thirst).toBeLessThan(0.8);
  });
});

describe('campfires', () => {
  it('lights itself when fed, because nobody builds one for decoration', () => {
    const g = ground();
    const s = new Stations(g);
    const fire = s.add(4, 4, 0, 'fire');
    expect(fire.lit).toBe(false);
    expect(s.refuel(fire, 1)).toBe(true);
    expect(fire.lit).toBe(true);
  });

  it('burns its fuel and goes out', () => {
    const g = ground();
    const s = new Stations(g);
    const fire = s.add(4, 4, 0, 'fire');
    s.refuel(fire, 2);

    const stopped = capture('station:stopped', () => {
      // Two planks, plus slack.
      for (let i = 0; i < 200; i++) s.update(1, FIRE_SECONDS_PER_PLANK / 20, null);
    });
    expect(fire.lit).toBe(false);
    expect(fire.fuel).toBe(0);
    expect(stopped.some((e) => e.kind === 'fire')).toBe(true);
  });

  it('refuses more than it can hold', () => {
    const g = ground();
    const s = new Stations(g);
    const fire = s.add(4, 4, 0, 'fire');
    s.refuel(fire, FIRE_MAX_FUEL);
    expect(s.refuel(fire, 1)).toBe(false);
  });

  it('warms what is near it, and less what is far', () => {
    const g = ground();
    const s = new Stations(g);
    const fire = s.add(8, 8, 0, 'fire');
    s.refuel(fire, 1);
    expect(s.warmthAt(8, 8, 0)).toBeCloseTo(1, 5);
    expect(s.warmthAt(10, 8, 0)).toBeGreaterThan(0);
    expect(s.warmthAt(10, 8, 0)).toBeLessThan(s.warmthAt(9, 8, 0));
    expect(s.warmthAt(15, 15, 0)).toBe(0);
    // …and nothing at all once it is out.
    fire.lit = false;
    expect(s.warmthAt(8, 8, 0)).toBe(0);
  });

  it('a fire warms a survivor a storm was making cold', () => {
    const g = ground();
    const p = new Player(g);
    const m = new Moodles(p.body);
    const cold = () => {
      const mm = new Moodles(p.body);
      mm.temperature = 0.5;
      for (let i = 0; i < 40; i++) mm.update(1, 1800, { daylight: 0, chill: 0.13 });
      return mm.temperature;
    };
    const warm = () => {
      const mm = new Moodles(p.body);
      mm.temperature = 0.5;
      for (let i = 0; i < 40; i++) mm.update(1, 1800, { daylight: 0, chill: 0.13, warmth: 1 });
      return mm.temperature;
    };
    expect(warm()).toBeGreaterThan(cold());
    void m;
  });

  it('crackles into the same sound field everything else uses', () => {
    const g = ground();
    const s = new Stations(g);
    const fire = s.add(4, 4, 0, 'fire');
    s.refuel(fire, 3);
    const noises = capture('noise:made', () => {
      for (let i = 0; i < 40; i++) s.update(0.5, 1, null);
    });
    expect(noises.length).toBeGreaterThan(0);
    expect(noises[0].source).toBe('fire');
  });
});

describe('generators', () => {
  it('runs on petrol and stops without it', () => {
    const g = ground();
    const s = new Stations(g);
    const gen = s.add(4, 4, 0, 'generator');
    expect(s.powered).toBe(false);

    s.refuel(gen, 2);
    expect(gen.running).toBe(true);
    expect(s.powered).toBe(true);

    for (let i = 0; i < 400; i++) s.update(1, 3600, null);
    expect(gen.running).toBe(false);
    expect(s.powered).toBe(false);
  });

  it('never takes more than it can hold', () => {
    const g = ground();
    const s = new Stations(g);
    const gen = s.add(4, 4, 0, 'generator');
    s.refuel(gen, GENERATOR_MAX_FUEL + 10);
    expect(gen.fuel).toBe(GENERATOR_MAX_FUEL);
  });

  it('is by far the loudest thing you can leave switched on', () => {
    const g = ground();
    const s = new Stations(g);
    const gen = s.add(4, 4, 0, 'generator');
    const fire = s.add(9, 9, 0, 'fire');
    s.refuel(gen, 4);
    s.refuel(fire, 2);

    const noises = capture('noise:made', () => {
      for (let i = 0; i < 60; i++) s.update(0.5, 1, null);
    });
    const loudest = (source) => Math.max(
      0, ...noises.filter((n) => n.source === source).map((n) => n.loudness),
    );
    expect(loudest('generator')).toBeGreaterThan(loudest('fire') * 2);
  });
});

describe('building them', () => {
  function setup() {
    const g = ground();
    const p = new Player(g);
    p.moodles = new Moodles(p.body);
    const s = new Stations(g);
    p.stations = s;
    p.position.set(4.5, 0, 4.5);
    p.setYaw(Math.PI); // facing +Z
    const c = new Construction(g, p, s);
    return { g, p, s, c };
  }

  it('puts the object in front of you and registers it', () => {
    const { g, p, s, c } = setup();
    p.inventory.add(new Item('plank', 4));
    p.inventory.add(new Item('nails', 1));

    expect(c.begin(RECIPE_BY_ID['rain-barrel'])).toBe(null);
    c.update(20);

    const spot = s.near(4, 4, 0, 2)[0];
    expect(spot).toBeDefined();
    expect(objectId(g.object[g.index(spot.x, spot.z, 0)])).toBe(OBJ.RAIN_BARREL);
    expect(spot.kind).toBe('barrel');
    expect(c.stats.placed).toBe(1);
  });

  it('never places on top of something already there', () => {
    const { g, p, c } = setup();
    // Fill every neighbour and the tile underfoot.
    for (const [x, z] of [[4, 4], [5, 4], [3, 4], [4, 5], [4, 3]]) {
      g.setObject(x, z, 0, packObject(OBJ.CRATE, DIR.N));
    }
    p.inventory.add(new Item('plank', 4));
    p.inventory.add(new Item('nails', 1));
    expect(c.begin(RECIPE_BY_ID['rain-barrel'])).toBe('no room in front of you');
  });

  it('refuses to cook without a lit fire, and allows it with one', () => {
    const { p, s, c } = setup();
    p.inventory.add(new Item('rawmeat', 1));
    expect(c.begin(RECIPE_BY_ID['cook-meat'])).not.toBe(null);

    const fire = s.add(5, 4, 0, 'fire');
    s.refuel(fire, 1);
    expect(c.begin(RECIPE_BY_ID['cook-meat'])).toBe(null);
  });

  it('cooking is worth doing: a steak beats raw meat several times over', () => {
    expect(new Item('steak').nutrition).toBeGreaterThan(new Item('rawmeat').nutrition * 3);
    expect(new Item('bakedpotato').nutrition).toBeGreaterThan(new Item('potato').nutrition * 3);
  });

  it('a generator is a trip, not a pickup', () => {
    // Twenty-five kilograms against a ten kilogram bag: you carry it or you
    // carry everything else.
    const { p } = setup();
    p.inventory.add(new Item('generator'));
    expect(p.inventory.overloaded).toBe(true);
    expect(p.inventory.mobility).toBeLessThan(0.6);
  });

  it('feeds a fire from the bag on the same key that opens a door', () => {
    const { p, s } = setup();
    const fire = s.add(5, 4, 0, 'fire');
    p.inventory.add(new Item('plank', 2));
    expect(p._useStation(4, 4)).toBe(true);
    expect(fire.lit).toBe(true);
    expect(p.inventory.countOf('plank')).toBe(1);
  });
});

describe('saving what you built', () => {
  it('round-trips every station and what is left in it', () => {
    const g = ground();
    const s = new Stations(g);
    const barrel = s.add(3, 3, 0, 'barrel');
    barrel.water = 7;
    const fire = s.add(6, 6, 0, 'fire');
    s.refuel(fire, 3);

    const json = JSON.parse(JSON.stringify(s.toJSON()));
    const restored = new Stations(g);
    restored.fromJSON(json);

    expect(restored.at(3, 3, 0).water).toBe(7);
    expect(restored.at(6, 6, 0).fuel).toBe(3);
    expect(restored.at(6, 6, 0).lit).toBe(true);
    expect(restored.powered).toBe(false);
  });

  it('is a short list rather than an array over the grid', () => {
    const g = ground(64, 64);
    const s = new Stations(g);
    s.add(3, 3, 0, 'barrel');
    expect(JSON.stringify(s.toJSON()).length).toBeLessThan(300);
  });
});

describe('the recipe table', () => {
  it('gives every placement recipe a real object to place', () => {
    for (const recipe of Object.values(RECIPE_BY_ID)) {
      if (recipe.output !== OUTPUT.PLACE) continue;
      expect(recipe.objectId, recipe.id).toBeGreaterThan(0);
      expect(Object.values(OBJ)).toContain(recipe.objectId);
    }
  });

  it('gives every cooking recipe something to cook on', () => {
    for (const recipe of Object.values(RECIPE_BY_ID)) {
      if (!recipe.needsFire) continue;
      expect(recipe.output).toBe(OUTPUT.ITEM);
      expect(recipe.itemId).toBeTruthy();
    }
  });
});
