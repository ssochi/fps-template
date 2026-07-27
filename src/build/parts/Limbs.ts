import * as THREE from 'three';
import { registerPart, type PartBuildContext } from '../PartRegistry';
import { addMesh, blob, boneGeometry, spikeGeometry } from '../Shapes';
import type { LegRig, PartRigs } from '../../anim/Rig';
import { lerp } from '../../core/MathUtils';

/**
 * Legs.
 *
 * The visible geometry is the easy half. The half that matters is the joint
 * chain underneath it, which must obey the -Y bone convention exactly, because
 * the IK solver drives it and a leg built any other way bends sideways or
 * inside out and looks like a rigging bug rather than a design choice.
 *
 * `kneeBack` is a real anatomical switch rather than decoration: a knee that
 * bends the same way front and back reads as a table, and the difference
 * between a dog and a lizard is largely which way each pair folds.
 */

function buildLeg(ctx: PartBuildContext): PartRigs {
  const { socket, traits, materials, attachment } = ctx;
  const side: -1 | 1 = ctx.side === -1 ? -1 : 1;

  /**
   * The leg is sized to the gap it has to span, and the traits split that span
   * rather than setting it.
   *
   * Letting the traits pick the total is what produced creatures kneeling on
   * the floor: a rounder body raises the socket, the trait rolls short, and the
   * limb simply cannot reach the ground — the IK then pins the foot at full
   * stretch and the animal drags its belly. Fixing the total and varying only
   * the thigh-to-shin ratio means every genome stands up, and the proportion
   * is still free.
   */
  // A little over the gap, so the limb rests slightly bent instead of locked.
  // `legLength` is what the ride height was computed *from*, so this is
  // self-consistent by construction rather than by luck.
  const span = Math.max(0.06, ctx.legLength * attachment.scale) * 1.06;
  const ratio = lerp(0.36, 0.64, traits.upperRatio);
  const upper = span * ratio;
  const lower = span * (1 - ratio);
  // Proportional to the leg, not to the body: keying limb thickness off body
  // radius alone gives a fat creature tree trunks and a slim one wire.
  const thickness = Math.max(0.014, span * traits.thickness * 0.14);

  const hip = new THREE.Object3D();
  hip.name = 'hip';
  socket.add(hip);
  const knee = new THREE.Object3D();
  knee.name = 'knee';
  knee.position.set(0, -upper, 0);
  hip.add(knee);
  const foot = new THREE.Object3D();
  foot.name = 'foot';
  foot.position.set(0, -lower, 0);
  knee.add(foot);

  const skin = materials.get('skin');
  const claw = materials.get('claw');
  const outline = materials.outline;

  addMesh(hip, boneGeometry(upper, thickness * 1.15, thickness * 0.82), skin, outline, ctx.spine);
  addMesh(knee, boneGeometry(lower, thickness * 0.8, thickness * 0.55), skin, outline, ctx.spine);
  // A joint bulge, so the limb reads as jointed rather than as two cones.
  addMesh(knee, blob(thickness * 0.86, { squash: 0.85 }), skin, outline, ctx.spine);

  // Foot: a pad plus claws fanned across the front.
  const padLength = thickness * 2.4 * traits.lowerRatio;
  addMesh(
    foot,
    blob(thickness * 0.95 * traits.lowerRatio, { squash: 0.5, stretch: 1.5 }),
    skin,
    outline,
    ctx.spine,
    [0, thickness * 0.3, padLength * 0.2],
  );
  const toes = Math.max(0, Math.round(traits.toes));
  for (let i = 0; i < toes; i++) {
    const spread = toes === 1 ? 0 : (i / (toes - 1) - 0.5) * 1.5;
    const clawNode = new THREE.Object3D();
    clawNode.position.set(spread * thickness * 1.4, thickness * 0.2, padLength * 0.5);
    clawNode.rotation.x = -Math.PI / 2 + 0.5;
    clawNode.rotation.z = -spread * 0.4;
    foot.add(clawNode);
    addMesh(clawNode, spikeGeometry(thickness * 1.5, thickness * 0.3, 0.35), claw, outline, ctx.spine);
  }

  /**
   * The knee's bend plane.
   *
   * Expressed in the socket's space, where -Y is out from the body and +Z is
   * the creature's forward. A pole on +Z folds the knee forward like a dog's
   * front leg; on -Z it folds back like its hind leg.
   */
  const pole = new THREE.Vector3(0, 0, traits.kneeBack > 0.5 ? -1 : 1);

  const rig: LegRig = {
    socket,
    hip,
    knee,
    foot,
    upperLength: upper,
    lowerLength: lower,
    pole,
    side,
    phase: 0,
    planted: new THREE.Vector3(),
    stepFrom: new THREE.Vector3(),
    stepTo: new THREE.Vector3(),
    stepProgress: 0,
    stepping: false,
    // Filled in by the builder once the hierarchy exists and the socket has a
    // position relative to the creature root.
    restOffset: new THREE.Vector3(0, 0, 0),
    spread: traits.spread,
    reach: upper + lower,
  };
  return { legs: [rig] };
}

registerPart({
  kind: 'leg',
  label: 'Leg',
  group: 'limb',
  maxCount: 12,
  weight: 5,
  traits: {
    upperRatio: { min: 0, max: 1, label: 'Thigh / shin' },
    lowerRatio: { min: 0.5, max: 1.8, label: 'Foot size' },
    thickness: { min: 0.3, max: 1.25, label: 'Limb thickness' },
    spread: { min: 0.55, max: 1.7, label: 'Stance width' },
    toes: { min: 0, max: 4, label: 'Claws', integer: true },
    kneeBack: { min: 0, max: 1, label: 'Knee backward' },
  },
  defaultPlacement: (rng) => ({
    at: rng.chance(0.5) ? rng.range(0.16, 0.34) : rng.range(0.62, 0.84),
    symmetry: 'pair',
    around: rng.range(-0.5, 0.5),
    scale: rng.range(0.8, 1.2),
  }),
  build: buildLeg,
});
