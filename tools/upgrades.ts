/**
 * tools/upgrades.ts — marginal value audit for the upgrade catalogue.
 *
 * `balance.ts` claims every upgrade should be worth roughly +40% effective
 * power, because stage targets grow 1.4x across 7 picks. That claim was never
 * measured — this measures it.
 *
 * For each upgrade (and each stack of it) we simulate N passes on real boards
 * with and without it applied, and report the delta in median pass score. An
 * upgrade well under the bar is a trap pick; one well over trivialises the run.
 *
 *   npm run upgrades
 *   npm run upgrades -- 10     # 10 boards per measurement (slower, tighter)
 */

import { ECONOMY, LAUNCH, ORB, PHYSICS, TEMPERATURES, VALIDATOR } from '../src/config/balance'
import { baseMods, UPGRADES, type Mods, type Upgrade } from '../src/config/upgrades'
import { deriveRng, type Rng } from '../src/core/rng'
import { boardRngFor, fallbackBoard, generateCandidate } from '../src/sim/boardgen'
import { probeBoard } from '../src/sim/validator'
import { initPhysics, makeStepEvents, PhysicsWorld } from '../src/sim/physics'
import { Pass, scoreLanding, scorePin, type ScoringContext } from '../src/sim/scoring'
import type { Board } from '../src/sim/board'

const BOARDS = Number(process.argv[2] ?? 6)
const PASSES_PER_BOARD = 30
/** Measure at Balanced: the most activation-efficient tier, so the baseline. */
const TEMP_INDEX = 1

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

function buildBoard(seed: string, stage: number, mods: Mods): Board {
  for (let attempt = 0; attempt < VALIDATOR.maxAttempts; attempt++) {
    const board = generateCandidate(boardRngFor(seed, stage, attempt), `${seed}/s${stage}`)
    if (mods.pruneFraction > 0) {
      const rng = deriveRng(seed, 'prune', stage, attempt)
      const ord = board.pins.filter((p) => !p.critical && !p.removed)
      for (const pin of rng.sample(ord, Math.floor(ord.length * mods.pruneFraction))) pin.removed = true
    }
    const stats = probeBoard(board, seed, stage, attempt)
    board.stats = stats
    if (stats.accepted) return board
  }
  return fallbackBoard(seed)
}

function runPass(world: PhysicsWorld, board: Board, mods: Mods, angle: number, charge: number, rng: Rng): number {
  const tier = TEMPERATURES[TEMP_INDEX]!
  const events = makeStepEvents()
  const pass = new Pass()
  const ctx: ScoringContext = { mods, tempScoreMult: tier.scoreMult, tempValue: tier.value, rng }

  world.loadBoard(board)
  const speed = LAUNCH.minSpeed + (LAUNCH.maxSpeed - LAUNCH.minSpeed) * charge
  const count = Math.max(1, Math.min(mods.orbsPerLaunch, LAUNCH.maxOrbsHardCap))
  for (let i = 0; i < count; i++) {
    const off = count === 1 ? 0 : (i - (count - 1) / 2) * LAUNCH.multiOrbSpread
    const a = Math.max(-LAUNCH.maxAngle, Math.min(LAUNCH.maxAngle, angle + off))
    world.spawnOrb(Math.sin(a) * 0.45, LAUNCH.originY - 0.5, Math.sin(a) * speed, -Math.cos(a) * speed, {
      restitution: ORB.restitution * tier.bounce,
      launchId: 0,
      scoreScale: mods.orbScoreMult,
    })
  }

  const maxSteps = Math.ceil((ORB.maxLifetime + 2) / PHYSICS.dt)
  for (let s = 0; s < maxSteps && world.orbCount > 0; s++) {
    world.stepOnce(events)
    for (const h of events.pinHits) scorePin(pass, h.pin, h.orb, ctx)
    for (const l of events.landings) scoreLanding(pass, l.pocket, l.orb, ctx)
  }
  world.despawnAllOrbs()
  return pass.score
}

/** Median pass score for a given mods configuration, over fixed boards/inputs. */
function measure(world: PhysicsWorld, mods: Mods, label: string): number {
  const scores: number[] = []
  for (let b = 0; b < BOARDS; b++) {
    const seed = `UPG-${b}`
    const board = buildBoard(seed, 1, mods)
    // Same input stream for every configuration, so differences are the
    // upgrade and not the aim.
    const rng = deriveRng('FIXED-INPUT', b)
    const scoreRng = deriveRng(label, b)
    for (let k = 0; k < PASSES_PER_BOARD; k++) {
      const angle = rng.range(-LAUNCH.maxAngle, LAUNCH.maxAngle)
      const charge = rng.range(0.5, 1.0)
      scores.push(runPass(world, board, mods, angle, charge, scoreRng))
    }
  }
  return median(scores)
}

async function main(): Promise<void> {
  await initPhysics()
  const world = new PhysicsWorld()

  const base = baseMods(ECONOMY.startingMaxPool)
  const baseline = measure(world, base, 'baseline')

  console.log('='.repeat(84))
  console.log('rogue/acc — upgrade marginal value audit')
  console.log(`boards=${BOARDS}  passes/board=${PASSES_PER_BOARD}  tier=Balanced  baseline median=${baseline}`)
  console.log('target: each pick worth about +40% (stage targets grow 1.4x over 7 picks)')
  console.log('='.repeat(84))
  console.log('\nupgrade                      stack  median   vs base   marginal   verdict')

  for (const up of UPGRADES) {
    const mods = baseMods(ECONOMY.startingMaxPool)
    let prev = baseline
    for (let stack = 1; stack <= up.maxStacks; stack++) {
      up.apply(mods)
      const score = measure(world, mods, `${up.id}-${stack}`)
      const vsBase = (score / baseline - 1) * 100
      const marginal = (score / prev - 1) * 100
      const verdict =
        marginal < 8 ? 'TRAP' : marginal < 22 ? 'weak' : marginal > 70 ? 'STRONG' : 'ok'
      console.log(
        `  ${up.name.padEnd(26)} ${String(stack).padStart(3)}  ${String(score).padStart(6)}  ` +
        `${(vsBase >= 0 ? '+' : '') + vsBase.toFixed(0).padStart(5)}%  ` +
        `${(marginal >= 0 ? '+' : '') + marginal.toFixed(0).padStart(7)}%   ${verdict}`,
      )
      prev = score
    }
  }

  console.log('\n' + '='.repeat(84))
  console.log('Caveats: measured at Balanced with random aim, so upgrades that reward')
  console.log('AIM (Benchmark Overfit, Attention Mask) or HOT play (Hallucination Engine,')
  console.log('Temperature Spike) are systematically under-reported here. Economy picks')
  console.log('(Context Extension, Speculative Decoding) buy passes, not pass score, and')
  console.log('read as 0% by construction — judge those on the full-run sweep instead.')
  console.log('='.repeat(84))
  world.dispose()
}

void main()
