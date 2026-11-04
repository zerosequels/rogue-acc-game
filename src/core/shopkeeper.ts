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

/**
 * Resolve a node-targeting count against the ACTUAL board size.
 *
 * Shop reach has to be a fraction of the lattice, not a fixed number. See
 * `SHOP.referenceNodes` for why this exists.
 */
function scaled(count: number, board: Board): number {
  if (count >= 999) return count          // 999 means "every weight"
  if (count <= 1) return count            // precise picks stay singular
  const active = board.nodes.filter((n) => !n.removed).length
  return Math.max(1, Math.round(count * (active / SHOP.referenceNodes)))
}
import type { Board, NodeDef, PocketDef } from '../sim/board'
import type { Card } from '../sim/deck'
import { deriveRng, type Rng } from './rng'
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

/**
 * What a purchase would actually hit.
 *
 * Preview and purchase MUST go through this same function with the same rng,
 * or the highlight lies. That is the whole point of the hover preview: you
 * see the real targets before you commit, while the selection stays random.
 */
export interface ResolvedTargets {
  nodes: NodeDef[]
  buckets: PocketDef[]
  cards: Card[]
  /** True when the player named the target rather than the machine. */
  chosen: boolean
}

export function resolveTargets(
  offer: Offer,
  run: RunState,
  board: Board,
  rng: Rng,
): ResolvedTargets {
  const { def } = offer
  const e = def.effect
  const out: ResolvedTargets = { nodes: [], buckets: [], cards: [], chosen: false }

  switch (e.kind) {
    case 'node-level':
    case 'node-transform': {
      if (offer.target?.kind === 'node') {
        const n = board.nodes.find((x) => x.id === offer.target!.id)
        if (n) { out.nodes.push(n); out.chosen = true }
        return out
      }
      const pool = nodeCandidates(def, board, offer.band)
      const count = e.kind === 'node-level' || e.kind === 'node-transform'
        ? scaled(e.count, board) : 1
      out.nodes = rng.sample(pool, Math.min(count, pool.length))
      return out
    }
    case 'bucket-level':
    case 'bucket-transform': {
      if (offer.target?.kind === 'bucket') {
        const p = board.pockets.find((x) => x.id === offer.target!.id)
        if (p) { out.buckets.push(p); out.chosen = true }
        return out
      }
      const pool = bucketCandidates(def, board)
      const count = e.kind === 'bucket-level' ? e.count : 1
      out.buckets = rng.sample(pool, Math.min(count, pool.length))
      return out
    }
    case 'card-level':
    case 'card-transform':
    case 'card-remove': {
      if (offer.target?.kind === 'card') {
        const c = run.deck.byId(offer.target.id)
        if (c) { out.cards.push(c); out.chosen = true }
        return out
      }
      if (e.kind === 'card-remove') return out
      const pool = cardCandidates(def, run)
      const count = e.kind === 'card-level' ? e.count : 1
      out.cards = rng.sample(pool, Math.min(count, pool.length))
      return out
    }
    default:
      return out
  }
}

export function applyPurchase(
  offer: Offer,
  run: RunState,
  board: Board,
  rng: Rng,
): PurchaseResult {
  const { def } = offer
  const e = def.effect
  const t = resolveTargets(offer, run, board, rng)

  switch (e.kind) {
    case 'node-level': {
      if (t.nodes.length === 0) return fail('no weight left to improve')
      for (const n of t.nodes) n.level = Math.min(PROGRESSION.maxNodeLevel, n.level + e.amount)
      return done(
        t.nodes.length === 1
          ? `weight #${t.nodes[0]!.id} → L${t.nodes[0]!.level}`
          : `+${e.amount} level to ${t.nodes.length} weights`,
        true,
      )
    }

    case 'node-transform': {
      if (t.nodes.length === 0) return fail('no weight can take that')
      for (const n of t.nodes) n.transforms.push(e.transform)
      return done(
        t.nodes.length === 1
          ? `weight #${t.nodes[0]!.id} → ${e.transform}`
          : `${e.transform} on ${t.nodes.length} weights`,
        true,
      )
    }

    case 'bucket-level': {
      if (t.buckets.length === 0) return fail('no token left to widen')
      for (const b of t.buckets) b.level = Math.min(PROGRESSION.maxBucketLevel, b.level + e.amount)
      return done(
        t.buckets.length === 1
          ? `TOK_${String(t.buckets[0]!.id).padStart(2, '0')} → L${t.buckets[0]!.level}`
          : `+${e.amount} level to ${t.buckets.length} output tokens`,
        true,
      )
    }

    case 'bucket-transform': {
      if (t.buckets.length === 0) return fail('no token can take that')
      for (const b of t.buckets) b.transform = e.transform
      return done(`TOK_${String(t.buckets[0]!.id).padStart(2, '0')} → ${e.transform}`, true)
    }

    case 'card-level': {
      if (t.cards.length === 0) return fail('every card is maxed')
      for (const c of t.cards) c.level = Math.min(DECK.maxLevel, c.level + e.amount)
      return done(
        t.cards.length === 1
          ? `card #${t.cards[0]!.id} → L${t.cards[0]!.level}`
          : `+${e.amount} level to ${t.cards.length} cards`,
        false,
      )
    }

    case 'card-transform': {
      if (t.cards.length === 0) return fail('no card can take that')
      for (const c of t.cards) c.transforms.push(e.transform)
      return done(`card #${t.cards[0]!.id} → ${e.transform}`, false)
    }

    case 'card-add': {
      for (let i = 0; i < e.count; i++) run.deck.add(e.cardType)
      return done(`+${e.count} ${e.cardType}`, false)
    }

    case 'card-remove': {
      const card = t.cards[0]
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

/**
 * The rng a purchase will use. Preview and purchase must derive the SAME
 * stream or the highlight is a lie — so there is exactly one place that
 * decides it.
 */
export function purchaseRng(run: RunState): Rng {
  return deriveRng(run.seed, 'buy', run.benchmarkIndex, run.totals.itemsBought)
}

export function rerollPrice(rerolls: number): number {
  return SHOP.rerollBase + rerolls * SHOP.rerollStep
}
