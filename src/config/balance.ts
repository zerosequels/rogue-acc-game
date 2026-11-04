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
  /** Weights stay LARGER than tokens: prevents tunnelling and keeps every
   *  bounce legible. Do not invert this ratio. */
  radius: 0.19,
  criticalRadius: 0.34,
  /** Restitution FLOOR only. Colliders combine with CoefficientCombineRule.Max,
   *  so the orb's temperature-scaled restitution is what actually governs
   *  bounciness above this value. Keep it low or temperature stops mattering. */
  restitution: 0.25,
  friction: 0.04,
  /** Minimum centre-to-centre distance between any two weights. Must exceed
   *  2*PIN.radius + 2*ORB.radius (= 0.69) or a token cannot pass between
   *  neighbours. 0.80 leaves real clearance. */
  minSpacing: 0.80,
} as const

export const ORB = {
  radius: 0.155,
  /** Base restitution at Balanced temperature. Multiplied by the selected
   *  tier's `bounce`, giving 0.46 / 0.58 / 0.73 / 0.87 across the four tiers.
   *  This single value is the main dial for how lively the whole board feels. */
  restitution: 0.58,
  friction: 0.02,
  linearDamping: 0.055,
  /** Hard velocity clamp. With the smaller radii, 40 u/s at a 1/120 step
   *  moves 0.33 units against a combined radius of 0.345 — close enough to
   *  tunnel if CCD ever misses. 30 keeps a step strictly under the gap. */
  maxSpeed: 30,
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
  basePinValue: 4,
  criticalPinValue: 14,
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
  pocketBonus: 22,
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
// The deck — training data.
//
// Deck size and activations are separate resources: activations are how many
// shots a benchmark gives, the deck is what those shots fire.
// ---------------------------------------------------------------------------

export const DECK = {
  /** 4 types x 4 = 16 cards. Small enough that deleting one is a visible 6%
   *  shift in your odds, which is what makes thinning a real decision. */
  startingPerType: 4,
  /** Card value is `typeMult * (1 + levelStep * (level - 1))`. */
  levelStep: 0.25,
  maxLevel: 10,
  maxTransformsPerCard: 2,
  /** How many upcoming cards the HUD shows. */
  previewCount: 2,

  poisonedMult: 3,
  poisonedDudChance: 0.2,
  distilledMult: 0.78,
  /** Deduplicated lowers the signal FLOOR by this many hops' worth of decay,
   *  which is what actually extends a wave. Raising maxHops does nothing —
   *  the floor always binds first. */
  dedupExtraHops: 1,
  /** Web-Scale contacts count this much toward the tier ladder. */
  webScaleTierWeight: 2,
  /** Curated guarantees at least this fraction of the pass median. */
  curatedFloor: 0.6,
} as const

// ---------------------------------------------------------------------------
// Signal propagation — the v2 scoring core.
//
// A struck node fires its downward edges. Nodes in the layer below score
// WITHOUT the ball touching them, and fire their own edges in turn. Downward
// only, so it cannot loop and depth bounds the cascade.
//
// These are the most dangerous numbers in the game. Propagation is
// multiplicative across a fan-out of 2-3, so retention slightly too high turns
// every contact into a board-wide flood. `npm run propagation` sweeps them.
// ---------------------------------------------------------------------------

export const SIGNAL = {
  /** Fraction of power each hop carries to the next layer. */
  retention: 0.45,
  /** Signal below this fraction of the originating strike stops. */
  floor: 0.08,
  /** Hard hop cap, independent of the floor. Backstop against a tuning slip. */
  maxHops: 6,
  /** GELU doubles outgoing strength; this is that multiplier. */
  geluBoost: 2.0,
  /** An attention head fires every downward edge rather than the usual two. */
  headFiresAllEdges: true,
  /**
   * Signal is a bonus laid ON TOP of contact scoring, not a replacement for
   * it, so it is scaled down relative to a direct hit. Because signal no
   * longer consumes nodes, EVERY contact fires a full wave — roughly 8 waves
   * a pass instead of one — so this share is what keeps the bonus a bonus.
   */
  bonusShare: 0.5,
} as const

// ---------------------------------------------------------------------------
// Node and bucket progression
// ---------------------------------------------------------------------------

export const PROGRESSION = {
  /** Node value is `basePinValue * level`. Linear keeps the HUD readable. */
  maxNodeLevel: 12,
  /** Bucket multiplier is `1 + bucketLevelStep * level`. */
  bucketLevelStep: 0.25,
  maxBucketLevel: 10,
  /** Most a node may carry. The shop charges much more for the second. */
  maxTransformsPerNode: 2,
} as const

export const TRANSFORMS = {
  /** attention-head: value multiplier. Replaces v1's flat criticalPinValue. */
  attentionHeadMult: 3,
  /** layer-norm: per copy, added to every node in the same layer. */
  layerNormBonus: 0.2,
  /** dropout: chance to not fire at all, and the payoff when it does. */
  dropoutChance: 0.3,
  dropoutMult: 3,
  /** embedding: the first node struck in a pass pays this. */
  embeddingMult: 4,
  /** sparse-moe: nodes needed in its layer before it wakes, then its payout. */
  moeThreshold: 3,
  moeMult: 5,
  /** quantised: half value now, cheaper levels later (shop, Pass 3). */
  quantisedMult: 0.5,
  /** checkpoint: fraction paid again on the following pass. */
  checkpointEcho: 0.5,

  /** logit-boost: multiplies the bucket's own multiplier. */
  logitBoostMult: 2,
  /** top-k: nodes a pass must strike to trigger, and the payout. */
  topKThreshold: 15,
  topKMult: 5,
  /** eos: ends the pass immediately but banks it at this multiplier. */
  eosMult: 3,
  /** nucleus: payout randomised in this range. */
  nucleusMin: 0.2,
  nucleusMax: 4,
  /** cache-hit: fraction paid again next pass. */
  cacheEcho: 1.0,
  /** revenue-share: money paid on landing. Spends in Pass 3. */
  revenueShare: 1,
} as const

// ---------------------------------------------------------------------------
// Activation economy — ONE pool for the whole run, not per stage.
//
// Equilibrium check: a stage costs ~8 launches, a clear refunds 8, so the pool
// hovers near its start value with a ~12 buffer. Mistakes are survivable; a
// genuinely bad stage costs real runway. That is the intended tension.
// ---------------------------------------------------------------------------

export const ECONOMY = {
  /** Forward passes per benchmark, before boss modifiers and shop upgrades. */
  activationsPerBenchmark: 10,
  startingMoney: 6,

  /** Overshoot: +$1 per this much over target... */
  overshootPer: 0.5,
  /** ...up to this many dollars. */
  overshootCap: 5,

  /** Interest: +$`interestAmount` per $`interestPer` held, capped.
   *  The cap is the important half — past $25 held, hoarding earns nothing
   *  and the money belongs in the board. That is what makes it a decision. */
  interestPer: 4,
  interestAmount: 1,
  interestCap: 8,

  /** Unspent activations pay $1 each, capped. Finishing early pays. */
  unspentCap: 6,

  /** HUD turns red at or below this many activations. */
  lowWarning: 3,

  /** Retained for the legacy Mods pool fields; the deck replaced the pool. */
  startingActivations: 10,
  startingMaxPool: 30,
  stageClearRefund: 8,
  overshootThreshold: 1.5,
  overshootBonus: 3,
} as const

// ---------------------------------------------------------------------------
// Temperature was cut in v2.
//
// It was the per-launch decision in v1 — a pre-generation sampling parameter
// you set before every shot. The deck replaces it: what you fire is decided
// by the draw queue, and your only response is where you aim. Risk became
// something you BUILD rather than something you dial.
//
// Nothing references TEMPERATURES any more. If you want a per-launch risk
// dial back, it belongs on the card, not on a slider.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stage targets: 1.4x growth. See the coupling note at the top of this file.
//   2,200 · 3,080 · 4,310 · 6,030 · 8,450 · 11,830 · 16,560 · 23,180
// ---------------------------------------------------------------------------

export const STAGES = {
  count: 8,
  /**
   * Stage 1 target. Calibrated against the headless sweep in `tools/simulate.ts`:
   * PROVISIONAL. Pass 3 replaces this curve entirely with funding rounds, so
   * this is only sized to keep Pass 2 playable: `npm run propagation` measures
   * a median pass of ~390 on the 70-node board with signal at 0.45 retention,
   * and the sweep put the unskilled baseline at 6 passes per benchmark against
   * an intended 8 — so this is scaled to land near 8 (which matches the +8
   * clear refund, meaning a competently played benchmark breaks even).
   */
  baseTarget: 4400,
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
  layers: 14,
  /** Even rows get this many nodes, odd rows one fewer and a half-cell shift. */
  nodesPerLayer: 13,
  /** Chance a node wires a third downward edge rather than two. */
  thirdEdgeChance: 0.34,
  /** Nodes that begin at level 2 rather than 1. */
  startingPromotions: 7,
  /** Attention heads placed unconditionally at run start. Never zero: the
   *  tier bonus, split trigger and detonation trigger all key off them.
   *  Scaled with the denser lattice so they stay findable. */
  startingAttentionHeads: 6,
  /** Additional nodes that begin carrying one of the mild transforms. */
  startingTransforms: 4,
  startingBucketTransformChance: 0.55,
  pocketCount: 6,
  spikePocketsMin: 1,
  spikePocketsMax: 2,
  /** Horizontal inset from the rails for node placement. */
  edgeInset: 0.85,
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
  bloomStrength: 0.30,
  bloomRadius: 0.44,
  bloomThreshold: 0.52,
  /** Extra bloom at max temperature. */
  bloomTempBoost: 0.18,
  /**
   * Glitch intensity ceiling. Tuned against a screenshot, not by eye: above
   * ~0.35 the chromatic split competes with the board instead of framing it.
   */
  glitchMax: 0.26,

  // --- final composite ------------------------------------------------------
  /** Spectral dispersion of bright halos, weighted by luminance so only hot
   *  things fringe. This is the prismatic bloom the reference art has and a
   *  plain monochrome bloom cannot produce. */
  dispersion: 0.0032,
  /** Animated film grain. Binds the image together and hides the banding
   *  additive blending leaves in dark areas. */
  grain: 0.045,
  /** Ordered 4x4 Bayer dither — the phosphor/scanner character. */
  dither: 0.018,
  /** Scanline depth. */
  scanlines: 0.035,
  trailLength: 64,
  pinFlashSeconds: 0.42,
  /** Signal pulses are briefer than contact flashes — they are a bonus
   *  passing through, not a weight being consumed. */
  signalFlashSeconds: 0.26,
  // --- holographic shells -------------------------------------------------
  // Nothing in the chamber is lit; every surface emits. Brightness is an
  // ENERGY scalar per instance, summed from rest + proximity + events.

  /** Sphere tessellation. Dense enough that no facet is ever visible — the
   *  wireframe is drawn in the shader, not made of these triangles. */
  shellSegments: 40,
  shellRings: 26,
  /** Shell radius as a fraction of the physics collider. Deliberately UNDER
   *  1: additive shells accumulate, and a shell drawn larger than its
   *  collider would make passable gaps look blocked. */
  shellScale: 0.92,
  headScale: 0.95,

  /** Energy contributions, summed per node per frame. */
  restEnergy: 0.040,
  proximityEnergy: 2.3,
  strikeEnergy: 2.8,
  signalEnergy: 2.2,
  spentEnergy: 0.16,
  inertEnergy: 0.10,
  /** World units over which a token excites the shells around it. */
  proximityRadius: 4.2,
  /** Everything not previewed drops to this while the shop panel is open. */
  mutedEnergyScale: 0.28,
  /** Extra energy on a weight a hovered purchase would hit. */
  previewEnergy: 2.6,

  /** Procedural grid density, rising with level — the third channel level
   *  reads on, alongside scale and nested shell count. */
  gridBase: 2.5,
  gridPerLevel: 0.4,
  /** A nested inner shell appears every N levels, up to the cap. */
  levelsPerShell: 4,
  maxInnerShells: 2,

  /** Conduits and the beads that ride them. */
  conduitRadius: 0.028,
  conduitRest: 0.14,
  conduitLit: 2.2,
  beadRadius: 0.11,
  beadSpeed: 2.6,

  /** Comet echoes: small shells strung down the trail at decreasing scale,
   *  which is what makes motion taper. A line alone cannot narrow. */
  trailEchoes: 10,
  trailEchoSpacing: 4,

  /** Token: a hard plasma core inside a wider wireframe shell. */
  tokenCoreEnergy: 2.6,
  tokenShellEnergy: 1.0,
  tokenGrid: 5,

  /** Depth of the output-token wells, in world units. */
  bucketDepth: 0.55,
  /** Z of the glyph label plane — in front of every shell. */
  labelZ: 0.6,

  // --- instrument chrome ----------------------------------------------------
  // Hairline apparatus around the field. A benchmarking game should look like
  // an instrument reading a system, not like a bare playfield.
  chromeZ: -0.05,
  chromePad: 0.5,
  chromeOpacity: 0.55,
  bracketLength: 1.1,
  tickCount: 30,
  tickMajor: 0.34,
  tickMinor: 0.17,
  registrationRadius: 8.6,
  sweepOpacity: 0.12,
  sweepSpeed: 0.07,

  /** Legacy, from the flat ring pass. Unused by the holographic renderer. */
  ringThickness: 0.062,
  /** Edge brightness at rest, as a fraction of full. Must stay faint: 70 nodes
   *  of edges at any real brightness becomes a bright haze, not a diagram. */
  edgeRestBrightness: 0.13,
  /** How fast a signalled edge fades back to rest. */
  edgeFadeRate: 2.6,
  /** Resolution of the glyph-label canvas. The label layer is one texture over
   *  the whole board, redrawn only when levels or transforms change. */
  labelPixelsPerUnit: 54,
  /** Milliseconds between hops when presenting a forward pass. Propagation is
   *  instantaneous and already scored; this only staggers the SHOW, so the
   *  player sees a wave travel down rather than a subtree blink on at once. */
  signalHopMs: 65,
  /** Horizontal breathing room either side of the board. */
  cameraPadding: 1.0,
  /** Clearance above the launcher, so it clears the HUD bar. */
  cameraPadTop: 2.8,
  /** Clearance below the board floor, so the pockets are never clipped. */
  cameraPadBottom: 2.6,
  /** Camera tilt in degrees. Small and fixed: enough to see the tops and
   *  near sides of every shell, not enough to disturb aim. The projection
   *  stays orthographic, so where a thing appears is still where it is. */
  cameraTilt: 9,
  /** Peak camera shake, in world units. Past ~0.5 it reads as nausea, not impact. */
  shakeMax: 0.34,
  /** World units of shake added per unit of renderer.punch(). */
  shakePerPunch: 0.16,
  /** Per-frame shake decay, normalised to 60fps. */
  shakeDecay: 0.86,
} as const

export const COLORS = {
  bg: 0x04060b,
  pin: 0x3ec6ff,
  pinLit: 0x8af2ff,
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
  /** Layers rendered inert by a boss modifier. */
  inert: 0x2a2f38,
  /** Instrument hairlines — neutral, never the accent. */
  chrome: 0x7fb6d9,
  /** Weights a hovered shop item would hit. */
  preview: 0x9dff4a,
} as const
