/**
 * rng.ts — seeded deterministic randomness.
 *
 * RULE: `Math.random()` is banned everywhere in gameplay code. Every random
 * decision in rogue/acc flows through an Rng constructed from the run seed, so
 * a seed fully reproduces board layouts and upgrade offers. Purely cosmetic
 * jitter (popup drift) is the only exception and lives in the UI layer.
 *
 * Streams are derived, not shared: `deriveRng(seed, 'board', 4)` gives stage 4
 * the same board no matter what the player did on stages 1-3, and no matter how
 * many times the RNG was pulled elsewhere. That independence is what makes a
 * seed meaningful.
 */

/** sfc32 — small, fast, 128-bit state, excellent distribution. */
export class Rng {
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(a: number, b: number, c: number, d: number) {
    this.a = a >>> 0
    this.b = b >>> 0
    this.c = c >>> 0
    this.d = d >>> 0
    // Discard the first few outputs; sfc32 needs a moment to mix.
    for (let i = 0; i < 12; i++) this.next()
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.a |= 0
    this.b |= 0
    this.c |= 0
    this.d |= 0
    const t = (((this.a + this.b) | 0) + this.d) | 0
    this.d = (this.d + 1) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.c = (this.c + t) | 0
    return (t >>> 0) / 4294967296
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on empty array')
    return items[this.int(0, items.length - 1)]!
  }

  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i)
      const tmp = out[i]!
      out[i] = out[j]!
      out[j] = tmp
    }
    return out
  }

  /** `count` distinct items, or all of them if count exceeds the pool. */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, Math.min(count, items.length))
  }

  /** Weighted pick. Weights need not sum to 1; non-positive weights are skipped. */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T {
    let total = 0
    for (const it of items) total += Math.max(0, weightOf(it))
    if (total <= 0) return this.pick(items)
    let roll = this.next() * total
    for (const it of items) {
      roll -= Math.max(0, weightOf(it))
      if (roll <= 0) return it
    }
    return items[items.length - 1]!
  }

  /** Roughly gaussian via the central limit theorem. Cheap and good enough. */
  gaussian(mean = 0, stdDev = 1): number {
    const sum = this.next() + this.next() + this.next() + this.next() + this.next() + this.next()
    return mean + (sum - 3) * 0.7071 * stdDev
  }
}

/** FNV-1a over a string → 32-bit unsigned. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Build an independent Rng stream from a run seed plus any number of labels.
 * Different labels produce uncorrelated streams from the same seed.
 */
export function deriveRng(seed: string, ...labels: (string | number)[]): Rng {
  const key = `${seed}::${labels.join(':')}`
  const h1 = fnv1a(key)
  const h2 = fnv1a(`${key}:beta`)
  const h3 = fnv1a(`gamma:${key}`)
  const h4 = fnv1a(`${h1 ^ h2}:delta:${key}`)
  return new Rng(h1, h2, h3, h4)
}

const SEED_ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXYZ2345679'

/**
 * A fresh human-sharable seed. This is the ONE place a non-deterministic source
 * is legitimate — we are minting a new seed, not making a gameplay decision.
 */
export function mintSeed(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += SEED_ALPHABET[bytes[i]! % SEED_ALPHABET.length]
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

/** Normalise user-supplied seeds so `abc def` and `ABC-DEF` are the same run. */
export function normaliseSeed(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (cleaned.length === 0) return mintSeed()
  return cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4, 16)}` : cleaned
}
