import * as THREE from 'three';
import type { Genome } from '../genome/Genome';
import { Rng } from '../core/Rng';
import { createMaterials, type CreatureMaterials } from '../shading/Toon';
import { bodyRadiusAt, buildBody, widestRadius, type BodyResult } from './Body';
import { getPart, resolveTraits, type PartBuildContext } from './PartRegistry';
import { emptyRigs, mergeRigs, type PartRigs } from '../anim/Rig';

// Registering a part is a side effect of importing its module, so these
// imports are the whole of the plug-in wiring. A new part file added here
// becomes available to the randomiser, the mutator and the UI at once.
import './parts/Limbs';
import './parts/Heads';
import './parts/Appendages';

export interface Creature {
  genome: Genome;
  body: BodyResult;
  root: THREE.Group;
  rigs: Required<PartRigs>;
  materials: CreatureMaterials;
  /** Longest leg reach, used to scale the gait. */
  legReach: number;
  dispose(): void;
}

/**
 * Grows a creature from a genome.
 *
 * The ordering here is the whole difficulty, and both constraints below produce
 * quiet nonsense rather than errors when they are broken:
 *
 * 1. **How tall it stands has to be decided before anything is built.** Leg
 *    length once came out of the gap between the socket and the ground, and
 *    that gap came out of the ride height, which came out of leg length — a
 *    loop. Broken naively it fails in a way that only shows up on some
 *    genomes: a wide body raises the sockets, the residual gap collapses, and
 *    the creature grows legs a few centimetres long and lies on its belly.
 *    Measured, that was 23 of 24 random creatures.
 *
 *    So leg length is a gene now, not a leftover. It is read straight from the
 *    body gene, the ride height is computed from it, and the body is built to
 *    that height — one direction, no loop.
 *
 * 2. **A leg's rest position is only knowable once the hierarchy exists**,
 *    since it is the socket's position expressed in the creature root. It is
 *    filled in at the end rather than by the part builder.
 */
export function buildCreature(genome: Genome): Creature {
  const rng = new Rng(genome.seed);
  // Outline width is now in view-space units scaled by depth, not in clip
  // space, so this number is a world-space thickness at one metre.
  const materials = createMaterials(genome.palette, 0.0075);
  const gene = genome.body;

  const flatten = gene.flatten;
  // How far below the spine each leg socket sits, at its own position.
  const socketDrop = (a: { at: number; around: number }): number =>
    Math.cos(a.around) * bodyRadiusAt(gene, a.at) * flatten * 0.92;
  const legs = genome.attachments.filter((a) => a.kind === 'leg');

  /**
   * Ride height and leg length, resolved in two passes rather than iterated.
   *
   * The two constraints pull opposite ways. The legs decide how tall the animal
   * *can* stand; the body's own depth decides how tall it *must*, or it drags.
   * Take the larger — and then the legs may no longer reach the ground, which
   * is the failure the first version shipped: measured, 13 of 24 creatures
   * stood with at least one foot in the air, up to half a metre off it.
   *
   * So the second pass lengthens the legs to whatever the chosen height
   * demands. It cannot loop, because lengthening legs never raises the body:
   * the height is already at least what the gene's own legs asked for.
   */
  const wanted = gene.length * gene.stance;
  let rideHeight = Math.max(0.12, widestRadius(gene) * flatten * 1.04);
  for (const a of legs) rideHeight = Math.max(rideHeight, wanted * a.scale * 0.9 + socketDrop(a));

  let legLength = wanted;
  for (const a of legs) {
    legLength = Math.max(legLength, (rideHeight - socketDrop(a)) / Math.max(0.2, a.scale * 0.94));
  }

  const body = buildBody(genome.body, genome.palette, materials, rideHeight);
  const rigs = emptyRigs();

  for (let index = 0; index < genome.attachments.length; index++) {
    const attachment = genome.attachments[index];
    const def = getPart(attachment.kind);
    // An unknown kind means a genome from a build that had a part this one does
    // not. Skipping it keeps the rest of the creature intact.
    if (!def) continue;

    const partRng = rng.fork(index * 7919 + 13);
    const traits = resolveTraits(def, attachment.traits, partRng);
    const sides: (-1 | 0 | 1)[] = attachment.symmetry === 'pair' ? [1, -1] : [0];

    for (const side of sides) {
      const socket = body.socketAt(attachment.at, attachment.around, side);
      const ctx: PartBuildContext = {
        rng: partRng.fork(side + 3),
        genome,
        attachment,
        socket: socket.node,
        bodyRadius: socket.radius,
        bodyLength: genome.body.length,
        side,
        spine: socket.spine,
        standHeight: socket.standHeight,
        legLength,
        materials,
        traits,
      };
      mergeRigs(rigs, def.build(ctx) ?? undefined);
    }
  }

  // The hierarchy is complete, so sockets finally have positions in the root's
  // space and the legs can learn where their feet belong.
  body.root.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(body.root.matrixWorld).invert();
  const local = new THREE.Vector3();
  let legReach = 0.001;
  for (const leg of rigs.legs) {
    local.setFromMatrixPosition(leg.socket.matrixWorld).applyMatrix4(inverse);
    // Stance width pushes the foot outboard of the hip; the foot sits on the
    // ground, which in the root's space is y = 0.
    leg.restOffset.set(local.x * leg.spread, 0, local.z);
    leg.planted.copy(leg.restOffset);
    leg.stepFrom.copy(leg.restOffset);
    leg.stepTo.copy(leg.restOffset);
    legReach = Math.max(legReach, leg.reach);
  }

  // Gait phase. Sorting by position along the body and alternating the side
  // gives a diagonal gait on four legs and a tripod on six, without either
  // being written down anywhere — they are the same rule.
  const ordered = [...rigs.legs].sort((a, b) => a.restOffset.z - b.restOffset.z);
  const pairSeen = new Map<number, number>();
  for (const leg of ordered) {
    const key = Math.round(leg.restOffset.z * 100);
    if (!pairSeen.has(key)) pairSeen.set(key, pairSeen.size);
    const pairIndex = pairSeen.get(key)!;
    leg.phase = ((pairIndex + (leg.side > 0 ? 0 : 1)) % 2) * 0.5;
  }

  // Flappers on a pair should beat together, not mirror into a scissor.
  for (let i = 0; i < rigs.flappers.length; i++) rigs.flappers[i].phase = 0;

  body.refresh();

  return {
    genome,
    body,
    root: body.root,
    rigs,
    materials,
    legReach,
    dispose() {
      body.dispose();
      body.root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
      });
      materials.dispose();
    },
  };
}
