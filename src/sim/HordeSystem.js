/**
 * Wiring for the horde: bakes the clips, owns the crowd mesh, and drives the
 * flow field, the sound field and the AI at their own rates.
 *
 * Three different update rates, on purpose:
 *
 *   - **Sound** decays every simulation step. It is a per-tile subtract.
 *   - **AI** runs every step. It is a few hundred cheap state machines.
 *   - **The flow field** rebuilds only when the player has moved far enough for
 *     the old one to be misleading. A full sweep is the single most expensive
 *     thing here, and re-running it every tick would be paying for precision
 *     nobody can perceive — a zombie two hundred tiles away does not care that
 *     its target moved one tile.
 */
import { Mesh } from 'three';
import { Character } from '../entity/Character.js';
import { allocateInstances, bakeVat } from '../render/Vat.js';
import { createCrowdMaterial } from '../render/CrowdMaterial.js';
import { FlowField } from './FlowField.js';
import { SoundField } from './Sound.js';
import { Horde } from './Horde.js';
import { STOREY } from '../core/constants.js';
import { events } from '../core/Events.js';

/** Frames baked per clip. Short loops; the shader interpolates between rows. */
const CLIP_FRAMES = { shamble: 24, lunge: 18, idle: 16, attack: 14, fall: 18 };

/** How far the player must move before the flow field is rebuilt, in tiles. */
const REBUILD_DISTANCE = 3;
/** …or this long, whichever comes first, so opened doors eventually register. */
const REBUILD_INTERVAL = 1.5;

/** The dead are grey-green and drained; the palette reserves colour for meaning. */
const CORPSE_COLORS = {
  skin: 0x93a081,
  shirt: 0x5e645f,
  trousers: 0x4c4f54,
  hair: 0x35302b,
};

/**
 * Clip definitions. Each poses the shared `Character` rig at a normalised time,
 * so the dead are the same body as the living and there is only ever one pose
 * function to keep correct.
 *
 * @type {import('../render/Vat.js').VatClip[]}
 */
export const ZOMBIE_CLIPS = [
  {
    name: 'shamble',
    frames: CLIP_FRAMES.shamble,
    pose: (c, t) => {
      const phase = t * Math.PI * 2;
      c.applyPose(phase, 'shamble', 1);
      c.applyUndeadArms(0.25, phase);
    },
  },
  {
    name: 'lunge',
    frames: CLIP_FRAMES.lunge,
    pose: (c, t) => {
      const phase = t * Math.PI * 2;
      c.applyPose(phase, 'lunge', 1);
      c.applyUndeadArms(0.95, phase);
    },
  },
  {
    name: 'idle',
    frames: CLIP_FRAMES.idle,
    pose: (c, t) => {
      const phase = t * Math.PI * 2;
      // A standing zombie sways rather than stands still, so a crowd waiting in
      // a room never reads as a set of statues.
      c.applyPose(phase, 'shamble', 0.12);
      c.applyUndeadArms(0.12, phase * 0.5);
    },
  },
  {
    // Plays once. The reach peaks partway through rather than at the end, so
    // the moment the blow lands is visible and backing off during the windup
    // reads as having dodged something.
    name: 'attack',
    frames: CLIP_FRAMES.attack,
    pose: (c, t) => {
      const strike = Math.sin(Math.min(1, t * 1.5) * Math.PI);
      c.applyPose(0, 'shamble', 0.1);
      c.applyUndeadArms(0.55 + strike * 0.45, 0);
      c.hips.rotation.x = 0.1 + strike * 0.22;
      c.torso.rotation.y = strike * 0.18;
    },
  },
  {
    // Plays once and holds: a corpse stays down, so a street you cleared stays
    // visibly cleared. Collapse, not ragdoll — the rig has no physics and a
    // hand-shaped fall reads better than a wrong one.
    name: 'fall',
    frames: CLIP_FRAMES.fall,
    pose: (c, t) => {
      const e = t * t * (3 - 2 * t); // ease, so the drop accelerates
      c.applyPose(0, 'shamble', 0.06);
      c.applyUndeadArms(0.3 * (1 - e), 0);
      // Fold at the hips and sink, ending face down at floor level.
      c.hips.rotation.x = 0.12 + e * (Math.PI / 2 - 0.12);
      c.hips.position.y = 0.92 - e * 0.78;
      c.legL.rotation.x = -e * 0.5;
      c.legR.rotation.x = -e * 0.35;
      c.shinL.rotation.x = e * 0.6;
      c.shinR.rotation.x = e * 0.45;
      c.head.rotation.x = -e * 0.5;
    },
  },
];

export class HordeSystem {
  /**
   * @param {import('three').Scene} scene
   * @param {import('../world/World.js').World} world
   * @param {{ capacity?: number, seed?: string }} [opts]
   */
  constructor(scene, world, { capacity = 400, seed = 'horde' } = {}) {
    this.world = world;
    this.grid = world.grid;

    this.flow = new FlowField(this.grid, 0);
    this.sound = new SoundField(this.grid, 0);
    this.horde = new Horde(this.grid, this.flow, this.sound, { capacity, seed });

    this.vat = bakeVat(() => new Character(CORPSE_COLORS), ZOMBIE_CLIPS);
    this.instances = allocateInstances(this.vat.geometry, capacity);

    this.material = createCrowdMaterial({
      positionTexture: this.vat.positionTexture,
      normalTexture: this.vat.normalTexture,
      vertexCount: this.vat.vertexCount,
      frameCount: this.vat.frameCount,
      worldUniforms: world.uniforms,
      storeyHeight: STOREY,
    });

    this.mesh = new Mesh(this.vat.geometry, this.material);
    this.mesh.name = 'horde';
    this.mesh.frustumCulled = false; // positions live in a texture, not in bounds
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);

    this.clock = 0;
    this._sinceRebuild = REBUILD_INTERVAL;
    this._lastGoal = { x: -999, z: -999 };

    // Anything that makes a noise emits this; nothing needs to know the horde
    // exists in order to be heard by it.
    this._offNoise = events.on('noise:made', (e) => {
      if (e.level === this.sound.level) this.sound.emit(e.x, e.z, e.loudness);
    });

    this.stats = { instances: 0, rebuilds: 0 };
  }

  /** @param {number} n how many to scatter across the town */
  populate(n) {
    return this.horde.populate(n);
  }

  /**
   * @param {number} dt
   * @param {{x: number, z: number, level: number}} playerTile
   */
  update(dt, playerTile) {
    this.clock += dt;
    this.sound.update(dt);

    this._sinceRebuild += dt;
    const moved =
      Math.abs(playerTile.x - this._lastGoal.x) + Math.abs(playerTile.z - this._lastGoal.z);
    if (moved >= REBUILD_DISTANCE || this._sinceRebuild >= REBUILD_INTERVAL) {
      this.flow.build([{ x: playerTile.x, z: playerTile.z }]);
      this._lastGoal.x = playerTile.x;
      this._lastGoal.z = playerTile.z;
      this._sinceRebuild = 0;
      this.stats.rebuilds++;
    }

    this.horde.update(dt, playerTile);
  }

  /** Called from the render step, so animation is smooth at display rate. */
  render(elapsed) {
    this.material.userData.uniforms.uTime.value = elapsed;
    const n = this.horde.writeInstances(this.instances, this.vat.clips, elapsed);
    this.vat.geometry.instanceCount = n;
    this.stats.instances = n;
  }

  dispose() {
    this._offNoise();
    this.vat.positionTexture.dispose();
    this.vat.normalTexture.dispose();
    this.vat.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
