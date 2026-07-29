import { describe, expect, it } from 'vitest';
import { Skills, SKILL, WEAPON_SKILL, XP, MAX_LEVEL, xpForLevel } from '../src/sim/Skills.js';
import { Audio } from '../src/audio/Audio.js';
import { serialise, restore, VERSION } from '../src/save/Save.js';
import { events } from '../src/core/Events.js';

describe('skills', () => {
  it('starts at zero across the board', () => {
    const s = new Skills();
    for (const id of Object.values(SKILL)) expect(s.level(id)).toBe(0);
  });

  it('makes the first levels quick and the last ones slow', () => {
    // A player who picks up an axe should feel it within one fight; a player
    // aiming at level 8 should be looking at weeks.
    const first = xpForLevel(1);
    const second = xpForLevel(2) - xpForLevel(1);
    const eighth = xpForLevel(8) - xpForLevel(7);
    expect(second).toBeGreaterThan(first);
    expect(eighth).toBeGreaterThan(second * 5);
  });

  it('levels up from doing the thing', () => {
    const s = new Skills();
    let levelled = false;
    const off = events.on('skill:levelled', () => (levelled = true));
    for (let i = 0; i < 20; i++) s.award(SKILL.BLADE, XP.kill);
    off();
    expect(s.level(SKILL.BLADE)).toBeGreaterThan(0);
    expect(levelled).toBe(true);
  });

  it('caps out rather than growing forever', () => {
    const s = new Skills();
    s.award(SKILL.BLUNT, 1e9);
    expect(s.level(SKILL.BLUNT)).toBe(MAX_LEVEL);
    expect(s.progress(SKILL.BLUNT)).toBe(1);
  });

  it('reports progress through the current level', () => {
    const s = new Skills();
    expect(s.progress(SKILL.BLUNT)).toBe(0);
    s.award(SKILL.BLUNT, xpForLevel(1) / 2);
    expect(s.progress(SKILL.BLUNT)).toBeGreaterThan(0.3);
    expect(s.progress(SKILL.BLUNT)).toBeLessThan(0.7);
  });

  it('ignores unknown skills instead of inventing them', () => {
    const s = new Skills();
    expect(s.award('telepathy', 100)).toBe(false);
    expect(s.xp.telepathy).toBeUndefined();
  });

  // --- every skill changes a number some other system reads --------------

  it('routes each weapon to the skill it trains', () => {
    expect(WEAPON_SKILL.axe).toBe(SKILL.BLADE);
    expect(WEAPON_SKILL.bat).toBe(SKILL.BLUNT);
    for (const id of Object.keys(WEAPON_SKILL)) {
      expect(Object.values(SKILL)).toContain(WEAPON_SKILL[id]);
    }
  });

  it('blade training does not improve a bat', () => {
    const s = new Skills();
    s.award(SKILL.BLADE, 1e6);
    expect(s.weaponDamage('axe')).toBeGreaterThan(1.5);
    expect(s.weaponDamage('bat')).toBe(1);
  });

  it('fitness makes exertion cheaper, sneaking makes you quieter', () => {
    const s = new Skills();
    expect(s.exertionCost).toBe(1);
    expect(s.noiseScale).toBe(1);
    s.award(SKILL.FITNESS, 1e6);
    s.award(SKILL.SNEAK, 1e6);
    expect(s.exertionCost).toBeLessThan(0.7);
    expect(s.noiseScale).toBeLessThan(0.6);
  });

  it('carpentry strengthens and speeds building', () => {
    const s = new Skills();
    s.award(SKILL.CARPENTRY, 1e6);
    expect(s.barricadeStrength).toBeGreaterThan(1.5);
    expect(s.buildSpeed).toBeGreaterThan(1.5);
  });

  it('scavenging and first aid scale their systems', () => {
    const s = new Skills();
    expect(s.scavengeBonus).toBe(0);
    s.award(SKILL.SCAVENGING, 1e6);
    s.award(SKILL.FIRSTAID, 1e6);
    expect(s.scavengeBonus).toBeGreaterThan(1);
    expect(s.firstAidQuality).toBeGreaterThan(1.4);
  });

  it('never lets a multiplier go to zero or below', () => {
    const s = new Skills();
    for (const id of Object.values(SKILL)) s.award(id, 1e9);
    expect(s.exertionCost).toBeGreaterThan(0);
    expect(s.noiseScale).toBeGreaterThan(0);
  });

  it('round-trips through JSON', () => {
    const s = new Skills();
    s.award(SKILL.BLUNT, 500);
    s.award(SKILL.CARPENTRY, 120);
    const copy = Skills.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(copy.level(SKILL.BLUNT)).toBe(s.level(SKILL.BLUNT));
    expect(copy.level(SKILL.CARPENTRY)).toBe(s.level(SKILL.CARPENTRY));
  });

  it('summarises only what it can explain', () => {
    const s = new Skills();
    for (const entry of s.summary()) {
      expect(entry.name).toBeTruthy();
      expect(entry.effect).toBeTruthy();
    }
  });
});

describe('audio', () => {
  it('does nothing at all before the context exists', () => {
    // Every browser refuses to start audio outside a user gesture, so all of
    // these must be safe to call from the moment the game boots.
    const a = new Audio();
    expect(a.ready).toBe(false);
    expect(() => {
      a.thud(1, 1);
      a.crack(1, 1);
      a.groan(1, 1, 0.5);
      a.step(1, 1);
      a.door(1, 1, true);
      a.hurt();
      a.hammer(1, 1);
    }).not.toThrow();
    expect(a.stats.played).toBe(0);
  });

  it('disables itself where there is no Web Audio at all', () => {
    const a = new Audio();
    a.resume();
    // Node has no AudioContext; the system must switch off rather than throw.
    expect(a.enabled).toBe(false);
    expect(a.ready).toBe(false);
  });

  it('clamps volume', () => {
    const a = new Audio();
    a.setVolume(5);
    expect(a.volume).toBe(1);
    a.setVolume(-3);
    expect(a.volume).toBe(0);
  });
});

describe('saving', () => {
  /** A stand-in game object with just the shape `serialise` reads. */
  function fakeGame() {
    const size = 8;
    const grid = {
      size,
      state: new Uint8Array(size),
      barricadeN: new Uint8Array(size),
      barricadeW: new Uint8Array(size),
      barricadeHpN: new Uint8Array(size),
      barricadeHpW: new Uint8Array(size),
      markAllDirty() {},
    };
    return {
      seed: 'test-seed',
      world: { grid, flushDirty() {} },
      avatar: {
        position: { x: 3, z: 4 },
        level: 1,
        yaw: 0.5,
        endurance: 0.6,
        weapon: { def: { id: 'axe' }, condition: 200 },
        torchOn: true,
        body: {
          health: new Float32Array([90, 80, 70, 60, 50, 40]),
          bleed: new Float32Array(6),
          fractured: new Uint8Array(6),
          pain: 12,
          infected: true,
          infection: 0.3,
          alive: true,
        },
        inventory: { items: [{ id: 'beans', count: 2, age: 0 }] },
      },
      clock: { elapsed: 12345 },
      moodles: { hunger: 0.4, thirst: 0.2, fatigue: 0.1, temperature: 0.5, panic: 0 },
      horde: { horde: { count: 3, state: new Uint8Array([4, 0, 4]) } },
      loot: { opened: new Map() },
      combat: { stats: { kills: 7 } },
      skills: new Skills(),
    };
  }

  it('stores the seed rather than the world', () => {
    const game = fakeGame();
    const snapshot = serialise(game);
    expect(snapshot.seed).toBe('test-seed');
    // A third of a million cells must not appear anywhere in the payload.
    const json = JSON.stringify(snapshot);
    expect(json.length).toBeLessThan(4000);
  });

  it('records only the cells that changed', () => {
    const game = fakeGame();
    game.world.grid.state[2] = 1;
    game.world.grid.barricadeN[5] = 3;
    game.world.grid.barricadeHpN[5] = 180;
    const snapshot = serialise(game);
    expect(snapshot.world.doors).toEqual([2, 1]);
    expect(snapshot.world.barricades).toEqual([5, 3, 180, 0, 0]);
  });

  it('records which of the dead are down', () => {
    const snapshot = serialise(fakeGame());
    expect(snapshot.world.dead).toEqual([0, 2]);
  });

  it('carries the player through faithfully', () => {
    const snapshot = serialise(fakeGame());
    expect(snapshot.player.weapon).toBe('axe');
    expect(snapshot.player.body.infected).toBe(true);
    expect(snapshot.player.inventory[0].id).toBe('beans');
    expect(snapshot.stats.kills).toBe(7);
  });

  it('does not save fog of war', () => {
    // Knowledge the player has, not state the world has — and storing it would
    // be a third of a million bytes to avoid a mild loss.
    const snapshot = serialise(fakeGame());
    expect(JSON.stringify(snapshot)).not.toContain('visib');
    expect(snapshot.world.fog).toBeUndefined();
  });

  it('refuses a snapshot from another version', () => {
    const game = fakeGame();
    const snapshot = serialise(game);
    snapshot.version = VERSION + 1;
    expect(restore(game, snapshot, {})).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(restore(fakeGame(), null, {})).toBe(false);
  });
});
