import type { GunshotProfile } from '../audio/AudioEngine';

export type WeaponId =
  | 'pistol'
  | 'machinePistol'
  | 'revolver'
  | 'smg'
  | 'rifle'
  | 'dmr'
  | 'sniper'
  | 'lmg'
  | 'shotgun'
  | 'autoShotgun';

export type FireMode = 'semi' | 'auto' | 'burst';

/** How the action is cycled — drives both animation and audio. */
export type ActionType = 'slide' | 'bolt' | 'pump' | 'gas' | 'cylinder';

export interface SpreadConfig {
  /** Cone half-angle in degrees while hip firing, standing still. */
  hip: number;
  /** Cone half-angle in degrees while aiming down sights. */
  ads: number;
  /** Added while moving at full speed. */
  moving: number;
  /** Added while airborne. */
  jumping: number;
  /** Multiplier applied while crouched (< 1 tightens). */
  crouchScale: number;
  /** Added per shot fired (bloom). */
  perShot: number;
  /** Degrees per second the bloom decays. */
  recovery: number;
  /** Hard ceiling on accumulated bloom. */
  max: number;
}

export interface RecoilConfig {
  /** Degrees of upward camera kick per shot. */
  vertical: number;
  /** Degrees of horizontal camera kick per shot (sign is randomised). */
  horizontal: number;
  /** Random +/- variance applied to both axes, as a fraction. */
  randomness: number;
  /** How fast the camera returns to the pre-fire aim, higher is faster. */
  recovery: number;
  /** Fraction of recoil that is *not* auto-recovered (0..1). */
  permanence: number;
  /** Backward push on the view model, metres. */
  kickback: number;
  /** Weapon model pitch kick, degrees. */
  modelPitch: number;
  /** Camera shake intensity. */
  shake: number;
  /**
   * Optional fixed recoil pattern (degrees, x = horizontal, y = vertical).
   * Applied for the first N shots of a magazine before falling back to random.
   */
  pattern?: ReadonlyArray<readonly [number, number]>;
}

export interface ViewModelTuning {
  /** Extra offset applied on top of the auto-computed hip pose. */
  hipOffset: [number, number, number];
  hipRotation: [number, number, number];
  /** Distance in front of the camera the sight line is placed when aiming. */
  adsDistance: number;
  /** Multiplier for sway/bob — heavy weapons move less. */
  swayScale: number;
  scale: number;
}

export interface WeaponConfig {
  id: WeaponId;
  name: string;
  /** Short label used in the HUD. */
  category: string;
  slot: number;

  // --- ballistics -------------------------------------------------------
  damage: number;
  headshotMultiplier: number;
  limbMultiplier: number;
  pellets: number;
  /** Extra cone applied to individual pellets, degrees. */
  pelletSpread: number;
  /** Distance (m) at which damage starts falling off. */
  falloffStart: number;
  /** Distance (m) at which damage reaches `minDamageScale`. */
  falloffEnd: number;
  minDamageScale: number;
  /** How many surfaces a round can punch through. 0 stops at the first hit. */
  penetration: number;
  /** Damage retained after each penetrated surface. */
  penetrationDamageScale: number;
  /** Metres per second — drives tracer travel speed. */
  muzzleVelocity: number;

  // --- handling ---------------------------------------------------------
  rpm: number;
  fireModes: readonly FireMode[];
  burstCount: number;
  /** Delay between rounds inside a burst, seconds. */
  burstDelay: number;
  actionType: ActionType;
  /** Extra time to cycle a bolt/pump action after each shot, seconds. */
  cycleTime: number;

  magSize: number;
  reserveAmmo: number;
  maxReserveAmmo: number;
  reloadTime: number;
  reloadEmptyTime: number;
  /** Shotgun-style one-shell-at-a-time reloading. */
  shellReload: boolean;
  shellReloadTime: number;

  drawTime: number;
  holsterTime: number;
  adsTime: number;
  /** Base FOV is multiplied by this while aiming. */
  adsFovScale: number;
  /** When set, a scope overlay is drawn and the FOV uses this instead. */
  scopeFov?: number;
  /** Movement speed multiplier while aiming. */
  adsMoveScale: number;
  /** Movement speed multiplier while simply holding the weapon. */
  weightMoveScale: number;

  spread: SpreadConfig;
  recoil: RecoilConfig;
  viewModel: ViewModelTuning;

  // --- presentation -----------------------------------------------------
  audio: GunshotProfile;
  /** Muzzle flash scale multiplier. */
  flashScale: number;
  flashColor: number;
  tracerColor: number;
  tracerWidth: number;
  /** 0..1 chance a round leaves a visible tracer. */
  tracerChance: number;
  ejectsShells: boolean;
  shellScale: number;
  /** Light intensity of the muzzle flash point light. */
  flashLightIntensity: number;
  /** Crosshair resting gap in pixels. */
  crosshairGap: number;
  description: string;
}
