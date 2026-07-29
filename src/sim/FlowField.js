/**
 * Flow-field pathing.
 *
 * With hundreds of agents converging on one target, per-agent A* is the wrong
 * shape: it costs O(agents × path). A single Dijkstra sweep outward from the
 * target costs O(cells) *once*, and every agent then just reads the direction
 * stored in its own cell. One sweep serves ten zombies or five hundred at the
 * same price, which is the difference between a horde and a handful.
 *
 * The sweep is a bucketed Dijkstra rather than a plain BFS, because edges have
 * different costs: a shut door is passable but slow, so the dead prefer an open
 * route and only converge on a door when there is no better way round. That is
 * what makes barricading a doorway meaningful instead of merely decorative.
 *
 * ## Two things changed in M13
 *
 * **The sweep is bounded.** It used to expand until it ran out of map. M11's
 * benchmark measured that honestly: on a 300 × 300 town it visited 270,000
 * cells to steer zombies that were, at worst, forty metres away. A field is only
 * consulted by agents standing in it, so it is now built to a radius and every
 * agent outside that radius simply has no direction — which is a state the horde
 * already handled, because it falls back to hearing.
 *
 * **The sweep is three-dimensional.** Stair links are edges like any other, so
 * the field runs up and down as well as along, and the dead can follow you
 * upstairs. Before M13 the field was one storey and upstairs zombies could only
 * wander.
 */
import { DIR_VEC } from '../core/constants.js';
import { WALL } from '../world/TileGrid.js';

/** Sentinel for "no route from here". */
export const UNREACHABLE = 0xffff;

/**
 * Direction codes. 0–3 are the compass directions of `DIR`; the two extra
 * values are the vertical moves, which have no compass equivalent.
 */
export const UP = 4;
export const DOWN = 5;

/** Step costs, in the same units as a tile of open ground. */
const COST = {
  open: 10,
  /** A doorway with a shut door: passable, but they will go around if they can. */
  closedDoor: 34,
  /** Climbing a fence or through a window. */
  climb: 60,
  /**
   * A flight of stairs. Dearer than open ground so a route that stays on one
   * storey wins where one exists, which is also what stops the dead treating a
   * staircase as a shortcut across a room.
   */
  stairs: 22,
};

export class FlowField {
  /**
   * @param {import('../world/TileGrid.js').TileGrid} grid
   */
  constructor(grid) {
    this.grid = grid;
    const n = grid.size;

    /** Accumulated cost to the nearest goal. */
    this.dist = new Uint16Array(n);
    /** Direction code to step toward the goal, or -1. */
    this.dir = new Int8Array(n);

    // Bucket queue: costs are small integers, so a bucketed queue beats a binary
    // heap here. Buckets are pooled and only ever have their length reset, so a
    // sweep allocates nothing at all — re-creating them per sweep was measurably
    // the dominant cost.
    this._buckets = [];
    this._used = [];
    /** Cells touched by the last sweep, so `reset` need not clear the whole map. */
    this._touched = [];

    this.stats = { sweeps: 0, visited: 0, goals: 0 };
    this.dist.fill(UNREACHABLE);
    this.dir.fill(-1);
  }

  /**
   * Clear the previous sweep.
   *
   * Only the cells the last sweep actually reached are cleared. Once the sweep
   * is bounded to a radius, filling the whole array would cost more than the
   * sweep does — on a 300² town that is 270,000 writes to undo perhaps 5,000.
   */
  reset() {
    const { dist, dir, _touched } = this;
    if (_touched.length === 0) {
      dist.fill(UNREACHABLE);
      dir.fill(-1);
      return;
    }
    for (let k = 0; k < _touched.length; k++) {
      dist[_touched[k]] = UNREACHABLE;
      dir[_touched[k]] = -1;
    }
    _touched.length = 0;
  }

  /**
   * Recompute the field from one or more goal cells.
   *
   * @param {Array<{x: number, z: number, level?: number}>} goals
   * @param {number} [maxCost] stop expanding past this. Roughly
   *   `radiusInTiles * COST.open` — see `HordeSystem.FLOW_RADIUS`.
   */
  build(goals, maxCost = 520) {
    const { grid, dist, dir, _touched } = this;
    const { width, depth, levels } = grid;
    const plane = width * depth;

    this.reset();
    const buckets = this._buckets;
    const used = this._used;
    for (let i = 0; i < used.length; i++) buckets[used[i]].length = 0;
    used.length = 0;
    let maxBucket = 0;

    const push = (index, cost) => {
      let b = buckets[cost];
      if (b === undefined) {
        b = [];
        buckets[cost] = b;
      }
      if (b.length === 0) used.push(cost);
      b.push(index);
      if (cost > maxBucket) maxBucket = cost;
    };

    // The wall lookups below are inlined rather than going through
    // `wallBetween` → `wallAt` → `index`. A sweep makes tens of thousands of
    // them, and the accessor chain — with its bounds checks and switch — was the
    // dominant cost of the whole sweep.
    const { floor, flags, wallN, wallW } = grid;

    /** Cost of an agent stepping from (fx,fz) into (tx,tz) on `level`. */
    const stepCost = (fx, fz, tx, tz, expandDir, level) => {
      const base = level * plane;
      const fi = base + fz * width + fx;
      if (floor[fi] === 0 || (flags[fi] & 1) !== 0) return -1;

      // The wall on the edge crossed, resolved by which way we expanded.
      // North/west walls are stored on the cell south/east of them.
      let wall;
      if (expandDir === 0) wall = wallN[base + tz * width + tx];
      else if (expandDir === 2) wall = wallN[fi];
      else if (expandDir === 1) wall = wallW[fi];
      else wall = wallW[base + tz * width + tx];

      if (wall === WALL.NONE) return COST.open;
      if (wall === WALL.DOORWAY) {
        return grid.isDoorOpen(fx, fz, tx, tz, level) ? COST.open : COST.closedDoor;
      }
      if (wall === WALL.FENCE || wall === WALL.WINDOW) return COST.climb;
      return -1;
    };

    let goalCount = 0;
    for (const g of goals) {
      const level = g.level ?? 0;
      if (!grid.isWalkable(g.x, g.z, level)) continue;
      const i = level * plane + g.z * width + g.x;
      if (dist[i] === 0) continue;
      dist[i] = 0;
      _touched.push(i);
      push(i, 0);
      goalCount++;
    }
    this.stats.goals = goalCount;
    if (goalCount === 0) return 0;

    let visited = 0;
    for (let cost = 0; cost <= maxBucket && cost <= maxCost; cost++) {
      const bucket = buckets[cost];
      if (bucket === undefined || bucket.length === 0) continue;

      for (let bi = 0; bi < bucket.length; bi++) {
        const index = bucket[bi];
        // A cell can be queued more than once at different costs; the first time
        // it comes out is the cheapest, so later entries are stale.
        if (dist[index] !== cost) continue;
        visited++;

        const level = (index / plane) | 0;
        const within = index - level * plane;
        const z = (within / width) | 0;
        const x = within - z * width;

        // --- along ---------------------------------------------------
        for (let d = 0; d < 4; d++) {
          const v = DIR_VEC[d];
          const nx = x + v.dx;
          const nz = z + v.dz;
          if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;

          const step = stepCost(nx, nz, x, z, d, level);
          if (step < 0) continue;

          const next = cost + step;
          if (next > maxCost) continue;
          const ni = index + v.dz * width + v.dx;
          if (next >= dist[ni]) continue;

          if (dist[ni] === UNREACHABLE) _touched.push(ni);
          dist[ni] = next;
          // The neighbour steps back toward the cell it was reached from, which
          // is the direction opposite the one we expanded in.
          dir[ni] = (d + 2) % 4;
          push(ni, next);
        }

        // --- up and down ---------------------------------------------
        // Expansion runs backwards from the goal, so what matters is whether the
        // *neighbour* can move into this cell. The cell above can descend here;
        // the cell below can climb here.
        const next = cost + COST.stairs;
        if (next > maxCost) continue;

        if (level + 1 < levels && grid.descendFrom(x, z, level + 1) === level) {
          const ni = index + plane;
          if (next < dist[ni]) {
            if (dist[ni] === UNREACHABLE) _touched.push(ni);
            dist[ni] = next;
            dir[ni] = DOWN;
            push(ni, next);
          }
        }
        if (level > 0 && grid.climbFrom(x, z, level - 1) === level) {
          const ni = index - plane;
          if (next < dist[ni]) {
            if (dist[ni] === UNREACHABLE) _touched.push(ni);
            dist[ni] = next;
            dir[ni] = UP;
            push(ni, next);
          }
        }
      }
    }

    this.stats.sweeps++;
    this.stats.visited = visited;
    return visited;
  }

  /**
   * Reference implementation of the horizontal step cost, kept for tests and
   * clarity.
   *
   * `build` inlines the same rule against the raw arrays because the accessor
   * chain dominated the sweep; this version is what that inlining must agree
   * with, and a test asserts that it does.
   */
  stepCost(fx, fz, tx, tz, level = 0) {
    const grid = this.grid;
    if (!grid.isWalkable(fx, fz, level)) return -1;

    const wall = grid.wallBetween(fx, fz, tx, tz, level);
    if (wall === WALL.NONE) return COST.open;
    if (wall === WALL.DOORWAY) {
      return grid.isDoorOpen(fx, fz, tx, tz, level) ? COST.open : COST.closedDoor;
    }
    if (wall === WALL.FENCE || wall === WALL.WINDOW) return COST.climb;
    return -1;
  }

  _index(x, z, level) {
    const { width, depth, levels } = this.grid;
    if (x < 0 || z < 0 || x >= width || z >= depth || level < 0 || level >= levels) return -1;
    return level * width * depth + z * width + x;
  }

  /** @returns {number} direction code to step, or -1 when there is no route */
  directionAt(x, z, level = 0) {
    const i = this._index(x, z, level);
    return i < 0 ? -1 : this.dir[i];
  }

  /** @returns {number} cost to the goal, or UNREACHABLE */
  costAt(x, z, level = 0) {
    const i = this._index(x, z, level);
    return i < 0 ? UNREACHABLE : this.dist[i];
  }

  /** Does this cell have a route to a goal? */
  reachable(x, z, level = 0) {
    return this.costAt(x, z, level) !== UNREACHABLE;
  }
}

export { COST };
