import * as THREE from 'three';
import {
  bothSides,
  loft,
  mesh,
  tube,
  type MechLeg,
  type VehicleBuildResult,
} from './ModelKit';
import { createCanvasTexture } from './Materials';

/**
 * A Terran heavy assault mech in the mould of StarCraft II's Thor.
 *
 * Built to the same rules as the other vehicles — primitives only, origin on
 * the ground, nose pointing +Z — but it walks instead of rolling, so almost
 * nothing of it is static. The hierarchy is what makes it animate:
 *
 *   root ─ hips ─ legs[2] ─ hip pivot ─ knee pivot ─ ankle pivot ─ foot
 *        └ torso (twists about Y)
 *              └ arms (elevate about X) ─ twin cannon assemblies
 *
 * The chassis heading is the root's yaw; the torso twists on top of it so the
 * guns can lead the walk, exactly like a MechWarrior torso. Each ankle
 * counter-rotates its parents so the foot stays flat through the whole stride.
 *
 * Proportions follow the silhouette that makes the design readable: a small
 * head sunk between enormous pauldrons, a deep slab-sided chest, stubby arms
 * carrying cannons longer than the torso, and wide splayed three-toed feet.
 */

/** Ground to hip pivot. Everything else is measured from this. */
const HIP_Y = 4.15;
const THIGH = 1.8;
const SHIN = 1.95;
const FOOT_THICK = 0.4;
const LEG_X = 1.45;

export const THOR_HEIGHT = 8.7;

// ---------------------------------------------------------------- materials

export interface ThorMaterials {
  armour: THREE.MeshStandardMaterial;
  armourDark: THREE.MeshStandardMaterial;
  frame: THREE.MeshStandardMaterial;
  piston: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  hazard: THREE.MeshStandardMaterial;
  visor: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  vent: THREE.MeshStandardMaterial;
  insignia: THREE.MeshStandardMaterial;
}

let cached: ThorMaterials | null = null;

/** Diagonal yellow/black caution stripes, as worn on every Terran pauldron. */
function hazardTexture(): THREE.Texture {
  return createCanvasTexture(
    256,
    (ctx, size) => {
      ctx.fillStyle = '#d8a413';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#1c1c1e';
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(Math.PI / 4);
      for (let i = -size; i < size; i += size / 4) {
        ctx.fillRect(i, -size, size / 8, size * 2);
      }
      ctx.restore();
      // Scuff the stripes so a large flat plate does not read as a decal.
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#2a2c30';
      for (let i = 0; i < 40; i++) {
        ctx.fillRect(Math.random() * size, Math.random() * size, Math.random() * 26, Math.random() * 5);
      }
    },
    { repeat: 1 },
  );
}

/** Weathered steel plate: base tint, panel seams, rivets and streaking. */
function plateTexture(base: string, seam: string): THREE.Texture {
  return createCanvasTexture(
    256,
    (ctx, size) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = seam;
      ctx.lineWidth = 2;
      for (const t of [0.25, 0.5, 0.75]) {
        ctx.beginPath();
        ctx.moveTo(0, t * size);
        ctx.lineTo(size, t * size);
        ctx.moveTo(t * size, 0);
        ctx.lineTo(t * size, size);
        ctx.stroke();
      }
      ctx.fillStyle = seam;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          ctx.beginPath();
          ctx.arc((x + 0.12) * (size / 4), (y + 0.12) * (size / 4), 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = '#0d0f12';
      for (let i = 0; i < 60; i++) {
        const x = Math.random() * size;
        ctx.fillRect(x, Math.random() * size, 1 + Math.random() * 2, 10 + Math.random() * 60);
      }
    },
    { repeat: 2 },
  );
}

/** The Terran skull-and-wings roundel, stencilled on the chest. */
function insigniaTexture(): THREE.Texture {
  return createCanvasTexture(256, (ctx, size) => {
    ctx.fillStyle = '#3d4550';
    ctx.fillRect(0, 0, size, size);
    const c = size / 2;
    ctx.fillStyle = '#c9ccd2';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(c, c - size * 0.02);
      ctx.lineTo(c + s * size * 0.42, c - size * 0.2);
      ctx.lineTo(c + s * size * 0.4, c - size * 0.05);
      ctx.lineTo(c + s * size * 0.16, c + size * 0.06);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath();
    ctx.ellipse(c, c + size * 0.04, size * 0.15, size * 0.17, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3d4550';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(c + s * size * 0.06, c, size * 0.045, size * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillRect(c - size * 0.05, c + size * 0.12, size * 0.1, size * 0.08);
  });
}

export function createThorMaterials(): ThorMaterials {
  if (cached) return cached;
  cached = {
    armour: new THREE.MeshStandardMaterial({
      map: plateTexture('#7d878f', '#4c545c'),
      roughness: 0.52,
      metalness: 0.85,
    }),
    armourDark: new THREE.MeshStandardMaterial({
      map: plateTexture('#4a525b', '#2b3138'),
      roughness: 0.58,
      metalness: 0.82,
    }),
    frame: new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.62, metalness: 0.9 }),
    piston: new THREE.MeshStandardMaterial({ color: 0xc7ccd4, roughness: 0.18, metalness: 1.0 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xc08a1c, roughness: 0.5, metalness: 0.6 }),
    hazard: new THREE.MeshStandardMaterial({ map: hazardTexture(), roughness: 0.6, metalness: 0.5 }),
    visor: new THREE.MeshStandardMaterial({
      color: 0x06202a,
      emissive: 0x35d6ff,
      emissiveIntensity: 2.4,
      roughness: 0.15,
      metalness: 0.4,
    }),
    glow: new THREE.MeshStandardMaterial({
      color: 0x2a0f02,
      emissive: 0xff6a18,
      emissiveIntensity: 2.6,
      roughness: 0.5,
    }),
    vent: new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.85, metalness: 0.5 }),
    insignia: new THREE.MeshStandardMaterial({ map: insigniaTexture(), roughness: 0.7, metalness: 0.4 }),
  };
  return cached;
}

// -------------------------------------------------------------------- parts

/** Bolt heads around the rim of a plate — the cheapest way to read as armour. */
function rivets(
  parent: THREE.Object3D,
  material: THREE.Material,
  width: number,
  height: number,
  z: number,
  count = 4,
  radius = 0.055,
): void {
  const geo = new THREE.CylinderGeometry(radius, radius, 0.05, 8);
  geo.rotateX(Math.PI / 2);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const x = -width / 2 + t * width;
    mesh(parent, geo, material, [x, height / 2, z]);
    mesh(parent, geo, material, [x, -height / 2, z]);
  }
}

/** A hydraulic ram: polished rod inside a dark cylinder. */
function piston(
  parent: THREE.Object3D,
  m: ThorMaterials,
  from: [number, number, number],
  length: number,
  radius: number,
  rotation: [number, number, number],
): void {
  mesh(parent, new THREE.CylinderGeometry(radius, radius, length * 0.55, 10), m.frame, from, rotation);
  mesh(
    parent,
    new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, length, 10),
    m.piston,
    from,
    rotation,
  );
}

/**
 * One leg, built downward from its hip pivot.
 *
 * Each joint gets its own group so the walk cycle only ever writes three
 * angles per leg; the ankle then subtracts the other two so the foot stays
 * level however the leg is folded.
 */
function buildLeg(m: ThorMaterials, side: 1 | -1): MechLeg {
  const hip = new THREE.Group();
  hip.position.set(side * LEG_X, HIP_Y, 0);

  // --- hip actuator housing ------------------------------------------------
  mesh(hip, new THREE.SphereGeometry(0.62, 14, 10), m.frame);
  mesh(hip, new THREE.BoxGeometry(0.9, 0.7, 1.0), m.armourDark, [side * 0.28, 0.1, 0]);
  mesh(hip, new THREE.CylinderGeometry(0.34, 0.34, 1.15, 12), m.piston, [0, 0, 0], [0, 0, Math.PI / 2]);

  // --- thigh ---------------------------------------------------------------
  const thighTop = -0.35;
  mesh(
    hip,
    loft([
      { z: -0.62, halfWidth: 0.52, bottom: -THIGH, top: thighTop },
      { z: -0.2, halfWidth: 0.62, bottom: -THIGH - 0.05, top: thighTop + 0.12 },
      { z: 0.42, halfWidth: 0.58, bottom: -THIGH, top: thighTop + 0.06 },
      { z: 0.66, halfWidth: 0.4, bottom: -THIGH + 0.12, top: thighTop - 0.1 },
    ]),
    m.armour,
  );
  const outer = mesh(hip, new THREE.BoxGeometry(0.16, 1.5, 1.2), m.armourDark, [side * 0.62, -0.95, -0.02]);
  outer.rotation.z = side * 0.04;
  mesh(hip, new THREE.BoxGeometry(0.06, 0.4, 1.05), m.hazard, [side * 0.71, -0.55, -0.02]);
  rivets(hip, m.frame, 0.9, 1.3, 0.7, 4);
  // Rear hydraulics driving the knee.
  piston(hip, m, [side * 0.18, -0.95, -0.72], 1.6, 0.13, [0.12, 0, 0]);
  piston(hip, m, [-side * 0.18, -0.95, -0.72], 1.6, 0.13, [0.12, 0, 0]);

  // --- knee ----------------------------------------------------------------
  const knee = new THREE.Group();
  knee.position.set(0, -THIGH, 0);
  hip.add(knee);
  mesh(knee, new THREE.CylinderGeometry(0.5, 0.5, 1.0, 14), m.frame, [0, 0, 0], [0, 0, Math.PI / 2]);
  // The knee cap is the mech's most exposed plate — armoured and striped.
  const cap = mesh(knee, new THREE.BoxGeometry(1.0, 0.9, 0.5), m.armour, [0, -0.05, 0.5]);
  cap.rotation.x = -0.12;
  mesh(knee, new THREE.BoxGeometry(0.86, 0.22, 0.12), m.hazard, [0, 0.28, 0.74]);
  mesh(knee, new THREE.CylinderGeometry(0.16, 0.16, 1.06, 10), m.piston, [0, 0, 0], [0, 0, Math.PI / 2]);

  // --- shin ----------------------------------------------------------------
  mesh(
    knee,
    loft([
      { z: -0.6, halfWidth: 0.5, bottom: -SHIN, top: -0.2 },
      { z: -0.1, halfWidth: 0.64, bottom: -SHIN - 0.02, top: -0.05 },
      { z: 0.55, halfWidth: 0.6, bottom: -SHIN, top: -0.15 },
      { z: 0.8, halfWidth: 0.4, bottom: -SHIN + 0.15, top: -0.4 },
    ]),
    m.armour,
  );
  bothSides((s) => {
    mesh(knee, new THREE.BoxGeometry(0.12, 1.1, 0.8), m.armourDark, [s * 0.56, -0.95, 0.0]);
  });
  piston(knee, m, [0, -1.0, -0.62], 1.7, 0.15, [-0.06, 0, 0]);
  mesh(
    knee,
    tube(
      [
        [0.3, -0.2, -0.6],
        [0.34, -0.9, -0.68],
        [0.3, -1.7, -0.5],
      ],
      0.06,
    ),
    m.frame,
  );
  mesh(knee, new THREE.BoxGeometry(0.5, 0.3, 0.16), m.vent, [0, -1.5, 0.58]);

  // --- ankle and foot ------------------------------------------------------
  const ankle = new THREE.Group();
  ankle.position.set(0, -SHIN, 0);
  knee.add(ankle);
  mesh(ankle, new THREE.CylinderGeometry(0.34, 0.34, 0.8, 12), m.frame, [0, 0, 0], [0, 0, Math.PI / 2]);

  const footY = -FOOT_THICK / 2;
  // Sole: a broad splayed pad, deeper at the heel than under the toes. The
  // feet are deliberately oversized — a top-heavy mech reads as unstable on
  // anything smaller, and the real thing plants like a crane outrigger.
  mesh(
    ankle,
    loft([
      { z: -1.15, halfWidth: 0.78, bottom: -FOOT_THICK, top: 0.16 },
      { z: -0.55, halfWidth: 1.02, bottom: -FOOT_THICK, top: 0.26 },
      { z: 0.4, halfWidth: 1.1, bottom: -FOOT_THICK, top: 0.22 },
      { z: 0.85, halfWidth: 0.95, bottom: -FOOT_THICK, top: 0.08 },
    ]),
    m.armourDark,
    [0, footY + FOOT_THICK / 2, 0],
  );
  // Three splayed toes with claws.
  for (const [tx, ta] of [
    [-0.62, -0.3],
    [0, 0],
    [0.62, 0.3],
  ] as [number, number][]) {
    const toe = mesh(
      ankle,
      new THREE.BoxGeometry(0.54, FOOT_THICK * 0.9, 1.15),
      m.armourDark,
      [tx, footY, 1.25],
    );
    toe.rotation.y = ta;
    const claw = mesh(ankle, new THREE.BoxGeometry(0.38, 0.18, 0.42), m.frame, [tx * 1.3, footY - 0.04, 1.82]);
    claw.rotation.y = ta;
  }
  mesh(ankle, new THREE.BoxGeometry(1.0, 0.4, 0.6), m.frame, [0, footY, -1.25]);
  for (let i = 0; i < 5; i++) {
    mesh(ankle, new THREE.BoxGeometry(1.9, 0.09, 0.12), m.frame, [0, footY - FOOT_THICK / 2, -0.9 + i * 0.5]);
  }
  // Ankle armour skirt, hiding the joint from the front.
  mesh(ankle, new THREE.BoxGeometry(0.9, 0.5, 0.3), m.armour, [0, 0.15, 0.6]);
  mesh(ankle, new THREE.BoxGeometry(0.3, 0.24, 0.6), m.hazard, [0, 0.3, -0.5]);

  return { hip, knee, ankle, phase: side > 0 ? 0 : 0.5 };
}

/** One arm cannon: recoil housing, twin barrels, muzzle brakes, ammo feed. */
function buildArmCannon(parent: THREE.Object3D, m: ThorMaterials, side: 1 | -1): THREE.Object3D {
  const arm = new THREE.Group();
  arm.position.set(side * 2.45, -0.15, 0);
  parent.add(arm);

  mesh(arm, new THREE.SphereGeometry(0.62, 14, 10), m.frame);
  mesh(arm, new THREE.BoxGeometry(0.9, 0.9, 1.1), m.armour, [side * 0.2, -0.05, 0.1]);
  piston(arm, m, [side * 0.1, -0.5, -0.5], 0.9, 0.11, [0.4, 0, 0]);

  // Receiver: the deep box the barrels run out of.
  mesh(arm, new THREE.BoxGeometry(1.25, 1.15, 2.3), m.armour, [side * 0.34, -0.1, 1.15]);
  mesh(arm, new THREE.BoxGeometry(1.32, 0.28, 1.5), m.hazard, [side * 0.34, 0.42, 0.9]);
  rivets(arm, m.frame, 1.0, 1.0, 2.3, 3);
  for (const dx of [-0.34, 0.34]) {
    mesh(
      arm,
      new THREE.CylinderGeometry(0.09, 0.09, 1.9, 8),
      m.piston,
      [side * 0.34 + dx, 0.42, 1.5],
      [Math.PI / 2, 0, 0],
    );
  }
  // Ammunition feed running in from the torso.
  mesh(
    arm,
    tube(
      [
        [side * 0.9, 0.1, -0.4],
        [side * 0.62, -0.28, 0.3],
        [side * 0.4, -0.42, 0.9],
      ],
      0.16,
    ),
    m.frame,
  );
  mesh(arm, new THREE.BoxGeometry(0.7, 0.5, 0.8), m.armourDark, [side * 0.34, -0.62, 0.7]);

  const muzzles: THREE.Object3D[] = [];
  for (const dx of [-0.3, 0.3]) {
    const x = side * 0.34 + dx;
    mesh(arm, new THREE.CylinderGeometry(0.2, 0.22, 2.6, 14), m.frame, [x, -0.1, 3.4], [Math.PI / 2, 0, 0]);
    mesh(arm, new THREE.CylinderGeometry(0.26, 0.26, 1.3, 14), m.armourDark, [x, -0.1, 2.9], [Math.PI / 2, 0, 0]);
    for (let i = 0; i < 5; i++) {
      mesh(arm, new THREE.BoxGeometry(0.06, 0.44, 0.12), m.vent, [x, -0.1, 2.45 + i * 0.22]);
    }
    // Muzzle brake: a fat collar with side ports.
    mesh(arm, new THREE.CylinderGeometry(0.3, 0.3, 0.55, 14), m.frame, [x, -0.1, 4.85], [Math.PI / 2, 0, 0]);
    for (const px of [-1, 1]) {
      mesh(arm, new THREE.BoxGeometry(0.14, 0.2, 0.34), m.vent, [x + px * 0.26, -0.1, 4.85]);
    }
    mesh(arm, new THREE.CylinderGeometry(0.17, 0.17, 0.08, 14), m.vent, [x, -0.1, 5.14], [Math.PI / 2, 0, 0]);

    const muzzle = new THREE.Object3D();
    muzzle.position.set(x, -0.1, 5.2);
    arm.add(muzzle);
    muzzles.push(muzzle);
  }
  arm.userData.muzzles = muzzles;
  return arm;
}

// -------------------------------------------------------------------- build

export function buildThor(): VehicleBuildResult {
  const m = createThorMaterials();
  const root = new THREE.Group();
  root.name = 'thor';

  // The chassis: pelvis and legs, which follow the walking direction.
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);

  const legs = [buildLeg(m, 1), buildLeg(m, -1)];
  for (const leg of legs) root.add(leg.hip);

  // --- pelvis --------------------------------------------------------------
  mesh(body, new THREE.BoxGeometry(2.6, 1.3, 1.9), m.armourDark, [0, HIP_Y + 0.25, -0.1]);
  mesh(body, new THREE.BoxGeometry(2.9, 0.4, 2.1), m.frame, [0, HIP_Y + 0.95, -0.1]);
  bothSides((s) => {
    const skirt = mesh(body, new THREE.BoxGeometry(0.9, 1.5, 1.3), m.armour, [s * 1.5, HIP_Y - 0.15, 0.15]);
    skirt.rotation.z = s * 0.14;
    mesh(body, new THREE.BoxGeometry(0.7, 0.3, 1.1), m.hazard, [s * 1.62, HIP_Y - 0.75, 0.15]);
  });
  mesh(body, new THREE.BoxGeometry(1.8, 1.1, 0.5), m.armour, [0, HIP_Y - 0.1, 0.95]);
  mesh(body, new THREE.BoxGeometry(1.4, 0.5, 0.14), m.hazard, [0, HIP_Y - 0.5, 1.22]);

  // --- torso ---------------------------------------------------------------
  const torso = new THREE.Group();
  torso.name = 'torso';
  torso.position.set(0, HIP_Y + 1.05, 0);
  root.add(torso);

  // Deep, slab-sided chest that tapers back toward the engine deck.
  mesh(
    torso,
    loft([
      { z: -1.5, halfWidth: 1.5, bottom: -0.25, top: 1.55 },
      { z: -0.9, halfWidth: 1.75, bottom: -0.35, top: 1.8 },
      { z: 0.35, halfWidth: 1.8, bottom: -0.4, top: 1.85 },
      { z: 1.1, halfWidth: 1.62, bottom: -0.3, top: 1.6 },
      { z: 1.45, halfWidth: 1.25, bottom: -0.15, top: 1.2 },
    ]),
    m.armour,
  );
  const glacis = mesh(torso, new THREE.BoxGeometry(2.3, 1.0, 0.3), m.armourDark, [0, 0.85, 1.4]);
  glacis.rotation.x = -0.22;
  mesh(torso, new THREE.PlaneGeometry(0.95, 0.95), m.insignia, [0, 0.95, 1.58], [-0.22, 0, 0]);
  bothSides((s) => {
    mesh(torso, new THREE.BoxGeometry(0.5, 0.9, 0.16), m.vent, [s * 1.35, 0.5, 1.34]);
    for (let i = 0; i < 4; i++) {
      mesh(torso, new THREE.BoxGeometry(0.44, 0.06, 0.2), m.frame, [s * 1.35, 0.2 + i * 0.22, 1.38]);
    }
    // Waist ammunition drums.
    mesh(
      torso,
      new THREE.CylinderGeometry(0.42, 0.42, 0.7, 14),
      m.armourDark,
      [s * 1.55, -0.05, -0.5],
      [0, 0, Math.PI / 2],
    );
    mesh(
      torso,
      new THREE.CylinderGeometry(0.2, 0.2, 0.76, 10),
      m.piston,
      [s * 1.55, -0.05, -0.5],
      [0, 0, Math.PI / 2],
    );
  });
  rivets(torso, m.frame, 2.6, 1.9, 1.5, 5, 0.07);

  // --- head ----------------------------------------------------------------
  // Small and sunk between the pauldrons — the silhouette depends on it.
  const head = new THREE.Group();
  head.position.set(0, 1.68, 0.55);
  torso.add(head);
  mesh(head, new THREE.BoxGeometry(1.0, 0.62, 1.05), m.armourDark);
  const brow = mesh(head, new THREE.BoxGeometry(1.08, 0.22, 0.4), m.armour, [0, 0.3, 0.32]);
  brow.rotation.x = -0.3;
  mesh(head, new THREE.BoxGeometry(0.78, 0.26, 0.1), m.visor, [0, 0.02, 0.54]);
  bothSides((s) => {
    mesh(head, new THREE.CylinderGeometry(0.12, 0.12, 0.18, 10), m.frame, [s * 0.42, 0.14, 0.5], [Math.PI / 2, 0, 0]);
    mesh(head, new THREE.CylinderGeometry(0.09, 0.09, 0.04, 10), m.visor, [s * 0.42, 0.14, 0.6], [Math.PI / 2, 0, 0]);
  });
  mesh(head, new THREE.CylinderGeometry(0.02, 0.01, 1.1, 6), m.frame, [0.4, 0.85, -0.3], [0.14, 0, 0.1]);
  mesh(torso, new THREE.BoxGeometry(1.2, 0.5, 1.0), m.frame, [0, 1.42, 0.4]);

  // --- pauldrons and missile pods -----------------------------------------
  bothSides((s) => {
    const pauldron = new THREE.Group();
    pauldron.position.set(s * 2.15, 0.95, -0.05);
    torso.add(pauldron);
    mesh(
      pauldron,
      loft([
        { z: -1.15, halfWidth: 0.62, bottom: -0.9, top: 0.7 },
        { z: -0.5, halfWidth: 0.78, bottom: -1.05, top: 0.95 },
        { z: 0.5, halfWidth: 0.8, bottom: -1.05, top: 0.9 },
        { z: 1.1, halfWidth: 0.6, bottom: -0.85, top: 0.6 },
      ]),
      m.armour,
    );
    // The signature caution band across the top of the pauldron.
    mesh(pauldron, new THREE.BoxGeometry(1.7, 0.34, 1.9), m.hazard, [0, 0.82, -0.05]);
    mesh(pauldron, new THREE.BoxGeometry(0.24, 1.5, 2.0), m.armourDark, [s * 0.82, -0.15, -0.05]);
    rivets(pauldron, m.frame, 1.4, 1.6, 1.15, 4, 0.06);

    // Javelin missile pod, sitting on top of the pauldron.
    const pod = new THREE.Group();
    pod.position.set(s * 0.05, 1.25, -0.15);
    pod.rotation.x = -0.16;
    pauldron.add(pod);
    mesh(pod, new THREE.BoxGeometry(1.4, 0.8, 1.5), m.armourDark);
    mesh(pod, new THREE.BoxGeometry(1.45, 0.16, 0.5), m.trim, [0, 0.42, 0.5]);
    const cell = new THREE.CylinderGeometry(0.15, 0.15, 0.12, 10);
    cell.rotateX(Math.PI / 2);
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        mesh(pod, cell, m.vent, [-0.4 + c * 0.4, 0.18 - r * 0.36, 0.76]);
      }
    }
    const podMuzzle = new THREE.Object3D();
    podMuzzle.position.set(0, 0, 0.9);
    pod.add(podMuzzle);
    pod.userData.muzzle = podMuzzle;
  });

  // --- engine deck ---------------------------------------------------------
  mesh(torso, new THREE.BoxGeometry(2.6, 1.7, 1.0), m.armourDark, [0, 0.75, -1.7]);
  // Reactor vent. Small and recessed: a full-width glowing slab reads as a
  // light box rather than an exhaust.
  mesh(torso, new THREE.BoxGeometry(1.3, 0.42, 0.2), m.glow, [0, 0.62, -2.14]);
  for (let i = 0; i < 5; i++) {
    mesh(torso, new THREE.BoxGeometry(0.1, 0.5, 0.12), m.frame, [-0.52 + i * 0.26, 0.62, -2.22]);
  }
  mesh(torso, new THREE.BoxGeometry(1.7, 0.16, 0.24), m.frame, [0, 0.9, -2.2]);
  mesh(torso, new THREE.BoxGeometry(1.7, 0.16, 0.24), m.frame, [0, 0.34, -2.2]);
  for (let i = 0; i < 5; i++) {
    mesh(torso, new THREE.BoxGeometry(2.3, 0.1, 0.5), m.frame, [0, 1.5 - i * 0.22, -1.9], [0.4, 0, 0]);
  }
  bothSides((s) => {
    for (const dx of [0.35, 0.95]) {
      mesh(torso, new THREE.CylinderGeometry(0.19, 0.22, 1.5, 10), m.frame, [s * dx, 2.0, -1.75]);
      mesh(torso, new THREE.CylinderGeometry(0.24, 0.24, 0.16, 10), m.armourDark, [s * dx, 2.72, -1.75]);
      mesh(torso, new THREE.CylinderGeometry(0.14, 0.14, 0.06, 10), m.glow, [s * dx, 2.78, -1.75]);
    }
    for (let i = 0; i < 4; i++) {
      mesh(torso, new THREE.BoxGeometry(0.1, 0.5, 0.9), m.frame, [s * 1.72, 0.9 - i * 0.28, -1.2]);
    }
  });
  mesh(torso, new THREE.CylinderGeometry(0.02, 0.01, 2.2, 6), m.frame, [-1.0, 2.6, -1.9], [0.1, 0, -0.12]);

  // --- arms ----------------------------------------------------------------
  // One pivot for both arms, so the cannons elevate together with the aim.
  const arms = new THREE.Group();
  arms.name = 'arms';
  arms.position.set(0, 0.85, 0.1);
  torso.add(arms);
  const leftArm = buildArmCannon(arms, m, -1);
  const rightArm = buildArmCannon(arms, m, 1);

  const muzzles = [
    ...(rightArm.userData.muzzles as THREE.Object3D[]),
    ...(leftArm.userData.muzzles as THREE.Object3D[]),
  ];
  const podMuzzles: THREE.Object3D[] = [];
  torso.traverse((child) => {
    const anchor = child.userData.muzzle as THREE.Object3D | undefined;
    if (anchor) podMuzzles.push(anchor);
  });

  return {
    root,
    parts: {
      body,
      wheels: [],
      turret: null,
      barrel: null,
      muzzle: null,
      mech: { torso, arms, legs, muzzles, podMuzzles },
    },
    colliders: [
      { centre: new THREE.Vector3(0, 2.1, 0), size: new THREE.Vector3(3.4, 4.2, 3.0) },
      { centre: new THREE.Vector3(0, 5.6, -0.1), size: new THREE.Vector3(6.4, 3.0, 4.4) },
    ],
    size: new THREE.Vector3(6.4, THOR_HEIGHT, 6.0),
    // In the cockpit, looking out through the visor.
    driverEye: new THREE.Vector3(0, HIP_Y + 2.62, 1.25),
    cameraPivot: new THREE.Vector3(0, HIP_Y + 1.6, 0),
    exitOffset: new THREE.Vector3(-4.2, 0, 1.5),
  };
}
