/**
 * Saving.
 *
 * ## The world is a seed plus what you changed
 *
 * A 104 × 104 × 3 town is a third of a million cells. Storing them would be
 * megabytes of data describing a town that regenerates identically from six
 * characters. So a save is the **seed** plus the *deltas*: which doors are open,
 * which openings are boarded and how badly, which containers have been opened
 * and what is left in them, and which of the dead are down.
 *
 * That is the same principle M8's lazy loot already relies on — an unopened
 * cupboard costs nothing because its contents are a function of the seed — and
 * it is why that decision was worth making then rather than now.
 *
 * ## What is deliberately not saved
 *
 * Fog of war. It is knowledge the *player* has, not state the world has, and
 * rebuilding it from a save would mean either storing a third of a million bytes
 * of visibility or lying about what they had seen. Reloading re-reveals as you
 * walk, which is a mild loss and a large simplification.
 */

const DB_NAME = 'knox';
const STORE = 'saves';
const VERSION = 1;

/**
 * Collect everything that is not derivable from the seed.
 *
 * @param {object} game
 * @returns {object} a plain, structured-cloneable snapshot
 */
export function serialise(game) {
  const { world, avatar, clock, moodles, horde, loot, combat, skills } = game;
  const grid = world.grid;

  // Doors, barricades and searched containers are sparse: a town has thousands
  // of cells and a handful of changes, so they are stored as index/value pairs
  // rather than as full arrays.
  // Objects the *player* put down. Worldgen's furniture regenerates from the
  // seed, so only the difference needs storing — and `Stations` already knows
  // exactly which cells those are.
  const placed = [];
  for (const state of game.stations?.byCell.values() ?? []) {
    placed.push(state.index, grid.object[state.index]);
  }

  const doors = [];
  const barricades = [];
  for (let i = 0; i < grid.size; i++) {
    if (grid.state[i] !== 0) doors.push(i, grid.state[i]);
    if (grid.barricadeN[i] || grid.barricadeW[i]) {
      barricades.push(i, grid.barricadeN[i], grid.barricadeHpN[i], grid.barricadeW[i], grid.barricadeHpW[i]);
    }
  }

  const containers = [];
  for (const [index, container] of loot.opened) {
    containers.push({
      index,
      items: container.items.map((it) => ({ id: it.id, count: it.count, age: it.age })),
    });
  }

  const dead = [];
  for (let i = 0; i < horde.horde.count; i++) {
    if (horde.horde.state[i] === 4 /* DEAD */) dead.push(i);
  }

  return {
    version: VERSION,
    seed: game.seed,
    savedAt: null, // stamped by the caller; Date is not available in worldgen
    // Who the survivor is, so Continue restores the character rather than the
    // last one the menu happened to be showing. It is three strings.
    profile: game.profile?.toJSON() ?? null,
    // Which utilities have failed and whether the helicopter has been. The
    // *schedule* is derived from the seed, so only what has already happened
    // needs storing — three booleans and a list of announcements.
    meta: game.meta?.toJSON() ?? null,
    // What has been built and how much is left in it. The objects themselves
    // are already in the grid deltas; this is the running state.
    stations: game.stations?.toJSON() ?? null,
    clock: { elapsed: clock.elapsed },
    player: {
      x: avatar.position.x,
      z: avatar.position.z,
      level: avatar.level,
      yaw: avatar.yaw,
      endurance: avatar.endurance,
      weapon: avatar.weapon.def.id,
      weaponCondition: avatar.weapon.condition,
      torchOn: avatar.torchOn,
      body: {
        health: Array.from(avatar.body.health),
        bleed: Array.from(avatar.body.bleed),
        fractured: Array.from(avatar.body.fractured),
        pain: avatar.body.pain,
        infected: avatar.body.infected,
        infection: avatar.body.infection,
        alive: avatar.body.alive,
      },
      inventory: avatar.inventory.items.map((it) => ({ id: it.id, count: it.count, age: it.age })),
    },
    moodles: {
      hunger: moodles.hunger,
      thirst: moodles.thirst,
      fatigue: moodles.fatigue,
      temperature: moodles.temperature,
      panic: moodles.panic,
    },
    skills: skills.toJSON(),
    stats: { kills: combat.stats.kills },
    world: { doors, barricades, containers, dead, placed },
  };
}

/**
 * Apply a snapshot onto a freshly generated world.
 *
 * The world must already have been regenerated from the same seed — this only
 * replays the differences.
 */
export function restore(game, data, { Item, Container, WeaponInstance, Skills }) {
  if (!data || data.version !== VERSION) return false;
  const { world, avatar, clock, moodles, horde, loot } = game;
  const grid = world.grid;

  clock.elapsed = data.clock.elapsed;

  const p = data.player;
  avatar.position.set(p.x, p.level * 2.6, p.z);
  avatar.level = p.level;
  avatar.setYaw(p.yaw);
  avatar.endurance = p.endurance;
  avatar.weapon = new WeaponInstance(p.weapon);
  avatar.weapon.condition = p.weaponCondition;
  avatar.torchOn = p.torchOn;

  avatar.body.health.set(p.body.health);
  avatar.body.bleed.set(p.body.bleed);
  avatar.body.fractured.set(p.body.fractured);
  avatar.body.pain = p.body.pain;
  avatar.body.infected = p.body.infected;
  avatar.body.infection = p.body.infection;
  avatar.body.alive = p.body.alive;

  avatar.inventory.items.length = 0;
  for (const raw of p.inventory) {
    const item = new Item(raw.id, raw.count);
    item.age = raw.age;
    avatar.inventory.add(item, true);
  }

  Object.assign(moodles, data.moodles);
  game.skills = Skills.fromJSON(data.skills);
  // The XP multiplier is a property of the character, not of the save, so it is
  // re-derived from the profile rather than stored twice and allowed to drift.
  if (game.profile) game.skills.rate = game.profile.mod('xpRate');
  avatar.skills = game.skills;

  const { doors, barricades, containers, dead, placed } = data.world;
  for (let i = 0; i < (placed?.length ?? 0); i += 2) grid.object[placed[i]] = placed[i + 1];
  for (let i = 0; i < doors.length; i += 2) grid.state[doors[i]] = doors[i + 1];
  for (let i = 0; i < barricades.length; i += 5) {
    const index = barricades[i];
    grid.barricadeN[index] = barricades[i + 1];
    grid.barricadeHpN[index] = barricades[i + 2];
    grid.barricadeW[index] = barricades[i + 3];
    grid.barricadeHpW[index] = barricades[i + 4];
  }

  game.meta?.fromJSON(data.meta);
  game.stations?.fromJSON(data.stations);
  if (game.meta && !game.meta.utilities.power) game.renderer?.setPower(false);

  loot.opened.clear();
  for (const saved of containers) {
    const container = new Container(40, 'container');
    for (const raw of saved.items) {
      const item = new Item(raw.id, raw.count);
      item.age = raw.age;
      container.add(item, true);
    }
    loot.opened.set(saved.index, container);
  }

  for (const i of dead) if (i < horde.horde.count) horde.horde.state[i] = 4;

  grid.markAllDirty();
  world.flushDirty(Infinity);
  return true;
}

/** Minimal IndexedDB wrapper. Resolves to null rather than throwing. */
function openDb() {
  return new Promise((resolve) => {
    if (!globalThis.indexedDB) return resolve(null);
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export async function save(slot, snapshot) {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(snapshot, slot);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

export async function load(slot) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(slot);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
  });
}

export async function clear(slot) {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(slot);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

export { VERSION };
