import { describe, expect, it, beforeEach } from 'vitest';
import { Vector3 } from 'three';
import { TileGrid, FLOOR, WALL, STATE } from '../src/world/TileGrid.js';
import { OBJ, packObject } from '../src/world/Objects.js';
import { Player, ENDURANCE, SPEED } from '../src/entity/Player.js';
import { Character, GAITS } from '../src/entity/Character.js';
import { DIR, STOREY } from '../src/core/constants.js';
import { events } from '../src/core/Events.js';

function room(w = 10, d = 10, levels = 2) {
  const g = new TileGrid(w, d, levels);
  for (let l = 0; l < levels; l++) {
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, l, FLOOR.WOOD);
  }
  return g;
}

function makePlayer(grid, x = 4.5, z = 4.5) {
  const p = new Player(grid);
  p.position.set(x, 0, z);
  return p;
}

const still = { move: new Vector3(), run: false, sneak: false, interact: false };
const intentTo = (x, z, extra = {}) => ({
  move: new Vector3(x, 0, z).normalize(),
  run: false,
  sneak: false,
  interact: false,
  ...extra,
});

/** Run the sim for `seconds` at the fixed 30 Hz step. */
function simulate(player, intent, seconds) {
  const dt = 1 / 30;
  for (let t = 0; t < seconds; t += dt) player.update(intent, dt);
}

describe('endurance', () => {
  it('drains while sprinting and recovers when idle', () => {
    const p = makePlayer(room());
    p.hasAim = false;
    simulate(p, intentTo(1, 0, { run: true }), 2);
    const afterRun = p.endurance;
    expect(afterRun).toBeLessThan(1);

    simulate(p, still, 2);
    expect(p.endurance).toBeGreaterThan(afterRun);
  });

  it('recovers more slowly than it drains, so sprinting has a cost', () => {
    expect(ENDURANCE.recover).toBeLessThan(ENDURANCE.runDrain);
  });

  it('becomes winded at empty and stays winded past the threshold', () => {
    const p = makePlayer(room(40, 40));
    p.endurance = 0.01;
    simulate(p, intentTo(1, 0, { run: true }), 0.5);
    expect(p.winded).toBe(true);

    // Recovering a little must NOT immediately un-wind, or the state flickers.
    p.endurance = ENDURANCE.windedUntil - 0.05;
    simulate(p, still, 1 / 30);
    expect(p.winded).toBe(true);

    p.endurance = ENDURANCE.windedUntil + 0.05;
    simulate(p, still, 1 / 30);
    expect(p.winded).toBe(false);
  });

  it('caps a winded player at a walk', () => {
    const p = makePlayer(room(40, 40));
    p.hasAim = false;
    // Winded is derived from endurance every frame, so it has to be set to a
    // value inside the hysteresis band — above empty, below the recovery
    // threshold. Setting `winded` with a full bar is not a reachable state and
    // clears itself on the first tick.
    p.endurance = 0.1;
    p.winded = true;
    simulate(p, intentTo(1, 0, { run: true }), 0.2);
    expect(p.winded).toBe(true);
    expect(p.gait).toBe('walk');
    expect(p.currentSpeed).toBeCloseTo(SPEED.walk, 5);
  });

  it('never leaves the 0–1 range', () => {
    const p = makePlayer(room(40, 40));
    simulate(p, intentTo(1, 0, { run: true }), 30);
    expect(p.endurance).toBeGreaterThanOrEqual(0);
    simulate(p, still, 60);
    expect(p.endurance).toBeLessThanOrEqual(1);
  });
});

describe('facing and backpedalling', () => {
  it('faces the aim target rather than the direction of travel', () => {
    const p = makePlayer(room());
    p.aimTarget.set(9, 0, 4.5); // due east
    p.hasAim = true;
    // Move west while aiming east.
    simulate(p, intentTo(-1, 0), 1);
    const f = p.forward();
    expect(f.x).toBeGreaterThan(0.9);
  });

  it('moves slower backwards than forwards', () => {
    const forwardSpeed = () => {
      const p = makePlayer(room(40, 40), 20.5, 20.5);
      p.aimTarget.set(39, 0, 20.5);
      p.hasAim = true;
      simulate(p, intentTo(1, 0), 1); // let facing settle
      const before = p.position.x;
      simulate(p, intentTo(1, 0), 0.5);
      return Math.abs(p.position.x - before);
    };
    const backwardSpeed = () => {
      const p = makePlayer(room(40, 40), 20.5, 20.5);
      p.aimTarget.set(39, 0, 20.5);
      p.hasAim = true;
      simulate(p, still, 1);
      const before = p.position.x;
      simulate(p, intentTo(-1, 0), 0.5);
      return Math.abs(p.position.x - before);
    };
    expect(backwardSpeed()).toBeLessThan(forwardSpeed() * 0.8);
  });
});

describe('doors', () => {
  /** A wall across the room with a shut door in it. */
  function walledRoom() {
    const g = room(10, 10, 1);
    for (let z = 0; z < 10; z++) g.setWall(5, z, 0, DIR.W, WALL.PLASTER);
    g.setWall(5, 4, 0, DIR.W, WALL.DOORWAY);
    g.setObject(5, 4, 0, packObject(OBJ.DOOR, DIR.W));
    return g;
  }

  it('opens a door by walking into it, rather than demanding a keypress', () => {
    const g = walledRoom();
    const p = makePlayer(g, 4.5, 4.5);
    p.hasAim = false;
    expect(g.isDoorOpen(4, 4, 5, 4, 0)).toBe(false);
    simulate(p, intentTo(1, 0), 2);
    expect(g.isDoorOpen(4, 4, 5, 4, 0)).toBe(true);
  });

  it('walks through once the door is open', () => {
    const g = walledRoom();
    const p = makePlayer(g, 4.5, 4.5);
    p.hasAim = false;
    simulate(p, intentTo(1, 0), 4);
    expect(p.position.x).toBeGreaterThan(5);
  });

  it('is stopped by a shut door it has not reached yet', () => {
    const g = walledRoom();
    const p = makePlayer(g, 4.5, 8.5); // a row with no doorway
    p.hasAim = false;
    simulate(p, intentTo(1, 0), 2);
    expect(p.position.x).toBeLessThan(5);
  });

  it('emits a noise event when a door is opened', () => {
    const g = walledRoom();
    const p = makePlayer(g, 4.5, 4.5);
    p.hasAim = false;
    const heard = [];
    const off = events.on('noise:made', (e) => heard.push(e));
    simulate(p, intentTo(1, 0), 2);
    off();
    expect(heard.some((e) => e.source === 'door')).toBe(true);
  });

  it('takes a moment — opening is not instantaneous', () => {
    const g = walledRoom();
    const p = makePlayer(g, 4.9, 4.5);
    p.hasAim = false;
    p.update(intentTo(1, 0), 1 / 30);
    expect(p.busy).toBeGreaterThan(0);
    expect(g.isDoorOpen(4, 4, 5, 4, 0)).toBe(false); // not yet
  });
});

describe('storeys', () => {
  it('climbs to the next storey at the top of a flight', () => {
    const g = room(10, 10, 2);
    g.setObject(5, 4, 0, packObject(OBJ.STAIRS_LOW, DIR.E));
    g.setObject(6, 4, 0, packObject(OBJ.STAIRS_HIGH, DIR.E));
    const p = makePlayer(g, 4.5, 4.5);
    p.hasAim = false;
    expect(p.level).toBe(0);
    simulate(p, intentTo(1, 0), 2);
    expect(p.level).toBe(1);
    expect(p.position.y).toBeCloseTo(STOREY);
  });

  /**
   * The staircase M2 generates, in full: two steps on the lower storey, the
   * ceiling above the bottom step opened out, and the cell above the top step
   * left solid as a landing.
   */
  function twoStorey() {
    const g = room(10, 10, 2);
    g.setObject(5, 4, 0, packObject(OBJ.STAIRS_LOW, DIR.E));
    g.setObject(6, 4, 0, packObject(OBJ.STAIRS_HIGH, DIR.E));
    g.setFloor(5, 4, 1, FLOOR.VOID);
    return g;
  }

  it('descends by walking, not only by being placed on a hole', () => {
    // Before M13 this test placed the player on the void tile by hand, with a
    // comment saying `canWalk` refuses to enter it. That comment was the bug:
    // nothing in the game could ever reach that cell, so going upstairs was a
    // one-way trip. Descent now uses the landing above the top step, which is
    // somewhere you can actually stand and walk onto.
    const g = twoStorey();
    const p = makePlayer(g, 4.5, 4.5);
    p.hasAim = false;
    simulate(p, intentTo(1, 0), 2);
    expect(p.level).toBe(1);

    // Step off the landing and come back to it: that is the whole round trip.
    simulate(p, intentTo(1, 0), 1.5);
    expect(p.level).toBe(1);
    simulate(p, intentTo(-1, 0), 2);
    expect(p.level).toBe(0);
  });

  it('does not oscillate while standing on the join', () => {
    const g = twoStorey();
    const p = makePlayer(g, 4.5, 4.5);
    p.hasAim = false;
    simulate(p, intentTo(1, 0), 2);
    const landed = p.level;
    // Keep pushing into the same tile. Without the cooldown the two storeys
    // join at one column and the player flips between them every tick.
    let flips = 0;
    let previous = landed;
    for (let i = 0; i < 60; i++) {
      p.update(intentTo(0, 0.02), 1 / 30);
      if (p.level !== previous) flips++;
      previous = p.level;
    }
    expect(flips).toBeLessThanOrEqual(1);
  });

  it('agrees with the grid about where the stairs are', () => {
    const g = twoStorey();
    // The top step climbs; the landing above it descends. One column, both ways.
    expect(g.climbFrom(6, 4, 0)).toBe(1);
    expect(g.descendFrom(6, 4, 1)).toBe(0);
    // The bottom step does neither: its ceiling is a hole, not a staircase.
    expect(g.climbFrom(5, 4, 0)).toBe(-1);
    expect(g.descendFrom(5, 4, 1)).toBe(-1);
    // And plain floor is plain floor.
    expect(g.climbFrom(2, 2, 0)).toBe(-1);
    expect(g.descendFrom(2, 2, 1)).toBe(-1);
  });
});

describe('character rig', () => {
  let c;
  beforeEach(() => {
    c = new Character();
  });

  it('advances the gait phase with distance, not with time', () => {
    const a = new Character();
    const b = new Character();
    // Same distance covered, very different elapsed time.
    for (let i = 0; i < 60; i++) a.update(1 / 60, 2, 'walk');
    for (let i = 0; i < 30; i++) b.update(1 / 30, 2, 'walk');
    expect(a.distance).toBeCloseTo(b.distance, 5);
  });

  it('settles to a neutral pose when standing still', () => {
    for (let i = 0; i < 200; i++) c.update(1 / 30, 0, 'idle');
    expect(Math.abs(c.legL.rotation.x)).toBeLessThan(0.01);
    expect(Math.abs(c.legR.rotation.x)).toBeLessThan(0.01);
  });

  it('swings the legs in opposition', () => {
    for (let i = 0; i < 60; i++) c.update(1 / 30, 3, 'walk');
    // At any moment one thigh leads and the other trails.
    expect(Math.sign(c.legL.rotation.x)).toBe(-Math.sign(c.legR.rotation.x));
  });

  it('counter-swings the arms against the legs', () => {
    for (let i = 0; i < 60; i++) c.update(1 / 30, 3, 'walk');
    expect(Math.sign(c.armL.rotation.x)).toBe(-Math.sign(c.legL.rotation.x));
  });

  it('only bends knees backwards', () => {
    for (let i = 0; i < 400; i++) {
      c.update(1 / 30, 4, 'run');
      expect(c.shinL.rotation.x).toBeGreaterThanOrEqual(0);
      expect(c.shinR.rotation.x).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps stride length physically plausible', () => {
    // A gait that covers under a metre per cycle makes the legs blur; one that
    // covers four makes them barely move. This caught a 6x scale error.
    expect(GAITS.walk.stride).toBeGreaterThan(1.2);
    expect(GAITS.walk.stride).toBeLessThan(2.0);
    expect(GAITS.run.stride).toBeGreaterThan(2.4);
    expect(GAITS.run.stride).toBeLessThan(4.0);
  });

  it('keeps thigh swing under the point where a run becomes the splits', () => {
    for (const name of ['sneak', 'walk', 'run']) {
      expect(GAITS[name].swing).toBeLessThan(0.85);
    }
  });

  it('crouches when sneaking and not otherwise', () => {
    expect(GAITS.sneak.crouch).toBeGreaterThan(0);
    expect(GAITS.walk.crouch).toBe(0);
    expect(GAITS.run.crouch).toBe(0);
  });
});
