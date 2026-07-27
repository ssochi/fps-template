import type { GameSettings, QualityLevel, Settings } from '../core/Settings';
import { LEVELS, type LevelId } from '../world/LevelBuilder';
import { WEAPON_CONFIGS, WEAPON_ORDER } from '../weapons/WeaponConfigs';
import { THROWABLE_CONFIGS, THROWABLE_ORDER } from '../weapons/ThrowableConfigs';

/**
 * Full-screen menus: the start screen, the pause / settings screen and the
 * death screen. All of them are plain DOM so they can be restyled or replaced
 * without touching rendering code.
 */

export type MenuScreen = 'none' | 'start' | 'pause' | 'death';

export interface MenuCallbacks {
  onStart: () => void;
  onResume: () => void;
  onRespawn: () => void;
  onResetRange: () => void;
  onSettingsChanged: () => void;
  onLevelChosen: (id: LevelId) => void;
}

interface ControlEntry {
  keys: string[];
  action: string;
}

const CONTROLS: ControlEntry[] = [
  { keys: ['W', 'A', 'S', 'D'], action: 'Move' },
  { keys: ['Shift'], action: 'Sprint' },
  { keys: ['Ctrl', 'C'], action: 'Crouch' },
  { keys: ['Shift', '+', 'Ctrl'], action: 'Slide (while sprinting)' },
  { keys: ['Space'], action: 'Jump' },
  { keys: ['Mouse 1'], action: 'Fire' },
  { keys: ['Mouse 2'], action: 'Aim down sights' },
  { keys: ['R'], action: 'Reload' },
  { keys: ['1', '—', '9', '0'], action: 'Select weapon' },
  { keys: ['Q'], action: 'Previous weapon' },
  { keys: ['Wheel'], action: 'Cycle weapons' },
  { keys: ['B'], action: 'Toggle fire mode' },
  { keys: ['G'], action: 'Throw grenade (hold to cook)' },
  { keys: ['G', '+', 'Mouse 2'], action: 'Underhand lob' },
  { keys: ['T'], action: 'Cycle grenade type' },
  { keys: ['V'], action: 'First / third person' },
  { keys: ['F'], action: 'Inspect weapon' },
  { keys: ['E'], action: 'Interact — resupply, pick up, open the fridge' },
  { keys: ['K'], action: 'Start timed drill' },
  { keys: ['L'], action: 'Reset targets' },
  { keys: ['M'], action: 'Next map' },
  { keys: ['H'], action: 'Toggle HUD' },
  { keys: ['P'], action: 'Toggle collision debug' },
  { keys: ['Esc'], action: 'Pause / settings' },
];

/** Shown alongside the on-foot controls; only relevant on the circuit map. */
const VEHICLE_CONTROLS: ControlEntry[] = [
  { keys: ['E'], action: 'Get in / out of a vehicle' },
  { keys: ['W'], action: 'Throttle' },
  { keys: ['S'], action: 'Brake, then reverse' },
  { keys: ['A'], action: 'Steer left' },
  { keys: ['D'], action: 'Steer right' },
  { keys: ['Space'], action: 'Handbrake' },
  { keys: ['Mouse'], action: 'Look around — aims the tank turret' },
  { keys: ['Mouse 1'], action: 'Fire the 120 mm gun (tank) / arm cannons (Thor)' },
  { keys: ['Mouse 2'], action: 'Javelin missile salvo (Thor)' },
  { keys: ['V'], action: 'Chase / cockpit camera' },
];

export class Menu {
  private readonly root: HTMLElement;
  private readonly settings: Settings;
  private readonly callbacks: MenuCallbacks;
  private current: MenuScreen = 'none';

  constructor(root: HTMLElement, settings: Settings, callbacks: MenuCallbacks) {
    this.root = root;
    this.settings = settings;
    this.callbacks = callbacks;
    this.root.innerHTML = this.markup();
    this.bind();
    this.syncSettingsInputs();
  }

  get screen(): MenuScreen {
    return this.current;
  }

  get isOpen(): boolean {
    return this.current !== 'none';
  }

  show(screen: MenuScreen): void {
    this.current = screen;
    this.el('#start-screen').classList.toggle('hidden', screen !== 'start');
    this.el('#pause-screen').classList.toggle('hidden', screen !== 'pause');
    this.el('#death-screen').classList.toggle('hidden', screen !== 'death');
    this.root.style.pointerEvents = screen === 'none' ? 'none' : 'auto';
    if (screen === 'pause') this.syncSettingsInputs();
  }

  hideLoading(): void {
    this.el('#loading').classList.add('hidden');
  }

  setDeathSummary(text: string): void {
    this.el('#death-summary').textContent = text;
  }

  private el<T extends HTMLElement>(selector: string): T {
    const found = this.root.querySelector<T>(selector);
    if (!found) throw new Error(`Menu element not found: ${selector}`);
    return found;
  }

  // ----------------------------------------------------------------- markup

  private markup(): string {
    return `
      <div id="loading">
        <div class="spinner"></div>
        <div>Building world…</div>
      </div>

      <div id="start-screen" class="screen hidden">
        <div class="screen__inner">
          <h1>Three.js FPS Template</h1>
          <p class="subtitle">
            First / third person shooter sandbox — ten weapons, three throwables, and three maps:
            a full shooting range; a race circuit whose garage holds a hypercar, a 4x4 and a tank —
            all three drivable with lap timing and a working 120 mm gun on the tank — plus a pilotable
            Terran assault mech that walks, twists its torso and fires twin arm cannons; and a model
            studio, a PBR test scene with an area-light rig, reference charts and six showpieces.
          </p>

          <h2>Controls</h2>
          <div class="controls-grid">${this.controlsMarkup()}</div>

          <h2>Driving</h2>
          <div class="controls-grid">${this.vehicleControlsMarkup()}</div>

          <h2>Arsenal</h2>
          <div class="weapon-cards">${this.weaponCardsMarkup()}</div>

          <h2>Throwables</h2>
          <div class="weapon-cards">${this.throwableCardsMarkup()}</div>

          <h2>Maps</h2>
          <div class="map-cards">${this.mapCardsMarkup()}</div>

          <div class="button-row">
            <button class="btn" id="btn-start">Click to play</button>
          </div>
          <p class="subtitle" style="margin-top:14px">
            Pointer lock will engage. Press <kbd>Esc</kbd> at any time for settings.
          </p>
        </div>
      </div>

      <div id="pause-screen" class="screen hidden">
        <div class="screen__inner">
          <h1>Paused</h1>
          <p class="subtitle">Adjust anything below — settings persist between sessions.</p>

          <h2>Settings</h2>
          <div class="settings-grid">
            <div class="setting">
              <label for="set-sens">Sensitivity</label>
              <input type="range" id="set-sens" min="0.1" max="4" step="0.05" />
              <span class="val" id="val-sens"></span>
            </div>
            <div class="setting">
              <label for="set-adssens">ADS sens. scale</label>
              <input type="range" id="set-adssens" min="0.1" max="1.5" step="0.05" />
              <span class="val" id="val-adssens"></span>
            </div>
            <div class="setting">
              <label for="set-fov">Field of view</label>
              <input type="range" id="set-fov" min="60" max="120" step="1" />
              <span class="val" id="val-fov"></span>
            </div>
            <div class="setting">
              <label for="set-bob">View bob</label>
              <input type="range" id="set-bob" min="0" max="2" step="0.05" />
              <span class="val" id="val-bob"></span>
            </div>
            <div class="setting">
              <label for="set-master">Master volume</label>
              <input type="range" id="set-master" min="0" max="1" step="0.02" />
              <span class="val" id="val-master"></span>
            </div>
            <div class="setting">
              <label for="set-sfx">SFX volume</label>
              <input type="range" id="set-sfx" min="0" max="2" step="0.02" />
              <span class="val" id="val-sfx"></span>
            </div>
            <div class="setting">
              <label for="set-quality">Quality</label>
              <select id="set-quality">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div class="setting">
              <label for="set-invert">Invert Y</label>
              <input type="checkbox" id="set-invert" />
            </div>
            <div class="setting">
              <label for="set-toggleads">Toggle ADS</label>
              <input type="checkbox" id="set-toggleads" />
            </div>
            <div class="setting">
              <label for="set-togglecrouch">Toggle crouch</label>
              <input type="checkbox" id="set-togglecrouch" />
            </div>
            <div class="setting">
              <label for="set-crosshair">Crosshair</label>
              <input type="checkbox" id="set-crosshair" />
            </div>
            <div class="setting">
              <label for="set-damagenumbers">Damage numbers</label>
              <input type="checkbox" id="set-damagenumbers" />
            </div>
            <div class="setting">
              <label for="set-fps">Show FPS</label>
              <input type="checkbox" id="set-fps" />
            </div>
          </div>

          <h2>Maps</h2>
          <div class="map-cards">${this.mapCardsMarkup()}</div>

          <h2>Controls</h2>
          <div class="controls-grid">${this.controlsMarkup()}</div>

          <h2>Driving</h2>
          <div class="controls-grid">${this.vehicleControlsMarkup()}</div>

          <div class="button-row">
            <button class="btn" id="btn-resume">Resume</button>
            <button class="btn secondary" id="btn-reset-range">Reset range</button>
            <button class="btn secondary" id="btn-reset-settings">Default settings</button>
          </div>
        </div>
      </div>

      <div id="death-screen" class="screen hidden">
        <div class="screen__inner" style="text-align:center">
          <h1>Down</h1>
          <p class="subtitle" id="death-summary"></p>
          <div class="button-row">
            <button class="btn" id="btn-respawn">Respawn</button>
          </div>
        </div>
      </div>
    `;
  }

  private vehicleControlsMarkup(): string {
    return Menu.controlRows(VEHICLE_CONTROLS);
  }

  private static controlRows(entries: ControlEntry[]): string {
    return entries
      .map((c) => {
        const keys = c.keys
          .map((k) => (k === '—' || k === '+' ? `<span>${k}</span>` : `<kbd>${k}</kbd>`))
          .join(' ');
        return `<div class="ctrl"><span>${keys}</span><span>${c.action}</span></div>`;
      })
      .join('');
  }

  private mapCardsMarkup(): string {
    return LEVELS.map(
      (l) => `
        <button class="map-card" data-level="${l.id}">
          <h3>${l.name}</h3>
          <p>${l.blurb}</p>
        </button>`,
    ).join('');
  }

  private controlsMarkup(): string {
    return Menu.controlRows(CONTROLS);
  }

  private throwableCardsMarkup(): string {
    return THROWABLE_ORDER.map((id) => {
      const c = THROWABLE_CONFIGS[id];
      return `
        <div class="weapon-card">
          <div class="cat">${c.category} · ${c.startCount} CARRIED</div>
          <h3>${c.name}</h3>
          <p>${c.description}</p>
        </div>`;
    }).join('');
  }

  private weaponCardsMarkup(): string {
    const bar = (name: string, value: number): string =>
      `<div class="stat-line"><span class="n">${name}</span><span class="track"><div style="width:${Math.round(
        Math.max(0, Math.min(1, value)) * 100,
      )}%"></div></span></div>`;

    return WEAPON_ORDER.map((id) => {
      const c = WEAPON_CONFIGS[id];
      const dps = (c.damage * c.pellets * c.rpm) / 60;
      return `
        <div class="weapon-card">
          <div class="cat">${c.category} · SLOT ${c.slot % 10}</div>
          <h3>${c.name}</h3>
          <p>${c.description}</p>
          ${bar('DAMAGE', (c.damage * c.pellets) / 130)}
          ${bar('RATE', c.rpm / 1000)}
          ${bar('DPS', dps / 500)}
          ${bar('RANGE', c.falloffEnd / 320)}
          ${bar('CONTROL', 1 - c.recoil.vertical / 3.6)}
          ${bar('MAG', c.magSize / 32)}
        </div>`;
    }).join('');
  }

  // -------------------------------------------------------------------- bind

  private bind(): void {
    this.el('#btn-start').addEventListener('click', () => this.callbacks.onStart());
    this.el('#btn-resume').addEventListener('click', () => this.callbacks.onResume());
    this.el('#btn-respawn').addEventListener('click', () => this.callbacks.onRespawn());
    this.el('#btn-reset-range').addEventListener('click', () => this.callbacks.onResetRange());
    this.el('#btn-reset-settings').addEventListener('click', () => {
      this.settings.reset();
      this.syncSettingsInputs();
      this.callbacks.onSettingsChanged();
    });

    this.bindRange('#set-sens', '#val-sens', 'sensitivity', (v) => v.toFixed(2));
    this.bindRange('#set-adssens', '#val-adssens', 'adsSensitivityScale', (v) => v.toFixed(2));
    this.bindRange('#set-fov', '#val-fov', 'fov', (v) => `${Math.round(v)}°`);
    this.bindRange('#set-bob', '#val-bob', 'viewBob', (v) => v.toFixed(2));
    this.bindRange('#set-master', '#val-master', 'masterVolume', (v) => `${Math.round(v * 100)}%`);
    this.bindRange('#set-sfx', '#val-sfx', 'sfxVolume', (v) => `${Math.round(v * 100)}%`);

    this.bindCheckbox('#set-invert', 'invertY');
    this.bindCheckbox('#set-toggleads', 'toggleAds');
    this.bindCheckbox('#set-togglecrouch', 'toggleCrouch');
    this.bindCheckbox('#set-crosshair', 'crosshairEnabled');
    this.bindCheckbox('#set-damagenumbers', 'damageNumbers');
    this.bindCheckbox('#set-fps', 'showFps');

    // Both screens carry a copy of the map picker, so bind them all.
    for (const card of this.root.querySelectorAll<HTMLElement>('.map-card')) {
      card.addEventListener('click', () => {
        const id = card.dataset.level as LevelId | undefined;
        if (id) this.callbacks.onLevelChosen(id);
      });
    }

    const quality = this.el<HTMLSelectElement>('#set-quality');
    quality.addEventListener('change', () => {
      this.settings.set('quality', quality.value as QualityLevel);
      this.callbacks.onSettingsChanged();
    });
  }

  private bindRange(
    inputSel: string,
    valueSel: string,
    key: keyof GameSettings,
    format: (v: number) => string,
  ): void {
    const input = this.el<HTMLInputElement>(inputSel);
    const value = this.el(valueSel);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      (this.settings.set as (k: keyof GameSettings, v: number) => void)(key, v);
      value.textContent = format(v);
      this.callbacks.onSettingsChanged();
    });
  }

  private bindCheckbox(selector: string, key: keyof GameSettings): void {
    const input = this.el<HTMLInputElement>(selector);
    input.addEventListener('change', () => {
      (this.settings.set as (k: keyof GameSettings, v: boolean) => void)(key, input.checked);
      this.callbacks.onSettingsChanged();
    });
  }

  private syncSettingsInputs(): void {
    const s = this.settings.current;
    const setRange = (sel: string, valSel: string, v: number, format: (n: number) => string): void => {
      this.el<HTMLInputElement>(sel).value = String(v);
      this.el(valSel).textContent = format(v);
    };

    setRange('#set-sens', '#val-sens', s.sensitivity, (v) => v.toFixed(2));
    setRange('#set-adssens', '#val-adssens', s.adsSensitivityScale, (v) => v.toFixed(2));
    setRange('#set-fov', '#val-fov', s.fov, (v) => `${Math.round(v)}°`);
    setRange('#set-bob', '#val-bob', s.viewBob, (v) => v.toFixed(2));
    setRange('#set-master', '#val-master', s.masterVolume, (v) => `${Math.round(v * 100)}%`);
    setRange('#set-sfx', '#val-sfx', s.sfxVolume, (v) => `${Math.round(v * 100)}%`);

    this.el<HTMLInputElement>('#set-invert').checked = s.invertY;
    this.el<HTMLInputElement>('#set-toggleads').checked = s.toggleAds;
    this.el<HTMLInputElement>('#set-togglecrouch').checked = s.toggleCrouch;
    this.el<HTMLInputElement>('#set-crosshair').checked = s.crosshairEnabled;
    this.el<HTMLInputElement>('#set-damagenumbers').checked = s.damageNumbers;
    this.el<HTMLInputElement>('#set-fps').checked = s.showFps;
    this.el<HTMLSelectElement>('#set-quality').value = s.quality;
    this.markActiveLevel(s.level);
  }

  /** Highlights whichever map is loaded, on every screen that lists them. */
  markActiveLevel(id: LevelId): void {
    for (const card of this.root.querySelectorAll<HTMLElement>('.map-card')) {
      card.classList.toggle('active', card.dataset.level === id);
    }
  }
}
