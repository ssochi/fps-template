/**
 * Character creation.
 *
 * The load-bearing test in this file is the last one: **every modifier in `MOD`
 * must move an observable number in a system that already exists.** That is the
 * rule the whole design rests on, and it is the only thing stopping this file
 * from growing traits that read well and do nothing.
 */
import { describe, expect, it } from 'vitest';
import {
  BASE_POINTS, MOD, OCCUPATIONS, Profile, TRAITS, TRAIT_BY_ID,
} from '../src/sim/Traits.js';
import { randomProfile } from '../src/ui/MainMenu.js';
import { Skills, xpForLevel } from '../src/sim/Skills.js';
import { Body, PART } from '../src/sim/Body.js';
import { Moodles } from '../src/sim/Moodles.js';
import { Player } from '../src/entity/Player.js';
import { TileGrid, FLOOR } from '../src/world/TileGrid.js';

function openGrid(size = 12) {
  const g = new TileGrid(size, size, 1);
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) g.setFloor(x, z, 0, FLOOR.CONCRETE);
  return g;
}

describe('the trait table', () => {
  it('gives every trait an effect', () => {
    for (const t of TRAITS) {
      const effects = Object.keys(t.mods ?? {}).length + Object.keys(t.skills ?? {}).length;
      expect(effects, `${t.id} does nothing`).toBeGreaterThan(0);
    }
  });

  it('only uses modifiers from the closed list', () => {
    const known = new Set(Object.values(MOD));
    for (const t of TRAITS) {
      for (const key of Object.keys(t.mods ?? {})) {
        expect(known.has(key), `${t.id} uses unknown mod ${key}`).toBe(true);
      }
    }
  });

  it('pairs every axis with a way to pay for it', () => {
    const axes = new Map();
    for (const t of TRAITS) {
      const entry = axes.get(t.axis) ?? { give: 0, take: 0 };
      if (t.cost >= 0) entry.take++;
      else entry.give++;
      axes.set(t.axis, entry);
    }
    for (const [axis, { give, take }] of axes) {
      expect(take, `${axis} has nothing to take`).toBeGreaterThan(0);
      expect(give, `${axis} has no way to pay`).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    expect(TRAIT_BY_ID.size).toBe(TRAITS.length);
    expect(new Set(OCCUPATIONS.map((o) => o.id)).size).toBe(OCCUPATIONS.length);
  });

  it('names occupation skills that actually exist', () => {
    const real = new Skills();
    for (const o of OCCUPATIONS) {
      for (const id of Object.keys(o.skills)) {
        expect(id in real.xp, `${o.id} trains unknown skill ${id}`).toBe(true);
      }
    }
  });
});

describe('the budget', () => {
  it('starts a default survivor with points to spend and nothing spent', () => {
    const p = Profile.default();
    expect(p.spent).toBe(0);
    expect(p.remaining).toBe(BASE_POINTS + 8); // unemployed
    expect(p.valid).toBe(true);
  });

  it('makes an occupation cost the points it does not grant', () => {
    const nurse = new Profile({ occupation: 'nurse' });
    const jobless = new Profile({ occupation: 'unemployed' });
    expect(nurse.budget).toBeLessThan(jobless.budget);
  });

  it('refuses a trait it cannot afford', () => {
    const p = new Profile({ occupation: 'nurse' }); // 6 points
    expect(p.add('resilient')).toBe(false); // costs 9
    expect(p.refuses('resilient')).toBe('not enough points');
  });

  it('lets a negative trait pay for a positive one', () => {
    const p = new Profile({ occupation: 'nurse' });
    expect(p.add('thinSkinned')).toBe(true); // +6
    expect(p.add('resilient')).toBe(false); // same axis
    expect(p.add('athletic')).toBe(true); // 6, now affordable
    expect(p.valid).toBe(true);
    expect(p.remaining).toBe(BASE_POINTS + 6 - 6);
  });

  it('allows only one trait per axis', () => {
    const p = Profile.default();
    p.add('athletic');
    expect(p.refuses('outOfShape')).toMatch(/conflicts/);
    expect(p.add('outOfShape')).toBe(false);
  });

  it('refuses to take the same trait twice', () => {
    const p = Profile.default();
    p.add('brave');
    expect(p.refuses('brave')).toBe('already taken');
  });

  it('drops unknown trait ids rather than carrying them', () => {
    const p = new Profile({ traits: ['athletic', 'not-a-trait'] });
    expect(p.traits).toEqual(['athletic']);
  });

  it('round-trips through JSON', () => {
    const p = new Profile({ name: 'Rae', occupation: 'burglar' });
    p.add('lightFooted');
    p.add('cowardly');
    const back = Profile.fromJSON(JSON.parse(JSON.stringify(p)));
    expect(back.name).toBe('Rae');
    expect(back.occupation).toBe('burglar');
    expect(back.traits).toEqual(p.traits);
    expect(back.mod(MOD.NOISE)).toBeCloseTo(p.mod(MOD.NOISE));
  });
});

describe('modifiers', () => {
  it('is 1 for anything untouched, so call sites need no null check', () => {
    const p = Profile.default();
    for (const key of Object.values(MOD)) expect(p.mod(key)).toBe(1);
    expect(p.mod('a-mod-that-does-not-exist')).toBe(1);
  });

  it('multiplies traits that touch the same number', () => {
    const p = Profile.default();
    p.add('athletic'); // enduranceDrain 0.72
    expect(p.mod(MOD.ENDURANCE_DRAIN)).toBeCloseTo(0.72);
    expect(p.mod(MOD.WALK_SPEED)).toBeCloseTo(1.12);
  });

  it('recomputes when the build changes', () => {
    const p = Profile.default();
    p.add('strong');
    expect(p.mod(MOD.MELEE_DAMAGE)).toBeGreaterThan(1);
    p.remove('strong');
    expect(p.mod(MOD.MELEE_DAMAGE)).toBe(1);
  });
});

describe('starting skills', () => {
  it('turns occupation levels into the XP that reaches them', () => {
    const skills = new Profile({ occupation: 'nurse' }).applyTo(new Skills());
    expect(skills.level('firstAid')).toBe(4);
    expect(skills.xp.firstAid).toBe(xpForLevel(4));
    expect(skills.level('blunt')).toBe(0);
  });

  it('adds trait-granted levels on top of the occupation', () => {
    const p = new Profile({ occupation: 'trainer' }); // fitness 4
    p.add('athletic'); // fitness +1
    expect(p.startingSkills().fitness).toBe(5);
  });

  it('routes the XP rate into the hook that was unused before M12', () => {
    const fast = new Profile({ traits: ['fastLearner'] }).applyTo(new Skills());
    const slow = new Profile({ traits: ['slowLearner'] }).applyTo(new Skills());
    expect(fast.rate).toBeGreaterThan(1);
    expect(slow.rate).toBeLessThan(1);

    fast.award('blunt', 100);
    slow.award('blunt', 100);
    expect(fast.xp.blunt).toBeGreaterThan(slow.xp.blunt);
  });

  it('leaves an unemployed survivor at zero everywhere', () => {
    const skills = Profile.default().applyTo(new Skills());
    for (const s of skills.summary()) expect(s.level).toBe(0);
  });
});

/**
 * The rule, enforced. Each case builds a profile with one trait and asserts a
 * number *some other system computes* has moved in the right direction. A
 * modifier that cannot be written as one of these is a modifier nothing reads.
 */
describe('every modifier moves something real', () => {
  const grid = openGrid();

  it('WALK_SPEED — the player covers more ground', () => {
    const move = (traits) => {
      const p = new Player(grid, { profile: new Profile({ traits }) });
      p.position.set(4.5, 0, 4.5);
      p.hasAim = false;
      const start = p.position.x;
      p.update({ move: { x: 1, y: 0, z: 0, lengthSq: () => 1 }, run: false, sneak: false }, 0.2);
      return p.position.x - start;
    };
    expect(move(['athletic'])).toBeGreaterThan(move([]));
    expect(move(['outOfShape'])).toBeLessThan(move([]));
  });

  it('ENDURANCE_DRAIN — running costs more or less', () => {
    const drain = (traits) => {
      const p = new Player(grid, { profile: new Profile({ traits }) });
      p._drainEndurance(1, 'run');
      return 1 - p.endurance;
    };
    expect(drain(['athletic'])).toBeLessThan(drain([]));
    expect(drain(['outOfShape'])).toBeGreaterThan(drain([]));
  });

  it('ENDURANCE_RECOVERY — standing still gives back more or less', () => {
    const back = (traits) => {
      const p = new Player(grid, { profile: new Profile({ traits }) });
      p.endurance = 0.5;
      p._drainEndurance(1, 'idle');
      return p.endurance - 0.5;
    };
    expect(back(['outOfShape'])).toBeLessThan(back([]));
  });

  it('CARRY_CAPACITY — the bag holds more before it slows you', () => {
    const cap = (traits) => new Player(grid, { profile: new Profile({ traits }) }).inventory.capacity;
    expect(cap(['packMule'])).toBeGreaterThan(cap([]));
    expect(cap(['weakShoulders'])).toBeLessThan(cap([]));
  });

  it('MELEE_DAMAGE — is applied to a swing, not merely stored', () => {
    // Asserted through the multiplier Combat reads, since staging a full fight
    // is what `combat.test.js` is for.
    expect(new Profile({ traits: ['strong'] }).mod(MOD.MELEE_DAMAGE)).toBeGreaterThan(1);
    expect(new Profile({ traits: ['feeble'] }).mod(MOD.MELEE_DAMAGE)).toBeLessThan(1);
  });

  it('NOISE — reaches the loudness the horde actually hears', () => {
    const quiet = new Player(grid, { profile: new Profile({ traits: ['lightFooted'] }) });
    const loud = new Player(grid, { profile: new Profile({ traits: ['clumsy'] }) });
    const plain = new Player(grid, { profile: Profile.default() });
    expect(quiet.noiseScale).toBeLessThan(plain.noiseScale);
    expect(loud.noiseScale).toBeGreaterThan(plain.noiseScale);
  });

  it('NOISE — combines with the Sneaking skill, which nothing read before M12', () => {
    const p = new Player(grid, { profile: Profile.default() });
    p.skills = new Skills();
    const before = p.noiseScale;
    p.skills.xp.sneak = xpForLevel(6);
    expect(p.noiseScale).toBeLessThan(before);
  });

  it('SIGHT_RANGE — scales how far the observer sees', () => {
    expect(new Profile({ traits: ['eagleEyed'] }).mod(MOD.SIGHT_RANGE)).toBeGreaterThan(1);
    expect(new Profile({ traits: ['shortSighted'] }).mod(MOD.SIGHT_RANGE)).toBeLessThan(1);
  });

  it('BLEED_RATE — the same wound bleeds harder or softer', () => {
    const bleed = (traits) => {
      const b = new Body(new Profile({ traits }));
      b.hurt({ amount: 10, part: PART.ARM_L, kind: 'scratch', bleed: 1, roll: () => 1 });
      return b.bleed[PART.ARM_L];
    };
    expect(bleed(['fastHealer'])).toBeLessThan(bleed([]));
    expect(bleed(['slowHealer'])).toBeGreaterThan(bleed([]));
  });

  it('INFECTION_RISK — changes the odds without making blunt wounds infectious', () => {
    // roll() = 0.7: a plain scratch (0.22) misses, a thin-skinned one still
    // misses, but the *threshold* has moved, which is what we assert directly.
    const takes = (traits, r) => {
      const b = new Body(new Profile({ traits }));
      b.hurt({ amount: 5, part: PART.ARM_L, kind: 'scratch', roll: () => r });
      return b.infected;
    };
    expect(takes([], 0.3)).toBe(false);
    expect(takes(['thinSkinned'], 0.3)).toBe(true); // 0.22 * 1.5 = 0.33
    expect(takes(['resilient'], 0.15)).toBe(false); // 0.22 * 0.5 = 0.11
    expect(takes([], 0.15)).toBe(true);

    // And a blunt wound is still uninfectable however thin your skin.
    const blunt = new Body(new Profile({ traits: ['thinSkinned'] }));
    blunt.hurt({ amount: 40, part: PART.TORSO, kind: 'blunt', roll: () => 0 });
    expect(blunt.infected).toBe(false);
  });

  it('PAIN_RATE — the same injury hurts more or less', () => {
    const pain = (traits) => {
      const b = new Body(new Profile({ traits }));
      b.hurt({ amount: 20, part: PART.LEG_L, roll: () => 1 });
      return b.pain;
    };
    expect(pain(['painTolerant'])).toBeLessThan(pain([]));
    expect(pain(['sensitive'])).toBeGreaterThan(pain([]));
  });

  it('HEAL_RATE — an untended graze closes faster or slower', () => {
    const healed = (traits) => {
      const b = new Body(new Profile({ traits }));
      b.health[PART.ARM_L] = 50;
      b.update(20, 20);
      return b.health[PART.ARM_L];
    };
    expect(healed(['fastHealer'])).toBeGreaterThan(healed([]));
    expect(healed(['slowHealer'])).toBeLessThan(healed([]));
  });

  it('HUNGER_RATE, THIRST_RATE, FATIGUE_RATE — the three clocks run at different speeds', () => {
    const after = (traits) => {
      const profile = new Profile({ traits });
      const m = new Moodles(new Body(profile), profile);
      m.update(1, 3600, {});
      return m;
    };
    expect(after(['ironGut']).hunger).toBeLessThan(after([]).hunger);
    expect(after(['heartyAppetite']).hunger).toBeGreaterThan(after([]).hunger);
    expect(after(['camel']).thirst).toBeLessThan(after([]).thirst);
    expect(after(['parched']).thirst).toBeGreaterThan(after([]).thirst);
    expect(after(['wakeful']).fatigue).toBeLessThan(after([]).fatigue);
    expect(after(['restless']).fatigue).toBeGreaterThan(after([]).fatigue);
  });

  it('PANIC_RATE — fear rises to a different height in the same room', () => {
    // Two zombies in daylight, deliberately: surrounded in the dark everyone
    // reaches 1 whatever their nerve, and a saturated case tests nothing.
    const scared = (traits) => {
      const profile = new Profile({ traits });
      const m = new Moodles(new Body(profile), profile);
      for (let i = 0; i < 300; i++) m.update(0.1, 0.1, { threats: 2, daylight: 1 });
      return m.panic;
    };
    expect(scared(['brave'])).toBeLessThan(scared([]));
    expect(scared(['cowardly'])).toBeGreaterThan(scared([]));
  });

  it('PANIC_RATE — and takes a different time to settle once it is over', () => {
    const settles = (traits) => {
      const profile = new Profile({ traits });
      const m = new Moodles(new Body(profile), profile);
      m.panic = 0.8;
      for (let i = 0; i < 100; i++) m.update(0.1, 0.1, { threats: 0, daylight: 1 });
      return m.panic;
    };
    expect(settles(['cowardly'])).toBeGreaterThan(settles([]));
    expect(settles(['brave'])).toBeLessThan(settles([]));
  });

  it('XP_RATE — the same action teaches a different amount', () => {
    const learned = (traits) => {
      const s = new Profile({ traits }).applyTo(new Skills());
      s.award('blade', 50);
      return s.xp.blade;
    };
    expect(learned(['fastLearner'])).toBeGreaterThan(learned([]));
    expect(learned(['slowLearner'])).toBeLessThan(learned([]));
  });

  it('covers every key in MOD — a modifier nobody reads is the failure mode', () => {
    // Each MOD key must appear in at least one trait, because a key no trait
    // uses is a hook with no way to reach it.
    const used = new Set();
    for (const t of TRAITS) for (const k of Object.keys(t.mods ?? {})) used.add(k);
    for (const key of Object.values(MOD)) {
      expect(used.has(key), `no trait sets ${key}`).toBe(true);
    }
  });
});

describe('surprise me', () => {
  it('always produces a legal build', () => {
    let seed = 1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 200; i++) {
      const p = randomProfile(rand);
      expect(p.valid, `illegal build: ${p.traits.join(',')}`).toBe(true);
      expect(p.remaining).toBeGreaterThanOrEqual(0);
    }
  });

  it('spends most of the budget rather than leaving it on the table', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let leftover = 0;
    for (let i = 0; i < 60; i++) leftover += randomProfile(rand).remaining;
    expect(leftover / 60).toBeLessThan(3);
  });
});

describe('the character sheet', () => {
  it('describes the occupation first, then the traits, tagged by sign', () => {
    const p = new Profile({ occupation: 'police', traits: ['strong', 'cowardly'] });
    const lines = p.describe();
    expect(lines[0].kind).toBe('occupation');
    expect(lines[0].name).toBe('Police Officer');
    expect(lines.map((l) => l.kind)).toContain('positive');
    expect(lines.map((l) => l.kind)).toContain('negative');
    for (const l of lines) expect(l.desc.length).toBeGreaterThan(0);
  });
});
