/**
 * The "you are here" marker.
 *
 * ## The problem it solves
 *
 * At this camera angle a survivor standing behind their own house is completely
 * invisible, and the very first frame of a new game is exactly that: the spawn
 * point is beside a building, the building is between the player and the lens,
 * and the screen shows a town with nobody in it. The cutaway from M4 does not
 * help, because it removes the walls of the room you are *inside* — it has
 * nothing to say about a wall you are merely standing behind.
 *
 * ## How
 *
 * Two pieces, both cheap:
 *
 *   - **A silhouette**, drawn with `depthFunc = GreaterDepth`. That is the whole
 *     trick: the shape is rendered *only where something is already in front of
 *     it*, so it is invisible when you can see the character and shows through
 *     the wall when you cannot. No occlusion test, no raycast, no per-frame
 *     logic — the depth buffer already knows the answer and this asks it.
 *
 *   - **A ring on the ground**, always drawn. It reads as a shadow you can
 *     trust, and it is what makes a stationary character findable in a street
 *     full of identical bodies.
 *
 * Both are unlit `MeshBasicMaterial` on purpose: this is signage, not scenery,
 * and it must look the same at midnight as at noon.
 */
import {
  BoxGeometry,
  GreaterDepth,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
} from 'three';

/** The colour reserved for "this one is you". Nothing else in the world is cyan. */
export const MARKER_COLOR = 0x7fd8ff;

/**
 * Draw order. The world is 0 by default and the character is pushed to
 * {@link CHARACTER_ORDER}, so the silhouette sits between them.
 */
export const MARKER_ORDER = 1;
export const CHARACTER_ORDER = 2;

export class Marker {
  constructor({ color = MARKER_COLOR } = {}) {
    this.group = new Group();
    this.group.name = 'marker';

    // --- the silhouette -------------------------------------------------
    // Two boxes rather than a copy of the eleven-part rig: through a wall you
    // need to read *where a person is*, not what their elbows are doing, and
    // two draw calls is the right price for that.
    // Opaque on purpose. A transparent material lands in three.js's transparent
    // pass, which runs after *everything* opaque — including the character
    // itself — so the silhouette would test against the character's own limbs
    // and show as slivers between them. Opaque plus an explicit `renderOrder`
    // puts it between the world and the body: it sees the wall's depth and not
    // its owner's.
    this.through = new MeshBasicMaterial({
      color,
      depthFunc: GreaterDepth,
      depthWrite: false,
      depthTest: true,
    });

    // Sized to sit *inside* the torso, above the gap between the legs. Anything
    // lower shows through that gap, where there is no character geometry to
    // hide it and the ground behind is further away — technically correct, and
    // it reads as a glowing patch under a visible survivor.
    const body = new Mesh(new BoxGeometry(0.34, 0.62, 0.22), this.through);
    body.position.y = 1.16;
    body.renderOrder = MARKER_ORDER;
    this.group.add(body);

    const head = new Mesh(new BoxGeometry(0.28, 0.28, 0.28), this.through);
    head.position.y = 1.58;
    head.renderOrder = MARKER_ORDER;
    this.group.add(head);

    // --- the ring -------------------------------------------------------
    // Always visible, including through the floor you are standing on, because
    // its whole job is to be findable.
    this.ringMaterial = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.4,
      depthTest: false,
      depthWrite: false,
    });
    const ring = new Mesh(new RingGeometry(0.34, 0.42, 24), this.ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.renderOrder = 7;
    this.group.add(ring);

    this.ring = ring;
  }

  /** Fade the whole marker, so a dead player's marker can be turned off. */
  setVisible(on) {
    this.group.visible = on;
  }

  dispose() {
    this.through.dispose();
    this.ringMaterial.dispose();
    for (const child of this.group.children) child.geometry.dispose();
  }
}
