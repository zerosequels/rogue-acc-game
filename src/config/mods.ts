/**
 * mods.ts — the flat bag of player modifiers.
 *
 * Everything in the sim layer reads `Mods` and nothing reads an upgrade. That
 * indirection is what let v1's upgrade catalogue be deleted wholesale when the
 * shop replaced it, without touching a line of scoring or physics.
 *
 * v1 owned a 16-entry upgrade list here with archetypes and draw weights. The
 * shop (`config/shop.ts` + `core/shopkeeper.ts`) replaced all of it: purchases
 * now act on the BOARD and the DECK directly rather than on this bag. What
 * survives are the fields the sim still consults, several of which no shop
 * item currently sets — they are kept because scoring reads them and because
 * re-adding an item that sets one is a one-line change.
 */

import { SCORE } from './balance'

/**
 * The complete set of player modifiers. Defaults here describe a pristine
 * base model with no fine-tunes applied.
 */
export interface Mods {
  // --- scoring ---
  /** Multiplies every pin's base value. */
  pinValueMult: number
  /** Flat multiplier on all score, applied last. */
  scoreMult: number
  /** Distinct pins needed to advance one multiplier tier. Lower is better. */
  pinsPerTier: number
  /** Gradient Surge: each pin struck adds this to base value for the rest of
   *  the launch (ramping cascade reward). */
  gradientSurge: number

  // --- orbs ---
  orbsPerLaunch: number
  /** Per-orb score scaling, used to balance multi-orb launches. */
  orbScoreMult: number
  /** Critical pin hits split the orb in two. */
  chainSplitOnCritical: boolean
  maxOrbs: number

  // --- economy ---
  poolMax: number
  /** First launch of each stage costs nothing. */
  freeFirstLaunch: boolean

  // --- board ---
  /** Fraction of ordinary pins pruned at board load. */
  pruneFraction: number
  /** Critical pins destroy nearby pins, each scoring on destruction. */
  explosiveWeights: boolean
  explosiveRadius: number
  /** Weights a single head may detonate. */
  detonationCap: number
  spikeMult: number
  spikeWidthMult: number

  // --- aim / control ---
  showTrajectory: boolean
  trajectorySeconds: number
  /** Mid-air redirects available per stage. */
  agenticOverridesPerStage: number

  // --- temperature ---
  /** Hallucination Engine: at Creative+, per-pin chance of x5 / zero. */
  hallucinationChance: number
  hallucinationDudChance: number
}

export function baseMods(poolMax: number): Mods {
  return {
    pinValueMult: 1,
    scoreMult: 1,
    pinsPerTier: 5,
    gradientSurge: 0,
    orbsPerLaunch: 1,
    orbScoreMult: 1,
    chainSplitOnCritical: false,
    maxOrbs: 6,
    poolMax,
    freeFirstLaunch: false,
    pruneFraction: 0,
    explosiveWeights: false,
    explosiveRadius: 1.9,
    detonationCap: SCORE.detonationCap,
    spikeMult: 5,
    spikeWidthMult: 1,
    showTrajectory: false,
    trajectorySeconds: 1.5,
    agenticOverridesPerStage: 0,
    hallucinationChance: 0,
    hallucinationDudChance: 0,
  }
}
