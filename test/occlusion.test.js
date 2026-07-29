/**
 * M15 — the occlusion cutaway.
 *
 * The shader itself cannot be unit-tested; what can be is everything that feeds
 * it, and the two ways this feature goes wrong are both on this side of the
 * GPU: tagging the wrong surfaces as floors, and computing the screen position
 * or radius in the wrong units.
 */
import { describe, expect, it } from 'vitest';
import { Scene, Vector2, Vector3 } from 'three';
import { TileGrid, FLOOR, WALL } from '../src/world/TileGrid.js';
import { OBJ, packObject } from '../src/world/Objects.js';
import { meshChunk } from '../src/world/Mesher.js';
import { FACING_FLOOR, FACING_NONE, createWorldUniforms } from '../src/render/WorldMaterial.js';
import { World } from '../src/world/World.js';
import { IsoCamera, ZOOM_STEPS } from '../src/render/IsoCamera.js';
import { DIR } from '../src/core/constants.js';
import { Character } from '../src/entity/Character.js';
import { CHARACTER_ORDER, MARKER_ORDER, Marker } from '../src/entity/Marker.js';

function facingsOf(grid, cx = 0, cz = 0, level = 0) {
  const built = meshChunk(grid, cx, cz, level);
  return built ? Array.from(built.geometry.getAttribute('aFacing').array) : [];
}

describe('what the cutaway is allowed to dissolve', () => {
  it('tags the ground as a floor, not merely as "not a wall"', () => {
    const g = new TileGrid(4, 4, 1);
    for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) g.setFloor(x, z, 0, FLOOR.CONCRETE);
    const facings = facingsOf(g);
    expect(facings.length).toBeGreaterThan(0);
    // Nothing but floor in this chunk.
    expect(new Set(facings)).toEqual(new Set([FACING_FLOOR]));
  });

  it('keeps walls tagged by direction, so the room cutaway still works', () => {
    const g = new TileGrid(4, 4, 1);
    for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) g.setFloor(x, z, 0, FLOOR.CONCRETE);
    g.setWall(2, 2, 0, DIR.N, WALL.BRICK);
    const facings = new Set(facingsOf(g));
    // A wall emits both of its opposing faces.
    expect(facings.has(DIR.N)).toBe(true);
    expect(facings.has(DIR.S)).toBe(true);
  });

  it('leaves objects dissolvable — a wardrobe in front of you must go', () => {
    const g = new TileGrid(4, 4, 1);
    for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) g.setFloor(x, z, 0, FLOOR.CONCRETE);
    g.setObject(2, 2, 0, packObject(OBJ.WARDROBE, DIR.N));
    const facings = new Set(facingsOf(g));
    expect(facings.has(FACING_NONE)).toBe(true);
    // …and it is *not* tagged as floor, which would exempt it.
    expect(FACING_NONE).not.toBe(FACING_FLOOR);
  });
});

describe('pointing the cutaway at the player', () => {
  /** A world with no scene graph of its own beyond a bare Scene. */
  function makeWorld() {
    const scene = new Scene();
    const world = new World(scene, 32, 32, 2);
    for (let l = 0; l < 2; l++) {
      for (let z = 0; z < 32; z++) {
        for (let x = 0; x < 32; x++) world.grid.setFloor(x, z, l, FLOOR.CONCRETE);
      }
    }
    return world;
  }

  const buffer = new Vector2(1280, 720);

  it('puts the circle on the player, not at the origin', () => {
    const world = makeWorld();
    const cam = new IsoCamera({ aspect: 16 / 9 });
    const player = new Vector3(16, 0, 16);
    cam.snapTo(player);

    world.updateOcclusion(player, cam, buffer);
    const screen = world.uniforms.uPlayerScreen.value;
    // The camera is centred on the player, so they land at the middle of the
    // frame — a little above it, because the circle is at chest height.
    expect(screen.x).toBeCloseTo(buffer.x / 2, 0);
    expect(screen.y).toBeGreaterThan(buffer.y / 2);
    expect(screen.z).toBeGreaterThan(0);
    expect(screen.z).toBeLessThan(1);
  });

  it('follows the player across the screen', () => {
    const world = makeWorld();
    const cam = new IsoCamera({ aspect: 16 / 9 });
    cam.snapTo(new Vector3(16, 0, 16));

    world.updateOcclusion(new Vector3(16, 0, 16), cam, buffer);
    const centred = world.uniforms.uPlayerScreen.value.clone();
    world.updateOcclusion(new Vector3(20, 0, 16), cam, buffer);
    const moved = world.uniforms.uPlayerScreen.value.clone();
    expect(moved.x).not.toBeCloseTo(centred.x, 0);
  });

  it('holds the hole at a constant size in metres, not in pixels', () => {
    // The whole reason the radius is computed rather than hard-coded: a fixed
    // pixel radius swallows a house at the closest zoom and is smaller than the
    // character at the widest.
    const world = makeWorld();
    const cam = new IsoCamera({ aspect: 16 / 9 });
    const player = new Vector3(16, 0, 16);

    cam.zoomStep = 0;
    cam.snapTo(player);
    world.updateOcclusion(player, cam, buffer);
    const close = world.uniforms.uOccludeRadius.value.clone();

    cam.zoomStep = ZOOM_STEPS.length - 1;
    cam.snapTo(player);
    world.updateOcclusion(player, cam, buffer);
    const wide = world.uniforms.uOccludeRadius.value.clone();

    expect(close.x).toBeGreaterThan(wide.x);
    // The ratio of the radii must equal the ratio of the view heights.
    expect(close.x / wide.x).toBeCloseTo(
      ZOOM_STEPS[ZOOM_STEPS.length - 1] / ZOOM_STEPS[0],
      3,
    );
  });

  it('scales with the drawing buffer, not the CSS size', () => {
    const world = makeWorld();
    const cam = new IsoCamera({ aspect: 16 / 9 });
    const player = new Vector3(16, 0, 16);
    cam.snapTo(player);

    world.updateOcclusion(player, cam, new Vector2(1280, 720));
    const single = world.uniforms.uOccludeRadius.value.x;
    world.updateOcclusion(player, cam, new Vector2(2560, 1440));
    const retina = world.uniforms.uOccludeRadius.value.x;
    expect(retina).toBeCloseTo(single * 2, 3);
  });

  it('keeps an inner radius smaller than the outer, so the edge fades outward', () => {
    const world = makeWorld();
    const cam = new IsoCamera({ aspect: 16 / 9 });
    const player = new Vector3(16, 0, 16);
    cam.snapTo(player);
    world.updateOcclusion(player, cam, buffer);
    const r = world.uniforms.uOccludeRadius.value;
    expect(r.x).toBeGreaterThan(0);
    expect(r.y).toBeGreaterThan(r.x);
  });
});

describe('the shared uniforms', () => {
  it('gives the occlusion cutaway a home the depth material also sees', () => {
    const u = createWorldUniforms({
      visibilityTexture: null, visWidth: 4, visHeight: 4, gridDepth: 4,
      roomCutTexture: null, roomCount: 4,
    });
    expect(u.uPlayerScreen).toBeDefined();
    expect(u.uOccludeRadius).toBeDefined();
    expect(u.uOccludeStrength.value).toBe(1);
  });
});

describe('the silhouette', () => {
  it('mirrors the body rather than approximating it, and does not recurse', () => {
    // The bug: attaching a ghost during `traverse` means the walk visits it,
    // and a ghost shares its host's geometry — so it passes the same size test
    // and gets a ghost of its own, for ever. It took out all 411 tests at once.
    const character = new Character();
    const marker = new Marker();
    const attached = marker.attachTo(character);

    expect(attached).toBeGreaterThan(3);
    expect(attached).toBeLessThan(9);

    let meshes = 0;
    character.root.traverse((o) => {
      if (o.isMesh) meshes++;
    });
    expect(meshes).toBeLessThan(40); // finite, and not exponential
  });

  it('shares geometry with the body, so it animates for free', () => {
    const character = new Character();
    const marker = new Marker();
    marker.attachTo(character);
    const ghost = character.torso.children.find((c) => c.material === marker.through);
    expect(ghost).toBeDefined();
    expect(ghost.geometry).toBe(character.torso.geometry);
  });

  it('skips parts too small to read at this camera distance', () => {
    const character = new Character();
    const marker = new Marker();
    marker.attachTo(character);
    // The eyes are two thousandths of a cubic metre; they must not be ghosted.
    let tiny = 0;
    character.root.traverse((o) => {
      if (!o.isMesh || o.material !== marker.through) return;
      const p = o.geometry.parameters;
      if (p.width * p.height * p.depth < 0.006) tiny++;
    });
    expect(tiny).toBe(0);
  });
});

describe('the cutaway only takes what is over your head', () => {
  it('starts the fade above a doorway', () => {
    // The correction M17 made to M15: a circle that dissolves everything
    // nearer than the player also dissolves the door in front of them.
    const scene = new Scene();
    const world = new World(scene, 16, 16, 2);
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) world.grid.setFloor(x, z, 0, FLOOR.CONCRETE);
    const cam = new IsoCamera({ aspect: 16 / 9 });
    const player = new Vector3(8, 0, 8);
    cam.snapTo(player);

    world.updateOcclusion(player, cam, new Vector2(1280, 720));
    const h = world.uniforms.uOccludeHeight.value;
    expect(h.x).toBeGreaterThan(2.05); // taller than a door
    expect(h.y).toBeGreaterThan(h.x);
    expect(h.y).toBeLessThan(2.6); // …and below the top of a wall
  });

  it('measures from the storey you are standing on', () => {
    const scene = new Scene();
    const world = new World(scene, 16, 16, 3);
    for (let l = 0; l < 3; l++) {
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) world.grid.setFloor(x, z, l, FLOOR.CONCRETE);
    }
    const cam = new IsoCamera({ aspect: 16 / 9 });
    const buffer = new Vector2(1280, 720);

    world.updateOcclusion(new Vector3(8, 0, 8), cam, buffer);
    const ground = world.uniforms.uOccludeHeight.value.x;
    world.updateOcclusion(new Vector3(8, 2.6, 8), cam, buffer);
    const upstairs = world.uniforms.uOccludeHeight.value.x;

    // Upstairs takes the ceiling above *you*, not the roof two floors up.
    expect(upstairs - ground).toBeCloseTo(2.6, 5);
  });
});

describe('draw order', () => {
  it('draws the body before its own silhouette', () => {
    // Both bugs this catches shipped in a screenshot: the ghost drawing first
    // (so it tested against the ground behind the survivor and covered them),
    // and the ghost inheriting the body's renderOrder from a traverse that ran
    // after it was attached (so three.js sorted a coplanar pair by distance).
    const character = new Character();
    character.root.traverse((o) => {
      if (o.isMesh) o.renderOrder = CHARACTER_ORDER;
    });
    const marker = new Marker();
    marker.attachTo(character);

    let bodies = 0;
    let ghosts = 0;
    character.root.traverse((o) => {
      if (!o.isMesh) return;
      if (o.material === marker.through) {
        ghosts++;
        expect(o.renderOrder).toBe(MARKER_ORDER);
      } else {
        bodies++;
        expect(o.renderOrder).toBe(CHARACTER_ORDER);
      }
    });
    expect(ghosts).toBeGreaterThan(0);
    expect(bodies).toBeGreaterThan(ghosts);
    expect(MARKER_ORDER).toBeGreaterThan(CHARACTER_ORDER);
  });
});

describe('deciding whether the survivor is hidden', () => {
  /**
   * The lesson of M17: the depth buffer is the wrong place to ask this. Two
   * shader programs computing the same transform need not agree in the last
   * bit, so `depthFunc = GreaterDepth` on a mesh sharing the body's geometry
   * gives a per-pixel coin flip — a survivor painted cyan in plain sight. The
   * grid knows, exactly, for a handful of lookups.
   */
  function open(w = 24, d = 24, levels = 2) {
    const scene = new Scene();
    const world = new World(scene, w, d, levels);
    for (let l = 0; l < levels; l++) {
      for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
        if (l === 0) world.grid.setFloor(x, z, l, FLOOR.CONCRETE);
      }
    }
    return world;
  }

  it('says no in the middle of an empty street', () => {
    const world = open();
    const cam = new IsoCamera({ aspect: 16 / 9 });
    expect(world.isOccluded({ x: 12, z: 12, level: 0 }, cam)).toBe(false);
  });

  it('says yes with a wall between them and the camera', () => {
    const world = open();
    const cam = new IsoCamera({ aspect: 16 / 9 });
    // The default camera looks down the +X/+Z diagonal, so the camera side of
    // a survivor at (12,12) is toward larger x and z.
    for (let z = 10; z < 16; z++) world.grid.setWall(14, z, 0, DIR.W, WALL.BRICK);
    for (let x = 10; x < 16; x++) world.grid.setWall(x, 14, 0, DIR.N, WALL.BRICK);
    expect(world.isOccluded({ x: 12, z: 12, level: 0 }, cam)).toBe(true);
  });

  it('says yes under a ceiling, wall or no wall', () => {
    const world = open();
    const cam = new IsoCamera({ aspect: 16 / 9 });
    expect(world.isOccluded({ x: 12, z: 12, level: 0 }, cam)).toBe(false);
    world.grid.setFloor(12, 12, 1, FLOOR.WOOD);
    expect(world.isOccluded({ x: 12, z: 12, level: 0 }, cam)).toBe(true);
  });

  it('changes its mind when the camera turns', () => {
    const world = open();
    const cam = new IsoCamera({ aspect: 16 / 9 });
    for (let z = 10; z < 16; z++) world.grid.setWall(14, z, 0, DIR.W, WALL.BRICK);
    for (let x = 10; x < 16; x++) world.grid.setWall(x, 14, 0, DIR.N, WALL.BRICK);
    const before = world.isOccluded({ x: 12, z: 12, level: 0 }, cam);

    cam.rotationStep = 2;
    cam.snapTo(new Vector3(12, 0, 12));
    const after = world.isOccluded({ x: 12, z: 12, level: 0 }, cam);
    expect(after).not.toBe(before);
  });

  it('toggles the silhouette rather than every mesh on the rig', () => {
    const character = new Character();
    const marker = new Marker();
    marker.attachTo(character);

    marker.setOccluded(true);
    expect(marker.ghosts.length).toBeGreaterThan(0);
    for (const g of marker.ghosts) expect(g.visible).toBe(true);
    // The body itself is never touched.
    expect(character.torso.visible).toBe(true);

    marker.setOccluded(false);
    for (const g of marker.ghosts) expect(g.visible).toBe(false);
    expect(character.torso.visible).toBe(true);
  });
});
