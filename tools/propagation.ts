/**
 * tools/propagation.ts — retention sweep for the forward pass.
 *
 * Propagation is the most dangerous number in v2. It is multiplicative across
 * a fan-out of two to three, so retention slightly too high turns every ball
 * contact into a board-wide flood and the score curve detonates; slightly too
 * low and the edges are decorative after all.
 *
 * This runs real boards through real physics and real scoring at a range of
 * retention values and reports what each one actually produces. Pick the
 * number from this table, not from intuition.
 *
 *   npm run propagation
 *   npm run propagation -- 8     # boards per setting
 */

import { ECONOMY, LAUNCH, ORB, PHYSICS, SIGNAL, VALIDATOR } from '../src/config/balance'
import { benchmarkAt } from '../src/config/rounds'
import { baseMods, type Mods } from '../src/config/mods'
import { deriveRng, type Rng } from '../src/core/rng'
import { boardRngFor, generateBoard } from '../src/sim/boardgen'
import { probeBoard } from '../src/sim/validator'
import { initPhysics, makeStepEvents, PhysicsWorld } from '../src/sim/physics'
import {
  computeLayerBonus, Pass, scoreLanding, scorePin, type ScoringContext,
} from '../src/sim/scoring'
import { buildSignalGraph, makeSignalResult, propagate } from '../src/sim/propagation'
import { isAttentionHead, type Board } from '../src/sim/board'

const BOARDS = Number(process.argv[2] ?? 6)
const TARGET = benchmarkAt(0).target
const PASSES = 26

/** SIGNAL is `as const`; the sweep needs to write to it. */
const TUNABLE = SIGNAL as unknown as { retention: number; floor: number }

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

function buildBoard(seed: string): Board {
  for (let a = 0; a < VALIDATOR.maxAttempts; a++) {
    const b = generateBoard(boardRngFor(seed, a), `${seed}/a${a}`)
    const stats = probeBoard(b, seed, a)
    b.stats = stats
    if (stats.accepted) return b
  }
  const last = generateBoard(boardRngFor(seed, 0), `${seed}/fb`)
  last.stats = { ...probeBoard(last, seed, 0), fallback: true, accepted: true }
  return last
}

interface PassStats {
  score: number
  contacts: number
  signalled: number
}

function runPass(
  world: PhysicsWorld, board: Board, mods: Mods, angle: number, charge: number, rng: Rng,
): PassStats {
  const events = makeStepEvents()
  const pass = new Pass()
  const graph = buildSignalGraph(board)
  const sig = makeSignalResult()
  const ctx: ScoringContext = {
    mods, tempScoreMult: 1, tempValue: 0, rng,
    layerBonus: computeLayerBonus(board),
  }

  world.loadBoard(board)
  const speed = LAUNCH.minSpeed + (LAUNCH.maxSpeed - LAUNCH.minSpeed) * charge
  world.spawnOrb(
    Math.sin(angle) * 0.45, LAUNCH.originY - 0.5,
    Math.sin(angle) * speed, -Math.cos(angle) * speed,
    { restitution: ORB.restitution, launchId: 0, scoreScale: 1 },
  )

  let contacts = 0
  let signalled = 0
  const maxSteps = Math.ceil((ORB.maxLifetime + 2) / PHYSICS.dt)
  for (let s = 0; s < maxSteps && world.orbCount > 0; s++) {
    world.stepOnce(events)
    for (const h of events.pinHits) {
      const ev = scorePin(pass, h.pin, h.orb, ctx)
      if (!ev) continue
      contacts++
      propagate(graph, pass, h.pin, ctx, sig)
      signalled += sig.reached
    }
    for (const l of events.landings) scoreLanding(pass, l.pocket, l.orb, ctx)
    if (pass.ended) break
  }
  world.despawnAllOrbs()
  return { score: pass.score, contacts, signalled }
}

async function main(): Promise<void> {
  await initPhysics()
  const world = new PhysicsWorld()
  const mods = baseMods(ECONOMY.startingMaxPool)
  const boards = Array.from({ length: BOARDS }, (_, i) => buildBoard(`PROP-${i}`))

  console.log('='.repeat(84))
  console.log('rogue/acc — propagation retention sweep')
  console.log(`boards=${BOARDS}  passes/board=${PASSES}  floor=${SIGNAL.floor}  stage-1 target=${TARGET}`)
  console.log('='.repeat(84))
  console.log('\nretention  contacts  signalled  total lit  score p50   score p90   passes to clear')
  console.log('-'.repeat(84))

  const original = TUNABLE.retention
  for (const retention of [0, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) {
    TUNABLE.retention = retention
    const scores: number[] = []
    const contacts: number[] = []
    const signalled: number[] = []

    for (let b = 0; b < boards.length; b++) {
      const rng = deriveRng('SWEEP-INPUT', b)
      const roll = deriveRng('SWEEP-ROLL', b)
      for (let k = 0; k < PASSES; k++) {
        const r = runPass(
          world, boards[b]!, mods,
          rng.range(-LAUNCH.maxAngle, LAUNCH.maxAngle),
          rng.range(0.5, 1.0),
          roll,
        )
        scores.push(r.score)
        contacts.push(r.contacts)
        signalled.push(r.signalled)
      }
    }

    const p50 = median(scores)
    const p90 = scores.slice().sort((a, b) => a - b)[Math.floor(scores.length * 0.9)] ?? 0
    const toClear = p50 > 0 ? benchmarkAt(0).target / p50 : Infinity
    const flag =
      retention === 0 ? '   (edges off — baseline)'
      : toClear < 4 ? '   <- too strong'
      : toClear > 14 ? '   <- too weak'
      : '   <- usable'

    console.log(
      `   ${retention.toFixed(2)}     ${mean(contacts).toFixed(1).padStart(5)}     ` +
      `${mean(signalled).toFixed(1).padStart(6)}     ` +
      `${(mean(contacts) + mean(signalled)).toFixed(1).padStart(6)}    ` +
      `${String(Math.round(p50)).padStart(7)}     ${String(Math.round(p90)).padStart(7)}    ` +
      `${toClear.toFixed(1).padStart(5)}${flag}`,
    )
  }
  TUNABLE.retention = original

  console.log('\n' + '='.repeat(84))
  console.log('Target: ~8 passes to clear stage 1 at the unskilled baseline, which is what')
  console.log('the clear refund is sized against. "total lit" is nodes scored per pass —')
  console.log(`the board has ${boards[0]!.nodes.length} nodes, so anything near that is a flood.`)
  console.log('='.repeat(84))

  const heads = boards.map((b) => b.nodes.filter((n) => isAttentionHead(n)).length)
  console.log(`\nattention heads per board: ${heads.join(', ')}`)
  world.dispose()
}

void main()
