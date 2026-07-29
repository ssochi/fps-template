/**
 * Base transform for anything that occupies the world.
 *
 * **This is the only file permitted to write `rotation.y`.** Two previous
 * projects in this repository shipped "everything faces backwards" bugs caused
 * by two subsystems disagreeing about which axis was forward, so orientation is
 * centralised: everything else calls `faceTo()` / `setYaw()`.
 *
 * Convention: forward is −Z, matching three.js's camera. Metres, seconds,
 * radians, Y up.
 */
import { Object3D, Vector3, MathUtils } from 'three';
import { STOREY, worldToTile } from '../core/constants.js';

const FORWARD = new Vector3(0, 0, -1);
const UP = new Vector3(0, 1, 0);
const _v = new Vector3();

export class Entity {
  constructor(name = 'entity') {
    this.object = new Object3D();
    this.object.name = name;
    this.name = name;

    this.position = this.object.position;
    this.velocity = new Vector3();

    /** Yaw in radians; 0 faces −Z. */
    this._yaw = 0;
    this._targetYaw = 0;
    /** Radians per second. */
    this.turnRate = Math.PI * 3;

    /** Which storey the entity is standing on. */
    this.level = 0;
    /** Collision radius in metres. */
    this.radius = 0.28;
    this.alive = true;
  }

  get yaw() {
    return this._yaw;
  }

  setYaw(radians) {
    this._yaw = wrapAngle(radians);
    this._targetYaw = this._yaw;
    this.object.rotation.y = this._yaw;
  }

  aimYaw(radians) {
    this._targetYaw = wrapAngle(radians);
  }

  /** Point at a world position. Yaw only — entities don't pitch. */
  faceTo(target, instant = false) {
    _v.subVectors(target, this.position);
    if (_v.lengthSq() < 1e-8) return;
    const yaw = Math.atan2(-_v.x, -_v.z);
    if (instant) this.setYaw(yaw);
    else this.aimYaw(yaw);
  }

  /** Face the direction of travel, if travelling. */
  faceVelocity(instant = false) {
    if (this.velocity.lengthSq() < 1e-6) return;
    const yaw = Math.atan2(-this.velocity.x, -this.velocity.z);
    if (instant) this.setYaw(yaw);
    else this.aimYaw(yaw);
  }

  /** Advance the eased turn. Call once per fixed step. */
  stepTurn(dt) {
    const delta = shortestAngle(this._yaw, this._targetYaw);
    if (Math.abs(delta) < 1e-5) return;
    const step = MathUtils.clamp(delta, -this.turnRate * dt, this.turnRate * dt);
    this._yaw = wrapAngle(this._yaw + step);
    this.object.rotation.y = this._yaw;
  }

  forward(out = new Vector3()) {
    return out.copy(FORWARD).applyAxisAngle(UP, this._yaw);
  }

  right(out = new Vector3()) {
    return out.set(1, 0, 0).applyAxisAngle(UP, this._yaw);
  }

  /** The tile this entity is standing on. */
  tile(out = { x: 0, z: 0 }) {
    worldToTile(this.position.x, this.position.z, out);
    return out;
  }

  /** Snap the entity's vertical position to its storey. */
  syncLevelHeight() {
    this.position.y = this.level * STOREY;
  }

  addTo(parent) {
    parent.add(this.object);
    return this;
  }

  dispose() {
    this.object.removeFromParent();
    this.alive = false;
  }
}

/** Wrap to (−π, π]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Signed shortest rotation from `from` to `to`. */
export function shortestAngle(from, to) {
  return wrapAngle(to - from);
}
