/**
 * The genome: a plain, serialisable description of one creature.
 *
 * Three requirements shaped this, and they pull against each other:
 *
 * - **Mutable.** Every heritable quantity is a bounded number with a declared
 *   range, so mutation is one generic operator over a trait table rather than a
 *   hand-written rule per field. Add a trait to the table and it mutates,
 *   breeds and gets a slider for free.
 * - **Composable.** Body parts are *attachments*, not slots. A creature does
 *   not have "a head field and a legs field"; it has a list of things bolted to
 *   its spine at a position, an angle and a scale. Two genomes can therefore be
 *   crossed by interleaving their attachment lists, and a part can appear
 *   anywhere a part could go.
 * - **Extensible.** An attachment names its part by a registry key. Adding a
 *   new kind of limb means registering a builder and a trait schema in one
 *   file; nothing here changes.
 *
 * The seed is part of the genome because the builders make stochastic choices
 * (scale jitter, plate placement). Without it stored, the "same" genome would
 * grow a slightly different creature each build and mutation would be
 * indistinguishable from noise.
 */

export interface TraitSpec {
  min: number;
  max: number;
  label: string;
  /** Mutation step as a fraction of the range. Defaults to 0.18. */
  volatility?: number;
  /** Snap to whole numbers. */
  integer?: boolean;
}

export type TraitTable = Record<string, TraitSpec>;

// ------------------------------------------------------------------ the body

export interface BodyGene {
  /** Spine joints. More segments bend more smoothly and cost more. */
  segments: number;
  length: number;
  /** Body radius as a fraction of body length, not an absolute. */
  girth: number;
  /** Radius multiplier at the head end of the spine. */
  taperHead: number;
  /** Radius multiplier at the tail end. */
  taperTail: number;
  /** Extra radius through the middle — a belly, or a wasp waist below 1. */
  belly: number;
  /** Upward arc of the spine at rest. Negative sags. */
  arch: number;
  /** Cross-section aspect. Above 1 is wide and flat, below is deep and narrow. */
  flatten: number;
  /** Leg length as a fraction of body length. Sets how tall it stands. */
  stance: number;
}

export const BODY_TRAITS: TraitTable = {
  segments: { min: 4, max: 14, label: 'Spine segments', integer: true, volatility: 0.14 },
  length: { min: 0.9, max: 4.2, label: 'Body length' },
  // A ratio, because girth and length as independent absolutes leave the two
  // ends of the range as a noodle and a beachball, and nothing in between is
  // any more likely than either.
  girth: { min: 0.085, max: 0.3, label: 'Girth' },
  taperHead: { min: 0.3, max: 1.15, label: 'Front taper' },
  taperTail: { min: 0.2, max: 1.1, label: 'Rear taper' },
  belly: { min: 0.7, max: 1.6, label: 'Belly' },
  arch: { min: -0.25, max: 0.5, label: 'Spine arch' },
  flatten: { min: 0.72, max: 1.45, label: 'Cross-section' },
  stance: { min: 0.12, max: 0.52, label: 'Leg length' },
};

// ------------------------------------------------------------------- colour

export interface PaletteGene {
  hue: number;
  saturation: number;
  lightness: number;
  /** Hue rotation for the belly and accents, in turns. */
  accentShift: number;
  /** Stripes or spots along the body. */
  bandCount: number;
  bandStrength: number;
  /** Strength of the wrap-around rim term in the toon shader. */
  rim: number;
  /** Where the cel ramp's terminator sits. */
  shadeBias: number;
}

export const PALETTE_TRAITS: TraitTable = {
  hue: { min: 0, max: 1, label: 'Hue', volatility: 0.25 },
  saturation: { min: 0.12, max: 0.95, label: 'Saturation' },
  lightness: { min: 0.28, max: 0.78, label: 'Lightness' },
  accentShift: { min: -0.35, max: 0.35, label: 'Accent shift' },
  bandCount: { min: 0, max: 14, label: 'Bands', integer: true },
  bandStrength: { min: 0, max: 0.85, label: 'Band strength' },
  rim: { min: 0, max: 1.1, label: 'Rim light' },
  shadeBias: { min: -0.3, max: 0.4, label: 'Shade bias' },
};

// ------------------------------------------------------------------ movement

export interface MotionGene {
  /** Cruise speed in metres per second. */
  speed: number;
  /** How high a foot lifts, relative to leg length. */
  stepHeight: number;
  /** Stride length, relative to leg length. */
  stride: number;
  /** Vertical bob of the body per step. */
  bounce: number;
  /** How much the spine snakes side to side as it walks. */
  spineFlex: number;
  /** How far the head leads a turn. */
  headLead: number;
  /** Lag of the tail behind the body. Lower is floppier. */
  tailStiffness: number;
  /** Breaths per second. */
  breathRate: number;
  /** Restlessness: how often it changes direction. */
  wander: number;
}

export const MOTION_TRAITS: TraitTable = {
  speed: { min: 0.35, max: 3.4, label: 'Speed' },
  stepHeight: { min: 0.08, max: 0.55, label: 'Step height' },
  stride: { min: 0.35, max: 1.25, label: 'Stride' },
  bounce: { min: 0, max: 0.28, label: 'Body bounce' },
  spineFlex: { min: 0, max: 0.75, label: 'Spine flex' },
  headLead: { min: 0, max: 1, label: 'Head lead' },
  tailStiffness: { min: 3, max: 34, label: 'Tail stiffness' },
  breathRate: { min: 0.15, max: 1.1, label: 'Breath rate' },
  wander: { min: 0.05, max: 1, label: 'Restlessness' },
};

// -------------------------------------------------------------- attachments

/**
 * One part bolted to the body.
 *
 * `at` is the only placement value that is not free: it is a position along the
 * spine in 0..1, and the builder resolves it to a real segment, so a genome
 * stays valid when a mutation changes the segment count under it.
 */
export interface Attachment {
  /** Registry key of the part kind. */
  kind: string;
  /** Position along the spine: 0 at the tail tip, 1 at the nose. */
  at: number;
  /** `pair` mirrors across the centreline; `single` sits on it. */
  symmetry: 'pair' | 'single';
  /** Angle around the body axis, radians. 0 is straight out to the side. */
  around: number;
  scale: number;
  /** Part-specific traits, keyed against the part definition's schema. */
  traits: Record<string, number>;
}

export const ATTACHMENT_TRAITS: TraitTable = {
  at: { min: 0.02, max: 0.98, label: 'Position' },
  around: { min: -1.5, max: 1.5, label: 'Angle' },
  scale: { min: 0.4, max: 1.9, label: 'Scale' },
};

// ---------------------------------------------------------------- the genome

export interface Genome {
  /** Feeds every stochastic choice in the build. Part of the identity. */
  seed: number;
  body: BodyGene;
  palette: PaletteGene;
  motion: MotionGene;
  attachments: Attachment[];
}

/** Deep copy. Genomes are plain data, so this is the whole of it. */
export function cloneGenome(genome: Genome): Genome {
  return {
    seed: genome.seed,
    body: { ...genome.body },
    palette: { ...genome.palette },
    motion: { ...genome.motion },
    attachments: genome.attachments.map((a) => ({ ...a, traits: { ...a.traits } })),
  };
}

/** Clamps every trait back into its declared range. */
export function clampTraits(values: Record<string, number>, table: TraitTable): void {
  for (const key of Object.keys(table)) {
    const spec = table[key];
    let v = values[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) v = (spec.min + spec.max) / 2;
    v = Math.min(spec.max, Math.max(spec.min, v));
    values[key] = spec.integer ? Math.round(v) : v;
  }
}

export function serialise(genome: Genome): string {
  return JSON.stringify(genome);
}

/**
 * Parses a genome and repairs it rather than trusting it.
 *
 * Genomes travel through URLs, clipboards and localStorage written by older
 * builds, so anything here may be missing, out of range or the wrong type. A
 * malformed one should still produce *a* creature.
 */
export function deserialise(text: string, fallback: Genome): Genome {
  try {
    const raw = JSON.parse(text) as Partial<Genome>;
    const genome: Genome = {
      seed: typeof raw.seed === 'number' ? raw.seed | 0 : fallback.seed,
      body: { ...fallback.body, ...(raw.body ?? {}) },
      palette: { ...fallback.palette, ...(raw.palette ?? {}) },
      motion: { ...fallback.motion, ...(raw.motion ?? {}) },
      attachments: Array.isArray(raw.attachments)
        ? raw.attachments
            .filter((a): a is Attachment => !!a && typeof a.kind === 'string')
            .map((a) => ({
              kind: a.kind,
              at: typeof a.at === 'number' ? a.at : 0.5,
              symmetry: a.symmetry === 'single' ? 'single' : 'pair',
              around: typeof a.around === 'number' ? a.around : 0,
              scale: typeof a.scale === 'number' ? a.scale : 1,
              traits: { ...(a.traits ?? {}) },
            }))
        : fallback.attachments.map((a) => ({ ...a, traits: { ...a.traits } })),
    };
    clampTraits(genome.body as unknown as Record<string, number>, BODY_TRAITS);
    clampTraits(genome.palette as unknown as Record<string, number>, PALETTE_TRAITS);
    clampTraits(genome.motion as unknown as Record<string, number>, MOTION_TRAITS);
    for (const a of genome.attachments) {
      clampTraits(a as unknown as Record<string, number>, ATTACHMENT_TRAITS);
    }
    return genome;
  } catch {
    return cloneGenome(fallback);
  }
}
