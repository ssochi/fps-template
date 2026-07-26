export type QualityLevel = 'low' | 'medium' | 'high';

export interface GameSettings {
  sensitivity: number;
  adsSensitivityScale: number;
  invertY: boolean;
  fov: number;
  masterVolume: number;
  sfxVolume: number;
  quality: QualityLevel;
  showFps: boolean;
  toggleAds: boolean;
  toggleCrouch: boolean;
  viewBob: number;
  crosshairEnabled: boolean;
  damageNumbers: boolean;
}

const STORAGE_KEY = 'fps-template.settings.v1';

export const DEFAULT_SETTINGS: GameSettings = {
  sensitivity: 1.0,
  adsSensitivityScale: 0.6,
  invertY: false,
  fov: 85,
  masterVolume: 0.8,
  sfxVolume: 1.0,
  quality: 'high',
  showFps: true,
  toggleAds: false,
  toggleCrouch: false,
  viewBob: 1.0,
  crosshairEnabled: true,
  damageNumbers: true,
};

export class Settings {
  private data: GameSettings;

  constructor() {
    this.data = { ...DEFAULT_SETTINGS, ...Settings.load() };
  }

  private static load(): Partial<GameSettings> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Partial<GameSettings>) : {};
    } catch {
      return {};
    }
  }

  get current(): Readonly<GameSettings> {
    return this.data;
  }

  get<K extends keyof GameSettings>(key: K): GameSettings[K] {
    return this.data[key];
  }

  set<K extends keyof GameSettings>(key: K, value: GameSettings[K]): void {
    if (this.data[key] === value) return;
    this.data[key] = value;
    this.persist();
  }

  reset(): void {
    this.data = { ...DEFAULT_SETTINGS };
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable — settings simply won't persist */
    }
  }
}
