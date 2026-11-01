/**
 * tools/simulate.ts — headless balance harness.
 *
 * The acceptance criteria for this game are things like "cascades feel
 * energetic" and "boards remain mostly playable", which cannot be eyeballed
 * reliably. This runs the real generator, the real validator, the real physics
 * and the real scoring code with no renderer attached, and reports the
 * distributions that actually decide whether the numbers in `balance.ts` work.
 *
 *   npm run sim              -- default sweep
 *   npm run sim -- 40        -- 40 seeds
 *
 * The sim layer imports nothing from Three.js or the DOM, which is what makes
 * this possible. Keep it that way.
 */

import { ECONOMY, LAUNCH, ORB, PHYSICS, SCORE, stageTarget, STAGES, TEMPERATURES, VALIDATOR } from '../src/config/balance'
import { baseMods, rollOffers, type Mods } from '../src/config/upgrades'
import { deriveRng, mintSeed, Rng } from '../src/core/rng'
import { boardRngFor, fallbackBoard, generateCandidate } from '../src/sim/boardgen'
import { probeBoard } from '../src/sim/validator'
import { initPhysics, makeStepEvents, PhysicsWorld } from '../src/sim/physics'
import { Pass, scoreLanding, scorePin, type ScoringContext } from '../src/sim/scoring'
import { resolveCriticalStrike } from '../src/sim/effects'
import type { Board } from '../src/sim/board'

const SEEDS = Number(process.argv[2] ?? 24)

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))]!
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** Build a validated board exactly the way the game does. */
function buildBoard(seed: string, stage: number, mods: Mods): { board: Board; attempts: number; fellBack: boolean } {
  for (let attempt = 0; attempt < VALIDATOR.maxAttempts; attempt++) {
    const board = generateCandidate(boardRngFor(seed, stage, attempt), `${seed}/s${stage}`)
    if (mods.pruneFraction > 0) {
      const rng = deriveRng(seed, 'prune', stage, attempt)
      const ordinary = board.pins.filter((p) => !p.critical && !p.removed)
      for (const pin of rng.sample(ordinary, Math.floor(ordinary.length * mods.pruneFraction))) {
        pin.removed = true
      }
    }
    const stats = probeBoard(board, seed, stage, attempt)
    board.stats = stats
    if (stats.accepted) return { board, attempts: attempt + 1, fellBack: false }
  }
  return { board: fallbackBoard(seed), attempts: VALIDATOR.maxAttempts, fellBack: true }
}

/**
 * Simulate one forward pass with a given aim/charge/temperature and return the
 * score it produced plus the cascade length. Uses the real scoring path.
 */
const detonated: { removed: boolean }[] = []

function simulatePass(
  world: PhysicsWorld,
  board: Board,
  mods: Mods,
  tempIndex: number,
  angle: number,
  charge: number,
  rng: Rng,
): { score: number; pins: number; spike: boolean; drained: boolean } {
  const tier = TEMPERATURES[tempIndex]!
  const events = makeStepEvents()
  const pass = new Pass()
  const ctx: ScoringContext = {
    mods,
    tempScoreMult: tier.scoreMult,
    tempValue: tier.value,
    rng,
  }

  // Explosive Weights removes pins during a pass; clear that before rebuilding
  // so each measured pass starts from the same board the player would see.
  for (const pin of detonated) pin.removed = false
  detonated.length = 0
  world.loadBoard(board)

  const speed = LAUNCH.minSpeed + (LAUNCH.maxSpeed - LAUNCH.minSpeed) * charge
  const count = Math.max(1, Math.min(mods.orbsPerLaunch, LAUNCH.maxOrbsHardCap))
  for (let i = 0; i < count; i++) {
    const offset = count === 1 ? 0 : (i - (count - 1) / 2) * LAUNCH.multiOrbSpread
    const a = Math.max(-LAUNCH.maxAngle, Math.min(LAUNCH.maxAngle, angle + offset))
    world.spawnOrb(
      Math.sin(a) * 0.45,
      LAUNCH.originY - 0.5,
      Math.sin(a) * speed,
      -Math.cos(a) * speed,
      { restitution: ORB.restitution * tier.bounce, launchId: 0, scoreScale: mods.orbScoreMult },
    )
  }

  let spike = false
  let drained = false
  const maxSteps = Math.ceil((ORB.maxLifetime + 2) / PHYSICS.dt)

  for (let step = 0; step < maxSteps && world.orbCount > 0; step++) {
    world.stepOnce(events)
    for (const hit of events.pinHits) {
      const ev = scorePin(pass, hit.pin, hit.orb, ctx)
      if (ev && hit.pin.critical) {
        const outcome = resolveCriticalStrike(world, pass, hit.pin, hit.orb, ctx, mods, ORB.restitution * tier.bounce)
        for (const d of outcome.detonated) detonated.push(d.pin)
      }
    }
    for (const landing of events.landings) {
      scoreLanding(pass, landing.pocket, landing.orb, ctx)
      if (landing.pocket.kind === 'spike') spike = true
      if (landing.pocket.kind === 'drain') drained = true
    }
  }

  world.despawnAllOrbs()
  return { score: pass.score, pins: pass.struck.size, spike, drained }
}

async function main(): Promise<void> {
  await initPhysics()
  const world = new PhysicsWorld()

  console.log('='.repeat(78))
  console.log('rogue/acc — headless balance sweep')
  console.log(`seeds=${SEEDS}  stages=${STAGES.count}  basePin=${SCORE.basePinValue}  growth=${STAGES.growth}`)
  console.log('='.repeat(78))

  // -----------------------------------------------------------------------
  // 1. Generator + validator health
  // -----------------------------------------------------------------------
  console.log('\n[1] BOARD GENERATION')
  const attemptCounts: number[] = []
  const medians: number[] = []
  const settles: number[] = []
  let fallbacks = 0
  const mods0 = baseMods(ECONOMY.startingMaxPool)

  for (let i = 0; i < SEEDS; i++) {
    const seed = `SWEEP-${i}`
    for (let stage = 1; stage <= 3; stage++) {
      const { board, attempts, fellBack } = buildBoard(seed, stage, mods0)
      attemptCounts.push(attempts)
      if (fellBack) fallbacks++
      else {
        medians.push(board.stats.medianPins)
        settles.push(board.stats.settleRate)
      }
    }
  }
  console.log(`  boards built        ${attemptCounts.length}`)
  console.log(`  attempts  mean ${mean(attemptCounts).toFixed(2)}   p90 ${pct(attemptCounts, 0.9)}   max ${Math.max(...attemptCounts)}`)
  console.log(`  fallbacks used      ${fallbacks}  (${((fallbacks / attemptCounts.length) * 100).toFixed(1)}%)`)
  console.log(`  median cascade      p10 ${pct(medians, 0.1).toFixed(1)}  p50 ${pct(medians, 0.5).toFixed(1)}  p90 ${pct(medians, 0.9).toFixed(1)}`)
  console.log(`  settle rate         p10 ${(pct(settles, 0.1) * 100).toFixed(0)}%  p50 ${(pct(settles, 0.5) * 100).toFixed(0)}%`)

  // -----------------------------------------------------------------------
  // 2. Single-pass score distribution at each temperature, base model
  // -----------------------------------------------------------------------
  console.log('\n[2] PASS SCORE BY TEMPERATURE (base checkpoint, stage 1 boards)')
  console.log('  tier        cost   p10     p50     p90     max    pins(p50)  spike%')
  for (let ti = 0; ti < TEMPERATURES.length; ti++) {
    const tier = TEMPERATURES[ti]!
    const scores: number[] = []
    const pinCounts: number[] = []
    let spikes = 0
    let n = 0
    for (let i = 0; i < Math.min(SEEDS, 12); i++) {
      const seed = `SWEEP-${i}`
      const { board } = buildBoard(seed, 1, mods0)
      const rng = deriveRng(seed, 'sim', ti)
      for (let k = 0; k < 14; k++) {
        const angle = rng.range(-LAUNCH.maxAngle, LAUNCH.maxAngle)
        const charge = rng.range(0.3, 1)
        const r = simulatePass(world, board, mods0, ti, angle, charge, rng)
        scores.push(r.score)
        pinCounts.push(r.pins)
        if (r.spike) spikes++
        n++
      }
    }
    console.log(
      `  ${tier.value.toFixed(1)} ${tier.name.padEnd(9)} ${String(tier.cost).padStart(2)}  ` +
      `${String(pct(scores, 0.1)).padStart(6)}  ${String(pct(scores, 0.5)).padStart(6)}  ` +
      `${String(pct(scores, 0.9)).padStart(6)}  ${String(Math.max(...scores)).padStart(6)}  ` +
      `${String(pct(pinCounts, 0.5)).padStart(7)}    ${((spikes / n) * 100).toFixed(1)}%`,
    )
  }

  // -----------------------------------------------------------------------
  // 3. Full-run simulation with a plausible player policy
  // -----------------------------------------------------------------------
  console.log('\n[3] FULL RUN SIMULATION')
  console.log('  policy: aim uniformly at random, charge 0.55-1.0, pick the hottest')
  console.log('  affordable temperature while >8 activations remain, else cheapest.')
  console.log('  This is a DELIBERATELY UNSKILLED baseline — a real player aims.\n')

  const reached: number[] = []
  const finalScores: number[] = []
  const passesPerStage: number[] = []
  let wins = 0

  for (let i = 0; i < SEEDS; i++) {
    const seed = `RUN-${i}`
    const mods = baseMods(ECONOMY.startingMaxPool)
    let activations = ECONOMY.startingActivations
    let maxPool = ECONOMY.startingMaxPool
    const taken: Record<string, number> = {}
    let stage = 1
    let total = 0

    while (stage <= STAGES.count) {
      const target = stageTarget(stage)
      const { board } = buildBoard(seed, stage, mods)
      const rng = deriveRng(seed, 'play', stage)
      let score = 0
      let passes = 0
      let freeUsed = false

      for (;;) {
        // --- choose temperature ---
        const avail = TEMPERATURES.filter((t) => !t.locked || mods.unlockRogueTemp)
        const costOf = (t: typeof avail[number]) => Math.max(1, t.cost - mods.tempCostReduction)
        let choice = avail[0]!
        if (activations > 8) {
          for (const t of avail) if (costOf(t) <= activations) choice = t
        } else {
          choice = avail.reduce((a, b) => (costOf(a) <= costOf(b) ? a : b))
        }
        const tempIndex = TEMPERATURES.indexOf(choice)
        let cost = costOf(choice)
        if (mods.freeFirstLaunch && !freeUsed) { cost = 0; freeUsed = true }
        if (activations < cost) break

        activations -= cost
        passes++
        const r = simulatePass(
          world, board, mods, tempIndex,
          rng.range(-LAUNCH.maxAngle, LAUNCH.maxAngle),
          rng.range(0.55, 1.0),
          rng,
        )
        score += r.score
        if (score >= target) break
      }

      total += score
      passesPerStage.push(passes)

      if (score < target) break // run failed on this stage

      // --- stage clear: refunds, then an upgrade ---
      activations = Math.min(maxPool, activations + ECONOMY.stageClearRefund)
      if (score / target >= ECONOMY.overshootThreshold) {
        activations = Math.min(maxPool, activations + ECONOMY.overshootBonus)
      }

      const offers = rollOffers(deriveRng(seed, 'upgrades', stage), taken, mods, 3)
      if (offers.length > 0) {
        // Greedy policy: always take the first offer. Not optimal — on purpose.
        const pick = offers[0]!
        pick.apply(mods)
        if (pick.onTake) {
          const bag = { activations, maxPool }
          pick.onTake(bag)
          maxPool = bag.maxPool
          activations = Math.min(bag.activations, bag.maxPool)
        }
        maxPool = mods.poolMax
        activations = Math.min(activations, maxPool)
        taken[pick.id] = (taken[pick.id] ?? 0) + 1
      }

      stage++
    }

    reached.push(Math.min(stage, STAGES.count))
    finalScores.push(total)
    if (stage > STAGES.count) wins++
  }

  const dist = new Map<number, number>()
  for (const r of reached) dist.set(r, (dist.get(r) ?? 0) + 1)
  console.log('  stage reached   count   bar')
  for (let s = 1; s <= STAGES.count; s++) {
    const c = dist.get(s) ?? 0
    console.log(`    ${String(s).padStart(2)}            ${String(c).padStart(4)}   ${'█'.repeat(c)}`)
  }
  console.log(`\n  win rate            ${((wins / SEEDS) * 100).toFixed(1)}%  (unskilled baseline)`)
  console.log(`  median stage        ${pct(reached, 0.5)}`)
  console.log(`  passes per stage    p50 ${pct(passesPerStage, 0.5)}   p90 ${pct(passesPerStage, 0.9)}`)
  console.log(`  total score         p50 ${pct(finalScores, 0.5).toLocaleString()}`)

  console.log('\n' + '='.repeat(78))
  console.log('Read it like this: unskilled win rate should be LOW but non-zero,')
  console.log('and passes-per-stage should sit near 8. A random-aim bot clearing')
  console.log('most runs means the game has no skill ceiling.')
  console.log('='.repeat(78))

  world.dispose()
}

void main()
