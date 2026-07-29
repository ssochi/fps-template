import { describe, expect, it } from 'vitest';
import { Vector4 } from 'three';
import { TileGrid, FLOOR, WALL, FLAG } from '../src/world/TileGrid.js';
import { OBJ, packObject } from '../src/world/Objects.js';
import { VIS, computeVisible, hasLineOfSight } from '../src/sim/Sight.js';
import { FogOfWar } from '../src/render/FogOfWar.js';
import { Cutaway } from '../src/render/Cutaway.js';
import { DIR } from '../src/core/constants.js';

function open(w = 21, d = 21, levels = 1) {
  const g = new TileGrid(w, d, levels);
  for (let l = 0; l < levels; l++) {
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, l, FLOOR.CONCRETE);
  }
  return g;
}

describe('line of sight', () => {
  it('sees itself and its neighbours across open ground', () => {
    const g = open();
    expect(hasLineOfSight(g, 10, 10, 10, 10, 0)).toBe(true);
    expect(hasLineOfSight(g, 10, 10, 16, 10, 0)).toBe(true);
    expect(hasLineOfSight(g, 10, 10, 16, 14, 0)).toBe(true);
  });

  it('is blocked by a wall and is symmetric', () => {
    const g = open();
    g.setWall(12, 10, 0, DIR.W, WALL.BRICK);
    expect(hasLineOfSight(g, 10, 10, 14, 10, 0)).toBe(false);
    expect(hasLineOfSight(g, 14, 10, 10, 10, 0)).toBe(false);
  });

  it('sees through a window but not through a shut door', () => {
    const g = open();
    g.setWall(12, 10, 0, DIR.W, WALL.WINDOW);
    expect(hasLineOfSight(g, 10, 10, 14, 10, 0)).toBe(true);

    g.setWall(12, 10, 0, DIR.W, WALL.DOORWAY);
    g.setObject(12, 10, 0, packObject(OBJ.DOOR, DIR.W));
    expect(hasLineOfSight(g, 10, 10, 14, 10, 0)).toBe(false);
    g.setDoorOpen(12, 10, 0, true);
    expect(hasLineOfSight(g, 10, 10, 14, 10, 0)).toBe(true);
  });

  it('does not leak diagonally through the join of two walls', () => {
    // The classic failure: a Bresenham line takes a diagonal step and skips
    // both corner edges, so sight slips through a sealed corner.
    const g = open();
    g.setWall(11, 10, 0, DIR.W, WALL.BRICK); // vertical wall west of (11,10)
    g.setWall(10, 11, 0, DIR.N, WALL.BRICK); // horizontal wall north of (10,11)
    expect(hasLineOfSight(g, 10, 10, 11, 11, 0)).toBe(false);
  });

  it('is blocked by an opaque-flagged cell such as a tree', () => {
    const g = open();
    g.setFlag(12, 10, 0, FLAG.OPAQUE, true);
    expect(hasLineOfSight(g, 10, 10, 15, 10, 0)).toBe(false);
  });

  it('stays inside its radius', () => {
    const g = open(41, 41);
    let maxD2 = 0;
    computeVisible(g, 20, 20, 0, 8, (x, z) => {
      maxD2 = Math.max(maxD2, (x - 20) ** 2 + (z - 20) ** 2);
    });
    expect(maxD2).toBeLessThanOrEqual(64);
  });

  it('sees the whole disc when nothing is in the way', () => {
    const g = open(41, 41);
    let n = 0;
    computeVisible(g, 20, 20, 0, 5, () => n++);
    // Every tile within radius 5 of centre: 81 for a Euclidean disc on a grid.
    expect(n).toBe(81);
  });

  it('sees strictly less once a wall is added', () => {
    const g = open(41, 41);
    let before = 0;
    computeVisible(g, 20, 20, 0, 10, () => before++);
    for (let z = 0; z < 41; z++) g.setWall(24, z, 0, DIR.W, WALL.BRICK);
    let after = 0;
    computeVisible(g, 20, 20, 0, 10, () => after++);
    expect(after).toBeLessThan(before);
  });
});

describe('fog of war', () => {
  it('starts with everything unseen', () => {
    const g = open();
    const fog = new FogOfWar(g, { radius: 6 });
    expect(fog.at(10, 10, 0)).toBe(VIS.UNSEEN);
  });

  it('marks what the observer can see as visible', () => {
    const g = open();
    const fog = new FogOfWar(g, { radius: 6 });
    fog.update(10, 10, 0);
    expect(fog.at(10, 10, 0)).toBe(VIS.VISIBLE);
    expect(fog.at(13, 10, 0)).toBe(VIS.VISIBLE);
    expect(fog.at(20, 20, 0)).toBe(VIS.UNSEEN);
  });

  it('demotes to remembered, never back to unseen', () => {
    const g = open(41, 41);
    const fog = new FogOfWar(g, { radius: 5 });
    fog.update(10, 10, 0);
    expect(fog.at(10, 10, 0)).toBe(VIS.VISIBLE);

    fog.update(30, 30, 0);
    expect(fog.at(10, 10, 0)).toBe(VIS.REMEMBERED);

    fog.update(35, 35, 0);
    expect(fog.at(10, 10, 0)).toBe(VIS.REMEMBERED);
  });

  it('skips the work when the observer has not changed tile', () => {
    const g = open();
    const fog = new FogOfWar(g, { radius: 6 });
    expect(fog.update(10, 10, 0)).toBe(true);
    expect(fog.update(10, 10, 0)).toBe(false);
    expect(fog.update(11, 10, 0)).toBe(true);
  });

  it('keeps the texture in step with the state', () => {
    const g = open();
    const fog = new FogOfWar(g, { radius: 6 });
    fog.update(10, 10, 0);
    const i = g.idx(10, 10, 0);
    expect(fog.data[i]).toBe(255);

    fog.update(10, 10, 0); // no-op
    fog.update(2, 2, 0);
    expect(fog.data[i]).toBeGreaterThan(0);
    expect(fog.data[i]).toBeLessThan(255);
  });

  it('reveals roofs, because a roof has no walls at its own storey', () => {
    const g = open(21, 21, 2);
    // A sealed building on the ground floor, with a roof above it.
    for (let x = 8; x <= 12; x++) {
      g.setWall(x, 8, 0, DIR.N, WALL.BRICK);
      g.setWall(x, 12, 0, DIR.S, WALL.BRICK);
    }
    for (let z = 8; z <= 12; z++) {
      g.setWall(8, z, 0, DIR.W, WALL.BRICK);
      g.setWall(12, z, 0, DIR.E, WALL.BRICK);
    }
    for (let z = 8; z <= 12; z++) {
      for (let x = 8; x <= 12; x++) {
        g.setFlag(x, z, 0, FLAG.INDOOR, true);
        g.setFloor(x, z, 1, FLOOR.ROOF);
      }
    }

    const fog = new FogOfWar(g, { radius: 12 });
    fog.update(3, 10, 0);

    // The roof is plainly visible from the street...
    expect(fog.at(10, 10, 1)).toBe(VIS.VISIBLE);
    // ...but the sealed room under it is not.
    expect(fog.at(10, 10, 0)).toBe(VIS.UNSEEN);
  });

  it('reveals and resets wholesale', () => {
    const g = open();
    const fog = new FogOfWar(g, { radius: 4 });
    fog.revealAll();
    expect(fog.at(20, 20, 0)).toBe(VIS.VISIBLE);
    fog.reset();
    expect(fog.at(20, 20, 0)).toBe(VIS.UNSEEN);
  });
});

describe('cutaway', () => {
  const fakeWorld = {};

  function withBuildings() {
    const cut = new Cutaway(fakeWorld, 32);
    cut.registerBuildings([
      { rooms: [{ id: 1 }, { id: 2 }, { id: 3 }], roofRoom: 4 },
      { rooms: [{ id: 5 }, { id: 6 }], roofRoom: 7 },
    ]);
    return cut;
  }

  it('cuts nothing while the player is outdoors', () => {
    const cut = withBuildings();
    for (let i = 0; i < 60; i++) cut.update(1 / 30, 0);
    expect(Math.max(...cut.current)).toBe(0);
  });

  it('opens the whole building, including its roof, not just one room', () => {
    const cut = withBuildings();
    for (let i = 0; i < 60; i++) cut.update(1 / 30, 2);
    for (const id of [1, 2, 3, 4]) expect(cut.current[id]).toBeCloseTo(1, 2);
  });

  it('leaves the neighbours alone', () => {
    const cut = withBuildings();
    for (let i = 0; i < 60; i++) cut.update(1 / 30, 2);
    for (const id of [5, 6, 7]) expect(cut.current[id]).toBe(0);
  });

  it('fades rather than popping', () => {
    const cut = withBuildings();
    cut.update(1 / 30, 1);
    const first = cut.current[1];
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
  });

  it('closes the building back up on leaving', () => {
    const cut = withBuildings();
    for (let i = 0; i < 60; i++) cut.update(1 / 30, 1);
    for (let i = 0; i < 60; i++) cut.update(1 / 30, 0);
    expect(cut.current[1]).toBe(0);
  });

  it('hides exactly the two facings that point at the camera', () => {
    const cut = withBuildings();
    const out = new Vector4();
    for (let step = 0; step < 4; step++) {
      const cam = { targetYaw: Math.PI * 0.25 + step * Math.PI * 0.5 };
      cut.facingMask(cam, out);
      const total = out.x + out.y + out.z + out.w;
      expect(total, `rotation step ${step}`).toBe(2);
      // Never both of an opposing pair — that would remove a room's backdrop.
      expect(out.x + out.z).toBe(1);
      expect(out.y + out.w).toBe(1);
    }
  });

  it('can be switched off entirely', () => {
    const cut = withBuildings();
    cut.enabled = false;
    for (let i = 0; i < 60; i++) cut.update(1 / 30, 2);
    expect(Math.max(...cut.current)).toBe(0);
  });
});
