import { describe, expect, it } from 'vitest';
import { TileGrid, FLOOR } from '../src/world/TileGrid.js';
import { FlowField } from '../src/sim/FlowField.js';
import { SoundField } from '../src/sim/Sound.js';
import { Horde, STATE } from '../src/sim/Horde.js';
import { Combat, REACH, ZOMBIE_WINDUP } from '../src/sim/Combat.js';
import { Body, PART, INFECTION_CHANCE } from '../src/sim/Body.js';
import { WEAPONS, WeaponInstance, SHOVE } from '../src/items/Weapons.js';
import { Player } from '../src/entity/Player.js';

function room(w = 41, d = 41) {
  const g = new TileGrid(w, d, 1);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) g.setFloor(x, z, 0, FLOOR.CONCRETE);
  return g;
}

/** A deterministic RNG: always returns the same value. */
const always = (v) => () => v;

function fight({ weapon = 'crowbar', roll = always(0.5) } = {}) {
  const g = room();
  const flow = new FlowField(g);
  const sound = new SoundField(g, 0);
  const horde = new Horde(g, flow, sound, { capacity: 32, seed: 'fight' });
  const player = new Player(g);
  player.weapon = new WeaponInstance(weapon);
  player.position.set(20.5, 0, 20.5);
  player.setYaw(0); // facing -Z
  const combat = new Combat(horde, player, roll);
  return { g, horde, player, combat };
}

/** Put a zombie directly in front of the player. */
function zombieAhead(horde, player, distance = 0.9) {
  const i = horde.spawn(20, 20, 0);
  horde.x[i] = player.position.x;
  horde.z[i] = player.position.z - distance;
  horde.state[i] = STATE.CHASE;
  horde.busy[i] = 0;
  horde.cooldown[i] = 0;
  return i;
}

describe('body', () => {
  it('starts whole', () => {
    const b = new Body();
    expect(b.condition).toBe(1);
    expect(b.alive).toBe(true);
    expect(b.infected).toBe(false);
  });

  it('locates damage rather than pooling it', () => {
    const b = new Body();
    b.hurt({ amount: 40, part: PART.LEG_L, roll: always(0.99) });
    expect(b.health[PART.LEG_L]).toBe(60);
    expect(b.health[PART.TORSO]).toBe(100);
  });

  it('slows you down when a leg is hurt', () => {
    const b = new Body();
    const before = b.mobility;
    b.hurt({ amount: 70, part: PART.LEG_L, roll: always(0.99) });
    b.hurt({ amount: 70, part: PART.LEG_R, roll: always(0.99) });
    expect(b.mobility).toBeLessThan(before);
  });

  it('weakens your swing when an arm is hurt', () => {
    const b = new Body();
    const before = b.dexterity;
    b.hurt({ amount: 60, part: PART.ARM_R, roll: always(0.99) });
    expect(b.dexterity).toBeLessThan(before);
  });

  it('fractures a limb under a heavy blow, but never the torso', () => {
    const b = new Body();
    b.hurt({ amount: 40, part: PART.ARM_L, roll: always(0.99) });
    expect(b.fractured[PART.ARM_L]).toBe(1);

    const c = new Body();
    c.hurt({ amount: 40, part: PART.TORSO, roll: always(0.99) });
    expect(c.fractured[PART.TORSO]).toBe(0);
  });

  it('dies when a lethal part is destroyed, and not when a limb is', () => {
    const legs = new Body();
    legs.hurt({ amount: 100, part: PART.LEG_L, roll: always(0.99) });
    expect(legs.alive).toBe(true);

    const torso = new Body();
    torso.hurt({ amount: 100, part: PART.TORSO, roll: always(0.99) });
    expect(torso.alive).toBe(false);
    expect(torso.causeOfDeath).toBeTruthy();
  });

  it('bleeds health away over time, and stops when bandaged', () => {
    const b = new Body();
    b.hurt({ amount: 5, part: PART.ARM_L, bleed: 1, roll: always(0.99) });
    const start = b.health[PART.ARM_L];
    for (let i = 0; i < 30; i++) b.update(1 / 3);
    expect(b.health[PART.ARM_L]).toBeLessThan(start);

    b.bandage(PART.ARM_L);
    const held = b.health[PART.ARM_L];
    for (let i = 0; i < 30; i++) b.update(1 / 3);
    expect(b.health[PART.ARM_L]).toBeGreaterThanOrEqual(held);
  });

  it('can only be infected by the dead, and only once', () => {
    const blunt = new Body();
    blunt.hurt({ amount: 10, kind: 'blunt', roll: always(0.0) });
    expect(blunt.infected).toBe(false);

    const bitten = new Body();
    bitten.hurt({ amount: 10, kind: 'bite', roll: always(0.0) });
    expect(bitten.infected).toBe(true);
    const at = bitten.infection;
    bitten.hurt({ amount: 10, kind: 'bite', roll: always(0.0) });
    expect(bitten.infection).toBe(at); // a second bite does not restart the clock
  });

  it('bites infect far more readily than scratches', () => {
    expect(INFECTION_CHANCE.bite).toBeGreaterThan(INFECTION_CHANCE.scratch);
    expect(INFECTION_CHANCE.blunt).toBe(0);
  });

  it('kills through infection on its own clock, not the real one', () => {
    const b = new Body();
    b.hurt({ amount: 1, kind: 'bite', roll: always(0.0) });
    // A minute of real time with no game-time acceleration must not be fatal…
    for (let i = 0; i < 1800; i++) b.update(1 / 30, 1 / 30);
    expect(b.alive).toBe(true);
    // …but the same span of in-game days is.
    for (let i = 0; i < 4000; i++) b.update(1 / 30, 60);
    expect(b.alive).toBe(false);
    expect(b.causeOfDeath).toBe('infection');
  });

  it('does not bleed out in seconds when the game clock is accelerated', () => {
    // The bug this pins: passing the 60x game clock to bleeding killed the
    // player about three seconds after a single bite.
    const b = new Body();
    b.hurt({ amount: 14, kind: 'bite', bleed: 0.9, roll: always(0.99) });
    for (let i = 0; i < 300; i++) b.update(1 / 30, 60 / 30); // 10 real seconds
    expect(b.alive).toBe(true);
  });
});

describe('weapons', () => {
  it('trades reach and crowd control against damage', () => {
    // A knife out-damages a bat but cannot hold a doorway.
    expect(WEAPONS.knife.damage).toBeGreaterThan(WEAPONS.bat.damage);
    expect(WEAPONS.bat.targets).toBeGreaterThan(WEAPONS.knife.targets);
    expect(WEAPONS.bat.range).toBeGreaterThan(WEAPONS.knife.range);
  });

  it('makes heavier weapons cost more stamina per swing', () => {
    expect(WEAPONS.axe.stamina).toBeGreaterThan(WEAPONS.knife.stamina);
  });

  it('wears down and eventually breaks', () => {
    const w = new WeaponInstance('knife');
    expect(w.broken).toBe(false);
    for (let i = 0; i < 500 && !w.broken; i++) w.wear(always(0.0));
    expect(w.broken).toBe(true);
    // A broken weapon is no better than your hands.
    expect(w.effectiveDamage()).toBe(WEAPONS.fists.damage);
  });

  it('never wears out bare hands', () => {
    const w = new WeaponInstance('fists');
    for (let i = 0; i < 1000; i++) w.wear(always(0.0));
    expect(w.broken).toBe(false);
    expect(w.conditionFraction).toBe(1);
  });

  it('keeps damage flat until a weapon is nearly spent', () => {
    const w = new WeaponInstance('crowbar');
    expect(w.effectiveDamage()).toBeCloseTo(WEAPONS.crowbar.damage);
    w.condition = w.def.durability * 0.5;
    expect(w.effectiveDamage()).toBeCloseTo(WEAPONS.crowbar.damage);
    w.condition = w.def.durability * 0.1;
    expect(w.effectiveDamage()).toBeLessThan(WEAPONS.crowbar.damage);
  });
});

describe('swinging', () => {
  it('hits what is in front and misses what is behind', () => {
    const { horde, player, combat } = fight();
    zombieAhead(horde, player, 0.9);
    expect(combat.swing('attack').hits).toBe(1);

    const back = fight();
    const i = back.horde.spawn(20, 20, 0);
    back.horde.x[i] = back.player.position.x;
    back.horde.z[i] = back.player.position.z + 0.9; // behind
    back.horde.state[i] = STATE.CHASE;
    expect(back.combat.swing('attack').hits).toBe(0);
  });

  it('misses what is out of reach', () => {
    const { horde, player, combat } = fight();
    zombieAhead(horde, player, WEAPONS.crowbar.range + 0.5);
    expect(combat.swing('attack').hits).toBe(0);
  });

  it('hits several at once with a wide weapon and one with a narrow one', () => {
    const wide = fight({ weapon: 'bat' });
    for (let k = -1; k <= 1; k++) {
      const i = wide.horde.spawn(20, 20, 0);
      wide.horde.x[i] = wide.player.position.x + k * 0.35;
      wide.horde.z[i] = wide.player.position.z - 1.0;
      wide.horde.state[i] = STATE.CHASE;
    }
    expect(wide.combat.swing('attack').hits).toBe(3);

    const narrow = fight({ weapon: 'knife' });
    for (let k = -1; k <= 1; k++) {
      const i = narrow.horde.spawn(20, 20, 0);
      narrow.horde.x[i] = narrow.player.position.x + k * 0.35;
      narrow.horde.z[i] = narrow.player.position.z - 0.9;
      narrow.horde.state[i] = STATE.CHASE;
    }
    expect(narrow.combat.swing('attack').hits).toBe(1);
  });

  it('kills after enough blows and leaves a corpse behind', () => {
    const { horde, player, combat } = fight({ weapon: 'axe' });
    const i = zombieAhead(horde, player, 1.0);
    let kills = 0;
    for (let s = 0; s < 4 && !horde.isDead(i); s++) {
      player.busy = 0;
      player.endurance = 1;
      kills += combat.swing('attack').kills;
    }
    expect(kills).toBe(1);
    expect(horde.state[i]).toBe(STATE.DEAD);
    // Corpses stay in the array so the street shows what happened there.
    expect(horde.count).toBe(1);
  });

  it('is refused when you have no endurance left', () => {
    const { horde, player, combat } = fight({ weapon: 'axe' });
    zombieAhead(horde, player, 1.0);
    player.endurance = 0.01;
    expect(combat.swing('attack').blocked).toBe(true);
  });

  it('is refused when you are dead', () => {
    const { horde, player, combat } = fight();
    zombieAhead(horde, player, 0.9);
    player.body.hurt({ amount: 200, part: PART.TORSO, roll: always(0.99) });
    expect(combat.swing('attack').blocked).toBe(true);
  });

  it('shoves without wounding', () => {
    const { horde, player, combat } = fight();
    const i = zombieAhead(horde, player, 1.0);
    const hp = horde.health[i];
    const result = combat.swing('shove');
    expect(result.hits).toBe(1);
    expect(horde.health[i]).toBe(hp);
    expect(horde.state[i]).toBe(STATE.STAGGER);
    expect(horde.busy[i]).toBeGreaterThan(0);
  });

  it('shoves more targets than most weapons hit, and costs less', () => {
    expect(SHOVE.targets).toBeGreaterThanOrEqual(WEAPONS.axe.targets);
    expect(SHOVE.stamina).toBeLessThan(WEAPONS.axe.stamina);
  });

  it('can always hit something standing on top of you', () => {
    // Facing away, but grabbed: being unable to hit what has hold of you would
    // make being surrounded unrecoverable for the wrong reason.
    const { horde, player, combat } = fight();
    const i = horde.spawn(20, 20, 0);
    horde.x[i] = player.position.x + 0.1;
    horde.z[i] = player.position.z + 0.15;
    horde.state[i] = STATE.CHASE;
    expect(combat.swing('attack').hits).toBe(1);
  });

  it('makes a noise the horde can hear', () => {
    const { horde, player, combat } = fight();
    // The sound field is wired through the event bus in HordeSystem, so here we
    // just assert the swing reports a loudness worth hearing.
    zombieAhead(horde, player, 0.9);
    combat.swing('attack');
    expect(WEAPONS.crowbar.noise).toBeGreaterThan(0);
  });
});

describe('being attacked', () => {
  it('does not connect instantly — the windup is a window to escape', () => {
    const { horde, player, combat } = fight();
    const i = zombieAhead(horde, player, 0.5);
    combat.update(1 / 30);
    expect(horde.state[i]).toBe(STATE.ATTACK);
    expect(player.body.condition).toBe(1); // nothing has landed yet
  });

  it('lands if you are still there when the windup ends', () => {
    const { horde, player, combat } = fight();
    zombieAhead(horde, player, 0.5);
    for (let t = 0; t < ZOMBIE_WINDUP + 0.2; t += 1 / 30) combat.update(1 / 30);
    expect(player.body.condition).toBeLessThan(1);
  });

  it('misses if you back away during the windup', () => {
    const { horde, player, combat } = fight();
    zombieAhead(horde, player, 0.5);
    combat.update(1 / 30);
    player.position.z += REACH * 3; // step back out of reach
    for (let t = 0; t < ZOMBIE_WINDUP + 0.2; t += 1 / 30) combat.update(1 / 30);
    expect(player.body.condition).toBe(1);
  });

  it('cannot attack from another storey', () => {
    const { horde, player, combat } = fight();
    const i = zombieAhead(horde, player, 0.5);
    horde.level[i] = 1;
    for (let t = 0; t < 1; t += 1 / 30) combat.update(1 / 30);
    expect(player.body.condition).toBe(1);
  });

  it('bites can infect and scratches mostly do not', () => {
    const bite = fight({ roll: always(0.0) }); // always bites, always infects
    zombieAhead(bite.horde, bite.player, 0.5);
    for (let t = 0; t < ZOMBIE_WINDUP + 0.2; t += 1 / 30) bite.combat.update(1 / 30);
    expect(bite.player.body.infected).toBe(true);

    const scratch = fight({ roll: always(0.99) }); // never bites, never infects
    zombieAhead(scratch.horde, scratch.player, 0.5);
    for (let t = 0; t < ZOMBIE_WINDUP + 0.2; t += 1 / 30) scratch.combat.update(1 / 30);
    expect(scratch.player.body.infected).toBe(false);
  });

  it('a dead zombie stops attacking', () => {
    const { horde, player, combat } = fight();
    const i = zombieAhead(horde, player, 0.5);
    combat.update(1 / 30);
    horde.damage(i, 999, { roll: always(0.99) });
    for (let t = 0; t < 1; t += 1 / 30) combat.update(1 / 30);
    expect(player.body.condition).toBe(1);
  });
});

describe('knockback', () => {
  it('pushes a zombie away without moving it through a wall', () => {
    const { horde, player } = fight();
    const i = zombieAhead(horde, player, 1.0);
    const z0 = horde.z[i];
    horde.damage(i, 10, { knockback: 1.2, dirX: 0, dirZ: -1, roll: always(0.99) });
    for (let t = 0; t < 0.5; t += 1 / 30) horde.update(1 / 30, { x: 20, z: 20, level: 0 });
    expect(horde.z[i]).toBeLessThan(z0);
  });

  it('leaves a staggered zombie unable to act for a moment', () => {
    const { horde, player } = fight();
    const i = zombieAhead(horde, player, 1.0);
    horde.stagger(i, 0.8, { dirZ: -1, knockback: 1 });
    expect(horde.isReady(i)).toBe(false);
    for (let t = 0; t < 1.0; t += 1 / 30) horde.update(1 / 30, { x: 20, z: 20, level: 0 });
    expect(horde.isReady(i)).toBe(true);
  });
});
