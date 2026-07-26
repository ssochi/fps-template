import * as THREE from 'three';
import { clamp, randRange } from '../core/MathUtils';

/**
 * Fully procedural audio. Every sound in the template is synthesized at runtime
 * with the WebAudio API, so the project ships with zero binary assets and works
 * offline. Swap `AudioEngine` for a sample-based implementation by keeping the
 * same public method surface.
 */

export interface GunshotProfile {
  /** Peak loudness of the shot, 0..1. */
  gain: number;
  /** Frequency the low-end "body" sweep starts at (Hz). */
  bodyFreq: number;
  /** Frequency the body sweep lands on (Hz). */
  bodyEndFreq: number;
  /** Body envelope length in seconds. */
  bodyDecay: number;
  /** Noise (crack) envelope length in seconds. */
  crackDecay: number;
  /** Lowpass sweep applied to the noise crack. */
  crackFreqStart: number;
  crackFreqEnd: number;
  /** Highpass on the crack — higher makes the shot thinner / snappier. */
  crackHighpass: number;
  /** How much of the shot is fed into the reverb tail, 0..1. */
  tail: number;
  /** Extra distortion / grit, 0..1. */
  grit: number;
}

export type ImpactMaterial = 'concrete' | 'metal' | 'dirt' | 'wood' | 'steelTarget' | 'glass';

interface SpatialOptions {
  position?: THREE.Vector3;
  /** Distance at which the sound is at full volume. */
  refDistance?: number;
  maxDistance?: number;
  volume?: number;
}

export class AudioEngine {
  readonly ctx: AudioContext;

  private readonly master: GainNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly sfxBus: GainNode;
  private readonly reverbSend: GainNode;
  private readonly reverb: ConvolverNode;
  private readonly reverbReturn: GainNode;
  private readonly deafenFilter: BiquadFilterNode;

  /** Running engine voice, alive only while the player is driving. */
  private engine: {
    oscA: OscillatorNode;
    oscB: OscillatorNode;
    sub: OscillatorNode;
    noise: AudioBufferSourceNode;
    noiseGain: GainNode;
    filter: BiquadFilterNode;
    gain: GainNode;
    baseFreq: number;
  } | null = null;

  private noiseBuffer!: AudioBuffer;
  private pinkBuffer!: AudioBuffer;
  private distortionCurve: Float32Array<ArrayBuffer>;

  private listenerPos = new THREE.Vector3();
  private listenerRight = new THREE.Vector3(1, 0, 0);
  private listenerForward = new THREE.Vector3(0, 0, -1);

  private masterVolume = 0.8;
  private sfxVolume = 1.0;
  private started = false;

  /** Cheap voice budget so full-auto fire cannot melt the audio graph. */
  private activeVoices = 0;
  private readonly maxVoices = 48;

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });

    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVolume;

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.18;

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this.sfxVolume;

    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.createImpulseResponse(2.4, 2.6);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbReturn = this.ctx.createGain();
    this.reverbReturn.gain.value = 0.85;

    this.deafenFilter = this.ctx.createBiquadFilter();
    this.deafenFilter.type = 'lowpass';
    this.deafenFilter.frequency.value = 22000;
    this.deafenFilter.Q.value = 0.4;

    this.sfxBus.connect(this.compressor);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.compressor);
    this.compressor.connect(this.deafenFilter);
    this.deafenFilter.connect(this.master);
    this.master.connect(this.ctx.destination);

    this.distortionCurve = this.createDistortionCurve(28);
    this.buildNoiseBuffers();
  }

  // ------------------------------------------------------------- lifecycle

  /** Must be called from a user gesture before any sound will be audible. */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* browser refused — audio stays silent until the next gesture */
      }
    }
    this.started = this.ctx.state === 'running';
  }

  suspend(): void {
    if (this.ctx.state === 'running') void this.ctx.suspend();
  }

  get isRunning(): boolean {
    return this.started && this.ctx.state === 'running';
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp(v, 0, 1);
    this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.02);
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = clamp(v, 0, 2);
    this.sfxBus.gain.setTargetAtTime(this.sfxVolume, this.ctx.currentTime, 0.02);
  }

  /** Feed the camera transform each frame so world sounds pan correctly. */
  updateListener(camera: THREE.Camera): void {
    camera.getWorldPosition(this.listenerPos);
    const m = camera.matrixWorld.elements;
    this.listenerRight.set(m[0], m[1], m[2]).normalize();
    this.listenerForward.set(-m[8], -m[9], -m[10]).normalize();
  }

  /** Muffle everything (used for the pause menu). */
  setMuffled(muffled: boolean): void {
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(muffled ? this.masterVolume * 0.25 : this.masterVolume, t, 0.08);
  }

  // ------------------------------------------------------------- primitives

  private buildNoiseBuffers(): void {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 2);

    this.noiseBuffer = this.ctx.createBuffer(1, len, sr);
    const white = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) white[i] = Math.random() * 2 - 1;

    // Paul Kellet's economy pink-noise approximation.
    this.pinkBuffer = this.ctx.createBuffer(1, len, sr);
    const pink = this.pinkBuffer.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      pink[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  }

  private createImpulseResponse(duration: number, decay: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * duration);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // Sparse early reflections over a smooth exponential tail.
        const env = Math.pow(1 - t, decay);
        const sparkle = i < sr * 0.08 && Math.random() < 0.02 ? 3 : 1;
        data[i] = (Math.random() * 2 - 1) * env * sparkle;
      }
    }
    return buf;
  }

  private createDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    return curve;
  }

  private now(): number {
    return this.ctx.currentTime;
  }

  private trackVoice(node: AudioScheduledSourceNode): void {
    this.activeVoices++;
    node.onended = () => {
      this.activeVoices--;
      node.disconnect();
    };
  }

  private canPlay(): boolean {
    return this.isRunning && this.activeVoices < this.maxVoices;
  }

  private noise(pink = false): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = pink ? this.pinkBuffer : this.noiseBuffer;
    // Random offset avoids the "same click every time" artifact.
    src.loop = true;
    return src;
  }

  /**
   * Builds the per-voice output chain. Returns the node a voice should connect
   * to; distance attenuation, stereo panning and air absorption are baked in.
   */
  private outputChain(opts: SpatialOptions = {}): { input: GainNode; send: GainNode } {
    const input = this.ctx.createGain();
    input.gain.value = opts.volume ?? 1;

    const send = this.ctx.createGain();
    send.gain.value = 0;
    input.connect(send);
    send.connect(this.reverbSend);

    if (!opts.position) {
      input.connect(this.sfxBus);
      return { input, send };
    }

    const rel = opts.position.clone().sub(this.listenerPos);
    const dist = rel.length();
    const ref = opts.refDistance ?? 4;
    const max = opts.maxDistance ?? 220;

    // Inverse-distance rolloff with a soft cutoff at maxDistance.
    const atten = ref / (ref + Math.max(0, Math.min(dist, max) - ref) * 0.9);
    const distGain = this.ctx.createGain();
    distGain.gain.value = atten;

    // Air absorption: distant sounds lose their high end.
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(20000 - dist * 130, 900, 20000);
    lp.Q.value = 0.4;

    const pan = this.ctx.createStereoPanner();
    const lateral = dist > 0.001 ? rel.dot(this.listenerRight) / dist : 0;
    const behind = dist > 0.001 ? rel.dot(this.listenerForward) / dist : 1;
    // Widen panning for sounds behind the listener so they read as "off-screen".
    pan.pan.value = clamp(lateral * (behind < 0 ? 1.0 : 0.75), -1, 1);

    input.connect(distGain);
    distGain.connect(lp);
    lp.connect(pan);
    pan.connect(this.sfxBus);

    return { input, send };
  }

  private envGain(
    attack: number,
    decay: number,
    peak: number,
    startTime: number,
  ): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, startTime);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), startTime + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + attack + decay);
    return g;
  }

  /** One-shot filtered noise burst — the workhorse for clicks/impacts/steps. */
  private burst(
    opts: {
      duration: number;
      attack?: number;
      peak?: number;
      type?: BiquadFilterType;
      freq: number;
      freqEnd?: number;
      q?: number;
      highpass?: number;
      pink?: boolean;
      rate?: number;
      tail?: number;
      distort?: boolean;
      delay?: number;
    },
    spatial: SpatialOptions = {},
  ): void {
    if (!this.canPlay()) return;
    const t = this.now() + (opts.delay ?? 0);
    const { input, send } = this.outputChain(spatial);
    send.gain.value = opts.tail ?? 0;

    const src = this.noise(opts.pink);
    src.playbackRate.value = opts.rate ?? 1;

    const filter = this.ctx.createBiquadFilter();
    filter.type = opts.type ?? 'lowpass';
    filter.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(30, opts.freqEnd),
        t + opts.duration,
      );
    }
    filter.Q.value = opts.q ?? 1;

    const env = this.envGain(opts.attack ?? 0.002, opts.duration, opts.peak ?? 1, t);

    let head: AudioNode = filter;
    if (opts.highpass) {
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = opts.highpass;
      filter.connect(hp);
      head = hp;
    }

    src.connect(filter);
    if (opts.distort) {
      const shaper = this.ctx.createWaveShaper();
      shaper.curve = this.distortionCurve;
      head.connect(shaper);
      shaper.connect(env);
    } else {
      head.connect(env);
    }
    env.connect(input);

    const stop = t + (opts.attack ?? 0.002) + opts.duration + 0.05;
    src.start(t, randRange(0, 1.5));
    src.stop(stop);
    this.trackVoice(src);
  }

  /** Decaying sine/triangle partial — used for metal rings and UI blips. */
  private tone(
    opts: {
      freq: number;
      freqEnd?: number;
      duration: number;
      peak?: number;
      type?: OscillatorType;
      attack?: number;
      delay?: number;
      tail?: number;
    },
    spatial: SpatialOptions = {},
  ): void {
    if (!this.canPlay()) return;
    const t = this.now() + (opts.delay ?? 0);
    const { input, send } = this.outputChain(spatial);
    send.gain.value = opts.tail ?? 0;

    const osc = this.ctx.createOscillator();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, t);
    if (opts.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), t + opts.duration);
    }

    const env = this.envGain(opts.attack ?? 0.003, opts.duration, opts.peak ?? 0.5, t);
    osc.connect(env);
    env.connect(input);
    osc.start(t);
    osc.stop(t + (opts.attack ?? 0.003) + opts.duration + 0.05);
    this.trackVoice(osc);
  }

  // ---------------------------------------------------------------- weapons

  playGunshot(p: GunshotProfile, position?: THREE.Vector3): void {
    if (!this.isRunning) return;
    const spatial: SpatialOptions = { position, refDistance: 6, maxDistance: 400 };

    // 1. Supersonic crack — bright noise with a fast downward lowpass sweep.
    this.burst(
      {
        duration: p.crackDecay,
        attack: 0.0012,
        peak: p.gain,
        type: 'lowpass',
        freq: p.crackFreqStart,
        freqEnd: p.crackFreqEnd,
        q: 0.8,
        highpass: p.crackHighpass,
        tail: p.tail * 0.6,
        distort: p.grit > 0.4,
      },
      spatial,
    );

    // 2. Muzzle blast body — low sine sweeping down gives the shot its weight.
    this.tone(
      {
        freq: p.bodyFreq,
        freqEnd: p.bodyEndFreq,
        duration: p.bodyDecay,
        peak: p.gain * 0.85,
        type: 'triangle',
        attack: 0.001,
        tail: p.tail,
      },
      spatial,
    );

    // 3. Mid punch so the shot cuts through on small speakers.
    this.burst(
      {
        duration: p.crackDecay * 0.45,
        attack: 0.001,
        peak: p.gain * 0.55,
        type: 'bandpass',
        freq: 1400,
        q: 1.2,
        tail: p.tail * 0.3,
      },
      spatial,
    );

    // 4. Distant slap-back that reads as the range's back wall.
    if (p.tail > 0.25) {
      this.burst(
        {
          duration: 0.35,
          attack: 0.02,
          peak: p.gain * 0.18 * p.tail,
          type: 'lowpass',
          freq: 1800,
          freqEnd: 300,
          tail: 1,
        },
        { ...spatial, volume: 0.8 },
      );
    }
  }

  /** Mechanical action noise layered on top of the shot (bolt, slide, pump). */
  playAction(kind: 'slide' | 'bolt' | 'pump' | 'trigger', position?: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 3, maxDistance: 40, volume: 0.5 };
    switch (kind) {
      case 'slide':
        this.burst({ duration: 0.05, peak: 0.35, type: 'bandpass', freq: 3200, q: 2, rate: 1.3 }, spatial);
        this.burst({ duration: 0.07, peak: 0.22, type: 'bandpass', freq: 1500, q: 3, rate: 0.9 }, { ...spatial, volume: 0.4 });
        break;
      case 'bolt':
        this.burst({ duration: 0.13, peak: 0.4, type: 'bandpass', freq: 2200, q: 2.5 }, spatial);
        this.tone({ freq: 900, freqEnd: 500, duration: 0.09, peak: 0.16, type: 'square', delay: 0.1 }, spatial);
        break;
      case 'pump':
        this.burst({ duration: 0.1, peak: 0.45, type: 'bandpass', freq: 1700, q: 2 }, spatial);
        this.burst({ duration: 0.12, peak: 0.4, type: 'bandpass', freq: 2600, q: 2.2, rate: 0.8 }, { ...spatial, volume: 0.8 });
        break;
      case 'trigger':
        this.burst({ duration: 0.02, peak: 0.18, type: 'bandpass', freq: 4200, q: 3 }, spatial);
        break;
    }
  }

  playDryFire(position?: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 3, maxDistance: 30 };
    this.burst({ duration: 0.035, peak: 0.4, type: 'bandpass', freq: 3000, q: 4 }, spatial);
    this.tone({ freq: 1600, freqEnd: 700, duration: 0.04, peak: 0.12, type: 'square' }, spatial);
  }

  playReloadStep(step: 'magOut' | 'magIn' | 'chamber' | 'shellInsert', position?: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 3, maxDistance: 40 };
    switch (step) {
      case 'magOut':
        this.burst({ duration: 0.09, peak: 0.35, type: 'bandpass', freq: 1100, q: 2.2 }, spatial);
        this.burst({ duration: 0.05, peak: 0.2, type: 'highpass', freq: 2600 }, { ...spatial, volume: 0.5 });
        break;
      case 'magIn':
        this.burst({ duration: 0.07, peak: 0.45, type: 'lowpass', freq: 1400, freqEnd: 400 }, spatial);
        this.tone({ freq: 260, freqEnd: 120, duration: 0.08, peak: 0.25, type: 'triangle' }, spatial);
        this.burst({ duration: 0.04, peak: 0.25, type: 'bandpass', freq: 3400, q: 3, delay: 0.03 }, spatial);
        break;
      case 'chamber':
        this.playAction('bolt', position);
        break;
      case 'shellInsert':
        this.burst({ duration: 0.06, peak: 0.3, type: 'bandpass', freq: 2000, q: 2, rate: randRange(0.9, 1.15) }, spatial);
        break;
    }
  }

  playWeaponSwitch(position?: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 3, maxDistance: 25 };
    this.burst({ duration: 0.12, peak: 0.22, type: 'bandpass', freq: 900, q: 1.4 }, spatial);
    this.burst({ duration: 0.06, peak: 0.16, type: 'highpass', freq: 3000 }, { ...spatial, volume: 0.6 });
  }

  playAds(entering: boolean, position?: THREE.Vector3): void {
    // Cloth / gear rustle.
    this.burst(
      {
        duration: 0.12,
        peak: 0.1,
        type: 'bandpass',
        freq: entering ? 2200 : 1600,
        q: 0.8,
        pink: true,
      },
      { position, refDistance: 2, maxDistance: 15 },
    );
  }

  // ---------------------------------------------------------------- impacts

  playImpact(material: ImpactMaterial, position: THREE.Vector3, energy = 1): void {
    const spatial: SpatialOptions = { position, refDistance: 5, maxDistance: 180, volume: energy };
    switch (material) {
      case 'concrete':
        this.burst({ duration: 0.11, peak: 0.5, type: 'lowpass', freq: 2400, freqEnd: 400, tail: 0.35 }, spatial);
        this.tone({ freq: 180, freqEnd: 70, duration: 0.07, peak: 0.2, type: 'triangle' }, spatial);
        break;
      case 'metal':
        this.burst({ duration: 0.05, peak: 0.35, type: 'highpass', freq: 2500, tail: 0.3 }, spatial);
        this.tone({ freq: randRange(1700, 2400), duration: 0.28, peak: 0.28, tail: 0.5 }, spatial);
        this.tone({ freq: randRange(3200, 4200), duration: 0.16, peak: 0.14 }, spatial);
        break;
      case 'steelTarget':
        this.burst({ duration: 0.04, peak: 0.4, type: 'highpass', freq: 3000 }, spatial);
        this.tone({ freq: randRange(720, 880), duration: 0.75, peak: 0.4, tail: 0.7 }, spatial);
        this.tone({ freq: randRange(1500, 1750), duration: 0.5, peak: 0.22, tail: 0.5 }, spatial);
        this.tone({ freq: randRange(2600, 3000), duration: 0.3, peak: 0.12 }, spatial);
        break;
      case 'dirt':
        this.burst({ duration: 0.14, peak: 0.4, type: 'lowpass', freq: 700, freqEnd: 180, pink: true, tail: 0.15 }, spatial);
        break;
      case 'wood':
        this.burst({ duration: 0.09, peak: 0.42, type: 'bandpass', freq: 900, q: 1.5, tail: 0.25 }, spatial);
        this.tone({ freq: 320, freqEnd: 150, duration: 0.09, peak: 0.16, type: 'triangle' }, spatial);
        break;
      case 'glass':
        this.burst({ duration: 0.2, peak: 0.3, type: 'highpass', freq: 4000, tail: 0.4 }, spatial);
        for (let i = 0; i < 4; i++) {
          this.tone({ freq: randRange(2500, 6000), duration: randRange(0.1, 0.3), peak: 0.1, delay: randRange(0, 0.12) }, spatial);
        }
        break;
    }
  }

  /** Sonic crack of a round passing near the listener. */
  playWhizz(position: THREE.Vector3): void {
    this.burst(
      { duration: 0.09, peak: 0.3, type: 'bandpass', freq: 2600, freqEnd: 700, q: 1.2 },
      { position, refDistance: 3, maxDistance: 20 },
    );
  }

  playShellDrop(position: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 3, maxDistance: 30, volume: 0.5 };
    const pings = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < pings; i++) {
      this.tone({
        freq: randRange(2600, 5200),
        duration: randRange(0.05, 0.14),
        peak: 0.09 / (i + 1),
        delay: i * randRange(0.05, 0.13),
      }, spatial);
    }
  }

  // ----------------------------------------------------------------- player

  playFootstep(surface: 'concrete' | 'metal' | 'dirt', running: boolean): void {
    const peak = running ? 0.26 : 0.15;
    const rate = randRange(0.85, 1.2);
    switch (surface) {
      case 'concrete':
        this.burst({ duration: 0.07, peak, type: 'lowpass', freq: 1500, freqEnd: 500, rate, pink: true });
        this.burst({ duration: 0.03, peak: peak * 0.5, type: 'highpass', freq: 3500, rate });
        break;
      case 'metal':
        this.burst({ duration: 0.05, peak, type: 'bandpass', freq: 2200, q: 1.5, rate });
        this.tone({ freq: randRange(1200, 1800), duration: 0.12, peak: peak * 0.4 });
        break;
      case 'dirt':
        this.burst({ duration: 0.1, peak: peak * 0.9, type: 'lowpass', freq: 800, freqEnd: 200, rate, pink: true });
        break;
    }
  }

  playJump(): void {
    this.burst({ duration: 0.06, peak: 0.12, type: 'bandpass', freq: 1200, q: 1, pink: true });
  }

  playLand(hard: boolean): void {
    this.burst({
      duration: hard ? 0.16 : 0.09,
      peak: hard ? 0.4 : 0.2,
      type: 'lowpass',
      freq: 1200,
      freqEnd: 160,
      pink: true,
    });
    if (hard) this.tone({ freq: 130, freqEnd: 55, duration: 0.14, peak: 0.28, type: 'triangle' });
  }

  playHurt(): void {
    this.burst({ duration: 0.25, peak: 0.3, type: 'bandpass', freq: 500, q: 0.7, pink: true });
    this.tone({ freq: 220, freqEnd: 90, duration: 0.3, peak: 0.2, type: 'sawtooth' });
  }

  // --------------------------------------------------------------------- UI

  playHitmarker(headshot: boolean): void {
    this.tone({ freq: headshot ? 1500 : 1050, duration: 0.05, peak: 0.16, type: 'square' });
    this.tone({ freq: headshot ? 2100 : 1400, duration: 0.05, peak: 0.12, type: 'square', delay: 0.035 });
  }

  playUi(kind: 'click' | 'confirm' | 'deny'): void {
    switch (kind) {
      case 'click':
        this.tone({ freq: 900, duration: 0.05, peak: 0.1, type: 'square' });
        break;
      case 'confirm':
        this.tone({ freq: 700, duration: 0.07, peak: 0.12, type: 'triangle' });
        this.tone({ freq: 1050, duration: 0.1, peak: 0.12, type: 'triangle', delay: 0.06 });
        break;
      case 'deny':
        this.tone({ freq: 320, freqEnd: 190, duration: 0.14, peak: 0.14, type: 'sawtooth' });
        break;
    }
  }

  /** A knock-down target toppling onto its base. */
  playTargetFall(position: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 8, maxDistance: 220 };
    this.burst({ duration: 0.13, peak: 0.45, type: 'lowpass', freq: 900, freqEnd: 180, tail: 0.3 }, spatial);
    this.tone({ freq: randRange(160, 240), freqEnd: 70, duration: 0.16, peak: 0.3, type: 'triangle' }, spatial);
    for (let i = 0; i < 3; i++) {
      this.tone({
        freq: randRange(900, 2200),
        duration: randRange(0.08, 0.2),
        peak: 0.09,
        delay: 0.05 + i * randRange(0.04, 0.1),
        tail: 0.3,
      }, spatial);
    }
  }

  /** Pneumatic reset of a knock-down target. */
  playTargetReset(position: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 8, maxDistance: 200 };
    this.burst({ duration: 0.3, peak: 0.22, type: 'highpass', freq: 2600, pink: true }, spatial);
    this.burst({ duration: 0.05, peak: 0.28, type: 'bandpass', freq: 1400, q: 2, delay: 0.26 }, spatial);
    this.tone({ freq: 520, freqEnd: 760, duration: 0.1, peak: 0.12, type: 'triangle', delay: 0.24 }, spatial);
  }

  // -------------------------------------------------------------- grenades

  playPinPull(): void {
    this.burst({ duration: 0.05, peak: 0.3, type: 'bandpass', freq: 3600, q: 4 });
    this.tone({ freq: 2100, freqEnd: 1500, duration: 0.06, peak: 0.12, type: 'square', delay: 0.03 });
  }

  playThrow(): void {
    this.burst({ duration: 0.18, peak: 0.14, type: 'bandpass', freq: 900, q: 0.7, pink: true });
  }

  playGrenadeBounce(surface: ImpactMaterial, position: THREE.Vector3, energy: number): void {
    const spatial: SpatialOptions = {
      position,
      refDistance: 4,
      maxDistance: 60,
      volume: clamp(energy * 0.35, 0.1, 1),
    };
    if (surface === 'metal' || surface === 'steelTarget') {
      this.tone({ freq: randRange(700, 1500), duration: 0.16, peak: 0.24, tail: 0.3 }, spatial);
      this.burst({ duration: 0.04, peak: 0.2, type: 'highpass', freq: 2600 }, spatial);
    } else {
      this.burst({ duration: 0.07, peak: 0.28, type: 'lowpass', freq: 1400, freqEnd: 300 }, spatial);
      this.tone({ freq: randRange(220, 340), freqEnd: 120, duration: 0.08, peak: 0.14, type: 'triangle' }, spatial);
    }
  }

  /** High-explosive detonation: crack, deep boom and a long tail. */
  playExplosion(position: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 14, maxDistance: 600 };
    this.burst(
      { duration: 0.5, peak: 1, type: 'lowpass', freq: 9000, freqEnd: 120, tail: 1, distort: true },
      spatial,
    );
    this.tone({ freq: 130, freqEnd: 28, duration: 0.75, peak: 0.95, type: 'triangle', tail: 1 }, spatial);
    this.tone({ freq: 62, freqEnd: 20, duration: 1.1, peak: 0.7, type: 'sine', tail: 1 }, spatial);
    this.burst(
      { duration: 1.5, peak: 0.3, type: 'lowpass', freq: 2400, freqEnd: 160, attack: 0.06, tail: 1, pink: true },
      spatial,
    );
    // Debris rattle.
    for (let i = 0; i < 6; i++) {
      this.tone({
        freq: randRange(400, 2600),
        duration: randRange(0.06, 0.2),
        peak: 0.07,
        delay: randRange(0.15, 0.7),
        tail: 0.4,
      }, spatial);
    }
  }

  // ------------------------------------------------------------- vehicles

  /**
   * Starts a looping engine voice.
   *
   * Two detuned saws plus a sub give the body, a resonant lowpass sweeping with
   * revs gives the character, and a noise bed stands in for induction and
   * transmission whine. `timbre` mostly sets how far apart the saws sit and how
   * much noise rides along — a V12 is tight and bright, a diesel is loose and
   * gruff.
   */
  startEngine(timbre: 'v12' | 'petrol' | 'diesel'): void {
    this.stopEngine();
    const t = this.ctx.currentTime;
    const spec = {
      v12: { base: 34, detune: 7, noise: 0.05, q: 6, sub: 0.22 },
      petrol: { base: 26, detune: 14, noise: 0.11, q: 3.4, sub: 0.3 },
      diesel: { base: 17, detune: 22, noise: 0.2, q: 2.2, sub: 0.5 },
    }[timbre];

    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = spec.q;
    filter.connect(gain);
    gain.connect(this.sfxBus);

    const oscA = this.ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.value = spec.base;
    const oscB = this.ctx.createOscillator();
    oscB.type = 'sawtooth';
    oscB.frequency.value = spec.base;
    oscB.detune.value = spec.detune;
    const sub = this.ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = spec.base * 0.5;
    const subGain = this.ctx.createGain();
    subGain.gain.value = spec.sub;
    sub.connect(subGain);
    subGain.connect(filter);
    oscA.connect(filter);
    oscB.connect(filter);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = spec.noise;
    noise.connect(noiseGain);
    noiseGain.connect(filter);

    oscA.start(t);
    oscB.start(t);
    sub.start(t);
    noise.start(t);
    gain.gain.setTargetAtTime(0.28, t, 0.12);

    this.engine = { oscA, oscB, sub, noise, noiseGain, filter, gain, baseFreq: spec.base };
  }

  /**
   * @param rpm01 0..1 through the rev range.
   * @param load 0..1 throttle, which opens the filter and lifts the level.
   */
  updateEngine(rpm01: number, load: number): void {
    if (!this.engine) return;
    const e = this.engine;
    const t = this.ctx.currentTime;
    const rev = clamp(rpm01, 0, 1);
    const freq = e.baseFreq * (1 + rev * 3.6);
    e.oscA.frequency.setTargetAtTime(freq, t, 0.05);
    e.oscB.frequency.setTargetAtTime(freq, t, 0.05);
    e.sub.frequency.setTargetAtTime(freq * 0.5, t, 0.05);
    e.filter.frequency.setTargetAtTime(300 + rev * 2600 + load * 700, t, 0.06);
    e.gain.gain.setTargetAtTime(0.2 + rev * 0.16 + load * 0.08, t, 0.08);
    e.noiseGain.gain.setTargetAtTime(0.04 + rev * 0.1, t, 0.1);
  }

  stopEngine(): void {
    if (!this.engine) return;
    const e = this.engine;
    const t = this.ctx.currentTime;
    e.gain.gain.setTargetAtTime(0, t, 0.08);
    for (const node of [e.oscA, e.oscB, e.sub, e.noise]) node.stop(t + 0.4);
    this.engine = null;
  }

  /** Tyres and panels scraping the armco. */
  playVehicleImpact(position: THREE.Vector3, strength: number): void {
    const spatial: SpatialOptions = { position, refDistance: 10, maxDistance: 300 };
    const peak = clamp(strength, 0.15, 1);
    this.burst(
      { duration: 0.22, peak: peak * 0.8, type: 'bandpass', freq: 900, q: 0.9, tail: 0.7, distort: true },
      spatial,
    );
    this.tone({ freq: 150, freqEnd: 48, duration: 0.35, peak: peak * 0.6, type: 'triangle', tail: 0.6 }, spatial);
  }

  /** 120 mm main gun: a hard crack, a deep thump and a long tail. */
  playCannon(position: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 20, maxDistance: 900 };
    this.burst(
      { duration: 0.32, peak: 1, type: 'lowpass', freq: 12000, freqEnd: 200, tail: 1, distort: true },
      spatial,
    );
    this.tone({ freq: 88, freqEnd: 24, duration: 0.9, peak: 1, type: 'square', tail: 1 }, spatial);
    this.tone({ freq: 46, freqEnd: 18, duration: 1.4, peak: 0.8, type: 'sine', tail: 1 }, spatial);
    this.burst(
      { duration: 2.2, peak: 0.26, type: 'lowpass', freq: 1800, freqEnd: 120, attack: 0.1, tail: 1, pink: true },
      spatial,
    );
    // Breech and recoil clatter.
    this.burst({ duration: 0.1, peak: 0.3, type: 'bandpass', freq: 2600, q: 2, delay: 0.28 }, spatial);
  }

  playSmokePop(position: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 8, maxDistance: 160 };
    this.burst({ duration: 0.12, peak: 0.5, type: 'bandpass', freq: 900, q: 1.2, tail: 0.4 }, spatial);
    this.burst(
      { duration: 2.6, peak: 0.16, type: 'highpass', freq: 1800, attack: 0.15, pink: true },
      spatial,
    );
  }

  playFlashBang(position: THREE.Vector3): void {
    const spatial: SpatialOptions = { position, refDistance: 12, maxDistance: 400 };
    this.burst(
      { duration: 0.3, peak: 1, type: 'highpass', freq: 700, tail: 1, distort: true },
      spatial,
    );
    this.tone({ freq: 320, freqEnd: 60, duration: 0.3, peak: 0.75, type: 'square', tail: 1 }, spatial);
    this.burst({ duration: 0.9, peak: 0.2, type: 'lowpass', freq: 5000, freqEnd: 400, attack: 0.04, tail: 1 }, spatial);
  }

  /**
   * Temporary hearing loss: everything is muffled behind a lowpass and a
   * tinnitus tone rings over the top.
   */
  deafen(amount: number, duration: number): void {
    if (!this.isRunning) return;
    const t = this.now();
    const strength = clamp(amount, 0, 1);
    const cutoff = 22000 - strength * 21500;

    this.deafenFilter.frequency.cancelScheduledValues(t);
    this.deafenFilter.frequency.setValueAtTime(Math.max(220, cutoff), t);
    this.deafenFilter.frequency.exponentialRampToValueAtTime(22000, t + Math.max(0.3, duration));

    // Tinnitus ring.
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(4300 + Math.random() * 400, t);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.05 * strength, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.1);
    this.trackVoice(osc);
  }

  playRangeEvent(kind: 'start' | 'end' | 'targetUp'): void {
    switch (kind) {
      case 'start':
        this.tone({ freq: 660, duration: 0.12, peak: 0.18, type: 'square' });
        this.tone({ freq: 880, duration: 0.18, peak: 0.18, type: 'square', delay: 0.14 });
        break;
      case 'end':
        this.tone({ freq: 880, duration: 0.12, peak: 0.18, type: 'square' });
        this.tone({ freq: 587, duration: 0.14, peak: 0.16, type: 'square', delay: 0.13 });
        this.tone({ freq: 440, duration: 0.3, peak: 0.16, type: 'square', delay: 0.27 });
        break;
      case 'targetUp':
        this.burst({ duration: 0.18, peak: 0.12, type: 'bandpass', freq: 700, q: 1.2 });
        break;
    }
  }
}
