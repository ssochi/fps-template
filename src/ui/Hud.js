/**
 * The HUD.
 *
 * DOM, not canvas. Everything here is text and boxes that change a few times a
 * second, and the GPU is already busy drawing a town; laying this out in the
 * renderer would cost more and be harder to read.
 *
 * The layout follows the reference game's because its arrangement is load
 * bearing rather than decorative: moodles stack down the right edge where they
 * are visible without being read, the body diagram sits with them, and the
 * bottom-left is reserved for what you are holding. The player should be able to
 * answer "am I in trouble?" from peripheral vision alone.
 */
import { events } from '../core/Events.js';
import { t } from './i18n.js';

/** Colour per moodle tier — muted at tier 1, alarming at tier 4. */
const TIER_COLOR = ['#8a9099', '#b9b06a', '#c99a52', '#c96f4a', '#c94a4a'];

const PART_KEYS = ['part.head', 'part.torso', 'part.armL', 'part.armR', 'part.legL', 'part.legR'];
const PART_EN = ['Head', 'Torso', 'L Arm', 'R Arm', 'L Leg', 'R Leg'];
const partLabel = (i) => t(PART_KEYS[i], PART_EN[i]);

export class Hud {
  constructor(root = document.getElementById('hud')) {
    this.root = root;
    this.el = {};
    this._build();
    this._flash = null;
    /** @type {Array<{ text: string, tone: string, until: number }>} */
    this._broadcasts = [];

    // Wounds flash the body panel. A swing that lands and one that misses used
    // to look identical, which made combat feel like nothing was happening.
    this._offWound = events.on('player:wounded', ({ kind }) => {
      this._flash = { until: performance.now() + 320, kind };
    });
    this._offDeath = events.on('player:died', (e) => this.showDeath(e));
    this._offLevel = events.on('skill:levelled', ({ name, level }) => {
      this._toast = { text: `${name} ${level}`, until: performance.now() + 2600 };
    });

    /**
     * The emergency broadcast log.
     *
     * A metagame event that nobody notices is not an event, and the ones M16
     * schedules happen *somewhere else* — a gunshot two streets over, the grid
     * failing overnight. This is the only channel that says so. Held for a long
     * time and stacked, because "the water goes off tomorrow" is something the
     * player has to remember rather than react to.
     */
    // Weather and the things you built announce themselves through the same
    // channel the emergency broadcasts use — one place on screen for "something
    // happened that you did not do".
    this._offWeather = events.on('weather:changed', ({ sky }) => {
      const key = sky === 3 ? 'weather.storm.started'
        : sky === 2 ? 'weather.rain.started' : 'weather.stopped';
      const fallback = sky >= 2
        ? 'Rain. It covers the noise you make.'
        : 'The rain has stopped.';
      this._broadcasts.push({ text: t(key, fallback), tone: 'normal', until: performance.now() + 9000 });
      this._renderBroadcasts();
    });
    this._offStation = events.on('station:stopped', ({ kind }) => {
      const key = kind === 'fire' ? 'station.fire.out' : 'station.generator.out';
      const fallback = kind === 'fire' ? 'The fire has gone out.' : 'The generator is out of fuel.';
      this._broadcasts.push({ text: t(key, fallback), tone: 'warning', until: performance.now() + 9000 });
      this._renderBroadcasts();
    });

    this._offBroadcast = events.on('meta:broadcast', ({ text, tone }) => {
      this._broadcasts.push({ text, tone, until: performance.now() + 14000 });
      if (this._broadcasts.length > 4) this._broadcasts.shift();
      this._renderBroadcasts();
    });
  }

  _build() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root.innerHTML = `
      <div id="hud-top-left">
        <div id="hud-clock"></div>
        <div id="hud-debug"></div>
      </div>
      <div id="hud-right">
        <div id="hud-moodles"></div>
        <div id="hud-body"></div>
        <div id="hud-skills"></div>
      </div>
      <div id="hud-bottom">
        <div id="hud-bars">
          <div class="bar"><span>${t('hud.hp', 'HP')}</span><em><i id="bar-health"></i></em></div>
          <div class="bar"><span>${t('hud.end', 'END')}</span><em><i id="bar-endurance"></i></em></div>
        </div>
        <div id="hud-weapon"></div>
        <div id="hud-help">${t('hud.help', 'WASD move · LMB attack · RMB shove · shift run · ctrl sneak · E interact · Tab bag · / controls')}</div>
      </div>
      <div id="hud-broadcast"></div>
      <div id="hud-death" class="hidden"></div>
    `;

    for (const id of [
      'hud-clock', 'hud-debug', 'hud-moodles', 'hud-body', 'hud-weapon',
      'bar-health', 'bar-endurance', 'hud-death', 'hud-skills', 'hud-broadcast',
    ]) {
      this.el[id] = this.root.querySelector(`#${id}`);
    }
  }

  /**
   * @param {object} s
   * @param {import('../core/Clock.js').Clock} s.clock
   * @param {import('../entity/Player.js').Player} s.player
   * @param {import('../sim/Moodles.js').Moodles} s.moodles
   * @param {string} s.debug
   */
  update({ clock, player, moodles, debug, skills }) {
    this.el['hud-clock'].textContent = `${clock.format()}  ·  ${clock.formatDate()}`;

    const toast = this._toast && performance.now() < this._toast.until ? this._toast.text : '';
    if (toast !== this._toastShown) {
      this._toastShown = toast;
      this.el['hud-skills'].dataset.toast = toast;
    }
    this.el['hud-debug'].textContent = debug;

    this._renderMoodles(moodles);
    this._renderBody(player.body);

    const hp = player.body.condition;
    this.el['bar-health'].style.width = `${(hp * 100).toFixed(1)}%`;
    this.el['bar-health'].style.background = hp > 0.6 ? '#6f9f68' : hp > 0.3 ? '#c9a052' : '#c94a4a';

    const end = player.endurance;
    this.el['bar-endurance'].style.width = `${(end * 100).toFixed(1)}%`;
    this.el['bar-endurance'].style.background = player.winded ? '#c96f4a' : '#5f8592';

    if (skills) this._renderSkills(skills);
    if (this._broadcasts.length) this._renderBroadcasts();

    const w = player.weapon;
    const cond = Math.round(w.conditionFraction * 100);
    this.el['hud-weapon'].innerHTML =
      `<b>${t(`weapon.${w.def.id}`, w.def.name)}</b>` +
      `${w.broken ? ` <em>${t('hud.broken', 'broken')}</em>` : ` <span>${cond}%</span>`}` +
      (moodles.asleep ? ` &nbsp;·&nbsp; <em>${t('hud.asleep', 'asleep')}</em>` : '');
  }

  _renderBroadcasts() {
    const now = performance.now();
    this._broadcasts = this._broadcasts.filter((b) => b.until > now);
    this.el['hud-broadcast'].innerHTML = this._broadcasts
      .map((b) => `<div class="bcast ${b.tone}">${b.text}</div>`)
      .join('');
  }

  /** Only skills above zero: an empty sheet is noise. */
  _renderSkills(skills) {
    const learned = skills.summary().filter((s) => s.level > 0);
    const html = learned
      .map((s) => `<div class="skill"><span>${t(`skill.${s.id}`, s.name)}</span><b>${s.level}</b></div>`)
      .join('');
    if (html === this._skillHtml) return;
    this._skillHtml = html;
    this.el['hud-skills'].innerHTML = html;
  }

  _renderMoodles(moodles) {
    const list = moodles.active();
    const html = list
      .map(
        (m) =>
          `<div class="moodle" style="border-color:${TIER_COLOR[m.tier]}">` +
          `<b style="color:${TIER_COLOR[m.tier]}">${t(`moodle.${m.id}.${m.tier}`, m.label)}</b></div>`,
      )
      .join('');
    // Only touch the DOM when it actually changed; this runs several times a
    // second and innerHTML is not free.
    if (html !== this._moodleHtml) {
      this._moodleHtml = html;
      this.el['hud-moodles'].innerHTML = html;
    }
  }

  _renderBody(body) {
    const flashing = this._flash && performance.now() < this._flash.until;
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const h = body.health[i];
      const bleeding = body.bleed[i] > 0.05;
      const broken = body.fractured[i];
      const colour = h > 70 ? '#6f9f68' : h > 35 ? '#c9a052' : '#c94a4a';
      rows.push(
        `<div class="part"><span>${partLabel(i)}</span>` +
          `<i style="width:${h}%;background:${colour}"></i>` +
          `${bleeding ? '<u title="bleeding">•</u>' : ''}` +
          `${broken ? '<s title="fractured">/</s>' : ''}</div>`,
      );
    }
    const cls = flashing ? 'hit' : '';
    const infection = body.infected
      ? `<div class="infection">${t('hud.infected', 'Infected')} · ${(body.infection * 100).toFixed(1)}%</div>`
      : '';
    this.el['hud-body'].className = cls;
    this.el['hud-body'].innerHTML = rows.join('') + infection;
  }

  /**
   * The death report.
   *
   * The reference game frames the whole run as "this is how you died", and the
   * screen that says so is the payoff for permadeath. It has to state the cause
   * plainly and show how long you lasted, because those are the two things a
   * player wants when deciding whether to go again.
   */
  showDeath({ cause, kills, days, skills = [], profile = [], name, onRestart }) {
    const el = this.el['hud-death'];
    el.classList.remove('hidden');
    // What you got good at is part of the report: it is the record of how you
    // actually played, which is the thing worth reading back.
    const learned = skills.length
      ? `<p class="learned">${skills.map((s) => `${s.name} ${s.level}`).join(' · ')}</p>`
      : '';
    // And who you chose to be is the other half of the sentence: the traits you
    // took are the reason the run went the way it did, so they belong beside
    // the cause rather than only on the screen where you picked them.
    const chosen = profile.length
      ? `<p class="chosen">${profile
          .map((d) => `<span class="${d.kind}">${t(d.key ?? '', d.name)}</span>`)
          .join('')}</p>`
      : '';
    el.innerHTML = `
      <div class="death-card">
        <h1>${name
          ? t('death.title', 'This is how {name} died', { name: escapeHtml(name) })
          : t('death.title.you', 'This is how you died')}</h1>
        <p class="cause">${cause}</p>
        <dl>
          <div><dt>${t('death.survived', 'Survived')}</dt><dd>${days ?? '—'}</dd></div>
          <div><dt>${t('death.kills', 'Zombies killed')}</dt><dd>${kills ?? 0}</dd></div>
        </dl>
        ${chosen}
        ${learned}
        <button id="death-restart">${t('death.restart', 'Begin again')}</button>
      </div>
    `;
    const button = el.querySelector('#death-restart');
    if (onRestart) button.addEventListener('click', onRestart);
  }

  dispose() {
    this._offWound();
    this._offDeath();
    this._offBroadcast?.();
    this._offWeather?.();
    this._offStation?.();
    this._offLevel();
  }
}

const CSS = `
#hud { font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cfd6dd; }
#hud b, #hud em, #hud span, #hud u, #hud s { font-weight: inherit; }

#hud-top-left { position: absolute; top: 10px; left: 12px; }
#hud-clock { font-size: 13px; letter-spacing: .04em; color: #e4ecf2; margin-bottom: 4px; }
#hud-debug { white-space: pre; opacity: .5; font-size: 11px; }

#hud-right { position: absolute; top: 10px; right: 12px; width: 168px; text-align: right; }
#hud-moodles { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.moodle {
  border-right: 3px solid; padding: 1px 7px 1px 9px;
  background: rgba(12,15,20,.55); border-radius: 2px 0 0 2px;
}

#hud-body {
  margin-top: 10px; padding: 7px 8px; background: rgba(12,15,20,.55);
  border-radius: 3px; transition: background .12s;
}
#hud-body.hit { background: rgba(120,30,30,.75); }
.part { display: flex; align-items: center; gap: 5px; height: 14px; }
.part span {
  width: 46px; flex: none; text-align: left; opacity: .65; font-size: 10px;
  white-space: nowrap;
}
.part i { height: 5px; border-radius: 2px; display: block; flex: none; }
.part u { color: #c94a4a; text-decoration: none; }
.part s { color: #d6b45a; text-decoration: none; }
.infection { margin-top: 5px; color: #a97fd0; font-size: 11px; }

#hud-skills {
  margin-top: 8px; padding: 6px 8px; background: rgba(12,15,20,.55); border-radius: 3px;
}
#hud-skills:empty { display: none; }
.skill { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; }
.skill span { opacity: .6; }
.skill b { font-weight: 400; color: #8fae86; }

#hud-bottom { position: absolute; left: 12px; bottom: 12px; }
#hud-bars { display: flex; gap: 14px; margin-bottom: 5px; }
.bar { display: flex; align-items: center; gap: 6px; }
.bar span { opacity: .55; font-size: 10px; width: 24px; flex: none; }
/* The track is a fixed-width box so the fill's percentage is a percentage of
   the bar and not of the bar plus its label. */
.bar em { display: block; width: 132px; height: 6px; border-radius: 3px;
          background: rgba(255,255,255,.1); overflow: hidden; font-style: normal; }
.bar i { display: block; height: 6px; width: 0; border-radius: 3px; transition: width .1s; }
#hud-weapon { opacity: .85; }
#hud-weapon em { color: #c94a4a; font-style: normal; }
#hud-weapon span { opacity: .5; }
#hud-help { margin-top: 6px; opacity: .32; font-size: 11px; }

#hud-death {
  position: absolute; inset: 0; display: grid; place-items: center;
  background: rgba(6,8,11,.82); backdrop-filter: blur(2px);
}
#hud-death.hidden { display: none; }
.death-card { text-align: center; max-width: 420px; }
.death-card h1 {
  font-size: 22px; font-weight: 400; letter-spacing: .18em;
  text-transform: uppercase; color: #d8dee4; margin: 0 0 10px;
}
.death-card .cause { color: #c96f4a; font-size: 15px; margin: 0 0 22px; }
.death-card dl { display: flex; justify-content: center; gap: 34px; margin: 0 0 20px; }
.death-card dt { opacity: .5; font-size: 10px; text-transform: uppercase; letter-spacing: .1em; }
.death-card dd { margin: 2px 0 0; font-size: 16px; }
#hud-broadcast {
  position: absolute; left: 50%; top: 68px; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 4px; align-items: center;
  pointer-events: none; max-width: 70vw;
}
.bcast {
  padding: 5px 14px; border-radius: 2px; font-size: 12px; letter-spacing: .04em;
  background: rgba(12,16,22,.82); border-left: 3px solid #8a9099; color: #c3ccd6;
}
.bcast.warning { border-left-color: #c9a052; color: #e0c98f; }
.bcast.bad { border-left-color: #c94a4a; color: #e7a9a9; }
.death-card .learned { opacity: .55; font-size: 11px; margin: 0 0 18px; }
.death-card .chosen { display: flex; flex-wrap: wrap; gap: 5px; justify-content: center; margin: 0 0 12px; }
.death-card .chosen span { font-size: 11px; padding: 2px 8px; border-radius: 2px; border: 1px solid; }
.death-card .chosen .occupation { border-color: #5b7691; color: #b9cbdd; }
.death-card .chosen .positive { border-color: #8a7440; color: #d9c48b; }
.death-card .chosen .negative { border-color: #47734f; color: #9ec9a7; }
.death-card button {
  font: inherit; color: #d8dee4; background: rgba(255,255,255,.06);
  border: 1px solid rgba(255,255,255,.16); border-radius: 3px;
  padding: 7px 20px; cursor: pointer; letter-spacing: .1em; text-transform: uppercase;
  font-size: 11px;
}
.death-card button:hover { background: rgba(255,255,255,.12); }
`;

/** The survivor's name is player-supplied text going into innerHTML. */
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}
