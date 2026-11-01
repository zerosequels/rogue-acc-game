/**
 * tools/upgrades.ts — shop item marginal-value audit.
 *
 * Every purchase has to move total power by roughly the same factor the
 * benchmark curve grows by, divided across the purchases a player can afford
 * per benchmark. This applies each shop item to a fresh board and measures
 * what it actually did to a median pass.
 *
 *   npm run upgrades
 *   npm run upgrades -- 8
 *
 * v1's version audited a hand-written upgrade list. The shop replaced that
 * list, and this tool was briefly left measuring code the game no longer ran —
 * which is exactly why `tools/` is now inside `tsconfig.json`.
 */

import { ECONOMY, LAUNCH, ORB, PHYSICS, VALIDATOR } from '../src/config/balance'
import { benchmarkAt } from '../src/config/rounds'
import { priceOf, SHOP_ITEMS, type ShopItemDef } from '../src/config/shop'
import { deriveRng, type Rng } from '../src/core/rng'
import { RunState } from '../src/core/state'
import { applyPurchase, type Offer } from '../src/core/shopkeeper'
import { boardRngFor, generateBoard } from '../src/sim/boardgen'
import { probeBoard } from '../src/sim/validator'
import { initPhysics, makeStepEvents, PhysicsWorld } from '../src/sim/physics'
import {
  computeLayerBonus, Pass, scoreLanding, scorePin, type ScoringContext,
} from '../src/sim/scoring'
import { buildSignalGraph, makeSignalResult, propagate } from '../src/sim/propagation'
import { resolveCriticalStrike } from '../src/sim/effects'
import { isAttentionHead, type Board } from '../src/sim/board'
import { CARD_TYPES, cardValue } from '../src/sim/deck'

const BOARDS = Number(process.argv[2] ?? 5)

/**
 * Items this harness structurally cannot measure, and why. They are not
 * traps — the measurement is a median single pass with a fixed card, which
 * is blind to each of these. Judge them on `npm run sim`.
 */
const UNMEASURABLE: Record<string, string> = {
  distil: 'pays off by being DRAWN more often; one fixed-card pass cannot see it',
  'top-k-sampling': 'needs 15+ contacts in a pass; the random-aim bot averages 10',
  'moe-router': 'wakes only when its layer is busy; random aim rarely loads one layer',
  'beam-search': 'returns the token — the gain is an extra pass, not a bigger one',
  'kv-cache': 'pays out on the FOLLOWING pass',
  'checkpoint-save': 'pays out on the FOLLOWING pass',
  'revenue-share': 'pays money, not score',
  poison: 'triple value against a 1-in-5 total loss; variance, not mean',
  'dedup-pass': 'extends signal only on passes that draw that one card',
  'tokeniser-fix': 'splits only on passes that draw that one card',
  curate: 'removes the floor; changes the low tail, not the median',
  'web-scale': 'tier weighting only shows across a long pass',
  epoch: 'spreads across 6 random cards; the fixed-card pass may miss all of them',
}
const PASSES = 24

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function buildBoard(seed: string): Board {
  for (let a = 0; a < VALIDATOR.maxAttempts; a++) {
    const b = generateBoard(boardRngFor(seed, a), `${seed}/a${a}`)
    b.stats = probeBoard(b, seed, a)
    if (b.stats.accepted) return b
  }
  const last = generateBoard(boardRngFor(seed, 0), `${seed}/fb`)
  last.stats = { ...probeBoard(last, seed, 0), fallback: true, accepted: true }
  return last
}

function runPass(
  world: PhysicsWorld, board: Board, run: RunState,
  angle: number, charge: number, rng: Rng,
): number {
  const card = run.deck.cards[0]
  if (!card) return 0
  const def = CARD_TYPES[card.type]
  const mods = run.mods
  const events = makeStepEvents()
  const pass = new Pass()
  const graph = buildSignalGraph(board)
  const sig = makeSignalResult()
  const ctx: ScoringContext = {
    mods, tempScoreMult: 1, tempValue: 0, rng, layerBonus: computeLayerBonus(board),
  }

  world.loadBoard(board)
  const speed = (LAUNCH.minSpeed + (LAUNCH.maxSpeed - LAUNCH.minSpeed) * charge) * def.speed
  world.spawnOrb(
    Math.sin(angle) * 0.45, LAUNCH.originY - 0.5,
    Math.sin(angle) * speed, -Math.cos(angle) * speed,
    { restitution: ORB.restitution * def.bounce, launchId: 0, scoreScale: cardValue(card) },
  )

  const detonated: { removed: boolean }[] = []
  const maxSteps = Math.ceil((ORB.maxLifetime + 2) / PHYSICS.dt)
  for (let s = 0; s < maxSteps && world.orbCount > 0; s++) {
    world.stepOnce(events)
    for (const h of events.pinHits) {
      const ev = scorePin(pass, h.pin, h.orb, ctx)
      if (!ev) continue
      if (isAttentionHead(h.pin)) {
        const o = resolveCriticalStrike(world, pass, h.pin, h.orb, ctx, mods, ORB.restitution)
        for (const d of o.detonated) detonated.push(d.pin)
      }
      propagate(graph, pass, h.pin, ctx, sig)
    }
    for (const l of events.landings) scoreLanding(pass, l.pocket, l.orb, ctx)
    if (pass.ended) break
  }
  world.despawnAllOrbs()
  for (const p of detonated) p.removed = false
  return pass.score
}

/** Median pass score for a (run, board) pair, over fixed boards and inputs. */
function measure(world: PhysicsWorld, make: () => { run: RunState; board: Board }, tag: string): number {
  const scores: number[] = []
  for (let b = 0; b < BOARDS; b++) {
    const { run, board } = make()
    const input = deriveRng('FIXED-INPUT', b)
    const roll = deriveRng(tag, b)
    for (let k = 0; k < PASSES; k++) {
      scores.push(runPass(
        world, board, run,
        input.range(-LAUNCH.maxAngle, LAUNCH.maxAngle),
        input.range(0.5, 1.0), roll,
      ))
    }
  }
  return median(scores)
}

async function main(): Promise<void> {
  await initPhysics()
  const world = new PhysicsWorld()
  let boardIdx = 0

  const fresh = () => {
    const seed = `SHOP-${boardIdx++ % BOARDS}`
    return { run: new RunState(seed), board: buildBoard(seed) }
  }

  boardIdx = 0
  const baseline = measure(world, fresh, 'baseline')

  console.log('='.repeat(86))
  console.log('rogue/acc v2 — shop item marginal value')
  console.log(`boards=${BOARDS}  passes/board=${PASSES}  baseline median pass=${baseline}`)
  console.log(`benchmark 0 target=${benchmarkAt(0).target}  growth=${(benchmarkAt(1).target / benchmarkAt(0).target).toFixed(2)}x`)
  console.log('='.repeat(86))
  console.log('\nitem                        prec      $   median   vs base   $ per 10%')

  const rows: { def: ShopItemDef; gain: number; price: number }[] = []

  for (const def of SHOP_ITEMS) {
    // Only score-affecting purchases are measurable here; economy items are
    // judged on the full-run sweep, where buying passes is what they do.
    if (def.effect.kind === 'activations' || def.effect.kind === 'card-add' || def.effect.kind === 'card-remove') continue

    boardIdx = 0
    const score = measure(world, () => {
      const { run, board } = fresh()
      const offer: Offer = { def, price: priceOf(def), sold: false }
      if (def.precision === 'banded') offer.band = 'middle'
      if (def.precision === 'precise') {
        const e = def.effect
        if (e.kind === 'node-level' || e.kind === 'node-transform') {
          const pool = board.nodes.filter((n) => !n.removed && n.layer > 0 && n.layer < board.layers - 1)
          if (pool.length) offer.target = { kind: 'node', id: pool[Math.floor(pool.length / 2)]!.id }
        } else if (e.kind === 'bucket-level' || e.kind === 'bucket-transform') {
          const pool = board.pockets.filter((p) => p.kind !== 'drain')
          if (pool.length) offer.target = { kind: 'bucket', id: pool[0]!.id }
        } else if (run.deck.cards.length) {
          offer.target = { kind: 'card', id: run.deck.cards[0]!.id }
        }
      }
      applyPurchase(offer, run, board, deriveRng('apply', def.id))
      return { run, board }
    }, def.id)

    const gain = (score / baseline - 1) * 100
    const price = priceOf(def)
    rows.push({ def, gain, price })
    const note = UNMEASURABLE[def.id]
    const perTen = note ? 'n/a' : gain > 0.5 ? (price / (gain / 10)).toFixed(1) : '—'
    console.log(
      `  ${def.name.padEnd(26)} ${def.precision.padEnd(8)} ${String(price).padStart(2)}  ` +
      `${String(Math.round(score)).padStart(6)}  ${((gain >= 0 ? '+' : '') + gain.toFixed(0)).padStart(7)}%   ${perTen.padStart(8)}` +
      (note ? `   ${note}` : ''),
    )
  }

  console.log('\n' + '='.repeat(86))
  console.log('"$ per 10%" is the real comparison: an item is priced well when it costs')
  console.log('about the same per unit of power as its neighbours. A conspicuously cheap')
  console.log('row is an auto-buy; a conspicuously dear one is never worth taking.')
  console.log('Negative rows are traps and must be fixed, not left as "a risky option".')
  console.log('='.repeat(86))

  const traps = rows.filter((r) => r.gain < -2 && !UNMEASURABLE[r.def.id])
  if (traps.length) {
    console.log('\nTRAPS:')
    for (const t of traps) console.log(`  ${t.def.name}  ${t.gain.toFixed(0)}%`)
  }
  console.log(`\nstarting capital $${ECONOMY.startingMoney}`)
  world.dispose()
}

void main()
