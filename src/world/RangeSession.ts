import type { RangeTarget } from './Targets';

/**
 * Range scoring and the timed drill.
 *
 * Tracks shots, hits and score for the HUD, and runs a "clear every reactive
 * target as fast as you can" drill with a persisted personal best.
 */

export type DrillState = 'idle' | 'ready' | 'running' | 'finished';

const BEST_TIME_KEY = 'fps-template.bestDrillTime.v1';

export class RangeSession {
  score = 0;
  shotsFired = 0;
  shotsHit = 0;

  drillState: DrillState = 'idle';
  drillTime = 0;
  bestTime: number | null = null;

  private readonly targets: RangeTarget[];
  private readonly drillTargets: RangeTarget[];
  private readonly cleared = new Set<RangeTarget>();
  private finishedTimer = 0;

  constructor(targets: RangeTarget[]) {
    this.targets = targets;
    // Reactive targets only — paper never "clears".
    this.drillTargets = targets.filter((t) => t.kind !== 'paper');
    this.bestTime = RangeSession.loadBest();
  }

  private static loadBest(): number | null {
    try {
      const raw = localStorage.getItem(BEST_TIME_KEY);
      return raw ? Number(raw) : null;
    } catch {
      return null;
    }
  }

  private static saveBest(time: number): void {
    try {
      localStorage.setItem(BEST_TIME_KEY, String(time));
    } catch {
      /* storage unavailable */
    }
  }

  get drillRemaining(): number {
    return this.drillTargets.length - this.cleared.size;
  }

  get accuracy(): number {
    return this.shotsFired > 0 ? this.shotsHit / this.shotsFired : 0;
  }

  registerShot(pellets: number): void {
    this.shotsFired += pellets;
  }

  /** Called for each pellet that connected with a target. */
  registerHit(target: RangeTarget, score: number): void {
    this.shotsHit++;
    this.score += score;

    if (this.drillState === 'ready') this.drillState = 'running';
    if (this.drillState === 'running' && this.drillTargets.includes(target)) {
      // Knock-down targets only count once they're actually down.
      if (!target.isKnockDown || target.down) this.cleared.add(target);
    }
  }

  startDrill(): void {
    this.resetTargets();
    this.cleared.clear();
    this.drillTime = 0;
    this.drillState = 'ready';
    this.finishedTimer = 0;
  }

  cancelDrill(): void {
    this.drillState = 'idle';
    this.drillTime = 0;
    this.cleared.clear();
  }

  resetTargets(): void {
    for (const t of this.targets) t.reset();
  }

  resetAll(): void {
    this.resetTargets();
    this.score = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.cancelDrill();
  }

  update(dt: number): { justFinished: boolean; newRecord: boolean } {
    if (this.drillState === 'running') {
      this.drillTime += dt;
      if (this.drillRemaining <= 0) {
        this.drillState = 'finished';
        this.finishedTimer = 5;
        const record = this.bestTime === null || this.drillTime < this.bestTime;
        if (record) {
          this.bestTime = this.drillTime;
          RangeSession.saveBest(this.drillTime);
        }
        return { justFinished: true, newRecord: record };
      }
    } else if (this.drillState === 'finished') {
      this.finishedTimer -= dt;
      if (this.finishedTimer <= 0) this.drillState = 'idle';
    }
    return { justFinished: false, newRecord: false };
  }

  /** Text for the HUD drill banner, or null when nothing is running. */
  get bannerText(): string | null {
    switch (this.drillState) {
      case 'ready':
        return `Drill armed — ${this.drillTargets.length} targets — fire to start`;
      case 'running':
        return `Drill · ${this.drillRemaining} left`;
      case 'finished':
        return `Drill complete${this.bestTime !== null ? ` · best ${this.bestTime.toFixed(2)}s` : ''}`;
      default:
        return null;
    }
  }

  get bannerTime(): number | null {
    return this.drillState === 'running' || this.drillState === 'finished' ? this.drillTime : null;
  }
}
