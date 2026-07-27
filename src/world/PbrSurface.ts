import * as THREE from 'three';

/**
 * Procedural PBR surface authoring.
 *
 * This is the metallic-roughness workflow every modern engine uses, generated
 * on a canvas instead of baked in Substance:
 *
 * - **Albedo** — base colour with no lighting baked in. sRGB.
 * - **Normal** — tangent-space surface detail, derived here from a height
 *   field. Linear, never sRGB; treating a normal map as colour data is the
 *   single most common way to get subtly wrong lighting.
 * - **ORM** — ambient occlusion, roughness and metalness packed into R, G and B
 *   of one texture. This is the glTF convention and three.js reads exactly
 *   those channels (`aomap_fragment` takes `.r`, `roughnessmap_fragment` `.g`,
 *   `metalnessmap_fragment` `.b`), so a single sample serves all three and one
 *   texture upload replaces three.
 *
 * The map factors *multiply* the material's scalars, so `applySurface` sets
 * `roughness = metalness = 1` — leaving them at their defaults would silently
 * halve the metalness of every metal.
 */

export interface Surface {
  /** Base colour, sRGB. */
  map: THREE.CanvasTexture;
  /** Tangent-space normals, linear. */
  normalMap: THREE.DataTexture;
  /** Occlusion (R) / roughness (G) / metalness (B), linear. */
  ormMap: THREE.CanvasTexture;
  normalScale: number;
  dispose(): void;
}

type Painter = (ctx: CanvasRenderingContext2D, size: number) => void;
/** A channel is either a constant or something painted in greyscale. */
type Channel = number | Painter;

export interface SurfaceSpec {
  size?: number;
  /** Texture repeats across the UV square. Set from texel density, not taste. */
  repeat?: number | [number, number];
  albedo: Painter;
  /** Greyscale height field; white is raised. Drives normals and cavity AO. */
  height?: Painter;
  roughness: Channel;
  metalness: Channel;
  /** Defaults to a cavity map derived from `height`. */
  ao?: Channel;
  /** Normal map strength; higher exaggerates the height field. */
  normalStrength?: number;
  normalScale?: number;
  anisotropy?: number;
}

function canvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const el = document.createElement('canvas');
  el.width = size;
  el.height = size;
  const ctx = el.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas: el, ctx };
}

function paintChannel(channel: Channel, size: number): Float32Array {
  const out = new Float32Array(size * size);
  if (typeof channel === 'number') {
    out.fill(channel);
    return out;
  }
  const { canvas: el, ctx } = canvas(size);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  channel(ctx, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    // Rec. 709 luma; a channel painted in grey should read as its own value.
    out[i] = (data[i * 4] * 0.2126 + data[i * 4 + 1] * 0.7152 + data[i * 4 + 2] * 0.0722) / 255;
    void el;
  }
  return out;
}

/**
 * Height field to tangent-space normals.
 *
 * Green is +Y (the OpenGL convention three.js expects); flipping it is the
 * DirectX convention and makes every bump read as a dent.
 *
 * `strength` is the slope in height-units per texel, so it is not a taste
 * knob: the central difference already spans two texels of a 0..1 height
 * field, and a value of 10 asks for an 83-degree facet on every thread of a
 * weave. Anything much above ~2.5 stops reading as a surface and starts
 * reading as crumpled foil. Calibrate against the real feature: carbon tow is
 * a few hundredths of a millimetre proud over a millimetre of weave.
 */
function normalsFromHeight(height: Float32Array, size: number, strength: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number =>
    height[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Central differences, so the slope is symmetric and tiles seamlessly.
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Cavity occlusion from a height field: a texel sitting below its neighbourhood
 * average is in a crevice. Stands in for the AO you would normally bake from a
 * high-poly mesh, and costs one blur.
 */
function cavityFromHeight(height: Float32Array, size: number, strength: number): Float32Array {
  const blurred = new Float32Array(size * size);
  const radius = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      let count = 0;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          sum += height[((y + oy + size) % size) * size + ((x + ox + size) % size)];
          count++;
        }
      }
      blurred[y * size + x] = sum / count;
    }
  }
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(0, Math.min(1, 1 - (blurred[i] - height[i]) * strength));
  }
  return out;
}

/** Paints a colour channel set, kept as linear 0..1 triples for blending. */
function paintRGB(painter: Painter, size: number): Float32Array {
  const { ctx } = canvas(size);
  painter(ctx, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const out = new Float32Array(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    out[i * 3] = data[i * 4] / 255;
    out[i * 3 + 1] = data[i * 4 + 1] / 255;
    out[i * 3 + 2] = data[i * 4 + 2] / 255;
  }
  return out;
}

/** The shared tail of every surface builder: pack ORM, derive normals, wrap. */
function assembleSurface(parts: {
  size: number;
  repeat?: number | [number, number];
  albedoCanvas: HTMLCanvasElement;
  height: Float32Array;
  ao: Float32Array;
  rough: Float32Array;
  metal: Float32Array;
  normalStrength: number;
  normalScale: number;
  anisotropy?: number;
}): Surface {
  const { size } = parts;
  const map = new THREE.CanvasTexture(parts.albedoCanvas);
  map.colorSpace = THREE.SRGBColorSpace;

  const normalMap = normalsFromHeight(parts.height, size, parts.normalStrength);

  const orm = canvas(size);
  const image = orm.ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    image.data[i * 4] = parts.ao[i] * 255;
    image.data[i * 4 + 1] = parts.rough[i] * 255;
    image.data[i * 4 + 2] = parts.metal[i] * 255;
    image.data[i * 4 + 3] = 255;
  }
  orm.ctx.putImageData(image, 0, 0);
  const ormMap = new THREE.CanvasTexture(orm.canvas);
  // Deliberately *not* sRGB: these are data channels, not colour.
  ormMap.colorSpace = THREE.NoColorSpace;

  const repeat = parts.repeat ?? 1;
  const [ru, rv] = Array.isArray(repeat) ? repeat : [repeat, repeat];
  for (const tex of [map, normalMap, ormMap] as THREE.Texture[]) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(ru, rv);
    tex.anisotropy = parts.anisotropy ?? 8;
    tex.needsUpdate = true;
  }

  return {
    map,
    normalMap,
    ormMap,
    normalScale: parts.normalScale,
    dispose() {
      map.dispose();
      normalMap.dispose();
      ormMap.dispose();
    },
  };
}

export function buildSurface(spec: SurfaceSpec): Surface {
  const size = spec.size ?? 512;

  const base = canvas(size);
  spec.albedo(base.ctx, size);

  const height = spec.height ? paintChannel(spec.height, size) : new Float32Array(size * size);

  return assembleSurface({
    size,
    repeat: spec.repeat,
    albedoCanvas: base.canvas,
    height,
    ao: spec.ao !== undefined ? paintChannel(spec.ao, size) : cavityFromHeight(height, size, 6),
    rough: paintChannel(spec.roughness, size),
    metal: paintChannel(spec.metalness, size),
    normalStrength: spec.normalStrength ?? 2,
    normalScale: spec.normalScale ?? 1,
    anisotropy: spec.anisotropy,
  });
}

/**
 * Wires a surface onto a material.
 *
 * All three of `aoMap`, `roughnessMap` and `metalnessMap` get the *same*
 * texture — that is the point of ORM packing. The scalars go to 1 because the
 * maps multiply them.
 */
export function applySurface(
  material: THREE.MeshStandardMaterial,
  surface: Surface,
  options: { aoIntensity?: number } = {},
): void {
  material.map = surface.map;
  material.normalMap = surface.normalMap;
  material.normalScale = new THREE.Vector2(surface.normalScale, surface.normalScale);
  material.roughnessMap = surface.ormMap;
  material.metalnessMap = surface.ormMap;
  material.aoMap = surface.ormMap;
  material.aoMapIntensity = options.aoIntensity ?? 1;
  material.roughness = 1;
  material.metalness = 1;
  material.needsUpdate = true;
}

// --------------------------------------------------------- layered surfaces

/** One material in a stack: everything except the shared height field. */
export interface Layer {
  albedo: Painter;
  roughness: Channel;
  metalness: Channel;
}

export interface LayeredSpec {
  size?: number;
  repeat?: number | [number, number];
  /** The substrate, shown where the mask is 0 — bare metal under the paint. */
  base: Layer;
  /** The coating, shown where the mask is 1. */
  coat: Layer;
  /** 1 keeps the coating, 0 exposes the substrate. */
  mask: Channel;
  /** Shared height field; the coat sits proud of the substrate by `relief`. */
  height?: Painter;
  /** How far the coating stands above bare substrate, in height units. */
  relief?: number;
  /** Darkens and roughens the cavities of the height field. 0 disables it. */
  grime?: number;
  normalStrength?: number;
  normalScale?: number;
  anisotropy?: number;
}

/**
 * Two complete material layers blended through a mask.
 *
 * This is the part of the industry workflow that a single-layer generator
 * cannot express, and the reason showroom-new is the easy case: a used object
 * is not one material with a dirt texture on it, it is a stack. Bare steel,
 * then enamel over most of it, then grime settled into whatever the enamel did
 * not cover. Every channel has to be blended — a chip in the paint changes the
 * colour *and* the roughness *and* the metalness, and getting only the first
 * gives you a decal of a chip rather than a chip.
 *
 * The mask also drives relief, so the coating has a real edge the normal map
 * can catch, and cavity grime is applied last so it settles over both layers.
 */
export function layeredSurface(spec: LayeredSpec): Surface {
  const size = spec.size ?? 512;
  const mask = paintChannel(spec.mask, size);

  const baseAlbedo = paintRGB(spec.base.albedo, size);
  const coatAlbedo = paintRGB(spec.coat.albedo, size);
  const baseRough = paintChannel(spec.base.roughness, size);
  const coatRough = paintChannel(spec.coat.roughness, size);
  const baseMetal = paintChannel(spec.base.metalness, size);
  const coatMetal = paintChannel(spec.coat.metalness, size);

  // The coat stands proud of the substrate wherever it survives.
  const relief = spec.relief ?? 0.35;
  const surfaceHeight = spec.height ? paintChannel(spec.height, size) : new Float32Array(size * size);
  const height = new Float32Array(size * size);
  for (let i = 0; i < height.length; i++) height[i] = surfaceHeight[i] + mask[i] * relief;

  const cavity = cavityFromHeight(height, size, 6);
  const grime = spec.grime ?? 0;

  const albedo = canvas(size);
  const albedoImage = albedo.ctx.createImageData(size, size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const m = mask[i];
    // Grime is thickest where the cavity map is darkest, and it is a dielectric
    // film: it hides metal as well as darkening and roughening what it covers.
    const dirt = grime * (1 - cavity[i]);
    for (let c = 0; c < 3; c++) {
      const mixed = baseAlbedo[i * 3 + c] * (1 - m) + coatAlbedo[i * 3 + c] * m;
      albedoImage.data[i * 4 + c] = Math.round(Math.max(0, Math.min(1, mixed * (1 - dirt * 0.65))) * 255);
    }
    albedoImage.data[i * 4 + 3] = 255;
    rough[i] = Math.min(1, (baseRough[i] * (1 - m) + coatRough[i] * m) * (1 - dirt) + dirt * 0.95);
    metal[i] = Math.max(0, (baseMetal[i] * (1 - m) + coatMetal[i] * m) * (1 - dirt));
  }
  albedo.ctx.putImageData(albedoImage, 0, 0);

  return assembleSurface({
    size,
    repeat: spec.repeat,
    albedoCanvas: albedo.canvas,
    height,
    ao: cavity,
    rough,
    metal,
    normalStrength: spec.normalStrength ?? 2,
    normalScale: spec.normalScale ?? 1,
    anisotropy: spec.anisotropy,
  });
}

// ------------------------------------------------------------- mask painters

/**
 * Chipped-coating mask: irregular flakes worn through to the substrate.
 *
 * Real edge wear follows the *mesh's* curvature and is baked from a high-poly
 * source. A tiling texture has no idea where the model's edges are, so this
 * does what a texture artist does instead — scatter flakes with hard, ragged
 * boundaries, because a soft-edged blob reads as a stain and a hard-edged one
 * reads as paint that has come off.
 */
export function chipMask(options: { count?: number; scale?: number; scratches?: number } = {}): Painter {
  const count = options.count ?? 90;
  const scale = options.scale ?? 1;
  const scratches = options.scratches ?? 40;
  return (ctx, size) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let i = 0; i < count; i++) {
      const cx = Math.random() * size;
      const cy = Math.random() * size;
      const r = (2 + Math.random() * 9) * scale;
      // A ragged polygon, not a circle: chips have corners.
      const points = 6 + Math.floor(Math.random() * 4);
      ctx.beginPath();
      for (let p = 0; p <= points; p++) {
        const a = (p / points) * Math.PI * 2;
        const rr = r * (0.45 + Math.random() * 0.75);
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (p === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      // Wrap the chip across the seam so the tile stays seamless.
      for (const [dx, dy] of [
        [cx > size - r * 2 ? -size : cx < r * 2 ? size : 0, 0],
        [0, cy > size - r * 2 ? -size : cy < r * 2 ? size : 0],
      ] as [number, number][]) {
        if (dx === 0 && dy === 0) continue;
        ctx.save();
        ctx.translate(dx, dy);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.strokeStyle = '#000';
    for (let i = 0; i < scratches; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const a = Math.random() * Math.PI * 2;
      const len = (6 + Math.random() * 40) * scale;
      ctx.lineWidth = 0.6 + Math.random() * 1.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
  };
}

/** A material with a surface already applied. */
export function surfaceMaterial(
  surface: Surface,
  extra: THREE.MeshPhysicalMaterialParameters = {},
): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial(extra);
  applySurface(material, surface);
  return material;
}

// ------------------------------------------------------------- ready-mades

/** Fine-weave carbon fibre: a 2x2 twill, glossy under clearcoat. */
export function carbonSurface(repeat = 6): Surface {
  const weave = (ctx: CanvasRenderingContext2D, size: number, light: string, dark: string): void => {
    const cell = size / 16;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        // 2x2 twill: the float direction steps one cell per row.
        const warp = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0;
        const g = ctx.createLinearGradient(
          x * cell,
          y * cell,
          warp ? (x + 1) * cell : x * cell,
          warp ? y * cell : (y + 1) * cell,
        );
        g.addColorStop(0, dark);
        g.addColorStop(0.5, light);
        g.addColorStop(1, dark);
        ctx.fillStyle = g;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  };
  return buildSurface({
    size: 256,
    repeat,
    albedo: (ctx, size) => weave(ctx, size, '#2a2e36', '#0b0d10'),
    height: (ctx, size) => weave(ctx, size, '#ffffff', '#202020'),
    roughness: 0.32,
    metalness: 0.25,
    normalStrength: 1.8,
    normalScale: 0.6,
  });
}

/** Brushed stainless: fine directional grain, anisotropic when lit. */
export function brushedMetalSurface(repeat = 3, tint = '#b9c0c7'): Surface {
  // Half the scratches catch the light and half sit in shadow.
  //
  // This matters more than it looks: stacking only *bright* semi-transparent
  // strokes is a one-way ratchet, so twelve passes at alpha 0.2 take any base
  // to near-white however dark it started. The roughness channel painted that
  // way came out at 0.9 — brushed steel authored as sandblasted steel — and
  // the ORM chart is where you would see it, which is what the chart is for.
  const grain = (ctx: CanvasRenderingContext2D, size: number, base: string, amp: number): void => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < size * 6; i++) {
      const y = Math.random() * size;
      const a = Math.random() * amp;
      const v = Math.random() < 0.5 ? 255 : 0;
      ctx.strokeStyle = `rgba(${v},${v},${v},${a})`;
      ctx.lineWidth = Math.random() < 0.85 ? 1 : 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y + (Math.random() - 0.5) * 2);
      ctx.stroke();
    }
  };
  return buildSurface({
    size: 512,
    repeat,
    albedo: (ctx, size) => grain(ctx, size, tint, 0.06),
    height: (ctx, size) => grain(ctx, size, '#808080', 0.5),
    roughness: (ctx, size) => grain(ctx, size, '#4a4a4a', 0.35),
    metalness: 1,
    normalStrength: 1.1,
    normalScale: 0.3,
  });
}

/** Upholstery: a woven twill with slubs, matte and soft. */
export function fabricSurface(colour: string, repeat = 10): Surface {
  const weave = (ctx: CanvasRenderingContext2D, size: number, base: string, contrast: number): void => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    const cell = size / 32;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const over = (x + y) % 2 === 0;
        ctx.fillStyle = `rgba(${over ? 255 : 0},${over ? 255 : 0},${over ? 255 : 0},${contrast})`;
        ctx.fillRect(x * cell, y * cell, cell * 0.92, cell * 0.92);
      }
    }
    // Slubs: the thick fibres that stop a woven fabric looking printed.
    for (let i = 0; i < 220; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${contrast * 0.5})`;
      ctx.lineWidth = 1 + Math.random();
      const y = Math.random() * size;
      ctx.beginPath();
      ctx.moveTo(Math.random() * size, y);
      ctx.lineTo(Math.random() * size, y + (Math.random() - 0.5) * 6);
      ctx.stroke();
    }
  };
  return buildSurface({
    size: 512,
    repeat,
    albedo: (ctx, size) => weave(ctx, size, colour, 0.06),
    height: (ctx, size) => weave(ctx, size, '#6a6a6a', 0.5),
    roughness: 0.86,
    metalness: 0,
    normalStrength: 2.4,
    normalScale: 0.65,
  });
}

/** Oiled walnut: open grain, medium gloss. */
export function walnutSurface(repeat = 2): Surface {
  const grain = (
    ctx: CanvasRenderingContext2D,
    size: number,
    light: string,
    dark: string,
    lines: number,
  ): void => {
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < lines; i++) {
      const x = (i / lines) * size + Math.sin(i) * 3;
      ctx.strokeStyle = dark;
      ctx.globalAlpha = 0.1 + Math.random() * 0.3;
      ctx.lineWidth = 0.6 + Math.random() * 2.4;
      ctx.beginPath();
      for (let y = 0; y <= size; y += 8) {
        // Grain wanders slowly, and pinches around knots.
        const wobble = Math.sin(y * 0.012 + i) * 1.8 + Math.sin(y * 0.05 + i * 2) * 0.6;
        ctx.lineTo(x + wobble, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  return buildSurface({
    size: 512,
    repeat,
    albedo: (ctx, size) => grain(ctx, size, '#6b4a30', '#2e1d12', 230),
    height: (ctx, size) => grain(ctx, size, '#9a9a9a', '#3a3a3a', 230),
    roughness: (ctx, size) => grain(ctx, size, '#6e6e6e', '#3a3a3a', 230),
    metalness: 0,
    normalStrength: 1.0,
    normalScale: 0.22,
  });
}

/** Polished studio floor: near-mirror, with faint sweep marks. */
export function studioFloorSurface(repeat = 14): Surface {
  return buildSurface({
    size: 512,
    repeat,
    albedo: (ctx, size) => {
      ctx.fillStyle = '#26282c';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 120; i++) {
        ctx.strokeStyle = `rgba(255,255,255,${Math.random() * 0.03})`;
        ctx.lineWidth = Math.random() * 3;
        const y = Math.random() * size;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size, y + (Math.random() - 0.5) * 30);
        ctx.stroke();
      }
    },
    height: (ctx, size) => {
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, size, size);
    },
    roughness: (ctx, size) => {
      ctx.fillStyle = '#282828';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 90; i++) {
        ctx.strokeStyle = `rgba(255,255,255,${Math.random() * 0.22})`;
        ctx.lineWidth = Math.random() * 4;
        const y = Math.random() * size;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size, y + (Math.random() - 0.5) * 40);
        ctx.stroke();
      }
    },
    metalness: 0.1,
    normalStrength: 0.7,
    normalScale: 0.18,
  });
}

/**
 * Chipped black enamel over bare steel — the worn-machine material.
 *
 * The point of this one is that it is *two* materials: where the mask lets the
 * substrate through, the surface stops being a rough black dielectric and
 * becomes a smooth metal. A single-layer texture with dark-and-light patches
 * painted into its albedo cannot do that, and the ORM chart in the studio is
 * where the difference is obvious.
 */
export function wornEnamelSurface(repeat = 3): Surface {
  return layeredSurface({
    size: 512,
    repeat,
    base: {
      // Bare steel, polished by decades of handling.
      albedo: (ctx, size) => {
        ctx.fillStyle = '#9aa0a6';
        ctx.fillRect(0, 0, size, size);
      },
      roughness: 0.28,
      metalness: 1,
    },
    coat: {
      // Crinkle-finish enamel: the pebbled black used on machine bodies.
      albedo: (ctx, size) => {
        ctx.fillStyle = '#2a2f35';
        ctx.fillRect(0, 0, size, size);
        for (let i = 0; i < 1400; i++) {
          const v = Math.random() < 0.5 ? 255 : 0;
          ctx.fillStyle = `rgba(${v},${v},${v},0.03)`;
          ctx.beginPath();
          ctx.arc(Math.random() * size, Math.random() * size, 1 + Math.random() * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      },
      roughness: 0.52,
      metalness: 0,
    },
    // Few chips, but big enough to be chips. The first pass had a hundred tiny
    // ones and read as granite; cutting the count alone just made the wear
    // invisible. Size is what separates "worn" from "noisy".
    mask: chipMask({ count: 34, scale: 1.5, scratches: 40 }),
    height: (ctx, size) => {
      // The crinkle itself; the mask adds the paint's own thickness on top.
      ctx.fillStyle = '#606060';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 2200; i++) {
        const v = Math.random() < 0.5 ? 255 : 0;
        ctx.fillStyle = `rgba(${v},${v},${v},0.08)`;
        ctx.beginPath();
        ctx.arc(Math.random() * size, Math.random() * size, 1.5 + Math.random() * 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    relief: 0.3,
    grime: 0.55,
    normalStrength: 1.6,
    normalScale: 0.55,
  });
}

/** Unglazed terracotta: chalky, porous, with throwing rings. */
export function terracottaSurface(repeat = 3): Surface {
  const speckle = (ctx: CanvasRenderingContext2D, size: number, base: string, amp: number): void => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 5000; i++) {
      const v = Math.random() < 0.5 ? 255 : 0;
      ctx.fillStyle = `rgba(${v},${v},${v},${Math.random() * amp})`;
      ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    // Throwing rings: the horizontal ridges a wheel leaves in the clay.
    for (let y = 0; y < size; y += 7 + Math.random() * 6) {
      ctx.strokeStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.05})`;
      ctx.lineWidth = 1 + Math.random() * 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y + (Math.random() - 0.5) * 2);
      ctx.stroke();
    }
  };
  return buildSurface({
    size: 512,
    repeat,
    albedo: (ctx, size) => speckle(ctx, size, '#a85a3c', 0.1),
    height: (ctx, size) => speckle(ctx, size, '#808080', 0.5),
    roughness: (ctx, size) => speckle(ctx, size, '#d0d0d0', 0.15),
    metalness: 0,
    normalStrength: 1.4,
    normalScale: 0.45,
  });
}

/** Damp potting compost: dark, matte, lumpy. */
export function soilSurface(repeat = 4): Surface {
  const lumps = (ctx: CanvasRenderingContext2D, size: number, base: string, amp: number): void => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 3000; i++) {
      const v = Math.random() < 0.45 ? 255 : 0;
      ctx.fillStyle = `rgba(${v},${v},${v},${Math.random() * amp})`;
      ctx.beginPath();
      ctx.arc(Math.random() * size, Math.random() * size, 1 + Math.random() * 5, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  return buildSurface({
    size: 512,
    repeat,
    albedo: (ctx, size) => lumps(ctx, size, '#2b2119', 0.16),
    height: (ctx, size) => lumps(ctx, size, '#707070', 0.6),
    roughness: 0.95,
    metalness: 0,
    normalStrength: 2.2,
    normalScale: 0.8,
  });
}
