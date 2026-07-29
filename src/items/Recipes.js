/**
 * Crafting.
 *
 * ## Recipes turn loot into a reason to have looted
 *
 * The point of a recipe is not the item it makes, it is that it gives a use to
 * something you already decided to carry. Every recipe here consumes materials
 * that M8's loot tables actually produce, so the bed sheets in a wardrobe and
 * the planks in a storage room stop being weight and start being a plan.
 *
 * ## Two kinds of output
 *
 * Some recipes produce **items** and some produce **work on the world** — a
 * barricade is not something you carry, it is something you do to a window.
 * Both live here because from the player's side they are the same action:
 * spend materials, get a result.
 */
import { Item } from './ItemDb.js';
import { OBJ } from '../world/Objects.js';

/** What a recipe produces. */
export const OUTPUT = {
  ITEM: 'item',
  /** Applied to a wall edge the player is facing. */
  BARRICADE: 'barricade',
  /**
   * Puts an object down on the tile in front of you.
   *
   * The third output kind, and the one that turns crafting from "make a thing
   * to carry" into "change this place". Everything M18 adds is one of these.
   */
  PLACE: 'place',
  /** Undo: take down whatever you are facing and get some of it back. */
  DISMANTLE: 'dismantle',
  /** Make a damaged barricade whole again. */
  REPAIR: 'repair',
};

/**
 * @typedef {object} Recipe
 * @property {string} id
 * @property {string} name
 * @property {Record<string, number>} materials item id → count consumed
 * @property {string} output one of OUTPUT
 * @property {string} [itemId]  for OUTPUT.ITEM
 * @property {number} [objectId] for OUTPUT.PLACE
 * @property {boolean} [needsFire] refused unless a lit fire is within reach
 * @property {boolean} [openEdge] barricades a gap rather than an opening
 * @property {number} [planks] planks nailed up per job, for OUTPUT.BARRICADE
 * @property {number} [count]
 * @property {number} [seconds] how long it takes, in real seconds
 * @property {number} [noise]   loudness while working
 * @property {string} description
 */

/** @type {Recipe[]} */
export const RECIPES = [
  {
    id: 'rip-sheet',
    name: 'Rip up a sheet',
    materials: { sheet: 1 },
    output: OUTPUT.ITEM,
    itemId: 'rag',
    count: 4,
    seconds: 2,
    noise: 1,
    description: 'Four dressings from one sheet. Quiet, and always available.',
  },
  {
    id: 'make-bandage',
    name: 'Boil rags into bandages',
    materials: { rag: 3 },
    output: OUTPUT.ITEM,
    itemId: 'bandage',
    count: 1,
    seconds: 6,
    noise: 2,
    description: 'Three rags make one proper bandage.',
  },
  {
    id: 'barricade',
    name: 'Barricade',
    materials: { plank: 1, nails: 1 },
    output: OUTPUT.BARRICADE,
    seconds: 3.5,
    // Hammering is loud, and it is loud *where you are about to hide*. That is
    // the whole tension of fortifying: the act of making a place safe is the
    // act of telling the street where you are.
    noise: 16,
    description: 'Nail a plank across the opening you are facing.',
  },
  {
    id: 'make-torch',
    name: 'Improvise a torch',
    materials: { plank: 1, rag: 1 },
    output: OUTPUT.ITEM,
    itemId: 'torch',
    count: 1,
    seconds: 4,
    noise: 1,
    description: 'Light, at the cost of being visible.',
  },
  {
    id: 'salvage-planks',
    name: 'Salvage planks',
    materials: { crowbar: 0 },
    output: OUTPUT.ITEM,
    itemId: 'plank',
    count: 2,
    seconds: 8,
    noise: 12,
    description: 'Prise planks off the furniture. Needs a crowbar in hand.',
  },
];

RECIPES.push(
  {
    /**
     * A wall built from planks.
     *
     * Deliberately the *barricade* mechanism applied to an open edge rather
     * than a new wall material. Everything a built wall needs already exists
     * for barricades: it blocks movement, it blocks sight, the mesher draws it,
     * the horde breaks it, and it saves. A new `WALL.PLANK` would have needed
     * all five written again, and would have shipped as indestructible — which
     * is the M6 mistake, a base as an off switch.
     */
    id: 'plank-wall',
    name: 'Board up an opening',
    materials: { plank: 3, nails: 1 },
    output: OUTPUT.BARRICADE,
    openEdge: true,
    // Three planks in, three planks of wall out. The barricade recipe adds one
    // per job because boarding a window is meant to be a decision you repeat;
    // a wall you are building from nothing is one job, and charging three
    // planks for one plank of wall would be a quiet swindle.
    planks: 3,
    seconds: 11,
    noise: 18,
    description: 'A wall of planks across a gap. Weaker than brick, and yours.',
  },
  {
    id: 'repair-barricade',
    name: 'Repair a barricade',
    materials: { nails: 1 },
    output: OUTPUT.REPAIR,
    seconds: 5,
    noise: 12,
    description: 'Makes a damaged barricade whole. Cheaper than rebuilding it.',
  },
  {
    id: 'dismantle',
    name: 'Take it down',
    materials: { hammer: 0 },
    output: OUTPUT.DISMANTLE,
    seconds: 6,
    noise: 9,
    description: 'Pull down what is in front of you and keep most of the wood.',
  },
  {
    id: 'cook-meat',
    name: 'Cook meat',
    materials: { rawmeat: 1 },
    output: OUTPUT.ITEM,
    itemId: 'steak',
    count: 1,
    seconds: 6,
    noise: 2,
    needsFire: true,
    description: 'Raw meat is barely food. Cooked, it is most of a day.',
  },
  {
    id: 'bake-potato',
    name: 'Bake a potato',
    materials: { potato: 1 },
    output: OUTPUT.ITEM,
    itemId: 'bakedpotato',
    count: 1,
    seconds: 5,
    noise: 2,
    needsFire: true,
    description: 'Three times the food, for the price of standing still.',
  },
  {
    id: 'boil-water',
    name: 'Boil water',
    materials: { rag: 0 },
    output: OUTPUT.ITEM,
    itemId: 'water',
    count: 1,
    seconds: 8,
    noise: 2,
    needsFire: true,
    needsWater: true,
    description: 'Fills a bottle from a barrel and boils it. Needs both.',
  },
  {
    id: 'rain-barrel',
    name: 'Build a rain barrel',
    materials: { plank: 4, nails: 1 },
    output: OUTPUT.PLACE,
    objectId: OBJ.RAIN_BARREL,
    seconds: 9,
    noise: 14,
    description: 'Fills when it rains. The only water that does not run out.',
  },
  {
    id: 'campfire',
    name: 'Lay a campfire',
    materials: { plank: 2 },
    output: OUTPUT.PLACE,
    objectId: OBJ.CAMPFIRE,
    seconds: 5,
    noise: 4,
    description: 'Warmth, light and the only way to cook. Feed it planks.',
  },
  {
    id: 'place-crate',
    name: 'Build a crate',
    materials: { plank: 3, nails: 1 },
    output: OUTPUT.PLACE,
    objectId: OBJ.CRATE,
    seconds: 8,
    noise: 13,
    description: 'Somewhere to put things down. A base with no storage is a rucksack.',
  },
  {
    id: 'place-table',
    name: 'Build a table',
    materials: { plank: 2, nails: 1 },
    output: OUTPUT.PLACE,
    objectId: OBJ.TABLE,
    seconds: 6,
    noise: 11,
    description: 'Blocks a doorway badly and holds a lamp well.',
  },
  {
    id: 'place-bed',
    name: 'Build a bunk',
    materials: { plank: 4, sheet: 1 },
    output: OUTPUT.PLACE,
    objectId: OBJ.BED,
    seconds: 10,
    noise: 12,
    description: 'Somewhere to sleep that is not the floor of a stranger.',
  },
  {
    id: 'place-generator',
    name: 'Set down a generator',
    materials: { generator: 1 },
    output: OUTPUT.PLACE,
    objectId: OBJ.GENERATOR,
    seconds: 8,
    noise: 10,
    description: 'The lights come back on. So does every head in the street.',
  },
);

export const RECIPE_BY_ID = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

/** Health each plank contributes to a barricade, and the cap. */
export const BARRICADE = { hpPerPlank: 60, maxPlanks: 4 };

/**
 * Can this be made right now?
 *
 * A material with a count of 0 means "must be held, not consumed" — that is how
 * the crowbar gates plank salvaging without being eaten by it.
 *
 * @param {Recipe} recipe
 * @param {import('./Container.js').Container} inventory
 * @param {{ weaponId?: string }} [held]
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function canCraft(recipe, inventory, held = {}) {
  const missing = [];
  for (const [id, count] of Object.entries(recipe.materials)) {
    if (count === 0) {
      // A tool, not a material.
      if (held.weaponId !== id && inventory.countOf(id) === 0) missing.push(id);
      continue;
    }
    if (inventory.countOf(id) < count) missing.push(id);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Consume the materials. Call only after `canCraft` passes.
 * @returns {boolean}
 */
export function consumeMaterials(recipe, inventory) {
  for (const [id, count] of Object.entries(recipe.materials)) {
    if (count === 0) continue;
    let remaining = count;
    while (remaining > 0) {
      const stack = inventory.find((i) => i.id === id);
      if (!stack) return false;
      const take = Math.min(remaining, stack.count);
      inventory.remove(stack, take);
      remaining -= take;
    }
  }
  return true;
}

/** @returns {Item | null} the crafted item, for OUTPUT.ITEM recipes */
export function produce(recipe) {
  if (recipe.output !== OUTPUT.ITEM) return null;
  return new Item(recipe.itemId, recipe.count ?? 1);
}
