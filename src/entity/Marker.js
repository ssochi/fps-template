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
 *   - **A silhouette** of the survivor's own animated body, drawn over
 *     everything, and shown only while a line-of-sight cast from them toward
 *     the camera is blocked. See the note in the constructor for why this is
 *     decided on the CPU rather than with a depth-function trick.
 *
 *   - **A ring on the ground**, always drawn. It reads as a shadow you can
 *     trust, and it is what makes a stationary character findable in a street
 *     full of identical bodies.
 *
 *   - **A heading notch** on the ring. The marker is a child of the entity, so
 *     it inherits the yaw for free.
 *
 * All unlit `MeshBasicMaterial` on purpose: this is signage, not scenery, and it
 * must look the same at midnight as at noon.
 */
import {
  BoxGeometry,
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
} from 'three';

/** The colour reserved for "this one is you". Nothing else in the world is cyan. */
export const MARKER_COLOR = 0x7fd8ff;

/** Draw order: world (0), body, then the silhouette straight over the top. */
export const CHARACTER_ORDER = 1;
export const MARKER_ORDER = 8;

/**
 * Cubic metres below which a body part is not worth an extra draw call in the
 * silhouette. Keeps the torso, the head and the legs; drops the eyes, the
 * collar and the forearms.
 */
const MIN_SILHOUETTE_VOLUME = 0.006;

export class Marker {
  constructor({ color = MARKER_COLOR } = {}) {
    this.group = new Group();
    this.group.name = 'marker';

    // --- the silhouette -------------------------------------------------
    //
    // Drawn straight over everything, and shown only when the game says the
    // survivor is actually hidden.
    //
    // M14 and M15 both tried to make the *depth buffer* answer "is this
    // occluded", with `depthFunc = GreaterDepth` on a mesh sharing the body's
    // geometry. It is a lovely trick and it does not survive contact: the ghost
    // and the body are drawn by different shader programs, GLSL makes no
    // promise that two programs computing the same transform agree in the last
    // bit, and without `invariant gl_Position` the comparison goes either way
    // per pixel. The result was a survivor painted cyan while standing in plain
    // sight — with the render order provably correct, a matching material class
    // and a polygon offset all failing to rescue it.
    //
    // The game already knows the answer. `sim/Sight.js` has cast rays across
    // this grid since M4; casting one from the survivor toward the camera is a
    // handful of tile lookups and it is *exact*. So the visibility is decided on
    // the CPU, by the same code the horde uses to decide whether it can see you,
    // and the shader does nothing clever at all.
    this.through = new MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    });

    // --- the ring -------------------------------------------------------
    // Always visible, including through the floor you are standing on, because
    // its whole job is to be findable.
    this.ringMaterial = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      depthWrite: false,
    });
    const ring = new Mesh(new RingGeometry(0.34, 0.42, 24), this.ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.renderOrder = 7;
    this.group.add(ring);

    this.ring = ring;

    // --- which way am I pointing? ---------------------------------------
    // A notch on the ring, at the front. The marker group is a child of the
    // entity, so this inherits the yaw for free and there is nothing to keep
    // in sync. Between this and the character's face, heading is legible at
    // every zoom step: the face reads up close, the notch reads when the
    // survivor is thirty pixels tall.
    const notch = new Mesh(new CircleGeometry(0.13, 3), this.ringMaterial);
    notch.rotation.x = -Math.PI / 2;
    // A three-segment circle is a triangle; this rotation points its apex at
    // −Z, which is the convention `Entity.js` uses for forward.
    notch.rotation.z = Math.PI / 2;
    notch.position.set(0, 0.03, -0.52);
    notch.renderOrder = 7;
    this.group.add(notch);
    this.notch = notch;
  }

  /**
   * Give the silhouette the survivor's actual shape.
   *
   * M14 used two static boxes, on the reasoning that through a wall you need to
   * read *where* a person is rather than what their elbows are doing. M17 made
   * the cutaway stop at head height — correctly, so that doors and windows stay
   * readable — and that promoted the silhouette from a fallback to the main way
   * you see yourself behind a low wall. Two boxes is not enough for that job: a
   * cyan slab tells you nothing about which way you are pointing or whether you
   * are moving.
   *
   * So each large part of the rig gets a sibling mesh sharing its geometry,
   * added as a *child* so it inherits the animated world matrix for free —
   * there is nothing to keep in sync, and the silhouette walks, turns and
   * staggers exactly as the body does.
   *
   * Only the parts that read at this size: torso, head, and the four leg
   * segments. Eyes, collar and forearms would be six more draw calls spent on
   * detail that is one pixel across.
   *
   * @param {import('./Character.js').Character} character
   */
  attachTo(character) {
    // Collected first, attached second. Adding a ghost during the walk means
    // `traverse` visits it, and a ghost shares its host's geometry — so it
    // passes the same size test, gets a ghost of its own, and recurses until
    // the stack gives out. Caught by every test in the suite at once.
    const hosts = [];
    character.root.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.parameters;
      if (!p || !p.width) return;
      if (p.width * p.height * p.depth < MIN_SILHOUETTE_VOLUME) return;
      hosts.push(o);
    });

    for (const host of hosts) {
      const ghost = new Mesh(host.geometry, this.through);
      ghost.renderOrder = MARKER_ORDER;
      host.add(ghost);
    }
    this.parts = hosts.length;
    this.ghosts = [];
    for (const host of hosts) {
      const ghost = host.children[host.children.length - 1];
      if (ghost.material === this.through) this.ghosts.push(ghost);
    }
    this.setOccluded(false);
    return hosts.length;
  }

  /**
   * Show or hide the silhouette. Driven from the frame loop by a line-of-sight
   * cast from the survivor toward the camera — see `World.isOccluded`.
   */
  setOccluded(occluded) {
    this.occluded = occluded;
    for (const ghost of this.ghosts ?? []) ghost.visible = occluded;
  }

  /** Fade the whole marker, so a dead player's marker can be turned off. */
  setVisible(on) {
    this.group.visible = on;
  }

  dispose() {
    this.through.dispose();
    this.ringMaterial.dispose();
    // Only the geometry this class made: the silhouette shares the character's.
    for (const child of this.group.children) child.geometry.dispose();
  }
}
