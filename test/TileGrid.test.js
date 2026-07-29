import { describe, expect, it } from 'vitest';
import { FLAG, FLOOR, TileGrid, WALL } from '../src/world/TileGrid.js';
import { DIR } from '../src/core/constants.js';
import { OBJ, packObject } from '../src/world/Objects.js';

function emptyGrid(w = 8, d = 8, l = 2) {
  const g = new TileGrid(w, d, l);
  for (let level = 0; level < l; level++) {
    for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, level, FLOOR.WOOD);
  }
  return g;
}

describe('indexing', () => {
  it('gives every cell a distinct index', () => {
    const g = new TileGrid(5, 4, 3);
    const seen = new Set();
    for (let level = 0; level < 3; level++)
      for (let z = 0; z < 4; z++)
        for (let x = 0; x < 5; x++) {
          const i = g.index(x, z, level);
          expect(i).toBeGreaterThanOrEqual(0);
          expect(seen.has(i)).toBe(false);
          seen.add(i);
        }
    expect(seen.size).toBe(5 * 4 * 3);
  });

  it('returns -1 outside the grid', () => {
    const g = new TileGrid(4, 4, 1);
    expect(g.index(-1, 0, 0)).toBe(-1);
    expect(g.index(0, 4, 0)).toBe(-1);
    expect(g.index(0, 0, 1)).toBe(-1);
  });
});

describe('walls live on edges, not in cells', () => {
  it('a wall set on the south of one cell is the north of its neighbour', () => {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.S, WALL.BRICK);
    expect(g.wallAt(2, 2, 0, DIR.S)).toBe(WALL.BRICK);
    expect(g.wallAt(2, 3, 0, DIR.N)).toBe(WALL.BRICK);
  });

  it('a wall set on the east of one cell is the west of its neighbour', () => {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.E, WALL.WOOD);
    expect(g.wallAt(2, 2, 0, DIR.E)).toBe(WALL.WOOD);
    expect(g.wallAt(3, 2, 0, DIR.W)).toBe(WALL.WOOD);
  });

  it('stores each wall exactly once, so it cannot disagree with itself', () => {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.S, WALL.BRICK);
    // Clearing it from the neighbour's side must clear it from both sides.
    g.setWall(2, 3, 0, DIR.N, WALL.NONE);
    expect(g.wallAt(2, 2, 0, DIR.S)).toBe(WALL.NONE);
    expect(g.wallAt(2, 3, 0, DIR.N)).toBe(WALL.NONE);
  });

  it('reports no wall at the grid edge rather than throwing', () => {
    const g = emptyGrid(4, 4, 1);
    expect(g.wallAt(0, 0, 0, DIR.N)).toBe(WALL.NONE);
    expect(g.wallAt(3, 3, 0, DIR.S)).toBe(WALL.NONE);
  });

  it('wallBetween agrees from both sides', () => {
    const g = emptyGrid();
    g.setWall(4, 4, 0, DIR.W, WALL.PLASTER);
    expect(g.wallBetween(4, 4, 3, 4, 0)).toBe(WALL.PLASTER);
    expect(g.wallBetween(3, 4, 4, 4, 0)).toBe(WALL.PLASTER);
  });

  it('rejects non-adjacent cells', () => {
    const g = emptyGrid();
    expect(() => g.wallBetween(0, 0, 2, 0, 0)).toThrow();
    expect(() => g.wallBetween(0, 0, 1, 1, 0)).toThrow();
  });
});

describe('movement queries', () => {
  it('blocks walking through a solid wall, both ways', () => {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.E, WALL.BRICK);
    expect(g.canWalk(2, 2, 3, 2, 0)).toBe(false);
    expect(g.canWalk(3, 2, 2, 2, 0)).toBe(false);
  });

  it('allows walking through a doorway', () => {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.E, WALL.DOORWAY);
    expect(g.canWalk(2, 2, 3, 2, 0)).toBe(true);
  });

  it('treats fences and windows as climbable, not walkable', () => {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.E, WALL.FENCE);
    expect(g.canWalk(2, 2, 3, 2, 0)).toBe(false);
    expect(g.canClimb(2, 2, 3, 2, 0)).toBe(true);
  });

  it('blocks walking into void and out of bounds', () => {
    const g = emptyGrid();
    g.setFloor(3, 2, 0, FLOOR.VOID);
    expect(g.canWalk(2, 2, 3, 2, 0)).toBe(false);
    expect(g.canWalk(0, 0, -1, 0, 0)).toBe(false);
  });

  it('blocks walking into a solid-flagged cell', () => {
    const g = emptyGrid();
    g.setFlag(3, 2, 0, FLAG.SOLID, true);
    expect(g.canWalk(2, 2, 3, 2, 0)).toBe(false);
  });
});

describe('sight queries', () => {
  it('windows and fences do not block sight, walls do', () => {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.E, WALL.WINDOW);
    expect(g.blocksSight(2, 2, 3, 2, 0)).toBe(false);
    g.setWall(2, 2, 0, DIR.E, WALL.FENCE);
    expect(g.blocksSight(2, 2, 3, 2, 0)).toBe(false);
    g.setWall(2, 2, 0, DIR.E, WALL.BRICK);
    expect(g.blocksSight(2, 2, 3, 2, 0)).toBe(true);
  });

  it('an empty doorway is see-through — it is a hole, not a door', () => {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.E, WALL.DOORWAY);
    expect(g.blocksSight(2, 2, 3, 2, 0)).toBe(false);
  });

  it('a shut door blocks sight; opening it does not', () => {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.E, WALL.DOORWAY);
    g.setObject(2, 2, 0, packObject(OBJ.DOOR, DIR.E));
    expect(g.blocksSight(2, 2, 3, 2, 0)).toBe(true);
    g.setDoorOpen(2, 2, 0, true);
    expect(g.blocksSight(2, 2, 3, 2, 0)).toBe(false);
  });
});

describe('doors', () => {
  function withDoor() {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.E, WALL.DOORWAY);
    g.setObject(2, 2, 0, packObject(OBJ.DOOR, DIR.E));
    return g;
  }

  it('separates the geometric route from the passable one', () => {
    const g = withDoor();
    // Pathfinding sees a route through a shut door — it just needs opening.
    expect(g.canWalk(2, 2, 3, 2, 0)).toBe(true);
    // Movement does not.
    expect(g.canPass(2, 2, 3, 2, 0)).toBe(false);
    g.setDoorOpen(2, 2, 0, true);
    expect(g.canPass(2, 2, 3, 2, 0)).toBe(true);
  });

  it('is found from either side of its doorway', () => {
    const g = withDoor();
    expect(g.doorTile(2, 2, 3, 2, 0)).toEqual({ x: 2, z: 2 });
    expect(g.doorTile(3, 2, 2, 2, 0)).toEqual({ x: 2, z: 2 });
  });

  it('reports whether opening actually changed anything', () => {
    const g = withDoor();
    expect(g.setDoorOpen(2, 2, 0, true)).toBe(true);
    expect(g.setDoorOpen(2, 2, 0, true)).toBe(false);
    expect(g.setDoorOpen(2, 2, 0, false)).toBe(true);
  });

  it('marks the chunk dirty so the door is redrawn', () => {
    const g = withDoor();
    g.takeDirty();
    g.setDoorOpen(2, 2, 0, true);
    expect(g.takeDirty()).toContain(g.chunkKeyForTile(2, 2, 0));
  });

  it('treats a doorway with no door as permanently open', () => {
    const g = emptyGrid();
    g.setWall(2, 2, 0, DIR.E, WALL.DOORWAY);
    expect(g.canPass(2, 2, 3, 2, 0)).toBe(true);
  });
});

describe('chunk dirtying', () => {
  it('marks both chunks when a wall sits on a chunk boundary', () => {
    const g = new TileGrid(32, 32, 1);
    g.takeDirty();
    // x = 16 is the first tile of the second chunk; its west wall is visible
    // from the chunk to its left as well.
    g.setWall(16, 4, 0, DIR.W, WALL.BRICK);
    const keys = g.takeDirty();
    expect(keys).toContain(g.chunkKey(1, 0, 0));
    expect(keys).toContain(g.chunkKey(0, 0, 0));
  });

  it('round-trips chunk keys', () => {
    const g = new TileGrid(64, 48, 3);
    for (const [cx, cz, level] of [[0, 0, 0], [3, 2, 2], [1, 1, 1]]) {
      const key = g.chunkKey(cx, cz, level);
      expect(g.decodeChunkKey(key)).toEqual({ cx, cz, level });
    }
  });

  it('takeDirty clears the set', () => {
    const g = new TileGrid(32, 32, 1);
    g.setFloor(1, 1, 0, FLOOR.WOOD);
    expect(g.takeDirty().length).toBeGreaterThan(0);
    expect(g.takeDirty().length).toBe(0);
  });
});
