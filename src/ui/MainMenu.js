/**
 * The main menu and character creation.
 *
 * ## Why this exists now
 *
 * Save/load has been implemented since M10 and reachable only from the debug
 * console — there was no surface for it because there was no screen before the
 * game. This is that screen, and character creation is what makes it worth
 * having: the first thing a survival run should ask you is who you are.
 *
 * ## The screen is the trade, not the list
 *
 * The point of creation is the *budget*, so the point counter is the largest
 * thing on the page and it turns red the moment a build stops being legal.
 * Traits are shown as two columns — what you gain and what you pay with — so
 * that the shape of the decision is visible without reading any of the text.
 * A negative trait is not a punishment section; it is the currency column.
 *
 * DOM rather than canvas, for the same reason the HUD is: text layout, hover
 * states and scrolling are solved problems and re-solving them in WebGL buys
 * nothing at all.
 */
import { OCCUPATIONS, Profile, TRAITS } from '../sim/Traits.js';

export class MainMenu {
  /**
   * @param {object} [opts]
   * @param {HTMLElement} [opts.root]
   * @param {boolean} [opts.hasSave] whether Continue should be offered
   */
  constructor({ root = document.body, hasSave = false } = {}) {
    this.profile = Profile.default();
    this.hasSave = hasSave;
    /** 'title' | 'create' */
    this.screen = 'title';
    /** Resolved with { action, profile, seed }. */
    this._resolve = null;
    this.seed = 'knox-county';

    const el = document.createElement('div');
    el.id = 'menu';
    root.appendChild(el);
    this.el = el;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    el.addEventListener('click', (e) => this._onClick(e));
    el.addEventListener('input', (e) => this._onInput(e));
    this.render();
  }

  /** @returns {Promise<{ action: string, profile: Profile, seed: string }>} */
  waitForStart() {
    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  dismiss() {
    this.el.remove();
  }

  // --- interaction -------------------------------------------------------

  _onInput(e) {
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (t.dataset.field === 'name') this.profile.name = t.value.slice(0, 24) || 'Survivor';
    else if (t.dataset.field === 'seed') this.seed = t.value || 'knox-county';
  }

  _onClick(e) {
    const el = /** @type {HTMLElement} */ (e.target).closest('[data-act]');
    if (!el) return;
    const { act, id } = el.dataset;

    if (act === 'new') this.screen = 'create';
    else if (act === 'back') this.screen = 'title';
    else if (act === 'occupation') {
      this.profile.occupation = id;
      // Changing job can shrink the budget below what is already spent, so drop
      // traits from the end until the build is legal again rather than silently
      // leaving an illegal one that the Begin button refuses to explain.
      while (!this.profile.valid && this.profile.traits.length) {
        this.profile.remove(this.profile.traits[this.profile.traits.length - 1]);
      }
    } else if (act === 'trait') this.profile.toggle(id);
    else if (act === 'random') this.profile = randomProfile();
    else if (act === 'clear') this.profile = new Profile({ name: this.profile.name });
    else if (act === 'begin') {
      if (!this.profile.valid) return;
      this._finish('new');
      return;
    } else if (act === 'continue') {
      this._finish('continue');
      return;
    }
    this.render();
  }

  _finish(action) {
    this.dismiss();
    this._resolve?.({ action, profile: this.profile, seed: this.seed });
    this._resolve = null;
  }

  // --- rendering ---------------------------------------------------------

  render() {
    this.el.innerHTML = this.screen === 'title' ? this._title() : this._create();
  }

  _title() {
    return `
      <div class="m-title">
        <h1>KNOX</h1>
        <p class="m-tag">This is how you died.</p>
        <div class="m-actions">
          <button data-act="new" class="m-big">New Survivor</button>
          <button data-act="continue" class="m-big" ${this.hasSave ? '' : 'disabled'}>
            ${this.hasSave ? 'Continue' : 'No Save'}
          </button>
        </div>
        <label class="m-seed">Town seed
          <input data-field="seed" value="${esc(this.seed)}" spellcheck="false" />
        </label>
      </div>`;
  }

  _create() {
    const p = this.profile;
    const left = p.remaining;
    const state = !p.valid ? 'bad' : left === 0 ? 'exact' : 'ok';

    const jobs = OCCUPATIONS.map((o) => `
      <button class="m-job ${o.id === p.occupation ? 'on' : ''}" data-act="occupation" data-id="${o.id}">
        <span class="m-job-name">${o.name}</span>
        ${o.points ? `<span class="m-pts">+${o.points}</span>` : ''}
        <span class="m-job-desc">${o.desc}</span>
        <span class="m-job-skills">${describeSkills(o.skills)}</span>
      </button>`).join('');

    const column = (positive) => TRAITS
      .filter((t) => (positive ? t.cost >= 0 : t.cost < 0))
      .map((t) => {
        const taken = p.traits.includes(t.id);
        const why = taken ? null : p.refuses(t.id);
        return `
        <button class="m-trait ${positive ? 'pos' : 'neg'} ${taken ? 'on' : ''} ${why ? 'off' : ''}"
                data-act="trait" data-id="${t.id}" title="${esc(why ?? t.desc)}">
          <span class="m-trait-cost">${t.cost > 0 ? t.cost : `+${-t.cost}`}</span>
          <span class="m-trait-name">${t.name}</span>
          <span class="m-trait-desc">${t.desc}</span>
        </button>`;
      }).join('');

    return `
      <div class="m-create">
        <header>
          <input data-field="name" class="m-name" value="${esc(p.name)}"
                 spellcheck="false" maxlength="24" />
          <div class="m-budget ${state}">
            <strong>${left}</strong><span>point${left === 1 ? '' : 's'} left</span>
          </div>
          <div class="m-head-actions">
            <button data-act="random">Surprise Me</button>
            <button data-act="clear">Clear</button>
            <button data-act="back">Back</button>
          </div>
        </header>

        <section class="m-jobs">
          <h2>Occupation</h2>
          <div class="m-job-grid">${jobs}</div>
        </section>

        <section class="m-traits">
          <div>
            <h2>Take <em>costs points</em></h2>
            <div class="m-trait-list">${column(true)}</div>
          </div>
          <div>
            <h2>Give <em>earns points</em></h2>
            <div class="m-trait-list">${column(false)}</div>
          </div>
        </section>

        <footer>
          <p class="m-summary">${p.describe().map((d) => d.name).join(' · ')}</p>
          <button data-act="begin" class="m-big" ${p.valid ? '' : 'disabled'}>
            ${p.valid ? 'Begin' : 'Over budget'}
          </button>
        </footer>
      </div>`;
  }
}

/**
 * A legal random build. Spends the negatives first so there is something to
 * spend, which is also the order a player who knows the game picks in.
 */
export function randomProfile(rand = Math.random) {
  const job = OCCUPATIONS[Math.floor(rand() * OCCUPATIONS.length)];
  const profile = new Profile({ name: 'Survivor', occupation: job.id });
  const pool = (positive) => TRAITS.filter((t) => (positive ? t.cost >= 0 : t.cost < 0))
    .map((t) => ({ t, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.t);

  for (const t of pool(false).slice(0, 2 + Math.floor(rand() * 2))) profile.add(t.id);
  for (const t of pool(true)) if (profile.remaining >= t.cost) profile.add(t.id);
  return profile;
}

function describeSkills(skills) {
  const parts = Object.entries(skills).map(([id, level]) => `${id} ${level}`);
  return parts.length ? parts.join(', ') : 'no training';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const CSS = `
#menu {
  position: fixed; inset: 0; z-index: 40;
  background: radial-gradient(120% 90% at 50% 20%, #16202c 0%, #080b10 70%);
  color: #cdd6e0; font: 13px/1.45 system-ui, sans-serif;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}
#menu button { font: inherit; color: inherit; cursor: pointer; }
#menu button[disabled] { cursor: default; opacity: .4; }

.m-title { text-align: center; }
.m-title h1 {
  font-size: 76px; letter-spacing: .34em; margin: 0 0 4px -.34em;
  font-weight: 300; color: #e8eef5;
}
.m-tag { margin: 0 0 40px; color: #6f7d8c; letter-spacing: .22em; text-transform: uppercase; }
.m-actions { display: flex; gap: 12px; justify-content: center; }
.m-big {
  padding: 13px 30px; background: #22303f; border: 1px solid #3c5064;
  border-radius: 3px; letter-spacing: .1em; text-transform: uppercase;
}
.m-big:hover:not([disabled]) { background: #2e4055; border-color: #5b7691; }
.m-seed { display: block; margin-top: 34px; color: #6f7d8c; font-size: 11px; }
#menu input {
  background: #10161e; border: 1px solid #2b3846; color: #cdd6e0;
  border-radius: 3px; padding: 6px 9px; font: inherit; margin-left: 8px;
}

/*
 * The budget counter is the screen. It has to be visible while you are picking
 * traits, so the header and footer are pinned and only the trait lists scroll —
 * a page that scrolls as a whole puts the number you are spending off-screen
 * exactly when you are spending it.
 */
.m-create {
  width: min(1080px, 96vw); height: 100vh; padding: 16px 0 14px;
  display: flex; flex-direction: column; gap: 14px;
}
.m-create header { display: flex; align-items: center; gap: 16px; flex: none; }
.m-jobs { flex: none; }
.m-traits { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-right: 4px; }
.m-create footer { flex: none; }
.m-name { flex: 1; font-size: 20px !important; margin: 0 !important; }
.m-head-actions { display: flex; gap: 6px; }
.m-head-actions button {
  background: #1a232e; border: 1px solid #2b3846; border-radius: 3px; padding: 7px 12px;
}
.m-head-actions button:hover { border-color: #4a6076; }

.m-budget { display: flex; align-items: baseline; gap: 6px; padding: 0 14px; }
.m-budget strong { font-size: 32px; font-weight: 500; }
.m-budget span { color: #6f7d8c; font-size: 11px; text-transform: uppercase; }
.m-budget.ok strong { color: #8fd0a0; }
.m-budget.exact strong { color: #e0c070; }
.m-budget.bad strong { color: #e07070; }

#menu h2 {
  font-size: 11px; text-transform: uppercase; letter-spacing: .18em;
  color: #6f7d8c; margin: 0 0 9px; font-weight: 500;
}
#menu h2 em { font-style: normal; color: #4c5866; letter-spacing: .06em; }

.m-job-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
.m-job {
  display: grid; grid-template-columns: 1fr auto; gap: 0 8px; text-align: left;
  background: #131a23; border: 1px solid #232e3a; border-radius: 3px; padding: 6px 10px;
}
.m-job:hover { border-color: #3f5468; }
.m-job.on { background: #1d2b38; border-color: #5b7691; }
.m-job-name { font-size: 13px; color: #dbe3ec; }
.m-pts { color: #8fd0a0; font-size: 12px; }
.m-job-desc { grid-column: 1 / -1; color: #7a879a; font-size: 11px; }
.m-job-skills { grid-column: 1 / -1; color: #5a6675; font-size: 10px; letter-spacing: .04em; }

.m-traits { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; align-content: start; }
.m-traits > div { display: flex; flex-direction: column; min-height: 0; }
.m-traits h2 { position: sticky; top: 0; background: #0c1117; padding: 2px 0 7px; z-index: 1; }
.m-trait-list { display: flex; flex-direction: column; gap: 3px; }
.m-trait {
  display: grid; grid-template-columns: 24px 1fr; gap: 0 8px; text-align: left;
  background: #131a23; border: 1px solid #232e3a; border-radius: 3px; padding: 4px 8px;
}
.m-trait:hover:not(.off) { border-color: #3f5468; }
.m-trait.off { opacity: .34; cursor: default; }
.m-trait-cost {
  grid-row: 1 / 3; align-self: center; text-align: center;
  font-size: 15px; font-variant-numeric: tabular-nums;
}
.m-trait.pos .m-trait-cost { color: #e0c070; }
.m-trait.neg .m-trait-cost { color: #8fd0a0; }
.m-trait-name { color: #dbe3ec; }
.m-trait-desc { color: #6d7a8b; font-size: 11px; }
.m-trait.on { background: #1d2b38; border-color: #5b7691; }
.m-trait.pos.on { border-color: #8a7440; }
.m-trait.neg.on { border-color: #47734f; }

.m-create footer {
  display: flex; align-items: center; gap: 18px;
  border-top: 1px solid #1d2732; padding-top: 14px;
}
.m-summary { flex: 1; margin: 0; color: #7a879a; font-size: 12px; }
`;
