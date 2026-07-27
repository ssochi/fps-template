import * as THREE from 'three';

/**
 * Modelling primitives shared by every hand-built vehicle and mech.
 *
 * These live apart from the models themselves so a builder can be split into
 * its own file without importing the other builders — the Thor and the ground
 * vehicles both need `loft` and `mesh`, and neither should have to know the
 * other exists.
 */

export interface WheelNode {
  /** Steers about Y; sits at the wheel centre. */
  pivot: THREE.Group;
  /** Spins about X. The mirrored model lives inside, so both sides spin alike. */
  spinner: THREE.Group;
  radius: number;
  steered: boolean;
  /** Drives the suspension-travel offset applied by the vehicle system. */
  restY: number;
}

/** One articulated leg of a walking mech. */
export interface MechLeg {
  /** Rotates about X at the hip. */
  hip: THREE.Group;
  /** Rotates about X at the knee, inside `hip`. */
  knee: THREE.Group;
  /** Rotates about X at the ankle, inside `knee`; keeps the foot flat. */
  ankle: THREE.Group;
  /** Phase offset through the stride, 0..1. */
  phase: number;
}

/** Everything on a walking mech that articulates. */
export interface MechParts {
  /** Twists about Y on the chassis so the guns can lead the walk direction. */
  torso: THREE.Group;
  /** Elevates about X inside the torso; carries both arm cannons. */
  arms: THREE.Group;
  legs: MechLeg[];
  /** World anchors for the two cannon barrels, alternated when firing. */
  muzzles: THREE.Object3D[];
  /** World anchors for the shoulder missile pods. */
  podMuzzles: THREE.Object3D[];
}

/** Everything on a vehicle that moves independently of its hull. */
export interface VehicleParts {
  /** Static hull; safe to flatten to one mesh per material. */
  body: THREE.Group;
  wheels: WheelNode[];
  /** Tank only: traverses about Y. */
  turret: THREE.Group | null;
  /** Tank only: elevates about X, inside `turret`. */
  barrel: THREE.Group | null;
  /** Tank only: muzzle anchor for shells, inside `barrel`. */
  muzzle: THREE.Object3D | null;
  /** Walking mech only. */
  mech: MechParts | null;
}

export interface VehicleBuildResult {
  root: THREE.Group;
  parts: VehicleParts;
  /** Local-space collision boxes, `{ centre, size }`, for the caller to place. */
  colliders: { centre: THREE.Vector3; size: THREE.Vector3 }[];
  /** Overall bounds, handy for signage and camera framing. */
  size: THREE.Vector3;
  /** Local offset of the driver's eye, for the in-cab camera. */
  driverEye: THREE.Vector3;
  /** Local point the chase camera orbits. */
  cameraPivot: THREE.Vector3;
  /** Local offset the player is dropped at when they get out. */
  exitOffset: THREE.Vector3;
}

// --------------------------------------------------------------- primitives

export interface Section {
  /** Position along the vehicle's long axis. */
  z: number;
  halfWidth: number;
  bottom: number;
  top: number;
  /**
   * Corner cut, in metres. Zero keeps the plain rectangle every gameplay
   * vehicle is built from; a positive value turns the section into a decagon
   * with a defined shoulder, which is what makes a body read as sculpted
   * rather than as a slab with the corners left square.
   */
  chamfer?: number;
  /** Half-width at the top edge. Defaults to `halfWidth`; less gives tumblehome. */
  topHalfWidth?: number;
  /** Half-width at the sill. Defaults to `halfWidth`. */
  bottomHalfWidth?: number;
}

/**
 * Skins a run of cross-sections into a closed hull.
 *
 * Triangles are emitted un-indexed so `computeVertexNormals` gives flat,
 * per-facet shading — which is exactly the faceted panel look the rest of the
 * template is built in, and it keeps every hull a single cheap geometry.
 */
export function loft(sections: Section[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];

  // The ring is walked anticlockwise seen from -Z, starting at the bottom
  // left. A plain rectangle is emitted verbatim so existing hulls are
  // untouched; anything else expands to a shouldered decagon.
  const corners = (s: Section): THREE.Vector3[] => {
    const hw = s.halfWidth;
    const bw = s.bottomHalfWidth ?? hw;
    const tw = s.topHalfWidth ?? hw;
    // A chamfer larger than the section collapses the shoulder, the waist and
    // the sill onto one line: the ring keeps its ten points but three of them
    // coincide, and the degenerate triangles between them get whatever normal
    // floating-point noise hands out. Clamp instead of trusting the caller.
    const raw = s.chamfer ?? 0;
    const c = Math.max(0, Math.min(raw, (s.top - s.bottom) * 0.4, Math.min(bw, tw) * 0.4));
    const ring: [number, number][] =
      c <= 0 && bw === hw && tw === hw
        ? [
            [-hw, s.bottom],
            [hw, s.bottom],
            [hw, s.top],
            [-hw, s.top],
          ]
        : (() => {
            const mid = (s.bottom + s.top) / 2;
            return [
              [-(bw - c), s.bottom],
              [bw - c, s.bottom],
              [bw, s.bottom + c],
              [hw, mid],
              [tw, s.top - c],
              [tw - c, s.top],
              [-(tw - c), s.top],
              [-tw, s.top - c],
              [-hw, mid],
              [-bw, s.bottom + c],
            ];
          })();
    return ring.map(([x, y]) => new THREE.Vector3(x, y, s.z));
  };

  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
    for (const v of [a, b, c]) positions.push(v.x, v.y, v.z);
    for (const [u, w] of [
      [0, 0],
      [1, 0],
      [1, 1],
    ]) {
      uvs.push(u, w);
    }
  };

  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void => {
    for (const v of [a, b, c, a, c, d]) positions.push(v.x, v.y, v.z);
    // Cheap planar UVs — good enough for the noise-based materials in use.
    for (const [u, w] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
      [1, 1],
      [0, 1],
    ]) {
      uvs.push(u, w);
    }
  };

  // Each side walks its own cross-section first, *then* steps to the next one.
  // Going around the ring first (a[n] -> b[n] -> b[n+1]) is the obvious
  // ordering and is wrong: it winds every side inward, so back-face culling
  // removes the surfaces facing the viewer and you see straight through the
  // hull to the inside of its far wall. The end caps below are unaffected,
  // which is what makes it easy to miss.
  for (let i = 0; i < sections.length - 1; i++) {
    const a = corners(sections[i]);
    const b = corners(sections[i + 1]);
    for (let k = 0; k < a.length; k++) {
      const n = (k + 1) % a.length;
      quad(a[k], a[n], b[n], b[k]);
    }
  }

  // End caps, wound outward.
  //
  // A rectangle fans safely from a corner, and does so here exactly as the
  // rectangle-only version did, so no existing hull changes. A shouldered
  // section is only near-convex — inset a sill and the chamfer point becomes
  // reflex — and a corner fan then emits a back-facing sliver there. Fanning
  // from the centroid is correct for any section the ring's middle can see.
  const cap = (ring: THREE.Vector3[], outward: boolean): void => {
    const n = ring.length;
    if (n === 4) {
      if (outward) for (let k = 1; k < 3; k++) tri(ring[0], ring[k], ring[k + 1]);
      else for (let k = 2; k >= 1; k--) tri(ring[0], ring[k + 1], ring[k]);
      return;
    }
    const mid = new THREE.Vector3();
    for (const v of ring) mid.add(v);
    mid.divideScalar(n);
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      if (outward) tri(mid, ring[k], ring[j]);
      else tri(mid, ring[j], ring[k]);
    }
  };
  cap(corners(sections[0]), false);
  cap(corners(sections[sections.length - 1]), true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/** A swept tube through a set of points — roll cages, tow cables, bull bars. */
export function tube(points: [number, number, number][], radius: number, segments = 8): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  return new THREE.TubeGeometry(curve, Math.max(8, points.length * segments), radius, 7, false);
}

export function mesh(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.position.set(position[0], position[1], position[2]);
  m.rotation.set(rotation[0], rotation[1], rotation[2]);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/**
 * Hangs a wheel model on a steer pivot and a spin node.
 *
 * The mirrored model goes *inside* the spinner rather than on it, so the same
 * `spinner.rotation.x` turns both sides the same way in world space — mirroring
 * the spin node itself would have the left wheels rolling backwards.
 */
export function mountWheel(
  parent: THREE.Object3D,
  model: THREE.Group,
  position: [number, number, number],
  mirrored: boolean,
  radius: number,
  steered: boolean,
  out: WheelNode[],
): void {
  const pivot = new THREE.Group();
  pivot.position.set(position[0], position[1], position[2]);
  const spinner = new THREE.Group();
  if (mirrored) model.rotation.y = Math.PI;
  spinner.add(model);
  pivot.add(spinner);
  parent.add(pivot);
  out.push({ pivot, spinner, radius, steered, restY: position[1] });
}

/** Adds `build` twice, mirrored across the centreline. */
export function bothSides(build: (side: 1 | -1) => void): void {
  build(1);
  build(-1);
}

/** A cylinder lying on the X axis — the orientation every wheel and axle wants. */
export function axle(radiusTop: number, radiusBottom: number, length: number, segments = 20): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, segments);
  geo.rotateZ(Math.PI / 2);
  return geo;
}
