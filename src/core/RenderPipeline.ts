import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { QualityLevel } from './Settings';

/**
 * Renders the view-model scene on top of the world with a fresh depth buffer.
 *
 * `RenderPass` clears depth before it binds its own render target, which is
 * fragile when it is not the first pass, so this does the two steps explicitly
 * in the right order.
 */
class ViewModelPass extends Pass {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.clear = false;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = oldAutoClear;
  }
}

export interface QualityPreset {
  pixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  shadowType: THREE.ShadowMapType;
  bloom: boolean;
  bloomStrength: number;
  antialias: boolean;
  particleScale: number;
  dynamicMuzzleLight: boolean;
  anisotropy: number;
  optionalLights: boolean;
  /** Light shafts and dust motes. */
  atmospherics: boolean;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    pixelRatio: 1,
    shadows: false,
    shadowMapSize: 1024,
    shadowType: THREE.BasicShadowMap,
    bloom: false,
    bloomStrength: 0,
    antialias: false,
    particleScale: 0.5,
    dynamicMuzzleLight: false,
    anisotropy: 1,
    optionalLights: false,
    atmospherics: false,
  },
  medium: {
    pixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    shadowType: THREE.PCFShadowMap,
    bloom: true,
    bloomStrength: 0.14,
    antialias: false,
    particleScale: 0.8,
    dynamicMuzzleLight: true,
    anisotropy: 4,
    optionalLights: true,
    atmospherics: true,
  },
  high: {
    pixelRatio: 2,
    shadows: true,
    shadowMapSize: 2048,
    shadowType: THREE.PCFShadowMap,
    bloom: true,
    bloomStrength: 0.2,
    antialias: true,
    particleScale: 1,
    dynamicMuzzleLight: true,
    anisotropy: 8,
    optionalLights: true,
    atmospherics: true,
  },
};

export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private smaaPass: SMAAPass | null = null;
  private renderPass: RenderPass | null = null;
  private viewModelPass: ViewModelPass | null = null;
  private outputPass: OutputPass | null = null;

  private worldScene: THREE.Scene;
  private worldCamera: THREE.Camera;
  private vmScene: THREE.Scene;
  private vmCamera: THREE.Camera;

  private preset: QualityPreset = QUALITY_PRESETS.high;
  private width = 1;
  private height = 1;

  onQualityApplied: ((preset: QualityPreset) => void) | null = null;

  constructor(
    container: HTMLElement,
    worldScene: THREE.Scene,
    worldCamera: THREE.Camera,
    vmScene: THREE.Scene,
    vmCamera: THREE.Camera,
  ) {
    this.worldScene = worldScene;
    this.worldCamera = worldCamera;
    this.vmScene = vmScene;
    this.vmCamera = vmCamera;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // handled by SMAA in the composer
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.canvas = this.renderer.domElement;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.8;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x0a0d12, 1);
    // The composer issues several render calls per frame; keep the stats for
    // the whole frame instead of just the final pass.
    this.renderer.info.autoReset = false;
    container.appendChild(this.canvas);

    this.resize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  }

  // ---------------------------------------------------------------- quality

  applyQuality(level: QualityLevel): QualityPreset {
    const preset = QUALITY_PRESETS[level];
    this.preset = preset;

    this.renderer.shadowMap.enabled = preset.shadows;
    this.renderer.shadowMap.type = preset.shadowType;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatio));

    this.buildComposer();
    this.resize(this.width, this.height);
    this.onQualityApplied?.(preset);
    return preset;
  }

  get currentPreset(): QualityPreset {
    return this.preset;
  }

  private buildComposer(): void {
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.smaaPass = null;
    this.outputPass = null;

    if (!this.preset.bloom && !this.preset.antialias) {
      // Nothing to composite — the direct path is cheaper.
      this.renderPass = null;
      this.viewModelPass = null;
      return;
    }

    const composer = new EffectComposer(this.renderer);
    composer.setPixelRatio(this.renderer.getPixelRatio());

    this.renderPass = new RenderPass(this.worldScene, this.worldCamera);
    composer.addPass(this.renderPass);

    this.viewModelPass = new ViewModelPass(this.vmScene, this.vmCamera);
    composer.addPass(this.viewModelPass);

    if (this.preset.bloom) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(this.width, this.height),
        this.preset.bloomStrength,
        0.3,
        // Only genuinely over-bright pixels (flashes, tracers, emissives) bloom.
        1.0,
      );
      composer.addPass(this.bloomPass);
    }

    this.outputPass = new OutputPass();
    composer.addPass(this.outputPass);

    if (this.preset.antialias) {
      this.smaaPass = new SMAAPass();
      composer.addPass(this.smaaPass);
    }

    this.composer = composer;
  }

  // ----------------------------------------------------------------- resize

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height, false);
    this.composer?.setSize(this.width, this.height);
    this.bloomPass?.resolution.set(this.width, this.height);
  }

  get pixelRatio(): number {
    return this.renderer.getPixelRatio();
  }

  // ----------------------------------------------------------------- render

  render(dt: number): void {
    this.renderer.info.reset();
    if (this.composer) {
      this.composer.render(dt);
      return;
    }
    // Direct path: world first, then the view model with a cleared depth buffer.
    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    this.renderer.render(this.worldScene, this.worldCamera);
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.vmScene, this.vmCamera);
    this.renderer.autoClear = true;
  }

  get info(): THREE.WebGLInfo {
    return this.renderer.info;
  }

  dispose(): void {
    this.composer?.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
