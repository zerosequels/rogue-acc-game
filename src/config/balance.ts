/**
 * balance.ts — THE tuning surface for rogue/acc.
 *
 * Every number that shapes how the game feels lives here. Nothing else in the
 * codebase should contain a magic gameplay constant. If you want to retune the
 * game, this is the only file you need to open.
 *
 * The three numbers that matter most, and how they are coupled:
 *
 *   BASE_PIN_VALUE (10) ......... the unit of all scoring
 *   BENCHMARK_GROWTH (1.4) ...... how fast stage targets escalate
 *   upgrade strength (~+40%) .... how fast player power escalates
 *
 * Targets grow 1.4x per stage, so across 7 upgrade picks the player must get
 * ~10.5x stronger (1.4^7). That means the average upgrade has to be worth about
 * +40% effective power. If you change BENCHMARK_GROWTH, upgrade strength in
 * `upgrades.ts` must move with it or the back half of the run becomes
 * unwinnable. This coupling is the single most important invariant in the game.
 */

// ---------------------------------------------------------------------------
// Board geometry (world units; the orthographic camera frames this exactly)
// ---------------------------------------------------------------------------

export const BOARD = {
  width: 16,
  height: 24,
  /** Playfield vertical span. Launcher sits above `top`, pockets below `bottom`. */
  top: 9,
  bottom: -9.2,
  wallThickness: 0.6,
} as const

export const PIN = {
  /** Pins are deliberately LARGER than orbs: prevents tunnelling and makes
   *  every bounce read clearly on screen. Do not invert this ratio. */
  radius: 0.3,
  criticalRadius: 0.52,
  /** Restitution FLOOR only. Colliders combine with CoefficientCombineRule.Max,
   *  so the orb's temperature-scaled restitution is what actually governs
   *  bounciness above this value. Keep it low or temperature stops mattering. */
  restitution: 0.25,
  friction: 0.04,
  /** Minimum centre-to-centre distance between any two pins.
   *  Must exceed 2*PIN.radius + 2*ORB.radius (= 1.1) or orbs cannot pass. */
  minSpacing: 1.26,
} as const

export const ORB = {
  radius: 0.25,
  /** Base restitution at Balanced temperature. Multiplied by the selected
   *  tier's `bounce`, giving 0.46 / 0.58 / 0.73 / 0.87 across the four tiers.
   *  This single value is the main dial for how lively the whole board feels. */
  restitution: 0.58,
  friction: 0.02,
  linearDamping: 0.055,
  /** Hard velocity clamp: anti-tunnel insurance + keeps cascades legible. */
  maxSpeed: 40,
  /** An orb below this speed for this long is considered stuck and culled. */
  stuckSpeed: 0.55,
  stuckSeconds: 1.5,
  /** Absolute lifetime ceiling. Also the validator's stuck threshold. */
  maxLifetime: 15,
} as const

export const PHYSICS = {
  gravity: -30,
  /** Fixed timestep. Required for determinism; never step with frame delta. */
  dt: 1 / 120,
  /** Max sim steps per rendered frame (prevents death-spiral on slow frames). */
  maxStepsPerFrame: 8,
  wallRestitution: 0.4,
} as const

export const LAUNCH = {
  /** Seconds of held input to reach full power. */
  chargeTime: 0.4,
  minSpeed: 12,
  maxSpeed: 28,
  /** Aim cone, radians from straight down. */
  maxAngle: (60 * Math.PI) / 180,
  aimSpeedKeyboard: 1.25,
  originY: 10.2,
  /** Orbs in a multi-orb launch are fanned across this angular spread. */
  multiOrbSpread: (7 * Math.PI) / 180,
  /** Hard ceiling on concurrent bodies. Protects the frame budget when
   *  Chain Reaction splits fire during a dense cascade. */
  maxOrbsHardCap: 12,
} as const

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const SCORE = {
  basePinValue: 10,
  criticalPinValue: 35,
  /**
   * Progressive multiplier ladder, keyed on DISTINCT weights struck this pass.
   *
   * Thresholds are expressed as MULTIPLES of `pinsPerTier` so that the Residual
   * Amplifier upgrade (which lowers pinsPerTier) compresses the whole ladder
   * uniformly instead of needing a second table.
   *
   * At the default pinsPerTier of 5 the breakpoints are 0 / 5 / 10 / 20:
   *   pins  0-4  -> x1.0
   *   pins  5-9  -> x1.5
   *   pins 10-19 -> x2.0
   *   pins 20+   -> x3.0
   *
   * Pins score at the tier they are struck in. The ladder is NOT applied
   * retroactively — that keeps a long cascade strongly rewarding without
   * letting one lucky drop swing an entire stage.
   *
   *   a 20-pin cascade: 5*10*1 + 5*10*1.5 + 10*10*2 = 325
   *   a 4-pin dud:      4*10*1                      =  40
   */
  tierMultipliers: [1.0, 1.5, 2.0, 3.0],
  tierThresholdSteps: [0, 1, 2, 4],
  /** Distinct weights needed per tier step, before Residual Amplifier. */
  pinsPerTier: 5,
  /**
   * Flat effective-pin bonus per attention head struck, for tier progress.
   * NOT scaled by pinsPerTier — see the note in `Pass.effectivePins`.
   */
  criticalTierBonus: 2,
  /** Spike pocket multiplies the whole pass's accumulated score. */
  spikeMultiplier: 5,
  /** Neutral bottom pockets award a flat consolation. */
  pocketBonus: 15,
  /** Hallucination Engine payout multiplier on a successful roll. */
  hallucinationMult: 5,
  /**
   * Explosive Weights: payout per detonated weight, as a multiple of base
   * value, and how many a single head may destroy.
   *
   * Detonation has to pay ABOVE base, not below. A destroyed weight cannot
   * then be struck by the token that detonated it, so a sub-1.0 payout makes
   * the upgrade a net loss — the audit measured the original 0.75x at +4%
   * against a +40% budget even after the permanent-destruction bug was fixed.
   */
  detonationValueMult: 2.0,
  detonationCap: 4,
} as const

// ---------------------------------------------------------------------------
// Activation economy — ONE pool for the whole run, not per stage.
//
// Equilibrium check: a stage costs ~8 launches, a clear refunds 8, so the pool
// hovers near its start value with a ~12 buffer. Mistakes are survivable; a
// genuinely bad stage costs real runway. That is the intended tension.
// ---------------------------------------------------------------------------

export const ECONOMY = {
  startingActivations: 20,
  startingMaxPool: 30,
  /** Refund on clearing a stage. */
  stageClearRefund: 8,
  /** Bonus for exceeding the target by `overshootThreshold`. */
  overshootThreshold: 1.5,
  overshootBonus: 3,
  /** HUD turns red at or below this many activations. */
  lowWarning: 5,
} as const

// ---------------------------------------------------------------------------
// Temperature — a PER-LAUNCH choice, not a meter that fills on its own.
//
// This is the game's central decision. Higher temperature makes orbs bouncier
// (more pins struck, far more variance) and multiplies score, but costs more
// activations per launch. Low temperature is a predictable grind; Rogue is a
// three-activation gamble. The name is literal: it is a sampling parameter you
// set before generation.
// ---------------------------------------------------------------------------

export interface TemperatureTier {
  readonly value: number
  readonly name: string
  /** Multiplies orb + pin restitution. */
  readonly bounce: number
  readonly scoreMult: number
  readonly cost: number
  readonly locked: boolean
  readonly blurb: string
}

export const TEMPERATURES: readonly TemperatureTier[] = [
  { value: 0.2, name: 'Greedy', bounce: 0.8, scoreMult: 1.0, cost: 1, locked: false, blurb: 'argmax. predictable. dull.' },
  { value: 0.7, name: 'Balanced', bounce: 1.0, scoreMult: 1.4, cost: 1, locked: false, blurb: 'the shipping default.' },
  { value: 1.3, name: 'Creative', bounce: 1.25, scoreMult: 2.0, cost: 2, locked: false, blurb: 'wider distribution. wilder bounce.' },
  { value: 2.0, name: 'Rogue', bounce: 1.5, scoreMult: 3.0, cost: 3, locked: true, blurb: 'unaligned sampling. no guardrails.' },
]

export const DEFAULT_TEMP_INDEX = 1

// ---------------------------------------------------------------------------
// Stage targets: 1.4x growth. See the coupling note at the top of this file.
//   2,200 · 3,080 · 4,310 · 6,030 · 8,450 · 11,830 · 16,560 · 23,180
// ---------------------------------------------------------------------------

export const STAGES = {
  count: 8,
  /**
   * Stage 1 target. Calibrated against the headless sweep in `tools/simulate.ts`:
   * a Balanced pass on a base checkpoint has a median of ~280, and the intended
   * equilibrium is ~8 passes per stage (which exactly matches the +8 refund, so
   * a competently played stage breaks even on activations).
   */
  baseTarget: 2200,
  growth: 1.4,
} as const

export function stageTarget(stage: number): number {
  const raw = STAGES.baseTarget * Math.pow(STAGES.growth, stage - 1)
  // Round to a readable figure so the HUD never shows 1959.9999.
  return Math.round(raw / 10) * 10
}

// ---------------------------------------------------------------------------
// Procedural board generation
// ---------------------------------------------------------------------------

export const BOARDGEN = {
  /**
   * v2: the lattice is FIXED. Geometry never varies between runs or seeds —
   * a standardised layout plus a board that persists all run means the player
   * must be able to learn it. The seed varies edge wiring and starting state
   * instead (see `boardgen.ts`).
   */
  layers: 9,
  /** Even rows get this many nodes, odd rows one fewer and a half-cell shift. */
  nodesPerLayer: 8,
  /** Chance a node wires a third downward edge rather than two. */
  thirdEdgeChance: 0.34,
  /** Nodes that begin at level 2 rather than 1. */
  startingPromotions: 3,
  /** Attention heads placed unconditionally at run start. Never zero: the
   *  tier bonus, split trigger and detonation trigger all key off them. */
  startingAttentionHeads: 3,
  /** Additional nodes that begin carrying one of the mild transforms. */
  startingTransforms: 2,
  startingBucketTransformChance: 0.55,
  pocketCount: 6,
  spikePocketsMin: 1,
  spikePocketsMax: 2,
  /** Horizontal inset from the rails for node placement. */
  edgeInset: 1.15,
  pocketWallHeight: 1.7,
} as const

/**
 * Validator thresholds. This is NOT a design system — it is a crash guard.
 * A well-built generator still emits outliers; this rejects the ones that are
 * actively unplayable (orbs that stick, boards with no cascade) and regenerates.
 */
export const VALIDATOR = {
  probeDrops: 24,
  /** Seconds of sim per probe. */
  probeSeconds: 8,
  /** Median distinct pins struck across probes must be at least this. */
  minMedianPins: 8,
  /** Fraction of probes that must terminate (drain/pocket) rather than stick. */
  minSettleRate: 0.8,
  /** No probe may stay alive longer than this. */
  maxAliveSeconds: ORB.maxLifetime,
  maxAttempts: 10,
} as const

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const VISUAL = {
  bloomStrength: 0.42,
  bloomRadius: 0.42,
  bloomThreshold: 0.33,
  /** Extra bloom at max temperature. */
  bloomTempBoost: 0.3,
  /**
   * Glitch intensity at max temperature. Tuned against a screenshot, not by
   * eye in isolation: above ~0.35 the chromatic split starts competing with
   * the board for attention instead of framing it.
   */
  glitchMax: 0.32,
  trailLength: 26,
  pinFlashSeconds: 0.42,
  /** Wall thickness of a node ring, in world units. Thin reads as schematic. */
  ringThickness: 0.062,
  /** Edge brightness at rest, as a fraction of full. Must stay faint: 70 nodes
   *  of edges at any real brightness becomes a bright haze, not a diagram. */
  edgeRestBrightness: 0.13,
  /** How fast a signalled edge fades back to rest. */
  edgeFadeRate: 2.6,
  /** Resolution of the glyph-label canvas. The label layer is one texture over
   *  the whole board, redrawn only when levels or transforms change. */
  labelPixelsPerUnit: 54,
  /** Horizontal breathing room either side of the board. */
  cameraPadding: 1.0,
  /** Clearance above the launcher, so it clears the HUD bar. */
  cameraPadTop: 2.8,
  /** Clearance below the board floor, so the pockets are never clipped. */
  cameraPadBottom: 2.6,
  /** Peak camera shake, in world units. Past ~0.5 it reads as nausea, not impact. */
  shakeMax: 0.34,
  /** World units of shake added per unit of renderer.punch(). */
  shakePerPunch: 0.16,
  /** Per-frame shake decay, normalised to 60fps. */
  shakeDecay: 0.86,
} as const

export const COLORS = {
  bg: 0x04060b,
  pin: 0x4e9ad4,
  pinLit: 0x35e4ff,
  pinSpent: 0x22435f,
  critical: 0xffa21f,
  criticalLit: 0xfff0c0,
  orb: 0x9dff4a,
  orbHot: 0xff3cc8,
  wall: 0x16243d,
  spike: 0xff3cc8,
  drain: 0x6e2233,
  pocket: 0x23496e,
  trail: 0x35e4ff,
  /** Connection lines at rest. Scaled down hard by edgeRestBrightness. */
  edge: 0x4fd8ff,
  drainLine: 0xd3405a,
  pocketLine: 0x4d8fc4,
} as const
