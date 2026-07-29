/**
 * M14 — localisation.
 *
 * The load-bearing test here is the coverage one: every id in every data table
 * a player reads must have a Chinese string. A game that is *mostly* translated
 * is worse than one that is not, because the gaps look like bugs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { detectLanguage, setLanguage, t, TABLES, has } from '../src/ui/i18n.js';
import { OCCUPATIONS, TRAITS } from '../src/sim/Traits.js';
import { SKILL, SKILL_INFO } from '../src/sim/Skills.js';
import { ITEMS, Item } from '../src/items/ItemDb.js';
import { RECIPES } from '../src/items/Recipes.js';
import { WEAPONS } from '../src/items/Weapons.js';
import { TIERS } from '../src/sim/Moodles.js';
import { POPULATIONS } from '../src/ui/MainMenu.js';
import { Clock } from '../src/core/Clock.js';

afterEach(() => setLanguage('en'));

describe('lookup', () => {
  it('falls back to readable English rather than to the key', () => {
    setLanguage('en');
    expect(t('nothing.here', 'Some English')).toBe('Some English');
    expect(t('nothing.here')).toBe('nothing.here');
  });

  it('returns the translation when there is one', () => {
    setLanguage('zh');
    expect(t('menu.begin', 'Begin')).toBe('开始');
  });

  it('substitutes into either language', () => {
    setLanguage('en');
    expect(t('x', 'Hello {who}', { who: 'Rae' })).toBe('Hello Rae');
    setLanguage('zh');
    expect(t('death.days', '{n} days', { n: 4 })).toContain('4');
  });

  it('ignores an unknown language rather than blanking the interface', () => {
    expect(setLanguage('kl')).toBe('en');
    expect(t('menu.begin', 'Begin')).toBe('Begin');
  });
});

describe('detection', () => {
  it('honours ?lang= above everything', () => {
    expect(detectLanguage('?lang=zh', ['en-GB'])).toBe('zh');
    expect(detectLanguage('?lang=en', ['zh-CN'])).toBe('en');
  });

  it('takes any variety of Chinese from the browser', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hant', 'ZH-hk']) {
      expect(detectLanguage('', [tag]), tag).toBe('zh');
    }
  });

  it('defaults to English for anything else', () => {
    expect(detectLanguage('', ['en-US', 'fr'])).toBe('en');
    expect(detectLanguage('', [])).toBe('en');
  });
});

/**
 * The rule: if a player can read it, it is translated. Each case walks a real
 * data table rather than a hand-written list of keys, so adding an item or a
 * trait without translating it fails here instead of shipping.
 */
describe('coverage of everything a player reads', () => {
  const missing = (keys) => {
    setLanguage('zh');
    return keys.filter((k) => !has(k));
  };

  it('translates every trait, name and description', () => {
    const keys = TRAITS.flatMap((tr) => [`trait.${tr.id}`, `trait.${tr.id}.desc`]);
    expect(missing(keys)).toEqual([]);
  });

  it('translates every occupation', () => {
    const keys = OCCUPATIONS.flatMap((o) => [`job.${o.id}`, `job.${o.id}.desc`]);
    expect(missing(keys)).toEqual([]);
  });

  it('translates every skill and what it does', () => {
    const keys = Object.values(SKILL).flatMap((id) => [`skill.${id}`, `skill.${id}.effect`]);
    expect(missing(keys)).toEqual([]);
    expect(Object.keys(SKILL_INFO).length).toBe(Object.values(SKILL).length);
  });

  it('translates every item', () => {
    expect(missing(Object.keys(ITEMS).map((id) => `item.${id}`))).toEqual([]);
  });

  it('translates every weapon', () => {
    expect(missing(Object.keys(WEAPONS).map((id) => `weapon.${id}`))).toEqual([]);
  });

  it('translates every recipe', () => {
    expect(missing(RECIPES.map((r) => `recipe.${r.id}`))).toEqual([]);
  });

  it('translates every moodle tier that is ever shown', () => {
    const keys = [];
    for (const [id, tiers] of Object.entries(TIERS)) {
      for (let tier = 1; tier < tiers.length; tier++) keys.push(`moodle.${id}.${tier}`);
    }
    expect(missing(keys)).toEqual([]);
  });

  it('translates every population setting', () => {
    const keys = POPULATIONS.flatMap((p) => [`population.${p.id}`, `population.${p.id}.desc`]);
    expect(missing(keys)).toEqual([]);
  });

  it('translates every cause of death', () => {
    const keys = ['wounds', 'injuries', 'bloodloss', 'infection', 'starvation', 'dehydration']
      .map((k) => `death.${k}`);
    expect(missing(keys)).toEqual([]);
  });

  it('has no blank strings anywhere', () => {
    for (const [lang, table] of Object.entries(TABLES)) {
      for (const [key, value] of Object.entries(table)) {
        expect(value.trim().length, `${lang}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('things that use the lookup', () => {
  it('labels an item in the chosen language', () => {
    setLanguage('zh');
    expect(new Item('water').label()).toBe('瓶装水');
    setLanguage('en');
    expect(new Item('water').label()).toBe('bottled water');
  });

  it('keeps the count and the spoilage marker when translated', () => {
    setLanguage('zh');
    const stack = new Item('bandage', 3);
    expect(stack.label()).toContain('×3');

    const bread = new Item('bread');
    bread.age = 1e5;
    expect(bread.spoiled).toBe(true);
    expect(bread.label()).toContain('腐坏');
  });

  it('formats the clock in the chosen language', () => {
    const clock = new Clock({ hour: 14, day: 2 });
    setLanguage('zh');
    const zh = clock.format();
    expect(zh).toContain('14:');
    expect(zh).toContain('第');
    setLanguage('en');
    expect(clock.format()).toContain('Day 3');
  });

  it('never leaks a lookup key into a label', () => {
    // The failure mode a fallback exists to prevent: a player seeing
    // `item.water` where a name should be.
    for (const lang of ['zh', 'en']) {
      setLanguage(lang);
      for (const id of Object.keys(ITEMS)) {
        expect(new Item(id).label(), `${lang}:${id}`).not.toContain('item.');
      }
    }
  });
});
