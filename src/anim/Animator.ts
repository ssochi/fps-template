import * as THREE from 'three';
import type { Creature } from '../build/CreatureBuilder';
import { solveTwoBone } from './IK';
import { SpringVec } from '../core/MathUtils';
import { clamp, damp, dampAngle, easeOutCubic, lerp, noise1 } from '../core/MathUtils';

/**
 * Procedural animation. There are no clips, no keyframes and no baked cycles;
 * every pose in this file is solved from the creature's current state.
 *
 * The load-bearing idea is that **the gait is not authored, it is a
 * consequence**. Feet are planted in the world and stay planted; when the body
 * carries a foot too far from where that foot ought to be, it takes a step.
 * Everything people recognise as a walk — the diagonal pairs of a dog, the
 * tripod of an insect, a limp when one leg is shorter — falls out of that rule
 * plus a constraint about which legs may be in the air together. A creature
 * with five legs, or with two legs of different lengths, is not a special case,
 * which is the entire point when the creature is assembled by mutation.
 *
 * The second idea is that **the stride clock runs on distance, not time**. Tie
 * a walk cycle to a timer and the feet skate the moment the speed changes; tie
 * it to metres travelled and they cannot, because the cycle and the ground move
 * together by construction.
 */

const _v = new THREE.Vector3();
const _target = new THREE.Vector3();
const _home = new THREE.Vector3();
const _inv = new THREE.Matrix4();
const _look = new THREE.Vector3();

export interface AnimatorOptions {
  /** Half-width of the pen the creature wanders inside. */
  bounds: number;
}

export class Animator {
  private creature: Creature;
  private readonly options: AnimatorOptions;

  /** World position of the root, on the ground. */
  readonly position = new THREE.Vector3();
  private heading = 0;
  private desiredHeading = 0;
  private speed = 0;
  private turnRate = 0;

  /** Metres travelled; drives the stride clock so feet cannot skate. */
  private distance = 0;
  private clock = 0;
  private wanderPhase = 0;

  /** Where the head is looking. */
  readonly interest = new THREE.Vector3(0, 1, 4);
  private idleBlink = 0;

  private bobPhase = 0;

  constructor(creature: Creature, options: AnimatorOptions) {
    this.creature = creature;
    this.options = options;
    this.reset();
  }

  setCreature(creature: Creature): void {
    this.creature = creature;
    this.reset();
  }

  private reset(): void {
    this.position.set(0, 0, 0);
    this.heading = 0;
    this.desiredHeading = 0;
    this.speed = 0;
    this.distance = 0;
    this.creature.root.position.copy(this.position);
    this.creature.root.rotation.y = this.heading;
    this.creature.root.updateMatrixWorld(true);
    for (const leg of this.creature.rigs.legs) {
      leg.planted.copy(leg.restOffset).applyMatrix4(this.creature.root.matrixWorld);
      leg.stepFrom.copy(leg.planted);
      leg.stepTo.copy(leg.planted);
      leg.stepping = false;
      leg.stepProgress = 0;
    }
    for (const chain of this.creature.rigs.chains) {
      chain.springs = chain.joints.map(() => new SpringVec(chain.stiffness, 0.55));
      chain.joints.forEach((joint, i) => {
        joint.updateWorldMatrix(true, false);
        chain.springs[i].reset(new THREE.Vector3().setFromMatrixPosition(joint.matrixWorld));
      });
    }
  }

  /** Stops the creature where it stands, for a still portrait. */
  freeze(): void {
    this.speed = 0;
    this.desiredHeading = this.heading;
  }

  update(dt: number, walking: boolean): void {
    const step = Math.min(dt, 1 / 30);
    this.clock += step;
    const { genome, rigs, body } = this.creature;
    const motion = genome.motion;

    this.steer(step, walking);
    this.driveRoot(step);
    this.poseSpine(step);

    // The spine has moved, so the sockets have moved, and only now do the legs
    // know where their hips are. Order is not negotiable here.
    this.creature.root.updateMatrixWorld(true);
    this.poseLegs(step);
    body.refresh();

    this.poseChains(step);
    this.poseHeads(step);
    this.poseFlappers(step);

    // Breathing rides on the carrier, on top of the walk bob.
    const breath = Math.sin(this.clock * Math.PI * 2 * motion.breathRate);
    body.carrier.scale.set(
      1 + breath * 0.018,
      1 + breath * 0.03,
      1,
    );
    void rigs;
  }

  // ------------------------------------------------------------------ steering

  private steer(dt: number, walking: boolean): void {
    const motion = this.creature.genome.motion;
    const target = walking ? motion.speed : 0;
    this.speed = damp(this.speed, target, 3.2, dt);

    if (walking) {
      // Smooth wander from value noise rather than random jumps, so the path
      // curves the way an animal's does instead of zig-zagging.
      this.wanderPhase += dt * motion.wander * 0.5;
      this.desiredHeading += noise1(this.wanderPhase, this.creature.genome.seed) * dt * motion.wander * 2.4;

      // Turn back at the edge of the pen, steering rather than teleporting.
      const limit = this.options.bounds;
      const dist = Math.hypot(this.position.x, this.position.z);
      if (dist > limit) {
        const inward = Math.atan2(-this.position.x, -this.position.z);
        const urgency = clamp((dist - limit) / (limit * 0.35), 0, 1);
        this.desiredHeading = lerp(this.desiredHeading, inward, urgency * 0.12);
      }
    }

    const before = this.heading;
    this.heading = dampAngle(this.heading, this.desiredHeading, 2.4, dt);
    this.turnRate = damp(this.turnRate, (this.heading - before) / Math.max(dt, 1e-4), 8, dt);
  }

  private driveRoot(dt: number): void {
    const move = this.speed * dt;
    this.position.x += Math.sin(this.heading) * move;
    this.position.z += Math.cos(this.heading) * move;
    this.distance += move;

    const root = this.creature.root;
    root.position.copy(this.position);
    root.rotation.y = this.heading;

    // Ride height plus the walk bob. The bob is a function of distance, so it
    // stays locked to the footfalls at any speed.
    const motion = this.creature.genome.motion;
    const strideLength = Math.max(0.2, this.creature.legReach * motion.stride);
    this.bobPhase = (this.distance / strideLength) * Math.PI * 2;
    const bob = Math.sin(this.bobPhase * 2) * motion.bounce * this.creature.legReach * 0.5;
    const carrier = this.creature.body.carrier;
    carrier.position.y = this.creature.body.rideHeight + bob;

    // Lean into the turn, and pitch back slightly under acceleration.
    carrier.rotation.z = damp(carrier.rotation.z, clamp(-this.turnRate * 0.25, -0.35, 0.35), 6, dt);
    carrier.rotation.x = damp(carrier.rotation.x, -this.speed * 0.02, 4, dt);
  }

  // ------------------------------------------------------------------- spine

  private poseSpine(dt: number): void {
    const { spine } = this.creature.body;
    const motion = this.creature.genome.motion;
    const n = spine.length;
    const amount = motion.spineFlex * clamp(this.speed / Math.max(0.4, motion.speed), 0, 1);

    for (let i = 0; i < n; i++) {
      const t = i / Math.max(1, n - 1);
      // A wave travelling head to tail. The phase offset per joint is what
      // makes it a wave rather than the whole body wagging as one plank.
      const wave = Math.sin(this.bobPhase - t * Math.PI * 1.5) * amount * 0.16;
      // The body also swings wide of a turn, most at the tail.
      const turn = clamp(-this.turnRate * 0.14, -0.25, 0.25) * (0.35 + t * 0.65);
      const targetY = wave + turn;
      spine[i].rotation.y = damp(spine[i].rotation.y, targetY, 14, dt);
      const rest = (spine[i].userData.restRotationX as number) ?? 0;
      spine[i].rotation.x = damp(spine[i].rotation.x, rest, 10, dt);
    }
  }

  // -------------------------------------------------------------------- legs

  private poseLegs(dt: number): void {
    const legs = this.creature.rigs.legs;
    if (legs.length === 0) return;
    const motion = this.creature.genome.motion;
    const root = this.creature.root;

    const strideLength = Math.max(0.12, this.creature.legReach * motion.stride);
    // A step should take roughly the time the body needs to cover a stride.
    const stepDuration = clamp(strideLength / Math.max(0.25, this.speed) * 0.42, 0.09, 0.5);

    // Which phase groups currently have a foot off the ground. Legs alternate
    // by group, so a group may only lift once the other has landed — this one
    // constraint is what turns a pile of independent legs into a gait.
    let groupAirborne = -1;
    for (const leg of legs) {
      if (leg.stepping) groupAirborne = leg.phase < 0.25 ? 0 : 1;
    }

    for (const leg of legs) {
      const group = leg.phase < 0.25 ? 0 : 1;
      _home.copy(leg.restOffset).applyMatrix4(root.matrixWorld);

      if (leg.stepping) {
        leg.stepProgress += dt / stepDuration;
        if (leg.stepProgress >= 1) {
          leg.stepping = false;
          leg.stepProgress = 0;
          leg.planted.copy(leg.stepTo);
        } else {
          const t = leg.stepProgress;
          leg.planted.lerpVectors(leg.stepFrom, leg.stepTo, easeOutCubic(t));
          // The arc. A sine gives the foot a soft landing; the leg's own reach
          // sets the height so a small leg does not goose-step.
          leg.planted.y = Math.sin(t * Math.PI) * motion.stepHeight * leg.reach;
        }
      } else {
        const drift = Math.hypot(leg.planted.x - _home.x, leg.planted.z - _home.z);
        const canLift = groupAirborne === -1 || groupAirborne === group;
        if (drift > strideLength * 0.5 && canLift) {
          leg.stepping = true;
          leg.stepProgress = 0;
          leg.stepFrom.copy(leg.planted);
          // Land ahead of the home position by half a stride, so the foot
          // arrives where the body is going rather than where it has been.
          leg.stepTo.copy(_home);
          leg.stepTo.x += Math.sin(this.heading) * strideLength * 0.5;
          leg.stepTo.z += Math.cos(this.heading) * strideLength * 0.5;
          leg.stepTo.y = 0;
          groupAirborne = group;
        }
      }

      // Solve the limb to wherever the foot now is.
      leg.socket.updateWorldMatrix(true, false);
      _inv.copy(leg.socket.matrixWorld).invert();
      _target.copy(leg.planted).applyMatrix4(_inv);
      solveTwoBone(leg.hip, leg.knee, _target, leg.upperLength, leg.lowerLength, leg.pole);
    }
  }

  // ------------------------------------------------------------------ chains

  private poseChains(dt: number): void {
    const sway = Math.sin(this.bobPhase * 0.5) * clamp(this.speed, 0, 2);
    for (const chain of this.creature.rigs.chains) {
      for (let i = 0; i < chain.joints.length; i++) {
        const joint = chain.joints[i];
        const spring = chain.springs[i];
        if (!spring) continue;
        const parent = joint.parent;
        if (!parent) continue;
        parent.updateWorldMatrix(true, false);

        // Where this joint would be if the chain were rigid: straight on down
        // the parent's -Y. The spring lags behind it, and the lag is the whole
        // effect — a tail that tracks perfectly is a broom handle.
        _v.set(0, -chain.lengths[i], 0).applyMatrix4(parent.matrixWorld);
        _v.x += Math.sin(this.clock * 1.7 + i * 0.6) * sway * 0.012 * chain.sway;
        _v.y -= chain.sway * 0.01 * (i + 1);

        spring.step(_v, dt);
        // Aim the parent's bone at the lagged point, then let the child follow.
        aimJoint(joint, spring.value);
      }
    }
  }

  // ------------------------------------------------------------------- heads

  private poseHeads(dt: number): void {
    const heads = this.creature.rigs.heads;
    if (heads.length === 0) return;
    const motion = this.creature.genome.motion;
    this.idleBlink -= dt;

    for (const head of heads) {
      head.node.updateWorldMatrix(true, false);
      _inv.copy(head.node.matrixWorld).invert();
      _look.copy(this.interest).applyMatrix4(_inv);

      // The head is built on the -Y convention, so "forward" for it is -Y and
      // the yaw/pitch below are measured against that, not against +Z.
      const yaw = Math.atan2(_look.x, -_look.y);
      const pitch = Math.atan2(_look.z, Math.hypot(_look.x, _look.y));

      // Anticipate the turn: a creature looks where it is going before it gets
      // there, and without this the head reads as dragged rather than leading.
      const lead = -this.turnRate * motion.headLead * 0.22;
      head.yaw.step(clamp(yaw + lead, -head.maxYaw, head.maxYaw), dt);
      head.pitch.step(clamp(pitch, -head.maxPitch, head.maxPitch), dt);
      head.node.rotation.set(head.pitch.value * 0.6, head.yaw.value, 0, 'YXZ');

      if (head.jaw) {
        if (this.idleBlink <= 0) this.idleBlink = 2.5 + Math.abs(noise1(this.clock, 7)) * 5;
        const open = this.idleBlink < 0.25 ? 0.5 : 0.02 + Math.max(0, Math.sin(this.clock * 0.7)) * 0.05;
        head.jawOpen.step(open, dt);
        head.jaw.rotation.x = head.jawOpen.value;
      }
    }
  }

  // ---------------------------------------------------------------- flappers

  private poseFlappers(dt: number): void {
    void dt;
    for (const flap of this.creature.rigs.flappers) {
      const beat = Math.sin(this.clock * Math.PI * 2 * flap.rate + flap.phase);
      const angle = flap.bias + beat * flap.amplitude;
      flap.node.quaternion.setFromAxisAngle(flap.axis, angle);
    }
  }
}

const _y = new THREE.Vector3();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _pinv = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 0, 1);

/** Points a joint's -Y bone at a world-space position. */
function aimJoint(joint: THREE.Object3D, worldTarget: THREE.Vector3): void {
  const parent = joint.parent;
  if (!parent) return;
  _pinv.copy(parent.matrixWorld).invert();
  _p.copy(worldTarget).applyMatrix4(_pinv);
  _y.copy(_p).sub(joint.position);
  if (_y.lengthSq() < 1e-10) return;
  _y.normalize().negate();
  _x.crossVectors(_y, UP);
  if (_x.lengthSq() < 1e-10) _x.set(1, 0, 0);
  _x.normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  joint.quaternion.setFromRotationMatrix(_m);
  joint.updateWorldMatrix(false, false);
}
