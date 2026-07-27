import * as THREE from 'three';
import type { BodyGene, PaletteGene } from '../genome/Genome';
import type { CreatureMaterials } from '../shading/Toon';
import { tubeGeometry } from './Shapes';
import { clamp, lerp } from '../core/MathUtils';

/**
 * The trunk: a chain of spine joints and a tube skinned to them.
 *
 * **Convention.** Spine bones run along local **+Z** (forward, toward the
 * nose); limb bones run down local **-Y**. Those differ because a spine really
 * does run forward and a limb really does hang down, and forcing one axis on
 * both makes every part builder carry a correction. Both are stated wherever
 * they matter — mixing them silently is the single most reliable way to build
 * a creature that walks backwards.
 *
 * The body mesh is not a skinned mesh. At this vertex count — a couple of
 * hundred — rewriting the ring positions from the joint matrices each frame is
 * cheaper than a skinning setup and far easier to reason about: there are no
 * bind poses, no weights to normalise, and the geometry is exactly where the
 * joints say it is.
 */

/**
 * The radius profile, as a pure function of the gene.
 *
 * Pure and exported because the builder has to know how thick the body will be
 * *before* the body exists, in order to work out how tall the creature stands.
 * Duplicating the expression there is how the two drift apart.
 *
 * One expression rather than a control-point curve, because every term has to
 * stay meaningful under mutation: taper the ends independently, swell or pinch
 * the middle, and never reach zero — a zero-radius ring collapses the tube's
 * normals and the shading goes black at that band.
 */
export function bodyRadiusAt(gene: BodyGene, t: number): number {
  const u = clamp(t, 0, 1);
  const ends = Math.sin(Math.PI * u) * 0.35 + 0.65;
  const taper = lerp(gene.taperTail, gene.taperHead, t);
  const belly = 1 + (gene.belly - 1) * Math.sin(Math.PI * u);
  return Math.max(0.02, gene.girth * gene.length * ends * taper * belly);
}

/** Widest point of the body, for ground clearance. */
export function widestRadius(gene: BodyGene): number {
  let widest = 0;
  for (let i = 0; i <= 12; i++) widest = Math.max(widest, bodyRadiusAt(gene, i / 12));
  return widest;
}

export interface BodySocket {
  node: THREE.Object3D;
  radius: number;
  spine: number;
  /** Distance from the socket down to the ground at rest. */
  standHeight: number;
}

export interface BodyResult {
  /** Yawed and positioned in the world by the animator. */
  root: THREE.Group;
  /** Carries the ride height and the walk bob, so the root stays on the floor. */
  carrier: THREE.Group;
  /** Rear (0) to front (n-1). */
  spine: THREE.Object3D[];
  segmentLength: number;
  totalLength: number;
  radiusAt: (t: number) => number;
  socketAt: (at: number, around: number, side: -1 | 0 | 1) => BodySocket;
  /** Rest height of the hips above the ground. */
  rideHeight: number;
  /** Rewrites the tube from the current joint transforms. Call after posing. */
  refresh: () => void;
  dispose: () => void;
}

const RADIAL_SEGMENTS = 12;

const _pos = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();

export function buildBody(
  gene: BodyGene,
  _palette: PaletteGene,
  materials: CreatureMaterials,
  rideHeight: number,
): BodyResult {
  const segments = Math.max(4, Math.round(gene.segments));
  const segmentLength = gene.length / (segments - 1);

  const radiusAt = (t: number): number => bodyRadiusAt(gene, t);

  const root = new THREE.Group();
  root.name = 'creature';
  const carrier = new THREE.Group();
  carrier.name = 'carrier';
  root.add(carrier);

  // Spine chain, rear to front. Each joint is a child of the one behind it, so
  // a bend at the hips carries the whole body forward of it.
  const spine: THREE.Object3D[] = [];
  for (let i = 0; i < segments; i++) {
    const joint = new THREE.Object3D();
    joint.name = `spine${i}`;
    if (i === 0) {
      // Centre the body on the root so it yaws about its middle.
      joint.position.set(0, 0, -gene.length / 2);
      carrier.add(joint);
    } else {
      joint.position.set(0, 0, segmentLength);
      // Rest arch, distributed evenly along the chain.
      joint.rotation.x = -gene.arch / (segments - 1);
      spine[i - 1].add(joint);
    }
    joint.userData.restRotationX = joint.rotation.x;
    spine.push(joint);
  }

  const geometry = tubeGeometry(
    segments,
    RADIAL_SEGMENTS,
    radiusAt,
    (t) => t * gene.length,
    gene.flatten,
  );
  const skin = new THREE.Mesh(geometry, materials.get('skin'));
  skin.castShadow = true;
  skin.receiveShadow = true;
  skin.frustumCulled = false;
  carrier.add(skin);

  const hull = new THREE.Mesh(geometry, materials.outline);
  hull.frustumCulled = false;
  hull.renderOrder = -1;
  carrier.add(hull);

  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const array = position.array as Float32Array;
  const localMatrices: THREE.Matrix4[] = spine.map(() => new THREE.Matrix4());

  /**
   * Rewrites every ring from the joints' carrier-space transforms.
   *
   * The matrices are accumulated down the chain rather than read from
   * `matrixWorld`, so this works before three.js has updated the graph and does
   * not need the carrier's inverse.
   */
  const refresh = (): void => {
    for (let i = 0; i < segments; i++) {
      spine[i].updateMatrix();
      if (i === 0) localMatrices[i].copy(spine[i].matrix);
      else localMatrices[i].multiplyMatrices(localMatrices[i - 1], spine[i].matrix);
    }
    let v = 0;
    for (let r = 0; r < segments; r++) {
      const t = r / (segments - 1);
      const radius = radiusAt(t);
      _m.copy(localMatrices[r]);
      _pos.setFromMatrixPosition(_m);
      _x.setFromMatrixColumn(_m, 0).normalize();
      _y.setFromMatrixColumn(_m, 1).normalize();
      for (let i = 0; i < RADIAL_SEGMENTS; i++) {
        const a = (i / RADIAL_SEGMENTS) * Math.PI * 2;
        const cx = Math.cos(a) * radius;
        const cy = Math.sin(a) * radius * gene.flatten;
        array[v++] = _pos.x + _x.x * cx + _y.x * cy;
        array[v++] = _pos.y + _x.y * cx + _y.y * cy;
        array[v++] = _pos.z + _x.z * cx + _y.z * cy;
      }
    }
    // The two cap vertices, on the axis at each end.
    _pos.setFromMatrixPosition(localMatrices[0]);
    _x.setFromMatrixColumn(localMatrices[0], 2).normalize().multiplyScalar(-radiusAt(0) * 0.8);
    array[v++] = _pos.x + _x.x;
    array[v++] = _pos.y + _x.y;
    array[v++] = _pos.z + _x.z;
    _pos.setFromMatrixPosition(localMatrices[segments - 1]);
    _x.setFromMatrixColumn(localMatrices[segments - 1], 2).normalize().multiplyScalar(radiusAt(1) * 0.8);
    array[v++] = _pos.x + _x.x;
    array[v++] = _pos.y + _x.y;
    array[v++] = _pos.z + _x.z;

    position.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  };


  /**
   * Places a socket on the body surface.
   *
   * `around` is measured from the belly: 0 is straight down, ±pi/2 is out to
   * the side, ±pi is on the back. A pair mirrors on X; a single stays on the
   * centreline and can therefore only be under or over the body, which is what
   * a dorsal fin or a belly plate wants anyway.
   */
  const socketAt = (at: number, around: number, side: -1 | 0 | 1): BodySocket => {
    const t = clamp(at, 0, 1);
    const exact = t * (segments - 1);
    const index = clamp(Math.round(exact), 0, segments - 1);
    const joint = spine[index];
    const radius = radiusAt(t);

    const node = new THREE.Object3D();
    node.name = `socket_${at.toFixed(2)}`;
    // Slide along the bone to hit the requested position between joints.
    node.position.z = (exact - index) * segmentLength;

    const lateral = side === 0 ? 0 : Math.sin(Math.abs(around)) * side;
    _d.set(lateral, -Math.cos(around), 0).normalize();
    node.position.x += _d.x * radius * 0.92;
    node.position.y += _d.y * radius * gene.flatten * 0.92;

    // Basis with local -Y along the outward direction and +Z as forward as it
    // can be, so a part built facing +Z still faces the creature's front.
    _y.copy(_d).negate();
    _fwd.set(0, 0, 1);
    _fwd.addScaledVector(_y, -_fwd.dot(_y));
    if (_fwd.lengthSq() < 1e-8) _fwd.set(1, 0, 0).addScaledVector(_y, -_y.x);
    _fwd.normalize();
    _x.crossVectors(_y, _fwd).normalize();
    _m.makeBasis(_x, _y, _fwd);
    node.quaternion.setFromRotationMatrix(_m);

    joint.add(node);
    return {
      node,
      radius,
      spine: t,
      standHeight: rideHeight + _d.y * radius * gene.flatten * 0.92,
    };
  };

  refresh();

  return {
    root,
    carrier,
    spine,
    segmentLength,
    totalLength: gene.length,
    radiusAt,
    socketAt,
    rideHeight,
    refresh,
    dispose: () => geometry.dispose(),
  };
}
