/**
 * The controls screen.
 *
 * Shown once, unprompted, before the first frame a new survivor plays, and
 * reachable afterwards with `/` or `F1`.
 *
 * The HUD has carried a one-line control hint since M7 and it was not enough:
 * it is eleven point type along the bottom edge of a screen with a town on it,
 * it lists nine bindings without saying what any of them are *for*, and half
 * the game's verbs were never on it at all. A player who does not know they can
 * press Tab does not discover an inventory by looking harder at a street.
 *
 * So this is deliberately modal and deliberately unmissable on the first run. It
 * costs one keypress to dismiss, and a game that cannot be played is worse than
 * a game that made you press a key.
 */
import { t } from './i18n.js';

/** Grouped so a player can find a verb by what they are trying to do. */
const SECTIONS = [
  {
    title: ['help.section.move', 'Moving'],
    rows: [
      ['help.move', 'WASD / arrows', 'help.move.desc', 'Walk relative to the screen; you turn to face where you are going'],
      ['help.run', 'Shift', 'help.run.desc', 'Run. Costs endurance, and running out leaves you winded'],
      ['help.sneak', 'Ctrl', 'help.sneak.desc', 'Sneak. Quiet, and slow'],
    ],
  },
  {
    title: ['help.section.fight', 'Fighting'],
    rows: [
      ['help.attack', 'Left mouse', 'help.attack.desc', 'Swing toward the cursor'],
      ['help.shove', 'Right mouse', 'help.shove.desc', 'Shove. No damage, but it buys you a second'],
      ['help.treat', 'H', 'help.treat.desc', 'Bandage a wound, or take a painkiller'],
    ],
  },
  {
    title: ['help.section.world', 'The world'],
    rows: [
      ['help.interact', 'E', 'help.interact.desc', 'Open a door, climb a window, vault a fence'],
      ['help.inventory', 'Tab / I', 'help.inventory.desc', 'Your bag. Stand next to a container to search it'],
      ['help.consume', 'F', 'help.consume.desc', 'Eat or drink something from your bag'],
      ['help.equip', 'G', 'help.equip.desc', 'Swap what is in your hands'],
      ['help.torch', 'L', 'help.torch.desc', 'Torch on and off, if you are carrying one'],
    ],
  },
  {
    title: ['help.section.camera', 'The camera'],
    rows: [
      ['help.rotate', 'Q / .', 'help.rotate.desc', 'Turn the view a quarter turn'],
      ['help.zoom', 'Wheel', 'help.zoom.desc', 'Zoom in and out'],
      ['help.pause', 'Space', 'help.pause.desc', 'Pause'],
    ],
  },
];

export class Help {
  constructor(root = document.body) {
    const el = document.createElement('div');
    el.id = 'help';
    el.className = 'hidden';
    root.appendChild(el);
    this.el = el;
    this.open = false;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this._render();
    // Any key or click dismisses it, because a player who has just been told
    // which keys do things should not have to find a specific one.
    this._onKey = () => this.hide();
    el.addEventListener('pointerdown', () => this.hide());
  }

  _render() {
    const sections = SECTIONS.map((s) => `
      <section>
        <h2>${t(s.title[0], s.title[1])}</h2>
        <dl>
          ${s.rows.map(([kKey, kEn, dKey, dEn]) => `
            <div><dt>${t(kKey, kEn)}</dt><dd>${t(dKey, dEn)}</dd></div>
          `).join('')}
        </dl>
      </section>`).join('');

    this.el.innerHTML = `
      <div class="help-card">
        <h1>${t('help.title', 'Controls')}</h1>
        ${sections}
        <p class="help-marker">${t('help.marker', 'The cyan ring at your feet is you. Behind a wall, your outline shows through.')}</p>
        <p class="help-foot">${t('help.dismiss', 'Press any key to begin · / or F1 to see this again')}</p>
      </div>`;
  }

  show() {
    if (this.open) return;
    this.open = true;
    this._render();
    this.el.classList.remove('hidden');
    window.addEventListener('keydown', this._onKey, { once: true });
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.el.classList.add('hidden');
    window.removeEventListener('keydown', this._onKey);
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }
}

const CSS = `
#help {
  position: fixed; inset: 0; z-index: 50; pointer-events: auto;
  background: rgba(6, 9, 13, .88);
  display: flex; align-items: center; justify-content: center;
  color: #cdd6e0; font: 13px/1.5 system-ui, sans-serif;
  overflow: auto;
}
#help.hidden { display: none; }
.help-card {
  width: min(760px, 92vw); padding: 22px 30px 24px;
  background: #101720; border: 1px solid #26323f; border-radius: 5px;
}
.help-card h1 {
  margin: 0 0 18px; font-size: 15px; font-weight: 500;
  letter-spacing: .22em; text-transform: uppercase; color: #e6edf4;
}
.help-card section { margin-bottom: 15px; }
.help-card h2 {
  margin: 0 0 6px; font-size: 11px; font-weight: 500; color: #6f7d8c;
  letter-spacing: .16em; text-transform: uppercase;
}
.help-card dl { margin: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 3px 22px; }
.help-card dl > div { display: grid; grid-template-columns: 96px 1fr; gap: 10px; align-items: baseline; }
.help-card dt {
  text-align: right; color: #e0c070; font-variant-numeric: tabular-nums;
  white-space: nowrap; font-size: 12px;
}
.help-card dd { margin: 0; color: #9aa7b6; font-size: 12px; }
.help-marker {
  margin: 16px 0 0; padding: 9px 12px; border-radius: 3px;
  background: rgba(127, 216, 255, .09); border: 1px solid rgba(127, 216, 255, .3);
  color: #a9dcf2; font-size: 12px;
}
.help-foot {
  margin: 14px 0 0; text-align: center; color: #5f6d7c; font-size: 11px;
  letter-spacing: .08em;
}
@media (max-width: 720px) {
  .help-card dl { grid-template-columns: 1fr; }
}
`;
