import * as THREE from 'three';
import { Spring, SpringVec } from '../core/MathUtils';

/**
 * The animation-facing view of a built creature.
 *
 * Nothing here knows what a part *looks* like. A part builder returns whichever
 * of these rigs it wants driven, and the animation systems consume them by
 * type — which is what lets a new kind of limb animate correctly without the
 * locomotion code learning about it.
 *
 * Bone convention, used everywhere: **a joint's bone runs down its own local
 * -Y**, and its child joint sits at `(0, -length, 0)`. Every solver in this
 * file assumes it, so a part that builds its joints any other way will bend in
 * the wrong direction and it will not be obvious which end is at fault.
 */

/** A leg or arm the walk cycle can plant and step. */
export interface LegRig {
  /** Attachment on the body; the hip's parent. */
  socket: THREE.Object3D;
  hip: THREE.Object3D;
  knee: THREE.Object3D;
  /** The tip that should reach the target. */
  foot: THREE.Object3D;
  upperLength: number;
  lowerLength: number;
  /** Which way the knee points, in the socket's space. */
  pole: THREE.Vector3;
  /** -1 left, +1 right. */
  side: -1 | 1;
  /** Phase through the gait, 0..1. Set by the gait planner, not the part. */
  phase: number;
  /** Where the foot is standing right now, in world space. */
  planted: THREE.Vector3;
  /** Where it is stepping to. */
  stepFrom: THREE.Vector3;
  stepTo: THREE.Vector3;
  /** 0 while planted; counts up to 1 through a step. */
  stepProgress: number;
  stepping: boolean;
  /** Rest position of the foot relative to the creature root, filled in by the
   *  builder once the hierarchy exists. */
  restOffset: THREE.Vector3;
  /** How far out to the side this leg stands, as a multiple of body radius. */
  spread: number;
  /** Total reach, cached from the two bone lengths. */
  reach: number;
}

/** A chain that trails behind its root: tails, tentacles, antennae. */
export interface ChainRig {
  joints: THREE.Object3D[];
  /** Length of each bone. */
  lengths: number[];
  /** How hard each joint resists lagging. Higher is stiffer. */
  stiffness: number;
  /** Per-joint world-space springs; allocated by the animator on first use. */
  springs: SpringVec[];
  /** Extra sway driven by the creature's own motion. */
  sway: number;
}

/** A head that tracks a point of interest. */
export interface HeadRig {
  node: THREE.Object3D;
  /** Sub-node that carries the jaw, if the part built one. */
  jaw: THREE.Object3D | null;
  maxYaw: number;
  maxPitch: number;
  /** Damped current angles, so the head does not snap. */
  yaw: Spring;
  pitch: Spring;
  jawOpen: Spring;
}

/** Something that beats: a wing, a fin, a fan. */
export interface FlapRig {
  node: THREE.Object3D;
  /** Local axis to rotate about. */
  axis: THREE.Vector3;
  amplitude: number;
  /** Cycles per second at rest. */
  rate: number;
  /** Offset through the cycle, so a pair alternates or mirrors. */
  phase: number;
  /** Rest angle the flap oscillates around. */
  bias: number;
}

/** Anything that just breathes with the body. */
export interface PulseRig {
  node: THREE.Object3D;
  amount: number;
  phase: number;
}

/** Everything a part can hand back for animation. */
export interface PartRigs {
  legs?: LegRig[];
  chains?: ChainRig[];
  heads?: HeadRig[];
  flappers?: FlapRig[];
  pulses?: PulseRig[];
}

export function emptyRigs(): Required<PartRigs> {
  return { legs: [], chains: [], heads: [], flappers: [], pulses: [] };
}

export function mergeRigs(into: Required<PartRigs>, from: PartRigs | undefined): void {
  if (!from) return;
  if (from.legs) into.legs.push(...from.legs);
  if (from.chains) into.chains.push(...from.chains);
  if (from.heads) into.heads.push(...from.heads);
  if (from.flappers) into.flappers.push(...from.flappers);
  if (from.pulses) into.pulses.push(...from.pulses);
}

/** Builds a head rig with sensible springs already wired. */
export function makeHeadRig(
  node: THREE.Object3D,
  jaw: THREE.Object3D | null,
  maxYaw: number,
  maxPitch: number,
): HeadRig {
  return {
    node,
    jaw,
    maxYaw,
    maxPitch,
    yaw: new Spring(70, 0.85),
    pitch: new Spring(70, 0.85),
    jawOpen: new Spring(120, 0.6),
  };
}
