/**
 * Vertex Animation Textures — the horde's rendering technology.
 *
 * ## Why this and not skinning
 *
 * three.js's `SkinnedMesh` collapses at a few dozen animated characters, and
 * `InstancedMesh` does not support skinning at all. This genre needs *hundreds*
 * on screen. VAT trades flexibility for scale in exactly the way the horde
 * wants: every clip is baked once into a texture — one row per frame, one texel
 * per vertex — and the vertex shader reads a position straight out of it. The
 * whole horde is then a single `InstancedMesh`: **one draw call**, no matter how
 * many are walking around.
 *
 * The trade is that a baked clip cannot be blended or IK'd at runtime. For the
 * dead that costs nothing — they have a handful of short looping clips and never
 * need to aim at anything. The player, who does, stays a live rig.
 *
 * ## Why the clips are baked from the player's rig
 *
 * `Character` is the single body definition in this project. Baking from it
 * means the dead are visibly the same species as the living, and it means there
 * is no second pose function to drift out of sync with the first — the baker
 * calls `applyPose`, exactly as gameplay does.
 *
 * ## Layout
 *
 * Two RGBA float textures, `width = vertexCount`, `height = totalFrames`:
 * positions and normals. Clips are stacked vertically and each records its start
 * row and length, so a per-instance clip index is just an offset. The shader
 * samples two adjacent rows and lerps, so 16 baked frames read as smooth motion
 * rather than as stop-motion.
 */
import {
  BufferAttribute,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NearestFilter,
  RGBAFormat,
  Sphere,
  Vector3,
} from 'three';

const _v = new Vector3();
const _n = new Vector3();

/**
 * @typedef {object} VatClip
 * @property {string} name
 * @property {number} frames
 * @property {(character: import('../entity/Character.js').Character, t: number) => void} pose
 *   `t` runs 0→1 across the clip; a looping clip must be seamless at t=1.
 */

/**
 * @typedef {object} BakedVat
 * @property {InstancedBufferGeometry} geometry
 * @property {DataTexture} positionTexture
 * @property {DataTexture} normalTexture
 * @property {Record<string, { start: number, frames: number }>} clips
 * @property {number} vertexCount
 * @property {number} frameCount
 */

/**
 * @param {() => import('../entity/Character.js').Character} makeCharacter
 * @param {VatClip[]} clips
 * @returns {BakedVat}
 */
export function bakeVat(makeCharacter, clips) {
  const character = makeCharacter();
  const root = character.root;

  /** @type {import('three').Mesh[]} */
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });

  let vertexCount = 0;
  for (const m of meshes) vertexCount += m.geometry.getAttribute('position').count;

  const frameCount = clips.reduce((sum, c) => sum + c.frames, 0);

  const positions = new Float32Array(vertexCount * frameCount * 4);
  const normals = new Float32Array(vertexCount * frameCount * 4);

  const clipTable = {};
  let row = 0;

  for (const clip of clips) {
    clipTable[clip.name] = { start: row, frames: clip.frames };

    for (let f = 0; f < clip.frames; f++) {
      // Sample at f/frames, not f/(frames-1): a looping clip's last frame must
      // be the step *before* the loop point, or the cycle stutters as the final
      // frame duplicates the first.
      clip.pose(character, f / clip.frames);
      root.updateMatrixWorld(true);

      let v = 0;
      for (const mesh of meshes) {
        const pos = mesh.geometry.getAttribute('position');
        const nrm = mesh.geometry.getAttribute('normal');
        const world = mesh.matrixWorld;
        const normalMat = mesh.normalMatrix.getNormalMatrix(world);

        for (let i = 0; i < pos.count; i++, v++) {
          _v.fromBufferAttribute(pos, i).applyMatrix4(world);
          _n.fromBufferAttribute(nrm, i).applyMatrix3(normalMat).normalize();

          const o = (row * vertexCount + v) * 4;
          positions[o] = _v.x;
          positions[o + 1] = _v.y;
          positions[o + 2] = _v.z;
          positions[o + 3] = 1;
          normals[o] = _n.x;
          normals[o + 1] = _n.y;
          normals[o + 2] = _n.z;
          normals[o + 3] = 0;
        }
      }
      row++;
    }
  }

  const geometry = buildTemplateGeometry(meshes, vertexCount);

  return {
    geometry,
    positionTexture: floatTexture(positions, vertexCount, frameCount),
    normalTexture: floatTexture(normals, vertexCount, frameCount),
    clips: clipTable,
    vertexCount,
    frameCount,
  };
}

/**
 * The template geometry carries no useful positions — every vertex is fetched
 * from the texture — but it must carry the *topology*, the per-vertex colour
 * (which never animates) and, critically, each vertex's row index in the
 * texture.
 */
function buildTemplateGeometry(meshes, vertexCount) {
  const geometry = new InstancedBufferGeometry();

  const dummyPos = new Float32Array(vertexCount * 3);
  // `normal` is never read — the shader fetches it from the texture — but
  // three.js declares the attribute unconditionally, and leaving it unbound
  // makes the driver complain on some platforms.
  const dummyNormal = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const vertexIds = new Float32Array(vertexCount);
  const indices = [];

  let v = 0;
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute('position');
    const color = mesh.material.color;
    const base = v;

    for (let i = 0; i < pos.count; i++, v++) {
      vertexIds[v] = v;
      colors[v * 3] = color.r;
      colors[v * 3 + 1] = color.g;
      colors[v * 3 + 2] = color.b;
    }

    const index = mesh.geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(base + i);
    }
  }

  geometry.setAttribute('position', new BufferAttribute(dummyPos, 3));
  geometry.setAttribute('normal', new BufferAttribute(dummyNormal, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('aVertexId', new BufferAttribute(vertexIds, 1));
  geometry.setIndex(indices);
  // Every vertex is repositioned in the shader, so bounds computed from the
  // dummy positions would be a zero-radius sphere at the origin and three.js
  // would frustum-cull the entire horde on the first frame. An explicit huge
  // sphere also stops it recomputing them.
  geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0), 1e6);
  return geometry;
}

function floatTexture(data, width, height) {
  const tex = new DataTexture(data, width, height, RGBAFormat, FloatType);
  // Nearest on both axes: the shader does its own frame interpolation, and
  // hardware filtering along the vertex axis would blend *different vertices*
  // together — which turns a character into a smear.
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Per-instance attributes. Allocated once at the horde's capacity and updated
 * in place; `count` on the geometry controls how many are actually drawn, so
 * spawning and killing never reallocates a buffer.
 */
export function allocateInstances(geometry, capacity) {
  const attrs = {
    /** xyz position, w = yaw. */
    aTransform: new InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
    /** x = clip start row, y = clip frames, z = phase offset, w = frames/sec. */
    aClip: new InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
    /** Per-instance colour multiplier, so a crowd is not one uniform colour. */
    aTint: new InstancedBufferAttribute(new Float32Array(capacity * 3), 3),
  };
  for (const [name, attr] of Object.entries(attrs)) {
    attr.setUsage(35048 /* DynamicDrawUsage */);
    geometry.setAttribute(name, attr);
  }
  geometry.instanceCount = 0;
  return attrs;
}
