import * as THREE from 'three';

/**
 * Procedural texture / material library.
 *
 * Everything is generated on a canvas at boot so the template has no external
 * image dependencies. Textures are cached and shared between materials.
 */

const textureCache = new Map<string, THREE.Texture>();

// --------------------------------------------------------------------- noise

function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smoothNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x: number, y: number, octaves: number, seed: number): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    value += smoothNoise(x * frequency, y * frequency, seed + i * 17) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / norm;
}

// ------------------------------------------------------------------ builders

function createCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

function finish(canvas: HTMLCanvasElement, repeat: number, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Converts a height field into a tangent-space normal map. */
function heightToNormalTexture(height: Float32Array, size: number, strength: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
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

interface SurfaceTextures {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/** Concrete-like surface: mottled base colour + speckle + subtle normal. */
function buildConcrete(size: number, baseHex: number, contrast: number, seed: number): SurfaceTextures {
  const { canvas, ctx } = createCanvas(size);
  const img = ctx.createImageData(size, size);
  const rough = createCanvas(size);
  const roughImg = rough.ctx.createImageData(size, size);
  const height = new Float32Array(size * size);

  const base = new THREE.Color(baseHex);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * 8;
      const v = (y / size) * 8;
      const n = fbm(u, v, 5, seed);
      const speck = hash2(x, y, seed + 99) > 0.985 ? 0.35 : 0;
      const shade = 1 - contrast * 0.5 + n * contrast + speck;

      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, base.r * 255 * shade);
      img.data[i + 1] = Math.min(255, base.g * 255 * shade);
      img.data[i + 2] = Math.min(255, base.b * 255 * shade);
      img.data[i + 3] = 255;

      const r = Math.min(255, 150 + n * 110);
      roughImg.data[i] = r;
      roughImg.data[i + 1] = r;
      roughImg.data[i + 2] = r;
      roughImg.data[i + 3] = 255;

      height[y * size + x] = n + speck;
    }
  }

  ctx.putImageData(img, 0, 0);
  rough.ctx.putImageData(roughImg, 0, 0);

  return {
    map: finish(canvas, 1, true),
    normalMap: heightToNormalTexture(height, size, 22),
    roughnessMap: finish(rough.canvas, 1, false),
  };
}

/** Brushed metal panel with rivets and a directional grain. */
function buildMetalPanel(size: number, baseHex: number, seed: number): SurfaceTextures {
  const { canvas, ctx } = createCanvas(size);
  const base = new THREE.Color(baseHex);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const grain = fbm((x / size) * 40, (y / size) * 3, 3, seed);
      const blotch = fbm((x / size) * 4, (y / size) * 4, 4, seed + 5);
      let shade = 0.72 + grain * 0.22 + blotch * 0.2;

      // Panel seams every quarter.
      const seam = x % (size / 2) < 2 || y % (size / 2) < 2;
      if (seam) shade *= 0.55;

      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, base.r * 255 * shade);
      img.data[i + 1] = Math.min(255, base.g * 255 * shade);
      img.data[i + 2] = Math.min(255, base.b * 255 * shade);
      img.data[i + 3] = 255;
      height[y * size + x] = seam ? 0 : 0.5 + grain * 0.5;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Rivets around each panel edge.
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  const step = size / 8;
  for (let i = 0; i < 8; i++) {
    for (const [rx, ry] of [
      [i * step + step / 2, 6],
      [i * step + step / 2, size / 2 + 6],
      [6, i * step + step / 2],
      [size / 2 + 6, i * step + step / 2],
    ]) {
      ctx.beginPath();
      ctx.arc(rx, ry, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const roughCanvas = createCanvas(size);
  const rimg = roughCanvas.ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const r = 90 + fbm(((i % size) / size) * 30, (Math.floor(i / size) / size) * 6, 3, seed + 3) * 90;
    rimg.data[i * 4] = r;
    rimg.data[i * 4 + 1] = r;
    rimg.data[i * 4 + 2] = r;
    rimg.data[i * 4 + 3] = 255;
  }
  roughCanvas.ctx.putImageData(rimg, 0, 0);

  return {
    map: finish(canvas, 1, true),
    normalMap: heightToNormalTexture(height, size, 14),
    roughnessMap: finish(roughCanvas.canvas, 1, false),
  };
}

/** Wood planks for crates and range furniture. */
function buildWood(size: number, seed: number): SurfaceTextures {
  const { canvas, ctx } = createCanvas(size);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  const plankH = size / 4;

  for (let y = 0; y < size; y++) {
    const plank = Math.floor(y / plankH);
    const plankTint = 0.85 + hash2(plank, 0, seed) * 0.3;
    for (let x = 0; x < size; x++) {
      const rings = Math.sin((x / size) * 6 + fbm((x / size) * 6, (y / size) * 26, 3, seed + plank) * 9);
      const grain = 0.72 + rings * 0.14 + fbm((x / size) * 60, (y / size) * 8, 2, seed) * 0.16;
      const edge = y % plankH < 2 ? 0.5 : 1;
      const shade = grain * plankTint * edge;

      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, 148 * shade);
      img.data[i + 1] = Math.min(255, 104 * shade);
      img.data[i + 2] = Math.min(255, 62 * shade);
      img.data[i + 3] = 255;
      height[y * size + x] = edge < 1 ? 0 : grain;
    }
  }
  ctx.putImageData(img, 0, 0);

  const roughCanvas = createCanvas(size);
  roughCanvas.ctx.fillStyle = '#b4b4b4';
  roughCanvas.ctx.fillRect(0, 0, size, size);

  return {
    map: finish(canvas, 1, true),
    normalMap: heightToNormalTexture(height, size, 10),
    roughnessMap: finish(roughCanvas.canvas, 1, false),
  };
}

/** Classic bullseye target face with scoring rings. */
export function createTargetFaceTexture(size = 512): THREE.CanvasTexture {
  const key = `target-face-${size}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;

  const { canvas, ctx } = createCanvas(size);
  ctx.fillStyle = '#efe9dc';
  ctx.fillRect(0, 0, size, size);

  // Paper grain.
  const grain = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 235 + Math.random() * 20;
    grain.data[i * 4] = v;
    grain.data[i * 4 + 1] = v - 4;
    grain.data[i * 4 + 2] = v - 14;
    grain.data[i * 4 + 3] = 26;
  }
  ctx.putImageData(grain, 0, 0);

  const cx = size / 2;
  const cy = size / 2;
  const rings = 6;
  for (let i = rings; i >= 1; i--) {
    const r = (i / rings) * (size * 0.46);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = i <= 2 ? '#c62828' : i % 2 === 0 ? '#f5f1e8' : '#e2dccd';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(30,30,30,0.55)';
    ctx.stroke();

    if (i > 2) {
      ctx.fillStyle = 'rgba(40,40,40,0.75)';
      ctx.font = `${Math.round(size * 0.045)}px "Courier New", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(rings - i + 1), cx, cy - r + size * 0.035);
    }
  }

  // Centre X.
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  const xr = size * 0.035;
  ctx.beginPath();
  ctx.moveTo(cx - xr, cy - xr);
  ctx.lineTo(cx + xr, cy + xr);
  ctx.moveTo(cx + xr, cy - xr);
  ctx.lineTo(cx - xr, cy + xr);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  textureCache.set(key, tex);
  return tex;
}

/** Humanoid silhouette target face. */
export function createSilhouetteTexture(size = 512): THREE.CanvasTexture {
  const key = `silhouette-${size}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;

  const { canvas, ctx } = createCanvas(size);
  ctx.fillStyle = '#d8d2c4';
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = '#2b2b30';
  // Head.
  ctx.beginPath();
  ctx.ellipse(size / 2, size * 0.2, size * 0.11, size * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();
  // Shoulders + torso.
  ctx.beginPath();
  ctx.moveTo(size * 0.5 - size * 0.09, size * 0.31);
  ctx.quadraticCurveTo(size * 0.16, size * 0.36, size * 0.15, size * 0.55);
  ctx.lineTo(size * 0.19, size * 0.95);
  ctx.lineTo(size * 0.81, size * 0.95);
  ctx.lineTo(size * 0.85, size * 0.55);
  ctx.quadraticCurveTo(size * 0.84, size * 0.36, size * 0.5 + size * 0.09, size * 0.31);
  ctx.closePath();
  ctx.fill();

  // Scoring zones.
  ctx.strokeStyle = 'rgba(230,230,230,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(size / 2, size * 0.55, size * 0.19, size * 0.24, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(size / 2, size * 0.55, size * 0.1, size * 0.13, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(size / 2, size * 0.2, size * 0.06, size * 0.07, 0, 0, Math.PI * 2);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  textureCache.set(key, tex);
  return tex;
}

/** Soft radial sprite used for muzzle flashes, smoke and sparks. */
export function createGlowTexture(size = 128): THREE.CanvasTexture {
  const key = `glow-${size}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;

  const { canvas, ctx } = createCanvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, tex);
  return tex;
}

/** Puffy smoke sprite. */
export function createSmokeTexture(size = 128): THREE.CanvasTexture {
  const key = `smoke-${size}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;

  const { canvas, ctx } = createCanvas(size);
  const img = ctx.createImageData(size, size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      const n = fbm((x / size) * 5, (y / size) * 5, 4, 7);
      const a = Math.max(0, 1 - d) * (0.45 + n * 0.75);
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.min(255, a * a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, tex);
  return tex;
}

/** Bullet hole decal — dark crater with a cracked rim. */
export function createBulletHoleTexture(size = 128): THREE.CanvasTexture {
  const key = `bullet-hole-${size}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;

  const { canvas, ctx } = createCanvas(size);
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;

  // Dust ring.
  const ring = ctx.createRadialGradient(c, c, size * 0.1, c, c, size * 0.5);
  ring.addColorStop(0, 'rgba(20,18,16,0.95)');
  ring.addColorStop(0.35, 'rgba(48,44,40,0.6)');
  ring.addColorStop(0.7, 'rgba(120,115,108,0.22)');
  ring.addColorStop(1, 'rgba(120,115,108,0)');
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.5, 0, Math.PI * 2);
  ctx.fill();

  // Core.
  ctx.fillStyle = 'rgba(8,8,10,0.98)';
  ctx.beginPath();
  ctx.arc(c, c, size * 0.14, 0, Math.PI * 2);
  ctx.fill();

  // Radial cracks.
  ctx.strokeStyle = 'rgba(25,23,21,0.7)';
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
    const len = size * (0.18 + Math.random() * 0.22);
    ctx.lineWidth = 1 + Math.random() * 1.6;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * size * 0.11, c + Math.sin(a) * size * 0.11);
    ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, tex);
  return tex;
}


/** Chain-link fence panel — alpha-tested diamond mesh. */
export function createChainLinkTexture(size = 256): THREE.CanvasTexture {
  const key = `chainlink-${size}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;

  const { canvas, ctx } = createCanvas(size);
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = '#b9bfc6';
  ctx.lineWidth = size / 42;
  ctx.lineCap = 'round';
  const step = size / 6;
  for (let i = -6; i <= 12; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step + size, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i * step, size);
    ctx.lineTo(i * step + size, 0);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  textureCache.set(key, tex);
  return tex;
}

/** Vertical gradient used for the volumetric-looking light shafts. */
export function createLightShaftTexture(): THREE.CanvasTexture {
  const key = 'light-shaft';
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;

  const w = 32;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  // Cone UVs run v = 0 at the base, v = 1 at the apex, so the bright end is
  // at the bottom of the image.
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.09)');
  grad.addColorStop(1, 'rgba(255,255,255,0.5)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(key, tex);
  return tex;
}

export type PosterKind = 'safety' | 'zones' | 'rules' | 'hazard';

/** Wall posters for the covered firing line. */
export function createPosterTexture(kind: PosterKind): THREE.CanvasTexture {
  const key = `poster-${kind}`;
  const cached = textureCache.get(key);
  if (cached) return cached as THREE.CanvasTexture;

  const w = 384;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  ctx.fillStyle = '#e9e5da';
  ctx.fillRect(0, 0, w, h);
  // Aged paper speckle.
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(120,110,95,${Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }

  const headline = (text: string, colour: string): void => {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, w, 86);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 40px "Arial Black", Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, 44);
  };

  const lines = (items: string[], startY: number): void => {
    ctx.fillStyle = '#26262a';
    ctx.font = '22px "Courier New", monospace';
    ctx.textAlign = 'left';
    items.forEach((line, i) => ctx.fillText(line, 26, startY + i * 40));
  };

  switch (kind) {
    case 'safety':
      headline('RANGE SAFETY', '#c62828');
      lines(
        ['1. TREAT EVERY WEAPON', '   AS LOADED', '2. MUZZLE DOWNRANGE', '3. FINGER OFF TRIGGER', '4. KNOW YOUR TARGET', '   AND BEYOND'],
        150,
      );
      break;
    case 'zones':
      headline('SCORING ZONES', '#1565c0');
      ctx.strokeStyle = '#26262a';
      ctx.lineWidth = 3;
      for (let i = 5; i >= 1; i--) {
        ctx.beginPath();
        ctx.arc(w / 2, 300, i * 30, 0, Math.PI * 2);
        ctx.fillStyle = i <= 2 ? '#c62828' : '#f2eee3';
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = '#26262a';
      ctx.font = 'bold 22px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('HEAD x2.4   BODY x1.0', w / 2, 470);
      break;
    case 'rules':
      headline('LANE ASSIGNMENT', '#2e7d32');
      lines(
        ['LANE 1  CQB STEEL', 'LANE 2  PENETRATION', 'LANE 3  PRECISION', 'LANE 4  MOVERS', 'LANE 5  LONG RANGE'],
        160,
      );
      break;
    case 'hazard':
      headline('EYE + EAR PPE', '#f0b400');
      ctx.fillStyle = '#26262a';
      ctx.beginPath();
      ctx.ellipse(w / 2, 250, 110, 55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e9e5da';
      ctx.beginPath();
      ctx.ellipse(w / 2 - 45, 250, 38, 34, 0, 0, Math.PI * 2);
      ctx.ellipse(w / 2 + 45, 250, 38, 34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#26262a';
      ctx.font = 'bold 26px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('MANDATORY', w / 2, 400);
      ctx.fillText('BEYOND THIS POINT', w / 2, 436);
      break;
  }

  ctx.strokeStyle = 'rgba(40,40,40,0.5)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, w - 4, h - 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  textureCache.set(key, tex);
  return tex;
}

/** Renders text onto a transparent canvas texture — used for range signage. */
export function createTextTexture(
  text: string,
  opts: {
    width?: number;
    height?: number;
    color?: string;
    background?: string;
    fontSize?: number;
    fontFamily?: string;
    subtitle?: string;
    borderColor?: string;
  } = {},
): THREE.CanvasTexture {
  const width = opts.width ?? 512;
  const height = opts.height ?? 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, width, height);
  }
  if (opts.borderColor) {
    ctx.strokeStyle = opts.borderColor;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, width - 10, height - 10);
  }

  const fontSize = opts.fontSize ?? Math.floor(height * 0.42);
  ctx.fillStyle = opts.color ?? '#f5f5f0';
  ctx.font = `bold ${fontSize}px ${opts.fontFamily ?? '"Arial Black", Impact, sans-serif'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, opts.subtitle ? height * 0.4 : height / 2);

  if (opts.subtitle) {
    ctx.font = `${Math.floor(fontSize * 0.42)}px "Courier New", monospace`;
    ctx.fillText(opts.subtitle, width / 2, height * 0.72);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ----------------------------------------------------------------- materials

export interface WorldMaterials {
  floor: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  concreteDark: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  metalDark: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  gunMetal: THREE.MeshStandardMaterial;
  gunPolymer: THREE.MeshStandardMaterial;
  gunAccent: THREE.MeshStandardMaterial;
  emissiveOrange: THREE.MeshStandardMaterial;
  emissiveCyan: THREE.MeshStandardMaterial;
  hazard: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  paintedRed: THREE.MeshStandardMaterial;
  paintedYellow: THREE.MeshStandardMaterial;
  paintedGreen: THREE.MeshStandardMaterial;
  paintedBlue: THREE.MeshStandardMaterial;
  plastic: THREE.MeshStandardMaterial;
  sandbag: THREE.MeshStandardMaterial;
  tarp: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  chainLink: THREE.MeshStandardMaterial;
  lampLens: THREE.MeshStandardMaterial;
  dirtBerm: THREE.MeshStandardMaterial;
  /** Track surface: dark, matte, tiled tightly so the seams disappear. */
  asphalt: THREE.MeshStandardMaterial;
  /** Track markings, pit boxes, grid slots. */
  whitePaint: THREE.MeshStandardMaterial;
  /** Armco, catch-fence posts, polished trim. */
  chrome: THREE.MeshStandardMaterial;
  /** Run-off gravel traps. */
  gravel: THREE.MeshStandardMaterial;
}

/**
 * A tiny escape hatch for callers that need a one-off procedural texture
 * without reimplementing the canvas plumbing (vehicle liveries, camo, treads).
 */
export function createCanvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  options: { repeat?: number; srgb?: boolean } = {},
): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(size);
  draw(ctx, size);
  return finish(canvas, options.repeat ?? 1, options.srgb ?? true);
}

/** Yellow/black hazard stripes for range boundaries. */
function buildHazard(size = 256): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(size);
  ctx.fillStyle = '#f0b400';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#1a1a1a';
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(Math.PI / 4);
  for (let i = -size; i < size; i += size / 4) {
    ctx.fillRect(i, -size, size / 8, size * 2);
  }
  ctx.restore();
  return finish(canvas, 1, true);
}

let cachedMaterials: WorldMaterials | null = null;

export function createWorldMaterials(): WorldMaterials {
  if (cachedMaterials) return cachedMaterials;

  const floorTex = buildConcrete(512, 0x8a8880, 0.5, 11);
  floorTex.map.repeat.set(24, 24);
  floorTex.normalMap.repeat.set(24, 24);
  floorTex.roughnessMap.repeat.set(24, 24);

  const wallTex = buildConcrete(512, 0x9a978e, 0.42, 3);
  wallTex.map.repeat.set(4, 4);
  wallTex.normalMap.repeat.set(4, 4);
  wallTex.roughnessMap.repeat.set(4, 4);

  const darkTex = buildConcrete(512, 0x55545a, 0.5, 23);
  darkTex.map.repeat.set(3, 3);
  darkTex.normalMap.repeat.set(3, 3);
  darkTex.roughnessMap.repeat.set(3, 3);

  const metalTex = buildMetalPanel(512, 0x9aa2ab, 41);
  const metalDarkTex = buildMetalPanel(512, 0x4d545c, 71);
  const woodTex = buildWood(512, 13);
  // Sunlit turf. ACES tone mapping crushes midtones hard, so the albedo has to
  // sit well above what a colour picker would suggest or a daylit field reads
  // as near-black.
  const grassTex = buildConcrete(512, 0x8a9a5c, 0.55, 91);
  grassTex.map.repeat.set(40, 40);
  grassTex.normalMap.repeat.set(40, 40);
  grassTex.roughnessMap.repeat.set(40, 40);

  // Asphalt tiles far more often than concrete — a 12 m wide ribbon reads as
  // aggregate rather than a smear only if the grain stays small.
  const asphaltTex = buildConcrete(512, 0x4b4d53, 0.34, 137);
  asphaltTex.map.repeat.set(6, 6);
  asphaltTex.normalMap.repeat.set(6, 6);
  asphaltTex.roughnessMap.repeat.set(6, 6);

  const gravelTex = buildConcrete(512, 0x9c9382, 0.75, 211);
  gravelTex.map.repeat.set(14, 14);
  gravelTex.normalMap.repeat.set(14, 14);
  gravelTex.roughnessMap.repeat.set(14, 14);

  cachedMaterials = {
    floor: new THREE.MeshStandardMaterial({
      map: floorTex.map,
      normalMap: floorTex.normalMap,
      roughnessMap: floorTex.roughnessMap,
      roughness: 0.95,
      metalness: 0.02,
      normalScale: new THREE.Vector2(0.6, 0.6),
    }),
    concrete: new THREE.MeshStandardMaterial({
      map: wallTex.map,
      normalMap: wallTex.normalMap,
      roughnessMap: wallTex.roughnessMap,
      roughness: 0.92,
      metalness: 0.02,
    }),
    concreteDark: new THREE.MeshStandardMaterial({
      map: darkTex.map,
      normalMap: darkTex.normalMap,
      roughnessMap: darkTex.roughnessMap,
      roughness: 0.9,
      metalness: 0.05,
    }),
    metal: new THREE.MeshStandardMaterial({
      map: metalTex.map,
      normalMap: metalTex.normalMap,
      roughnessMap: metalTex.roughnessMap,
      roughness: 0.45,
      metalness: 0.85,
    }),
    metalDark: new THREE.MeshStandardMaterial({
      map: metalDarkTex.map,
      normalMap: metalDarkTex.normalMap,
      roughnessMap: metalDarkTex.roughnessMap,
      roughness: 0.55,
      metalness: 0.8,
    }),
    wood: new THREE.MeshStandardMaterial({
      map: woodTex.map,
      normalMap: woodTex.normalMap,
      roughnessMap: woodTex.roughnessMap,
      roughness: 0.85,
      metalness: 0.0,
    }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1c1c20, roughness: 0.95, metalness: 0.0 }),
    gunMetal: new THREE.MeshStandardMaterial({ color: 0x2f3338, roughness: 0.34, metalness: 0.95 }),
    gunPolymer: new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.72, metalness: 0.05 }),
    gunAccent: new THREE.MeshStandardMaterial({ color: 0x6d5230, roughness: 0.5, metalness: 0.6 }),
    emissiveOrange: new THREE.MeshStandardMaterial({
      color: 0x110800,
      emissive: 0xff7a1a,
      emissiveIntensity: 3.5,
      roughness: 0.6,
    }),
    emissiveCyan: new THREE.MeshStandardMaterial({
      color: 0x001114,
      emissive: 0x28e0ff,
      emissiveIntensity: 1.5,
      roughness: 0.6,
    }),
    hazard: new THREE.MeshStandardMaterial({ map: buildHazard(), roughness: 0.8, metalness: 0.1 }),
    grass: new THREE.MeshStandardMaterial({
      map: grassTex.map,
      normalMap: grassTex.normalMap,
      roughnessMap: grassTex.roughnessMap,
      roughness: 1.0,
      metalness: 0.0,
    }),
    paintedRed: new THREE.MeshStandardMaterial({ color: 0xa8332a, roughness: 0.62, metalness: 0.25 }),
    paintedYellow: new THREE.MeshStandardMaterial({ color: 0xd8a41c, roughness: 0.6, metalness: 0.25 }),
    paintedGreen: new THREE.MeshStandardMaterial({ color: 0x3f6b48, roughness: 0.68, metalness: 0.2 }),
    paintedBlue: new THREE.MeshStandardMaterial({ color: 0x2b5a80, roughness: 0.6, metalness: 0.25 }),
    plastic: new THREE.MeshStandardMaterial({ color: 0x2c3138, roughness: 0.45, metalness: 0.02 }),
    sandbag: new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: 1.0, metalness: 0.0 }),
    tarp: new THREE.MeshStandardMaterial({
      color: 0x35402f,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xbfd8e8,
      roughness: 0.06,
      metalness: 0,
      transmission: 0.85,
      thickness: 0.02,
      transparent: true,
      opacity: 0.35,
    }),
    chainLink: new THREE.MeshStandardMaterial({
      map: createChainLinkTexture(),
      transparent: true,
      alphaTest: 0.45,
      roughness: 0.5,
      metalness: 0.85,
      side: THREE.DoubleSide,
    }),
    lampLens: new THREE.MeshStandardMaterial({
      color: 0x2a2e33,
      emissive: 0xdfe9ff,
      emissiveIntensity: 0.85,
      roughness: 0.4,
    }),
    dirtBerm: new THREE.MeshStandardMaterial({ color: 0x6a5c46, roughness: 1.0, metalness: 0.0 }),
    asphalt: new THREE.MeshStandardMaterial({
      map: asphaltTex.map,
      normalMap: asphaltTex.normalMap,
      roughnessMap: asphaltTex.roughnessMap,
      roughness: 0.97,
      metalness: 0.0,
      normalScale: new THREE.Vector2(0.45, 0.45),
    }),
    whitePaint: new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.72, metalness: 0.02 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.24, metalness: 1.0 }),
    gravel: new THREE.MeshStandardMaterial({
      map: gravelTex.map,
      normalMap: gravelTex.normalMap,
      roughnessMap: gravelTex.roughnessMap,
      roughness: 1.0,
      metalness: 0.0,
    }),
  };

  return cachedMaterials;
}
