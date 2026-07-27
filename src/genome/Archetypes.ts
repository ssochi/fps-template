import type { Rng } from '../core/Rng';
import type { TraitTable } from './Genome';

/**
 * Body plans.
 *
 * Without these the randomiser draws every trait uniformly and independently,
 * and the result is not diverse — it is uniformly average. Nearly every creature
 * came out a medium tube on four medium legs, because that is what the middle of
 * every range is, and the genuinely different shapes sat in corners of the space
 * that independent uniform draws essentially never visit together. You need
 * *long body* **and** *many segments* **and** *no legs* **and** *high spine flex*
 * to get a snake, and the odds of drawing all four at once are negligible.
 *
 * An archetype is a prior, not a new representation: it narrows the ranges the
 * randomiser draws from and says how many legs go where. Everything it produces
 * is an ordinary genome that mutation, breeding and the sliders can take
 * anywhere. Nothing downstream knows archetypes exist — a bred creature has no
 * archetype at all, only the genes it inherited.
 *
 * Ranges are given as fractions of each trait's declared range rather than as
 * absolute numbers, so retuning a trait's bounds does not silently invalidate
 * every archetype that mentioned it.
 */

export type Span = [number, number];

export interface Archetype {
  id: string;
  label: string;
  weight: number;
  /** Sub-ranges of BODY_TRAITS, as fractions 0..1 of each declared range. */
  body?: Record<string, Span>;
  /** Sub-ranges of MOTION_TRAITS. */
  motion?: Record<string, Span>;
  /** Sub-ranges of PALETTE_TRAITS. */
  palette?: Record<string, Span>;
  /** How many mirrored leg pairs, chosen uniformly from this list. */
  legPairs: number[];
  /** Where the first and last leg pairs sit along the spine. */
  legSpan: Span;
  /** How far out to the side the legs are set, as a fraction of that trait. */
  legSprawl?: Span;
  /** Parts every member of this plan has. */
  required: string[];
  /** Pool the optional extras are drawn from. */
  extras: string[];
  extraCount: Span;
}

export const ARCHETYPES: Archetype[] = [
  {
    id: 'quadruped',
    label: 'Quadruped',
    weight: 5,
    body: {
      length: [0.25, 0.6],
      girth: [0.3, 0.7],
      segments: [0.3, 0.7],
      stance: [0.35, 0.8],
      // Hide or scales, rarely plates.
      reliefKind: [0.6, 1],
      relief: [0, 0.5],
    },
    legPairs: [2],
    legSpan: [0.2, 0.78],
    legSprawl: [0, 0.35],
    required: ['head', 'tail'],
    extras: ['horn', 'fin', 'plate', 'antenna', 'frill', 'shell'],
    extraCount: [0, 2],
  },
  {
    id: 'insectoid',
    label: 'Insectoid',
    weight: 4,
    body: {
      length: [0.3, 0.6],
      girth: [0.15, 0.45],
      segments: [0.6, 1],
      // Low and wide, and the legs sprawl rather than stand under it.
      stance: [0.15, 0.45],
      flatten: [0.55, 1],
      // Segmented, always and strongly: it is what makes an insect an insect.
      reliefKind: [0.33, 0.34],
      relief: [0.55, 1],
      reliefScale: [0.4, 0.9],
    },
    motion: { speed: [0.4, 0.9], spineFlex: [0, 0.3] },
    legPairs: [3, 3, 4],
    legSpan: [0.14, 0.8],
    legSprawl: [0.55, 1],
    required: ['head', 'antenna'],
    extras: ['plate', 'horn', 'fin', 'wing', 'tail', 'pincer', 'shell'],
    extraCount: [1, 3],
  },
  {
    id: 'serpent',
    label: 'Serpent',
    weight: 3,
    body: {
      length: [0.7, 1],
      girth: [0, 0.25],
      segments: [0.75, 1],
      stance: [0, 0.2],
      belly: [0.1, 0.5],
      flatten: [0.3, 0.7],
      // Scutes down the back, the way a snake's dorsal scales read.
      reliefKind: [0.66, 1],
      relief: [0.3, 0.8],
      reliefScale: [0.5, 1],
    },
    // Legless things live or die on the spine wave; it *is* their locomotion.
    motion: { spineFlex: [0.7, 1], speed: [0.2, 0.6], stride: [0.5, 1] },
    legPairs: [0, 0, 1],
    legSpan: [0.2, 0.3],
    required: ['head'],
    extras: ['fin', 'horn', 'plate', 'frill'],
    extraCount: [0, 2],
  },
  {
    id: 'arachnid',
    label: 'Arachnid',
    weight: 3,
    body: {
      length: [0, 0.3],
      girth: [0.55, 1],
      segments: [0, 0.35],
      // Long legs under a compact round body.
      stance: [0.6, 1],
      belly: [0.55, 1],
      relief: [0, 0.35],
    },
    motion: { spineFlex: [0, 0.2], speed: [0.3, 0.8] },
    legPairs: [4, 4, 3],
    legSpan: [0.2, 0.8],
    legSprawl: [0.6, 1],
    required: ['head'],
    extras: ['eyestalk', 'horn', 'plate', 'antenna', 'pincer'],
    extraCount: [1, 2],
  },
  {
    id: 'biped',
    label: 'Biped',
    weight: 3,
    body: {
      length: [0.1, 0.4],
      girth: [0.35, 0.75],
      segments: [0.25, 0.6],
      stance: [0.5, 1],
      // Held upright rather than slung between the shoulders.
      arch: [0.55, 1],
      relief: [0, 0.45],
    },
    motion: { bounce: [0.4, 1], speed: [0.3, 0.8] },
    legPairs: [1],
    legSpan: [0.28, 0.28],
    legSprawl: [0, 0.3],
    required: ['head', 'tail'],
    extras: ['horn', 'fin', 'wing', 'plate', 'frill', 'pincer'],
    extraCount: [1, 3],
  },
  {
    id: 'flier',
    label: 'Flier',
    weight: 2,
    body: { length: [0.15, 0.5], girth: [0.2, 0.55], segments: [0.3, 0.7], stance: [0.3, 0.7] },
    motion: { speed: [0.5, 1], bounce: [0.3, 0.8] },
    legPairs: [1, 2],
    legSpan: [0.22, 0.6],
    required: ['head', 'wing', 'tail'],
    extras: ['horn', 'fin', 'antenna'],
    extraCount: [0, 2],
  },
  {
    id: 'blob',
    label: 'Blob',
    weight: 2,
    body: {
      length: [0, 0.25],
      girth: [0.7, 1],
      segments: [0, 0.3],
      belly: [0.7, 1],
      stance: [0.15, 0.5],
      taperHead: [0.6, 1],
      taperTail: [0.6, 1],
      // Smooth. A blob with ridges stops being a blob.
      relief: [0, 0.15],
    },
    motion: { speed: [0.1, 0.45], bounce: [0.5, 1], wander: [0.4, 1] },
    palette: { saturation: [0.5, 1] },
    legPairs: [1, 2],
    legSpan: [0.3, 0.7],
    required: ['head'],
    extras: ['eyestalk', 'antenna', 'horn', 'tail', 'fin', 'shell'],
    extraCount: [1, 3],
  },
];

/** Draws a trait, honouring an archetype's sub-range if it names one. */
export function drawTrait(
  key: string,
  table: TraitTable,
  spans: Record<string, Span> | undefined,
  rng: Rng,
): number {
  const spec = table[key];
  const span = spans?.[key];
  const lo = span ? spec.min + (spec.max - spec.min) * span[0] : spec.min;
  const hi = span ? spec.min + (spec.max - spec.min) * span[1] : spec.max;
  const v = rng.range(lo, hi);
  return spec.integer ? Math.round(v) : v;
}

export function pickArchetype(rng: Rng): Archetype {
  return rng.weighted(ARCHETYPES, (a) => a.weight);
}
