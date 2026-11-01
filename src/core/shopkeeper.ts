/**
 * shopkeeper.ts — rolling stock, resolving targets, applying purchases.
 *
 * Kept out of `game.ts` because it is pure rules: given a run, a board and an
 * rng, what is for sale and what does buying it do? No DOM, no Three.js, so
 * the harness can shop exactly as the player does.
 */

import { PROGRESSION } from '../config/balance'
import { DECK } from '../config/balance'
import {
  priceOf, SHOP, SHOP_ITEMS,
  type Band, type ShopItemDef,
} from '../config/shop'
import type { Board, NodeDef, PocketDef } from '../sim/board'
import type { Card } from '../sim/deck'
import type { Rng } from './rng'
import type { RunState } from './state'

export interface Offer {
  readonly def: ShopItemDef
  readonly price: number
  /** Resolved only for precise purchases, at buy time. */
  target?: { kind: 'node'; id: number } | { kind: 'bucket'; id: number } | { kind: 'card'; id: number }
  band?: Band
  sold: boolean
}

export interface PurchaseResult {
  ok: boolean
  message: string
  /** True when the board changed and caches must be rebuilt. */
  boardChanged: boolean
}

/** Can this item do anything at all right now? Filters dead stock. */
function isUseful(def: ShopItemDef, run: RunState, board: Board): boolean {
  if (def.maxBuys > 0 && (run.bought[def.id] ?? 0) >= def.maxBuys) return false

  switch (def.effect.kind) {
    case 'node-transform': {
      const t = def.effect.transform
      return board.nodes.some(
        (n) => !n.removed &&
          n.transforms.length < PROGRESSION.maxTransformsPerNode &&
          !n.transforms.includes(t),
      )
    }
    case 'bucket-transform':
      return board.pockets.some((p) => p.kind !== 'drain' && p.transform === null)
    case 'node-level':
      return board.nodes.some((n) => !n.removed && n.level < PROGRESSION.maxNodeLevel)
    case 'bucket-level':
      return board.pockets.some((p) => p.level < PROGRESSION.maxBucketLevel)
    case 'card-remove':
      return run.deck.size > 1
    case 'card-level':
      return run.deck.cards.some((c) => c.level < DECK.maxLevel)
    case 'card-transform': {
      const t = def.effect.transform
      return run.deck.cards.some(
        (c) => c.transforms.length < DECK.maxTransformsPerCard && !c.transforms.includes(t),
      )
    }
    default:
      return true
  }
}

export function rollStock(run: RunState, board: Board, rng: Rng): Offer[] {
  const eligible = SHOP_ITEMS.filter((d) => isUseful(d, run, board))
  const offers: Offer[] = []
  const used = new Set<string>()

  while (offers.length < SHOP.stock && used.size < eligible.length) {
    const pool = eligible.filter((d) => !used.has(d.id))
    if (pool.length === 0) break
    const def = rng.weighted(pool, (d) => d.weight)
    used.add(def.id)
    offers.push({ def, price: priceOf(def), sold: false })
  }
  return offers
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

function layerBand(board: Board, node: NodeDef): Band {
  const third = board.layers / 3
  if (node.layer < third) return 'upper'
  if (node.layer < third * 2) return 'middle'
  return 'lower'
}

/** Candidate nodes for an effect, honouring the band when one was chosen. */
export function nodeCandidates(def: ShopItemDef, board: Board, band?: Band): NodeDef[] {
  let pool = board.nodes.filter((n) => !n.removed)
  if (band) pool = pool.filter((n) => layerBand(board, n) === band)

  if (def.effect.kind === 'node-level') {
    return pool.filter((n) => n.level < PROGRESSION.maxNodeLevel)
  }
  if (def.effect.kind === 'node-transform') {
    const t = def.effect.transform
    return pool.filter(
      (n) => n.transforms.length < PROGRESSION.maxTransformsPerNode && !n.transforms.includes(t),
    )
  }
  return pool
}

export function bucketCandidates(def: ShopItemDef, board: Board): PocketDef[] {
  if (def.effect.kind === 'bucket-transform') {
    return board.pockets.filter((p) => p.kind !== 'drain' && p.transform === null)
  }
  return board.pockets.filter((p) => p.level < PROGRESSION.maxBucketLevel)
}

export function cardCandidates(def: ShopItemDef, run: RunState): Card[] {
  if (def.effect.kind === 'card-level') {
    return run.deck.cards.filter((c) => c.level < DECK.maxLevel)
  }
  if (def.effect.kind === 'card-transform') {
    const t = def.effect.transform
    return run.deck.cards.filter(
      (c) => c.transforms.length < DECK.maxTransformsPerCard && !c.transforms.includes(t),
    )
  }
  return run.deck.cards
}

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

export function applyPurchase(
  offer: Offer,
  run: RunState,
  board: Board,
  rng: Rng,
): PurchaseResult {
  const { def } = offer
  const e = def.effect

  switch (e.kind) {
    case 'node-level': {
      const pool = nodeCandidates(def, board, offer.band)
      if (pool.length === 0) return fail('no weight left to improve')
      // A precise purchase names ONE weight and hits it hard; blind and
      // banded ones spray across several. That is the trade the price buys.
      const picked = offer.target?.kind === 'node'
        ? [board.nodes.find((n) => n.id === offer.target!.id)].filter(Boolean) as NodeDef[]
        : rng.sample(pool, Math.min(e.count, pool.length))
      if (picked.length === 0) return fail('no weight left to improve')
      for (const n of picked) n.level = Math.min(PROGRESSION.maxNodeLevel, n.level + e.amount)
      return done(
        picked.length === 1
          ? `weight #${picked[0]!.id} → L${picked[0]!.level}`
          : `+${e.amount} level to ${picked.length} weights`,
        true,
      )
    }

    case 'node-transform': {
      const pool = nodeCandidates(def, board, offer.band)
      if (pool.length === 0) return fail('no weight can take that')
      const picked = offer.target?.kind === 'node'
        ? [board.nodes.find((n) => n.id === offer.target!.id)].filter(Boolean) as NodeDef[]
        : rng.sample(pool, Math.min(e.count, pool.length))
      if (picked.length === 0) return fail('no weight can take that')
      for (const n of picked) n.transforms.push(e.transform)
      return done(
        picked.length === 1
          ? `weight #${picked[0]!.id} → ${e.transform}`
          : `${e.transform} on ${picked.length} weights`,
        true,
      )
    }

    case 'bucket-level': {
      const pool = bucketCandidates(def, board)
      if (pool.length === 0) return fail('no token left to widen')
      const picked = offer.target?.kind === 'bucket'
        ? [board.pockets.find((p) => p.id === offer.target!.id)].filter(Boolean) as PocketDef[]
        : rng.sample(pool, Math.min(e.count, pool.length))
      if (picked.length === 0) return fail('no token left to widen')
      for (const b of picked) b.level = Math.min(PROGRESSION.maxBucketLevel, b.level + e.amount)
      return done(
        picked.length === 1
          ? `TOK_${String(picked[0]!.id).padStart(2, '0')} → L${picked[0]!.level}`
          : `+${e.amount} level to ${picked.length} output tokens`,
        true,
      )
    }

    case 'bucket-transform': {
      const pool = bucketCandidates(def, board)
      const b = offer.target?.kind === 'bucket'
        ? board.pockets.find((p) => p.id === offer.target!.id)
        : pool.length ? rng.pick(pool) : undefined
      if (!b) return fail('no token can take that')
      b.transform = e.transform
      return done(`TOK_${String(b.id).padStart(2, '0')} → ${e.transform}`, true)
    }

    case 'card-level': {
      const pool = cardCandidates(def, run)
      if (pool.length === 0) return fail('every card is maxed')
      const picked = offer.target?.kind === 'card'
        ? [run.deck.byId(offer.target.id)].filter(Boolean) as Card[]
        : rng.sample(pool, Math.min(e.count, pool.length))
      if (picked.length === 0) return fail('every card is maxed')
      for (const c of picked) c.level = Math.min(DECK.maxLevel, c.level + e.amount)
      return done(
        picked.length === 1
          ? `card #${picked[0]!.id} → L${picked[0]!.level}`
          : `+${e.amount} level to ${picked.length} cards`,
        false,
      )
    }

    case 'card-transform': {
      const pool = cardCandidates(def, run)
      const card = offer.target?.kind === 'card'
        ? run.deck.byId(offer.target.id)
        : pool.length ? rng.pick(pool) : undefined
      if (!card) return fail('no card can take that')
      card.transforms.push(e.transform)
      return done(`card #${card.id} → ${e.transform}`, false)
    }

    case 'card-add': {
      for (let i = 0; i < e.count; i++) run.deck.add(e.cardType)
      return done(`+${e.count} ${e.cardType}`, false)
    }

    case 'card-remove': {
      const card = offer.target?.kind === 'card' ? run.deck.byId(offer.target.id) : undefined
      if (!card) return fail('pick a card to delete')
      run.deck.remove(card.id)
      return done(`deleted card #${card.id}`, false)
    }

    case 'activations': {
      run.activationAllowance += e.amount
      run.activations += e.amount
      return done(`+${e.amount} activation${e.amount === 1 ? '' : 's'} per benchmark`, false)
    }
  }
}

function done(message: string, boardChanged: boolean): PurchaseResult {
  return { ok: true, message, boardChanged }
}
function fail(message: string): PurchaseResult {
  return { ok: false, message, boardChanged: false }
}

export function rerollPrice(rerolls: number): number {
  return SHOP.rerollBase + rerolls * SHOP.rerollStep
}
