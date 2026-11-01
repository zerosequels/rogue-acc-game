/**
 * state.ts — the run model and its phase machine.
 *
 * Owns the RULES of a run: what a pass costs, when a benchmark is cleared,
 * what money you earn, when the bubble pops. It knows nothing about Three.js,
 * Rapier or the DOM, which keeps the rules readable and testable headlessly.
 *
 * Phase flow:
 *
 *   boot -> brief -> aim <-> resolving
 *                     |          |
 *                     |          +-> cleared -> shop -> brief
 *                     |          +-> collapsed        (bubble pops, you lose)
 *                     +-------------> ipo              (bubble pops, you won)
 */

import { ECONOMY } from '../config/balance'
import { benchmarkAt, bossFor, totalBenchmarks, type BenchmarkDef, type BossDef } from '../config/rounds'
import { baseMods, type Mods } from '../config/mods'
import { Deck } from '../sim/deck'
import { deriveRng, type Rng } from './rng'

export type Phase =
  | 'boot'
  | 'brief'
  | 'aim'
  | 'resolving'
  | 'cleared'
  | 'shop'
  | 'ipo'
  | 'collapsed'

export interface RunTotals {
  passesFired: number
  pinsStruck: number
  signalsFired: number
  spikesHit: number
  drains: number
  bestPass: number
  totalScore: number
  activationsSpent: number
  moneyEarned: number
  moneySpent: number
  itemsBought: number
}

function emptyTotals(): RunTotals {
  return {
    passesFired: 0, pinsStruck: 0, signalsFired: 0, spikesHit: 0, drains: 0,
    bestPass: 0, totalScore: 0, activationsSpent: 0,
    moneyEarned: 0, moneySpent: 0, itemsBought: 0,
  }
}

export interface ClearReward {
  base: number
  overshoot: number
  interest: number
  unspent: number
  total: number
  ratio: number
}

export class RunState {
  readonly seed: string
  phase: Phase = 'boot'

  /** 0..23. The flat benchmark index drives everything. */
  benchmarkIndex = 0
  score = 0

  activations = 0
  /** Permanent per-benchmark allowance, before boss modifiers. */
  activationAllowance: number
  money: number

  mods: Mods
  deck: Deck
  /** shop item id -> times bought. */
  bought: Record<string, number> = {}

  overridesLeft = 0
  totals: RunTotals = emptyTotals()

  constructor(seed: string) {
    this.seed = seed
    this.activationAllowance = ECONOMY.activationsPerBenchmark
    this.money = ECONOMY.startingMoney
    this.mods = baseMods(ECONOMY.startingMaxPool)
    this.deck = new Deck(deriveRng(seed, 'deck'))
    this.activations = this.activationAllowance
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  get benchmark(): BenchmarkDef {
    return benchmarkAt(this.benchmarkIndex)
  }

  get boss(): BossDef | null {
    return bossFor(this.benchmark)
  }

  /** The effective target, after any boss modifier. */
  get target(): number {
    const b = this.boss
    return Math.round(this.benchmark.target * (b?.targetMult ?? 1))
  }

  get progress(): number {
    return this.target <= 0 ? 1 : Math.min(1, this.score / this.target)
  }

  get targetMet(): boolean {
    return this.score >= this.target
  }

  get isFinalBenchmark(): boolean {
    return this.benchmarkIndex >= totalBenchmarks() - 1
  }

  /** Activations this benchmark grants, after any boss modifier. */
  get benchmarkActivations(): number {
    const b = this.boss
    return Math.max(1, Math.round(this.activationAllowance * (b?.activationMult ?? 1)))
  }

  flavorRng(label: string): Rng {
    return deriveRng(this.seed, 'flavor', label, this.benchmarkIndex)
  }

  // -------------------------------------------------------------------------
  // Economy
  // -------------------------------------------------------------------------

  get canFire(): boolean {
    return this.activations > 0 && this.deck.size > 0
  }

  spend(): void {
    this.activations = Math.max(0, this.activations - 1)
    this.totals.activationsSpent++
    this.totals.passesFired++
  }

  commitPass(passScore: number, passMoney: number): void {
    this.score += passScore
    this.totals.totalScore += passScore
    this.totals.bestPass = Math.max(this.totals.bestPass, passScore)
    if (passMoney > 0) {
      this.money += passMoney
      this.totals.moneyEarned += passMoney
    }
  }

  /**
   * Interest is what makes the economy a decision rather than an accumulator:
   * holding money earns money, so every purchase has an opportunity cost. The
   * cap is the important half — past it, hoarding earns nothing and the money
   * belongs in the board.
   */
  interestOn(amount: number): number {
    return Math.min(
      ECONOMY.interestCap,
      Math.floor(amount / ECONOMY.interestPer) * ECONOMY.interestAmount,
    )
  }

  applyClearRewards(): ClearReward {
    const def = this.benchmark
    const ratio = this.target > 0 ? this.score / this.target : 1

    const base = def.payout
    const overshootSteps = Math.floor(Math.max(0, ratio - 1) / ECONOMY.overshootPer)
    const overshoot = Math.min(ECONOMY.overshootCap, overshootSteps)
    const unspent = Math.min(ECONOMY.unspentCap, this.activations)
    const interest = this.interestOn(this.money)

    const total = base + overshoot + unspent + interest
    this.money += total
    this.totals.moneyEarned += total
    return { base, overshoot, interest, unspent, total, ratio }
  }

  canAfford(price: number): boolean {
    return this.money >= price
  }

  pay(price: number, itemId: string): boolean {
    if (!this.canAfford(price)) return false
    this.money -= price
    this.totals.moneySpent += price
    this.totals.itemsBought++
    this.bought[itemId] = (this.bought[itemId] ?? 0) + 1
    return true
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * What happens once a pass fully resolves.
   *
   * Failure is checked AFTER the target, so a final pass that clears on your
   * last activation is a win rather than a loss. That ordering is the whole
   * difference between a tense finish and a cheated one.
   */
  resolveAfterPass(): Phase {
    if (this.targetMet) return this.isFinalBenchmark ? 'ipo' : 'cleared'
    if (!this.canFire) return 'collapsed'
    return 'aim'
  }

  advanceBenchmark(): void {
    this.benchmarkIndex++
    this.score = 0
  }

  /** Called when a benchmark starts. Resets per-benchmark state. */
  beginBenchmark(rng: Rng): void {
    this.score = 0
    this.activations = this.benchmarkActivations
    this.overridesLeft = this.mods.agenticOverridesPerStage
    this.deck.reshuffle(rng)
  }
}
