import * as THREE from 'three';
import type { Attachment, Genome, TraitTable } from '../genome/Genome';
import type { PartRigs } from '../anim/Rig';
import type { CreatureMaterials } from '../shading/Toon';
import { Rng } from '../core/Rng';

/**
 * The extension point.
 *
 * A part kind is registered once with a trait schema and a builder, and from
 * then on it is a full citizen: the randomiser can pick it, mutation can add,
 * remove and retune it, breeding can inherit it, the UI can expose sliders for
 * it, and the animation systems drive whatever rigs it returns. Nothing in the
 * genome, the mutator or the animator names a specific part.
 *
 * The contract a part must keep:
 *
 * - Build into `ctx.socket` and nowhere else. The socket is already positioned,
 *   oriented and mirrored, so a part that reaches for world coordinates will be
 *   wrong on the left-hand side of every creature.
 * - Bones run down local -Y, with the child joint at `(0, -length, 0)`. Every
 *   solver assumes it.
 * - Return the rigs you want animated. Returning nothing is fine — a horn is a
 *   perfectly good part.
 */

export interface PartBuildContext {
  rng: Rng;
  genome: Genome;
  attachment: Attachment;
  /** Pre-oriented, pre-mirrored parent. Build here. */
  socket: THREE.Object3D;
  /** Body radius at this point on the spine, so parts can scale to the body. */
  bodyRadius: number;
  bodyLength: number;
  /** -1 left, +1 right, 0 on the centreline. */
  side: -1 | 0 | 1;
  /** Spine coordinate of the socket, for the shader's band pattern. */
  spine: number;
  /** Distance from the socket to the ground at rest — a leg's budget. */
  standHeight: number;
  /** Leg length the creature was sized around, from the body gene. */
  legLength: number;
  materials: CreatureMaterials;
  /** Traits resolved against the part's schema; never missing a key. */
  traits: Record<string, number>;
}

export type PartGroup = 'head' | 'limb' | 'tail' | 'wing' | 'crest' | 'misc';

export interface PartDefinition {
  kind: string;
  label: string;
  group: PartGroup;
  /** Upper bound per creature, so mutation cannot grow nine heads. */
  maxCount: number;
  /** Relative likelihood of being chosen when a creature is randomised. */
  weight: number;
  traits: TraitTable;
  /** Where a freshly added one goes. */
  defaultPlacement(rng: Rng): Pick<Attachment, 'at' | 'symmetry' | 'around' | 'scale'>;
  build(ctx: PartBuildContext): PartRigs | void;
}

const REGISTRY = new Map<string, PartDefinition>();

export function registerPart(definition: PartDefinition): void {
  if (REGISTRY.has(definition.kind)) {
    throw new Error(`Part kind "${definition.kind}" is already registered`);
  }
  REGISTRY.set(definition.kind, definition);
}

export function getPart(kind: string): PartDefinition | undefined {
  return REGISTRY.get(kind);
}

export function allParts(): PartDefinition[] {
  return [...REGISTRY.values()];
}

export function partsInGroup(group: PartGroup): PartDefinition[] {
  return allParts().filter((p) => p.group === group);
}

export function countInGroup(genome: Genome, group: PartGroup): number {
  let n = 0;
  for (const a of genome.attachments) {
    const def = REGISTRY.get(a.kind);
    if (def && def.group === group) n += a.symmetry === 'pair' ? 2 : 1;
  }
  return n;
}

export function countOfKind(genome: Genome, kind: string): number {
  let n = 0;
  for (const a of genome.attachments) {
    if (a.kind === kind) n += a.symmetry === 'pair' ? 2 : 1;
  }
  return n;
}

/**
 * Fills in any traits an attachment is missing and drops any it should not
 * have, so a genome saved before a part gained a trait still loads.
 */
export function resolveTraits(def: PartDefinition, stored: Record<string, number>, rng: Rng): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, spec] of Object.entries(def.traits)) {
    const value = stored[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = Math.min(spec.max, Math.max(spec.min, spec.integer ? Math.round(value) : value));
    } else {
      const v = rng.range(spec.min, spec.max);
      out[key] = spec.integer ? Math.round(v) : v;
    }
  }
  return out;
}
