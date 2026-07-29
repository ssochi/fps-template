/**
 * Typed pub/sub.
 *
 * Systems never import one another. Combat emits `noise:made`; Sound listens.
 * That keeps the horde, the simulation and the renderer independently testable,
 * and it is the only reason a save system can observe everything without every
 * system knowing it exists.
 */
export class Events {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.handlers = new Map();
  }

  /** @returns {() => void} an unsubscribe function */
  on(type, fn) {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  emit(type, payload) {
    const set = this.handlers.get(type);
    if (!set) return;
    // Copy first: a handler that unsubscribes itself must not mutate the set
    // we are iterating.
    for (const fn of [...set]) fn(payload);
  }

  clear() {
    this.handlers.clear();
  }
}

/** The game-wide bus. */
export const events = new Events();
