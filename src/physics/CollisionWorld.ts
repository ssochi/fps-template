import * as THREE from 'three';

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
}
