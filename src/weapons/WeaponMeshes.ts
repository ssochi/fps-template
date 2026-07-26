import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { WeaponId } from './WeaponTypes';
import { createWorldMaterials } from '../world/Materials';

/**
 * Procedural weapon models.
 *
 * Every gun is assembled from primitives and exposes a set of named anchors the
 * gameplay systems rely on:
 *
 *   muzzle    – where flashes, smoke and tracers originate
 *   sight     – the point that must line up with screen centre when aiming
 *   ejectPort – where spent casings spawn
 *   magazine  – animated during reloads
 *   slide     – reciprocating mass animated on every shot
 *   charging  – bolt / pump handle animated when the action cycles
 *
 * Replace `buildWeaponModel` with a glTF loader to drop in real art; the rest of
 * the codebase only talks to the anchors.
 */

export interface WeaponModel {
  root: THREE.Group;
  muzzle: THREE.Object3D;
  sight: THREE.Object3D;
  ejectPort: THREE.Object3D;
  magazine: THREE.Object3D | null;
  slide: THREE.Object3D | null;
  charging: THREE.Object3D | null;
  /** Scope lens mesh, present on the sniper only. */
  scopeLens: THREE.Object3D | null;
  /** Where the trigger hand sits. */
  gripAnchor: THREE.Object3D;
  /** Where the support hand sits — parented to the pump on the shotgun. */
  foreAnchor: THREE.Object3D;
  /** Length used to place the model sensibly in third person. */
  length: number;
}

const roundedCache = new Map<string, THREE.BufferGeometry>();

function roundedBox(w: number, h: number, d: number, radius = 0.004, segments = 2): THREE.BufferGeometry {
  const r = Math.min(radius, w / 2.2, h / 2.2, d / 2.2);
  const key = `${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}|${r.toFixed(4)}|${segments}`;
  let geo = roundedCache.get(key);
  if (!geo) {
    geo = new RoundedBoxGeometry(w, h, d, segments, r);
    roundedCache.set(key, geo);
  }
  return geo;
}

function part(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function boxPart(
  parent: THREE.Object3D,
  mat: THREE.Material,
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
  radius = 0.004,
): THREE.Mesh {
  return part(parent, roundedBox(w, h, d, radius), mat, x, y, z);
}

function cylinderPart(
  parent: THREE.Object3D,
  mat: THREE.Material,
  rTop: number,
  rBottom: number,
  height: number,
  x = 0,
  y = 0,
  z = 0,
  radialSegments = 12,
): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, height, radialSegments);
  const mesh = part(parent, geo, mat, x, y, z);
  // Cylinders default to +Y; guns are built along -Z so rotate onto the axis.
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function anchor(parent: THREE.Object3D, name: string, x: number, y: number, z: number): THREE.Object3D {
  const obj = new THREE.Object3D();
  obj.name = name;
  obj.position.set(x, y, z);
  parent.add(obj);
  return obj;
}

/** Iron sight posts: a front blade and a rear notch aligned on the sight line. */
function addIronSights(
  parent: THREE.Object3D,
  mat: THREE.Material,
  sightY: number,
  frontZ: number,
  rearZ: number,
  height = 0.008,
): THREE.Object3D {
  boxPart(parent, mat, 0.0035, height, 0.004, 0, sightY - height / 2, frontZ, 0.001);
  const rear = new THREE.Group();
  rear.position.set(0, sightY - height / 2, rearZ);
  boxPart(rear, mat, 0.004, height, 0.005, -0.008, 0, 0, 0.001);
  boxPart(rear, mat, 0.004, height, 0.005, 0.008, 0, 0, 0.001);
  parent.add(rear);
  return anchor(parent, 'sight', 0, sightY + 0.0015, rearZ);
}


/** Small shared details that make every gun read as a real object. */
function addSlingLoop(parent: THREE.Object3D, mat: THREE.Material, x: number, y: number, z: number): void {
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.011, 0.0035, 6, 12), mat);
  loop.position.set(x, y, z);
  loop.rotation.y = Math.PI / 2;
  loop.castShadow = true;
  parent.add(loop);
}

/** Fire selector paddle — a tiny detail the eye picks up instantly. */
function addSelector(parent: THREE.Object3D, mat: THREE.Material, x: number, y: number, z: number): void {
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.022, 0.009), mat);
  lever.position.set(x, y, z);
  lever.rotation.z = -0.5;
  lever.castShadow = true;
  parent.add(lever);
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.005, 10), mat);
  boss.position.set(x, y, z);
  boss.rotation.z = Math.PI / 2;
  parent.add(boss);
}

let tritiumMaterial: THREE.MeshStandardMaterial | null = null;

/** Glowing tritium dot for night sights. */
function addTritium(parent: THREE.Object3D, x: number, y: number, z: number, colour = 0x66ff99): void {
  if (!tritiumMaterial) {
    tritiumMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      emissive: colour,
      emissiveIntensity: 2.4,
      roughness: 0.4,
    });
  }
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0016, 6, 5), tritiumMaterial);
  dot.position.set(x, y, z);
  parent.add(dot);
}

/** Picatinny rail with cross-slots. */
function addRail(
  parent: THREE.Object3D,
  mat: THREE.Material,
  length: number,
  x: number,
  y: number,
  z: number,
  width = 0.024,
): void {
  boxPart(parent, mat, width, 0.008, length, x, y, z, 0.002);
  const slots = Math.max(2, Math.floor(length / 0.021));
  for (let i = 0; i < slots; i++) {
    boxPart(parent, mat, width + 0.002, 0.005, 0.005, x, y + 0.005, z - length / 2 + 0.01 + i * 0.021, 0.001);
  }
}

// ---------------------------------------------------------------- the guns

function buildPistol(): WeaponModel {
  const m = createWorldMaterials();
  const root = new THREE.Group();
  root.name = 'weapon-pistol';

  // Slide (reciprocates on every shot).
  const slide = new THREE.Group();
  root.add(slide);
  boxPart(slide, m.gunMetal, 0.028, 0.036, 0.185, 0, 0.022, -0.045, 0.005);
  // Serrations.
  for (let i = 0; i < 5; i++) {
    boxPart(slide, m.gunPolymer, 0.0295, 0.026, 0.0035, 0, 0.022, 0.028 - i * 0.009, 0.001);
  }
  // Ejection port cut.
  boxPart(slide, m.gunPolymer, 0.03, 0.014, 0.05, 0.001, 0.03, -0.03, 0.001);

  // Barrel + crown.
  cylinderPart(slide, m.gunMetal, 0.0075, 0.0075, 0.02, 0, 0.022, -0.135, 12);
  const bore = cylinderPart(slide, m.rubber, 0.0045, 0.0045, 0.006, 0, 0.022, -0.14, 10);
  bore.castShadow = false;

  // Frame + trigger guard.
  boxPart(root, m.gunPolymer, 0.024, 0.02, 0.14, 0, -0.002, -0.03, 0.004);
  boxPart(root, m.gunPolymer, 0.02, 0.006, 0.045, 0, -0.026, -0.015, 0.002);
  boxPart(root, m.gunPolymer, 0.02, 0.024, 0.006, 0, -0.016, 0.005, 0.002);
  boxPart(root, m.gunPolymer, 0.02, 0.024, 0.006, 0, -0.016, -0.037, 0.002);
  boxPart(root, m.gunMetal, 0.008, 0.018, 0.005, 0, -0.019, -0.017, 0.002);

  // Grip, canted back like a real pistol.
  const grip = new THREE.Group();
  grip.position.set(0, -0.05, 0.028);
  grip.rotation.x = -0.28;
  root.add(grip);
  boxPart(grip, m.gunPolymer, 0.026, 0.095, 0.038, 0, 0, 0, 0.006);
  for (let i = 0; i < 6; i++) {
    boxPart(grip, m.rubber, 0.0275, 0.004, 0.039, 0, 0.03 - i * 0.013, 0, 0.001);
  }

  // Magazine (animated on reload).
  const magazine = new THREE.Group();
  magazine.position.set(0, -0.05, 0.028);
  magazine.rotation.x = -0.28;
  root.add(magazine);
  boxPart(magazine, m.gunMetal, 0.02, 0.09, 0.03, 0, -0.004, 0, 0.003);
  boxPart(magazine, m.gunPolymer, 0.028, 0.008, 0.042, 0, -0.05, 0, 0.002);

  addSelector(root, m.gunMetal, -0.015, 0.002, 0.014);
  addSlingLoop(root, m.gunMetal, -0.014, -0.012, 0.05);

  const sight = addIronSights(slide, m.gunMetal, 0.044, -0.12, 0.028, 0.008);
  addTritium(slide, 0, 0.042, -0.12);
  addTritium(slide, -0.008, 0.042, 0.028);
  addTritium(slide, 0.008, 0.042, 0.028);
  const muzzle = anchor(root, 'muzzle', 0, 0.022, -0.145);
  const ejectPort = anchor(root, 'ejectPort', 0.02, 0.032, -0.03);
  const gripAnchor = anchor(root, 'gripAnchor', 0, -0.062, 0.038);
  const foreAnchor = anchor(root, 'foreAnchor', -0.028, -0.062, 0.028);

  return {
    root,
    muzzle,
    sight,
    ejectPort,
    magazine,
    slide,
    charging: null,
    scopeLens: null,
    gripAnchor,
    foreAnchor,
    length: 0.22,
  };
}

function buildSmg(): WeaponModel {
  const m = createWorldMaterials();
  const root = new THREE.Group();
  root.name = 'weapon-smg';

  // Upper receiver + rail.
  boxPart(root, m.gunPolymer, 0.05, 0.062, 0.29, 0, 0.02, -0.06, 0.006);
  const rail = boxPart(root, m.gunMetal, 0.024, 0.008, 0.24, 0, 0.055, -0.07, 0.002);
  for (let i = 0; i < 12; i++) {
    boxPart(root, m.gunMetal, 0.026, 0.004, 0.004, 0, 0.06, -0.175 + i * 0.019, 0.001);
  }
  rail.castShadow = true;

  // Barrel shroud with cooling slots + suppressor-ish muzzle device.
  cylinderPart(root, m.gunMetal, 0.017, 0.017, 0.15, 0, 0.018, -0.24, 14);
  for (let i = 0; i < 5; i++) {
    boxPart(root, m.gunPolymer, 0.036, 0.008, 0.016, 0, 0.018, -0.19 - i * 0.024, 0.002);
  }
  cylinderPart(root, m.gunMetal, 0.012, 0.014, 0.045, 0, 0.018, -0.335, 12);
  const bore = cylinderPart(root, m.rubber, 0.0055, 0.0055, 0.008, 0, 0.018, -0.354, 10);
  bore.castShadow = false;

  // Bolt / charging handle.
  const charging = new THREE.Group();
  root.add(charging);
  boxPart(charging, m.gunMetal, 0.016, 0.014, 0.05, -0.032, 0.03, -0.02, 0.003);

  // Grip + magwell (magazine feeds through the grip, Vector style).
  const grip = new THREE.Group();
  grip.position.set(0, -0.055, 0.005);
  grip.rotation.x = -0.2;
  root.add(grip);
  boxPart(grip, m.gunPolymer, 0.034, 0.11, 0.052, 0, 0, 0, 0.007);

  const magazine = new THREE.Group();
  magazine.position.set(0, -0.06, 0.005);
  magazine.rotation.x = -0.2;
  root.add(magazine);
  boxPart(magazine, m.gunPolymer, 0.026, 0.13, 0.038, 0, -0.02, 0, 0.004);
  boxPart(magazine, m.gunMetal, 0.03, 0.008, 0.044, 0, -0.088, 0, 0.002);

  // Trigger guard.
  boxPart(root, m.gunPolymer, 0.026, 0.006, 0.055, 0, -0.03, -0.03, 0.002);
  boxPart(root, m.gunMetal, 0.008, 0.02, 0.005, 0, -0.02, -0.036, 0.002);

  // Fore grip.
  const foreGrip = new THREE.Group();
  foreGrip.position.set(0, -0.03, -0.19);
  foreGrip.rotation.x = 0.12;
  root.add(foreGrip);
  boxPart(foreGrip, m.gunPolymer, 0.03, 0.07, 0.03, 0, -0.025, 0, 0.006);

  // Folding stock.
  const stock = new THREE.Group();
  root.add(stock);
  boxPart(stock, m.gunMetal, 0.012, 0.012, 0.13, -0.02, 0.03, 0.13, 0.003);
  boxPart(stock, m.gunMetal, 0.012, 0.012, 0.13, 0.02, 0.03, 0.13, 0.003);
  boxPart(stock, m.rubber, 0.055, 0.075, 0.02, 0, 0.02, 0.195, 0.005);

  addSelector(root, m.gunMetal, -0.028, -0.006, 0.02);
  addSlingLoop(root, m.gunMetal, -0.028, 0.04, 0.1);
  addSlingLoop(root, m.gunMetal, -0.02, 0.0, -0.2);

  const sight = addIronSights(root, m.gunMetal, 0.075, -0.17, 0.03, 0.012);
  addTritium(root, 0, 0.072, -0.17);
  const muzzle = anchor(root, 'muzzle', 0, 0.018, -0.36);
  const ejectPort = anchor(root, 'ejectPort', 0.03, 0.03, -0.03);
  const gripAnchor = anchor(root, 'gripAnchor', 0, -0.075, 0.02);
  const foreAnchor = anchor(root, 'foreAnchor', 0, -0.075, -0.185);

  return {
    root,
    muzzle,
    sight,
    ejectPort,
    magazine,
    slide: null,
    charging,
    scopeLens: null,
    gripAnchor,
    foreAnchor,
    length: 0.45,
  };
}

function buildRifle(): WeaponModel {
  const m = createWorldMaterials();
  const root = new THREE.Group();
  root.name = 'weapon-rifle';

  // Upper + lower receiver.
  boxPart(root, m.gunMetal, 0.045, 0.055, 0.22, 0, 0.03, -0.02, 0.005);
  boxPart(root, m.gunPolymer, 0.042, 0.05, 0.16, 0, -0.012, 0.01, 0.005);

  // Top rail.
  boxPart(root, m.gunMetal, 0.024, 0.008, 0.42, 0, 0.062, -0.12, 0.002);
  for (let i = 0; i < 20; i++) {
    boxPart(root, m.gunMetal, 0.026, 0.005, 0.005, 0, 0.067, -0.32 + i * 0.021, 0.001);
  }

  // Free-float handguard with M-LOK style slots.
  boxPart(root, m.gunPolymer, 0.044, 0.046, 0.3, 0, 0.03, -0.28, 0.008);
  for (let i = 0; i < 6; i++) {
    boxPart(root, m.rubber, 0.046, 0.012, 0.028, 0, 0.018, -0.4 + i * 0.045, 0.002);
    boxPart(root, m.rubber, 0.046, 0.012, 0.028, 0, 0.045, -0.4 + i * 0.045, 0.002);
  }

  // Barrel + flash hider.
  cylinderPart(root, m.gunMetal, 0.011, 0.011, 0.2, 0, 0.03, -0.5, 14);
  cylinderPart(root, m.gunMetal, 0.014, 0.012, 0.055, 0, 0.03, -0.615, 12);
  for (let i = 0; i < 3; i++) {
    boxPart(root, m.gunPolymer, 0.032, 0.006, 0.008, 0, 0.03, -0.6 - i * 0.014, 0.001);
  }
  const bore = cylinderPart(root, m.rubber, 0.006, 0.006, 0.01, 0, 0.03, -0.642, 10);
  bore.castShadow = false;

  // Gas block + tube.
  boxPart(root, m.gunMetal, 0.022, 0.026, 0.03, 0, 0.036, -0.44, 0.003);
  cylinderPart(root, m.gunMetal, 0.004, 0.004, 0.22, 0, 0.05, -0.33, 8);

  // Forward assist + charging handle.
  const charging = new THREE.Group();
  root.add(charging);
  boxPart(charging, m.gunMetal, 0.05, 0.012, 0.03, 0, 0.055, 0.098, 0.003);
  boxPart(charging, m.gunMetal, 0.016, 0.012, 0.05, -0.03, 0.055, 0.09, 0.003);

  // Pistol grip.
  const grip = new THREE.Group();
  grip.position.set(0, -0.06, 0.055);
  grip.rotation.x = -0.32;
  root.add(grip);
  boxPart(grip, m.gunPolymer, 0.032, 0.1, 0.045, 0, 0, 0, 0.008);

  // Curved STANAG magazine built from stacked, progressively rotated slabs.
  const magazine = new THREE.Group();
  magazine.position.set(0, -0.035, -0.02);
  root.add(magazine);
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    boxPart(magazine, m.gunPolymer, 0.026, 0.026, 0.036, 0, -i * 0.024, t * t * 0.03, 0.003);
  }
  boxPart(magazine, m.gunMetal, 0.03, 0.008, 0.042, 0, -0.168, 0.032, 0.002);

  // Trigger guard + trigger.
  boxPart(root, m.gunPolymer, 0.026, 0.006, 0.06, 0, -0.038, 0.01, 0.002);
  boxPart(root, m.gunMetal, 0.008, 0.022, 0.005, 0, -0.026, 0.002, 0.002);

  // Collapsible stock.
  boxPart(root, m.gunMetal, 0.026, 0.026, 0.12, 0, 0.02, 0.15, 0.004);
  boxPart(root, m.gunPolymer, 0.05, 0.07, 0.13, 0, 0.012, 0.22, 0.008);
  boxPart(root, m.rubber, 0.052, 0.075, 0.016, 0, 0.008, 0.288, 0.004);
  boxPart(root, m.gunPolymer, 0.03, 0.03, 0.09, 0, -0.022, 0.19, 0.006);

  // Red-dot optic sitting on the rail.
  const optic = new THREE.Group();
  optic.position.set(0, 0.066, -0.06);
  root.add(optic);
  boxPart(optic, m.gunPolymer, 0.03, 0.012, 0.06, 0, 0.006, 0, 0.003);
  boxPart(optic, m.gunPolymer, 0.006, 0.036, 0.008, -0.017, 0.03, -0.022, 0.002);
  boxPart(optic, m.gunPolymer, 0.006, 0.036, 0.008, 0.017, 0.03, -0.022, 0.002);
  boxPart(optic, m.gunPolymer, 0.006, 0.036, 0.008, -0.017, 0.03, 0.022, 0.002);
  boxPart(optic, m.gunPolymer, 0.006, 0.036, 0.008, 0.017, 0.03, 0.022, 0.002);
  boxPart(optic, m.gunPolymer, 0.04, 0.008, 0.052, 0, 0.05, 0, 0.002);
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.015, 20),
    new THREE.MeshStandardMaterial({
      color: 0x0a1a1a,
      roughness: 0.1,
      metalness: 0.2,
      transparent: true,
      opacity: 0.55,
    }),
  );
  lens.position.set(0, 0.03, 0.02);
  lens.rotation.y = Math.PI;
  optic.add(lens);
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.0016, 10),
    new THREE.MeshBasicMaterial({ color: 0xff2200, toneMapped: false }),
  );
  dot.position.set(0, 0.03, 0.019);
  dot.rotation.y = Math.PI;
  optic.add(dot);

  addSelector(root, m.gunMetal, -0.024, -0.008, 0.052);
  addSlingLoop(root, m.gunMetal, -0.024, 0.0, 0.15);
  addSlingLoop(root, m.gunMetal, -0.024, 0.012, -0.4);

  // Back-up iron sights sit slightly lower; the optic defines the aim line.
  boxPart(root, m.gunMetal, 0.004, 0.01, 0.004, 0, 0.071, -0.32, 0.001);
  const sight = anchor(root, 'sight', 0, 0.096, -0.06);

  const muzzle = anchor(root, 'muzzle', 0, 0.03, -0.65);
  const ejectPort = anchor(root, 'ejectPort', 0.026, 0.04, 0.02);
  const gripAnchor = anchor(root, 'gripAnchor', 0, -0.085, 0.08);
  const foreAnchor = anchor(root, 'foreAnchor', 0, -0.005, -0.3);

  return {
    root,
    muzzle,
    sight,
    ejectPort,
    magazine,
    slide: null,
    charging,
    scopeLens: null,
    gripAnchor,
    foreAnchor,
    length: 0.86,
  };
}

function buildSniper(): WeaponModel {
  const m = createWorldMaterials();
  const root = new THREE.Group();
  root.name = 'weapon-sniper';

  // Receiver.
  boxPart(root, m.gunMetal, 0.042, 0.05, 0.28, 0, 0.02, 0.02, 0.005);

  // Heavy fluted barrel.
  cylinderPart(root, m.gunMetal, 0.012, 0.016, 0.55, 0, 0.02, -0.4, 16);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const flute = cylinderPart(root, m.gunPolymer, 0.0035, 0.0035, 0.42, Math.cos(a) * 0.0125, 0.02 + Math.sin(a) * 0.0125, -0.4, 6);
    flute.castShadow = false;
  }
  // Muzzle brake.
  cylinderPart(root, m.gunMetal, 0.017, 0.017, 0.075, 0, 0.02, -0.71, 14);
  for (let i = 0; i < 3; i++) {
    boxPart(root, m.gunPolymer, 0.04, 0.008, 0.01, 0, 0.02, -0.69 - i * 0.02, 0.001);
  }
  const bore = cylinderPart(root, m.rubber, 0.0075, 0.0075, 0.012, 0, 0.02, -0.746, 10);
  bore.castShadow = false;

  // Chassis / forend.
  boxPart(root, m.gunPolymer, 0.05, 0.05, 0.34, 0, 0.005, -0.25, 0.008);
  for (let i = 0; i < 5; i++) {
    boxPart(root, m.rubber, 0.052, 0.014, 0.03, 0, 0.0, -0.36 + i * 0.05, 0.002);
  }

  // Bolt handle (animated when cycling).
  const charging = new THREE.Group();
  charging.position.set(0.021, 0.03, 0.06);
  root.add(charging);
  const boltArm = boxPart(charging, m.gunMetal, 0.055, 0.011, 0.011, 0.027, 0, 0, 0.004);
  boltArm.rotation.z = -0.25;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 10), m.gunMetal);
  knob.position.set(0.056, -0.014, 0);
  knob.castShadow = true;
  charging.add(knob);

  // Scope.
  const scope = new THREE.Group();
  scope.position.set(0, 0.078, -0.03);
  root.add(scope);
  cylinderPart(scope, m.gunPolymer, 0.019, 0.019, 0.24, 0, 0, -0.02, 18);
  cylinderPart(scope, m.gunPolymer, 0.028, 0.024, 0.075, 0, 0, -0.17, 18);
  cylinderPart(scope, m.gunPolymer, 0.024, 0.022, 0.06, 0, 0, 0.12, 18);
  // Turrets.
  cylinderPart(scope, m.gunMetal, 0.011, 0.011, 0.02, 0, 0.026, -0.02, 12).rotation.set(0, 0, 0);
  const windage = cylinderPart(scope, m.gunMetal, 0.011, 0.011, 0.02, 0.026, 0, -0.02, 12);
  windage.rotation.set(0, 0, Math.PI / 2);
  // Rings.
  boxPart(scope, m.gunMetal, 0.03, 0.03, 0.018, 0, -0.012, -0.07, 0.004);
  boxPart(scope, m.gunMetal, 0.03, 0.03, 0.018, 0, -0.012, 0.06, 0.004);

  const scopeLens = new THREE.Mesh(
    new THREE.CircleGeometry(0.021, 24),
    new THREE.MeshStandardMaterial({
      color: 0x0d1c2a,
      roughness: 0.05,
      metalness: 0.4,
      emissive: 0x0a1420,
      emissiveIntensity: 0.6,
    }),
  );
  scopeLens.position.set(0, 0, 0.148);
  scopeLens.rotation.y = Math.PI;
  scope.add(scopeLens);
  const objective = new THREE.Mesh(
    new THREE.CircleGeometry(0.024, 24),
    new THREE.MeshStandardMaterial({ color: 0x16324a, roughness: 0.05, metalness: 0.6 }),
  );
  objective.position.set(0, 0, -0.206);
  scope.add(objective);

  // Grip + stock with cheek riser.
  const grip = new THREE.Group();
  grip.position.set(0, -0.055, 0.09);
  grip.rotation.x = -0.3;
  root.add(grip);
  boxPart(grip, m.gunPolymer, 0.032, 0.1, 0.045, 0, 0, 0, 0.008);

  boxPart(root, m.gunPolymer, 0.045, 0.075, 0.2, 0, 0.005, 0.24, 0.01);
  boxPart(root, m.gunPolymer, 0.04, 0.03, 0.13, 0, 0.05, 0.24, 0.006);
  boxPart(root, m.rubber, 0.048, 0.09, 0.018, 0, -0.005, 0.345, 0.005);

  // Detachable box magazine.
  const magazine = new THREE.Group();
  magazine.position.set(0, -0.03, -0.01);
  root.add(magazine);
  boxPart(magazine, m.gunMetal, 0.03, 0.075, 0.06, 0, -0.03, 0, 0.004);

  // Trigger guard.
  boxPart(root, m.gunPolymer, 0.026, 0.006, 0.06, 0, -0.032, 0.05, 0.002);
  boxPart(root, m.gunMetal, 0.008, 0.022, 0.005, 0, -0.02, 0.04, 0.002);

  // Folded bipod.
  const bipod = new THREE.Group();
  bipod.position.set(0, -0.022, -0.38);
  root.add(bipod);
  const legL = boxPart(bipod, m.gunMetal, 0.008, 0.008, 0.12, -0.012, -0.01, 0.05, 0.002);
  legL.rotation.x = 0.25;
  const legR = boxPart(bipod, m.gunMetal, 0.008, 0.008, 0.12, 0.012, -0.01, 0.05, 0.002);
  legR.rotation.x = 0.25;

  addSlingLoop(root, m.gunMetal, -0.024, 0.0, 0.22);
  addSlingLoop(root, m.gunMetal, -0.028, -0.012, -0.32);

  const sight = anchor(root, 'sight', 0, 0.078, -0.03);
  const muzzle = anchor(root, 'muzzle', 0, 0.02, -0.755);
  const ejectPort = anchor(root, 'ejectPort', 0.024, 0.035, 0.045);
  const gripAnchor = anchor(root, 'gripAnchor', 0, -0.08, 0.115);
  const foreAnchor = anchor(root, 'foreAnchor', 0, -0.03, -0.28);

  return {
    root,
    muzzle,
    sight,
    ejectPort,
    magazine,
    slide: null,
    charging,
    scopeLens,
    gripAnchor,
    foreAnchor,
    length: 1.2,
  };
}

function buildShotgun(): WeaponModel {
  const m = createWorldMaterials();
  const root = new THREE.Group();
  root.name = 'weapon-shotgun';

  // Receiver.
  boxPart(root, m.gunMetal, 0.046, 0.058, 0.22, 0, 0.015, 0.02, 0.006);

  // Barrel + magazine tube.
  cylinderPart(root, m.gunMetal, 0.016, 0.016, 0.52, 0, 0.028, -0.36, 16);
  cylinderPart(root, m.gunMetal, 0.012, 0.012, 0.42, 0, -0.005, -0.31, 12);
  // Barrel band.
  boxPart(root, m.gunMetal, 0.036, 0.055, 0.016, 0, 0.012, -0.5, 0.003);
  const bore = cylinderPart(root, m.rubber, 0.0115, 0.0115, 0.014, 0, 0.028, -0.612, 12);
  bore.castShadow = false;

  // Pump fore-end (animated when cycling).
  const charging = new THREE.Group();
  charging.position.set(0, 0, 0);
  root.add(charging);
  boxPart(charging, m.wood, 0.046, 0.05, 0.17, 0, 0.005, -0.24, 0.008);
  for (let i = 0; i < 7; i++) {
    boxPart(charging, m.gunPolymer, 0.048, 0.007, 0.008, 0, 0.005, -0.31 + i * 0.022, 0.001);
  }

  // Loading port + shell lifter.
  boxPart(root, m.gunPolymer, 0.03, 0.014, 0.07, 0, -0.016, 0.01, 0.002);

  // Stock + grip.
  const grip = new THREE.Group();
  grip.position.set(0, -0.05, 0.09);
  grip.rotation.x = -0.35;
  root.add(grip);
  boxPart(grip, m.wood, 0.034, 0.095, 0.05, 0, 0, 0, 0.008);

  boxPart(root, m.wood, 0.046, 0.08, 0.2, 0, -0.005, 0.22, 0.012);
  boxPart(root, m.rubber, 0.05, 0.095, 0.02, 0, -0.015, 0.325, 0.006);

  // Trigger guard.
  boxPart(root, m.gunMetal, 0.026, 0.006, 0.058, 0, -0.032, 0.045, 0.002);
  boxPart(root, m.gunMetal, 0.008, 0.022, 0.005, 0, -0.02, 0.036, 0.002);

  // Bead front sight + ghost ring rear.
  const bead = new THREE.Mesh(
    new THREE.SphereGeometry(0.004, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0x554400, emissiveIntensity: 0.8, roughness: 0.4 }),
  );
  bead.position.set(0, 0.05, -0.59);
  bead.castShadow = true;
  root.add(bead);

  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.002, 8, 18), m.gunMetal);
  ring.position.set(0, 0.05, 0.1);
  ring.castShadow = true;
  root.add(ring);

  addSlingLoop(root, m.gunMetal, -0.026, -0.01, 0.2);
  addSlingLoop(root, m.gunMetal, 0, -0.012, -0.5);

  const sight = anchor(root, 'sight', 0, 0.05, 0.1);
  const muzzle = anchor(root, 'muzzle', 0, 0.028, -0.62);
  const ejectPort = anchor(root, 'ejectPort', 0.026, 0.02, 0.03);
  const gripAnchor = anchor(root, 'gripAnchor', 0, -0.075, 0.115);
  // Parented to the pump so the support hand rides the fore-end when cycling.
  const foreAnchor = anchor(charging, 'foreAnchor', 0, -0.035, -0.24);

  return {
    root,
    muzzle,
    sight,
    ejectPort,
    magazine: null,
    slide: null,
    charging,
    scopeLens: null,
    gripAnchor,
    foreAnchor,
    length: 1.0,
  };
}

function buildMachinePistol(): WeaponModel {
  const m = createWorldMaterials();
  const root = new THREE.Group();
  root.name = 'weapon-machine-pistol';

  const slide = new THREE.Group();
  root.add(slide);
  boxPart(slide, m.gunMetal, 0.03, 0.04, 0.2, 0, 0.024, -0.05, 0.005);
  for (let i = 0; i < 6; i++) {
    boxPart(slide, m.gunPolymer, 0.0315, 0.028, 0.0035, 0, 0.024, 0.03 - i * 0.009, 0.001);
  }
  boxPart(slide, m.gunPolymer, 0.032, 0.015, 0.055, 0.001, 0.033, -0.035, 0.001);
  cylinderPart(slide, m.gunMetal, 0.008, 0.008, 0.03, 0, 0.024, -0.15, 12);
  // Compensator ports.
  for (let i = 0; i < 3; i++) {
    boxPart(slide, m.gunPolymer, 0.02, 0.006, 0.006, 0, 0.04, -0.142 - i * 0.012, 0.001);
  }
  const bore = cylinderPart(slide, m.rubber, 0.0045, 0.0045, 0.006, 0, 0.024, -0.163, 10);
  bore.castShadow = false;

  boxPart(root, m.gunPolymer, 0.026, 0.024, 0.155, 0, -0.004, -0.035, 0.004);
  boxPart(root, m.gunPolymer, 0.022, 0.006, 0.05, 0, -0.03, -0.02, 0.002);
  boxPart(root, m.gunPolymer, 0.022, 0.026, 0.006, 0, -0.019, 0.006, 0.002);
  boxPart(root, m.gunMetal, 0.008, 0.018, 0.005, 0, -0.022, -0.02, 0.002);

  const grip = new THREE.Group();
  grip.position.set(0, -0.055, 0.03);
  grip.rotation.x = -0.26;
  root.add(grip);
  boxPart(grip, m.gunPolymer, 0.028, 0.1, 0.04, 0, 0, 0, 0.006);
  for (let i = 0; i < 6; i++) {
    boxPart(grip, m.rubber, 0.0295, 0.004, 0.041, 0, 0.032 - i * 0.014, 0, 0.001);
  }

  // Extended 20-round magazine hanging well below the grip.
  const magazine = new THREE.Group();
  magazine.position.set(0, -0.055, 0.03);
  magazine.rotation.x = -0.26;
  root.add(magazine);
  boxPart(magazine, m.gunMetal, 0.022, 0.15, 0.032, 0, -0.035, 0, 0.003);
  boxPart(magazine, m.gunPolymer, 0.03, 0.008, 0.044, 0, -0.114, 0, 0.002);

  // Folding fore-grip.
  const foreGrip = new THREE.Group();
  foreGrip.position.set(0, -0.028, -0.1);
  foreGrip.rotation.x = 0.15;
  root.add(foreGrip);
  boxPart(foreGrip, m.gunPolymer, 0.024, 0.055, 0.024, 0, -0.02, 0, 0.005);

  addSelector(root, m.gunMetal, -0.017, 0.0, 0.012);
  addSlingLoop(root, m.gunMetal, -0.016, -0.012, 0.05);

  const sight = addIronSights(slide, m.gunMetal, 0.048, -0.13, 0.03, 0.009);
  addTritium(slide, 0, 0.046, -0.13);
  addTritium(slide, -0.008, 0.046, 0.03);
  addTritium(slide, 0.008, 0.046, 0.03);

  const muzzle = anchor(root, 'muzzle', 0, 0.024, -0.168);
  const ejectPort = anchor(root, 'ejectPort', 0.022, 0.034, -0.035);
  const gripAnchor = anchor(root, 'gripAnchor', 0, -0.066, 0.042);
  const foreAnchor = anchor(root, 'foreAnchor', 0, -0.075, -0.108);

  return {
    root,
    muzzle,
    sight,
    ejectPort,
    magazine,
    slide,
    charging: null,
    scopeLens: null,
    gripAnchor,
    foreAnchor,
    length: 0.28,
  };
}

function buildRevolver(): WeaponModel {
  const m = createWorldMaterials();
  const root = new THREE.Group();
  root.name = 'weapon-revolver';

  // Frame and top strap.
  boxPart(root, m.gunMetal, 0.026, 0.05, 0.13, 0, 0.014, -0.03, 0.005);
  boxPart(root, m.gunMetal, 0.024, 0.012, 0.1, 0, 0.041, -0.05, 0.002);

  // Heavy barrel with a vented rib and ejector shroud.
  cylinderPart(root, m.gunMetal, 0.011, 0.011, 0.19, 0, 0.026, -0.155, 14);
  boxPart(root, m.gunMetal, 0.018, 0.012, 0.19, 0, 0.041, -0.155, 0.002);
  for (let i = 0; i < 6; i++) {
    boxPart(root, m.gunPolymer, 0.02, 0.006, 0.008, 0, 0.043, -0.09 - i * 0.024, 0.001);
  }
  boxPart(root, m.gunMetal, 0.02, 0.016, 0.17, 0, 0.008, -0.15, 0.003);
  const bore = cylinderPart(root, m.rubber, 0.006, 0.006, 0.008, 0, 0.026, -0.248, 10);
  bore.castShadow = false;

  // Cylinder — animated as the "magazine" so reloads swing it out.
  const magazine = new THREE.Group();
  magazine.position.set(0, 0.014, -0.028);
  root.add(magazine);
  const cyl = cylinderPart(magazine, m.gunMetal, 0.026, 0.026, 0.072, 0, 0, 0, 20);
  cyl.castShadow = true;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const chamber = cylinderPart(
      magazine,
      m.rubber,
      0.0055,
      0.0055,
      0.076,
      Math.cos(a) * 0.016,
      Math.sin(a) * 0.016,
      0,
      8,
    );
    chamber.castShadow = false;
    // Flute between chambers.
    const flute = cylinderPart(
      magazine,
      m.gunPolymer,
      0.004,
      0.004,
      0.05,
      Math.cos(a + 0.52) * 0.025,
      Math.sin(a + 0.52) * 0.025,
      0,
      6,
    );
    flute.castShadow = false;
  }
  cylinderPart(magazine, m.gunMetal, 0.006, 0.006, 0.09, 0, 0, 0, 10);

  // Hammer and trigger.
  const hammer = boxPart(root, m.gunMetal, 0.008, 0.03, 0.014, 0, 0.045, 0.038, 0.002);
  hammer.rotation.x = 0.35;
  boxPart(root, m.gunMetal, 0.02, 0.006, 0.05, 0, -0.024, 0.0, 0.002);
  boxPart(root, m.gunMetal, 0.02, 0.024, 0.006, 0, -0.014, 0.024, 0.002);
  const trigger = boxPart(root, m.gunMetal, 0.007, 0.02, 0.005, 0, -0.017, 0.006, 0.002);
  trigger.rotation.x = -0.25;

  // Chequered wooden grips.
  const grip = new THREE.Group();
  grip.position.set(0, -0.058, 0.052);
  grip.rotation.x = -0.36;
  root.add(grip);
  boxPart(grip, m.gunAccent, 0.03, 0.1, 0.046, 0, 0, 0, 0.01);
  for (let i = 0; i < 7; i++) {
    boxPart(grip, m.wood, 0.0315, 0.004, 0.047, 0, 0.036 - i * 0.012, 0, 0.001);
  }

  // Sights.
  boxPart(root, m.gunMetal, 0.004, 0.011, 0.005, 0, 0.052, -0.242, 0.001);
  const rearGroup = new THREE.Group();
  root.add(rearGroup);
  boxPart(rearGroup, m.gunMetal, 0.018, 0.011, 0.008, 0, 0.052, 0.008, 0.001);
  boxPart(rearGroup, m.gunPolymer, 0.005, 0.012, 0.009, 0, 0.053, 0.008, 0.001);
  addTritium(root, 0, 0.056, -0.242, 0xffcc44);
  const sight = anchor(root, 'sight', 0, 0.0585, 0.008);

  const muzzle = anchor(root, 'muzzle', 0, 0.026, -0.252);
  const ejectPort = anchor(root, 'ejectPort', 0.03, 0.014, -0.028);
  const gripAnchor = anchor(root, 'gripAnchor', 0, -0.07, 0.062);
  const foreAnchor = anchor(root, 'foreAnchor', -0.03, -0.07, 0.05);

  return {
    root,
    muzzle,
    sight,
    ejectPort,
    magazine,
    slide: null,
    charging: null,
    scopeLens: null,
    gripAnchor,
    foreAnchor,
    length: 0.32,
  };
}

function buildDmr(): WeaponModel {
  const m = createWorldMaterials();
  const root = new THREE.Group();
  root.name = 'weapon-dmr';

  // Receiver set — longer and squarer than the carbine.
  boxPart(root, m.gunMetal, 0.048, 0.062, 0.27, 0, 0.03, -0.02, 0.005);
  boxPart(root, m.gunPolymer, 0.045, 0.052, 0.19, 0, -0.014, 0.02, 0.005);
  addRail(root, m.gunMetal, 0.5, 0, 0.068, -0.13, 0.026);

  // Free-float tube with cooling slots.
  cylinderPart(root, m.gunPolymer, 0.03, 0.03, 0.36, 0, 0.032, -0.33, 14);
  for (let i = 0; i < 8; i++) {
    boxPart(root, m.rubber, 0.064, 0.01, 0.026, 0, 0.032, -0.47 + i * 0.042, 0.002);
  }
  for (let i = 0; i < 8; i++) {
    boxPart(root, m.rubber, 0.01, 0.064, 0.026, 0, 0.032, -0.47 + i * 0.042, 0.002);
  }

  // Heavy barrel and muzzle brake.
  cylinderPart(root, m.gunMetal, 0.013, 0.014, 0.24, 0, 0.032, -0.62, 14);
  cylinderPart(root, m.gunMetal, 0.017, 0.016, 0.07, 0, 0.032, -0.77, 14);
  for (let i = 0; i < 3; i++) {
    boxPart(root, m.gunPolymer, 0.038, 0.007, 0.009, 0, 0.032, -0.755 - i * 0.018, 0.001);
  }
  const bore = cylinderPart(root, m.rubber, 0.0068, 0.0068, 0.01, 0, 0.032, -0.803, 10);
  bore.castShadow = false;

  // Gas block.
  boxPart(root, m.gunMetal, 0.026, 0.03, 0.036, 0, 0.04, -0.52, 0.003);

  const charging = new THREE.Group();
  root.add(charging);
  boxPart(charging, m.gunMetal, 0.055, 0.013, 0.032, 0, 0.058, 0.114, 0.003);
  boxPart(charging, m.gunMetal, 0.018, 0.013, 0.055, -0.032, 0.058, 0.104, 0.003);

  const grip = new THREE.Group();
  grip.position.set(0, -0.062, 0.06);
  grip.rotation.x = -0.3;
  root.add(grip);
  boxPart(grip, m.gunPolymer, 0.034, 0.105, 0.048, 0, 0, 0, 0.008);

  // 20-round magazine.
  const magazine = new THREE.Group();
  magazine.position.set(0, -0.04, -0.02);
  root.add(magazine);
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    boxPart(magazine, m.gunMetal, 0.028, 0.032, 0.042, 0, -i * 0.03, t * t * 0.022, 0.003);
  }
  boxPart(magazine, m.gunPolymer, 0.032, 0.009, 0.048, 0, -0.145, 0.024, 0.002);

  boxPart(root, m.gunPolymer, 0.028, 0.006, 0.062, 0, -0.04, 0.014, 0.002);
  boxPart(root, m.gunMetal, 0.008, 0.022, 0.005, 0, -0.028, 0.004, 0.002);
  addSelector(root, m.gunMetal, -0.026, -0.004, 0.052);

  // Precision stock with an adjustable cheek riser and monopod.
  boxPart(root, m.gunPolymer, 0.03, 0.03, 0.13, 0, 0.02, 0.17, 0.005);
  boxPart(root, m.gunPolymer, 0.05, 0.085, 0.16, 0, 0.012, 0.28, 0.008);
  boxPart(root, m.gunPolymer, 0.042, 0.03, 0.14, 0, 0.062, 0.28, 0.006);
  for (const x of [-0.022, 0.022]) {
    boxPart(root, m.gunMetal, 0.006, 0.05, 0.006, x, 0.04, 0.245, 0.002);
  }
  boxPart(root, m.rubber, 0.052, 0.09, 0.018, 0, 0.008, 0.368, 0.005);
  boxPart(root, m.gunPolymer, 0.028, 0.055, 0.03, 0, -0.03, 0.33, 0.005);
  addSlingLoop(root, m.gunMetal, -0.026, 0.0, 0.2);
  addSlingLoop(root, m.gunMetal, -0.03, 0.02, -0.46);

  // 4x optic on tall rings.
  const scope = new THREE.Group();
  scope.position.set(0, 0.108, -0.06);
  root.add(scope);
  cylinderPart(scope, m.gunPolymer, 0.017, 0.017, 0.2, 0, 0, -0.01, 16);
  cylinderPart(scope, m.gunPolymer, 0.024, 0.021, 0.06, 0, 0, -0.135, 16);
  cylinderPart(scope, m.gunPolymer, 0.021, 0.019, 0.05, 0, 0, 0.1, 16);
  cylinderPart(scope, m.gunMetal, 0.01, 0.01, 0.018, 0, 0.023, -0.01, 12);
  const windage = cylinderPart(scope, m.gunMetal, 0.01, 0.01, 0.018, 0.023, 0, -0.01, 12);
  windage.rotation.set(0, 0, Math.PI / 2);
  boxPart(scope, m.gunMetal, 0.028, 0.05, 0.018, 0, -0.026, -0.06, 0.004);
  boxPart(scope, m.gunMetal, 0.028, 0.05, 0.018, 0, -0.026, 0.05, 0.004);

  const scopeLens = new THREE.Mesh(
    new THREE.CircleGeometry(0.018, 20),
    new THREE.MeshStandardMaterial({
      color: 0x10202c,
      roughness: 0.05,
      metalness: 0.4,
      emissive: 0x0c1a26,
      emissiveIntensity: 0.6,
    }),
  );
  scopeLens.position.set(0, 0, 0.126);
  scopeLens.rotation.y = Math.PI;
  scope.add(scopeLens);
  const objective = new THREE.Mesh(
    new THREE.CircleGeometry(0.021, 20),
    new THREE.MeshStandardMaterial({ color: 0x1a3a52, roughness: 0.05, metalness: 0.6 }),
  );
  objective.position.set(0, 0, -0.166);
  scope.add(objective);

  const sight = anchor(root, 'sight', 0, 0.108, -0.06);
  const muzzle = anchor(root, 'muzzle', 0, 0.032, -0.812);
  const ejectPort = anchor(root, 'ejectPort', 0.03, 0.042, 0.03);
  const gripAnchor = anchor(root, 'gripAnchor', 0, -0.088, 0.086);
  const foreAnchor = anchor(root, 'foreAnchor', 0, -0.008, -0.36);

  return {
    root,
    muzzle,
    sight,
    ejectPort,
    magazine,
    slide: null,
    charging,
    scopeLens,
    gripAnchor,
    foreAnchor,
    length: 1.05,
  };
}

function buildLmg(): WeaponModel {
  const m = createWorldMaterials();
  const root = new THREE.Group();
  root.name = 'weapon-lmg';

  // Big square receiver with a hinged feed tray cover.
  boxPart(root, m.gunMetal, 0.062, 0.085, 0.3, 0, 0.04, -0.02, 0.006);
  boxPart(root, m.gunMetal, 0.066, 0.014, 0.26, 0, 0.088, -0.03, 0.003);
  addRail(root, m.gunMetal, 0.2, 0, 0.1, -0.06, 0.026);

  // Belt box hanging under the receiver.
  const magazine = new THREE.Group();
  magazine.position.set(0, -0.05, 0.0);
  root.add(magazine);
  boxPart(magazine, m.paintedGreen, 0.075, 0.1, 0.15, 0, -0.03, 0, 0.008);
  boxPart(magazine, m.gunMetal, 0.08, 0.012, 0.155, 0, 0.024, 0, 0.003);
  boxPart(magazine, m.gunMetal, 0.03, 0.02, 0.01, 0, -0.086, 0, 0.003);
  // Exposed belt of rounds feeding up into the receiver.
  for (let i = 0; i < 5; i++) {
    const link = boxPart(magazine, m.gunAccent, 0.03, 0.009, 0.012, 0.006, 0.03 + i * 0.011, -0.02 + i * 0.004, 0.002);
    link.rotation.z = 0.15;
  }

  // Heavy barrel with a carry handle and flash hider.
  cylinderPart(root, m.gunMetal, 0.014, 0.017, 0.42, 0, 0.03, -0.36, 14);
  for (let i = 0; i < 10; i++) {
    boxPart(root, m.gunPolymer, 0.036, 0.007, 0.012, 0, 0.03, -0.24 - i * 0.032, 0.001);
  }
  cylinderPart(root, m.gunMetal, 0.02, 0.017, 0.075, 0, 0.03, -0.6, 12);
  for (let i = 0; i < 4; i++) {
    boxPart(root, m.gunPolymer, 0.044, 0.008, 0.009, 0, 0.03, -0.58 - i * 0.017, 0.001);
  }
  const bore = cylinderPart(root, m.rubber, 0.0075, 0.0075, 0.01, 0, 0.03, -0.638, 10);
  bore.castShadow = false;

  const handle = new THREE.Group();
  handle.position.set(0.026, 0.07, -0.26);
  root.add(handle);
  boxPart(handle, m.gunPolymer, 0.016, 0.016, 0.13, 0, 0.03, 0, 0.004);
  boxPart(handle, m.gunMetal, 0.014, 0.05, 0.016, 0, 0.005, -0.055, 0.003);
  boxPart(handle, m.gunMetal, 0.014, 0.05, 0.016, 0, 0.005, 0.055, 0.003);

  // Gas tube.
  cylinderPart(root, m.gunMetal, 0.008, 0.008, 0.3, 0, -0.004, -0.32, 8);

  const charging = new THREE.Group();
  root.add(charging);
  boxPart(charging, m.gunMetal, 0.02, 0.018, 0.06, 0.04, 0.03, 0.02, 0.004);

  const grip = new THREE.Group();
  grip.position.set(0, -0.05, 0.09);
  grip.rotation.x = -0.3;
  root.add(grip);
  boxPart(grip, m.gunPolymer, 0.036, 0.11, 0.05, 0, 0, 0, 0.008);

  boxPart(root, m.gunPolymer, 0.03, 0.007, 0.07, 0, -0.026, 0.05, 0.002);
  boxPart(root, m.gunMetal, 0.009, 0.024, 0.006, 0, -0.012, 0.038, 0.002);

  // Skeleton buttstock.
  boxPart(root, m.gunPolymer, 0.05, 0.075, 0.19, 0, 0.03, 0.22, 0.008);
  boxPart(root, m.gunPolymer, 0.052, 0.02, 0.1, 0, 0.075, 0.24, 0.005);
  boxPart(root, m.rubber, 0.055, 0.1, 0.02, 0, 0.02, 0.32, 0.005);
  addSlingLoop(root, m.gunMetal, -0.032, 0.03, 0.16);
  addSlingLoop(root, m.gunMetal, -0.034, 0.02, -0.34);

  // Deployed bipod under the barrel.
  const bipod = new THREE.Group();
  bipod.position.set(0, 0.012, -0.44);
  root.add(bipod);
  for (const side of [-1, 1]) {
    const leg = boxPart(bipod, m.gunMetal, 0.01, 0.16, 0.01, side * 0.03, -0.08, 0.02, 0.002);
    leg.rotation.z = side * 0.32;
    leg.rotation.x = 0.18;
    const foot = boxPart(bipod, m.rubber, 0.02, 0.012, 0.05, side * 0.06, -0.155, 0.05, 0.003);
    foot.rotation.x = 0.18;
  }

  const sight = addIronSights(root, m.gunMetal, 0.128, -0.28, 0.05, 0.014);
  const muzzle = anchor(root, 'muzzle', 0, 0.03, -0.648);
  const ejectPort = anchor(root, 'ejectPort', 0.036, 0.03, -0.02);
  const gripAnchor = anchor(root, 'gripAnchor', 0, -0.076, 0.116);
  const foreAnchor = anchor(root, 'foreAnchor', 0.026, 0.03, -0.26);

  return {
    root,
    muzzle,
    sight,
    ejectPort,
    magazine,
    slide: null,
    charging,
    scopeLens: null,
    gripAnchor,
    foreAnchor,
    length: 0.99,
  };
}

function buildAutoShotgun(): WeaponModel {
  const m = createWorldMaterials();
  const root = new THREE.Group();
  root.name = 'weapon-auto-shotgun';

  // Boxy receiver.
  boxPart(root, m.gunPolymer, 0.058, 0.085, 0.3, 0, 0.02, -0.02, 0.008);
  boxPart(root, m.gunMetal, 0.05, 0.016, 0.26, 0, 0.066, -0.03, 0.003);
  addRail(root, m.gunMetal, 0.28, 0, 0.08, -0.05, 0.026);

  // Barrel inside a vented shroud.
  cylinderPart(root, m.gunMetal, 0.017, 0.017, 0.34, 0, 0.026, -0.34, 14);
  cylinderPart(root, m.gunPolymer, 0.026, 0.026, 0.3, 0, 0.026, -0.32, 12);
  for (let i = 0; i < 7; i++) {
    boxPart(root, m.rubber, 0.056, 0.012, 0.022, 0, 0.026, -0.44 + i * 0.042, 0.002);
  }
  const bore = cylinderPart(root, m.rubber, 0.012, 0.012, 0.012, 0, 0.026, -0.508, 12);
  bore.castShadow = false;

  // Drum magazine.
  const magazine = new THREE.Group();
  magazine.position.set(0, -0.062, -0.01);
  root.add(magazine);
  const drum = cylinderPart(magazine, m.gunPolymer, 0.075, 0.075, 0.05, 0, -0.05, 0, 22);
  drum.rotation.x = 0;
  cylinderPart(magazine, m.gunMetal, 0.03, 0.03, 0.056, 0, -0.05, 0, 14).rotation.x = 0;
  boxPart(magazine, m.gunPolymer, 0.04, 0.06, 0.045, 0, 0.0, 0, 0.004);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const shell = cylinderPart(
      magazine,
      m.gunAccent,
      0.009,
      0.009,
      0.052,
      Math.cos(a) * 0.052,
      -0.05 + Math.sin(a) * 0.052,
      0,
      8,
    );
    shell.castShadow = false;
  }

  const charging = new THREE.Group();
  root.add(charging);
  boxPart(charging, m.gunMetal, 0.018, 0.016, 0.05, -0.036, 0.04, 0.02, 0.004);

  const grip = new THREE.Group();
  grip.position.set(0, -0.055, 0.09);
  grip.rotation.x = -0.32;
  root.add(grip);
  boxPart(grip, m.gunPolymer, 0.036, 0.105, 0.05, 0, 0, 0, 0.008);

  boxPart(root, m.gunPolymer, 0.03, 0.007, 0.068, 0, -0.03, 0.05, 0.002);
  boxPart(root, m.gunMetal, 0.009, 0.024, 0.006, 0, -0.016, 0.038, 0.002);
  addSelector(root, m.gunMetal, -0.031, 0.0, 0.07);

  // Vertical fore-grip on the shroud.
  const foreGrip = new THREE.Group();
  foreGrip.position.set(0, -0.006, -0.29);
  foreGrip.rotation.x = 0.1;
  root.add(foreGrip);
  boxPart(foreGrip, m.gunPolymer, 0.032, 0.085, 0.034, 0, -0.05, 0, 0.007);

  // Fixed stock.
  boxPart(root, m.gunPolymer, 0.05, 0.08, 0.2, 0, 0.014, 0.22, 0.008);
  boxPart(root, m.rubber, 0.052, 0.095, 0.02, 0, 0.008, 0.325, 0.005);
  addSlingLoop(root, m.gunMetal, -0.03, 0.02, 0.19);

  const sight = addIronSights(root, m.gunMetal, 0.098, -0.2, 0.06, 0.013);
  const muzzle = anchor(root, 'muzzle', 0, 0.026, -0.518);
  const ejectPort = anchor(root, 'ejectPort', 0.032, 0.03, -0.01);
  const gripAnchor = anchor(root, 'gripAnchor', 0, -0.082, 0.116);
  const foreAnchor = anchor(root, 'foreAnchor', 0, -0.085, -0.292);

  return {
    root,
    muzzle,
    sight,
    ejectPort,
    magazine,
    slide: null,
    charging,
    scopeLens: null,
    gripAnchor,
    foreAnchor,
    length: 0.86,
  };
}

const BUILDERS: Record<WeaponId, () => WeaponModel> = {
  pistol: buildPistol,
  machinePistol: buildMachinePistol,
  revolver: buildRevolver,
  smg: buildSmg,
  rifle: buildRifle,
  dmr: buildDmr,
  sniper: buildSniper,
  lmg: buildLmg,
  shotgun: buildShotgun,
  autoShotgun: buildAutoShotgun,
};

export function buildWeaponModel(id: WeaponId): WeaponModel {
  return BUILDERS[id]();
}

// -------------------------------------------------------------- spent brass

let shellGeometryCache: THREE.BufferGeometry | null = null;

export function getShellGeometry(): THREE.BufferGeometry {
  if (!shellGeometryCache) {
    shellGeometryCache = new THREE.CylinderGeometry(0.0045, 0.005, 0.019, 8, 1);
    shellGeometryCache.rotateZ(Math.PI / 2);
  }
  return shellGeometryCache;
}

let shellMaterialCache: THREE.MeshStandardMaterial | null = null;

export function getShellMaterial(): THREE.MeshStandardMaterial {
  if (!shellMaterialCache) {
    shellMaterialCache = new THREE.MeshStandardMaterial({
      color: 0xc9a227,
      metalness: 1,
      roughness: 0.3,
    });
  }
  return shellMaterialCache;
}
