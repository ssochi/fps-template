import { describe, expect, it } from 'vitest';
import { Item, ITEMS, KIND, itemsOfKind } from '../src/items/ItemDb.js';
import { Container, Inventory } from '../src/items/Container.js';
import { LootSystem, TABLES } from '../src/items/Loot.js';
import { TileGrid, FLOOR } from '../src/world/TileGrid.js';
import { OBJ, packObject, OBJECT_SPEC } from '../src/world/Objects.js';
import { Body } from '../src/sim/Body.js';
import { Moodles } from '../src/sim/Moodles.js';
import { Player } from '../src/entity/Player.js';

function grid(w = 12, d = 12) {
  const g = new TileGrid(w, d, 1);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, 0, FLOOR.WOOD);
  return g;
}

describe('items', () => {
  it('weighs a stack by its count', () => {
    const one = new Item('bandage', 1);
    const five = new Item('bandage', 5);
    expect(five.weight).toBeCloseTo(one.weight * 5);
  });

  it('rejects unknown ids loudly rather than making an empty item', () => {
    expect(() => new Item('nonsense')).toThrow();
  });

  it('spoils perishables and leaves tinned food alone', () => {
    const bread = new Item('bread');
    const beans = new Item('beans');
    expect(bread.spoilage).toBe(0);

    bread.age_(ITEMS.bread.perishable + 1);
    beans.age_(10000);
    expect(bread.spoiled).toBe(true);
    expect(beans.spoiled).toBe(false);
    expect(beans.nutrition).toBe(ITEMS.beans.nutrition);
  });

  it('makes spoiled food worthless, not merely worse', () => {
    const steak = new Item('steak');
    steak.age_(ITEMS.steak.perishable + 1);
    expect(steak.nutrition).toBe(0);
    expect(steak.hydration).toBe(0);
  });

  it('degrades nutrition gradually before it spoils', () => {
    const fresh = new Item('bread');
    const stale = new Item('bread');
    stale.age_(ITEMS.bread.perishable * 0.8);
    expect(stale.nutrition).toBeLessThan(fresh.nutrition);
    expect(stale.nutrition).toBeGreaterThan(0);
  });

  it('says so in the label when food has turned', () => {
    const milk = new Item('milk');
    milk.age_(ITEMS.milk.perishable + 1);
    expect(milk.label()).toContain('rotten');
  });

  it('gives fresh food better nutrition than tinned, as the trade for spoiling', () => {
    expect(ITEMS.steak.nutrition).toBeGreaterThan(ITEMS.beans.nutrition);
    expect(ITEMS.steak.perishable).toBeDefined();
    expect(ITEMS.beans.perishable).toBeUndefined();
  });

  it('has at least one item of every kind', () => {
    for (const kind of Object.values(KIND)) {
      expect(itemsOfKind(kind).length, kind).toBeGreaterThan(0);
    }
  });
});

describe('containers', () => {
  it('measures capacity in weight, not slots', () => {
    const c = new Container(2);
    expect(c.add(new Item('crisps'))).toBe(true); // 0.1 kg
    expect(c.add(new Item('axe'))).toBe(false); // 3.2 kg
    expect(c.items).toHaveLength(1);
  });

  it('merges stacks of the same thing', () => {
    const c = new Container(10);
    c.add(new Item('bandage', 2));
    c.add(new Item('bandage', 2));
    expect(c.items).toHaveLength(1);
    expect(c.countOf('bandage')).toBe(4);
  });

  it('will not merge food of very different ages', () => {
    // Merging would silently launder spoilage, which is the one thing an age is
    // there to prevent.
    const c = new Container(10);
    const fresh = new Item('rag', 1);
    const old = new Item('rag', 1);
    c.add(fresh);
    c.add(old);
    expect(c.countOf('rag')).toBe(2);

    const d = new Container(10);
    const a = new Item('bandage', 1);
    const b = new Item('bandage', 1);
    b.age = 500; // bandages do not perish, so age never diverges in practice
    d.add(a);
    d.add(b);
    expect(d.items).toHaveLength(2);
  });

  it('splits a stack when only part is taken', () => {
    const c = new Container(10);
    const stack = new Item('bandage', 5);
    c.add(stack);
    const taken = c.remove(stack, 2);
    expect(taken.count).toBe(2);
    expect(c.countOf('bandage')).toBe(3);
  });

  it('transfers only when there is room', () => {
    const from = new Container(10);
    const to = new Container(1);
    const axe = new Item('axe');
    from.add(axe);
    expect(from.transferTo(to, axe)).toBe(false);
    expect(from.countOf('axe')).toBe(1);

    const big = new Container(10);
    expect(from.transferTo(big, axe)).toBe(true);
    expect(from.countOf('axe')).toBe(0);
    expect(big.countOf('axe')).toBe(1);
  });

  it('ages and discards its contents', () => {
    const c = new Container(20);
    c.add(new Item('milk'));
    c.add(new Item('beans'));
    c.age(ITEMS.milk.perishable + 1);
    expect(c.discardSpoiled()).toBe(1);
    expect(c.countOf('beans')).toBe(1);
  });

  it('lists heaviest first, so the problem is at the top', () => {
    const c = new Container(20);
    c.add(new Item('crisps'));
    c.add(new Item('axe'));
    expect(c.sorted()[0].id).toBe('axe');
  });
});

describe('encumbrance', () => {
  it('lets you overload yourself rather than refusing', () => {
    // A hard cap makes the player put things back; a soft one makes them decide
    // whether the trip is worth being slow for.
    const inv = new Inventory(2);
    expect(inv.add(new Item('axe'))).toBe(true);
    expect(inv.overloaded).toBe(true);
  });

  it('costs speed in proportion to the overload', () => {
    const inv = new Inventory(10);
    expect(inv.mobility).toBe(1);
    inv.add(new Item('axe', 4)); // 12.8 kg
    const slow = inv.mobility;
    expect(slow).toBeLessThan(1);
    inv.add(new Item('axe', 4));
    expect(inv.mobility).toBeLessThan(slow);
  });

  it('never slows you to a standstill', () => {
    const inv = new Inventory(1);
    inv.add(new Item('axe', 40));
    expect(inv.mobility).toBeGreaterThan(0.3);
  });
});

describe('loot', () => {
  function world() {
    const g = grid(20, 20);
    g.setObject(5, 5, 0, packObject(OBJ.FRIDGE, 0));
    g.setRoom(5, 5, 0, 1);
    g.setObject(7, 5, 0, packObject(OBJ.WARDROBE, 0));
    g.setRoom(7, 5, 0, 2);
    g.setObject(9, 5, 0, packObject(OBJ.TABLE, 0)); // not a container
    const purposes = new Map([[1, 'kitchen'], [2, 'bedroom']]);
    return { g, loot: new LootSystem(g, 'seed', purposes) };
  }

  it('only opens things that are containers', () => {
    const { loot } = world();
    expect(loot.open(5, 5, 0)).not.toBe(null);
    expect(loot.open(9, 5, 0)).toBe(null);
    expect(loot.open(1, 1, 0)).toBe(null);
  });

  it('puts food in a kitchen fridge and linen in a bedroom wardrobe', () => {
    // Rolled over many seeds, because any single container may be empty.
    const kinds = { fridge: new Set(), wardrobe: new Set() };
    for (let s = 0; s < 40; s++) {
      const g = grid(20, 20);
      g.setObject(5, 5, 0, packObject(OBJ.FRIDGE, 0));
      g.setRoom(5, 5, 0, 1);
      g.setObject(7, 5, 0, packObject(OBJ.WARDROBE, 0));
      g.setRoom(7, 5, 0, 2);
      const l = new LootSystem(g, `seed-${s}`, new Map([[1, 'kitchen'], [2, 'bedroom']]));
      for (const i of l.open(5, 5, 0).items) kinds.fridge.add(i.id);
      for (const i of l.open(7, 5, 0).items) kinds.wardrobe.add(i.id);
    }
    const fridgeTable = new Set(TABLES.kitchen[OBJ.FRIDGE]);
    for (const id of kinds.fridge) expect(fridgeTable.has(id), `${id} in fridge`).toBe(true);
    const wardrobeTable = new Set(TABLES.bedroom[OBJ.WARDROBE]);
    for (const id of kinds.wardrobe) expect(wardrobeTable.has(id), `${id} in wardrobe`).toBe(true);
  });

  it('is deterministic — the same cupboard holds the same thing', () => {
    const a = world();
    const b = world();
    const first = a.loot.open(5, 5, 0).items.map((i) => `${i.id}x${i.count}`);
    const second = b.loot.open(5, 5, 0).items.map((i) => `${i.id}x${i.count}`);
    expect(first).toEqual(second);
  });

  it('generates only on first open, and remembers afterwards', () => {
    const { loot } = world();
    const first = loot.open(5, 5, 0);
    expect(loot.stats.generated).toBe(1);
    const again = loot.open(5, 5, 0);
    expect(again).toBe(first);
    expect(loot.stats.generated).toBe(1);
  });

  it('leaves some containers empty', () => {
    // An empty cupboard is what makes a full one worth something.
    let empties = 0;
    for (let s = 0; s < 60; s++) {
      const g = grid(20, 20);
      g.setObject(3, 3, 0, packObject(OBJ.BIN, 0));
      const l = new LootSystem(g, `e-${s}`, new Map());
      if (l.open(3, 3, 0).isEmpty) empties++;
    }
    expect(empties).toBeGreaterThan(5);
  });

  it('ages perishables that were already sitting there', () => {
    let aged = 0;
    for (let s = 0; s < 40; s++) {
      const g = grid(20, 20);
      g.setObject(5, 5, 0, packObject(OBJ.FRIDGE, 0));
      g.setRoom(5, 5, 0, 1);
      const l = new LootSystem(g, `a-${s}`, new Map([[1, 'kitchen']]));
      for (const i of l.open(5, 5, 0).items) if (i.age > 0) aged++;
    }
    expect(aged).toBeGreaterThan(0);
  });

  it('marks a searched container in the grid', () => {
    const { g, loot } = world();
    loot.open(5, 5, 0);
    loot.markSearched(5, 5, 0);
    expect(g.state[g.idx(5, 5, 0)] & 4).toBe(4);
  });

  it('only lists containers that are actually flagged as such', () => {
    for (const [objId, table] of Object.entries(TABLES.kitchen)) {
      expect(OBJECT_SPEC[objId]?.container, `object ${objId}`).toBe(true);
      expect(table.length).toBeGreaterThan(0);
    }
  });
});

describe('using items', () => {
  function player() {
    const p = new Player(grid());
    p.moodles = new Moodles(p.body);
    return p;
  }

  it('eating reduces hunger and consumes the item', () => {
    const p = player();
    p.moodles.hunger = 0.8;
    const beans = new Item('beans');
    p.inventory.add(beans);
    expect(p.consume(beans)).toBe(true);
    expect(p.moodles.hunger).toBeLessThan(0.8);
    expect(p.inventory.countOf('beans')).toBe(0);
  });

  it('drinking reduces thirst', () => {
    const p = player();
    p.moodles.thirst = 0.9;
    const water = new Item('water');
    p.inventory.add(water);
    p.consume(water);
    expect(p.moodles.thirst).toBeLessThan(0.5);
  });

  it('refuses to eat something rotten', () => {
    const p = player();
    const milk = new Item('milk');
    milk.age_(ITEMS.milk.perishable + 1);
    p.inventory.add(milk);
    expect(p.consume(milk)).toBe(false);
    expect(p.inventory.countOf('milk')).toBe(1);
  });

  it('equipping swaps weapons and puts the old one back in the bag', () => {
    const p = player();
    expect(p.weapon.def.id).toBe('crowbar');
    const axe = new Item('axe');
    p.inventory.add(axe);
    expect(p.equip(axe)).toBe(true);
    expect(p.weapon.def.id).toBe('axe');
    // Losing the crowbar because you picked up an axe would be a bad surprise.
    expect(p.inventory.countOf('crowbar')).toBe(1);
    expect(p.inventory.countOf('axe')).toBe(0);
  });

  it('will not equip something that is not a weapon', () => {
    const p = player();
    const beans = new Item('beans');
    p.inventory.add(beans);
    expect(p.equip(beans)).toBe(false);
  });

  it('bandages the worst wound without asking which', () => {
    const p = player();
    p.body.hurt({ amount: 40, part: 4, bleed: 2, roll: () => 0.99 });
    const bandage = new Item('bandage');
    p.inventory.add(bandage);
    expect(p.useMedical(bandage)).toBe(true);
    expect(p.body.bleed[4]).toBeLessThan(2);
    expect(p.inventory.countOf('bandage')).toBe(0);
  });

  it('a first aid kit heals as well as stopping the bleeding', () => {
    const p = player();
    p.body.hurt({ amount: 50, part: 1, bleed: 1, roll: () => 0.99 });
    const kit = new Item('firstaid');
    p.inventory.add(kit);
    p.useMedical(kit);
    expect(p.body.health[1]).toBeGreaterThan(50);
    expect(p.body.bleed[1]).toBe(0);
  });

  it('carrying too much slows the player down', () => {
    const p = player();
    const before = p.inventory.mobility;
    p.inventory.add(new Item('axe', 6));
    expect(p.inventory.mobility).toBeLessThan(before);
  });
});

describe('dressings', () => {
  function player() {
    const p = new Player(grid());
    p.moodles = new Moodles(p.body);
    return p;
  }

  it('works the same way on a light wound and a bad one', () => {
    // The bug this pins: a flat subtraction fully stops a scratch and barely
    // touches a deep wound, so the item behaves differently depending on how
    // hurt you are — which is the opposite of what a bandage should do.
    const light = player();
    light.body.hurt({ amount: 5, part: 1, bleed: 0.4, roll: () => 0.99 });
    const lightBefore = light.body.bleed[1];
    const b1 = new Item('bandage');
    light.inventory.add(b1);
    light.useMedical(b1);
    const lightRatio = light.body.bleed[1] / lightBefore;

    const bad = player();
    bad.body.hurt({ amount: 5, part: 1, bleed: 4, roll: () => 0.99 });
    const badBefore = bad.body.bleed[1];
    const b2 = new Item('bandage');
    bad.inventory.add(b2);
    bad.useMedical(b2);
    const badRatio = bad.body.bleed[1] / badBefore;

    expect(lightRatio).toBeCloseTo(badRatio, 5);
  });

  it('ranks a kit above a bandage above a rag', () => {
    expect(ITEMS.firstaid.stopsBleeding).toBeGreaterThan(ITEMS.bandage.stopsBleeding);
    expect(ITEMS.bandage.stopsBleeding).toBeGreaterThan(ITEMS.rag.stopsBleeding);
  });
});
