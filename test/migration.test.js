/**
 * M13 — the horde that moves.
 *
 * Three claims are under test here, and they are the three the milestone is
 * about: that the flow field runs up and down stairs, that bounding it costs
 * nothing behavioural, and that a street you cleared does not stay cleared.
 */
import { describe, expect, it } from 'vitest';
import { TileGrid, FLOOR, WALL } from '../src/world/TileGrid.js';
import { OBJ, packObject } from '../src/world/Objects.js';
import { COST, DOWN, FlowField, UP, UNREACHABLE } from '../src/sim/FlowField.js';
import { SoundField } from '../src/sim/Sound.js';
import { Horde, STATE } from '../src/sim/Horde.js';
import { Migration, SCALE } from '../src/sim/Migration.js';
import { DIR, DIR_VEC } from '../src/core/constants.js';

function room(w = 21, d = 21, levels = 1) {
  const g = new TileGrid(w, d, levels);
  for (let l = 0; l < levels; l++) {
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, l, FLOOR.CONCRETE);
  }
  return g;
}

/** A two-storey room joined by the staircase M2 generates. */
function twoStorey(w = 21, d = 21) {
  const g = room(w, d, 2);
  g.setObject(5, 5, 0, packObject(OBJ.STAIRS_LOW, DIR.E));
  g.setObject(6, 5, 0, packObject(OBJ.STAIRS_HIGH, DIR.E));
  g.setFloor(5, 5, 1, FLOOR.VOID);
  return g;
}

/** Walk the field from a cell to the goal, returning the path length or -1. */
function follow(flow, x, z, level = 0, limit = 600) {
  let steps = 0;
  while (flow.costAt(x, z, level) > 0 && steps < limit) {
    const d = flow.directionAt(x, z, level);
    if (d < 0) return -1;
    if (d === UP) level++;
    else if (d === DOWN) level--;
    else {
      x += DIR_VEC[d].dx;
      z += DIR_VEC[d].dz;
    }
    steps++;
  }
  return flow.costAt(x, z, level) === 0 ? steps : -1;
}

describe('vertical links', () => {
  it('joins the two storeys at the column above the top step', () => {
    const g = twoStorey();
    expect(g.climbFrom(6, 5, 0)).toBe(1);
    expect(g.descendFrom(6, 5, 1)).toBe(0);
  });

  it('refuses to climb where there is nothing to arrive on', () => {
    const g = twoStorey();
    g.setFloor(6, 5, 1, FLOOR.VOID); // remove the landing
    expect(g.climbFrom(6, 5, 0)).toBe(-1);
    expect(g.descendFrom(6, 5, 1)).toBe(-1);
  });

  it('never links a storey that does not exist', () => {
    const g = room(9, 9, 1);
    g.setObject(4, 4, 0, packObject(OBJ.STAIRS_HIGH, DIR.E));
    expect(g.climbFrom(4, 4, 0)).toBe(-1);
    expect(g.descendFrom(4, 4, 0)).toBe(-1);
  });
});

describe('the flow field crosses storeys', () => {
  it('routes a zombie upstairs to a target above it', () => {
    const g = twoStorey();
    const flow = new FlowField(g);
    flow.build([{ x: 15, z: 15, level: 1 }]);

    // Somewhere on the ground floor, far from the stairs.
    expect(flow.reachable(18, 2, 0)).toBe(true);
    expect(follow(flow, 18, 2, 0)).toBeGreaterThan(0);
  });

  it('routes downstairs as readily as up', () => {
    const g = twoStorey();
    const flow = new FlowField(g);
    flow.build([{ x: 18, z: 18, level: 0 }]);
    expect(follow(flow, 2, 2, 1)).toBeGreaterThan(0);
  });

  it('marks the actual staircase cells UP and DOWN', () => {
    const g = twoStorey();
    const flow = new FlowField(g);
    flow.build([{ x: 15, z: 15, level: 1 }]);
    // Standing on the top step on the ground floor, the way on is up.
    expect(flow.directionAt(6, 5, 0)).toBe(UP);

    const down = new FlowField(g);
    down.build([{ x: 15, z: 15, level: 0 }]);
    expect(down.directionAt(6, 5, 1)).toBe(DOWN);
  });

  it('leaves an unreachable storey unreachable', () => {
    const g = room(21, 21, 2); // no stairs at all
    const flow = new FlowField(g);
    flow.build([{ x: 10, z: 10, level: 0 }]);
    expect(flow.reachable(10, 10, 0)).toBe(true);
    expect(flow.reachable(10, 10, 1)).toBe(false);
    expect(flow.costAt(10, 10, 1)).toBe(UNREACHABLE);
  });

  it('prefers staying on one storey where a flat route exists', () => {
    // A staircase is a route, not a shortcut: going up and straight back down
    // must never beat walking across the room.
    const g = twoStorey();
    const flow = new FlowField(g);
    flow.build([{ x: 8, z: 5, level: 0 }]);
    // Two tiles west of the bottom step, on the ground floor.
    expect(flow.directionAt(3, 5, 0)).toBe(DIR.E);
  });
});

describe('the bounded sweep', () => {
  it('visits far fewer cells than the map has', () => {
    const g = room(120, 120);
    const flow = new FlowField(g);
    const visited = flow.build([{ x: 60, z: 60 }], 30 * COST.open);
    expect(visited).toBeLessThan(120 * 120 * 0.3);
    // …and a disc of radius 30 is about 2,800 cells, so it should be near that.
    expect(visited).toBeGreaterThan(1500);
  });

  it('still answers everywhere inside the radius', () => {
    const g = room(120, 120);
    const flow = new FlowField(g);
    flow.build([{ x: 60, z: 60 }], 20 * COST.open);
    expect(flow.reachable(60 + 15, 60)).toBe(true);
    expect(flow.reachable(60, 60 - 15)).toBe(true);
    expect(flow.reachable(60 + 40, 60)).toBe(false);
  });

  it('leaves no trace of the previous sweep outside the new one', () => {
    // `reset` only clears the cells the last sweep touched, which is the whole
    // point of bounding it — and the obvious way to get that wrong is to leave
    // a stale direction lying somewhere the new sweep never reaches.
    const g = room(120, 120);
    const flow = new FlowField(g);
    flow.build([{ x: 20, z: 20 }], 15 * COST.open);
    expect(flow.reachable(24, 20)).toBe(true);

    flow.build([{ x: 100, z: 100 }], 15 * COST.open);
    expect(flow.reachable(24, 20)).toBe(false);
    expect(flow.directionAt(24, 20)).toBe(-1);
    expect(flow.reachable(104, 100)).toBe(true);
  });

  it('agrees with the unbounded sweep inside the radius', () => {
    const g = room(60, 60);
    for (let z = 10; z < 50; z++) g.setWall(30, z, 0, DIR.W, WALL.BRICK);
    g.setWall(30, 30, 0, DIR.W, WALL.DOORWAY);

    const bounded = new FlowField(g);
    bounded.build([{ x: 10, z: 30 }], 25 * COST.open);
    const full = new FlowField(g);
    full.build([{ x: 10, z: 30 }], 6000);

    for (let z = 25; z < 36; z++) {
      for (let x = 5; x < 25; x++) {
        if (!bounded.reachable(x, z)) continue;
        expect(bounded.costAt(x, z), `${x},${z}`).toBe(full.costAt(x, z));
      }
    }
  });
});

describe('sound crosses storeys', () => {
  it('is heard through a floor, but faintly', () => {
    const g = twoStorey();
    const sound = new SoundField(g);
    sound.emit(15, 15, 0, 30);
    const here = sound.at(15, 15, 0);
    const above = sound.at(15, 15, 1);
    expect(above).toBeGreaterThan(0);
    expect(above).toBeLessThan(here);
  });

  it('carries far better up a stairwell than through a slab', () => {
    const g = twoStorey();
    const sound = new SoundField(g);
    // Emitted at the foot of the stairs.
    sound.emit(6, 5, 0, 30);
    const upTheStairs = sound.at(6, 5, 1);

    const slab = new SoundField(g);
    slab.emit(15, 15, 0, 30);
    const throughFloor = slab.at(15, 15, 1);
    expect(upTheStairs).toBeGreaterThan(throughFloor);
  });

  it('fades only what is actually audible, and leaves no leak behind', () => {
    // The decay pass walks a list rather than the map. The two ways to get that
    // wrong are to drop a cell that is still loud, and to keep growing the list
    // for ever — so assert both, twice over, with a second noise in between.
    const g = room(60, 60, 2);
    const sound = new SoundField(g);
    sound.emit(30, 30, 0, 25);
    const spread = sound.stats.spread;
    expect(spread).toBeGreaterThan(50);

    sound.update(1 / 30);
    expect(sound.stats.loud).toBeGreaterThan(0);
    expect(sound.stats.loud).toBeLessThanOrEqual(spread);

    sound.emit(10, 10, 0, 25);
    for (let t = 0; t < 600; t++) sound.update(1 / 30);
    expect(sound.stats.loud).toBe(0);
    expect(sound.at(30, 30, 0)).toBe(0);
    expect(sound.at(10, 10, 0)).toBe(0);

    // And it still works afterwards: a stale flag would silence the field.
    sound.emit(30, 30, 0, 25);
    expect(sound.at(30, 30, 0)).toBe(25);
    sound.update(1 / 30);
    expect(sound.at(30, 30, 0)).toBeLessThan(25);
    expect(sound.at(30, 30, 0)).toBeGreaterThan(0);
  });

  it('offers a vertical heading only where a body could take it', () => {
    const g = twoStorey();
    const sound = new SoundField(g);
    sound.emit(15, 15, 1, 40);
    // Standing on the top step below, the loudest way is up.
    expect(sound.loudestDirection(6, 5, 0)).toBe(UP);
    // Standing under a plain ceiling, it is not — there is no way through.
    const d = sound.loudestDirection(15, 15, 0);
    expect(d).not.toBe(UP);
  });
});

describe('the horde uses the stairs', () => {
  function setup() {
    const g = twoStorey(31, 31);
    const flow = new FlowField(g);
    const sound = new SoundField(g);
    const horde = new Horde(g, flow, sound, { capacity: 32, seed: 'stairs' });
    return { g, flow, sound, horde };
  }

  it('climbs to a chasing target on the storey above', () => {
    const { horde, flow } = setup();
    const i = horde.spawn(6, 5, 0); // on the top step
    horde.state[i] = STATE.CHASE;
    horde.attention[i] = 1;
    flow.build([{ x: 15, z: 15, level: 1 }]);

    // Sight cannot reach through a floor, so keep attention topped up: this
    // test is about movement, and `combat.test.js` owns perception.
    for (let t = 0; t < 90; t++) {
      horde.attention[i] = 1;
      horde.update(1 / 30, { x: 15, z: 15, level: 1 });
    }
    expect(horde.level[i]).toBe(1);
  });

  it('takes a beat on the stairs rather than teleporting', () => {
    const { horde, flow } = setup();
    const i = horde.spawn(6, 5, 0);
    horde.state[i] = STATE.CHASE;
    horde.attention[i] = 1;
    flow.build([{ x: 15, z: 15, level: 1 }]);
    horde.attention[i] = 1;
    horde.update(1 / 30, { x: 15, z: 15, level: 1 });
    expect(horde.level[i]).toBe(0);
  });

  it('lands on the tile centre, not half inside a wall', () => {
    // Arriving a hair off centre can put a body on the wrong side of a wall
    // that only exists on the storey it arrived at, so the check is the state
    // *on the tick the storey changes* — a tick later it has walked on.
    const { horde, flow } = setup();
    const i = horde.spawn(6, 5, 0);
    horde.x[i] = 6.94;
    horde.z[i] = 5.08;
    horde.state[i] = STATE.CHASE;
    flow.build([{ x: 15, z: 15, level: 1 }]);

    let arrived = false;
    for (let t = 0; t < 90 && !arrived; t++) {
      horde.attention[i] = 1;
      const before = horde.level[i];
      horde.update(1 / 30, { x: 15, z: 15, level: 1 });
      if (horde.level[i] !== before) {
        arrived = true;
        expect(horde.x[i]).toBeCloseTo(6.5, 5);
        expect(horde.z[i]).toBeCloseTo(5.5, 5);
      }
    }
    expect(arrived).toBe(true);
  });
});

describe('migration', () => {
  function town(w = 64, d = 64) {
    const g = room(w, d);
    return { g, m: new Migration(g) };
  }

  it('measures how much floor each district has', () => {
    const g = new TileGrid(32, 32, 1);
    // Only the western half has any floor at all.
    for (let z = 0; z < 32; z++) for (let x = 0; x < 16; x++) g.setFloor(x, z, 0, FLOOR.CONCRETE);
    const m = new Migration(g);
    expect(m.capacity[m.cellOf(4, 4)]).toBe(SCALE * SCALE);
    expect(m.capacity[m.cellOf(28, 4)]).toBe(0);
  });

  it('counts only the living', () => {
    const { g, m } = town();
    const horde = new Horde(g, null, null, { capacity: 32, seed: 'census' });
    for (let k = 0; k < 6; k++) horde.spawn(10, 10, 0);
    horde.state[0] = STATE.DEAD;
    horde.state[1] = STATE.DEAD;
    m.census(horde);
    expect(m.population[m.cellOf(10, 10)]).toBe(4);
  });

  it('sends a wanderer from a crowded district toward an empty one', () => {
    const { g, m } = town();
    const horde = new Horde(g, null, null, { capacity: 64, seed: 'crowd' });
    for (let k = 0; k < 16; k++) horde.spawn(10, 10, 0);
    m.census(horde);

    const dir = m.driftDirection(10, 10);
    expect(dir).toBeGreaterThanOrEqual(0);
    // Whichever way it points, it must be somewhere less crowded than here.
    const v = DIR_VEC[dir];
    const cx = Math.floor(10 / SCALE) + v.dx;
    const cz = Math.floor(10 / SCALE) + v.dz;
    expect(m.population[m.index(cx, cz)]).toBeLessThan(m.population[m.cellOf(10, 10)]);
  });

  it('stays put in a quiet, evenly settled town', () => {
    const { g, m } = town();
    const horde = new Horde(g, null, null, { capacity: 128, seed: 'even' });
    for (let x = 2; x < 62; x += 4) for (let z = 2; z < 62; z += 4) horde.spawn(x, z, 0);
    m.census(horde);
    expect(m.driftDirection(30, 30)).toBe(-1);
  });

  it('remembers a loud noise long after the sound field has forgotten it', () => {
    const { g, m } = town();
    const sound = new SoundField(g);
    sound.emit(50, 50, 0, 30);
    m.remember(50, 50, 30);

    // Thirty seconds is a very long time for a noise: the sound field is silent.
    for (let t = 0; t < 900; t++) sound.update(1 / 30);
    expect(sound.at(50, 50, 0)).toBe(0);
    expect(m.memory[m.cellOf(50, 50)]).toBeGreaterThan(0);
  });

  it('does not migrate a town over a footstep', () => {
    const { m } = town();
    m.remember(30, 30, 2);
    expect(m.memory[m.cellOf(30, 30)]).toBe(0);
  });

  it('draws wanderers toward a district that heard something', () => {
    const { g, m } = town();
    const horde = new Horde(g, null, null, { capacity: 32, seed: 'draw' });
    // An evenly spread town, so crowding cannot explain the answer.
    for (let x = 2; x < 62; x += 4) for (let z = 2; z < 62; z += 4) horde.spawn(x, z, 0);
    m.census(horde);
    expect(m.driftDirection(30, 30)).toBe(-1);

    m.remember(38, 30, 40); // something loud, two districts east
    const dir = m.driftDirection(34, 30);
    expect(dir).toBe(DIR.E);
  });

  it('forgets eventually, so a town does not converge for ever', () => {
    const { g, m } = town();
    const horde = new Horde(g, null, null, { capacity: 8, seed: 'forget' });
    m.remember(30, 30, 40);
    const start = m.memory[m.cellOf(30, 30)];
    for (let t = 0; t < 60 * 30; t++) m.update(1 / 30, horde); // one real minute
    expect(m.memory[m.cellOf(30, 30)]).toBeLessThan(start);
    expect(m.memory[m.cellOf(30, 30)]).toBe(0);
  });

  it('never sends anyone into a district with no floor', () => {
    const g = new TileGrid(32, 32, 1);
    for (let z = 0; z < 32; z++) for (let x = 0; x < 16; x++) g.setFloor(x, z, 0, FLOOR.CONCRETE);
    const m = new Migration(g);
    const horde = new Horde(g, null, null, { capacity: 32, seed: 'void' });
    for (let k = 0; k < 16; k++) horde.spawn(13, 10, 0);
    m.census(horde);
    // Crowded, and the void is east. It must not be the answer.
    const dir = m.driftDirection(13, 10);
    expect(dir).not.toBe(DIR.E);
  });

  it('refills a cleared street from the streets around it', () => {
    // The claim the whole milestone rests on, run as a simulation rather than
    // asserted about a single call.
    const g = room(64, 64);
    const flow = new FlowField(g);
    const sound = new SoundField(g);
    const m = new Migration(g);
    const horde = new Horde(g, flow, sound, { capacity: 400, seed: 'refill', migration: m });

    for (let k = 0; k < 300; k++) {
      horde.spawn(8 + (k % 40), 8 + Math.floor(k / 40), 0);
    }
    // A block in the north-east that nothing has ever walked into.
    const empty = () => {
      m.census(horde);
      return m.population[m.cellOf(52, 12)];
    };
    expect(empty()).toBe(0);

    for (let t = 0; t < 120 * 30; t++) {
      m.update(1 / 30, horde);
      horde.update(1 / 30, { x: 2, z: 2, level: 0 });
    }
    expect(empty()).toBeGreaterThan(0);
  });
});
