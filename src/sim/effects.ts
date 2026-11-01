/**
 * effects.ts — upgrade effects that act on the running simulation.
 *
 * Most upgrades are pure modifiers: they change a number in `Mods` and the
 * scoring code reads it. Two are not — LoRA: Chain Reaction spawns a token,
 * and Explosive Weights destroys pins — and those originally lived in
 * `core/game.ts` alongside the renderer calls.
 *
 * That was a mistake. `tools/upgrades.ts` measured both at exactly 0%, not
 * because they do nothing but because the headless harness never executed
 * them: they were sitting in the orchestration layer, on the far side of the
 * sim/render split. Two of sixteen upgrades were structurally unmeasurable.
 *
 * They live here now. `game.ts` calls this and reacts to the returned events
 * with visuals and audio; the harness calls the exact same function and gets
 * the scoring. One implementation, one source of truth, fully testable.
 */

import { LAUNCH } from '../config/balance'
import type { Mods } from '../config/upgrades'
import type { PinDef } from './board'
import type { OrbHandle, PhysicsWorld } from './physics'
import { scoreDetonation, type Pass, type ScoreEvent, type ScoringContext } from './scoring'

export interface CriticalOutcome {
  /** Weights destroyed by Explosive Weights, with the points each paid. */
  detonated: { pin: PinDef; event: ScoreEvent | null }[]
  /** Token spawned by Chain Reaction, if any. */
  split: OrbHandle | null
}

const EMPTY: CriticalOutcome = { detonated: [], split: null }

/**
 * Resolve everything that fires when a token strikes an attention head.
 * Safe to call unconditionally — it no-ops when neither upgrade is held.
 */
export function resolveCriticalStrike(
  world: PhysicsWorld,
  pass: Pass,
  pin: PinDef,
  orb: OrbHandle,
  ctx: ScoringContext,
  mods: Mods,
  passRestitution: number,
): CriticalOutcome {
  if (!mods.explosiveWeights && !mods.chainSplitOnCritical) return EMPTY

  const out: CriticalOutcome = { detonated: [], split: null }

  // --- Explosive Weights -------------------------------------------------
  if (mods.explosiveWeights) {
    const near = world.pinsNear(pin.x, pin.y, mods.explosiveRadius, pin)
    let destroyed = 0
    for (const victim of near) {
      // Heads survive their neighbours' detonations, so a cluster of heads
      // cannot cascade into clearing the board.
      if (victim.critical) continue
      if (destroyed >= mods.detonationCap) break
      const event = scoreDetonation(pass, victim, ctx)
      world.removePin(victim)
      out.detonated.push({ pin: victim, event })
      destroyed++
    }
  }

  // --- LoRA: Chain Reaction ----------------------------------------------
  if (mods.chainSplitOnCritical) {
    const cap = Math.min(mods.maxOrbs, LAUNCH.maxOrbsHardCap)
    if (world.orbCount < cap) {
      // Mirror the parent's horizontal velocity with a nudge away from it, so
      // the pair visibly diverges instead of overlapping into one blurred dot.
      const vx = -orb.vx * 0.9 + (orb.vx >= 0 ? -2 : 2)
      const vy = Math.min(-2, orb.vy * 0.8)
      out.split = world.spawnOrb(orb.x, orb.y, vx, vy, {
        // Inherit the pass's temperature-scaled bounce. Spawning at 0 made
        // every split a dead weight that dropped straight through the board.
        restitution: passRestitution,
        launchId: orb.launchId,
        // Splits pay less, or Chain Reaction stacked with multi-token
        // launches compounds away from the upgrade budget.
        scoreScale: orb.scoreScale * 0.6,
      })
    }
  }

  return out
}
