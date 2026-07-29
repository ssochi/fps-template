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
  PointLight,
  HemisphereLight,
  Color,
  DirectionalLight,
  PCFShadowMap,
  Scene,
  Vector2,
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
    // PCFSoftShadowMap is deprecated in r185 and silently downgrades to this.
    this.renderer.shadowMap.type = PCFShadowMap;
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
     * Driven by the clock, but never allowed to line up with the camera rig: at
     * any of the four snapped rotations the view shows two facades, and with the
     * sun on the rig's axis both light identically and the building reads as a
     * flat silhouette. The azimuth is offset to keep one facade in key light and
     * the other in fill, which is where isometric depth comes from.
     */
    this.sunDirection = new Vector3(0.62, 0.62, -0.48).normalize();
    /** 0 = night, 1 = noon. Set from the clock each frame. */
    this.daylight = 1;

    /**
     * The player's torch.
     *
     * The only local light source in the game, and the reason night can have a
     * lower floor than it does: with a torch, darkness has an answer. It is
     * deliberately short-ranged — it shows you the room you are in, not the
     * street, so carrying one changes *where* you can see rather than how far.
     */
    this._bufferSize = new Vector2(1, 1);
    this._gloom = 0;
    this._fireFlicker = 0;
    /** 1 while the grid is up, 0 once it has failed. Eased. */
    this.power = 1;
    this._powerTarget = 1;
    this.torch = new PointLight(0xffd9a0, 0, 9, 1.6);
    /** A campfire. Warmer and further-reaching than a torch. */
    this.fire = new PointLight(0xffb060, 0, 14, 1.7);
    this.scene.add(this.fire);
    this.torch.castShadow = false; // a second shadow map for one lamp is not worth it
    this.scene.add(this.torch);

    this.setSize(window.innerWidth, window.innerHeight);
  }

  setSize(width, height) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxPixelRatio));
    this.renderer.setSize(width, height, false);
    this.isoCamera.setAspect(width / height);
  }

  /**
   * Point the key light at the sun's current position and fade the whole scene
   * toward night.
   *
   * Night is not merely dimmer: the fill goes cold and blue and the key light
   * drops almost to nothing, because the interesting thing about darkness in
   * this genre is that it takes away your ability to see what is coming, not
   * that it lowers a brightness slider.
   *
   * @param {{ elevation: number, azimuth: number }} angles
   * @param {number} daylight 0–1
   */
  setSun(angles, daylight) {
    this.daylight = daylight;
    const ce = Math.cos(angles.elevation);
    this.sunDirection
      .set(Math.sin(angles.azimuth) * ce, Math.max(0.12, Math.sin(angles.elevation)), Math.cos(angles.azimuth) * ce)
      .normalize();

    // Night keeps a moonlight floor rather than going to true black. Real
    // darkness is accurate and unplayable: the player still has to be able to
    // read a silhouette and a doorway. Torches and lamps, which are what should
    // make the difference between this and daylight, are a later milestone.
    // Night keeps a moonlight floor rather than going to true black.
    //
    // Physically, an unlit street under overcast sky is unreadable, and the
    // first pass at this was exactly that — a black screen with a HUD on it.
    // The dynamic that is *supposed* to make night dangerous is not being
    // unable to see at all, it is being unable to see *far*, which the fog of
    // war already does. So the floor sits where silhouettes and doorways still
    // read. When torches and lamps exist this can come back down, because then
    // darkness will have an answer.
    // Cloud takes light out of the sky before anything else does, so an
    // overcast noon reads as an overcast noon rather than as dusk.
    const dayness = Math.max(0, Math.min(1, daylight)) * (1 - this._gloom * 0.55);

    // The night floor, and what the power cut is *for*.
    //
    // M7 set this floor deliberately high and said why: an unlit street under
    // an overcast sky is unreadable, and the first pass at night was a black
    // screen with a HUD on it. The note ended "when torches and lamps exist
    // this can come back down, because then darkness will have an answer."
    //
    // A power cut is that moment. While the grid is up the town has streetlight
    // and the floor stays where M7 put it; when it fails the floor drops by
    // half, night becomes genuinely dark, and M9's torch stops being strictly
    // optional. Nothing new was added to make the world harder — something
    // that was always there was taken away.
    const lit = 0.55 + this.power * 0.45;
    const nightFloor = 0.1 * lit;
    this.key.intensity = MOOD.keyIntensity * (nightFloor + dayness * (1 - nightFloor));
    this.key.color.setHex(dayness > 0.5 ? MOOD.key : MOOD.keyDusk);
    this.fill.intensity = MOOD.fillIntensity * (0.46 * lit + dayness * (1 - 0.46 * lit));
    this.fill.color.setHex(dayness > 0.35 ? MOOD.fillSky : MOOD.fillNight);
    this.scene.background.setHex(dayness > 0.35 ? MOOD.sky : MOOD.skyNight);
  }

  /**
   * Whether the town still has mains power, 0–1 so it can fade rather than pop.
   * Read by `setSun` above; the grid failing is a lighting change, not a new
   * light source.
   */
  /**
   * A lit campfire, or null. One pooled point light — a second fire further
   * away is a glow you would not see anyway at this camera distance, and a
   * light per fire is a shadow map per fire.
   */
  setFire(state) {
    if (!state) {
      this.fire.intensity = 0;
      return;
    }
    this.fire.position.set(state.x + 0.5, state.level * 2.6 + 0.5, state.z + 0.5);
    // Flickers, because a fire that does not is a lamp.
    this.fire.intensity = 11 + Math.sin(this._fireFlicker) * 1.8;
  }

  /** How much light the cloud has taken out of the sky, 0–1. */
  setGloom(gloom) {
    this._gloom = Math.max(0, Math.min(1, gloom));
  }

  setPower(on) {
    this._powerTarget = on ? 1 : 0;
  }

  /** Eased toward the target, so the lights go out over a few seconds. */
  stepPower(dt) {
    this._fireFlicker += dt * 9;
    const k = 1 - Math.exp(-dt / 2.5);
    this.power += (this._powerTarget - this.power) * k;
  }

  /**
   * Drawing-buffer size in pixels, which is what `gl_FragCoord` is measured in.
   * Not the CSS size: on a high-density display the two differ by the pixel
   * ratio, and a screen-space shader test that uses the wrong one is wrong by
   * exactly that factor.
   */
  get bufferSize() {
    this.renderer.getDrawingBufferSize(this._bufferSize);
    return this._bufferSize;
  }

  /**
   * Move and dim the player's torch. Off during the day, since a torch that
   * does nothing visible but still costs a draw is just confusing.
   */
  setTorch(position, on) {
    const strength = on ? Math.max(0, 1 - this.daylight * 1.4) : 0;
    this.torch.intensity = strength * 14;
    if (strength > 0) this.torch.position.set(position.x, position.y + 1.3, position.z);
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
