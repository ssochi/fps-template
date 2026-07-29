import { describe, expect, it } from 'vitest';
import { TileGrid, FLOOR, WALL } from '../src/world/TileGrid.js';
import { OBJ, packObject } from '../src/world/Objects.js';
import { Item } from '../src/items/ItemDb.js';
import { RECIPE_BY_ID, RECIPES, BARRICADE, canCraft, consumeMaterials, OUTPUT } from '../src/items/Recipes.js';
import { Construction, Siege, ZOMBIE_PLANK_DAMAGE } from '../src/sim/Construction.js';
import { Player } from '../src/entity/Player.js';
import { Moodles } from '../src/sim/Moodles.js';
import { Horde, STATE } from '../src/sim/Horde.js';
import { FlowField } from '../src/sim/FlowField.js';
import { SoundField } from '../src/sim/Sound.js';
import { DIR } from '../src/core/constants.js';
import { events } from '../src/core/Events.js';

function grid(w = 16, d = 16) {
  const g = new TileGrid(w, d, 1);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, 0, FLOOR.WOOD);
  return g;
}

/** A player standing at (5,5) facing east, with a window on that edge. */
function scene({ facing = DIR.E } = {}) {
  const g = grid();
  g.setWall(5, 5, 0, facing, WALL.WINDOW);
  const p = new Player(g);
  p.moodles = new Moodles(p.body);
  p.position.set(5.5, 0, 5.5);
  // Face the wall: yaw 0 is -Z, and Entity's convention is atan2(-x, -z).
  const dirVec = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0] }[facing];
  p.setYaw(Math.atan2(-dirVec[0], -dirVec[1]));
  return { g, p, c: new Construction(g, p) };
}

describe('recipes', () => {
  it('only consumes materials the loot tables actually produce', () => {
    const g = grid();
    const p = new Player(g);
    for (const r of RECIPES) {
      for (const id of Object.keys(r.materials)) {
        expect(() => new Item(id), `${r.id} needs ${id}`).not.toThrow();
      }
    }
  });

  it('reports what is missing rather than just failing', () => {
    const g = grid();
    const p = new Player(g);
    const check = canCraft(RECIPE_BY_ID['make-bandage'], p.inventory);
    expect(check.ok).toBe(false);
    expect(check.missing).toContain('rag');
  });

  it('treats a zero-count material as a tool that is held, not spent', () => {
    const g = grid();
    const p = new Player(g);
    const salvage = RECIPE_BY_ID['salvage-planks'];
    // Nothing in the bag, but a crowbar in hand.
    expect(canCraft(salvage, p.inventory, { weaponId: 'crowbar' }).ok).toBe(true);
    consumeMaterials(salvage, p.inventory);
    expect(p.weapon.def.id).toBe('crowbar'); // not eaten by the recipe
  });

  it('consumes across several stacks', () => {
    const g = grid();
    const p = new Player(g);
    p.inventory.add(new Item('rag', 2));
    p.inventory.add(new Item('rag', 2));
    consumeMaterials(RECIPE_BY_ID['make-bandage'], p.inventory);
    expect(p.inventory.countOf('rag')).toBe(1);
  });

  it('makes fortifying the loudest thing you can do', () => {
    // The tension of base building: making a place safe tells the street where
    // you are. The barricade recipe must be louder than the quiet ones.
    const barricade = RECIPE_BY_ID.barricade;
    const quiet = RECIPE_BY_ID['rip-sheet'];
    expect(barricade.noise).toBeGreaterThan(quiet.noise * 5);
  });
});

describe('building', () => {
  it('refuses to barricade a solid wall', () => {
    const { g, c } = scene();
    g.setWall(5, 5, 0, DIR.E, WALL.BRICK);
    c.player.inventory.add(new Item('plank', 2));
    c.player.inventory.add(new Item('nails', 2));
    expect(c.begin(RECIPE_BY_ID.barricade)).toBe('face a window or doorway');
  });

  it('barricades the opening the player is facing', () => {
    const { g, c, p } = scene();
    p.inventory.add(new Item('plank', 2));
    p.inventory.add(new Item('nails', 2));
    expect(c.begin(RECIPE_BY_ID.barricade)).toBe(null);
    for (let t = 0; t < 5; t += 1 / 30) c.update(1 / 30);
    expect(g.barricadeAt(5, 5, 0, DIR.E).planks).toBe(1);
    expect(p.inventory.countOf('plank')).toBe(1);
  });

  it('blocks movement and sight once planks are up', () => {
    const { g, c, p } = scene();
    expect(g.canPass(5, 5, 6, 5, 0)).toBe(false); // a window is climbable, not walkable
    expect(g.blocksSight(5, 5, 6, 5, 0)).toBe(false);
    expect(g.canClimb(5, 5, 6, 5, 0)).toBe(true);

    p.inventory.add(new Item('plank', 1));
    p.inventory.add(new Item('nails', 1));
    c.begin(RECIPE_BY_ID.barricade);
    for (let t = 0; t < 5; t += 1 / 30) c.update(1 / 30);

    expect(g.blocksSight(5, 5, 6, 5, 0)).toBe(true);
    // You cannot see out either — that is the trade.
    expect(g.blocksSight(6, 5, 5, 5, 0)).toBe(true);
    expect(g.canClimb(5, 5, 6, 5, 0)).toBe(false);
  });

  it('stacks planks up to a limit', () => {
    const { g, c, p } = scene();
    p.inventory.add(new Item('plank', 4));
    p.inventory.add(new Item('nails', 4));
    p.inventory.add(new Item('plank', 4));
    p.inventory.add(new Item('nails', 4));
    for (let n = 0; n < 6; n++) {
      c.cancel();
      const reason = c.begin(RECIPE_BY_ID.barricade);
      if (reason) break;
      for (let t = 0; t < 5; t += 1 / 30) c.update(1 / 30);
    }
    expect(g.barricadeAt(5, 5, 0, DIR.E).planks).toBe(BARRICADE.maxPlanks);
  });

  it('refuses a second job while one is running', () => {
    const { c, p } = scene();
    p.inventory.add(new Item('sheet', 2));
    expect(c.begin(RECIPE_BY_ID['rip-sheet'])).toBe(null);
    expect(c.begin(RECIPE_BY_ID['rip-sheet'])).toBe('busy');
  });

  it('makes noise the whole time it is working', () => {
    const { c, p } = scene();
    p.inventory.add(new Item('plank', 1));
    p.inventory.add(new Item('nails', 1));
    const heard = [];
    const off = events.on('noise:made', (e) => heard.push(e));
    c.begin(RECIPE_BY_ID.barricade);
    for (let t = 0; t < 3; t += 1 / 30) c.update(1 / 30);
    off();
    expect(heard.filter((e) => e.source === 'crafting').length).toBeGreaterThan(2);
  });

  it('produces the crafted item into the bag', () => {
    const { c, p } = scene();
    p.inventory.add(new Item('sheet', 1));
    c.begin(RECIPE_BY_ID['rip-sheet']);
    for (let t = 0; t < 4; t += 1 / 30) c.update(1 / 30);
    expect(p.inventory.countOf('rag')).toBe(4);
    expect(p.inventory.countOf('sheet')).toBe(0);
  });

  it('holds the player in place while working', () => {
    const { c, p } = scene();
    p.inventory.add(new Item('sheet', 1));
    c.begin(RECIPE_BY_ID['rip-sheet']);
    c.update(1 / 30);
    expect(p.busy).toBeGreaterThan(0);
  });
});

describe('siege', () => {
  function besieged() {
    const g = grid(24, 24);
    // A wall with a doorway, barricaded, and the player behind it.
    for (let z = 0; z < 24; z++) g.setWall(12, z, 0, DIR.W, WALL.BRICK);
    g.setWall(12, 10, 0, DIR.W, WALL.DOORWAY);
    g.addPlank(12, 10, 0, DIR.W, BARRICADE.hpPerPlank, BARRICADE.maxPlanks);

    const flow = new FlowField(g, 0);
    const sound = new SoundField(g, 0);
    const horde = new Horde(g, flow, sound, { capacity: 16, seed: 'siege' });
    const siege = new Siege(g, horde);
    flow.build([{ x: 16, z: 10 }]);
    return { g, horde, flow, siege };
  }

  it('a barricade blocks the dead, at first', () => {
    const { g } = besieged();
    expect(g.canPass(11, 10, 12, 10, 0)).toBe(false);
  });

  it('a chasing zombie hammers on it', () => {
    const { g, horde, flow, siege } = besieged();
    const i = horde.spawn(11, 10, 0);
    horde.state[i] = STATE.CHASE;
    const before = g.barricadeAt(12, 10, 0, DIR.W).hp;
    for (let t = 0; t < 3; t += 1 / 30) siege.update(1 / 30, flow);
    expect(g.barricadeAt(12, 10, 0, DIR.W).hp).toBeLessThan(before);
    expect(siege.stats.hits).toBeGreaterThan(0);
  });

  it('a wanderer does not demolish the neighbourhood', () => {
    const { g, horde, flow, siege } = besieged();
    const i = horde.spawn(11, 10, 0);
    horde.state[i] = STATE.WANDER;
    const before = g.barricadeAt(12, 10, 0, DIR.W).hp;
    for (let t = 0; t < 3; t += 1 / 30) siege.update(1 / 30, flow);
    expect(g.barricadeAt(12, 10, 0, DIR.W).hp).toBe(before);
  });

  it('gets through eventually — a barricade is a delay, not a wall', () => {
    const { g, horde, flow, siege } = besieged();
    for (let n = 0; n < 4; n++) {
      const i = horde.spawn(11, 10 + (n % 2), 0);
      horde.x[i] = 11.5;
      horde.z[i] = 10.5;
      horde.state[i] = STATE.CHASE;
    }
    for (let t = 0; t < 60; t += 1 / 30) siege.update(1 / 30, flow);
    expect(g.isBarricaded(11, 10, 12, 10, 0)).toBe(false);
    expect(siege.stats.breaches).toBeGreaterThan(0);
    expect(g.canPass(11, 10, 12, 10, 0)).toBe(true);
  });

  it('makes a racket doing it, which brings more', () => {
    const { horde, flow, siege } = besieged();
    const i = horde.spawn(11, 10, 0);
    horde.state[i] = STATE.CHASE;
    const heard = [];
    const off = events.on('noise:made', (e) => heard.push(e));
    for (let t = 0; t < 3; t += 1 / 30) siege.update(1 / 30, flow);
    off();
    expect(heard.some((e) => e.source === 'siege')).toBe(true);
  });

  it('forces a shut door rather than picking at it', () => {
    const g = grid(24, 24);
    for (let z = 0; z < 24; z++) g.setWall(12, z, 0, DIR.W, WALL.BRICK);
    g.setWall(12, 10, 0, DIR.W, WALL.DOORWAY);
    g.setObject(12, 10, 0, packObject(OBJ.DOOR, DIR.W));
    const flow = new FlowField(g, 0);
    const horde = new Horde(g, flow, new SoundField(g, 0), { capacity: 8, seed: 'door' });
    const siege = new Siege(g, horde);
    flow.build([{ x: 16, z: 10 }]);

    const i = horde.spawn(11, 10, 0);
    horde.state[i] = STATE.CHASE;
    expect(g.isDoorOpen(11, 10, 12, 10, 0)).toBe(false);
    for (let t = 0; t < 3; t += 1 / 30) siege.update(1 / 30, flow);
    expect(g.isDoorOpen(11, 10, 12, 10, 0)).toBe(true);
  });

  it('needs several hits per plank, so the delay is real', () => {
    expect(BARRICADE.hpPerPlank / ZOMBIE_PLANK_DAMAGE).toBeGreaterThan(3);
  });
});

describe('painkillers and torches', () => {
  it('painkillers suppress pain rather than mending anything', () => {
    const g = grid();
    const p = new Player(g);
    p.moodles = new Moodles(p.body);
    p.body.hurt({ amount: 60, part: 1, roll: () => 0.99 });
    const pain = p.body.pain;
    const health = p.body.health[1];
    const pills = new Item('painkillers');
    p.inventory.add(pills);
    expect(p.useMedical(pills)).toBe(true);
    expect(p.body.pain).toBeLessThan(pain);
    expect(p.body.health[1]).toBe(health); // no healing
  });

  it('a torch only lights when you have one', () => {
    const g = grid();
    const p = new Player(g);
    expect(p.hasTorch).toBe(false);
    expect(p.toggleTorch()).toBe(false);

    p.inventory.add(new Item('torch'));
    expect(p.toggleTorch()).toBe(true);
    expect(p.toggleTorch()).toBe(false);
  });
});
