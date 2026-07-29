/**
 * The item database.
 *
 * ## Weight is the whole design
 *
 * Every item's most important stat is what it weighs, because carrying capacity
 * is the only real constraint on looting. Without it, "search everything and
 * take it all" is always correct and a house full of containers is a chore
 * rather than a decision. With it, every tin of beans is measured against the
 * axe you would have to leave behind.
 *
 * ## Food is a clock, not a number
 *
 * Perishables carry a `perishable` age in in-game hours. Fresh food is better
 * than tinned food and stops being food; tinned food is worse and never does.
 * That is what makes a fridge worth checking on day one and worthless on day
 * ten, and it is why looting has a rhythm rather than being a single sweep.
 */

/** What an item is for. Drives which panel actions it offers. */
import { t } from '../ui/i18n.js';

export const KIND = {
  FOOD: 'food',
  DRINK: 'drink',
  MEDICAL: 'medical',
  WEAPON: 'weapon',
  TOOL: 'tool',
  MATERIAL: 'material',
  CLOTHING: 'clothing',
};

/**
 * @typedef {object} ItemDef
 * @property {string} id
 * @property {string} name
 * @property {string} kind
 * @property {number} weight        kilograms
 * @property {number} [nutrition]   hunger removed, 0–1
 * @property {number} [hydration]   thirst removed, 0–1
 * @property {number} [perishable]  in-game hours before it spoils; absent = never
 * @property {number} [heal]        health restored to one part
 * @property {number} [stopsBleeding] *fraction* of the bleed removed, 0–1.
 *   A fraction rather than a flat subtraction, so a dressing behaves the same way
 *   on a scratch and on a deep wound; a flat value silently fails on bad ones.
 * @property {string} [weaponId]    links to WEAPONS for equippable items
 * @property {number} [stack]       max per slot; absent = 1
 */

/** @type {Record<string, ItemDef>} */
export const ITEMS = {
  // --- fresh food: good, heavy-ish, and on a timer -----------------------
  bread: { id: 'bread', name: 'bread', kind: KIND.FOOD, weight: 0.4, nutrition: 0.22, perishable: 96 },
  cheese: { id: 'cheese', name: 'cheese', kind: KIND.FOOD, weight: 0.35, nutrition: 0.2, perishable: 120 },
  steak: { id: 'steak', name: 'steak', kind: KIND.FOOD, weight: 0.5, nutrition: 0.35, perishable: 40 },
  apple: { id: 'apple', name: 'apple', kind: KIND.FOOD, weight: 0.2, nutrition: 0.12, perishable: 200 },
  milk: { id: 'milk', name: 'milk', kind: KIND.DRINK, weight: 1.0, hydration: 0.35, nutrition: 0.06, perishable: 60 },

  // --- tinned: worse, but it will still be there next week ---------------
  beans: { id: 'beans', name: 'tinned beans', kind: KIND.FOOD, weight: 0.45, nutrition: 0.18 },
  soup: { id: 'soup', name: 'tinned soup', kind: KIND.FOOD, weight: 0.5, nutrition: 0.16, hydration: 0.08 },
  crisps: { id: 'crisps', name: 'crisps', kind: KIND.FOOD, weight: 0.1, nutrition: 0.07 },
  chocolate: { id: 'chocolate', name: 'chocolate bar', kind: KIND.FOOD, weight: 0.1, nutrition: 0.09 },

  water: { id: 'water', name: 'bottled water', kind: KIND.DRINK, weight: 1.0, hydration: 0.5 },
  soda: { id: 'soda', name: 'can of soda', kind: KIND.DRINK, weight: 0.35, hydration: 0.22, nutrition: 0.04 },

  // --- medical ------------------------------------------------------------
  bandage: { id: 'bandage', name: 'bandage', kind: KIND.MEDICAL, weight: 0.05, stopsBleeding: 0.75, stack: 5 },
  rag: { id: 'rag', name: 'ripped sheet', kind: KIND.MEDICAL, weight: 0.05, stopsBleeding: 0.45, stack: 5 },
  painkillers: { id: 'painkillers', name: 'painkillers', kind: KIND.MEDICAL, weight: 0.1, heal: 0, stack: 3 },
  firstaid: { id: 'firstaid', name: 'first aid kit', kind: KIND.MEDICAL, weight: 1.2, heal: 30, stopsBleeding: 1 },

  // --- weapons, as carryable items ---------------------------------------
  knife: { id: 'knife', name: 'kitchen knife', kind: KIND.WEAPON, weight: 0.3, weaponId: 'knife' },
  bat: { id: 'bat', name: 'baseball bat', kind: KIND.WEAPON, weight: 1.6, weaponId: 'bat' },
  axe: { id: 'axe', name: 'fire axe', kind: KIND.WEAPON, weight: 3.2, weaponId: 'axe' },
  crowbar: { id: 'crowbar', name: 'crowbar', kind: KIND.WEAPON, weight: 2.4, weaponId: 'crowbar' },

  // --- tools and materials ------------------------------------------------
  torch: { id: 'torch', name: 'torch', kind: KIND.TOOL, weight: 0.6 },
  hammer: { id: 'hammer', name: 'hammer', kind: KIND.TOOL, weight: 1.1, weaponId: 'crowbar' },
  nails: { id: 'nails', name: 'box of nails', kind: KIND.MATERIAL, weight: 0.4, stack: 4 },
  plank: { id: 'plank', name: 'wooden plank', kind: KIND.MATERIAL, weight: 1.8, stack: 3 },
  sheet: { id: 'sheet', name: 'bed sheet', kind: KIND.MATERIAL, weight: 0.3, stack: 3 },
  bag: { id: 'bag', name: 'duffel bag', kind: KIND.CLOTHING, weight: 1.0 },

  // --- M18 ------------------------------------------------------------
  petrol: { id: 'petrol', name: 'can of petrol', kind: KIND.MATERIAL, weight: 3.2, stack: 2 },
  /**
   * Twenty-five kilograms, against a ten kilogram bag. You cannot carry a
   * generator and anything else, which is the point: getting one home is a trip
   * you make on purpose, slowly, with nothing in your hands.
   */
  generator: { id: 'generator', name: 'generator', kind: KIND.MATERIAL, weight: 25 },
  /**
   * Raw meat is food you cannot eat yet. It is the only item in the game whose
   * nutrition is *negative* to eat as it is, which is what gives a campfire a
   * job beyond warmth.
   */
  rawmeat: {
    id: 'rawmeat', name: 'raw meat', kind: KIND.FOOD, weight: 0.5,
    nutrition: 0.08, perishable: 30, raw: true, cooksTo: 'steak',
  },
  potato: {
    id: 'potato', name: 'potato', kind: KIND.FOOD, weight: 0.25,
    nutrition: 0.06, perishable: 400, raw: true, cooksTo: 'bakedpotato',
  },
  bakedpotato: {
    id: 'bakedpotato', name: 'baked potato', kind: KIND.FOOD, weight: 0.22,
    nutrition: 0.2, perishable: 60,
  },
};

/**
 * One item in the world or in a bag.
 *
 * A class rather than a plain id because perishables need their own age, and a
 * stack needs its own count. Everything else reads from the shared definition.
 */
export class Item {
  /** @param {string} id @param {number} [count] */
  constructor(id, count = 1) {
    this.def = ITEMS[id];
    if (!this.def) throw new Error(`unknown item: ${id}`);
    this.id = id;
    this.count = count;
    /** In-game hours this has existed. Only meaningful for perishables. */
    this.age = 0;
  }

  get weight() {
    return this.def.weight * this.count;
  }

  get stackable() {
    return (this.def.stack ?? 1) > 1;
  }

  get maxStack() {
    return this.def.stack ?? 1;
  }

  /** Fresh → 0, spoiled → 1. Non-perishables are always 0. */
  get spoilage() {
    if (!this.def.perishable) return 0;
    return Math.min(1, this.age / this.def.perishable);
  }

  get spoiled() {
    return this.spoilage >= 1;
  }

  /** Nutrition now, after spoilage. Spoiled food is not food. */
  get nutrition() {
    if (this.spoiled) return 0;
    return (this.def.nutrition ?? 0) * (1 - this.spoilage * 0.4);
  }

  get hydration() {
    if (this.spoiled) return 0;
    return (this.def.hydration ?? 0) * (1 - this.spoilage * 0.4);
  }

  /** @param {number} gameHours */
  age_(gameHours) {
    if (this.def.perishable) this.age += gameHours;
  }

  /**
   * How the item should read in a list.
   *
   * The definition's English `name` is the fallback, so a missing translation
   * shows readable English rather than a lookup key — see `ui/i18n.js`.
   */
  label() {
    const name = t(`item.${this.id}`, this.def.name);
    const base = this.count > 1 ? `${name} ×${this.count}` : name;
    if (!this.def.perishable) return base;
    if (this.spoiled) return `${base} ${t('item.rottenSuffix', '(rotten)')}`;
    if (this.spoilage > 0.65) return `${base} ${t('item.staleSuffix', '(stale)')}`;
    return base;
  }

  clone(count = this.count) {
    const copy = new Item(this.id, count);
    copy.age = this.age;
    return copy;
  }
}

/** All item ids of a given kind, for loot tables and tests. */
export function itemsOfKind(kind) {
  return Object.values(ITEMS).filter((d) => d.kind === kind).map((d) => d.id);
}
