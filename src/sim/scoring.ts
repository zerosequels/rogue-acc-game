/**
 * scoring.ts — forward-pass scoring.
 *
 * One "forward pass" is everything that happens from a launch until the last of
 * its orbs leaves the board. Score accumulates in the pass, then commits to the
 * stage total. Holding it uncommitted is what makes a spike pocket dramatic: it
 * multiplies the whole pass retroactively.
 *
 * Key rule: a pin scores ONCE PER PASS, not once per contact. Without that,
 * an orb rattling in a pocket of three pins farms them forever and the
 * multiplier ladder becomes meaningless. "Chain" in the HUD is therefore the
 * count of DISTINCT weights struck.
 */

import { SCORE } from '../config/balance'
import type { Rng } from '../core/rng'
import type { Mods } from '../config/upgrades'
import type { PinDef, PocketDef } from './board'
import type { OrbHandle } from './physics'

export interface ScoreEvent {
  /** Points actually awarded (already fully multiplied). */
  points: number
  x: number
  y: number
  kind: 'pin' | 'critical' | 'spike' | 'pocket' | 'dud' | 'hallucination' | 'detonation'
  /** Tier multiplier in force when this scored, for the popup label. */
  tierMult: number
}

/** Live state of the current forward pass. */
export class Pass {
  /** Distinct pin ids struck this pass. */
  readonly struck = new Set<number>()
  /** Attention heads struck, for tier bonus accounting. */
  criticalHits = 0
  /** Accumulated, uncommitted score. */
  score = 0
  /** Number of score-bearing events, used for pacing audio/visual intensity. */
  eventCount = 0
  /** Set once a spike has already fired this pass (one jackpot per pass). */
  spikeApplied = false

  get chain(): number {
    return this.struck.size
  }

  /**
   * Effective pins for tier purposes: distinct pins, plus a FLAT bonus per
   * attention head struck, divided by the number of tokens in the pass.
   *
   * Two separate fixes are encoded here, both found by `tools/upgrades.ts`:
   *
   * 1. The head bonus used to be scaled by `pinsPerTier`, so a single head
   *    advanced a whole tier on its own. That alone inflated a median pass
   *    from ~145 to ~315 and let a random-aim bot clear stages in three
   *    passes. A head should accelerate the ladder, not skip a rung of it.
   *
   * 2. The ladder is shared across every token in a pass, so launching three
   *    tokens used to reach the top tier that one token cannot — measured at
   *    +205% for a single stack of New Attention Head, against a +40% budget.
   *    Normalising by token count makes the ladder measure CASCADE QUALITY
   *    rather than token count: with three tokens you need three times the
   *    strikes for the same tier, which is the honest comparison. Multi-token
   *    launches still win on board coverage and spike chances — they just no
   *    longer get the multiplier for free.
   */
  effectivePins(mods: Mods): number {
    const raw = this.struck.size + this.criticalHits * SCORE.criticalTierBonus
    return raw / Math.max(1, mods.orbsPerLaunch)
  }

  tierIndex(mods: Mods): number {
    const eff = this.effectivePins(mods)
    const steps = SCORE.tierThresholdSteps
    let idx = 0
    for (let i = 0; i < steps.length; i++) {
      if (eff >= steps[i]! * mods.pinsPerTier) idx = i
    }
    return Math.min(idx, SCORE.tierMultipliers.length - 1)
  }

  tierMult(mods: Mods): number {
    return SCORE.tierMultipliers[this.tierIndex(mods)]!
  }

  reset(): void {
    this.struck.clear()
    this.criticalHits = 0
    this.score = 0
    this.eventCount = 0
    this.spikeApplied = false
  }
}

export interface ScoringContext {
  mods: Mods
  /** Selected temperature's score multiplier. */
  tempScoreMult: number
  /** Selected temperature value, gates Hallucination Engine. */
  tempValue: number
  rng: Rng
}

/**
 * Score a pin contact. Returns null when the pin was already struck this pass
 * (the common case during a rattle) so callers can skip all feedback.
 */
export function scorePin(
  pass: Pass,
  pin: PinDef,
  orb: OrbHandle,
  ctx: ScoringContext,
): ScoreEvent | null {
  if (pass.struck.has(pin.id)) return null
  pass.struck.add(pin.id)
  if (pin.critical) pass.criticalHits++

  const { mods } = ctx
  const tierMult = pass.tierMult(mods)

  // Gradient Surge ramps base value with every weight already struck.
  const surge = mods.gradientSurge * (pass.struck.size - 1)
  const base = (pin.critical ? SCORE.criticalPinValue : SCORE.basePinValue) + surge

  let points = base * mods.pinValueMult * tierMult * ctx.tempScoreMult * orb.scoreScale * mods.scoreMult
  let kind: ScoreEvent['kind'] = pin.critical ? 'critical' : 'pin'

  // --- Hallucination Engine: only active at Creative (1.3) and above ---
  if (mods.hallucinationChance > 0 && ctx.tempValue >= 1.3) {
    const roll = ctx.rng.next()
    if (roll < mods.hallucinationDudChance) {
      points = 0
      kind = 'dud'
    } else if (roll < mods.hallucinationDudChance + mods.hallucinationChance) {
      points *= SCORE.hallucinationMult
      kind = 'hallucination'
    }
  }

  points = Math.round(points)
  pass.score += points
  pass.eventCount++

  return { points, x: pin.x, y: pin.y, kind, tierMult }
}

/**
 * Score a pin destroyed by Explosive Weights. Detonated pins pay immediately
 * and still count toward the chain, but never trigger further detonations
 * (no recursive chain — that is what the maxOrbs cap is for elsewhere).
 */
export function scoreDetonation(
  pass: Pass,
  pin: PinDef,
  ctx: ScoringContext,
): ScoreEvent | null {
  if (pass.struck.has(pin.id)) return null
  pass.struck.add(pin.id)

  const { mods } = ctx
  const tierMult = pass.tierMult(mods)
  const surge = mods.gradientSurge * (pass.struck.size - 1)
  const base = SCORE.basePinValue + surge
  const points = Math.round(
    base * mods.pinValueMult * tierMult * ctx.tempScoreMult * mods.scoreMult *
      SCORE.detonationValueMult,
  )

  pass.score += points
  pass.eventCount++
  return { points, x: pin.x, y: pin.y, kind: 'detonation', tierMult }
}

/** Resolve an orb landing in a bottom pocket. */
export function scoreLanding(
  pass: Pass,
  pocket: PocketDef,
  orb: OrbHandle,
  ctx: ScoringContext,
): ScoreEvent | null {
  const { mods } = ctx

  if (pocket.kind === 'spike') {
    // One jackpot per pass: multiplies everything banked so far. If the pass
    // scored nothing, award a floor so a blind spike hit is never worthless.
    if (pass.spikeApplied) return null
    pass.spikeApplied = true

    // The jackpot is a PASS-level prize, so it must be shared between the
    // tokens of that pass. Otherwise every extra token is another lottery
    // ticket on the same pass-wide multiplier: `tools/upgrades.ts` measured a
    // single stack of New Attention Head at +186% purely from tripled spike
    // odds, and a further stack at -8% as those odds saturated. Dividing the
    // bonus portion keeps expected spike value roughly flat in token count,
    // so wide builds buy board COVERAGE rather than a free jackpot.
    const spikeMult = 1 + (mods.spikeMult - 1) / Math.max(1, mods.orbsPerLaunch)

    const before = pass.score
    const after = before > 0
      ? Math.round(before * spikeMult)
      : Math.round(SCORE.basePinValue * spikeMult * mods.pinValueMult * ctx.tempScoreMult)
    pass.score = after
    pass.eventCount++
    return {
      points: after - before,
      x: pocket.x,
      y: orb.y,
      kind: 'spike',
      tierMult: pass.tierMult(mods),
    }
  }

  if (pocket.kind === 'pocket') {
    const points = Math.round(
      SCORE.pocketBonus * mods.pinValueMult * ctx.tempScoreMult * orb.scoreScale * mods.scoreMult,
    )
    pass.score += points
    pass.eventCount++
    return { points, x: pocket.x, y: orb.y, kind: 'pocket', tierMult: pass.tierMult(mods) }
  }

  // 'drain' — a dead neuron. No points, but the UI still marks it.
  return null
}
