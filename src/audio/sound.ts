/**
 * sound.ts — procedural audio. No asset files, no loading, no license.
 *
 * A pachinko game lives on the tick of each weight, so the most important
 * voice here by far is `pinTick`. Everything else is garnish.
 *
 * Three constraints shaped the design:
 *
 * 1. **Autoplay policy.** An AudioContext created before a user gesture starts
 *    suspended and stays silent. The context is therefore created lazily on
 *    the first real input and resumed on every subsequent one.
 *
 * 2. **Density.** A dense cascade with several tokens can register dozens of
 *    strikes a second. Every voice is a short one-shot that disposes itself,
 *    and `pinTick` is rate-limited, or the mix turns to mud and the main
 *    thread spends its budget building oscillators.
 *
 * 3. **Escalation.** Pitch rises with chain length. That rising run of notes
 *    is what makes a long cascade *feel* long — it is the audio equivalent of
 *    the multiplier ladder, and it costs nothing to implement.
 */

const STORAGE_KEY = 'rogue-acc:muted'

/** Pentatonic steps (semitones). Random intervals sound wrong; these do not. */
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31]

export class Audio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private comp: DynamicsCompressorNode | null = null
  private noiseBuffer: AudioBuffer | null = null

  private _muted = false
  /** Voices started in the current frame, for rate limiting. */
  private framePins = 0
  private lastTickAt = 0

  constructor() {
    try {
      this._muted = localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      this._muted = false
    }
  }

  get muted(): boolean {
    return this._muted
  }

  toggleMute(): boolean {
    this._muted = !this._muted
    try {
      localStorage.setItem(STORAGE_KEY, this._muted ? '1' : '0')
    } catch {
      /* private browsing — the preference just will not persist */
    }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this._muted ? 0 : 0.9, this.ctx.currentTime, 0.02)
    }
    return this._muted
  }

  /**
   * Must be called from a user gesture handler. Safe to call repeatedly —
   * browsers can re-suspend the context when a tab is backgrounded.
   */
  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext()
      } catch {
        return
      }
      this.comp = this.ctx.createDynamicsCompressor()
      this.comp.threshold.value = -18
      this.comp.knee.value = 24
      this.comp.ratio.value = 10
      this.comp.attack.value = 0.003
      this.comp.release.value = 0.14

      this.master = this.ctx.createGain()
      this.master.gain.value = this._muted ? 0 : 0.9

      this.master.connect(this.comp)
      this.comp.connect(this.ctx.destination)

      this.noiseBuffer = this.makeNoise()
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  /** Call once per frame so the per-frame voice budget resets. */
  frame(): void {
    this.framePins = 0
  }

  private makeNoise(): AudioBuffer | null {
    if (!this.ctx) return null
    const len = Math.floor(this.ctx.sampleRate * 0.4)
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = buf.getChannelData(0)
    // Cosmetic only — never a gameplay decision, so Math.random is fine here.
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    return buf
  }

  private get ready(): boolean {
    return !!(this.ctx && this.master && !this._muted)
  }

  // -------------------------------------------------------------------------
  // Primitive voices
  // -------------------------------------------------------------------------

  private blip(
    freq: number,
    duration: number,
    gain: number,
    type: OscillatorType = 'triangle',
    detune = 0,
    sweepTo?: number,
  ): void {
    if (!this.ready) return
    const ctx = this.ctx!
    const now = ctx.currentTime

    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freq, now)
    if (sweepTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), now + duration)
    osc.detune.value = detune

    const env = ctx.createGain()
    // Percussive: near-instant attack, exponential tail. A linear tail reads
    // as a beep; an exponential one reads as a strike.
    env.gain.setValueAtTime(0.0001, now)
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + 0.004)
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    osc.connect(env)
    env.connect(this.master!)
    osc.start(now)
    osc.stop(now + duration + 0.02)
    osc.onended = () => {
      osc.disconnect()
      env.disconnect()
    }
  }

  private noise(duration: number, gain: number, filterHz: number, sweepTo?: number): void {
    if (!this.ready || !this.noiseBuffer) return
    const ctx = this.ctx!
    const now = ctx.currentTime

    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer

    const filt = ctx.createBiquadFilter()
    filt.type = 'bandpass'
    filt.frequency.setValueAtTime(filterHz, now)
    if (sweepTo !== undefined) filt.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), now + duration)
    filt.Q.value = 1.1

    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, now)
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), now + 0.003)
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    src.connect(filt)
    filt.connect(env)
    env.connect(this.master!)
    src.start(now)
    src.stop(now + duration + 0.02)
    src.onended = () => {
      src.disconnect()
      filt.disconnect()
      env.disconnect()
    }
  }

  // -------------------------------------------------------------------------
  // Game voices
  // -------------------------------------------------------------------------

  /**
   * A weight strike. `chain` drives pitch up the scale so a long cascade is an
   * ascending run; `heat` brightens the timbre with temperature.
   */
  pinTick(chain: number, heat: number): void {
    if (!this.ready) return
    // Rate limit: at most 4 per frame, and never two inside 12ms. Dense
    // cascades otherwise produce a wall of clicks instead of a rhythm.
    if (this.framePins >= 4) return
    const now = this.ctx!.currentTime
    if (now - this.lastTickAt < 0.012) return
    this.lastTickAt = now
    this.framePins++

    const step = SCALE[Math.min(SCALE.length - 1, chain)] ?? 0
    const freq = 320 * Math.pow(2, step / 12)
    this.blip(freq, 0.075, 0.1 + heat * 0.05, heat > 0.6 ? 'square' : 'triangle', heat * 12)
    this.noise(0.03, 0.035, 2400 + heat * 1800)
  }

  /** Attention head — brighter, with a perfect fifth stacked on top. */
  criticalTick(chain: number, heat: number): void {
    if (!this.ready) return
    const step = SCALE[Math.min(SCALE.length - 1, chain)] ?? 0
    const freq = 420 * Math.pow(2, step / 12)
    this.blip(freq, 0.17, 0.14, 'sawtooth', heat * 10)
    this.blip(freq * 1.5, 0.13, 0.08, 'triangle')
    this.noise(0.07, 0.05, 3600, 1200)
  }

  /** Hallucination Engine payout — detuned, slightly wrong, deliberately. */
  hallucination(): void {
    this.blip(660, 0.2, 0.1, 'sawtooth', -35)
    this.blip(661, 0.2, 0.1, 'sawtooth', 42)
    this.blip(990, 0.14, 0.06, 'square', 18)
  }

  /** Benchmark spike — the jackpot. The one unmistakably triumphant sound. */
  spike(): void {
    if (!this.ready) return
    const ctx = this.ctx!
    const root = 523.25
    // Ascending arpeggio, scheduled ahead on the audio clock so it stays in
    // time regardless of what the frame loop is doing.
    ;[0, 4, 7, 12, 16, 19].forEach((semi, i) => {
      const t = ctx.currentTime + i * 0.055
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = root * Math.pow(2, semi / 12)
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.exponentialRampToValueAtTime(0.16, t + 0.006)
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.34)
      osc.connect(env)
      env.connect(this.master!)
      osc.start(t)
      osc.stop(t + 0.36)
      osc.onended = () => {
        osc.disconnect()
        env.disconnect()
      }
    })
    this.noise(0.5, 0.07, 900, 5200)
  }

  /** Dead neuron. Low, short, final. */
  drain(): void {
    this.blip(118, 0.26, 0.14, 'sine', 0, 52)
    this.noise(0.17, 0.05, 300, 90)
  }

  /** Residual pocket — a small consolation. */
  pocket(): void {
    this.blip(330, 0.13, 0.07, 'triangle', 0, 420)
  }

  /** Token fired. Pitch and brightness scale with charge and temperature. */
  launch(charge: number, heat: number): void {
    this.blip(190 + charge * 150, 0.17, 0.12, 'sawtooth', heat * 20, 90)
    this.noise(0.13, 0.06, 700 + charge * 1400, 320)
  }

  /**
   * A forward pass firing. Pitch and voice count scale with how far the
   * signal reached, so a big propagation is audibly bigger without needing
   * one voice per node — which at 20 nodes would be a wall of clicks.
   */
  signal(reached: number): void {
    if (!this.ready || reached <= 0) return
    const ctx = this.ctx!
    const voices = Math.min(4, 1 + Math.floor(reached / 4))
    for (var v = 0; v < voices; v++) {
      var t = ctx.currentTime + v * 0.045
      var osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(240 * Math.pow(2, v / 6), t)
      osc.frequency.exponentialRampToValueAtTime(240 * Math.pow(2, (v + 2) / 6), t + 0.18)
      var env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.exponentialRampToValueAtTime(0.055, t + 0.008)
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      osc.connect(env)
      env.connect(this.master!)
      osc.start(t)
      osc.stop(t + 0.24)
      osc.onended = (function (o, e) {
        return function () { o.disconnect(); e.disconnect() }
      })(osc, env)
    }
  }

  /** Chain Reaction split. */
  split(): void {
    this.blip(760, 0.1, 0.09, 'square', 0, 1180)
  }

  /** Explosive Weights. */
  detonate(): void {
    this.noise(0.26, 0.12, 1500, 160)
    this.blip(92, 0.22, 0.1, 'sine', 0, 44)
  }

  /** Rising tone while the launcher charges. Called once per charge start. */
  chargeStart(): void {
    if (!this.ready) return
    const ctx = this.ctx!
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(110, now)
    osc.frequency.exponentialRampToValueAtTime(300, now + 0.4)

    const filt = ctx.createBiquadFilter()
    filt.type = 'lowpass'
    filt.frequency.setValueAtTime(500, now)
    filt.frequency.exponentialRampToValueAtTime(2600, now + 0.4)

    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, now)
    env.gain.exponentialRampToValueAtTime(0.055, now + 0.07)
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.46)

    osc.connect(filt)
    filt.connect(env)
    env.connect(this.master!)
    osc.start(now)
    osc.stop(now + 0.48)
    osc.onended = () => {
      osc.disconnect()
      filt.disconnect()
      env.disconnect()
    }
  }

  uiMove(): void {
    this.blip(520, 0.045, 0.045, 'square')
  }

  uiConfirm(): void {
    this.blip(440, 0.1, 0.08, 'triangle')
    this.blip(660, 0.14, 0.06, 'triangle')
  }

  uiDenied(): void {
    this.blip(150, 0.13, 0.09, 'square', -28, 105)
  }

  stageClear(): void {
    if (!this.ready) return
    const ctx = this.ctx!
    ;[0, 7, 12, 19].forEach((semi, i) => {
      const t = ctx.currentTime + i * 0.1
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = 392 * Math.pow(2, semi / 12)
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.exponentialRampToValueAtTime(0.14, t + 0.01)
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
      osc.connect(env)
      env.connect(this.master!)
      osc.start(t)
      osc.stop(t + 0.52)
      osc.onended = () => {
        osc.disconnect()
        env.disconnect()
      }
    })
  }

  /** Signal collapse: a descending, detuned fall. */
  runFail(): void {
    if (!this.ready) return
    const ctx = this.ctx!
    ;[0, -3, -7, -12].forEach((semi, i) => {
      const t = ctx.currentTime + i * 0.16
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = 294 * Math.pow(2, semi / 12)
      osc.detune.value = -22
      const env = ctx.createGain()
      env.gain.setValueAtTime(0.0001, t)
      env.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.62)
      osc.connect(env)
      env.connect(this.master!)
      osc.start(t)
      osc.stop(t + 0.64)
      osc.onended = () => {
        osc.disconnect()
        env.disconnect()
      }
    })
  }

  dispose(): void {
    void this.ctx?.close()
    this.ctx = null
    this.master = null
  }
}
