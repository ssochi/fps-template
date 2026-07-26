import * as THREE from 'three';
import { createCanvasTexture } from './Materials';

/**
 * Materials for the hand-built vehicles and the Thor.
 *
 * Cached process-wide: they are shared between every instance and survive a
 * level swap, so the level's own `dispose()` deliberately leaves them alone.
 */

// ---------------------------------------------------------------- materials

export interface VehicleMaterials {
  carPaint: THREE.MeshStandardMaterial;
  carPaintDark: THREE.MeshStandardMaterial;
  carbon: THREE.MeshStandardMaterial;
  carGlass: THREE.MeshPhysicalMaterial;
  chrome: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  rimGold: THREE.MeshStandardMaterial;
  brakeDisc: THREE.MeshStandardMaterial;
  caliper: THREE.MeshStandardMaterial;
  tailLight: THREE.MeshStandardMaterial;
  headLight: THREE.MeshStandardMaterial;
  interior: THREE.MeshStandardMaterial;
  livery: THREE.MeshStandardMaterial;
  engineRed: THREE.MeshStandardMaterial;
  jeepBody: THREE.MeshStandardMaterial;
  jeepDark: THREE.MeshStandardMaterial;
  canvasTop: THREE.MeshStandardMaterial;
  jeepGlass: THREE.MeshPhysicalMaterial;
  star: THREE.MeshStandardMaterial;
  tankHull: THREE.MeshStandardMaterial;
  tankDark: THREE.MeshStandardMaterial;
  track: THREE.MeshStandardMaterial;
  optic: THREE.MeshStandardMaterial;
  amber: THREE.MeshStandardMaterial;
}

let cached: VehicleMaterials | null = null;

export function carbonTexture(): THREE.Texture {
  return createCanvasTexture(
    256,
    (ctx, size) => {
      ctx.fillStyle = '#14161a';
      ctx.fillRect(0, 0, size, size);
      const cell = size / 16;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          // Alternating warp/weft blocks read as a 2x2 twill at any sane range.
          const warp = (x + y) % 2 === 0;
          const g = ctx.createLinearGradient(
            x * cell,
            y * cell,
            warp ? (x + 1) * cell : x * cell,
            warp ? y * cell : (y + 1) * cell,
          );
          g.addColorStop(0, '#22262c');
          g.addColorStop(0.5, '#0e1013');
          g.addColorStop(1, '#22262c');
          ctx.fillStyle = g;
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    },
    { repeat: 4 },
  );
}

function camoTexture(): THREE.Texture {
  return createCanvasTexture(
    512,
    (ctx, size) => {
      ctx.fillStyle = '#4d5540';
      ctx.fillRect(0, 0, size, size);
      const blobs: [string, number, number][] = [
        ['#39412f', 26, 52],
        ['#5b4c35', 20, 40],
        ['#24281f', 14, 34],
      ];
      for (const [colour, count, radius] of blobs) {
        ctx.fillStyle = colour;
        for (let i = 0; i < count; i++) {
          const cx = Math.random() * size;
          const cy = Math.random() * size;
          ctx.beginPath();
          // Irregular lobed blob rather than a circle, so it reads as camo.
          for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 8) {
            const r = radius * (0.55 + Math.random() * 0.7);
            const x = cx + Math.cos(a) * r;
            const y = cy + Math.sin(a) * r * 0.8;
            if (a === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill();
        }
      }
    },
    { repeat: 2 },
  );
}

function liveryTexture(): THREE.Texture {
  return createCanvasTexture(512, (ctx, size) => {
    ctx.fillStyle = '#b01d2a';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#f2f2ee';
    ctx.beginPath();
    ctx.moveTo(0, size * 0.62);
    ctx.lineTo(size, size * 0.34);
    ctx.lineTo(size, size * 0.66);
    ctx.lineTo(0, size * 0.94);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#12161b';
    ctx.font = `bold ${size * 0.38}px "Arial Black", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('07', size * 0.28, size * 0.44);
    ctx.font = `bold ${size * 0.1}px sans-serif`;
    ctx.fillStyle = '#f2f2ee';
    ctx.fillText('MERIDIAN', size * 0.68, size * 0.24);
  });
}

function starTexture(): THREE.Texture {
  return createCanvasTexture(256, (ctx, size) => {
    ctx.fillStyle = '#4a5238';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#e6e2d0';
    ctx.fillStyle = '#e6e2d0';
    ctx.lineWidth = size * 0.03;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 === 0 ? size * 0.38 : size * 0.16;
      const x = size / 2 + Math.cos(a) * r;
      const y = size / 2 + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  });
}

export function createVehicleMaterials(): VehicleMaterials {
  if (cached) return cached;

  const carbonMap = carbonTexture();
  cached = {
    carPaint: new THREE.MeshStandardMaterial({
      color: 0x9c1420,
      roughness: 0.22,
      metalness: 0.75,
    }),
    carPaintDark: new THREE.MeshStandardMaterial({
      color: 0x17191d,
      roughness: 0.3,
      metalness: 0.7,
    }),
    carbon: new THREE.MeshStandardMaterial({
      map: carbonMap,
      color: 0xffffff,
      roughness: 0.38,
      metalness: 0.45,
    }),
    carGlass: new THREE.MeshPhysicalMaterial({
      color: 0x121a20,
      roughness: 0.05,
      metalness: 0.1,
      transmission: 0.72,
      thickness: 0.03,
      transparent: true,
      opacity: 0.55,
    }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xc6ced8, roughness: 0.15, metalness: 1.0 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.96, metalness: 0.0 }),
    rimGold: new THREE.MeshStandardMaterial({ color: 0xb08a3c, roughness: 0.28, metalness: 0.95 }),
    brakeDisc: new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.55, metalness: 0.6 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xd8a41c, roughness: 0.4, metalness: 0.4 }),
    tailLight: new THREE.MeshStandardMaterial({
      color: 0x2a0304,
      emissive: 0xff1a20,
      emissiveIntensity: 2.6,
      roughness: 0.35,
    }),
    headLight: new THREE.MeshStandardMaterial({
      color: 0x0d1116,
      emissive: 0xdfeaff,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    }),
    interior: new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.85, metalness: 0.05 }),
    livery: new THREE.MeshStandardMaterial({
      map: liveryTexture(),
      roughness: 0.3,
      metalness: 0.4,
      side: THREE.DoubleSide,
    }),
    engineRed: new THREE.MeshStandardMaterial({ color: 0x8c1a12, roughness: 0.4, metalness: 0.7 }),
    jeepBody: new THREE.MeshStandardMaterial({ color: 0x4e5840, roughness: 0.78, metalness: 0.2 }),
    jeepDark: new THREE.MeshStandardMaterial({ color: 0x2b2f28, roughness: 0.7, metalness: 0.4 }),
    canvasTop: new THREE.MeshStandardMaterial({
      color: 0x51553f,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
    }),
    jeepGlass: new THREE.MeshPhysicalMaterial({
      color: 0xa8c0cc,
      roughness: 0.12,
      metalness: 0.0,
      transmission: 0.8,
      thickness: 0.02,
      transparent: true,
      opacity: 0.4,
    }),
    star: new THREE.MeshStandardMaterial({ map: starTexture(), roughness: 0.85, side: THREE.DoubleSide }),
    tankHull: new THREE.MeshStandardMaterial({ map: camoTexture(), roughness: 0.88, metalness: 0.28 }),
    tankDark: new THREE.MeshStandardMaterial({ color: 0x2f342a, roughness: 0.75, metalness: 0.5 }),
    track: new THREE.MeshStandardMaterial({ color: 0x33352f, roughness: 0.72, metalness: 0.6 }),
    optic: new THREE.MeshStandardMaterial({
      color: 0x0a1418,
      emissive: 0x2a6f7a,
      emissiveIntensity: 0.9,
      roughness: 0.15,
      metalness: 0.4,
    }),
    amber: new THREE.MeshStandardMaterial({
      color: 0x201200,
      emissive: 0xffa63c,
      emissiveIntensity: 1.8,
      roughness: 0.4,
    }),
  };
  return cached;
}
