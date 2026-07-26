import * as THREE from 'three';
import { Input, MOUSE_LEFT, MOUSE_RIGHT } from './Input';
import { Settings, type QualityLevel } from './Settings';
import { RenderPipeline, QUALITY_PRESETS } from './RenderPipeline';
import { clamp } from './MathUtils';
import { CollisionWorld } from '../physics/CollisionWorld';
import { ShootingRange } from '../world/ShootingRange';
import { RaceTrack } from '../world/RaceTrack';
import { LEVELS, mergeDisplayModel, type LevelBuildResult, type LevelId } from '../world/LevelBuilder';
import { RangeSession } from '../world/RangeSession';
import type { RangeTarget, TargetEvent } from '../world/Targets';
import { Player, type PlayerInputState } from '../player/Player';
import { CameraController } from '../player/CameraController';
import { ViewModel } from '../player/ViewModel';
import { CharacterModel } from '../player/CharacterModel';
import { WeaponSystem, type HitInfo, type ShotInfo, type WeaponInput } from '../weapons/WeaponSystem';
import { WEAPON_CONFIGS, WEAPON_ORDER } from '../weapons/WeaponConfigs';
import type { WeaponConfig, WeaponId } from '../weapons/WeaponTypes';
import { buildWeaponModel } from '../weapons/WeaponMeshes';
import { ThrowableSystem } from '../weapons/ThrowableSystem';
import type { ThrowableConfig } from '../weapons/ThrowableConfigs';
import { VehicleSystem, type VehicleInstance } from '../vehicles/VehicleSystem';
import { LapTimer } from '../vehicles/LapTimer';
import type { VehicleConfig } from '../vehicles/VehicleConfigs';
import { EffectsSystem } from '../fx/EffectsSystem';

/** Footfall dust is kicked straight up. */
const THOR_UP = new THREE.Vector3(0, 1, 0);
import { AudioEngine, type ImpactMaterial } from '../audio/AudioEngine';
import { HUD } from '../ui/HUD';
import { Menu } from '../ui/Menu';

type GameState = 'loading' | 'menu' | 'playing' | 'paused' | 'dead';

/** Slot keys 1-9 then 0, matching `WEAPON_ORDER`. */
const SLOT_KEYS = [
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Digit0',
];

/**
 * Wires every subsystem together and owns the frame loop.
 *
 * Order of operations each frame is deliberate: input -> player physics ->
 * camera -> weapons -> view model / character -> world FX -> HUD. Placing the
 * camera before the weapons means a shot fired this frame is traced along the
 * aim the player is actually looking at, with no frame of input lag.
 */
export class Game {
  private readonly container: HTMLElement;
  private readonly settings = new Settings();
  private readonly input: Input;

  private readonly scene = new THREE.Scene();
  private readonly collision = new CollisionWorld();
  private level!: LevelBuildResult;
  private session!: RangeSession;

  private readonly player: Player;
  private readonly cameraController: CameraController;
  private readonly viewModel: ViewModel;
  private readonly character: CharacterModel;
  private readonly weapons: WeaponSystem;
  private readonly throwables: ThrowableSystem;
  private readonly vehicles: VehicleSystem;
  private lapTimer: LapTimer | null = null;
  private readonly effects = new EffectsSystem();
  private readonly audio = new AudioEngine();
  private readonly pipeline: RenderPipeline;

  private readonly hud: HUD;
  private readonly menu: Menu;

  private state: GameState = 'loading';
  private running = false;
  private lastTime = 0;
  private accumulatedFps = 0;
  private fpsFrames = 0;
  private fpsTimer = 0;
  private displayFps = 0;

  private adsToggleState = false;
  private hudVisible = true;
  private appliedQuality: QualityLevel | null = null;
  private lastWeaponId: WeaponId = 'pistol';
  private collisionDebug: THREE.Object3D | null = null;
  /** Level geometry plus the vehicle group; rebuilt on every level load. */
  private raycastTargets: THREE.Object3D[] = [];
  private interactTarget: 'ammo' | 'vehicle' | WeaponId | null = null;
  private interactVehicle: VehicleInstance | null = null;
  /** Sits in the driver's seat rather than on the boom. */
  private cockpitView = false;

  // Scratch objects — the frame loop must not allocate.
  private readonly raycaster = new THREE.Raycaster();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly tmpVec3 = new THREE.Vector3();
  private readonly tmpAimPoint = new THREE.Vector3();
  private readonly tmpProjection = new THREE.Vector3();
  private readonly tmpScreen = new THREE.Vector2();
  private readonly fireDirection = new THREE.Vector3();
  private readonly worldMuzzle = new THREE.Vector3();
  private readonly ejectOrigin = new THREE.Vector3();
  private readonly hitCentre = new THREE.Vector3();

  constructor(container: HTMLElement, hudRoot: HTMLElement, menuRoot: HTMLElement) {
    this.container = container;

    // --- vehicles ---------------------------------------------------------
    // Built before the level, because `buildLevel` populates it from the
    // level's spawn list.
    this.vehicles = new VehicleSystem(this.collision, {
      getCollidables: () => this.level.collidables,
      onCannonFire: (position, config) => this.onCannonFire(position, config),
      onShellImpact: (position, payload) => this.onShellImpact(position, payload),
      onMechCannon: (origin, direction, config) => this.onMechCannon(origin, direction, config),
      onBarrage: (position) => {
        this.audio.playCannon(position);
        this.cameraController.addTrauma(0.4);
        this.hud.logEvent('Javelin salvo away', 'good');
      },
      onFootfall: (position, hard) => {
        this.audio.playVehicleImpact(position, clamp(hard * 0.55, 0.15, 0.6));
        this.effects.spawnImpact(position, THOR_UP, 'dirt', 0.9 + hard);
        this.cameraController.addTrauma(0.06 + hard * 0.06);
      },
      onCollide: (instance, impact) => {
        this.audio.playVehicleImpact(instance.position, clamp(impact / 14, 0.2, 1));
        this.cameraController.addTrauma(clamp(impact / 24, 0.1, 0.7));
        this.player.damage(clamp(impact - 8, 0, 30), 'fall');
      },
    });
    this.scene.add(this.vehicles.group);

    // --- world -----------------------------------------------------------
    // `buildLevel` fills in `level` and `session`; the definite-assignment
    // assertions on those fields exist because it runs here rather than inline.
    this.buildLevel(this.settings.get('level'));
    this.scene.add(this.effects.group);

    // --- player ----------------------------------------------------------
    const aspect = window.innerWidth / window.innerHeight;
    this.player = new Player(this.collision, {
      onFootstep: (surface, running) => this.audio.playFootstep(surface, running),
      onJump: () => this.audio.playJump(),
      onLand: (hard, speed) => {
        this.audio.playLand(hard);
        this.cameraController.onLand(speed);
      },
      onSlideStart: () => this.audio.playFootstep('concrete', true),
      onDamage: (amount, source) => {
        this.audio.playHurt();
        this.hud.flashDamage(clamp(amount / 40, 0.25, 1));
        if (source === 'fall') this.hud.logEvent(`Fall damage −${Math.round(amount)}`, 'warn');
      },
      onDeath: () => this.onPlayerDeath(),
    });
    this.player.teleport(this.level.spawnPoint, this.level.spawnYaw);

    this.cameraController = new CameraController(aspect, this.settings.get('fov'));
    this.cameraController.collidables = this.level.collidables;

    this.viewModel = new ViewModel(aspect);
    this.character = new CharacterModel();
    this.scene.add(this.character.root);

    // --- UI --------------------------------------------------------------
    this.hud = new HUD(hudRoot);
    this.menu = new Menu(menuRoot, this.settings, {
      onStart: () => this.startPlaying(),
      onResume: () => this.startPlaying(),
      onRespawn: () => this.respawn(),
      onLevelChosen: (id) => this.loadLevel(id),
      onResetRange: () => {
        this.session.resetAll();
        this.effects.clear();
        this.weapons.refillAll();
        this.throwables.clear();
        this.throwables.refill();
        this.hud.clearTransient();
        this.hud.logEvent('Range reset', 'good');
      },
      onSettingsChanged: () => this.applySettings(),
    });

    // --- weapons ---------------------------------------------------------
    this.weapons = new WeaponSystem(
      {
        getFireRay: (origin, direction) => this.getFireRay(origin, direction),
        raycast: (origin, direction, maxDistance, ignore) =>
          this.raycastWorld(origin, direction, maxDistance, ignore),
        onShotFired: (shots, config) => this.onShotFired(shots, config),
        onHit: (hit, config) => this.onHit(hit, config),
        onDryFire: (config) => {
          void config;
          this.audio.playDryFire();
        },
        onReloadStart: (config, kind) => {
          void config;
          if (kind !== 'shell') this.audio.playAction('trigger');
        },
        onReloadStep: (config, step) => {
          void config;
          this.audio.playReloadStep(step);
        },
        onReloadEnd: (config) => {
          if (config.shellReload) this.audio.playAction('pump');
        },
        onCycle: (config) => {
          this.audio.playAction(config.actionType === 'pump' ? 'pump' : 'bolt');
        },
        onEquip: (config) => this.onEquipWeapon(config),
        onAdsChange: (config, aiming) => {
          void config;
          this.audio.playAds(aiming);
        },
        onFireModeChange: (config, mode) => {
          void config;
          this.audio.playUi('click');
          this.hud.logEvent(`Fire mode: ${mode.toUpperCase()}`);
        },
        onAmmoChanged: () => {
          /* HUD reads ammo every frame; hook kept for external listeners */
        },
      },
      'rifle',
    );

    this.throwables = new ThrowableSystem(this.collision, {
      getThrowRay: (origin, direction) => this.getThrowRay(origin, direction),
      onPinPulled: () => this.audio.playPinPull(),
      onThrown: (config, projectile) => {
        void projectile;
        this.audio.playThrow();
        this.hud.logEvent(`${config.category} out`);
      },
      onBounce: (projectile, surface, speed) =>
        this.audio.playGrenadeBounce(
          surface as ImpactMaterial,
          projectile.position,
          clamp(speed / 8, 0.15, 1),
        ),
      onDetonate: (config, position) => this.onDetonate(config, position),
      onSelectionChanged: (config) => {
        this.audio.playUi('click');
        this.hud.logEvent(`${config.name}`);
      },
      onEmpty: () => this.audio.playUi('deny'),
    });
    this.scene.add(this.throwables.group);

    this.effects.onShellLanded = (position) => this.audio.playShellDrop(position);

    // --- rendering -------------------------------------------------------
    this.pipeline = new RenderPipeline(
      container,
      this.scene,
      this.cameraController.camera,
      this.viewModel.scene,
      this.viewModel.camera,
    );
    this.pipeline.onQualityApplied = (preset) => {
      this.effects.particleScale = preset.particleScale;
      this.effects.dynamicMuzzleLight = preset.dynamicMuzzleLight;
      this.effects.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatio));
      void preset;
      this.applyLevelQuality();
    };

    this.input = new Input(this.pipeline.canvas);
    this.input.onPointerLockChange((locked) => this.onPointerLockChange(locked));

    this.applySettings();
    window.addEventListener('resize', this.handleResize);
    this.handleResize();
  }

  // ---------------------------------------------------------------- startup

  start(): void {
    this.menu.hideLoading();
    this.state = 'menu';
    this.menu.show('start');
    this.hud.setVisible(false);
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.loop);
  }

  private startPlaying(): void {
    void this.audio.resume();
    this.audio.setMuffled(false);
    this.state = 'playing';
    this.menu.show('none');
    this.hud.setVisible(true);
    this.input.enabled = true;
    this.input.requestPointerLock();
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.menu.show('pause');
    this.audio.setMuffled(true);
    this.input.clear();
    this.input.exitPointerLock();
  }

  private onPointerLockChange(locked: boolean): void {
    if (!locked && this.state === 'playing') this.pause();
  }

  private onPlayerDeath(): void {
    this.state = 'dead';
    this.menu.setDeathSummary(
      `Score ${this.session.score.toLocaleString()} · accuracy ${Math.round(
        this.session.accuracy * 100,
      )}%`,
    );
    this.menu.show('death');
    this.input.exitPointerLock();
  }

  private respawn(): void {
    this.player.respawn(this.level.spawnPoint, this.level.spawnYaw);
    this.cameraController.reset();
    this.character.reset();
    this.weapons.refillAll();
    this.throwables.clear();
    this.throwables.refill();
    this.hud.clearTransient();
    this.startPlaying();
  }

  // ------------------------------------------------------------------ levels

  /** Builds a level and wires everything that points at level content. */
  private buildLevel(id: LevelId): void {
    const builder = id === 'circuit' ? new RaceTrack(this.collision) : new ShootingRange(this.collision);
    this.level = builder.build();
    this.scene.add(this.level.root);
    this.scene.background = this.level.background;
    this.scene.fog = this.level.fog;

    this.session = new RangeSession(this.level.targets);
    for (const target of this.level.targets) {
      target.onStateChange = (t, event) => this.onTargetStateChange(t, event);
    }
    this.populatePedestals();

    this.vehicles.spawnAll(this.level.vehicles);
    this.lapTimer = this.level.lapCourse ? new LapTimer(this.level.lapCourse) : null;
    this.raycastTargets = [...this.level.collidables, this.vehicles.group];
  }

  /**
   * Swaps maps at runtime. The collision world, session and all level-owned
   * GPU resources belong to the level, so they are torn down and rebuilt
   * together; everything else (player, weapons, HUD) simply re-points.
   */
  loadLevel(id: LevelId): void {
    if (this.level && this.level.id === id) {
      this.menu.markActiveLevel(id);
      return;
    }

    if (this.collisionDebug) {
      this.scene.remove(this.collisionDebug);
      this.collisionDebug = null;
    }
    if (this.vehicles.driving) this.leaveVehicle(false);
    this.vehicles.clear();
    this.scene.remove(this.level.root);
    this.level.dispose();
    this.collision.clear();
    this.effects.clear();
    this.throwables.clear();

    this.buildLevel(id);
    this.settings.set('level', id);
    this.menu.markActiveLevel(id);

    this.cameraController.collidables = this.level.collidables;
    this.player.respawn(this.level.spawnPoint, this.level.spawnYaw);
    this.cameraController.reset();
    this.character.reset();
    this.weapons.refillAll();
    this.throwables.refill();
    this.hud.clearTransient();

    // The sun and the optional lights are new objects, so the quality preset
    // has to be pushed at them again.
    this.applyLevelQuality();
    this.hud.logEvent(`Map: ${this.level.name}`, 'good');
  }

  private applyLevelQuality(): void {
    const preset = QUALITY_PRESETS[this.settings.get('quality')];
    this.level.sun.castShadow = preset.shadows;
    this.level.sun.shadow.mapSize.setScalar(preset.shadowMapSize);
    this.level.sun.shadow.map?.dispose();
    this.level.sun.shadow.map = null;
    for (const light of this.level.optionalLights) light.visible = preset.optionalLights;
    for (const object of this.level.atmospherics) object.visible = preset.atmospherics;
  }

  private populatePedestals(): void {
    for (const pickup of this.level.pickups) {
      const model = buildWeaponModel(pickup.id);
      // Scale each gun so they read at a similar size on their pedestal.
      const scale = clamp(1.05 / Math.max(0.3, model.length), 0.85, 1.9);
      model.root.scale.setScalar(scale);
      model.root.rotation.set(0, 0, 0.35);
      // Display models never animate, so flatten them to one mesh per material
      // instead of paying ~50 draw calls per pedestal.
      pickup.display.add(mergeDisplayModel(model.root, `display-${pickup.id}`));
    }
  }

  private applySettings(): void {
    const s = this.settings.current;
    this.cameraController.setBaseFov(s.fov);
    this.audio.setMasterVolume(s.masterVolume);
    this.audio.setSfxVolume(s.sfxVolume);
    this.hud.showCrosshair = s.crosshairEnabled;
    this.hud.showDamageNumbers = s.damageNumbers;
    this.hud.showFps = s.showFps;
    this.player.toggleCrouchEnabled = s.toggleCrouch;

    // Rebuilding the composer is expensive; only do it when the preset changes
    // rather than on every slider drag.
    if (s.quality !== this.appliedQuality) {
      this.appliedQuality = s.quality;
      this.pipeline.applyQuality(s.quality);
    }
  }

  private handleResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.pipeline.resize(w, h);
    this.cameraController.setAspect(w / h);
    this.viewModel.setAspect(w / h);
  };

  // ------------------------------------------------------------------- loop

  private loop = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);

    // Clamp dt so a background tab or a hitch can't tunnel the player through
    // the world when the tab regains focus.
    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = Math.min(0.05, Math.max(0.0001, rawDt));

    this.updateFpsCounter(rawDt);

    if (this.state === 'playing') {
      this.update(dt);
    } else {
      // Keep transient visuals alive behind the menus.
      this.effects.update(dt, this.cameraController.camera);
      this.level.update(dt);
      for (const target of this.level.targets) target.update(dt);
      this.handleMenuInput();
    }

    this.spinPedestals(dt);
    this.pipeline.render(dt);
    this.input.endFrame();
  };

  private updateFpsCounter(rawDt: number): void {
    this.fpsTimer += rawDt;
    this.accumulatedFps += 1 / Math.max(1e-5, rawDt);
    this.fpsFrames++;
    if (this.fpsTimer >= 0.5) {
      this.displayFps = this.accumulatedFps / this.fpsFrames;
      this.fpsTimer = 0;
      this.accumulatedFps = 0;
      this.fpsFrames = 0;
      const info = this.pipeline.info;
      this.hud.setFpsText(
        `${this.displayFps.toFixed(0)} fps\n${info.render.calls} draws\n` +
          `${(info.render.triangles / 1000).toFixed(0)}k tris\n` +
          `${this.effects.particleCount} fx\n${this.throwables.liveCount} nades`,
      );
    }
  }

  private handleMenuInput(): void {
    if (this.state === 'paused' && this.input.wasPressed('Escape')) this.startPlaying();
  }

  private spinPedestals(dt: number): void {
    for (const pickup of this.level.pickups) {
      pickup.display.rotation.y += dt * 0.6;
      pickup.display.position.y = pickup.position.y + 1.55 + Math.sin(performance.now() * 0.0016) * 0.04;
    }
  }

  // ----------------------------------------------------------------- update

  private update(dt: number): void {
    if (this.input.wasPressed('Escape')) {
      this.pause();
      return;
    }

    this.handleDebugKeys();

    if (this.vehicles.driving) {
      this.updateDriving(dt);
      return;
    }

    const lookDelta = this.applyMouseLook();
    const playerInput = this.buildPlayerInput();
    this.player.update(dt, playerInput);

    // The camera is placed before the weapons run so that a shot fired this
    // frame uses this frame's aim rather than last frame's — one frame of aim
    // lag is very noticeable when flicking, one frame of ADS lag is not.
    this.cameraController.setRecoilRecovery(this.weapons.config.recoil.recovery);
    this.cameraController.update(dt, this.player, {
      adsProgress: this.weapons.adsProgress,
      adsFov: this.weapons.getAdsFov(this.settings.get('fov')),
      bobScale: this.settings.get('viewBob'),
      firing: this.weapons.adsProgress > 0.5,
    });
    this.cameraController.camera.updateMatrixWorld(true);

    const weaponInput = this.buildWeaponInput();
    this.weapons.update(dt, weaponInput);

    this.throwables.update(dt, {
      throwDown: this.input.isDown('KeyG'),
      lobDown: this.input.isDown('KeyG') && this.input.isMouseDown(MOUSE_RIGHT),
      cyclePressed: this.input.wasPressed('KeyT'),
      blocked: !this.player.alive,
    });

    this.updateViewModel(dt, lookDelta);
    this.updateCharacter(dt);
    this.updateInteractions();

    this.vehicles.update(dt, null);
    this.level.update(dt);
    for (const target of this.level.targets) target.update(dt);
    const drill = this.session.update(dt);
    if (drill.justFinished) {
      this.audio.playRangeEvent('end');
      this.hud.logEvent(
        `Drill complete in ${this.session.drillTime.toFixed(2)}s${drill.newRecord ? ' — NEW BEST' : ''}`,
        'good',
      );
    }

    this.effects.update(dt, this.cameraController.camera);
    this.audio.updateListener(this.cameraController.camera);
    this.updateHud(dt);
  }

  // ---------------------------------------------------------------- driving

  /**
   * The driving frame. Player physics is skipped entirely — the vehicle is
   * authoritative and the player is carried along with it — but look angles,
   * effects, audio and the HUD all still run.
   */
  private updateDriving(dt: number): void {
    const vehicle = this.vehicles.driving;
    if (!vehicle) return;

    this.applyMouseLook();

    if (this.input.wasPressed('KeyE')) {
      this.leaveVehicle(true);
      return;
    }
    if (this.input.wasPressed('KeyV')) {
      this.cockpitView = !this.cockpitView;
      this.hud.logEvent(this.cockpitView ? 'Cockpit view' : 'Chase view');
    }

    const steer = (this.input.isDown('KeyA') ? 1 : 0) - (this.input.isDown('KeyD') ? 1 : 0);
    const throttle = (this.input.isDown('KeyW') ? 1 : 0) - (this.input.isDown('KeyS') ? 1 : 0);

    this.vehicles.update(dt, {
      throttle,
      steer,
      handbrake: this.input.isDown('Space'),
      aimYaw: this.cameraController.aimYaw,
      aimPitch: this.cameraController.aimPitch,
      firePressed: this.input.wasMousePressed(MOUSE_LEFT),
      fireHeld: this.input.isMouseDown(MOUSE_LEFT),
      secondaryPressed: this.input.wasMousePressed(MOUSE_RIGHT),
    });

    // Carry the player with the vehicle so getting out lands somewhere sane
    // and so positional audio is heard from the right place.
    this.player.position.copy(vehicle.position);
    this.player.velocity.set(0, 0, 0);

    const config = vehicle.config;
    // A car's camera drifts back behind it; the tank's does not, because the
    // same look angles are aiming the gun.
    const wide = config.tracked ? 0 : 10;
    this.cameraController.updateVehicle(dt, {
      position: vehicle.position,
      // The pivot and eye are model-space offsets, so they turn with the model,
      // which sits half a turn off the heading yaw.
      modelYaw: vehicle.yaw + Math.PI,
      pivot: vehicle.cameraPivot,
      eye: vehicle.driverEye,
      speed: vehicle.speed,
      maxSpeed: config.maxSpeed,
      distance: config.tracked ? 12 : 7.5,
      height: config.tracked ? 4.2 : 2.4,
      firstPerson: this.cockpitView,
      lookYaw: this.player.yaw,
      lookPitch: this.player.pitch,
      fovBoost: wide,
    });
    this.cameraController.camera.updateMatrixWorld(true);

    this.viewModel.setHidden(true);
    this.character.root.visible = false;

    this.audio.updateEngine(this.engineRevs(vehicle), Math.max(0, throttle));

    if (this.lapTimer) {
      const event = this.lapTimer.update(dt, vehicle.position);
      if (event === 'start') {
        this.audio.playRangeEvent('start');
        this.hud.logEvent('Timing started — go!', 'good');
      } else if (event === 'lap') {
        const time = LapTimer.format(this.lapTimer.last);
        const best = this.lapTimer.last === this.lapTimer.best;
        this.audio.playRangeEvent('end');
        this.hud.logEvent(`Lap ${this.lapTimer.laps} — ${time}${best ? ' — NEW BEST' : ''}`, 'good');
      }
    }

    this.level.update(dt);
    for (const target of this.level.targets) target.update(dt);
    this.session.update(dt);
    this.effects.update(dt, this.cameraController.camera);
    this.audio.updateListener(this.cameraController.camera);
    this.updateHud(dt);
  }

  /** Fakes a gearbox: revs sweep through each ratio as speed climbs. */
  private engineRevs(vehicle: VehicleInstance): number {
    const config = vehicle.config;
    const fraction = clamp(Math.abs(vehicle.speed) / config.maxSpeed, 0, 1);
    const perGear = 1 / config.gears;
    const gear = Math.min(config.gears - 1, Math.floor(fraction / perGear));
    return clamp(0.18 + ((fraction - gear * perGear) / perGear) * 0.82, 0, 1);
  }

  private gearLabel(vehicle: VehicleInstance): string {
    if (vehicle.config.mech) {
      if (vehicle.speed < -0.3) return 'REV';
      return Math.abs(vehicle.speed) < 0.3 ? 'IDLE' : 'WALK';
    }
    if (vehicle.speed < -0.4) return 'R';
    if (Math.abs(vehicle.speed) < 0.4) return 'N';
    const config = vehicle.config;
    const fraction = clamp(Math.abs(vehicle.speed) / config.maxSpeed, 0, 1);
    return `${Math.min(config.gears, Math.floor(fraction * config.gears) + 1)}`;
  }

  private enterVehicle(vehicle: VehicleInstance): void {
    this.vehicles.enter(vehicle);
    this.cockpitView = false;
    this.player.yaw = vehicle.yaw;
    this.player.pitch = 0;
    this.viewModel.setHidden(true);
    this.character.root.visible = false;
    this.audio.startEngine(vehicle.config.engine.timbre);
    this.audio.playUi('confirm');
    this.hud.logEvent(
      vehicle.config.mech
        ? `${vehicle.config.name} — W/S walk, A/D turn, Mouse 1 cannons, Mouse 2 Javelin salvo`
        : `${vehicle.config.name} — W/S drive, A/D steer, Space brake${
            vehicle.config.cannon ? ', Mouse 1 fire' : ''
          }`,
      'good',
    );
  }

  private leaveVehicle(announce: boolean): void {
    const spot = this.vehicles.exit();
    this.audio.stopEngine();
    if (spot) this.player.teleport(spot, this.player.yaw);
    this.viewModel.setHidden(false);
    this.cockpitView = false;
    this.character.root.visible = true;
    if (announce) {
      this.audio.playUi('click');
      this.hud.logEvent('Dismounted');
    }
  }

  private onCannonFire(position: THREE.Vector3, config: VehicleConfig): void {
    void config;
    this.audio.playCannon(position);
    this.cameraController.addTrauma(0.85);
    this.cameraController.getAimDirection(this.fireDirection);
    this.effects.spawnMuzzleFlash(position, this.fireDirection, 2.6, 0xffc98a, 26);
  }

  private onShellImpact(
    position: THREE.Vector3,
    payload: { damage: number; blastRadius: number },
  ): void {
    this.effects.spawnExplosion(position, payload.blastRadius, 0);
    this.audio.playExplosion(position);
    this.applyBlastDamage(
      { damage: payload.damage, damageRadius: payload.blastRadius } as ThrowableConfig,
      position,
    );
    const distance = this.player.eyePosition.distanceTo(position);
    this.cameraController.addTrauma(clamp(1 - distance / (payload.blastRadius * 3), 0, 0.8));
  }

  /**
   * A mech arm cannon round. Hitscan, and it goes through exactly the same
   * raycast, impact and scoring path as a rifle shot — the only difference is
   * where it comes from and how hard it hits.
   */
  private onMechCannon(
    origin: THREE.Vector3,
    barrelDirection: THREE.Vector3,
    config: VehicleConfig,
  ): void {
    const spec = config.mech;
    if (!spec) return;

    // The guns sit seven metres up and two metres out from the camera, so
    // firing along the barrel axis would send rounds far over the crosshair.
    // Converge them on whatever the camera is looking at instead — the same
    // trick the third-person weapon path uses to keep the crosshair honest.
    const camera = this.cameraController.camera;
    const self = this.vehicles.driving ? [this.vehicles.driving.root] : [];
    this.cameraController.getAimDirection(this.fireDirection);
    const aimHit = this.raycastWorld(camera.position, this.fireDirection, spec.cannon.range, self);
    const aimDistance = aimHit ? Math.max(aimHit.distance, 12) : spec.cannon.range;
    this.tmpAimPoint.copy(camera.position).addScaledVector(this.fireDirection, aimDistance);

    const direction = this.tmpVec2.copy(this.tmpAimPoint).sub(origin).normalize();
    const spread = (spec.cannon.spread * Math.PI) / 180;
    direction.x += (Math.random() - 0.5) * spread;
    direction.y += (Math.random() - 0.5) * spread;
    direction.normalize();
    void barrelDirection;

    this.effects.spawnMuzzleFlash(origin, direction, 1.5, 0xffd6a0, 14);
    this.audio.playVehicleImpact(origin, 0.55);
    this.cameraController.addTrauma(0.05);

    const hit = this.raycastWorld(origin, direction, spec.cannon.range, self);
    const end = hit
      ? hit.point
      : this.tmpVec.copy(origin).addScaledVector(direction, spec.cannon.range).clone();
    this.effects.spawnTracer(origin, end, 320, 0.05, 0xffd08a);
    if (!hit) return;

    this.effects.spawnImpact(hit.point, hit.normal, hit.surface, 1.4);
    this.audio.playImpact(hit.surface, hit.point, 1.1);
    const target = hit.object.userData.rangeTarget as RangeTarget | undefined;
    if (!target) return;
    this.cameraController.getAimDirection(this.hitCentre);
    const result = target.registerHit(hit.point, 'body', this.hitCentre, spec.cannon.damage);
    this.session.registerHit(target, result.score);
    this.audio.playHitmarker(false);
    this.hud.showHitmarker(false);
    if (result.knockedDown) this.hud.logEvent(`${target.label} down`, 'good');
  }

  private handleDebugKeys(): void {
    if (this.input.wasPressed('KeyH')) {
      this.hudVisible = !this.hudVisible;
      this.hud.setVisible(this.hudVisible);
    }
    if (this.input.wasPressed('KeyP')) {
      if (this.collisionDebug) {
        this.scene.remove(this.collisionDebug);
        this.collisionDebug = null;
        this.hud.logEvent('Collision debug off');
      } else {
        this.collisionDebug = this.collision.buildDebugMesh();
        this.scene.add(this.collisionDebug);
        this.hud.logEvent(`Collision debug on — ${this.collision.count} boxes`);
      }
    }
    if (this.input.wasPressed('KeyL')) {
      this.session.resetTargets();
      this.audio.playRangeEvent('targetUp');
      this.hud.logEvent('Targets reset', 'good');
    }
    if (this.input.wasPressed('KeyM')) {
      const index = LEVELS.findIndex((l) => l.id === this.level.id);
      this.loadLevel(LEVELS[(index + 1) % LEVELS.length].id);
      return;
    }
    if (this.input.wasPressed('KeyK')) {
      if (this.session.drillState === 'idle' || this.session.drillState === 'finished') {
        this.session.startDrill();
        this.audio.playRangeEvent('start');
        this.hud.logEvent('Timed drill armed — fire to start', 'good');
      } else {
        this.session.cancelDrill();
        this.hud.logEvent('Drill cancelled', 'warn');
      }
    }
    if (this.input.wasPressed('KeyV')) {
      const mode = this.cameraController.toggleMode();
      this.character.setFirstPerson(mode === 'first', true);
      this.viewModel.setHidden(mode !== 'first');
      this.hud.logEvent(mode === 'first' ? 'First person' : 'Third person');
    }
  }

  private applyMouseLook(): { yaw: number; pitch: number } {
    if (!this.input.pointerLocked) return { yaw: 0, pitch: 0 };

    const s = this.settings.current;
    // 0.0022 rad per count at sensitivity 1 lands close to the de-facto
    // standard used by most shooters at 800 DPI.
    const base = 0.0022 * s.sensitivity;
    const adsScale = 1 - (1 - s.adsSensitivityScale) * this.weapons.adsProgress;
    // Scoped optics scale sensitivity by the zoom factor so tracking stays 1:1.
    const zoomScale = this.weapons.config.scopeFov
      ? 1 - (1 - this.weapons.config.scopeFov / s.fov) * this.weapons.adsProgress
      : 1;

    const yaw = this.input.mouseDX * base * adsScale * zoomScale;
    const pitch = this.input.mouseDY * base * adsScale * zoomScale * (s.invertY ? -1 : 1);
    this.player.addLook(yaw, pitch);
    return { yaw, pitch };
  }

  private buildPlayerInput(): PlayerInputState {
    const forward =
      (this.input.isDown('KeyW') ? 1 : 0) - (this.input.isDown('KeyS') ? 1 : 0);
    const right = (this.input.isDown('KeyD') ? 1 : 0) - (this.input.isDown('KeyA') ? 1 : 0);
    const crouch = this.input.anyDown('ControlLeft', 'ControlRight', 'KeyC');
    const crouchPressed =
      this.input.wasPressed('ControlLeft') ||
      this.input.wasPressed('ControlRight') ||
      this.input.wasPressed('KeyC');

    return {
      forward,
      right,
      jump: this.input.isDown('Space'),
      jumpPressed: this.input.wasPressed('Space'),
      sprint: this.input.anyDown('ShiftLeft', 'ShiftRight'),
      crouch,
      crouchPressed,
      aiming: this.weapons.adsProgress > 0.15,
      speedScale: this.weapons.moveSpeedScale,
    };
  }

  private buildWeaponInput(): WeaponInput {
    // Weapon selection: number keys, mouse wheel or Q for the previous weapon.
    let switchTo: WeaponId | null = null;
    for (let i = 0; i < SLOT_KEYS.length; i++) {
      if (this.input.wasPressed(SLOT_KEYS[i])) switchTo = WEAPON_ORDER[i];
    }
    if (this.input.wasPressed('KeyQ') && this.lastWeaponId !== this.weapons.currentId) {
      switchTo = this.lastWeaponId;
    }
    if (this.input.wheelDelta !== 0) {
      const idx = WEAPON_ORDER.indexOf(this.weapons.currentId);
      const next = (idx + Math.sign(this.input.wheelDelta) + WEAPON_ORDER.length) % WEAPON_ORDER.length;
      switchTo = WEAPON_ORDER[next];
    }
    // Remember what we're leaving so Q can swap back to it.
    if (switchTo && switchTo !== this.weapons.currentId && !this.weapons.isBusy) {
      this.lastWeaponId = this.weapons.currentId;
    }

    // ADS can be hold or toggle.
    let aimDown: boolean;
    if (this.settings.get('toggleAds')) {
      if (this.input.wasMousePressed(MOUSE_RIGHT)) this.adsToggleState = !this.adsToggleState;
      if (this.player.sprinting && this.player.moveIntensity > 0.8) this.adsToggleState = false;
      aimDown = this.adsToggleState;
    } else {
      this.adsToggleState = false;
      aimDown = this.input.isMouseDown(MOUSE_RIGHT);
    }

    return {
      triggerDown: this.input.isMouseDown(MOUSE_LEFT),
      aimDown,
      reloadPressed: this.input.wasPressed('KeyR'),
      fireModePressed: this.input.wasPressed('KeyB'),
      inspectPressed: this.input.wasPressed('KeyF'),
      switchTo,
      // A grenade in hand locks out the gun until the throw completes.
      blocked: this.throwables.busy,
      sprinting: this.player.sprinting,
      moveIntensity: this.player.moveIntensity,
      airborne: !this.player.grounded,
      crouched: this.player.isCrouching,
    };
  }

  private updateViewModel(dt: number, lookDelta: { yaw: number; pitch: number }): void {
    const firstPerson = this.cameraController.mode === 'first';
    this.viewModel.setHidden(!firstPerson);

    // The view-model camera sits at the origin of its own scene, so the rig
    // only needs the world camera's rotation-free identity: the weapon is
    // already expressed in camera space.
    this.viewModel.update(dt, {
      ads: this.weapons.adsProgress,
      sprint: this.player.sprinting ? clamp(this.player.moveIntensity * 1.4, 0, 1) : 0,
      moveIntensity: this.player.moveIntensity,
      grounded: this.player.grounded,
      lookDeltaYaw: lookDelta.yaw,
      lookDeltaPitch: lookDelta.pitch,
      reloadProgress: this.weapons.reloadProgress,
      reloadKind: this.weapons.reloadKind,
      drawProgress: this.weapons.drawProgress,
      holsterProgress: this.weapons.holsterProgress,
      cycleProgress: this.weapons.cycleProgress,
      inspectProgress: this.weapons.inspectProgress,
      crouchAmount: this.player.crouchAmount,
      bobScale: this.settings.get('viewBob'),
      throwable:
        this.throwables.activity === 'idle'
          ? null
          : {
              id: this.throwables.currentId,
              state: this.throwables.activity === 'cooking' ? 'cook' : 'throw',
              progress: Math.max(0, this.throwables.throwProgress),
            },
    });
  }

  private updateCharacter(dt: number): void {
    const firstPerson = this.cameraController.mode === 'first';
    this.character.setFirstPerson(firstPerson, true);
    this.character.update(dt, {
      position: this.player.position,
      aimYaw: this.cameraController.aimYaw,
      aimPitch: this.cameraController.aimPitch,
      velocity: this.player.velocity,
      speed: this.player.planarSpeed,
      moveIntensity: this.player.moveIntensity,
      grounded: this.player.grounded,
      sprinting: this.player.sprinting,
      crouchAmount: this.player.crouchAmount,
      sliding: this.player.isSliding,
      ads: this.weapons.adsProgress,
      alive: this.player.alive,
      reloadProgress: this.weapons.reloadProgress,
      cycleProgress: this.weapons.cycleProgress,
    });
  }

  // ----------------------------------------------------------- interactions

  private updateInteractions(): void {
    this.interactTarget = null;
    this.interactVehicle = null;
    let closest = Infinity;

    // Vehicles win over everything else within reach — walking past a car to
    // pick up a rifle is the rarer intent.
    const vehicle = this.vehicles.nearest(this.player.position);
    if (vehicle) {
      this.interactVehicle = vehicle;
      this.interactTarget = 'vehicle';
    }

    for (const pickup of this.level.pickups) {
      const d = this.player.position.distanceTo(pickup.position);
      if (d < pickup.radius && d < closest && !this.interactVehicle) {
        closest = d;
        this.interactTarget = pickup.id;
      }
    }
    if (!this.interactVehicle) {
      for (const crate of this.level.ammoCrates) {
        if (this.player.position.distanceTo(crate.position) < crate.radius) {
          this.interactTarget = 'ammo';
          break;
        }
      }
    }

    if (this.interactTarget && this.input.wasPressed('KeyE')) {
      if (this.interactTarget === 'vehicle') {
        if (this.interactVehicle) this.enterVehicle(this.interactVehicle);
      } else if (this.interactTarget === 'ammo') {
        this.weapons.refillAll();
        this.throwables.refill();
        this.audio.playUi('confirm');
        this.hud.logEvent('Ammunition resupplied', 'good');
      } else {
        if (this.weapons.currentId !== this.interactTarget) {
          this.weapons.switchTo(this.interactTarget);
        }
        this.audio.playUi('confirm');
      }
    }
  }

  // ------------------------------------------------------------- ballistics

  /**
   * Produces the ray a shot follows.
   *
   * First person fires straight from the eye so rounds always land exactly on
   * the crosshair. Third person fires from the character's muzzle toward the
   * point the camera is looking at, which keeps the crosshair honest without
   * letting the player shoot from behind cover.
   */
  private getFireRay(origin: THREE.Vector3, direction: THREE.Vector3): void {
    const camera = this.cameraController.camera;
    this.cameraController.getAimDirection(this.fireDirection);

    if (this.cameraController.mode === 'first') {
      origin.copy(camera.position);
      direction.copy(this.fireDirection);
      return;
    }

    // Find what the camera is pointing at.
    const hit = this.raycastWorld(camera.position, this.fireDirection, 500, []);
    const aimDistance = hit ? Math.max(hit.distance, 5) : 500;
    this.tmpAimPoint.copy(camera.position).addScaledVector(this.fireDirection, aimDistance);

    this.character.getWorldMuzzle(origin);
    direction.copy(this.tmpAimPoint).sub(origin).normalize();
  }

  /** Grenades leave the hand slightly right of and below the eye line. */
  private getThrowRay(origin: THREE.Vector3, direction: THREE.Vector3): void {
    const camera = this.cameraController.camera;
    this.cameraController.getAimDirection(direction);
    origin.copy(camera.position);
    this.tmpVec3.set(1, 0, 0).applyQuaternion(camera.quaternion);
    origin.addScaledVector(this.tmpVec3, 0.22).addScaledVector(direction, 0.35);
    origin.y -= 0.12;
  }

  private onDetonate(config: ThrowableConfig, position: THREE.Vector3): void {
    const groundY = this.player.position.y;
    switch (config.id) {
      case 'frag':
        this.effects.spawnExplosion(position, config.damageRadius, groundY);
        this.audio.playExplosion(position);
        this.cameraController.addTrauma(this.blastFalloff(position, config.damageRadius) * 1.4);
        this.applyBlastDamage(config, position);
        break;

      case 'smoke':
        this.effects.spawnSmokeCloud(position, config.smokeRadius, config.smokeDuration);
        this.audio.playSmokePop(position);
        break;

      case 'flash': {
        this.effects.spawnFlashBurst(position);
        this.audio.playFlashBang(position);
        this.applyFlashBlindness(config, position);
        this.cameraController.addTrauma(this.blastFalloff(position, config.flashRadius) * 0.7);
        break;
      }
    }
  }

  /** 0..1 proximity factor for the player, ignoring line of sight. */
  private blastFalloff(position: THREE.Vector3, radius: number): number {
    this.player.getEyePosition(this.tmpVec3);
    const d = this.tmpVec3.distanceTo(position);
    return clamp(1 - d / Math.max(0.001, radius), 0, 1);
  }

  private applyBlastDamage(config: ThrowableConfig, position: THREE.Vector3): void {
    // Targets in range take falloff damage, but only with line of sight.
    for (const target of this.level.targets) {
      target.getCentre(this.tmpVec2);
      const distance = this.tmpVec2.distanceTo(position);
      if (distance > config.damageRadius) continue;
      if (!this.collision.hasLineOfSight(position, this.tmpVec2)) continue;

      const falloff = 1 - distance / config.damageRadius;
      const damage = config.damage * falloff * falloff;
      const result = target.registerHit(this.tmpVec2, 'body', this.tmpVec2, damage);
      this.session.registerHit(target, result.score);
      if (result.knockedDown) this.hud.logEvent(`${target.label} down`, 'good');
    }

    // The thrower is not immune.
    this.player.getEyePosition(this.tmpVec3);
    const distance = this.tmpVec3.distanceTo(position);
    if (distance < config.damageRadius && this.collision.hasLineOfSight(position, this.tmpVec3)) {
      const falloff = 1 - distance / config.damageRadius;
      this.player.damage(config.damage * falloff * falloff * 0.6, 'hit');
    }
  }

  private applyFlashBlindness(config: ThrowableConfig, position: THREE.Vector3): void {
    this.player.getEyePosition(this.tmpVec3);
    const distance = this.tmpVec3.distanceTo(position);
    if (distance > config.flashRadius) return;
    if (!this.collision.hasLineOfSight(position, this.tmpVec3)) return;

    // Looking at it is far worse than catching it in the corner of your eye.
    this.cameraController.getAimDirection(this.tmpVec2);
    this.tmpVec.copy(position).sub(this.tmpVec3).normalize();
    const facing = clamp(this.tmpVec2.dot(this.tmpVec), -1, 1);
    const view = clamp((facing + 0.35) / 1.35, 0.12, 1);
    const proximity = 1 - distance / config.flashRadius;
    const strength = clamp(proximity * proximity * view, 0, 1);
    if (strength < 0.03) return;

    this.hud.applyFlash(strength);
    this.audio.deafen(strength, config.flashDuration * strength);
  }

  /**
   * True when `object` or any of its ancestors is in `ignore`.
   *
   * Comparing only the leaf mesh is not enough now that vehicles are raycast
   * targets: a mech would put its first round straight into its own arm.
   */
  private static isIgnored(object: THREE.Object3D, ignore: THREE.Object3D[]): boolean {
    if (ignore.length === 0) return false;
    let node: THREE.Object3D | null = object;
    while (node) {
      if (ignore.includes(node)) return true;
      node = node.parent;
    }
    return false;
  }

  private raycastWorld(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    ignore: THREE.Object3D[],
  ): HitInfo | null {
    this.raycaster.set(origin, direction);
    this.raycaster.near = 0;
    this.raycaster.far = maxDistance;
    // Vehicles are dynamic objects rather than baked level geometry, so they
    // have to be tested separately or a parked car would be shot straight
    // through. Recursive, because a vehicle is a hierarchy of joints.
    const hits = this.raycaster.intersectObjects(this.raycastTargets, true);

    for (const hit of hits) {
      if (Game.isIgnored(hit.object, ignore)) continue;
      if (!hit.face) continue;

      const data = hit.object.userData;
      const surface = (data.surface ?? 'concrete') as ImpactMaterial;
      const zone = (data.zone ?? 'body') as HitInfo['zone'];
      const isTarget = data.rangeTarget !== undefined;

      // Normals come back in object space; lift them into world space.
      this.tmpVec.copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();

      return {
        point: hit.point.clone(),
        normal: this.tmpVec.clone(),
        distance: hit.distance,
        object: hit.object,
        surface,
        damage: 0,
        zone,
        penetrationDepth: 0,
        isTarget,
        penetrable: data.penetrable ?? (surface === 'wood' || isTarget),
      };
    }
    return null;
  }

  // ------------------------------------------------------------ shot events

  private onShotFired(shots: ShotInfo[], config: WeaponConfig): void {
    const firstPerson = this.cameraController.mode === 'first';

    // --- muzzle position --------------------------------------------------
    if (firstPerson) {
      this.viewModel.getWorldMuzzle(this.cameraController.camera, this.worldMuzzle);
      this.viewModel.getWorldEjectPort(this.cameraController.camera, this.ejectOrigin);
      this.viewModel.showMuzzleFlash(config);
    } else {
      this.character.getWorldMuzzle(this.worldMuzzle);
      this.character.getWorldEjectPort(this.ejectOrigin);
    }

    this.cameraController.getAimDirection(this.tmpVec2);
    this.effects.spawnMuzzleFlash(
      this.worldMuzzle,
      this.tmpVec2,
      config.flashScale,
      config.flashColor,
      config.flashLightIntensity,
      !firstPerson,
    );

    // --- audio ------------------------------------------------------------
    this.audio.playGunshot(config.audio);
    if (config.actionType === 'slide' || config.actionType === 'gas') {
      this.audio.playAction('slide');
    }

    // --- tracers ----------------------------------------------------------
    for (const shot of shots) {
      if (Math.random() > config.tracerChance) continue;
      this.effects.spawnTracer(
        this.worldMuzzle,
        shot.endPoint,
        config.muzzleVelocity * 0.55,
        config.tracerWidth,
        config.tracerColor,
      );
    }

    // --- brass ------------------------------------------------------------
    if (config.ejectsShells) {
      this.tmpVec3.set(1, 0.35, 0).applyQuaternion(this.cameraController.camera.quaternion).normalize();
      this.effects.spawnShell(
        this.ejectOrigin,
        this.tmpVec3,
        this.tmpVec2,
        config.shellScale,
        this.player.position.y + 0.02,
      );
    }

    // --- recoil -----------------------------------------------------------
    const recoil = this.weapons.getRecoilImpulse();
    this.cameraController.addRecoil(recoil.pitch, recoil.yaw);
    this.player.addAimPunch(recoil.permanentYaw, recoil.permanentPitch);
    this.cameraController.addTrauma(config.recoil.shake * 0.22);
    this.viewModel.onFire(config, this.weapons.adsProgress);
    this.viewModel.cycleAction();
    this.character.onFire(config);

    // --- scoring ----------------------------------------------------------
    this.session.registerShot(config.pellets);
  }

  private onHit(hit: HitInfo, config: WeaponConfig): void {
    // Impact FX.
    this.effects.spawnImpact(hit.point, hit.normal, hit.surface, clamp(config.damage / 40, 0.5, 1.6));
    this.audio.playImpact(hit.surface, hit.point, clamp(config.damage / 45, 0.5, 1.4));

    const decalSize = hit.surface === 'steelTarget' || hit.surface === 'metal' ? 0.06 : 0.1;
    this.effects.spawnDecal(hit.point, hit.normal, decalSize * (config.pellets > 1 ? 0.65 : 1));

    const target = hit.object.userData.rangeTarget as RangeTarget | undefined;
    if (!target) return;

    this.cameraController.getAimDirection(this.hitCentre);
    const result = target.registerHit(hit.point, hit.zone, this.hitCentre, hit.damage);
    this.session.registerHit(target, result.score);

    const headshot = hit.zone === 'head';
    this.audio.playHitmarker(headshot);
    this.hud.showHitmarker(headshot);

    if (this.projectToScreen(hit.point, this.tmpScreen)) {
      const label =
        target.kind === 'paper'
          ? `${result.ring}`
          : headshot
            ? `${Math.round(hit.damage)}!`
            : `${Math.round(hit.damage)}`;
      this.hud.spawnDamageNumber(
        this.tmpScreen.x,
        this.tmpScreen.y,
        label,
        headshot ? 'headshot' : 'damage',
      );
    }

    if (result.knockedDown) {
      this.hud.logEvent(`${target.label} down`, 'good');
    }
  }

  private onTargetStateChange(target: RangeTarget, event: TargetEvent): void {
    target.getCentre(this.tmpVec3);
    if (event === 'down') this.audio.playTargetFall(this.tmpVec3);
    else this.audio.playTargetReset(this.tmpVec3);
  }

  private projectToScreen(world: THREE.Vector3, out: THREE.Vector2): boolean {
    this.tmpProjection.copy(world).project(this.cameraController.camera);
    if (this.tmpProjection.z > 1) return false;
    out.set(
      (this.tmpProjection.x * 0.5 + 0.5) * window.innerWidth,
      (-this.tmpProjection.y * 0.5 + 0.5) * window.innerHeight,
    );
    return true;
  }

  private onEquipWeapon(config: WeaponConfig): void {
    this.viewModel.equip(config);
    this.character.equip(config);
    this.audio.playWeaponSwitch();
    this.hud.logEvent(`${config.name} equipped`);
  }

  // -------------------------------------------------------------------- HUD

  private updateHud(dt: number): void {
    const ammo = this.weapons.getAmmoDisplay();
    const cfg = this.weapons.config;

    const driving = this.vehicles.driving;

    let prompt: string | null = null;
    let promptKey: string | null = null;
    if (driving) {
      prompt = 'Get out';
      promptKey = 'E';
    } else if (this.interactTarget === 'vehicle' && this.interactVehicle) {
      prompt = `Drive ${this.interactVehicle.config.name}`;
      promptKey = 'E';
    } else if (this.interactTarget === 'ammo') {
      prompt = 'Resupply ammunition';
      promptKey = 'E';
    } else if (this.interactTarget && this.interactTarget !== 'vehicle') {
      prompt = `Take ${WEAPON_CONFIGS[this.interactTarget].name}`;
      promptKey = 'E';
    }

    const lap = this.lapTimer;
    const vehicleFrame = driving
      ? {
          name: driving.config.name,
          speedKph: Math.abs(driving.speed) * 3.6,
          gear: this.gearLabel(driving),
          revs: this.engineRevs(driving),
          laps: lap?.laps ?? 0,
          lapTime: LapTimer.format(lap?.current ?? null),
          lastLap: LapTimer.format(lap?.last ?? null),
          bestLap: LapTimer.format(lap?.best ?? null),
          showLaps: lap !== null && !driving.config.mech,
          reloadLabel: driving.config.mech ? 'MISSILES' : 'GUN',
          reload: driving.config.cannon
            ? clamp(1 - driving.reload / driving.config.cannon.reload, 0, 1)
            : driving.config.mech
              ? clamp(1 - driving.barrageCooldown / driving.config.mech.barrage.cooldown, 0, 1)
              : null,
        }
      : null;

    this.hud.update(dt, {
      health: this.player.health,
      maxHealth: this.player.config.maxHealth,
      stamina: this.player.stamina,
      maxStamina: this.player.config.maxStamina,
      ammo: ammo.ammo,
      reserve: ammo.reserve,
      magSize: ammo.magSize,
      weapon: cfg,
      fireMode: this.weapons.fireMode,
      spread: this.weapons.currentSpread,
      ads: this.weapons.adsProgress,
      reloading: this.weapons.isReloading,
      fov: this.cameraController.camera.fov,
      viewportHeight: window.innerHeight,
      showScope: cfg.scopeFov !== undefined && !driving,
      vehicle: vehicleFrame,
      score: this.session.score,
      shotsFired: this.session.shotsFired,
      shotsHit: this.session.shotsHit,
      drillText: this.session.bannerText,
      drillTime: this.session.bannerTime,
      prompt,
      promptKey,
      throwable: {
        name: this.throwables.config.category,
        count: this.throwables.count,
        cook: this.throwables.cookFraction,
      },
    });
  }

  // ---------------------------------------------------------------- cleanup

  dispose(): void {
    this.running = false;
    window.removeEventListener('resize', this.handleResize);
    this.input.dispose();
    this.pipeline.dispose();
    this.audio.suspend();
    this.container.innerHTML = '';
  }
}
