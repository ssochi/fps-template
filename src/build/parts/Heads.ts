import * as THREE from 'three';
import { registerPart, type PartBuildContext } from '../PartRegistry';
import { addMesh, blob, spikeGeometry } from '../Shapes';
import { makeHeadRig, type PartRigs } from '../../anim/Rig';
import { lerp } from '../../core/MathUtils';

/**
 * Heads.
 *
 * A head is where a creature's whole read comes from, and almost all of that is
 * eyes: their size, how far apart they sit, and how far round the skull. Wide
 * and low is a prey animal, forward and close is a predator, and one in the
 * middle is something else entirely. The trait ranges are set so all three are
 * reachable rather than clustering on a safe average.
 */

function buildHead(ctx: PartBuildContext): PartRigs {
  const { socket, traits, materials, attachment } = ctx;
  const skin = materials.get('skin');
  const belly = materials.get('belly');
  const horn = materials.get('horn');
  const eyeMat = materials.get('eye');
  const mouth = materials.get('mouth');
  const outline = materials.outline;

  /**
   * Head size: mostly girth, a little length, and capped against the body.
   *
   * The length term stops a head vanishing on a thin snake, but weighted too
   * heavily it does the opposite — a long fat body produced a skull wider than
   * the animal, which reads as a balloon on a stick rather than as a head. The
   * cap is what keeps it a head at both ends of the range.
   */
  const unit = ctx.bodyRadius * 0.78 + ctx.bodyLength * 0.028;
  const size = Math.min(
    unit * lerp(0.62, 1.3, traits.size) * attachment.scale,
    ctx.bodyRadius * 1.45,
  );

  // The neck is a short stack rather than one bone, so the head can arc.
  const neckSegments = Math.max(1, Math.round(traits.neck * 3) + 1);
  // The neck has to be long enough to carry the skull clear of the trunk, or
  // a short-necked genome buries the head inside the body.
  const neckLength = Math.max(size * 0.85 + ctx.bodyRadius * 0.5, size * lerp(0.3, 2.2, traits.neck));
  let mount: THREE.Object3D = socket;
  const neckJoints: THREE.Object3D[] = [];
  for (let i = 0; i < neckSegments; i++) {
    const joint = new THREE.Object3D();
    joint.name = `neck${i}`;
    joint.position.y = i === 0 ? 0 : -neckLength / neckSegments;
    // Curve the neck up and forward out of the shoulders.
    joint.rotation.x = i === 0 ? -1.25 : 0.18;
    mount.add(joint);
    const r = ctx.bodyRadius * lerp(0.75, 0.45, i / neckSegments);
    addMesh(
      joint,
      blob(r, { squash: 0.9, stretch: 1.1 }),
      skin,
      outline,
      ctx.spine,
      [0, -neckLength / neckSegments / 2, 0],
    );
    neckJoints.push(joint);
    mount = joint;
  }

  // The head node hangs off the last neck joint, still on the -Y convention.
  const head = new THREE.Object3D();
  head.name = 'head';
  head.position.y = -neckLength / neckSegments;
  mount.add(head);

  // Skull, then a snout tapering off it.
  const snout = lerp(0.15, 1.5, traits.snout);
  addMesh(head, blob(size, { squash: 0.86, stretch: 1.15 }), skin, outline, ctx.spine, [0, -size * 0.4, 0]);
  const snoutNode = new THREE.Object3D();
  snoutNode.position.set(0, -size * 0.42, size * 0.55);
  snoutNode.rotation.x = 0.25;
  head.add(snoutNode);
  addMesh(
    snoutNode,
    blob(size * 0.66, { squash: 0.78, stretch: 1 + snout, taper: 0.45 }),
    skin,
    outline,
    ctx.spine,
    [0, 0, size * snout * 0.5],
  );

  // Jaw, hinged so it can open.
  const jaw = new THREE.Object3D();
  jaw.name = 'jaw';
  jaw.position.set(0, -size * 0.52, size * 0.3);
  head.add(jaw);
  addMesh(
    jaw,
    blob(size * 0.5, { squash: 0.4, stretch: 1 + snout * 0.9, taper: 0.4 }),
    mouth,
    outline,
    ctx.spine,
    [0, -size * 0.1, size * snout * 0.45],
  );

  // Teeth along the jaw line.
  const teeth = Math.round(traits.teeth);
  for (let i = 0; i < teeth; i++) {
    const t = teeth === 1 ? 0.5 : i / (teeth - 1);
    for (const s of [-1, 1]) {
      const node = new THREE.Object3D();
      node.position.set(s * size * 0.3, -size * 0.44, size * (0.35 + t * snout * 0.75));
      node.rotation.x = Math.PI;
      head.add(node);
      addMesh(node, spikeGeometry(size * 0.2, size * 0.055, 0.1), horn, outline, ctx.spine);
    }
  }

  // Eyes. `eyeRound` swings them from wide-set and lateral to forward-facing.
  const eyeSize = size * lerp(0.14, 0.42, traits.eyeSize);
  const eyeAround = lerp(1.15, 0.32, traits.eyeForward);
  for (const s of [-1, 1]) {
    const node = new THREE.Object3D();
    node.position.set(
      s * Math.sin(eyeAround) * size * 0.82,
      -size * 0.22,
      Math.cos(eyeAround) * size * 0.78,
    );
    head.add(node);
    addMesh(node, blob(eyeSize, {}), eyeMat, outline, ctx.spine);
    // A pupil that reads at a distance: a dark disc pushed to the surface.
    addMesh(
      node,
      blob(eyeSize * 0.52, { stretch: 0.6 }),
      materials.get('claw'),
      null,
      ctx.spine,
      [s * eyeSize * 0.2, 0, eyeSize * 0.72],
    );
    // Brow ridge, which is most of a creature's expression.
    addMesh(
      node,
      blob(eyeSize * 1.15, { squash: 0.34, stretch: 0.8 }),
      skin,
      outline,
      ctx.spine,
      [0, eyeSize * 0.85, 0],
      [traits.brow * 0.9 - 0.45, 0, -s * traits.brow * 0.5],
    );
  }

  // A pale throat, so the head is not one flat colour from every angle.
  addMesh(
    head,
    blob(size * 0.55, { squash: 0.55, stretch: 1.1 }),
    belly,
    null,
    ctx.spine,
    [0, -size * 0.72, size * 0.1],
  );

  return {
    heads: [makeHeadRig(head, jaw, 0.85, 0.6)],
    chains:
      neckJoints.length > 1
        ? [
            {
              joints: neckJoints.slice(1),
              lengths: neckJoints.slice(1).map(() => neckLength / neckSegments),
              stiffness: 26,
              springs: [],
              sway: 0.25,
            },
          ]
        : [],
  };
}

registerPart({
  kind: 'head',
  label: 'Head',
  group: 'head',
  maxCount: 1,
  weight: 10,
  traits: {
    size: { min: 0, max: 1, label: 'Skull size' },
    neck: { min: 0, max: 1, label: 'Neck length' },
    snout: { min: 0, max: 1, label: 'Snout' },
    eyeSize: { min: 0, max: 1, label: 'Eye size' },
    eyeForward: { min: 0, max: 1, label: 'Eyes forward' },
    brow: { min: 0, max: 1, label: 'Brow' },
    teeth: { min: 0, max: 5, label: 'Teeth', integer: true },
  },
  defaultPlacement: () => ({ at: 0.98, symmetry: 'single', around: Math.PI, scale: 1 }),
  build: buildHead,
});
