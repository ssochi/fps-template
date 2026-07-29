/**
 * The world material: one shader that does chunk shading, cutaway and fog of war.
 *
 * All three effects are per-*tile* or per-*room* decisions that change as the
 * player moves. Baking any of them into the chunk geometry would mean remeshing
 * a dozen chunks per step, so they are driven entirely by two small lookup
 * textures and a handful of uniforms — the geometry never changes.
 *
 * ## Cutaway
 *
 * Each vertex carries the facing of the surface it belongs to (0–3 for the four
 * wall directions, 4 for floors and objects) and the id of the room it belongs
 * to. A room-indexed texture says how cut-away each room currently is. When a
 * room is cut, two things vanish: any storey above the player's, and any wall
 * face pointing toward the camera. That is exactly the reference game's
 * behaviour — you see into the building you are in, from the near side, and its
 * upper floors get out of the way.
 *
 * The fade is *dithered* rather than blended. An alpha fade on world geometry
 * needs depth sorting, which for interpenetrating chunk meshes is both expensive
 * and unreliable; a screen-door dither gives a smooth-looking transition with a
 * plain `discard` and no sorting at all.
 *
 * ## Fog of war
 *
 * A single-channel texture laid out exactly like the tile grid, sampled by world
 * position. Three states are read out of one value: black when unseen, a cool
 * desaturated memory when remembered, full colour when visible.
 */
import { Color, FrontSide, MeshDepthMaterial, MeshLambertMaterial, RGBADepthPacking, Vector2, Vector4 } from 'three';

/** Facing id used by anything that must never be cut for facing the camera. */
export const FACING_NONE = 4;

/**
 * A 4×4 ordered dither. Declared once and shared by both the beauty and depth
 * shaders so a fading wall and its shadow dissolve on identical pixels — if they
 * disagreed, a half-faded wall would cast a full shadow through its own holes.
 */
const DITHER_GLSL = /* glsl */ `
float knoxDither( vec2 fragCoord ) {
  int ix = int( mod( fragCoord.x, 4.0 ) );
  int iy = int( mod( fragCoord.y, 4.0 ) );
  int index = ix + iy * 4;
  float m[16];
  m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
  m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
  m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
  m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
  float v = 0.0;
  for ( int i = 0; i < 16; i++ ) { if ( i == index ) v = m[i]; }
  return ( v + 0.5 ) / 16.0;
}
`;

const CUT_PARS_VERTEX = /* glsl */ `
attribute float aFacing;
attribute float aRoom;
attribute float aLevel;

uniform sampler2D uRoomCut;
uniform float uRoomCutSize;
uniform float uPlayerLevel;
uniform vec4  uFacingHidden;

varying float vCut;
varying vec3  vWorldPos;
varying float vLevelOut;

float knoxCutAmount() {
  float roomCut = texture2D( uRoomCut, vec2( ( aRoom + 0.5 ) / uRoomCutSize, 0.5 ) ).r;
  if ( roomCut < 0.004 ) return 0.0;

  // Storeys above the player's get out of the way entirely.
  if ( aLevel > uPlayerLevel + 0.5 ) return roomCut;

  // Otherwise only the wall faces pointing at the camera go.
  if ( aFacing > 3.5 ) return 0.0;
  float hidden =
      aFacing < 0.5 ? uFacingHidden.x
    : aFacing < 1.5 ? uFacingHidden.y
    : aFacing < 2.5 ? uFacingHidden.z
    :                 uFacingHidden.w;
  return roomCut * hidden;
}
`;

const CUT_VERTEX = /* glsl */ `
  vCut = knoxCutAmount();
  vWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vLevelOut = aLevel;
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
uniform sampler2D uVisibility;
uniform vec2  uVisTexSize;
uniform float uGridDepth;
uniform vec3  uMemoryTint;
uniform float uFogStrength;

varying float vCut;
varying vec3  vWorldPos;
varying float vLevelOut;
`;

/** Applied just before the fragment is written, so it sees the final colour. */
const FOG_FRAGMENT = /* glsl */ `
  {
    vec2 visUv = vec2(
      vWorldPos.x / uVisTexSize.x,
      ( vLevelOut * uGridDepth + vWorldPos.z ) / uVisTexSize.y
    );
    float vis = texture2D( uVisibility, visUv ).r;
    vis = mix( 1.0, vis, uFogStrength );

    float lum = dot( outgoingLight, vec3( 0.299, 0.587, 0.114 ) );
    vec3 remembered = vec3( lum ) * uMemoryTint;

    // 0 unseen -> 1 remembered, then 0 remembered -> 1 visible.
    float rememberK = smoothstep( 0.06, 0.48, vis );
    float visibleK  = smoothstep( 0.52, 0.96, vis );

    vec3 c = mix( vec3( 0.012, 0.014, 0.02 ), remembered, rememberK );
    outgoingLight = mix( c, outgoingLight, visibleK );
  }
`;

const CUT_DISCARD = /* glsl */ `
  if ( vCut > 0.001 && vCut > knoxDither( gl_FragCoord.xy ) ) discard;
`;

/**
 * Shared uniform objects. Both the beauty material and the custom depth
 * material reference the *same* objects, so there is exactly one place to
 * write a cutaway or fog change and no way for the two to drift apart.
 */
export function createWorldUniforms({ visibilityTexture, visWidth, visHeight, gridDepth, roomCutTexture, roomCount }) {
  return {
    uRoomCut: { value: roomCutTexture },
    uRoomCutSize: { value: roomCount },
    uPlayerLevel: { value: 0 },
    uFacingHidden: { value: new Vector4(0, 0, 0, 0) },
    uVisibility: { value: visibilityTexture },
    uVisTexSize: { value: new Vector2(visWidth, visHeight) },
    uGridDepth: { value: gridDepth },
    uMemoryTint: { value: new Color(0.42, 0.47, 0.62) },
    uFogStrength: { value: 1 },
  };
}

/** The lit material for chunk geometry. */
export function createWorldMaterial(uniforms) {
  const material = new MeshLambertMaterial({ vertexColors: true, side: FrontSide });

  // three.js defaults `shadowSide` to the opposite of `side`, which assumes
  // closed solids. Walls are coplanar pairs of one-sided quads, so casting from
  // the back faces makes every wall shadow itself in hard diagonal wedges.
  material.shadowSide = FrontSide;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CUT_PARS_VERTEX}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${CUT_VERTEX}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FOG_PARS_FRAGMENT}\n${DITHER_GLSL}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CUT_DISCARD}`)
      .replace('#include <opaque_fragment>', `${FOG_FRAGMENT}\n#include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'knox-world-v1';
  return material;
}

/**
 * The depth material used for shadow casting.
 *
 * Without this, cutting a roof away leaves the roof's shadow lying across the
 * room you just revealed — the geometry is gone from the beauty pass but still
 * present in the shadow map. It shares the uniform objects and the dither
 * function with the beauty material so both dissolve identically.
 */
export function createWorldDepthMaterial(uniforms) {
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CUT_PARS_VERTEX}`)
      .replace('#include <clipping_planes_vertex>', `#include <clipping_planes_vertex>\n${CUT_VERTEX}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FOG_PARS_FRAGMENT}\n${DITHER_GLSL}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CUT_DISCARD}`);
  };
  material.customProgramCacheKey = () => 'knox-world-depth-v1';
  return material;
}
