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
}

/**
 * Skins a run of rectangular cross-sections into a closed hull.
 *
 * Triangles are emitted un-indexed so `computeVertexNormals` gives flat,
 * per-facet shading — which is exactly the faceted panel look the rest of the
 * template is built in, and it keeps every hull a single cheap geometry.
 */
export function loft(sections: Section[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];

  const corners = (s: Section): THREE.Vector3[] => [
    new THREE.Vector3(-s.halfWidth, s.bottom, s.z),
    new THREE.Vector3(s.halfWidth, s.bottom, s.z),
    new THREE.Vector3(s.halfWidth, s.top, s.z),
    new THREE.Vector3(-s.halfWidth, s.top, s.z),
  ];

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
    quad(a[0], a[1], b[1], b[0]); // bottom
    quad(a[1], a[2], b[2], b[1]); // right
    quad(a[2], a[3], b[3], b[2]); // top
    quad(a[3], a[0], b[0], b[3]); // left
  }

  // End caps, wound outward.
  const first = corners(sections[0]);
  quad(first[0], first[3], first[2], first[1]);
  const last = corners(sections[sections.length - 1]);
  quad(last[0], last[1], last[2], last[3]);

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
