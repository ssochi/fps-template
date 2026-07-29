/**
 * The shader that draws the horde.
 *
 * Every vertex position and normal is fetched from the vertex animation
 * textures rather than coming from the geometry, and the instance's own
 * transform is a position and a yaw rather than a full matrix — the dead never
 * pitch, roll or scale, so four floats do what sixteen would.
 *
 * Fog of war applies to the horde exactly as it does to the world: a zombie
 * standing in a room you cannot see is not drawn. That is not a rendering
 * nicety, it is the stealth rule — if you could see them through walls there
 * would be nothing to be afraid of.
 */
import { DoubleSide, MeshLambertMaterial, Vector2 } from 'three';

const VERTEX_PARS = /* glsl */ `
attribute float aVertexId;
attribute vec4  aTransform;   // xyz = world position, w = yaw
attribute vec4  aClip;        // x = start row, y = frames, z = phase, w = fps
attribute vec3  aTint;

uniform sampler2D uVatPosition;
uniform sampler2D uVatNormal;
uniform vec2  uVatSize;       // (vertexCount, frameCount)
uniform float uTime;

varying vec3  vTint;
varying vec3  vWorldPos;
varying float vLevelOut;

uniform float uStoreyHeight;

vec4 vatFetch( sampler2D tex, float vertexId, float row ) {
  return texture2D( tex, vec2( ( vertexId + 0.5 ) / uVatSize.x, ( row + 0.5 ) / uVatSize.y ) );
}
`;

const VERTEX_MAIN = /* glsl */ `
  float frames = max( aClip.y, 1.0 );
  float t = uTime * aClip.w + aClip.z * frames;
  float f0 = floor( mod( t, frames ) );
  float f1 = mod( f0 + 1.0, frames );
  float blend = fract( t );

  // Two adjacent frames, lerped. Sixteen baked frames read as smooth motion
  // this way; sampled with nearest they read as stop-motion.
  vec3 p0 = vatFetch( uVatPosition, aVertexId, aClip.x + f0 ).xyz;
  vec3 p1 = vatFetch( uVatPosition, aVertexId, aClip.x + f1 ).xyz;
  vec3 localPos = mix( p0, p1, blend );

  vec3 n0 = vatFetch( uVatNormal, aVertexId, aClip.x + f0 ).xyz;
  vec3 n1 = vatFetch( uVatNormal, aVertexId, aClip.x + f1 ).xyz;
  vec3 localNormal = normalize( mix( n0, n1, blend ) );

  float s = sin( aTransform.w );
  float c = cos( aTransform.w );
  mat3 yaw = mat3( c, 0.0, -s,  0.0, 1.0, 0.0,  s, 0.0, c );

  vec3 worldPos = yaw * localPos + aTransform.xyz;
  vec3 worldNormal = yaw * localNormal;

  vTint = aTint;
  vWorldPos = worldPos;
  vLevelOut = floor( aTransform.y / uStoreyHeight + 0.001 );
`;

const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D uVisibility;
uniform vec2  uVisTexSize;
uniform float uGridDepth;
uniform float uFogStrength;

varying vec3  vTint;
varying vec3  vWorldPos;
varying float vLevelOut;
`;

const FRAGMENT_MAIN = /* glsl */ `
  {
    vec2 visUv = vec2(
      vWorldPos.x / uVisTexSize.x,
      ( vLevelOut * uGridDepth + vWorldPos.z ) / uVisTexSize.y
    );
    float vis = texture2D( uVisibility, visUv ).r;
    vis = mix( 1.0, vis, uFogStrength );

    // A zombie in a room you cannot see is not drawn at all. Remembering where
    // a *wall* was is knowledge; remembering where a zombie was is a lie, and
    // seeing one through a wall removes the entire reason to be careful.
    if ( vis < 0.75 ) discard;

    outgoingLight *= vTint;
  }
`;

/**
 * @param {object} opts
 * @param {import('three').Texture} opts.positionTexture
 * @param {import('three').Texture} opts.normalTexture
 * @param {number} opts.vertexCount
 * @param {number} opts.frameCount
 * @param {Record<string, {value: unknown}>} opts.worldUniforms shared with the
 *   world material, so the horde and the town agree about what is visible
 */
export function createCrowdMaterial({
  positionTexture,
  normalTexture,
  vertexCount,
  frameCount,
  worldUniforms,
  storeyHeight,
}) {
  const material = new MeshLambertMaterial({
    vertexColors: true,
    // The baked geometry is a set of open boxes whose winding survives the
    // texture fetch, but a mis-baked normal should show as flat shading rather
    // than as a hole in a body.
    side: DoubleSide,
  });

  const uniforms = {
    uVatPosition: { value: positionTexture },
    uVatNormal: { value: normalTexture },
    uVatSize: { value: new Vector2(vertexCount, frameCount) },
    uTime: { value: 0 },
    uStoreyHeight: { value: storeyHeight },
    uVisibility: worldUniforms.uVisibility,
    uVisTexSize: worldUniforms.uVisTexSize,
    uGridDepth: worldUniforms.uGridDepth,
    uFogStrength: worldUniforms.uFogStrength,
  };
  material.userData.uniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <beginnormal_vertex>', `${VERTEX_MAIN}\n  vec3 objectNormal = worldNormal;`)
      .replace('#include <begin_vertex>', '  vec3 transformed = worldPos;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <opaque_fragment>', `${FRAGMENT_MAIN}\n#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'knox-crowd-v1';

  return material;
}
