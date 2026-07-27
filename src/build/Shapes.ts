import * as THREE from 'three';
import { SPINE_ATTRIBUTE } from '../shading/Toon';

/**
 * Geometry primitives for growing creatures.
 *
 * Everything here is generated rather than loaded, and everything carries the
 * spine attribute the toon shader needs, because a geometry that reaches the
 * renderer without it does not fail loudly — it fails as a broken draw call.
 */

/** A ring of points around the local Y axis, squashed on Z by `flatten`. */
function ring(
  out: number[],
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  flatten: number,
  segments: number,
): void {
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius * flatten, cz);
  }
}

/**
 * A tube swept along +Z with a varying radius.
 *
 * Returned un-indexed positions plus a matching index buffer: the body mesh
 * rewrites its vertex positions every frame as the spine bends, and an indexed
 * buffer means each ring's vertices exist once and the rewrite is O(rings).
 */
export function tubeGeometry(
  rings: number,
  segments: number,
  radiusAt: (t: number) => number,
  zAt: (t: number) => number,
  flatten: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const spine: number[] = [];
  for (let r = 0; r < rings; r++) {
    const t = r / (rings - 1);
    ring(positions, 0, 0, zAt(t), radiusAt(t), flatten, segments);
    for (let i = 0; i < segments; i++) spine.push(t);
  }
  // Caps as single points at each end.
  positions.push(0, 0, zAt(0));
  spine.push(0);
  positions.push(0, 0, zAt(1));
  spine.push(1);
  const tailCap = rings * segments;
  const noseCap = tailCap + 1;

  const index: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let i = 0; i < segments; i++) {
      const a = r * segments + i;
      const b = r * segments + ((i + 1) % segments);
      const c = (r + 1) * segments + i;
      const d = (r + 1) * segments + ((i + 1) % segments);
      // Rings wind anticlockwise in XY and advance on +Z, so the quad has to
      // run a -> b -> c to put its normal outward. The other ordering is the
      // one that reads naturally and it turns the whole body inside out: the
      // tube lights from within and every creature renders as a black hole
      // with correctly shaded limbs attached to it.
      index.push(a, b, c, b, d, c);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i;
    const b = (i + 1) % segments;
    index.push(tailCap, b, a);
    const c = (rings - 1) * segments + i;
    const d = (rings - 1) * segments + ((i + 1) % segments);
    index.push(noseCap, c, d);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute(SPINE_ATTRIBUTE, new THREE.Float32BufferAttribute(spine, 1));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A deformed sphere — the base of every head, eye, pad and blob.
 *
 * `squash` scales Y, `stretch` scales Z, and `taper` narrows one end, which
 * between them covers snouts, skulls, eyeballs and bellies without a separate
 * primitive for each.
 */
export function blob(
  radius: number,
  opts: { squash?: number; stretch?: number; taper?: number; segments?: number } = {},
): THREE.BufferGeometry {
  const segments = opts.segments ?? 16;
  const geo = new THREE.SphereGeometry(radius, segments, Math.max(8, segments * 0.66));
  const pos = geo.getAttribute('position');
  const squash = opts.squash ?? 1;
  const stretch = opts.stretch ?? 1;
  const taper = opts.taper ?? 0;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i) * stretch;
    // Taper toward +Z, normalised so the far end pinches rather than shifts.
    const k = 1 - taper * ((z / (radius * stretch)) * 0.5 + 0.5);
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * squash * k, z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** A tapered limb segment: a capsule-ish cone running down -Y. */
export function boneGeometry(length: number, topRadius: number, bottomRadius: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(topRadius, bottomRadius, length, 10, 1, false);
  // Bones run down -Y with the joint at the origin, so the body of the
  // cylinder has to hang below rather than straddle it.
  geo.translate(0, -length / 2, 0);
  return geo;
}

/** A spike or horn: a cone running down -Y from its base at the origin. */
export function spikeGeometry(length: number, radius: number, curve: number, segments = 7): THREE.BufferGeometry {
  const rings = 6;
  const positions: number[] = [];
  const index: number[] = [];
  for (let r = 0; r < rings; r++) {
    const t = r / (rings - 1);
    const rad = radius * Math.pow(1 - t, 0.75);
    // Curve sweeps the tip forward on Z as it rises.
    const z = curve * t * t * length;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(Math.cos(a) * rad, -t * length, z + Math.sin(a) * rad);
    }
  }
  positions.push(0, -length, curve * length);
  const tip = rings * segments;
  // Same winding rule as the tube, and it caught the same bug: horns, teeth,
  // claws and wing fingers were all shading from the inside.
  for (let r = 0; r < rings - 1; r++) {
    for (let i = 0; i < segments; i++) {
      const a = r * segments + i;
      const b = r * segments + ((i + 1) % segments);
      const c = (r + 1) * segments + i;
      const d = (r + 1) * segments + ((i + 1) % segments);
      index.push(a, b, c, b, d, c);
    }
  }
  for (let i = 0; i < segments; i++) {
    const c = (rings - 1) * segments + i;
    const d = (rings - 1) * segments + ((i + 1) % segments);
    index.push(tip, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A membrane panel for wings and fins: a quad grid bowed along its span so it
 * catches light like a sail rather than a sheet of paper.
 */
export function membraneGeometry(span: number, chord: number, sag: number): THREE.BufferGeometry {
  const nx = 6;
  const ny = 5;
  const geo = new THREE.PlaneGeometry(span, chord, nx, ny);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) / (span / 2);
    const v = pos.getY(i) / (chord / 2);
    // Scallop the trailing edge, the way a bat wing runs between fingers.
    const scallop = Math.abs(Math.sin(u * Math.PI * 1.5)) * chord * 0.09;
    pos.setY(i, pos.getY(i) + (v < 0 ? scallop : 0));
    pos.setZ(i, -sag * (1 - u * u) * (1 - v * v));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** A flat plate — scutes, frills, fins. Lies in XY, thickness on Z. */
export function plateGeometry(width: number, height: number, thickness: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(width, height, thickness, 1, 2, 1);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    // Taper the top edge to a ridge.
    const t = (pos.getY(i) + height / 2) / height;
    pos.setX(i, pos.getX(i) * (1 - t * 0.55));
    pos.setZ(i, pos.getZ(i) * (1 - t * 0.7));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Attaches a mesh plus its outline hull.
 *
 * Every visible mesh gets a back-face twin, so the outline is built once at the
 * same place the mesh is, and nothing can be added to the creature and silently
 * come out un-outlined.
 */
export function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  outline: THREE.Material | null,
  spine: number,
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  if (!geometry.getAttribute(SPINE_ATTRIBUTE)) {
    const count = geometry.getAttribute('position').count;
    const data = new Float32Array(count);
    data.fill(spine);
    geometry.setAttribute(SPINE_ATTRIBUTE, new THREE.BufferAttribute(data, 1));
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  if (outline) {
    const hull = new THREE.Mesh(geometry, outline);
    hull.position.copy(mesh.position);
    hull.rotation.copy(mesh.rotation);
    hull.scale.copy(mesh.scale);
    hull.castShadow = false;
    hull.receiveShadow = false;
    // Drawn before the surface so it never sorts in front of a neighbour.
    hull.renderOrder = -1;
    parent.add(hull);
  }
  return mesh;
}
