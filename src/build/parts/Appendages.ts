import * as THREE from 'three';
import { registerPart, type PartBuildContext } from '../PartRegistry';
import { addMesh, blob, membraneGeometry, plateGeometry, spikeGeometry } from '../Shapes';
import type { ChainRig, PartRigs } from '../../anim/Rig';
import { lerp } from '../../core/MathUtils';

/**
 * Everything that is not a leg or a head.
 *
 * These are the parts that demonstrate the registry is worth having: a horn is
 * forty lines and needs nothing from the genome, the mutator, the animator or
 * the UI to become a first-class heritable feature. The tail is the same shape
 * of code as an antenna, which is the same as a tentacle — one chain builder,
 * three registrations, and mutation can put any of them anywhere.
 */

// ------------------------------------------------------------------- chains

function buildChain(
  ctx: PartBuildContext,
  opts: {
    segments: number;
    length: number;
    baseRadius: number;
    tipRadius: number;
    stiffness: number;
    sway: number;
    tip?: 'none' | 'spike' | 'bulb' | 'fan';
    /**
     * Rotation of the chain root about the socket's X, in radians.
     *
     * The socket's -Y points straight out of the body, which is right for a
     * leg and wrong for everything else here: a tail built along it hangs
     * under the animal like a plumb line instead of trailing behind. +pi/2
     * swings the chain backward, negative values tip it up and forward.
     */
    rootPitch?: number;
  },
): PartRigs {
  const { socket, materials } = ctx;
  const skin = materials.get('skin');
  const outline = materials.outline;
  const segLength = opts.length / opts.segments;

  const base = new THREE.Object3D();
  base.rotation.x = opts.rootPitch ?? 0;
  socket.add(base);

  const joints: THREE.Object3D[] = [];
  let mount: THREE.Object3D = base;
  for (let i = 0; i < opts.segments; i++) {
    const joint = new THREE.Object3D();
    joint.name = `chain${i}`;
    joint.position.y = i === 0 ? 0 : -segLength;
    mount.add(joint);
    const t = i / opts.segments;
    const r = lerp(opts.baseRadius, opts.tipRadius, t);
    // The segment mesh has to *span* its bone, not sit at the joint. A sphere
    // per joint on a long chain gives a row of detached beads floating in the
    // air, which is what a long antenna looked like.
    addMesh(
      joint,
      blob(r, { squash: Math.max(1, (segLength * 0.62) / Math.max(r, 1e-4)) }),
      skin,
      outline,
      ctx.spine,
      [0, -segLength / 2, 0],
    );
    joints.push(joint);
    mount = joint;
  }

  const last = joints[joints.length - 1];
  if (opts.tip === 'spike') {
    const node = new THREE.Object3D();
    node.position.y = -segLength;
    last.add(node);
    addMesh(node, spikeGeometry(opts.tipRadius * 5, opts.tipRadius * 1.4, 0.2), materials.get('horn'), outline, ctx.spine);
  } else if (opts.tip === 'bulb') {
    addMesh(last, blob(opts.tipRadius * 2.4, { squash: 0.9 }), materials.get('eye'), outline, ctx.spine, [0, -segLength, 0]);
  } else if (opts.tip === 'fan') {
    for (let i = 0; i < 5; i++) {
      const node = new THREE.Object3D();
      node.position.y = -segLength;
      node.rotation.z = (i / 4 - 0.5) * 1.5;
      last.add(node);
      addMesh(
        node,
        plateGeometry(opts.tipRadius * 1.2, opts.tipRadius * 5, opts.tipRadius * 0.3),
        materials.get('membrane'),
        outline,
        ctx.spine,
        [0, -opts.tipRadius * 2.5, 0],
      );
    }
  }

  const chain: ChainRig = {
    joints,
    lengths: joints.map(() => segLength),
    stiffness: opts.stiffness,
    springs: [],
    sway: opts.sway,
  };
  return { chains: [chain] };
}

registerPart({
  kind: 'tail',
  label: 'Tail',
  group: 'tail',
  maxCount: 2,
  weight: 7,
  traits: {
    length: { min: 0.25, max: 2.4, label: 'Tail length' },
    segments: { min: 3, max: 10, label: 'Tail joints', integer: true },
    thickness: { min: 0.3, max: 1.3, label: 'Tail thickness' },
    taper: { min: 0.02, max: 0.6, label: 'Tail taper' },
    tip: { min: 0, max: 3, label: 'Tail tip', integer: true },
  },
  defaultPlacement: () => ({ at: 0.02, symmetry: 'single', around: 0.35, scale: 1 }),
  build: (ctx) =>
    buildChain(ctx, {
      segments: Math.round(ctx.traits.segments),
      length: ctx.bodyLength * ctx.traits.length * ctx.attachment.scale,
      baseRadius: ctx.bodyRadius * ctx.traits.thickness,
      tipRadius: ctx.bodyRadius * ctx.traits.thickness * ctx.traits.taper,
      stiffness: ctx.genome.motion.tailStiffness,
      sway: 1,
      // Trails behind the animal rather than dangling beneath it.
      rootPitch: Math.PI / 2,
      tip: (['none', 'spike', 'bulb', 'fan'] as const)[Math.round(ctx.traits.tip)],
    }),
});

registerPart({
  kind: 'antenna',
  label: 'Antenna',
  group: 'misc',
  maxCount: 6,
  weight: 3,
  traits: {
    length: { min: 0.15, max: 0.9, label: 'Antenna length' },
    segments: { min: 2, max: 6, label: 'Antenna joints', integer: true },
    thickness: { min: 0.05, max: 0.3, label: 'Antenna thickness' },
    tip: { min: 0, max: 3, label: 'Antenna tip', integer: true },
  },
  defaultPlacement: (rng) => ({
    at: rng.range(0.8, 0.97),
    symmetry: 'pair',
    around: Math.PI * rng.range(0.7, 1),
    scale: rng.range(0.7, 1.3),
  }),
  build: (ctx) =>
    buildChain(ctx, {
      segments: Math.round(ctx.traits.segments),
      // Off the body radius rather than its length: a two-segment antenna
      // sized against a three-metre body is a pair of flagpoles.
      length: (ctx.bodyRadius * 1.6 + ctx.bodyLength * 0.12) * ctx.traits.length * ctx.attachment.scale,
      baseRadius: ctx.bodyRadius * ctx.traits.thickness,
      tipRadius: ctx.bodyRadius * ctx.traits.thickness * 0.4,
      // Deliberately floppier than a tail; antennae are the part that sells
      // secondary motion because they never stop moving.
      stiffness: 9,
      sway: 2.2,
      // Antennae sweep up and back off the head.
      rootPitch: -0.55,
      tip: (['none', 'bulb', 'bulb', 'spike'] as const)[Math.round(ctx.traits.tip)],
    }),
});

// -------------------------------------------------------------------- crests

registerPart({
  kind: 'horn',
  label: 'Horn',
  group: 'crest',
  maxCount: 8,
  weight: 4,
  traits: {
    length: { min: 0.3, max: 3.2, label: 'Horn length' },
    thickness: { min: 0.1, max: 0.7, label: 'Horn thickness' },
    curve: { min: -0.7, max: 0.9, label: 'Horn curve' },
    tilt: { min: -0.8, max: 0.8, label: 'Horn tilt' },
  },
  defaultPlacement: (rng) => ({
    at: rng.range(0.75, 0.96),
    symmetry: rng.chance(0.7) ? 'pair' : 'single',
    around: Math.PI * rng.range(0.6, 1),
    scale: rng.range(0.7, 1.4),
  }),
  build: (ctx) => {
    const node = new THREE.Object3D();
    node.rotation.x = ctx.traits.tilt;
    ctx.socket.add(node);
    const unit = ctx.bodyRadius * 0.6 + ctx.bodyLength * 0.06;
    addMesh(
      node,
      spikeGeometry(
        unit * ctx.traits.length * ctx.attachment.scale * 1.5,
        unit * ctx.traits.thickness * ctx.attachment.scale * 0.7,
        ctx.traits.curve,
      ),
      ctx.materials.get('horn'),
      ctx.materials.outline,
      ctx.spine,
    );
  },
});

registerPart({
  kind: 'fin',
  label: 'Fin',
  group: 'crest',
  maxCount: 10,
  weight: 4,
  traits: {
    height: { min: 0.4, max: 3, label: 'Fin height' },
    width: { min: 0.3, max: 2.2, label: 'Fin width' },
    lean: { min: -0.6, max: 0.6, label: 'Fin lean' },
    count: { min: 1, max: 5, label: 'Fin blades', integer: true },
  },
  defaultPlacement: (rng) => ({
    at: rng.range(0.25, 0.8),
    symmetry: 'single',
    around: Math.PI,
    scale: rng.range(0.8, 1.4),
  }),
  build: (ctx) => {
    const blades = Math.max(1, Math.round(ctx.traits.count));
    const unit = ctx.bodyRadius * 0.7 + ctx.bodyLength * 0.05;
    const h = unit * ctx.traits.height * ctx.attachment.scale * 1.1;
    const w = unit * ctx.traits.width * ctx.attachment.scale;
    for (let i = 0; i < blades; i++) {
      const node = new THREE.Object3D();
      const t = blades === 1 ? 0 : i / (blades - 1) - 0.5;
      node.position.z = t * w * 1.5;
      node.rotation.x = ctx.traits.lean;
      // Blades shrink away from the middle, so a row reads as a crest rather
      // than as a picket fence.
      const falloff = 1 - Math.abs(t) * 0.9;
      ctx.socket.add(node);
      addMesh(
        node,
        plateGeometry(w * falloff, h * falloff, ctx.bodyRadius * 0.12),
        ctx.materials.get('membrane'),
        ctx.materials.outline,
        ctx.spine,
        [0, -h * falloff * 0.5, 0],
        [0, Math.PI / 2, Math.PI],
      );
    }
  },
});

registerPart({
  kind: 'plate',
  label: 'Armour plate',
  group: 'crest',
  maxCount: 14,
  weight: 3,
  traits: {
    size: { min: 0.4, max: 1.8, label: 'Plate size' },
    rows: { min: 1, max: 3, label: 'Plate rows', integer: true },
  },
  defaultPlacement: (rng) => ({
    at: rng.range(0.15, 0.9),
    symmetry: rng.chance(0.5) ? 'pair' : 'single',
    around: Math.PI * rng.range(0.55, 1),
    scale: rng.range(0.8, 1.3),
  }),
  build: (ctx) => {
    const rows = Math.max(1, Math.round(ctx.traits.rows));
    const s = (ctx.bodyRadius * 0.8 + ctx.bodyLength * 0.03) * ctx.traits.size * ctx.attachment.scale;
    for (let i = 0; i < rows; i++) {
      const node = new THREE.Object3D();
      node.position.z = (i - (rows - 1) / 2) * s * 1.1;
      node.rotation.x = -0.3;
      ctx.socket.add(node);
      addMesh(
        node,
        blob(s * 0.7, { squash: 0.42, stretch: 0.9 }),
        ctx.materials.get('horn'),
        ctx.materials.outline,
        ctx.spine,
        [0, -s * 0.1, 0],
      );
    }
  },
});

// --------------------------------------------------------------------- wings

registerPart({
  kind: 'wing',
  label: 'Wing',
  group: 'wing',
  maxCount: 4,
  weight: 3,
  traits: {
    span: { min: 0.6, max: 3, label: 'Wing span' },
    chord: { min: 0.4, max: 1.8, label: 'Wing chord' },
    fingers: { min: 2, max: 5, label: 'Wing fingers', integer: true },
    beat: { min: 0.4, max: 3.2, label: 'Beat rate' },
    sag: { min: 0, max: 0.5, label: 'Membrane sag' },
  },
  defaultPlacement: (rng) => ({
    at: rng.range(0.55, 0.75),
    symmetry: 'pair',
    around: Math.PI * rng.range(0.55, 0.8),
    scale: rng.range(0.8, 1.3),
  }),
  build: (ctx) => {
    const span = ctx.bodyLength * ctx.traits.span * 0.5 * ctx.attachment.scale;
    const chord = span * ctx.traits.chord * 0.55;
    const side = ctx.side === -1 ? -1 : 1;

    // The flap node rotates about the socket's forward axis, so both wings of
    // a pair sweep up and down together rather than mirroring into a scissor.
    const flap = new THREE.Object3D();
    flap.name = 'wing';
    ctx.socket.add(flap);

    // The wing lies out along the socket's -Y, which is already the outward
    // direction, so it needs no side flip of its own.
    const arm = new THREE.Object3D();
    arm.rotation.z = -Math.PI / 2 * side;
    flap.add(arm);

    addMesh(
      arm,
      membraneGeometry(span, chord, ctx.traits.sag * chord),
      ctx.materials.get('membrane'),
      ctx.materials.outline,
      ctx.spine,
      [span * 0.5 * side, 0, 0],
      [0, 0, 0],
    );

    const fingers = Math.max(2, Math.round(ctx.traits.fingers));
    for (let i = 0; i < fingers; i++) {
      const t = i / (fingers - 1);
      const node = new THREE.Object3D();
      node.position.set(span * t * side, 0, 0);
      node.rotation.z = (side > 0 ? -1 : 1) * (0.2 + t * 0.5);
      arm.add(node);
      addMesh(
        node,
        spikeGeometry(chord * (0.9 - t * 0.35), chord * 0.045, 0.1),
        ctx.materials.get('horn'),
        ctx.materials.outline,
        ctx.spine,
      );
    }

    return {
      flappers: [
        {
          node: flap,
          axis: new THREE.Vector3(0, 0, 1),
          amplitude: 0.55,
          rate: ctx.traits.beat,
          phase: 0,
          bias: -0.25,
        },
      ],
    };
  },
});

registerPart({
  kind: 'eyestalk',
  label: 'Eye stalk',
  group: 'misc',
  maxCount: 6,
  weight: 2,
  traits: {
    length: { min: 0.2, max: 1.2, label: 'Stalk length' },
    eye: { min: 0.15, max: 0.6, label: 'Eye size' },
    segments: { min: 2, max: 5, label: 'Stalk joints', integer: true },
  },
  defaultPlacement: (rng) => ({
    at: rng.range(0.7, 0.95),
    symmetry: 'pair',
    around: Math.PI * rng.range(0.6, 0.95),
    scale: rng.range(0.7, 1.2),
  }),
  build: (ctx) => {
    const rigs = buildChain(ctx, {
      segments: Math.round(ctx.traits.segments),
      length: (ctx.bodyRadius * 1.4 + ctx.bodyLength * 0.1) * ctx.traits.length * ctx.attachment.scale,
      baseRadius: ctx.bodyRadius * 0.16,
      tipRadius: ctx.bodyRadius * 0.12,
      stiffness: 14,
      sway: 1.6,
      rootPitch: -0.3,
    });
    const chain = rigs.chains![0];
    const tip = chain.joints[chain.joints.length - 1];
    const r = ctx.bodyRadius * ctx.traits.eye * ctx.attachment.scale;
    const eye = new THREE.Object3D();
    eye.position.y = -chain.lengths[0];
    tip.add(eye);
    addMesh(eye, blob(r, {}), ctx.materials.get('eye'), ctx.materials.outline, ctx.spine);
    addMesh(eye, blob(r * 0.5, { stretch: 0.6 }), ctx.materials.get('claw'), null, ctx.spine, [0, 0, r * 0.7]);
    return rigs;
  },
});
