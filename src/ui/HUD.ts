import { clamp, lerp } from '../core/MathUtils';
import type { FireMode, WeaponConfig, WeaponId } from '../weapons/WeaponTypes';
import { WEAPON_CONFIGS, WEAPON_ORDER } from '../weapons/WeaponConfigs';

/**
 * DOM-based heads-up display.
 *
 * Kept out of the WebGL scene so text stays crisp at any resolution and so it
 * can be restyled from CSS without touching game code. Everything updates from
 * a single `update()` call per frame with cached values to avoid layout churn.
 */

export interface HudFrame {
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  ammo: number;
  reserve: number;
  magSize: number;
  weapon: WeaponConfig;
  fireMode: FireMode;
  /** Spread cone half-angle in degrees, drives the crosshair gap. */
  spread: number;
  ads: number;
  reloading: boolean;
  /** Vertical FOV in degrees, needed to convert spread to pixels. */
  fov: number;
  viewportHeight: number;
  showScope: boolean;
  score: number;
  shotsFired: number;
  shotsHit: number;
  drillText: string | null;
  drillTime: number | null;
  prompt: string | null;
  promptKey: string | null;
  /** Selected throwable, its stock and cook progress. */
  throwable: { name: string; count: number; cook: number } | null;
  /** Set while driving; suppresses the weapon panels and shows the dash. */
  vehicle: {
    name: string;
    speedKph: number;
    gear: string;
    /** 0..1 through the rev range. */
    revs: number;
    laps: number;
    lapTime: string;
    lastLap: string;
    bestLap: string;
    /** Tank only: 0..1 reload progress, 1 = ready. */
    reload: number | null;
  } | null;
}

interface DamageNumber {
  el: HTMLDivElement;
  life: number;
  maxLife: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export class HUD {
  private readonly root: HTMLElement;

  private readonly crosshair: HTMLElement;
  private readonly chLines: HTMLElement[] = [];
  private readonly chDot: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly scope: HTMLElement;

  private readonly magEl: HTMLElement;
  private readonly reserveEl: HTMLElement;
  private readonly weaponNameEl: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly reloadHintEl: HTMLElement;

  private readonly healthFill: HTMLElement;
  private readonly healthValue: HTMLElement;
  private readonly staminaFill: HTMLElement;
  private readonly staminaValue: HTMLElement;

  private readonly loadoutEl: HTMLElement;
  private readonly ammoPanel: HTMLElement;
  private readonly vehicleEl: HTMLElement;
  private readonly vehNameEl: HTMLElement;
  private readonly vehKphEl: HTMLElement;
  private readonly vehRevEl: HTMLElement;
  private readonly vehGearEl: HTMLElement;
  private readonly vehLapEl: HTMLElement;
  private readonly vehTimeEl: HTMLElement;
  private readonly vehBestEl: HTMLElement;
  private readonly vehReloadRow: HTMLElement;
  private readonly vehReloadEl: HTMLElement;
  private readonly slotEls = new Map<WeaponId, HTMLElement>();

  private readonly scoreEl: HTMLElement;
  private readonly accuracyEl: HTMLElement;
  private readonly hitsEl: HTMLElement;
  private readonly drillBanner: HTMLElement;

  private readonly eventLog: HTMLElement;
  private readonly promptEl: HTMLElement;
  private readonly damageVignette: HTMLElement;
  private readonly lowHealthVignette: HTMLElement;
  private readonly fpsEl: HTMLElement;
  private readonly damageLayer: HTMLElement;
  private readonly throwablePanel: HTMLElement;
  private readonly throwableName: HTMLElement;
  private readonly throwableCount: HTMLElement;
  private readonly throwableCook: HTMLElement;
  private readonly flashOverlay: HTMLElement;

  private readonly damageNumbers: DamageNumber[] = [];

  private hitmarkerTimer = 0;
  private damageFlash = 0;
  private crosshairGapSmooth = 8;
  private lastAmmo = -1;
  private lastReserve = -1;
  private lastWeapon: WeaponId | null = null;
  private lastMode: FireMode | null = null;
  private lastHealth = -1;
  private lastStamina = -1;
  private lastScore = -1;
  private lastAccuracy = '';
  private lastDrill = '';
  private lastPrompt = '';
  private lastThrowable = '';
  private lastVehicleName = '';
  private lastKph = -1;
  private lastGear = '';
  private flashAmount = 0;

  showCrosshair = true;
  showDamageNumbers = true;
  showFps = true;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = HUD.markup();

    this.crosshair = this.q('#crosshair');
    this.chDot = this.q('#crosshair .ch-dot');
    for (const el of this.root.querySelectorAll<HTMLElement>('#crosshair .ch-line')) {
      this.chLines.push(el);
    }
    this.hitmarker = this.q('#hitmarker');
    this.scope = this.q('#scope');

    this.magEl = this.q('#ammo .mag');
    this.reserveEl = this.q('#ammo .reserve');
    this.weaponNameEl = this.q('#ammo .weapon-name');
    this.modeEl = this.q('#ammo .mode');
    this.reloadHintEl = this.q('#ammo .reload-hint');

    this.healthFill = this.q('#health-fill');
    this.healthValue = this.q('#health-value');
    this.staminaFill = this.q('#stamina-fill');
    this.staminaValue = this.q('#stamina-value');

    this.loadoutEl = this.q('#loadout');
    this.ammoPanel = this.q('#ammo');
    this.scoreEl = this.q('#stat-score');
    this.accuracyEl = this.q('#stat-accuracy');
    this.hitsEl = this.q('#stat-hits');
    this.drillBanner = this.q('#drill-banner');

    this.eventLog = this.q('#event-log');
    this.promptEl = this.q('#prompt');
    this.damageVignette = this.q('#damage-vignette');
    this.lowHealthVignette = this.q('#low-health-vignette');
    this.fpsEl = this.q('#fps');
    this.damageLayer = this.q('#damage-layer');
    this.throwablePanel = this.q('#throwables');
    this.throwableName = this.q('#throwables .tw-name');
    this.throwableCount = this.q('#tw-count');
    this.throwableCook = this.q('#tw-cook-fill');
    this.flashOverlay = this.q('#flash-overlay');
    this.vehicleEl = this.q('#vehicle');
    this.vehNameEl = this.q('#vehicle .veh-name');
    this.vehKphEl = this.q('#veh-kph');
    this.vehRevEl = this.q('#veh-rev-fill');
    this.vehGearEl = this.q('#veh-gear');
    this.vehLapEl = this.q('#veh-lap');
    this.vehTimeEl = this.q('#veh-time');
    this.vehBestEl = this.q('#veh-best');
    this.vehReloadRow = this.q('#vehicle .veh-reload');
    this.vehReloadEl = this.q('#veh-reload');

    this.buildLoadout();
    this.buildScopeReticle();
  }

  private q<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`HUD element not found: ${selector}`);
    return el;
  }

  private static markup(): string {
    return `
      <div id="crosshair">
        <div class="ch-line" data-dir="up"></div>
        <div class="ch-line" data-dir="down"></div>
        <div class="ch-line" data-dir="left"></div>
        <div class="ch-line" data-dir="right"></div>
        <div class="ch-dot"></div>
      </div>
      <div id="hitmarker"><span></span><span></span><span></span><span></span></div>

      <div id="scope" class="hidden">
        <div class="scope-mask"></div>
        <div class="scope-ring"></div>
        <div class="scope-reticle"></div>
      </div>

      <div id="damage-layer"></div>

      <div id="ammo" class="panel">
        <div class="weapon-name">—</div>
        <div class="counts"><span class="mag">0</span><span class="reserve">/ 0</span></div>
        <div class="mode">SEMI</div>
        <div class="reload-hint hidden">PRESS R TO RELOAD</div>
      </div>

      <div id="loadout" class="panel"></div>

      <div id="vitals" class="panel">
        <div class="row">
          <span class="label">HP</span>
          <span class="bar"><div id="health-fill"></div></span>
          <span class="value" id="health-value">100</span>
        </div>
        <div class="row">
          <span class="label">STAM</span>
          <span class="bar"><div id="stamina-fill"></div></span>
          <span class="value" id="stamina-value">100</span>
        </div>
      </div>

      <div id="range-stats" class="panel">
        <div class="stat"><div class="k">SCORE</div><div class="v accent" id="stat-score">0</div></div>
        <div class="stat"><div class="k">HITS</div><div class="v" id="stat-hits">0 / 0</div></div>
        <div class="stat"><div class="k">ACCURACY</div><div class="v" id="stat-accuracy">—</div></div>
      </div>

      <div id="throwables" class="panel">
        <div class="tw-name">FRAG</div>
        <div class="tw-count"><span id="tw-count">0</span><span class="tw-x">x</span></div>
        <div class="tw-cook"><div id="tw-cook-fill"></div></div>
      </div>

      <div id="vehicle" class="panel hidden">
        <div class="veh-name">—</div>
        <div class="veh-speed"><span id="veh-kph">0</span><span class="veh-unit">KM/H</span></div>
        <div class="veh-revs"><div id="veh-rev-fill"></div></div>
        <div class="veh-row"><span class="k">GEAR</span><span class="v" id="veh-gear">N</span></div>
        <div class="veh-row"><span class="k">LAP</span><span class="v" id="veh-lap">0</span></div>
        <div class="veh-row"><span class="k">TIME</span><span class="v" id="veh-time">—</span></div>
        <div class="veh-row"><span class="k">BEST</span><span class="v accent" id="veh-best">—</span></div>
        <div class="veh-row veh-reload hidden"><span class="k">GUN</span><span class="v" id="veh-reload">READY</span></div>
      </div>

      <div id="drill-banner" class="panel hidden"></div>
      <div id="event-log"></div>
      <div id="prompt" class="hidden"></div>
      <div id="flash-overlay"></div>
      <div id="damage-vignette"></div>
      <div id="low-health-vignette"></div>
      <div id="fps"></div>
    `;
  }

  private buildLoadout(): void {
    for (const id of WEAPON_ORDER) {
      const cfg = WEAPON_CONFIGS[id];
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<span class="key">${cfg.slot}</span><span>${cfg.category}</span>`;
      this.loadoutEl.appendChild(el);
      this.slotEls.set(id, el);
    }
  }

  private buildScopeReticle(): void {
    const reticle = this.q('#scope .scope-reticle');
    // Mil-dot ladder below the centre for holdover reference.
    for (let i = 1; i <= 5; i++) {
      const dot = document.createElement('div');
      dot.className = 'mil-dot';
      dot.style.top = `calc(50% + ${i * 4}%)`;
      dot.style.width = `${12 - i}px`;
      reticle.appendChild(dot);
    }
  }

  // ------------------------------------------------------------------ update

  update(dt: number, frame: HudFrame): void {
    this.updateCrosshair(dt, frame);
    this.updateAmmo(frame);
    this.updateVitals(frame);
    this.updateStats(frame);
    this.updatePrompt(frame);
    this.updateThrowables(frame);
    this.updateVehicle(frame);
    this.updateDamageNumbers(dt);
    this.updateVignettes(dt, frame);

    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= dt;
      if (this.hitmarkerTimer <= 0) this.hitmarker.classList.remove('show');
    }
  }

  private updateCrosshair(dt: number, frame: HudFrame): void {
    // Matches SCOPE_HIDE_THRESHOLD in ViewModel so the overlay is already
    // covering the screen by the time the weapon model disappears.
    const scoped = frame.showScope && frame.ads > 0.78;
    this.scope.classList.toggle('hidden', !scoped);
    if (scoped) this.scope.style.opacity = String(clamp((frame.ads - 0.78) / 0.06, 0, 1));

    const visible = this.showCrosshair && !scoped && frame.ads < 0.85;
    this.crosshair.style.opacity = visible ? String(1 - frame.ads * 0.8) : '0';
    if (!visible) return;

    // Convert the spread cone into on-screen pixels so the crosshair honestly
    // represents where rounds can land.
    const halfFovRad = (frame.fov * Math.PI) / 360;
    const pxPerRad = frame.viewportHeight / 2 / Math.tan(halfFovRad);
    const spreadPx = Math.tan((frame.spread * Math.PI) / 180) * pxPerRad;
    const targetGap = clamp(frame.weapon.crosshairGap * 0.4 + spreadPx, 3, 190);

    this.crosshairGapSmooth = lerp(this.crosshairGapSmooth, targetGap, 1 - Math.exp(-22 * dt));
    const gap = this.crosshairGapSmooth;
    const len = clamp(6 + gap * 0.12, 5, 14);
    const thickness = 2;

    for (const line of this.chLines) {
      const dir = line.dataset.dir;
      if (dir === 'up') {
        line.style.width = `${thickness}px`;
        line.style.height = `${len}px`;
        line.style.left = `${-thickness / 2}px`;
        line.style.top = `${-gap - len}px`;
      } else if (dir === 'down') {
        line.style.width = `${thickness}px`;
        line.style.height = `${len}px`;
        line.style.left = `${-thickness / 2}px`;
        line.style.top = `${gap}px`;
      } else if (dir === 'left') {
        line.style.width = `${len}px`;
        line.style.height = `${thickness}px`;
        line.style.top = `${-thickness / 2}px`;
        line.style.left = `${-gap - len}px`;
      } else {
        line.style.width = `${len}px`;
        line.style.height = `${thickness}px`;
        line.style.top = `${-thickness / 2}px`;
        line.style.left = `${gap}px`;
      }
    }
    this.chDot.style.opacity = frame.weapon.pellets > 1 ? '0' : '0.85';
  }

  private updateAmmo(frame: HudFrame): void {
    if (frame.weapon.id !== this.lastWeapon) {
      this.lastWeapon = frame.weapon.id;
      this.weaponNameEl.textContent = frame.weapon.name;
      for (const [id, el] of this.slotEls) el.classList.toggle('active', id === frame.weapon.id);
    }
    if (frame.ammo !== this.lastAmmo) {
      this.lastAmmo = frame.ammo;
      this.magEl.textContent = String(frame.ammo);
      const ratio = frame.ammo / Math.max(1, frame.magSize);
      this.magEl.classList.toggle('low', ratio <= 0.3 && frame.ammo > 0);
      this.magEl.classList.toggle('empty', frame.ammo === 0);
    }
    if (frame.reserve !== this.lastReserve) {
      this.lastReserve = frame.reserve;
      this.reserveEl.textContent = `/ ${frame.reserve}`;
    }
    if (frame.fireMode !== this.lastMode) {
      this.lastMode = frame.fireMode;
      this.modeEl.textContent = frame.fireMode.toUpperCase();
    }
    const needsReload = frame.ammo === 0 && frame.reserve > 0 && !frame.reloading;
    this.reloadHintEl.classList.toggle('hidden', !needsReload);
  }

  private updateVitals(frame: HudFrame): void {
    const hp = Math.round(frame.health);
    if (hp !== this.lastHealth) {
      this.lastHealth = hp;
      const ratio = clamp(frame.health / frame.maxHealth, 0, 1);
      this.healthFill.style.width = `${ratio * 100}%`;
      this.healthValue.textContent = String(hp);
      this.healthFill.classList.toggle('hurt', ratio <= 0.6 && ratio > 0.3);
      this.healthFill.classList.toggle('critical', ratio <= 0.3);
    }
    const st = Math.round(frame.stamina);
    if (st !== this.lastStamina) {
      this.lastStamina = st;
      this.staminaFill.style.width = `${clamp(frame.stamina / frame.maxStamina, 0, 1) * 100}%`;
      this.staminaValue.textContent = String(st);
    }
  }

  private updateStats(frame: HudFrame): void {
    if (frame.score !== this.lastScore) {
      this.lastScore = frame.score;
      this.scoreEl.textContent = frame.score.toLocaleString();
    }
    const acc =
      frame.shotsFired > 0 ? `${Math.round((frame.shotsHit / frame.shotsFired) * 100)}%` : '—';
    const hits = `${frame.shotsHit} / ${frame.shotsFired}`;
    if (acc !== this.lastAccuracy) {
      this.lastAccuracy = acc;
      this.accuracyEl.textContent = acc;
      this.hitsEl.textContent = hits;
    }

    const drill =
      frame.drillText === null
        ? ''
        : frame.drillTime !== null
          ? `${frame.drillText} — ${frame.drillTime.toFixed(1)}s`
          : frame.drillText;
    if (drill !== this.lastDrill) {
      this.lastDrill = drill;
      this.drillBanner.textContent = drill;
      this.drillBanner.classList.toggle('hidden', drill === '');
    }
  }

  private updatePrompt(frame: HudFrame): void {
    const key = frame.prompt === null ? '' : `${frame.promptKey ?? ''}|${frame.prompt}`;
    if (key === this.lastPrompt) return;
    this.lastPrompt = key;
    if (frame.prompt === null) {
      this.promptEl.classList.add('hidden');
      return;
    }
    this.promptEl.classList.remove('hidden');
    this.promptEl.innerHTML = frame.promptKey
      ? `<span class="key">${frame.promptKey}</span>${frame.prompt}`
      : frame.prompt;
  }

  private updateThrowables(frame: HudFrame): void {
    if (!frame.throwable) {
      this.throwablePanel.classList.add('hidden');
      this.lastThrowable = ' ';
      return;
    }
    this.throwablePanel.classList.remove('hidden');
    const key = `${frame.throwable.name}|${frame.throwable.count}`;
    if (key !== this.lastThrowable) {
      this.lastThrowable = key;
      this.throwableName.textContent = frame.throwable.name;
      this.throwableCount.textContent = String(frame.throwable.count);
      this.throwablePanel.classList.toggle('empty', frame.throwable.count === 0);
    }
    this.throwableCook.style.width = `${clamp(frame.throwable.cook, 0, 1) * 100}%`;
    this.throwablePanel.classList.toggle('cooking', frame.throwable.cook > 0);
  }

  /**
   * Flash blindness: a white overlay that decays. `amount` is 0..1 and the
   * effect stacks so a second bang while already blind keeps you down longer.
   */
  /**
   * The dash replaces the weapon panels while driving — showing an ammo count
   * and a crosshair for a gun the player cannot reach would just be noise.
   */
  private updateVehicle(frame: HudFrame): void {
    const v = frame.vehicle;
    const driving = v !== null;
    this.vehicleEl.classList.toggle('hidden', !driving);
    this.ammoPanel.classList.toggle('hidden', driving);
    this.loadoutEl.classList.toggle('hidden', driving);
    this.throwablePanel.classList.toggle('hidden', driving);
    if (!v) return;

    if (this.lastVehicleName !== v.name) {
      this.lastVehicleName = v.name;
      this.vehNameEl.textContent = v.name;
    }
    const kph = Math.round(v.speedKph);
    if (this.lastKph !== kph) {
      this.lastKph = kph;
      this.vehKphEl.textContent = `${kph}`;
    }
    this.vehRevEl.style.width = `${Math.round(clamp(v.revs, 0, 1) * 100)}%`;
    this.vehRevEl.classList.toggle('redline', v.revs > 0.92);
    if (this.lastGear !== v.gear) {
      this.lastGear = v.gear;
      this.vehGearEl.textContent = v.gear;
    }
    this.vehLapEl.textContent = `${v.laps}`;
    this.vehTimeEl.textContent = v.lapTime;
    this.vehBestEl.textContent = v.bestLap;

    this.vehReloadRow.classList.toggle('hidden', v.reload === null);
    if (v.reload !== null) {
      const ready = v.reload >= 1;
      this.vehReloadEl.textContent = ready ? 'READY' : `${Math.round(v.reload * 100)}%`;
      this.vehReloadEl.classList.toggle('accent', ready);
    }
  }

  applyFlash(amount: number): void {
    this.flashAmount = clamp(Math.max(this.flashAmount, amount), 0, 1);
  }

  get flashLevel(): number {
    return this.flashAmount;
  }

  private updateVignettes(dt: number, frame: HudFrame): void {
    if (this.flashAmount > 0) {
      // Slow at first (full whiteout), then clears quickly.
      this.flashAmount = Math.max(0, this.flashAmount - dt * (0.12 + this.flashAmount * 0.22));
      this.flashOverlay.style.opacity = String(Math.min(1, this.flashAmount * 1.35));
    }

    if (this.damageFlash > 0) {
      this.damageFlash = Math.max(0, this.damageFlash - dt * 1.8);
      this.damageVignette.style.opacity = String(this.damageFlash * 0.8);
    }
    const ratio = clamp(frame.health / frame.maxHealth, 0, 1);
    this.lowHealthVignette.style.opacity = ratio < 0.35 ? String((0.35 - ratio) * 2.4) : '0';
  }

  private updateDamageNumbers(dt: number): void {
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const d = this.damageNumbers[i];
      d.life -= dt;
      if (d.life <= 0) {
        d.el.remove();
        this.damageNumbers.splice(i, 1);
        continue;
      }
      d.vy += 55 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      const t = d.life / d.maxLife;
      d.el.style.transform = `translate(-50%, -50%) translate(${d.x}px, ${d.y}px) scale(${0.85 + t * 0.35})`;
      d.el.style.opacity = String(Math.min(1, t * 2));
    }
  }

  // ------------------------------------------------------------------ events

  showHitmarker(headshot: boolean): void {
    this.hitmarker.classList.remove('show');
    this.hitmarker.classList.toggle('headshot', headshot);
    // Force a reflow so the animation restarts on rapid consecutive hits.
    void this.hitmarker.offsetWidth;
    this.hitmarker.classList.add('show');
    this.hitmarkerTimer = 0.24;
  }

  /** Spawns a floating number at a screen position. */
  spawnDamageNumber(
    screenX: number,
    screenY: number,
    text: string,
    kind: 'damage' | 'headshot' | 'score' = 'damage',
  ): void {
    if (!this.showDamageNumbers) return;
    if (this.damageNumbers.length > 26) {
      const oldest = this.damageNumbers.shift();
      oldest?.el.remove();
    }
    const el = document.createElement('div');
    el.className = `damage-number${kind === 'headshot' ? ' headshot' : kind === 'score' ? ' score' : ''}`;
    el.textContent = text;
    el.style.left = `${screenX}px`;
    el.style.top = `${screenY}px`;
    this.damageLayer.appendChild(el);

    this.damageNumbers.push({
      el,
      life: 1.1,
      maxLife: 1.1,
      x: 0,
      y: 0,
      vx: (Math.random() - 0.5) * 40,
      vy: -70,
    });
  }

  logEvent(text: string, kind: 'info' | 'good' | 'warn' = 'info'): void {
    const entry = document.createElement('div');
    entry.className = `entry${kind === 'good' ? ' good' : kind === 'warn' ? ' warn' : ''}`;
    entry.textContent = text;
    this.eventLog.appendChild(entry);
    while (this.eventLog.children.length > 6) this.eventLog.removeChild(this.eventLog.children[0]);
    window.setTimeout(() => entry.remove(), 4200);
  }

  flashDamage(intensity = 1): void {
    this.damageFlash = clamp(this.damageFlash + intensity, 0, 1.3);
  }

  setFpsText(text: string): void {
    this.fpsEl.classList.toggle('hidden', !this.showFps);
    if (this.showFps) this.fpsEl.textContent = text;
  }

  setVisible(visible: boolean): void {
    this.root.style.opacity = visible ? '1' : '0';
  }

  clearTransient(): void {
    for (const d of this.damageNumbers) d.el.remove();
    this.damageNumbers.length = 0;
    this.eventLog.innerHTML = '';
    this.flashAmount = 0;
    this.flashOverlay.style.opacity = '0';
  }
}
