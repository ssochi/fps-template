import * as THREE from 'three';
import { createCanvasTexture } from './Materials';

/**
 * Procedural vehicle models: a hypercar, a 4x4 and a main battle tank.
 *
 * Every vehicle is built from primitives at runtime — no external assets — and
 * returned as a plain `THREE.Group` with its origin on the ground, centred, and
 * its nose pointing **+Z**. That matches the convention used by the targets and
 * weapon models, so a caller only ever has to set `position` and `rotation.y`.
 *
 * The bodies are lofted rather than boxed: `loft()` skins a list of rectangular
 * cross-sections, which is what lets a wedge-shaped hypercar nose, a sloped
 * tank glacis and a boxy jeep tub all come out of the same 60 lines.
 *
 * Nothing here animates, so callers are expected to merge the result — see
 * `mergeStaticHierarchy` — collapsing a few hundred primitives per vehicle into
 * one draw call per material.
 */

export type VehicleId = 'supercar' | 'jeep' | 'tank';

export interface VehicleBuildResult {
  root: THREE.Group;
  /** Local-space collision boxes, `{ centre, size }`, for the caller to place. */
  colliders: { centre: THREE.Vector3; size: THREE.Vector3 }[];
  /** Overall bounds, handy for signage and camera framing. */
  size: THREE.Vector3;
}

export interface VehicleDescriptor {
  id: VehicleId;
  name: string;
  subtitle: string;
}

export const VEHICLES: readonly VehicleDescriptor[] = [
  { id: 'supercar', name: 'MERIDIAN GT-9', subtitle: 'HYPERCAR · 1040 HP' },
  { id: 'jeep', name: 'FIELD ROVER 4X4', subtitle: 'UTILITY · ALL-TERRAIN' },
  { id: 'tank', name: 'M-77 WARDEN', subtitle: 'MAIN BATTLE TANK · 120 MM' },
];

// --------------------------------------------------------------- primitives

interface Section {
  /** Position along the vehicle's long axis. */
  z: number;
  halfWidth: number;
  bottom: number;
  top: number;
}

/**
 * Skins a run of rectangular cross-sections into a closed hull.
 *
 * Triangles are emitted un-indexed so `computeVertexNormals` gives flat,
 * per-facet shading — which is exactly the faceted panel look the rest of the
 * template is built in, and it keeps every hull a single cheap geometry.
 */
function loft(sections: Section[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];

  const corners = (s: Section): THREE.Vector3[] => [
    new THREE.Vector3(-s.halfWidth, s.bottom, s.z),
    new THREE.Vector3(s.halfWidth, s.bottom, s.z),
    new THREE.Vector3(s.halfWidth, s.top, s.z),
    new THREE.Vector3(-s.halfWidth, s.top, s.z),
  ];

  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void => {
    for (const v of [a, b, c, a, c, d]) positions.push(v.x, v.y, v.z);
    // Cheap planar UVs — good enough for the noise-based materials in use.
    for (const [u, w] of [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
      [1, 1],
      [0, 1],
    ]) {
      uvs.push(u, w);
    }
  };

  // Each side walks its own cross-section first, *then* steps to the next one.
  // Going around the ring first (a[n] -> b[n] -> b[n+1]) is the obvious
  // ordering and is wrong: it winds every side inward, so back-face culling
  // removes the surfaces facing the viewer and you see straight through the
  // hull to the inside of its far wall. The end caps below are unaffected,
  // which is what makes it easy to miss.
  for (let i = 0; i < sections.length - 1; i++) {
    const a = corners(sections[i]);
    const b = corners(sections[i + 1]);
    quad(a[0], a[1], b[1], b[0]); // bottom
    quad(a[1], a[2], b[2], b[1]); // right
    quad(a[2], a[3], b[3], b[2]); // top
    quad(a[3], a[0], b[0], b[3]); // left
  }

  // End caps, wound outward.
  const first = corners(sections[0]);
  quad(first[0], first[3], first[2], first[1]);
  const last = corners(sections[sections.length - 1]);
  quad(last[0], last[1], last[2], last[3]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/** A swept tube through a set of points — roll cages, tow cables, bull bars. */
function tube(points: [number, number, number][], radius: number, segments = 8): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  return new THREE.TubeGeometry(curve, Math.max(8, points.length * segments), radius, 7, false);
}

function mesh(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.position.set(position[0], position[1], position[2]);
  m.rotation.set(rotation[0], rotation[1], rotation[2]);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** Adds `build` twice, mirrored across the centreline. */
function bothSides(build: (side: 1 | -1) => void): void {
  build(1);
  build(-1);
}

/** A cylinder lying on the X axis — the orientation every wheel and axle wants. */
function axle(radiusTop: number, radiusBottom: number, length: number, segments = 20): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, segments);
  geo.rotateZ(Math.PI / 2);
  return geo;
}

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

function carbonTexture(): THREE.Texture {
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

// ------------------------------------------------------------------- wheels

interface WheelOptions {
  radius: number;
  width: number;
  /** Rim treatment. */
  style: 'spoke' | 'steel';
  spokes?: number;
  rim: THREE.Material;
  tyre: THREE.Material;
  hub: THREE.Material;
  /** Chunky off-road tread blocks around the circumference. */
  tread?: { count: number; depth: number };
  /** Cross-drilled disc and caliper behind the spokes. */
  brakes?: { disc: THREE.Material; caliper: THREE.Material };
}

/** A wheel centred on the origin, rotating about X. */
function buildWheel(o: WheelOptions): THREE.Group {
  const g = new THREE.Group();
  const r = o.radius;

  // Carcass, then a slightly proud shoulder each side so the tyre reads as
  // having a sidewall rather than being a plain cylinder.
  mesh(g, axle(r, r, o.width, 24), o.tyre);
  for (const s of [-1, 1]) {
    mesh(g, axle(r * 0.99, r * 0.93, o.width * 0.08, 24), o.tyre, [(s * o.width) / 2, 0, 0]);
  }

  if (o.tread) {
    const block = new THREE.BoxGeometry(o.width * 0.34, o.tread.depth, r * 0.42);
    for (let i = 0; i < o.tread.count; i++) {
      const a = (i / o.tread.count) * Math.PI * 2;
      for (const row of [-1, 0, 1]) {
        // Stagger alternate rows so the tread reads as a directional pattern
        // rather than three identical rings.
        const angle = a + ((row + 1) % 2) * (Math.PI / o.tread.count);
        const reach = r + o.tread.depth * 0.35;
        mesh(
          g,
          block,
          o.tyre,
          [row * o.width * 0.3, Math.sin(angle) * reach, Math.cos(angle) * reach],
          // Point the block's thin axis radially outward.
          [Math.PI / 2 - angle, 0, 0],
        );
      }
    }
  }

  // Rim barrel and face.
  mesh(g, axle(r * 0.62, r * 0.62, o.width * 0.92, 24), o.rim);
  for (const s of [-1, 1]) {
    mesh(g, axle(r * 0.66, r * 0.66, o.width * 0.06, 24), o.rim, [(s * o.width) / 2.2, 0, 0]);
  }

  const face = o.width / 2 - o.width * 0.12;
  if (o.style === 'spoke') {
    const count = o.spokes ?? 5;
    const spoke = new THREE.BoxGeometry(o.width * 0.14, r * 0.62, o.width * 0.2);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      // Twin-spoke: a narrow V per arm reads as a race wheel from any angle.
      for (const twist of [-0.11, 0.11]) {
        const m = mesh(g, spoke, o.rim, [face * 0.55, 0, 0]);
        m.rotation.x = a + twist;
        m.position.y = Math.sin(a + twist) * r * 0.36;
        m.position.z = Math.cos(a + twist) * r * 0.36;
      }
    }
    // Lug nuts around the hub.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      mesh(
        g,
        axle(r * 0.035, r * 0.035, o.width * 0.1, 6),
        o.hub,
        [face, Math.sin(a) * r * 0.13, Math.cos(a) * r * 0.13],
      );
    }
  } else {
    // Pressed-steel wheel: solid dish with lightening holes.
    mesh(g, axle(r * 0.6, r * 0.6, o.width * 0.06, 22), o.rim, [face * 0.4, 0, 0]);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      mesh(
        g,
        axle(r * 0.11, r * 0.11, o.width * 0.14, 12),
        o.hub,
        [face * 0.4, Math.sin(a) * r * 0.34, Math.cos(a) * r * 0.34],
      );
    }
  }

  mesh(g, axle(r * 0.2, r * 0.2, o.width * 0.36, 16), o.hub, [face * 0.7, 0, 0]);
  mesh(g, axle(r * 0.09, r * 0.09, o.width * 0.5, 10), o.hub, [face * 0.85, 0, 0]);

  if (o.brakes) {
    mesh(g, axle(r * 0.56, r * 0.56, o.width * 0.09, 26), o.brakes.disc);
    // Caliper straddling the disc at 10 o'clock.
    const cal = mesh(
      g,
      new THREE.BoxGeometry(o.width * 0.22, r * 0.46, r * 0.2),
      o.brakes.caliper,
      [0, r * 0.42, -r * 0.16],
    );
    cal.rotation.x = 0.5;
  }

  return g;
}

// ---------------------------------------------------------------- supercar

function buildSupercar(): VehicleBuildResult {
  const m = createVehicleMaterials();
  const root = new THREE.Group();
  root.name = 'supercar';

  const WHEEL_R = 0.36;
  const WHEEL_W = 0.34;
  const REAR_W = 0.42;
  const TRACK = 0.86;
  const AXLE_F = 1.35;
  const AXLE_R = -1.42;

  // --- lower body ---------------------------------------------------------
  // A mid-engined wedge: widest over the rear haunches, dropping to a shovel
  // nose. The greenhouse is a separate loft so it can be glass.
  const body = loft([
    { z: -2.28, halfWidth: 0.9, bottom: 0.3, top: 0.78 },
    { z: -1.86, halfWidth: 1.0, bottom: 0.19, top: 0.86 },
    { z: -1.05, halfWidth: 1.03, bottom: 0.15, top: 0.88 },
    { z: -0.15, halfWidth: 0.99, bottom: 0.13, top: 0.85 },
    { z: 0.72, halfWidth: 0.95, bottom: 0.13, top: 0.8 },
    { z: 1.5, halfWidth: 0.88, bottom: 0.15, top: 0.68 },
    { z: 2.06, halfWidth: 0.76, bottom: 0.19, top: 0.56 },
    { z: 2.38, halfWidth: 0.54, bottom: 0.26, top: 0.48 },
  ]);
  mesh(root, body, m.carPaint);

  const glass = loft([
    { z: -1.32, halfWidth: 0.6, bottom: 0.86, top: 1.02 },
    { z: -0.78, halfWidth: 0.67, bottom: 0.85, top: 1.17 },
    { z: 0.04, halfWidth: 0.65, bottom: 0.84, top: 1.2 },
    { z: 0.76, halfWidth: 0.57, bottom: 0.81, top: 1.04 },
    { z: 1.3, halfWidth: 0.45, bottom: 0.79, top: 0.86 },
  ]);
  mesh(root, glass, m.carGlass);

  // Roof spine and A-pillars in body colour so the canopy is not one glass blob.
  mesh(root, new THREE.BoxGeometry(0.18, 0.06, 1.6), m.carPaintDark, [0, 1.19, -0.2]);
  bothSides((s) => {
    const pillar = mesh(root, new THREE.BoxGeometry(0.08, 0.06, 0.9), m.carPaintDark, [s * 0.56, 1.02, 0.5]);
    pillar.rotation.x = -0.5;
    const rear = mesh(root, new THREE.BoxGeometry(0.09, 0.06, 0.7), m.carPaintDark, [s * 0.6, 1.02, -1.0]);
    rear.rotation.x = 0.55;
  });

  // --- floor, splitter, diffuser -----------------------------------------
  mesh(root, new THREE.BoxGeometry(1.86, 0.05, 4.3), m.carbon, [0, 0.11, -0.1]);
  mesh(root, new THREE.BoxGeometry(2.0, 0.05, 0.62), m.carbon, [0, 0.115, 2.36]);
  bothSides((s) => {
    // Dive planes on the front corners.
    const plane = mesh(root, new THREE.BoxGeometry(0.34, 0.03, 0.2), m.carbon, [s * 0.86, 0.34, 2.2]);
    plane.rotation.z = s * -0.18;
    plane.rotation.x = 0.12;
    // Side skirts.
    mesh(root, new THREE.BoxGeometry(0.1, 0.1, 2.4), m.carbon, [s * 0.99, 0.16, 0.1]);
  });

  const diffuser = mesh(root, new THREE.BoxGeometry(1.74, 0.34, 0.72), m.carbon, [0, 0.24, -2.06]);
  diffuser.rotation.x = -0.42;
  for (let i = -2; i <= 2; i++) {
    mesh(root, new THREE.BoxGeometry(0.04, 0.3, 0.68), m.carbon, [i * 0.34, 0.26, -2.06]);
  }

  // --- front end ----------------------------------------------------------
  // Recessed intakes either side of the nose, plus the central radiator duct.
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.44, 0.2, 0.14), m.carPaintDark, [s * 0.62, 0.3, 2.34]);
    // Swept headlight cluster.
    const lamp = mesh(root, new THREE.BoxGeometry(0.38, 0.09, 0.1), m.headLight, [s * 0.62, 0.56, 2.28]);
    lamp.rotation.z = s * 0.16;
    // Daytime running strip curling down the corner.
    const drl = mesh(root, new THREE.BoxGeometry(0.05, 0.22, 0.06), m.headLight, [s * 0.79, 0.47, 2.24]);
    drl.rotation.z = s * 0.3;
  });
  mesh(root, new THREE.BoxGeometry(0.8, 0.16, 0.12), m.carPaintDark, [0, 0.32, 2.4]);
  // Bonnet vents.
  for (let i = 0; i < 3; i++) {
    mesh(root, new THREE.BoxGeometry(0.5, 0.02, 0.07), m.carbon, [0, 0.61 - i * 0.006, 1.5 + i * 0.13]);
  }
  mesh(root, new THREE.CylinderGeometry(0.07, 0.07, 0.02, 14), m.chrome, [-0.72, 0.79, 0.1]);

  // --- sides --------------------------------------------------------------
  bothSides((s) => {
    // Door livery panel, inset a touch so it never z-fights the body.
    const decal = mesh(root, new THREE.PlaneGeometry(1.1, 0.42), m.livery, [s * 1.005, 0.53, 0.35]);
    decal.rotation.y = s * (Math.PI / 2);
    // Intake scoop feeding the mid-mounted engine.
    const scoop = mesh(root, new THREE.BoxGeometry(0.1, 0.3, 0.66), m.carPaintDark, [s * 1.0, 0.52, -0.7]);
    scoop.rotation.y = s * 0.12;
    mesh(root, new THREE.BoxGeometry(0.06, 0.22, 0.5), m.carbon, [s * 1.02, 0.52, -0.72]);
    // Mirror on a slim stalk.
    mesh(root, new THREE.CylinderGeometry(0.018, 0.018, 0.2, 8), m.carbon, [s * 0.86, 0.9, 0.86], [0, 0, s * 0.9]);
    mesh(root, new THREE.BoxGeometry(0.06, 0.09, 0.16), m.carPaintDark, [s * 0.98, 0.95, 0.86]);
    // Wheel arch lips.
    for (const z of [AXLE_F, AXLE_R]) {
      const arch = mesh(
        root,
        new THREE.TorusGeometry(WHEEL_R + 0.08, 0.035, 8, 14, Math.PI),
        m.carPaintDark,
        [s * (TRACK + (z > 0 ? WHEEL_W : REAR_W) * 0.5), WHEEL_R + 0.02, z],
      );
      arch.rotation.y = Math.PI / 2;
    }
  });

  // --- rear ---------------------------------------------------------------
  // Exposed engine bay under a slatted cover.
  mesh(root, new THREE.BoxGeometry(0.9, 0.3, 0.8), m.carPaintDark, [0, 0.66, -1.2]);
  mesh(root, new THREE.BoxGeometry(0.62, 0.16, 0.5), m.engineRed, [0, 0.84, -1.2]);
  bothSides((s) => {
    mesh(root, new THREE.CylinderGeometry(0.05, 0.05, 0.34, 10), m.chrome, [s * 0.2, 0.93, -1.2], [Math.PI / 2, 0, 0]);
  });
  for (let i = 0; i < 5; i++) {
    mesh(root, new THREE.BoxGeometry(0.86, 0.015, 0.1), m.carbon, [0, 0.9 - i * 0.005, -0.95 - i * 0.13]);
  }

  // Taillights: a full-width bar plus corner blocks.
  mesh(root, new THREE.BoxGeometry(1.5, 0.05, 0.05), m.tailLight, [0, 0.66, -2.29]);
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.24, 0.12, 0.06), m.tailLight, [s * 0.66, 0.55, -2.29]);
  });
  mesh(root, new THREE.BoxGeometry(1.3, 0.26, 0.08), m.carbon, [0, 0.4, -2.3]);

  // Quad exhausts stacked in the centre of the diffuser.
  for (const x of [-0.3, -0.1, 0.1, 0.3]) {
    mesh(root, new THREE.CylinderGeometry(0.06, 0.07, 0.16, 12), m.chrome, [x, 0.46, -2.3], [Math.PI / 2, 0, 0]);
  }

  // Swan-neck rear wing.
  bothSides((s) => {
    const neck = mesh(root, new THREE.BoxGeometry(0.06, 0.34, 0.12), m.carbon, [s * 0.5, 0.94, -1.95]);
    neck.rotation.x = -0.2;
    mesh(root, new THREE.BoxGeometry(0.03, 0.3, 0.62), m.carbon, [s * 0.82, 1.16, -2.0]);
  });
  const wing = mesh(root, new THREE.BoxGeometry(1.66, 0.045, 0.4), m.carbon, [0, 1.16, -2.0]);
  wing.rotation.x = -0.22;
  mesh(root, new THREE.BoxGeometry(1.66, 0.03, 0.14), m.carbon, [0, 1.06, -1.83]);

  // --- wheels -------------------------------------------------------------
  bothSides((s) => {
    const front = buildWheel({
      radius: WHEEL_R,
      width: WHEEL_W,
      style: 'spoke',
      spokes: 5,
      rim: m.rimGold,
      tyre: m.rubber,
      hub: m.chrome,
      brakes: { disc: m.brakeDisc, caliper: m.caliper },
    });
    front.position.set(s * TRACK, WHEEL_R, AXLE_F);
    if (s < 0) front.rotation.y = Math.PI;
    root.add(front);

    const rear = buildWheel({
      radius: WHEEL_R + 0.04,
      width: REAR_W,
      style: 'spoke',
      spokes: 5,
      rim: m.rimGold,
      tyre: m.rubber,
      hub: m.chrome,
      brakes: { disc: m.brakeDisc, caliper: m.caliper },
    });
    rear.position.set(s * TRACK, WHEEL_R + 0.04, AXLE_R);
    if (s < 0) rear.rotation.y = Math.PI;
    root.add(rear);
  });

  // --- cockpit ------------------------------------------------------------
  // The body is a closed shell, so anything below its beltline (~0.85) is
  // sealed in. The interior therefore sits just proud of it, inside the glass
  // canopy, where it actually reads through the screen.
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.42, 0.1, 0.5), m.interior, [s * 0.34, 0.91, 0.05]);
    const back = mesh(root, new THREE.BoxGeometry(0.4, 0.42, 0.09), m.interior, [s * 0.34, 1.05, -0.22]);
    back.rotation.x = -0.18;
    mesh(root, new THREE.BoxGeometry(0.34, 0.12, 0.1), m.interior, [s * 0.34, 1.19, -0.3]);
  });
  mesh(root, new THREE.BoxGeometry(1.1, 0.12, 0.3), m.interior, [0, 0.95, 0.62]);
  const wheelRim = mesh(root, new THREE.TorusGeometry(0.13, 0.022, 6, 14), m.interior, [0.34, 1.0, 0.5]);
  wheelRim.rotation.x = 1.2;
  // Centre console bridging the two seats.
  mesh(root, new THREE.BoxGeometry(0.24, 0.1, 0.8), m.carbon, [0, 0.9, 0.1]);

  return {
    root,
    colliders: [
      { centre: new THREE.Vector3(0, 0.6, 0), size: new THREE.Vector3(2.05, 1.2, 4.7) },
    ],
    size: new THREE.Vector3(2.05, 1.35, 4.8),
  };
}

// -------------------------------------------------------------------- jeep

function buildJeep(): VehicleBuildResult {
  const m = createVehicleMaterials();
  const root = new THREE.Group();
  root.name = 'jeep';

  const WHEEL_R = 0.46;
  const WHEEL_W = 0.34;
  const TRACK = 0.84;
  const AXLE_F = 1.32;
  const AXLE_R = -1.32;
  const FLOOR = 0.72;

  // --- chassis and running gear ------------------------------------------
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.12, 0.14, 3.9), m.jeepDark, [s * 0.42, 0.56, -0.05]);
    // Leaf springs and dampers, visible because there are no valances.
    for (const z of [AXLE_F, AXLE_R]) {
      mesh(root, new THREE.BoxGeometry(0.09, 0.05, 0.9), m.jeepDark, [s * 0.5, 0.5, z]);
      const shock = mesh(root, new THREE.CylinderGeometry(0.045, 0.045, 0.36, 10), m.jeepDark, [s * 0.62, 0.66, z]);
      shock.rotation.x = 0.18;
    }
  });
  for (const z of [AXLE_F, AXLE_R]) {
    mesh(root, axle(0.07, 0.07, TRACK * 2, 14), m.jeepDark, [0, WHEEL_R, z]);
    mesh(root, new THREE.SphereGeometry(0.17, 14, 10), m.jeepDark, [0.06, WHEEL_R, z]);
  }
  // Prop shaft and transfer case.
  mesh(root, new THREE.CylinderGeometry(0.05, 0.05, 2.4, 10), m.jeepDark, [0.06, 0.52, 0], [Math.PI / 2, 0, 0]);
  mesh(root, new THREE.BoxGeometry(0.34, 0.3, 0.5), m.jeepDark, [0, 0.6, 0.3]);

  // --- body tub -----------------------------------------------------------
  // The tub is a *solid* body whose top surface is the cockpit floor, with the
  // sides added back as separate panels above it. A single loft up to the
  // beltline would be a closed box with the seats sealed inside — the hull has
  // to actually be open, not merely appear open because its roof was culled.
  const CABIN_FLOOR = 1.0;
  const tub = loft([
    { z: -2.1, halfWidth: 0.86, bottom: FLOOR, top: CABIN_FLOOR },
    { z: -1.5, halfWidth: 0.9, bottom: FLOOR, top: CABIN_FLOOR },
    { z: 0.55, halfWidth: 0.9, bottom: FLOOR, top: CABIN_FLOOR },
    { z: 0.62, halfWidth: 0.88, bottom: FLOOR, top: 1.18 },
    { z: 1.72, halfWidth: 0.86, bottom: FLOOR + 0.04, top: 1.16 },
    { z: 1.95, halfWidth: 0.8, bottom: FLOOR + 0.08, top: 1.1 },
  ]);
  mesh(root, tub, m.jeepBody);
  // Cockpit sides, rear panel and dash bulkhead, all solid.
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.1, 0.38, 2.65), m.jeepBody, [s * 0.85, 1.19, -0.775]);
  });
  mesh(root, new THREE.BoxGeometry(1.8, 0.38, 0.1), m.jeepBody, [0, 1.19, -2.06]);
  mesh(root, new THREE.BoxGeometry(1.78, 0.38, 0.1), m.jeepBody, [0, 1.19, 0.58]);
  // Rubber-matted floor pan laid over the tub deck.
  mesh(root, new THREE.BoxGeometry(1.62, 0.04, 2.5), m.jeepDark, [0, CABIN_FLOOR + 0.02, -0.775]);

  // Bonnet with a centre hinge line and two latches.
  mesh(root, new THREE.BoxGeometry(1.7, 0.05, 1.06), m.jeepBody, [0, 1.19, 1.14]);
  mesh(root, new THREE.BoxGeometry(0.05, 0.03, 1.04), m.jeepDark, [0, 1.22, 1.14]);
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.1, 0.06, 0.05), m.chrome, [s * 0.7, 1.16, 0.64]);
    // Bonnet louvres.
    for (let i = 0; i < 4; i++) {
      mesh(root, new THREE.BoxGeometry(0.3, 0.02, 0.05), m.jeepDark, [s * 0.5, 1.22, 1.4 + i * 0.11]);
    }
  });
  mesh(root, new THREE.PlaneGeometry(0.44, 0.44), m.star, [0, 1.222, 1.05], [-Math.PI / 2, 0, 0]);

  // --- grille and front ---------------------------------------------------
  mesh(root, new THREE.BoxGeometry(1.62, 0.5, 0.08), m.jeepBody, [0, 0.95, 1.97]);
  for (let i = 0; i < 7; i++) {
    const x = (i - 3) * 0.17;
    mesh(root, new THREE.BoxGeometry(0.09, 0.4, 0.06), m.jeepDark, [x, 0.95, 2.0]);
  }
  bothSides((s) => {
    // Round headlamps in chrome bezels, flanking the grille.
    mesh(root, new THREE.CylinderGeometry(0.16, 0.16, 0.1, 16), m.jeepBody, [s * 0.62, 0.98, 1.96], [Math.PI / 2, 0, 0]);
    mesh(root, new THREE.CylinderGeometry(0.13, 0.13, 0.04, 16), m.headLight, [s * 0.62, 0.98, 2.02], [Math.PI / 2, 0, 0]);
    mesh(root, new THREE.TorusGeometry(0.15, 0.016, 6, 16), m.chrome, [s * 0.62, 0.98, 2.02], [0, 0, 0]);
    // Indicators.
    mesh(root, new THREE.CylinderGeometry(0.05, 0.05, 0.04, 10), m.amber, [s * 0.8, 1.16, 2.0], [Math.PI / 2, 0, 0]);
  });

  // Bull bar with an integrated winch.
  mesh(root, tube(
    [
      [-0.86, 0.5, 2.16],
      [-0.86, 1.12, 2.24],
      [0, 1.2, 2.26],
      [0.86, 1.12, 2.24],
      [0.86, 0.5, 2.16],
    ],
    0.04,
  ), m.jeepDark);
  mesh(root, new THREE.BoxGeometry(1.74, 0.09, 0.09), m.jeepDark, [0, 0.86, 2.22]);
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.08, 0.5, 0.09), m.jeepDark, [s * 0.5, 0.85, 2.16]);
  });
  mesh(root, axle(0.11, 0.11, 0.5, 14), m.chrome, [0, 0.78, 1.92]);
  mesh(root, new THREE.BoxGeometry(0.62, 0.24, 0.2), m.jeepDark, [0, 0.78, 1.86]);
  mesh(root, new THREE.BoxGeometry(0.16, 0.12, 0.06), m.chrome, [0, 0.78, 2.2]);

  // --- windscreen and cage ------------------------------------------------
  const screenFrame = mesh(root, new THREE.BoxGeometry(1.7, 0.62, 0.06), m.jeepBody, [0, 1.6, 0.62]);
  screenFrame.rotation.x = -0.16;
  const screenGlass = mesh(root, new THREE.PlaneGeometry(1.56, 0.5), m.jeepGlass, [0, 1.6, 0.66]);
  screenGlass.rotation.x = -0.16;
  bothSides((s) => {
    // Wiper.
    const wiper = mesh(root, new THREE.BoxGeometry(0.03, 0.03, 0.42), m.jeepDark, [s * 0.4, 1.36, 0.7]);
    wiper.rotation.set(-0.16, 0, s * 0.5);
  });

  // Roll cage: A-pillars up from the screen, a main hoop, side and rear stays.
  bothSides((s) => {
    mesh(root, tube(
      [
        [s * 0.8, 1.34, 0.66],
        [s * 0.82, 1.9, 0.6],
        [s * 0.84, 2.02, 0.2],
        [s * 0.84, 2.02, -1.0],
        [s * 0.84, 1.5, -1.9],
        [s * 0.84, 0.9, -2.02],
      ],
      0.045,
    ), m.jeepDark);
    mesh(root, tube(
      [
        [s * 0.84, 2.02, -0.4],
        [s * 0.84, 1.4, -0.42],
        [s * 0.84, 1.34, -0.44],
      ],
      0.04,
    ), m.jeepDark);
  });
  mesh(root, tube([[-0.84, 2.02, -0.4], [0, 2.06, -0.4], [0.84, 2.02, -0.4]], 0.045), m.jeepDark);
  mesh(root, tube([[-0.84, 2.02, 0.2], [0, 2.05, 0.2], [0.84, 2.02, 0.2]], 0.045), m.jeepDark);
  mesh(root, tube([[-0.84, 2.02, -1.0], [0, 2.05, -1.0], [0.84, 2.02, -1.0]], 0.045), m.jeepDark);
  // Diagonal brace across the main hoop.
  mesh(root, tube([[-0.8, 1.4, -0.42], [0.8, 1.98, -0.4]], 0.035), m.jeepDark);

  // Canvas roof panel stretched over the front bay.
  const canopy = mesh(root, new THREE.BoxGeometry(1.68, 0.03, 1.24), m.canvasTop, [0, 2.03, -0.4]);
  canopy.rotation.x = 0.02;

  // Light bar on the front of the cage.
  mesh(root, new THREE.BoxGeometry(1.2, 0.06, 0.06), m.jeepDark, [0, 1.98, 0.56]);
  for (const x of [-0.45, -0.15, 0.15, 0.45]) {
    mesh(root, new THREE.CylinderGeometry(0.09, 0.09, 0.12, 14), m.jeepDark, [x, 2.06, 0.56], [Math.PI / 2, 0, 0]);
    mesh(root, new THREE.CylinderGeometry(0.07, 0.07, 0.03, 14), m.headLight, [x, 2.06, 0.62], [Math.PI / 2, 0, 0]);
  }

  // --- snorkel, exhaust, aerial -------------------------------------------
  mesh(root, tube(
    [
      [0.84, 1.0, 1.5],
      [0.9, 1.5, 1.46],
      [0.9, 2.1, 1.44],
      [0.9, 2.24, 1.3],
    ],
    0.055,
  ), m.jeepDark);
  mesh(root, new THREE.CylinderGeometry(0.075, 0.09, 0.22, 12), m.jeepDark, [0.9, 2.3, 1.22], [1.2, 0, 0]);
  mesh(root, tube(
    [
      [-0.5, 0.5, 1.2],
      [-0.7, 0.44, 0.2],
      [-0.86, 0.5, -1.4],
      [-0.86, 0.62, -2.05],
    ],
    0.045,
  ), m.jeepDark);
  mesh(root, new THREE.CylinderGeometry(0.06, 0.05, 0.14, 10), m.chrome, [-0.86, 0.62, -2.12], [Math.PI / 2, 0, 0]);
  mesh(root, new THREE.CylinderGeometry(0.012, 0.006, 1.5, 6), m.jeepDark, [-0.86, 1.9, -1.6], [0.08, 0, 0.05]);

  // --- interior -----------------------------------------------------------
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.5, 0.12, 0.5), m.interior, [s * 0.42, 1.06, -0.1]);
    const back = mesh(root, new THREE.BoxGeometry(0.5, 0.62, 0.1), m.interior, [s * 0.42, 1.38, -0.36]);
    back.rotation.x = -0.16;
    mesh(root, new THREE.BoxGeometry(0.42, 0.16, 0.12), m.interior, [s * 0.42, 1.7, -0.4]);
  });
  // Rear bench.
  mesh(root, new THREE.BoxGeometry(1.5, 0.12, 0.44), m.interior, [0, 1.04, -1.3]);
  mesh(root, new THREE.BoxGeometry(1.5, 0.44, 0.1), m.interior, [0, 1.26, -1.54]);
  // Dash, instruments, wheel, levers.
  mesh(root, new THREE.BoxGeometry(1.62, 0.28, 0.26), m.jeepDark, [0, 1.28, 0.5]);
  for (const x of [0.3, 0.52]) {
    mesh(root, new THREE.CylinderGeometry(0.07, 0.07, 0.04, 14), m.interior, [x, 1.32, 0.36], [Math.PI / 2, 0, 0]);
  }
  const steer = mesh(root, new THREE.TorusGeometry(0.17, 0.022, 6, 16), m.interior, [0.42, 1.36, 0.14]);
  steer.rotation.x = 1.15;
  mesh(root, new THREE.CylinderGeometry(0.03, 0.03, 0.34, 8), m.jeepDark, [0.42, 1.28, 0.28], [1.15, 0, 0]);
  mesh(root, new THREE.CylinderGeometry(0.02, 0.02, 0.3, 6), m.jeepDark, [0.06, 1.15, 0.0], [0.2, 0, 0.1]);
  mesh(root, new THREE.SphereGeometry(0.035, 8, 6), m.interior, [0.08, 1.31, 0.03]);

  // --- rear kit -----------------------------------------------------------
  // Spare wheel on a swing-out carrier.
  const spare = buildWheel({
    radius: WHEEL_R,
    width: WHEEL_W,
    style: 'steel',
    rim: m.jeepBody,
    tyre: m.rubber,
    hub: m.jeepDark,
    tread: { count: 16, depth: 0.05 },
  });
  spare.position.set(0.1, 1.24, -2.3);
  spare.rotation.z = Math.PI / 2;
  spare.rotation.y = Math.PI / 2;
  root.add(spare);
  mesh(root, new THREE.BoxGeometry(0.1, 0.9, 0.1), m.jeepDark, [-0.62, 1.2, -2.14]);
  mesh(root, new THREE.BoxGeometry(0.9, 0.1, 0.1), m.jeepDark, [-0.2, 1.24, -2.2]);

  // Jerry cans and stowage on the rear quarters.
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.18, 0.46, 0.34), m.jeepDark, [s * 0.74, 1.5, -1.7]);
    mesh(root, new THREE.BoxGeometry(0.04, 0.1, 0.08), m.chrome, [s * 0.84, 1.7, -1.7]);
    // Rock sliders.
    mesh(root, new THREE.BoxGeometry(0.1, 0.1, 1.5), m.jeepDark, [s * 0.94, 0.7, -0.1]);
    // Fender flares over each arch.
    for (const z of [AXLE_F, AXLE_R]) {
      const flare = mesh(root, new THREE.BoxGeometry(0.24, 0.06, 1.0), m.jeepDark, [s * 0.92, 1.14, z]);
      flare.rotation.z = s * 0.16;
    }
  });
  // Shovel and axe strapped along the left flank.
  mesh(root, new THREE.CylinderGeometry(0.022, 0.022, 0.9, 8), m.jeepDark, [-0.92, 1.3, 0.1], [0, 0, 0.1]);
  mesh(root, new THREE.BoxGeometry(0.03, 0.2, 0.14), m.chrome, [-0.92, 0.86, 0.14]);
  mesh(root, new THREE.CylinderGeometry(0.02, 0.02, 0.7, 8), m.jeepDark, [-0.92, 1.42, -0.5], [0, 0, 0.1]);
  mesh(root, new THREE.BoxGeometry(0.03, 0.16, 0.1), m.chrome, [-0.92, 1.75, -0.5]);
  // Tow hitch and recovery eyes.
  mesh(root, new THREE.BoxGeometry(0.24, 0.12, 0.24), m.jeepDark, [0, 0.66, -2.16]);
  mesh(root, new THREE.SphereGeometry(0.05, 10, 8), m.chrome, [0, 0.76, -2.24]);
  bothSides((s) => {
    const eye = mesh(root, new THREE.TorusGeometry(0.06, 0.02, 6, 12), m.chrome, [s * 0.6, 0.72, 2.16]);
    eye.rotation.y = Math.PI / 2;
  });
  // Number plate.
  mesh(root, new THREE.BoxGeometry(0.42, 0.14, 0.02), m.chrome, [-0.3, 0.78, -2.2]);

  // --- wheels -------------------------------------------------------------
  bothSides((s) => {
    for (const z of [AXLE_F, AXLE_R]) {
      const wheel = buildWheel({
        radius: WHEEL_R,
        width: WHEEL_W,
        style: 'steel',
        rim: m.jeepBody,
        tyre: m.rubber,
        hub: m.jeepDark,
        tread: { count: 18, depth: 0.055 },
      });
      wheel.position.set(s * TRACK, WHEEL_R, z);
      if (s < 0) wheel.rotation.y = Math.PI;
      root.add(wheel);
    }
  });

  return {
    root,
    colliders: [
      { centre: new THREE.Vector3(0, 0.95, -0.05), size: new THREE.Vector3(1.95, 1.9, 4.3) },
    ],
    size: new THREE.Vector3(1.95, 2.4, 4.6),
  };
}

// -------------------------------------------------------------------- tank

function buildTank(): VehicleBuildResult {
  const m = createVehicleMaterials();
  const root = new THREE.Group();
  root.name = 'tank';

  const HALF_TRACK = 1.5; // centreline offset of each track
  const TRACK_W = 0.62;
  const ROAD_R = 0.46;
  const WHEEL_Y = 0.52;
  const HUB_Y = 0.78;
  const HUB_R = 0.62;
  const RUN_Z = 2.7;

  // --- hull ---------------------------------------------------------------
  // Sharply sloped glacis at the front, near-vertical plates aft.
  const hull = loft([
    { z: -3.4, halfWidth: 1.45, bottom: 0.62, top: 1.6 },
    { z: -2.6, halfWidth: 1.55, bottom: 0.58, top: 1.72 },
    { z: 0.4, halfWidth: 1.6, bottom: 0.55, top: 1.78 },
    { z: 1.5, halfWidth: 1.58, bottom: 0.55, top: 1.74 },
    { z: 2.5, halfWidth: 1.5, bottom: 0.6, top: 1.36 },
    { z: 3.5, halfWidth: 1.32, bottom: 0.72, top: 0.98 },
  ]);
  mesh(root, hull, m.tankHull);
  // Belly plate joining the sponsons.
  mesh(root, new THREE.BoxGeometry(HALF_TRACK * 2 + TRACK_W, 0.3, 6.4), m.tankDark, [0, 0.45, 0]);

  // Sponson overhangs above the tracks.
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.86, 0.22, 5.6), m.tankHull, [s * 1.72, 1.66, -0.4]);
    // Skirt armour: six hinged plates per side.
    for (let i = 0; i < 6; i++) {
      const z = 2.3 - i * 0.94;
      const plate = mesh(root, new THREE.BoxGeometry(0.09, 0.78, 0.88), m.tankHull, [s * 2.06, 1.12, z]);
      plate.rotation.z = s * 0.03;
    }
    // Mudguards fore and aft.
    mesh(root, new THREE.BoxGeometry(0.8, 0.06, 0.5), m.tankDark, [s * 1.7, 1.5, 3.06]);
    mesh(root, new THREE.BoxGeometry(0.8, 0.06, 0.5), m.tankDark, [s * 1.7, 1.5, -3.3]);
  });

  // Glacis detail: spare track links, driver's hatch, tow eyes, headlamps.
  for (let i = 0; i < 5; i++) {
    mesh(root, new THREE.BoxGeometry(0.44, 0.1, 0.16), m.track, [-0.9 + i * 0.45, 1.42, 2.62], [0.5, 0, 0]);
  }
  mesh(root, new THREE.CylinderGeometry(0.32, 0.32, 0.1, 18), m.tankHull, [-0.55, 1.77, 1.62]);
  mesh(root, new THREE.BoxGeometry(0.3, 0.1, 0.14), m.optic, [-0.55, 1.83, 1.9]);
  bothSides((s) => {
    mesh(root, new THREE.BoxGeometry(0.28, 0.24, 0.2), m.tankDark, [s * 1.15, 1.34, 2.86]);
    mesh(root, new THREE.CylinderGeometry(0.09, 0.09, 0.04, 14), m.headLight, [s * 1.15, 1.34, 2.97], [Math.PI / 2, 0, 0]);
    const eye = mesh(root, new THREE.TorusGeometry(0.1, 0.03, 6, 12), m.tankDark, [s * 0.8, 0.86, 3.4]);
    eye.rotation.y = Math.PI / 2;
  });
  // Tow cable draped along each flank, ends pinned to the hull.
  bothSides((s) => {
    mesh(root, tube(
      [
        [s * 1.66, 1.8, 2.6],
        [s * 1.74, 1.62, 1.2],
        [s * 1.74, 1.6, -0.6],
        [s * 1.7, 1.74, -2.4],
        [s * 1.62, 1.8, -3.2],
      ],
      0.045,
      4,
    ), m.tankDark);
  });

  // Engine deck: louvred intakes, exhaust grille, stowage.
  for (let i = 0; i < 7; i++) {
    mesh(root, new THREE.BoxGeometry(2.2, 0.05, 0.12), m.tankDark, [0, 1.8, -1.6 - i * 0.22], [0.35, 0, 0]);
  }
  mesh(root, new THREE.BoxGeometry(1.1, 0.16, 0.7), m.tankDark, [0.9, 1.82, -3.0]);
  mesh(root, new THREE.BoxGeometry(1.0, 0.1, 0.6), m.track, [0.9, 1.9, -3.0]);
  mesh(root, new THREE.BoxGeometry(0.9, 0.4, 0.5), m.tankDark, [-1.0, 1.9, -2.9]);
  // Rear-mounted fuel drums on a rack.
  bothSides((s) => {
    mesh(root, new THREE.CylinderGeometry(0.28, 0.28, 0.86, 16), m.tankDark, [s * 0.75, 1.16, -3.7], [0, 0, Math.PI / 2]);
  });
  mesh(root, new THREE.BoxGeometry(2.6, 0.08, 0.1), m.tankDark, [0, 0.82, -3.7]);

  // --- running gear -------------------------------------------------------
  bothSides((s) => {
    const x = s * HALF_TRACK;
    // Sprocket (rear) and idler (front).
    for (const [z, teeth] of [
      [-RUN_Z, true],
      [RUN_Z, false],
    ] as [number, boolean][]) {
      mesh(root, axle(HUB_R, HUB_R, TRACK_W * 0.5, 20), m.tankDark, [x, HUB_Y, z]);
      mesh(root, axle(HUB_R * 0.4, HUB_R * 0.4, TRACK_W * 0.8, 14), m.tankDark, [x, HUB_Y, z]);
      if (teeth) {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          mesh(
            root,
            new THREE.BoxGeometry(TRACK_W * 0.3, 0.16, 0.12),
            m.track,
            [x, HUB_Y + Math.sin(a) * HUB_R, z + Math.cos(a) * HUB_R],
            [-a, 0, 0],
          );
        }
      }
    }
    // Seven road wheels, each a doubled rubber-tyred disc.
    for (let i = 0; i < 7; i++) {
      const z = -2.16 + i * 0.72;
      mesh(root, axle(ROAD_R, ROAD_R, TRACK_W * 0.66, 18), m.tankDark, [x, WHEEL_Y, z]);
      for (const inner of [-1, 1]) {
        mesh(root, axle(ROAD_R * 0.98, ROAD_R * 0.98, TRACK_W * 0.16, 18), m.rubber, [
          x + inner * TRACK_W * 0.26,
          WHEEL_Y,
          z,
        ]);
      }
      mesh(root, axle(ROAD_R * 0.24, ROAD_R * 0.24, TRACK_W * 0.8, 12), m.tankDark, [x, WHEEL_Y, z]);
      // Torsion-bar swing arm.
      const arm = mesh(root, new THREE.BoxGeometry(0.14, 0.16, 0.44), m.tankDark, [
        s * (HALF_TRACK - TRACK_W * 0.5),
        WHEEL_Y + 0.14,
        z - 0.18,
      ]);
      arm.rotation.x = 0.4;
    }
    // Return rollers along the top run.
    for (const z of [-1.7, -0.2, 1.3]) {
      mesh(root, axle(0.19, 0.19, TRACK_W * 0.5, 12), m.tankDark, [x, 1.42, z]);
    }
  });

  // Track: a closed band of links following the running gear. Two straight
  // runs joined by half circles around the sprocket and idler.
  const BAND_R = HUB_R + 0.1;
  const TOP_Y = HUB_Y + BAND_R;
  const BOT_Y = 0.06;
  const path: { z: number; y: number; angle: number }[] = [];
  const PITCH = 0.26;
  const straight = RUN_Z * 2;
  const bottomSteps = Math.round(straight / PITCH);
  for (let i = 0; i < bottomSteps; i++) {
    path.push({ z: -RUN_Z + (i / bottomSteps) * straight, y: BOT_Y, angle: 0 });
  }
  const arcSteps = Math.round((Math.PI * BAND_R) / PITCH);
  for (let i = 0; i < arcSteps; i++) {
    const a = -Math.PI / 2 + (i / arcSteps) * Math.PI;
    path.push({
      z: RUN_Z + Math.cos(a) * BAND_R,
      y: HUB_Y + Math.sin(a) * BAND_R,
      angle: a + Math.PI / 2,
    });
  }
  for (let i = 0; i < bottomSteps; i++) {
    path.push({ z: RUN_Z - (i / bottomSteps) * straight, y: TOP_Y, angle: Math.PI });
  }
  for (let i = 0; i < arcSteps; i++) {
    const a = Math.PI / 2 + (i / arcSteps) * Math.PI;
    path.push({
      z: -RUN_Z + Math.cos(a) * BAND_R,
      y: HUB_Y + Math.sin(a) * BAND_R,
      angle: a + Math.PI / 2,
    });
  }

  const linkGeo = new THREE.BoxGeometry(TRACK_W, 0.07, PITCH * 0.86);
  const hornGeo = new THREE.BoxGeometry(TRACK_W * 0.18, 0.1, PITCH * 0.4);
  bothSides((s) => {
    const x = s * HALF_TRACK;
    for (const p of path) {
      mesh(root, linkGeo, m.track, [x, p.y, p.z], [p.angle, 0, 0]);
      mesh(
        root,
        hornGeo,
        m.track,
        [x, p.y + Math.cos(p.angle) * 0.08, p.z - Math.sin(p.angle) * 0.08],
        [p.angle, 0, 0],
      );
    }
  });

  // --- turret -------------------------------------------------------------
  const turret = new THREE.Group();
  turret.position.set(0, 1.78, -0.3);
  // Slight traverse so the gun does not read as a mirror-symmetric slab.
  turret.rotation.y = -0.22;
  root.add(turret);

  const shell = loft([
    { z: -1.7, halfWidth: 1.0, bottom: 0.0, top: 0.68 },
    { z: -1.2, halfWidth: 1.18, bottom: 0.0, top: 0.82 },
    { z: -0.1, halfWidth: 1.2, bottom: 0.0, top: 0.84 },
    { z: 0.9, halfWidth: 1.04, bottom: 0.0, top: 0.76 },
    { z: 1.6, halfWidth: 0.72, bottom: 0.02, top: 0.56 },
    { z: 1.9, halfWidth: 0.52, bottom: 0.06, top: 0.46 },
  ]);
  mesh(turret, shell, m.tankHull);
  // Roof plate and a bolted-on applique array on the cheeks.
  mesh(turret, new THREE.BoxGeometry(2.3, 0.06, 2.6), m.tankHull, [0, 0.85, -0.3]);
  bothSides((s) => {
    for (let i = 0; i < 3; i++) {
      mesh(turret, new THREE.BoxGeometry(0.12, 0.44, 0.5), m.tankHull, [s * 1.2, 0.42, 1.0 - i * 0.56]);
    }
  });

  // Mantlet and main armament.
  mesh(turret, new THREE.CylinderGeometry(0.44, 0.44, 0.6, 18), m.tankDark, [0, 0.42, 1.86], [Math.PI / 2, 0, 0]);
  mesh(turret, new THREE.BoxGeometry(1.0, 0.72, 0.24), m.tankHull, [0, 0.42, 1.72]);
  // Barrel: thermal sleeve, fume extractor, then the muzzle brake.
  mesh(turret, new THREE.CylinderGeometry(0.13, 0.14, 2.2, 16), m.tankDark, [0, 0.42, 3.1], [Math.PI / 2, 0, 0]);
  mesh(turret, new THREE.CylinderGeometry(0.16, 0.16, 1.5, 16), m.tankHull, [0, 0.42, 2.9], [Math.PI / 2, 0, 0]);
  mesh(turret, new THREE.CylinderGeometry(0.21, 0.21, 0.6, 16), m.tankHull, [0, 0.42, 3.5], [Math.PI / 2, 0, 0]);
  mesh(turret, new THREE.CylinderGeometry(0.115, 0.115, 1.5, 16), m.tankDark, [0, 0.42, 4.5], [Math.PI / 2, 0, 0]);
  mesh(turret, new THREE.CylinderGeometry(0.19, 0.19, 0.42, 16), m.tankDark, [0, 0.42, 5.2], [Math.PI / 2, 0, 0]);
  for (const s of [-1, 1]) {
    mesh(turret, new THREE.BoxGeometry(0.06, 0.3, 0.2), m.tankDark, [s * 0.16, 0.42, 5.2]);
  }
  mesh(turret, new THREE.CylinderGeometry(0.13, 0.13, 0.06, 16), m.tankDark, [0, 0.42, 5.43], [Math.PI / 2, 0, 0]);

  // Coaxial MG port and the gunner's primary sight.
  mesh(turret, new THREE.CylinderGeometry(0.05, 0.05, 0.5, 10), m.tankDark, [0.34, 0.4, 2.0], [Math.PI / 2, 0, 0]);
  mesh(turret, new THREE.BoxGeometry(0.42, 0.3, 0.42), m.tankHull, [0.62, 0.9, 0.9]);
  mesh(turret, new THREE.BoxGeometry(0.3, 0.18, 0.04), m.optic, [0.62, 0.92, 1.12]);
  mesh(turret, new THREE.BoxGeometry(0.5, 0.06, 0.46), m.tankDark, [0.62, 1.07, 0.9]);

  // Commander's cupola: hatch, vision blocks, pintle MG.
  mesh(turret, new THREE.CylinderGeometry(0.44, 0.46, 0.28, 18), m.tankHull, [-0.5, 0.98, -0.1]);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    mesh(
      turret,
      new THREE.BoxGeometry(0.16, 0.1, 0.06),
      m.optic,
      [-0.5 + Math.sin(a) * 0.44, 1.0, -0.1 + Math.cos(a) * 0.44],
      [0, a, 0],
    );
  }
  const hatch = mesh(turret, new THREE.CylinderGeometry(0.4, 0.4, 0.07, 18), m.tankHull, [-0.5, 1.14, -0.1]);
  hatch.rotation.z = 0.55;
  hatch.position.x -= 0.18;
  hatch.position.y += 0.12;
  // Pintle mount and MG.
  mesh(turret, new THREE.CylinderGeometry(0.05, 0.05, 0.3, 10), m.tankDark, [-0.16, 1.24, -0.1]);
  mesh(turret, new THREE.BoxGeometry(0.14, 0.16, 0.6), m.tankDark, [-0.16, 1.42, 0.06]);
  mesh(turret, new THREE.CylinderGeometry(0.03, 0.03, 0.7, 10), m.tankDark, [-0.16, 1.44, 0.6], [Math.PI / 2, 0, 0]);
  mesh(turret, new THREE.BoxGeometry(0.2, 0.22, 0.16), m.tankDark, [-0.16, 1.4, -0.24]);
  mesh(turret, new THREE.BoxGeometry(0.34, 0.28, 0.04), m.tankDark, [-0.16, 1.5, 0.34]);
  // Loader's hatch.
  mesh(turret, new THREE.CylinderGeometry(0.34, 0.34, 0.08, 16), m.tankHull, [0.62, 0.9, -0.5]);

  // Smoke grenade launchers, four tubes a side, angled outboard.
  bothSides((s) => {
    for (let i = 0; i < 4; i++) {
      const bank = mesh(
        turret,
        new THREE.CylinderGeometry(0.075, 0.075, 0.3, 10),
        m.tankDark,
        [s * (1.02 + (i % 2) * 0.16), 0.5 + Math.floor(i / 2) * 0.2, 0.72 - (i % 2) * 0.02],
        [Math.PI / 2, 0, 0],
      );
      bank.rotation.y = s * 0.5;
      bank.rotation.x = Math.PI / 2 - 0.25;
    }
    mesh(turret, new THREE.BoxGeometry(0.1, 0.5, 0.16), m.tankDark, [s * 1.14, 0.6, 0.62]);
  });

  // Rear stowage basket with a tarp bundle and jerry cans.
  mesh(turret, new THREE.BoxGeometry(2.0, 0.06, 1.0), m.tankDark, [0, 0.16, -1.9]);
  for (const x of [-0.95, 0.95]) {
    mesh(turret, new THREE.BoxGeometry(0.05, 0.5, 1.0), m.track, [x, 0.4, -1.9]);
  }
  mesh(turret, new THREE.BoxGeometry(2.0, 0.5, 0.05), m.track, [0, 0.4, -2.38]);
  mesh(turret, new THREE.BoxGeometry(1.0, 0.36, 0.7), m.canvasTop, [-0.4, 0.38, -1.9]);
  for (const x of [0.5, 0.82]) {
    mesh(turret, new THREE.BoxGeometry(0.28, 0.44, 0.16), m.tankDark, [x, 0.42, -1.9]);
  }
  // Antennas and a wind sensor.
  mesh(turret, new THREE.CylinderGeometry(0.014, 0.006, 1.8, 6), m.tankDark, [-1.0, 1.75, -1.5], [0.1, 0, 0.08]);
  mesh(turret, new THREE.CylinderGeometry(0.014, 0.006, 1.5, 6), m.tankDark, [1.0, 1.6, -1.5], [0.1, 0, -0.08]);
  mesh(turret, new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8), m.tankDark, [0.9, 1.1, -1.2]);
  mesh(turret, new THREE.BoxGeometry(0.16, 0.06, 0.16), m.optic, [0.9, 1.37, -1.2]);

  return {
    root,
    colliders: [
      { centre: new THREE.Vector3(0, 1.1, -0.2), size: new THREE.Vector3(4.2, 2.2, 7.2) },
      { centre: new THREE.Vector3(0, 2.2, -0.6), size: new THREE.Vector3(2.4, 0.9, 3.6) },
    ],
    size: new THREE.Vector3(4.2, 3.1, 7.4),
  };
}

// ------------------------------------------------------------------- public

export function buildVehicle(id: VehicleId): VehicleBuildResult {
  switch (id) {
    case 'supercar':
      return buildSupercar();
    case 'jeep':
      return buildJeep();
    case 'tank':
      return buildTank();
  }
}
