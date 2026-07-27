import { Rng, randomSeed } from '../core/Rng';
import {
  ATTACHMENT_TRAITS,
  BODY_TRAITS,
  MOTION_TRAITS,
  PALETTE_TRAITS,
  cloneGenome,
  clampTraits,
  type Attachment,
  type Genome,
  type TraitTable,
} from './Genome';
import { allParts, countOfKind, getPart, type PartDefinition } from '../build/PartRegistry';
import { drawTrait, pickArchetype, type Span } from './Archetypes';

/**
 * Variation operators.
 *
 * All three of these are generic over the trait tables rather than written per
 * field, which is what makes the system extensible in practice rather than in
 * principle: a part that declares a new trait is immediately mutable, heritable
 * and adjustable, and nothing in this file learns its name.
 *
 * The interesting design question is not how to perturb a number, it is how
 * hard to perturb it. Mutation that is too timid produces a wall of creatures
 * nobody can tell apart; too violent and every child is unrelated to its
 * parent, which is the same as randomising. So `amount` scales a per-trait
 * volatility, and structural changes — gaining and losing whole parts — happen
 * on a separate, much rarer roll, because those are the changes people notice.
 */

function mutateTraits(
  values: Record<string, number>,
  table: TraitTable,
  amount: number,
  rng: Rng,
): void {
  for (const [key, spec] of Object.entries(table)) {
    const volatility = spec.volatility ?? 0.18;
    // Not every trait moves every time; a genome where everything shifts at
    // once reads as a different animal rather than a variation on one.
    if (!rng.chance(0.55)) continue;
    const span = spec.max - spec.min;
    const current = values[key] ?? (spec.min + spec.max) / 2;
    values[key] = current + rng.normal() * span * volatility * amount;
  }
  clampTraits(values, table);
}

function randomTraitsFor(def: PartDefinition, rng: Rng): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, spec] of Object.entries(def.traits)) {
    const v = rng.range(spec.min, spec.max);
    out[key] = spec.integer ? Math.round(v) : v;
  }
  return out;
}

function makeAttachment(def: PartDefinition, rng: Rng): Attachment {
  const placement = def.defaultPlacement(rng);
  return { kind: def.kind, ...placement, traits: randomTraitsFor(def, rng) };
}

/** Parts that still have room on this creature. */
function addableParts(genome: Genome): PartDefinition[] {
  return allParts().filter((def) => countOfKind(genome, def.kind) < def.maxCount);
}

/**
 * A brand new creature.
 *
 * Drawn through a body plan rather than uniformly. Independent uniform draws
 * over every trait do not give variety, they give the middle of the space over
 * and over: the shapes worth seeing need several traits at their extremes *at
 * the same time*, and those corners are never reached by chance. `Archetypes`
 * explains the reasoning; the result is still an ordinary genome that mutation
 * and breeding can take anywhere.
 */
export function randomGenome(seed = randomSeed()): Genome {
  const rng = new Rng(seed);
  const plan = pickArchetype(rng);
  const genome: Genome = {
    seed,
    body: {} as Genome['body'],
    palette: {} as Genome['palette'],
    motion: {} as Genome['motion'],
    attachments: [],
  };

  const fill = (table: TraitTable, spans: Record<string, Span> | undefined): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const key of Object.keys(table)) out[key] = drawTrait(key, table, spans, rng);
    return out;
  };
  Object.assign(genome.body, fill(BODY_TRAITS, plan.body));
  Object.assign(genome.palette, fill(PALETTE_TRAITS, plan.palette));
  Object.assign(genome.motion, fill(MOTION_TRAITS, plan.motion));

  // Legs first: they come in mirrored pairs spread evenly along the plan's
  // span. Placing them by an even sweep rather than at random is what keeps
  // the creature on a stable base — random placement puts three of four legs
  // at one end and the animal pivots on its nose.
  const leg = getPart('leg');
  const pairs = rng.pick(plan.legPairs);
  if (leg && pairs > 0) {
    const sprawl = plan.legSprawl ?? [0, 0.5];
    for (let i = 0; i < pairs; i++) {
      const t = pairs === 1 ? (plan.legSpan[0] + plan.legSpan[1]) / 2
        : plan.legSpan[0] + (i / (pairs - 1)) * (plan.legSpan[1] - plan.legSpan[0]);
      const a = makeAttachment(leg, rng);
      a.at = clamp01(t + rng.range(-0.025, 0.025));
      a.symmetry = 'pair';
      // Sprawl: 0 is directly underneath, higher swings the hips outboard.
      a.around = rng.range(sprawl[0], sprawl[1]) * 1.15 * (rng.chance(0.5) ? 1 : -1);
      // Front and rear knees fold opposite ways on anything quadrupedal.
      a.traits.kneeBack = t > 0.5 ? 0 : 1;
      genome.attachments.push(a);
    }
  }

  for (const kind of plan.required) {
    const def = getPart(kind);
    if (def && countOfKind(genome, kind) < def.maxCount) {
      genome.attachments.push(makeAttachment(def, rng));
    }
  }

  const extras = rng.int(Math.round(plan.extraCount[0]), Math.round(plan.extraCount[1]));
  for (let i = 0; i < extras; i++) {
    const candidates = plan.extras
      .map((kind) => getPart(kind))
      .filter((def): def is PartDefinition => !!def && countOfKind(genome, def.kind) < def.maxCount);
    if (candidates.length === 0) break;
    genome.attachments.push(makeAttachment(rng.weighted(candidates, (d) => d.weight), rng));
  }

  return genome;
}

const clamp01 = (v: number): number => (v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v);

export interface MutateOptions {
  /** 0 nudges, 1 is a strong mutation, above that is a different animal. */
  amount: number;
  /** Allow parts to be gained and lost, not just retuned. */
  structural: boolean;
  /** Re-roll the build seed, changing the stochastic detail too. */
  reseed: boolean;
}

export function mutate(source: Genome, options: MutateOptions, rng = new Rng(randomSeed())): Genome {
  const genome = cloneGenome(source);
  const amount = Math.max(0, options.amount);

  mutateTraits(genome.body as unknown as Record<string, number>, BODY_TRAITS, amount, rng);
  mutateTraits(genome.palette as unknown as Record<string, number>, PALETTE_TRAITS, amount, rng);
  mutateTraits(genome.motion as unknown as Record<string, number>, MOTION_TRAITS, amount, rng);

  for (const attachment of genome.attachments) {
    const def = getPart(attachment.kind);
    mutateTraits(attachment as unknown as Record<string, number>, ATTACHMENT_TRAITS, amount, rng);
    if (def) mutateTraits(attachment.traits, def.traits, amount, rng);
  }

  if (options.structural) {
    // Lose a part. The head is exempt: a creature without one stops reading as
    // a creature, and the operator that produces it is not interesting enough
    // to be worth the ones it ruins.
    if (rng.chance(0.28 * amount) && genome.attachments.length > 2) {
      const candidates = genome.attachments
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.kind !== 'head');
      if (candidates.length > 0) {
        genome.attachments.splice(rng.pick(candidates).i, 1);
      }
    }
    // Gain one.
    if (rng.chance(0.35 * amount)) {
      const candidates = addableParts(genome);
      if (candidates.length > 0) {
        genome.attachments.push(makeAttachment(rng.weighted(candidates, (d) => d.weight), rng));
      }
    }
    // Duplicate one, which is how symmetry and repetition arise — most real
    // variation is a segment repeated, not a novel organ.
    if (rng.chance(0.22 * amount) && genome.attachments.length > 0) {
      const source_ = rng.pick(genome.attachments);
      const def = getPart(source_.kind);
      if (def && countOfKind(genome, source_.kind) < def.maxCount) {
        const copy: Attachment = { ...source_, traits: { ...source_.traits } };
        copy.at = Math.min(0.98, Math.max(0.02, copy.at + rng.range(-0.2, 0.2)));
        genome.attachments.push(copy);
      }
    }
  }

  if (options.reseed) genome.seed = randomSeed();
  return genome;
}

/**
 * Crossover.
 *
 * Numeric traits blend, because a child between a long parent and a short one
 * should be middling. Attachments do not blend — you cannot have half a wing —
 * so they are inherited whole, matched up by kind and position so that "the
 * front legs" of one parent are crossed against "the front legs" of the other
 * rather than against its horns.
 */
export function breed(a: Genome, b: Genome, rng = new Rng(randomSeed())): Genome {
  const mix = (x: number, y: number): number => {
    // Slightly beyond the parents at the edges, so a line does not converge on
    // the average of its founders and stay there forever.
    const t = rng.range(-0.15, 1.15);
    return x + (y - x) * t;
  };

  const child = cloneGenome(a);
  child.seed = rng.chance(0.5) ? a.seed : b.seed;

  for (const key of Object.keys(BODY_TRAITS)) {
    const values = child.body as unknown as Record<string, number>;
    values[key] = mix(
      (a.body as unknown as Record<string, number>)[key],
      (b.body as unknown as Record<string, number>)[key],
    );
  }
  clampTraits(child.body as unknown as Record<string, number>, BODY_TRAITS);

  for (const key of Object.keys(PALETTE_TRAITS)) {
    const values = child.palette as unknown as Record<string, number>;
    values[key] = mix(
      (a.palette as unknown as Record<string, number>)[key],
      (b.palette as unknown as Record<string, number>)[key],
    );
  }
  clampTraits(child.palette as unknown as Record<string, number>, PALETTE_TRAITS);

  for (const key of Object.keys(MOTION_TRAITS)) {
    const values = child.motion as unknown as Record<string, number>;
    values[key] = mix(
      (a.motion as unknown as Record<string, number>)[key],
      (b.motion as unknown as Record<string, number>)[key],
    );
  }
  clampTraits(child.motion as unknown as Record<string, number>, MOTION_TRAITS);

  // Pair attachments up: same kind, nearest position. Anything unmatched is
  // inherited on a coin flip, which is where a child gains one parent's horns
  // without the other's.
  const remaining = b.attachments.map((x) => ({ ...x, traits: { ...x.traits } }));
  const result: Attachment[] = [];

  for (const mine of a.attachments) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].kind !== mine.kind) continue;
      const d = Math.abs(remaining[i].at - mine.at);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      const theirs = remaining.splice(bestIndex, 1)[0];
      const merged: Attachment = {
        kind: mine.kind,
        at: mix(mine.at, theirs.at),
        symmetry: rng.chance(0.5) ? mine.symmetry : theirs.symmetry,
        around: mix(mine.around, theirs.around),
        scale: mix(mine.scale, theirs.scale),
        traits: {},
      };
      const def = getPart(mine.kind);
      const keys = def ? Object.keys(def.traits) : Object.keys(mine.traits);
      for (const key of keys) {
        const x = mine.traits[key];
        const y = theirs.traits[key];
        merged.traits[key] =
          typeof x === 'number' && typeof y === 'number' ? mix(x, y) : (x ?? y ?? 0);
      }
      if (def) clampTraits(merged.traits, def.traits);
      clampTraits(merged as unknown as Record<string, number>, ATTACHMENT_TRAITS);
      result.push(merged);
    } else if (rng.chance(0.62)) {
      result.push({ ...mine, traits: { ...mine.traits } });
    }
  }
  for (const theirs of remaining) {
    if (rng.chance(0.62)) result.push(theirs);
  }

  // Guarantee a head, whichever way the coins fell.
  if (!result.some((x) => x.kind === 'head')) {
    const parentHead = a.attachments.find((x) => x.kind === 'head') ?? b.attachments.find((x) => x.kind === 'head');
    if (parentHead) result.push({ ...parentHead, traits: { ...parentHead.traits } });
  }

  child.attachments = result;
  return child;
}
