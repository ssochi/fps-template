import * as THREE from 'three';
import { createWorldMaterials } from '../world/Materials';

export type ThrowableId = 'frag' | 'smoke' | 'flash';

export interface ThrowableConfig {
  id: ThrowableId;
  name: string;
  /** Short label for the HUD. */
  category: string;
  description: string;

  /** Seconds from the pin being pulled to detonation. */
  fuse: number;
  /** Whether holding the throw key cooks the fuse before the throw. */
  cookable: boolean;
  /** Detonate on the first solid contact instead of on the fuse. */
  impact: boolean;

  startCount: number;
  maxCount: number;

  /** Launch speed for a full overhand throw, m/s. */
  throwSpeed: number;
  /** Launch speed for the underhand (right mouse) toss, m/s. */
  lobSpeed: number;
  /** Upward bias added to the throw direction. */
  throwLift: number;

  radius: number;
  restitution: number;
  friction: number;

  /** Time from pressing throw to the projectile leaving the hand. */
  windup: number;
  /** Lockout after the throw before the next action. */
  recovery: number;

  // --- payload ----------------------------------------------------------
  /** Peak damage at the centre of the blast. */
  damage: number;
  /** Beyond this radius the blast does nothing. */
  damageRadius: number;
  /** Seconds a smoke cloud keeps emitting. */
  smokeDuration: number;
  /** Radius of the smoke cloud, metres. */
  smokeRadius: number;
  /** Seconds of full blindness at point blank. */
  flashDuration: number;
  /** Beyond this radius a flash has no effect. */
  flashRadius: number;

  colour: number;
  bandColour: number;
}

export const FRAG: ThrowableConfig = {
  id: 'frag',
  name: 'M67 Fragmentation',
  category: 'FRAG',
  description: 'Three-second fuse. Cook it by holding the throw key — the timer starts when the pin comes out.',
  fuse: 3.0,
  cookable: true,
  impact: false,
  startCount: 4,
  maxCount: 6,
  throwSpeed: 18,
  lobSpeed: 8,
  throwLift: 0.18,
  radius: 0.05,
  restitution: 0.32,
  friction: 0.6,
  windup: 0.24,
  recovery: 0.45,
  damage: 140,
  damageRadius: 8,
  smokeDuration: 0,
  smokeRadius: 0,
  flashDuration: 0,
  flashRadius: 0,
  colour: 0x3f4a35,
  bandColour: 0xd8a41c,
};

export const SMOKE: ThrowableConfig = {
  id: 'smoke',
  name: 'M18 Smoke',
  category: 'SMOKE',
  description: 'Pops two seconds after landing and screens the lane for about twenty seconds.',
  fuse: 2.0,
  cookable: false,
  impact: false,
  startCount: 3,
  maxCount: 4,
  throwSpeed: 16,
  lobSpeed: 7.5,
  throwLift: 0.2,
  radius: 0.055,
  restitution: 0.2,
  friction: 0.5,
  windup: 0.24,
  recovery: 0.45,
  damage: 0,
  damageRadius: 0,
  smokeDuration: 20,
  smokeRadius: 6,
  flashDuration: 0,
  flashRadius: 0,
  colour: 0x5a6355,
  bandColour: 0x39d6ff,
};

export const FLASH: ThrowableConfig = {
  id: 'flash',
  name: 'M84 Stun',
  category: 'FLASH',
  description: 'Short fuse, blinding bang. Look away or put something solid between you and it.',
  fuse: 1.6,
  cookable: false,
  impact: false,
  startCount: 3,
  maxCount: 4,
  throwSpeed: 17,
  lobSpeed: 8,
  throwLift: 0.2,
  radius: 0.045,
  restitution: 0.45,
  friction: 0.7,
  windup: 0.22,
  recovery: 0.4,
  damage: 0,
  damageRadius: 0,
  smokeDuration: 0,
  smokeRadius: 0,
  flashDuration: 4.5,
  flashRadius: 14,
  colour: 0x2b2f34,
  bandColour: 0xe8e0c8,
};

export const THROWABLE_CONFIGS: Record<ThrowableId, ThrowableConfig> = {
  frag: FRAG,
  smoke: SMOKE,
  flash: FLASH,
};

export const THROWABLE_ORDER: readonly ThrowableId[] = ['frag', 'smoke', 'flash'];

// ------------------------------------------------------------------ models

const modelCache = new Map<ThrowableId, THREE.Group>();

/**
 * Procedural grenade bodies. Each returns a fresh clone so projectiles, the
 * view model and the HUD preview can all hold one at once.
 */
function buildThrowable(id: ThrowableId): THREE.Group {
  const m = createWorldMaterials();
  const cfg = THROWABLE_CONFIGS[id];
  const group = new THREE.Group();
  group.name = `throwable-${id}`;

  const body = new THREE.MeshStandardMaterial({ color: cfg.colour, roughness: 0.72, metalness: 0.35 });
  const band = new THREE.MeshStandardMaterial({ color: cfg.bandColour, roughness: 0.6, metalness: 0.2 });

  if (id === 'frag') {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.038, 14, 12), body);
    shell.scale.set(1, 1.18, 1);
    group.add(shell);
    // Fragmentation grooves.
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0355, 0.0028, 6, 18), band);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -0.022 + i * 0.015;
      group.add(ring);
    }
    for (let i = 0; i < 6; i++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.076, 0.004), band);
      const a = (i / 6) * Math.PI * 2;
      rib.position.set(Math.cos(a) * 0.036, 0, Math.sin(a) * 0.036);
      group.add(rib);
    }
  } else {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.11, 16), body);
    group.add(can);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.0325, 0.0325, 0.018, 16), band);
    stripe.position.y = 0.02;
    group.add(stripe);
    if (id === 'flash') {
      // Emission ports around the body.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const port = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.01, 8), m.rubber);
        port.rotation.z = Math.PI / 2;
        port.position.set(Math.cos(a) * 0.032, -0.02, Math.sin(a) * 0.032);
        port.lookAt(0, -0.02, 0);
        group.add(port);
      }
    } else {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.012, 8), m.rubber);
        hole.position.set(Math.cos(a) * 0.016, 0.055, Math.sin(a) * 0.016);
        group.add(hole);
      }
    }
  }

  // Fuse assembly: striker housing, safety lever and pull ring.
  const top = id === 'frag' ? 0.044 : 0.055;
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.02, 12), m.gunMetal);
  housing.position.y = top + 0.008;
  group.add(housing);

  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.058, 0.005), m.gunMetal);
  lever.position.set(0.02, top - 0.014, 0);
  lever.rotation.z = -0.12;
  group.add(lever);

  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.0025, 6, 14), m.gunMetal);
  ring.position.set(-0.022, top + 0.012, 0);
  ring.rotation.y = Math.PI / 2;
  group.add(ring);

  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  return group;
}

export function getThrowableModel(id: ThrowableId): THREE.Group {
  let cached = modelCache.get(id);
  if (!cached) {
    cached = buildThrowable(id);
    modelCache.set(id, cached);
  }
  return cached.clone(true);
}
