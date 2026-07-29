/**
 * Knox — bootstrap.
 *
 * M1 wires the tile grid, the chunk mesher and the isometric rig together over a
 * hand-authored test block. Town generation is M2; the real player is M3.
 */
import { CapsuleGeometry, Mesh, MeshLambertMaterial, Vector2, Vector3 } from 'three';
import { Renderer } from './render/Renderer.js';
import { IsoCamera } from './render/IsoCamera.js';
import { Loop } from './core/Loop.js';
import { ACTION, Input } from './core/Input.js';
import { World } from './world/World.js';
import { buildTestBlock } from './scenes/TestBlock.js';
import { Entity } from './entity/Entity.js';
import { Walker } from './entity/Walker.js';
import { STOREY, tileToWorld } from './core/constants.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('app'));
const statsEl = document.getElementById('stats');

const isoCamera = new IsoCamera({ aspect: window.innerWidth / window.innerHeight });
const renderer = new Renderer(canvas, isoCamera);
const input = new Input(canvas);

const world = new World(renderer.scene, 48, 32, 2);
const { spawn } = buildTestBlock(world);

// --- stand-in avatar ----------------------------------------------------
// A capsule, not a character: M3 owns the real one. It exists so movement,
// collision and camera follow can be judged now.
const avatar = new Entity('avatar');
const avatarMesh = new Mesh(
  new CapsuleGeometry(0.26, 0.9, 6, 14),
  new MeshLambertMaterial({ color: 0xd8c9a8 }),
);
avatarMesh.position.y = 0.88;
avatarMesh.castShadow = true;
avatar.object.add(avatarMesh);
renderer.scene.add(avatar.object);

const spawnWorld = tileToWorld(spawn.x, spawn.z, spawn.level);
avatar.position.set(spawnWorld.x, spawnWorld.y, spawnWorld.z);
avatar.level = spawn.level;
const walker = new Walker(avatar);

isoCamera.snapTo(avatar.position);

// --- loop ---------------------------------------------------------------
const axis = new Vector2();
const basisF = new Vector3();
const basisR = new Vector3();
const moveDir = new Vector3();
const camFocus = new Vector3();
let paused = false;

window.addEventListener('resize', () => renderer.setSize(window.innerWidth, window.innerHeight));

const loop = new Loop({
  update(dt) {
    if (input.wasPressed(ACTION.PAUSE)) paused = !paused;

    // Camera controls stay live while paused — inspecting a frozen scene is
    // half of what a pause key is for.
    if (input.wasPressed(ACTION.ROTATE_CW)) isoCamera.rotate(1);
    if (input.wasPressed(ACTION.ROTATE_CCW)) isoCamera.rotate(-1);
    if (input.wheelSteps) isoCamera.zoom(input.wheelSteps);

    if (input.wasPressed(ACTION.LEVEL_UP) && avatar.level < world.grid.levels - 1) {
      avatar.level++;
      avatar.syncLevelHeight();
    }
    if (input.wasPressed(ACTION.LEVEL_DOWN) && avatar.level > 0) {
      avatar.level--;
      avatar.syncLevelHeight();
    }

    if (!paused) {
      // Screen-relative movement: "up" is up the screen at any camera rotation.
      input.moveAxis(axis);
      isoCamera.screenBasis(basisF, basisR);
      moveDir.set(0, 0, 0).addScaledVector(basisR, axis.x).addScaledVector(basisF, axis.y);
      if (moveDir.lengthSq() > 1e-8) moveDir.normalize();

      const speed = input.isHeld(ACTION.RUN)
        ? walker.runSpeed
        : input.isHeld(ACTION.SNEAK)
          ? walker.sneakSpeed
          : walker.walkSpeed;
      walker.step(world.grid, moveDir, speed, dt);
    }

    // A small budget keeps a collapsing building off the critical path. Nothing
    // dirties chunks yet, but the path should be exercised from day one.
    world.flushDirty(2);
  },

  render(alpha, frameTime) {
    // The camera follows the avatar's eye height, not its feet, so upper
    // storeys don't push the view into the floor.
    camFocus.set(avatar.position.x, avatar.level * STOREY + 0.9, avatar.position.z);
    isoCamera.update(frameTime, camFocus);
    renderer.updateLights(camFocus);
    renderer.render();
    input.endFrame();

    if (loop.frame % 15 === 0) {
      const r = renderer.info;
      statsEl.textContent =
        `${loop.fps.toFixed(0)} fps   sim ${loop.lastUpdateMs.toFixed(2)}ms   draw ${loop.lastRenderMs.toFixed(2)}ms\n` +
        `${r.calls} draws   ${(r.triangles / 1000).toFixed(1)}k tris   ${world.stats.chunks} chunks\n` +
        `tile ${Math.floor(avatar.position.x)},${Math.floor(avatar.position.z)}  storey ${avatar.level}` +
        `   zoom ${isoCamera.viewHeight}m${paused ? '   [PAUSED]' : ''}`;
    }
  },
});

loop.start();

// Console handle, and the hook the smoke test drives.
window.__knox = { world, renderer, isoCamera, loop, avatar, input };
