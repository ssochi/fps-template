/**
 * Knox — bootstrap.
 *
 * M1 wires the tile grid, the chunk mesher and the isometric rig together over a
 * hand-authored test block. Town generation is M2; the real player is M3.
 */
import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import { Renderer } from './render/Renderer.js';
import { IsoCamera } from './render/IsoCamera.js';
import { Loop } from './core/Loop.js';
import { ACTION, Input } from './core/Input.js';
import { World } from './world/World.js';
import { FLAG } from './world/TileGrid.js';
import { generateTown } from './worldgen/Town.js';
import { Player } from './entity/Player.js';
import { HordeSystem } from './sim/HordeSystem.js';
import { Combat } from './sim/Combat.js';
import { Clock } from './core/Clock.js';
import { Moodles } from './sim/Moodles.js';
import { Hud } from './ui/Hud.js';
import { events } from './core/Events.js';
import { STOREY, tileToWorld } from './core/constants.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('app'));

const isoCamera = new IsoCamera({ aspect: window.innerWidth / window.innerHeight });
const renderer = new Renderer(canvas, isoCamera);
const input = new Input(canvas);

const world = new World(renderer.scene, 104, 104, 3);
const town = generateTown(world, 'knox-county');
const { spawn } = town;

// --- player -------------------------------------------------------------
const avatar = new Player(world.grid);
renderer.scene.add(avatar.object);

const spawnWorld = tileToWorld(spawn.x, spawn.z, spawn.level);
avatar.position.set(spawnWorld.x, spawnWorld.y, spawnWorld.z);
avatar.level = spawn.level;

isoCamera.snapTo(avatar.position);

// --- the horde ----------------------------------------------------------
const horde = new HordeSystem(renderer.scene, world, { capacity: 400 });
horde.populate(260);

const combat = new Combat(horde.horde, avatar);

// --- survival -----------------------------------------------------------
const clock = new Clock({ hour: 9 });
const moodles = new Moodles(avatar.body);
avatar.moodles = moodles;
const hud = new Hud();

// The death report needs facts the Body does not have: how long you lasted and
// how many you took with you. Assembling them here keeps Body ignorant of the UI.
events.on('player:died', ({ cause }) => {
  hud.showDeath({
    cause: DEATH_CAUSES[cause] ?? cause,
    days: `${clock.day + 1} day${clock.day === 0 ? '' : 's'}`,
    kills: combat.stats.kills,
  });
});

const DEATH_CAUSES = {
  wounds: 'Torn apart',
  injuries: 'Died of your injuries',
  'blood loss': 'Bled out',
  infection: 'Turned',
  starvation: 'Starved',
  dehydration: 'Died of thirst',
};

// --- cursor aiming ------------------------------------------------------
// The body turns toward the cursor, not toward travel, so backing away from
// something while still facing it is possible. The pointer is projected onto
// the horizontal plane of the storey the player is standing on — projecting
// onto y=0 instead would make aiming drift as soon as they went upstairs.
const raycaster = new Raycaster();
const aimPlane = new Plane(new Vector3(0, 1, 0), 0);
const aimHit = new Vector3();

function updateAim() {
  aimPlane.constant = -(avatar.level * STOREY + 1.0);
  raycaster.setFromCamera(input.pointer, isoCamera.camera);
  if (raycaster.ray.intersectPlane(aimPlane, aimHit)) {
    avatar.aimTarget.copy(aimHit);
    avatar.hasAim = true;
  }
}

// --- loop ---------------------------------------------------------------
const axis = new Vector2();
const basisF = new Vector3();
const basisR = new Vector3();
const moveDir = new Vector3();
const camFocus = new Vector3();
const intent = { move: moveDir, run: false, sneak: false, interact: false };
const observer = { x: 0, z: 0, level: 0 };
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

    if (!paused) {
      updateAim();

      // Screen-relative movement: "up" is up the screen at any camera rotation.
      input.moveAxis(axis);
      isoCamera.screenBasis(basisF, basisR);
      moveDir.set(0, 0, 0).addScaledVector(basisR, axis.x).addScaledVector(basisF, axis.y);
      if (moveDir.lengthSq() > 1e-8) moveDir.normalize();

      intent.move = moveDir;
      intent.run = input.isHeld(ACTION.RUN);
      intent.sneak = input.isHeld(ACTION.SNEAK);
      intent.interact = input.wasPressed(ACTION.INTERACT);

      // Swinging is only possible when not already committed to something.
      if (avatar.busy <= 0) {
        if (input.wasPressed(ACTION.ATTACK)) combat.swing('attack');
        else if (input.wasPressed(ACTION.SHOVE)) combat.swing('shove');
      }

      // Screenshot hook: a still frame cannot hold a key down, so the smoke
      // test drives the animator directly. It must *replace* the normal update
      // rather than follow it — otherwise the idle pass and the forced pass
      // fight over the animator's speed blend and the pose lands at half
      // amplitude, which looks like a broken gait rather than a driven one.
      const forced = window.__knox?.__forceGait;
      if (forced) {
        avatar.gait = forced.gait;
        avatar.currentSpeed = forced.speed;
        avatar.character.update(dt, forced.speed, forced.gait);
      } else {
        avatar.update(intent, dt);
      }
    }

    // Cutaway and fog of war both key off the tile the player is standing on.
    const t = avatar.tile();
    observer.x = t.x;
    observer.z = t.z;
    observer.level = avatar.level;
    world.updateView(dt, observer, isoCamera);
    horde.update(dt, observer);
    combat.update(dt);

    // One clock, advanced in one place. Bleeding is felt in real seconds;
    // hunger and infection are measured in days, so Body and Moodles are handed
    // both rather than each inventing a scale.
    const gameDt = clock.advance(dt);
    avatar.body.update(dt, gameDt);
    moodles.update(dt, gameDt, {
      indoors: world.grid.hasFlag(observer.x, observer.z, observer.level, FLAG.INDOOR),
      daylight: clock.daylight,
      exertion: avatar.currentSpeed / 5,
      threats: horde.horde.stats.chasing,
    });
    // Fatigue caps how much endurance you can hold at all.
    avatar.endurance = Math.min(avatar.endurance, moodles.enduranceCeiling);

    // A small budget keeps a collapsing building off the critical path.
    world.flushDirty(2);
  },

  render(alpha, frameTime) {
    // The camera follows the avatar's eye height, not its feet, so upper
    // storeys don't push the view into the floor.
    camFocus.set(avatar.position.x, avatar.level * STOREY + 0.9, avatar.position.z);
    isoCamera.update(frameTime, camFocus);
    renderer.setSun(clock.sunAngles(), clock.daylight);
    renderer.updateLights(camFocus);
    horde.render(loop.elapsed);
    renderer.render();
    input.endFrame();

    if (loop.frame % 12 === 0) {
      const r = renderer.info;
      hud.update({
        clock,
        player: avatar,
        moodles,
        debug:
          `${loop.fps.toFixed(0)} fps · sim ${loop.lastUpdateMs.toFixed(2)}ms · ${r.calls} draws\n` +
          `${horde.horde.stats.alive} alive · ${horde.horde.stats.dead} down · ` +
          `${horde.horde.stats.chasing} chasing · ${combat.stats.kills} killed`,
      });
    }
  },
});

loop.start();

// Console handle, and the hook the smoke test drives.
window.__knox = { world, town, renderer, isoCamera, loop, avatar, input, horde, combat, clock, moodles, hud };
