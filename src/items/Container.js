/**
 * Containers and the player's inventory.
 *
 * One class for both, because a rucksack and a fridge differ only in capacity
 * and in who is carrying them. Making them the same type means transferring
 * items is a single operation rather than four combinations of special cases.
 *
 * Capacity is measured in **weight**, not slots. Slot counts make a tin of beans
 * and a fire axe interchangeable, which is exactly the decision the design wants
 * to force you to make.
 */
import { Item } from './ItemDb.js';

export class Container {
  /**
   * @param {number} capacity kilograms
   * @param {string} [name]
   */
  constructor(capacity, name = 'container') {
    this.capacity = capacity;
    this.name = name;
    /** @type {Item[]} */
    this.items = [];
  }

  get weight() {
    let total = 0;
    for (const item of this.items) total += item.weight;
    return total;
  }

  /** 0–1 and beyond; over 1 means overloaded, which callers may allow. */
  get load() {
    return this.capacity > 0 ? this.weight / this.capacity : 0;
  }

  get isEmpty() {
    return this.items.length === 0;
  }

  /** Would this fit without going over capacity? */
  canFit(item) {
    return this.weight + item.weight <= this.capacity + 1e-9;
  }

  /**
   * Put an item in, merging into an existing stack where possible.
   *
   * Stacks only merge when their *ages* match closely, so a fresh loaf and a
   * week-old one stay separate. Merging them would silently launder spoilage,
   * which is the one thing a perishable's age exists to prevent.
   *
   * @param {Item} item
   * @param {boolean} [force] ignore capacity
   * @returns {boolean} whether it went in
   */
  add(item, force = false) {
    if (!force && !this.canFit(item)) return false;

    if (item.stackable) {
      for (const existing of this.items) {
        if (existing.id !== item.id) continue;
        if (existing.count >= existing.maxStack) continue;
        if (Math.abs(existing.age - item.age) > 6) continue;

        const room = existing.maxStack - existing.count;
        const moved = Math.min(room, item.count);
        existing.count += moved;
        item.count -= moved;
        if (item.count <= 0) return true;
      }
    }

    this.items.push(item);
    return true;
  }

  /**
   * Take an item out.
   * @param {Item} item
   * @param {number} [count]
   * @returns {Item | null} what was removed
   */
  remove(item, count = item.count) {
    const index = this.items.indexOf(item);
    if (index < 0) return null;

    if (count >= item.count) {
      this.items.splice(index, 1);
      return item;
    }
    item.count -= count;
    return item.clone(count);
  }

  /** First item matching a predicate. */
  find(predicate) {
    return this.items.find(predicate) ?? null;
  }

  /** Total count of an item id across stacks. */
  countOf(id) {
    let n = 0;
    for (const item of this.items) if (item.id === id) n += item.count;
    return n;
  }

  /**
   * Move an item to another container.
   * @returns {boolean} whether it moved
   */
  transferTo(other, item, count = item.count) {
    const probe = item.clone(count);
    if (!other.canFit(probe)) return false;
    const taken = this.remove(item, count);
    if (!taken) return false;
    other.add(taken, true);
    return true;
  }

  /** Age every perishable. @param {number} gameHours */
  age(gameHours) {
    for (const item of this.items) item.age_(gameHours);
  }

  /** Throw away anything rotten. Returns how many were binned. */
  discardSpoiled() {
    const before = this.items.length;
    this.items = this.items.filter((i) => !i.spoiled);
    return before - this.items.length;
  }

  /** Items sorted for display: heaviest first, so the problem is at the top. */
  sorted() {
    return [...this.items].sort((a, b) => b.weight - a.weight);
  }
}

/**
 * The player's carried inventory.
 *
 * Encumbrance is deliberately not a hard wall. You *can* pick up more than you
 * should carry — you just move like it. A hard cap makes the player put things
 * back; a soft one makes them decide whether the trip is worth being slow for,
 * which is a far more interesting moment when there are things behind you.
 */
export class Inventory extends Container {
  constructor(capacity = 8) {
    super(capacity, 'inventory');
  }

  /** Speed multiplier from what you are carrying, 0.35–1. */
  get mobility() {
    const over = Math.max(0, this.load - 1);
    if (over <= 0) return 1;
    return Math.max(0.35, 1 - over * 0.55);
  }

  get overloaded() {
    return this.load > 1;
  }

  /** Overloading is allowed; the cost is paid in speed. */
  add(item, force = true) {
    return super.add(item, force);
  }
}
