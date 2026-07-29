/**
 * The isometric camera rig.
 *
 * Orthographic, fixed pitch, rotation snapped to 90° steps, zoom snapped to a
 * fixed ladder. Free orbit is deliberately *not* offered: the whole readability
 * of a tile-grid world depends on the grid meeting the screen at a constant
 * angle, and letting the player tilt off it makes walls, distances and reachable
 * tiles ambiguous. The reference game snaps for the same reason.
 *
 * Rotation and zoom animate between their snapped values rather than popping —
 * the discipline is on the *resting* states, not the transitions.
 */
import { OrthographicCamera, MathUtils, Vector3 } from 'three';

/**
 * Pitch above the horizon. A true isometric projection is atan(1/√2) ≈ 35.26°;
 * the reference game's 2:1 pixel ratio is atan(1/2) ≈ 26.57°. We sit between
 * them: shallow enough that walls and facades stay tall and legible, steep
 * enough to see over them into the next room.
 */
export const ISO_PITCH = MathUtils.degToRad(31);

/** The zoom ladder, in world-metres of vertical view height. */
export const ZOOM_STEPS = [10, 14, 20, 28, 40, 56];
const DEFAULT_ZOOM = 2;

/** How far back the camera sits. Orthographic, so this only affects clipping. */
const RIG_DISTANCE = 120;

export class IsoCamera {
  constructor({ aspect = 16 / 9 } = {}) {
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 400);

    /** Quarter-turns east of the default facing. Always an integer. */
    this.rotationStep = 0;
    /** Index into ZOOM_STEPS. Always an integer. */
    this.zoomStep = DEFAULT_ZOOM;

    /** Eased values that chase the snapped targets. */
    this._yaw = this.targetYaw;
    this._viewHeight = ZOOM_STEPS[this.zoomStep];

    /** What the camera looks at, in world space. */
    this.target = new Vector3(0, 0, 0);
    this._smoothTarget = new Vector3(0, 0, 0);

    /** Seconds to reach ~63% of the way to a new rotation / zoom. */
    this.rotationLag = 0.16;
    this.zoomLag = 0.12;
    this.followLag = 0.09;

    this.aspect = aspect;
    this._offset = new Vector3();
    this.setAspect(aspect);
    this.snapTo(this.target);
  }

  /** The yaw the rig is currently easing toward. */
  get targetYaw() {
    // The default facing looks north-east down the grid, which puts tile edges
    // at a consistent screen angle and keeps text-free geometry readable.
    return Math.PI * 0.25 + this.rotationStep * Math.PI * 0.5;
  }

  get viewHeight() {
    return ZOOM_STEPS[this.zoomStep];
  }

  setAspect(aspect) {
    this.aspect = aspect;
    this._applyFrustum();
  }

  _applyFrustum() {
    const h = this._viewHeight / 2;
    const w = h * this.aspect;
    const cam = this.camera;
    cam.left = -w;
    cam.right = w;
    cam.top = h;
    cam.bottom = -h;
    cam.updateProjectionMatrix();
  }

  /** Rotate by whole quarter-turns. Positive is clockwise on screen. */
  rotate(steps = 1) {
    this.rotationStep += steps;
  }

  /** Step the zoom ladder. Positive zooms out. */
  zoom(steps = 1) {
    this.zoomStep = MathUtils.clamp(this.zoomStep + steps, 0, ZOOM_STEPS.length - 1);
  }

  /** Jump straight to a target with no easing — for teleports and first frame. */
  snapTo(position) {
    this.target.copy(position);
    this._smoothTarget.copy(position);
    this._yaw = this.targetYaw;
    this._viewHeight = this.viewHeight;
    this._applyFrustum();
    this._place();
  }

  /**
   * @param {number} dt seconds
   * @param {Vector3} [follow] world position to track
   */
  update(dt, follow) {
    if (follow) this.target.copy(follow);

    // Exponential smoothing, framerate-independent: the fraction remaining
    // after dt seconds is lag^(dt/lag)-style rather than a fixed lerp factor.
    const k = (lag) => 1 - Math.exp(-dt / Math.max(lag, 1e-4));

    this._smoothTarget.lerp(this.target, k(this.followLag));

    // Shortest-path yaw easing, so turning from 315° to 45° goes the short way.
    const dYaw = wrapAngle(this.targetYaw - this._yaw);
    this._yaw += dYaw * k(this.rotationLag);

    const targetHeight = this.viewHeight;
    if (Math.abs(targetHeight - this._viewHeight) > 1e-3) {
      this._viewHeight += (targetHeight - this._viewHeight) * k(this.zoomLag);
      this._applyFrustum();
    }

    this._place();
  }

  _place() {
    const cosP = Math.cos(ISO_PITCH);
    const sinP = Math.sin(ISO_PITCH);
    this._offset.set(Math.sin(this._yaw) * cosP, sinP, Math.cos(this._yaw) * cosP);
    this.camera.position.copy(this._smoothTarget).addScaledVector(this._offset, RIG_DISTANCE);
    this.camera.lookAt(this._smoothTarget);
    this.camera.updateMatrixWorld();
  }

  /**
   * Screen-space movement basis, so "press W" means "up the screen" regardless
   * of which quarter-turn the camera is on. Returns unit vectors on the XZ
   * plane. Without this, rotating the camera silently rebinds the movement keys.
   *
   * @returns {{ forward: Vector3, right: Vector3 }}
   */
  screenBasis(forward = new Vector3(), right = new Vector3()) {
    // "Up the screen" is the horizontal projection of the camera's view
    // direction, which is the negated rig offset flattened onto XZ.
    forward.set(-this._offset.x, 0, -this._offset.z).normalize();
    // Screen right is cross(viewDir, worldUp), matching how three.js's lookAt
    // builds the camera's local X axis.
    right.set(-forward.z, 0, forward.x);
    return { forward, right };
  }

  /** True once rotation and zoom have settled — useful for screenshot tests. */
  get isSettled() {
    return (
      Math.abs(wrapAngle(this.targetYaw - this._yaw)) < 1e-3 &&
      Math.abs(this.viewHeight - this._viewHeight) < 1e-3
    );
  }
}

/** Wrap to (−π, π]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
