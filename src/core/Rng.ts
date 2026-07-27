/**
 * Seeded pseudo-random numbers.
 *
 * The whole generator rests on this. A genome is only a genome if it names the
 * *same* creature every time it is built — otherwise mutation is meaningless
 * (you could not tell your change from the noise), breeding is meaningless, and
 * a saved creature is not saved at all. `Math.random` gives none of that, so
 * every stochastic decision in the build goes through one of these instead, fed
 * from the genome's own seed.
 *
 * mulberry32: 32-bit state, passes gjrand's basic suite, and is about as short
 * as a usable generator gets.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Zero is a fixed point for the mixing function, so shift it off.
    this.state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1 - 1e-9));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  /**
   * Weighted pick. Weights need not sum to one; non-positive weights never win.
   */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    let total = 0;
    for (const item of items) total += Math.max(0, weight(item));
    if (total <= 0) return items[0];
    let roll = this.next() * total;
    for (const item of items) {
      roll -= Math.max(0, weight(item));
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }

  /**
   * Approximately normal, mean 0, standard deviation 1.
   *
   * Sum of four uniforms rather than Box-Muller: it has bounded support, which
   * matters here because an unbounded tail on a mutation occasionally produces
   * a limb four metres long and a creature that reads as a bug rather than as a
   * variant.
   */
  normal(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }

  /** A new independent stream, so one subsystem cannot desync another. */
  fork(salt: number): Rng {
    return new Rng(Math.imul(this.state ^ salt, 0x85ebca6b) | 0);
  }
}

/** A seed from the clock, for "give me something new". */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) | 0;
}

/**
 * Seed to a short human-readable code and back, so a creature can be named,
 * written down and typed into another browser.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function seedToCode(seed: number): string {
  let value = seed >>> 0;
  let out = '';
  for (let i = 0; i < 7; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

export function codeToSeed(code: string): number | null {
  const clean = code.trim().toUpperCase();
  if (!clean) return null;
  let value = 0;
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) return null;
    value = value * 32 + index;
  }
  return value | 0;
}
