/**
 * state.ts — the run model and its phase machine.
 *
 * This file owns the *rules* of a run: what a stage costs, when it is cleared,
 * when the run dies, what an upgrade does to the player. It deliberately knows
 * nothing about Three.js, Rapier, or the DOM, which keeps the rules readable
 * and makes them testable without a browser.
 *
 * Phase flow:
 *
 *   boot -> stage-intro -> aim <-> resolving
 *                           |          |
 *                           |          +-> stage-clear -> upgrade -> stage-intro
 *                           |          +-> run-fail
 *                           +-------------> run-win (after the final stage)
 */

import { ECONOMY, STAGES, stageTarget, TEMPERATURES } from '../config/balance'
import { baseMods, rollOffers, type Mods, type Upgrade } from '../config/upgrades'
import { deriveRng, type Rng } from './rng'
import { benchmarkName } from '../flavor/text'

export type Phase =
  | 'boot'
  | 'stage-intro'
  | 'aim'
  | 'resolving'
  | 'stage-clear'
  | 'upgrade'
  | 'run-fail'
  | 'run-win'

export interface RunTotals {
  passesFired: number
  pinsStruck: number
  criticalsStruck: number
  spikesHit: number
  drains: number
  bestPass: number
  totalScore: number
  activationsSpent: number
}

function emptyTotals(): RunTotals {
  return {
    passesFired: 0,
    pinsStruck: 0,
    criticalsStruck: 0,
    spikesHit: 0,
    drains: 0,
    bestPass: 0,
    totalScore: 0,
    activationsSpent: 0,
  }
}

export class RunState {
  readonly seed: string
  phase: Phase = 'boot'

  stage = 1
  score = 0
  target: number

  activations: number
  maxPool: number

  mods: Mods
  /** upgrade id → stacks taken. */
  taken: Record<string, number> = {}
  /** Ordered list for the end-of-run summary. */
  history: Upgrade[] = []

  /** Offers currently on the upgrade screen. */
  offers: Upgrade[] = []

  /** Mid-air redirects left this stage. */
  overridesLeft = 0
  /** Whether the free first pass of the stage has been consumed. */
  freePassUsed = false

  totals: RunTotals = emptyTotals()

  constructor(seed: string) {
    this.seed = seed
    this.maxPool = ECONOMY.startingMaxPool
    this.activations = ECONOMY.startingActivations
    this.mods = baseMods(ECONOMY.startingMaxPool)
    this.target = stageTarget(1)
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  get benchmark(): string {
    return benchmarkName(this.stage)
  }

  get progress(): number {
    return this.target <= 0 ? 1 : Math.min(1, this.score / this.target)
  }

  get targetMet(): boolean {
    return this.score >= this.target
  }

  get isFinalStage(): boolean {
    return this.stage >= STAGES.count
  }

  /** A seeded stream for flavour choices, so a run always tells one story. */
  flavorRng(label: string): Rng {
    return deriveRng(this.seed, 'flavor', label, this.stage)
  }

  // -------------------------------------------------------------------------
  // Economy
  // -------------------------------------------------------------------------

  /** Activation cost of a pass at `tierCost`, accounting for the free first pass. */
  effectiveCost(tierCost: number): number {
    if (this.mods.freeFirstLaunch && !this.freePassUsed) return 0
    return tierCost
  }

  canAfford(tierCost: number): boolean {
    return this.activations >= this.effectiveCost(tierCost)
  }

  /** Spend for a pass. Caller must have checked canAfford. */
  spend(tierCost: number): number {
    const cost = this.effectiveCost(tierCost)
    if (cost === 0) this.freePassUsed = true
    this.activations = Math.max(0, this.activations - cost)
    this.totals.activationsSpent += cost
    this.totals.passesFired++
    return cost
  }

  /**
   * The cheapest pass currently possible. If the player cannot afford even
   * this, the run is over — checked after every pass resolves.
   */
  cheapestCost(): number {
    const tiers = TEMPERATURES.filter((t) => !t.locked || this.mods.unlockRogueTemp)
    let min = Infinity
    for (const t of tiers) min = Math.min(min, Math.max(1, t.cost - this.mods.tempCostReduction))
    return min === Infinity ? 1 : min
  }

  get isBankrupt(): boolean {
    return !this.canAfford(this.cheapestCost())
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /** Called when a forward pass commits its score. */
  commitPass(passScore: number): void {
    this.score += passScore
    this.totals.totalScore += passScore
    this.totals.bestPass = Math.max(this.totals.bestPass, passScore)
  }

  /**
   * Decide what happens after a pass fully resolves.
   * Returns the phase the game should move to.
   */
  resolveAfterPass(): Phase {
    if (this.targetMet) {
      return this.isFinalStage ? 'run-win' : 'stage-clear'
    }
    if (this.isBankrupt) return 'run-fail'
    return 'aim'
  }

  /** Apply stage-clear refunds. Returns a breakdown for the UI. */
  applyStageRewards(): { refund: number; overshoot: number; ratio: number } {
    const refund = Math.min(ECONOMY.stageClearRefund, this.maxPool - this.activations)
    this.activations += Math.max(0, refund)

    const ratio = this.target > 0 ? this.score / this.target : 1
    let overshoot = 0
    if (ratio >= ECONOMY.overshootThreshold) {
      overshoot = Math.min(ECONOMY.overshootBonus, this.maxPool - this.activations)
      this.activations += Math.max(0, overshoot)
    }
    return { refund: Math.max(0, refund), overshoot: Math.max(0, overshoot), ratio }
  }

  /** Roll the upgrade offers for the current stage transition. */
  rollUpgradeOffers(): Upgrade[] {
    const rng = deriveRng(this.seed, 'upgrades', this.stage)
    this.offers = rollOffers(rng, this.taken, this.mods, 3)
    return this.offers
  }

  takeUpgrade(upgrade: Upgrade): void {
    upgrade.apply(this.mods)
    if (upgrade.onTake) {
      const bag = { activations: this.activations, maxPool: this.maxPool }
      upgrade.onTake(bag)
      this.maxPool = bag.maxPool
      this.activations = Math.min(bag.activations, bag.maxPool)
    }
    // Keep the pool ceiling in sync with mods, whichever path changed it.
    this.maxPool = this.mods.poolMax
    this.activations = Math.min(this.activations, this.maxPool)

    this.taken[upgrade.id] = (this.taken[upgrade.id] ?? 0) + 1
    this.history.push(upgrade)
    this.offers = []
  }

  /** Advance to the next stage. Resets per-stage state. */
  nextStage(): void {
    this.stage++
    this.score = 0
    this.target = stageTarget(this.stage)
    this.overridesLeft = this.mods.agenticOverridesPerStage
    this.freePassUsed = false
  }

  /** Called when a fresh board is loaded, including the first stage. */
  beginStage(): void {
    this.overridesLeft = this.mods.agenticOverridesPerStage
    this.freePassUsed = false
  }
}
