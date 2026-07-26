import * as THREE from 'three';
import { ParticleSystem } from './ParticleSystem';
import {
  createBulletHoleTexture,
  createGlowTexture,
  createSmokeTexture,
} from '../world/Materials';
import { getShellGeometry, getShellMaterial } from '../weapons/WeaponMeshes';
import { randRange } from '../core/MathUtils';
import type { ImpactMaterial } from '../audio/AudioEngine';

interface Tracer {
  mesh: THREE.Mesh;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  distance: number;
  travelled: number;
  speed: number;
  streak: number;
  active: boolean;
  fading: boolean;
  fade: number;
}

interface Decal {
  mesh: THREE.Mesh;
  life: number;
}

interface Shell {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  angular: THREE.Vector3;
  life: number;
  grounded: boolean;
  restY: number;
  playedSound: boolean;
}

interface Flash {
  group: THREE.Group;
  light: THREE.PointLight;
  planes: THREE.Mesh[];
  life: number;
  maxLife: number;
  baseIntensity: number;
}

const MAX_TRACERS = 64;
const MAX_DECALS = 220;
const MAX_SHELLS = 48;
const MAX_FLASHES = 6;

/**
 * All transient visuals: muzzle flashes, tracers, impact debris, bullet holes
 * and spent brass. Everything is pooled, so sustained automatic fire allocates
 * nothing after the first few shots.
 */
export class EffectsSystem {
  readonly group = new THREE.Group();

  private readonly sparks: ParticleSystem;
  private readonly smoke: ParticleSystem;

  private readonly tracers: Tracer[] = [];
  private readonly decals: Decal[] = [];
  private decalCursor = 0;
  private readonly shells: Shell[] = [];
  private readonly flashes: Flash[] = [];

  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpMat = new THREE.Matrix4();
  private readonly up = new THREE.Vector3(0, 1, 0);

  private readonly colorSpark = new THREE.Color(0xffb347);
  private readonly colorSparkEnd = new THREE.Color(0x8a2b00);
  private readonly colorSmoke = new THREE.Color(0x8f8d88);
  private readonly colorSmokeEnd = new THREE.Color(0x4a4845);

  /** Set false on low quality to skip dynamic muzzle lights. */
  dynamicMuzzleLight = true;
  /** Global particle count multiplier driven by the quality setting. */
  particleScale = 1;

  onShellLanded: ((position: THREE.Vector3) => void) | null = null;

  constructor() {
    this.group.name = 'effects';

    const glow = createGlowTexture();
    const smokeTex = createSmokeTexture();

    this.sparks = new ParticleSystem(2400, glow, THREE.AdditiveBlending);
    this.smoke = new ParticleSystem(1200, smokeTex, THREE.NormalBlending);
    this.group.add(this.sparks.points, this.smoke.points);

    this.buildTracerPool();
    this.buildDecalPool();
    this.buildShellPool();
    this.buildFlashPool();
  }

  // ------------------------------------------------------------------ pools

  private buildTracerPool(): void {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, -0.5);

    for (let i = 0; i < MAX_TRACERS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe6a0,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 8;
      this.group.add(mesh);
      this.tracers.push({
        mesh,
        origin: new THREE.Vector3(),
        direction: new THREE.Vector3(),
        distance: 0,
        travelled: 0,
        speed: 300,
        streak: 6,
        active: false,
        fading: false,
        fade: 1,
      });
    }
  }

  private buildDecalPool(): void {
    const geo = new THREE.PlaneGeometry(1, 1);
    const tex = createBulletHoleTexture();
    for (let i = 0; i < MAX_DECALS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.decals.push({ mesh, life: 0 });
    }
  }

  private buildShellPool(): void {
    const geo = getShellGeometry();
    const mat = getShellMaterial();
    for (let i = 0; i < MAX_SHELLS; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.castShadow = true;
      this.group.add(mesh);
      this.shells.push({
        mesh,
        velocity: new THREE.Vector3(),
        angular: new THREE.Vector3(),
        life: 0,
        grounded: false,
        restY: 0,
        playedSound: false,
      });
    }
  }

  private buildFlashPool(): void {
    const glow = createGlowTexture();
    for (let i = 0; i < MAX_FLASHES; i++) {
      const group = new THREE.Group();
      group.visible = false;

      const planes: THREE.Mesh[] = [];
      for (let p = 0; p < 3; p++) {
        const mat = new THREE.MeshBasicMaterial({
          map: glow,
          color: 0xffc46b,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        mesh.renderOrder = 12;
        // Three overlapping quads at different roll angles fake a star flash.
        mesh.rotation.z = (p / 3) * Math.PI;
        group.add(mesh);
        planes.push(mesh);
      }

      // A short forward cone sells the burning gas leaving the barrel.
      const coneGeo = new THREE.ConeGeometry(0.5, 1, 8, 1, true);
      coneGeo.rotateX(-Math.PI / 2);
      coneGeo.translate(0, 0, -0.5);
      const coneMat = new THREE.MeshBasicMaterial({
        color: 0xffdca8,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      });
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.renderOrder = 12;
      group.add(cone);
      planes.push(cone);

      const light = new THREE.PointLight(0xffb15c, 0, 14, 2);
      light.castShadow = false;
      group.add(light);

      this.group.add(group);
      this.flashes.push({ group, light, planes, life: 0, maxLife: 0.06, baseIntensity: 8 });
    }
  }

  // -------------------------------------------------------------- emitters

  /**
   * Muzzle flash + smoke at a world transform.
   *
   * `showQuads` is false in first person, where the view-model scene draws its
   * own flash sprites — the world flash then contributes only the dynamic light,
   * smoke and sparks so nothing is doubled up on screen.
   */
  spawnMuzzleFlash(
    position: THREE.Vector3,
    direction: THREE.Vector3,
    scale: number,
    color: number,
    lightIntensity: number,
    showQuads = true,
  ): void {
    const flash = this.flashes.find((f) => f.life <= 0) ?? this.flashes[0];
    flash.group.position.copy(position);
    this.tmpVec.copy(position).add(direction);
    flash.group.lookAt(this.tmpVec);
    flash.group.rotateZ(Math.random() * Math.PI * 2);
    flash.group.visible = true;
    flash.life = 0.055 + scale * 0.02;
    flash.maxLife = flash.life;
    flash.baseIntensity = lightIntensity;

    const s = showQuads ? scale * randRange(0.85, 1.25) : 0;
    for (let i = 0; i < 3; i++) {
      const p = flash.planes[i];
      const sz = s * randRange(0.16, 0.3);
      p.scale.set(sz, sz, sz);
      p.position.z = -0.02 - i * 0.01;
      (p.material as THREE.MeshBasicMaterial).color.setHex(color);
    }
    const cone = flash.planes[3];
    cone.scale.set(s * 0.1, s * 0.1, s * randRange(0.18, 0.32));
    (cone.material as THREE.MeshBasicMaterial).color.setHex(color);

    flash.light.color.setHex(color);
    flash.light.intensity = this.dynamicMuzzleLight ? lightIntensity : 0;
    flash.light.distance = 10 + scale * 6;

    // Burning powder sparks thrown forward out of the barrel.
    const count = Math.round(10 * scale * this.particleScale);
    for (let i = 0; i < count; i++) {
      this.tmpVec2
        .copy(direction)
        .multiplyScalar(randRange(3, 14))
        .add(
          this.tmpVec
            .set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1))
            .multiplyScalar(randRange(0.5, 3)),
        );
      this.sparks.spawn({
        position: position.clone().addScaledVector(direction, 0.02),
        velocity: this.tmpVec2.clone(),
        color: this.colorSpark,
        endColor: this.colorSparkEnd,
        size: randRange(0.6, 1.6) * scale,
        endScale: 0.2,
        life: randRange(0.08, 0.3),
        gravity: -6,
        drag: 0.02,
        alpha: 1,
      });
    }

    // Muzzle smoke.
    const smokeCount = Math.round(3 * scale * this.particleScale);
    for (let i = 0; i < smokeCount; i++) {
      this.smoke.spawn({
        position: position.clone().addScaledVector(direction, randRange(0.02, 0.2)),
        velocity: direction
          .clone()
          .multiplyScalar(randRange(0.6, 2.2))
          .add(new THREE.Vector3(randRange(-0.3, 0.3), randRange(0.1, 0.6), randRange(-0.3, 0.3))),
        color: new THREE.Color(0xb9b5ac),
        endColor: this.colorSmokeEnd,
        size: randRange(2, 4) * scale,
        endScale: 4,
        life: randRange(0.4, 0.9),
        gravity: 0.4,
        drag: 0.12,
        alpha: 0.28,
        spin: randRange(-2, 2),
      });
    }
  }

  spawnTracer(
    origin: THREE.Vector3,
    target: THREE.Vector3,
    speed: number,
    width: number,
    color: number,
  ): void {
    const tracer = this.tracers.find((t) => !t.active);
    if (!tracer) return;

    tracer.origin.copy(origin);
    tracer.direction.copy(target).sub(origin);
    tracer.distance = tracer.direction.length();
    if (tracer.distance < 0.001) return;
    tracer.direction.divideScalar(tracer.distance);
    tracer.travelled = 0;
    tracer.speed = speed;
    tracer.streak = Math.min(9, Math.max(2.5, tracer.distance * 0.35));
    tracer.active = true;
    tracer.fading = false;
    tracer.fade = 1;

    const mat = tracer.mesh.material as THREE.MeshBasicMaterial;
    mat.color.setHex(color);
    mat.opacity = 0.95;
    tracer.mesh.visible = true;
    tracer.mesh.scale.set(width, width, 0.001);
  }

  /**
   * Impact debris. `normal` should point out of the surface.
   */
  spawnImpact(
    position: THREE.Vector3,
    normal: THREE.Vector3,
    material: ImpactMaterial,
    energy = 1,
  ): void {
    const scale = this.particleScale;

    const sparkCount = (): number => {
      switch (material) {
        case 'metal':
        case 'steelTarget':
          return Math.round(randRange(14, 26) * energy * scale);
        case 'concrete':
          return Math.round(randRange(4, 9) * energy * scale);
        case 'glass':
          return Math.round(randRange(8, 16) * energy * scale);
        default:
          return Math.round(randRange(0, 3) * energy * scale);
      }
    };

    const isMetal = material === 'metal' || material === 'steelTarget';
    const sparkColor = isMetal ? new THREE.Color(0xfff0c0) : new THREE.Color(0xffb066);

    const n = sparkCount();
    for (let i = 0; i < n; i++) {
      // Bias sparks along the surface normal with a wide random cone.
      this.tmpVec2
        .copy(normal)
        .multiplyScalar(randRange(1.5, 6))
        .add(
          this.tmpVec
            .set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1))
            .normalize()
            .multiplyScalar(randRange(1, 5)),
        );
      this.sparks.spawn({
        position: position.clone().addScaledVector(normal, 0.01),
        velocity: this.tmpVec2.clone(),
        color: sparkColor,
        endColor: this.colorSparkEnd,
        size: randRange(0.4, 1.1),
        endScale: 0.15,
        life: randRange(0.15, 0.7),
        gravity: -9.8,
        drag: 0.4,
        alpha: 1,
        collideGround: true,
        groundY: 0.02,
        restitution: 0.35,
      });
    }

    // Dust / smoke puff.
    const dustCount = Math.round(
      (material === 'dirt' ? 10 : material === 'concrete' ? 7 : 3) * energy * scale,
    );
    const dustColor =
      material === 'dirt'
        ? new THREE.Color(0x6b5a44)
        : material === 'wood'
          ? new THREE.Color(0x8a6c4a)
          : this.colorSmoke;

    for (let i = 0; i < dustCount; i++) {
      this.smoke.spawn({
        position: position.clone().addScaledVector(normal, 0.02),
        velocity: normal
          .clone()
          .multiplyScalar(randRange(0.4, 2.2))
          .add(new THREE.Vector3(randRange(-0.8, 0.8), randRange(0, 0.9), randRange(-0.8, 0.8))),
        color: dustColor,
        endColor: this.colorSmokeEnd,
        size: randRange(0.5, 1.4),
        endScale: randRange(3, 6),
        life: randRange(0.5, 1.4),
        gravity: -0.5,
        drag: 0.2,
        alpha: randRange(0.18, 0.4),
        spin: randRange(-1.5, 1.5),
      });
    }

    // Solid debris chunks for hard surfaces.
    if (material === 'concrete' || material === 'wood' || material === 'dirt') {
      const chunks = Math.round(randRange(2, 6) * scale);
      const chunkColor =
        material === 'wood' ? new THREE.Color(0x7a5a38) : new THREE.Color(0x6f6c66);
      for (let i = 0; i < chunks; i++) {
        this.smoke.spawn({
          position: position.clone().addScaledVector(normal, 0.02),
          velocity: normal
            .clone()
            .multiplyScalar(randRange(1, 4))
            .add(new THREE.Vector3(randRange(-2, 2), randRange(1, 4), randRange(-2, 2))),
          color: chunkColor,
          size: randRange(0.06, 0.16),
          endScale: 1,
          life: randRange(0.6, 1.4),
          gravity: -12,
          drag: 0.6,
          alpha: 1,
          spin: randRange(-8, 8),
          collideGround: true,
          groundY: 0.02,
          restitution: 0.25,
        });
      }
    }
  }

  /** Places a bullet hole oriented to the hit surface. */
  spawnDecal(position: THREE.Vector3, normal: THREE.Vector3, size = 0.09, life = 45): void {
    const decal = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % this.decals.length;

    decal.mesh.position.copy(position).addScaledVector(normal, 0.006);

    // Orient the quad to the surface with a random roll so repeats aren't obvious.
    this.tmpVec.copy(normal);
    const upRef = Math.abs(this.tmpVec.dot(this.up)) > 0.95 ? new THREE.Vector3(1, 0, 0) : this.up;
    this.tmpMat.lookAt(new THREE.Vector3(0, 0, 0), this.tmpVec, upRef);
    this.tmpQuat.setFromRotationMatrix(this.tmpMat);
    decal.mesh.quaternion.copy(this.tmpQuat);
    decal.mesh.rotateZ(Math.random() * Math.PI * 2);

    const s = size * randRange(0.85, 1.2);
    decal.mesh.scale.set(s, s, s);
    decal.mesh.visible = true;
    (decal.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    decal.life = life;
  }

  /** Ejects a spent casing with a tumble. */
  spawnShell(
    position: THREE.Vector3,
    ejectDirection: THREE.Vector3,
    forward: THREE.Vector3,
    scale: number,
    groundY: number,
  ): void {
    const shell = this.shells.find((s) => s.life <= 0) ?? this.shells[0];
    shell.mesh.position.copy(position);
    shell.mesh.scale.setScalar(scale);
    shell.mesh.visible = true;
    shell.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);

    shell.velocity
      .copy(ejectDirection)
      .multiplyScalar(randRange(1.8, 3.4))
      .addScaledVector(forward, randRange(-0.6, 0.4))
      .add(new THREE.Vector3(0, randRange(1.2, 2.4), 0));
    shell.angular.set(randRange(-24, 24), randRange(-24, 24), randRange(-24, 24));
    shell.life = 6;
    shell.grounded = false;
    shell.restY = groundY + 0.005 * scale;
    shell.playedSound = false;
  }

  // ---------------------------------------------------------------- update

  update(dt: number, camera: THREE.Camera): void {
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.updateTracers(dt);
    this.updateDecals(dt);
    this.updateShells(dt);
    this.updateFlashes(dt, camera);
  }

  private updateTracers(dt: number): void {
    for (const t of this.tracers) {
      if (!t.active) continue;

      t.travelled += t.speed * dt;
      const head = Math.min(t.travelled, t.distance);
      let tail = t.travelled - t.streak;

      if (head >= t.distance) {
        t.fading = true;
        tail = Math.max(tail, 0);
      }

      if (tail >= t.distance) {
        t.active = false;
        t.mesh.visible = false;
        continue;
      }
      tail = Math.max(0, tail);

      const len = head - tail;
      if (len <= 0.001) {
        t.active = false;
        t.mesh.visible = false;
        continue;
      }

      this.tmpVec.copy(t.origin).addScaledVector(t.direction, head);
      t.mesh.position.copy(this.tmpVec);
      this.tmpVec2.copy(this.tmpVec).add(t.direction);
      t.mesh.lookAt(this.tmpVec2);
      t.mesh.scale.z = len;

      const mat = t.mesh.material as THREE.MeshBasicMaterial;
      if (t.fading) {
        t.fade -= dt * 6;
        mat.opacity = Math.max(0, 0.95 * t.fade);
        if (t.fade <= 0) {
          t.active = false;
          t.mesh.visible = false;
        }
      }
    }
  }

  private updateDecals(dt: number): void {
    for (const d of this.decals) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) {
        d.mesh.visible = false;
        continue;
      }
      // Fade over the final few seconds so recycling isn't a visible pop.
      if (d.life < 4) {
        (d.mesh.material as THREE.MeshBasicMaterial).opacity = d.life / 4;
      }
    }
  }

  private updateShells(dt: number): void {
    for (const s of this.shells) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.visible = false;
        continue;
      }
      if (s.life < 1) {
        s.mesh.scale.multiplyScalar(Math.max(0, 1 - dt * 2));
      }
      if (s.grounded) continue;

      s.velocity.y -= 22 * dt;
      s.mesh.position.addScaledVector(s.velocity, dt);
      s.mesh.rotation.x += s.angular.x * dt;
      s.mesh.rotation.y += s.angular.y * dt;
      s.mesh.rotation.z += s.angular.z * dt;

      if (s.mesh.position.y <= s.restY) {
        s.mesh.position.y = s.restY;
        if (!s.playedSound) {
          s.playedSound = true;
          this.onShellLanded?.(s.mesh.position);
        }
        if (Math.abs(s.velocity.y) < 0.55) {
          s.grounded = true;
          s.velocity.set(0, 0, 0);
          s.mesh.rotation.x = Math.PI / 2;
        } else {
          s.velocity.y = -s.velocity.y * 0.35;
          s.velocity.x *= 0.6;
          s.velocity.z *= 0.6;
          s.angular.multiplyScalar(0.5);
        }
      }
    }
  }

  private updateFlashes(dt: number, camera: THREE.Camera): void {
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) {
        f.group.visible = false;
        f.light.intensity = 0;
        continue;
      }
      const t = f.life / f.maxLife;
      for (let i = 0; i < 3; i++) {
        (f.planes[i].material as THREE.MeshBasicMaterial).opacity = t;
        // Billboard the glow quads toward the camera each frame.
        f.planes[i].lookAt(camera.position);
        f.planes[i].rotateZ((i / 3) * Math.PI);
      }
      (f.planes[3].material as THREE.MeshBasicMaterial).opacity = t * 0.8;
      f.light.intensity = this.dynamicMuzzleLight ? f.baseIntensity * t * t : 0;
    }
  }

  clear(): void {
    this.sparks.clear();
    this.smoke.clear();
    for (const t of this.tracers) {
      t.active = false;
      t.mesh.visible = false;
    }
    for (const d of this.decals) {
      d.life = 0;
      d.mesh.visible = false;
    }
    for (const s of this.shells) {
      s.life = 0;
      s.mesh.visible = false;
    }
    for (const f of this.flashes) {
      f.life = 0;
      f.group.visible = false;
      f.light.intensity = 0;
    }
  }

  setPixelRatio(ratio: number): void {
    this.sparks.setPixelRatio(ratio);
    this.smoke.setPixelRatio(ratio);
  }

  get particleCount(): number {
    return this.sparks.active + this.smoke.active;
  }
}
