import { describe, expect, it } from 'vitest';
import { TileGrid, FLOOR, WALL, FLAG } from '../src/world/TileGrid.js';
import { OBJ, packObject } from '../src/world/Objects.js';
import { FlowField, UNREACHABLE, COST } from '../src/sim/FlowField.js';
import { SoundField } from '../src/sim/Sound.js';
import { Horde, STATE } from '../src/sim/Horde.js';
import { bakeVat } from '../src/render/Vat.js';
import { Character } from '../src/entity/Character.js';
import { ZOMBIE_CLIPS } from '../src/sim/HordeSystem.js';
import { DIR, DIR_VEC } from '../src/core/constants.js';

function room(w = 21, d = 21, levels = 1) {
  const g = new TileGrid(w, d, levels);
  for (let l = 0; l < levels; l++) {
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, l, FLOOR.CONCRETE);
  }
  return g;
}

/** Walk the field from a tile to the goal, returning the path length or -1. */
function follow(flow, x, z, limit = 400) {
  let steps = 0;
  while (flow.costAt(x, z) > 0 && steps < limit) {
    const d = flow.directionAt(x, z);
    if (d < 0) return -1;
    x += DIR_VEC[d].dx;
    z += DIR_VEC[d].dz;
    steps++;
  }
  return flow.costAt(x, z) === 0 ? steps : -1;
}

describe('flow field', () => {
  it('leads every reachable tile to the goal', () => {
    const g = room();
    const flow = new FlowField(g);
    flow.build([{ x: 10, z: 10 }]);

    for (const [x, z] of [[0, 0], [20, 20], [0, 20], [5, 13]]) {
      expect(follow(flow, x, z), `from ${x},${z}`).toBeGreaterThan(0);
    }
  });

  it('costs nothing at the goal itself', () => {
    const g = room();
    const flow = new FlowField(g);
    flow.build([{ x: 10, z: 10 }]);
    expect(flow.costAt(10, 10)).toBe(0);
    expect(flow.directionAt(10, 10)).toBe(-1);
  });

  it('marks sealed-off tiles unreachable rather than guessing', () => {
    const g = room();
    // Wall a 3x3 pocket off completely.
    for (let x = 2; x <= 4; x++) {
      g.setWall(x, 2, 0, DIR.N, WALL.BRICK);
      g.setWall(x, 4, 0, DIR.S, WALL.BRICK);
    }
    for (let z = 2; z <= 4; z++) {
      g.setWall(2, z, 0, DIR.W, WALL.BRICK);
      g.setWall(4, z, 0, DIR.E, WALL.BRICK);
    }
    const flow = new FlowField(g);
    flow.build([{ x: 15, z: 15 }]);
    expect(flow.costAt(3, 3)).toBe(UNREACHABLE);
    expect(flow.reachable(3, 3)).toBe(false);
    expect(flow.reachable(15, 15)).toBe(true);
  });

  it('routes around a shut door when there is an open way', () => {
    const g = room();
    // A wall across the map with a shut door in it and a clear gap further down.
    for (let z = 0; z < 14; z++) g.setWall(10, z, 0, DIR.W, WALL.BRICK);
    g.setWall(10, 5, 0, DIR.W, WALL.DOORWAY);
    g.setObject(10, 5, 0, packObject(OBJ.DOOR, DIR.W));

    const flow = new FlowField(g);
    flow.build([{ x: 15, z: 5 }]);

    // Getting there through the shut door costs more than going round the end
    // of the wall, so the field must not route the neighbour through the door.
    const viaDoor = flow.costAt(9, 5);
    g.setDoorOpen(10, 5, 0, true);
    flow.build([{ x: 15, z: 5 }]);
    const viaOpenDoor = flow.costAt(9, 5);
    expect(viaOpenDoor).toBeLessThan(viaDoor);
  });

  it('treats a climbable fence as expensive but passable', () => {
    const g = room();
    for (let z = 0; z < 21; z++) g.setWall(10, z, 0, DIR.W, WALL.FENCE);
    const flow = new FlowField(g);
    flow.build([{ x: 15, z: 10 }]);
    expect(flow.reachable(5, 10)).toBe(true);
    expect(flow.costAt(9, 10)).toBeGreaterThanOrEqual(COST.climb);
  });

  it('supports several goals at once', () => {
    const g = room();
    const flow = new FlowField(g);
    flow.build([{ x: 2, z: 2 }, { x: 18, z: 18 }]);
    expect(flow.costAt(2, 2)).toBe(0);
    expect(flow.costAt(18, 18)).toBe(0);
    // A tile near one goal routes to that one, not across the map.
    expect(flow.costAt(4, 2)).toBeLessThan(flow.costAt(10, 10));
  });

  it('inlined sweep costs agree with the reference implementation', () => {
    // `build` duplicates the step-cost rule against the raw typed arrays for
    // speed. If the two ever disagree the horde paths through walls, so the
    // duplication is pinned here rather than trusted.
    const g = room(15, 15);
    for (let z = 0; z < 10; z++) g.setWall(7, z, 0, DIR.W, WALL.BRICK);
    g.setWall(7, 3, 0, DIR.W, WALL.DOORWAY);
    g.setObject(7, 3, 0, packObject(OBJ.DOOR, DIR.W));
    g.setWall(4, 12, 0, DIR.N, WALL.FENCE);
    g.setFlag(9, 9, 0, FLAG.SOLID, true);

    const flow = new FlowField(g);
    // Re-derive each edge cost from the field: a tile's cost must equal its
    // parent's cost plus the reference step cost of the edge between them.
    flow.build([{ x: 12, z: 12 }]);
    let checked = 0;
    for (let z = 1; z < 14; z++) {
      for (let x = 1; x < 14; x++) {
        const d = flow.directionAt(x, z);
        if (d < 0) continue;
        const nx = x + DIR_VEC[d].dx;
        const nz = z + DIR_VEC[d].dz;
        const step = flow.stepCost(x, z, nx, nz);
        expect(step, `edge ${x},${z} -> ${nx},${nz}`).toBeGreaterThan(0);
        expect(flow.costAt(x, z)).toBe(flow.costAt(nx, nz) + step);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('never routes through a solid wall', () => {
    const g = room();
    for (let z = 0; z < 21; z++) g.setWall(10, z, 0, DIR.W, WALL.BRICK);
    const flow = new FlowField(g);
    flow.build([{ x: 15, z: 10 }]);
    // The whole west half is sealed off.
    expect(flow.reachable(5, 10)).toBe(false);
  });
});

describe('sound', () => {
  it('is loudest at its source and falls off with distance', () => {
    const g = room(41, 41);
    const sound = new SoundField(g);
    sound.emit(20, 20, 0, 20);
    expect(sound.at(20, 20)).toBe(20);
    expect(sound.at(25, 20)).toBeLessThan(sound.at(22, 20));
    expect(sound.at(22, 20)).toBeLessThan(sound.at(20, 20));
  });

  it('is muffled far more by a wall than by open air', () => {
    const open = new SoundField(room(41, 41));
    open.emit(20, 20, 0, 30);
    const throughAir = open.at(24, 20);

    const g = room(41, 41);
    for (let z = 0; z < 41; z++) g.setWall(22, z, 0, DIR.W, WALL.BRICK);
    const walled = new SoundField(g);
    walled.emit(20, 20, 0, 30);
    expect(walled.at(24, 20)).toBeLessThan(throughAir);
  });

  it('passes freely through an open door and poorly through a shut one', () => {
    const make = (open) => {
      const g = room(41, 41);
      for (let z = 0; z < 41; z++) g.setWall(22, z, 0, DIR.W, WALL.BRICK);
      g.setWall(22, 20, 0, DIR.W, WALL.DOORWAY);
      g.setObject(22, 20, 0, packObject(OBJ.DOOR, DIR.W));
      if (open) g.setDoorOpen(22, 20, 0, true);
      const s = new SoundField(g);
      s.emit(20, 20, 0, 30);
      return s.at(24, 20);
    };
    expect(make(true)).toBeGreaterThan(make(false));
  });

  it('decays to silence', () => {
    const g = room();
    const sound = new SoundField(g);
    sound.emit(10, 10, 0, 10);
    for (let i = 0; i < 200; i++) sound.update(1 / 30);
    expect(sound.at(10, 10)).toBe(0);
  });

  it('points uphill toward the source', () => {
    const g = room(41, 41);
    const sound = new SoundField(g);
    sound.emit(30, 20, 0, 30);
    // Standing west of the noise, the loudest neighbour is the one to the east.
    expect(sound.loudestDirection(20, 20)).toBe(DIR.E);
  });

  it('reports no direction when it is quiet', () => {
    const g = room();
    const sound = new SoundField(g);
    expect(sound.loudestDirection(10, 10)).toBe(-1);
  });
});

describe('horde behaviour', () => {
  function setup() {
    const g = room(41, 41);
    const flow = new FlowField(g);
    const sound = new SoundField(g);
    const horde = new Horde(g, flow, sound, { capacity: 64, seed: 'test' });
    return { g, flow, sound, horde };
  }

  it('wanders when it can neither see nor hear anything', () => {
    const { horde, flow } = setup();
    const i = horde.spawn(5, 5, 0);
    flow.build([{ x: 35, z: 35 }]);
    horde.update(1 / 30, { x: 35, z: 35, level: 0 });
    expect(horde.state[i]).toBe(STATE.WANDER);
  });

  it('chases what it can see', () => {
    const { horde, flow } = setup();
    const i = horde.spawn(20, 20, 0);
    horde.yaw[i] = Math.atan2(-1, 0); // face east, toward the target
    flow.build([{ x: 26, z: 20 }]);
    horde.update(1 / 30, { x: 26, z: 20, level: 0 });
    expect(horde.state[i]).toBe(STATE.CHASE);
  });

  it('cannot see through a wall', () => {
    const { g, horde, flow } = setup();
    for (let z = 0; z < 41; z++) g.setWall(23, z, 0, DIR.W, WALL.BRICK);
    const i = horde.spawn(20, 20, 0);
    horde.yaw[i] = Math.atan2(-1, 0);
    flow.build([{ x: 26, z: 20 }]);
    horde.update(1 / 30, { x: 26, z: 20, level: 0 });
    expect(horde.state[i]).not.toBe(STATE.CHASE);
  });

  it('cannot see what is behind it', () => {
    const { horde, flow } = setup();
    const i = horde.spawn(20, 20, 0);
    horde.yaw[i] = Math.atan2(1, 0); // face west, away from the target
    flow.build([{ x: 26, z: 20 }]);
    horde.update(1 / 30, { x: 26, z: 20, level: 0 });
    expect(horde.state[i]).not.toBe(STATE.CHASE);
  });

  it('investigates a noise it did not see made', () => {
    const { horde, sound, flow } = setup();
    const i = horde.spawn(20, 20, 0);
    horde.yaw[i] = Math.atan2(1, 0); // facing away; this is hearing, not sight
    sound.emit(26, 20, 0, 25);
    flow.build([{ x: 26, z: 20 }]);
    horde.update(1 / 30, { x: 26, z: 20, level: 0 });
    expect(horde.state[i]).toBe(STATE.INVESTIGATE);
  });

  it('keeps coming for a while after losing sight, then gives up', () => {
    const { horde, flow } = setup();
    const i = horde.spawn(20, 20, 0);
    horde.yaw[i] = Math.atan2(-1, 0);
    flow.build([{ x: 26, z: 20 }]);
    horde.update(1 / 30, { x: 26, z: 20, level: 0 });
    expect(horde.attention[i]).toBe(1);

    // Target vanishes far away and out of range.
    const gone = { x: 39, z: 39, level: 0 };
    for (let t = 0; t < 30; t++) horde.update(1 / 30, gone);
    expect(horde.state[i]).toBe(STATE.CHASE); // still on it

    for (let t = 0; t < 300; t++) horde.update(1 / 30, gone);
    expect(horde.state[i]).toBe(STATE.WANDER); // lost interest
  });

  it('never walks through a wall', () => {
    const { g, horde, flow } = setup();
    for (let z = 0; z < 41; z++) g.setWall(23, z, 0, DIR.W, WALL.BRICK);
    const i = horde.spawn(20, 20, 0);
    flow.build([{ x: 30, z: 20 }]);
    for (let t = 0; t < 600; t++) horde.update(1 / 30, { x: 30, z: 20, level: 0 });
    expect(horde.x[i]).toBeLessThan(23);
  });

  it('only ever spawns on walkable ground', () => {
    const { g, horde } = setup();
    for (let z = 10; z < 20; z++) for (let x = 10; x < 20; x++) g.setFloor(x, z, 0, FLOOR.VOID);
    horde.populate(40);
    for (let i = 0; i < horde.count; i++) {
      expect(g.isWalkable(Math.floor(horde.x[i]), Math.floor(horde.z[i]), 0)).toBe(true);
    }
  });

  it('refuses to exceed its capacity', () => {
    const { horde } = setup();
    for (let i = 0; i < 200; i++) horde.spawn(5, 5, 0);
    expect(horde.count).toBe(64);
    expect(horde.spawn(5, 5, 0)).toBe(-1);
  });
});

describe('vertex animation baking', () => {
  const vat = bakeVat(() => new Character(), ZOMBIE_CLIPS);

  it('bakes every clip into its own block of rows', () => {
    let expected = 0;
    for (const clip of ZOMBIE_CLIPS) {
      expect(vat.clips[clip.name].start).toBe(expected);
      expect(vat.clips[clip.name].frames).toBe(clip.frames);
      expected += clip.frames;
    }
    expect(vat.frameCount).toBe(expected);
  });

  it('gives every vertex a row index matching its position in the texture', () => {
    const ids = vat.geometry.getAttribute('aVertexId');
    expect(ids.count).toBe(vat.vertexCount);
    for (let i = 0; i < ids.count; i++) expect(ids.getX(i)).toBe(i);
  });

  it('produces finite positions inside a human-sized box', () => {
    const data = vat.positionTexture.image.data;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < data.length; i += 4) {
      expect(Number.isFinite(data[i])).toBe(true);
      expect(Math.abs(data[i])).toBeLessThan(2);
      expect(Math.abs(data[i + 2])).toBeLessThan(2);
      minY = Math.min(minY, data[i + 1]);
      maxY = Math.max(maxY, data[i + 1]);
    }
    expect(minY).toBeGreaterThan(-0.4);
    expect(maxY).toBeLessThan(2.2);
  });

  it('bakes unit-length normals', () => {
    const data = vat.normalTexture.image.data;
    for (let i = 0; i < data.length; i += 4) {
      const len = Math.hypot(data[i], data[i + 1], data[i + 2]);
      expect(len).toBeCloseTo(1, 4);
    }
  });

  it('actually animates — frames within a clip differ', () => {
    const data = vat.positionTexture.image.data;
    const stride = vat.vertexCount * 4;
    let maxDelta = 0;
    for (let v = 0; v < vat.vertexCount; v++) {
      const a = data[v * 4 + 1];
      const b = data[stride * 6 + v * 4 + 1];
      maxDelta = Math.max(maxDelta, Math.abs(a - b));
    }
    expect(maxDelta).toBeGreaterThan(0.02);
  });

  it('loops seamlessly — the last frame is not a copy of the first', () => {
    const data = vat.positionTexture.image.data;
    const stride = vat.vertexCount * 4;
    const shamble = vat.clips.shamble;
    let delta = 0;
    for (let v = 0; v < vat.vertexCount; v++) {
      // All three components: a gait swings limbs in the sagittal plane, so
      // comparing X alone finds no difference even when the pose has changed.
      for (let c = 0; c < 3; c++) {
        const first = data[shamble.start * stride + v * 4 + c];
        const last = data[(shamble.start + shamble.frames - 1) * stride + v * 4 + c];
        delta += Math.abs(first - last);
      }
    }
    expect(delta).toBeGreaterThan(0.01);
  });
});
