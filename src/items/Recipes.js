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

/** What a recipe produces. */
export const OUTPUT = {
  ITEM: 'item',
  /** Applied to a wall edge the player is facing. */
  BARRICADE: 'barricade',
};

/**
 * @typedef {object} Recipe
 * @property {string} id
 * @property {string} name
 * @property {Record<string, number>} materials item id → count consumed
 * @property {string} output one of OUTPUT
 * @property {string} [itemId]  for OUTPUT.ITEM
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
