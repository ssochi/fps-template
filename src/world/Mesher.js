/**
 * Turns a chunk of tile data into one merged BufferGeometry.
 *
 * A chunk is 16 × 16 tiles on a single storey — small enough that breaking a
 * door rebuilds well under a millisecond of geometry, large enough that a whole
 * town is a few hundred draw calls rather than a few hundred thousand.
 *
 * Two things are baked in at build time rather than paid for per frame:
 *
 *   - **Material colour**, into vertex colours. One material for the entire
 *     world means one draw call per chunk regardless of how many surfaces it
 *     mixes.
 *   - **Ambient occlusion**, from wall adjacency. Corner darkening is what
 *     makes flat isometric geometry read as solid, and computing it here costs
 *     nothing at runtime.
 *
 * Walls are zero-thickness planes, as in the reference game, and each is
 * emitted as *two* one-sided quads with opposing normals. That is not
 * redundancy: M4's cutaway hides the face pointing at the camera and keeps the
 * one pointing away, which is only possible if they are separate primitives.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { CHUNK, DIR, STOREY, TILE } from '../core/constants.js';
import { FLAG, FLOOR, WALL } from './TileGrid.js';
import { FLOOR_COLOR, WALL_COLOR } from '../render/Palette.js';

/** How dark a fully occluded vertex gets. */
const AO_MIN = 0.55;
/** Extra darkening at the very bottom of a wall — a cheap contact shadow. */
const WALL_FOOT_AO = 0.72;

/**
 * The two faces of a wall are pushed this far apart along their normals.
 *
 * Perfectly coplanar front and back faces are degenerate for the depth test:
 * the shadow map records one and the other receives at the identical depth, so
 * every wall shadows itself in hard diagonal wedges. A centimetre of separation
 * is invisible at any zoom and removes the fight entirely.
 */
const WALL_SKIN = 0.012;

/** Door and window openings, in metres. */
const DOOR_WIDTH = 0.9;
const DOOR_HEIGHT = 2.05;
const WINDOW_WIDTH = 0.7;
const WINDOW_SILL = 0.9;
const WINDOW_HEAD = 2.0;
const FENCE_HEIGHT = 1.05;

/**
 * The solid parts of a wall segment, in (u, y) space where u runs 0→1 along the
 * segment and y is metres above the storey floor. Returning rectangles rather
 * than special-casing each material downstream keeps the 3D emit code uniform.
 *
 * @param {number} material
 * @returns {Array<{u0: number, u1: number, y0: number, y1: number}>}
 */
export function wallRects(material) {
  switch (material) {
    case WALL.NONE:
      return [];
    case WALL.FENCE:
      return [{ u0: 0, u1: 1, y0: 0, y1: FENCE_HEIGHT }];
    case WALL.DOORWAY: {
      const m = (1 - DOOR_WIDTH) / 2;
      return [
        { u0: 0, u1: m, y0: 0, y1: STOREY },
        { u0: 1 - m, u1: 1, y0: 0, y1: STOREY },
        { u0: m, u1: 1 - m, y0: DOOR_HEIGHT, y1: STOREY },
      ];
    }
    case WALL.WINDOW: {
      const m = (1 - WINDOW_WIDTH) / 2;
      return [
        { u0: 0, u1: m, y0: 0, y1: STOREY },
        { u0: 1 - m, u1: 1, y0: 0, y1: STOREY },
        { u0: m, u1: 1 - m, y0: 0, y1: WINDOW_SILL },
        { u0: m, u1: 1 - m, y0: WINDOW_HEAD, y1: STOREY },
      ];
    }
    default:
      return [{ u0: 0, u1: 1, y0: 0, y1: STOREY }];
  }
}

/**
 * Accumulates triangles and hands back a BufferGeometry.
 * Normals are computed from winding, so a quad emitted in the wrong order
 * produces a visibly wrong normal rather than silently correct lighting — which
 * is how the inverted-winding bugs in this repository's history went unnoticed.
 */
class MeshBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.colors = [];
    /** Which storey each vertex belongs to — M4 fades storeys above the player. */
    this.levels = [];
  }

  /**
   * @param {number[]} p0 @param {number[]} p1 @param {number[]} p2 @param {number[]} p3
   *   corners in counter-clockwise order when viewed from the front
   * @param {number[]} rgb base colour
   * @param {number[]} ao per-corner multiplier, same order as the corners
   * @param {number} level storey index
   */
  quad(p0, p1, p2, p3, rgb, ao, level) {
    const ux = p1[0] - p0[0];
    const uy = p1[1] - p0[1];
    const uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0];
    const vy = p2[1] - p0[1];
    const vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    const corners = [p0, p1, p2, p3];
    const order = [0, 1, 2, 0, 2, 3];
    for (const c of order) {
      const p = corners[c];
      this.positions.push(p[0], p[1], p[2]);
      this.normals.push(nx, ny, nz);
      const k = ao[c];
      this.colors.push(rgb[0] * k, rgb[1] * k, rgb[2] * k);
      this.levels.push(level);
    }
  }

  build() {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geo.setAttribute('level', new BufferAttribute(new Float32Array(this.levels), 1));
    geo.computeBoundingSphere();
    return geo;
  }

  get triangleCount() {
    return this.positions.length / 9;
  }
}

/**
 * Ambient occlusion at a tile *corner*, from the walls that meet there.
 *
 * A corner (cx, cz) is touched by up to four wall segments: the north walls of
 * the cells on either side of it along X, and the west walls of the cells on
 * either side along Z. More walls meeting the corner means less sky reaches it.
 */
function cornerAo(grid, cx, cz, level) {
  let n = 0;
  if (grid.wallAt(cx - 1, cz, level, DIR.N) !== WALL.NONE) n++;
  if (grid.wallAt(cx, cz, level, DIR.N) !== WALL.NONE) n++;
  if (grid.wallAt(cx, cz - 1, level, DIR.W) !== WALL.NONE) n++;
  if (grid.wallAt(cx, cz, level, DIR.W) !== WALL.NONE) n++;
  if (n === 0) return 1;
  return Math.max(AO_MIN, 1 - n * 0.14);
}

/**
 * Build the merged geometry for one chunk.
 *
 * @param {import('./TileGrid.js').TileGrid} grid
 * @param {number} cx chunk X
 * @param {number} cz chunk Z
 * @param {number} level storey
 * @returns {{ geometry: BufferGeometry, triangles: number } | null} null when
 *   the chunk is entirely empty, so no mesh is created for it at all
 */
export function meshChunk(grid, cx, cz, level) {
  const b = new MeshBuilder();

  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  const x1 = Math.min(x0 + CHUNK, grid.width);
  const z1 = Math.min(z0 + CHUNK, grid.depth);
  const baseY = level * STOREY;

  for (let z = z0; z < z1; z++) {
    for (let x = x0; x < x1; x++) {
      const i = grid.idx(x, z, level);

      // --- floor ---
      const floor = grid.floor[i];
      if (floor !== FLOOR.VOID) {
        const rgb = FLOOR_COLOR[floor] ?? FLOOR_COLOR[FLOOR.CONCRETE];
        const wx = x * TILE;
        const wz = z * TILE;
        const ao = [
          cornerAo(grid, x, z, level),
          cornerAo(grid, x, z + 1, level),
          cornerAo(grid, x + 1, z + 1, level),
          cornerAo(grid, x + 1, z, level),
        ];
        // CCW seen from +Y — verified by unit test, not by eye.
        b.quad(
          [wx, baseY, wz],
          [wx, baseY, wz + TILE],
          [wx + TILE, baseY, wz + TILE],
          [wx + TILE, baseY, wz],
          rgb,
          ao,
          level,
        );
      }

      // --- walls ---
      // Only this cell's own north and west edges: every wall belongs to
      // exactly one cell, so iterating cells visits every wall exactly once.
      const wn = grid.wallN[i];
      if (wn !== WALL.NONE) emitWall(b, wn, x, z, level, baseY, true);
      const ww = grid.wallW[i];
      if (ww !== WALL.NONE) emitWall(b, ww, x, z, level, baseY, false);
    }
  }

  if (b.triangleCount === 0) return null;
  return { geometry: b.build(), triangles: b.triangleCount };
}

/**
 * @param {MeshBuilder} b
 * @param {number} material
 * @param {boolean} isNorth true for a north-edge wall (runs along X), false for
 *   a west-edge wall (runs along Z)
 */
function emitWall(b, material, x, z, level, baseY, isNorth) {
  const rgb = WALL_COLOR[material] ?? WALL_COLOR[WALL.PLASTER];
  const rects = wallRects(material);

  for (const r of rects) {
    // Bottom vertices are darker: a contact shadow where wall meets floor.
    const kBottom = r.y0 < 0.01 ? WALL_FOOT_AO : 1;
    const ao = [kBottom, kBottom, 1, 1];

    // Slightly dimmer on one side so the two faces of a wall are never the
    // same flat colour under a single key light.
    const dim = rgb.map((c) => c * 0.86);

    if (isNorth) {
      // Segment lies along X at constant Z = z, spanning u ∈ [x, x+1].
      const ax = (x + r.u0) * TILE;
      const bx = (x + r.u1) * TILE;
      const y0 = baseY + r.y0;
      const y1 = baseY + r.y1;
      const zn = z * TILE - WALL_SKIN;
      const zs = z * TILE + WALL_SKIN;
      // Face pointing north (−Z).
      b.quad([bx, y0, zn], [ax, y0, zn], [ax, y1, zn], [bx, y1, zn], rgb, ao, level);
      // Face pointing south (+Z).
      b.quad([ax, y0, zs], [bx, y0, zs], [bx, y1, zs], [ax, y1, zs], dim, ao, level);
    } else {
      // Segment lies along Z at constant X = x, spanning u ∈ [z, z+1].
      const az = (z + r.u0) * TILE;
      const bz = (z + r.u1) * TILE;
      const y0 = baseY + r.y0;
      const y1 = baseY + r.y1;
      const xw = x * TILE - WALL_SKIN;
      const xe = x * TILE + WALL_SKIN;
      // Face pointing west (−X).
      b.quad([xw, y0, az], [xw, y0, bz], [xw, y1, bz], [xw, y1, az], rgb, ao, level);
      // Face pointing east (+X).
      b.quad([xe, y0, bz], [xe, y0, az], [xe, y1, az], [xe, y1, bz], dim, ao, level);
    }
  }
}

export { MeshBuilder, AO_MIN };
