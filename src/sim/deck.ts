/**
 * deck.ts — training data.
 *
 * Every card is its own object with its own level and transforms, so a deck is
 * a collection you grow rather than a set of counters. You build it in the
 * shop; the draw order is random.
 *
 * Deck size and activations are deliberately SEPARATE resources. Activations
 * are how many shots a benchmark gives you; the deck is what those shots fire.
 * The shop sells both independently, so "more shots" and "better shots" are
 * different purchases.
 *
 * Sixteen starting cards is a deliberate number: deleting one is a visible 6%
 * shift in your odds, which is what makes paying to remove a weak card a
 * legible decision. A 52-card deck would make thinning statistically invisible
 * at a ten-shot draw.
 */

import { DECK } from '../config/balance'
import type { Rng } from '../core/rng'

export type CardType = 'common-crawl' | 'arxiv' | 'synthetic' | 'rlhf'

export type CardTransform =
  | 'deduplicated'
  | 'tokenised'
  | 'curated'
  | 'web-scale'
  | 'poisoned'
  | 'distilled'

export interface CardTypeDef {
  readonly id: CardType
  readonly name: string
  readonly short: string
  /** Multiplies the token's score contribution. */
  readonly valueMult: number
  /** Scales restitution. Heavy data punches deeper; light data skips wide. */
  readonly bounce: number
  /** Scales launch speed. */
  readonly speed: number
  /** Synthetic data rolls its value per launch between these bounds. */
  readonly volatile?: readonly [number, number]
  readonly blurb: string
}

export const CARD_TYPES: Record<CardType, CardTypeDef> = {
  'common-crawl': {
    id: 'common-crawl',
    name: 'Common Crawl',
    short: 'CRAWL',
    valueMult: 1.0,
    bounce: 1.0,
    speed: 1.0,
    blurb: 'the dependable default. mostly boilerplate, but there is a lot of it.',
  },
  arxiv: {
    id: 'arxiv',
    name: 'arXiv Dump',
    short: 'ARXIV',
    valueMult: 1.3,
    bounce: 0.82,
    speed: 1.12,
    blurb: 'heavy. falls straighter, punches deeper, hits fewer things harder.',
  },
  synthetic: {
    id: 'synthetic',
    name: 'Synthetic Gen',
    short: 'SYNTH',
    valueMult: 1.0,
    bounce: 1.22,
    speed: 1.0,
    volatile: [0.4, 2.2],
    blurb: 'model-generated. nobody checked it. could be anything.',
  },
  rlhf: {
    id: 'rlhf',
    name: 'RLHF Preference',
    short: 'RLHF',
    valueMult: 0.8,
    bounce: 1.3,
    speed: 0.92,
    blurb: 'light and agreeable. touches everything, commits to nothing.',
  },
}

export interface CardTransformDef {
  readonly id: CardTransform
  readonly name: string
  readonly short: string
  readonly description: string
}

export const CARD_TRANSFORMS: Record<CardTransform, CardTransformDef> = {
  deduplicated: {
    id: 'deduplicated',
    name: 'Deduplicated',
    short: 'DEDUP',
    description: 'Signal from this token travels one extra hop.',
  },
  tokenised: {
    id: 'tokenised',
    name: 'Tokenised',
    short: 'TOKEN',
    description: 'Splits into two tokens on first contact.',
  },
  curated: {
    id: 'curated',
    name: 'Curated',
    short: 'CURATE',
    description: 'Guarantees a minimum pass value. Removes the floor.',
  },
  'web-scale': {
    id: 'web-scale',
    name: 'Web-Scale',
    short: 'WEB',
    description: 'Contacts count double toward the multiplier tier.',
  },
  poisoned: {
    id: 'poisoned',
    name: 'Poisoned',
    short: 'POISON',
    description: 'Triple value, but a 20% chance the whole pass scores zero.',
  },
  distilled: {
    id: 'distilled',
    name: 'Distilled',
    short: 'DISTIL',
    description: 'Half value, but returns itself to the draw queue after use.',
  },
}

export interface Card {
  readonly id: number
  type: CardType
  level: number
  transforms: CardTransform[]
}

export function cardValue(card: Card): number {
  const def = CARD_TYPES[card.type]
  let v = def.valueMult * (1 + DECK.levelStep * (card.level - 1))
  if (card.transforms.includes('poisoned')) v *= DECK.poisonedMult
  if (card.transforms.includes('distilled')) v *= DECK.distilledMult
  return v
}

export function cardLabel(card: Card): string {
  const def = CARD_TYPES[card.type]
  const tags = card.transforms.map((t) => CARD_TRANSFORMS[t].short)
  return `${def.short} L${card.level}${tags.length ? ' · ' + tags.join('·') : ''}`
}

/**
 * The deck and its draw queue.
 *
 * The queue is shuffled once per benchmark and drawn from the front, so the
 * player can be shown what is coming next. Drawing with replacement would be
 * simpler but makes "next up" meaningless and lets the same card appear five
 * times in a row.
 */
export class Deck {
  readonly cards: Card[] = []
  private queue: number[] = []
  private nextId = 1

  constructor(rng?: Rng) {
    for (const type of Object.keys(CARD_TYPES) as CardType[]) {
      for (let i = 0; i < DECK.startingPerType; i++) this.add(type)
    }
    if (rng) this.reshuffle(rng)
  }

  add(type: CardType, level = 1, transforms: CardTransform[] = []): Card {
    const card: Card = { id: this.nextId++, type, level, transforms: transforms.slice() }
    this.cards.push(card)
    return card
  }

  remove(cardId: number): boolean {
    const i = this.cards.findIndex((c) => c.id === cardId)
    if (i < 0) return false
    this.cards.splice(i, 1)
    this.queue = this.queue.filter((q) => q !== cardId)
    return true
  }

  byId(cardId: number): Card | undefined {
    return this.cards.find((c) => c.id === cardId)
  }

  get size(): number {
    return this.cards.length
  }

  /** Fresh shuffled queue. Called at the start of every benchmark. */
  reshuffle(rng: Rng): void {
    this.queue = rng.shuffle(this.cards.map((c) => c.id))
  }

  /** The next `n` cards, for the "now loading" readout. */
  peek(n: number): Card[] {
    const out: Card[] = []
    for (let i = 0; i < Math.min(n, this.queue.length); i++) {
      const c = this.byId(this.queue[i]!)
      if (c) out.push(c)
    }
    return out
  }

  /**
   * Draw the next card. Refills from a reshuffle when the queue empties, so a
   * long benchmark never runs out of ammo for a reason the player cannot see.
   */
  draw(rng: Rng): Card | null {
    if (this.cards.length === 0) return null
    if (this.queue.length === 0) this.reshuffle(rng)
    const id = this.queue.shift()
    if (id === undefined) return null
    const card = this.byId(id)
    if (!card) return this.draw(rng)
    // Distilled data goes straight back into the queue rather than waiting
    // for the next shuffle — that is the whole point of taking it.
    if (card.transforms.includes('distilled')) this.queue.push(card.id)
    return card
  }

  /** Composition summary, for the shop and the HUD. */
  summary(): { type: CardType; count: number; avgLevel: number }[] {
    const out: { type: CardType; count: number; avgLevel: number }[] = []
    for (const type of Object.keys(CARD_TYPES) as CardType[]) {
      const of = this.cards.filter((c) => c.type === type)
      if (of.length === 0) continue
      out.push({
        type,
        count: of.length,
        avgLevel: of.reduce((a, c) => a + c.level, 0) / of.length,
      })
    }
    return out
  }
}
