/**
 * M19 — full carpentry.
 *
 * M18 made three specific objects placeable. This generalises it: furniture and
 * storage you build, walls where there was a gap, and — the half that was
 * missing — the ability to take any of it back down or mend it.
 */
import { describe, expect, it } from 'vitest';
import { TileGrid, FLOOR, WALL } from '../src/world/TileGrid.js';
import { OBJ, objectId, packObject } from '../src/world/Objects.js';
import { Player } from '../src/entity/Player.js';
import { Moodles } from '../src/sim/Moodles.js';
import { Stations } from '../src/sim/Stations.js';
import { Construction } from '../src/sim/Construction.js';
import { LootSystem } from '../src/items/Loot.js';
import { BARRICADE, OUTPUT, RECIPE_BY_ID, RECIPES } from '../src/items/Recipes.js';
import { Item } from '../src/items/ItemDb.js';
import { DIR } from '../src/core/constants.js';

function ground(w = 16, d = 16) {
  const g = new TileGrid(w, d, 1);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, 0, FLOOR.CONCRETE);
  return g;
}

/** A survivor at (4.5, 4.5) facing south (+Z), with everything wired. */
function setup(grid = ground()) {
  const p = new Player(grid);
  p.moodles = new Moodles(p.body);
  const stations = new Stations(grid);
  p.stations = stations;
  p.position.set(4.5, 0, 4.5);
  p.setYaw(Math.PI);
  const loot = new LootSystem(grid, 'carpentry', new Map());
  const c = new Construction(grid, p, stations);
  c.loot = loot;
  return { g: grid, p, c, loot, stations };
}

/** Run a job to completion. */
function build(c, recipeId) {
  const reason = c.begin(RECIPE_BY_ID[recipeId]);
  if (reason) return reason;
  c.update(30);
  return null;
}

describe('building a wall where there was none', () => {
  it('boards an open edge between two floors', () => {
    const { g, p, c } = setup();
    p.inventory.add(new Item('plank', 3));
    p.inventory.add(new Item('nails', 1));

    expect(g.isBarricaded(4, 4, 4, 5, 0)).toBe(false);
    expect(build(c, 'plank-wall')).toBe(null);
    expect(g.isBarricaded(4, 4, 4, 5, 0)).toBe(true);
  });

  it('stops movement and sight, which is what makes it a wall', () => {
    const { g, p, c } = setup();
    p.inventory.add(new Item('plank', 3));
    p.inventory.add(new Item('nails', 1));
    build(c, 'plank-wall');

    expect(g.canPass(4, 4, 4, 5, 0)).toBe(false);
    expect(g.blocksSight(4, 4, 4, 5, 0)).toBe(true);
    // …and both ways round, like every other wall in the game.
    expect(g.canPass(4, 5, 4, 4, 0)).toBe(false);
  });

  it('refuses to build across the void', () => {
    const g = ground();
    // Remove the floor beyond the player.
    g.setFloor(4, 5, 0, FLOOR.VOID);
    const { p, c } = setup(g);
    p.inventory.add(new Item('plank', 3));
    p.inventory.add(new Item('nails', 1));
    expect(build(c, 'plank-wall')).not.toBe(null);
  });

  it('refuses to build where a wall already is', () => {
    const g = ground();
    g.setWall(4, 5, 0, DIR.N, WALL.BRICK);
    const { p, c } = setup(g);
    p.inventory.add(new Item('plank', 3));
    p.inventory.add(new Item('nails', 1));
    expect(build(c, 'plank-wall')).not.toBe(null);
  });

  it('is a barricade, so the dead can break it — not an off switch', () => {
    // The M6 lesson, kept: a wall the player built must be destructible or a
    // base becomes a way to stop playing.
    const { g, p, c } = setup();
    p.inventory.add(new Item('plank', 3));
    p.inventory.add(new Item('nails', 1));
    build(c, 'plank-wall');

    let hits = 0;
    while (g.isBarricaded(4, 4, 4, 5, 0) && hits < 400) {
      g.damageBarricade(4, 4, 4, 5, 0, 9);
      hits++;
    }
    expect(g.isBarricaded(4, 4, 4, 5, 0)).toBe(false);
    // …but it takes a while. A wall that falls in three swings is decoration.
    // Three planks in, so three planks of wall: roughly twenty swings.
    expect(hits).toBeGreaterThan(15);
  });
});

describe('repairing', () => {
  function damaged() {
    const { g, p, c } = setup();
    g.setWall(4, 5, 0, DIR.N, WALL.WINDOW);
    g.addPlank(4, 4, 0, DIR.S, BARRICADE.hpPerPlank, BARRICADE.maxPlanks);
    g.addPlank(4, 4, 0, DIR.S, BARRICADE.hpPerPlank, BARRICADE.maxPlanks);
    g.damageBarricade(4, 4, 4, 5, 0, 50);
    return { g, p, c };
  }

  it('makes a damaged barricade whole for the price of nails', () => {
    const { g, p, c } = damaged();
    const before = g.barricadeAt(4, 4, 0, DIR.S);
    expect(before.hp).toBeLessThan(before.planks * BARRICADE.hpPerPlank);

    p.inventory.add(new Item('nails', 1));
    expect(build(c, 'repair-barricade')).toBe(null);

    const after = g.barricadeAt(4, 4, 0, DIR.S);
    expect(after.hp).toBe(after.planks * BARRICADE.hpPerPlank);
    expect(after.planks).toBe(before.planks); // mended, not reinforced
  });

  it('refuses when there is nothing to mend', () => {
    const { g, p, c } = setup();
    g.setWall(4, 5, 0, DIR.N, WALL.WINDOW);
    g.addPlank(4, 4, 0, DIR.S, BARRICADE.hpPerPlank, BARRICADE.maxPlanks);
    p.inventory.add(new Item('nails', 1));
    expect(build(c, 'repair-barricade')).not.toBe(null);
  });

  it('spends the nails only once the work is done', () => {
    const { p, c } = damaged();
    p.inventory.add(new Item('nails', 2));
    c.begin(RECIPE_BY_ID['repair-barricade']);
    c.update(0.5);
    expect(p.inventory.countOf('nails')).toBe(2);
    c.update(30);
    expect(p.inventory.countOf('nails')).toBe(1);
  });
});

describe('taking it down', () => {
  it('pulls a barricade apart a plank at a time and hands the wood back', () => {
    const { g, p, c } = setup();
    g.setWall(4, 5, 0, DIR.N, WALL.WINDOW);
    g.addPlank(4, 4, 0, DIR.S, BARRICADE.hpPerPlank, BARRICADE.maxPlanks);
    g.addPlank(4, 4, 0, DIR.S, BARRICADE.hpPerPlank, BARRICADE.maxPlanks);
    p.inventory.add(new Item('hammer'));

    expect(build(c, 'dismantle')).toBe(null);
    expect(g.barricadeAt(4, 4, 0, DIR.S).planks).toBe(1);
    expect(p.inventory.countOf('plank')).toBe(1);
  });

  it('removes furniture and returns most of it', () => {
    const { g, p, c } = setup();
    g.setObject(4, 5, 0, packObject(OBJ.WARDROBE, DIR.N));
    p.inventory.add(new Item('hammer'));

    expect(build(c, 'dismantle')).toBe(null);
    expect(g.object[g.index(4, 5, 0)]).toBe(0);
    expect(p.inventory.countOf('plank')).toBeGreaterThan(0);
  });

  it('never lets you dismantle the stairs you are standing on', () => {
    const { g, p, c } = setup();
    g.setObject(4, 5, 0, packObject(OBJ.STAIRS_HIGH, DIR.N));
    g.setObject(4, 4, 0, packObject(OBJ.STAIRS_LOW, DIR.N));
    p.inventory.add(new Item('hammer'));
    expect(build(c, 'dismantle')).not.toBe(null);
  });

  it('never lets you dismantle a door out of its frame', () => {
    const { g, p, c } = setup();
    g.setWall(4, 5, 0, DIR.N, WALL.DOORWAY);
    g.setObject(4, 5, 0, packObject(OBJ.DOOR, DIR.N));
    p.inventory.add(new Item('hammer'));
    expect(build(c, 'dismantle')).not.toBe(null);
  });

  it('costs you a plank overall, so it is not a way to farm wood', () => {
    // Build a crate for three planks and a nail, take it down for two.
    const { p, c } = setup();
    p.inventory.add(new Item('plank', 3));
    p.inventory.add(new Item('nails', 1));
    p.inventory.add(new Item('hammer'));

    expect(build(c, 'place-crate')).toBe(null);
    expect(p.inventory.countOf('plank')).toBe(0);
    expect(build(c, 'dismantle')).toBe(null);
    expect(p.inventory.countOf('plank')).toBeLessThan(3);
  });

  it('forgets the station that was standing there', () => {
    const { g, p, c, stations } = setup();
    p.inventory.add(new Item('plank', 2));
    p.inventory.add(new Item('hammer'));
    expect(build(c, 'campfire')).toBe(null);
    expect(stations.byCell.size).toBe(1);

    expect(build(c, 'dismantle')).toBe(null);
    expect(stations.byCell.size).toBe(0);
    expect(g.object[g.index(4, 5, 0)]).toBe(0);
  });
});

describe('storage you built', () => {
  it('is empty, because loot is a function of the seed and this is not', () => {
    // The bug this prevents: a crate you nailed together thirty seconds ago
    // arriving full of somebody else's tinned beans.
    const { p, c, loot } = setup();
    p.inventory.add(new Item('plank', 3));
    p.inventory.add(new Item('nails', 1));
    expect(build(c, 'place-crate')).toBe(null);

    const container = loot.open(4, 5, 0);
    expect(container).not.toBe(null);
    expect(container.isEmpty).toBe(true);
  });

  it('keeps what you put in it', () => {
    const { p, c, loot } = setup();
    p.inventory.add(new Item('plank', 3));
    p.inventory.add(new Item('nails', 1));
    build(c, 'place-crate');

    const container = loot.open(4, 5, 0);
    container.add(new Item('bandage', 2));
    expect(loot.open(4, 5, 0).countOf('bandage')).toBe(2);
  });

  it('leaves a cupboard that predates the outbreak alone', () => {
    const { g, loot } = setup();
    g.setObject(9, 9, 0, packObject(OBJ.CRATE, DIR.N));
    // Not marked as placed, so it rolls from the seed like everything else.
    const a = loot.open(9, 9, 0);
    const fresh = new LootSystem(g, 'carpentry', new Map());
    const b = fresh.open(9, 9, 0);
    expect(b.items.map((i) => i.id)).toEqual(a.items.map((i) => i.id));
  });
});

describe('the carpentry table', () => {
  it('gives every recipe a description and a time', () => {
    for (const r of RECIPES) {
      expect(r.description?.length, r.id).toBeGreaterThan(10);
      expect(r.seconds, r.id).toBeGreaterThan(0);
    }
  });

  it('makes every job that uses nails loud, because fortifying is loud', () => {
    // The M9 rule, still holding: the act of making a place safe is the act of
    // announcing where you are. Scoped to *nailing*, because laying sticks in
    // a ring for a campfire is genuinely quiet and pretending otherwise would
    // be a rule enforcing itself rather than the fiction.
    for (const r of RECIPES) {
      if (!('nails' in r.materials) && r.output !== OUTPUT.DISMANTLE) continue;
      expect(r.noise, r.id).toBeGreaterThan(5);
    }
  });

  it('gives dismantling and repairing nothing to place', () => {
    for (const id of ['dismantle', 'repair-barricade']) {
      expect(RECIPE_BY_ID[id].objectId).toBeUndefined();
      expect(RECIPE_BY_ID[id].itemId).toBeUndefined();
    }
  });

  it('needs a hammer in hand or in the bag to take anything down', () => {
    const { g, p, c } = setup();
    g.setObject(4, 5, 0, packObject(OBJ.WARDROBE, DIR.N));
    expect(build(c, 'dismantle')).not.toBe(null);
    p.inventory.add(new Item('hammer'));
    expect(build(c, 'dismantle')).toBe(null);
    // …and the hammer survives: a zero-count material is held, not spent.
    expect(p.inventory.countOf('hammer')).toBe(1);
  });
});
