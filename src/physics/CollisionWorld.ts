import * as THREE from 'three';
import { clamp } from '../core/MathUtils';

export interface Collider {
  box: THREE.Box3;
  /** Surface tag used for footstep / impact sounds. */
  surface: 'concrete' | 'metal' | 'dirt' | 'wood';
}

const EPS = 1e-4;

/**
 * Axis-aligned static collision world.
 *
 * The player is treated as an AABB and moved one axis at a time, which is
 * robust, allocation-free and plenty for the boxy geometry of a shooting
 * range. Step-up handling lets the player walk over low obstacles and stairs.
 */
export class CollisionWorld {
  private readonly colliders: Collider[] = [];
  private readonly tmpBox = new THREE.Box3();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpRay = new THREE.Ray();
  private readonly tmpHit = new THREE.Vector3();

  addBox(center: THREE.Vector3, size: THREE.Vector3, surface: Collider['surface'] = 'concrete'): Collider {
    const half = size.clone().multiplyScalar(0.5);
    const collider: Collider = {
      box: new THREE.Box3(center.clone().sub(half), center.clone().add(half)),
      surface,
    };
    this.colliders.push(collider);
    return collider;
  }

  /** Registers an object's world-space bounding box as a collider. */
  addFromObject(object: THREE.Object3D, surface: Collider['surface'] = 'concrete'): Collider {
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    const collider: Collider = { box, surface };
    this.colliders.push(collider);
    return collider;
  }

  /** Removes a previously added collider. Used when a vehicle is destroyed. */
  removeCollider(collider: Collider): void {
    const index = this.colliders.indexOf(collider);
    if (index >= 0) this.colliders.splice(index, 1);
  }

  clear(): void {
    this.colliders.length = 0;
  }

  get count(): number {
    return this.colliders.length;
  }

  /** Debug helper: visualises every collider as a wireframe box. */
  buildDebugMesh(): THREE.Object3D {
    const group = new THREE.Group();
    group.name = 'collision-debug';
    const mat = new THREE.LineBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.5 });
    for (const c of this.colliders) {
      const size = c.box.getSize(new THREE.Vector3());
      const center = c.box.getCenter(new THREE.Vector3());
      const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
      edges.position.copy(center);
      geo.dispose();
      group.add(edges);
    }
    return group;
  }

  // ------------------------------------------------------------------ tests

  private playerBox(feet: THREE.Vector3, radius: number, height: number, out: THREE.Box3): THREE.Box3 {
    out.min.set(feet.x - radius, feet.y, feet.z - radius);
    out.max.set(feet.x + radius, feet.y + height, feet.z + radius);
    return out;
  }

  /** True when an AABB at `feet` would intersect any collider. */
  overlaps(feet: THREE.Vector3, radius: number, height: number): boolean {
    const box = this.playerBox(feet, radius, height, this.tmpBox);
    for (const c of this.colliders) {
      if (c.box.intersectsBox(box)) return true;
    }
    return false;
  }

  /**
   * Resolves movement along a single axis, returning the corrected coordinate
   * and whether a collision happened.
   */
  private resolveAxis(
    feet: THREE.Vector3,
    radius: number,
    height: number,
    axis: 'x' | 'y' | 'z',
    delta: number,
  ): { hit: boolean; surface: Collider['surface'] | null } {
    if (delta === 0) return { hit: false, surface: null };
    feet[axis] += delta;
    const box = this.playerBox(feet, radius, height, this.tmpBox);

    let hit = false;
    let surface: Collider['surface'] | null = null;

    for (const c of this.colliders) {
      if (!c.box.intersectsBox(box)) continue;
      hit = true;
      surface = c.surface;

      if (axis === 'y') {
        if (delta > 0) feet.y = c.box.min.y - height - EPS;
        else feet.y = c.box.max.y + EPS;
      } else if (axis === 'x') {
        if (delta > 0) feet.x = c.box.min.x - radius - EPS;
        else feet.x = c.box.max.x + radius + EPS;
      } else {
        if (delta > 0) feet.z = c.box.min.z - radius - EPS;
        else feet.z = c.box.max.z + radius + EPS;
      }
      this.playerBox(feet, radius, height, box);
    }

    return { hit, surface };
  }

  /**
   * Moves an AABB "capsule" through the world.
   *
   * @returns collision flags plus the surface the character is standing on.
   */
  move(
    feet: THREE.Vector3,
    displacement: THREE.Vector3,
    radius: number,
    height: number,
    stepHeight = 0.45,
  ): { grounded: boolean; hitCeiling: boolean; hitWall: boolean; groundSurface: Collider['surface'] } {
    let grounded = false;
    let hitCeiling = false;
    let hitWall = false;
    let groundSurface: Collider['surface'] = 'concrete';

    // --- vertical ---------------------------------------------------------
    const vertical = this.resolveAxis(feet, radius, height, 'y', displacement.y);
    if (vertical.hit) {
      if (displacement.y <= 0) {
        grounded = true;
        groundSurface = vertical.surface ?? 'concrete';
      } else {
        hitCeiling = true;
      }
    }

    // --- horizontal, with a step-up retry ---------------------------------
    const beforeX = feet.x;
    const beforeZ = feet.z;
    const beforeY = feet.y;

    const hx = this.resolveAxis(feet, radius, height, 'x', displacement.x);
    const hz = this.resolveAxis(feet, radius, height, 'z', displacement.z);

    if (hx.hit || hz.hit) {
      hitWall = true;
      // Retry the same horizontal move from `stepHeight` higher; if the raised
      // position is clear we let the character climb the ledge.
      if (stepHeight > 0) {
        this.tmpVec.set(beforeX, beforeY + stepHeight, beforeZ);
        if (!this.overlaps(this.tmpVec, radius, height)) {
          const raised = this.tmpVec.clone();
          this.resolveAxis(raised, radius, height, 'x', displacement.x);
          this.resolveAxis(raised, radius, height, 'z', displacement.z);

          const movedRaised = Math.hypot(raised.x - beforeX, raised.z - beforeZ);
          const movedFlat = Math.hypot(feet.x - beforeX, feet.z - beforeZ);

          if (movedRaised > movedFlat + 0.005) {
            // Drop back down onto the ledge.
            const drop = this.resolveAxis(raised, radius, height, 'y', -stepHeight - EPS);
            if (drop.hit) {
              feet.copy(raised);
              grounded = true;
              groundSurface = drop.surface ?? groundSurface;
              hitWall = false;
            }
          }
        }
      }
    }

    // Ground probe so walking off tiny lips doesn't flicker the grounded flag.
    if (!grounded && displacement.y <= 0) {
      this.tmpVec.copy(feet);
      this.tmpVec.y -= 0.06;
      if (this.overlaps(this.tmpVec, radius, height)) {
        grounded = true;
      }
    }

    return { grounded, hitCeiling, hitWall, groundSurface };
  }

  /**
   * Moves a free-standing AABB — a vehicle — through the world.
   *
   * Unlike `move()` this takes independent half-extents rather than a radius,
   * because a car is nothing like square in plan, and it takes an `ignore`
   * collider so a vehicle never collides with its own registered box.
   *
   * @returns which axes were blocked, and the surface underfoot.
   */
  /** True when a box centred at (x, y, z) touches nothing. */
  private boxFree(
    x: number,
    y: number,
    z: number,
    half: THREE.Vector3,
    ignore: Collider | null,
  ): boolean {
    this.tmpBox.min.set(x - half.x, y - half.y, z - half.z);
    this.tmpBox.max.set(x + half.x, y + half.y, z + half.z);
    for (const c of this.colliders) {
      if (c === ignore) continue;
      if (c.box.intersectsBox(this.tmpBox)) return false;
    }
    return true;
  }

  moveBox(
    centre: THREE.Vector3,
    displacement: THREE.Vector3,
    half: THREE.Vector3,
    stepHeight = 0.3,
    ignore: Collider | null = null,
  ): { grounded: boolean; hitWall: boolean; groundSurface: Collider['surface'] } {
    let grounded = false;
    let hitWall = false;
    let groundSurface: Collider['surface'] = 'dirt';
    const startBottom = centre.y - half.y;

    const resolve = (axis: 'x' | 'y' | 'z', delta: number): Collider | null => {
      if (delta === 0) return null;
      centre[axis] += delta;
      let hit: Collider | null = null;

      for (const c of this.colliders) {
        if (c === ignore) continue;
        this.tmpBox.min.set(centre.x - half.x, centre.y - half.y, centre.z - half.z);
        this.tmpBox.max.set(centre.x + half.x, centre.y + half.y, centre.z + half.z);
        if (!c.box.intersectsBox(this.tmpBox)) continue;
        // Falling onto something far taller than a step means we are laterally
        // *inside* a wall, not standing on a ledge — snapping to its top would
        // park a car on the armco. Leave it for the horizontal pass to push out.
        if (axis === 'y' && delta < 0 && c.box.max.y > startBottom + stepHeight + EPS) continue;
        hit = c;
        if (axis === 'y') {
          centre.y = delta > 0 ? c.box.min.y - half.y - EPS : c.box.max.y + half.y + EPS;
        } else if (axis === 'x') {
          centre.x = delta > 0 ? c.box.min.x - half.x - EPS : c.box.max.x + half.x + EPS;
        } else {
          centre.z = delta > 0 ? c.box.min.z - half.z - EPS : c.box.max.z + half.z + EPS;
        }
      }
      return hit;
    };

    const vertical = resolve('y', displacement.y);
    if (vertical && displacement.y <= 0) {
      grounded = true;
      groundSurface = vertical.surface;
    }

    // Horizontal, retried from `stepHeight` up so kerbs and thresholds are
    // driven over instead of stopping the vehicle dead.
    const before = centre.clone();
    const blockedX = resolve('x', displacement.x);
    const blockedZ = resolve('z', displacement.z);
    if (blockedX || blockedZ) {
      hitWall = true;
      // The raised start position has to be clear before the step is even
      // attempted. Without that check a vehicle pushed into a wall climbs it
      // one step per frame and ends up driving along the top of the armco.
      if (stepHeight > 0 && this.boxFree(before.x, before.y + stepHeight, before.z, half, ignore)) {
        const raised = before.clone();
        raised.y += stepHeight;
        const saveCentre = centre.clone();
        centre.copy(raised);
        resolve('x', displacement.x);
        resolve('z', displacement.z);
        const movedRaised = Math.hypot(centre.x - before.x, centre.z - before.z);
        const movedFlat = Math.hypot(saveCentre.x - before.x, saveCentre.z - before.z);
        if (movedRaised > movedFlat + 0.005) {
          const drop = resolve('y', -stepHeight - EPS);
          if (drop) {
            grounded = true;
            groundSurface = drop.surface;
            hitWall = false;
          } else {
            centre.copy(saveCentre);
          }
        } else {
          centre.copy(saveCentre);
        }
      }
    }

    if (!grounded && displacement.y <= 0) {
      const probe = centre.clone();
      probe.y -= 0.06;
      this.tmpBox.min.set(probe.x - half.x, probe.y - half.y, probe.z - half.z);
      this.tmpBox.max.set(probe.x + half.x, probe.y + half.y, probe.z + half.z);
      for (const c of this.colliders) {
        if (c === ignore) continue;
        if (c.box.intersectsBox(this.tmpBox)) {
          grounded = true;
          groundSurface = c.surface;
          break;
        }
      }
    }

    return { grounded, hitWall, groundSurface };
  }

  /**
   * Resolves a moving sphere (a thrown grenade) against the static world.
   *
   * Integrates the position, then pushes the sphere out of anything it ended up
   * inside and reflects its velocity off the contact normal.
   *
   * @returns the surface it bounced off, or null if it hit nothing.
   */
  moveSphere(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    radius: number,
    dt: number,
    restitution = 0.4,
    friction = 0.55,
  ): { surface: Collider['surface']; speed: number } | null {
    position.addScaledVector(velocity, dt);

    let result: { surface: Collider['surface']; speed: number } | null = null;

    for (const c of this.colliders) {
      // Closest point on the box to the sphere centre.
      this.tmpVec.set(
        clamp(position.x, c.box.min.x, c.box.max.x),
        clamp(position.y, c.box.min.y, c.box.max.y),
        clamp(position.z, c.box.min.z, c.box.max.z),
      );
      const dx = position.x - this.tmpVec.x;
      const dy = position.y - this.tmpVec.y;
      const dz = position.z - this.tmpVec.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq >= radius * radius) continue;

      let nx = dx;
      let ny = dy;
      let nz = dz;
      let dist = Math.sqrt(distSq);

      if (dist < 1e-5) {
        // Centre is inside the box — escape along the shallowest axis.
        const toMinX = position.x - c.box.min.x;
        const toMaxX = c.box.max.x - position.x;
        const toMinY = position.y - c.box.min.y;
        const toMaxY = c.box.max.y - position.y;
        const toMinZ = position.z - c.box.min.z;
        const toMaxZ = c.box.max.z - position.z;
        const best = Math.min(toMinX, toMaxX, toMinY, toMaxY, toMinZ, toMaxZ);
        nx = best === toMinX ? -1 : best === toMaxX ? 1 : 0;
        ny = best === toMinY ? -1 : best === toMaxY ? 1 : 0;
        nz = best === toMinZ ? -1 : best === toMaxZ ? 1 : 0;
        dist = 1;
      } else {
        nx /= dist;
        ny /= dist;
        nz /= dist;
      }

      const penetration = radius - dist;
      position.x += nx * penetration;
      position.y += ny * penetration;
      position.z += nz * penetration;

      const along = velocity.x * nx + velocity.y * ny + velocity.z * nz;
      if (along < 0) {
        const impact = -along;
        // Reflect the normal component, damp the tangential component.
        velocity.x -= (1 + restitution) * along * nx;
        velocity.y -= (1 + restitution) * along * ny;
        velocity.z -= (1 + restitution) * along * nz;
        velocity.x *= friction;
        velocity.y *= friction;
        velocity.z *= friction;
        if (!result || impact > result.speed) result = { surface: c.surface, speed: impact };
      }
    }

    return result;
  }

  /** True when the straight line between two points is unobstructed. */
  hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    this.tmpVec.copy(to).sub(from);
    const distance = this.tmpVec.length();
    if (distance < 1e-4) return true;
    this.tmpRay.origin.copy(from);
    this.tmpRay.direction.copy(this.tmpVec).divideScalar(distance);

    for (const c of this.colliders) {
      const hit = this.tmpRay.intersectBox(c.box, this.tmpHit);
      if (hit && from.distanceToSquared(hit) < distance * distance - 1e-4) return false;
    }
    return true;
  }
}
