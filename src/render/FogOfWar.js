/**
 * Three-state fog of war.
 *
 * The reference game's black-and-grey memory fog is not decoration — it *is* the
 * tension. You know the shape of the house you looted; you do not know what is
 * standing in it now. Encoding that as three states rather than a binary
 * visible/hidden is what makes the distinction exist at all:
 *
 *   unseen      → near-black; you have never been here
 *   remembered  → dim and desaturated; you know the geometry, not the contents
 *   visible     → lit normally
 *
 * ## Where it lives
 *
 * In a texture, not in the mesh. Visibility changes every time the player moves
 * a tile; baking it into vertex colours would mean remeshing a dozen chunks per
 * step. As a single-channel texture sampled by world position, a visibility
 * update is one `texSubImage` and costs nothing.
 *
 * Storeys are stacked vertically in the same texture — level L occupies rows
 * `L * depth` to `(L+1) * depth`. One texture, one sampler, one binding.
 */
import { DataTexture, RedFormat, UnsignedByteType, NearestFilter, ClampToEdgeWrapping } from 'three';
import { VIS, computeVisible, markWallSkirt } from '../sim/Sight.js';

/** Encoded texel values per state — read straight into the shader as 0–1. */
const TEXEL = {
  [VIS.UNSEEN]: 0,
  [VIS.REMEMBERED]: 110,
  [VIS.VISIBLE]: 255,
};

export class FogOfWar {
  /**
   * @param {import('../world/TileGrid.js').TileGrid} grid
   * @param {{ radius?: number }} [opts]
   */
  constructor(grid, { radius = 17 } = {}) {
    this.grid = grid;
    this.radius = radius;

    this.width = grid.width;
    this.height = grid.depth * grid.levels;

    /** Persistent knowledge, one byte per cell. Survives leaving the area. */
    this.state = new Uint8Array(grid.size);
    /** What is visible *this* update, so the previous set can be demoted. */
    this._visible = new Set();
    this._previous = new Set();
    /** Reused flat x,z buffer, so an update allocates nothing. */
    this._scratch = [];

    this.data = new Uint8Array(this.width * this.height);
    this.texture = new DataTexture(this.data, this.width, this.height, RedFormat, UnsignedByteType);
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    this.texture.wrapS = ClampToEdgeWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    /** Set when the observer has not moved, so the work can be skipped. */
    this._lastKey = -1;
    this.enabled = true;
    this.stats = { visible: 0, updates: 0 };
  }

  /**
   * Recompute visibility from an observer.
   *
   * Cheap to call every frame: it returns immediately unless the observer has
   * changed *tile*, which is what actually changes what can be seen.
   *
   * @returns {boolean} whether anything was recomputed
   */
  update(x, z, level) {
    if (!this.enabled) return false;
    const key = (level * this.grid.depth + z) * this.grid.width + x;
    if (key === this._lastKey) return false;
    this._lastKey = key;

    const tmp = this._previous;
    this._previous = this._visible;
    this._visible = tmp;
    this._visible.clear();

    const grid = this.grid;

    // Sight is cast on every storey at or above the observer's, not just their
    // own. Casting only on one leaves every roof in the town unseen — a black
    // hole in the middle of a lit street — because a roof's visibility cannot
    // be inherited from a ground-floor interior nobody can see into.
    //
    // Casting per storey gets it right for free rather than by special case: a
    // roof has no walls at its own level, so the sweep reaches all of it, while
    // an upper-storey *interior* still has its exterior walls and stays dark
    // until the player climbs up there. Levels below the observer are left
    // alone — you cannot see the floor below through the floor you stand on.
    const seen = this._scratch;
    for (let l = level; l < grid.levels; l++) {
      seen.length = 0;
      const mark = (mx, mz) => {
        this._visible.add(grid.idx(mx, mz, l));
        seen.push(mx, mz);
      };
      computeVisible(grid, x, z, l, this.radius, mark);
      // The far face of a wall you are standing against is not "seen through",
      // but it is certainly seen. Without this a room is ringed by black where
      // its own walls are.
      markWallSkirt(grid, l, seen, (vx, vz) => this._visible.has(grid.idx(vx, vz, l)), mark);
    }

    // Demote everything that was visible and no longer is.
    for (const i of this._previous) {
      if (!this._visible.has(i)) {
        this.state[i] = VIS.REMEMBERED;
        this._writeTexel(i);
      }
    }
    for (const i of this._visible) {
      if (this.state[i] !== VIS.VISIBLE) {
        this.state[i] = VIS.VISIBLE;
        this._writeTexel(i);
      }
    }

    this.texture.needsUpdate = true;
    this.stats.visible = this._visible.size;
    this.stats.updates++;
    return true;
  }

  _writeTexel(i) {
    // Cell index and texel index coincide: the texture is laid out exactly like
    // the grid, with storeys stacked in rows.
    this.data[i] = TEXEL[this.state[i]];
  }

  /** @returns {number} one of VIS */
  at(x, z, level) {
    const i = this.grid.index(x, z, level);
    return i < 0 ? VIS.UNSEEN : this.state[i];
  }

  /** Reveal everything — for debugging and for the screenshot gate. */
  revealAll() {
    this.state.fill(VIS.VISIBLE);
    this.data.fill(TEXEL[VIS.VISIBLE]);
    this.texture.needsUpdate = true;
    this._lastKey = -1;
  }

  /** Forget everything. */
  reset() {
    this.state.fill(VIS.UNSEEN);
    this.data.fill(0);
    this._visible.clear();
    this._previous.clear();
    this._lastKey = -1;
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}
