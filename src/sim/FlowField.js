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
 */
import { DIR_VEC } from '../core/constants.js';
import { WALL } from '../world/TileGrid.js';

/** Sentinel for "no route from here". */
export const UNREACHABLE = 0xffff;

/** Step costs, in the same units as a tile of open ground. */
const COST = {
  open: 10,
  /** A doorway with a shut door: passable, but they will go around if they can. */
  closedDoor: 34,
  /** Climbing a fence or through a window. */
  climb: 60,
};

export class FlowField {
  /** @param {import('../world/TileGrid.js').TileGrid} grid */
  constructor(grid, level = 0) {
    this.grid = grid;
    this.level = level;
    const n = grid.width * grid.depth;

    /** Accumulated cost to the nearest goal. */
    this.dist = new Uint16Array(n);
    /** Direction index (0–3) to step toward the goal, or -1. */
    this.dir = new Int8Array(n);

    // Bucket queue: costs are small integers, so a bucketed queue beats a binary
    // heap here. Buckets are pooled and only ever have their length reset, so a
    // sweep allocates nothing at all — re-creating them per sweep was measurably
    // the dominant cost.
    this._buckets = [];
    this._used = [];

    this.stats = { sweeps: 0, visited: 0, goals: 0 };
    this.reset();
  }

  reset() {
    this.dist.fill(UNREACHABLE);
    this.dir.fill(-1);
  }

  /**
   * Recompute the field from one or more goal tiles.
   *
   * @param {Array<{x: number, z: number}>} goals
   * @param {number} [maxCost] stop expanding past this, so a sweep never walks
   *   the whole town to serve zombies who are nowhere near it
   */
  build(goals, maxCost = 4000) {
    const { grid, dist, dir } = this;
    const { width, depth } = grid;
    const level = this.level;

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
    // `wallBetween` → `wallAt` → `index`. A sweep makes roughly 42,000 of them,
    // and the accessor chain — with its bounds checks and switch — was the
    // dominant cost of the whole sweep.
    const base = level * depth * width;
    const { floor, flags, wallN, wallW } = grid;

    /** Cost of an agent stepping from (fx,fz) into (tx,tz); -1 if impassable. */
    const stepCost = (fx, fz, tx, tz, expandDir) => {
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
      if (!grid.isWalkable(g.x, g.z, level)) continue;
      const i = g.z * width + g.x;
      dist[i] = 0;
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

        const z = (index / width) | 0;
        const x = index - z * width;

        for (let d = 0; d < 4; d++) {
          const v = DIR_VEC[d];
          const nx = x + v.dx;
          const nz = z + v.dz;
          if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;

          const step = stepCost(nx, nz, x, z, d);
          if (step < 0) continue;

          const next = cost + step;
          if (next > maxCost) continue;
          const ni = nz * width + nx;
          if (next >= dist[ni]) continue;

          dist[ni] = next;
          // The neighbour steps back toward the cell it was reached from, which
          // is the direction opposite the one we expanded in.
          dir[ni] = (d + 2) % 4;
          push(ni, next);
        }
      }
    }

    this.stats.sweeps++;
    this.stats.visited = visited;
    return visited;
  }

  /**
   * Reference implementation of the step cost, kept for tests and clarity.
   *
   * `build` inlines the same rule against the raw arrays because the accessor
   * chain dominated the sweep; this version is what that inlining must agree
   * with, and a test asserts that it does.
   */
  stepCost(fx, fz, tx, tz) {
    const grid = this.grid;
    const level = this.level;
    if (!grid.isWalkable(fx, fz, level)) return -1;

    const wall = grid.wallBetween(fx, fz, tx, tz, level);
    if (wall === WALL.NONE) return COST.open;
    if (wall === WALL.DOORWAY) {
      return grid.isDoorOpen(fx, fz, tx, tz, level) ? COST.open : COST.closedDoor;
    }
    if (wall === WALL.FENCE || wall === WALL.WINDOW) return COST.climb;
    return -1;
  }

  /** @returns {number} direction index to step, or -1 when there is no route */
  directionAt(x, z) {
    if (x < 0 || z < 0 || x >= this.grid.width || z >= this.grid.depth) return -1;
    return this.dir[z * this.grid.width + x];
  }

  /** @returns {number} cost to the goal, or UNREACHABLE */
  costAt(x, z) {
    if (x < 0 || z < 0 || x >= this.grid.width || z >= this.grid.depth) return UNREACHABLE;
    return this.dist[z * this.grid.width + x];
  }

  /** Does this cell have a route to a goal? */
  reachable(x, z) {
    return this.costAt(x, z) !== UNREACHABLE;
  }
}

export { COST };
