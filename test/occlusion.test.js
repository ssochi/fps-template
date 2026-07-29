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
