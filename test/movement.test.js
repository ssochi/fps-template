import { describe, expect, it } from 'vitest';
import { IsoCamera, wrapAngle } from '../src/render/IsoCamera.js';
import { FLOOR, TileGrid, WALL } from '../src/world/TileGrid.js';
import { Entity } from '../src/entity/Entity.js';
import { moveOnGrid } from '../src/entity/Walker.js';
import { DIR } from '../src/core/constants.js';

describe('iso camera basis', () => {
  it('keeps forward and right orthogonal and on the ground plane', () => {
    const cam = new IsoCamera({ aspect: 16 / 9 });
    for (let step = 0; step < 4; step++) {
      cam.rotationStep = step;
      cam.snapTo(cam.target);
      const { forward, right } = cam.screenBasis();
      expect(forward.y).toBe(0);
      expect(right.y).toBe(0);
      expect(forward.length()).toBeCloseTo(1);
      expect(right.length()).toBeCloseTo(1);
      expect(forward.dot(right)).toBeCloseTo(0);
    }
  });

  it('rotates the basis by a quarter turn per step', () => {
    const cam = new IsoCamera({ aspect: 1 });
    cam.rotationStep = 0;
    cam.snapTo(cam.target);
    const a = cam.screenBasis().forward.clone();
    cam.rotationStep = 1;
    cam.snapTo(cam.target);
    const b = cam.screenBasis().forward.clone();
    // A quarter turn means the two forwards are perpendicular.
    expect(a.dot(b)).toBeCloseTo(0);
  });

  it('matches the camera\'s own right vector, so W is not secretly A', () => {
    const cam = new IsoCamera({ aspect: 1 });
    cam.snapTo(cam.target);
    const { right } = cam.screenBasis();
    // three.js stores the camera's local X axis in the first column of its
    // world matrix; screen-right must agree with it on the ground plane.
    const e = cam.camera.matrixWorld.elements;
    const camRight = { x: e[0], z: e[2] };
    const len = Math.hypot(camRight.x, camRight.z);
    expect(right.x).toBeCloseTo(camRight.x / len, 3);
    expect(right.z).toBeCloseTo(camRight.z / len, 3);
  });

  it('clamps zoom to the ladder', () => {
    const cam = new IsoCamera({ aspect: 1 });
    cam.zoom(-99);
    expect(cam.zoomStep).toBe(0);
    cam.zoom(99);
    expect(cam.zoomStep).toBe(5);
  });

  it('takes the short way round when rotating past the wrap point', () => {
    expect(wrapAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI * 0.5);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI * 0.5);
  });
});

describe('grid movement', () => {
  function scene() {
    const g = new TileGrid(8, 8, 1);
    for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) g.setFloor(x, z, 0, FLOOR.WOOD);
    const e = new Entity('test');
    e.position.set(2.5, 0, 2.5);
    return { g, e };
  }

  it('moves freely with nothing in the way', () => {
    const { g, e } = scene();
    moveOnGrid(g, e, 0.4, 0.4);
    expect(e.position.x).toBeCloseTo(2.9);
    expect(e.position.z).toBeCloseTo(2.9);
  });

  it('stops at a wall and reports the blocked axis', () => {
    const { g, e } = scene();
    g.setWall(2, 2, 0, DIR.E, WALL.BRICK);
    const hit = moveOnGrid(g, e, 0.9, 0);
    expect(hit.hitX).toBe(true);
    // Parked a radius short of the wall plane at x = 3.
    expect(e.position.x).toBeLessThan(3 - e.radius + 1e-3);
    expect(e.position.x).toBeGreaterThan(3 - e.radius - 0.01);
  });

  it('slides along a wall instead of sticking', () => {
    const { g, e } = scene();
    g.setWall(2, 2, 0, DIR.E, WALL.BRICK);
    const startZ = e.position.z;
    moveOnGrid(g, e, 0.9, 0.3);
    expect(e.position.z).toBeCloseTo(startZ + 0.3);
  });

  it('does not squeeze diagonally through a corner', () => {
    const { g, e } = scene();
    g.setWall(2, 2, 0, DIR.E, WALL.BRICK);
    g.setWall(2, 2, 0, DIR.S, WALL.BRICK);
    moveOnGrid(g, e, 0.9, 0.9);
    // Both axes blocked: the entity must still be inside its original tile.
    expect(Math.floor(e.position.x)).toBe(2);
    expect(Math.floor(e.position.z)).toBe(2);
  });

  it('walks through a doorway', () => {
    const { g, e } = scene();
    g.setWall(2, 2, 0, DIR.E, WALL.DOORWAY);
    moveOnGrid(g, e, 0.9, 0);
    expect(e.position.x).toBeCloseTo(3.4);
  });

  it('is blocked by the edge of the world', () => {
    const { g, e } = scene();
    e.position.set(0.5, 0, 0.5);
    const hit = moveOnGrid(g, e, -0.9, 0);
    expect(hit.hitX).toBe(true);
    expect(e.position.x).toBeGreaterThan(0);
  });
});

describe('entity facing', () => {
  it('faces −Z at yaw 0, matching the project convention', () => {
    const e = new Entity('t');
    e.setYaw(0);
    const f = e.forward();
    expect(f.z).toBeCloseTo(-1);
    expect(f.x).toBeCloseTo(0);
  });

  it('faceTo points at the target, not away from it', () => {
    const e = new Entity('t');
    e.position.set(0, 0, 0);
    e.faceTo({ x: 5, y: 0, z: 0 }, true);
    const f = e.forward();
    expect(f.x).toBeCloseTo(1);
    expect(f.z).toBeCloseTo(0);
  });

  it('turns the short way round', () => {
    const e = new Entity('t');
    e.turnRate = 100;
    e.setYaw(Math.PI * 0.95);
    e.aimYaw(-Math.PI * 0.95);
    e.stepTurn(0.001); // small step: check the direction of travel, not arrival
    expect(e.yaw).toBeGreaterThan(Math.PI * 0.95);
  });
});
