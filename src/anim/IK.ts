import * as THREE from 'three';
import { clamp } from '../core/MathUtils';

/**
 * Inverse kinematics for the creature rigs.
 *
 * Bones run down local -Y and children sit at `(0, -length, 0)`; see `Rig.ts`.
 */

const DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _bend = new THREE.Quaternion();
const _target = new THREE.Vector3();
const _inv = new THREE.Matrix4();

/**
 * Two-bone IK, solved analytically.
 *
 * Iterative solvers are the usual reach for this and are the wrong tool: with
 * exactly two bones the law of cosines gives the answer outright, in constant
 * time, with no convergence to tune and no jitter when the target sits at the
 * edge of reach.
 *
 * The pole vector is not optional. Aligning the bone to the target leaves the
 * rotation about that axis free, and picking an arbitrary perpendicular — which
 * is what `setFromUnitVectors` does — lets the knee spin to whichever side the
 * floating-point wind happens to blow. The pole names the plane the limb bends
 * in, which is the difference between a leg and a broken leg.
 *
 * @param target Desired foot position, in the hip's *parent* space.
 * @param pole   Direction the knee should point, in the hip's parent space.
 */
export function solveTwoBone(
  hip: THREE.Object3D,
  knee: THREE.Object3D,
  target: THREE.Vector3,
  upperLength: number,
  lowerLength: number,
  pole: THREE.Vector3,
): void {
  _v.copy(target).sub(hip.position);
  let dist = _v.length();
  if (dist < 1e-6) {
    _v.set(0, -1, 0);
    dist = 1e-6;
  } else {
    _v.multiplyScalar(1 / dist);
  }

  // Clamp into the annulus the limb can actually reach. Without the lower
  // bound a target inside the fold makes the cosines exceed 1; without the
  // upper bound a limb at full stretch pops as the argument crosses it.
  const min = Math.abs(upperLength - lowerLength) + 1e-4;
  const max = upperLength + lowerLength - 1e-4;
  dist = clamp(dist, min, max);

  const alpha = Math.acos(
    clamp(
      (upperLength * upperLength + dist * dist - lowerLength * lowerLength) /
        (2 * upperLength * dist),
      -1,
      1,
    ),
  );
  const theta = Math.acos(
    clamp(
      (upperLength * upperLength + lowerLength * lowerLength - dist * dist) /
        (2 * upperLength * lowerLength),
      -1,
      1,
    ),
  );

  // Frame where local -Y runs to the target and local +X is the bend axis.
  _y.copy(_v).negate();
  _x.crossVectors(_v, pole);
  if (_x.lengthSq() < 1e-10) {
    // Pole is parallel to the limb; any perpendicular will do, but pick a
    // stable one rather than letting the cross product return zero.
    _x.set(1, 0, 0).cross(_v);
    if (_x.lengthSq() < 1e-10) _x.set(0, 0, 1).cross(_v);
  }
  _x.normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  _q.setFromRotationMatrix(_m);

  // Swing the thigh off the straight line by alpha, about the bend axis.
  _bend.setFromAxisAngle(new THREE.Vector3(1, 0, 0), alpha);
  hip.quaternion.copy(_q).multiply(_bend);

  // Fold the shin back by the interior angle's complement.
  knee.rotation.set(-(Math.PI - theta), 0, 0);
  knee.quaternion.setFromEuler(knee.rotation);
}

/**
 * Points a joint's bone (-Y) at a world-space target, keeping the roll stable.
 */
export function aimAt(joint: THREE.Object3D, worldTarget: THREE.Vector3, up: THREE.Vector3): void {
  const parent = joint.parent;
  _target.copy(worldTarget);
  if (parent) {
    parent.updateWorldMatrix(true, false);
    _inv.copy(parent.matrixWorld).invert();
    _target.applyMatrix4(_inv);
  }
  _v.copy(_target).sub(joint.position);
  if (_v.lengthSq() < 1e-10) return;
  _v.normalize();
  _y.copy(_v).negate();
  _x.crossVectors(_v, up);
  if (_x.lengthSq() < 1e-10) _x.set(1, 0, 0).cross(_v);
  _x.normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  joint.quaternion.setFromRotationMatrix(_m);
}

/**
 * Relaxes a chain toward a set of world-space goals, one joint at a time.
 *
 * This is the trailing-tail solver rather than a reaching one: each joint aims
 * at where the next joint's spring has drifted to, which produces the lag and
 * overshoot a tail has, and unlike FABRIK it never needs the chain to reach a
 * specific point.
 */
export function aimChainAt(
  joints: THREE.Object3D[],
  goals: THREE.Vector3[],
  up: THREE.Vector3,
): void {
  const count = Math.min(joints.length, goals.length);
  for (let i = 0; i < count; i++) {
    joints[i].updateWorldMatrix(true, false);
    aimAt(joints[i], goals[i], up);
    joints[i].updateWorldMatrix(false, false);
  }
}

/** The tip of a two-bone limb, in the hip's parent space — for tests and debug. */
export function footPosition(
  hip: THREE.Object3D,
  knee: THREE.Object3D,
  foot: THREE.Object3D,
): THREE.Vector3 {
  hip.updateMatrix();
  knee.updateMatrix();
  foot.updateMatrix();
  const m = new THREE.Matrix4().multiplyMatrices(hip.matrix, knee.matrix).multiply(foot.matrix);
  return new THREE.Vector3().setFromMatrixPosition(m);
}

export { DOWN };
