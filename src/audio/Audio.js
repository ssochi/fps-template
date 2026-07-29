/**
 * Procedural audio.
 *
 * ## Synthesised, not sampled
 *
 * The blueprint's "procedural everything" pillar applies here as much as to the
 * geometry: there are no audio files, only oscillators, noise buffers and
 * envelopes. That keeps the repo tiny and the cold start instant, and — more
 * usefully — it means every sound can be *parameterised* by the thing that made
 * it. A zombie's groan is pitched by which zombie it is, so a crowd sounds like
 * a crowd rather than like one clip played thirty times.
 *
 * ## Sound is information, not decoration
 *
 * This genre is played by ear. What the player needs from audio is *where* and
 * *how many*, so everything is positioned in a stereo field by its offset from
 * the camera, and attenuated by distance. A groan behind you to the left has to
 * be audible as being behind you to the left.
 *
 * ## Browsers will not let us start
 *
 * An AudioContext cannot begin until the user has interacted with the page, so
 * everything here is written to be safely callable before that happens and to
 * come alive on the first click or keypress.
 */

/** Distance in metres past which a sound is inaudible. */
const MAX_DISTANCE = 34;

export class Audio {
  constructor() {
    /** @type {AudioContext | null} */
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.5;
    /** Listener position, set from the camera target each frame. */
    this.listener = { x: 0, z: 0 };
    /** Simple rate limiting, so a hundred zombies do not make a hundred groans. */
    this._budget = new Map();
    this.stats = { played: 0, dropped: 0 };
  }

  /**
   * Start the context. Safe to call repeatedly; browsers require this to happen
   * inside a user gesture.
   */
  resume() {
    if (!this.enabled) return;
    if (!this.ctx) {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx) {
        this.enabled = false;
        return;
      }
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this._noise = this._makeNoiseBuffer();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** One second of white noise, reused by every noisy sound. */
  _makeNoiseBuffer() {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * Gain and pan for a world position. Returns null when it is too far to hear,
   * which is also how the whole system stays cheap in a crowd.
   */
  _place(x, z) {
    const dx = x - this.listener.x;
    const dz = z - this.listener.z;
    const distance = Math.hypot(dx, dz);
    if (distance > MAX_DISTANCE) return null;
    // Inverse-ish falloff, floored so nearby sounds do not clip.
    const gain = Math.min(1, 1 / (1 + distance * 0.16));
    // The camera looks down the +X/+Z diagonal, so screen-left is roughly the
    // difference between the two axes.
    const pan = Math.max(-1, Math.min(1, (dx - dz) / 24));
    return { gain, pan, distance };
  }

  /** Drop repeats of the same sound within a short window. */
  _allow(key, minInterval) {
    const now = this.ctx.currentTime;
    const last = this._budget.get(key) ?? -Infinity;
    if (now - last < minInterval) {
      this.stats.dropped++;
      return false;
    }
    this._budget.set(key, now);
    return true;
  }

  /** Build the shared output chain for one voice. */
  _voice(place, gain) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = gain * place.gain;
    const panner = ctx.createStereoPanner();
    panner.pan.value = place.pan;
    out.connect(panner);
    panner.connect(this.master);
    return out;
  }

  _noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    return src;
  }

  // --- the sounds --------------------------------------------------------

  /** A dull impact — a bat, a shove, a body hitting the floor. */
  thud(x, z, { pitch = 1, gain = 0.5 } = {}) {
    if (!this.ready) return;
    const place = this._place(x, z);
    if (!place || !this._allow('thud', 0.04)) return;

    const ctx = this.ctx;
    const out = this._voice(place, gain);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140 * pitch, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(48 * pitch, ctx.currentTime + 0.13);

    const env = ctx.createGain();
    env.gain.setValueAtTime(1, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);

    osc.connect(env);
    env.connect(out);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    this.stats.played++;
  }

  /** A sharp, bright hit — a blade, glass, a nail going in. */
  crack(x, z, { pitch = 1, gain = 0.35 } = {}) {
    if (!this.ready) return;
    const place = this._place(x, z);
    if (!place || !this._allow('crack', 0.03)) return;

    const ctx = this.ctx;
    const out = this._voice(place, gain);
    const src = this._noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2200 * pitch;
    filter.Q.value = 1.4;

    const env = ctx.createGain();
    env.gain.setValueAtTime(1, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);

    src.connect(filter);
    filter.connect(env);
    env.connect(out);
    src.start();
    src.stop(ctx.currentTime + 0.1);
    this.stats.played++;
  }

  /**
   * A groan. Pitched by a per-zombie seed so a crowd is a crowd.
   * @param {number} seed 0–1, stable per zombie
   */
  groan(x, z, seed = 0.5) {
    if (!this.ready) return;
    const place = this._place(x, z);
    if (!place || !this._allow('groan', 0.16)) return;

    const ctx = this.ctx;
    const out = this._voice(place, 0.3);
    const base = 68 + seed * 54;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(base * 0.82, ctx.currentTime + 0.7);

    // A formant filter is what turns a sawtooth into something vocal.
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.frequency.value = 420 + seed * 260;
    formant.Q.value = 4;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, ctx.currentTime);
    env.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.12);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);

    osc.connect(formant);
    formant.connect(env);
    env.connect(out);
    osc.start();
    osc.stop(ctx.currentTime + 0.85);
    this.stats.played++;
  }

  /** A footstep. Quiet, frequent, and the thing that makes movement feel real. */
  step(x, z, { hard = false } = {}) {
    if (!this.ready) return;
    const place = this._place(x, z);
    if (!place || !this._allow('step', 0.11)) return;

    const ctx = this.ctx;
    const out = this._voice(place, hard ? 0.16 : 0.1);
    const src = this._noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = hard ? 1600 : 700;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.9, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);

    src.connect(filter);
    filter.connect(env);
    env.connect(out);
    src.start();
    src.stop(ctx.currentTime + 0.08);
    this.stats.played++;
  }

  /** Hammering — two quick knocks, because one reads as a thud. */
  hammer(x, z) {
    if (!this.ready) return;
    this.thud(x, z, { pitch: 1.9, gain: 0.4 });
    const ctx = this.ctx;
    setTimeout(() => this.crack(x, z, { pitch: 1.5, gain: 0.25 }), 70);
  }

  /** A door swinging. */
  door(x, z, open) {
    if (!this.ready) return;
    const place = this._place(x, z);
    if (!place) return;
    const ctx = this.ctx;
    const out = this._voice(place, 0.22);
    const src = this._noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(open ? 380 : 620, ctx.currentTime);
    filter.frequency.linearRampToValueAtTime(open ? 700 : 260, ctx.currentTime + 0.3);
    filter.Q.value = 3;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.6, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.34);

    src.connect(filter);
    filter.connect(env);
    env.connect(out);
    src.start();
    src.stop(ctx.currentTime + 0.36);
    this.stats.played++;
  }

  /** The player being hurt. Deliberately not positional — it is happening to you. */
  hurt() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.4;
    out.connect(this.master);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(220, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(90, ctx.currentTime + 0.25);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.9, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

    osc.connect(env);
    env.connect(out);
    osc.start();
    osc.stop(ctx.currentTime + 0.32);
    this.stats.played++;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  dispose() {
    if (this.ctx) this.ctx.close();
    this.ctx = null;
  }
}
