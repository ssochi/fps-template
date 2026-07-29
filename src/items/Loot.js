/**
 * Loot generation.
 *
 * ## Contents come from the room, not from a global table
 *
 * M2's furnishing pass gave every room a *purpose* before it placed any
 * furniture, and this is what that was for: a fridge in a kitchen holds food, a
 * wardrobe in a bedroom holds sheets and clothes, a shelf in a storage room
 * holds tools and planks. Rolling from one global table would put bandages in
 * the oven, and the thing that makes a house worth searching is that you can
 * *guess* where to look.
 *
 * ## Rolled lazily, and deterministically
 *
 * A town has thousands of containers and the player will open a few dozen.
 * Nothing is generated until a container is opened for the first time, and when
 * it is, the contents derive from the world seed and the container's own cell
 * index — so the same jar of beans is in the same cupboard whether you open it
 * on day one or day nine, and a save file never has to store an unopened room.
 */
import { Container } from './Container.js';
import { Item, ITEMS } from './ItemDb.js';
import { OBJ, objectId, OBJECT_SPEC } from '../world/Objects.js';
import { Rng } from '../core/Rng.js';

/**
 * What each container type can hold, by the purpose of the room it stands in.
 * `null` means "this container type is not interesting in this room" and yields
 * an empty container — an empty cupboard is a legitimate and important result.
 */
const TABLES = {
  kitchen: {
    [OBJ.FRIDGE]: ['milk', 'milk', 'cheese', 'rawmeat', 'rawmeat', 'apple', 'bread', 'soda', 'water'],
    [OBJ.COUNTER]: ['beans', 'soup', 'crisps', 'chocolate', 'water', 'knife', 'rag'],
    [OBJ.STOVE]: ['soup', 'beans'],
    [OBJ.SHELF]: ['beans', 'soup', 'water', 'crisps', 'potato', 'potato'],
  },
  bedroom: {
    [OBJ.WARDROBE]: ['sheet', 'sheet', 'bag', 'rag', 'chocolate'],
    [OBJ.BED]: ['sheet', 'rag'],
    [OBJ.SHELF]: ['bandage', 'painkillers', 'chocolate', 'torch'],
    [OBJ.DESK]: ['painkillers', 'torch', 'nails'],
  },
  bathroom: {
    [OBJ.SINK]: ['bandage', 'painkillers', 'rag'],
    [OBJ.SHELF]: ['bandage', 'bandage', 'painkillers', 'firstaid'],
  },
  living: {
    [OBJ.SHELF]: ['torch', 'chocolate', 'crisps', 'painkillers', 'bat'],
    [OBJ.DESK]: ['torch', 'nails', 'painkillers'],
    [OBJ.SOFA]: ['crisps', 'chocolate'],
  },
  storage: {
    // A generator lives exactly where you would look for one, and weighs
    // twenty-five kilograms — finding it is the easy half.
    [OBJ.SHELF]: ['nails', 'plank', 'hammer', 'axe', 'crowbar', 'torch', 'petrol'],
    [OBJ.CRATE]: ['plank', 'plank', 'nails', 'bag', 'water', 'petrol', 'generator'],
  },
  /** Outdoors and anything unclassified. */
  default: {
    [OBJ.BIN]: ['rag', 'plank', 'crisps'],
    [OBJ.CAR]: ['crowbar', 'water', 'rag', 'bag', 'petrol'],
    [OBJ.CRATE]: ['plank', 'nails', 'water', 'petrol'],
  },
};

/** How full a container tends to be, by room purpose. */
const ABUNDANCE = {
  kitchen: 0.72,
  storage: 0.66,
  bathroom: 0.5,
  bedroom: 0.48,
  living: 0.42,
  default: 0.3,
};

/** Capacity in kilograms, by container type. */
const CAPACITY = {
  [OBJ.FRIDGE]: 40,
  [OBJ.WARDROBE]: 30,
  [OBJ.COUNTER]: 20,
  [OBJ.SHELF]: 25,
  [OBJ.DESK]: 15,
  [OBJ.CRATE]: 25,
  [OBJ.STOVE]: 10,
  [OBJ.SINK]: 8,
  [OBJ.BED]: 10,
  [OBJ.SOFA]: 6,
  [OBJ.BIN]: 12,
  [OBJ.CAR]: 45,
};

export class LootSystem {
  /**
   * @param {import('../world/TileGrid.js').TileGrid} grid
   * @param {string|number} seed the world seed, so loot matches the town
   * @param {Map<number, string>} roomPurposes roomId → purpose
   */
  constructor(grid, seed, roomPurposes = new Map()) {
    this.grid = grid;
    this.seed = new Rng(seed).seed;
    this.roomPurposes = roomPurposes;
    /** @type {Map<number, Container>} cell index → contents, once opened */
    this.opened = new Map();
    /**
     * Cells where the *player* put the container down.
     *
     * Loot is a function of `(seed, cell)`, which is exactly right for a
     * cupboard that has been standing in a kitchen since before the outbreak
     * and exactly wrong for a crate you carried in and set down five seconds
     * ago. A shelf you built is empty because you have not put anything in it.
     */
    this.placed = new Set();
    this.stats = { generated: 0, items: 0 };
  }

  /** Is there something searchable on this tile? */
  containerAt(x, z, level) {
    const i = this.grid.index(x, z, level);
    if (i < 0) return null;
    const id = objectId(this.grid.object[i]);
    const spec = OBJECT_SPEC[id];
    return spec?.container ? { index: i, objectId: id } : null;
  }

  /**
   * Open a container, generating its contents the first time.
   * @returns {Container | null}
   */
  open(x, z, level) {
    const found = this.containerAt(x, z, level);
    if (!found) return null;

    let container = this.opened.get(found.index);
    if (!container) {
      container = this.placed.has(found.index)
        ? new Container(CAPACITY[found.objectId] ?? 12, OBJECT_SPEC[found.objectId]?.name ?? 'container')
        : this._generate(found.index, found.objectId, this.grid.room[found.index]);
      this.opened.set(found.index, container);
      this.stats.generated++;
      this.stats.items += container.items.length;
    }
    return container;
  }

  /**
   * Contents from (seed, cell, room purpose). Deterministic, so the same
   * cupboard holds the same thing however long you take to reach it.
   */
  _generate(cellIndex, objId, roomId) {
    const purpose = this.roomPurposes.get(roomId) ?? 'default';
    const rng = new Rng((this.seed ^ (cellIndex * 2654435761)) >>> 0);

    const capacity = CAPACITY[objId] ?? 12;
    const container = new Container(capacity, OBJECT_SPEC[objId]?.name ?? 'container');

    const table = TABLES[purpose]?.[objId] ?? TABLES.default[objId] ?? null;
    if (!table) return container;

    // An empty cupboard is a real and useful result — it is what makes finding
    // a full one worth something. Nothing guarantees a container has anything.
    const abundance = ABUNDANCE[purpose] ?? ABUNDANCE.default;
    if (!rng.chance(abundance)) return container;

    const draws = rng.int(1, 4);
    for (let d = 0; d < draws; d++) {
      const id = rng.pick(table);
      const def = ITEMS[id];
      const count = (def.stack ?? 1) > 1 ? rng.int(1, def.stack) : 1;
      const item = new Item(id, count);

      // Perishables have already been sitting there since the outbreak. This is
      // why a fridge is worth checking early and worthless later.
      if (def.perishable) item.age = rng.range(0, def.perishable * 0.55);

      container.add(item);
    }
    return container;
  }

  /** Note that a container at this cell was put there by the player. */
  markPlaced(x, z, level) {
    const i = this.grid.index(x, z, level);
    if (i >= 0) this.placed.add(i);
  }

  /** Mark a container as searched, so the UI can grey it out. */
  markSearched(x, z, level) {
    const i = this.grid.index(x, z, level);
    if (i >= 0) this.grid.state[i] |= 4; // STATE.SEARCHED
  }

  /** Age every opened container's contents. @param {number} gameHours */
  age(gameHours) {
    for (const container of this.opened.values()) container.age(gameHours);
  }
}

export { TABLES, CAPACITY, ABUNDANCE };
