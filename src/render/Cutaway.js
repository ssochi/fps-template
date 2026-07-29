/**
 * Per-room cutaway.
 *
 * The problem this solves is the genre's defining rendering problem: an
 * isometric camera looking at a building sees its roof and its two near walls,
 * and the player is inside behind all three.
 *
 * The rule, matching the reference game:
 *
 *   - Nothing is cut while you are outdoors. The town keeps its roofs on, which
 *     is what makes it read as a town rather than a doll's house.
 *   - Step inside and *your building* opens up: storeys above you disappear, and
 *     the wall faces pointing at the camera disappear. Neighbouring buildings
 *     are untouched — that is the difference between seeing into a house and
 *     taking the lid off the whole street.
 *
 * Which faces "point at the camera" is a lookup, not a per-frame dot product per
 * wall: rotation is snapped to quarter turns, so there are exactly four answers.
 */
import { DataTexture, RedFormat, UnsignedByteType, NearestFilter, ClampToEdgeWrapping } from 'three';
import { DIR_VEC } from '../core/constants.js';

/** Seconds for a room to fade fully in or out. */
const FADE_TIME = 0.18;

export class Cutaway {
  /**
   * @param {import('../world/World.js').World} world
   * @param {number} roomCount how many room ids exist, including 0 for outdoors
   */
  constructor(world, roomCount) {
    this.world = world;
    this.roomCount = Math.max(2, roomCount);

    /** Target cut amount per room: 1 when the player is in that building. */
    this.target = new Float32Array(this.roomCount);
    /** Current, eased toward the target so rooms fade rather than pop. */
    this.current = new Float32Array(this.roomCount);

    this.data = new Uint8Array(this.roomCount);
    this.texture = new DataTexture(this.data, this.roomCount, 1, RedFormat, UnsignedByteType);
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    this.texture.wrapS = ClampToEdgeWrapping;
    this.texture.wrapT = ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;

    /** roomId → building id. Rooms of the same building are cut together. */
    this.roomBuilding = new Uint16Array(this.roomCount);
    /** building id → room ids. */
    this.buildingRooms = new Map();

    this._activeBuilding = 0;
    this.enabled = true;
  }

  /**
   * Tell the cutaway which rooms belong to which building.
   * @param {Array<{ rooms: Array<{id:number}>, roofRoom?: number }>} buildings
   */
  registerBuildings(buildings) {
    this.buildingRooms.clear();
    this.roomBuilding.fill(0);
    buildings.forEach((b, index) => {
      const id = index + 1;
      const ids = [];
      for (const room of b.rooms) {
        if (room.id < this.roomCount) {
          this.roomBuilding[room.id] = id;
          ids.push(room.id);
        }
      }
      if (b.roofRoom && b.roofRoom < this.roomCount) {
        this.roomBuilding[b.roofRoom] = id;
        ids.push(b.roofRoom);
      }
      this.buildingRooms.set(id, ids);
    });
  }

  /**
   * @param {number} dt
   * @param {number} roomId the room the player is standing in, 0 for outdoors
   */
  update(dt, roomId) {
    const building = this.enabled ? this.roomBuilding[roomId] ?? 0 : 0;

    if (building !== this._activeBuilding) {
      this.target.fill(0);
      if (building) {
        for (const id of this.buildingRooms.get(building) ?? []) this.target[id] = 1;
      }
      this._activeBuilding = building;
    }

    // Ease toward the target. The shader dithers on this value, so a partial
    // amount is a partially dissolved wall rather than a half-transparent one.
    const k = Math.min(1, dt / FADE_TIME);
    let changed = false;
    for (let i = 0; i < this.roomCount; i++) {
      const cur = this.current[i];
      const tgt = this.target[i];
      if (cur === tgt) continue;
      const next = Math.abs(tgt - cur) < 0.004 ? tgt : cur + (tgt - cur) * k;
      this.current[i] = next;
      const texel = Math.round(next * 255);
      if (this.data[i] !== texel) {
        this.data[i] = texel;
        changed = true;
      }
    }
    if (changed) this.texture.needsUpdate = true;
    return changed;
  }

  /**
   * Which wall facings point toward the camera, as a 0/1 mask per direction.
   *
   * A wall face is in the way when its outward normal has a positive dot with
   * the direction from the scene to the camera. With rotation snapped to quarter
   * turns this is always exactly two of the four.
   *
   * @param {import('./IsoCamera.js').IsoCamera} isoCamera
   * @param {import('three').Vector4} out receives (N, E, S, W)
   */
  facingMask(isoCamera, out) {
    // The rig's horizontal offset is the direction from target to camera.
    const yaw = isoCamera.targetYaw;
    const cx = Math.sin(yaw);
    const cz = Math.cos(yaw);
    const m = [0, 0, 0, 0];
    for (let d = 0; d < 4; d++) {
      m[d] = DIR_VEC[d].dx * cx + DIR_VEC[d].dz * cz > 0.01 ? 1 : 0;
    }
    out.set(m[0], m[1], m[2], m[3]);
    return out;
  }

  dispose() {
    this.texture.dispose();
  }
}
