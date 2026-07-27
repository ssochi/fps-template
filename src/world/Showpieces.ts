import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { bothSides, loft, mesh, tube } from './ModelKit';
import {
  brushedMetalSurface,
  carbonSurface,
  fabricSurface,
  soilSurface,
  surfaceMaterial,
  terracottaSurface,
  walnutSurface,
  wornEnamelSurface,
  type Surface,
} from './PbrSurface';
import { createCanvasTexture } from './Materials';

/**
 * Showcase props for the studio level.
 *
 * These are built to a different standard from the gameplay props: full PBR
 * surfaces rather than flat colours, `MeshPhysicalMaterial` layers where the
 * real material has them (clearcoat over car paint, sheen on upholstery,
 * anisotropy on brushed steel, transmission on glass), and rounded geometry
 * where a hard box edge would give the model away.
 *
 * All of it only reads correctly with an environment map — clearcoat, sheen and
 * anisotropy are reflection effects and there is nothing for them to reflect
 * otherwise. `StudioLevel` supplies one.
 *
 * Everything is built origin-on-the-ground, facing +Z.
 */

export interface Showpiece {
  root: THREE.Group;
  /** Bounding size, for plinth and camera framing. */
  size: THREE.Vector3;
  /** Named hinges the level animates, e.g. the fridge doors. */
  hinges: { node: THREE.Group; open: number; axis: 'y' | 'z' }[];
  /** Lights that belong to the piece — the fridge's interior lamp. */
  lights: THREE.Light[];
  /** The typewriter's linkage, for the level to drive. */
  typing?: TypingLinkage;
  dispose(): void;
}

/** Everything the level needs to make the typewriter strike a key. */
export interface TypingLinkage {
  keys: { node: THREE.Group; rest: number }[];
  typebars: THREE.Group[];
  carriage: THREE.Group;
  carriageRest: number;
}

// ---------------------------------------------------------------- materials

interface ShowMaterials {
  surfaces: Surface[];
  materials: THREE.Material[];
  /** Geometries built per-instance rather than shared; the rest are cached. */
  geometries: THREE.BufferGeometry[];
}

function track(store: ShowMaterials, material: THREE.Material): THREE.Material {
  store.materials.push(material);
  return material;
}

function newStore(): ShowMaterials {
  return { surfaces: [], materials: [], geometries: [] };
}

function disposer(store: ShowMaterials): () => void {
  return () => {
    for (const s of store.surfaces) s.dispose();
    for (const m of store.materials) m.dispose();
    for (const g of store.geometries) g.dispose();
  };
}

/** Rounded box; the single cheapest upgrade over a hard-edged primitive. */
function rounded(w: number, h: number, d: number, radius = 0.02, segments = 3): THREE.BufferGeometry {
  return new RoundedBoxGeometry(w, h, d, segments, Math.min(radius, Math.min(w, h, d) / 2 - 1e-3));
}

// ---------------------------------------------------------------- supercar

/**
 * A show-condition mid-engine supercar.
 *
 * The paint is the point: a metallic base under a `clearcoat` layer with its
 * own near-zero roughness, which is what separates automotive paint from any
 * other glossy surface. A faint flake normal map under the coat gives it the
 * sparkle that a flat colour cannot.
 */
export function buildShowcar(): Showpiece {
  const store = newStore();
  const root = new THREE.Group();
  root.name = 'showcar';

  const carbon = carbonSurface(8);
  store.surfaces.push(carbon);

  // Metallic flake: sparse bright specks that only show under the clearcoat.
  const flakeTex = createCanvasTexture(
    256,
    (ctx, size) => {
      ctx.fillStyle = '#8080ff';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 2600; i++) {
        const a = Math.random() * Math.PI * 2;
        ctx.fillStyle = `rgb(${128 + Math.cos(a) * 60},${128 + Math.sin(a) * 60},235)`;
        ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
      }
    },
    { repeat: 42, srgb: false },
  );

  const paint = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0x0d3b6e,
      metalness: 0.85,
      roughness: 0.28,
      // Automotive clearcoat: a second, far smoother specular lobe on top.
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      normalMap: flakeTex,
      normalScale: new THREE.Vector2(0.12, 0.12),
    }),
  ) as THREE.MeshPhysicalMaterial;

  const carbonMat = track(
    store,
    surfaceMaterial(carbon, { clearcoat: 0.4, clearcoatRoughness: 0.16, anisotropy: 0.4 }),
  );
  // Glazing reads almost entirely by what it reflects, so near-total
  // transmission makes a canopy vanish and the car look roofless. Privacy
  // tint plus a strong specular lobe is what puts the surface back.
  const glass = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0x0c1218,
      metalness: 0,
      roughness: 0.05,
      transmission: 0.55,
      thickness: 0.02,
      ior: 1.52,
      specularIntensity: 1,
      envMapIntensity: 1.6,
    }),
  );
  const chrome = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0xdfe4ea, metalness: 1, roughness: 0.045 }),
  );
  // Painted alloy, not chrome. A pure metal has no diffuse term at all, so a
  // rim modelled as one goes black in a shadowed wheel arch no matter how
  // bright its colour — which is exactly what a real wheel is not, because a
  // real wheel is silver paint and lacquer over the casting.
  const alloy = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0xa9afb7,
      metalness: 0.55,
      roughness: 0.42,
      clearcoat: 0.3,
      clearcoatRoughness: 0.18,
    }),
  );
  const steel = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x8d939b, metalness: 1, roughness: 0.42 }),
  );
  const caliperMat = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0xb8341f, metalness: 0.2, roughness: 0.35, clearcoat: 0.6 }),
  );
  const rubber = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x121316, metalness: 0, roughness: 0.92 }),
  );
  const trim = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x1a1d21, metalness: 0.4, roughness: 0.45 }),
  );
  const leather = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x2a1c18, metalness: 0, roughness: 0.62, sheen: 0.3 }),
  );
  const lamp = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0x0a0e12,
      emissive: 0xdfeaff,
      emissiveIntensity: 1.6,
      roughness: 0.08,
      metalness: 0.2,
    }),
  );
  const tail = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0x1c0203,
      emissive: 0xff1f1f,
      emissiveIntensity: 2.2,
      roughness: 0.14,
    }),
  );

  const WHEEL_R = 0.35;
  const AXLE_F = 1.42;
  const AXLE_R = -1.46;
  const TRACK = 0.85;

  // --- body ---------------------------------------------------------------
  // Twelve sections rather than eight: the extra loops are what keep the
  // shoulder line reading as a curve instead of a chamfer. Every section is
  // chamfered with a narrowed sill and roof, so the cross-section is a
  // shouldered decagon — a plain rectangular loft gives slab sides and hard
  // 90-degree edges that no amount of clearcoat rescues.
  mesh(
    root,
    loft([
      { z: -2.36, halfWidth: 0.86, bottom: 0.32, top: 0.8, chamfer: 0.13, topHalfWidth: 0.78, bottomHalfWidth: 0.76 },
      { z: -2.1, halfWidth: 0.96, bottom: 0.24, top: 0.86, chamfer: 0.15, topHalfWidth: 0.86, bottomHalfWidth: 0.84 },
      { z: -1.78, halfWidth: 1.02, bottom: 0.19, top: 0.9, chamfer: 0.16, topHalfWidth: 0.9, bottomHalfWidth: 0.9 },
      { z: -1.3, halfWidth: 1.05, bottom: 0.16, top: 0.92, chamfer: 0.17, topHalfWidth: 0.9, bottomHalfWidth: 0.93 },
      { z: -0.82, halfWidth: 1.04, bottom: 0.15, top: 0.9, chamfer: 0.17, topHalfWidth: 0.86, bottomHalfWidth: 0.93 },
      { z: -0.28, halfWidth: 1.0, bottom: 0.14, top: 0.87, chamfer: 0.16, topHalfWidth: 0.82, bottomHalfWidth: 0.9 },
      { z: 0.3, halfWidth: 0.97, bottom: 0.14, top: 0.84, chamfer: 0.16, topHalfWidth: 0.8, bottomHalfWidth: 0.88 },
      { z: 0.86, halfWidth: 0.94, bottom: 0.14, top: 0.79, chamfer: 0.15, topHalfWidth: 0.78, bottomHalfWidth: 0.85 },
      { z: 1.38, halfWidth: 0.9, bottom: 0.15, top: 0.71, chamfer: 0.14, topHalfWidth: 0.74, bottomHalfWidth: 0.8 },
      { z: 1.86, halfWidth: 0.83, bottom: 0.17, top: 0.62, chamfer: 0.13, topHalfWidth: 0.66, bottomHalfWidth: 0.72 },
      { z: 2.2, halfWidth: 0.72, bottom: 0.2, top: 0.54, chamfer: 0.11, topHalfWidth: 0.56, bottomHalfWidth: 0.62 },
      { z: 2.44, halfWidth: 0.52, bottom: 0.25, top: 0.48, chamfer: 0.07, topHalfWidth: 0.42, bottomHalfWidth: 0.46 },
    ]),
    paint,
  );

  // Greenhouse: strong tumblehome, so the glass leans in over the shoulder.
  mesh(
    root,
    loft([
      { z: -1.42, halfWidth: 0.6, bottom: 0.88, top: 1.02, chamfer: 0.07, topHalfWidth: 0.48 },
      { z: -1.0, halfWidth: 0.68, bottom: 0.87, top: 1.16, chamfer: 0.09, topHalfWidth: 0.56 },
      { z: -0.4, halfWidth: 0.7, bottom: 0.86, top: 1.23, chamfer: 0.1, topHalfWidth: 0.6 },
      { z: 0.24, halfWidth: 0.67, bottom: 0.85, top: 1.24, chamfer: 0.1, topHalfWidth: 0.6 },
      { z: 0.84, halfWidth: 0.6, bottom: 0.83, top: 1.1, chamfer: 0.09, topHalfWidth: 0.52 },
      { z: 1.36, halfWidth: 0.47, bottom: 0.8, top: 0.9, chamfer: 0.05, topHalfWidth: 0.4 },
    ]),
    glass,
  );
  // A painted roof panel over the canopy, with the pillars sitting *on* the
  // glass surface rather than inside it. Pillars buried in the glass show
  // through a tinted canopy as bars floating in mid-air — a roll cage, not a
  // greenhouse — so each one is pushed out to the section half-width it spans.
  mesh(root, rounded(1.18, 0.06, 1.42, 0.06), paint, [0, 1.245, -0.28]);
  mesh(root, rounded(1.06, 0.02, 1.3, 0.04), trim, [0, 1.2, -0.28]);
  bothSides((s) => {
    // Cant rail: the painted lower edge of the side glass. The canopy needs a
    // frame, but modelled pillars are a trap here — the glass tapers in z
    // faster than a straight bar does, so anything spanning the windscreen
    // ends up outside the silhouette and reads as a roll cage strapped over
    // the roof. The roof panel and this rail do the framing on the surface.
    mesh(root, rounded(0.05, 0.05, 1.5, 0.02), paint, [s * 0.69, 0.87, -0.2]);
    // Windscreen and backlight surrounds, flat against the glass.
    const front = mesh(root, rounded(0.9, 0.04, 0.24, 0.015), trim, [s * 0.28, 1.02, 1.16]);
    front.rotation.x = -0.5;
    const rear = mesh(root, rounded(0.9, 0.04, 0.2, 0.015), trim, [s * 0.28, 1.06, -1.3]);
    rear.rotation.x = 0.5;
  });

  // Shut lines: thin dark insets are what make separate panels read as panels.
  //
  // They have to hug the surface they sit in. A flank that narrows above and
  // below the waist puts anything placed at the maximum half-width outside
  // the paint, and a seam wide enough to see then reads as a black plate
  // bolted to the door rather than as a gap between two panels.
  bothSides((s) => {
    // Door leading and trailing edges, vertical.
    for (const z of [1.24, -0.34]) {
      const seam = mesh(root, new THREE.BoxGeometry(0.02, 0.44, 0.014), trim, [s * 0.95, 0.55, z]);
      seam.rotation.y = s * 0.04;
    }
    // Sill seam along the bottom of the door.
    mesh(root, new THREE.BoxGeometry(0.02, 0.014, 1.56), trim, [s * 0.93, 0.34, 0.46]);
    // Bonnet shut line across the nose.
    mesh(root, new THREE.BoxGeometry(1.34, 0.014, 0.02), trim, [0, 0.7, 1.42]);
  });

  // --- aero ---------------------------------------------------------------
  mesh(root, rounded(1.94, 0.06, 4.4, 0.03), carbonMat, [0, 0.115, -0.1]);
  mesh(root, rounded(1.78, 0.06, 0.6, 0.03), carbonMat, [0, 0.18, 2.4]);
  bothSides((s) => {
    const plane = mesh(root, rounded(0.36, 0.035, 0.24, 0.015), carbonMat, [s * 0.9, 0.36, 2.24]);
    plane.rotation.z = s * -0.2;
    plane.rotation.x = 0.14;
    mesh(root, rounded(0.1, 0.09, 2.5, 0.035), carbonMat, [s * 0.87, 0.2, 0.05]);
    // Side intake feeding the mid engine.
    const scoop = mesh(root, rounded(0.12, 0.32, 0.7, 0.05), trim, [s * 0.9, 0.55, -0.75]);
    scoop.rotation.y = s * 0.1;
    mesh(root, rounded(0.07, 0.22, 0.54, 0.03), carbonMat, [s * 0.94, 0.55, -0.77]);
    // Mirror on a carbon stalk.
    mesh(root, new THREE.CylinderGeometry(0.016, 0.016, 0.2, 10), carbonMat, [s * 0.87, 0.94, 0.92], [0, 0, s * 0.95]);
    const housing = mesh(root, rounded(0.05, 0.075, 0.14, 0.025), paint, [s * 0.98, 0.99, 0.92]);
    housing.rotation.y = s * 0.2;
    mesh(root, new THREE.PlaneGeometry(0.04, 0.06), chrome, [s * 1.005, 0.99, 0.92], [0, s * (Math.PI / 2), 0]);
    // Flared arch lips. A thin tube out at the track width reads as a wire
    // hoop hovering beside the car; the lip has to be thick enough to be a
    // pressing and close enough to be part of the wing.
    for (const z of [AXLE_F, AXLE_R]) {
      const arch = mesh(
        root,
        new THREE.TorusGeometry(WHEEL_R + 0.07, 0.055, 10, 20, Math.PI),
        paint,
        [s * (TRACK + 0.13), WHEEL_R + 0.01, z],
      );
      arch.rotation.y = Math.PI / 2;
      // Haunch: the sheet between the arch lip and the body side.
      const haunch = mesh(
        root,
        new THREE.TorusGeometry(WHEEL_R + 0.05, 0.09, 8, 16, Math.PI * 0.8),
        paint,
        [s * (TRACK + 0.04), WHEEL_R + 0.02, z],
      );
      haunch.rotation.y = Math.PI / 2;
      haunch.rotation.x = Math.PI * 0.1;
    }
  });

  // Diffuser and swan-neck wing.
  const diffuser = mesh(root, rounded(1.78, 0.36, 0.76, 0.03), carbonMat, [0, 0.25, -2.12]);
  diffuser.rotation.x = -0.44;
  for (let i = -2; i <= 2; i++) {
    mesh(root, rounded(0.035, 0.3, 0.72, 0.015), carbonMat, [i * 0.35, 0.27, -2.12]);
  }
  bothSides((s) => {
    const neck = mesh(root, rounded(0.06, 0.36, 0.13, 0.025), carbonMat, [s * 0.52, 0.98, -2.0]);
    neck.rotation.x = -0.22;
    mesh(root, rounded(0.03, 0.32, 0.66, 0.015), carbonMat, [s * 0.84, 1.2, -2.04]);
  });
  const wing = mesh(root, rounded(1.7, 0.05, 0.44, 0.02), carbonMat, [0, 1.2, -2.04]);
  wing.rotation.x = -0.2;
  mesh(root, rounded(1.7, 0.03, 0.16, 0.015), carbonMat, [0, 1.1, -1.86]);

  // --- lighting signature -------------------------------------------------
  bothSides((s) => {
    // Recessed headlamp bucket with lens elements, then the DRL blade.
    const bucket = mesh(root, rounded(0.44, 0.2, 0.16, 0.05), trim, [s * 0.62, 0.58, 2.32]);
    bucket.rotation.z = s * 0.14;
    for (const dx of [-0.12, 0, 0.12]) {
      mesh(
        root,
        new THREE.SphereGeometry(0.055, 14, 10),
        lamp,
        [s * 0.62 + dx * (s > 0 ? 1 : -1), 0.58 + dx * 0.14 * (s > 0 ? 1 : -1), 2.38],
      );
    }
    const drl = mesh(root, rounded(0.06, 0.26, 0.06, 0.02), lamp, [s * 0.83, 0.5, 2.28]);
    drl.rotation.z = s * 0.32;
    // Front intakes.
    mesh(root, rounded(0.4, 0.18, 0.12, 0.04), trim, [s * 0.66, 0.3, 2.4]);
  });
  mesh(root, rounded(0.86, 0.16, 0.12, 0.04), trim, [0, 0.32, 2.44]);

  // Full-width tail bar plus corner blocks.
  mesh(root, rounded(1.5, 0.06, 0.06, 0.02), tail, [0, 0.68, -2.37]);
  bothSides((s) => {
    mesh(root, rounded(0.26, 0.13, 0.07, 0.03), tail, [s * 0.66, 0.56, -2.37]);
  });
  mesh(root, rounded(1.34, 0.28, 0.1, 0.03), carbonMat, [0, 0.4, -2.38]);
  for (const x of [-0.31, -0.1, 0.1, 0.31]) {
    mesh(root, new THREE.CylinderGeometry(0.062, 0.072, 0.18, 16), chrome, [x, 0.47, -2.38], [Math.PI / 2, 0, 0]);
  }

  // --- engine bay ---------------------------------------------------------
  mesh(root, rounded(0.94, 0.3, 0.84, 0.04), trim, [0, 0.68, -1.24]);
  mesh(root, rounded(0.64, 0.16, 0.52, 0.03), chrome, [0, 0.86, -1.24]);
  bothSides((s) => {
    mesh(root, new THREE.CylinderGeometry(0.05, 0.05, 0.34, 12), chrome, [s * 0.2, 0.95, -1.24], [Math.PI / 2, 0, 0]);
  });
  for (let i = 0; i < 6; i++) {
    mesh(root, rounded(0.9, 0.016, 0.1, 0.006), carbonMat, [0, 0.92 - i * 0.004, -0.94 - i * 0.12]);
  }

  // --- interior -----------------------------------------------------------
  bothSides((s) => {
    mesh(root, rounded(0.44, 0.1, 0.52, 0.04), leather, [s * 0.35, 0.92, 0.06]);
    const back = mesh(root, rounded(0.42, 0.46, 0.09, 0.04), leather, [s * 0.35, 1.08, -0.2]);
    back.rotation.x = -0.16;
    mesh(root, rounded(0.34, 0.14, 0.1, 0.04), leather, [s * 0.35, 1.24, -0.28]);
  });
  mesh(root, rounded(1.16, 0.13, 0.32, 0.05), trim, [0, 0.97, 0.64]);
  mesh(root, rounded(0.3, 0.1, 0.8, 0.04), carbonMat, [0, 0.92, 0.12]);
  const rim = mesh(root, new THREE.TorusGeometry(0.14, 0.023, 10, 20), leather, [0.35, 1.02, 0.5]);
  rim.rotation.x = 1.18;
  mesh(root, new THREE.CylinderGeometry(0.035, 0.035, 0.24, 10), carbonMat, [0.35, 0.98, 0.62], [1.18, 0, 0]);

  // --- wheels -------------------------------------------------------------
  const tyreLabel = createCanvasTexture(256, (ctx, size) => {
    ctx.fillStyle = '#121316';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(210,210,210,0.5)';
    ctx.font = `bold ${size * 0.075}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('MERIDIAN SPORT  325/30 ZR21', size / 2, size * 0.5);
  });
  const sidewall = track(
    store,
    new THREE.MeshPhysicalMaterial({ map: tyreLabel, color: 0xffffff, roughness: 0.95, metalness: 0 }),
  );

  bothSides((s) => {
    for (const [z, r, width] of [
      [AXLE_F, WHEEL_R, 0.3],
      [AXLE_R, WHEEL_R + 0.04, 0.38],
    ] as [number, number, number][]) {
      const hub = new THREE.Group();
      hub.position.set(s * TRACK, r, z);
      root.add(hub);

      const tyre = new THREE.CylinderGeometry(r, r, width, 30, 1, true);
      tyre.rotateZ(Math.PI / 2);
      mesh(hub, tyre, rubber);
      // The sidewall has to be an annulus. A capped cylinder here is a solid
      // disc across the whole wheel: it hides the rim completely and the wheel
      // renders as a black circle with tyre lettering on it.
      for (const side of [-1, 1]) {
        const wall = new THREE.RingGeometry(r * 0.72, r * 0.995, 30, 1);
        mesh(hub, wall, sidewall, [(side * width) / 2, 0, 0], [0, side * (Math.PI / 2), 0]);
      }
      // Tread blocks.
      const block = new THREE.BoxGeometry(width * 0.26, 0.014, r * 0.36);
      for (let i = 0; i < 34; i++) {
        const a = (i / 34) * Math.PI * 2;
        for (const row of [-1, 0, 1]) {
          const angle = a + ((row + 1) % 2) * (Math.PI / 34);
          mesh(
            hub,
            block,
            rubber,
            [row * width * 0.3, Math.sin(angle) * (r + 0.005), Math.cos(angle) * (r + 0.005)],
            [Math.PI / 2 - angle, 0, 0],
          );
        }
      }

      // Rim: a concave multi-spoke, machined face, over a drilled steel disc.
      // Open-ended, for the same reason the sidewall is an annulus — a capped
      // cylinder here is a solid disc that buries every spoke behind it.
      const barrel = new THREE.CylinderGeometry(r * 0.68, r * 0.68, width * 0.9, 28, 1, true);
      barrel.rotateZ(Math.PI / 2);
      mesh(hub, barrel, trim);
      const face = width / 2 - 0.02;
      // Ten spokes. The box is (axial depth, radial length, tangential width)
      // before the roll about X, and the tangential width is the one that has
      // to stay slim — widen it and the ten spokes close up into a solid disc
      // with four notches in it rather than a wheel.
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        // `rotation.x = a` turns local +Y into (0, cos a, sin a), so the
        // position has to be (cos a, sin a) too. Swapping them — the obvious
        // (sin, cos) — leaves each spoke sitting across its own radius, and
        // ten of them trace a box outline instead of a radial fan.
        const spoke = mesh(hub, rounded(width * 0.22, r * 0.6, 0.026, 0.008), alloy, [
          s * (face - width * 0.14),
          Math.cos(a) * r * 0.34,
          Math.sin(a) * r * 0.34,
        ]);
        spoke.rotation.x = a;
      }
      const lip = new THREE.TorusGeometry(r * 0.72, 0.018, 10, 30);
      lip.rotateY(Math.PI / 2);
      mesh(hub, lip, steel, [s * face, 0, 0]);
      const disc = new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.03, 26);
      disc.rotateZ(Math.PI / 2);
      mesh(hub, disc, steel);
      // Cross-drilling: the holes are what make a disc read as a brake disc.
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        for (const rr of [r * 0.36, r * 0.5]) {
          mesh(
            hub,
            new THREE.CylinderGeometry(0.012, 0.012, 0.04, 6),
            trim,
            [0, Math.sin(a) * rr, Math.cos(a) * rr],
            [0, 0, Math.PI / 2],
          );
        }
      }
      // The caliper clamps the disc edge, inboard of the spokes.
      const caliper = mesh(hub, rounded(width * 0.2, r * 0.44, r * 0.2, 0.02), caliperMat, [
        -s * width * 0.06,
        r * 0.44,
        -r * 0.16,
      ]);
      caliper.rotation.x = 0.34;
      mesh(hub, new THREE.CylinderGeometry(r * 0.2, r * 0.2, width * 0.5, 16), alloy, [s * face * 0.8, 0, 0], [0, 0, Math.PI / 2]);
      // Centre-lock nut, so the hub has a focal point.
      mesh(hub, new THREE.CylinderGeometry(r * 0.11, r * 0.11, width * 0.16, 6), alloy, [s * (face + 0.01), 0, 0], [0, 0, Math.PI / 2]);
    }
  });

  store.materials.push(sidewall);
  return {
    root,
    size: new THREE.Vector3(2.1, 1.3, 4.9),
    hinges: [],
    lights: [],
    dispose: () => {
      disposer(store)();
      flakeTex.dispose();
      tyreLabel.dispose();
    },
  };
}

// -------------------------------------------------------------------- sofa

/**
 * A three-seat mid-century sofa.
 *
 * Upholstery is the interesting material here: `sheen` is a separate retro-
 * reflective lobe that models the fuzz on a woven surface, and without it cloth
 * reads as painted plastic no matter how good the albedo is.
 */
export function buildSofa(): Showpiece {
  const store = newStore();
  const root = new THREE.Group();
  root.name = 'sofa';

  const cloth = fabricSurface('#4e6b7a', 8);
  const walnut = walnutSurface(4);
  store.surfaces.push(cloth, walnut);

  const fabric = track(
    store,
    surfaceMaterial(cloth, {
      // A woven surface scatters at grazing angles; this is what sells cloth.
      sheen: 1,
      sheenRoughness: 0.55,
      sheenColor: new THREE.Color(0x9fc6d8),
    }),
  );
  const piping = track(
    store,
    surfaceMaterial(fabricSurface('#31485a', 20), {
      sheen: 0.8,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(0x8fb4c8),
    }),
  );
  const wood = track(store, surfaceMaterial(walnut, { clearcoat: 0.35, clearcoatRoughness: 0.3 }));
  const brass = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0xb8914a, metalness: 1, roughness: 0.22 }),
  );
  const thread = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x2b3b46, roughness: 0.85, metalness: 0 }),
  );

  const W = 2.24;
  const D = 0.92;
  const SEAT_Y = 0.42;

  // --- frame and legs ------------------------------------------------------
  mesh(root, rounded(W, 0.12, D, 0.03), wood, [0, SEAT_Y - 0.08, 0]);
  const legGeo = new THREE.CylinderGeometry(0.03, 0.045, 0.4, 12);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = mesh(root, legGeo, wood, [sx * (W / 2 - 0.16), 0.2, sz * (D / 2 - 0.14)]);
      // Splayed, which is the whole silhouette of the period.
      leg.rotation.z = sx * 0.12;
      leg.rotation.x = -sz * 0.12;
      // The ferrule hangs off the leg, not off the sofa. Placing it in the
      // parent's space means guessing where the splay put the foot, and the
      // guess is out by the tilt — brass rings floating beside each leg.
      mesh(leg, new THREE.CylinderGeometry(0.046, 0.046, 0.05, 12), brass, [0, -0.175, 0]);
    }
  }

  // --- arms ----------------------------------------------------------------
  bothSides((s) => {
    const arm = mesh(root, rounded(0.2, 0.42, D, 0.09, 5), fabric, [s * (W / 2 - 0.1), SEAT_Y + 0.19, 0]);
    arm.rotation.z = s * 0.03;
    // Welt cord along the top of the arm.
    mesh(
      root,
      tube(
        [
          [s * (W / 2 - 0.1), SEAT_Y + 0.4, -D / 2 + 0.04],
          [s * (W / 2 - 0.1), SEAT_Y + 0.41, 0],
          [s * (W / 2 - 0.1), SEAT_Y + 0.4, D / 2 - 0.04],
        ],
        0.016,
      ),
      piping,
    );
    mesh(root, rounded(0.22, 0.1, D + 0.02, 0.04), wood, [s * (W / 2 - 0.1), SEAT_Y - 0.02, 0]);
  });

  // --- back ----------------------------------------------------------------
  const backRest = mesh(root, rounded(W - 0.34, 0.56, 0.2, 0.07, 4), fabric, [0, SEAT_Y + 0.34, -D / 2 + 0.1]);
  backRest.rotation.x = 0.1;

  // --- cushions ------------------------------------------------------------
  // Three seats and three backs, each nudged and rotated a touch: a row of
  // identical cushions is the fastest way to look like a render, not a sofa.
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 0.7;
    const jitter = (i - 1) * 0.012;

    const seat = mesh(root, rounded(0.68, 0.17, D - 0.14, 0.075, 5), fabric, [x, SEAT_Y + 0.07, 0.03]);
    seat.rotation.y = jitter;
    seat.rotation.z = jitter * 0.5;
    mesh(
      root,
      tube(
        [
          [x - 0.33, SEAT_Y + 0.07, D / 2 - 0.09],
          [x, SEAT_Y + 0.075, D / 2 - 0.08],
          [x + 0.33, SEAT_Y + 0.07, D / 2 - 0.09],
        ],
        0.014,
      ),
      piping,
    );

    const back = mesh(root, rounded(0.66, 0.5, 0.18, 0.07, 5), fabric, [x, SEAT_Y + 0.4, -D / 2 + 0.21]);
    back.rotation.x = 0.14;
    back.rotation.y = -jitter;

    // Button tufting: the button sits in a dimple, so add both.
    for (const [bx, by] of [
      [-0.16, 0.1],
      [0.16, 0.1],
      [0, -0.09],
    ] as [number, number][]) {
      const dimple = mesh(root, new THREE.SphereGeometry(0.05, 12, 8), fabric, [
        x + bx,
        SEAT_Y + 0.4 + by,
        -D / 2 + 0.3,
      ]);
      dimple.scale.set(1, 1, 0.35);
      mesh(root, new THREE.SphereGeometry(0.022, 12, 8), piping, [x + bx, SEAT_Y + 0.4 + by, -D / 2 + 0.315]);
    }

    // Top-stitch along the cushion seam.
    for (let st = 0; st < 14; st++) {
      mesh(root, new THREE.BoxGeometry(0.022, 0.004, 0.004), thread, [
        x - 0.3 + st * 0.046,
        SEAT_Y + 0.155,
        D / 2 - 0.075,
      ]);
    }
  }

  // Throw cushions, set at an angle.
  for (const [x, a] of [
    [-0.78, 0.4],
    [0.8, -0.32],
  ] as [number, number][]) {
    const pillow = mesh(root, rounded(0.34, 0.34, 0.12, 0.06, 5), piping, [x, SEAT_Y + 0.36, -0.18]);
    pillow.rotation.set(0.18, 0, a);
  }

  return {
    root,
    size: new THREE.Vector3(W, 0.86, D),
    hinges: [],
    lights: [],
    dispose: disposer(store),
  };
}

// ------------------------------------------------------------------ fridge

/**
 * A French-door refrigerator whose doors and freezer drawer actually open.
 *
 * Each door is a hinge group with the geometry offset so the pivot sits on the
 * hinge line rather than the door's centre — the usual mistake makes a door
 * swing about its middle and sink into the carcass. The interior lamp is a real
 * `PointLight` that only switches on when something is open.
 */
export function buildFridge(): Showpiece {
  const store = newStore();
  const root = new THREE.Group();
  root.name = 'fridge';

  const steel = brushedMetalSurface(2.2, '#aeb5bc');
  store.surfaces.push(steel);

  const shell = track(
    store,
    surfaceMaterial(steel, {
      // Brushed steel: the grain smears the highlight along one axis.
      anisotropy: 0.75,
      anisotropyRotation: Math.PI / 2,
      clearcoat: 0.25,
      clearcoatRoughness: 0.3,
    }),
  );
  const dark = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x1a1d21, metalness: 0.5, roughness: 0.5 }),
  );
  const chrome = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0xd6dce2, metalness: 1, roughness: 0.08 }),
  );
  const liner = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0xb7bdc2, metalness: 0, roughness: 0.55 }),
  );
  const seal = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x24272b, metalness: 0, roughness: 0.95 }),
  );
  const shelfGlass = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0xd8f0f4,
      metalness: 0,
      roughness: 0.02,
      transmission: 0.94,
      thickness: 0.01,
      ior: 1.5,
      transparent: true,
      opacity: 0.55,
    }),
  );
  const crisper = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0xbfd6dd,
      metalness: 0,
      roughness: 0.25,
      transmission: 0.6,
      thickness: 0.02,
      transparent: true,
      opacity: 0.6,
    }),
  );
  const display = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0x02080c,
      emissive: 0x35d6ff,
      emissiveIntensity: 1.4,
      roughness: 0.1,
    }),
  );
  // The lamp diffuser is bright, not over-bright: anything past the 1.0 bloom
  // high-pass in a small white-lined box blooms the whole frame white.
  const interiorLamp = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0xfff6e2,
      emissive: 0xfff4dc,
      emissiveIntensity: 0.85,
      roughness: 0.4,
    }),
  );

  const W = 0.92;
  const H = 1.82;
  const D = 0.72;
  const WALL = 0.055;
  const DOOR_T = 0.09;
  const FREEZER_H = 0.52;
  const FRIDGE_H = H - FREEZER_H;

  // --- carcass -------------------------------------------------------------
  // Built as five slabs rather than a hollowed box, so the liner is a real
  // surface the interior light can bounce off.
  mesh(root, rounded(W, H, WALL, 0.01), shell, [0, H / 2, -D / 2 + WALL / 2]);
  bothSides((s) => {
    mesh(root, rounded(WALL, H, D - WALL, 0.01), shell, [s * (W / 2 - WALL / 2), H / 2, WALL / 2]);
  });
  mesh(root, rounded(W, WALL, D, 0.01), shell, [0, H - WALL / 2, 0]);
  mesh(root, rounded(W, WALL, D, 0.01), shell, [0, WALL / 2, 0]);
  // Liner: a slightly inset white shell.
  mesh(root, rounded(W - WALL * 2.2, FRIDGE_H - 0.04, 0.01), liner, [0, FREEZER_H + FRIDGE_H / 2, -D / 2 + WALL + 0.01]);
  bothSides((s) => {
    mesh(root, rounded(0.01, FRIDGE_H - 0.04, D - WALL * 2), liner, [
      s * (W / 2 - WALL - 0.01),
      FREEZER_H + FRIDGE_H / 2,
      WALL / 2,
    ]);
  });
  mesh(root, rounded(W - WALL * 2.2, 0.012, D - WALL * 2), liner, [0, FREEZER_H + 0.01, WALL / 2]);
  mesh(root, rounded(W - WALL * 2.2, 0.012, D - WALL * 2), liner, [0, H - WALL - 0.01, WALL / 2]);
  // Mid divider between fridge and freezer.
  mesh(root, rounded(W - WALL * 2, 0.03, D - WALL, 0.008), shell, [0, FREEZER_H, WALL / 2]);
  // Feet and toe kick.
  mesh(root, rounded(W - 0.06, 0.07, 0.05, 0.01), dark, [0, 0.035, D / 2 - 0.06]);
  for (const sx of [-1, 1]) {
    mesh(root, new THREE.CylinderGeometry(0.028, 0.032, 0.05, 10), dark, [sx * (W / 2 - 0.08), 0.025, -D / 2 + 0.08]);
  }

  // --- interior fittings ---------------------------------------------------
  const shelfW = W - WALL * 2.4;
  for (let i = 0; i < 3; i++) {
    const y = FREEZER_H + 0.32 + i * 0.3;
    mesh(root, rounded(shelfW, 0.012, D - WALL * 2.4, 0.004), shelfGlass, [0, y, WALL / 2]);
    mesh(root, rounded(shelfW, 0.02, 0.014, 0.005), chrome, [0, y + 0.012, D / 2 - WALL - 0.06]);
  }
  // Crisper drawers.
  for (const sx of [-1, 1]) {
    mesh(root, rounded(shelfW / 2 - 0.01, 0.2, D - WALL * 2.6, 0.012), crisper, [
      sx * (shelfW / 4 + 0.005),
      FREEZER_H + 0.14,
      WALL / 2,
    ]);
    mesh(root, rounded(shelfW / 2 - 0.06, 0.016, 0.012), chrome, [
      sx * (shelfW / 4 + 0.005),
      FREEZER_H + 0.2,
      D / 2 - WALL - 0.03,
    ]);
  }

  // Contents: bottles, cartons, jars. Cheap, and an empty fridge looks fake.
  const bottleMat = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0x2f6b3a,
      roughness: 0.08,
      metalness: 0,
      transmission: 0.7,
      thickness: 0.03,
      transparent: true,
      opacity: 0.8,
    }),
  );
  const cartonMat = track(store, new THREE.MeshPhysicalMaterial({ color: 0xd8d2c4, roughness: 0.8 }));
  const jarMat = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0xc98a3a,
      roughness: 0.1,
      transmission: 0.5,
      thickness: 0.02,
      transparent: true,
      opacity: 0.85,
    }),
  );
  for (let i = 0; i < 4; i++) {
    const x = -0.26 + i * 0.17;
    mesh(root, new THREE.CylinderGeometry(0.035, 0.035, 0.24, 14), bottleMat, [x, FREEZER_H + 0.44, -0.06]);
    mesh(root, new THREE.CylinderGeometry(0.014, 0.014, 0.06, 12), bottleMat, [x, FREEZER_H + 0.59, -0.06]);
    mesh(root, new THREE.CylinderGeometry(0.016, 0.016, 0.02, 12), dark, [x, FREEZER_H + 0.63, -0.06]);
  }
  for (let i = 0; i < 2; i++) {
    mesh(root, rounded(0.1, 0.2, 0.08, 0.008), cartonMat, [-0.2 + i * 0.15, FREEZER_H + 0.72, 0.04]);
    mesh(root, rounded(0.03, 0.06, 0.03, 0.01), cartonMat, [-0.2 + i * 0.15, FREEZER_H + 0.84, 0.04]);
  }
  for (let i = 0; i < 3; i++) {
    mesh(root, new THREE.CylinderGeometry(0.04, 0.04, 0.1, 14), jarMat, [0.1 + i * 0.1, FREEZER_H + 0.98, 0.0]);
    mesh(root, new THREE.CylinderGeometry(0.042, 0.042, 0.016, 14), chrome, [0.1 + i * 0.1, FREEZER_H + 1.04, 0.0]);
  }

  // Interior lamp: emissive housing plus the light it stands for.
  mesh(root, rounded(0.22, 0.04, 0.09, 0.012), interiorLamp, [0, H - WALL - 0.05, -D / 2 + WALL + 0.1]);
  const lamp = new THREE.PointLight(0xfff0d4, 0, 1.6, 2);
  lamp.position.set(0, H - 0.16, -0.06);
  root.add(lamp);

  // --- doors ---------------------------------------------------------------
  const hinges: Showpiece['hinges'] = [];

  const buildDoor = (side: 1 | -1): void => {
    const doorW = W / 2;
    const hinge = new THREE.Group();
    // Pivot on the outer edge — the hinge line, not the door's centre.
    hinge.position.set(side * (W / 2), FREEZER_H + FRIDGE_H / 2, D / 2 - DOOR_T / 2);
    root.add(hinge);

    // Everything is offset inboard so the panel spans hinge -> centre.
    const cx = -side * (doorW / 2);
    mesh(hinge, rounded(doorW, FRIDGE_H - 0.02, DOOR_T, 0.02), shell, [cx, 0, 0]);
    mesh(hinge, rounded(doorW - 0.03, FRIDGE_H - 0.06, 0.012), liner, [cx, 0, -DOOR_T / 2 - 0.006]);
    // Magnetic gasket around the sealing face.
    for (const [w, h, x, y] of [
      [doorW - 0.06, 0.022, cx, (FRIDGE_H - 0.08) / 2],
      [doorW - 0.06, 0.022, cx, -(FRIDGE_H - 0.08) / 2],
      [0.022, FRIDGE_H - 0.08, cx - doorW / 2 + 0.03, 0],
      [0.022, FRIDGE_H - 0.08, cx + doorW / 2 - 0.03, 0],
    ] as [number, number, number, number][]) {
      mesh(hinge, rounded(w, h, 0.016, 0.005), seal, [x, y, -DOOR_T / 2 - 0.012]);
    }
    // Door bins.
    for (let i = 0; i < 3; i++) {
      const y = -FRIDGE_H / 2 + 0.22 + i * 0.32;
      mesh(hinge, rounded(doorW - 0.09, 0.14, 0.09, 0.012), crisper, [cx, y, -DOOR_T / 2 - 0.06]);
      mesh(hinge, rounded(doorW - 0.09, 0.012, 0.09, 0.004), liner, [cx, y - 0.07, -DOOR_T / 2 - 0.06]);
    }
    // Vertical bar handle, standing off the face on two posts.
    const hx = cx + side * (doorW / 2 - 0.07);
    mesh(hinge, new THREE.CylinderGeometry(0.016, 0.016, FRIDGE_H * 0.62, 14), chrome, [hx, 0, DOOR_T / 2 + 0.055]);
    for (const sy of [-1, 1]) {
      mesh(
        hinge,
        new THREE.CylinderGeometry(0.012, 0.012, 0.06, 10),
        chrome,
        [hx, sy * FRIDGE_H * 0.29, DOOR_T / 2 + 0.028],
        [Math.PI / 2, 0, 0],
      );
    }
    // Hinge barrels.
    for (const sy of [-1, 1]) {
      mesh(hinge, new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), dark, [
        -side * 0.012,
        sy * (FRIDGE_H / 2 - 0.05),
        0,
      ]);
    }

    // The left door carries the dispenser recess and control panel.
    if (side < 0) {
      mesh(hinge, rounded(0.2, 0.28, 0.06, 0.015), dark, [cx, 0.1, DOOR_T / 2 - 0.01]);
      mesh(hinge, rounded(0.16, 0.09, 0.008), display, [cx, 0.2, DOOR_T / 2 + 0.022]);
      mesh(hinge, new THREE.CylinderGeometry(0.014, 0.014, 0.05, 10), chrome, [cx, 0.14, DOOR_T / 2 + 0.01], [Math.PI / 2, 0, 0]);
      mesh(hinge, rounded(0.12, 0.02, 0.03, 0.006), chrome, [cx, 0.0, DOOR_T / 2 + 0.005]);
    }

    hinges.push({ node: hinge, open: side < 0 ? 1 : -1, axis: 'y' });
  };
  buildDoor(1);
  buildDoor(-1);

  // Freezer drawer: slides forward rather than swinging.
  const drawer = new THREE.Group();
  drawer.position.set(0, FREEZER_H / 2 - 0.01, D / 2 - DOOR_T / 2);
  root.add(drawer);
  mesh(drawer, rounded(W, FREEZER_H - 0.04, DOOR_T, 0.02), shell);
  mesh(drawer, rounded(W - 0.06, 0.022, 0.016, 0.005), seal, [0, (FREEZER_H - 0.1) / 2, -DOOR_T / 2 - 0.012]);
  mesh(drawer, new THREE.CylinderGeometry(0.016, 0.016, W * 0.7, 14), chrome, [0, 0.08, DOOR_T / 2 + 0.055], [0, 0, Math.PI / 2]);
  for (const sx of [-1, 1]) {
    mesh(drawer, new THREE.CylinderGeometry(0.012, 0.012, 0.06, 10), chrome, [sx * W * 0.3, 0.08, DOOR_T / 2 + 0.028], [Math.PI / 2, 0, 0]);
  }
  // The basket that comes with it.
  mesh(drawer, rounded(W - 0.14, 0.22, D - 0.24, 0.012), crisper, [0, -0.04, -D / 2 + 0.1]);
  hinges.push({ node: drawer, open: 1, axis: 'z' });

  // --- exterior trim -------------------------------------------------------
  mesh(root, rounded(0.13, 0.03, 0.006), dark, [0, H - 0.12, D / 2 + 0.002]);

  return {
    root,
    size: new THREE.Vector3(W, H, D + 0.1),
    hinges,
    lights: [lamp],
    dispose: disposer(store),
  };
}

// ------------------------------------------------------------- potted plant

/**
 * A monstera in a terracotta pot.
 *
 * Everything else in this scene is a closed hard-surface shell. A plant is the
 * opposite problem and needs three things none of the others do:
 *
 * 1. **Alpha cutout.** A monstera's silhouette *is* the model — the splits and
 *    holes cannot be geometry at this budget, so each leaf is one alpha-tested
 *    quad. `alphaTest` rather than `transparent` keeps them in the opaque pass,
 *    so there is no sort order to get wrong. three.js compiles a matching
 *    depth-material variant on its own, so the shadows are cut out too.
 * 2. **Two-sided shading.** A leaf has no back face to cull, and three.js flips
 *    the normal for back faces, so the underside lights correctly for free.
 * 3. **Translucency.** A leaf between you and a lamp glows. Thin-walled
 *    `transmission` is the closest this material model gets.
 */
export function buildPlant(): Showpiece {
  const store = newStore();
  const root = new THREE.Group();
  root.name = 'plant';

  // --- leaf texture: colour and silhouette in one RGBA canvas --------------
  const leafTex = createCanvasTexture(512, (ctx, size) => {
    const cx = size / 2;
    // The blade: a rounded heart, drawn once and reused as the clip path.
    const blade = new Path2D();
    blade.moveTo(cx, size * 0.03);
    blade.bezierCurveTo(size * 0.94, size * 0.24, size * 0.9, size * 0.78, cx, size * 0.98);
    blade.bezierCurveTo(size * 0.1, size * 0.78, size * 0.06, size * 0.24, cx, size * 0.03);

    ctx.save();
    ctx.clip(blade);
    ctx.fillStyle = '#2f6b33';
    ctx.fillRect(0, 0, size, size);
    // Midrib and lateral veins, lighter than the blade.
    ctx.strokeStyle = 'rgba(150,190,120,0.55)';
    ctx.lineWidth = size * 0.012;
    ctx.beginPath();
    ctx.moveTo(cx, size * 0.06);
    ctx.lineTo(cx, size * 0.96);
    ctx.stroke();
    ctx.lineWidth = size * 0.006;
    for (let i = 1; i < 9; i++) {
      const y = size * (0.1 + i * 0.095);
      for (const s of [-1, 1]) {
        ctx.strokeStyle = `rgba(150,190,120,${0.4 - i * 0.02})`;
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.quadraticCurveTo(cx + s * size * 0.22, y + size * 0.03, cx + s * size * 0.46, y + size * 0.1);
        ctx.stroke();
      }
    }
    // Mottling, so a flat green does not read as plastic.
    for (let i = 0; i < 900; i++) {
      const v = Math.random() < 0.5 ? 255 : 0;
      ctx.fillStyle = `rgba(${v},${v * 0.9},${v * 0.6},${Math.random() * 0.07})`;
      ctx.beginPath();
      ctx.arc(Math.random() * size, Math.random() * size, 2 + Math.random() * 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Fenestration. Cutting *after* painting means the veins run right up to
    // each split, which is what makes the holes look grown rather than punched.
    // Fenestration has to cut *deep* — a monstera's margin is split almost to
    // the midrib, and that division into lobes is the whole silhouette. Nicks
    // around the edge just read as a damaged houseplant.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    for (let i = 0; i < 6; i++) {
      const y = size * (0.2 + i * 0.125);
      // Deeper toward the middle of the blade, shallower at tip and base.
      const t = Math.sin((i / 5) * Math.PI);
      const depth = size * (0.2 + t * 0.2);
      const half = size * (0.018 + t * 0.016);
      for (const sd of [-1, 1]) {
        const outer = cx + sd * size * 0.52;
        const inner = cx + sd * (size * 0.5 - depth);
        // A wedge: wide at the margin, tapering to a rounded stop inboard.
        ctx.beginPath();
        ctx.moveTo(outer, y - half * 2.1);
        ctx.quadraticCurveTo(inner + sd * size * 0.05, y - half * 0.5, inner, y + half * 0.5);
        ctx.quadraticCurveTo(inner + sd * size * 0.05, y + half * 1.6, outer, y + half * 3.0);
        ctx.closePath();
        ctx.fill();
      }
      // The oval holes that sit between the splits, near the midrib.
      for (const sd of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(
          cx + sd * size * (0.1 + Math.random() * 0.07),
          y + size * 0.06,
          size * (0.022 + Math.random() * 0.02),
          size * 0.015,
          sd * 0.45,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  });

  const leafMat = track(
    store,
    new THREE.MeshPhysicalMaterial({
      map: leafTex,
      // Alpha *test*, not alpha blend: a cut-out leaf stays in the opaque pass
      // and needs no depth sorting against the forty others.
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 0.42,
      metalness: 0,
      clearcoat: 0.35,
      clearcoatRoughness: 0.35,
      sheen: 0.5,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0x9fd08a),
    }),
  );

  const stemMat = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x4c7a3a, roughness: 0.55, metalness: 0, sheen: 0.3 }),
  );

  const terracotta = terracottaSurface(2.2);
  store.surfaces.push(terracotta);
  const potMat = track(store, surfaceMaterial(terracotta, {}));
  const soil = soilSurface(3);
  store.surfaces.push(soil);
  const soilMat = track(store, surfaceMaterial(soil, {}));
  const pebble = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x6d6a63, roughness: 0.8, metalness: 0 }),
  );

  // --- pot ------------------------------------------------------------------
  const POT_TOP = 0.42;
  // A lathe profile that goes up the outside, over the rim and back down the
  // inside, so the pot is genuinely hollow rather than a cone with a lid.
  const profile: [number, number][] = [
    [0, 0],
    [0.155, 0],
    [0.168, 0.018],
    [0.2, 0.11],
    [0.235, 0.25],
    [0.248, 0.34],
    [0.252, 0.365],
    [0.285, 0.378],
    [0.285, POT_TOP - 0.015],
    [0.246, POT_TOP],
    [0.238, POT_TOP - 0.02],
    [0.232, 0.3],
    [0.198, 0.13],
    [0.172, 0.06],
    [0, 0.06],
  ];
  const potGeo = new THREE.LatheGeometry(
    profile.map(([x, y]) => new THREE.Vector2(x, y)),
    48,
  );
  mesh(root, potGeo, potMat);

  // Saucer.
  const saucerGeo = new THREE.LatheGeometry(
    [
      [0, 0],
      [0.3, 0],
      [0.32, 0.012],
      [0.335, 0.05],
      [0.325, 0.052],
      [0.31, 0.02],
      [0, 0.018],
    ].map(([x, y]) => new THREE.Vector2(x, y)),
    40,
  );
  mesh(root, saucerGeo, potMat, [0, -0.018, 0]);

  // --- soil and dressing ----------------------------------------------------
  const soilGeo = new THREE.SphereGeometry(0.235, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  soilGeo.scale(1, 0.22, 1);
  mesh(root, soilGeo, soilMat, [0, POT_TOP - 0.055, 0]);
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 0.2;
    const s = 0.012 + Math.random() * 0.018;
    const stone = mesh(
      root,
      new THREE.DodecahedronGeometry(s, 0),
      pebble,
      [Math.cos(a) * r, POT_TOP - 0.05 + Math.cos(r * 8) * 0.006, Math.sin(a) * r],
      [Math.random() * 3, Math.random() * 3, Math.random() * 3],
    );
    stone.scale.set(1, 0.6, 1);
  }

  // --- leaves ---------------------------------------------------------------
  // One quad per leaf, cupped along its width and drooping along its length, so
  // a flat cut-out still catches light across the blade instead of flashing on
  // and off as the turntable brings it edge-on.
  const leafGeo = (w: number, h: number): THREE.BufferGeometry => {
    const geo = new THREE.PlaneGeometry(w, h, 5, 7);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const u = x / (w / 2);
      const v = (y + h / 2) / h;
      // Cup across the blade, and let the tip fall away.
      pos.setZ(i, -u * u * h * 0.09 - (1 - v) * (1 - v) * h * 0.16);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  };

  const LEAVES: [number, number, number, number, number][] = [
    // yaw, tilt from vertical, petiole length, leaf size, roll
    [0.0, 0.62, 0.5, 0.46, 0.1],
    [0.9, 0.95, 0.62, 0.52, -0.2],
    [1.8, 0.5, 0.42, 0.4, 0.25],
    [2.6, 1.1, 0.7, 0.56, 0.15],
    [3.5, 0.35, 0.34, 0.34, -0.1],
    [4.3, 0.85, 0.58, 0.48, 0.3],
    [5.1, 1.05, 0.66, 0.5, -0.25],
    [5.8, 0.25, 0.3, 0.3, 0.05],
    [1.3, 0.15, 0.52, 0.32, 0.4],
    [4.0, 0.2, 0.6, 0.36, -0.35],
  ];

  for (const [yaw, tilt, len, span, roll] of LEAVES) {
    const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const base = new THREE.Vector3(dir.x * 0.05, POT_TOP - 0.05, dir.z * 0.05);
    // The petiole arcs: out and up from the compost, then over at the tip.
    const tipUp = Math.cos(tilt) * len;
    const tipOut = Math.sin(tilt) * len;
    const points: [number, number, number][] = [
      [base.x, base.y - 0.02, base.z],
      [base.x + dir.x * tipOut * 0.18, base.y + tipUp * 0.42, base.z + dir.z * tipOut * 0.18],
      [base.x + dir.x * tipOut * 0.62, base.y + tipUp * 0.85, base.z + dir.z * tipOut * 0.62],
      [base.x + dir.x * tipOut, base.y + tipUp, base.z + dir.z * tipOut],
    ];
    mesh(root, tube(points, 0.011, 10), stemMat);

    const leaf = new THREE.Mesh(leafGeo(span, span * 1.24), leafMat);
    const tip = new THREE.Vector3(points[3][0], points[3][1], points[3][2]);
    leaf.position.copy(tip).addScaledVector(dir, span * 0.45).setY(tip.y - span * 0.2);
    leaf.rotation.order = 'YXZ';
    leaf.rotation.y = -yaw + Math.PI / 2;
    // The blade hangs roughly horizontal on a drooping petiole.
    leaf.rotation.x = -Math.PI / 2 + tilt * 0.55;
    leaf.rotation.z = roll;
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    root.add(leaf);
    // The geometry is per-leaf, so it has to be tracked for disposal.
    store.geometries.push(leaf.geometry);
  }

  store.geometries.push(potGeo, saucerGeo, soilGeo);

  return {
    root,
    size: new THREE.Vector3(1.5, 1.35, 1.5),
    hinges: [],
    lights: [],
    dispose: () => {
      disposer(store)();
      leafTex.dispose();
    },
  };
}

// --------------------------------------------------------------- typewriter

/**
 * A 1930s desk typewriter.
 *
 * This one is here for the material rather than the shape. Every other piece in
 * the studio is showroom-new, which is the easy case: one surface per part.
 * A machine that has been used is a *stack* — steel, enamel over most of it,
 * grime settled into whatever the enamel did not cover — and `layeredSurface`
 * blends all three ORM channels through the wear mask, so a chip changes the
 * colour and the roughness and the metalness at once.
 *
 * The keys are also an atlas exercise: forty-odd keytops share one geometry,
 * one material and one texture, each with its glyph selected by baked UVs
 * rather than by a per-key material.
 */
/** Typebar angles: parked just clear of the shell, and up at the platen. */
export const TYPEBAR_REST = 0.24;
export const TYPEBAR_STRUCK = 0.86;

export function buildTypewriter(): Showpiece {
  const store = newStore();
  const root = new THREE.Group();
  root.name = 'typewriter';

  const enamel = wornEnamelSurface(2.4);
  store.surfaces.push(enamel);
  const bodyMat = track(store, surfaceMaterial(enamel, { clearcoat: 0.25, clearcoatRoughness: 0.45 }));

  const nickel = track(
    store,
    // Tarnished, not chromed: a mirror finish on a ninety-year-old machine is
    // the giveaway that nobody thought about the material.
    new THREE.MeshPhysicalMaterial({ color: 0xb2b6ba, metalness: 1, roughness: 0.28 }),
  );
  const blackMetal = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x17191c, metalness: 0.35, roughness: 0.5 }),
  );
  const platenMat = track(
    store,
    // Perished rubber: matte, slightly grey-bloomed.
    new THREE.MeshPhysicalMaterial({ color: 0x2a2723, metalness: 0, roughness: 0.88 }),
  );
  const paperMat = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0xb8b3a6, metalness: 0, roughness: 0.95, side: THREE.DoubleSide }),
  );
  const ribbonMat = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0x1d1a18, metalness: 0, roughness: 0.7 }),
  );

  // --- key glyph atlas ------------------------------------------------------
  const COLS = 8;
  const ROWS = 6;
  const GLYPHS = 'QWERTYUIOPASDFGHJKLZXCVBNM1234567890.,;:?-+@&%$#*!/'.split('');
  const keyTex = createCanvasTexture(1024, (ctx, size) => {
    const cw = size / COLS;
    const ch = size / ROWS;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        const x = c * cw;
        const y = r * ch;
        ctx.fillStyle = '#111316';
        ctx.fillRect(x, y, cw, ch);
        // The white ring that edges a period keytop.
        ctx.strokeStyle = '#cdc7b8';
        ctx.lineWidth = size * 0.004;
        ctx.beginPath();
        ctx.arc(x + cw / 2, y + ch / 2, Math.min(cw, ch) * 0.42, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#e8e2d2';
        ctx.font = `bold ${ch * 0.42}px Georgia, serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(GLYPHS[i % GLYPHS.length], x + cw / 2, y + ch / 2 + ch * 0.02);
      }
    }
  });

  /**
   * A keytop whose top face samples one cell of the atlas.
   *
   * Rewriting the UVs is what keeps this to one draw call. Giving each key its
   * own material would be forty materials and forty uploads of the same image
   * to say the same thing.
   */
  const keyGeo = (glyphIndex: number): THREE.BufferGeometry => {
    const geo = new THREE.CylinderGeometry(0.0165, 0.019, 0.008, 16, 1);
    const uv = geo.attributes.uv;
    const pos = geo.attributes.position;
    const col = glyphIndex % COLS;
    const row = Math.floor(glyphIndex / COLS) % ROWS;
    for (let i = 0; i < uv.count; i++) {
      // Only the top cap carries the glyph; the side wall gets a dark corner
      // of the same cell so it stays on the one texture.
      if (pos.getY(i) > 0.0035) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        uv.setXY(i, (col + u) / COLS, 1 - (row + 1 - v) / ROWS);
      } else {
        uv.setXY(i, (col + 0.03) / COLS, 1 - (row + 0.97) / ROWS);
      }
    }
    uv.needsUpdate = true;
    return geo;
  };

  // --- body -----------------------------------------------------------------
  const bodyGeo = loft([
    { z: -0.16, halfWidth: 0.16, bottom: 0.012, top: 0.10, chamfer: 0.03, topHalfWidth: 0.13, bottomHalfWidth: 0.14 },
    { z: -0.09, halfWidth: 0.175, bottom: 0.006, top: 0.135, chamfer: 0.035, topHalfWidth: 0.145, bottomHalfWidth: 0.155 },
    { z: 0.0, halfWidth: 0.178, bottom: 0.004, top: 0.125, chamfer: 0.035, topHalfWidth: 0.15, bottomHalfWidth: 0.16 },
    { z: 0.08, halfWidth: 0.172, bottom: 0.004, top: 0.085, chamfer: 0.03, topHalfWidth: 0.15, bottomHalfWidth: 0.155 },
    { z: 0.15, halfWidth: 0.162, bottom: 0.004, top: 0.05, chamfer: 0.02, topHalfWidth: 0.145, bottomHalfWidth: 0.145 },
  ]);
  mesh(root, bodyGeo, bodyMat);
  store.geometries.push(bodyGeo);

  // Feet.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      mesh(root, new THREE.CylinderGeometry(0.016, 0.018, 0.014, 12), platenMat, [
        sx * 0.13,
        0.007,
        sz * 0.12,
      ]);
    }
  }

  // Side panels with the maker's name.
  const badgeTex = createCanvasTexture(256, (ctx, size) => {
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#c9a24a';
    ctx.font = `italic bold ${size * 0.3}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Halden', size / 2, size / 2);
  });
  const badgeMat = track(
    store,
    new THREE.MeshPhysicalMaterial({
      map: badgeTex,
      alphaTest: 0.4,
      color: 0xffffff,
      metalness: 0.9,
      roughness: 0.32,
      side: THREE.DoubleSide,
    }),
  );
  mesh(root, new THREE.PlaneGeometry(0.13, 0.033), badgeMat, [0, 0.108, -0.163]);

  // --- carriage -------------------------------------------------------------
  // Slides left as you type; this is the group the interaction animates.
  const carriage = new THREE.Group();
  carriage.name = 'carriage';
  carriage.position.set(0, 0.148, -0.075);
  root.add(carriage);

  mesh(carriage, rounded(0.36, 0.014, 0.052, 0.005), blackMetal);
  mesh(carriage, new THREE.CylinderGeometry(0.006, 0.006, 0.38, 10), nickel, [0, 0.028, 0.028], [0, 0, Math.PI / 2]);

  const platen = new THREE.Group();
  platen.position.set(0, 0.042, 0);
  carriage.add(platen);
  mesh(platen, new THREE.CylinderGeometry(0.032, 0.032, 0.3, 28), platenMat, [0, 0, 0], [0, 0, Math.PI / 2]);
  for (const sx of [-1, 1]) {
    mesh(platen, new THREE.CylinderGeometry(0.038, 0.038, 0.018, 20), blackMetal, [sx * 0.157, 0, 0], [0, 0, Math.PI / 2]);
    // Knurled end knob.
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      mesh(platen, new THREE.BoxGeometry(0.019, 0.004, 0.004), blackMetal, [
        sx * 0.157,
        Math.cos(a) * 0.037,
        Math.sin(a) * 0.037,
      ], [a, 0, 0]);
    }
  }
  // Paper: fed round the platen and standing up behind it.
  const SHEET_H = 0.2;
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.2, SHEET_H, 1, 8), paperMat);
  const spos = sheet.geometry.attributes.position;
  for (let i = 0; i < spos.count; i++) {
    const v = (spos.getY(i) + SHEET_H / 2) / SHEET_H;
    // Curls forward at the bottom, where it comes off the platen.
    spos.setZ(i, -Math.pow(1 - v, 2) * 0.055);
  }
  spos.needsUpdate = true;
  sheet.geometry.computeVertexNormals();
  sheet.position.set(0, 0.085, -0.05);
  sheet.rotation.x = -0.14;
  sheet.castShadow = true;
  carriage.add(sheet);
  store.geometries.push(sheet.geometry);

  // Paper bail and its rollers.
  mesh(carriage, new THREE.CylinderGeometry(0.0035, 0.0035, 0.26, 8), nickel, [0, 0.056, -0.036], [0, 0, Math.PI / 2]);
  for (const sx of [-1, 0, 1]) {
    mesh(carriage, new THREE.CylinderGeometry(0.007, 0.007, 0.026, 10), platenMat, [sx * 0.08, 0.056, -0.036], [0, 0, Math.PI / 2]);
  }
  // Carriage return lever.
  const lever = mesh(carriage, new THREE.CylinderGeometry(0.004, 0.004, 0.11, 8), nickel, [-0.2, 0.03, 0.01], [0, 0, 0.5]);
  lever.rotation.z = 1.05;
  mesh(carriage, rounded(0.045, 0.008, 0.014, 0.004), blackMetal, [-0.235, 0.062, 0.01]);

  // --- typebar basket -------------------------------------------------------
  // Fanned arms behind the keys; the struck one swings up to the platen.
  // The pivot sits low and forward, the arm reaches back and up toward the
  // printing point at the front of the platen. Rest angle is set so the tips
  // clear the shell — a basket tucked entirely inside the body is what a real
  // machine has, but it also means the fan is invisible until something is
  // struck, and this is a display piece.
  const typebars: THREE.Group[] = [];
  const BAR_COUNT = 21;
  for (let i = 0; i < BAR_COUNT; i++) {
    const t = i / (BAR_COUNT - 1) - 0.5;
    const pivot = new THREE.Group();
    pivot.name = `typebar${i}`;
    pivot.position.set(t * 0.14, 0.115, 0.005);
    pivot.rotation.y = -t * 1.0;
    root.add(pivot);
    mesh(pivot, new THREE.BoxGeometry(0.0045, 0.0035, 0.085), nickel, [0, 0, -0.043]);
    // The type slug on the end.
    mesh(pivot, rounded(0.009, 0.009, 0.007, 0.002), blackMetal, [0, 0, -0.085]);
    pivot.rotation.x = TYPEBAR_REST;
    typebars.push(pivot);
  }

  // Type guide, sitting in the throat where the bars converge.
  mesh(root, rounded(0.03, 0.016, 0.01, 0.003), nickel, [0, 0.142, -0.056]);

  // --- ribbon spools --------------------------------------------------------
  for (const sx of [-1, 1]) {
    mesh(root, new THREE.CylinderGeometry(0.028, 0.028, 0.012, 20), nickel, [sx * 0.105, 0.132, -0.028]);
    mesh(root, new THREE.CylinderGeometry(0.024, 0.024, 0.016, 20), ribbonMat, [sx * 0.105, 0.136, -0.028]);
    mesh(root, new THREE.CylinderGeometry(0.005, 0.005, 0.03, 10), nickel, [sx * 0.105, 0.142, -0.028]);
  }
  mesh(root, new THREE.BoxGeometry(0.19, 0.011, 0.002), ribbonMat, [0, 0.126, -0.045]);

  // --- keyboard -------------------------------------------------------------
  // Four staggered rows, each on a stem, each a pivot the interaction presses.
  const keys: { node: THREE.Group; rest: number }[] = [];
  // One material, one texture, one upload — the whole point of the atlas.
  const capMat = track(
    store,
    new THREE.MeshPhysicalMaterial({
      map: keyTex,
      metalness: 0.1,
      roughness: 0.38,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
    }),
  );
  const ROW_COUNTS = [10, 9, 8, 7];
  let glyph = 0;
  for (let r = 0; r < ROW_COUNTS.length; r++) {
    const count = ROW_COUNTS[r];
    const z = 0.055 + r * 0.028;
    // The body's top surface falls away toward the player: it is at y 0.125 at
    // z 0, 0.085 at z 0.08 and 0.05 at z 0.15. Keys placed on a flat plane
    // below that line disappear *inside* the shell, which is what happened the
    // first time — the keyboard rendered as four nickel dots.
    const y = 0.116 - r * 0.0185;
    for (let c = 0; c < count; c++) {
      const x = (c - (count - 1) / 2) * 0.0345 + (r % 2 ? 0.008 : 0);
      const node = new THREE.Group();
      node.name = `key${keys.length}`;
      node.position.set(x, y, z);
      root.add(node);
      const geo = keyGeo(glyph++);
      const cap = new THREE.Mesh(geo, capMat);
      cap.castShadow = true;
      cap.receiveShadow = true;
      node.add(cap);
      store.geometries.push(geo);
      // The stem down into the body.
      mesh(node, new THREE.CylinderGeometry(0.0022, 0.0022, 0.03, 8), nickel, [0, -0.018, 0.004], [0.35, 0, 0]);
      keys.push({ node, rest: y });
    }
  }
  // Space bar.
  const spaceNode = new THREE.Group();
  spaceNode.name = `key${keys.length}`;
  spaceNode.position.set(0, 0.048, 0.163);
  root.add(spaceNode);
  mesh(spaceNode, rounded(0.16, 0.008, 0.014, 0.003), blackMetal);
  keys.push({ node: spaceNode, rest: 0.036 });

  return {
    root,
    size: new THREE.Vector3(0.42, 0.3, 0.42),
    hinges: [],
    lights: [],
    typing: { keys, typebars, carriage, carriageRest: carriage.position.x },
    dispose: () => {
      disposer(store)();
      keyTex.dispose();
      badgeTex.dispose();
    },
  };
}

// ----------------------------------------------------------- decanter set

/**
 * Cut-crystal decanter, two tumblers and a tray.
 *
 * Almost no geometry, and that is deliberate: this piece is a shading test.
 * The parts it exercises are the ones the other showpieces never touch:
 *
 * - **`attenuationColor` / `attenuationDistance`** — Beer-Lambert absorption
 *   through the volume, so the whisky darkens with the path length through it.
 *   A shallow pour is pale and the belly of the decanter is deep amber, from
 *   one material with no gradient painted anywhere.
 * - **`dispersion`** — wavelength-dependent IOR, which is where the fire in a
 *   cut lead crystal comes from.
 * - **One volume per vessel, split at the fill line.** The textbook model is a
 *   liquid shell at IOR 1.36 nested inside a glass shell at 1.55, and it does
 *   not render here at all: three.js transmission refracts a backdrop that
 *   contains only the *opaque* scene, so a transmissive liquid inside a
 *   transmissive glass is in nobody's backdrop and is simply invisible.
 *   Measured — the pour came out neutral grey while the same absorption on a
 *   free-standing ball came out amber.
 *
 *   So each vessel is two stacked solids instead: below the fill line one
 *   volume carrying the whisky's absorption, above it a hollow crystal shell.
 *   That is what the eye receives anyway — glass, whisky and glass again read
 *   as one amber body — and it survives a renderer that only refracts once.
 *
 * The limit that remains: nothing refracts twice, so a tumbler seen through the
 * decanter does not bend. That needs a different renderer, not more tuning.
 */
export function buildDecanterSet(): Showpiece {
  const store = newStore();
  const root = new THREE.Group();
  root.name = 'decanter';

  const crystal = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.03,
      transmission: 1,
      thickness: 0.05,
      ior: 1.55,
      // Lead crystal is not water-clear; it carries the faintest grey.
      attenuationColor: new THREE.Color(0xf2f6f4),
      attenuationDistance: 0.9,
      dispersion: 1.6,
      specularIntensity: 1,
      envMapIntensity: 1.4,
      side: THREE.DoubleSide,
    }),
  );
  const whisky = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.02,
      transmission: 1,
      thickness: 0.1,
      // Between glass and spirit, because this one volume stands in for both.
      ior: 1.48,
      // The amber is absorption, not albedo: short distance, saturated colour.
      // Beer-Lambert then does the rest — the belly is deep and the shoulder,
      // where the volume is thin, is pale, from a single flat parameter.
      attenuationColor: new THREE.Color(0xe09a34),
      attenuationDistance: 0.115,
      envMapIntensity: 1.2,
    }),
  );
  // Blended, not transmissive, for the same reason: ice sitting in the drink
  // would be a transmissive object behind a transmissive one and would vanish.
  // Alpha blending renders after the transmissive pass, so it survives.
  const ice = track(
    store,
    new THREE.MeshPhysicalMaterial({
      color: 0xdff0ff,
      metalness: 0,
      roughness: 0.32,
      ior: 1.31,
      transparent: true,
      opacity: 0.62,
      envMapIntensity: 1.3,
    }),
  );

  const walnut = walnutSurface(5);
  store.surfaces.push(walnut);
  const trayMat = track(store, surfaceMaterial(walnut, { clearcoat: 0.4, clearcoatRoughness: 0.25 }));
  const brass = track(
    store,
    new THREE.MeshPhysicalMaterial({ color: 0xb08d42, metalness: 1, roughness: 0.3 }),
  );

  const lathe = (points: [number, number][], segments: number): THREE.BufferGeometry => {
    const geo = new THREE.LatheGeometry(
      points.map(([x, y]) => new THREE.Vector2(x, y)),
      segments,
    );
    store.geometries.push(geo);
    return geo;
  };

  // --- tray -----------------------------------------------------------------
  mesh(root, rounded(0.42, 0.016, 0.3, 0.006), trayMat, [0, 0.008, 0]);
  for (const sx of [-1, 1]) {
    mesh(root, rounded(0.012, 0.022, 0.3, 0.004), trayMat, [sx * 0.204, 0.019, 0]);
  }
  for (const sz of [-1, 1]) {
    mesh(root, rounded(0.42, 0.022, 0.012, 0.004), trayMat, [0, 0.019, sz * 0.144]);
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      mesh(root, new THREE.CylinderGeometry(0.007, 0.007, 0.006, 10), brass, [sx * 0.19, 0.003, sz * 0.13]);
    }
  }

  // --- decanter -------------------------------------------------------------
  const DEC = new THREE.Group();
  DEC.position.set(-0.1, 0.016, 0);
  root.add(DEC);

  // Low segment count on the body is the cut: a crystal decanter is faceted,
  // and a smooth lathe here throws away the whole reason for the dispersion.
  //
  // Split at the fill line: the belly is one solid carrying the whisky's
  // absorption, the shoulder and neck a hollow crystal shell above it. They
  // share a silhouette, so the join reads as the surface of the pour.
  const LEVEL = 0.105;
  mesh(
    DEC,
    lathe(
      [
        [0.0, 0.0],
        [0.058, 0.0],
        [0.07, 0.012],
        [0.076, 0.05],
        [0.0745, LEVEL],
        [0.0, LEVEL],
      ],
      12,
    ),
    whisky,
  );
  mesh(
    DEC,
    lathe(
      // A closed ring section — first point repeated at the end — rather than
      // one that starts and ends on the axis, which lays two coincident discs
      // across the fill line and z-fights them.
      [
        [0.0745, LEVEL],
        [0.062, 0.14],
        [0.04, 0.168],
        [0.028, 0.186],
        [0.026, 0.215],
        [0.032, 0.232],
        [0.03, 0.238],
        [0.023, 0.232],
        [0.02, 0.19],
        [0.032, 0.166],
        [0.055, 0.135],
        [0.0655, LEVEL],
        [0.0745, LEVEL],
      ],
      12,
    ),
    crystal,
  );

  // Faceted stopper.
  const stopperGeo = new THREE.SphereGeometry(0.036, 8, 5);
  store.geometries.push(stopperGeo);
  mesh(DEC, stopperGeo, crystal, [0, 0.268, 0]);
  mesh(DEC, lathe([[0, 0], [0.021, 0], [0.021, 0.03], [0, 0.03]], 10), crystal, [0, 0.234, 0]);

  // --- tumblers -------------------------------------------------------------
  const POUR = 0.048;
  // Below the pour: one filled volume. Above it: the hollow glass.
  const drinkGeo = lathe(
    [
      [0.0, 0.0],
      [0.038, 0.0],
      [0.042, 0.008],
      [0.043, 0.02],
      [0.0415, POUR],
      [0.0, POUR],
    ],
    10,
  );
  const tumblerGeo = lathe(
    [
      [0.0415, POUR],
      [0.041, 0.06],
      [0.04, 0.082],
      [0.036, 0.082],
      [0.037, 0.055],
      [0.0365, POUR],
      [0.0415, POUR],
    ],
    10,
  );
  const cubeGeo = new THREE.BoxGeometry(0.019, 0.019, 0.019);
  store.geometries.push(cubeGeo);

  for (const [x, z, rot, cubes] of [
    [0.1, -0.055, 0.4, 2],
    [0.115, 0.06, -0.7, 1],
  ] as [number, number, number, number][]) {
    const g = new THREE.Group();
    g.position.set(x, 0.016, z);
    g.rotation.y = rot;
    root.add(g);
    mesh(g, tumblerGeo, crystal);
    mesh(g, drinkGeo, whisky);
    for (let i = 0; i < cubes; i++) {
      const cube = mesh(g, cubeGeo, ice, [
        (i - (cubes - 1) / 2) * 0.018,
        0.05 + i * 0.014,
        i * 0.004,
      ], [0.4 + i, 0.7 * i, 0.2]);
      cube.castShadow = false;
    }
  }

  return {
    root,
    size: new THREE.Vector3(0.46, 0.32, 0.34),
    hinges: [],
    lights: [],
    dispose: disposer(store),
  };
}
