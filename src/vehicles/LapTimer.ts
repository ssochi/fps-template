import * as THREE from 'three';
import type { LapCourse } from '../world/LevelBuilder';

/**
 * Lap counting for the circuit.
 *
 * A lap is only credited when the car crosses the start/finish line *in the
 * racing direction* having already passed every checkpoint. Without the
 * checkpoints you could bank laps by shuffling back and forth over the line,
 * and without the direction test you could bank them by reversing over it.
 */
export class LapTimer {
  laps = 0;
  /** Elapsed time on the current lap, seconds. Null before the first crossing. */
  current: number | null = null;
  last: number | null = null;
  best: number | null = null;

  private readonly course: LapCourse;
  private readonly visited: boolean[];
  private previousSide: number | null = null;
  private readonly tmp = new THREE.Vector3();

  constructor(course: LapCourse) {
    this.course = course;
    this.visited = course.checkpoints.map(() => false);
  }

  reset(): void {
    this.laps = 0;
    this.current = null;
    this.last = null;
    this.previousSide = null;
    this.visited.fill(false);
  }

  get checkpointsHit(): number {
    return this.visited.filter(Boolean).length;
  }

  get checkpointCount(): number {
    return this.visited.length;
  }

  /**
   * @returns 'lap' when a lap was just completed, 'start' on the first
   * crossing, otherwise null.
   */
  update(dt: number, position: THREE.Vector3): 'lap' | 'start' | null {
    if (this.current !== null) this.current += dt;

    for (let i = 0; i < this.course.checkpoints.length; i++) {
      if (this.visited[i]) continue;
      const cp = this.course.checkpoints[i];
      if (position.distanceTo(cp.position) < cp.radius) this.visited[i] = true;
    }

    const c = this.course;
    const offset = this.tmp.copy(position).sub(c.linePoint);
    const along = offset.dot(c.lineNormal);
    const side = Math.sign(along) || 1;

    // Distance measured across the line, so passing it wide does not count.
    const across = Math.hypot(offset.x - c.lineNormal.x * along, offset.z - c.lineNormal.z * along);

    const previous = this.previousSide;
    this.previousSide = side;
    if (previous === null || side === previous) return null;
    // Crossings only count in the racing direction and within the line.
    if (side <= 0 || across > c.lineHalfWidth) return null;

    if (this.current === null) {
      this.current = 0;
      this.visited.fill(false);
      return 'start';
    }

    if (this.checkpointsHit < this.checkpointCount) return null;

    this.laps++;
    this.last = this.current;
    if (this.best === null || this.current < this.best) this.best = this.current;
    this.current = 0;
    this.visited.fill(false);
    return 'lap';
  }

  static format(seconds: number | null): string {
    if (seconds === null) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return m > 0 ? `${m}:${s.toFixed(2).padStart(5, '0')}` : s.toFixed(2);
  }
}
