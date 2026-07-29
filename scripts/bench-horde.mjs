/**
 * M13's central claim, measured: bounding the flow-field sweep turns it from
 * O(cells) into O(radius²), so the map's size stops setting the AI's cost.
 *
 *   node scripts/bench-horde.mjs
 */
import { TileGrid, FLOOR } from '../src/world/TileGrid.js';
import { COST, FlowField } from '../src/sim/FlowField.js';
import { SoundField } from '../src/sim/Sound.js';
import { Horde } from '../src/sim/Horde.js';
import { Migration } from '../src/sim/Migration.js';
import { generateTown } from '../src/worldgen/Town.js';
import { FLOW_RADIUS } from '../src/sim/HordeSystem.js';

/** A stand-in for `World`, since worldgen only ever touches the grid. */
function fakeWorld(width, depth, levels) {
  const grid = new TileGrid(width, depth, levels);
  return { grid, markAllDirty: () => {}, flushDirty: () => {} };
}

function time(label, runs, fn) {
  fn(); // warm
  const start = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const ms = (performance.now() - start) / runs;
  return { label, ms };
}

const SIZES = [104, 200, 300, 420];
const rows = [];

for (const size of SIZES) {
  const world = fakeWorld(size, size, 3);
  const town = generateTown(world, `bench-${size}`);
  const grid = world.grid;

  const goal = { x: town.spawn.x, z: town.spawn.z, level: 0 };
  const bounded = new FlowField(grid);
  const unbounded = new FlowField(grid);

  const b = time('bounded', 20, () => bounded.build([goal], FLOW_RADIUS * COST.open));
  const u = time('unbounded', 5, () => unbounded.build([goal], 0xfffe));

  const sound = new SoundField(grid);
  const s = time('sound emit', 20, () => {
    sound.clear();
    sound.emit(goal.x, goal.z, 0, 30);
  });
  // The decay pass runs *every* tick over every cell, so it is the sound
  // field's real cost — emission happens a few times a second at most.
  const sd = time('sound decay', 100, () => sound.update(1 / 30));

  const migration = new Migration(grid);
  const horde = new Horde(grid, bounded, sound, { capacity: 400, seed: 'bench', migration });
  horde.populate(300);
  const c = time('census', 50, () => migration.census(horde));
  const a = time('horde tick', 50, () => horde.update(1 / 30, goal));

  rows.push({
    size,
    cells: grid.size,
    boundedMs: b.ms,
    boundedVisited: bounded.stats.visited,
    unboundedMs: u.ms,
    unboundedVisited: unbounded.stats.visited,
    soundMs: s.ms,
    decayMs: sd.ms,
    censusMs: c.ms,
    tickMs: a.ms,
    migrationKb: (migration.population.byteLength + migration.capacity.byteLength +
      migration.memory.byteLength) / 1024,
  });
}

const pad = (s, n) => String(s).padStart(n);
console.log(`\n  flow-field sweep, radius ${FLOW_RADIUS} tiles\n`);
console.log('  map        cells   bounded          unbounded        speedup');
for (const r of rows) {
  console.log(
    `  ${pad(r.size + '²×3', 8)} ${pad(r.cells.toLocaleString(), 9)}   ` +
      `${pad(r.boundedMs.toFixed(2), 5)} ms / ${pad(r.boundedVisited.toLocaleString(), 7)}   ` +
      `${pad(r.unboundedMs.toFixed(2), 6)} ms / ${pad(r.unboundedVisited.toLocaleString(), 7)}   ` +
      `${pad((r.unboundedMs / r.boundedMs).toFixed(1) + '×', 6)}`,
  );
}

console.log('\n  the rest of the horde, per simulation step\n');
console.log('  map        sound emit   decay/tick   census (300)   tick (300)   migration mem');
for (const r of rows) {
  console.log(
    `  ${pad(r.size + '²×3', 8)} ${pad(r.soundMs.toFixed(2), 9)} ms ${pad(r.decayMs.toFixed(3), 10)} ms ` +
      `${pad(r.censusMs.toFixed(3), 12)} ms ${pad(r.tickMs.toFixed(3), 10)} ms ` +
      `${pad(r.migrationKb.toFixed(1) + ' KB', 14)}`,
  );
}
console.log();
