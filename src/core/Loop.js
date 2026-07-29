/**
 * Fixed-step simulation with interpolated rendering.
 *
 * The simulation runs at a fixed 30 Hz regardless of display rate. Two reasons,
 * both specific to this genre: a survival sim gains nothing from 60 Hz AI, and
 * halving the tick rate halves what a three-hundred-strong horde costs. Render
 * runs as fast as the display allows and gets the leftover fraction to
 * interpolate with.
 */
export const SIM_HZ = 30;

export class Loop {
  /**
   * @param {object} opts
   * @param {(dt: number) => void} opts.update fixed-step; dt is always the same
   * @param {(alpha: number, frameTime: number) => void} opts.render alpha ∈ [0,1)
   * @param {number} [opts.hz]
   */
  constructor({ update, render, hz = SIM_HZ }) {
    this.update = update;
    this.render = render;
    this.step = 1 / hz;
    /** Stop catching up past this many steps, or a backgrounded tab returns
     *  and tries to simulate ten seconds in one frame — the spiral of death. */
    this.maxSubSteps = 5;

    this.running = false;
    this.accumulator = 0;
    this.last = 0;
    /** In-simulation seconds elapsed. Deterministic; safe to save. */
    this.elapsed = 0;
    this.frame = 0;

    this._fpsWindow = [];
    this.fps = 0;
    this.lastUpdateMs = 0;
    this.lastRenderMs = 0;

    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);

    let frameTime = (now - this.last) / 1000;
    this.last = now;
    if (frameTime > 0.25) frameTime = 0.25;

    this.accumulator += frameTime;

    const t0 = performance.now();
    let steps = 0;
    while (this.accumulator >= this.step && steps < this.maxSubSteps) {
      this.update(this.step);
      this.accumulator -= this.step;
      this.elapsed += this.step;
      steps++;
    }
    if (steps === this.maxSubSteps) this.accumulator = 0;
    const t1 = performance.now();

    this.render(this.accumulator / this.step, frameTime);
    const t2 = performance.now();

    this.lastUpdateMs = t1 - t0;
    this.lastRenderMs = t2 - t1;
    this.frame++;

    this._fpsWindow.push(frameTime);
    if (this._fpsWindow.length > 30) this._fpsWindow.shift();
    const avg = this._fpsWindow.reduce((a, b) => a + b, 0) / this._fpsWindow.length;
    this.fps = avg > 0 ? 1 / avg : 0;
  }
}
