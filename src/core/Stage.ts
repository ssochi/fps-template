import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeGradientMap } from '../shading/Toon';

/**
 * The viewer: renderer, camera, lights and the ground the creature walks on.
 *
 * The lighting is deliberately plain. Cel shading quantises the diffuse term,
 * so a rig with many lights does not give a richer image — it gives a muddle of
 * overlapping terminators and the banding stops reading as deliberate. One key
 * with a hard shadow, one cool fill to keep the shadow side from going flat,
 * and a hemisphere for bounce is the whole rig, and it is enough because the
 * shader is doing the stylising rather than the lights.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sun: THREE.DirectionalLight;

  private readonly container: HTMLElement;
  private readonly groundMaterial: THREE.MeshToonMaterial;
  private readonly gradient: THREE.DataTexture;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // No tone mapping. ACES rolls the highlights off smoothly, which is exactly
    // what a cel ramp is trying to avoid: it turns the hard step between bands
    // back into a gradient.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x121722);
    this.scene.fog = new THREE.Fog(0x121722, 26, 62);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(4.6, 3.1, 6.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0.9, 0);
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 26;
    // Stop the camera going under the floor, where the creature is a silhouette
    // against nothing and the shadow is on the wrong side of it.
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
    this.sun.position.set(6, 9, 4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 40;
    const extent = 12;
    this.sun.shadow.camera.left = -extent;
    this.sun.shadow.camera.right = extent;
    this.sun.shadow.camera.top = extent;
    this.sun.shadow.camera.bottom = -extent;
    // Creatures span an order of magnitude in size, so the shadow bias has to
    // survive the small end without peter-panning the large one. Normal bias
    // does most of the work here because it scales with the surface angle,
    // which is what curved bodies need; a constant depth bias alone left the
    // rounder ones speckled with self-shadow acne.
    this.sun.shadow.bias = -0.0009;
    this.sun.shadow.normalBias = 0.055;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const fill = new THREE.DirectionalLight(0x8fb6ff, 0.75);
    fill.position.set(-7, 4, -5);
    this.scene.add(fill);
    this.scene.add(new THREE.HemisphereLight(0x9fc3ff, 0x2a2438, 0.7));

    // Ground.
    this.gradient = makeGradientMap(3, 0.1);
    this.groundMaterial = new THREE.MeshToonMaterial({
      color: 0x3c4a63,
      gradientMap: this.gradient,
    });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 64), this.groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(60, 60, 0x55628a, 0x2b3348);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.32;
    grid.position.y = 0.002;
    this.scene.add(grid);

    // A ring marking the pen the creature wanders inside.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(11.85, 12, 96),
      new THREE.MeshBasicMaterial({ color: 0x4de0d0, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.004;
    this.scene.add(ring);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Frames a newly grown creature.
   *
   * Sizes vary by an order of magnitude between genomes, so a fixed camera
   * either buries you inside a large one or loses a small one in the distance.
   * The orbit direction is preserved and only the distance changes, so a
   * randomise does not also throw away the angle you had chosen to look from.
   */
  frame(object: THREE.Object3D, focusY: number): void {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (radius / Math.max(0.05, Math.sin(fov * 0.5))) * 1.35 + 0.8;

    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(1, 0.6, 1.3);
    direction.normalize();
    this.controls.target.set(0, focusY, 0);
    this.camera.position.copy(this.controls.target).addScaledVector(direction, distance);
    this.controls.update();
  }

  /** Keeps the shadow frustum on the creature rather than on the origin. */
  followShadow(target: THREE.Vector3): void {
    this.sun.position.set(target.x + 6, 9, target.z + 4);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
