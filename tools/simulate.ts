/**
 * tools/simulate.ts — v2 full-run harness.
 *
 * Plays complete runs headlessly: real board, real physics, real propagation,
 * real scoring, real shop. Twenty-four benchmarks is far too long a curve to
 * tune by playing, and the interest-bearing economy compounds, so the only
 * honest way to size the numbers is to run a few hundred benchmarks.
 *
 *   npm run sim
 *   npm run sim -- 40
 *
 * The bot is deliberately UNSKILLED: it aims uniformly at random. A random-aim
 * bot clearing most runs would mean the game has no skill ceiling.
 */

import { DECK, ECONOMY, LAUNCH, ORB, PHYSICS, VALIDATOR } from '../src/config/balance'
import { benchmarkAt, bossFor, totalBenchmarks } from '../src/config/rounds'
import type { Mods } from '../src/config/mods'
import { deriveRng, type Rng } from '../src/core/rng'
import { RunState } from '../src/core/state'
import { applyPurchase, rollStock } from '../src/core/shopkeeper'
import { boardRngFor, generateBoard } from '../src/sim/boardgen'
import { probeBoard } from '../src/sim/validator'
import { initPhysics, makeStepEvents, PhysicsWorld } from '../src/sim/physics'
import {
  computeLayerBonus, Pass, scoreLanding, scorePin, type ScoringContext,
} from '../src/sim/scoring'
import { buildSignalGraph, makeSignalResult, propagate } from '../src/sim/propagation'
import { resolveCriticalStrike } from '../src/sim/effects'
import { isAttentionHead, type Board, type NodeDef } from '../src/sim/board'
import { CARD_TYPES, cardValue } from '../src/sim/deck'

const RUNS = Number(process.argv[2] ?? 24)

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))]!
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const median = (xs: number[]) => pct(xs, 0.5)

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

interface PassOut { score: number; money: number; contacts: number; signalled: number }

function runPass(
  world: PhysicsWorld, board: Board, run: RunState, mods: Mods,
  angle: number, charge: number, rng: Rng, deadLayers: number,
): PassOut {
  const card = run.deck.draw(rng)
  if (!card) return { score: 0, money: 0, contacts: 0, signalled: 0 }
  const def = CARD_TYPES[card.type]

  const events = makeStepEvents()
  const pass = new Pass()
  const graph = buildSignalGraph(board)
  const sig = makeSignalResult()
  const ctx: ScoringContext = {
    mods, tempScoreMult: 1, tempValue: 0, rng,
    layerBonus: computeLayerBonus(board),
  }

  let scale = cardValue(card) * mods.orbScoreMult
  if (def.volatile) scale *= rng.range(def.volatile[0], def.volatile[1])
  const dud = card.transforms.includes('poisoned') && rng.next() < DECK.poisonedDudChance

  world.loadBoard(board)
  const speed = (LAUNCH.minSpeed + (LAUNCH.maxSpeed - LAUNCH.minSpeed) * charge) * def.speed
  const count = Math.max(1, Math.min(mods.orbsPerLaunch, LAUNCH.maxOrbsHardCap))
  for (let i = 0; i < count; i++) {
    const off = count === 1 ? 0 : (i - (count - 1) / 2) * LAUNCH.multiOrbSpread
    const a = Math.max(-LAUNCH.maxAngle, Math.min(LAUNCH.maxAngle, angle + off))
    world.spawnOrb(
      Math.sin(a) * 0.45, LAUNCH.originY - 0.5,
      Math.sin(a) * speed, -Math.cos(a) * speed,
      { restitution: ORB.restitution * def.bounce, launchId: 0, scoreScale: scale },
    )
  }

  const inert = (n: NodeDef) => deadLayers > 0 && n.layer >= board.layers - deadLayers
  const detonated: NodeDef[] = []
  let contacts = 0
  let signalled = 0

  const maxSteps = Math.ceil((ORB.maxLifetime + 2) / PHYSICS.dt)
  for (let s = 0; s < maxSteps && world.orbCount > 0; s++) {
    world.stepOnce(events)
    for (const h of events.pinHits) {
      if (inert(h.pin)) continue
      const ev = scorePin(pass, h.pin, h.orb, ctx)
      if (!ev) continue
      contacts++
      if (isAttentionHead(h.pin)) {
        const o = resolveCriticalStrike(world, pass, h.pin, h.orb, ctx, mods, ORB.restitution * def.bounce)
        for (const d of o.detonated) detonated.push(d.pin)
      }
      propagate(graph, pass, h.pin, ctx, sig)
      signalled += sig.reached
    }
    for (const l of events.landings) scoreLanding(pass, l.pocket, l.orb, ctx)
    if (pass.ended) break
  }
  world.despawnAllOrbs()
  for (const p of detonated) p.removed = false

  return {
    score: dud ? 0 : pass.score,
    money: pass.money,
    contacts,
    signalled,
  }
}

/** A plain shopping policy: buy the cheapest useful thing, keep a reserve. */
function shop(run: RunState, board: Board, rng: Rng): void {
  for (let visit = 0; visit < 4; visit++) {
    const stock = rollStock(run, board, rng)
    // Keep $5 back so interest keeps paying — the bot is not clever, but
    // ignoring interest entirely would misrepresent the economy.
    const reserve = run.money > 12 ? 5 : 0
    const affordable = stock
      .filter((o) => o.price <= run.money - reserve)
      .sort((a, b) => a.price - b.price)
    if (affordable.length === 0) break
    const offer = affordable[affordable.length - 1]!
    if (offer.def.precision === 'banded') offer.band = rng.pick(['upper', 'middle', 'lower'] as const)
    if (offer.def.precision === 'precise') {
      // Bot targets randomly even when it paid for precision. Real players
      // do better, which is part of why the unskilled baseline is a floor.
      const e = offer.def.effect
      if (e.kind === 'node-level' || e.kind === 'node-transform') {
        const pool = board.nodes.filter((n) => !n.removed)
        offer.target = { kind: 'node', id: rng.pick(pool).id }
      } else if (e.kind === 'bucket-level' || e.kind === 'bucket-transform') {
        offer.target = { kind: 'bucket', id: rng.pick(board.pockets).id }
      } else if (run.deck.cards.length > 0) {
        offer.target = { kind: 'card', id: rng.pick(run.deck.cards).id }
      }
    }
    const result = applyPurchase(offer, run, board, rng)
    if (result.ok) run.pay(offer.price, offer.def.id)
    else break
  }
}

async function main(): Promise<void> {
  await initPhysics()
  const world = new PhysicsWorld()

  console.log('='.repeat(82))
  console.log('rogue/acc v2 — full run sweep')
  console.log(`runs=${RUNS}  benchmarks=${totalBenchmarks()}  base=${benchmarkAt(0).target}  final=${benchmarkAt(23).target}`)
  console.log('='.repeat(82))

  const reached: number[] = []
  const passesPer: number[] = []
  const moneyEnd: number[] = []
  const deckEnd: number[] = []
  const bought: number[] = []
  let wins = 0
  const perBenchmarkPasses = new Map<number, number[]>()

  for (let r = 0; r < RUNS; r++) {
    const seed = `V2-${r}`
    const run = new RunState(seed)
    const board = buildBoard(seed)
    let alive = true

    while (alive && run.benchmarkIndex < totalBenchmarks()) {
      const bm = benchmarkAt(run.benchmarkIndex)
      const boss = bossFor(bm)
      const rng = deriveRng(seed, 'play', run.benchmarkIndex)
      run.beginBenchmark(rng)
      let passes = 0

      while (run.canFire) {
        run.spend()
        passes++
        const out = runPass(
          world, board, run, run.mods,
          rng.range(-LAUNCH.maxAngle, LAUNCH.maxAngle),
          rng.range(0.5, 1.0), rng, boss?.deadLayers ?? 0,
        )
        run.commitPass(out.score, out.money)
        if (run.targetMet) break
      }

      const list = perBenchmarkPasses.get(run.benchmarkIndex) ?? []
      list.push(passes)
      perBenchmarkPasses.set(run.benchmarkIndex, list)
      passesPer.push(passes)

      if (!run.targetMet) { alive = false; break }
      run.applyClearRewards()
      if (run.benchmarkIndex >= totalBenchmarks() - 1) { wins++; break }
      shop(run, board, deriveRng(seed, 'shop', run.benchmarkIndex))
      run.advanceBenchmark()
    }

    reached.push(run.benchmarkIndex + (alive ? 1 : 0))
    moneyEnd.push(run.money)
    deckEnd.push(run.deck.size)
    bought.push(run.totals.itemsBought)
  }

  console.log('\n[1] HOW FAR RUNS GET')
  const buckets = new Map<number, number>()
  for (const r of reached) {
    const round = Math.min(8, Math.floor((r - 1) / 3) + 1)
    buckets.set(round, (buckets.get(round) ?? 0) + 1)
  }
  const ROUND_NAMES = ['Pre-Seed','Seed','Series A','Series B','Series C','Series D','Series E','IPO']
  for (let i = 1; i <= 8; i++) {
    const c = buckets.get(i) ?? 0
    console.log(`  ${ROUND_NAMES[i-1]!.padEnd(9)} ${String(c).padStart(3)}  ${'█'.repeat(c)}`)
  }
  console.log(`\n  win rate (IPO)      ${((wins / RUNS) * 100).toFixed(1)}%  (unskilled baseline)`)
  console.log(`  median benchmark    ${median(reached)} of ${totalBenchmarks()}`)

  console.log('\n[2] PACE — passes per benchmark (target ~6-8)')
  console.log('  bench  round      target     passes p50   n')
  for (let i = 0; i < totalBenchmarks(); i++) {
    const list = perBenchmarkPasses.get(i)
    if (!list || list.length < 2) continue
    const bm = benchmarkAt(i)
    console.log(
      `   ${String(i).padStart(2)}    ${bm.roundName.padEnd(9)} ${String(bm.target).padStart(9)}` +
      `        ${String(median(list)).padStart(3)}      ${list.length}`,
    )
  }

  console.log('\n[3] ECONOMY')
  console.log(`  items bought        mean ${mean(bought).toFixed(1)}   p90 ${pct(bought, 0.9)}`)
  console.log(`  capital at end      p50 $${median(moneyEnd)}   p90 $${pct(moneyEnd, 0.9)}`)
  console.log(`  deck size at end    p50 ${median(deckEnd)}   p90 ${pct(deckEnd, 0.9)}`)
  console.log(`  passes per bench    p50 ${median(passesPer)}   p90 ${pct(passesPer, 0.9)}`)
  console.log(`  starting capital    $${ECONOMY.startingMoney}`)

  console.log('\n' + '='.repeat(82))
  console.log('Read it as: the unskilled win rate should be LOW but non-zero, and passes')
  console.log('per benchmark should sit near 6-8 ACROSS the curve, not just at the start.')
  console.log('A pace that drifts means target growth and upgrade power are mismatched.')
  console.log('='.repeat(82))
  world.dispose()
}

void main()
