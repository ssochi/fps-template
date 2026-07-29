/**
 * A procedurally built, procedurally animated humanoid.
 *
 * ## Rigid parts, not a SkinnedMesh
 *
 * The blueprint called for a `SkinnedMesh` player. Building it, that turns out
 * to buy nothing here: skinning exists to make *surfaces* deform smoothly across
 * a joint, and at the zoom ladder this camera actually uses — 10 m of view height
 * at the closest step — a shoulder seam is under two pixels. A hierarchy of
 * rigid boxes gives identical animation control with no bind matrices, no
 * weight painting, and no per-frame skinning cost, and it stays compatible with
 * everything M5 needs, since the horde's vertex-animation textures bake out of
 * whatever poses these bones are in.
 *
 * Revisit if the camera ever gains a close-up.
 *
 * ## Animation is a function of phase, not a clip
 *
 * There are no keyframes. A gait is a set of sine offsets over a normalised
 * phase, which means walk, run and sneak are the *same* function with different
 * amplitudes and frequencies, and blending between them is arithmetic rather
 * than a crossfade. Feet are then pinned to the floor by construction rather
 * than by tuning the clip's playback speed against the movement speed — the
 * usual cause of characters that ice-skate.
 */
import { BoxGeometry, Group, Mesh, MeshLambertMaterial, Color } from 'three';

/** Body proportions in metres. Roughly a 1.8 m adult. */
const P = {
  hipY: 0.92,
  torso: { w: 0.42, h: 0.62, d: 0.24 },
  head: { w: 0.24, h: 0.26, d: 0.24 },
  neck: 0.1,
  upperArm: { w: 0.11, h: 0.3, d: 0.12 },
  lowerArm: { w: 0.1, h: 0.28, d: 0.11 },
  upperLeg: { w: 0.15, h: 0.44, d: 0.16 },
  lowerLeg: { w: 0.13, h: 0.44, d: 0.14 },
  shoulderX: 0.26,
  hipX: 0.11,
};

/**
 * Gait parameters.
 *
 * `stride` is **metres covered per full gait cycle** (left step + right step),
 * and the phase advances with distance rather than wall-clock time. That is what
 * keeps the feet planted at any speed — but it also means the units matter: a
 * stride of 0.5 m does not mean "slow", it means the legs cycle twice per metre.
 * Real figures: ~1.5 m per cycle walking, ~3 m running.
 *
 * `swing` is the thigh's peak rotation in radians. Anything past ~0.8 rad (46°)
 * stops reading as running and starts reading as the splits.
 */
export const GAITS = {
  idle: { stride: 0, swing: 0, bob: 0.006, lean: 0, armSwing: 0, crouch: 0 },
  sneak: { stride: 1.0, swing: 0.34, bob: 0.02, lean: 0.12, armSwing: 0.18, crouch: 0.18 },
  walk: { stride: 1.55, swing: 0.55, bob: 0.035, lean: 0.04, armSwing: 0.42, crouch: 0 },
  run: { stride: 3.0, swing: 0.78, bob: 0.06, lean: 0.13, armSwing: 0.66, crouch: 0 },

  // The dead move wrong on purpose: a short dragging stride, almost no arm
  // counter-swing, and a forward lean the living would fall over from. Silhouette
  // is the only thing that reads at this camera distance, so the difference has
  // to be in the pose rather than in any detail.
  shamble: { stride: 0.95, swing: 0.36, bob: 0.05, lean: 0.12, armSwing: 0.08, crouch: 0.06 },
  lunge: { stride: 2.4, swing: 0.72, bob: 0.07, lean: 0.19, armSwing: 0.14, crouch: 0 },
};

/**
 * A limb segment that rotates about its *top* edge.
 *
 * A box mesh is centred on its own origin, so rotating one directly swings it
 * about its middle and the joint visibly detaches. Offsetting the mesh half its
 * length below a pivot `Group` is what makes the rotation happen at the joint.
 */
function segment(size, material, parent, x, y, z) {
  const pivot = new Group();
  pivot.position.set(x, y, z);
  const mesh = new Mesh(new BoxGeometry(size.w, size.h, size.d), material);
  mesh.position.y = -size.h / 2;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  pivot.add(mesh);
  parent.add(pivot);
  return pivot;
}

export class Character {
  /**
   * @param {{ skin?: number, shirt?: number, trousers?: number, hair?: number }} [colors]
   */
  constructor(colors = {}) {
    const skin = new MeshLambertMaterial({ color: new Color(colors.skin ?? 0xc9a184) });
    const shirt = new MeshLambertMaterial({ color: new Color(colors.shirt ?? 0x5f8592) });
    const trousers = new MeshLambertMaterial({ color: new Color(colors.trousers ?? 0x4d5262) });
    const hair = new MeshLambertMaterial({ color: new Color(colors.hair ?? 0x3a2b22) });
    this.materials = [skin, shirt, trousers, hair];

    this.root = new Group();
    this.root.name = 'character';

    // Hips carry the whole body, so bob and crouch are one write.
    this.hips = new Group();
    this.hips.position.y = P.hipY;
    this.root.add(this.hips);

    const torso = new Mesh(new BoxGeometry(P.torso.w, P.torso.h, P.torso.d), shirt);
    torso.position.y = P.torso.h / 2;
    torso.castShadow = true;
    torso.receiveShadow = true;
    this.hips.add(torso);
    this.torso = torso;

    const headY = P.torso.h + P.neck + P.head.h / 2;
    this.head = new Mesh(new BoxGeometry(P.head.w, P.head.h, P.head.d), skin);
    this.head.position.y = headY;
    this.head.castShadow = true;
    this.hips.add(this.head);

    // --- which way is this person facing? -------------------------------
    //
    // The rig shipped with a head that was a plain box, so the front and the
    // back of a survivor were the same six-pixel silhouette and there was no
    // way at all to tell which way they were pointing. That was reported as
    // "the facing controls feel awkward", which it is not — the facing has
    // always been correct, it was *invisible*, and no amount of control tuning
    // would have fixed a body with no front.
    //
    // Three marks, all of them cheap, and all of them chosen because they read
    // at a hundred pixels tall: hair that stops at the hairline instead of
    // wrapping the whole skull, two dark eyes, and a collar. The horde shares
    // this rig, so the dead get faces too — and, more usefully, a direction you
    // can read before they reach you.

    // Hair covers the crown and the back, and stops short of the face.
    const cap = new Mesh(new BoxGeometry(P.head.w + 0.02, 0.07, P.head.d + 0.02), hair);
    cap.position.y = headY + P.head.h / 2 - 0.02;
    cap.castShadow = true;
    this.hips.add(cap);

    const backHair = new Mesh(new BoxGeometry(P.head.w + 0.02, P.head.h * 0.72, 0.045), hair);
    backHair.position.set(0, headY + 0.01, P.head.d / 2);
    this.hips.add(backHair);

    // Forward is −Z, so the face is on the −Z side of the head.
    const faceZ = -P.head.d / 2 - 0.011;
    const eyeGeo = new BoxGeometry(0.055, 0.045, 0.02);
    const eyeMaterial = new MeshLambertMaterial({ color: new Color(0x1d1a18) });
    this.materials.push(eyeMaterial);
    for (const side of [-1, 1]) {
      const eye = new Mesh(eyeGeo, eyeMaterial);
      eye.position.set(side * 0.055, headY + 0.025, faceZ);
      this.hips.add(eye);
    }

    // A collar, so the *body* has a front as well as the head — at the widest
    // zoom the head is three pixels and the torso is the only thing readable.
    const collar = new Mesh(new BoxGeometry(P.torso.w * 0.62, 0.07, 0.03), eyeMaterial);
    collar.position.set(0, P.torso.h - 0.05, -P.torso.d / 2 - 0.016);
    this.hips.add(collar);

    const shoulderY = P.torso.h - 0.06;
    this.armL = segment(P.upperArm, shirt, this.hips, -P.shoulderX, shoulderY, 0);
    this.armR = segment(P.upperArm, shirt, this.hips, P.shoulderX, shoulderY, 0);
    this.forearmL = segment(P.lowerArm, skin, this.armL, 0, -P.upperArm.h, 0);
    this.forearmR = segment(P.lowerArm, skin, this.armR, 0, -P.upperArm.h, 0);

    this.legL = segment(P.upperLeg, trousers, this.hips, -P.hipX, 0, 0);
    this.legR = segment(P.upperLeg, trousers, this.hips, P.hipX, 0, 0);
    this.shinL = segment(P.lowerLeg, trousers, this.legL, 0, -P.upperLeg.h, 0);
    this.shinR = segment(P.lowerLeg, trousers, this.legR, 0, -P.upperLeg.h, 0);

    /** Distance travelled, in metres. Drives the gait phase. */
    this.distance = 0;
    /** Seconds, for the idle sway which is not distance-driven. */
    this.clock = 0;
    this._gait = 'idle';
    this._blend = 0;
  }

  /**
   * @param {number} dt seconds
   * @param {number} speed metres per second the character is actually moving
   * @param {keyof GAITS} gait
   */
  update(dt, speed, gait) {
    this.clock += dt;
    this.distance += speed * dt;
    this._gait = gait;

    const g = GAITS[gait] ?? GAITS.idle;

    // Phase advances with distance, so the feet stay planted regardless of
    // speed. This is the whole reason the character never ice-skates.
    const phase = g.stride > 0 ? (this.distance / g.stride) * Math.PI * 2 : this.clock * 1.4;

    // Amplitude fades in with speed so a character easing to a stop settles
    // rather than snapping from mid-stride to a T-pose.
    const moving = Math.min(1, speed / 1.2);
    this._blend += (moving - this._blend) * Math.min(1, dt * 12);

    this.applyPose(phase, gait, this._blend);
  }

  /**
   * Set the whole rig from a phase directly, with no time integration.
   *
   * Split out of `update` so the same pose function can be sampled at arbitrary
   * points rather than only stepped forward — which is what the horde's
   * animation baker needs. Two pose functions, one for play and one for baking,
   * would drift apart the first time either was tuned.
   *
   * @param {number} phase radians; a full gait cycle is 2π
   * @param {keyof GAITS} gait
   * @param {number} a amplitude, 0 = neutral stance, 1 = full stride
   */
  applyPose(phase, gait, a = 1) {
    const g = GAITS[gait] ?? GAITS.idle;
    const swing = Math.sin(phase);
    const swingOpp = Math.sin(phase + Math.PI);

    this.legL.rotation.x = swing * g.swing * a;
    this.legR.rotation.x = swingOpp * g.swing * a;
    // Knees only bend backwards, and only on the return half of the stride.
    this.shinL.rotation.x = Math.max(0, -swing) * g.swing * 0.95 * a;
    this.shinR.rotation.x = Math.max(0, -swingOpp) * g.swing * 0.95 * a;

    // Arms counter-swing against the legs.
    this.armL.rotation.x = swingOpp * g.armSwing * a;
    this.armR.rotation.x = swing * g.armSwing * a;
    this.forearmL.rotation.x = -0.25 - Math.max(0, swingOpp) * 0.5 * a;
    this.forearmR.rotation.x = -0.25 - Math.max(0, swing) * 0.5 * a;

    // Two bobs per stride — the body rises on each footfall, not each cycle.
    const bob = Math.abs(Math.cos(phase)) * g.bob * a;
    this.hips.position.y = P.hipY - g.crouch * a - bob;
    this.hips.rotation.x = g.lean * a;

    // Idle sway, so a standing character is not a statue. Driven by the phase
    // rather than the clock so a baked pose is reproducible from its phase alone.
    if (a < 0.25) {
      const breath = Math.sin(phase * 0.5) * 0.012;
      this.hips.position.y += breath * (1 - a);
      this.torso.rotation.z = Math.sin(phase * 0.22) * 0.01 * (1 - a);
    } else {
      this.torso.rotation.z = 0;
    }
  }

  /**
   * The dead do not carry their arms like the living. Applied on top of a pose,
   * so the underlying gait maths stays shared with the player.
   *
   * @param {number} reach 0 = arms hanging, 1 = arms out in front
   */
  applyUndeadArms(reach, phase = 0) {
    const droop = -0.15 + Math.sin(phase) * 0.05;
    this.armL.rotation.x = droop - reach * 1.05;
    this.armR.rotation.x = droop - reach * 1.05;
    this.armL.rotation.z = 0.16 + reach * 0.1;
    this.armR.rotation.z = -0.16 - reach * 0.1;
    this.forearmL.rotation.x = -0.5 + reach * 0.35;
    this.forearmR.rotation.x = -0.5 + reach * 0.35;
    this.head.rotation.x = 0.18 * (1 - reach) + 0.05;
  }

  /** Turn the head and torso toward an aim yaw relative to the body's facing. */
  look(relativeYaw) {
    // Split the twist between torso and head so the whole body doesn't snap.
    const clamped = Math.max(-1.1, Math.min(1.1, relativeYaw));
    this.torso.rotation.y = clamped * 0.35;
    this.head.rotation.y = clamped * 0.65;
  }

  dispose() {
    this.root.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
  }
}

export { P as PROPORTIONS };
