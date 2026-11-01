/**
 * upgrades.ts — the model-modification catalogue.
 *
 * Every upgrade is pure data plus one `apply(mods)` function that mutates a
 * flat `Mods` bag. Nothing in the sim or render layer knows an upgrade exists;
 * they only read `Mods`. To add an upgrade, append to UPGRADES — no other file
 * needs to change.
 *
 * Four archetypes, so a run has recognisable build directions:
 *
 *   scale ......... raw multipliers. reliable, boring, always fine.
 *   width ......... more orbs, more pool, more launches.
 *   precision ..... board manipulation and aim control.
 *   temperature ... make the hot tiers cheaper/stronger. the gambling build.
 *
 * STRENGTH BUDGET: stage targets grow 1.4x and the player gets 7 picks, so each
 * upgrade must average ~+40% effective power. When adding one, sanity-check it
 * against that bar — well under and it is a trap pick, well over and the run
 * trivialises. See the coupling note in `balance.ts`.
 */

import { SCORE } from './balance'

export type Archetype = 'scale' | 'width' | 'precision' | 'temperature'

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
  unlockRogueTemp: boolean
  /** Subtracted from every temperature's activation cost (floored at 1). */
  tempCostReduction: number
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
    unlockRogueTemp: false,
    tempCostReduction: 0,
    hallucinationChance: 0,
    hallucinationDudChance: 0,
  }
}

export interface Upgrade {
  readonly id: string
  readonly name: string
  readonly archetype: Archetype
  readonly description: string
  /** Flavour line shown under the mechanical description. */
  readonly flavor: string
  /** How many times this upgrade may be taken in one run. */
  readonly maxStacks: number
  /** Relative draw weight. Swingy or build-defining picks are rarer. */
  readonly weight: number
  /** Hidden unless the predicate passes — keeps synergy picks coherent. */
  readonly requires?: (mods: Mods) => boolean
  readonly apply: (mods: Mods) => void
  /** Immediate one-shot effect on the run (pool grants etc.). */
  readonly onTake?: (run: { activations: number; maxPool: number }) => void
}

export const UPGRADES: readonly Upgrade[] = [
  // ======================= SCALE =======================
  {
    id: 'just-scale',
    name: 'Just Scale',
    archetype: 'scale',
    description: 'All weight values +40%.',
    flavor: 'no clever tricks. no architecture search. just more.',
    maxStacks: 3,
    weight: 10,
    apply: (m) => { m.pinValueMult += 0.4 },
  },
  {
    id: 'residual-amplifier',
    name: 'Residual Amplifier',
    archetype: 'scale',
    description: 'Multiplier tiers advance every 3 weights instead of 5.',
    flavor: 'the residual stream stops forgetting what it just computed.',
    maxStacks: 2,
    weight: 7,
    apply: (m) => { m.pinsPerTier = Math.max(2, m.pinsPerTier - 2) },
  },
  {
    id: 'gradient-surge',
    name: 'Gradient Surge',
    archetype: 'scale',
    description: 'Each weight struck adds +1 to base value for the rest of that forward pass.',
    flavor: 'gradients compound. so does the damage.',
    maxStacks: 3,
    weight: 8,
    apply: (m) => { m.gradientSurge += 1 },
  },
  {
    id: 'distillation',
    name: 'Distillation',
    archetype: 'scale',
    description: 'Permanently −5 max activation pool, but all weights +25%.',
    flavor: 'smaller model. sharper model. fewer shots to prove it.',
    maxStacks: 2,
    weight: 5,
    apply: (m) => { m.pinValueMult += 0.25; m.poolMax = Math.max(8, m.poolMax - 5) },
    onTake: (run) => {
      run.maxPool = Math.max(8, run.maxPool - 5)
      run.activations = Math.min(run.activations, run.maxPool)
    },
  },

  // ======================= WIDTH =======================
  {
    id: 'attention-head',
    name: 'New Attention Head',
    archetype: 'width',
    description: 'Launch one extra token per forward pass. Tokens share the pass, so each scores less.',
    flavor: 'parallel heads, parallel cascades, parallel benchmarks.',
    maxStacks: 3,
    weight: 9,
    apply: (m) => {
      m.orbsPerLaunch += 1
      m.maxOrbs = Math.min(12, m.maxOrbs + 2)
      // Per-token value is RECOMPUTED from the token count, never compounded,
      // so that TOTAL pass value is exactly 1.4^(stacks) — the +40% per pick
      // budget, met by construction. A negative stack is therefore impossible.
      //
      // The original compounded orbScoreMult by 0.7 per stack. Token count
      // grows linearly while 0.7^n decays geometrically, so `tools/upgrades.ts`
      // measured stack 2 at +169% and stack 3 at **-17%** — a third pick made
      // you strictly weaker. Two companion fixes landed alongside this one
      // (tier normalisation in scoring.ts, spike sharing in scoreLanding);
      // all three were needed, and the audit is what separated them.
      m.orbScoreMult = Math.pow(1.4, m.orbsPerLaunch - 1) / m.orbsPerLaunch
    },
  },
  {
    id: 'lora-chain-reaction',
    name: 'LoRA: Chain Reaction',
    archetype: 'width',
    description: 'Striking an attention head splits the token in two.',
    flavor: 'a low-rank adapter that only knows how to multiply.',
    maxStacks: 1,
    weight: 6,
    apply: (m) => { m.chainSplitOnCritical = true; m.maxOrbs = Math.min(12, m.maxOrbs + 4) },
  },
  {
    id: 'context-extension',
    name: 'Context Extension',
    archetype: 'width',
    description: '+6 max activation pool, and +4 activations right now.',
    flavor: 'the window widens. the run breathes.',
    maxStacks: 3,
    weight: 8,
    apply: (m) => { m.poolMax += 6 },
    onTake: (run) => {
      run.maxPool += 6
      run.activations = Math.min(run.maxPool, run.activations + 4)
    },
  },
  {
    id: 'speculative-decoding',
    name: 'Speculative Decoding',
    archetype: 'width',
    description: 'The first forward pass of every stage is free.',
    flavor: 'draft it cheap, verify it later, bill nobody.',
    maxStacks: 1,
    weight: 7,
    apply: (m) => { m.freeFirstLaunch = true },
  },

  // ===================== PRECISION =====================
  {
    id: 'prune-dead-neurons',
    name: 'Prune Dead Neurons',
    archetype: 'precision',
    description: 'Removes 15% of ordinary weights at load. Survivors +50% value.',
    flavor: 'sparsity is a feature. the holes are where the cascade lives.',
    maxStacks: 2,
    weight: 7,
    // Was 20% pruned for +15% value, which the audit measured at **-7%** — the
    // lost strikes (and lost tier progress) outweighed the bump, making this a
    // strictly negative pick. Prune less, pay more.
    apply: (m) => { m.pruneFraction = Math.min(0.35, m.pruneFraction + 0.15); m.pinValueMult += 0.5 },
  },
  {
    id: 'attention-mask',
    name: 'Attention Mask',
    archetype: 'precision',
    description: 'Projects the token’s predicted path for its first 1.5 seconds.',
    flavor: 'you can see what it is about to attend to. roughly.',
    maxStacks: 1,
    weight: 8,
    apply: (m) => { m.showTrajectory = true },
  },
  {
    id: 'explosive-weights',
    name: 'Explosive Weights',
    archetype: 'precision',
    description: 'Attention heads detonate, scoring nearby weights at double value. They reform next pass.',
    flavor: 'exploding gradients, but on purpose, and louder.',
    maxStacks: 2,
    weight: 6,
    // Stack 2 must raise the CAP, not just the radius — a wider blast that
    // still only destroys four weights measured at +7%, barely a pick.
    apply: (m) => {
      m.explosiveWeights = true
      m.explosiveRadius += 0.6
      m.detonationCap += 3
    },
  },
  {
    id: 'benchmark-overfit',
    name: 'Benchmark Overfit',
    archetype: 'precision',
    description: 'Benchmark spikes are 50% wider and pay ×7 instead of ×5.',
    flavor: 'we did not train on the test set. we trained near it.',
    maxStacks: 2,
    weight: 6,
    apply: (m) => { m.spikeMult += 2; m.spikeWidthMult += 0.5 },
  },

  // =================== TEMPERATURE ===================
  {
    id: 'temperature-spike',
    name: 'Temperature Spike',
    archetype: 'temperature',
    description: 'Unlocks Rogue (2.0) sampling. All temperature costs −1 (min 1).',
    flavor: 'somebody removed the ceiling on the sampler. nobody admits it.',
    maxStacks: 2,
    weight: 8,
    apply: (m) => { m.unlockRogueTemp = true; m.tempCostReduction += 1 },
  },
  {
    id: 'hallucination-engine',
    name: 'Hallucination Engine',
    archetype: 'temperature',
    description: 'At Creative or above: each weight has a 12% chance to pay ×5 and a 4% chance to pay nothing.',
    flavor: 'confidently wrong, occasionally transcendent.',
    maxStacks: 2,
    weight: 5,
    apply: (m) => { m.hallucinationChance += 0.12; m.hallucinationDudChance += 0.04 },
  },
  {
    id: 'agentic-override',
    name: 'Agentic Override',
    archetype: 'temperature',
    description: 'Once per stage, redirect a token in mid-flight.',
    flavor: 'it took an action you did not authorise. it worked.',
    maxStacks: 3,
    weight: 7,
    apply: (m) => { m.agenticOverridesPerStage += 1 },
  },
  {
    id: 'rogue-fine-tune',
    name: 'Rogue Fine-Tune',
    archetype: 'temperature',
    description: 'All score +80%. Max activation pool −4.',
    flavor: 'the eval scores went up. the refusals went down. ship it.',
    maxStacks: 2,
    weight: 5,
    apply: (m) => { m.scoreMult += 0.8; m.poolMax = Math.max(8, m.poolMax - 4) },
    onTake: (run) => {
      run.maxPool = Math.max(8, run.maxPool - 4)
      run.activations = Math.min(run.activations, run.maxPool)
    },
  },
]

const BY_ID = new Map(UPGRADES.map((u) => [u.id, u]))

export function upgradeById(id: string): Upgrade | undefined {
  return BY_ID.get(id)
}

/**
 * Pick `count` offers, deliberately spread across archetypes so the player
 * sees real alternatives rather than three flavours of the same build.
 * Deterministic: driven entirely by the passed Rng.
 */
export function rollOffers(
  rng: { pick: <T>(a: readonly T[]) => T; weighted: <T>(a: readonly T[], w: (t: T) => number) => T; shuffle: <T>(a: readonly T[]) => T[] },
  taken: Readonly<Record<string, number>>,
  mods: Mods,
  count = 3,
): Upgrade[] {
  const eligible = UPGRADES.filter((u) => {
    if ((taken[u.id] ?? 0) >= u.maxStacks) return false
    if (u.requires && !u.requires(mods)) return false
    return true
  })
  if (eligible.length <= count) return eligible.slice()

  const offers: Upgrade[] = []
  const usedArchetypes = new Set<Archetype>()

  while (offers.length < count) {
    // Prefer unseen archetypes, but never deadlock if the pool is lopsided.
    const fresh = eligible.filter(
      (u) => !offers.includes(u) && !usedArchetypes.has(u.archetype),
    )
    const pool = fresh.length > 0 ? fresh : eligible.filter((u) => !offers.includes(u))
    if (pool.length === 0) break
    const chosen = rng.weighted(pool, (u) => u.weight)
    offers.push(chosen)
    usedArchetypes.add(chosen.archetype)
  }

  return rng.shuffle(offers)
}

export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  scale: 'Scale',
  width: 'Width',
  precision: 'Precision',
  temperature: 'Temperature',
}
