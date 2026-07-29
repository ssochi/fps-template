/**
 * Winding and normal assertions on generated geometry.
 *
 * This repository's history contains a commit titled "Fix see-through vehicle
 * hulls: lofted sides were wound inward". Inverted winding is invisible until
 * someone looks from exactly the wrong angle, which is why it survives review
 * and why it gets asserted here instead.
 */
import { describe, expect, it } from 'vitest';
import { FLOOR, TileGrid, WALL } from '../src/world/TileGrid.js';
import { meshChunk, wallRects } from '../src/world/Mesher.js';
import { DIR, STOREY } from '../src/core/constants.js';
import { OBJ, objectFacing, objectId, packObject } from '../src/world/Objects.js';

function gridWithFloor(w = 4, d = 4) {
  const g = new TileGrid(w, d, 1);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, 0, FLOOR.WOOD);
  return g;
}

/** Every distinct normal in the geometry, rounded to kill float noise. */
function normalsOf(geometry) {
  const n = geometry.getAttribute('normal');
  const set = new Set();
  for (let i = 0; i < n.count; i++) {
    set.add(`${round(n.getX(i))},${round(n.getY(i))},${round(n.getZ(i))}`);
  }
  return set;
}
const round = (v) => (Math.abs(v) < 1e-6 ? 0 : Number(v.toFixed(3)));

describe('floor geometry', () => {
  it('faces up, never down', () => {
    const g = gridWithFloor();
    const { geometry } = meshChunk(g, 0, 0, 0);
    expect([...normalsOf(geometry)]).toEqual(['0,1,0']);
  });

  it('emits two triangles per floor tile', () => {
    const g = gridWithFloor(3, 2);
    const { triangles } = meshChunk(g, 0, 0, 0);
    expect(triangles).toBe(3 * 2 * 2);
  });

  it('returns null for a chunk with nothing in it', () => {
    const g = new TileGrid(4, 4, 1);
    expect(meshChunk(g, 0, 0, 0)).toBe(null);
  });
});

describe('wall geometry', () => {
  it('a north wall emits one face each way along Z', () => {
    const g = new TileGrid(4, 4, 1);
    g.setWall(1, 1, 0, DIR.N, WALL.BRICK);
    const { geometry } = meshChunk(g, 0, 0, 0);
    const normals = normalsOf(geometry);
    expect(normals).toEqual(new Set(['0,0,-1', '0,0,1']));
  });

  it('a west wall emits one face each way along X', () => {
    const g = new TileGrid(4, 4, 1);
    g.setWall(1, 1, 0, DIR.W, WALL.BRICK);
    expect(normalsOf(meshChunk(g, 0, 0, 0).geometry)).toEqual(new Set(['-1,0,0', '1,0,0']));
  });

  it('draws a shared wall exactly once, not once per adjacent cell', () => {
    const g = new TileGrid(4, 4, 1);
    g.setWall(1, 1, 0, DIR.E, WALL.BRICK);
    const a = meshChunk(g, 0, 0, 0).triangles;

    const g2 = new TileGrid(4, 4, 1);
    // Same edge, addressed from the other side. Must produce identical geometry.
    g2.setWall(2, 1, 0, DIR.W, WALL.BRICK);
    expect(meshChunk(g2, 0, 0, 0).triangles).toBe(a);
    // A solid wall is one rectangle, two faces, two triangles each.
    expect(a).toBe(4);
  });

  it('spans exactly one storey in height', () => {
    const g = new TileGrid(4, 4, 1);
    g.setWall(1, 1, 0, DIR.N, WALL.BRICK);
    const pos = meshChunk(g, 0, 0, 0).geometry.getAttribute('position');
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minY = Math.min(minY, pos.getY(i));
      maxY = Math.max(maxY, pos.getY(i));
    }
    expect(minY).toBeCloseTo(0);
    expect(maxY).toBeCloseTo(STOREY);
  });

  it('places upper storeys at the right height', () => {
    const g = new TileGrid(4, 4, 2);
    g.setFloor(1, 1, 1, FLOOR.CARPET);
    const pos = meshChunk(g, 0, 0, 1).geometry.getAttribute('position');
    expect(pos.getY(0)).toBeCloseTo(STOREY);
  });
});

describe('wall openings', () => {
  it('a solid wall is one rectangle', () => {
    expect(wallRects(WALL.BRICK)).toHaveLength(1);
  });

  it('a doorway leaves a gap from the floor up', () => {
    const rects = wallRects(WALL.DOORWAY);
    // Nothing may cover the middle of the segment at floor level.
    const atFloorMiddle = rects.filter((r) => r.y0 < 0.01 && r.u0 < 0.5 && r.u1 > 0.5);
    expect(atFloorMiddle).toHaveLength(0);
    // But there must be a header above it.
    expect(rects.some((r) => r.u0 > 0 && r.u1 < 1 && r.y1 === STOREY)).toBe(true);
  });

  it('a window leaves a gap with a sill below and a header above', () => {
    const rects = wallRects(WALL.WINDOW);
    const middle = rects.filter((r) => r.u0 > 0.01 && r.u1 < 0.99);
    expect(middle).toHaveLength(2);
    expect(middle.some((r) => r.y0 === 0)).toBe(true); // sill
    expect(middle.some((r) => r.y1 === STOREY)).toBe(true); // header
  });

  it('a fence is short enough to see over', () => {
    const [rect] = wallRects(WALL.FENCE);
    expect(rect.y1).toBeLessThan(STOREY / 2);
  });

  it('an absent wall produces nothing', () => {
    expect(wallRects(WALL.NONE)).toHaveLength(0);
  });
});

describe('ambient occlusion', () => {
  it('darkens floor corners where walls meet', () => {
    const open = gridWithFloor();
    const openColors = meshChunk(open, 0, 0, 0).geometry.getAttribute('color');

    const walled = gridWithFloor();
    walled.setWall(1, 1, 0, DIR.N, WALL.BRICK);
    walled.setWall(1, 1, 0, DIR.W, WALL.BRICK);
    const walledColors = meshChunk(walled, 0, 0, 0).geometry.getAttribute('color');

    const brightest = (attr) => {
      let max = 0;
      for (let i = 0; i < attr.count; i++) max = Math.max(max, attr.getX(i));
      return max;
    };
    const darkest = (attr) => {
      let min = Infinity;
      for (let i = 0; i < attr.count; i++) min = Math.min(min, attr.getX(i));
      return min;
    };

    // The open floor is uniformly lit; the walled one has darker corners.
    expect(darkest(openColors)).toBeCloseTo(brightest(openColors), 5);
    expect(darkest(walledColors)).toBeLessThan(darkest(openColors));
  });
});

describe('object geometry', () => {
  it('emits a box with five faces — no wasted underside', () => {
    const g = new TileGrid(4, 4, 1);
    g.setObject(1, 1, 0, packObject(OBJ.CRATE, DIR.N));
    const { geometry, triangles } = meshChunk(g, 0, 0, 0);
    expect(triangles).toBe(10); // five quads
    // Every face except the bottom: no normal may point down.
    expect(normalsOf(geometry).has('0,-1,0')).toBe(false);
    expect(normalsOf(geometry).has('0,1,0')).toBe(true);
  });

  it('round-trips an object id and facing through the packed cell value', () => {
    for (const id of [OBJ.BED, OBJ.FRIDGE, OBJ.STAIRS_LOW]) {
      for (let dir = 0; dir < 4; dir++) {
        const packed = packObject(id, dir);
        expect(objectId(packed)).toBe(id);
        expect(objectFacing(packed)).toBe(dir);
      }
    }
  });

  it('keeps an object inside its own tile', () => {
    const g = new TileGrid(4, 4, 1);
    g.setObject(2, 1, 0, packObject(OBJ.WARDROBE, DIR.N));
    const pos = meshChunk(g, 0, 0, 0).geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getX(i)).toBeGreaterThanOrEqual(2);
      expect(pos.getX(i)).toBeLessThanOrEqual(3);
      expect(pos.getZ(i)).toBeGreaterThanOrEqual(1);
      expect(pos.getZ(i)).toBeLessThanOrEqual(2);
    }
  });

  it('rotates a non-square footprint with its facing', () => {
    const extent = (facing, axis) => {
      const g = new TileGrid(4, 4, 1);
      g.setObject(1, 1, 0, packObject(OBJ.SOFA, facing));
      const pos = meshChunk(g, 0, 0, 0).geometry.getAttribute('position');
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        const v = axis === 'x' ? pos.getX(i) : pos.getZ(i);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      return max - min;
    };
    // A sofa is wider than it is deep; turning it must swap those extents.
    expect(extent(DIR.N, 'x')).toBeCloseTo(extent(DIR.E, 'z'), 5);
    expect(extent(DIR.N, 'z')).toBeCloseTo(extent(DIR.E, 'x'), 5);
  });

  it('builds stairs that climb a full storey across two tiles', () => {
    const g = new TileGrid(4, 4, 2);
    g.setObject(1, 1, 0, packObject(OBJ.STAIRS_LOW, DIR.E));
    g.setObject(2, 1, 0, packObject(OBJ.STAIRS_HIGH, DIR.E));
    const pos = meshChunk(g, 0, 0, 0).geometry.getAttribute('position');
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
    expect(maxY).toBeCloseTo(STOREY);
  });
});
