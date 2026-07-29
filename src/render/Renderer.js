/**
 * Renderer setup for the isometric view.
 *
 * Kept thin: the interesting rendering work in this genre is occlusion and fog
 * of war (M4), not post-processing. What matters here is the shadow rig, which
 * for an orthographic camera can be tight and cheap because the visible area is
 * bounded and known exactly.
 */
import {
  ACESFilmicToneMapping,
  HemisphereLight,
  Color,
  DirectionalLight,
  PCFSoftShadowMap,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { MOOD } from './Palette.js';

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('./IsoCamera.js').IsoCamera} isoCamera
   */
  constructor(canvas, isoCamera, { maxPixelRatio = 1.75 } = {}) {
    this.isoCamera = isoCamera;
    this.maxPixelRatio = maxPixelRatio;

    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    // Mild filmic curve: the palette is deliberately low-saturation and
    // high-contrast, and linear output crushes the dusk range flat.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new Scene();
    this.scene.background = new Color(MOOD.sky);
    // Deliberately no `scene.fog`. Distance fog is computed from view-space
    // depth, and under an orthographic rig every visible surface sits at
    // roughly the same depth — so it applies a flat grey wash over the whole
    // frame instead of receding. "You can't see far" in this genre is
    // fog of war (M4), which is a grid query, not a depth ramp.

    this.fill = new HemisphereLight(MOOD.fillSky, MOOD.fillGround, MOOD.fillIntensity);
    this.scene.add(this.fill);

    this.key = new DirectionalLight(MOOD.key, MOOD.keyIntensity);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 200;
    this.key.shadow.bias = -0.0007;
    this.key.shadow.normalBias = 0.03;
    /** Extent of the shadow frustum, resized with the zoom. */
    this._shadowExtent = 0;
    this.scene.add(this.key);
    this.scene.add(this.key.target);

    /**
     * Direction *toward* the sun.
     *
     * Chosen so it is never parallel to the camera rig. At any of the four
     * snapped rotations the view shows two facades; with the sun on the rig's
     * axis both of them light identically and the building reads as a flat
     * silhouette. Offsetting it puts one facade in key light and the other in
     * ambient, which is what gives isometric geometry its depth.
     */
    this.sunDirection = new Vector3(0.62, 0.62, -0.48).normalize();

    this.setSize(window.innerWidth, window.innerHeight);
  }

  setSize(width, height) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxPixelRatio));
    this.renderer.setSize(width, height, false);
    this.isoCamera.setAspect(width / height);
  }

  /**
   * Keep the shadow frustum centred on the view and sized to it.
   *
   * The orthographic camera sees an exactly known area, so the shadow map can
   * cover that and nothing more — which is why isometric shadows can stay crisp
   * where a perspective game would need cascades. It does mean the frustum has
   * to be resized when the player zooms out, or the far half of the screen
   * silently loses its shadows along a straight diagonal edge.
   */
  updateLights(focus) {
    this.key.target.position.copy(focus);
    this.key.position.copy(focus).addScaledVector(this.sunDirection, 70);
    this.key.target.updateMatrixWorld();

    // Half-diagonal of the visible ground area, plus room for tall casters.
    const h = this.isoCamera.viewHeight / 2;
    const w = h * this.isoCamera.aspect;
    const extent = Math.hypot(w, h) + 8;
    if (Math.abs(extent - this._shadowExtent) > 0.5) {
      this._shadowExtent = extent;
      const cam = this.key.shadow.camera;
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;
      cam.updateProjectionMatrix();
    }
  }

  render() {
    // `info` resets per render() call; one call per frame here, so plain reads
    // are accurate.
    this.renderer.render(this.scene, this.isoCamera.camera);
  }

  get info() {
    return this.renderer.info.render;
  }

  dispose() {
    this.renderer.dispose();
  }
}
