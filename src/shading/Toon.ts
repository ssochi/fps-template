import * as THREE from 'three';
import type { PaletteGene } from '../genome/Genome';
import { clamp } from '../core/MathUtils';

/**
 * Cel shading, built on `MeshToonMaterial` rather than from scratch.
 *
 * Writing a raw `ShaderMaterial` is the obvious route and throws away the whole
 * lighting pipeline with it: shadow maps, light probes, fog and tone mapping
 * all live in three.js's chunk system, and a hand-rolled shader has to
 * reimplement every one of them to look right. `MeshToonMaterial` already
 * quantises its diffuse term through a `gradientMap`, so the cel look is a
 * texture decision, and everything else is injected at named chunk boundaries.
 *
 * Three things are added on top of stock toon shading, because without them a
 * cel-shaded creature reads as flat vinyl:
 *
 * - **A hard rim term.** Toon lighting collapses the silhouette against the
 *   background; a quantised wrap light peels it back off.
 * - **Bands.** Stripes along the body, from a per-vertex spine coordinate
 *   rather than a texture, so they wrap every part coherently.
 * - **A shade bias.** Moves the terminator so a creature can read as lit from
 *   above with a thin shadow, or as mostly-in-shadow with a bright edge.
 */

/** Where a vertex sits along the creature's spine, 0 at tail, 1 at nose. */
export const SPINE_ATTRIBUTE = 'aSpine';

/**
 * Every part must carry the spine attribute, even a constant one.
 *
 * A missing attribute is not a soft failure in GLSL — the draw either errors or
 * silently reads garbage — so parts that occupy a single point on the spine
 * fill it with that one value rather than the shader carrying two code paths.
 */
export function setSpine(geometry: THREE.BufferGeometry, value: number | ((y: number) => number)): void {
  const position = geometry.getAttribute('position');
  const count = position.count;
  const data = new Float32Array(count);
  if (typeof value === 'number') {
    data.fill(value);
  } else {
    for (let i = 0; i < count; i++) data[i] = value(position.getY(i));
  }
  geometry.setAttribute(SPINE_ATTRIBUTE, new THREE.BufferAttribute(data, 1));
}

/**
 * The cel ramp.
 *
 * `NearestFilter` is the entire point: linear filtering here interpolates
 * between the steps and gives back the smooth gradient the ramp exists to
 * remove. `bias` slides the terminator without changing the step count.
 */
export function makeGradientMap(steps: number, bias: number): THREE.DataTexture {
  const n = Math.max(2, Math.min(6, Math.round(steps)));
  const width = 64;
  const data = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const t = clamp(i / (width - 1) + bias * 0.5, 0, 1);
    const stepIndex = Math.min(n - 1, Math.floor(t * n));
    // Weight the steps toward the light so the shadow side keeps some form.
    const level = 0.22 + 0.78 * Math.pow(stepIndex / (n - 1), 0.8);
    const v = Math.round(level * 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export interface ToonUniforms {
  uAccent: { value: THREE.Color };
  uPattern: { value: number };
  uPatternScale: { value: number };
  uPatternStrength: { value: number };
  uCountershade: { value: number };
  uRim: { value: number };
  uRimColor: { value: THREE.Color };
}

export interface ToonMaterial extends THREE.MeshToonMaterial {
  creatureUniforms: ToonUniforms;
}

/** Colour roles a part can ask for. */
export type Role = 'skin' | 'belly' | 'horn' | 'claw' | 'eye' | 'membrane' | 'mouth';

export interface CreatureMaterials {
  get(role: Role): THREE.Material;
  outline: THREE.Material;
  /** Drives the band pattern and rim at runtime without a rebuild. */
  setPalette(palette: PaletteGene): void;
  dispose(): void;
}

function hsl(h: number, s: number, l: number): THREE.Color {
  return new THREE.Color().setHSL(((h % 1) + 1) % 1, clamp(s, 0, 1), clamp(l, 0, 1));
}

/**
 * Derives the whole colour scheme from the palette gene.
 *
 * The roles are related rather than independent: a creature whose horns are an
 * unrelated colour to its skin reads as assembled from parts, which is exactly
 * what it is and exactly what it should not look like. Everything is a rotation
 * or a value shift away from the base hue.
 */
function roleColours(p: PaletteGene): Record<Role, THREE.Color> {
  const base = hsl(p.hue, p.saturation, p.lightness);
  const accentHue = p.hue + p.accentShift;
  return {
    skin: base,
    belly: hsl(accentHue, p.saturation * 0.75, Math.min(0.92, p.lightness + 0.22)),
    // Keratin: desaturated and pale, whatever the skin is doing.
    horn: hsl(accentHue + 0.04, p.saturation * 0.3, 0.72),
    claw: hsl(accentHue + 0.02, p.saturation * 0.22, 0.24),
    eye: hsl(p.hue + 0.5, 0.85, 0.62),
    membrane: hsl(accentHue, p.saturation * 0.6, p.lightness * 0.85),
    mouth: hsl(p.hue + 0.02, 0.55, 0.24),
  };
}

/**
 * Markings.
 *
 * Two coordinates do all of it: `vSpine`, which runs nose to tail and is shared
 * by every part, and the angle around the part's own axis. That pairing is what
 * lets a stripe wrap the body, the legs and the tail as one pattern rather than
 * restarting per mesh, and it needs no UV unwrap of geometry that did not exist
 * a frame ago.
 *
 * Every marking is a hard step rather than a smooth gradient, for the same
 * reason the light ramp is: a soft edge on a cel-shaded surface reads as an
 * artefact, a hard one reads as drawn.
 */
const BAND_CHUNK = /* glsl */ `
  float pu = vSpine * uPatternScale;
  float pv = atan(vLocal.y, vLocal.x) * 0.15915494 + 0.5;
  float mark = 0.0;
  int mode = int(uPattern + 0.5);

  if (mode == 1) {
    // Bands around the body.
    mark = step(0.5, fract(pu));
  } else if (mode == 2) {
    // Spots: one per cell, jittered so the grid does not read as a grid.
    vec2 cell = vec2(pu, pv * max(3.0, uPatternScale * 0.7));
    vec2 id = floor(cell);
    vec2 f = fract(cell) - 0.5;
    float h = fract(sin(dot(id, vec2(127.1, 311.7))) * 43758.5453);
    vec2 jitter = vec2(h - 0.5, fract(h * 17.0) - 0.5) * 0.5;
    mark = 1.0 - step(0.16 + h * 0.16, length(f - jitter));
  } else if (mode == 3) {
    // Patches: soft noise, hard threshold.
    float n = sin(pu * 2.1 + sin(pv * 6.28 * 2.0) * 1.7) * 0.5 + 0.5;
    mark = step(0.55, n);
  } else if (mode == 4) {
    // Segments: a ring at every joint, like an insect's plates.
    mark = smoothstep(0.42, 0.5, abs(fract(pu) - 0.5)) ;
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, uAccent, mark * uPatternStrength);

  // Countershading is independent of the marking: nearly every real animal has
  // it, and it is most of why a plain one still reads as solid rather than flat.
  float up = clamp(vObjNormal.y * 0.5 + 0.5, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, uAccent, (1.0 - up) * uCountershade * 0.85);
`;

const RIM_CHUNK = /* glsl */ `
  // Quantised wrap light. Smooth rim on a cel-shaded surface reads as a bloom
  // artefact; a hard edge reads as drawn.
  float rimFacing = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float rimBand = smoothstep(0.55, 0.72, rimFacing);
  outgoingLight += uRimColor * (rimBand * uRim);
`;

function createToonMaterial(
  colour: THREE.Color,
  gradient: THREE.DataTexture,
  uniforms: ToonUniforms,
  extra: THREE.MeshToonMaterialParameters = {},
): ToonMaterial {
  const material = new THREE.MeshToonMaterial({
    color: colour,
    gradientMap: gradient,
    ...extra,
  }) as ToonMaterial;
  material.creatureUniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAccent = uniforms.uAccent;
    shader.uniforms.uPattern = uniforms.uPattern;
    shader.uniforms.uPatternScale = uniforms.uPatternScale;
    shader.uniforms.uPatternStrength = uniforms.uPatternStrength;
    shader.uniforms.uCountershade = uniforms.uCountershade;
    shader.uniforms.uRim = uniforms.uRim;
    shader.uniforms.uRimColor = uniforms.uRimColor;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float ${SPINE_ATTRIBUTE};
        varying float vSpine;
        varying vec3 vLocal;
        varying vec3 vObjNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSpine = ${SPINE_ATTRIBUTE};
        vLocal = transformed;
        vObjNormal = normalize(objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vSpine;
        varying vec3 vLocal;
        varying vec3 vObjNormal;
        uniform vec3 uAccent;
        uniform float uPattern;
        uniform float uPatternScale;
        uniform float uPatternStrength;
        uniform float uCountershade;
        uniform float uRim;
        uniform vec3 uRimColor;`,
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${BAND_CHUNK}`)
      // `opaque_fragment` is the first chunk after `outgoingLight` exists, so
      // this is the one place the rim can be added to the lit result.
      .replace('#include <opaque_fragment>', `${RIM_CHUNK}\n#include <opaque_fragment>`);
  };
  // Injected uniforms change the program, so the key must change with them.
  material.customProgramCacheKey = () => 'creature-toon-v2';
  return material;
}

/**
 * The inverted-hull outline.
 *
 * Chosen over a post-process edge detector because a creature is dozens of
 * separate meshes: a screen-space pass finds the silhouette of the whole
 * animal, while the hull gives every limb, horn and toe its own line, which is
 * what makes a cel-shaded creature read as drawn rather than as a flat cutout.
 * It costs a second draw of the same geometry, which at this triangle count is
 * cheaper than an extra full-screen pass.
 *
 * The expansion is along the vertex normal in *view* space and scaled by the
 * clip-space w, so the line stays a constant width on screen instead of
 * thinning with distance.
 */
export function createOutlineMaterial(width: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uWidth: { value: width }, uColor: { value: new THREE.Color(0x140f1c) } },
    vertexShader: /* glsl */ `
      uniform float uWidth;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        // Expand in *view* space, not in clip space.
        //
        // Nudging clip.xy leaves the hull at exactly the surface's depth, and
        // since only back faces are drawn, anywhere the geometry is thin — the
        // silhouette of a tube, a membrane, a fin — the two coincide and
        // z-fight into speckle. Moving along the view-space normal pushes a
        // back face further from the camera, which is where it belongs.
        // Scaling by -z keeps the line a constant width on screen.
        mvPosition.xyz += n * uWidth * max(0.35, -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }
    `,
    side: THREE.BackSide,
    // The hull sits behind the surface it outlines; without this it z-fights
    // along every silhouette edge.
    depthWrite: true,
  });
}

/**
 * Builds the material set for one creature.
 *
 * All roles share one gradient map and one uniform block, so retinting a
 * creature is a uniform write rather than a rebuild — which is what makes the
 * palette sliders feel live.
 */
export function createMaterials(palette: PaletteGene, outlineWidth: number): CreatureMaterials {
  const uniforms: ToonUniforms = {
    uAccent: { value: new THREE.Color() },
    uPattern: { value: 0 },
    uPatternScale: { value: 6 },
    uPatternStrength: { value: 0 },
    uCountershade: { value: 0 },
    uRim: { value: 0 },
    uRimColor: { value: new THREE.Color(0xffffff) },
  };
  let gradient = makeGradientMap(4, palette.shadeBias);
  const materials = new Map<Role, ToonMaterial>();
  const roles: Role[] = ['skin', 'belly', 'horn', 'claw', 'eye', 'membrane', 'mouth'];
  const colours = roleColours(palette);

  for (const role of roles) {
    const extra: THREE.MeshToonMaterialParameters = {};
    if (role === 'eye') {
      extra.emissive = colours.eye.clone().multiplyScalar(0.55);
    }
    if (role === 'membrane') {
      extra.transparent = true;
      extra.opacity = 0.82;
      extra.side = THREE.DoubleSide;
    }
    materials.set(role, createToonMaterial(colours[role], gradient, uniforms, extra));
  }

  const outline = createOutlineMaterial(outlineWidth);

  const apply = (p: PaletteGene): void => {
    const next = roleColours(p);
    for (const role of roles) materials.get(role)!.color.copy(next[role]);
    materials.get('eye')!.emissive.copy(next.eye).multiplyScalar(0.55);
    uniforms.uAccent.value.copy(next.belly);
    uniforms.uPattern.value = p.pattern;
    uniforms.uPatternScale.value = p.patternScale;
    uniforms.uPatternStrength.value = p.patternStrength;
    uniforms.uCountershade.value = p.countershade;
    uniforms.uRim.value = p.rim;
    uniforms.uRimColor.value.copy(hsl(p.hue + 0.5, 0.35, 0.85));

    const nextGradient = makeGradientMap(4, p.shadeBias);
    gradient.dispose();
    gradient = nextGradient;
    for (const role of roles) materials.get(role)!.gradientMap = gradient;
  };
  apply(palette);

  return {
    get: (role) => materials.get(role) ?? materials.get('skin')!,
    outline,
    setPalette: apply,
    dispose() {
      for (const m of materials.values()) m.dispose();
      outline.dispose();
      gradient.dispose();
    },
  };
}
