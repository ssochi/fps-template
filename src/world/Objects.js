/**
 * The object layer — furniture, doors, stairs, street clutter.
 *
 * One object per tile, stored in `grid.object` as a packed `id * 4 + facing`.
 * Packing the facing in costs nothing and avoids a second parallel array, and
 * because the camera only ever sits at four snapped rotations, four facings are
 * all any object needs.
 *
 * Objects are meshed into the chunk geometry rather than being scene nodes.
 * A furnished town has tens of thousands of them; as `Object3D`s that is tens
 * of thousands of draw calls and matrix updates, and none of them ever move.
 */
import { Color } from 'three';
import { DIR } from '../core/constants.js';

export const OBJ = {
  NONE: 0,
  DOOR: 1,
  /** Lower half of a two-tile staircase. */
  STAIRS_LOW: 2,
  /** Upper half. */
  STAIRS_HIGH: 3,

  BED: 4,
  TABLE: 5,
  CHAIR: 6,
  SOFA: 7,
  COUNTER: 8,
  FRIDGE: 9,
  STOVE: 10,
  SHELF: 11,
  WARDROBE: 12,
  DESK: 13,
  TV: 14,
  TOILET: 15,
  SINK: 16,
  BATH: 17,
  CRATE: 18,

  TREE: 19,
  BUSH: 20,
  CAR: 21,
  BIN: 22,
  LAMPPOST: 23,

  // --- M18: things you build ------------------------------------------
  /** Collects rain. The answer to the water shutoff. */
  RAIN_BARREL: 24,
  /** Warmth, light, and the only way to cook. */
  CAMPFIRE: 25,
  /** Mains power in one building, for as long as the petrol lasts. */
  GENERATOR: 26,
};

/**
 * @typedef {object} ObjectSpec
 * @property {string} name
 * @property {number} w      width across the tile, 0–1
 * @property {number} d      depth across the tile, 0–1
 * @property {number} h      height in metres
 * @property {number} color  sRGB hex
 * @property {number} [y]    height off the floor, for wall-mounted things
 * @property {boolean} [solid]   blocks movement
 * @property {boolean} [opaque]  blocks line of sight
 * @property {boolean} [container] can hold loot (M8 reads this)
 * @property {boolean} [flush] sits against a wall rather than centred
 */

/** @type {Record<number, ObjectSpec>} */
export const OBJECT_SPEC = {
  [OBJ.DOOR]: { name: 'door', w: 0.9, d: 0.1, h: 2.05, color: 0x6b5237 },
  [OBJ.STAIRS_LOW]: { name: 'stairs', w: 1, d: 1, h: 1.3, color: 0x7a6244 },
  [OBJ.STAIRS_HIGH]: { name: 'stairs', w: 1, d: 1, h: 2.6, color: 0x7a6244 },

  [OBJ.BED]: { name: 'bed', w: 0.9, d: 0.95, h: 0.55, color: 0x7d6a78, container: true, flush: true },
  [OBJ.TABLE]: { name: 'table', w: 0.85, d: 0.85, h: 0.75, color: 0x6f5539 },
  [OBJ.CHAIR]: { name: 'chair', w: 0.45, d: 0.45, h: 0.9, color: 0x5f4a32 },
  [OBJ.SOFA]: { name: 'sofa', w: 0.95, d: 0.7, h: 0.8, color: 0x4f5a63, flush: true },
  [OBJ.COUNTER]: { name: 'counter', w: 1, d: 0.7, h: 0.92, color: 0x8a8478, container: true, flush: true },
  [OBJ.FRIDGE]: { name: 'fridge', w: 0.8, d: 0.75, h: 1.8, color: 0x9aa2a6, solid: true, opaque: true, container: true, flush: true },
  [OBJ.STOVE]: { name: 'stove', w: 0.9, d: 0.7, h: 0.95, color: 0x585d61, container: true, flush: true },
  [OBJ.SHELF]: { name: 'shelf', w: 0.95, d: 0.4, h: 1.9, color: 0x6b5539, solid: true, opaque: true, container: true, flush: true },
  [OBJ.WARDROBE]: { name: 'wardrobe', w: 0.9, d: 0.6, h: 2.0, color: 0x5e4830, solid: true, opaque: true, container: true, flush: true },
  [OBJ.DESK]: { name: 'desk', w: 0.95, d: 0.6, h: 0.78, color: 0x6a5136, container: true, flush: true },
  [OBJ.TV]: { name: 'tv', w: 0.8, d: 0.2, h: 0.6, color: 0x2a2d31, y: 0.6, flush: true },
  [OBJ.TOILET]: { name: 'toilet', w: 0.5, d: 0.6, h: 0.75, color: 0xb9bcbd, flush: true },
  [OBJ.SINK]: { name: 'sink', w: 0.6, d: 0.45, h: 0.85, color: 0xb9bcbd, flush: true },
  [OBJ.BATH]: { name: 'bath', w: 0.95, d: 0.75, h: 0.6, color: 0xc3c6c7, flush: true },
  [OBJ.CRATE]: { name: 'crate', w: 0.7, d: 0.7, h: 0.7, color: 0x7a6238, container: true },

  [OBJ.TREE]: { name: 'tree', w: 0.8, d: 0.8, h: 4.2, color: 0x3f5a34, solid: true, opaque: true },
  [OBJ.BUSH]: { name: 'bush', w: 0.75, d: 0.75, h: 1.0, color: 0x46603a },
  [OBJ.CAR]: { name: 'car', w: 0.95, d: 0.95, h: 1.4, color: 0x6b3f3d, solid: true, opaque: true, container: true },
  [OBJ.BIN]: { name: 'bin', w: 0.6, d: 0.6, h: 1.0, color: 0x4a5a4a, container: true },
  [OBJ.RAIN_BARREL]: { name: 'rain barrel', w: 0.7, d: 0.7, h: 0.95, color: 0x4a5a55, solid: true, container: false },
  [OBJ.CAMPFIRE]: { name: 'campfire', w: 0.8, d: 0.8, h: 0.28, color: 0x3a2f28 },
  [OBJ.GENERATOR]: { name: 'generator', w: 0.7, d: 0.55, h: 0.6, color: 0x8a7326, solid: true },

  [OBJ.LAMPPOST]: { name: 'lamppost', w: 0.16, d: 0.16, h: 4.6, color: 0x4e5257, solid: true },
};

/** Pack an object id and facing into the single value stored per cell. */
export function packObject(id, facing = DIR.N) {
  return id * 4 + facing;
}

export function objectId(packed) {
  return packed >> 2;
}

export function objectFacing(packed) {
  return packed & 3;
}

/** @returns {ObjectSpec | null} */
export function objectSpec(packed) {
  return OBJECT_SPEC[objectId(packed)] ?? null;
}

/** Linear-space colour, matching how the mesher bakes vertex colours. */
const _colorCache = new Map();
export function objectColor(id) {
  let rgb = _colorCache.get(id);
  if (!rgb) {
    const spec = OBJECT_SPEC[id];
    const c = new Color(spec ? spec.color : 0xff00ff);
    rgb = [c.r, c.g, c.b];
    _colorCache.set(id, rgb);
  }
  return rgb;
}
