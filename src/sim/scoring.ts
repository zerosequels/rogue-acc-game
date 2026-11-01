/**
 * scoring.ts — what a weight is worth, right now.
 *
 * One "forward pass" runs from launch until the last token leaves the board.
 * Score accumulates uncommitted in `Pass` and only lands on the benchmark
 * total at the end, which is what lets a benchmark spike multiply the whole
 * pass retroactively.
 *
 * The rule everything else depends on: **a node scores once per pass**,
 * whether the ball touched it or a signal reached it. Without that, a token
 * rattling between three weights farms them forever, and — far worse in v2 —
 * propagation re-entering a node it already lit would never terminate.
 */

import { SCORE, SIGNAL, TRANSFORMS } from '../config/balance'
import type { Rng } from '../core/rng'
import type { Mods } from '../config/upgrades'
import { isAttentionHead, type Board, type NodeDef, type PocketDef } from './board'
import type { OrbHandle } from './physics'

export interface ScoreEvent {
  points: number
  x: number
  y: number
  kind:
    | 'pin' | 'critical' | 'spike' | 'pocket' | 'dud'
    | 'hallucination' | 'detonation' | 'signal' | 'echo'
  tierMult: number
  /** Hop distance from the originating contact. 0 means the ball touched it. */
  hop?: number
  /** Node this came from, so the render layer can find it without a search. */
  nodeId?: number
}

/** Payouts deferred to the next pass by Checkpoint / Cache Hit. */
export interface EchoPayout {
  points: number
  x: number
  y: number
}

/** Live state of the current forward pass. */
export class Pass {
  readonly struck = new Set<number>()
  criticalHits = 0
  score = 0
  eventCount = 0
  spikeApplied = false
  /** Nodes struck per layer, for Sparse MoE's wake condition. */
  readonly struckByLayer = new Map<number, number>()
  /** Nodes lit by signal this pass. Bonus only — see the note on scoreSignal. */
  signalCount = 0
  /** True once any node has scored — Embedding keys off this. */
  anyStruck = false
  /** Set by an EOS bucket; the caller must stop the pass. */
  ended = false
  /** Money earned mid-pass by Revenue Share buckets. Spends in Pass 3. */
  money = 0
  /** Payouts this pass has deferred to the next one. */
  readonly echoes: EchoPayout[] = []

  get chain(): number {
    return this.struck.size
  }

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
    this.struckByLayer.clear()
    this.criticalHits = 0
    this.score = 0
    this.eventCount = 0
    this.spikeApplied = false
    this.anyStruck = false
    this.signalCount = 0
    this.ended = false
    this.money = 0
    this.echoes.length = 0
  }
}

export interface ScoringContext {
  mods: Mods
  /** Retained from v1's temperature; always 1 now that temperature is cut. */
  tempScoreMult: number
  tempValue: number
  rng: Rng
  /** Per-layer value bonus from Layer Norm. Recomputed when the board changes. */
  layerBonus: readonly number[]
}

/**
 * Layer Norm is the only transform whose effect is not local to its own node,
 * so it is precomputed per board rather than searched per strike.
 */
export function computeLayerBonus(board: Board): number[] {
  const bonus = new Array<number>(board.layers).fill(1)
  for (const n of board.nodes) {
    if (n.removed) continue
    if (n.transforms.includes('layer-norm')) {
      bonus[n.layer] = (bonus[n.layer] ?? 1) + TRANSFORMS.layerNormBonus
    }
  }
  return bonus
}

/**
 * Raw value of a node before pass-level multipliers. Shared by contact
 * scoring and signal scoring so the two can never drift apart.
 */
function nodeBaseValue(node: NodeDef, ctx: ScoringContext): number {
  let v = SCORE.basePinValue * node.level
  if (isAttentionHead(node)) v *= TRANSFORMS.attentionHeadMult
  if (node.transforms.includes('quantised')) v *= TRANSFORMS.quantisedMult
  v *= ctx.layerBonus[node.layer] ?? 1
  return v
}

/**
 * Transforms whose payout depends on pass state rather than the node alone.
 * Returns a multiplier, or null when the node refuses to fire (Dropout).
 */
function situationalMult(node: NodeDef, pass: Pass, ctx: ScoringContext): number | null {
  let m = 1

  if (node.transforms.includes('dropout')) {
    if (ctx.rng.next() < TRANSFORMS.dropoutChance) return null
    m *= TRANSFORMS.dropoutMult
  }
  if (node.transforms.includes('embedding') && !pass.anyStruck) {
    m *= TRANSFORMS.embeddingMult
  }
  if (node.transforms.includes('sparse-moe')) {
    const inLayer = pass.struckByLayer.get(node.layer) ?? 0
    if (inLayer < TRANSFORMS.moeThreshold) return null
    m *= TRANSFORMS.moeMult
  }
  return m
}

function registerStrike(pass: Pass, node: NodeDef): void {
  pass.struck.add(node.id)
  pass.struckByLayer.set(node.layer, (pass.struckByLayer.get(node.layer) ?? 0) + 1)
  if (isAttentionHead(node)) pass.criticalHits++
}

/**
 * Score a ball contact. Returns null when the node was already scored this
 * pass (the common case during a rattle) so callers can skip all feedback.
 */
export function scorePin(
  pass: Pass,
  node: NodeDef,
  orb: OrbHandle,
  ctx: ScoringContext,
): ScoreEvent | null {
  if (pass.struck.has(node.id)) return null

  const situational = situationalMult(node, pass, ctx)
  // A refusing node still counts as struck — otherwise Dropout would be
  // re-rolled every time the ball brushed it.
  registerStrike(pass, node)
  if (situational === null) {
    pass.anyStruck = true
    return { points: 0, x: node.x, y: node.y, kind: 'dud', tierMult: pass.tierMult(ctx.mods), hop: 0, nodeId: node.id }
  }

  const { mods } = ctx
  const tierMult = pass.tierMult(mods)
  const surge = mods.gradientSurge * (pass.struck.size - 1)
  const base = nodeBaseValue(node, ctx) + surge

  let points =
    base * situational * mods.pinValueMult * tierMult * ctx.tempScoreMult *
    orb.scoreScale * mods.scoreMult
  let kind: ScoreEvent['kind'] = isAttentionHead(node) ? 'critical' : 'pin'

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
  pass.anyStruck = true

  if (node.transforms.includes('checkpoint')) {
    pass.echoes.push({
      points: Math.round(points * TRANSFORMS.checkpointEcho),
      x: node.x,
      y: node.y,
    })
  }

  return { points, x: node.x, y: node.y, kind, tierMult, hop: 0, nodeId: node.id }
}

/**
 * Score a node reached by signal rather than contact.
 *
 * Signal is a BONUS, and that word carries real mechanical weight:
 *
 *   - It does NOT consume the node. A weight lit by signal can still be hit
 *     by the ball afterwards for its full contact value, and can be lit again
 *     by a later contact's wave. Consuming nodes made the first contact of a
 *     pass eat most of the board, which is why measured contacts fell from
 *     10 to 4.8 — the ball was being starved by its own network.
 *   - It does NOT advance the multiplier tier. The ladder stays a measure of
 *     how well you AIMED; signal is a measure of how well your network is
 *     WIRED. Keeping them separate is what stops a good build from erasing
 *     the skill component.
 *
 * Termination does not depend on any of this: `propagate` carries its own
 * per-wave visited set, and the edge graph is a DAG by construction.
 *
 * `power` is the fraction of the originating strike still carried at this hop.
 */
export function scoreSignal(
  pass: Pass,
  node: NodeDef,
  power: number,
  hop: number,
  ctx: ScoringContext,
): ScoreEvent | null {
  // Dropout still gets to refuse — a flaky weight is flaky however it fires.
  if (node.transforms.includes('dropout') && ctx.rng.next() < TRANSFORMS.dropoutChance) {
    return null
  }

  let situational = 1
  if (node.transforms.includes('dropout')) situational *= TRANSFORMS.dropoutMult
  if (node.transforms.includes('sparse-moe')) {
    // MoE still reads CONTACT counts: it wakes when the layer is genuinely
    // being worked, not when its own wave brushes past.
    const inLayer = pass.struckByLayer.get(node.layer) ?? 0
    if (inLayer < TRANSFORMS.moeThreshold) return null
    situational *= TRANSFORMS.moeMult
  }
  // Embedding is deliberately absent: it rewards the FIRST weight the ball
  // touches, and a signal wave never touches anything.

  const { mods } = ctx
  const tierMult = pass.tierMult(mods)
  const base = nodeBaseValue(node, ctx)
  const points = Math.round(
    base * situational * power * SIGNAL_BONUS_SHARE * mods.pinValueMult * tierMult *
      ctx.tempScoreMult * mods.scoreMult,
  )
  if (points <= 0) return null

  pass.score += points
  pass.eventCount++
  pass.signalCount++

  if (node.transforms.includes('checkpoint')) {
    pass.echoes.push({
      points: Math.round(points * TRANSFORMS.checkpointEcho),
      x: node.x,
      y: node.y,
    })
  }

  return { points, x: node.x, y: node.y, kind: 'signal', tierMult, hop, nodeId: node.id }
}

/** Detonated weights (Explosive Weights) pay above base and reform next pass. */
export function scoreDetonation(
  pass: Pass,
  node: NodeDef,
  ctx: ScoringContext,
): ScoreEvent | null {
  if (pass.struck.has(node.id)) return null
  registerStrike(pass, node)

  const { mods } = ctx
  const tierMult = pass.tierMult(mods)
  const surge = mods.gradientSurge * (pass.struck.size - 1)
  const base = nodeBaseValue(node, ctx) + surge
  const points = Math.round(
    base * mods.pinValueMult * tierMult * ctx.tempScoreMult * mods.scoreMult *
      SCORE.detonationValueMult,
  )

  pass.score += points
  pass.eventCount++
  pass.anyStruck = true
  return { points, x: node.x, y: node.y, kind: 'detonation', tierMult }
}

/** Resolve a token landing in an output bucket. */
export function scoreLanding(
  pass: Pass,
  pocket: PocketDef,
  orb: OrbHandle,
  ctx: ScoringContext,
): ScoreEvent | null {
  const { mods } = ctx

  if (pocket.transform === 'revenue-share') pass.money += TRANSFORMS.revenueShare

  if (pocket.kind === 'spike') {
    if (pass.spikeApplied) return null
    pass.spikeApplied = true

    // The jackpot is a PASS-level prize and must be shared between the tokens
    // of that pass, or every extra token is another ticket on the same draw.
    let spikeMult = 1 + (mods.spikeMult - 1) / Math.max(1, mods.orbsPerLaunch)
    spikeMult *= bucketMultiplier(pocket)
    spikeMult *= bucketTransformMult(pocket, pass, ctx)

    const before = pass.score
    const after = before > 0
      ? Math.round(before * spikeMult)
      : Math.round(SCORE.basePinValue * spikeMult * mods.pinValueMult * ctx.tempScoreMult)
    pass.score = after
    pass.eventCount++
    applyBucketEcho(pass, pocket, after - before)
    return { points: after - before, x: pocket.x, y: orb.y, kind: 'spike', tierMult: pass.tierMult(mods) }
  }

  if (pocket.kind === 'pocket') {
    const mult = bucketMultiplier(pocket) * bucketTransformMult(pocket, pass, ctx)
    const points = Math.round(
      SCORE.pocketBonus * mult * mods.pinValueMult * ctx.tempScoreMult *
        orb.scoreScale * mods.scoreMult,
    )
    pass.score += points
    pass.eventCount++
    applyBucketEcho(pass, pocket, points)
    return { points, x: pocket.x, y: orb.y, kind: 'pocket', tierMult: pass.tierMult(mods) }
  }

  // 'drain' — a dead neuron. No points, but the UI still marks it.
  return null
}

export function bucketMultiplier(pocket: PocketDef): number {
  return 1 + PROGRESSION_BUCKET_STEP * pocket.level
}

/** Pulled out so `balance.ts` stays the only place the step is written. */
import { PROGRESSION } from '../config/balance'
const PROGRESSION_BUCKET_STEP = PROGRESSION.bucketLevelStep

function bucketTransformMult(pocket: PocketDef, pass: Pass, ctx: ScoringContext): number {
  switch (pocket.transform) {
    case 'logit-boost':
      return TRANSFORMS.logitBoostMult
    case 'top-k':
      return pass.struck.size >= TRANSFORMS.topKThreshold ? TRANSFORMS.topKMult : 1
    case 'eos':
      pass.ended = true
      return TRANSFORMS.eosMult
    case 'nucleus':
      return ctx.rng.range(TRANSFORMS.nucleusMin, TRANSFORMS.nucleusMax)
    default:
      return 1
  }
}

function applyBucketEcho(pass: Pass, pocket: PocketDef, points: number): void {
  if (pocket.transform !== 'cache-hit' || points <= 0) return
  pass.echoes.push({
    points: Math.round(points * TRANSFORMS.cacheEcho),
    x: pocket.x,
    y: pocket.halfWidth,
  })
}

/** Does this bucket hand the token back for a free relaunch? */
export function returnsToken(pocket: PocketDef): boolean {
  return pocket.transform === 'beam-search'
}

const SIGNAL_BONUS_SHARE = SIGNAL.bonusShare

export { SIGNAL }
