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
import { Panels } from './ui/Panels.js';
import { LootSystem } from './items/Loot.js';
import { Construction, Siege } from './sim/Construction.js';
import { Skills, SKILL, WEAPON_SKILL, XP } from './sim/Skills.js';
import { Audio } from './audio/Audio.js';
import * as Save from './save/Save.js';
import { Container } from './items/Container.js';
import { WeaponInstance } from './items/Weapons.js';
import { Item } from './items/ItemDb.js';
import { events } from './core/Events.js';
import { STOREY, tileToWorld } from './core/constants.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('app'));

const isoCamera = new IsoCamera({ aspect: window.innerWidth / window.innerHeight });
const renderer = new Renderer(canvas, isoCamera);
const input = new Input(canvas);

const WORLD_SEED = 'knox-county';
const world = new World(renderer.scene, 104, 104, 3);
const town = generateTown(world, WORLD_SEED);
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

// --- looting ------------------------------------------------------------
// Loot keys off the purpose M2's furnishing pass gave each room, so a fridge in
// a kitchen holds food and a wardrobe in a bedroom holds sheets.
const roomPurposes = new Map(town.rooms.map((r) => [r.id, r.purpose]));
const loot = new LootSystem(world.grid, WORLD_SEED, roomPurposes);
const panels = new Panels(avatar.inventory);
panels.player = avatar;

const construction = new Construction(world.grid, avatar);
// Blocked zombies work on whatever is in their way, so a barricade is a delay
// rather than an off switch.
const siege = new Siege(world.grid, horde.horde);
panels.construction = construction;

// --- progression, sound and saving --------------------------------------
const skills = new Skills();
avatar.skills = skills;
const audio = new Audio();

/**
 * Sound is wired entirely through the event bus. Nothing that makes a noise
 * knows the audio system exists, which is the same rule the horde's hearing
 * follows — and it means one listener covers combat, doors, crafting and sieges.
 */
events.on('noise:made', (e) => {
  const wx = e.x + 0.5;
  const wz = e.z + 0.5;
  if (e.source === 'door') audio.door(wx, wz, e.loudness > 5);
  else if (e.source === 'crafting' || e.source === 'siege') audio.hammer(wx, wz);
  else if (e.source === 'attack') audio.thud(wx, wz, { pitch: 1.2 });
  else if (e.source === 'shove') audio.thud(wx, wz, { pitch: 0.8, gain: 0.35 });
  else audio.crack(wx, wz);
});
events.on('player:wounded', () => audio.hurt());

// Skills are awarded from the same events, so "you get better at what you do"
// needs no bookkeeping at each call site.
events.on('player:treated', () => skills.award(SKILL.FIRSTAID, XP.treat));
events.on('crafted', () => skills.award(SKILL.CARPENTRY, XP.craft));
events.on('built:barricade', () => skills.award(SKILL.CARPENTRY, XP.plank));

// Browsers refuse to start an AudioContext outside a user gesture.
for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, () => audio.resume(), { once: false });
}

// Something to start with, so the first minute is not spent hungry and unarmed.
avatar.inventory.add(new Item('water'));
avatar.inventory.add(new Item('beans'));
avatar.inventory.add(new Item('bandage', 2));

canvas.addEventListener('pointerdown', (e) => {
  if (!panels.open) return;
  e.stopPropagation();
});
panels.el.addEventListener('pointerdown', (e) => {
  const action = panels.resolveClick(e.target);
  if (!action) return;
  if (action.recipe) {
    const reason = construction.begin(action.recipe);
    if (!reason) panels.close();
    return;
  }
  action.from.transferTo(action.to, action.item, action.item.count);
  panels.invalidate();
});

// The death report needs facts the Body does not have: how long you lasted and
// how many you took with you. Assembling them here keeps Body ignorant of the UI.
events.on('player:died', ({ cause }) => {
  hud.showDeath({
    cause: DEATH_CAUSES[cause] ?? cause,
    days: `${clock.day + 1} day${clock.day === 0 ? '' : 's'}`,
    kills: combat.stats.kills,
    skills: skills.summary().filter((s2) => s2.level > 0),
    onRestart: () => {
      // A run is permanent, so restarting throws the save away rather than
      // reloading into the corpse you just made.
      Save.clear('slot1').then(() => window.location.reload());
    },
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

    // --- inventory and looting -------------------------------------------
    if (input.wasPressed(ACTION.INVENTORY)) {
      panels.toggle(panels.open ? null : nearbyContainer());
    }
    if (panels.open) {
      if (input.wasPressed(ACTION.CONSUME)) {
        const food = panels.firstEdible();
        if (food) {
          avatar.consume(food);
          panels.invalidate();
        }
      }
      if (input.wasPressed(ACTION.EQUIP)) {
        const weapon = panels.firstWeapon();
        if (weapon) {
          avatar.equip(weapon);
          panels.invalidate();
        }
      }
      if (input.wasPressed(ACTION.TREAT)) {
        const kit = avatar.inventory.find((i) => i.def.stopsBleeding || i.id === 'painkillers');
        if (kit) {
          avatar.useMedical(kit);
          panels.invalidate();
        }
      }
    }
    if (input.wasPressed(ACTION.TORCH)) avatar.toggleTorch();

    if (!paused && !panels.open) {
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
        if (input.wasPressed(ACTION.ATTACK)) {
          const result = combat.swing('attack');
          const trained = WEAPON_SKILL[avatar.weapon.def.id] ?? SKILL.BLUNT;
          if (result.hits) skills.award(trained, XP.hit * result.hits);
          if (result.kills) skills.award(trained, XP.kill * result.kills);
        } else if (input.wasPressed(ACTION.SHOVE)) {
          combat.swing('shove');
        }
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
    construction.update(dt);
    siege.update(dt, horde.flow);

    // Fitness and sneaking are trained by doing them, not by a menu.
    if (avatar.gait === 'run') skills.award(SKILL.FITNESS, XP.run * dt);
    else if (avatar.gait === 'sneak' && horde.horde.stats.chasing === 0) {
      skills.award(SKILL.SNEAK, XP.sneak * dt);
    }

    // One clock, advanced in one place. Bleeding is felt in real seconds;
    // hunger and infection are measured in days, so Body and Moodles are handed
    // both rather than each inventing a scale.
    const gameDt = clock.advance(dt);
    const hoursSince = gameDt / 3600;
    // Everything perishable ages on the in-game clock: what you carry, and what
    // is still sitting in the containers you have already opened.
    avatar.inventory.age(hoursSince);
    loot.age(hoursSince);
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
    renderer.setTorch(avatar.position, avatar.torchOn && avatar.hasTorch);

    // Audio follows the camera's focus, not the player, so a sound is placed
    // relative to what the screen is showing.
    audio.listener.x = camFocus.x;
    audio.listener.z = camFocus.z;
    footsteps(frameTime);
    ambientGroans(frameTime);
    renderer.updateLights(camFocus);
    horde.render(loop.elapsed);
    renderer.render();
    input.endFrame();

    if (loop.frame % 12 === 0) {
      const r = renderer.info;
      panels.render();
      hud.update({
        clock,
        player: avatar,
        moodles,
        skills,
        debug:
          `${loop.fps.toFixed(0)} fps · sim ${loop.lastUpdateMs.toFixed(2)}ms · ${r.calls} draws\n` +
          `${horde.horde.stats.alive} alive · ${horde.horde.stats.dead} down · ` +
          `${horde.horde.stats.chasing} chasing · ${combat.stats.kills} killed\n` +
          `carrying ${avatar.inventory.weight.toFixed(1)}kg · ` +
          `${loot.stats.generated} searched · ${construction.stats.barricades} barricades\n` +
          (construction.job
            ? `${construction.job.recipe.name} ${(construction.progress * 100).toFixed(0)}%`
            : siege.stats.breaches
              ? `${siege.stats.breaches} breach(es)`
              : ''),
      });
    }
  },
});

loop.start();

// Console handle, and the hook the smoke test drives.
// --- incidental sound ---------------------------------------------------
let stepPhase = 0;
function footsteps(dt) {
  if (avatar.currentSpeed <= 0.1) return;
  // Phase advances with distance for exactly the reason the gait does: the sound
  // has to land on the footfall, not on a timer.
  stepPhase += avatar.currentSpeed * dt;
  const stride = avatar.gait === 'run' ? 1.5 : avatar.gait === 'sneak' ? 1.0 : 1.3;
  if (stepPhase < stride) return;
  stepPhase = 0;
  if (avatar.gait === 'sneak') return; // sneaking is the point of sneaking
  audio.step(avatar.position.x, avatar.position.z, { hard: avatar.gait === 'run' });
}

let groanTimer = 0;
function ambientGroans(dt) {
  groanTimer -= dt;
  if (groanTimer > 0) return;
  groanTimer = 0.5 + Math.random() * 1.4;

  // Pick the nearest few and let one of them speak, so a crowd is audible as a
  // crowd without every member being a voice.
  const h = horde.horde;
  let best = -1;
  let bestD2 = 26 * 26;
  for (let i = 0; i < h.count; i += 3) {
    if (h.state[i] === 4) continue;
    const dx = h.x[i] - camFocus.x;
    const dz = h.z[i] - camFocus.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  if (best >= 0) audio.groan(h.x[best], h.z[best], h.phase[best]);
}

/** The container the player is standing next to, if any. */
function nearbyContainer() {
  const t = avatar.tile();
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const found = loot.open(t.x + dx, t.z + dz, avatar.level);
    if (found) {
      loot.markSearched(t.x + dx, t.z + dz, avatar.level);
      return found;
    }
  }
  return null;
}

window.__knox = {
  world, town, renderer, isoCamera, loop, avatar, input, horde, combat,
  clock, moodles, hud, loot, panels, construction, siege, skills, audio,
  seed: WORLD_SEED,
  Save,
  saveNow: () => Save.save('slot1', Save.serialise(window.__knox)),
};
